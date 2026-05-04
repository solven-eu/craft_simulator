# Raw upstream data

Local copies of upstream datasets used to populate `games/poe2/`. Not consumed
directly by the runtime — we transform them into JSON modules under
`games/poe2/data/`.

## Krakenbul — WEIGHTS + ILVLS 0.4 (PoE2)

Source: Google Sheet
`https://docs.google.com/spreadsheets/d/1QSAu0A-ZKcHFlQ5QCcUJSMb0ebXq1nxpGRUVgHXVjW8`

Compiled by Krakenbul (Prohibited Library Discord) from PoE2 recombinator data
plus trade-site parsing for non-recombinable bases. Re-downloadable via:

```
curl -L -o krakenbul_weights.xlsx \
  "https://docs.google.com/spreadsheets/d/1QSAu0A-ZKcHFlQ5QCcUJSMb0ebXq1nxpGRUVgHXVjW8/export?format=xlsx"
```

Per-tab CSVs (export?format=csv&gid=…):

| File | Tab | gid | Meaning |
|---|---|---|---|
| `krakenbul_weights.csv`   | WEIGHTS   | 1418797281 | Spawn weight per (base, mod, tier) |
| `krakenbul_ilvls.csv`     | ILVLS     |  492566948 | Item-level required to roll the tier |
| `krakenbul_spawnlvls.csv` | SPAWNLVLS | 1652888001 | Spawn level (≈ ilvl in most rows) |
| `krakenbul_names.csv`     | NAMES     |  380825024 | Affix name shown on item per tier |
| `krakenbul_ids.csv`       | IDS       | 1257586048 | Internal mod id per tier |

All five tabs share schema: `BASE, TYPE, NAME, 1..13, ItemClass`
where columns `1..13` are the tier slots (T1 = highest tier).
1,160 rows; covers boots, body armour, helmets, gloves, weapons, jewels,
charms, tablets, waystones, etc.
