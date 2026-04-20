# configify — Deployment & Operations Guide

**configify** is a self-hosted template studio. Write any text with `{{variable}}` placeholders, save templates to a shared PostgreSQL database, fill them in via an auto-generated form, and execute the result over SSH against a managed device inventory — all from the browser.

**Features:** local accounts · LDAP/AD · SAML 2.0 SSO · AES-256-GCM credential vault · SSH execution with live output · device groups · template folder tree · **Cisco IOS/NX-OS configuration compliance**

---

## UI Navigation

configify uses a **left sidebar** for navigation. Each item is a square tile with an icon and label:

| Icon | Label | Page | Description |
|------|-------|------|-------------|
| 📋 | Use | `/` | Select a template, fill variables, execute over SSH |
| 📂 | Templates | `/templates.html` | Create, edit, and delete templates; organise into folders |
| 🖥️ | Devices | `/devices.html` | Manage devices, groups, and credential vault |
| 🛡️ | Compliance | `/compliance.html` | Golden config checking for Cisco IOS & NX-OS |
| ⚙️ | Admin | `/admin.html` | User accounts and auth providers (admin only) |
| ↩️ | Sign out | — | End the current session |

The active page is highlighted in blue. The Admin item is hidden for non-admin users.

---

## Configuration Compliance

The Compliance section lets you define **golden configurations** — sets of expected configuration lines — and validate them against the live `show running-config` output of your Cisco IOS and NX-OS devices.

### Supported device types

| Device type | SSH command |
|-------------|-------------|
| `cisco_ios` | `terminal length 0` → `show running-config` |
| `cisco_nxos` | `terminal length 0` → `show running-config` |

> Other device types (linux, windows, junos) are not checked by the compliance engine and will be skipped even if assigned.

### Golden configurations

A golden config contains the **expected lines** that must be present in the device's running configuration.

**Matching rules:**
- Each non-blank, non-comment line (lines starting with `!`) must appear **verbatim** somewhere in the `show running-config` output
- Line indentation is preserved — an indented line under an interface block must match with its indentation
- The order of lines in the golden config does not matter
- The `terminal length 0` command is sent first to disable IOS paging

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
3. Send `terminal length 0` (disable paging)
4. Send `show running-config`
5. Wait for output to settle (3 s of silence) or 60 s hard cap
6. Disconnect
7. Compare each golden config line against the collected output
8. Persist result to `compliance_results` table

### Troubleshooting compliance

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| "No eligible devices found" | No assignments, or devices have unsupported types | Add assignments; check device type is cisco_ios or cisco_nxos |
| Device shows "Error" | No default credential, SSH refused, or VAULT_SECRET mismatch | Assign a credential; test SSH manually |
| Lines marked missing despite being present | Indentation mismatch or invisible characters | Paste lines directly from `show running-config` output into the golden config |
| Timeout / empty config | Paging still active (IOS prompt returned before full config) | Device may not support `terminal length 0`; try reducing config size or splitting into multiple golden configs |

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
PostgreSQL                ← templates, users, devices, credentials, golden_configs, compliance_results, logs
```

### Pages

| URL | Description |
|-----|-------------|
| `/` | Template use page + SSH execution panel |
| `/login.html` | Login (local / LDAP / SAML) |
| `/templates.html` | Template creation, editing, folder tree |
| `/devices.html` | Device inventory + credential vault |
| `/compliance.html` | Configuration compliance dashboard |
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
| GET | `/api/devices/credentials` | user | List credentials (no secrets) |
| POST | `/api/devices/credentials` | user | Add credential |
| PATCH | `/api/devices/credentials/:id` | user | Edit credential |
| DELETE | `/api/devices/credentials/:id` | **admin** | Delete credential |
| POST | `/api/ssh/execute` | user | Start SSH job → `{ jobId }` |
| GET | `/api/ssh/poll/:jobId` | user | Poll job output |
| GET | `/api/devices/:id/logs` | user | Execution history for device |
| **GET** | **`/api/compliance/golden-configs`** | user | List golden configs |
| **POST** | **`/api/compliance/golden-configs`** | user | Create golden config |
| **GET** | **`/api/compliance/golden-configs/:id`** | user | Get golden config (with config_text) |
| **PUT** | **`/api/compliance/golden-configs/:id`** | user | Update golden config |
| **DELETE** | **`/api/compliance/golden-configs/:id`** | **admin** | Delete golden config |
| **GET** | **`/api/compliance/assignments`** | user | List assignments |
| **POST** | **`/api/compliance/assignments`** | user | Create assignment |
| **DELETE** | **`/api/compliance/assignments/:id`** | user | Remove assignment |
| **GET** | **`/api/compliance/dashboard`** | user | Summary stats + latest results |
| **GET** | **`/api/compliance/results/:id`** | user | Full detail for a single result |
| **POST** | **`/api/compliance/check`** | user | Start compliance check job |
| **GET** | **`/api/compliance/poll/:jobId`** | user | Poll check progress |
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

### Upgrading to v2.5 (adds compliance checking)

If you have an existing install, run the compliance schema migration:

```bash
PGPASSWORD=your_db_password psql -h localhost -U configify_user -d configify_db \
    -f /var/www/configify/schema_compliance.sql
```

Then apply the sidebar patch to add the Compliance nav item:

```bash
cd /var/www/configify
python3 apply_compliance_patch.py
pm2 restart configify-app
```

### Upgrading to v2.4 (template folder tree)

```sql
-- Run as configify_user against configify_db
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

All passwords and private keys are AES-256-GCM encrypted at rest using `VAULT_SECRET`.

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
- Credential secrets never leave the server in plaintext
- Session cookies are `httpOnly`, `secure` (production), 8-hour expiry
- Only `admin` role can delete users, devices, credentials, groups, and golden configs
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
├── schema.sql               ← unified database schema (all tables, fresh installs)
├── schema_compliance.sql    ← compliance tables only (for upgrading existing installs)
├── apply_compliance_patch.py← adds 🛡️ Compliance sidebar link to all HTML pages
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
│   ├── devices.js           ← /api/devices/*
│   ├── ssh.js               ← /api/ssh/* (polling-based; auto shell/exec mode)
│   ├── templates.js         ← /api/templates/* + /api/templates/groups/*
│   └── compliance.js        ← /api/compliance/* (golden configs, assignments, checks)
└── public/
    ├── index.html           ← Template use + SSH execution
    ├── login.html           ← Login page (local / LDAP / SAML)
    ├── templates.html       ← Template CRUD + folder tree panel
    ├── devices.html         ← Device inventory + credential vault
    ├── compliance.html      ← Configuration compliance dashboard
    └── admin.html           ← User + auth config
```

---

## Changelog

### v2.5 (current)

- **Configuration compliance** — new Compliance section (🛡️ sidebar) for Cisco IOS and NX-OS devices.
  - **Golden configs** — define expected configuration lines; blank lines and IOS comments (`!`) are ignored automatically.
  - **Assignments** — link a golden config to a specific device or an entire device group (group assignments expand to all member devices at check time).
  - **Async check engine** — SSH-based, same polling pattern as template execution. Sends `terminal length 0` + `show running-config` via PTY shell. Results stored in `compliance_results`.
  - **Dashboard** — live stats (total / compliant / non-compliant / error / compliance rate), per-device compliance table with progress bars, line-by-line detail modal, per-pair re-check.
  - New files: `routes/compliance.js`, `public/compliance.html`, `schema_compliance.sql`, `apply_compliance_patch.py`.
  - Updated: `server.js`, `schema.sql`, `README.md`.

### v2.4

- **Unified schema** — `schema.sql`, `schema_v2.sql`, and `schema_v3.sql` merged.
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
