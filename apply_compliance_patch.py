#!/usr/bin/env python3
"""
apply_compliance_patch.py
Adds the compliance sidebar link to all configify HTML pages.
Run from the configify root directory (where public/ lives):

    python3 apply_compliance_patch.py

Safe to run multiple times (idempotent).
"""

import os, sys, pathlib, shutil

APP_DIR = pathlib.Path(__file__).parent
PUBLIC  = APP_DIR / 'public'

FILES = [
    PUBLIC / 'index.html',
    PUBLIC / 'templates.html',
    PUBLIC / 'devices.html',
    PUBLIC / 'admin.html',
]

FIND = '    <a href="/admin.html" class="sb-item hidden" id="admin-link">'

INSERT = '''\
    <a href="/compliance.html" class="sb-item">
      <span class="sb-icon">🛡️</span>
      <span class="sb-label">Compliance</span>
    </a>
    <a href="/admin.html" class="sb-item hidden" id="admin-link">'''

ok = skip = err = 0

for path in FILES:
    if not path.exists():
        print(f"  SKIP  {path.name} — file not found")
        skip += 1
        continue

    content = path.read_text(encoding='utf-8')

    if INSERT.strip() in content:
        print(f"  SKIP  {path.name} — already patched")
        skip += 1
        continue

    if FIND not in content:
        print(f"  WARN  {path.name} — expected pattern not found; skipping")
        skip += 1
        continue

    # Backup original
    backup = path.with_suffix(path.suffix + '.bak')
    shutil.copy2(path, backup)

    patched = content.replace(FIND, INSERT, 1)
    path.write_text(patched, encoding='utf-8')
    print(f"  OK    {path.name}  (backup: {backup.name})")
    ok += 1

print(f"\n{ok} patched, {skip} skipped, {err} errors")
if ok:
    print("Restart the app to serve updated files: pm2 restart configify-app")
