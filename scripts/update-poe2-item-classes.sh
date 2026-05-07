#!/usr/bin/env bash
# Refresh data/poe2/item_class_tags.json from the canonical poe2db
# Items index. The page lists all item classes grouped by category
# (One Handed Weapons, Two Handed Weapons, Off-hand, Body Armours,
# Helmets, …); we parse it into a tag-membership JSON the engine and
# the UI can use to expand item-class group labels (e.g. "Martial
# Weapon", "One Handed Melee Weapon or Bow") to concrete base IDs in
# our catalog.
#
# Outputs:
#   data/raw/poe2db_items.html     cached page
#   data/poe2/item_class_tags.json regenerated
#
# Usage:  scripts/update-poe2-item-classes.sh
# REFRESH=1 forces a re-fetch (default uses the cached page).

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RAW="$ROOT/data/raw"
OUT="$ROOT/data/poe2"
mkdir -p "$RAW" "$OUT"

URL="https://poe2db.tw/us/Items"
HTML="$RAW/poe2db_items.html"

if [[ ! -f "$HTML" || "${REFRESH:-0}" = "1" ]]; then
  echo "[1/2] Fetching $URL …"
  curl -fsSL "$URL" -o "$HTML"
else
  echo "[1/2] Reusing cached $HTML (set REFRESH=1 to re-fetch)"
fi

echo "[2/2] Parsing classes and rebuilding item_class_tags.json …"
python3 - "$HTML" "$OUT/item_class_tags.json" "$OUT/mods.json" <<'PY'
import json, re, sys
from datetime import datetime, timezone
from pathlib import Path

html_path, out_path, mods_path = map(Path, sys.argv[1:4])
html = html_path.read_text(encoding='utf-8', errors='ignore')

# Each category block is `<ul>` whose first item is
# `<span class="disabled">SectionName</span>` and the rest are
# `<a class="ItemClasses ..." href="Slug">DisplayName</a>`.
# Sections we don't care about (gems, currencies, jewels, etc.) get
# filtered out by the SECTION_TAG_MAP below.
SECTION_RE = re.compile(
    r'<li><span class="disabled">([^<]+)</span></li>'
    r'(.*?)</ul>',
    re.DOTALL,
)
ENTRY_RE = re.compile(
    r'<a class="ItemClasses[^"]*"[^>]*href="([^"]+)"[^>]*>([^<]+)</a>',
)

# Map poe2db section header → tag name we expose in JSON. The page
# only emits these top-level sections (Armour and Jewellery cover all
# their pieces in a single block — we then synthesise per-piece tags).
SECTION_TAG_MAP = {
    'One Handed Weapons':  'ONE_HANDED_WEAPON',
    'Two Handed Weapons':  'TWO_HANDED_WEAPON',
    'Off-hand':            'OFFHAND',
    'Armour':              'ARMOUR',
    'Jewellery':           'JEWELLERY',
}

# Per-piece tag for each Armour / Jewellery class entry (display name → tag).
PIECE_TAG_BY_DISPLAY = {
    'Body Armours': 'BODY_ARMOUR',
    'Helmets':      'HELMET',
    'Gloves':       'GLOVES',
    'Boots':        'BOOTS',
    'Amulets':      'AMULET',
    'Rings':        'RING',
    'Belts':        'BELT',
}
# Sections that map to the same tag get unioned (e.g. four armour
# sections all contribute to ARMOUR). Order in the page is preserved.

# Map poe2db class display name → catalog base IDs in our mods.json.
# When a single poe2db class (e.g. "Bows") corresponds to one base in
# our catalog, the value is a singleton; otherwise it's the whole
# attribute / element family.
def expand_to_bases(display_name: str, catalog_bases: set) -> list:
    name = display_name.strip()
    # Direct match (uppercased) — covers BOW, CROSSBOW, SPEAR, etc.
    upper = name.upper()
    if upper in catalog_bases: return [upper]
    # Pluralisation: poe2db lists "Bows" / "Crossbows" / "Spears";
    # catalog uses singular "BOW" / "CROSSBOW" / "SPEAR".
    if upper.endswith('S') and upper[:-1] in catalog_bases: return [upper[:-1]]
    # Body Armours / Helmets / Gloves / Boots — match attribute-suffixed bases.
    base_root = upper.rstrip('S')
    if base_root.endswith('IE'): base_root = base_root[:-2] + 'Y'  # not currently used; safety
    if base_root == 'BODY ARMOUR':
        return sorted(b for b in catalog_bases if b.startswith('BODY ARMOUR ('))
    if base_root in ('HELMET', 'GLOVE', 'BOOT'):
        # Catalog stores HELMET / GLOVES / BOOTS with attribute suffix;
        # normalise root → catalog stem.
        stem = {'HELMET': 'HELMET', 'GLOVE': 'GLOVES', 'BOOT': 'BOOTS'}[base_root]
        return sorted(b for b in catalog_bases if b.startswith(stem + ' ('))
    if base_root == 'SHIELD':
        return sorted(b for b in catalog_bases if b.startswith('SHIELD ('))
    if base_root == 'BUCKLER':
        return ['BUCKLER'] if 'BUCKLER' in catalog_bases else []
    if base_root == 'WAND':
        # Includes elemental wand variants if catalog tracks them.
        return sorted([b for b in catalog_bases if b == 'WAND' or b.endswith(' WAND')])
    if base_root == 'STAVE':  # "Staves" → STAVE singular root
        return sorted([b for b in catalog_bases if b == 'STAFF' or b.endswith(' STAFF')])
    if base_root == 'QUARTERSTAVE':
        # "Quarterstaves" — catalog has both QUARTERSTAFF and WARSTAFF.
        return sorted([b for b in catalog_bases if b in ('QUARTERSTAFF', 'WARSTAFF')])
    if base_root == 'ONE HAND MACE': return ['ONE HAND MACE'] if 'ONE HAND MACE' in catalog_bases else []
    if base_root == 'TWO HAND MACE': return ['TWO HAND MACE'] if 'TWO HAND MACE' in catalog_bases else []
    # No catalog match — return empty list, gap is reported separately.
    return []

# Load catalog bases.
mods = json.loads(mods_path.read_text(encoding='utf-8'))
catalog_bases = sorted({m['base'] for m in mods})
catalog_set = set(catalog_bases)

# Pull all category sections.
tags = {}        # tag_name → { description, aliases, members:set, classes:[(display, slug)] }
order = []
for m in SECTION_RE.finditer(html):
    section = m.group(1).strip()
    body = m.group(2)
    tag = SECTION_TAG_MAP.get(section)
    if not tag: continue
    entries = ENTRY_RE.findall(body)
    if not entries: continue
    if tag not in tags:
        tags[tag] = {
            'description': '',
            'aliases': [section],
            'members': set(),
            'classes': [],
            'gaps': [],
        }
        order.append(tag)
    for slug, display in entries:
        display = display.strip()
        slug = slug.strip()
        bases = expand_to_bases(display, catalog_set)
        tags[tag]['classes'].append({'display': display, 'slug': slug})
        if bases:
            tags[tag]['members'].update(bases)
        else:
            tags[tag]['gaps'].append(display)

# Synthesise per-piece tags from the Armour / Jewellery sections.
for parent_tag in ('ARMOUR', 'JEWELLERY'):
    if parent_tag not in tags: continue
    for c in tags[parent_tag]['classes']:
        piece_tag = PIECE_TAG_BY_DISPLAY.get(c['display'])
        if not piece_tag: continue
        bases = expand_to_bases(c['display'], catalog_set)
        if piece_tag not in tags:
            tags[piece_tag] = {
                'description': '',
                'aliases': [c['display']],
                'members': set(bases),
                'classes': [c],
                'gaps': [] if bases else [c['display']],
            }
            order.append(piece_tag)
        else:
            tags[piece_tag]['members'].update(bases)
            tags[piece_tag]['classes'].append(c)
            if not bases: tags[piece_tag]['gaps'].append(c['display'])
    # Roll the parent tag's members up from the per-piece members.
    parent_members = set()
    for c in tags[parent_tag]['classes']:
        bases = expand_to_bases(c['display'], catalog_set)
        parent_members.update(bases)
    tags[parent_tag]['members'] = parent_members

# Hand-tag descriptions (verbatim in-game tooltips when known).
DESCRIPTIONS = {
    'ONE_HANDED_WEAPON':
        'One Handed Weapons. Per the in-game tooltip: Claws, Daggers, '
        'Wands, One Hand Swords, One Hand Axes, One Hand Maces, '
        'Sceptres, Spears, Flails.',
    'TWO_HANDED_WEAPON':
        'Two Handed Weapons. Per the in-game tooltip: Bows, Staves, '
        'Two Hand Swords, Two Hand Axes, Two Hand Maces, Quarterstaves, '
        'Fishing Rods, Crossbows, Traps, Talismans.',
    'OFFHAND':
        'Off-hand items: Quivers, Shields, Bucklers, Foci.',
    'BODY_ARMOUR':   'Chest armour, all attribute variants.',
    'HELMET':        'Head armour, all attribute variants.',
    'GLOVES':        'Hand armour, all attribute variants.',
    'BOOTS':         'Foot armour, all attribute variants.',
    'AMULET':        'Amulet — neck slot accessory.',
    'RING':          'Ring — finger slot accessory.',
    'BELT':          'Belt — waist slot accessory.',
    'ARMOUR':        'All wearable armour pieces (chest + helmet + gloves + boots).',
    'JEWELLERY':     'Amulet, Ring, Belt — the three accessory slots.',
}

# Synthesised tags (built from the scraped data, not from a single
# poe2db section): MARTIAL_WEAPON, CASTER_WEAPON, ARMOUR, JEWELLERY,
# ONE_HANDED_MELEE_OR_BOW, TWO_HANDED_MELEE_OR_CROSSBOW.
def members_of(tag): return tags.get(tag, {}).get('members', set())

# MARTIAL_WEAPON = (1H ∪ 2H) − {Wands, Sceptres, Staves, Foci}.
caster_displays = {'Wands', 'Sceptres', 'Staves', 'Foci'}
def is_caster_class(display):
    return display in caster_displays
martial_members = set()
for tag in ('ONE_HANDED_WEAPON', 'TWO_HANDED_WEAPON'):
    for c in tags.get(tag, {}).get('classes', []):
        if not is_caster_class(c['display']):
            for b in expand_to_bases(c['display'], catalog_set):
                martial_members.add(b)
# Synthesised: CASTER_WEAPON
caster_members = set()
for tag in ('ONE_HANDED_WEAPON', 'TWO_HANDED_WEAPON'):
    for c in tags.get(tag, {}).get('classes', []):
        if is_caster_class(c['display']):
            for b in expand_to_bases(c['display'], catalog_set):
                caster_members.add(b)
# FOCUS goes under offhand on poe2db; add it to caster too.
for c in tags.get('OFFHAND', {}).get('classes', []):
    if c['display'] in ('Foci', 'Focus'):
        for b in expand_to_bases(c['display'], catalog_set):
            caster_members.add(b)

# Synthesised: ARMOUR (chest + helmet + gloves + boots), JEWELLERY (amulet + ring + belt).
armour_members = set()
for t in ('BODY_ARMOUR', 'HELMET', 'GLOVES', 'BOOTS'):
    armour_members.update(members_of(t))

jewellery_members = set()
for t in ('AMULET', 'RING', 'BELT'):
    jewellery_members.update(members_of(t))

# 1H melee: 1H − casters − ranged; 2H melee: 2H − casters − ranged.
# Bows / Crossbows / Fishing Rods / Traps / Talismans are ranged or
# thrown; not melee even though they're Martial.
ranged_displays = {'Bows', 'Crossbows', 'Fishing Rods', 'Traps', 'Talismans'}
def melee_subset(tag):
    out = set()
    for c in tags.get(tag, {}).get('classes', []):
        if is_caster_class(c['display']) or c['display'] in ranged_displays:
            continue
        out.update(expand_to_bases(c['display'], catalog_set))
    return out

# poe2db-style "One Handed Melee Weapon or Bow" — 1H melee plus Bow.
oh_melee_or_bow = melee_subset('ONE_HANDED_WEAPON') | ({'BOW'} if 'BOW' in catalog_set else set())
# "Two Handed Melee Weapon or Crossbow" — 2H melee plus Crossbow.
th_melee_or_crossbow = melee_subset('TWO_HANDED_WEAPON') | ({'CROSSBOW'} if 'CROSSBOW' in catalog_set else set())

# Build the output.
def sorted_list(s): return sorted(s)

now = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
out = {
    '_meta': {
        'purpose': "Item-class tag taxonomy. Maps abstract groupings "
                   "(poe2db's free-text labels like 'Martial Weapon', "
                   "'One Handed Melee Weapon or Bow') to the concrete "
                   "base IDs in our catalog. Used to expand essence / "
                   "orb / omen applicability rules from textual class-"
                   "groups to actual base lists.",
        'source': 'https://poe2db.tw/us/Items (in-game item-class taxonomy). '
                  'Regenerated by scripts/update-poe2-item-classes.sh.',
        'fetched_at': now,
        'rule_when_disagreement': 'When the in-game tooltip and poe2db disagree, the tooltip wins.',
        'schema': {
            'tags': {
                '<TAG_NAME>': {
                    'description': 'Human-readable definition.',
                    'aliases': 'Alternative phrasings poe2db / wiki use.',
                    'members': 'Catalog base IDs that carry this tag.',
                    'classes': 'For scraped tags: the poe2db class names + slugs covered.',
                    '_catalog_gaps': 'poe2db classes not yet in our catalog.',
                },
            },
        },
    },
    'tags': {},
}

# Scraped tags first (in poe2db order).
for tag in order:
    rec = tags[tag]
    out['tags'][tag] = {
        'description': DESCRIPTIONS.get(tag, ''),
        'aliases': rec['aliases'],
        'members': sorted_list(rec['members']),
        'classes': rec['classes'],
        '_catalog_gaps': rec['gaps'],
    }

# Synthesised tags — sit alongside the scraped ones.
out['tags']['MARTIAL_WEAPON'] = {
    'description': 'Martial Weapons can be used to Attack. Axes, Bows, Claws, '
                   'Crossbows, Daggers, Flails, Maces, Quarterstaves, Spears, '
                   'Swords, and Talismans are Martial Weapons.',
    'aliases': ['Martial Weapon', 'Martial Weapons'],
    'members': sorted_list(martial_members),
    '_synthesised_from': '(ONE_HANDED_WEAPON ∪ TWO_HANDED_WEAPON) − caster classes (Wands, Sceptres, Staves, Foci)',
}
out['tags']['CASTER_WEAPON'] = {
    'description': 'Caster weapons — used by spells / minion skills, not Attacks. '
                   'Wands (1H), Sceptres (1H), Staves (2H), and Foci (off-hand).',
    'aliases': ['Caster Weapon', 'Caster Weapons'],
    'members': sorted_list(caster_members),
    '_synthesised_from': 'Wands ∪ Sceptres ∪ Staves ∪ Foci',
}
out['tags']['ONE_HANDED_MELEE_OR_BOW'] = {
    'description': '1H melee martial weapons plus Bows. Used by poe2db essence '
                   'groupings to scope 1H damage rolls. Excludes casters.',
    'aliases': ['One Handed Melee Weapon or Bow'],
    'members': sorted_list(oh_melee_or_bow),
    '_synthesised_from': '(ONE_HANDED_WEAPON − casters) ∪ {BOW}',
}
out['tags']['TWO_HANDED_MELEE_OR_CROSSBOW'] = {
    'description': '2H melee martial weapons plus Crossbows. Used by poe2db essence '
                   'groupings to scope 2H damage rolls. Excludes casters.',
    'aliases': ['Two Handed Melee Weapon or Crossbow'],
    'members': sorted_list(th_melee_or_crossbow),
    '_synthesised_from': 'TWO_HANDED_WEAPON − casters (Crossbow naturally included)',
}
out['tags']['ARMOUR'] = {
    'description': 'All wearable armour pieces (chest + helmet + gloves + boots).',
    'aliases': ['Armour', 'Armor'],
    'members': sorted_list(armour_members),
    '_synthesised_from': 'BODY_ARMOUR ∪ HELMET ∪ GLOVES ∪ BOOTS',
}
out['tags']['JEWELLERY'] = {
    'description': 'Amulet / Ring / Belt — the three accessory slots.',
    'aliases': ['Jewellery'],
    'members': sorted_list(jewellery_members),
    '_synthesised_from': 'AMULET ∪ RING ∪ BELT',
}

out_path.write_text(json.dumps(out, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')

# Console summary
print(f'  Wrote {out_path.relative_to(Path.cwd().parent / "poe-crafter")}')
print(f'  {len(out["tags"])} tags · catalog has {len(catalog_set)} bases')
total_gaps = sum(len(t.get("_catalog_gaps", [])) for t in out['tags'].values())
print(f'  catalog gaps: {total_gaps} (poe2db classes without a catalog base)')
print()
for tag_name, t in out['tags'].items():
    n_members = len(t.get('members', []))
    n_gaps = len(t.get('_catalog_gaps', []))
    flag = ' ⚠' if n_gaps else ''
    print(f'  {tag_name:<32} {n_members:>3} bases{(" · " + str(n_gaps) + " gap(s)") if n_gaps else ""}{flag}')
PY

echo "Done."
