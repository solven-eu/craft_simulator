// MDP optimization: Perfect-essence overwrite "padding" trick.
//
// Game-theoretic insight (user-confirmed 2026-05-07): when the next
// step is a Perfect-essence overwrite that picks a uniformly-random
// affix to replace, padding the item with extra irrelevant affixes
// BEFORE the Perfect essence reduces P(overwrite destroys a wished
// affix that's already on the item).
//
//   Without padding (totalMods=3 with 1 wished bit):
//     P(Perfect overwrites wished bit) = 1/3 ≈ 33%.
//   With padding to totalMods=6 (1 wished + 5 irrelevant):
//     P(Perfect overwrites wished bit) = 1/6 ≈ 17%.
//
// The bone-reveal action is one cheap source of padding (apply +
// reveal both cost a fixed boneCostEx, and the resulting affix
// doesn't have to land a wished bit — just a slot). Exalt is
// another. The engine picks among them by Q-value comparison.
//
// This test pins that the padding optimization is in fact selected:
// at a post-essence-A state with 1 wished bit and 2 irrelevant, the
// optimal policy must NOT apply Perfect-essence-B directly — it must
// pad first (via bone, exalt, or chaos).
//
// User reported this behaviour and explicitly endorsed it as
// correct game theory ("It's correct game-theoretically — keep it.
// Ensure there is a unit-test related to this optimization.").

import { strict as assert } from 'node:assert';
import { ctxToMdpInput } from '../engine/mdp/adapter.js';
import { solveMDP } from '../engine/mdp/solve.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.message}`); }
}

console.log('MDP — Perfect-essence overwrite padding trick');

// Two essence-only PREFIX requirements:
//   bit 0 = WISH_A  ←  granted by Magic→Rare essence (essence A)
//   bit 1 = WISH_B  ←  granted by Perfect-overwrite essence (essence B)
// Both essence-only ⇒ no natural-pool path to either bit.
const baseCtx = {
  modIds: { 'WISH_A_NAME': 'wish_a', 'WISH_B_NAME': 'wish_b' },
  fullPool: [],
  itemClass: 'Body Armour',
  basePriceEx: 100,
  startingCounts: { prefixes: 0, suffixes: 0 },
  wishlist: [
    { key: 'PREFIX:WISH_A_NAME', type: 'PREFIX', required: true, requiredTier: 1 },
    { key: 'PREFIX:WISH_B_NAME', type: 'PREFIX', required: true, requiredTier: 1 },
  ],
  essences: [
    {
      poe2db_slug: 'EssenceA_Greater',
      name: 'EssenceA Greater',
      tier: 'Greater',
      side: 'PREFIX',
      item_classes: 'Body Armour',
      target_affix: '(N—M)% WISH_A_NAME',
      matched_mods: 'WISH_A_NAME',
    },
    {
      poe2db_slug: 'EssenceB_Perfect',
      name: 'EssenceB Perfect',
      tier: 'Perfect',
      side: 'PREFIX',
      item_classes: 'Body Armour',
      target_affix: '(N—M)% WISH_B_NAME',
      matched_mods: 'WISH_B_NAME',
    },
  ],
  essencePrices: {
    'EssenceA Greater':   { priceEx: 44 },
    'EssenceB Perfect':   { priceEx: 13 },
  },
};

function solve(extra = {}) {
  const input = ctxToMdpInput(baseCtx);
  return solveMDP({
    ...input,
    target: { ...input.target, minFilled: 2, maxFilled: 6 },
    orbCosts: {
      transmute: 0.01, augment: 0.05, regal: 0.5, alch: 1,
      // Cheap exalt — cheap padding via exalt is a valid alternative
      // to bone padding; either should appear in policy.
      exalt: 1,
      annul: 9.5, fracturing: 50, chaos: 5,
    },
    orbTimes: {
      transmute: 1, augment: 1, regal: 1, alch: 1,
      exalt: 1, annul: 1, fracturing: 3, chaos: 1,
    },
    boneCostEx: 0.5,
    pBoneRevealHit:        [0, 0],   // neither wished is in desecrated pool
    pBoneRevealHitPrefix:  [0, 0],
    pBoneRevealHitSuffix:  [0, 0],
    pBoneRevealHitAbyssal: [0, 0],
    budgetEx: 50000,
    ...extra,
  });
}

test('engine pads BEFORE applying Perfect-overwrite essence (avoids 1/3 destroy-progress)', () => {
  const result = solve();
  // The reachable post-essence-A state is: rare|1|3 (modMask=1=WISH_A,
  // totalMods=3 from transmute + augment + essence). At this state,
  // the optimal policy must NOT be EssenceB_Perfect directly — that
  // would burn 33% of attempts. It must be a padding action (exalt
  // / apply_bone / chaos) to dilute the irrelevant pool first.
  const postEssAStateKey = [...result.policy.keys()].find((k) => {
    // State key format:
    // rarity|modMask|totalMods|prefixMods|desecCount|desecWishedMask|desecPrefixCount|fracturedBit|irrFractured|boneMod|boneRevealed
    const parts = k.split('|');
    return parts[0] === 'rare' && parts[1] === '1' && parts[2] === '3'
        && parts[4] === '0' && parts[7] === '-1' && parts[9] === '0';
  });
  assert.ok(postEssAStateKey,
    `expected a reachable rare|modMask=1|totalMods=3 state in the policy`);
  const action = result.policy.get(postEssAStateKey);
  // The padding optimization rules out the direct Perfect-essence
  // overwrite at this state.
  assert.ok(action !== 'essence_EssenceB_Perfect',
    `at rare|1|3, engine should NOT apply Perfect essence directly `
    + `(would destroy progress 1/3 of the time); got action=${action}.`);
  // It should be a padding action: exalt, apply_bone, or chaos.
  // (Annul would remove the wished bit — strictly bad.)
  const paddingActions = new Set(['exalt', 'apply_bone', 'chaos']);
  assert.ok(paddingActions.has(action),
    `at rare|1|3, engine should pick a padding action `
    + `(exalt / apply_bone / chaos) before the Perfect essence; got action=${action}.`);
});

test('engine eventually applies Perfect-overwrite essence at a higher-totalMods state', () => {
  const result = solve();
  // Somewhere in the policy, at a state with more padding (totalMods
  // ≥ 4 or so), Perfect essence should be the chosen action — that's
  // where the padding pays off.
  const policies = new Set([...result.policy.values()].filter(Boolean));
  assert.ok(policies.has('essence_EssenceB_Perfect'),
    `EssenceB_Perfect must appear in optimal policy at SOME state `
    + `(after padding); got: ${[...policies]}`);
});

test('padding trick: V*(start) is finite (craft is reachable end-to-end)', () => {
  const result = solve();
  assert.ok(Number.isFinite(result.vStar),
    `V*(start) must be finite (the padding trick + Perfect overwrite ` +
    `path must reach goal); got ${result.vStar}`);
  assert.ok(result.chain.pSuccessStart > 0.5,
    `pSuccessStart should be high (padding makes Perfect overwrite ` +
    `mostly preserve progress); got ${result.chain.pSuccessStart}`);
});

console.log(`\n${passed} passed · ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
