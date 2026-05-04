#!/usr/bin/env bash
# Refresh the PoE2 essence dataset from poe2db.tw and enrich it with
# prefix/suffix side info derived by matching against the Krakenbul mods
# dataset (data/poe2/mods.json — produced by update-poe2-data.sh).
#
# Outputs:
#   data/raw/poe2db_essence_index.html       cached index page
#   data/raw/poe2db_essence_<slug>.html      cached per-essence detail page
#   data/poe2/essences.csv                   enriched essence catalog
#
# Usage:  scripts/update-poe2-essences.sh
# Prerequisite:  data/poe2/mods.json (run update-poe2-data.sh first).

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RAW="$ROOT/data/raw"
OUT="$ROOT/data/poe2"
mkdir -p "$RAW" "$OUT"

INDEX_URL="https://poe2db.tw/us/Essence"
INDEX_HTML="$RAW/poe2db_essence_index.html"

if [[ ! -f "$ROOT/data/poe2/mods.json" ]]; then
  echo "  ! data/poe2/mods.json not found — run scripts/update-poe2-data.sh first" >&2
  exit 1
fi

echo "[1/3] Fetching essence index…"
curl -fsSL "$INDEX_URL" -o "$INDEX_HTML"

echo "[2/3] Discovering per-essence pages and downloading detail HTML…"
SLUGS=$(
  grep -oE 'href="(Lesser_Essence|Greater_Essence|Perfect_Essence|Essence)[A-Za-z_]*"' "$INDEX_HTML" \
    | sed -E 's/href="([^"]+)"/\1/' \
    | sort -u
)
COUNT=$(echo "$SLUGS" | wc -l | tr -d ' ')
echo "  found $COUNT essence slug(s)"
echo "$SLUGS" | while IFS= read -r slug; do
  [[ -z "$slug" ]] && continue
  out="$RAW/poe2db_essence_${slug}.html"
  if [[ ! -s "$out" ]]; then
    if curl -fsSL "https://poe2db.tw/us/${slug}" -o "$out" 2>/dev/null; then
      printf '  fetched %s\n' "$slug"
    else
      printf '  ! failed: %s (skipping)\n' "$slug"
    fi
    sleep 0.2  # be gentle
  fi
done

echo "[3/3] Building enriched essences.csv…"
python3 - "$RAW" "$OUT" <<'PY'
import csv, json, re, sys
from html.parser import HTMLParser
from pathlib import Path

raw_dir, out_dir = Path(sys.argv[1]), Path(sys.argv[2])

# --- Load mods.json: map affix description -> (type, item_classes) ----------
mods = json.load((out_dir / 'mods.json').open())
mods_by_name = {}
for m in mods:
    mods_by_name.setdefault(m['name'], []).append(m)

# --- Parse poe2db essence detail HTML ---------------------------------------
class StatsExtractor(HTMLParser):
    """
    Extracts the contiguous 'explicitMod' blocks from <div class="Stats">.
    Each block describes one piece of the essence's forced-affix rule, e.g.:
      "Armour or Belt: +(30—39) to maximum Life"
    """
    def __init__(self):
        super().__init__()
        self.in_stats = 0
        self.in_mod = 0
        self.cur = []
        self.mods = []
    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        cls = a.get('class', '')
        if tag == 'div' and 'Stats' in cls:
            self.in_stats += 1
        elif tag == 'div' and 'explicitMod' in cls and self.in_stats:
            self.in_mod += 1
            self.cur = []
    def handle_endtag(self, tag):
        if tag == 'div':
            if self.in_mod:
                self.in_mod -= 1
                if self.in_mod == 0 and self.cur:
                    self.mods.append(re.sub(r'\s+', ' ', ''.join(self.cur)).strip())
            elif self.in_stats:
                self.in_stats -= 1
    def handle_data(self, data):
        if self.in_mod:
            self.cur.append(data)

def parse_essence(html):
    """Return dict with: og_title, og_desc, mod_lines (list)."""
    title_m = re.search(r'<meta property="og:title" content="([^"]+)"', html)
    desc_m  = re.search(r'<meta property="og:description" content="([^"]+)"', html)
    sx = StatsExtractor()
    try: sx.feed(html)
    except Exception: pass
    return {
        'name': title_m.group(1) if title_m else '',
        'description': desc_m.group(1) if desc_m else '',
        'mod_lines': sx.mods,
    }

# --- Affix-text normaliser: drop ranges, collapse whitespace ----------------
RANGE_RE = re.compile(r'\(\s*[\d.]+\s*[—\-–]\s*[\d.]+\s*\)')
def normalise_affix(text):
    text = RANGE_RE.sub('#', text)
    text = re.sub(r'(\+|-)\s*#', r'\1#', text)
    text = re.sub(r'#\s*%', r'#%', text)
    text = re.sub(r'\s+', ' ', text).strip()
    return text

def find_side(target_affix):
    """
    Match target_affix against mods_by_name. Returns (side, item_classes_set)
    or (None, set()) if no unambiguous match.
    """
    norm = normalise_affix(target_affix)
    candidates = []
    # Try exact match against normalised names.
    for name, recs in mods_by_name.items():
        if normalise_affix(name) == norm:
            for r in recs:
                candidates.append(r)
    if not candidates:
        # Try substring containment in either direction.
        for name, recs in mods_by_name.items():
            nn = normalise_affix(name)
            if norm and (norm in nn or nn in norm):
                for r in recs:
                    candidates.append(r)
    if not candidates:
        return None, set()
    sides = {c['type'] for c in candidates}
    classes = {c['itemClass'] for c in candidates if c.get('itemClass')}
    if len(sides) == 1:
        return next(iter(sides)), classes
    return None, classes

# --- Build enriched CSV -----------------------------------------------------
rows_out = []
fields = ['name', 'tier', 'target_affix', 'side', 'guarantee', 'notes',
          'item_classes', 'matched_mods', 'poe2db_slug']

# Reuse target_affix and tier from the existing essences.csv (we curated it
# earlier from the index page).  Otherwise rebuild from detail pages.
existing_csv = out_dir / 'essences.csv'
existing = []
if existing_csv.exists():
    with existing_csv.open(newline='', encoding='utf-8') as f:
        existing = list(csv.DictReader(f))

# Index detail pages by name
detail_by_name = {}
for path in raw_dir.glob('poe2db_essence_*.html'):
    try:
        html = path.read_text(encoding='utf-8', errors='ignore')
        info = parse_essence(html)
        if info['name']:
            detail_by_name[info['name']] = (path.stem.replace('poe2db_essence_', ''), info)
    except Exception as e:
        print(f"  ! parse error in {path.name}: {e}", file=sys.stderr)

unresolved = 0
for row in existing:
    name = row['name']
    target = row.get('target_affix', '')
    slug, info = detail_by_name.get(name, (None, None))
    notes = row.get('notes', '')
    item_classes = ''
    matched = []

    side, klass = find_side(target)
    if klass:
        item_classes = '|'.join(sorted(klass))

    if info and info['mod_lines']:
        # The detail page typically has multiple per-class mod lines; try each
        # to see if any narrows the side.
        if not side:
            for ml in info['mod_lines']:
                # strip leading "Class: " or "Class or Class:"
                stripped = re.sub(r'^[^:]+:\s*', '', ml)
                s2, k2 = find_side(stripped)
                if s2:
                    side = s2
                    matched.append(ml)
                    if k2: item_classes = '|'.join(sorted(k2))
                    break

    if not side:
        unresolved += 1

    rows_out.append({
        'name': name,
        'tier': row.get('tier', ''),
        'target_affix': target,
        'side': side or 'UNKNOWN',
        'guarantee': row.get('guarantee', ''),
        'notes': notes,
        'item_classes': item_classes,
        'matched_mods': ' / '.join(matched) if matched else '',
        'poe2db_slug': slug or '',
    })

with (out_dir / 'essences.csv').open('w', newline='', encoding='utf-8') as f:
    w = csv.DictWriter(f, fieldnames=fields)
    w.writeheader()
    w.writerows(rows_out)

resolved = len(rows_out) - unresolved
print(f"  wrote {len(rows_out)} essences "
      f"({resolved} side-resolved, {unresolved} still UNKNOWN)")
PY

echo "Done."
