#!/usr/bin/env bash
# Refresh the PoE2 crafting dataset from Krakenbul's Google Sheet.
#
# Outputs:
#   data/raw/krakenbul_weights.xlsx     full workbook (archive)
#   data/raw/krakenbul_<tab>.csv        per-tab CSV (one per visible tab)
#   data/poe2/mods.json                 merged per-(base, mod) records,
#                                       runtime-friendly shape (legacy
#                                       consolidated view kept for callers
#                                       that need a global mod list)
#   data/poe2/by-base/<slug>.mods.json  same records, partitioned by base —
#                                       runtime should prefer these for
#                                       per-craft loads
#   data/poe2/by-base/index.json        manifest { base: slug } so the
#                                       runtime can resolve a base name to
#                                       a filename without directory scans
#
# Usage:  scripts/update-poe2-data.sh [SHEET_ID]
# Default SHEET_ID is Krakenbul's "WEIGHTS + ILVLS 0.4".

set -euo pipefail

SHEET_ID="${1:-1QSAu0A-ZKcHFlQ5QCcUJSMb0ebXq1nxpGRUVgHXVjW8}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RAW="$ROOT/data/raw"
OUT="$ROOT/data/poe2"
mkdir -p "$RAW" "$OUT"

GS_BASE="https://docs.google.com/spreadsheets/d/$SHEET_ID"

echo "[1/3] Downloading workbook (xlsx)…"
curl -fsSL -o "$RAW/krakenbul_weights.xlsx" "$GS_BASE/export?format=xlsx"

echo "[2/3] Discovering tabs and downloading per-tab CSVs…"
# Parse htmlview to get (tab name, gid) pairs — robust to tab additions/renames.
mapping="$(
  curl -fsSL "$GS_BASE/htmlview" \
    | grep -oE 'name: "[A-Z_][A-Z0-9_]*", pageUrl: "[^"]*gid=[0-9]+' \
    | sed -E 's/name: "([^"]+)".*gid=([0-9]+).*/\1 \2/'
)"

if [[ -z "$mapping" ]]; then
  echo "  ! could not parse tabs from htmlview — sheet structure may have changed" >&2
  exit 1
fi

while read -r name gid; do
  [[ -z "$name" ]] && continue
  lname="$(echo "$name" | tr '[:upper:]' '[:lower:]')"
  printf '  - %-12s gid=%-12s -> krakenbul_%s.csv\n' "$name" "$gid" "$lname"
  curl -fsSL -o "$RAW/krakenbul_${lname}.csv" \
    "$GS_BASE/export?format=csv&gid=$gid"
done <<< "$mapping"

echo "[3/3] Merging tabs into $OUT/mods.json…"
python3 - "$RAW" "$OUT/mods.json" <<'PY'
import csv, json, sys
from pathlib import Path

raw_dir, out_path = Path(sys.argv[1]), Path(sys.argv[2])

# Each tab carries one attribute per tier slot (columns "1".."13").
# Merge them keyed by (BASE, TYPE, NAME) so the runtime sees one record per mod.
TAB_ATTRS = {
    "weights":   ("weight",   int),
    "ilvls":     ("ilvl",     int),
    "spawnlvls": ("spawnLvl", int),
    "names":     ("tierName", str),
    "ids":       ("id",       str),
}

records = {}  # (base, type, name) -> dict
order = []

def cast(value, kind):
    v = value.strip()
    if v == "":
        return None
    if kind is int:
        try: return int(v)
        except ValueError: return None
    return v

for tab, (attr, kind) in TAB_ATTRS.items():
    path = raw_dir / f"krakenbul_{tab}.csv"
    if not path.exists():
        print(f"  ! missing {path.name}, skipping", file=sys.stderr)
        continue
    with path.open(newline="", encoding="utf-8") as f:
        reader = csv.reader(f)
        header = next(reader)
        # Header: BASE, TYPE, NAME, 1, 2, ..., 13, ItemClass
        tier_cols = [(i, int(h)) for i, h in enumerate(header) if h.isdigit()]
        ic_idx = header.index("ItemClass") if "ItemClass" in header else None
        for row in reader:
            if len(row) < 4 or not row[0]:
                continue
            key = (row[0], row[1], row[2])
            rec = records.get(key)
            if rec is None:
                rec = {
                    "base": row[0],
                    "type": row[1],
                    "name": row[2],
                    "itemClass": row[ic_idx] if ic_idx is not None and ic_idx < len(row) else None,
                    "tiers": {},
                }
                records[key] = rec
                order.append(key)
            for col_idx, tier in tier_cols:
                if col_idx >= len(row):
                    continue
                value = cast(row[col_idx], kind)
                if value is None:
                    continue
                slot = rec["tiers"].setdefault(tier, {"tier": tier})
                slot[attr] = value

# Materialise tier dicts as sorted arrays (T1 first = best).
out = []
for key in order:
    rec = records[key]
    rec["tiers"] = [rec["tiers"][t] for t in sorted(rec["tiers"])]
    out.append(rec)

out_path.parent.mkdir(parents=True, exist_ok=True)
with out_path.open("w", encoding="utf-8") as f:
    json.dump(out, f, ensure_ascii=False, indent=2)

print(f"  wrote {len(out)} mod records, "
      f"{sum(len(r['tiers']) for r in out)} tiers total -> {out_path.name}")

# --- Per-base partition --------------------------------------------------
# Filename slug matches the convention shared with update-poe2-tags.sh so
# both scripts produce consistent <slug>.*.json files.
def slugify(base):
    head, _, paren = base.partition("(")
    name = head.strip().lower().replace(" ", "_")
    spec = paren.rstrip(")").strip().lower().replace("/", "").replace(" ", "") if paren else ""
    return name + ("_" + spec if spec else "")

by_base_dir = out_path.parent / "by-base"
by_base_dir.mkdir(parents=True, exist_ok=True)

per_base = {}
for rec in out:
    per_base.setdefault(rec["base"], []).append(rec)

manifest = {}
for base, recs in per_base.items():
    slug = slugify(base)
    if slug in manifest.values():
        # collision guard — should not happen with current bases but loud-fail
        # so we notice if the sheet adds something unexpected.
        raise SystemExit(f"slug collision on '{slug}' for base '{base}'")
    manifest[base] = slug
    with (by_base_dir / f"{slug}.mods.json").open("w", encoding="utf-8") as f:
        json.dump(recs, f, ensure_ascii=False, indent=2)

# Manifest is the source of truth for "which bases exist". Other build
# scripts (update-poe2-tags.sh) read it back to align their per-base
# emissions with the same slugs.
manifest_path = by_base_dir / "index.json"
with manifest_path.open("w", encoding="utf-8") as f:
    json.dump(dict(sorted(manifest.items())), f, ensure_ascii=False, indent=2)
print(f"  wrote {len(manifest)} per-base files -> {by_base_dir.name}/")
PY

echo "Done."
