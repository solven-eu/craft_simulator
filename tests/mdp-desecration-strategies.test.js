// MDP: desecration crafting strategies — white base → required
// desecrated mod, with varying currency rates and omen availability.
//
// Goal: pin that the solver actually picks DIFFERENT strategies as
// the cost / availability of each tool changes. A single "always use
// plain bones" optimal-policy would mean the engine isn't reacting
// to rate changes (bug). These scenarios are the contract:
//
//   1. Cheap plain bones, no omens ⇒ plain reveal_bone in policy.
//   2. Cheap Abyssal Echoes vs expensive plain reveal ⇒ Abyssal in policy.
//
// Removed (2026-05-11): scenarios for `reveal_bone_sinistral` /
// `reveal_bone_dextral` — those actions don't exist any more. PoE2
// has no "Omen of Sinistral/Dextral Necromancy"; side-forcing on
// bone reveal is set at apply_bone time via Sinistral/Dextral
// Crystallisation, which the adapter already models by pinning
// state.boneSide. Plain reveal_bone uses the matching side pool
// automatically when boneSide is set.
//
// Gap (not yet covered): Omen of Light annulment cleanup is exercised
// in mdp-omen-of-light-cleanup.test.js (separate file).

import { strict as assert } from 'node:assert';
import { solveMDP } from '../engine/mdp/solve.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.message}`); }
}

console.log('MDP desecration-strategy tests');

// White base: starts Normal with 0 mods. Wishlist requires one
// desecrated mod. The path to it: transmute → augment → regal →
// apply_bone → reveal_bone (or one of its variants).
//
// We pick a Rare-pre-rolled fixture rather than walk through magic →
// rare to keep the test focused on the desecration step. The engine
// covers the magic→rare path elsewhere; here we want the desecration
// CHOICE to dominate the policy.
//
// Two-mod wishlist: bit 0 = a PREFIX-required desecrated mod, bit 1 =
// a SUFFIX-required desecrated mod. Tests target one or the other.
const baseInput = {
  wishlist: [
    { key: 'WISH_P', weight: 0, type: 'PREFIX' },
    { key: 'WISH_S', weight: 0, type: 'SUFFIX' },
  ],
  // Pure desecrated affixes have weight=0 in the natural pool — the
  // only way to land them is via a bone reveal. This is exactly the
  // scenario the test wants to cover (forces the solver to use bones,
  // not exalt/regal lottery).
  irrelevantWeight: 60000,
  irrelevantWeightBySide: { PREFIX: 30000, SUFFIX: 30000 },
  basePriceEx: 1,
  alchemyDraws: 4,
  maxFilled: 6,
  timeWeightExPerSec: 0,
  budgetEx: 100000,
};

// Generic orb rates — calibrated so reveal-strategy is the swing
// variable, not magic→rare ladder costs. Reveal-variant costs are
// NOT set here on purpose: each test seeds only the variants it
// wants priced; unpriced variants get dropped (silent skip) so
// strategy-choice assertions aren't polluted by phantom "free"
// actions.
const baseOrbCosts = {
  transmute: 0.01, augment: 0.05, regal: 0.5, alch: 1,
  exalt: 5, annul: 9.5, fracturing: 50,
};
const baseOrbTimes = {
  transmute: 1, augment: 1, regal: 1, alch: 1,
  exalt: 1, annul: 1, fracturing: 3,
  reveal_bone: 1,
  reveal_bone_abyssal: 1,
};

function solve(overrides = {}) {
  const orbCosts = { ...baseOrbCosts, ...(overrides.orbCosts ?? {}) };
  const orbTimes = { ...baseOrbTimes, ...(overrides.orbTimes ?? {}) };
  return solveMDP({
    ...baseInput,
    ...overrides,
    orbCosts, orbTimes,
  });
}

// ─── Scenario 1: required PREFIX desecrated, cheap plain bone, no omens ─
test('cheap plain bone + required PREFIX desecrated mod ⇒ apply+reveal in optimal policy', () => {
  const result = solve({
    target: { requiredMods: ['WISH_P'], minFilled: 1, maxFilled: 6 },
    boneCostEx: 0.5,
    pBoneRevealHit:        [0.3, 0],   // 30% prefix hit on plain reveal
    pBoneRevealHitPrefix:  [0,   0],   // omens unpriced ⇒ excluded
    pBoneRevealHitSuffix:  [0,   0],
    pBoneRevealHitAbyssal: [0,   0],
  });
  const policies = new Set([...result.policy.values()].filter(Boolean));
  assert.ok(policies.has('apply_bone'),
    `apply_bone should be in optimal policy when required mod is desecrated-only. Got: ${[...policies]}`);
  assert.ok(policies.has('reveal_bone'),
    `reveal_bone should follow apply_bone in policy. Got: ${[...policies]}`);
});

// ─── Scenario 2: cheap Abyssal Echoes dominates plain reveal ────────────
test('cheap Abyssal Echoes + expensive plain reveal ⇒ reveal_bone_abyssal in policy', () => {
  const result = solve({
    target: { requiredMods: ['WISH_P'], minFilled: 1, maxFilled: 6 },
    boneCostEx: 0.5,
    pBoneRevealHit:        [0.27, 0],
    pBoneRevealHitAbyssal: [0.47, 0],   // 6-pick boost
    pBoneRevealHitPrefix:  [0,    0],
    pBoneRevealHitSuffix:  [0,    0],
    orbCosts: {
      reveal_bone:         100,         // plain reveal expensive
      reveal_bone_abyssal: 0.5,         // Abyssal cheap (omen included)
    },
  });
  const policies = new Set([...result.policy.values()].filter(Boolean));
  assert.ok(policies.has('reveal_bone_abyssal'),
    `Abyssal Echoes should be picked when its hit rate is much higher and cost is lower. Got: ${[...policies]}`);
});

// ─── Scenario 6: requiring TWO desecrated mods is fundamentally unreachable ──
test('two required desecrated mods ⇒ unreachable (one-desecrated-cap, even if both are in pool)', () => {
  // PoE2 rule (user clarification 2026-05-07): a desecrated mod —
  // revealed or unrevealed — blocks `apply_bone`. Without an
  // omen-of-light Annul to scrub it, the item can carry at most one
  // desecrated mod over its entire crafting life. Hence requiring
  // TWO desecrated mods on the final item is unreachable, regardless
  // of pool composition.
  //
  // This test seeds BOTH wished mods into the desecrated pool with
  // generous hit rates — pool-composition is not the bottleneck.
  // The unreachability comes from the apply_bone gate alone.
  const result = solve({
    target: { requiredMods: ['WISH_P', 'WISH_S'], minFilled: 2, maxFilled: 6 },
    boneCostEx: 0.5,
    pBoneRevealHit:        [0.5, 0.5],   // both in desecrated pool, generous rates
    pBoneRevealHitPrefix:  [0.7, 0],
    pBoneRevealHitSuffix:  [0,   0.7],
    pBoneRevealHitAbyssal: [0,   0],
  });
  assert.equal(result.chain.pSuccessStart, 0,
    `requiring two desecrated mods is unreachable under the one-desecrated-cap; `
    + `expected pSuccessStart=0, got ${result.chain.pSuccessStart}. (Engine must `
    + `gate apply_bone on desecratedCount=0 — without omen-of-light cleanup, no `
    + `second bone can be applied after the first reveal.)`);
});

// ─── Scenario 7: side-allocation — required PREFIX + 3P/0S start ────────
test('required PREFIX + already-full prefix side ⇒ no plain-reveal path can satisfy goal', () => {
  // Edge case: starting state has prefix side full. Bone-reveal is
  // forced to suffix. A required PREFIX desecrated mod cannot land
  // at all from this state via a fresh bone — the policy must either
  // fail, or use Sinistral to override (if available). With Sinistral
  // unpriced, the goal is unreachable.
  const result = solve({
    target: { requiredMods: ['WISH_P'], minFilled: 1, maxFilled: 6 },
    start: {
      rarity: 'rare',
      modsOnItem: [],            // no wished mods on item
      totalMods: 3,              // 3 mods on prefix side
      prefixMods: 3,             // all on prefix
      fracturedKey: null,
    },
    boneCostEx: 0.5,
    pBoneRevealHit:        [0.3, 0],
    pBoneRevealHitPrefix:  [0,   0],
    pBoneRevealHitSuffix:  [0,   0],
    pBoneRevealHitAbyssal: [0,   0],
  });
  // pSuccessStart should be 0 — no path lands the required prefix
  // affix once the prefix side is locked full and Sinistral is
  // unpriced.
  assert.equal(result.chain.pSuccessStart, 0,
    `with prefix side full and forced-suffix reveal, required PREFIX desecrated `
    + `mod is unreachable; expected pSuccessStart=0, got ${result.chain.pSuccessStart}`);
});

console.log(`\n${passed} passed · ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
