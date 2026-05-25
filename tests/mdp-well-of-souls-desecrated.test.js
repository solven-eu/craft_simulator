// MDP: Well-of-Souls strategy choice for a DESECRATED-pool wished mod.
//
// Scenario shape: the wishlist asks for a single mod that ONLY
// exists in the desecrated pool (e.g. an Amanamu-tagged mod).
// Standard orbs (transmute / regal / exalt) can't roll it — the
// only path is bones. The strategy choice is between bone variants:
//
//   (a) plain apply_bone + reveal_bone — generic 3-pick reveal.
//   (b) apply_bone_sinistral / _dextral — Necromancy pins the
//       bone-phantom side. For a single-side wished mod, this
//       strictly improves hit rate (smaller denominator).
//   (c) reveal_bone_abyssal — Abyssal Echoes turns the 3-pick
//       reveal into a 6-pick. Higher hit rate at the cost of one
//       Abyssal omen.
//   (d) Future: apply_bone_liege / apply_bone_sovereign /
//       apply_bone_blackblooded — narrow the at-least-one-
//       guaranteed-desecrated slot to one specific god's pool.
//       NOT YET MODELLED — placeholder tests below describe the
//       expected behaviour for the day they land.
//
// All scenarios use a single PREFIX wished mod with weight=0 in the
// natural pool (desecrated-only) so the engine MUST go through bones.

import { strict as assert } from 'node:assert';
import { solveMDP } from '../engine/mdp/solve.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.message}`); }
}

console.log('MDP tests — Well-of-Souls (desecrated-pool wished mod)');

const baseInput = {
  // Pure desecrated wishlist entry: weight=0 in base pool ⇒ engine
  // can only land it via a bone reveal. Mirror of the existing
  // mdp-desecration-strategies.test.js fixture.
  wishlist: [{ key: 'PREFIX:WISH_DESEC', weight: 0, type: 'PREFIX', requiredTier: 1, required: true }],
  irrelevantWeight: 60000,
  irrelevantWeightBySide: { PREFIX: 30000, SUFFIX: 30000 },
  target: { requiredMods: ['PREFIX:WISH_DESEC'], minFilled: 1, maxFilled: 6 },
  start: { rarity: 'normal' },
  basePriceEx: 1,
  alchemyDraws: 4,
  maxFilled: 6,
  timeWeightExPerSec: 0,
};

const baseOrbCosts = {
  transmute: 0.01, augment: 0.05, regal: 0.5, alch: 1,
  exalt: 1, annul: 9.5, fracturing: 50, chaos: 1,
};
const baseOrbTimes = {
  transmute: 1, augment: 1, regal: 1, alch: 1,
  exalt: 1, annul: 1, fracturing: 3, chaos: 1,
  reveal_bone: 1, reveal_bone_abyssal: 1,
  apply_bone_sinistral: 1, apply_bone_dextral: 1,
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

// Scenario 1 — desecrated-only target ⇒ engine MUST use bones.
// With cheap bone, plain apply_bone in policy.
test('desecrated-only wished + cheap bone ⇒ apply_bone in optimal policy', () => {
  const result = solve({
    boneCostEx: 0.5,
    pBoneRevealHit:        [0.3],   // 3-pick over the full bone pool
    pBoneRevealHitPrefix:  [0.6],   // prefix-only pool
    pBoneRevealHitSuffix:  [0],
    pBoneRevealHitAbyssal: [0.5],
  });
  const policies = new Set([...result.policy.values()].filter(Boolean));
  assert.ok(policies.has('apply_bone') || policies.has('apply_bone_sinistral'),
    `desecrated-only mod + cheap bone ⇒ engine must use a bone variant; got: ${[...policies]}`);
});

// Scenario 2 — Necromancy strictly improves hit rate for a single-
// side wished mod (the irrelevant-other-side branch is pruned).
// When Sinistral is cheap, the engine should prefer it over plain
// apply_bone.
test('cheap Sinistral Necromancy + PREFIX-only desecrated wish ⇒ apply_bone_sinistral in policy', () => {
  const result = solve({
    boneCostEx: 0.5,
    pBoneRevealHit:        [0.3],
    pBoneRevealHitPrefix:  [0.6],   // prefix-only pool ⇒ 2× hit rate
    pBoneRevealHitSuffix:  [0],
    pBoneRevealHitAbyssal: [0.5],
    orbCosts: {
      apply_bone_sinistral: 0.2,    // omen cheap
    },
  });
  const policies = new Set([...result.policy.values()].filter(Boolean));
  assert.ok(policies.has('apply_bone_sinistral'),
    `cheap Sinistral Necromancy + 2x prefix-only hit ⇒ should be picked; got: ${[...policies]}`);
});

// Scenario 3 — Necromancy NOT worth omen cost ⇒ plain bone wins.
// Comparator: same hit-rate boost, but the omen is now expensive.
test('expensive Sinistral Necromancy ⇒ plain apply_bone reclaims optimal policy', () => {
  const result = solve({
    boneCostEx: 0.5,
    pBoneRevealHit:        [0.3],
    pBoneRevealHitPrefix:  [0.6],
    pBoneRevealHitSuffix:  [0],
    pBoneRevealHitAbyssal: [0.5],
    orbCosts: {
      apply_bone_sinistral: 100,    // omen way too expensive
    },
  });
  const policies = new Set([...result.policy.values()].filter(Boolean));
  assert.ok(!policies.has('apply_bone_sinistral'),
    `expensive Sinistral ⇒ should NOT be in policy; got: ${[...policies]}`);
});

// Scenario 4 — wrong-side Necromancy is irrelevant. Wished mod is
// PREFIX; Dextral Necromancy forces the bone-phantom SUFFIX, where
// the wished mod can't land. Even with Dextral free, the engine
// should NOT use it.
test('Dextral Necromancy is useless for a PREFIX wished mod (even free)', () => {
  const result = solve({
    boneCostEx: 0.5,
    pBoneRevealHit:        [0.3],
    pBoneRevealHitPrefix:  [0.6],
    pBoneRevealHitSuffix:  [0],     // suffix pool can't hit the prefix wish
    pBoneRevealHitAbyssal: [0.5],
    orbCosts: {
      apply_bone_sinistral: 100,
      apply_bone_dextral:   0,      // free
    },
  });
  const policies = new Set([...result.policy.values()].filter(Boolean));
  assert.ok(!policies.has('apply_bone_dextral'),
    `Dextral on a PREFIX wish lands no useful outcome; should NOT be in policy; got: ${[...policies]}`);
});

// Scenario 5 — strict side-symmetry check. Wished mod is PREFIX;
// Sinistral and Dextral Necromancy are BOTH cheap (same omen cost).
// Sinistral routes to the prefix-only hit pool (wished mod
// reachable); Dextral routes to the suffix-only pool (wished mod
// NOT reachable). Engine must pick Sinistral over Dextral on the
// merit of the routing, not the cost. Comparator to scenario 4
// (which only checks Dextral exclusion) — this scenario pins
// "correct-side IS picked AND wrong-side is NOT picked" in one
// solve, so a regression that broke either direction would surface.
test('side-symmetry: cheap Sinistral picked, cheap Dextral excluded for a PREFIX wish', () => {
  const result = solve({
    boneCostEx: 0.5,
    pBoneRevealHit:        [0.3],
    pBoneRevealHitPrefix:  [0.6],   // prefix pool hits the wish
    pBoneRevealHitSuffix:  [0],     // suffix pool cannot
    pBoneRevealHitAbyssal: [0.5],
    orbCosts: {
      apply_bone_sinistral: 0.2,    // both omens equally cheap
      apply_bone_dextral:   0.2,
    },
  });
  const policies = new Set([...result.policy.values()].filter(Boolean));
  assert.ok(policies.has('apply_bone_sinistral'),
    `correct-side (Sinistral, PREFIX pool) should be picked; got: ${[...policies]}`);
  assert.ok(!policies.has('apply_bone_dextral'),
    `wrong-side (Dextral, SUFFIX pool, no wish hit) must NOT be picked even at the same cost; got: ${[...policies]}`);
});

// ──────────────────────────────────────────────────────────────────
// PLACEHOLDERS — Liege / Sovereign / Blackblooded omens
// ──────────────────────────────────────────────────────────────────
//
// These omens narrow the at-least-one-desecrated guarantee on a
// reveal to ONE specific god's sub-pool (Amanamu / Ulaman / Kurgal).
// Modelling them requires per-god hit-prob arrays in the adapter:
//
//   pBoneRevealHitAmanamu  — only Amanamu-tagged desecrated mods
//   pBoneRevealHitUlaman   — only Ulaman-tagged
//   pBoneRevealHitKurgal   — only Kurgal-tagged
//
// And matching engine actions:
//
//   apply_bone_liege       — Amanamu-only reveal pool, ~+omen-of-the-liege cost
//   apply_bone_sovereign   — Ulaman-only,  ~+omen-of-the-sovereign cost
//   apply_bone_blackblooded— Kurgal-only,  ~+omen-of-the-blackblooded cost
//
// The desecrated catalog (data/poe2/extra_mods.json) already tags
// every desecrated mod with one of {amanamu_mod, ulaman_mod,
// kurgal_mod}; partitioning the hit-prob arrays is mechanical.
//
// When these land, the test below should flip from skip to pinned:
//
//   test('cheap Liege omen + Amanamu-pool desecrated wish ⇒ apply_bone_liege', () => {
//     const result = solve({
//       boneCostEx: 0.5,
//       pBoneRevealHitAmanamu: [0.9],   // narrowed pool ⇒ near-certain hit
//       pBoneRevealHitUlaman:  [0],
//       pBoneRevealHitKurgal:  [0],
//       orbCosts: { apply_bone_liege: 0.5 },
//     });
//     const policies = new Set([...result.policy.values()].filter(Boolean));
//     assert.ok(policies.has('apply_bone_liege'),
//       `cheap Liege omen narrowing to Amanamu pool ⇒ should be picked; got: ${[...policies]}`);
//   });
//
// And the comparator: expensive Liege ⇒ plain bone reclaims policy.
test.skip = (name, fn) => {
  console.log(`  ⤳ ${name} (skipped — Liege/Sovereign/Blackblooded not yet modelled)`);
};
test.skip('cheap Liege omen + Amanamu-pool desecrated wish ⇒ apply_bone_liege in optimal policy');
test.skip('expensive Liege omen ⇒ plain apply_bone reclaims optimal policy');
test.skip('cheap Sovereign + Ulaman-pool wish ⇒ apply_bone_sovereign in optimal policy');
test.skip('cheap Blackblooded + Kurgal-pool wish ⇒ apply_bone_blackblooded in optimal policy');

console.log(`\n${passed} passed · ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
