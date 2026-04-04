/**
 * auth/index.js
 * Configures Passport strategies: local, LDAP/LDAPS, SAML.
 * Strategies are registered lazily when enabled via DB config.
 */
const passport        = require('passport');
const LocalStrategy   = require('passport-local').Strategy;
const LdapStrategy    = require('passport-ldapauth');
const { Strategy: SamlStrategy } = require('@node-saml/passport-saml');
const bcrypt          = require('bcrypt');
const db              = require('../db');

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
            if (!rows.length) return done(null, false, { message: 'Invalid credentials' });
            const user = rows[0];
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

    passport.use('ldap', new LdapStrategy(
        {
            server: {
                url:            cfg.url,
                bindDN:         cfg.bindDN,
                bindCredentials: cfg.bindCredentials,
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

                // Determine role from group membership
                let role = 'user';
                const memberOf = ldapUser.memberOf || [];
                const groups   = Array.isArray(memberOf) ? memberOf : [memberOf];
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
}

// ── SAML strategy (registered dynamically when enabled) ────────
async function setupSamlStrategy() {
    const { rows } = await db.query(
        "SELECT config FROM auth_config WHERE provider = 'saml' AND enabled = TRUE"
    );
    if (!rows.length) return;

    const cfg  = rows[0].config;
    const attrMap = cfg.attributeMapping || {};

    passport.use('saml', new SamlStrategy(
        {
            entryPoint:       cfg.entryPoint,
            issuer:           cfg.issuer,
            callbackUrl:      cfg.callbackUrl,
            cert:             cfg.cert,
            privateKey:       cfg.privateKey || undefined,
            identifierFormat: cfg.identifierFormat,
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
        // verify callback for logout
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
}

// ── Bootstrap all enabled strategies ──────────────────────────
async function initAuth() {
    try {
        await setupLdapStrategy();
        await setupSamlStrategy();
        console.log('✅ Auth strategies initialised');
    } catch (err) {
        console.error('⚠️  Auth strategy init warning:', err.message);
    }
}

module.exports = { passport, initAuth };
