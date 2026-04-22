-- ============================================================
-- configify — unified database schema (v2.7)
-- Single file; safe to apply to a fresh database.
-- Includes: core tables, compliance, schedules.
-- ============================================================

-- ── Shared trigger function (created first; referenced by all triggers) ──
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;


-- ── Users ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
    id               SERIAL PRIMARY KEY,
    username         VARCHAR(100) UNIQUE NOT NULL,
    email            VARCHAR(255) UNIQUE,
    password_hash    VARCHAR(255),                           -- NULL for LDAP/SAML users
    auth_provider    VARCHAR(20)  NOT NULL DEFAULT 'local',  -- 'local' | 'ldap' | 'saml'
    saml_name_id     VARCHAR(255),
    ldap_dn          VARCHAR(512),
    role             VARCHAR(20)  NOT NULL DEFAULT 'user',   -- 'admin' | 'user'
    is_active        BOOLEAN      NOT NULL DEFAULT TRUE,
    last_login       TIMESTAMP WITH TIME ZONE,
    created_at       TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at       TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Default admin account  (password: ChangeMe2026!)
-- bcrypt cost 12. Change immediately after first login.
INSERT INTO users (username, email, password_hash, role)
VALUES (
    'admin',
    'admin@localhost',
    '$2b$12$MhJJV3YtPm6G8Td6My8p7.H.8mLVn3wO0FhwQ/Ip8F9lWsFbzBfsG',
    'admin'
) ON CONFLICT DO NOTHING;


-- ── Auth provider config (LDAP / SAML) ───────────────────────
CREATE TABLE IF NOT EXISTS auth_config (
    id         SERIAL PRIMARY KEY,
    provider   VARCHAR(20) UNIQUE NOT NULL,   -- 'ldap' | 'saml'
    enabled    BOOLEAN NOT NULL DEFAULT FALSE,
    config     JSONB   NOT NULL DEFAULT '{}',
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO auth_config (provider, enabled, config) VALUES
  ('ldap', FALSE, '{
    "url": "ldap://dc.example.com:389",
    "bindDN": "cn=svc-configify,ou=ServiceAccounts,dc=example,dc=com",
    "bindCredentials": "CHANGE_ME",
    "searchBase": "ou=Users,dc=example,dc=com",
    "searchFilter": "(sAMAccountName={{username}})",
    "tlsOptions": {"rejectUnauthorized": true},
    "usernameField": "username",
    "passwordField": "password",
    "groupSearchBase": "ou=Groups,dc=example,dc=com",
    "groupSearchFilter": "(member={{dn}})",
    "adminGroup": "CN=configify-admins,ou=Groups,dc=example,dc=com"
  }'),
  ('saml', FALSE, '{
    "entryPoint": "https://idp.example.com/saml/sso",
    "issuer": "configify",
    "callbackUrl": "https://configify.yourdomain.com/auth/saml/callback",
    "cert": "PASTE_IDP_CERT_HERE",
    "privateKey": "",
    "identifierFormat": "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
    "attributeMapping": {
      "email": "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
      "username": "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name",
      "role": "http://schemas.xmlsoap.org/claims/Group",
      "adminGroupValue": "configify-admins"
    }
  }')
ON CONFLICT DO NOTHING;


-- ── Template groups (folder tree) ─────────────────────────────
CREATE TABLE IF NOT EXISTS template_groups (
    id         SERIAL PRIMARY KEY,
    name       VARCHAR(255) NOT NULL,
    parent_id  INTEGER REFERENCES template_groups(id) ON DELETE CASCADE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);


-- ── Templates ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS templates (
    id            SERIAL PRIMARY KEY,
    template_id   VARCHAR(50) UNIQUE NOT NULL,
    name          VARCHAR(255) NOT NULL,
    template_text TEXT NOT NULL,
    group_id      INTEGER REFERENCES template_groups(id) ON DELETE SET NULL,
    created_at    TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at    TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);


-- ── Device groups ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS device_groups (
    id          SERIAL PRIMARY KEY,
    name        VARCHAR(255) NOT NULL,
    description TEXT,
    color       VARCHAR(7) DEFAULT '#475569',
    created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at  TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);


-- ── Credential vault ──────────────────────────────────────────
-- encrypted_enable_password: AES-256-GCM encrypted privilege-escalation
-- password used for Cisco IOS/NX-OS "enable" mode (and similar).
-- NULL means no enable password is configured for this credential.
CREATE TABLE IF NOT EXISTS credentials (
    id                       SERIAL PRIMARY KEY,
    name                     VARCHAR(255) NOT NULL,
    username                 VARCHAR(255) NOT NULL,
    auth_method              VARCHAR(20)  NOT NULL DEFAULT 'password',
    encrypted_password       TEXT,
    encrypted_key            TEXT,
    encrypted_passphrase     TEXT,
    encrypted_enable_password TEXT,   -- v2.7: privilege-escalation secret (nullable)
    created_by               INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at               TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at               TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Migration guard for existing installs upgrading to v2.7
ALTER TABLE credentials ADD COLUMN IF NOT EXISTS
    encrypted_enable_password TEXT;


-- ── Devices ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS devices (
    id                    SERIAL PRIMARY KEY,
    name                  VARCHAR(255) NOT NULL,
    hostname              VARCHAR(255) NOT NULL,
    port                  INTEGER      NOT NULL DEFAULT 22,
    device_type           VARCHAR(50)  NOT NULL DEFAULT 'linux',
    group_id              INTEGER REFERENCES device_groups(id) ON DELETE SET NULL,
    default_credential_id INTEGER REFERENCES credentials(id)    ON DELETE SET NULL,
    description           TEXT,
    tags                  TEXT[],
    created_by            INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at            TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at            TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);


-- ── SSH execution log ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS execution_logs (
    id            SERIAL PRIMARY KEY,
    device_id     INTEGER REFERENCES devices(id)     ON DELETE SET NULL,
    template_id   VARCHAR(50),
    executed_by   INTEGER REFERENCES users(id)       ON DELETE SET NULL,
    credential_id INTEGER REFERENCES credentials(id) ON DELETE SET NULL,
    command_text  TEXT    NOT NULL,
    output        TEXT,
    exit_code     INTEGER,
    status        VARCHAR(20) NOT NULL DEFAULT 'running',
    started_at    TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    completed_at  TIMESTAMP WITH TIME ZONE
);


-- ════════════════════════════════════════════════════════════════
-- COMPLIANCE CHECKING  (v2.5+)
-- ════════════════════════════════════════════════════════════════

-- ── Golden configurations ──────────────────────────────────────
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
CREATE TABLE IF NOT EXISTS golden_config_assignments (
    id               SERIAL PRIMARY KEY,
    golden_config_id INTEGER NOT NULL REFERENCES golden_configs(id)  ON DELETE CASCADE,
    device_id        INTEGER          REFERENCES devices(id)         ON DELETE CASCADE,
    device_group_id  INTEGER          REFERENCES device_groups(id)   ON DELETE CASCADE,
    created_by       INTEGER          REFERENCES users(id)           ON DELETE SET NULL,
    created_at       TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_gca_one_target CHECK (
        (device_id IS NOT NULL)::int + (device_group_id IS NOT NULL)::int = 1
    ),
    CONSTRAINT uq_gca_device UNIQUE (golden_config_id, device_id),
    CONSTRAINT uq_gca_group  UNIQUE (golden_config_id, device_group_id)
);

-- ── Compliance check results ───────────────────────────────────
CREATE TABLE IF NOT EXISTS compliance_results (
    id               SERIAL PRIMARY KEY,
    golden_config_id INTEGER REFERENCES golden_configs(id) ON DELETE CASCADE,
    device_id        INTEGER REFERENCES devices(id)        ON DELETE CASCADE,
    credential_id    INTEGER REFERENCES credentials(id)    ON DELETE SET NULL,
    status           VARCHAR(20) NOT NULL DEFAULT 'running',
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

-- ── Compliance schedules ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS compliance_schedules (
    id               SERIAL PRIMARY KEY,
    name             VARCHAR(255) NOT NULL,
    description      TEXT,
    golden_config_id INTEGER REFERENCES golden_configs(id) ON DELETE SET NULL,
    enabled          BOOLEAN NOT NULL DEFAULT TRUE,
    interval_hours   INTEGER NOT NULL DEFAULT 24 CHECK (interval_hours > 0),
    last_run         TIMESTAMP WITH TIME ZONE,
    next_run         TIMESTAMP WITH TIME ZONE,
    run_count        INTEGER NOT NULL DEFAULT 0,
    last_result      JSONB,
    created_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at       TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at       TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);


-- ════════════════════════════════════════════════════════════════
-- INDEXES
-- ════════════════════════════════════════════════════════════════

CREATE INDEX IF NOT EXISTS idx_template_id            ON templates(template_id);
CREATE INDEX IF NOT EXISTS idx_templates_group        ON templates(group_id);
CREATE INDEX IF NOT EXISTS idx_tpl_groups_parent      ON template_groups(parent_id);
CREATE INDEX IF NOT EXISTS idx_users_username         ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_provider         ON users(auth_provider);
CREATE INDEX IF NOT EXISTS idx_devices_group          ON devices(group_id);
CREATE INDEX IF NOT EXISTS idx_devices_cred           ON devices(default_credential_id);
CREATE INDEX IF NOT EXISTS idx_exec_logs_device       ON execution_logs(device_id);
CREATE INDEX IF NOT EXISTS idx_exec_logs_user         ON execution_logs(executed_by);
CREATE INDEX IF NOT EXISTS idx_golden_configs_name    ON golden_configs(name);
CREATE INDEX IF NOT EXISTS idx_gca_golden_config      ON golden_config_assignments(golden_config_id);
CREATE INDEX IF NOT EXISTS idx_gca_device             ON golden_config_assignments(device_id);
CREATE INDEX IF NOT EXISTS idx_gca_group              ON golden_config_assignments(device_group_id);
CREATE INDEX IF NOT EXISTS idx_compliance_device      ON compliance_results(device_id);
CREATE INDEX IF NOT EXISTS idx_compliance_gc          ON compliance_results(golden_config_id);
CREATE INDEX IF NOT EXISTS idx_compliance_status      ON compliance_results(status);
CREATE INDEX IF NOT EXISTS idx_compliance_checked_at  ON compliance_results(checked_at DESC);
CREATE INDEX IF NOT EXISTS idx_comp_sched_next_run
    ON compliance_schedules(enabled, next_run) WHERE enabled = TRUE;


-- ════════════════════════════════════════════════════════════════
-- TRIGGERS  (updated_at)
-- ════════════════════════════════════════════════════════════════

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'update_templates_updated_at') THEN
        CREATE TRIGGER update_templates_updated_at
            BEFORE UPDATE ON templates
            FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_users_updated_at') THEN
        CREATE TRIGGER trg_users_updated_at
            BEFORE UPDATE ON users
            FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_credentials_updated_at') THEN
        CREATE TRIGGER trg_credentials_updated_at
            BEFORE UPDATE ON credentials
            FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_devices_updated_at') THEN
        CREATE TRIGGER trg_devices_updated_at
            BEFORE UPDATE ON devices
            FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_golden_configs_updated_at') THEN
        CREATE TRIGGER trg_golden_configs_updated_at
            BEFORE UPDATE ON golden_configs
            FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_comp_schedules_updated_at') THEN
        CREATE TRIGGER trg_comp_schedules_updated_at
            BEFORE UPDATE ON compliance_schedules
            FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    END IF;
END $$;
