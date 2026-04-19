-- ============================================================
-- configify — compliance schema additions
-- Append these to schema.sql (already included in schema.sql
-- for fresh installs).  Existing installs: run this file once.
-- ============================================================

-- ── Golden configurations ──────────────────────────────────────
-- Define expected configuration lines for Cisco IOS / NX-OS devices.
CREATE TABLE IF NOT EXISTS golden_configs (
    id           SERIAL PRIMARY KEY,
    name         VARCHAR(255) NOT NULL,
    description  TEXT,
    config_text  TEXT NOT NULL,
    device_types VARCHAR(50)[] NOT NULL DEFAULT ARRAY['cisco_ios','cisco_nxos']::VARCHAR[],
    created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at   TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at   TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- ── Golden config assignments ──────────────────────────────────
-- Link a golden config to a specific device OR an entire device group.
-- Exactly one of device_id or device_group_id must be set.
CREATE TABLE IF NOT EXISTS golden_config_assignments (
    id               SERIAL PRIMARY KEY,
    golden_config_id INTEGER NOT NULL REFERENCES golden_configs(id)   ON DELETE CASCADE,
    device_id        INTEGER          REFERENCES devices(id)           ON DELETE CASCADE,
    device_group_id  INTEGER          REFERENCES device_groups(id)     ON DELETE CASCADE,
    created_by       INTEGER          REFERENCES users(id)             ON DELETE SET NULL,
    created_at       TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_gca_one_target CHECK (
        (device_id IS NOT NULL)::int + (device_group_id IS NOT NULL)::int = 1
    ),
    CONSTRAINT uq_gca_device UNIQUE (golden_config_id, device_id),
    CONSTRAINT uq_gca_group  UNIQUE (golden_config_id, device_group_id)
);

-- ── Compliance check results ───────────────────────────────────
-- Stores the outcome of each compliance check run.
-- config_snapshot: raw output of `show running-config` (optional, may be large)
-- missing_lines:   array of golden config lines not found in the running config
-- line_results:    JSON array of {line, found} objects for the detail view
CREATE TABLE IF NOT EXISTS compliance_results (
    id               SERIAL PRIMARY KEY,
    golden_config_id INTEGER REFERENCES golden_configs(id)  ON DELETE CASCADE,
    device_id        INTEGER REFERENCES devices(id)         ON DELETE CASCADE,
    credential_id    INTEGER REFERENCES credentials(id)     ON DELETE SET NULL,
    status           VARCHAR(20) NOT NULL DEFAULT 'running',
    -- 'running' | 'compliant' | 'non_compliant' | 'error'
    config_snapshot  TEXT,
    missing_lines    TEXT[]  NOT NULL DEFAULT '{}',
    line_results     JSONB   NOT NULL DEFAULT '[]',
    total_lines      INTEGER NOT NULL DEFAULT 0,
    matched_lines    INTEGER NOT NULL DEFAULT 0,
    error_message    TEXT,
    checked_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
    checked_at       TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    completed_at     TIMESTAMP WITH TIME ZONE
);

-- ── Indexes ───────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_golden_configs_name     ON golden_configs(name);
CREATE INDEX IF NOT EXISTS idx_gca_golden_config       ON golden_config_assignments(golden_config_id);
CREATE INDEX IF NOT EXISTS idx_gca_device              ON golden_config_assignments(device_id);
CREATE INDEX IF NOT EXISTS idx_gca_group               ON golden_config_assignments(device_group_id);
CREATE INDEX IF NOT EXISTS idx_compliance_device       ON compliance_results(device_id);
CREATE INDEX IF NOT EXISTS idx_compliance_gc           ON compliance_results(golden_config_id);
CREATE INDEX IF NOT EXISTS idx_compliance_status       ON compliance_results(status);
CREATE INDEX IF NOT EXISTS idx_compliance_checked_at   ON compliance_results(checked_at DESC);

-- ── updated_at trigger for golden_configs ─────────────────────
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_golden_configs_updated_at') THEN
        CREATE TRIGGER trg_golden_configs_updated_at
            BEFORE UPDATE ON golden_configs
            FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    END IF;
END $$;
