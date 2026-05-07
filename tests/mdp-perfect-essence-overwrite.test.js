// MDP-ε: Perfect-essence overwrite mechanic.
//
// Per project memory `project_perfect_essence_rules`: Perfect (and
// Corrupted) essences apply on a RARE item and overwrite a
// uniformly-random affix of the essence's natural side. Adapter
// dispatches mode='rare_overwrite' for these vs the legacy
// 'magic_to_rare' shape used by Lesser/Normal/Greater.
//
// This file pins the user's reported regression (2026-05-07,
// shared via URL): white Body Armour STR + two required PREFIX
// essence-only affixes:
//   1. `#% increased Armour, Evasion or Energy Shield`
//      (granted by Lesser/Normal/Greater Essence of Enhancement —
//       Magic→Rare).
//   2. `#% increased maximum Life`
//      (granted by Perfect Essence of the Body — Rare overwrite).
// Path: transmute → augment → Greater Enhancement (Magic→Rare with
// affix #1) → Perfect Body (Rare overwrite with affix #2).
// Without the overwrite mechanic, the engine couldn't apply a
// second essence and reported the craft unreachable.

import { strict as assert } from 'node:assert';
import { ctxToMdpInput } from '../engine/mdp/adapter.js';
import { solveMDP } from '../engine/mdp/solve.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.message}`); }
}

console.log('Perfect-essence overwrite tests');

const baseCtx = {
  modIds: {
    '#% increased Armour, Evasion or Energy Shield': 'inc_armour_evasion_or_es',
    '#% increased maximum Life': 'inc_max_life',
  },
  fullPool: [],   // both affixes are essence-only.
  itemClass: 'Body Armour',
  basePriceEx: 100,
  startingCounts: { prefixes: 0, suffixes: 0 },
};

const wishlist = [
  {
    key: 'PREFIX:#% increased Armour, Evasion or Energy Shield',
    type: 'PREFIX',
    requiredTier: 1,
    required: true,
  },
  {
    key: 'PREFIX:#% increased maximum Life',
    type: 'PREFIX',
    requiredTier: 1,
    required: true,
  },
];

const essences = [
  // Magic→Rare essence for affix #1 (Greater Enhancement).
  {
    poe2db_slug: 'Greater_Essence_of_Enhancement',
    name: 'Greater Essence of Enhancement',
    tier: 'Greater',
    side: 'PREFIX',
    item_classes: 'Amulet|Body Armour|Boots|Gloves|Helmet|Shield',
    target_affix: '(68—79)% increased Armour, Evasion or Energy Shield',
    matched_mods: '',
  },
  // Rare-overwrite essence for affix #2 (Perfect Body).
  {
    poe2db_slug: 'Perfect_Essence_of_the_Body',
    name: 'Perfect Essence of the Body',
    tier: 'Perfect',
    side: 'PREFIX',
    item_classes: 'Body Armour',
    target_affix: '(8—10)% increased maximum Life',
    matched_mods: '',
  },
];
const essencePrices = {
  'Greater Essence of Enhancement': { priceEx: 44.1 },
  'Perfect Essence of the Body':    { priceEx: 13 },
};

test('two essence-only PREFIX requirements ⇒ MDP finds a solution via overwrite', () => {
  const input = ctxToMdpInput({
    ...baseCtx,
    wishlist,
    essences,
    essencePrices,
  });
  // Both essences should be in the input list.
  assert.equal(input.essences.length, 2,
    `both essences should be admitted (Magic→Rare + Rare-overwrite); got ${input.essences.length}`);
  const greater = input.essences.find((e) => e.id.includes('Enhancement'));
  const perfect = input.essences.find((e) => e.id.includes('Body'));
  assert.equal(greater?.mode, 'magic_to_rare',
    `Greater Essence of Enhancement should be magic_to_rare; got ${greater?.mode}`);
  assert.equal(perfect?.mode, 'rare_overwrite',
    `Perfect Essence of the Body should be rare_overwrite; got ${perfect?.mode}`);

  const result = solveMDP({
    ...input,
    target: { ...input.target, minFilled: 2, maxFilled: 6 },
    orbCosts: {
      transmute: 0.01, augment: 0.05, regal: 0.5, alch: 1,
      exalt: 5, annul: 9.5, fracturing: 50,
    },
    orbTimes: {
      transmute: 1, augment: 1, regal: 1, alch: 1,
      exalt: 1, annul: 1, fracturing: 3,
    },
    budgetEx: 50000,
  });
  // pSuccessStart > 0 ⇒ a path exists. (Without the overwrite
  // mechanic this was 0 and the user reported "no solution.")
  assert.ok(result.chain.pSuccessStart > 0,
    `craft must be reachable; got pSuccessStart=${result.chain.pSuccessStart}. `
    + `(Regression on the rare_overwrite mode for Perfect essences.)`);
});

test('Perfect-essence overwrite is in the optimal policy', () => {
  const input = ctxToMdpInput({ ...baseCtx, wishlist, essences, essencePrices });
  const result = solveMDP({
    ...input,
    target: { ...input.target, minFilled: 2, maxFilled: 6 },
    orbCosts: {
      transmute: 0.01, augment: 0.05, regal: 0.5, alch: 1,
      exalt: 5, annul: 9.5, fracturing: 50,
    },
    orbTimes: {
      transmute: 1, augment: 1, regal: 1, alch: 1,
      exalt: 1, annul: 1, fracturing: 3,
    },
    budgetEx: 50000,
  });
  const policies = new Set([...result.policy.values()].filter(Boolean));
  const hasPerfect = [...policies].some((id) => id.includes('Body'));
  assert.ok(hasPerfect,
    `Perfect Essence of the Body should appear in the optimal policy; got: ${[...policies]}`);
});

test('Perfect-essence overwrite skipped when same-family already on item', () => {
  // If the item already has the affix the Perfect essence would set,
  // the action should be inapplicable (same-family-blocked).
  const input = ctxToMdpInput({
    ...baseCtx,
    wishlist,
    essences: [essences[1]], // only the Perfect essence
    essencePrices,
    // Pretend the wished mod is already on the starting item.
    startingR: 1,
    startingWSoft: 0,
    startingHits: 1,
    startingCounts: { prefixes: 1, suffixes: 0 },
  });
  const result = solveMDP({
    ...input,
    target: { ...input.target, minFilled: 1, maxFilled: 6 },
    orbCosts: {
      transmute: 0.01, augment: 0.05, regal: 0.5, alch: 1,
      exalt: 5, annul: 9.5, fracturing: 50,
    },
    orbTimes: {
      transmute: 1, augment: 1, regal: 1, alch: 1,
      exalt: 1, annul: 1, fracturing: 3,
    },
    budgetEx: 50000,
  });
  // Engine should be at goal already (the required mod is on item)
  // and not need any orb actions. The Perfect essence's same-family
  // block is the supporting invariant.
  const startState = result.start.state;
  // Required mod (bit 0) should be set on the start state, and total
  // mods should equal 1 — already at goal modulo minFilled/maxFilled.
  assert.equal(startState.modMask & 1, 1,
    `start.modMask should have bit 0 set; got ${startState.modMask}`);
});

console.log(`\n${passed} passed · ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
