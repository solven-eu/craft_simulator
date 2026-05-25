# MDP action coverage

What the engine currently models, what it doesn't, and where the
boundaries are. Kept in sync with `engine/mdp/actions.js` via the
test `tests/actions-coverage-doc.test.js` — every key under
`ACTIONS = { ... }` in actions.js MUST appear in the **Covered**
section below, and vice versa.

If a planned action is intentionally not covered yet, list it under
**Not covered (deliberate)** so future readers see the boundary,
not just the gap.

---

## Covered (`engine/mdp/actions.js`)

Each entry below has a corresponding key in `ACTIONS`. The test
parses both files and fails if the lists drift.

### Item-rarity transitions

- `transmute` — Orb of Transmutation. Normal+0 → Magic with 1–2 mods.
- `transmute_greater` — Greater Orb of Transmutation. Same shape, tier-biased.
- `transmute_perfect` — Perfect Orb of Transmutation. Same shape, top-tier-biased.
- `augment` — Orb of Augmentation. Magic+1 → Magic+2.
- `augment_greater` — Greater Orb of Augmentation.
- `augment_perfect` — Perfect Orb of Augmentation.
- `regal` — Regal Orb. Magic → Rare with +1 mod.
- `regal_greater` — Greater Regal Orb.
- `regal_perfect` — Perfect Regal Orb.
- `alch` — Orb of Alchemy. Normal/Magic → Rare with 4 mods (re-roll, not additive).
- `exalt` — Exalted Orb. Rare with <6 mods → adds 1 mod.
- `exalt_greater` — Greater Exalted Orb.
- `exalt_perfect` — Perfect Exalted Orb.
- `chaos` — Chaos Orb. Rare: remove a random mod, add a random mod.
- `chaos_greater` — Greater Chaos Orb.
- `chaos_perfect` — Perfect Chaos Orb.
- `annul` — Orb of Annulment. Removes one random non-fractured mod.
- `fracturing` — Fracturing Orb. Locks one random mod (≥4 mods required).
- `buy_base` — Discard current item, buy a fresh Normal base.

### Desecration (Bones)

- `apply_bone` — Apply a Bone-class currency. Adds a hidden bone-phantom slot.
  The cheapest applicable bone for the item class is selected by
  `engine/mdp/adapter.js`.
- `apply_bone_sinistral` — Apply Bone + Omen of Sinistral Necromancy.
  Pins the bone-phantom to the prefix side; reveal then uses the
  prefix-only hit pool.
- `apply_bone_dextral` — Apply Bone + Omen of Dextral Necromancy.
  Pins the bone-phantom to the suffix side; reveal then uses the
  suffix-only hit pool.
- `reveal_bone` — Resolve the bone-phantom into a real desecrated affix
  (best-of-3 picks).
- `reveal_bone_abyssal` — Reveal under Omen of Abyssal Echoes
  (effectively best-of-6 picks via a re-roll).

### Omen-augmented variants

These are full MDP actions wrapping the base orb with the omen's
side filter. The action cost includes the omen price.

- `regal_sinistral` — Regal Orb + Omen of Sinistral Coronation (force prefix).
- `regal_dextral` — Regal Orb + Omen of Dextral Coronation (force suffix).
- `exalt_double` — Exalted Orb + Omen of Greater Exaltation (adds 2 mods in one cast).
- `exalt_greater_double` — Greater Exalted Orb + Omen of Greater Exaltation.
- `exalt_perfect_double` — Perfect Exalted Orb + Omen of Greater Exaltation.
- `annul_omen_of_light` — Orb of Annulment + Omen of Light. Targets a
  desecrated affix specifically; used to scrub a bad bone-revealed mod.

### Dynamic essence actions

Essence actions are not pre-defined keys in `ACTIONS`. They're
injected per-craft by `engine/mdp/adapter.js` into `solveMDP`'s
`input.essences`, then materialised by
`engine/mdp/actions.js → makeEssenceAction` inside `solveMDP`. Each
essence in the catalog (`data/poe2/essences.csv`) becomes its own
action when its `matched_mods` overlap the wishlist and its
`item_classes` covers the current base.

This includes Lesser / Normal / Greater / Perfect tiers of every
essence family (Insulation, Thawing, Sorcery, etc.) plus the
side-perfect overwrite mechanic.

---

## Not covered (deliberate)

Crafting actions and omens that exist in PoE2 but are not currently
modelled by the MDP. Listed so the gap is visible — not a TODO list.

### Vaal corruption

- **Vaal Orb** — present in `games/poe2/orbs.js:35` as catalog
  metadata only; no MDP action. Corruption is irreversible and
  produces a wide outcome distribution (add mod, remove mod, brick
  to corrupted-rare, transform to unique). Modelling it would
  require a `corrupted` rarity dimension on state and a fan-out of
  outcomes that the current state-space doesn't carry.
- **Omen of Corruption** — modifies Vaal outcomes. Not modelled
  because Vaal itself isn't.

### Whittling

- **Omen of Whittling** — removes the lowest-tier non-fractured mod.
  Referenced as a strategy concept in `engine/state.js:8` (a
  hypothetical state extension tracking the lowest-tier irrelevant
  per side) but no MDP action exists. Adding it requires per-side
  lowest-tier flags on the state.

### Side-controlled exalt / annul

- **Omen of Sinistral Exaltation** — exalt forced into an open
  prefix slot.
- **Omen of Dextral Exaltation** — exalt forced into an open suffix
  slot.
- **Omen of Sinistral Annulment** — annul removes a prefix only.
- **Omen of Dextral Annulment** — annul removes a suffix only.

These would be straightforward to add — they mirror the
Sinistral/Dextral Coronation pattern already wired for Regal — but
they aren't currently in the action set, so the engine cannot
recommend "annul a prefix" as a distinct strategy from plain annul.

### Tier-biased exalt

- **Omen of Greater Exaltation** — exalt that biases toward higher
  tiers.
- **Omen of Catalysing Exaltation** — exalt that adds a catalyst
  effect alongside the new mod.

The Greater/Perfect Exalt orbs already cover "tier-biased exalt"
through their qBoost; the omen variants would add finer
granularity but produce the same family of outcomes.

### Sinistral / Dextral Erasure

- **Omen of Sinistral Erasure** — under investigation. Not yet
  classified; not modelled.
- **Omen of Dextral Erasure** — same.

### Recombination (handled outside MDP)

- **Omen of Recombination** + **Recombinator** — closed-form
  strategy in `engine/strategies/recombinator.js` (not part of the
  MDP). Recombination merges two items, which fundamentally breaks
  the single-item assumption of the MDP state.

### League / map mechanics (out of scope)

These omens affect map drops, monster mods, or league mechanics
rather than item crafting; they will not be added to the MDP.

- Omen of the Ancients, Blessed, Hunt
- Omen of Refreshment, Resurgence, Reinforcements
- Omen of Chaotic Monsters / Quantity / Rarity
- Omen of Bartering, Gambling, Chance, Amelioration
- Omen of Answered Prayers, Sanctification, Secret Compartments
- Petition Splinter

---

## Bidirectional link

The test at `tests/actions-coverage-doc.test.js` enforces:

1. Every key in `engine/mdp/actions.js → ACTIONS` appears as a
   bullet in the **Covered** section above.
2. Every bullet in the **Covered** section corresponds to a key in
   `ACTIONS`.

Adding a new MDP action without updating this doc fails the test.
Removing a doc bullet without removing the action fails the test.
Renaming an action requires both files to change in lockstep.

The **Not covered** section is informative only — it's not test-
enforced, since the omen catalog evolves upstream.
