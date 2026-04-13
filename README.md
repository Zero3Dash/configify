# configify — Deployment & Operations Guide

**configify** is a self-hosted template studio. Write any text with `{{variable}}` placeholders, save templates to a shared PostgreSQL database, fill them in via an auto-generated form, and execute the result over SSH against a managed device inventory — all from the browser.

**Features:** local accounts · LDAP/AD · SAML 2.0 SSO · AES-256-GCM credential vault · SSH execution with live output · device groups

---

## UI Navigation

configify uses a **left sidebar** for navigation. Each item is a square tile with an icon and label:

| Icon | Label | Page | Description |
|------|-------|------|-------------|
| 📋 | Use | `/` | Select a template, fill variables, execute over SSH |
| 📂 | Templates | `/templates.html` | Create and delete templates |
| 🖥️ | Devices | `/devices.html` | Manage devices, groups, and credential vault |
| ⚙️ | Admin | `/admin.html` | User accounts and auth providers (admin only) |
| ↩️ | Sign out | — | End the current session |

The active page is highlighted in blue. The Admin item is hidden for non-admin users.

---

## Using Templates

### Workflow

1. **Select template** — pick from the dropdown on the Use page (`/`)
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
PostgreSQL                ← templates, users, devices, credentials, logs
```

### Pages

| URL | Description |
|-----|-------------|
| `/` | Template use page + SSH execution panel |
| `/login.html` | Login (local / LDAP / SAML) |
| `/templates.html` | Template creation + delete list |
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
| GET | `/api/templates` | user | List templates |
| POST | `/api/templates` | user | Create template |
| GET | `/api/templates/:id` | user | Get single template (includes body) |
| DELETE | `/api/templates/:id` | user | Delete template |
| GET | `/api/devices` | user | List devices |
| POST | `/api/devices` | user | Add device |
| PATCH | `/api/devices/:id` | user | Edit device |
| DELETE | `/api/devices/:id` | **admin** | Delete device |
| GET | `/api/devices/groups` | user | List groups |
| POST | `/api/devices/groups` | user | Add group |
| PATCH | `/api/devices/groups/:id` | user | Edit group |
| DELETE | `/api/devices/groups/:id` | **admin** | Delete group |
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

### How it works

configify uses **HTTP polling** — no WebSockets required.

1. Click **▶ Run on device** → `POST /api/ssh/execute` starts the SSH job and returns `{ jobId }`
2. Browser polls `GET /api/ssh/poll/:jobId` every 800 ms
3. Each poll returns new output since the last call plus the job status (`running` / `done` / `error`)
4. Terminal updates in real time; polling stops when the job finishes

### One-time DB migration

If your `execution_logs` table was created before `credential_id` was added:

```sql
ALTER TABLE execution_logs
  ADD COLUMN IF NOT EXISTS credential_id
  INTEGER REFERENCES credentials(id) ON DELETE SET NULL;
```

The server also runs this automatically on every `POST /api/ssh/execute`.

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
psql -h localhost -U configify_user -d configify_db -f schema_v2.sql -W
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
├── schema.sql               ← templates table
├── schema_v2.sql            ← users, devices, credentials, groups, logs
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
│   ├── ssh.js               ← /api/ssh/* (polling-based execution)
│   └── templates.js         ← /api/templates/*
└── public/
    ├── index.html           ← Template use + SSH execution (left sidebar)
    ├── login.html           ← Login page (local / LDAP / SAML)
    ├── templates.html       ← Template creation + delete list (left sidebar)
    ├── devices.html         ← Device inventory + credential vault (left sidebar)
    └── admin.html           ← User + auth config (left sidebar)
```

---

## Changelog

### v2.2 (current)
- **Fixed variable fields not appearing on Use page** — root cause was `show()` setting `style.display = ''` which cannot override a CSS-class `display:none`; now uses `classList.add/remove('visible')` which correctly triggers the `.visible` rule
- **Templates page simplified** — now a focused creation form; existing templates shown as a compact deletable list below with a Use button linking directly to the Use page
- **Use page step indicators** — numbered step badges highlight as you progress through select → variables → device → run

### v2.1
- Left sidebar navigation with square icon tiles
- Live template variable filling — output updates as you type
- Unfilled variables highlighted yellow; filled values shown green
