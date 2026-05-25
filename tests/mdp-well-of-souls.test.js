// MDP: Well-of-Souls strategy choice for a STANDARD-pool wished mod.
//
// Scenario shape: the wishlist asks for a single mod that exists in
// the natural (base) affix pool. The engine has a few alternatives:
//
//   (a) plain orb path: transmute → augment → regal → exalt-fill.
//       One weighted draw per orb; geometric retry.
//   (b) bone path: apply_bone → reveal_bone. Reveal is a best-of-N
//       pick (3 picks plain, 6 with Abyssal Echoes), so the per-attempt
//       hit probability for a wished mod is much higher than a single
//       weighted draw — at the cost of one bone + one reveal.
//   (c) Necromancy: apply_bone_sinistral/dextral pins the bone-phantom
//       to the wished side, which (for the engine's current modelling)
//       removes the irrelevant-other-side outcome from the reveal.
//       Net effect: irrelevant-side mods can't soak up the bone slot,
//       so the per-attempt hit rate increases proportionally.
//
// These tests pin the engine's choice across cost regimes — the load-
// bearing claim is "the engine picks the right STRATEGY when costs
// favour it," not the exact V*/Q numbers.
//
// Gaps not exercised here:
//   - Best-of-3 from base ∪ desecrated pool: the engine currently
//     models `pBoneRevealHit` as desecrated-only. For a standard
//     wished mod the engine sees pBoneRevealHit[i]=0, so apply_bone
//     can't help. Tests below set pBoneRevealHit explicitly to
//     simulate "reveal can land the wished mod" — useful as a
//     contract for the day the engine models the union pool.
//   - Sovereign / Liege / Blackblooded omens (per-god pool filters)
//     aren't hardcoded yet; covered in the desecrated test file as
//     "skip with note" placeholders.

import { strict as assert } from 'node:assert';
import { solveMDP } from '../engine/mdp/solve.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.message}`); }
}

console.log('MDP tests — Well-of-Souls (standard-pool wished mod)');

// Single PREFIX wished mod, present in standard pool. We seed the
// reveal hit-prob arrays so the bone path can produce the wished
// mod (the engine's current model gates this via pBoneRevealHit).
const baseInput = {
  wishlist: [{ key: 'PREFIX:WISH', weight: 2000, type: 'PREFIX', requiredTier: 1, required: true }],
  irrelevantWeight: 60000,
  irrelevantWeightBySide: { PREFIX: 30000, SUFFIX: 30000 },
  target: { requiredMods: ['PREFIX:WISH'], minFilled: 1, maxFilled: 6 },
  start: { rarity: 'normal' },
  basePriceEx: 1,
  alchemyDraws: 4,
  maxFilled: 6,
  timeWeightExPerSec: 0,
};

const baseRates = {
  orbCosts: {
    transmute: 0.01, augment: 0.05, regal: 0.5, alch: 1,
    exalt: 1, annul: 9.5, fracturing: 50,
    chaos: 1,
  },
  orbTimes: {
    transmute: 1, augment: 1, regal: 1, alch: 1,
    exalt: 1, annul: 1, fracturing: 3,
    chaos: 1, reveal_bone: 1, reveal_bone_abyssal: 1,
    apply_bone_sinistral: 1, apply_bone_dextral: 1,
  },
};

// Scenario 1 — bone path dominates when bone is dirt-cheap.
// Bone reveal lands wished mod with p=0.6 (2 free picks at 30%
// each, simplified), vs a single exalt draw at ~0.06. With bone
// at 0.1 ex and exalt at 1 ex, expected cost via bone (~apply +
// reveal then maybe finish via exalts) is much lower than pure
// exalt-spam (~17 attempts × 1 ex each).
test('cheap bone (~0.1 ex) + 60% reveal hit ⇒ bone path in optimal policy', () => {
  const result = solveMDP({
    ...baseInput,
    ...baseRates,
    boneCostEx: 0.1,
    pBoneRevealHit:        [0.6],
    pBoneRevealHitPrefix:  [0.6],
    pBoneRevealHitSuffix:  [0],
    pBoneRevealHitAbyssal: [0.85],
  });
  const policies = new Set([...result.policy.values()].filter(Boolean));
  assert.ok(policies.has('apply_bone') || policies.has('apply_bone_sinistral'),
    `cheap bone with 60% reveal hit ⇒ engine should use a bone variant; got: ${[...policies]}`);
});

// Scenario 2 — expensive bone, cheap exalt ⇒ engine picks the
// natural orb path. Verifies the engine isn't biased toward bone.
test('expensive bone (10 ex) + cheap exalt (1 ex) ⇒ no bone in optimal policy', () => {
  const result = solveMDP({
    ...baseInput,
    ...baseRates,
    boneCostEx: 10,
    pBoneRevealHit:        [0.6],
    pBoneRevealHitPrefix:  [0.6],
    pBoneRevealHitSuffix:  [0],
    pBoneRevealHitAbyssal: [0.85],
  });
  const policies = new Set([...result.policy.values()].filter(Boolean));
  assert.ok(!policies.has('apply_bone') && !policies.has('apply_bone_sinistral'),
    `expensive bone ⇒ engine should avoid bone path entirely; got: ${[...policies]}`);
});

// Scenario 3 — Abyssal Echoes (6-pick) dominates plain reveal when
// its omen makes it cheaper-per-effective-pick. Plain reveal hit
// p=0.3, Abyssal hit p=0.7 (≈ 1 - (1 - 1/N)^6 vs ^3 for the same N).
// With Abyssal cost = 0.5 ex (vs reveal cost = 0), Abyssal is the
// optimal reveal variant when the marginal hit boost outweighs the
// 0.5-ex omen.
test('Abyssal Echoes worth its omen cost ⇒ Abyssal reveal in optimal policy', () => {
  const result = solveMDP({
    ...baseInput,
    ...baseRates,
    boneCostEx: 0.5,
    pBoneRevealHit:        [0.3],
    pBoneRevealHitPrefix:  [0.3],
    pBoneRevealHitSuffix:  [0],
    pBoneRevealHitAbyssal: [0.7],
    orbCosts: {
      ...baseRates.orbCosts,
      reveal_bone:         0,
      reveal_bone_abyssal: 0.5,
    },
  });
  const policies = new Set([...result.policy.values()].filter(Boolean));
  assert.ok(policies.has('reveal_bone_abyssal'),
    `cheap Abyssal Echoes with much higher hit rate ⇒ should appear in policy; got: ${[...policies]}`);
});

// Scenario 4 — Necromancy reduces irrelevant-side weight. With a
// wished PREFIX mod and Sinistral Necromancy, the bone-phantom is
// pinned PREFIX so the reveal's prefix-only hit pool is used (and
// the irrelevant-suffix bucket is removed). When Sinistral cost
// is small relative to the per-attempt hit-rate boost, the engine
// prefers apply_bone_sinistral over plain apply_bone.
//
// pBoneRevealHitPrefix > pBoneRevealHit because the prefix-only
// pool is a strict subset (smaller denominator ⇒ higher per-mod p).
test('cheap Sinistral Necromancy ⇒ apply_bone_sinistral preferred over plain apply_bone', () => {
  const result = solveMDP({
    ...baseInput,
    ...baseRates,
    boneCostEx: 0.5,
    pBoneRevealHit:        [0.3],
    pBoneRevealHitPrefix:  [0.6],   // prefix-only pool ⇒ higher hit
    pBoneRevealHitSuffix:  [0],
    pBoneRevealHitAbyssal: [0.5],
    orbCosts: {
      ...baseRates.orbCosts,
      apply_bone_sinistral: 0.2,    // omen cheap
    },
  });
  const policies = new Set([...result.policy.values()].filter(Boolean));
  assert.ok(policies.has('apply_bone_sinistral'),
    `cheap Sinistral Necromancy + higher prefix-only hit rate ⇒ should be picked; got: ${[...policies]}`);
});

// Scenario 5 — Necromancy NOT worth its omen cost ⇒ plain bone
// reclaims the policy. Comparator to scenario 4: same hit-rate
// boost, but the omen is now expensive enough that the
// hit-rate × (1/cost) ratio favours plain apply_bone.
test('expensive Sinistral Necromancy ⇒ plain apply_bone reclaims optimal policy', () => {
  const result = solveMDP({
    ...baseInput,
    ...baseRates,
    boneCostEx: 0.5,
    pBoneRevealHit:        [0.3],
    pBoneRevealHitPrefix:  [0.6],
    pBoneRevealHitSuffix:  [0],
    pBoneRevealHitAbyssal: [0.5],
    orbCosts: {
      ...baseRates.orbCosts,
      apply_bone_sinistral: 100,    // omen way too expensive
    },
  });
  const policies = new Set([...result.policy.values()].filter(Boolean));
  assert.ok(!policies.has('apply_bone_sinistral'),
    `expensive Sinistral ⇒ should NOT be in policy; got: ${[...policies]}`);
});

console.log(`\n${passed} passed · ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
