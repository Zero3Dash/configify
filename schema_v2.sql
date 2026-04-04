-- ============================================================
-- configify schema v2 — auth, devices, credentials, groups
-- Run this AFTER schema.sql (or replace it entirely for fresh installs)
-- ============================================================

-- ── Users ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
    id               SERIAL PRIMARY KEY,
    username         VARCHAR(100) UNIQUE NOT NULL,
    email            VARCHAR(255) UNIQUE,
    password_hash    VARCHAR(255),                          -- NULL for LDAP/SAML users
    auth_provider    VARCHAR(20)  NOT NULL DEFAULT 'local', -- 'local' | 'ldap' | 'saml'
    saml_name_id     VARCHAR(255),                          -- NameID from IdP
    ldap_dn          VARCHAR(512),                          -- Distinguished Name from LDAP
    role             VARCHAR(20)  NOT NULL DEFAULT 'user',  -- 'admin' | 'user'
    is_active        BOOLEAN      NOT NULL DEFAULT TRUE,
    last_login       TIMESTAMP WITH TIME ZONE,
    created_at       TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at       TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Seed a default admin (password: ChangeMe2026!)
-- Generated with bcrypt cost 12. Replace immediately after first login.
INSERT INTO users (username, email, password_hash, role)
VALUES (
    'admin',
    'admin@localhost',
    '$2b$12$MhJJV3YtPm6G8Td6My8p7.H.8mLVn3wO0FhwQ/Ip8F9lWsFbzBfsG',
    'admin'
) ON CONFLICT DO NOTHING;

-- ── Auth config (LDAP / SAML stored per-provider) ────────────
CREATE TABLE IF NOT EXISTS auth_config (
    id         SERIAL PRIMARY KEY,
    provider   VARCHAR(20) UNIQUE NOT NULL,  -- 'ldap' | 'saml'
    enabled    BOOLEAN NOT NULL DEFAULT FALSE,
    config     JSONB   NOT NULL DEFAULT '{}',
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO auth_config (provider, enabled, config)
VALUES
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

-- ── Device groups ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS device_groups (
    id          SERIAL PRIMARY KEY,
    name        VARCHAR(255) NOT NULL,
    description TEXT,
    color       VARCHAR(7) DEFAULT '#475569',  -- hex colour for UI badge
    created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at  TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- ── Credential vault ──────────────────────────────────────────
-- All secret fields are AES-256-GCM encrypted (iv:tag:ciphertext in hex, colon-separated)
CREATE TABLE IF NOT EXISTS credentials (
    id                  SERIAL PRIMARY KEY,
    name                VARCHAR(255) NOT NULL,
    username            VARCHAR(255) NOT NULL,
    auth_method         VARCHAR(20)  NOT NULL DEFAULT 'password', -- 'password' | 'key' | 'key+passphrase'
    encrypted_password  TEXT,         -- AES-256-GCM encrypted
    encrypted_key       TEXT,         -- AES-256-GCM encrypted private key (PEM)
    encrypted_passphrase TEXT,        -- AES-256-GCM encrypted key passphrase
    created_by          INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at          TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- ── Devices ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS devices (
    id                    SERIAL PRIMARY KEY,
    name                  VARCHAR(255) NOT NULL,
    hostname              VARCHAR(255) NOT NULL,
    port                  INTEGER      NOT NULL DEFAULT 22,
    device_type           VARCHAR(50)  NOT NULL DEFAULT 'linux',  -- 'linux' | 'cisco_ios' | 'cisco_nxos' | 'junos' | 'windows'
    group_id              INTEGER REFERENCES device_groups(id) ON DELETE SET NULL,
    default_credential_id INTEGER REFERENCES credentials(id) ON DELETE SET NULL,
    description           TEXT,
    tags                  TEXT[],
    created_by            INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at            TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at            TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- ── SSH execution log ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS execution_logs (
    id             SERIAL PRIMARY KEY,
    device_id      INTEGER REFERENCES devices(id) ON DELETE SET NULL,
    template_id    VARCHAR(50),  -- references templates.template_id (soft ref)
    executed_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
    command_text   TEXT    NOT NULL,
    output         TEXT,
    exit_code      INTEGER,
    status         VARCHAR(20) NOT NULL DEFAULT 'running', -- 'running' | 'success' | 'failed'
    started_at     TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    completed_at   TIMESTAMP WITH TIME ZONE
);

-- ── Indexes ────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_users_username       ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_provider       ON users(auth_provider);
CREATE INDEX IF NOT EXISTS idx_devices_group        ON devices(group_id);
CREATE INDEX IF NOT EXISTS idx_devices_cred         ON devices(default_credential_id);
CREATE INDEX IF NOT EXISTS idx_exec_logs_device     ON execution_logs(device_id);
CREATE INDEX IF NOT EXISTS idx_exec_logs_user       ON execution_logs(executed_by);

-- ── updated_at triggers ────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = CURRENT_TIMESTAMP; RETURN NEW; END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_users_updated_at') THEN
    CREATE TRIGGER trg_users_updated_at BEFORE UPDATE ON users
      FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_credentials_updated_at') THEN
    CREATE TRIGGER trg_credentials_updated_at BEFORE UPDATE ON credentials
      FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_devices_updated_at') THEN
    CREATE TRIGGER trg_devices_updated_at BEFORE UPDATE ON devices
      FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  END IF;
END $$;
