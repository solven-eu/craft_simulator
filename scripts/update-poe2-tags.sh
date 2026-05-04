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
    # Map "GLOVES (DEX)" -> "Gloves_dex"; "BODY ARMOURS (STR/DEX)" -> "Body_Armours_strdex"
    # "RING" -> "Rings", "QUIVER" -> "Quivers" (poe2db uses plural for some bases)
    name, _, paren = base.partition('(')
    name = name.strip().lower()
    spec = paren.rstrip(')').strip().lower().replace('/', '') if paren else ''
    # Pluralise common singular bases on poe2db
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
while IFS=$'\t' read -r base slug; do
  out="$RAW/poe2db_base_${slug}.html"
  if [[ ! -s "$out" ]]; then
    if curl -fsSL "https://poe2db.tw/us/${slug}" -o "$out" 2>/dev/null; then
      printf '  fetched %s -> %s\n' "$base" "$slug"
    else
      printf '  ! failed: %s (%s) — slug guess wrong; skipping\n' "$base" "$slug"
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
mod_tags = {}
# Per-base, per-bucket extracted entries (desecrated/essence/corrupted) for
# the UI to render as separate mod-pool sections. Each item:
# { name, text (canonical with `#`), tags, tier_name }
extra_mods = {}  # { base: { 'desecrated': [...], 'essence': [...], 'corrupted': [...] } }
# Per-base, per-mod, per-tier display strings with ACTUAL value ranges
# preserved from poe2db (`+(10—19) to maximum Life` instead of `#`).
# Shape: { base: { mod_name: { tier_number: display_text } } }
mod_ranges = {}
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
PY

rm -f "$SLUGS_FILE"
echo "Done."
