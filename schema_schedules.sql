-- ============================================================
-- configify — compliance schedules (migration for existing installs)
-- Run once:
--   PGPASSWORD=your_db_password psql -h localhost -U configify_user \
--       -d configify_db -f schema_schedules.sql
-- Already included in schema.sql for fresh installs.
-- ============================================================

CREATE TABLE IF NOT EXISTS compliance_schedules (
    id               SERIAL PRIMARY KEY,
    name             VARCHAR(255) NOT NULL,
    description      TEXT,
    golden_config_id INTEGER REFERENCES golden_configs(id) ON DELETE SET NULL,
    -- NULL = run ALL active assignments (full audit)
    enabled          BOOLEAN NOT NULL DEFAULT TRUE,
    interval_hours   INTEGER NOT NULL DEFAULT 24 CHECK (interval_hours > 0),
    last_run         TIMESTAMP WITH TIME ZONE,
    next_run         TIMESTAMP WITH TIME ZONE,
    run_count        INTEGER NOT NULL DEFAULT 0,
    last_result      JSONB,   -- { compliant, non_compliant, error, total }
    created_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at       TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at       TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_comp_sched_next_run
    ON compliance_schedules(enabled, next_run) WHERE enabled = TRUE;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_comp_schedules_updated_at') THEN
        CREATE TRIGGER trg_comp_schedules_updated_at
            BEFORE UPDATE ON compliance_schedules
            FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    END IF;
END $$;
