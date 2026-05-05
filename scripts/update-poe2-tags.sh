#!/usr/bin/env bash
# Enrich data/poe2/mods.json with per-mod tags (damage / elemental / fire /
# life / attribute / etc.) scraped from poe2db's per-base pages.
#
# Implementation note: poe2db embeds the structured mod data as JS payload —
# `new ModsView({...})` — at the bottom of every per-base page. Each mod
# carries its tags inline in the `mod_no` array (HTML spans with
# `data-tag="..."`). Parsing that JSON is dramatically more reliable than
# scraping the rendered table.
#
# Outputs:
#   data/raw/poe2db_base_<slug>.html     cached per-base HTML
#   data/poe2/mod_tags.json              { "BASE": { "<mod name>": [tags] } }
#   data/poe2/extra_mods.json            { "BASE": { desecrated/essence/corrupted: [...] } }
#   data/poe2/mod_ranges.json            { "BASE": { "<mod name>": { tier: display } } }
#   data/poe2/by-base/<slug>.tags.json   per-base partition of mod_tags
#   data/poe2/by-base/<slug>.extra.json  per-base partition of extra_mods
#   data/poe2/by-base/<slug>.ranges.json per-base partition of mod_ranges
#
# Usage:  scripts/update-poe2-tags.sh [BASE...]
#   With no arguments: enriches every base present in data/poe2/mods.json.
#   With base names (e.g. "GLOVES (DEX)"): only those bases.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RAW="$ROOT/data/raw"
OUT="$ROOT/data/poe2"
mkdir -p "$RAW"

if [[ ! -f "$OUT/mods.json" ]]; then
  echo "  ! data/poe2/mods.json not found — run scripts/update-poe2-data.sh first" >&2
  exit 1
fi

ARGS_JSON=$(printf '%s\n' "$@" | python3 -c 'import json,sys; print(json.dumps([l.rstrip() for l in sys.stdin if l.strip()]))')

echo "[1/3] Determining bases to scrape…"
SLUGS_FILE="$(mktemp)"
python3 - "$OUT/mods.json" "$ARGS_JSON" "$SLUGS_FILE" <<'PY'
import json, sys, re
mods_path, args_json, out_file = sys.argv[1], sys.argv[2], sys.argv[3]
mods = json.load(open(mods_path))
filter_set = set(json.loads(args_json))
seen = set()
mapping = []
for m in mods:
    base = m['base']
    if filter_set and base not in filter_set: continue
    if base in seen: continue
    seen.add(base)
    # Map base name -> poe2db URL slug. Two layers:
    # 1. Hard overrides for irregulars (WARSTAFF lives at /Quarterstaves;
    #    elemental wand/staff variants all share /Wands and /Staves on
    #    poe2db — they're not split per element). Hybrid armour bases
    #    (e.g. BODY ARMOUR (STR/DEX)) don't have dedicated pages on
    #    poe2db and are mapped to the closest single-attribute parent.
    # 2. Pluralise + attribute-suffix fallback for the regular bases
    #    (BOOTS (DEX) -> Boots_dex, RING -> Rings, etc.).
    overrides = {
        'BOW': 'Bows', 'CROSSBOW': 'Crossbows', 'SPEAR': 'Spears',
        'WARSTAFF': 'Quarterstaves',
        'ONE HAND MACE': 'One_Hand_Maces', 'TWO HAND MACE': 'Two_Hand_Maces',
        'BUCKLER': 'Bucklers', 'TALISMAN': 'Talismans',
        'FIRE WAND': 'Wands', 'ICE WAND': 'Wands',
        'LIGHTNING WAND': 'Wands', 'CHAOS WAND': 'Wands',
        'PHYSICAL WAND': 'Wands',
        'FIRE STAFF': 'Staves', 'ICE STAFF': 'Staves',
        'LIGHTNING STAFF': 'Staves', 'CHAOS STAFF': 'Staves',
        'PHYSICAL STAFF': 'Staves',
        # Hybrid armour bases reuse one of the parent single-attribute
        # pages — pick whichever attribute appears first. The hybrid mod
        # pool overlaps heavily with the single-attribute parent, so the
        # tag map is at least directionally correct.
        'BODY ARMOUR (DEX)': 'Body_Armours_dex',
        'BODY ARMOUR (STR)': 'Body_Armours_str',
        'BODY ARMOUR (INT)': 'Body_Armours_int',
        'BODY ARMOUR (STR/DEX)': 'Body_Armours_str',
        'BODY ARMOUR (STR/INT)': 'Body_Armours_str',
        'BODY ARMOUR (DEX/INT)': 'Body_Armours_dex',
        'BOOTS (STR/DEX)': 'Boots_str',
        'BOOTS (STR/INT)': 'Boots_str',
        'BOOTS (DEX/INT)': 'Boots_dex',
        'HELMET (STR/DEX)': 'Helmets_str',
        'HELMET (STR/INT)': 'Helmets_str',
        'HELMET (DEX/INT)': 'Helmets_dex',
        'GLOVES (STR/DEX)': 'Gloves_str',
        'GLOVES (STR/INT)': 'Gloves_str',
        'GLOVES (DEX/INT)': 'Gloves_dex',
        'SHIELD (STR/DEX)': 'Shields_str',
        'SHIELD (STR/INT)': 'Shields_str',
    }
    if base in overrides:
        slug = overrides[base]
    else:
        name, _, paren = base.partition('(')
        name = name.strip().lower()
        spec = paren.rstrip(')').strip().lower().replace('/', '') if paren else ''
        plural = {'ring': 'rings', 'quiver': 'quivers', 'amulet': 'amulets',
                  'belt': 'belts', 'wand': 'wands', 'staff': 'staves',
                  'sceptre': 'sceptres', 'focus': 'foci', 'shield': 'shields',
                  'helmet': 'helmets', 'boot': 'boots', 'glove': 'gloves'}
        title = plural.get(name, name)
        title = '_'.join(w.capitalize() for w in title.split())
        slug = title + ('_' + spec if spec else '')
    mapping.append((base, slug))
with open(out_file, 'w') as f:
    for b, s in mapping: f.write(f'{b}\t{s}\n')
print(f'  {len(mapping)} base(s) to fetch')
PY

echo "[2/3] Fetching per-base HTML…"
# Drop any cached HTML that lacks the ModsView payload — those are stale
# 404 / redirect pages from earlier runs with wrong slugs. Re-fetching is
# cheap and idempotent for valid slugs.
while IFS=$'\t' read -r base slug; do
  out="$RAW/poe2db_base_${slug}.html"
  if [[ -s "$out" ]] && ! grep -q 'new ModsView' "$out"; then
    rm -f "$out"
    printf '  invalidated stale cache for %s (%s)\n' "$base" "$slug"
  fi
  if [[ ! -s "$out" ]]; then
    if curl -fsSL "https://poe2db.tw/us/${slug}" -o "$out" 2>/dev/null; then
      printf '  fetched %s -> %s\n' "$base" "$slug"
    else
      printf '  ! failed: %s (%s) — slug guess wrong; skipping\n' "$base" "$slug"
      rm -f "$out"
    fi
    sleep 0.2
  fi
done < "$SLUGS_FILE"

echo "[3/3] Parsing tags and writing mod_tags.json…"
python3 - "$RAW" "$OUT" "$SLUGS_FILE" <<'PY'
import json, re, sys
from pathlib import Path

raw_dir, out_dir, slugs_file = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])

def parse_html(html):
    """
    Extract the `new ModsView({...})` JSON payload, then walk each mod entry
    in the `normal` array. Each mod carries its tags inline in the `mod_no`
    field (a list of HTML strings of the form
    `<span ... data-tag="TAG">Tag</span>`). Returns (canonical_mod_text, [tags]).
    """
    m = re.search(r'new ModsView\(\{', html)
    if not m: return []
    start = m.end() - 1
    # Walk balanced braces while respecting string literals.
    depth = 0
    i = start
    in_str = False
    esc = False
    end = -1
    while i < len(html):
        c = html[i]
        if in_str:
            if esc: esc = False
            elif c == '\\': esc = True
            elif c == '"': in_str = False
        else:
            if c == '"': in_str = True
            elif c == '{': depth += 1
            elif c == '}':
                depth -= 1
                if depth == 0:
                    end = i + 1
                    break
        i += 1
    if end < 0: return []
    try:
        data = json.loads(html[start:end])
    except Exception:
        return []
    out = []
    # Yield (canonical_text, tags, bucket, tier_name, display_text) tuples.
    # `display_text` keeps numeric ranges intact ("+(10—19) to ...") so the
    # UI can show real values rather than the placeholder "#".
    for bucket in ('normal', 'desecrated', 'corrupted', 'essence'):
        for mod in data.get(bucket, []):
            text_html = mod.get('str') or ''
            # Display text: strip tags but keep the value ranges.
            display = re.sub(r'<[^>]+>', '', text_html)
            display = re.sub(r'\s+', ' ', display).strip()
            # Canonical form with values replaced by `#` (for matching).
            text = re.sub(r'\(\s*[\d.]+\s*[—\-–]\s*[\d.]+\s*\)', '#', display)
            text = re.sub(r'\(\s*[\d.]+\s*\)', '#', text)
            text = re.sub(r'[\d.]+', '#', text)
            text = re.sub(r'\s+', ' ', text).strip()
            tag_html = ' '.join(mod.get('mod_no') or [])
            tags = sorted(set(re.findall(r'data-tag="([^"]+)"', tag_html)))
            if text:
                raw_name = mod.get('Name', '')
                clean_name = re.sub(r'<[^>]+>', '', raw_name).strip()
                out.append((text, tags, bucket, clean_name, display))
    return out

bases = []
with slugs_file.open() as f:
    for line in f:
        if not line.strip(): continue
        b, s = line.rstrip('\n').split('\t')
        bases.append((b, s))

mods = json.load((out_dir / 'mods.json').open())
# Seed the consolidated dicts from existing on-disk JSONs so a partial
# re-scrape (script invoked with explicit [BASE…] args) only TOUCHES the
# bases it processes — every other base's data carries over. Without this
# seeding, running e.g. `update-poe2-tags.sh BOW` would clobber the entire
# extra_mods.json down to just BOW's data.
def _load_existing(name):
    p = out_dir / name
    if not p.exists():
        return {}
    try:
        return json.load(p.open())
    except Exception:
        return {}
mod_tags = _load_existing('mod_tags.json')
extra_mods = _load_existing('extra_mods.json')
mod_ranges = _load_existing('mod_ranges.json')
# Restrict touch-set to the bases actually being scraped this run, so the
# loop below overwrites their entries cleanly (no stale-from-prior-run
# noise) without affecting other bases.
touched_bases = {b for b, _s in bases}
for base in list(touched_bases):
    mod_tags.pop(base, None)
    extra_mods.pop(base, None)
    mod_ranges.pop(base, None)
for base, slug in bases:
    path = raw_dir / f'poe2db_base_{slug}.html'
    if not path.exists():
        continue
    html = path.read_text(encoding='utf-8', errors='ignore')
    rows = parse_html(html)
    if not rows:
        # Last-ditch: harvest any data-tag inside any block whose text
        # mentions one of the mods.json affix names. (Skipped for v1 —
        # too fuzzy. Just record empty.)
        mod_tags[base] = {}
        continue
    # Parser yields (canonical_text, tags) per mod. Cross-reference against
    # the names in mods.json for this base. Aggressive normalisation: strip
    # ALL whitespace, drop leading `+` (poe2db emits "+#" while mods.json
    # uses "#" for many mods), and unify dash variants. This catches the
    # "Polar Bear" class of mismatch (`+# % to Cold Resistance` vs
    # `#% to Cold Resistance`).
    def normalise(s):
        s = s.replace('—', '-').replace('–', '-').replace('+', '')
        s = re.sub(r'\s+', '', s)
        return s.lower()
    mods_by_name = {}
    for m in mods:
        if m['base'] == base:
            mods_by_name[m['name']] = normalise(m['name'])
    by_name = {n: set() for n in mods_by_name}
    extra = {'desecrated': [], 'essence': [], 'corrupted': []}
    # Per-base mod-tier-name → tier number map (from mods.json)
    tiername_to_tier = {}  # { canonical_mod_name: { tier_name: tier_number } }
    for m in mods:
        if m['base'] != base: continue
        per_mod = {}
        for t in m.get('tiers', []):
            tn = (t.get('tierName') or '').strip()
            if tn:
                per_mod[tn] = t.get('tier')
        tiername_to_tier[m['name']] = per_mod
    ranges_for_base = {}
    for text, tags, bucket, tier_name, display in rows:
        nt = normalise(text)
        if bucket == 'normal':
            for name, nn in mods_by_name.items():
                if nt == nn or nt in nn or nn in nt:
                    by_name[name].update(tags)
                    # Map tier_name → tier number; record display string.
                    tier_num = tiername_to_tier.get(name, {}).get(tier_name)
                    if tier_num is not None:
                        ranges_for_base.setdefault(name, {})[str(tier_num)] = display
                    break
        elif bucket in extra:
            extra[bucket].append({
                'text': text, 'tags': tags, 'tier_name': tier_name,
                'display': display,
            })
    mod_tags[base] = {k: sorted(v) for k, v in by_name.items() if v}
    if any(extra.values()):
        extra_mods[base] = {k: v for k, v in extra.items() if v}
    if ranges_for_base:
        mod_ranges[base] = ranges_for_base

out_path = out_dir / 'mod_tags.json'
with out_path.open('w', encoding='utf-8') as f:
    json.dump(mod_tags, f, ensure_ascii=False, indent=2)
total_rows = sum(len(v) for v in mod_tags.values())
print(f'  wrote {len(mod_tags)} bases, {total_rows} mod-tag entries -> {out_path.relative_to(out_dir.parent.parent)}')

extra_path = out_dir / 'extra_mods.json'
with extra_path.open('w', encoding='utf-8') as f:
    json.dump(extra_mods, f, ensure_ascii=False, indent=2)
desecrated_total = sum(len(v.get('desecrated', [])) for v in extra_mods.values())
essence_total = sum(len(v.get('essence', [])) for v in extra_mods.values())
print(f'  wrote {len(extra_mods)} bases, {desecrated_total} desecrated, {essence_total} essence mods -> {extra_path.relative_to(out_dir.parent.parent)}')

ranges_path = out_dir / 'mod_ranges.json'
with ranges_path.open('w', encoding='utf-8') as f:
    json.dump(mod_ranges, f, ensure_ascii=False, indent=2)
ranges_total = sum(sum(len(t) for t in m.values()) for m in mod_ranges.values())
print(f'  wrote {len(mod_ranges)} bases, {ranges_total} per-tier display strings -> {ranges_path.relative_to(out_dir.parent.parent)}')

# --- Per-base partition --------------------------------------------------
# Use the slug from the manifest emitted by update-poe2-data.sh so file
# names line up across the two scripts. Fall back to local slug derivation
# if the manifest isn't there yet (first-run ordering).
def slugify(base):
    head, _, paren = base.partition('(')
    name = head.strip().lower().replace(' ', '_')
    spec = paren.rstrip(')').strip().lower().replace('/', '').replace(' ', '') if paren else ''
    return name + ('_' + spec if spec else '')

by_base_dir = out_dir / 'by-base'
by_base_dir.mkdir(parents=True, exist_ok=True)
manifest_path = by_base_dir / 'index.json'
manifest = {}
if manifest_path.exists():
    try:
        manifest = json.load(manifest_path.open())
    except Exception:
        manifest = {}

all_bases = set(mod_tags) | set(extra_mods) | set(mod_ranges) | set(manifest)
for base in all_bases:
    slug = manifest.get(base) or slugify(base)
    manifest.setdefault(base, slug)
    tags_only = mod_tags.get(base, {})
    extra_only = extra_mods.get(base, {})
    ranges_only = mod_ranges.get(base, {})
    with (by_base_dir / f'{slug}.tags.json').open('w', encoding='utf-8') as f:
        json.dump(tags_only, f, ensure_ascii=False, indent=2)
    with (by_base_dir / f'{slug}.extra.json').open('w', encoding='utf-8') as f:
        json.dump(extra_only, f, ensure_ascii=False, indent=2)
    with (by_base_dir / f'{slug}.ranges.json').open('w', encoding='utf-8') as f:
        json.dump(ranges_only, f, ensure_ascii=False, indent=2)

# Refresh the manifest (idempotent — keeps any pre-existing entries from
# update-poe2-data.sh and adds bases visible only to the tags scrape).
with manifest_path.open('w', encoding='utf-8') as f:
    json.dump(dict(sorted(manifest.items())), f, ensure_ascii=False, indent=2)
print(f'  wrote per-base tags/extra/ranges for {len(all_bases)} base(s) -> {by_base_dir.name}/')
PY

rm -f "$SLUGS_FILE"
echo "Done."
