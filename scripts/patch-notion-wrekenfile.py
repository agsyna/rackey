#!/usr/bin/env python3
"""Repair the Notion wrekenfile shipped by `swytchcode get notion`.

The published bundle references 20 response structs from its METHODS section but defines only
3 in STRUCTS, so `swytchcode add method notion.*` fails with:

    error: resolve STRUCTs in RETURNS: struct "api.page.createResponse200" not found in STRUCTS

Appends stubs for every referenced-but-undefined struct. The two Rackey depends on get a real
Notion page shape; the rest get a minimal envelope so the bundle validates as a whole.

Re-run after every `swytchcode get notion` — a fetch reintroduces the bug. Idempotent.

Usage: python3 scripts/patch-notion-wrekenfile.py <path-to-notes-project>
"""
import re
import sys
from pathlib import Path

PAGE_RESPONSE_FIELDS = [
    ("object", "STRING"),
    ("id", "STRING"),
    ("created_time", "STRING"),
    ("last_edited_time", "STRING"),
    ("archived", "BOOL"),
    ("in_trash", "BOOL"),
    ("url", "STRING"),
    ("public_url", "ANY"),
    ("parent", "OBJECT"),
    ("properties", "OBJECT"),
    ("icon", "ANY"),
    ("cover", "ANY"),
]

GENERIC_FIELDS = [
    ("object", "STRING"),
    ("id", "STRING"),
]

PRECISE = {
    "api.page.createResponse200": PAGE_RESPONSE_FIELDS,
    "api.page.updateResponse200": PAGE_RESPONSE_FIELDS,
}

MARKER = "# --- rackey patch: stubs for referenced-but-undefined structs ---"

def render(name, fields):
    lines = [f"  {name}:"]
    for field, ftype in fields:
        lines += [f"    - name: {field}", f"      type: {ftype}", "      REQUIRED: false"]
    return lines

def main():
    if len(sys.argv) < 2:
        sys.exit("usage: patch-notion-wrekenfile.py <path-to-notes-project>")

    root = Path(sys.argv[1])
    matches = sorted(root.glob(".swytchcode/integrations/Notion/notion/*/wrekenfile.yaml"))
    if not matches:
        sys.exit(f"✗ no Notion wrekenfile under {root} — run `swytchcode get notion` first")

    for path in matches:
        text = path.read_text()

        referenced = set(re.findall(r"RETURNTYPE: STRUCT\(([^)]+)\)", text))
        defined = set(re.findall(r"^  ([A-Za-z0-9_.\-]+):$", text, re.MULTILINE))
        missing = sorted(referenced - defined)

        if not missing:
            print(f"✓ {path.name}: nothing to patch ({len(referenced)} structs all defined)")
            continue

        out = [text.rstrip("\n"), "", MARKER]
        for name in missing:
            out += render(name, PRECISE.get(name, GENERIC_FIELDS))

        path.write_text("\n".join(out) + "\n")

        precise_hits = [m for m in missing if m in PRECISE]
        print(f"✓ {path.name}: added {len(missing)} stub struct(s)")
        for name in precise_hits:
            print(f"    · {name} (full Notion page shape)")
        remaining = len(missing) - len(precise_hits)
        if remaining:
            print(f"    · +{remaining} generic envelope stub(s)")

if __name__ == "__main__":
    main()
