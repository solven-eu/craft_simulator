#!/usr/bin/env python3
"""
Phase 0 of the mod-identity refactor (see ROADMAP "Mod identity refactor"):
generate a stable ASCII id per unique mod name, and emit a flat JSON
mapping at data/poe2/mod_ids.json.

The mapping is the source of truth that subsequent phases (engine
adapter, UI store, URL serializer) consume. Keeping it in its own
file keeps the diff reviewable and avoids touching mods.json /
extra_mods.json until the id table is signed off.

ID convention chosen by the project owner: short ASCII like `max_life`
(lowercase, snake_case, no `p_` / `s_` side prefix). Side is already
encoded by the type field on each mod entry.

Slug recipe
-----------
Applied in order:

  1. Strip leading `+`. Drop placeholder characters (`#`, `%`).
  2. Lowercase.
  3. Pattern substitutions for common verbose roots:
       ' to maximum ' → 'max_'
       ' resistance'  → '_res'
       '% increased ' → 'increased_'
       ' to '         → ''       (filler)
  4. Replace remaining non-alphanumeric runs with `_`.
  5. Collapse repeated `_`. Strip leading/trailing `_`.

Examples (from the canonical mod set):

  '+# to maximum Life'                     → max_life
  '#% to Cold Resistance'                  → cold_res
  '#% increased Critical Hit Chance'       → increased_critical_hit_chance
  '# to # Physical Thorns damage'          → physical_thorns_damage
  '+#% increased Armour, Evasion or
   Energy Shield'                          → increased_armour_evasion_or_energy_shield
  'Mark of the Abyssal Lord'               → mark_of_the_abyssal_lord

Synthetic essence/desecrated-only mods that have no base-pool entry
(Mark of the Abyssal Lord, Allocates a Notable, etc.) get the same
treatment — their id starts with no prefix; the engine treats them
as ordinary ids. If we later want a `meta_*` namespace we can add it
without re-keying.

Collision handling
------------------

Multiple display names slugifying to the same id is the **intended
behaviour** — `# to Dexterity` and `+# to Dexterity` are the same
affix; both map to `dexterity`. The script reports these collapsed
groups for transparency but does not error.

Empty ids (slug = '') are still a hard error.
"""

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MODS_JSON = ROOT / 'data' / 'poe2' / 'mods.json'
EXTRA_MODS_JSON = ROOT / 'data' / 'poe2' / 'extra_mods.json'
OUT = ROOT / 'data' / 'poe2' / 'mod_ids.json'

# Order matters: longer / more specific patterns first so they match
# before the generic ' to ' filler-drop. The bare 'maximum' → 'max'
# rule fires first so any usage (including non-' to maximum X' forms
# such as 'per Maximum Life' or 'Recover #% of Maximum Mana') is
# normalised before the rest of the substitutions look at the string.
SUBSTITUTIONS = [
    ('maximum',       'max'),
    ('damage',        'dmg'),
    ('strength',      'str'),
    ('dexterity',     'dex'),
    ('intelligence',  'int'),
    ('critical',      'crit'),
    ('increased',     'inc'),
    ('energy shield', 'es'),
    (' resistance ',  ' _res '),
    (' resistance',   ' _res'),
    ('% inc ',        ' inc_'),
    (' to ',          ' '),
    (' of ',          ' '),
]


def slugify(name: str) -> str:
    s = name.strip()
    # Strip placeholder characters and leading +.
    s = re.sub(r'^\+', '', s)
    s = s.replace('#', '').replace('%', '')
    s = s.lower()
    for src, dst in SUBSTITUTIONS:
        s = s.replace(src, dst)
    # Replace non-alphanumeric runs with `_`. Keep underscores.
    s = re.sub(r'[^a-z0-9_]+', '_', s)
    s = re.sub(r'_+', '_', s)
    return s.strip('_')


def main():
    mods = json.loads(MODS_JSON.read_text(encoding='utf-8'))
    # Collect every unique display name across the catalog.
    names = set()
    for m in mods:
        n = m.get('name')
        if isinstance(n, str) and n.strip():
            names.add(n)

    # Also pull essence / desecrated affix names from extra_mods.json.
    extra = json.loads(EXTRA_MODS_JSON.read_text(encoding='utf-8'))
    extra_names = set()
    for base_v in extra.values():
        for bucket in ('essence', 'desecrated', 'corrupted'):
            for entry in base_v.get(bucket, []):
                t = entry.get('text')
                if isinstance(t, str) and t.strip():
                    extra_names.add(t)

    all_names = sorted(names | extra_names)
    name_to_id = {}
    id_to_names = {}
    empty_id_names = []

    for name in all_names:
        mod_id = slugify(name)
        if not mod_id:
            empty_id_names.append(name)
            continue
        id_to_names.setdefault(mod_id, []).append(name)
        name_to_id[name] = mod_id

    if empty_id_names:
        print('ERROR — display names that slugify to "":', file=sys.stderr)
        for n in empty_id_names:
            print(f'  - {n!r}', file=sys.stderr)
        print('Extend SUBSTITUTIONS or hand-map. Aborting.', file=sys.stderr)
        sys.exit(1)

    # Report collapsed groups (same id, multiple source spellings) —
    # informational, not an error. This is the intended outcome for
    # +/non-+ variants of the same affix.
    collapsed = [(mid, names) for mid, names in id_to_names.items() if len(names) > 1]
    if collapsed:
        print(f'Collapsed {len(collapsed)} id group(s) where multiple '
              f'spellings map to one id:')
        for mid, names in sorted(collapsed):
            print(f'  {mid}: {names}')
        print()

    payload = {
        '_meta': {
            'purpose': 'Phase 0 of the mod-identity refactor — stable ASCII ids per mod display name. '
                       'Used by the engine adapter and UI store as the keying axis once the refactor lands.',
            'convention': 'lowercase snake_case; pattern substitutions: "maximum" → "max", '
                          '"damage" → "dmg", "strength" → "str", "dexterity" → "dex", '
                          '"intelligence" → "int", "critical" → "crit", "increased" → "inc", '
                          '"energy shield" → "es", "resistance" → "_res", "% inc" → "inc_", '
                          '"to " and "of " filler dropped. Side (PREFIX/SUFFIX) is encoded '
                          'separately on each mod entry, not in the id.',
            'count': len(name_to_id),
        },
        'name_to_id': dict(sorted(name_to_id.items())),
    }
    OUT.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
    print(f'Wrote {OUT.relative_to(ROOT)}: {len(name_to_id)} unique mod names → ids')
    # Sample for sanity check.
    print('\nSample (first 15):')
    for name in sorted(name_to_id)[:15]:
        print(f'  {name_to_id[name]:<40} {name}')


if __name__ == '__main__':
    main()
