#!/usr/bin/env python3
"""
Merge Perfect-tier essence affixes (scraped into
data/poe2/perfect_essences.json by parse-perfect-essences.py) into
data/poe2/extra_mods.json so the in-app essence panel and per-tier
modal pick them up.

Each Perfect essence row carries an `item_class_group` (e.g. "Body
Armour", "One Handed Melee Weapon or Bow"). We expand that to
internal base IDs via data/poe2/item_class_tags.json, then append
one essence entry per base under extra_mods[base].essence.

Idempotent: re-running replaces previous Perfect-tier rows that
share the same (tier_name, text, base) tuple.

Note on grouping: Perfect essences typically grant a DIFFERENT
affix than their Lesser/Normal/Greater siblings (e.g. Perfect
Essence of the Body grants `(8—10)% increased maximum Life`, while
the lower tiers grant `+(N—M) to maximum Life`). They naturally
appear as separate rows in the essence panel, grouped by their own
text. The per-tier modal for the lower-tier affix legitimately has
no Perfect entry — that's not a data gap, it's the game's design.
"""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PERFECT = ROOT / 'data' / 'poe2' / 'perfect_essences.json'
EXTRA = ROOT / 'data' / 'poe2' / 'extra_mods.json'
TAGS = ROOT / 'data' / 'poe2' / 'item_class_tags.json'


def main():
    perfect = json.loads(PERFECT.read_text(encoding='utf-8'))
    extra = json.loads(EXTRA.read_text(encoding='utf-8'))
    tags = json.loads(TAGS.read_text(encoding='utf-8'))['tags']
    # Mod-tag lookup so Perfect rows inherit affix tags (`life`,
    # `chaos`, etc.) rather than landing with `tags: []` and
    # falling out of the tag-filter chip strip.
    mod_tags_path = ROOT / 'data' / 'poe2' / 'mod_tags.json'
    mod_tags_db = json.loads(mod_tags_path.read_text(encoding='utf-8')) if mod_tags_path.exists() else {}

    def tags_for(base: str, mod_text: str) -> list:
        """Look up affix tags for (base, mod_text). Falls back to
        any other base that lists this exact mod text. Mirrors the
        cross-base fallback used in the runtime store."""
        direct = (mod_tags_db.get(base) or {}).get(mod_text)
        if direct: return list(direct)
        for base_map in mod_tags_db.values():
            t = (base_map or {}).get(mod_text)
            if t: return list(t)
        return []

    # Build alias → tag-name map so we can resolve free-text item-class
    # groups like "Body Armour" or "One Handed Melee Weapon or Bow".
    alias_to_tag = {}
    for tag_name, tag in tags.items():
        for alias in tag.get('aliases', []):
            alias_to_tag[alias] = tag_name

    # Singular forms used by some Perfect-essence rows that aren't in
    # the scraped aliases (which use poe2db's plural section names).
    SINGULAR_TO_TAG = {
        'Body Armour': 'BODY_ARMOUR',
        'Helmet':      'HELMET',
        'Glove':       'GLOVES',
        'Gloves':      'GLOVES',
        'Boot':        'BOOTS',
        'Boots':       'BOOTS',
        'Amulet':      'AMULET',
        'Ring':        'RING',
        'Belt':        'BELT',
        'Sceptre':     'CASTER_WEAPON',  # narrow: only sceptres; tag name CASTER includes wands/staves/foci.
        'Wand':        'CASTER_WEAPON',
        'Staff':       'CASTER_WEAPON',
        'Focus':       'OFFHAND',
        'Focus or Wand': 'CASTER_WEAPON',
    }
    # For these we want a *narrow* member list rather than the full
    # tag — e.g. "Sceptre" should be just SCEPTRE, not all caster
    # weapons. Override here:
    NARROW_BASES = {
        'Sceptre':       ['SCEPTRE'],
        'Wand':          ['WAND', 'CHAOS WAND', 'FIRE WAND', 'ICE WAND', 'LIGHTNING WAND', 'PHYSICAL WAND'],
        'Staff':         ['STAFF', 'CHAOS STAFF', 'FIRE STAFF', 'ICE STAFF', 'LIGHTNING STAFF', 'PHYSICAL STAFF'],
        'Focus':         ['FOCUS'],
        'Focus or Wand': ['FOCUS', 'WAND', 'CHAOS WAND', 'FIRE WAND', 'ICE WAND', 'LIGHTNING WAND', 'PHYSICAL WAND'],
    }

    def expand_group(group: str) -> list:
        if not group: return []
        if group in NARROW_BASES:
            return NARROW_BASES[group]
        tag_name = alias_to_tag.get(group) or SINGULAR_TO_TAG.get(group)
        if tag_name and tag_name in tags:
            return list(tags[tag_name].get('members', []))
        for tag in tags.values():
            if group in tag.get('aliases', []):
                return list(tag.get('members', []))
        return []

    added = 0
    skipped_groups = []
    for essence_name, rows in perfect.items():
        # Normalise the synthesised tier_name so it matches the
        # existing essence-row schema (tier_name = "Perfect Essence of
        # the Body" etc.).
        for r in rows:
            group = r.get('item_class_group') or ''
            bases = expand_group(group)
            if not bases:
                skipped_groups.append((essence_name, group))
                continue
            for base in bases:
                if base not in extra:
                    extra[base] = {}
                bucket = extra[base].setdefault('essence', [])
                new_row = {
                    'tier_name': essence_name,
                    'text': r.get('text') or '',
                    'display': r.get('display') or '',
                    'tags': tags_for(base, r.get('text') or ''),
                }
                # Idempotent: drop any prior row with the same
                # (tier_name, text) before appending the fresh one.
                bucket[:] = [e for e in bucket
                             if not (e.get('tier_name') == new_row['tier_name']
                                     and e.get('text') == new_row['text'])]
                bucket.append(new_row)
                added += 1

    EXTRA.write_text(json.dumps(extra, indent=2, ensure_ascii=False),
                     encoding='utf-8')
    print(f'Merged {added} Perfect-essence row(s) into '
          f'{EXTRA.relative_to(ROOT)}')
    if skipped_groups:
        print(f'\nSkipped {len(skipped_groups)} row(s) — '
              f'item_class_group not resolvable to any base:')
        for name, g in skipped_groups:
            print(f'  {name}: {g!r}')
        print('Resolve by extending data/poe2/item_class_tags.json '
              'aliases or members.')
        sys.exit(1 if False else 0)  # warn but don't error


if __name__ == '__main__':
    main()
