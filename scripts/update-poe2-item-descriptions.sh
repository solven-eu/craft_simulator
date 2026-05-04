#!/usr/bin/env bash
# Snapshot the descriptions + icons of all PoE2 currency items (orbs, omens,
# catalysts, desecration items) from poe2db. Stores them as a stable CSV so any
# wording change (which usually signals a behaviour change — e.g. Orb of Alchemy
# gaining "or Magic" alongside "Normal" in 0.3.1) shows up as a clean diff.
#
# Two-pass scrape:
#   Pass 1: poe2db's Modifiers page (covers omens + a few orbs + catalysts).
#   Pass 2: per-item pages for every currency listed in games/poe2/currency.js,
#           parsed via og:title / og:description / og:image meta tags. Catches
#           the bulk of common orbs (Exalted, Chaos, Regal, Vaal, Annulment,
#           Transmutation, Augmentation, Chance, Greater/Perfect variants,
#           Jeweller's, Artificer's, Architect's, Extraction) that aren't on
#           the Modifiers page.
#
# Outputs:
#   data/raw/poe2db_modifiers.html       cached source HTML (Pass 1)
#   data/raw/poe2db_item_<slug>.html     cached per-item HTML (Pass 2)
#   data/poe2/item_descriptions.csv      slug, kind, name, description, image_url, fetched_at
#
# Usage:  scripts/update-poe2-item-descriptions.sh
#
# Source: https://poe2db.tw (CC BY-NC-SA 3.0).

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RAW="$ROOT/data/raw"
OUT="$ROOT/data/poe2"
mkdir -p "$RAW" "$OUT"

URL="https://poe2db.tw/us/Modifiers"
HTML="$RAW/poe2db_modifiers.html"

echo "[1/3] Fetching $URL …"
curl -fsSL "$URL" -o "$HTML"

echo "[2/3] Fetching per-item pages for currencies in currency.js …"
# Derive slugs from currency.js. poe2db's URL convention: spaces -> "_",
# apostrophes stripped (e.g. "Architect's Orb" -> "Architects_Orb"). We sleep
# 150ms between requests to be polite.
python3 - "$ROOT/games/poe2/currency.js" "$RAW" <<'PY'
import re, sys, time, urllib.request, urllib.error
from pathlib import Path

js_path, raw_dir = Path(sys.argv[1]), Path(sys.argv[2])
src = js_path.read_text(encoding='utf-8')

# Match every `name: '...'` or `name: "..."` literal. The two quote styles are
# both used (and JS escaping is rare here), so we read whichever quote opens.
NAME_RE = re.compile(r"name:\s*(['\"])(.*?)\1", re.DOTALL)
names = []
seen = set()
for m in NAME_RE.finditer(src):
    n = m.group(2)
    if n in seen: continue
    seen.add(n); names.append(n)

def slug_of(name):
    s = name.replace("'", "").replace("’", "")
    s = re.sub(r'\s+', '_', s.strip())
    return s

UA = 'Mozilla/5.0 (poe-crafter snapshot script)'
ok = 0; missed = []
for n in names:
    slug = slug_of(n)
    out = raw_dir / f'poe2db_item_{slug}.html'
    if out.exists():
        ok += 1; continue
    url = f'https://poe2db.tw/us/{slug}'
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            out.write_bytes(r.read())
        ok += 1
    except urllib.error.HTTPError as e:
        if e.code == 404:
            missed.append((n, slug))
        else:
            print(f'  ! {slug}: HTTP {e.code}')
            missed.append((n, slug))
    except Exception as e:
        print(f'  ! {slug}: {e}')
        missed.append((n, slug))
    time.sleep(0.15)

print(f'  cached {ok}/{len(names)} per-item pages; {len(missed)} missing')
for n, s in missed:
    print(f'    miss: {n!r} -> {s}.html')
PY

echo "[3/3] Parsing all entries (Modifiers page + per-item pages) …"
python3 - "$HTML" "$OUT" "$RAW" "$ROOT/games/poe2/currency.js" <<'PY'
import csv, re, sys
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path

html_path, out_dir, raw_dir, currency_js = (
    Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3]), Path(sys.argv[4]))
html = html_path.read_text(encoding='utf-8', errors='ignore')

# --- Pass 1: Modifiers page ---------------------------------------------
# Each entry on poe2db's Modifiers Acronym tab lives in a flex container:
#
#   <div class="d-flex border-top rounded">
#     ... <a class="<KIND>" ... href="<SLUG>"><img height="16" .../>NAME</a>
#     <div> ...
#       <div class="explicitMod">DESC</div>     [may include nested <a>/<br>]
#     </div>
#   </div>
#
# We split the HTML between successive opens of that container, then for
# each chunk extract slug+name (header anchor, the one carrying height="16")
# and the *first* explicitMod that follows.

CONTAINER_DELIM = '<div class="d-flex border-top rounded">'
HEADER_ANCHOR_RE = re.compile(
    r'<div class="flex-grow-1 ms-2">\s*<a class="([^"]+)"[^>]+href="([^"]+)">(.*?)</a>',
    re.DOTALL,
)
EXPLICIT_MOD_RE = re.compile(r'<div class="explicitMod">(.*?)</div>', re.DOTALL)
TAG_RE = re.compile(r'<[^>]+>')
IMG_RE = re.compile(r'<img[^>]+src="([^"]+)"')

def kind_of(class_attr):
    cls = class_attr.lower()
    if 'omen' in cls: return 'omen'
    if 'currency' in cls: return 'currency'
    if 'breachstone' in cls: return 'breachstone'
    if 'tincture' in cls: return 'tincture'
    return 'other'

def normalise(text):
    """Strip inline tags, collapse whitespace; preserve <br> as a separator."""
    text = re.sub(r'<br\s*/?>', ' ', text)
    text = TAG_RE.sub('', text)
    return re.sub(r'\s+', ' ', text).strip()

records = {}  # slug -> dict (later: name-keyed merge)
chunks = html.split(CONTAINER_DELIM)[1:]
for chunk in chunks:
    head = HEADER_ANCHOR_RE.search(chunk)
    if not head: continue
    cls, slug, inner = head.group(1), head.group(2), head.group(3)
    name = TAG_RE.sub('', inner).strip()
    if not name: continue
    desc_parts = [normalise(m.group(1)) for m in EXPLICIT_MOD_RE.finditer(chunk)]
    description = ' '.join(p for p in desc_parts if p)
    img_match = IMG_RE.search(chunk)
    image_url = img_match.group(1) if img_match else ''
    k = kind_of(cls)
    if k not in ('currency', 'omen'):
        continue
    records[name] = {
        'slug': slug,
        'kind': k,
        'name': name,
        'description': description,
        'image_url': image_url,
    }

# --- Pass 2: per-item pages ---------------------------------------------
# Per-item pages don't have the flex container; they expose the canonical
# fields via Open Graph meta tags:
#   <meta property="og:title" content="Exalted Orb" />
#   <meta property="og:description" content="Augments a Rare item ..." />
#   <meta property="og:image" content="https://cdn.poe2db.tw/...webp" />
META_RE = re.compile(
    r'<meta\s+property="og:(title|description|image)"\s+content="([^"]*)"',
    re.IGNORECASE,
)

NAME_RE = re.compile(r"name:\s*(['\"])(.*?)\1", re.DOTALL)
src = currency_js.read_text(encoding='utf-8')
desired_names = []
seen = set()
for m in NAME_RE.finditer(src):
    n = m.group(2)
    if n in seen: continue
    seen.add(n); desired_names.append(n)

def slug_of(name):
    s = name.replace("'", "").replace("’", "")
    s = re.sub(r'\s+', '_', s.strip())
    return s

# Each per-item page is its own item; the page may be either a currency/orb
# or a desecration consumable. We tag accordingly via the Modifiers Acronym
# entries we already saw, falling back to 'currency' (everything in
# currency.js is a crafting item).
DESECRATION_NAMES = {n.lower() for n in [
    'Ancient Collarbone','Preserved Collarbone','Gnawed Collarbone',
    'Ancient Jawbone','Preserved Jawbone','Gnawed Jawbone',
    'Ancient Rib','Preserved Rib','Gnawed Rib',
    'Preserved Cranium',
    "Tecrod's Gaze","Kurgal's Gaze","Amanamu's Gaze","Ulaman's Gaze",
    "Kulemak's Invitation",
]}

added_pass2 = 0
for n in desired_names:
    slug = slug_of(n)
    page = raw_dir / f'poe2db_item_{slug}.html'
    if not page.exists(): continue
    body = page.read_text(encoding='utf-8', errors='ignore')
    meta = {}
    for m in META_RE.finditer(body):
        meta[m.group(1).lower()] = m.group(2)
    # og:title is the canonical name; trust it over our currency.js label
    # (handles minor punctuation drift). If missing, fall back to name.
    name = meta.get('title', n).strip() or n
    description = meta.get('description', '').strip()
    image_url = meta.get('image', '').strip()
    if not image_url:
        continue  # a 404'd or empty page
    kind = 'desecrated' if n.lower() in DESECRATION_NAMES else 'currency'
    if name in records:
        # Modifiers-page record wins for description (richer formatting),
        # but use the per-item page to fill in any missing image_url.
        if not records[name]['image_url']:
            records[name]['image_url'] = image_url
        continue
    records[name] = {
        'slug': slug,
        'kind': kind,
        'name': name,
        'description': description,
        'image_url': image_url,
    }
    added_pass2 += 1

# --- Sort + write -------------------------------------------------------
KIND_ORDER = {'currency': 0, 'omen': 1, 'desecrated': 2, 'breachstone': 3, 'tincture': 4, 'other': 9}
all_records = sorted(records.values(),
                     key=lambda r: (KIND_ORDER.get(r['kind'], 99), r['slug']))

now = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
out_csv = out_dir / 'item_descriptions.csv'
with out_csv.open('w', newline='', encoding='utf-8') as f:
    w = csv.writer(f)
    w.writerow(['slug', 'kind', 'name', 'description', 'image_url', 'fetched_at'])
    for r in all_records:
        w.writerow([r['slug'], r['kind'], r['name'], r['description'], r['image_url'], now])

n_orbs = sum(1 for r in all_records if r['kind'] == 'currency')
n_omens = sum(1 for r in all_records if r['kind'] == 'omen')
n_des = sum(1 for r in all_records if r['kind'] == 'desecrated')
print(f'  wrote {len(all_records)} rows ({n_orbs} currency, {n_omens} omens, {n_des} desecrated; {added_pass2} added by per-item pass) -> data/poe2/item_descriptions.csv')
PY

echo "Done."
echo
echo "Tip: \`git diff data/poe2/item_descriptions.csv\` after re-running"
echo "     reveals wording/icon drift — usually a sign of mechanic changes."
