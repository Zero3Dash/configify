# configify — Deployment & Operations Guide

**configify** is a self-hosted template studio. Write any text with `{{variable}}` placeholders, save templates to a shared PostgreSQL database, fill them in via an auto-generated form, and execute the result over SSH against a managed device inventory — all from the browser.

**Features:** local accounts · LDAP/AD · SAML 2.0 SSO · AES-256-GCM credential vault · SSH execution with live output · device groups · template folder tree

---

## UI Navigation

configify uses a **left sidebar** for navigation. Each item is a square tile with an icon and label:

| Icon | Label | Page | Description |
|------|-------|------|-------------|
| 📋 | Use | `/` | Select a template, fill variables, execute over SSH |
| 📂 | Templates | `/templates.html` | Create, edit, and delete templates; organise into folders |
| 🖥️ | Devices | `/devices.html` | Manage devices, groups, and credential vault |
| ⚙️ | Admin | `/admin.html` | User accounts and auth providers (admin only) |
| ↩️ | Sign out | — | End the current session |

The active page is highlighted in blue. The Admin item is hidden for non-admin users.

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

### Tips

- Variables are case-sensitive: `{{Interface}}` and `{{interface}}` are treated as separate variables
- Spaces are allowed in variable names: `{{IP Address}}` is valid
- Templates with no variables execute as-is
- The Run button enables once both a template and a device are selected

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
PostgreSQL                ← templates, template_groups, users, devices, credentials, logs
```

### Pages

| URL | Description |
|-----|-------------|
| `/` | Template use page + SSH execution panel |
| `/login.html` | Login (local / LDAP / SAML) |
| `/templates.html` | Template creation, editing, folder tree |
| `/devices.html` | Device inventory + credential vault |
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
| GET | `/api/templates` | user | List templates (includes group_id, group_name) |
| POST | `/api/templates` | user | Create template (accepts group_id) |
| GET | `/api/templates/:id` | user | Get single template (includes body) |
| PUT | `/api/templates/:id` | user | Edit template name, body, and/or group_id |
| DELETE | `/api/templates/:id` | user | Delete template |
| GET | `/api/templates/groups` | user | List all template folders (flat; build tree client-side) |
| POST | `/api/templates/groups` | user | Create folder (accepts name, parent_id) |
| PATCH | `/api/templates/groups/:id` | user | Rename / reparent folder |
| DELETE | `/api/templates/groups/:id` | user | Delete folder (templates ungrouped; children promoted) |
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

In shell mode, configify:
1. Opens a PTY shell on the device
2. Sends each line individually with a 150 ms inter-line delay
3. Monitors output and closes the session after 2 s of silence
4. Enforces a 90 s hard timeout to prevent hung sessions

### How polling works

configify uses **HTTP polling** — no WebSockets required.

1. Click **▶ Run on device** → `POST /api/ssh/execute` starts the SSH job and returns `{ jobId }`
2. Browser polls `GET /api/ssh/poll/:jobId` every 800 ms
3. Each poll returns new output since the last call plus the job status (`running` / `done` / `error`)
4. Terminal updates in real time; polling stops when the job finishes

### Troubleshooting SSH

```bash
pm2 logs configify-app --lines 50
```

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| "No credential specified" | Device has no default credential | Edit device → assign default credential |
| "Failed to decrypt password" | `VAULT_SECRET` changed | Restore original `VAULT_SECRET` or re-enter credential |
| "connect ECONNREFUSED" | Wrong host/port or firewall | Test: `ssh -p <port> <user>@<host>` from server |
| "All configured authentication methods failed" | Wrong password/key | Re-enter credential in vault |
| Poll returns 404 | Server restarted mid-job (in-memory jobs lost) | Click Run again |
| Commands execute but session hangs | Device prompt not detected | Session will auto-close after 2 s idle or 90 s hard cap |

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

Installs Node.js 20, PostgreSQL 17, Nginx, PM2, generates secrets, applies schema, configures self-signed SSL.

---

## Manual install

### 1 — Get the code

```bash
git clone https://github.com/Zero3Dash/configify.git
sudo mv configify /var/www/configify
sudo chown -R $USER:$USER /var/www/configify
cd /var/www/configify
```

### 2 — System packages

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl wget git ufw build-essential openssl
sudo ufw allow OpenSSH && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp && sudo ufw enable
```

### 3 — Node.js 20

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
```

### 4 — PostgreSQL 17

```bash
sudo apt install -y postgresql-17
sudo systemctl enable --now postgresql
sudo -i -u postgres psql <<'SQL'
CREATE DATABASE configify_db;
CREATE USER configify_user WITH PASSWORD 'YourStrongPasswordHere';
GRANT ALL PRIVILEGES ON DATABASE configify_db TO configify_user;
\c configify_db
GRANT ALL ON SCHEMA public TO configify_user;
\q
SQL
```

### 5 — Apply schema

```bash
psql -h localhost -U configify_user -d configify_db -f schema.sql -W
```

### 6 — Install packages & configure environment

```bash
npm install --omit=dev
cp .env.example .env && chmod 600 .env
```

Edit `.env` — generate secrets with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

> ⚠️ **Back up `VAULT_SECRET` immediately.** If lost, all stored SSH credentials become permanently unrecoverable.

### 7 — PM2

```bash
sudo npm install -g pm2
sudo mkdir -p /var/log/configify && sudo chown $USER /var/log/configify
pm2 start ecosystem.config.js && pm2 save && pm2 startup
```

### 8 — Nginx + SSL

**Let's Encrypt:**
```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d configify.yourdomain.com
sudo cp configify-letsencrypt /etc/nginx/sites-available/configify
```

**Self-signed:**
```bash
sudo openssl req -x509 -nodes -days 3650 -newkey rsa:2048 \
    -keyout /etc/ssl/private/configify.key \
    -out /etc/ssl/certs/configify.crt \
    -subj "/CN=configify.yourdomain.com"
sudo cp configify-selfsigned /etc/nginx/sites-available/configify
```

```bash
sudo ln -s /etc/nginx/sites-available/configify /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

---

## Upgrading from an earlier version

If you have an existing install that was set up before the schema was unified, run this migration instead of re-applying `schema.sql` (which is for fresh installs):

```sql
-- Run as configify_user against configify_db

-- Template folder tree (v3 additions)
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

-- SSH log credential tracking (added in v2.3)
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

All passwords and private keys are AES-256-GCM encrypted at rest using `VAULT_SECRET`. The API never returns plaintext secrets.

### Auth methods

| Method | When to use |
|--------|-------------|
| Password | Standard SSH password auth |
| SSH Private Key | RSA/Ed25519 PEM key, no passphrase |
| SSH Private Key + Passphrase | Encrypted private key |

---

## Database backup

```bash
sudo cp backup-configify-db.sh /usr/local/bin/
sudo chmod +x /usr/local/bin/backup-configify-db.sh
# Daily cron at 02:00
sudo crontab -u postgres -e
# 0 2 * * * /usr/local/bin/backup-configify-db.sh
```

**Restore:**
```bash
gunzip -c /var/backups/postgresql/configify_db_YYYYMMDD_HHMMSS.sql.gz \
  | psql -h localhost -U configify_user -d configify_db -W
```

---

## Operations

```bash
bash /var/www/configify/check-status.sh   # health check
pm2 status                                 # process table
pm2 logs configify-app                     # live log tail
pm2 restart configify-app                  # restart after update
```

### Update

```bash
cd /var/www/configify
git pull
npm install --omit=dev
pm2 restart configify-app
```

---

## Security notes

- All routes except `/auth/*` and `/login.html` require a valid session
- Credential secrets never leave the server in plaintext
- Session cookies are `httpOnly`, `secure` (production), 8-hour expiry
- Only `admin` role can delete users, devices, credentials, and groups
- PostgreSQL bound to `localhost` only
- SSH host keys accepted automatically; verify fingerprints out-of-band if needed

```bash
sudo apt install -y fail2ban && sudo systemctl enable --now fail2ban
```

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
├── schema.sql               ← unified database schema (all tables, indexes, triggers, seed data)
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
│   └── templates.js         ← /api/templates/* + /api/templates/groups/*
└── public/
    ├── index.html           ← Template use + SSH execution
    ├── login.html           ← Login page (local / LDAP / SAML)
    ├── templates.html       ← Template CRUD + folder tree panel
    ├── devices.html         ← Device inventory + credential vault
    └── admin.html           ← User + auth config
```

---

## Changelog

### v2.4 (current)

- **Unified schema** — `schema.sql`, `schema_v2.sql`, and `schema_v3.sql` merged into a single `schema.sql`. Fresh installs apply one file; existing installs can use the SQL snippet in the *Upgrading* section above.
- **Template folder tree** — Templates can be organised into a multi-level folder hierarchy. The Templates page gains a 240 px sticky folder panel with inline create/rename/delete controls. The template dropdown on the Use page groups options under `📁 Folder / Path` optgroups. Moving a template to a different folder is available from the template list without opening the editor.

### v2.3
- **Fixed multi-line SSH execution for network devices** — `execCommand` sent the entire template as a single string, causing Cisco IOS to error with `Line has invalid autocommand "..."`. Multi-line templates and network device types (`cisco_ios`, `cisco_nxos`, `junos`, `windows`) now use PTY shell mode, sending each line individually with a 150 ms inter-line delay. Sessions close automatically after 2 s of output silence or a 90 s hard cap.
- **Added template editing** — Templates page now has an ✏️ Edit button per template that opens a full-screen modal pre-populated with the template name and body. Changes are saved via `PUT /api/templates/:id`. Variable chip preview and character count update live while editing.

### v2.2
- **Fixed variable fields not appearing on Use page** — root cause was `show()` setting `style.display = ''` which cannot override a CSS-class `display:none`; now uses `classList.add/remove('visible')` which correctly triggers the `.visible` rule
- **Templates page simplified** — now a focused creation form; existing templates shown as a compact deletable list below with a Use button linking directly to the Use page
- **Use page step indicators** — numbered step badges highlight as you progress through select → variables → device → run

### v2.1
- Left sidebar navigation with square icon tiles
- Live template variable filling — output updates as you type
- Unfilled variables highlighted yellow; filled values shown green
