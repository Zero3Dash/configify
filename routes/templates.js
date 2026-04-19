/**
 * routes/templates.js
 * Template CRUD + template group (folder) tree management.
 *
 * Route order matters: /groups/* must come before /:template_id so Express
 * doesn't treat "groups" as a template_id parameter.
 */
const express = require('express');
const db      = require('../db');
const router  = express.Router();

// ══════════════════════════════════════════════════════════════
// TEMPLATE GROUPS  (folder tree)
// ══════════════════════════════════════════════════════════════

/**
 * GET /api/templates/groups
 * Returns a flat array; the client builds the tree using parent_id.
 */
router.get('/groups', async (req, res) => {
    try {
        const { rows } = await db.query(`
            SELECT  g.id, g.name, g.parent_id, g.sort_order, g.created_at,
                    u.username          AS created_by_name,
                    COUNT(t.id)::int    AS template_count
            FROM    template_groups g
            LEFT JOIN users     u ON u.id = g.created_by
            LEFT JOIN templates t ON t.group_id = g.id
            GROUP BY g.id, u.username
            ORDER BY g.parent_id NULLS FIRST, g.sort_order, g.name
        `);
        res.json(rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

/**
 * POST /api/templates/groups
 * Body: { name, parent_id? }
 */
router.post('/groups', async (req, res) => {
    const { name, parent_id } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'name required' });
    try {
        const { rows } = await db.query(
            `INSERT INTO template_groups (name, parent_id, created_by)
             VALUES ($1, $2, $3) RETURNING *`,
            [name.trim(), parent_id || null, req.user.id]
        );
        res.status(201).json(rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

/**
 * PATCH /api/templates/groups/:id
 * Body: { name?, parent_id? }  — partial update (rename / reparent)
 */
router.patch('/groups/:id', async (req, res) => {
    const gid = parseInt(req.params.id);
    const { name, parent_id } = req.body;

    if (parent_id !== undefined && parseInt(parent_id) === gid) {
        return res.status(400).json({ error: 'A folder cannot be its own parent' });
    }

    const fields = [], vals = [];
    let idx = 1;
    if (name      !== undefined) { fields.push(`name = $${idx++}`);      vals.push(name.trim()); }
    if (parent_id !== undefined) { fields.push(`parent_id = $${idx++}`); vals.push(parent_id || null); }
    if (!fields.length) return res.status(400).json({ error: 'No fields to update' });

    vals.push(gid);
    try {
        const { rows } = await db.query(
            `UPDATE template_groups SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
            vals
        );
        if (!rows.length) return res.status(404).json({ error: 'Folder not found' });
        res.json(rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

/**
 * DELETE /api/templates/groups/:id
 * Templates inside become ungrouped; child groups are reparented to the
 * deleted group's own parent (i.e. promoted one level up).
 */
router.delete('/groups/:id', async (req, res) => {
    const gid = parseInt(req.params.id);
    try {
        const { rows } = await db.query(
            'SELECT parent_id FROM template_groups WHERE id = $1', [gid]
        );
        if (!rows.length) return res.status(404).json({ error: 'Folder not found' });
        const parentId = rows[0].parent_id;

        await db.query('UPDATE templates      SET group_id  = NULL     WHERE group_id  = $1', [gid]);
        await db.query('UPDATE template_groups SET parent_id = $1      WHERE parent_id = $2', [parentId, gid]);
        await db.query('DELETE FROM template_groups WHERE id = $1', [gid]);

        res.status(204).send();
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

// ══════════════════════════════════════════════════════════════
// TEMPLATES
// ══════════════════════════════════════════════════════════════

router.get('/', async (req, res) => {
    try {
        const { rows } = await db.query(`
            SELECT  t.id, t.template_id, t.name, t.template_text,
                    t.created_at, t.updated_at, t.group_id,
                    g.name AS group_name
            FROM    templates t
            LEFT JOIN template_groups g ON g.id = t.group_id
            ORDER BY t.created_at DESC
        `);
        res.json(rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

router.get('/:template_id', async (req, res) => {
    try {
        const { rows } = await db.query(
            `SELECT t.*, g.name AS group_name
             FROM   templates t
             LEFT JOIN template_groups g ON g.id = t.group_id
             WHERE  t.template_id = $1`,
            [req.params.template_id]
        );
        if (!rows.length) return res.status(404).json({ error: 'Template not found' });
        res.json(rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

router.post('/', async (req, res) => {
    const { name, template_text, group_id } = req.body;
    if (!name || !template_text)
        return res.status(400).json({ error: 'name and template_text are required' });
    try {
        const template_id = 'tpl_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);
        const { rows } = await db.query(
            `INSERT INTO templates (template_id, name, template_text, group_id)
             VALUES ($1, $2, $3, $4)
             RETURNING id, template_id, name, created_at, group_id`,
            [template_id, name, template_text, group_id || null]
        );
        res.status(201).json(rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

/**
 * PUT /api/templates/:template_id
 * Body: { name, template_text, group_id? }
 * group_id: omit to leave unchanged; pass null to ungroup; pass id to move.
 */
router.put('/:template_id', async (req, res) => {
    const { template_id } = req.params;
    const { name, template_text, group_id } = req.body;
    if (!name || !template_text)
        return res.status(400).json({ error: 'name and template_text are required' });
    try {
        // Build query dynamically so omitting group_id leaves it unchanged
        let query, params;
        if (group_id !== undefined) {
            query  = `UPDATE templates
                      SET name=$1, template_text=$2, group_id=$3, updated_at=NOW()
                      WHERE template_id=$4
                      RETURNING id, template_id, name, template_text,
                                created_at, updated_at, group_id`;
            params = [name, template_text, group_id || null, template_id];
        } else {
            query  = `UPDATE templates
                      SET name=$1, template_text=$2, updated_at=NOW()
                      WHERE template_id=$3
                      RETURNING id, template_id, name, template_text,
                                created_at, updated_at, group_id`;
            params = [name, template_text, template_id];
        }
        const { rows } = await db.query(query, params);
        if (!rows.length) return res.status(404).json({ error: 'Template not found' });
        res.json(rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

router.delete('/:template_id', async (req, res) => {
    try {
        const { rows } = await db.query(
            'DELETE FROM templates WHERE template_id = $1 RETURNING id',
            [req.params.template_id]
        );
        if (!rows.length) return res.status(404).json({ error: 'Template not found' });
        res.status(204).send();
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

module.exports = router;
