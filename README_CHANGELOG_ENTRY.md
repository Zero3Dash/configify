<!-- README patch — prepend this entry to the Changelog section -->

### v2.8 (current)

- **New dashboard home page** (`/`) — the root URL now serves a summary dashboard showing:
  - Inventory: device count (with group count), credential count (with enable-password indicator), template count
  - Compliance: compliant / non-compliant / error totals, overall compliance rate, and a progress-bar breakdown card
  - Quick-access tiles to the most common actions
- **Deploy page** (`/deploy.html`) — the former "Use" page is now at `/deploy.html` with the label **Deploy** (🚀) in the sidebar. Template links from the Templates page (`▶ Use` button) have been updated to `/deploy.html?template=...`.
- **Sidebar updated on all pages** — sidebar nav now shows **Home** (🏠 `/`) and **Deploy** (🚀 `/deploy.html`) in place of the old **Use** item.
- **`apply_nav_patch.py`** — idempotent patch script to update the sidebar on existing HTML files without a full redeploy. Run once after upgrading:
  ```bash
  cd /var/www/configify
  python3 apply_nav_patch.py
  ```
