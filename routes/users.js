/**
 * routes/users.js
 * User CRUD + auth config management — admin only.
 */
const express  = require('express');
const bcrypt   = require('bcrypt');
const db       = require('../db');
const { requireAdmin, requireAuth } = require('../middleware/auth');

const router = express.Router();

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
router.get('/auth-config/:provider', requireAdmin, async (req, res) => {
    const { provider } = req.params;
    if (!['ldap', 'saml'].includes(provider)) return res.status(400).json({ error: 'Invalid provider' });
    try {
        const { rows } = await db.query(
            'SELECT provider, enabled, config FROM auth_config WHERE provider = $1',
            [provider]
        );
        if (!rows.length) return res.status(404).json({ error: 'Provider config not found' });
        // Strip secrets from response
        const cfg = { ...rows[0].config };
        if (cfg.bindCredentials) cfg.bindCredentials = '••••••••';
        if (cfg.privateKey)      cfg.privateKey      = '••••••••';
        res.json({ ...rows[0], config: cfg });
    } catch (err) { res.status(500).json({ error: 'Database error' }); }
});

// ── Auth config — update ───────────────────────────────────────
router.put('/auth-config/:provider', requireAdmin, async (req, res) => {
    const { provider } = req.params;
    if (!['ldap', 'saml'].includes(provider)) return res.status(400).json({ error: 'Invalid provider' });
    const { enabled, config } = req.body;
    try {
        // Merge secrets: don't overwrite with '••••••••'
        const existing = await db.query(
            'SELECT config FROM auth_config WHERE provider = $1', [provider]
        );
        const currentCfg = existing.rows[0]?.config || {};
        const merged = { ...currentCfg, ...config };
        if (config?.bindCredentials === '••••••••') merged.bindCredentials = currentCfg.bindCredentials;
        if (config?.privateKey      === '••••••••') merged.privateKey      = currentCfg.privateKey;

        const { rows } = await db.query(
            `UPDATE auth_config SET enabled = $1, config = $2, updated_at = NOW()
             WHERE provider = $3
             RETURNING provider, enabled`,
            [enabled, JSON.stringify(merged), provider]
        );
        res.json({ ok: true, ...rows[0] });
    } catch (err) { res.status(500).json({ error: 'Database error' }); }
});

module.exports = router;
