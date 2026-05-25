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

# Per-currency detail pages we ALSO scrape because the aggregator
# pages above silently omit some entries even when poe2db carries
# the trade data. Verified gap (2026-05-25): Omen of Sinistral /
# Dextral Necromancy and Omen of Abyssal Echoes are absent from
# Economy_Ritual (30 omens listed) but each individual detail page
# has the same Div/Chaos/Exalted price rows.
#
# Format: "Display Name:kind"  — same `kind` convention as PAGES.
# The URL is derived from the name (spaces → underscores) and the
# rates-CSV slug is also derived (lowercase + hyphens, prefixed
# with "omen-of-" etc.). Add entries as new gaps surface.
declare -a EXTRA_PAGES=(
  # Omens absent from Economy_Ritual.
  "Omen of Sinistral Necromancy:omen"
  "Omen of Dextral Necromancy:omen"
  "Omen of Abyssal Echoes:omen"
  "Omen of Light:omen"
  # (Omen of Sinistral/Dextral Coronation removed in PoE2 0.3 —
  # do NOT add back; the engine's regal_sinistral / regal_dextral
  # actions referencing them are legacy and should be gated by
  # mechanicsOverrides if the user wants to model pre-0.3 crafts.)
  # Bones — desecrated currencies referenced by games/poe2/currency.js
  # for the bone-trick / Well of Souls flow. Economy_Soul_Cores covers
  # soul cores only; bones live on their own detail pages.
  "Ancient Collarbone:desecrated"
  "Ancient Jawbone:desecrated"
  "Ancient Rib:desecrated"
  "Preserved Collarbone:desecrated"
  "Preserved Jawbone:desecrated"
  "Preserved Rib:desecrated"
  "Preserved Cranium:desecrated"
  "Gnawed Collarbone:desecrated"
  "Gnawed Jawbone:desecrated"
  "Gnawed Rib:desecrated"
  # Misc orbs referenced by the engine but absent from Economy_Currency.
  "Orb of Extraction:currency"
  "Vaal Cultivation Orb:currency"
)

echo "[1/3] Fetching ${#PAGES[@]} aggregator pages from /$REGION/…"
for spec in "${PAGES[@]}"; do
  page="${spec%%:*}"
  echo "  - Economy_$page"
  curl -fsSL "https://poe2db.tw/$REGION/Economy_$page" -o "$RAW/poe2db_economy_${page}.html"
done

echo "[2/3] Fetching ${#EXTRA_PAGES[@]} per-currency detail pages from /$REGION/…"
for spec in "${EXTRA_PAGES[@]}"; do
  name="${spec%%:*}"
  url_name="${name// /_}"
  out_html="$RAW/poe2db_detail_${url_name}.html"
  echo "  - $name"
  # `|| true` so an upstream 404 / network blip doesn't abort the
  # whole update — the per-item parser below will list any that
  # didn't yield a price, and the user can refresh manually.
  curl -fsSL "https://poe2db.tw/$REGION/$url_name" -o "$out_html" \
    || echo "    ! fetch failed (will be reported in the missing list)" >&2
done

echo "[3/3] Parsing all pages …"
python3 - "$RAW" "$OUT" "$REGION" "--aggregator" "${PAGES[@]}" "--extra" "${EXTRA_PAGES[@]}" <<'PY'
import csv, re, sys
from datetime import datetime, timezone
from pathlib import Path

raw_dir, out_dir, region, *rest = sys.argv[1:]
raw_dir, out_dir = Path(raw_dir), Path(out_dir)

# Split the rest into aggregator and extra (per-currency) lists.
# Sentinels (--aggregator, --extra) come from the shell side so the
# script can be re-invoked with either list omitted in the future.
def split_sentinels(args):
    cur = None
    out = {'aggregator': [], 'extra': []}
    for a in args:
        if a == '--aggregator': cur = 'aggregator'
        elif a == '--extra':    cur = 'extra'
        elif cur:               out[cur].append(a)
    return out
buckets = split_sentinels(rest)
page_specs = buckets['aggregator']
extra_specs = buckets['extra']

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

# ---- Per-currency detail-page parser ----------------------------
# Detail pages have the same row format as the aggregator, but EACH
# row has TWO Economy_* links: the ref currency first, then the
# item. NAME_RE on the row would match the ref currency by accident
# — so for detail pages we already KNOW the item slug from the
# input, and just need to find the first row pairing it with a ref
# currency.
#
# Strategy: scan PAIR_RE across the whole detail page (there's
# typically a primary table near the top with Div/Ex/Chaos rows),
# group consecutive (qty, slug) pairs into "ref ↔ item" tuples,
# and use the first pairing that hits a known ref currency.
seen_slugs = {r['slug'] for r in records}
missing_extras = []  # names that didn't yield a price (404, layout drift, etc.)
extras_added = 0
for spec in extra_specs:
    name, kind = spec.split(':', 1)
    url_name = name.replace(' ', '_')
    html_path = raw_dir / f'poe2db_detail_{url_name}.html'
    if not html_path.exists():
        missing_extras.append(f'{name} (fetch failed)')
        continue
    src = html_path.read_text(encoding='utf-8', errors='ignore')
    # Scope the parse to the page's OWN card (first
    # <h5 class="card-header"> ... </h5> followed by its <table>).
    # Otherwise unrelated omen tables on the same page (e.g. the
    # Abyssal Echoes page also embeds Omen of Light data) would
    # bleed into the result. The first card on a detail page is
    # always the page's primary item.
    #
    # Note: poe2db's economy slug doesn't always match the kebab
    # form of the display name — Omen of Abyssal Echoes uses the
    # slug `omen-of-abyssal-favours` internally. So we accept
    # whatever non-ref slug appears in the first card's table and
    # trust the page header / input name as the canonical display.
    card_re = re.compile(
        r'<h5\s+class="card-header">[^<]*</h5>.*?(<table[^>]*>.*?</table>)',
        re.DOTALL)
    card_m = card_re.search(src)
    table_src = card_m.group(1) if card_m else src
    pairs = PAIR_RE.findall(table_src)
    ref_qty = item_qty = ref_currency = item_slug = item_img = None
    for i, (qty, slug, img) in enumerate(pairs):
        if slug in REF_SLUGS and i + 1 < len(pairs):
            next_qty, next_slug, next_img = pairs[i + 1]
            if next_slug != slug and next_slug not in REF_SLUGS:
                ref_qty, ref_currency = float(qty), slug
                item_qty, item_slug, item_img = float(next_qty), next_slug, next_img
                break
    if ref_qty is None or item_qty is None or item_qty == 0:
        missing_extras.append(f'{name} (no Div/Ex/Chaos pair in the page-header card)')
        continue
    if item_slug in seen_slugs:
        # Aggregator already covered it; skip to avoid duplicate rows.
        continue
    seen_slugs.add(item_slug)
    records.append({
        'name': name,
        'slug': item_slug,
        'kind': kind,
        'ref_currency': ref_currency,
        'price_per_unit': ref_qty / item_qty,
        # Detail pages don't carry the 7-day trend / daily volume in
        # the same row format the aggregator uses; leave blank rather
        # than fabricate values. The rates panel handles empty trend
        # / volume gracefully (just hides the chip).
        'trend_7d_pct': '',
        'daily_volume': '',
        'image_url': item_img,
    })
    extras_added += 1
print(f'  Detail pages: {extras_added} rows added, {len(missing_extras)} missing')

# Stable order: kind first, then name.
KIND_ORDER = {'currency': 0, 'omen': 1, 'essence': 2, 'catalyst': 3, 'fragment': 4, 'soul_core': 5, 'desecrated': 6}
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

# Final summary: any extras that didn't yield a price. Surface them
# explicitly so the user knows the gap remains (poe2db might have
# changed the URL slug, dropped the page, or removed trade data).
# This is intentionally a warning, not an error — the rest of the
# snapshot is still useful and automated re-runs shouldn't fail.
if missing_extras:
    print('')
    print(f'WARN: {len(missing_extras)} per-currency detail page(s) yielded no price:')
    for m in missing_extras:
        print(f'  - {m}')
    print('  → either the page URL changed or trade data dried up.')
    print('  → update the EXTRA_PAGES list in scripts/update-poe2-rates.sh,')
    print('    or remove the entry if the currency was deprecated.')
PY

echo "Done."
echo
echo "Tip: \`git diff data/poe2/rates.csv\` reveals price drift between snapshots."
