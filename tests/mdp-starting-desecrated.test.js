// Regression test: a starting item with a `desecrated` slot must be
// reflected in the engine's start-state desecratedCount /
// desecratedWishedMask / desecratedPrefixCount. Without this plumbing,
// the engine would silently apply_bone over a starting desecrated
// affix — violating the one-desecrated-cap rule.

import { strict as assert } from 'node:assert';
import { ctxToMdpInput } from '../engine/mdp/adapter.js';
import { solveMDP } from '../engine/mdp/solve.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.message}`); }
}

console.log('Starting desecrated affix — adapter + solver plumbing');

const baseCtx = {
  modIds: { '# to maximum Life': 'max_life' },
  fullPool: [
    { key: 'PREFIX:# to maximum Life', type: 'PREFIX', weight: 1000, tiers: [] },
  ],
  itemClass: 'Body Armour',
  basePriceEx: 100,
  startingCounts: { prefixes: 1, suffixes: 0 },
  wishlist: [{
    key: 'PREFIX:# to maximum Life',
    type: 'PREFIX',
    required: true,
    requiredTier: null,
  }],
  startingHits: 1,
  startingR: 1,
  startingWSoft: 0,
  startingFracturedKey: null,
};

test('adapter forwards starting desecrated key + side to start.desecrated*', () => {
  const input = ctxToMdpInput({
    ...baseCtx,
    startingDesecratedKey: 'PREFIX:# to maximum Life',
    startingDesecratedSide: 'PREFIX',
  });
  assert.equal(input.start.desecratedKey, 'PREFIX:max_life',
    `start.desecratedKey should be canonicalised; got ${input.start.desecratedKey}`);
  assert.equal(input.start.desecratedSide, 'PREFIX',
    'start.desecratedSide should be PREFIX');
});

test('solver seeds desecratedCount=1 + wishedMask bit set when starting affix is desecrated', () => {
  const input = ctxToMdpInput({
    ...baseCtx,
    startingDesecratedKey: 'PREFIX:# to maximum Life',
    startingDesecratedSide: 'PREFIX',
  });
  const result = solveMDP({
    ...input,
    target: { ...input.target, minFilled: 1, maxFilled: 6 },
    orbCosts: { transmute: 0.01, augment: 0.05, regal: 0.5, alch: 1, exalt: 5, annul: 9.5, fracturing: 50 },
    orbTimes: { transmute: 1, augment: 1, regal: 1, alch: 1, exalt: 1, annul: 1, fracturing: 3 },
    budgetEx: 10000,
  });
  // The engine's start state must reflect the desecrated provenance.
  // Total/per-side counts are now derived from
  //   `popcount(desecratedWishedMask) + desecratedIrrPrefix + desecratedIrrSuffix`
  // — the underlying mask + irrelevant counts are what the assertions
  // check.
  const startState = result.start.state;
  // Wishlist bit 0 = the desecrated mod ⇒ desecratedWishedMask bit 0 set.
  assert.ok((startState.desecratedWishedMask & 1) === 1,
    `start.state.desecratedWishedMask should have bit 0 set; got ${startState.desecratedWishedMask}`);
  // The starting affix matches the wished bit, so it counts as a
  // wished-desecrated rather than an irrelevant — irrelevant counts
  // should be 0.
  assert.equal(startState.desecratedIrrPrefix ?? 0, 0,
    `start.state.desecratedIrrPrefix should be 0 (the desecrated mod is wished, not irrelevant); got ${startState.desecratedIrrPrefix}`);
  assert.equal(startState.desecratedIrrSuffix ?? 0, 0,
    `start.state.desecratedIrrSuffix should be 0; got ${startState.desecratedIrrSuffix}`);
});

test('startingBoneMod=true seeds boneMod=true and blocks apply_bone (one-cap)', () => {
  const input = ctxToMdpInput({
    ...baseCtx,
    startingBoneMod: true,
    // No desecrated starting affix — only the pending bone.
    startingDesecratedKey: null,
    startingDesecratedSide: null,
  });
  assert.equal(input.start.boneMod, true,
    `start.boneMod should be true when startingBoneMod is set; got ${input.start.boneMod}`);
  assert.equal(input.start.rarity, 'rare',
    `start.rarity must be 'rare' when a bone is pending (apply_bone requires rare); got ${input.start.rarity}`);
  const result = solveMDP({
    ...input,
    target: { ...input.target, minFilled: 1, maxFilled: 6 },
    orbCosts: { transmute: 0.01, augment: 0.05, regal: 0.5, alch: 1, exalt: 5, annul: 9.5, fracturing: 50 },
    orbTimes: { transmute: 1, augment: 1, regal: 1, alch: 1, exalt: 1, annul: 1, fracturing: 3 },
    boneCostEx: 0.5,
    pBoneRevealHit: [0.3],
    pBoneRevealHitPrefix: [0.6],
    pBoneRevealHitSuffix: [0],
    pBoneRevealHitAbyssal: [0],
    budgetEx: 10000,
  });
  // Engine must be sitting in pre-reveal state at start.
  assert.equal(result.start.state.boneMod, true);
  assert.equal(result.start.state.boneRevealed, false);
  // apply_bone should NOT be applicable at start (a bone is already
  // pending; the next legal step is reveal_bone).
  const startApps = result.appsPerState?.get?.(result.startIdx) ?? [];
  const ids = startApps.map((a) => a.actionId);
  assert.ok(!ids.includes('apply_bone'),
    `apply_bone must not be applicable when boneMod=true at start; got actions: ${JSON.stringify(ids)}`);
  assert.ok(ids.includes('reveal_bone'),
    `reveal_bone must be applicable when boneMod=true at start; got actions: ${JSON.stringify(ids)}`);
});

test('starting desecrated mod blocks apply_bone at start state', () => {
  const input = ctxToMdpInput({
    ...baseCtx,
    startingDesecratedKey: 'PREFIX:# to maximum Life',
    startingDesecratedSide: 'PREFIX',
  });
  const result = solveMDP({
    ...input,
    target: { ...input.target, minFilled: 1, maxFilled: 6 },
    orbCosts: { transmute: 0.01, augment: 0.05, regal: 0.5, alch: 1, exalt: 5, annul: 9.5, fracturing: 50 },
    orbTimes: { transmute: 1, augment: 1, regal: 1, alch: 1, exalt: 1, annul: 1, fracturing: 3 },
    boneCostEx: 0.5,
    pBoneRevealHit: [0.3],
    pBoneRevealHitPrefix: [0.6],
    pBoneRevealHitSuffix: [0],
    pBoneRevealHitAbyssal: [0],
    budgetEx: 10000,
  });
  // Look up the start state's applicable actions — apply_bone should
  // NOT be present because desecratedCount=1 already.
  const startApps = result.appsPerState?.get?.(result.startIdx) ?? [];
  const ids = startApps.map((a) => a.actionId);
  assert.ok(!ids.includes('apply_bone'),
    `apply_bone must not be applicable at start state with desecratedCount=1; got actions: ${JSON.stringify(ids)}`);
});

console.log(`\n${passed} passed · ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
