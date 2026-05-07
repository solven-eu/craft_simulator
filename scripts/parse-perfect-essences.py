#!/usr/bin/env python3
"""
Extract Perfect-tier essence affix data from cached poe2db pages.

Reads the per-essence detail HTML at `data/raw/poe2db_essence_Perfect_*.html`
(downloaded earlier by `scripts/update-poe2-essences.sh`) and emits a
structured JSON file at `data/poe2/perfect_essences.json` with one
record per essence per item-class line:

  {
    "Perfect Essence of the Body": [
      {"item_class_group": "Body Armour",
       "text":  "#% increased maximum Life",
       "display": "(8—10)% increased maximum Life",
       "tags": []}
    ],
    ...
  }

Notes
-----
* `mod-value` spans contain nested `<span class="ndash">—</span>` — we
  walk the string by hand to handle balanced nesting (same bug pattern
  fixed in `update-poe2-desecrated-sides.sh`).
* `text` is the affix template with the mod-value collapsed to `#`,
  preserving any leading `+` or trailing `%` that poe2db tucked inside
  the span (matches the convention used by `data/poe2/extra_mods.json`).
* `display` keeps the range string (e.g. "(8—10)%") so the per-tier
  modal can show roll bounds.
* The item-class group string is preserved verbatim (e.g. "Body Armour",
  "One Handed Melee Weapon or Bow"); mapping to our internal base IDs
  is left to a follow-up step where the user can review the rules.
"""

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / 'data' / 'raw'
OUT_JSON = ROOT / 'data' / 'poe2' / 'perfect_essences.json'

EXPLICIT_RE = re.compile(r'<div class="explicitMod">(.*?)</div>', re.DOTALL)
TAG_RE = re.compile(r'<[^>]+>')
HEADER_DESC_RE = re.compile(
    r'Removes a random modifier|Body Armour|Belt|Amulet|Ring|Boots|Gloves|Helmet|'
    r'Buckler|Shield|Quiver|Focus|Sceptre|Wand|Staff|One Handed|Two Handed|'
    r'Martial|Caster|Bow|Crossbow|Spear|Talisman|Jewel|Weapon',
    re.IGNORECASE,
)


def walk_mod_values(s: str, on_span):
    """Walk the string replacing each balanced <span class='mod-value'>...</span>
    by `on_span(inner_text)`. Returns the rewritten string."""
    out = []
    i = 0
    OPEN = "<span class='mod-value'>"
    while True:
        j = s.find(OPEN, i)
        if j < 0:
            out.append(s[i:])
            return ''.join(out)
        out.append(s[i:j])
        depth = 1
        k = j + len(OPEN)
        content_start = k
        content_end = -1
        while depth > 0 and k < len(s):
            open_at = s.find('<span', k)
            close_at = s.find('</span>', k)
            if close_at < 0:
                break
            if open_at >= 0 and open_at < close_at:
                depth += 1
                k = open_at + 5
            else:
                depth -= 1
                if depth == 0:
                    content_end = close_at
                k = close_at + len('</span>')
        inner_html = s[content_start:content_end] if content_end >= 0 else ''
        inner_text = TAG_RE.sub('', inner_html).strip()
        out.append(on_span(inner_text))
        i = k


def parse_explicit_line(raw_html: str):
    """Parse one <div class="explicitMod"> body. Returns dict with
    item_class_group, text (with `#` placeholders), display (verbatim
    ranges) — or None if it's the meta description line."""
    text_no_tags = TAG_RE.sub('', raw_html).strip()
    if 'Removes a random modifier' in text_no_tags or not text_no_tags:
        return None
    # Detect "Item Class: <rest>" prefix by inspecting the text before
    # the first mod-value span.
    mv_idx = raw_html.find("<span class='mod-value'>")
    pre = raw_html[:mv_idx] if mv_idx >= 0 else raw_html
    pre_text = TAG_RE.sub('', pre).strip()
    item_class_group = ''
    if ':' in pre_text:
        head, _ = pre_text.rsplit(':', 1)
        # Sanity: only treat as class prefix if not too long (avoid
        # capturing entire sentence).
        if len(head) <= 60:
            item_class_group = head.strip()

    def to_placeholder(inner_text):
        prefix = '+' if inner_text.startswith('+') else ''
        suffix = '%' if inner_text.endswith('%') else ''
        return prefix + '#' + suffix

    def to_verbatim(inner_text):
        return inner_text

    template_html = walk_mod_values(raw_html, to_placeholder)
    display_html = walk_mod_values(raw_html, to_verbatim)
    # Strip badges and anchors, keep their text content; drop other tags.
    def cleanup(s):
        s = re.sub(r"<span class=\"badge[^\"]*\"[^>]*>.*?</span>", '', s, flags=re.DOTALL)
        s = re.sub(r'<a[^>]*>(.*?)</a>', r'\1', s, flags=re.DOTALL)
        s = TAG_RE.sub('', s)
        return re.sub(r'\s+', ' ', s).strip()
    template = cleanup(template_html)
    display = cleanup(display_html)
    if item_class_group:
        if template.startswith(item_class_group + ':'):
            template = template[len(item_class_group) + 1:].strip()
        if display.startswith(item_class_group + ':'):
            display = display[len(item_class_group) + 1:].strip()
    return {
        'item_class_group': item_class_group,
        'text': template,
        'display': display,
    }


def main():
    files = sorted(RAW.glob('poe2db_essence_Perfect_*.html'))
    if not files:
        raise SystemExit(f'No Perfect-essence pages found under {RAW}')

    out = {}
    for f in files:
        # Filename → "Perfect Essence of the Body"
        name = f.stem.replace('poe2db_essence_', '').replace('_', ' ')
        html = f.read_text(encoding='utf-8', errors='ignore')
        rows = []
        for m in EXPLICIT_RE.finditer(html):
            parsed = parse_explicit_line(m.group(1))
            if parsed:
                rows.append(parsed)
        out[name] = rows

    OUT_JSON.write_text(json.dumps(out, indent=2, ensure_ascii=False), encoding='utf-8')
    # Summary
    total_rows = sum(len(v) for v in out.values())
    print(f'Wrote {OUT_JSON.relative_to(ROOT)}')
    print(f'  {len(out)} Perfect-tier essences, {total_rows} item-class lines')
    for name, rows in out.items():
        print(f'  {name}:')
        for r in rows:
            print(f'    [{r["item_class_group"] or "(any)"}] {r["text"]}    [{r["display"]}]')


if __name__ == '__main__':
    main()
