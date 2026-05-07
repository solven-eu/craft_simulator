// MDP-ε regression: three essence-able wished prefixes.
//
// User-reported scenario: a Body Armour with 3 required prefixes,
// each essence-able. Concrete craft state (copied from a live URL):
//
//   itemType:  Body Armour
//   base:      BODY ARMOUR (STR)
//   ilvl:      72
//   target:
//     PREFIX  # to # Physical Thorns damage          (req T2)
//     PREFIX  #% increased Armour, Evasion or
//             Energy Shield                          (req T1)
//     PREFIX  +# to maximum Life                     (req T1)
//   minFilled: 3, maxFilled: 6, requiredHits: 3
//   budget:    34_226 ex
//
// Symptom: solver reports V* = ∞ (no path to goal).
//
// Root cause (verified against data/poe2/mods.json):
//   * Wished mod 1 ("# to # Physical Thorns damage") IS in the base
//     pool with weight 1000 across tiers — orbs can reach it.
//   * Wished mods 2 & 3 are NOT in the base pool at all under their
//     wishlist-key names. The user added them via "+ wish" from the
//     essence panel, which stores the essence-text spelling
//     (`+# to maximum Life`, the disjunctive `#% increased Armour,
//     Evasion or Energy Shield`). The base pool stores neither of
//     those exact names.
//   * Essences match by text, but the engine's tier-acceptance check
//     fails for the Lesser-only essences when requiredTier = 1
//     (Lesser typically lands at the lower affix tiers).
//
// Net effect: no orb action ever sets bits 2 or 3 in the wished mask,
// so V* = ∞.
//
// The tests below pin three expected behaviours:
//   (a) When wishlist keys ARE in the base pool, the engine finds a
//       finite V*. Sanity baseline that passes today.
//   (b) When a wishlist mod is essence-only (not in base pool) but a
//       matching essence with pAcceptable = 1 is provided, V* must
//       remain finite — the essence path alone should suffice.
//   (c) The user's exact scenario should not be classified as
//       impossible, given a complete essence-action set covering
//       every essence-only wished mod.

import { strict as assert } from 'node:assert';
import { solveMDP } from '../engine/mdp/solve.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.message}`); }
}

console.log('MDP-ε tests — three essence-able prefixes');

// Three wished prefixes, all essence-able. Required item shape:
// every wished mod present (3 prefixes filled, suffix side free).
const baseInput = {
  wishlist: [
    { key: 'PREFIX:# to maximum Life',          weight: 1000, type: 'PREFIX', requiredTier: 2 },
    { key: 'PREFIX:# to Strength',              weight:  900, type: 'PREFIX', requiredTier: 2 },
    { key: 'PREFIX:#% increased Armour',        weight:  800, type: 'PREFIX', requiredTier: 2 },
  ],
  irrelevantWeight: 50000,
  irrelevantWeightBySide: { PREFIX: 25000, SUFFIX: 25000 },
  target: {
    requiredMods: [
      'PREFIX:# to maximum Life',
      'PREFIX:# to Strength',
      'PREFIX:#% increased Armour',
    ],
    minFilled: 3,
    maxFilled: 6,
  },
  start: { rarity: 'normal' },
  basePriceEx: 100,
  alchemyDraws: 4,
  maxFilled: 6,
  timeWeightExPerSec: 0,
  budgetEx: 100_000, // generous so essence runs aren't budget-pruned
  orbCosts:  { transmute: 0.01, augment: 0.05, regal: 0.5, alch: 1, exalt: 1, annul: 0.5, fracturing: 50 },
  orbTimes:  { transmute: 1,    augment: 1,    regal: 1,   alch: 1, exalt: 1, annul: 1,   fracturing: 3 },
  essences: [
    { id: 'essence_body_greater',     name: 'Greater Essence of the Body',     costEx: 17, timeSec: 3, matchedKeys: ['PREFIX:# to maximum Life'],   pAcceptable: 1 },
    { id: 'essence_strength_greater', name: 'Greater Essence of the Infinite', costEx: 20, timeSec: 3, matchedKeys: ['PREFIX:# to Strength'],         pAcceptable: 1 },
    { id: 'essence_armour_greater',   name: 'Greater Essence of Enhancement',  costEx: 25, timeSec: 3, matchedKeys: ['PREFIX:#% increased Armour'],   pAcceptable: 1 },
  ],
};

test('three essence-able prefixes ⇒ solver returns FINITE V*', () => {
  const result = solveMDP(baseInput);
  assert.ok(
    Number.isFinite(result.vStar),
    `expected V*(start) finite for a 3-essence-able-prefix wishlist; ` +
    `got V*=${result.vStar}. The user-reported regression: solver claims ` +
    `the craft is impossible even though essence-spam + exalt-fill should ` +
    `reach all three prefixes from a fresh Normal base.`,
  );
});

test('three essence-able prefixes ⇒ at least one essence appears in the policy', () => {
  // A solvable scenario should make use of at least one matching
  // essence — they're the cheapest deterministic way to land any one
  // of the three wished prefixes.
  const result = solveMDP(baseInput);
  const policies = new Set([...result.policy.values()].filter(Boolean));
  const usedEssence = ['essence_body_greater', 'essence_strength_greater', 'essence_armour_greater']
    .some((id) => policies.has(id));
  assert.ok(
    usedEssence,
    `expected at least one matching essence in the optimal policy; ` +
    `got policies: ${[...policies].join(', ')}. If no essence is used, ` +
    `essence-spam isn't being considered as a strategy and the MDP is ` +
    `under-modelling the action set.`,
  );
});

// (b) Realistic mixed scenario, mirroring the user's live craft:
// one wished mod is essence-only (zero pool weight, matching essence
// covers it), two are in-pool. Engine should find: apply the essence
// once, then exalt-fill the remaining two wished slots — V* must be
// finite. This is the regression that the mod-id canonicalisation
// (Phase 1) was meant to unblock.
test('one essence-only + two in-pool wished mods ⇒ V* remains finite', () => {
  const result = solveMDP({
    ...baseInput,
    wishlist: [
      // bit 0: essence-only — no orb can roll it, only the essence below.
      { key: 'PREFIX:#% increased Armour, Evasion or Energy Shield', weight: 0,    type: 'PREFIX', requiredTier: 1 },
      // bits 1, 2: in-pool, exalt-fill can advance them.
      { key: 'PREFIX:# to maximum Life',                              weight: 1000, type: 'PREFIX', requiredTier: 2 },
      { key: 'PREFIX:# to # Physical Thorns damage',                  weight: 1000, type: 'PREFIX', requiredTier: 2 },
    ],
    target: {
      requiredMods: [
        'PREFIX:#% increased Armour, Evasion or Energy Shield',
        'PREFIX:# to maximum Life',
        'PREFIX:# to # Physical Thorns damage',
      ],
      minFilled: 3,
      maxFilled: 6,
    },
    essences: [
      { id: 'ess_aes',  name: 'Lesser Essence of Enhancement', costEx: 5,  timeSec: 3, matchedKeys: ['PREFIX:#% increased Armour, Evasion or Energy Shield'], pAcceptable: 1 },
      // Optional in-pool essences for the other two; the engine may
      // or may not pick them.
      { id: 'ess_life', name: 'Greater Essence of the Body',    costEx: 17, timeSec: 3, matchedKeys: ['PREFIX:# to maximum Life'],     pAcceptable: 1 },
    ],
  });
  assert.ok(
    Number.isFinite(result.vStar),
    `expected finite V* for the user's real craft (1 essence-only + ` +
    `2 in-pool wished mods); got V*=${result.vStar}. If V*=∞, the ` +
    `engine still treats the essence-only mod as unreachable.`,
  );
});

if (failed > 0) process.exit(1);
console.log(`\n${passed} passed, ${failed} failed`);
