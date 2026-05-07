#!/usr/bin/env bash
# Snapshot the prefix/suffix classification for the 196 desecrated mods
# from poe2db's "Desecrated Mods" tab. Each row in that tab is:
#   Name (source family) · Level · Pre/Suf · Description (mod text)
# We normalise the description into the same template form used by
# data/poe2/extra_mods.json (numeric placeholders -> `#`) so the UI can
# join on it: `text -> {side, level, family}`.
#
# Output: data/poe2/desecrated_sides.json
# Source: https://poe2db.tw/us/Desecrated_Modifiers#DesecratedMods
#         (CC BY-NC-SA 3.0).

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RAW="$ROOT/data/raw"
OUT="$ROOT/data/poe2"
mkdir -p "$RAW" "$OUT"

URL="https://poe2db.tw/us/Desecrated_Modifiers"
HTML="$RAW/poe2db_desecrated.html"

if [ ! -f "$HTML" ] || [ "${REFRESH:-0}" = "1" ]; then
  echo "[1/2] Fetching $URL …"
  curl -fsSL "$URL" -o "$HTML"
else
  echo "[1/2] Reusing cached $HTML (set REFRESH=1 to re-fetch)"
fi

echo "[2/2] Parsing #DesecratedMods table …"
python3 - "$HTML" "$OUT" <<'PY'
import json, re, sys
from datetime import datetime, timezone
from pathlib import Path

html_path, out_dir = Path(sys.argv[1]), Path(sys.argv[2])
html = html_path.read_text(encoding='utf-8', errors='ignore')

# Slice to the DesecratedMods tab and grab the first <table> after it.
anchor = html.find('id="DesecratedMods"')
if anchor < 0:
    sys.exit('DesecratedMods anchor not found in HTML')
tbl_start = html.find('<table', anchor)
tbl_end = html.find('</table>', tbl_start)
if tbl_start < 0 or tbl_end < 0:
    sys.exit('DesecratedMods table boundaries not found')
table_html = html[tbl_start:tbl_end]

ROW_RE = re.compile(r'<tr>(.*?)</tr>', re.DOTALL)
TD_RE  = re.compile(r'<td[^>]*>(.*?)</td>', re.DOTALL)
TAG_RE = re.compile(r'<[^>]+>')

def replace_mod_value_spans(s):
    # `mod-value` spans contain nested <span class="ndash">—</span> which
    # confuses a non-greedy `.*?</span>` match. Walk the string by hand,
    # capture each balanced mod-value span, and rewrite it as a single
    # placeholder. To stay aligned with extra_mods.json, the placeholder
    # preserves a leading `+` and trailing `%` if poe2db tucked them
    # inside the span (e.g. `<span class='mod-value'>+(8—15)%</span>`
    # becomes `+#%`, not `#`).
    out, i, OPEN = [], 0, "<span class='mod-value'>"
    while True:
        j = s.find(OPEN, i)
        if j < 0:
            out.append(s[i:])
            return ''.join(out)
        out.append(s[i:j])
        # Find the matching </span>, counting nested <span ...>.
        depth = 1
        k = j + len(OPEN)
        content_start = k
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
        inner_html = s[content_start:content_end] if depth == 0 else ''
        inner_text = TAG_RE.sub('', inner_html).strip()
        prefix = '+' if inner_text.startswith('+') else ''
        suffix = '%' if inner_text.endswith('%') else ''
        out.append(prefix + '#' + suffix)
        i = k

def normalise_description(html_chunk):
    # 1) Replace balanced mod-value spans (with nested children) by '#'.
    s = replace_mod_value_spans(html_chunk)
    # 2) Strip badge spans (tag chips at the end).
    s = re.sub(r"<span class=\"badge[^\"]*\"[^>]*>.*?</span>", '', s, flags=re.DOTALL)
    # 3) Strip anchor tags but keep their inner text.
    s = re.sub(r'<a[^>]*>(.*?)</a>', r'\1', s, flags=re.DOTALL)
    # 4) Drop any remaining tags + collapse whitespace.
    s = TAG_RE.sub('', s)
    s = re.sub(r'\s+', ' ', s).strip()
    return s

records = []
seen = set()
for row_match in ROW_RE.finditer(table_html):
    row = row_match.group(1)
    cells = TD_RE.findall(row)
    if len(cells) < 4:
        continue
    name = TAG_RE.sub('', cells[0]).strip()        # e.g. "Amanamu's"
    level_raw = TAG_RE.sub('', cells[1]).strip()   # e.g. "65"
    side_raw = TAG_RE.sub('', cells[2]).strip()    # "Prefix" | "Suffix"
    text = normalise_description(cells[3])
    if not text or side_raw not in ('Prefix', 'Suffix'):
        continue
    side = 'PREFIX' if side_raw == 'Prefix' else 'SUFFIX'
    key = text
    if key in seen:
        # Same template can repeat across families (e.g. "+# to maximum Life"
        # would appear under multiple sources if any did). Keep the first hit;
        # side should be invariant per template.
        continue
    seen.add(key)
    try:
        level = int(level_raw)
    except ValueError:
        level = None
    records.append({
        'text': text,
        'side': side,
        'family': name,
        'level': level,
    })

records.sort(key=lambda r: (r['side'], r['family'], r['text']))

now = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
payload = {
    'fetched_at': now,
    'source': 'https://poe2db.tw/us/Desecrated_Modifiers#DesecratedMods',
    'count': len(records),
    'mods': records,
}
out_path = out_dir / 'desecrated_sides.json'
out_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding='utf-8')

# Summary
prefixes = sum(1 for r in records if r['side'] == 'PREFIX')
suffixes = sum(1 for r in records if r['side'] == 'SUFFIX')
families = sorted({r['family'] for r in records})
print(f'  wrote {len(records)} desecrated-mod sides ({prefixes}P / {suffixes}S) to data/poe2/desecrated_sides.json')
print(f'  families: {", ".join(families)}')
PY

echo "Done."
