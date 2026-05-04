#!/usr/bin/env bash
# Snapshot the PoE2 desecrated-modifier consumables (Bones / Skulls / Soul
# Cores) from poe2db's "Abyssalify Ref" tab. Each consumable has:
#   - an item-class restriction (Weapon/Quiver, Armour, Jewellery, Jewel,
#     Waystone),
#   - an optional ilvl bound (max-ilvl for low tiers, min-modifier-level for
#     high tiers),
#   - a description and an icon URL.
#
# Output: data/poe2/desecrated.csv with columns:
#   slug, name, item_class, max_ilvl, min_mod_level, description, image_url, fetched_at
#
# Source: https://poe2db.tw/us/Desecrated_Modifiers#AbyssalifyRef
#         (CC BY-NC-SA 3.0).

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RAW="$ROOT/data/raw"
OUT="$ROOT/data/poe2"
mkdir -p "$RAW" "$OUT"

URL="https://poe2db.tw/us/Desecrated_Modifiers"
HTML="$RAW/poe2db_desecrated.html"

echo "[1/2] Fetching $URL …"
curl -fsSL "$URL" -o "$HTML"

echo "[2/2] Parsing AbyssalifyRef consumables …"
python3 - "$HTML" "$OUT" <<'PY'
import csv, re, sys
from datetime import datetime, timezone
from pathlib import Path

html_path, out_dir = Path(sys.argv[1]), Path(sys.argv[2])
html = html_path.read_text(encoding='utf-8', errors='ignore')

# Strategy: each desecrated consumable's anchor carries a `AbyssalBenchTicket`
# substring in its `data-hover` attribute. We filter ALL container chunks by
# that signature so we don't have to slice the page by section header.
section = html

CONTAINER_DELIM = '<div class="d-flex border-top rounded">'
HEADER_RE = re.compile(
    r'<div class="flex-grow-1 ms-2">\s*<a class="([^"]+)"[^>]+href="([^"]+)">(.*?)</a>',
    re.DOTALL,
)
EXPLICIT_MOD_RE = re.compile(r'<div class="explicitMod">(.*?)</div>', re.DOTALL)
IMG_RE = re.compile(r'<img[^>]+src="([^"]+)"')
MAX_ILVL_RE = re.compile(r'Maximum Item Level.*?<span[^>]*>(\d+)', re.DOTALL)
MIN_LVL_RE = re.compile(r'Minimum Modifier Level.*?<span[^>]*>(\d+)', re.DOTALL)
TAG_RE = re.compile(r'<[^>]+>')

def normalise(text):
    text = re.sub(r'<br\s*/?>', ' ', text)
    text = TAG_RE.sub('', text)
    return re.sub(r'\s+', ' ', text).strip()

# Item-class detection from description text.
def detect_item_class(desc_text):
    t = desc_text.lower()
    if 'weapon or' in t and 'quiver' in t: return 'Weapon/Quiver'
    if 'armour' in t: return 'Armour'
    if 'amulet' in t and 'ring' in t and 'belt' in t: return 'Amulet/Ring/Belt'
    if 'jewel' in t and 'jewellery' not in t: return 'Jewel'
    if 'waystone' in t: return 'Waystone'
    if 'weapon' in t: return 'Weapon'
    return 'Unknown'

records = []
seen = set()
for chunk in section.split(CONTAINER_DELIM)[1:]:
    # Filter: only keep chunks whose entry references the Abyssal bench ticket
    # data — the canonical marker for a desecration consumable.
    if 'AbyssalBenchTicket' not in chunk: continue
    head = HEADER_RE.search(chunk)
    if not head: continue
    cls_attr, slug, inner = head.group(1), head.group(2), head.group(3)
    name = TAG_RE.sub('', inner).strip()
    if not name: continue
    if (slug, name) in seen: continue
    seen.add((slug, name))
    desc_parts = [normalise(m.group(1)) for m in EXPLICIT_MOD_RE.finditer(chunk)]
    description = ' '.join(p for p in desc_parts if p)
    img = IMG_RE.search(chunk)
    image_url = img.group(1) if img else ''
    max_ilvl = MAX_ILVL_RE.search(chunk)
    min_lvl = MIN_LVL_RE.search(chunk)
    records.append({
        'slug': slug,
        'name': name,
        'item_class': detect_item_class(description),
        'max_ilvl': int(max_ilvl.group(1)) if max_ilvl else '',
        'min_mod_level': int(min_lvl.group(1)) if min_lvl else '',
        'description': description,
        'image_url': image_url,
    })

records.sort(key=lambda r: (r['item_class'], r['name']))

now = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
out_csv = out_dir / 'desecrated.csv'
with out_csv.open('w', newline='', encoding='utf-8') as f:
    w = csv.writer(f)
    w.writerow(['slug', 'name', 'item_class', 'max_ilvl', 'min_mod_level',
                'description', 'image_url', 'fetched_at'])
    for r in records:
        w.writerow([r['slug'], r['name'], r['item_class'], r['max_ilvl'],
                    r['min_mod_level'], r['description'], r['image_url'], now])

# Summary
by_class = {}
for r in records:
    by_class[r['item_class']] = by_class.get(r['item_class'], 0) + 1
print(f'  wrote {len(records)} desecrated consumables -> data/poe2/desecrated.csv')
for k, v in sorted(by_class.items()):
    print(f'    {k}: {v}')
PY

echo "Done."
