# configify — Deployment & Operations Guide

**configify** is a self-hosted template studio. Write any text with `{{variable}}` placeholders, save templates to a shared PostgreSQL database, fill them in via an auto-generated form, and execute the result over SSH against a managed device inventory all from the browser.

**Features:** local accounts · LDAP/AD · SAML 2.0 SSO · AES-256-GCM credential vault · live SSH streaming · device groups · shareable template links · iframe embed

---

## Architecture

```
Browser
  │
  ▼
Nginx (443 TLS)          ← reverse proxy, handles WebSocket upgrade
  │
  ▼
Node.js / Express (3000) ← API + static files
  │           │
  │           └── WebSocket /ws/ssh/:logId  ← real-time SSH output
  ▼
PostgreSQL               ← templates, users, devices, credentials, logs
```

### Pages

| URL               | Description                           |
| ----------------- | ------------------------------------- |
| `/`             | Template studio + SSH execution panel |
| `/login.html`   | Login (local / LDAP / SAML)           |
| `/devices.html` | Device + credential vault manager     |
| `/admin.html`   | User admin + auth provider config     |

### API routes

| Method | Path                                 | Auth            | Description                            |
| ------ | ------------------------------------ | --------------- | -------------------------------------- |
| POST   | `/auth/login/local`                | public          | Local login                            |
| POST   | `/auth/login/ldap`                 | public          | LDAP login                             |
| GET    | `/auth/saml/login`                 | public          | SAML redirect to IdP                   |
| POST   | `/auth/saml/callback`              | public          | SAML ACS callback                      |
| GET    | `/auth/me`                         | user            | Current user info                      |
| POST   | `/auth/logout`                     | user            | Destroy session                        |
| GET    | `/api/templates`                   | user            | List templates                         |
| POST   | `/api/templates`                   | user            | Create template                        |
| DELETE | `/api/templates/:id`               | user            | Delete template                        |
| GET    | `/api/devices`                     | user            | List devices                           |
| POST   | `/api/devices`                     | user            | Add device                             |
| PATCH  | `/api/devices/:id`                 | user            | Edit device                            |
| DELETE | `/api/devices/:id`                 | **admin** | Delete device                          |
| GET    | `/api/devices/groups`              | user            | List groups                            |
| POST   | `/api/devices/groups`              | user            | Add group                              |
| DELETE | `/api/devices/groups/:id`          | **admin** | Delete group                           |
| GET    | `/api/devices/credentials`         | user            | List credentials (no secrets returned) |
| POST   | `/api/devices/credentials`         | user            | Add credential                         |
| DELETE | `/api/devices/credentials/:id`     | **admin** | Delete credential                      |
| POST   | `/api/ssh/execute`                 | user            | Start SSH job →`{ logId }`          |
| GET    | `/api/devices/:id/logs`            | user            | Execution history for a device         |
| GET    | `/api/users`                       | **admin** | List users                             |
| POST   | `/api/users`                       | **admin** | Create local user                      |
| PATCH  | `/api/users/:id`                   | **admin** | Edit user                              |
| DELETE | `/api/users/:id`                   | **admin** | Delete user                            |
| GET    | `/api/users/auth-config/:provider` | **admin** | Get LDAP/SAML config                   |
| PUT    | `/api/users/auth-config/:provider` | **admin** | Update LDAP/SAML config                |

---

## Getting the code

### Clone from GitHub

```bash
git clone https://github.com/Zero3Dash/configify.git
cd configify
```

If deploying directly onto a server, clone there:

```bash
ssh user@your-server-ip
git clone https://github.com/Zero3Dash/configify.git /var/www/configify
cd /var/www/configify
```

### Keep up to date

```bash
cd /var/www/configify
git pull
npm install --omit=dev
pm2 restart configify-app
```

If a release includes database changes the release notes will say so. Apply them with:

```bash
psql -h localhost -U configify_user -d configify_db -f schema_v2.sql -W
```

All schema files use `CREATE TABLE IF NOT EXISTS` and `ON CONFLICT DO NOTHING` throughout, so re-running them against an existing database is safe — they are additive only and will not modify or drop existing data.

---

## Quick install (Ubuntu 24.04)

Clone the repo then run the included bootstrap script. It handles everything end-to-end with no manual steps.

```bash
git clone https://github.com/Zero3Dash/configify.git
cd configify
sudo bash setup.sh
```

`setup.sh` will:

1. Install Node.js 20, PostgreSQL 17, Nginx, and PM2
2. Create the database user and apply the schema
3. Generate `SESSION_SECRET` and `VAULT_SECRET` and write them to `.env`
4. Install npm dependencies
5. Start the app under PM2 with auto-restart on boot
6. Generate a self-signed SSL certificate and configure Nginx

At the end it prints the URL, generated database password, and a reminder to change the default admin password immediately.

> For a public-facing server with a real domain, switch to Let's Encrypt after setup — see **Nginx + SSL → Option A** in the manual install section below.

---

## Manual install

Follow this path if you need more control, are deploying to an existing server, or want Let's Encrypt from the start.

### Prerequisites

- Ubuntu 24.04 (or compatible Debian-based OS), minimum 1 GB RAM
- A domain name pointing to the server's IP (required for Let's Encrypt; optional for self-signed)
- SSH access with sudo

- sudo apt install git
- sudo apt install cron

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

# Firewall
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

### 3 — Node.js 20

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node -v   # should print v20.x
```

### 4 — PostgreSQL 17

```bash
sudo install -d /usr/share/postgresql-common/pgdg
sudo curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
    -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc
sudo sh -c 'echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] \
    https://apt.postgresql.org/pub/repos/apt noble-pgdg main" \
    > /etc/apt/sources.list.d/pgdg.list'
sudo apt update && sudo apt install -y postgresql-17
sudo systemctl enable --now postgresql
```

#### Create the database

```bash
sudo -i -u postgres psql <<'SQL'
CREATE DATABASE configify_db;
CREATE USER configify_user WITH PASSWORD 'YourStrongPasswordHere';
GRANT ALL PRIVILEGES ON DATABASE configify_db TO configify_user;
\c configify_db
GRANT ALL ON SCHEMA public TO configify_user;
\q
SQL
```

#### Apply the schema

```bash
cd /var/www/configify

# Templates table
psql -h localhost -U configify_user -d configify_db -f schema.sql -W

# Users, devices, credentials, groups, execution logs, auth config
psql -h localhost -U configify_user -d configify_db -f schema_v2.sql -W
```

### 5 — Node packages

```bash
cd /var/www/configify
npm install --omit=dev
```

### 6 — Environment variables

```bash
cp .env.example .env
chmod 600 .env
nano .env
```

Generate the two required secrets — run each command and paste the output into `.env`:

```bash
# SESSION_SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# VAULT_SECRET  (must be exactly 64 hex characters)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

> ⚠️ **Back up `VAULT_SECRET` to a password manager or secrets store immediately.** If it is lost, all stored SSH credentials become permanently unrecoverable — there is no reset path.

Complete `.env` reference:

```ini
PORT=3000
NODE_ENV=production

DB_HOST=localhost
DB_PORT=5432
DB_NAME=configify_db
DB_USER=configify_user
DB_PASSWORD=YourStrongPasswordHere

SESSION_SECRET=<64-char hex>
VAULT_SECRET=<64-char hex>

APP_URL=https://configify.yourdomain.com
```

### 7 — PM2

```bash
sudo npm install -g pm2

sudo mkdir -p /var/log/configify
sudo chown $USER:$USER /var/log/configify

pm2 start ecosystem.config.js
pm2 save

# Register PM2 to start on boot — run the command it prints
pm2 startup
```

### 8 — Nginx + SSL

**Option A — Let's Encrypt (recommended for public servers):**

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d configify.yourdomain.com
```

Then copy the `configify-letsencrypt` file from the repo as your site config:

```bash
sudo cp /var/www/configify/configify-letsencrypt /etc/nginx/sites-available/configify
# Replace configify.yourdomain.com with your actual domain
sudo nano /etc/nginx/sites-available/configify
```

**Option B — Self-signed (internal networks / testing):**

```bash
sudo openssl req -x509 -nodes -days 3650 -newkey rsa:2048 \
    -keyout /etc/ssl/private/configify.key \
    -out    /etc/ssl/certs/configify.crt \
    -subj   "/CN=configify.yourdomain.com"
sudo chmod 600 /etc/ssl/private/configify.key

sudo cp /var/www/configify/configify-selfsigned /etc/nginx/sites-available/configify
sudo nano /etc/nginx/sites-available/configify   # replace the domain
```

**Enable the site (both options):**

```bash
sudo ln -s /etc/nginx/sites-available/configify /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl enable --now nginx
sudo systemctl reload nginx
```

---

## First login

Navigate to `https://configify.yourdomain.com` and log in with:

- **Username:** `admin`
- **Password:** `ChangeMe2026!`

Go to **Admin → Users → Edit** and set a strong password before doing anything else.

---

## Authentication setup

### Local accounts

Managed through **Admin → Users**. Passwords are bcrypt-hashed at cost 12. Only local accounts can have passwords changed through the UI — LDAP and SAML users are provisioned automatically on first login and managed by the upstream directory.

### LDAP / Active Directory

1. Log in as admin → **Admin → Auth Providers → LDAP/AD**
2. Enter your directory settings:

| Field             | Example                                                                   |
| ----------------- | ------------------------------------------------------------------------- |
| LDAP URL          | `ldap://dc.corp.example.com:389` or `ldaps://dc.corp.example.com:636` |
| Bind DN           | `cn=svc-configify,ou=ServiceAccounts,dc=corp,dc=example,dc=com`         |
| Bind Password     | service account password                                                  |
| Search Base       | `ou=Users,dc=corp,dc=example,dc=com`                                    |
| Search Filter     | `(sAMAccountName={{username}})`                                         |
| Admin Group DN    | `CN=configify-admins,ou=Groups,dc=corp,dc=example,dc=com`               |
| Group Search Base | `ou=Groups,dc=corp,dc=example,dc=com`                                   |

3. Enable the toggle → **Save LDAP config**
4. Restart: `pm2 restart configify-app`
5. The **LDAP/AD** tab appears on the login page

**LDAPS with a self-signed DC certificate:** disable *Reject unauthorized TLS certificates* in the form.

**Group-based admin role:** any user whose Active Directory `memberOf` attribute includes the Admin Group DN will receive the `admin` role in configify, synced on every login.

### SAML 2.0 (SSO)

1. Register configify as a Service Provider in your IdP:

   - **Entity ID / Issuer:** `configify` (or any string — must match what you enter in step 2)
   - **ACS URL:** `https://configify.yourdomain.com/auth/saml/callback`
   - **Name ID format:** Email address (recommended)
2. Log in as admin → **Admin → Auth Providers → SAML 2.0**
3. Fill in the IdP details and attribute mapping
4. Paste the IdP signing certificate — PEM body only, without the `-----BEGIN CERTIFICATE-----` / `-----END CERTIFICATE-----` wrapper lines
5. Enable the toggle → **Save SAML config** → `pm2 restart configify-app`
6. The **Sign in with SSO** button appears on the login page

**Attribute mapping — Azure AD / Entra ID:**

| Field             | Claim URI                                                              |
| ----------------- | ---------------------------------------------------------------------- |
| Email             | `http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress` |
| Username          | `http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name`         |
| Role/Group        | `http://schemas.microsoft.com/ws/2008/06/identity/claims/groups`     |
| Admin group value | Object ID of the admin group in Azure AD                               |

---

## Device & credential vault

### Credentials

All passwords and private keys are encrypted at rest using **AES-256-GCM** keyed from `VAULT_SECRET`. The API never returns plaintext secrets after initial storage — only metadata (name, username, auth method, creation date) is readable.

| Auth method                  | When to use                           |
| ---------------------------- | ------------------------------------- |
| Password                     | Standard SSH password auth            |
| SSH Private Key              | RSA or Ed25519 PEM key, no passphrase |
| SSH Private Key + Passphrase | Encrypted private key                 |

### Devices

Each device has a type (Linux, Cisco IOS, Cisco NX-OS, JunOS, Windows) used for display only — SSH behaviour is identical regardless. The default port is 22 and can be overridden per device.

Devices can be assigned to colour-coded groups. Groups appear as headings in the SSH device picker on the template page.

### SSH execution

1. On the **Templates** page, select or create a template and fill in all variables
2. Click **⚡ Generate Filled Template**
3. In the right-hand **Execute on Device** panel, select a target device
4. Optionally select a credential override (otherwise the device's default credential is used)
5. Click **▶ Run on device**
6. Output streams live: stdout in white, stderr in amber, exit status in green (0) or red (non-zero)

Each execution is logged to `execution_logs` with the full command text, combined output, exit code, start time, and end time. Retrieve logs per device:

```
GET /api/devices/:id/logs
```

#### Host-key fingerprint (auto-accept)

configify automatically accepts any SSH host key presented by a target device, equivalent to OpenSSH's `StrictHostKeyChecking=accept-new`. Executions are never blocked by an unknown-host prompt.

During each connection the server captures the host key's **SHA-256 fingerprint** (hex) via the `hostVerifier` callback and streams it to the browser over the WebSocket. It appears beneath the progress bar in the **Execute on Device** panel and can be copied with one click for out-of-band verification against the device's own key output (e.g. `show crypto key mypubkey rsa` on Cisco IOS).

> **Security note:** because keys are accepted unconditionally, configify does not protect against MITM attacks on the network path between the server and the device. Restrict network access to the configify host itself and use a dedicated management VLAN or VPN for device connectivity.

#### Progress indicator

A four-step progress bar appears below the **▶ Run on device** button for every execution:

| Step | Label   | What it means                       |
| ---- | ------- | ------------------------------------ |
| 1    | Fetch   | Retrieving job details from the DB   |
| 2    | Connect | TCP + SSH handshake to the device    |
| 3    | Run     | Command executing, output streaming  |
| 4    | Done    | Exit code received, log finalised    |

Steps animate with a pulsing blue dot while active, turn green on success, and red on any failure. The track bar fills proportionally and changes colour to match the outcome.

---

## Database backup

`setup.sh` configures a daily cron job automatically. To set it up manually:

```bash
sudo mkdir -p /var/backups/postgresql
sudo chown postgres:postgres /var/backups/postgresql

sudo cp /var/www/configify/backup-configify-db.sh /usr/local/bin/
sudo chmod +x /usr/local/bin/backup-configify-db.sh

# Add a daily job at 02:00 for the postgres user
sudo crontab -u postgres -e
# Add this line:
# 0 2 * * * /usr/local/bin/backup-configify-db.sh
```

Backups older than 7 days are pruned automatically. **Restore from a backup:**

```bash
gunzip -c /var/backups/postgresql/configify_db_YYYYMMDD_HHMMSS.sql.gz \
    | psql -h localhost -U configify_user -d configify_db -W
```

---

## Operations

### Health check

```bash
bash /var/www/configify/check-status.sh
```

Prints PM2 status, Nginx, PostgreSQL, live database row counts, disk usage, recent errors, and SSL certificate expiry in one shot.

### PM2 commands

```bash
pm2 status                    # process table
pm2 logs configify-app        # live log tail
pm2 logs configify-app --err  # errors only
pm2 restart configify-app     # restart after a git pull
pm2 monit                     # live CPU / memory dashboard
```

### Log locations

| Log          | Path                                           |
| ------------ | ---------------------------------------------- |
| App stdout   | `/var/log/configify/out.log`                 |
| App stderr   | `/var/log/configify/err.log`                 |
| App combined | `/var/log/configify/combined.log`            |
| Nginx access | `/var/log/nginx/configify_access.log`        |
| Nginx errors | `/var/log/nginx/configify_error.log`         |
| PostgreSQL   | `/var/log/postgresql/postgresql-17-main.log` |

---

## Troubleshooting

| Symptom                                     | Likely cause                        | Fix                                                                                                         |
| ------------------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 502 Bad Gateway                             | Node app not running                | `pm2 status` → `pm2 start ecosystem.config.js`                                                         |
| Login fails with correct password           | Schema not applied or stale session | Re-run `schema_v2.sql`; clear browser cookies                                                             |
| LDAP login fails                            | Wrong bind DN, filter, or URL       | Check `err.log` — passport-ldapauth logs the exact LDAP error                                            |
| SAML redirect loop or error page            | ACS URL mismatch or wrong cert      | Confirm the callback URL in your IdP exactly matches `APP_URL/auth/saml/callback`                         |
| SSH execution fails immediately             | No credential assigned to device    | Go to Devices, edit the device, assign a default credential                                                 |
| SSH "Credential not found"                  | `VAULT_SECRET` was changed        | Restore the original `VAULT_SECRET` — credentials encrypted with a different key cannot be decrypted     |
| WebSocket disconnects instantly             | Nginx missing upgrade headers       | Confirm `proxy_set_header Upgrade $http_upgrade` and `Connection 'upgrade'` in Nginx config             |
| `VAULT_SECRET must be 64-char` on startup | Missing or malformed `.env`       | Run `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` and paste result           |
| 401 on all API calls                        | Session store not initialised       | Check `err.log` for DB connection errors; `user_sessions` table is created automatically on first start |
| No fingerprint shown after SSH connect      | Device disconnected before handshake| Check terminal for the specific connection error                                                            |

---

## Security notes

- All routes except `/auth/*` and `/login.html` require a valid session
- Credential secrets are AES-256-GCM encrypted; plaintext is never persisted or returned by the API
- Session cookies are `httpOnly`, `secure` (production), and expire after 8 hours
- Only `admin` role accounts can delete users, devices, credentials, and groups
- PostgreSQL is bound to `localhost` only — no remote database access
- SSH host keys are accepted automatically; verify fingerprints displayed in the UI out-of-band if MITM risk is a concern in your environment
- Install `fail2ban` to protect the host SSH service against brute-force:

```bash
sudo apt install -y fail2ban
sudo systemctl enable --now fail2ban
```

---

## File structure

```
/var/www/configify/
├── server.js                ← Express app entry point
├── db.js                    ← PostgreSQL connection pool
├── package.json
├── ecosystem.config.js      ← PM2 process config
├── .env                     ← runtime secrets (chmod 600, not in git)
├── .env.example             ← copy to .env and populate
├── schema.sql               ← templates table
├── schema_v2.sql            ← users, devices, credentials, groups, logs
├── setup.sh                 ← one-shot Ubuntu 24.04 install script
├── check-status.sh          ← service health check
├── backup-configify-db.sh   ← PostgreSQL dump + rotation
├── configify-letsencrypt    ← Nginx site config (Let's Encrypt)
├── configify-selfsigned     ← Nginx site config (self-signed)
├── auth/
│   └── index.js             ← Passport strategies: local / LDAP / SAML
├── crypto/
│   └── vault.js             ← AES-256-GCM encrypt / decrypt
├── middleware/
│   └── auth.js              ← requireAuth / requireAdmin
├── routes/
│   ├── auth.js              ← /auth/* login, logout, providers
│   ├── users.js             ← /api/users/* + auth-config (admin)
│   ├── devices.js           ← /api/devices/* groups, credentials, devices
│   ├── ssh.js               ← /api/ssh/execute + WebSocket handler
│   └── templates.js         ← /api/templates/*
└── public/
    ├── index.html           ← Template studio + live SSH panel
    ├── login.html           ← Login (local / LDAP / SAML tabs)
    ├── admin.html           ← User management + auth provider config
    └── devices.html         ← Device inventory + credential vault
```
