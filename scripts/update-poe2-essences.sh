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

class PreSufTableExtractor(HTMLParser):
    """
    Scrapes the Class | Modifier | Pre/Suf table on poe2db essence detail
    pages (the second tab — e.g. PerfectEssenceofBattleCurrencyPerfectEssenceAttack).
    Each <tr> has three cells; the third cell text is "Prefix" or "Suffix".

    We only consider tables whose <th> row matches the canonical
    [Class, Modifier, Pre/Suf] schema; this avoids picking up the
    economy/exchange table at the top of the page.
    """
    def __init__(self):
        super().__init__()
        self.in_table = 0
        self.in_thead = 0
        self.in_tbody = 0
        self.in_th = 0
        self.in_tr = 0
        self.in_td = 0
        self.headers = []
        self.cur_th = []
        self.cur_row = []
        self.cur_td = []
        self.is_target_table = False
        self.classes = []  # list of (item_class, modifier_text, side)
    def handle_starttag(self, tag, attrs):
        if tag == 'table':
            self.in_table += 1
            self.headers = []
            self.is_target_table = False
        elif self.in_table:
            if tag == 'thead': self.in_thead += 1
            elif tag == 'tbody': self.in_tbody += 1
            elif tag == 'tr':
                self.in_tr += 1
                self.cur_row = []
            elif tag == 'th':
                self.in_th += 1
                self.cur_th = []
            elif tag == 'td':
                self.in_td += 1
                self.cur_td = []
    def handle_endtag(self, tag):
        if tag == 'th' and self.in_th:
            self.in_th -= 1
            self.headers.append(re.sub(r'\s+', ' ', ''.join(self.cur_th)).strip())
        elif tag == 'td' and self.in_td:
            self.in_td -= 1
            self.cur_row.append(re.sub(r'\s+', ' ', ''.join(self.cur_td)).strip())
        elif tag == 'tr' and self.in_tr:
            self.in_tr -= 1
            if self.in_tbody and self.is_target_table and len(self.cur_row) >= 3:
                klass, mod, side = self.cur_row[0], self.cur_row[1], self.cur_row[2]
                if side in ('Prefix', 'Suffix'):
                    self.classes.append((klass, mod, side.upper()))
        elif tag == 'thead' and self.in_thead:
            self.in_thead -= 1
            # Decide if this is the target table by header signature.
            sig = [h.lower() for h in self.headers]
            self.is_target_table = (
                'class' in sig and 'modifier' in sig and
                any('pre' in h.lower() and 'suf' in h.lower() for h in self.headers)
            )
        elif tag == 'tbody' and self.in_tbody:
            self.in_tbody -= 1
        elif tag == 'table' and self.in_table:
            self.in_table -= 1
            self.is_target_table = False
    def handle_data(self, data):
        if self.in_th: self.cur_th.append(data)
        elif self.in_td: self.cur_td.append(data)

def parse_essence(html):
    """Return dict with: og_title, og_desc, mod_lines, presuf_rows."""
    title_m = re.search(r'<meta property="og:title" content="([^"]+)"', html)
    desc_m  = re.search(r'<meta property="og:description" content="([^"]+)"', html)
    sx = StatsExtractor()
    try: sx.feed(html)
    except Exception: pass
    px = PreSufTableExtractor()
    try: px.feed(html)
    except Exception: pass
    # Normalise side from the Class|Modifier|Pre/Suf table: it's authoritative
    # when unanimous. ("Prefix" or "Suffix" — never both for a single essence.)
    sides = {row[2] for row in px.classes}
    presuf_side = None
    presuf_classes = set()
    if len(sides) == 1:
        presuf_side = next(iter(sides)).upper()  # PREFIX / SUFFIX
        if presuf_side == 'PREFIX' or presuf_side == 'SUFFIX':
            presuf_classes = {row[0] for row in px.classes if row[0]}
    # Per-mod sides: for multi-mod essences (Hysteria, mixed prefix/suffix
    # across item classes), aggregate by canonicalised modifier text. Same
    # text → same side is unanimous; different sides for the same text is
    # an unresolvable conflict (we drop it).
    per_mod_sides = {}
    per_mod_conflicts = set()
    for klass, mod, side in px.classes:
        canon = canonicalise_for_extra_mods(mod)
        if not canon:
            continue
        side_up = side.upper()  # PREFIX / SUFFIX
        existing = per_mod_sides.get(canon)
        if existing is None:
            per_mod_sides[canon] = side_up
        elif existing != side_up:
            per_mod_conflicts.add(canon)
    for c in per_mod_conflicts:
        per_mod_sides.pop(c, None)
    return {
        'name': title_m.group(1) if title_m else '',
        'description': desc_m.group(1) if desc_m else '',
        'mod_lines': sx.mods,
        'presuf_side': presuf_side,
        'presuf_classes': presuf_classes,
        'per_mod_sides': per_mod_sides,
    }

# --- Affix-text normaliser: drop ranges, collapse whitespace ----------------
RANGE_RE = re.compile(r'\(\s*[\d.]+\s*[—\-–]\s*[\d.]+\s*\)')
def normalise_affix(text):
    text = RANGE_RE.sub('#', text)
    text = re.sub(r'(\+|-)\s*#', r'\1#', text)
    text = re.sub(r'#\s*%', r'#%', text)
    text = re.sub(r'\s+', ' ', text).strip()
    return text

# Canonicalise to extra_mods.json's text format: ranges → '#', and *plain*
# integers/decimals (e.g. "+3 to Level of all Attack Skills" or "60% increased
# effect of Socketed Items") → '#'. Used to key per-mod side data so it
# matches the UI's `m.text` directly. Critically, this strips trailing
# parentheticals like "(one-handed) or +5 (two-handed)" since those are
# class-disjunctions that the UI text doesn't carry.
PARENS_TAIL_RE = re.compile(r'\s*\([^)]*\)\s*(?:or\s*[+\-]?\d+(?:\.\d+)?\s*\([^)]*\))*\s*$')
NUM_RE = re.compile(r'\d+(?:\.\d+)?')
def canonicalise_for_extra_mods(text):
    if not text:
        return ''
    t = RANGE_RE.sub('#', text)
    t = NUM_RE.sub('#', t)
    t = re.sub(r'(\+|-)\s*#', r'\1#', t)
    t = re.sub(r'#\s*%', r'#%', t)
    # Drop trailing class-disjunction parentheticals like " (one-handed) or +# (two-handed)".
    t = re.sub(r'\s*\(one-handed\).*$', '', t)
    t = re.sub(r'\s*\(Wand\)\s*or.*$', '', t)
    t = re.sub(r'\s*\(Focus/Wand\)\s*or.*$', '', t)
    t = re.sub(r'\s+', ' ', t).strip()
    return t

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

# Curated side overrides. When the auto-resolver can't pick a side
# from the base-mod registry (typically essence-only affixes whose
# target text is `(N—M)% increased Foo` with no base-pool match),
# this JSON file maps the literal target_affix to a side. Source of
# truth for "Perfect Essence of X is a prefix" claims that the user
# verified on the wiki / poe2db. Single edit point — patch the JSON,
# re-run the scraper.
overrides_path = out_dir / 'essence_side_overrides.json'
overrides_map = {}
if overrides_path.exists():
    with overrides_path.open(encoding='utf-8') as f:
        d = json.load(f)
    for text, info in (d.get('overrides') or {}).items():
        if info and info.get('side') in ('PREFIX', 'SUFFIX', 'ABYSS'):
            overrides_map[text] = info['side']

unresolved = 0
for row in existing:
    name = row['name']
    target = row.get('target_affix', '')
    slug, info = detail_by_name.get(name, (None, None))
    notes = row.get('notes', '')
    item_classes = ''
    matched = []

    # 1. Authoritative: the per-class Pre/Suf table on the detail page.
    #    poe2db itself labels each row Prefix/Suffix; if all rows agree,
    #    that's the answer. Trumps everything else (covers essence-only
    #    affixes that don't exist in the base mod registry).
    side = None
    if info and info.get('presuf_side'):
        side = info['presuf_side']
        if info.get('presuf_classes'):
            item_classes = '|'.join(sorted(info['presuf_classes']))
        matched.append(f"detail-page Pre/Suf table → {side}")

    # 2. Fallback: match against base mod registry (mods.json).
    if not side:
        side, klass = find_side(target)
        if klass:
            item_classes = '|'.join(sorted(klass))

    # 3. Fallback: walk per-class mod lines from the detail page.
    if not side and info and info['mod_lines']:
        for ml in info['mod_lines']:
            # strip leading "Class: " or "Class or Class:"
            stripped = re.sub(r'^[^:]+:\s*', '', ml)
            s2, k2 = find_side(stripped)
            if s2:
                side = s2
                matched.append(ml)
                if k2: item_classes = '|'.join(sorted(k2))
                break

    # 4. Last-chance: curated overrides keyed on target_affix.
    #    ABYSS is preserved verbatim — the UI renders it as a full-width
    #    row outside the prefix/suffix split (Mark of the Abyssal Lord).
    if not side:
        side = overrides_map.get(target)

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

# --- Per-mod side map for multi-mod essences --------------------------------
# Hysteria is the canonical case: 10 different mods, mixed prefix/suffix
# across item classes. The CSV's single `side` column can't represent
# that. Write a separate file keyed on (essence name, canonicalised mod
# text) so the UI can resolve any specific mod's side directly. Same
# format as essence_side_overrides but auto-generated from the Pre/Suf
# table — never hand-edit.
mod_sides_by_essence = {}
for nm, (slug, info) in detail_by_name.items():
    pms = (info or {}).get('per_mod_sides') or {}
    if pms:
        mod_sides_by_essence[nm] = pms

mod_sides_path = out_dir / 'essence_mod_sides.json'
mod_sides_path.write_text(json.dumps({
    '_comment': ('Auto-generated by scripts/update-poe2-essences.sh. '
                 'For each essence, maps canonicalised mod text (#-form, '
                 'matching extra_mods.json `text`) to the prefix/suffix '
                 'side scraped from poe2db\'s Class|Modifier|Pre/Suf table. '
                 'Conflicting rows (same canonical text → different sides) '
                 'are dropped. Use for multi-mod essences (Hysteria) where '
                 'the unanimous-side rule in essences.csv falls through.'),
    'mod_sides': mod_sides_by_essence,
}, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
multi_mod_count = sum(1 for v in mod_sides_by_essence.values() if len(v) > 1)
total_mod_entries = sum(len(v) for v in mod_sides_by_essence.values())

resolved = len(rows_out) - unresolved
print(f"  wrote {len(rows_out)} essences "
      f"({resolved} side-resolved, {unresolved} still UNKNOWN)")
print(f"  wrote essence_mod_sides.json: {len(mod_sides_by_essence)} essences, "
      f"{multi_mod_count} multi-mod, {total_mod_entries} per-mod entries")
PY

echo "Done."
