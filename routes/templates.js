/**
 * routes/templates.js  (extracted from original server.js)
 */
const express = require('express');
const db      = require('../db');
const router  = express.Router();

router.get('/', async (req, res) => {
    try {
        const result = await db.query(
            'SELECT id, template_id, name, created_at FROM templates ORDER BY created_at DESC'
        );
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

router.get('/:template_id', async (req, res) => {
    try {
        const { template_id } = req.params;
        const result = await db.query(
            'SELECT * FROM templates WHERE template_id = $1', [template_id]
        );
        if (!result.rows.length) return res.status(404).json({ error: 'Template not found' });
        res.json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

router.post('/', async (req, res) => {
    try {
        const { name, template_text } = req.body;
        if (!name || !template_text)
            return res.status(400).json({ error: 'Name and template_text are required' });
        const template_id = 'tpl_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);
        const result = await db.query(
            'INSERT INTO templates (template_id, name, template_text) VALUES ($1, $2, $3) RETURNING id, template_id, name, created_at',
            [template_id, name, template_text]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

router.delete('/:template_id', async (req, res) => {
    try {
        const { template_id } = req.params;
        const result = await db.query(
            'DELETE FROM templates WHERE template_id = $1 RETURNING id', [template_id]
        );
        if (!result.rows.length) return res.status(404).json({ error: 'Template not found' });
        res.status(204).send();
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

module.exports = router;
