<!-- README patch — replace the "UI Navigation" table section with this -->

## UI Navigation

configify uses a **left sidebar** for navigation. Each item is a square tile with an icon and label:

| Icon | Label | Page | Description |
|------|-------|------|-------------|
| 🏠 | Home | `/` | **Dashboard** — devices, credentials, compliance summary |
| 🚀 | Deploy | `/deploy.html` | Select a template, fill variables, execute over SSH |
| 📂 | Templates | `/templates.html` | Create, edit, and delete templates; organise into folders |
| 🖥️ | Devices | `/devices.html` | Manage devices, groups, and credential vault |
| 🛡️ | Compliance | `/compliance.html` | Golden config checking for Cisco IOS & NX-OS |
| 🔧 | Settings | `/settings.html` | Automated compliance schedules |
| ⚙️ | Admin | `/admin.html` | User accounts and auth providers (admin only) |
| ↩️ | Sign out | — | End the current session |

The active page is highlighted in blue. The Admin item is hidden for non-admin users.

### Dashboard (`/`)

The home page provides an at-a-glance summary of your environment:

- **Inventory row** — total device count (with group count), credential count (with enable-password indicator), and template count (with folder breakdown)
- **Compliance row** — compliant / non-compliant / error counts plus overall compliance rate
- **Compliance breakdown card** — progress-bar breakdown of all three compliance states as a percentage of total checks run
- **Quick access tiles** — one-click shortcuts to the most common actions

The dashboard data is loaded in parallel from `/api/devices`, `/api/devices/credentials`, `/api/templates`, and `/api/compliance/dashboard`. Each stat card degrades gracefully if an endpoint is unavailable.
