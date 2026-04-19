-- ============================================================
-- configify schema v3 — template groups (tree structure)
-- Run AFTER schema.sql and schema_v2.sql
-- ============================================================

CREATE TABLE IF NOT EXISTS template_groups (
    id          SERIAL PRIMARY KEY,
    name        VARCHAR(255) NOT NULL,
    parent_id   INTEGER REFERENCES template_groups(id) ON DELETE CASCADE,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at  TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_tpl_groups_parent ON template_groups(parent_id);

-- Add group column to existing templates table
ALTER TABLE templates
    ADD COLUMN IF NOT EXISTS group_id
    INTEGER REFERENCES template_groups(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_templates_group ON templates(group_id);
