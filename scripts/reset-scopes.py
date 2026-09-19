#!/usr/bin/env python3
"""Force every agent project back to its intended capability scope.

`swytchcode exec` on an unregistered tool fetches and registers it, leaving residue in three
places: tooling.json (tools + integrations), integrations/manifest.json (which drives
`auth connect`), and the downloaded bundle directory. Cleaning only tooling.json is not
enough — a stale manifest keeps `auth connect` asking for a provider the agent shouldn't hold.

Run after any incident, after the boundary demo's --show-gap act, or when `npm run scopes`
reports drift. Idempotent.

Usage: python3 scripts/reset-scopes.py [--check]
       --check  report drift and exit non-zero, change nothing (for CI)
"""
import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

SCOPES = {
    "email": ("Gmail.gmail", "Gmail", ["gmail.user.messages.get", "gmail.user.messages.get1"]),
    "calendar": ("Google Calendar.calendar", "Google Calendar", ["calendar.event.get", "calendar.event.get.1"]),
    "notes": ("Notion.notion", "Notion", ["notion.page.create", "notion.page.update"]),
    "briefing": ("Resend.resend", "Resend", ["resend.email.create"]),
}

check_only = "--check" in sys.argv
drift_found = False

def report(agent, kind, items):
    global drift_found
    drift_found = True
    verb = "DRIFT" if check_only else "removed"
    print(f"  {agent}: {verb} {kind}: {', '.join(items)}")

for agent, (integ_key, bundle_dir, allowed) in SCOPES.items():
    base = ROOT / "agents" / agent / ".swytchcode"
    if not base.exists():
        print(f"  {agent}: no project at {base} — run scripts/setup.sh")
        continue

    tj_path = base / "tooling.json"
    tj = json.loads(tj_path.read_text())

    extra_tools = [t for t in tj.get("tools", {}) if t not in allowed]
    extra_integs = [k for k in tj.get("integrations", {}) if k != integ_key]

    if extra_tools:
        report(agent, "tools", extra_tools)
    if extra_integs:
        report(agent, "integrations", extra_integs)

    if not check_only and (extra_tools or extra_integs):
        tj["tools"] = {k: v for k, v in tj["tools"].items() if k in allowed}
        tj["integrations"] = {k: v for k, v in tj["integrations"].items() if k == integ_key}
        tj_path.write_text(json.dumps(tj, indent=2) + "\n")

    missing = [t for t in allowed if t not in tj.get("tools", {})]
    if missing:
        print(f"  {agent}: MISSING expected tools: {', '.join(missing)} — run `swytchcode add method <id>`")
        drift_found = True

    mf_path = base / "integrations" / "manifest.json"
    if mf_path.exists():
        mf = json.loads(mf_path.read_text())
        keep_prefix = integ_key.split(".")[0]
        foreign = [k for k in mf if not k.startswith(keep_prefix)]
        siblings = [k for k in mf if k.startswith(keep_prefix) and k != integ_key]
        stale = foreign + siblings
        if stale:
            report(agent, "manifest entries", stale)
            if not check_only:
                mf_path.write_text(json.dumps({k: v for k, v in mf.items() if k == integ_key}, indent=2) + "\n")

    idir = base / "integrations"
    if idir.exists():
        stray = [c.name for c in idir.iterdir() if c.is_dir() and c.name != bundle_dir]
        if stray:
            report(agent, "bundle dirs", stray)
            if not check_only:
                for name in stray:
                    shutil.rmtree(idir / name)

if not drift_found:
    print("✓ all four agents hold exactly their intended scope")
    sys.exit(0)

if check_only:
    print("\n✗ scope drift detected — run `python3 scripts/reset-scopes.py` to correct it")
    sys.exit(1)

print("\n✓ scopes reset")
