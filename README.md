# configify — Deployment & Operations Guide

**configify** is a self-hosted template studio. Write any text with `{{variable}}` placeholders, save templates to a shared PostgreSQL database, fill them in via an auto-generated form, and execute the result over SSH against a managed device inventory — all from the browser.

**Features:** local accounts · LDAP/AD · SAML 2.0 SSO · AES-256-GCM credential vault · SSH execution with live output · device groups · template folder tree · **Cisco IOS/NX-OS configuration compliance** · **automated compliance schedules** · **enable/privilege-escalation password support**

---

## UI Navigation

configify uses a **left sidebar** for navigation. Each item is a square tile with an icon and label:

| Icon | Label | Page | Description |
|------|-------|------|-------------|
| 📋 | Use | `/` | Select a template, fill variables, execute over SSH |
| 📂 | Templates | `/templates.html` | Create, edit, and delete templates; organise into folders |
| 🖥️ | Devices | `/devices.html` | Manage devices, groups, and credential vault |
| 🛡️ | Compliance | `/compliance.html` | Golden config checking for Cisco IOS & NX-OS |
| 🔧 | Settings | `/settings.html` | Automated compliance schedules |
| ⚙️ | Admin | `/admin.html` | User accounts and auth providers (admin only) |
| ↩️ | Sign out | — | End the current session |

The active page is highlighted in blue. The Admin item is hidden for non-admin users.

---

## Credential Vault & Enable Password

All credentials are stored AES-256-GCM encrypted at rest using `VAULT_SECRET`. Plaintext secrets are never returned by the API.

### Enable / privilege-escalation password

Many Cisco IOS and NX-OS devices start an SSH session at **user EXEC mode** (`>`). Before running configuration commands or compliance checks, the device must be elevated to **privileged EXEC mode** (`#`) using the `enable` command.

configify handles this automatically when an **enable password** is stored on the credential:

**Privilege escalation sequence:**

```
SSH connect  →  user EXEC (>)
  → send: enable
  → wait 600 ms
  → send: <enable password>
  → wait 600 ms
  → now in privileged EXEC (#)
  → send template commands / show running-config
```

**Configuring an enable password:**

1. Go to **Devices → Credentials tab → Add or Edit a credential**
2. Fill in the amber **Enable password** section at the bottom of the form
3. Leave blank to keep an existing value; click **✕ Clear** to remove it
4. Save — the password is encrypted immediately with AES-256-GCM

**When enable is used:**

| Device type | Enable sequence sent |
|-------------|----------------------|
| `cisco_ios` | Yes — if enable password is set on the credential |
| `cisco_nxos` | Yes — if enable password is set on the credential |
| `junos` | Yes — if enable password is set on the credential |
| `linux`, `windows`, `other` | Never |

The enable badge (⚡) appears on the credential list and the device's Default Credential cell when an enable password is stored.

---

## Configuration Compliance

The Compliance section lets you define **golden configurations** — sets of expected configuration lines — and validate them against the live `show running-config` output of your Cisco IOS and NX-OS devices.

### Supported device types

| Device type | SSH command |
|-------------|-------------|
| `cisco_ios` | (`enable`) → `terminal length 0` → `show running-config` |
| `cisco_nxos` | (`enable`) → `terminal length 0` → `show running-config` |

> Other device types (linux, windows, junos) are not checked by the compliance engine and will be skipped even if assigned. The enable sequence is applied to compliance checks automatically when the device's default credential has an enable password.

### Golden configurations

A golden config contains the **expected lines** that must be present in the device's running configuration.

**Matching rules:**
- Each non-blank, non-comment line (lines starting with `!`) must appear **verbatim** somewhere in the `show running-config` output
- Line indentation is preserved — an indented line under an interface block must match with its indentation
- The order of lines in the golden config does not matter
- `terminal length 0` is sent first to disable IOS paging

**Example golden config** (NTP, logging, and SSH hardening baseline):
```
ntp server 10.0.0.1
ntp server 10.0.0.2
logging host 10.0.0.100
logging trap informational
service timestamps log datetime msec
ip ssh version 2
ip ssh time-out 60
no service telnet
```

### Workflow

1. **Create a golden config** — Compliance → Golden Configs → "+ New golden config"
2. **Assign it** — Compliance → Assignments → "+ New assignment"
   - Assign to a specific device, or to an entire device group (applies to all current and future members)
3. **Run checks** — Compliance → Dashboard → "▶ Run all checks"
   - Or run a single golden config: Golden Configs → "▶ Check all"
   - Or re-check a single device/policy pair from the dashboard table
4. **View results** — The dashboard updates with compliance status per device per golden config

### Automated schedules

Configure recurring compliance checks via **Settings** (🔧):

- Each schedule targets either a specific golden config or runs a full audit across all assignments
- Interval options from 1 hour to weekly
- Schedules run server-side; the server polls for due jobs every 60 seconds
- Results appear automatically in the Compliance dashboard

Admin role is required to create or modify schedules.

### Dashboard

The dashboard shows:
- **Stat cards** — total checks, compliant, non-compliant, errors, compliance rate
- **Device table** — one row per (device, golden config) pair, showing:
  - Compliance status badge (✓ Compliant / ✗ Non-compliant / ⚠ Error)
  - Lines matched progress bar (e.g. 12/15)
  - Last checked timestamp
  - "Detail" button — shows line-by-line results (✓ found / ✗ missing)
  - "Re-check" button — re-runs just that device/policy pair

### Compliance check internals

The check is asynchronous and uses the same SSH polling pattern as template execution:

1. `POST /api/compliance/check` → starts job, returns `{ jobId }`
2. Browser polls `GET /api/compliance/poll/:jobId` every 1.2 s
3. Each poll returns `{ status, completed, total, newLog, results }`
4. On completion, dashboard data is refreshed automatically

Per-device steps:
1. Connect via SSH (uses device's default credential)
2. Open PTY shell
3. If enable password is stored: send `enable` → wait → send password → wait
4. Send `terminal length 0` (disable paging)
5. Send `show running-config`
6. Wait for output to settle (3 s of silence) or 60 s hard cap
7. Disconnect
8. Compare each golden config line against the collected output
9. Persist result to `compliance_results` table

### Troubleshooting compliance

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| "No eligible devices found" | No assignments, or devices have unsupported types | Add assignments; check device type is cisco_ios or cisco_nxos |
| Device shows "Error" | No default credential, SSH refused, or VAULT_SECRET mismatch | Assign a credential; test SSH manually |
| Lines marked missing despite being present | Indentation mismatch or invisible characters | Paste lines directly from `show running-config` output into the golden config |
| Config retrieved shows only user EXEC output | Device requires enable password but none is set | Add enable password to the credential |
| Timeout / empty config | Paging still active (IOS prompt returned before full config) | Device may not support `terminal length 0`; try reducing config size or splitting into multiple golden configs |
| Database error on schedule creation | `compliance_schedules` table missing | Run the migration snippet below or re-apply `schema.sql` |

---

## Using Templates

### Workflow

1. **Select template** — pick from the dropdown on the Use page (`/`). Templates are grouped into folders in the dropdown.
2. **Fill variables** — input fields appear immediately; output updates **live as you type**
3. **Select device** — choose a target from the SSH panel on the right
4. **Click Run** — configify connects via SSH and streams output to the terminal

### Variable syntax

Use `{{Variable Name}}` in your template body. Variables are extracted automatically and an input field is generated for each one. Unfilled variables show highlighted in yellow in the output preview; filled values appear in green.

```
interface {{Interface}}
 ip address {{IP Address}} {{Subnet Mask}}
 no shutdown
ip route 0.0.0.0 0.0.0.0 {{Default Gateway}}
```

### Template folders

Templates can be organised into a multi-level folder tree on the **Templates** page:

- The left panel shows the folder tree. Click any folder to filter the template list.
- Use **＋** (top of folder panel) to create a top-level folder.
- Hover a folder node to reveal inline **📁+ subfolder**, **✏ rename**, and **✕ delete** buttons.
- Each template row has a **📁 Move** button to change its folder without opening the editor.
- When a folder is deleted, its templates become ungrouped and direct child folders are promoted one level up.

---

## Architecture

```
Browser
  │
  ▼
Nginx (443 TLS)           ← reverse proxy
  │
  ▼
Node.js / Express (3000)  ← API + static files
  │
  ▼
PostgreSQL                ← templates, users, devices, credentials,
                             golden_configs, compliance_results,
                             compliance_schedules, logs
```

### Pages

| URL | Description |
|-----|-------------|
| `/` | Template use page + SSH execution panel |
| `/login.html` | Login (local / LDAP / SAML) |
| `/templates.html` | Template creation, editing, folder tree |
| `/devices.html` | Device inventory + credential vault (incl. enable password) |
| `/compliance.html` | Configuration compliance dashboard |
| `/settings.html` | Automated compliance schedules |
| `/admin.html` | User admin + auth provider config |

### API routes

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/auth/login/local` | public | Local login |
| POST | `/auth/login/ldap` | public | LDAP login |
| GET | `/auth/saml/login` | public | SAML redirect to IdP |
| POST | `/auth/saml/callback` | public | SAML ACS callback |
| GET | `/auth/me` | user | Current user info |
| POST | `/auth/logout` | user | Destroy session |
| GET | `/api/templates` | user | List templates |
| POST | `/api/templates` | user | Create template |
| GET | `/api/templates/:id` | user | Get single template |
| PUT | `/api/templates/:id` | user | Edit template |
| DELETE | `/api/templates/:id` | user | Delete template |
| GET | `/api/templates/groups` | user | List template folders |
| POST | `/api/templates/groups` | user | Create folder |
| PATCH | `/api/templates/groups/:id` | user | Rename / reparent folder |
| DELETE | `/api/templates/groups/:id` | user | Delete folder |
| GET | `/api/devices` | user | List devices |
| POST | `/api/devices` | user | Add device |
| PATCH | `/api/devices/:id` | user | Edit device |
| DELETE | `/api/devices/:id` | **admin** | Delete device |
| GET | `/api/devices/groups` | user | List device groups |
| POST | `/api/devices/groups` | user | Add device group |
| PATCH | `/api/devices/groups/:id` | user | Edit device group |
| DELETE | `/api/devices/groups/:id` | **admin** | Delete device group |
| GET | `/api/devices/credentials` | user | List credentials (no secrets; `has_enable_password` boolean) |
| POST | `/api/devices/credentials` | user | Add credential (accepts `enable_password`) |
| PATCH | `/api/devices/credentials/:id` | user | Edit credential (pass `""` to clear enable password) |
| DELETE | `/api/devices/credentials/:id` | **admin** | Delete credential |
| POST | `/api/ssh/execute` | user | Start SSH job → `{ jobId }` |
| GET | `/api/ssh/poll/:jobId` | user | Poll job output |
| GET | `/api/devices/:id/logs` | user | Execution history for device |
| GET | `/api/compliance/golden-configs` | user | List golden configs |
| POST | `/api/compliance/golden-configs` | user | Create golden config |
| GET | `/api/compliance/golden-configs/:id` | user | Get golden config (with config_text) |
| PUT | `/api/compliance/golden-configs/:id` | user | Update golden config |
| DELETE | `/api/compliance/golden-configs/:id` | **admin** | Delete golden config |
| GET | `/api/compliance/assignments` | user | List assignments |
| POST | `/api/compliance/assignments` | user | Create assignment |
| POST | `/api/compliance/assignments/bulk` | user | Bulk create assignments |
| DELETE | `/api/compliance/assignments/:id` | user | Remove assignment |
| GET | `/api/compliance/dashboard` | user | Summary stats + latest results |
| GET | `/api/compliance/results/:id` | user | Full detail for a single result |
| POST | `/api/compliance/check` | user | Start compliance check job |
| GET | `/api/compliance/poll/:jobId` | user | Poll check progress |
| GET | `/api/compliance/schedules` | user | List schedules |
| POST | `/api/compliance/schedules` | **admin** | Create schedule |
| PATCH | `/api/compliance/schedules/:id` | **admin** | Update schedule |
| DELETE | `/api/compliance/schedules/:id` | **admin** | Delete schedule |
| GET | `/api/users` | **admin** | List users |
| POST | `/api/users` | **admin** | Create local user |
| PATCH | `/api/users/:id` | **admin** | Edit user |
| DELETE | `/api/users/:id` | **admin** | Delete user |
| GET | `/api/users/auth-config/:provider` | **admin** | Get LDAP/SAML config |
| PUT | `/api/users/auth-config/:provider` | **admin** | Update LDAP/SAML config |

---

## SSH Execution

### Execution strategy

configify automatically selects the right execution mode based on the template and device type:

| Condition | Mode | Why |
|-----------|------|-----|
| Single-line command on Linux/Unix | `execCommand` | Clean exit code, minimal overhead |
| Multi-line template (any device) | PTY shell | Commands must be sent one at a time |
| `cisco_ios`, `cisco_nxos`, `junos`, `windows` (any line count) | PTY shell | These devices do not support `execCommand`-style execution |

### Enable / privilege escalation (PTY shell mode only)

When a credential has an enable password **and** the device type is `cisco_ios`, `cisco_nxos`, or `junos`, configify prepends the following to the command sequence before any template lines:

```
send: enable
wait: 600 ms   ← device presents "Password:" prompt
send: <enable password>
wait: 600 ms   ← device presents "#" prompt
```

This is fully automatic — no changes are needed to template content.

---

## Prerequisites

- Ubuntu 24.04 (or compatible Debian-based OS), min 1 GB RAM
- SSH access with sudo

## Quick install (Ubuntu 24.04)

```bash
git clone https://github.com/Zero3Dash/configify.git
cd configify
sudo bash setup.sh
```

---

## Upgrading from an earlier version

### Upgrading to v2.7 (enable password support)

Add the new column to an existing install:

```sql
-- Run as configify_user against configify_db
ALTER TABLE credentials ADD COLUMN IF NOT EXISTS encrypted_enable_password TEXT;
```

Then restart the app:

```bash
pm2 restart configify-app
```

> `schema.sql` already includes this `ALTER TABLE … ADD COLUMN IF NOT EXISTS` statement, so re-applying the schema is also safe.

### Upgrading to v2.6 (merges schema files; adds Settings nav to all pages)

`schema.sql` is now the single source of truth for all tables. The separate `schema_compliance.sql` and `schema_schedules.sql` files are deprecated. For existing installs, add the `compliance_schedules` table if it doesn't already exist:

```sql
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
CREATE INDEX IF NOT EXISTS idx_comp_sched_next_run
    ON compliance_schedules(enabled, next_run) WHERE enabled = TRUE;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_comp_schedules_updated_at') THEN
        CREATE TRIGGER trg_comp_schedules_updated_at
            BEFORE UPDATE ON compliance_schedules
            FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    END IF;
END $$;
```

Then restart: `pm2 restart configify-app`

### Upgrading to v2.5 (adds compliance checking)

```bash
PGPASSWORD=your_db_password psql -h localhost -U configify_user -d configify_db \
    -f /var/www/configify/schema.sql
pm2 restart configify-app
```

### Upgrading to v2.4 (template folder tree)

```sql
CREATE TABLE IF NOT EXISTS template_groups (
    id         SERIAL PRIMARY KEY,
    name       VARCHAR(255) NOT NULL,
    parent_id  INTEGER REFERENCES template_groups(id) ON DELETE CASCADE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_tpl_groups_parent ON template_groups(parent_id);
ALTER TABLE templates ADD COLUMN IF NOT EXISTS group_id
    INTEGER REFERENCES template_groups(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_templates_group ON templates(group_id);
ALTER TABLE execution_logs ADD COLUMN IF NOT EXISTS credential_id
    INTEGER REFERENCES credentials(id) ON DELETE SET NULL;
```

---

## First login

Navigate to `https://configify.yourdomain.com`

- **Username:** `admin`
- **Password:** `ChangeMe2026!`

Change this immediately in **Admin → Users → Edit**.

---

## Authentication setup

### Local accounts
Managed through **Admin → Users**. Passwords bcrypt-hashed at cost 12.

### LDAP / Active Directory
1. **Admin → Auth Providers → LDAP/AD**, fill in directory settings, enable, save.
2. `pm2 restart configify-app`

### SAML 2.0
1. Register configify as SP in your IdP (ACS URL: `https://yourdomain/auth/saml/callback`)
2. **Admin → Auth Providers → SAML 2.0**, fill in IdP details, enable, save.
3. `pm2 restart configify-app`

---

## Device & credential vault

All passwords, private keys, and enable passwords are AES-256-GCM encrypted at rest using `VAULT_SECRET`. The API never returns plaintext secrets; the credentials list returns a `has_enable_password` boolean instead.

---

## Database backup

```bash
sudo cp backup-configify-db.sh /usr/local/bin/
sudo chmod +x /usr/local/bin/backup-configify-db.sh
sudo crontab -u postgres -e
# 0 2 * * * /usr/local/bin/backup-configify-db.sh
```

---

## Operations

```bash
bash /var/www/configify/check-status.sh   # health check
pm2 status                                 # process table
pm2 logs configify-app                     # live log tail
pm2 restart configify-app                  # restart after update
```

---

## Security notes

- All routes except `/auth/*` and `/login.html` require a valid session
- Credential secrets (password, private key, passphrase, enable password) never leave the server in plaintext
- Session cookies are `httpOnly`, `secure` (production), 8-hour expiry
- Only `admin` role can delete users, devices, credentials, groups, and golden configs
- Only `admin` role can create or modify compliance schedules
- PostgreSQL bound to `localhost` only
- Compliance checks use only the device's assigned default credential

---

## File structure

```
/var/www/configify/
├── server.js                ← Express entry point
├── db.js                    ← PostgreSQL pool
├── package.json
├── ecosystem.config.js      ← PM2 config
├── .env                     ← runtime secrets (chmod 600, not in git)
├── .env.example
├── schema.sql               ← UNIFIED schema (all tables — use this for all installs)
├── schema_compliance.sql    ← DEPRECATED — see schema.sql
├── schema_schedules.sql     ← DEPRECATED — see schema.sql
├── apply_compliance_patch.py← legacy sidebar patcher (no longer needed from v2.6)
├── setup.sh                 ← one-shot install script
├── check-status.sh          ← health check
├── backup-configify-db.sh   ← DB backup + rotation
├── configify-letsencrypt    ← Nginx config (Let's Encrypt)
├── configify-selfsigned     ← Nginx config (self-signed)
├── auth/index.js            ← Passport: local / LDAP / SAML
├── crypto/vault.js          ← AES-256-GCM encrypt/decrypt
├── middleware/auth.js       ← requireAuth / requireAdmin
├── routes/
│   ├── auth.js              ← /auth/*
│   ├── users.js             ← /api/users/* + auth-config
│   ├── devices.js           ← /api/devices/* (incl. enable_password vault)
│   ├── ssh.js               ← /api/ssh/* (polling-based; auto shell/exec + enable mode)
│   ├── templates.js         ← /api/templates/* + /api/templates/groups/*
│   └── compliance.js        ← /api/compliance/* (golden configs, assignments, checks, schedules)
└── public/
    ├── index.html           ← Template use + SSH execution
    ├── login.html           ← Login page (local / LDAP / SAML)
    ├── templates.html       ← Template CRUD + folder tree panel
    ├── devices.html         ← Device inventory + credential vault (enable password UI)
    ├── compliance.html      ← Configuration compliance dashboard
    ├── settings.html        ← Automated compliance schedules
    └── admin.html           ← User + auth config
```

---

## Changelog

### v2.7 (current)

- **Enable password / privilege escalation** — credential vault now stores an optional encrypted enable password for Cisco IOS, NX-OS, and JunOS devices.
  - New column `encrypted_enable_password` on the `credentials` table (AES-256-GCM encrypted; nullable). Existing installs are migrated automatically by an `ALTER TABLE … ADD COLUMN IF NOT EXISTS` guard in `schema.sql`.
  - When a credential has an enable password and is used with a `cisco_ios`, `cisco_nxos`, or `junos` device, configify automatically sends `enable\n<password>\n` before any template commands or compliance checks, bringing the device from user-EXEC (`>`) to privileged-EXEC (`#`). A 600 ms settle delay is applied after each step.
  - **Credential modal** (Devices page) — amber "⚡ Enable password" section added with inline help text, keep-existing behaviour (blank field = unchanged), and a "✕ Clear saved enable password" button to remove a stored value.
  - **Credential list** — new "Enable" column shows a ⚡ badge when an enable password is configured.
  - **Device list** — the Default Credential cell shows an `enable` badge when the assigned credential has an enable password stored.
  - The `GET /api/devices/credentials` response now includes `has_enable_password` (boolean) — the actual encrypted value is never returned.

### v2.6

- **Settings nav link on all pages** — 🔧 Settings sidebar item now appears consistently on every page.
- **Merged schema files** — `schema.sql` is now the single unified schema file. `schema_compliance.sql` and `schema_schedules.sql` are deprecated.
- **Fixed compliance schedule database error** — `compliance_schedules` table is now part of the main `schema.sql`.

### v2.5

- **Configuration compliance** — new Compliance section (🛡️ sidebar) for Cisco IOS and NX-OS devices.
  - Golden configs, assignments (bulk), async check engine, automated schedules, dashboard.

### v2.4

- **Unified schema** — merged schema files.
- **Template folder tree** — multi-level folder hierarchy for templates.

### v2.3
- **Fixed multi-line SSH execution for network devices** — PTY shell mode with per-line delay.
- **Added template editing** — ✏️ Edit button with full-screen modal.

### v2.2
- **Fixed variable fields not appearing on Use page**
- **Templates page simplified**
- **Use page step indicators**

### v2.1
- Left sidebar navigation
- Live template variable filling
