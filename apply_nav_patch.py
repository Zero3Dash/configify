#!/usr/bin/env python3
"""
apply_nav_patch.py
Updates the configify sidebar navigation across all HTML pages:

  - Replaces the old "Use" (📋) nav link with two items:
      🏠 Home  →  /
      🚀 Deploy →  /deploy.html
  - Updates template "Use" button links:
      /?template=...  →  /deploy.html?template=...

Run from the configify root directory (where public/ lives):

    python3 apply_nav_patch.py

Safe to run multiple times (idempotent).
"""

import os, sys, re, pathlib, shutil

APP_DIR = pathlib.Path(__file__).parent
PUBLIC  = APP_DIR / 'public'

FILES = [
    PUBLIC / 'templates.html',
    PUBLIC / 'devices.html',
    PUBLIC / 'compliance.html',
    PUBLIC / 'settings.html',
    PUBLIC / 'admin.html',
]

# ── Idempotency guard — if already patched nothing to do ─────────────────
ALREADY_PATCHED_MARKER = 'href="/deploy.html" class="sb-item"'

# ── Pattern: old "Use" link (spaced or compact, active or not) ───────────
USE_LINK_RE = re.compile(
    r'<a href="/" class="sb-item(?:\s+active)?"[^>]*>\s*'
    r'<span class="sb-icon">📋</span>\s*'
    r'<span class="sb-label">Use</span>\s*'
    r'</a>',
    re.DOTALL
)

# ── Replacement: Home + Deploy ────────────────────────────────────────────
HOME_DEPLOY = (
    '<a href="/" class="sb-item">\n'
    '      <span class="sb-icon">🏠</span>\n'
    '      <span class="sb-label">Home</span>\n'
    '    </a>\n'
    '    <a href="/deploy.html" class="sb-item">\n'
    '      <span class="sb-icon">🚀</span>\n'
    '      <span class="sb-label">Deploy</span>\n'
    '    </a>'
)

# Compact variant for pages that use single-line markup
HOME_DEPLOY_COMPACT = (
    '<a href="/" class="sb-item"><span class="sb-icon">🏠</span>'
    '<span class="sb-label">Home</span></a>\n'
    '    <a href="/deploy.html" class="sb-item">'
    '<span class="sb-icon">🚀</span><span class="sb-label">Deploy</span></a>'
)

def is_compact(match_text):
    """Returns True if the matched Use link is written on a single line."""
    return '\n' not in match_text.strip()

def replacement(m):
    return HOME_DEPLOY_COMPACT if is_compact(m.group(0)) else HOME_DEPLOY

ok = skip = err = 0

for path in FILES:
    if not path.exists():
        print(f"  SKIP  {path.name} — file not found")
        skip += 1
        continue

    content = path.read_text(encoding='utf-8')

    if ALREADY_PATCHED_MARKER in content:
        print(f"  SKIP  {path.name} — already patched")
        skip += 1
        continue

    if not USE_LINK_RE.search(content):
        print(f"  WARN  {path.name} — '📋 Use' link pattern not found; skipping")
        skip += 1
        continue

    # Backup original
    backup = path.with_suffix(path.suffix + '.nav_bak')
    shutil.copy2(path, backup)

    # Patch 1: replace Use link with Home + Deploy
    patched = USE_LINK_RE.sub(replacement, content)

    # Patch 2: fix template "Use" button href  /?template=  →  /deploy.html?template=
    patched = patched.replace(
        'href="/?template=${encodeURIComponent(t.template_id)}"',
        'href="/deploy.html?template=${encodeURIComponent(t.template_id)}"'
    )
    patched = re.sub(r'href="\/\?template=', 'href="/deploy.html?template=', patched)

    path.write_text(patched, encoding='utf-8')
    print(f"  OK    {path.name}  (backup → {backup.name})")
    ok += 1

print(f"\n{ok} patched, {skip} skipped, {err} errors")
if ok:
    print("Done. No restart required — changes take effect immediately.")
