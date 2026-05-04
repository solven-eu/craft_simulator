# Sources

Reference URLs the user has shared as authoritative inputs for game data
(orbs, effects, weights, ilvl gating, omen rules, etc.). Curated — only
the best source per topic should be kept; supersede rather than append
when a better one arrives.

## Processing workflow

To re-validate the engine against the latest game state, walk this list
top-to-bottom. Each URL has either an associated scraper (re-run it) or
explicit "feeds X" notes pointing at the destination file/module:

| URL | Feeds | Re-run command |
|---|---|---|
| poe2db `/us/Crafting` | Omen × orb interaction rules → `data/poe2/omens.csv`, `engine/mdp/actions.js` (Sinistral / Dextral / Greater variants) | manual review (no scraper) |
| poe2db `/us/<Greater\|Perfect>_<Orb>` (8 pages) | Per-orb `Minimum Modifier Level` → `engine/mdp/adapter.js:orbMinLevel` | manual fetch + paste |
| poe2db `/us/Modifiers#Acronym` | Currency wording + icons → `data/poe2/item_descriptions.csv` | `scripts/update-poe2-item-descriptions.sh` |
| poe2db `/us/<base>#ModifiersCalc` | Per-affix tags → `data/poe2/mod_tags.json` | `scripts/update-poe2-tags.sh` |
| poe2db `/us/Desecrated_Modifiers#AbyssalifyRef` | Desecration consumables → `data/poe2/desecrated.csv` | `scripts/update-poe2-desecrated.sh` |
| poe2db `/us/Essence` | Essence catalog → `data/poe2/essences.csv` | `scripts/update-poe2-essences.sh` |
| poe2db `/us/Economy_*` | Currency / omen / essence / catalyst rates → `data/poe2/rates.csv` | `scripts/update-poe2-rates.sh` |
| Krakenbul Sheet (`/spreadsheets/d/1QSAu0A-…/edit`) | Mod weights / ilvls / spawn levels → `data/poe2/mods.json` (via `update-poe2-data.sh`) | `scripts/update-poe2-data.sh` |
| poe.ninja `/poe2/economy/vaal/<category>` | Cloudflare-protected snapshots → `data/poe2/rates/<category>.csv` | `scripts/fetch-poe-ninja-rates.mjs` (manual CF solve) |

**Adding a URL**: add it here under the right game heading AND in the
table above (or "no scraper — manual review" if it's a doc-style ref).
This file is the single source of truth: any URL the engine relies on
should appear here, so a future "process every URL again" sweep stays
mechanical.

## Path of Exile 2

- [Mobalytics — PoE 2 Currency Guide](https://mobalytics.gg/poe-2/guides/currency-guide) — overview of orb categories (transmutation, augmentation, alchemy, regal, chaos, vaal, exalted, divine, annulment, chance, mirror, jeweller's, quality currencies) with mechanical descriptions and rarity classifications. Lacks drop rates, ilvl restrictions, and weighted outcome data — will need to be supplemented for the evaluator. (added 2026-04-29)
- [poe2db — Desecrated Modifiers (Abyssalify Ref)](https://poe2db.tw/us/Desecrated_Modifiers#AbyssalifyRef) — desecration consumables (Bones, Skulls, …) with item-class restriction and ilvl bounds (`Maximum Item Level`, `Minimum Modifier Level`). Cached via `scripts/update-poe2-desecrated.sh` into `data/poe2/desecrated.csv`. (added 2026-04-30)
- [poe.ninja — PoE2 economy (Vaal league)](https://poe.ninja/poe2/economy/vaal/) — broader economy data behind the same Cloudflare gate. Scraped via `npm run rates` (`scripts/fetch-poe-ninja-rates.mjs`, Playwright Chromium with manual CF solve). Outputs per-category CSVs at `data/poe2/rates/<category>.csv`. Currently covers `currency`, `abyssal-bones`, `breach-catalyst`, `essence`, `omen`. (added 2026-04-30)
- [poe.ninja — PoE2 Abyssal Bones economy](https://poe.ninja/poe2/economy/vaal/abyssal-bones) — current market prices for desecration consumables. Cloudflare-protected; user supplies via screenshot. Local snapshot: `data/poe2/desecrated_prices.csv`. **Note** the inverse-rate convention: when poe.ninja shows `1.0 ex ↔ N item`, the per-unit price is `1/N` ex (sub-Exalted items). (added 2026-04-30)
- [poe2db — Modifiers (Acronym tab)](https://poe2db.tw/us/Modifiers#Acronym) — canonical wording + icon URLs for every PoE2 currency orb and omen. Snapshot via `scripts/update-poe2-item-descriptions.sh` into `data/poe2/item_descriptions.csv`. Wording drift between refreshes (e.g. *Orb of Alchemy* gaining `or Magic` in 0.3.1) signals mechanic changes — `git diff` the CSV after each run. (added 2026-04-30)
- [poe2db — per-base modifier tables (e.g. /us/Gloves_dex)](https://poe2db.tw/us/Gloves_dex#ModifiersCalc) — canonical source for per-affix **category tags** (damage / elemental / fire / cold / attribute / life / mana / …). Each mod row carries `data-tag="…"` attributes (multiple tags per row). Scraped via `scripts/update-poe2-tags.sh` into `data/poe2/mod_tags.json`. (added 2026-04-29)
- [poe.ninja — PoE2 Breach Catalysts](https://poe.ninja/poe2/economy/vaal/breach-catalyst) — catalyst price snapshots. Catalysts deterministically boost all affixes of a given category, so concentration matters for scoring. **Cloudflare-protected** — same drill as orb rates: user captures a screenshot, we seed `games/poe2/catalysts.js` from it. (added 2026-04-29)
- [poe2db — Weightings](https://poe2db.tw/weightings) — per-base mod spawn-weight tables (renders the upstream Krakenbul spreadsheet plus trade-site parsing for non-recombinable bases: Charms, Jewels, Tablets, Waystones). No direct download — data is read off the page. Useful for encoding `Action.outcomes()` weights. (added 2026-04-29)
- [poe.ninja — PoE2 Vaal Currency](https://poe.ninja/poe2/economy/vaal/currency) — **canonical source** for orb-to-orb conversion rates (Exalted ↔ Divine ↔ Chaos ↔ all other orbs). **Cloudflare-protected — cannot be fetched programmatically.** User supplies rates manually (screenshot or copy-paste); we seed them in `games/poe2/currency.js` and let the user override at runtime. (added 2026-04-29)
- [Krakenbul — WEIGHTS + ILVLS 0.4 (Google Sheet)](https://docs.google.com/spreadsheets/d/1QSAu0A-ZKcHFlQ5QCcUJSMb0ebXq1nxpGRUVgHXVjW8/edit) — **canonical source** for PoE2 mod spawn weights, ilvl gating, spawn levels, mod names, and internal ids. 5 tabs (WEIGHTS, ILVLS, SPAWNLVLS, NAMES, IDS), 1,160 rows. Schema: `BASE, TYPE, NAME, T1..T13, ItemClass`. Publicly exportable as XLSX/CSV via the `/export` endpoint — no auth needed. Local cache: `data/raw/krakenbul_*.csv`. (added 2026-04-29)
- [Prohibited Library Discord](https://discord.gg/3VxKY6gt7j) — community hub where Krakenbul publishes the spreadsheet above. Use only if the sheet link rotates or for context/discussion. Pointer to original announcement: https://discord.com/channels/991073626721763429/991093492136689684/1451931609157734671 (auth required). (added 2026-04-29)
- Discord-attached JSON dump: https://discord.com/channels/991073626721763429/991093492136689684/1451964878544830465 (auth required). User-supplied as `data/raw/manual/poe2_mods_0.4.json`. **Verified equivalent to** the Krakenbul Google Sheet (same 7,747 tier rows, all fields match) — keep as a cross-check / fallback if the Sheet rotates, not as a primary source. Shape: nested `{ Base: { Type: { Name: { Tier: rec } } } }` with stringified numbers. (added 2026-04-29)

- [poe2db — Essences](https://poe2db.tw/us/Essence) — full PoE2 essence catalog. Enriched via `scripts/update-poe2-essences.sh` (cross-references against `mods.json` to derive `side` and `item_classes`). Cached locally as `data/poe2/essences.csv` — 81 essences, 48 with side resolved, 33 still UNKNOWN (typically multi-context weapon affixes). (updated 2026-04-29)
- [Mobalytics — PoE2 Omen Crafting](https://mobalytics.gg/poe-2/guides/omen-crafting) — canonical omen catalog. 27 omens cached locally as `data/poe2/omens.csv` with an `available` column. Some omens are deprecated; e.g. *Omen of Homogenising Exaltation* (https://poe2db.tw/Omen_of_Homogenising_Exaltation) was removed and ships with `available=false`. Users can toggle availability at runtime to model what-if scenarios. (updated 2026-04-29)
- [poe2db — Crafting (overview)](https://poe2db.tw/us/Crafting) — **canonical source for omen × orb interaction rules**: which orbs each omen affects and how (Sinistral/Dextral side-only, Greater/Homogenising effect modifiers). Also the source for Coronation, Alchemy, and Greater Annulment omen entries added to `data/poe2/omens.csv`. Manual review (no scraper) — re-read after every PoE2 patch and reflect changes in `engine/mdp/actions.js` (omen-augmented action variants) and `data/poe2/omens.csv`. (added 2026-05-03)
- **Reddit — Butsicles, "POE 2, Patch 0.2.0 Guide to Recombinators, Part 1"** ([URL](https://www.reddit.com/r/PathOfExile2/comments/1jzu2py/poe_2_patch_020_guide_to_recombinators_part_1/)) — canonical source for the recombinator formula. Reddit can't be fetched directly by `WebFetch` (host blocked); user pastes the post body into the chat for re-validation. Key formulas encoded in `engine/strategies.js:recombinator`:
  - Two-mod EI combine: `RS = SC(mod_A) + SC(mod_B)`, each `SC` capped at 50% so `RS ≤ 100%`.
  - `SC(mod) = min(50, A_scale · Σ weight(t) / total_pool_weight)` where the sum is over tiers `t ≤ chosen_tier ≤ ilvl_max`.
  - Per-base scaling constant `A_scale` ≈ 500,000 for body armours, ~800,000 for spears (varies). Default 500K until per-base tuning lands.
  - Non-EI items: each mod uses the *opposite* item's ilvl for SC; non-native/illegal mods give `SC = 0`.
  - Base-pick conjecture: `P(left base | success) ≈ SC(right) / RS`. Implication: low-weight (rare) mods rarely transfer to a clean base.
  - Fractured affixes: not selectable, but carry FREE if their base wins. `P(fracture wins) ≈ SC(other-base mod) / RS`. Conjecture: weight choice on the fractured base is irrelevant for fracture carry-over (the two effects cancel).
  - Cost: 2 source items + 1 Expedition Artifact per attempt. Artifact-to-exalted conversion is user-supplied (artifacts aren't directly tradable). (added 2026-05-04)
- **Greater / Perfect orb pages** (8 distinct URLs) — canonical source for each variant's `Minimum Modifier Level` field, used by `engine/mdp/adapter.js:orbMinLevel` to compute `pTierAcceptable[orb][mod]`. These are the **measured game-rule values** that replaced earlier scalar `qBoost` guesses. Re-fetch on patch via `curl https://poe2db.tw/us/<Orb_Name>` and grep for `Minimum Modifier Level`. URLs:
  - https://poe2db.tw/us/Greater_Orb_of_Transmutation (minLevel 55)
  - https://poe2db.tw/us/Perfect_Orb_of_Transmutation (minLevel 70)
  - https://poe2db.tw/us/Greater_Orb_of_Augmentation (minLevel 55)
  - https://poe2db.tw/us/Perfect_Orb_of_Augmentation (minLevel 70)
  - https://poe2db.tw/us/Greater_Regal_Orb (minLevel 35)
  - https://poe2db.tw/us/Perfect_Regal_Orb (minLevel 50)
  - https://poe2db.tw/us/Greater_Exalted_Orb (minLevel 35)
  - https://poe2db.tw/us/Perfect_Exalted_Orb (minLevel 50)
  Captured 2026-05-03; verify if patch notes mention orb mechanic changes.

### To collect

- **Essence prices (full)** — partial seed in `data/poe2/essence_prices.csv` from screenshot 2026-04-29 (~21 essences); the remaining 60 use a placeholder of 7 chaos ≈ 44.1 ex. Refresh by capturing the full poe.ninja essences page when needed. (updated 2026-04-29)
- **Essence affix `side` for the remaining 33** — typically multi-context weapon essences (one-handed vs two-handed differ). Resolve by either splitting the mods.json match (currently exact/normalised name only) or scraping per-essence detail pages on poe2db for explicit prefix/suffix labels. (updated 2026-04-29)
- **Omen prices** — poe.ninja snapshot for omens not yet captured; assume ~10 ex placeholder. (added 2026-04-29)

## Path of Exile 1

_(none yet)_

## Diablo 4

_(none yet)_

## Strategy guides

- [r/PathOfExile2 — Beginner Crafting Guide for PoE2](https://www.reddit.com/r/PathOfExile2/comments/1kbdnzv/beginner_crafting_guide_for_path_of_exile_2/) — community guide describing high-level PoE2 craft patterns (fracture-anchor + reset-via-annul, alch-spam, chaos-spam, exalt-fill). Used as the source list for strategies modeled in `engine/strategies.js`. (added 2026-04-29)

## Reference tools (do NOT emulate)

The two leading existing crafting tools, kept here as reference UX / feature
inventory. **Do not copy their evaluator approach** — both rely on Monte Carlo
random simulation, which is precisely what this project differentiates against
(see `feedback_analytical_not_simulation` memory).

- [Craft of Exile (PoE2)](https://www.craftofexile.com/?game=poe2&cl=fr) — full mod planner, orb actions, fossils/essences/harvest. UX reference for the cascade flow. Evaluator: random simulation. (added 2026-04-29)
- [Path of Crafting — Interactive](https://pathofcrafting.net/craft/interactive) — alternative interactive crafter. Evaluator: random simulation. (added 2026-04-29)

## General / cross-game

_(none yet)_
