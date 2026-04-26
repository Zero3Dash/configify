/**
 * routes/users.js
 * User CRUD + auth config management — admin only.
 *
 * Security fix (v2.8.1): LDAP bindCredentials and SAML privateKey are now
 * encrypted with AES-256-GCM (via crypto/vault.js) before being stored in
 * auth_config.config. They were previously stored as plaintext JSON, meaning
 * anyone with database read access could extract them directly.
 *
 * Migration: safeDecrypt() detects whether a stored value is already
 * encrypted (vault format: "iv:tag:ciphertext") or is legacy plaintext.
 * Plaintext values continue to work transparently until the config is next
 * saved, at which point they are encrypted automatically. No manual migration
 * step is required.
 *
 * Sensitive fields encrypted at rest:
 *   LDAP  — bindCredentials
 *   SAML  — privateKey
 *
 * The API never returns these values. The GET handler replaces them with
 * the sentinel "••••••••" so the UI can show whether a value is set without
 * ever transmitting the secret. The PUT handler treats an incoming sentinel
 * as "keep the existing stored value unchanged".
 */
const express  = require('express');
const bcrypt   = require('bcrypt');
const db       = require('../db');
const vault    = require('../crypto/vault');
const { requireAdmin, requireAuth } = require('../middleware/auth');

const router = express.Router();

// ── Vault helpers ──────────────────────────────────────────────

/**
 * Returns true if `value` looks like a vault-encrypted string
 * ("iv:tag:ciphertext" — three colon-separated hex segments).
 * Used to distinguish already-encrypted values from legacy plaintext
 * during the migration period.
 */
function isVaultEncrypted(value) {
    if (!value || typeof value !== 'string') return false;
    const parts = value.split(':');
    return parts.length === 3 && parts.every(p => /^[0-9a-f]+$/i.test(p));
}

/**
 * Decrypt a value that may be either vault-encrypted or legacy plaintext.
 * - Vault-encrypted  → decrypt and return plaintext
 * - Plaintext        → return as-is (migration path; will be encrypted on next save)
 * - null / undefined → return null
 */
function safeDecrypt(value) {
    if (!value) return null;
    if (isVaultEncrypted(value)) {
        try {
            return vault.decrypt(value);
        } catch (err) {
            console.error('[auth-config] Failed to decrypt stored secret:', err.message);
            return null;
        }
    }
    // Legacy plaintext — return as-is so existing configs keep working
    return value;
}

/**
 * Encrypt a plaintext secret for storage.
 * Returns null if the value is falsy.
 */
function encryptSecret(value) {
    if (!value) return null;
    return vault.encrypt(value);
}

// ── List all users ─────────────────────────────────────────────
router.get('/', requireAdmin, async (req, res) => {
    try {
        const { rows } = await db.query(
            `SELECT id, username, email, role, auth_provider, is_active, last_login, created_at
             FROM users ORDER BY created_at DESC`
        );
        res.json(rows);
    } catch (err) { res.status(500).json({ error: 'Database error' }); }
});

// ── Create user (local only via admin) ────────────────────────
router.post('/', requireAdmin, async (req, res) => {
    const { username, email, password, role } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'username and password required' });
    if (password.length < 8)   return res.status(400).json({ error: 'Password min 8 characters' });
    const allowedRoles = ['admin', 'user'];
    const userRole = allowedRoles.includes(role) ? role : 'user';
    try {
        const hash = await bcrypt.hash(password, 12);
        const { rows } = await db.query(
            `INSERT INTO users (username, email, password_hash, role, auth_provider)
             VALUES ($1, $2, $3, $4, 'local')
             RETURNING id, username, email, role, auth_provider, is_active, created_at`,
            [username, email || null, hash, userRole]
        );
        res.status(201).json(rows[0]);
    } catch (err) {
        if (err.code === '23505') return res.status(409).json({ error: 'Username or email already exists' });
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

// ── Update user ────────────────────────────────────────────────
router.patch('/:id', requireAdmin, async (req, res) => {
    const { id } = req.params;
    const { email, role, is_active, password } = req.body;
    try {
        const fields = [];
        const vals   = [];
        let   idx    = 1;

        if (email      !== undefined) { fields.push(`email = $${idx++}`);     vals.push(email); }
        if (role       !== undefined) { fields.push(`role = $${idx++}`);      vals.push(role); }
        if (is_active  !== undefined) { fields.push(`is_active = $${idx++}`); vals.push(is_active); }
        if (password) {
            const hash = await bcrypt.hash(password, 12);
            fields.push(`password_hash = $${idx++}`);
            vals.push(hash);
        }
        if (!fields.length) return res.status(400).json({ error: 'No fields to update' });

        vals.push(id);
        const { rows } = await db.query(
            `UPDATE users SET ${fields.join(', ')} WHERE id = $${idx}
             RETURNING id, username, email, role, auth_provider, is_active`,
            vals
        );
        if (!rows.length) return res.status(404).json({ error: 'User not found' });
        res.json(rows[0]);
    } catch (err) { res.status(500).json({ error: 'Database error' }); }
});

// ── Delete user ────────────────────────────────────────────────
router.delete('/:id', requireAdmin, async (req, res) => {
    const { id } = req.params;
    if (parseInt(id) === req.user.id) return res.status(400).json({ error: 'Cannot delete yourself' });
    try {
        const { rows } = await db.query('DELETE FROM users WHERE id = $1 RETURNING id', [id]);
        if (!rows.length) return res.status(404).json({ error: 'User not found' });
        res.status(204).send();
    } catch (err) { res.status(500).json({ error: 'Database error' }); }
});

// ── Auth config (LDAP / SAML) — get ───────────────────────────
//
// Sensitive fields (bindCredentials, privateKey) are NEVER returned to
// the client. They are replaced with the sentinel "••••••••" so the UI
// can indicate whether a value is stored without transmitting it.
//
router.get('/auth-config/:provider', requireAdmin, async (req, res) => {
    const { provider } = req.params;
    if (!['ldap', 'saml'].includes(provider)) return res.status(400).json({ error: 'Invalid provider' });
    try {
        const { rows } = await db.query(
            'SELECT provider, enabled, config FROM auth_config WHERE provider = $1',
            [provider]
        );
        if (!rows.length) return res.status(404).json({ error: 'Provider config not found' });

        // Deep-copy the config and replace sensitive fields with the sentinel.
        // We intentionally do NOT decrypt here — the plaintext value must never
        // leave the server, even over an authenticated API call.
        const cfg = { ...rows[0].config };
        if (cfg.bindCredentials) cfg.bindCredentials = '••••••••';
        if (cfg.privateKey)      cfg.privateKey      = '••••••••';

        res.json({ ...rows[0], config: cfg });
    } catch (err) { res.status(500).json({ error: 'Database error' }); }
});

// ── Auth config — update ───────────────────────────────────────
//
// Encryption rules for sensitive fields:
//
//   Incoming value  │ Action
//   ────────────────┼────────────────────────────────────────────────────
//   "••••••••"      │ Keep the existing stored value (encrypted) unchanged
//   non-empty string│ Encrypt with vault.encrypt() and store ciphertext
//   empty / absent  │ Clear the field (set to null)
//
// All other config fields are stored as-is (they are not sensitive).
//
router.put('/auth-config/:provider', requireAdmin, async (req, res) => {
    const { provider } = req.params;
    if (!['ldap', 'saml'].includes(provider)) return res.status(400).json({ error: 'Invalid provider' });
    const { enabled, config } = req.body;
    try {
        // Fetch the current stored config so we can merge and preserve secrets.
        const existing = await db.query(
            'SELECT config FROM auth_config WHERE provider = $1', [provider]
        );
        const currentCfg = existing.rows[0]?.config || {};

        // Start with current values, overlay the incoming fields.
        const merged = { ...currentCfg, ...config };

        // ── Handle LDAP bindCredentials ────────────────────────────────
        if (provider === 'ldap') {
            if (config?.bindCredentials === '••••••••') {
                // Sentinel: keep whatever is already stored (may be encrypted or legacy plaintext)
                merged.bindCredentials = currentCfg.bindCredentials;
            } else if (config?.bindCredentials) {
                // New plaintext value provided — encrypt before storing
                merged.bindCredentials = encryptSecret(config.bindCredentials);
                console.log(`[auth-config] user ${req.user.id} updated LDAP bindCredentials (encrypted)`);
            } else if (config && 'bindCredentials' in config) {
                // Explicitly cleared
                merged.bindCredentials = null;
            }
        }

        // ── Handle SAML privateKey ─────────────────────────────────────
        if (provider === 'saml') {
            if (config?.privateKey === '••••••••') {
                // Sentinel: keep whatever is already stored
                merged.privateKey = currentCfg.privateKey;
            } else if (config?.privateKey) {
                // New plaintext value provided — encrypt before storing
                merged.privateKey = encryptSecret(config.privateKey);
                console.log(`[auth-config] user ${req.user.id} updated SAML privateKey (encrypted)`);
            } else if (config && 'privateKey' in config) {
                // Explicitly cleared
                merged.privateKey = null;
            }
        }

        const { rows } = await db.query(
            `UPDATE auth_config SET enabled = $1, config = $2, updated_at = NOW()
             WHERE provider = $3
             RETURNING provider, enabled`,
            [enabled, JSON.stringify(merged), provider]
        );
        console.log(`[auth-config] user ${req.user.id} updated ${provider} config (enabled=${enabled})`);
        res.json({ ok: true, ...rows[0] });
    } catch (err) {
        console.error('[auth-config] PUT error:', err);
        res.status(500).json({ error: 'Database error' });
    }
});

module.exports = router;
