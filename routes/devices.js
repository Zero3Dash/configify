/**
 * routes/devices.js
 * Device groups, devices, and credential vault CRUD.
 */
const express = require('express');
const db      = require('../db');
const vault   = require('../crypto/vault');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();

// ════════════════════════════════════════════════════════
// DEVICE GROUPS
// ════════════════════════════════════════════════════════

router.get('/groups', requireAuth, async (req, res) => {
    try {
        const { rows } = await db.query(
            `SELECT g.*, u.username AS created_by_name,
                    COUNT(d.id)::int AS device_count
             FROM device_groups g
             LEFT JOIN users u ON u.id = g.created_by
             LEFT JOIN devices d ON d.group_id = g.id
             GROUP BY g.id, u.username
             ORDER BY g.name`
        );
        res.json(rows);
    } catch (err) { res.status(500).json({ error: 'Database error' }); }
});

router.post('/groups', requireAuth, async (req, res) => {
    const { name, description, color } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    try {
        const { rows } = await db.query(
            `INSERT INTO device_groups (name, description, color, created_by)
             VALUES ($1, $2, $3, $4) RETURNING *`,
            [name, description || null, color || '#475569', req.user.id]
        );
        res.status(201).json(rows[0]);
    } catch (err) { res.status(500).json({ error: 'Database error' }); }
});

router.patch('/groups/:id', requireAuth, async (req, res) => {
    const { name, description, color } = req.body;
    try {
        const { rows } = await db.query(
            `UPDATE device_groups SET
               name        = COALESCE($1, name),
               description = COALESCE($2, description),
               color       = COALESCE($3, color)
             WHERE id = $4 RETURNING *`,
            [name, description, color, req.params.id]
        );
        if (!rows.length) return res.status(404).json({ error: 'Group not found' });
        res.json(rows[0]);
    } catch (err) { res.status(500).json({ error: 'Database error' }); }
});

router.delete('/groups/:id', requireAdmin, async (req, res) => {
    try {
        await db.query('UPDATE devices SET group_id = NULL WHERE group_id = $1', [req.params.id]);
        const { rows } = await db.query('DELETE FROM device_groups WHERE id = $1 RETURNING id', [req.params.id]);
        if (!rows.length) return res.status(404).json({ error: 'Group not found' });
        res.status(204).send();
    } catch (err) { res.status(500).json({ error: 'Database error' }); }
});

// ════════════════════════════════════════════════════════
// CREDENTIAL VAULT
// ════════════════════════════════════════════════════════

router.get('/credentials', requireAuth, async (req, res) => {
    try {
        const { rows } = await db.query(
            `SELECT c.id, c.name, c.username, c.auth_method, c.created_at, u.username AS created_by_name
             FROM credentials c
             LEFT JOIN users u ON u.id = c.created_by
             ORDER BY c.name`
        );
        // Never return encrypted values in list
        res.json(rows);
    } catch (err) { res.status(500).json({ error: 'Database error' }); }
});

router.post('/credentials', requireAuth, async (req, res) => {
    const { name, username, auth_method, password, private_key, passphrase } = req.body;
    if (!name || !username) return res.status(400).json({ error: 'name and username required' });
    try {
        const { rows } = await db.query(
            `INSERT INTO credentials
               (name, username, auth_method, encrypted_password, encrypted_key, encrypted_passphrase, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             RETURNING id, name, username, auth_method, created_at`,
            [
                name, username,
                auth_method || 'password',
                vault.encrypt(password   || null),
                vault.encrypt(private_key|| null),
                vault.encrypt(passphrase || null),
                req.user.id
            ]
        );
        res.status(201).json(rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

router.patch('/credentials/:id', requireAuth, async (req, res) => {
    const { name, username, auth_method, password, private_key, passphrase } = req.body;
    try {
        const fields = [];
        const vals   = [];
        let   idx    = 1;
        if (name        !== undefined) { fields.push(`name = $${idx++}`);               vals.push(name); }
        if (username    !== undefined) { fields.push(`username = $${idx++}`);            vals.push(username); }
        if (auth_method !== undefined) { fields.push(`auth_method = $${idx++}`);         vals.push(auth_method); }
        if (password    !== undefined) { fields.push(`encrypted_password = $${idx++}`);  vals.push(vault.encrypt(password)); }
        if (private_key !== undefined) { fields.push(`encrypted_key = $${idx++}`);       vals.push(vault.encrypt(private_key)); }
        if (passphrase  !== undefined) { fields.push(`encrypted_passphrase = $${idx++}`);vals.push(vault.encrypt(passphrase)); }
        if (!fields.length) return res.status(400).json({ error: 'No fields to update' });
        vals.push(req.params.id);
        const { rows } = await db.query(
            `UPDATE credentials SET ${fields.join(', ')} WHERE id = $${idx}
             RETURNING id, name, username, auth_method`,
            vals
        );
        if (!rows.length) return res.status(404).json({ error: 'Credential not found' });
        res.json(rows[0]);
    } catch (err) { res.status(500).json({ error: 'Database error' }); }
});

router.delete('/credentials/:id', requireAdmin, async (req, res) => {
    try {
        await db.query('UPDATE devices SET default_credential_id = NULL WHERE default_credential_id = $1', [req.params.id]);
        const { rows } = await db.query('DELETE FROM credentials WHERE id = $1 RETURNING id', [req.params.id]);
        if (!rows.length) return res.status(404).json({ error: 'Credential not found' });
        res.status(204).send();
    } catch (err) { res.status(500).json({ error: 'Database error' }); }
});

// ════════════════════════════════════════════════════════
// DEVICES
// ════════════════════════════════════════════════════════

router.get('/', requireAuth, async (req, res) => {
    try {
        const { rows } = await db.query(
            `SELECT d.*,
                    g.name  AS group_name,
                    g.color AS group_color,
                    c.name  AS credential_name,
                    c.username AS credential_username,
                    u.username AS created_by_name
             FROM devices d
             LEFT JOIN device_groups g ON g.id = d.group_id
             LEFT JOIN credentials   c ON c.id = d.default_credential_id
             LEFT JOIN users         u ON u.id = d.created_by
             ORDER BY COALESCE(g.name,'zzz'), d.name`
        );
        res.json(rows);
    } catch (err) { res.status(500).json({ error: 'Database error' }); }
});

router.post('/', requireAuth, async (req, res) => {
    const { name, hostname, port, device_type, group_id, default_credential_id, description, tags } = req.body;
    if (!name || !hostname) return res.status(400).json({ error: 'name and hostname required' });
    try {
        const { rows } = await db.query(
            `INSERT INTO devices
               (name, hostname, port, device_type, group_id, default_credential_id, description, tags, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
             RETURNING *`,
            [name, hostname, port || 22, device_type || 'linux',
             group_id || null, default_credential_id || null,
             description || null, tags || null, req.user.id]
        );
        res.status(201).json(rows[0]);
    } catch (err) { res.status(500).json({ error: 'Database error' }); }
});

router.patch('/:id', requireAuth, async (req, res) => {
    const allowed = ['name','hostname','port','device_type','group_id','default_credential_id','description','tags'];
    const fields = [], vals = [];
    let idx = 1;
    for (const key of allowed) {
        if (req.body[key] !== undefined) {
            fields.push(`${key} = $${idx++}`);
            vals.push(req.body[key]);
        }
    }
    if (!fields.length) return res.status(400).json({ error: 'No fields to update' });
    vals.push(req.params.id);
    try {
        const { rows } = await db.query(
            `UPDATE devices SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
            vals
        );
        if (!rows.length) return res.status(404).json({ error: 'Device not found' });
        res.json(rows[0]);
    } catch (err) { res.status(500).json({ error: 'Database error' }); }
});

router.delete('/:id', requireAdmin, async (req, res) => {
    try {
        const { rows } = await db.query('DELETE FROM devices WHERE id = $1 RETURNING id', [req.params.id]);
        if (!rows.length) return res.status(404).json({ error: 'Device not found' });
        res.status(204).send();
    } catch (err) { res.status(500).json({ error: 'Database error' }); }
});

// ── Execution logs for a device ────────────────────────────────
router.get('/:id/logs', requireAuth, async (req, res) => {
    try {
        const { rows } = await db.query(
            `SELECT l.*, u.username AS executed_by_name
             FROM execution_logs l
             LEFT JOIN users u ON u.id = l.executed_by
             WHERE l.device_id = $1
             ORDER BY l.started_at DESC LIMIT 100`,
            [req.params.id]
        );
        res.json(rows);
    } catch (err) { res.status(500).json({ error: 'Database error' }); }
});

module.exports = router;
