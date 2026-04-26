/**
 * auth/index.js
 * Configures Passport strategies: local, LDAP/LDAPS, SAML.
 * Strategies are registered lazily when enabled via DB config.
 *
 * Security fix (v2.8.1): LDAP bindCredentials and SAML privateKey are now
 * stored encrypted in auth_config.config. This module decrypts them at
 * strategy-setup time using safeDecrypt(), which also handles legacy
 * plaintext values transparently for backwards compatibility with existing
 * installs that have not yet re-saved their auth config.
 */
const passport        = require('passport');
const LocalStrategy   = require('passport-local').Strategy;
const LdapStrategy    = require('passport-ldapauth');
const { Strategy: SamlStrategy } = require('@node-saml/passport-saml');
const bcrypt          = require('bcrypt');
const db              = require('../db');
const vault           = require('../crypto/vault');

// ── Vault helpers ──────────────────────────────────────────────

/**
 * Returns true if `value` looks like a vault-encrypted string
 * ("iv:tag:ciphertext" — three colon-separated hex segments).
 */
function isVaultEncrypted(value) {
    if (!value || typeof value !== 'string') return false;
    const parts = value.split(':');
    return parts.length === 3 && parts.every(p => /^[0-9a-f]+$/i.test(p));
}

/**
 * Decrypt a value that may be either vault-encrypted or legacy plaintext.
 *
 * - Vault-encrypted  → decrypt and return plaintext
 * - Plaintext        → return as-is (migration path for existing installs)
 * - null / falsy     → return null
 *
 * This allows the auth strategies to work immediately after upgrading,
 * even if the admin has not yet re-saved the auth config to trigger
 * encryption of the stored values.
 */
function safeDecrypt(value) {
    if (!value) return null;
    if (isVaultEncrypted(value)) {
        try {
            return vault.decrypt(value);
        } catch (err) {
            console.error('[auth] Failed to decrypt stored secret — check VAULT_SECRET:', err.message);
            return null;
        }
    }
    // Legacy plaintext — return as-is
    return value;
}

// ── Serialize / deserialize session ────────────────────────────
passport.serializeUser((user, done) => done(null, user.id));

passport.deserializeUser(async (id, done) => {
    try {
        const { rows } = await db.query(
            'SELECT id, username, email, role, auth_provider, is_active FROM users WHERE id = $1',
            [id]
        );
        if (!rows.length || !rows[0].is_active) return done(null, false);
        done(null, rows[0]);
    } catch (err) { done(err); }
});

// ── Local strategy ─────────────────────────────────────────────
passport.use('local', new LocalStrategy(
    { usernameField: 'username', passwordField: 'password' },
    async (username, password, done) => {
        try {
            const { rows } = await db.query(
                'SELECT * FROM users WHERE username = $1 AND auth_provider = $2 AND is_active = TRUE',
                [username, 'local']
            );

            // Always run bcrypt even when the user is not found.
            // This normalises response timing and prevents an attacker from
            // distinguishing "username not found" from "wrong password" via
            // timing analysis.
            if (!rows.length) {
                await bcrypt.compare(password, '$2b$12$placeholderHashToNormaliseTimingXXXXXXXXXXXX');
                return done(null, false, { message: 'Invalid credentials' });
            }

            const user  = rows[0];
            const match = await bcrypt.compare(password, user.password_hash);
            if (!match) return done(null, false, { message: 'Invalid credentials' });

            await db.query('UPDATE users SET last_login = NOW() WHERE id = $1', [user.id]);
            return done(null, user);
        } catch (err) { done(err); }
    }
));

// ── LDAP strategy (registered dynamically when enabled) ────────
async function setupLdapStrategy() {
    const { rows } = await db.query(
        "SELECT config FROM auth_config WHERE provider = 'ldap' AND enabled = TRUE"
    );
    if (!rows.length) return;

    const cfg = rows[0].config;

    // Decrypt the bind password. safeDecrypt() handles both:
    //   • New encrypted values stored by the updated routes/users.js
    //   • Legacy plaintext values in existing installs (migration path)
    const bindCredentials = safeDecrypt(cfg.bindCredentials);
    if (!bindCredentials) {
        console.warn('[auth] LDAP bindCredentials is not set or could not be decrypted — LDAP strategy not registered');
        return;
    }

    passport.use('ldap', new LdapStrategy(
        {
            server: {
                url:            cfg.url,
                bindDN:         cfg.bindDN,
                bindCredentials,                        // decrypted plaintext
                searchBase:     cfg.searchBase,
                searchFilter:   cfg.searchFilter,
                searchAttributes: ['dn', 'sAMAccountName', 'mail', 'memberOf', 'cn'],
                tlsOptions:     cfg.tlsOptions || {}
            },
            usernameField: cfg.usernameField || 'username',
            passwordField: cfg.passwordField || 'password'
        },
        async (ldapUser, done) => {
            try {
                const username = ldapUser.sAMAccountName || ldapUser.cn;
                const email    = ldapUser.mail || null;
                const dn       = ldapUser.dn;

                // Determine role from group membership.
                // Filter to strings only — some LDAP servers return memberOf
                // entries as objects rather than strings, which would cause
                // .toLowerCase() to throw and silently skip the admin check.
                let role = 'user';
                const memberOf = ldapUser.memberOf || [];
                const groups   = (Array.isArray(memberOf) ? memberOf : [memberOf])
                    .filter(g => typeof g === 'string');

                if (cfg.adminGroup && groups.some(g => g.toLowerCase() === cfg.adminGroup.toLowerCase())) {
                    role = 'admin';
                }

                // Upsert user
                const { rows } = await db.query(`
                    INSERT INTO users (username, email, auth_provider, ldap_dn, role, last_login)
                    VALUES ($1, $2, 'ldap', $3, $4, NOW())
                    ON CONFLICT (username)
                    DO UPDATE SET
                        email      = EXCLUDED.email,
                        ldap_dn    = EXCLUDED.ldap_dn,
                        role       = EXCLUDED.role,
                        last_login = NOW()
                    RETURNING id, username, email, role, auth_provider, is_active
                `, [username, email, dn, role]);

                if (!rows[0].is_active) return done(null, false, { message: 'Account disabled' });
                done(null, rows[0]);
            } catch (err) { done(err); }
        }
    ));

    console.log('✅  LDAP strategy registered');
}

// ── SAML strategy (registered dynamically when enabled) ────────
async function setupSamlStrategy() {
    const { rows } = await db.query(
        "SELECT config FROM auth_config WHERE provider = 'saml' AND enabled = TRUE"
    );
    if (!rows.length) return;

    const cfg    = rows[0].config;
    const attrMap = cfg.attributeMapping || {};

    // Decrypt the SP private key if one is stored.
    // safeDecrypt() handles both encrypted and legacy plaintext values.
    // The private key is optional — SAML works without it if the SP does
    // not need to sign requests or decrypt assertions.
    const privateKey = safeDecrypt(cfg.privateKey) || undefined;

    passport.use('saml', new SamlStrategy(
        {
            entryPoint:           cfg.entryPoint,
            issuer:               cfg.issuer,
            callbackUrl:          cfg.callbackUrl,
            cert:                 cfg.cert,
            privateKey,                                 // decrypted plaintext (or undefined)
            identifierFormat:     cfg.identifierFormat,
            wantAssertionsSigned: true
        },
        async (profile, done) => {
            try {
                const username = profile[attrMap.username] || profile.nameID;
                const email    = profile[attrMap.email]    || profile.nameID;
                const groups   = profile[attrMap.role]     || '';
                const role     = (Array.isArray(groups) ? groups : [groups])
                    .some(g => g === attrMap.adminGroupValue) ? 'admin' : 'user';

                const { rows } = await db.query(`
                    INSERT INTO users (username, email, auth_provider, saml_name_id, role, last_login)
                    VALUES ($1, $2, 'saml', $3, $4, NOW())
                    ON CONFLICT (username)
                    DO UPDATE SET
                        email        = EXCLUDED.email,
                        saml_name_id = EXCLUDED.saml_name_id,
                        role         = EXCLUDED.role,
                        last_login   = NOW()
                    RETURNING id, username, email, role, auth_provider, is_active
                `, [username, email, profile.nameID, role]);

                if (!rows[0].is_active) return done(null, false, { message: 'Account disabled' });
                done(null, rows[0]);
            } catch (err) { done(err); }
        },
        // verify callback for SLO (single logout)
        async (profile, done) => {
            try {
                const { rows } = await db.query(
                    'SELECT id, username, email, role, auth_provider, is_active FROM users WHERE saml_name_id = $1',
                    [profile.nameID]
                );
                done(null, rows[0] || false);
            } catch (err) { done(err); }
        }
    ));

    console.log('✅  SAML strategy registered');
}

// ── Bootstrap all enabled strategies ──────────────────────────
async function initAuth() {
    try {
        await setupLdapStrategy();
        await setupSamlStrategy();
        console.log('✅  Auth strategies initialised');
    } catch (err) {
        console.error('⚠️  Auth strategy init warning:', err.message);
    }
}

module.exports = { passport, initAuth };
