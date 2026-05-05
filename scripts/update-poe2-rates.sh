#!/usr/bin/env bash
# Snapshot PoE2 currency rates from poe2db's Economy_* tables. These tables
# render server-side (no JS), so a plain curl + tbody parse suffices.
#
# Each row in an Economy table has the form:
#
#   <tr>
#     <td><a href="Economy_<slug>"><img/>Name</a> <a href="<Slug>">Wiki</a></td>
#     <td>X <a href="Economy_<refSlug>"><img/></a> ↔ Y <a href="Economy_<itemSlug>"><img/></a></td>
#     <td><svg sparkline/> <span>+N%</span></td>
#     <td><div class="text-end">VOLUME <img/></div></td>
#   </tr>
#
# Where (X, refSlug) and (Y, itemSlug) describe the trade ratio in either
# direction. We normalise to "ref currency per 1 unit of item":
#
#   if refSlug ∈ {divine, chaos, exalted}:  price = X / Y in `refSlug`
#
# `loadRates()` later combines these with the divine→exalted and chaos→exalted
# ratios (also in this CSV, taken from the divine and chaos rows themselves).
#
# Outputs:
#   data/raw/poe2db_economy_<page>.html   cached source
#   data/poe2/rates.csv                   name,slug,kind,ref_currency,price_per_unit,trend_7d_pct,daily_volume,image_url,fetched_at
#
# Usage:  scripts/update-poe2-rates.sh
#
# Source: https://poe2db.tw/us/Economy_* (CC BY-NC-SA 3.0).

set -euo pipefail

# Optional [REGION] arg picks which poe2db language path to scrape from
# (us, cn, de, fr, ru, kr, tw, jp). PoE2's economy is cross-region — these
# are language localisations, NOT separate regional servers — so prices
# are identical across regions; the choice only affects item-name
# language. We still record `region` in the CSV so the snapshot is
# self-describing for future audits.
REGION="${1:-us}"
case "$REGION" in
  us|cn|de|fr|ru|kr|tw|jp) ;;
  *) echo "  ! unknown region '$REGION' — pick one of us cn de fr ru kr tw jp" >&2; exit 2 ;;
esac

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RAW="$ROOT/data/raw"
OUT="$ROOT/data/poe2"
mkdir -p "$RAW" "$OUT"

# Order matters only for csv sort grouping. `kind` here is what we tag rows
# with — matches the sections used by the rates panel.
declare -a PAGES=(
  "Currency:currency"
  "Ritual:omen"
  "Essences:essence"
  "Fragments:fragment"
  "Soul_Cores:soul_core"
  "Breach:catalyst"
)

echo "[1/2] Fetching ${#PAGES[@]} Economy_* pages from /$REGION/…"
for spec in "${PAGES[@]}"; do
  page="${spec%%:*}"
  echo "  - Economy_$page"
  curl -fsSL "https://poe2db.tw/$REGION/Economy_$page" -o "$RAW/poe2db_economy_${page}.html"
done

echo "[2/2] Parsing tables …"
python3 - "$RAW" "$OUT" "$REGION" "${PAGES[@]}" <<'PY'
import csv, re, sys
from datetime import datetime, timezone
from pathlib import Path

raw_dir, out_dir, region, *page_specs = sys.argv[1:]
raw_dir, out_dir = Path(raw_dir), Path(out_dir)

ROW_RE = re.compile(r'<tr[^>]*>(.*?)</tr>', re.DOTALL)
TBODY_RE = re.compile(r'<tbody[^>]*>(.*?)</tbody>', re.DOTALL)
NAME_RE = re.compile(
    r'<a href="Economy_([^"]+)"[^>]*><img[^>]*src="([^"]+)"[^>]*/>([^<]+)</a>',
    re.DOTALL,
)
PAIR_RE = re.compile(
    r'(\d+(?:\.\d+)?)\s*<a href="Economy_([^"]+)"[^>]*><img[^>]*src="([^"]+)"',
    re.DOTALL,
)
TREND_RE = re.compile(r'<span style="color: \w+">([+-]?\d+)%</span>')
VOL_RE = re.compile(r'<div class="text-end">(\d+(?:\.\d+)?)\s*<img')
# poe2db's economy header carries the league name in a <h1> like
# "Economy Currency · Vaal" or in a select <option selected>. Best-effort
# extraction; blank if the upstream layout shifts.
LEAGUE_RE = re.compile(r'<option[^>]*selected[^>]*>([^<]+)</option>')

REF_SLUGS = {'divine', 'chaos', 'exalted'}

now = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
league = ''
records = []
for spec in page_specs:
    page, kind = spec.split(':', 1)
    src = (raw_dir / f'poe2db_economy_{page}.html').read_text(encoding='utf-8', errors='ignore')
    if not league:
        # First-page-wins league capture; the value is consistent across all
        # Economy_* pages on a given snapshot so any one of them is fine.
        league_m = LEAGUE_RE.search(src)
        if league_m:
            league = league_m.group(1).strip()
    tbody_m = TBODY_RE.search(src)
    if not tbody_m:
        print(f'  ! Economy_{page}: no <tbody>')
        continue
    rows = ROW_RE.findall(tbody_m.group(1))
    kept = 0
    for row in rows:
        name_m = NAME_RE.search(row)
        if not name_m: continue
        item_slug, item_img, name = name_m.group(1), name_m.group(2), name_m.group(3).strip()
        # Find the price td (always the 2nd <td>). Restrict the pair match to it.
        tds = re.findall(r'<td[^>]*>(.*?)</td>', row, re.DOTALL)
        if len(tds) < 2: continue
        pairs = PAIR_RE.findall(tds[1])
        # When the item IS one of the reference currencies (Divine, Chaos,
        # Exalted), match the item side first so we don't double-claim it.
        ref_qty = item_qty = ref_currency = None
        for qty, slug, _img in pairs:
            if slug == item_slug:
                item_qty = float(qty)
            elif slug in REF_SLUGS and ref_qty is None:
                ref_qty, ref_currency = float(qty), slug
        if ref_qty is None or item_qty is None or item_qty == 0:
            # Some rows pair item-vs-item (e.g. divine ↔ chaos itself); skip.
            continue
        price = ref_qty / item_qty
        trend_m = TREND_RE.search(row)
        vol_m = VOL_RE.search(row)
        records.append({
            'name': name,
            'slug': item_slug,
            'kind': kind,
            'ref_currency': ref_currency,
            'price_per_unit': price,
            'trend_7d_pct': trend_m.group(1) if trend_m else '',
            'daily_volume': vol_m.group(1) if vol_m else '',
            'image_url': item_img,
        })
        kept += 1
    print(f'  Economy_{page}: {kept} rows')

# Stable order: kind first, then name.
KIND_ORDER = {'currency': 0, 'omen': 1, 'essence': 2, 'catalyst': 3, 'fragment': 4, 'soul_core': 5}
records.sort(key=lambda r: (KIND_ORDER.get(r['kind'], 99), r['name']))

out_csv = out_dir / 'rates.csv'
with out_csv.open('w', newline='', encoding='utf-8') as f:
    w = csv.writer(f)
    w.writerow(['name', 'slug', 'kind', 'ref_currency', 'price_per_unit',
                'trend_7d_pct', 'daily_volume', 'image_url', 'fetched_at',
                'region', 'league'])
    for r in records:
        # Round price to 4 significant digits — anything finer is below
        # market noise (rates jitter ±5% intraday). 4 sig digits keeps
        # "187.2", "0.005650", "9684" — readable, comparable.
        w.writerow([r['name'], r['slug'], r['kind'], r['ref_currency'],
                    f"{r['price_per_unit']:.4g}", r['trend_7d_pct'],
                    r['daily_volume'], r['image_url'], now,
                    region, league])

print(f'  wrote {len(records)} rows -> data/poe2/rates.csv')
print(f'  region={region}  league={league or "?"}  fetched_at={now}')
PY

echo "Done."
echo
echo "Tip: \`git diff data/poe2/rates.csv\` reveals price drift between snapshots."
