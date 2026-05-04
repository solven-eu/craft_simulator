// MDP-β: Dextral Coronation Regal omen for a SUFFIX wishlist.
//
// Derived from / canonical sibling of `mdp-omen-regal-prefix.test.js`
// — both files share the same scenario shape with the wished mod's
// type swapped (SUFFIX here, PREFIX there) and the omen swapped to
// match (Dextral here for suffix-only Regal, Sinistral there for
// prefix-only). When updating one, propagate the change to the
// other to keep coverage symmetric.
//
// Scenario: bow-fracture (single SUFFIX wished mod, fracture target).
// Plain Regal draws from full pool (50% prefix-irrelevant, 50%
// suffix-mix); Dextral Coronation Regal restricts to the suffix side,
// concentrating wished probability mass. Action cost = orb + omen.
//
// Pivot tests:
//   - Cheap omen (~0 ex) ⇒ Dextral Regal preferred over plain.
//   - Expensive omen (≫ EV gain) ⇒ plain Regal wins.

import { strict as assert } from 'node:assert';
import { solveMDP } from '../engine/mdp/solve.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.message}`); }
}

console.log('MDP-β tests — Dextral Coronation (SUFFIX wishlist)');

const baseInput = {
  // Single SUFFIX wished mod (bow's "fire an additional Arrow").
  wishlist: [{ key: 'WISH_SUFFIX', weight: 2000, type: 'SUFFIX' }],
  irrelevantWeight: 60000,
  irrelevantWeightBySide: { PREFIX: 30000, SUFFIX: 30000 },
  target: {
    requiredMods: ['WISH_SUFFIX'],
    fracturedKey:  'WISH_SUFFIX',
    minFilled: 1, maxFilled: 1,
  },
  start: { rarity: 'normal' },
  basePriceEx: 100,
  alchemyDraws: 4,
  maxFilled: 6,
  timeWeightExPerSec: 0,
  budgetEx: 50000,
};

const baseRates = {
  orbCosts: {
    transmute: 0.01, augment: 0.05,
    regal: 0.5, regal_sinistral: 0.5, regal_dextral: 0.5,
    alch: 1000, exalt: 1, annul: 0.5, fracturing: 50,
  },
  orbTimes: {
    transmute: 1, augment: 1,
    regal: 1, regal_sinistral: 1, regal_dextral: 1,
    alch: 1, exalt: 1, annul: 1, fracturing: 3,
  },
};

test('cheap Dextral Coronation omen ⇒ omen-Regal in optimal policy', () => {
  // From a magic|0|2 state (2 irrelevant, no wished yet), plain Regal
  // sees the full 60k+2k pool: P(land wished) = 2k / 62k ≈ 3.2%.
  // Dextral Regal restricts to the suffix side: P(land wished) =
  // 2k / 32k ≈ 6.3%. Doubled hit rate at near-zero omen cost ⇒ omen
  // is worth it.
  const result = solveMDP({
    ...baseInput,
    ...baseRates,
    orbCosts: {
      ...baseRates.orbCosts,
      regal_dextral: 0.5 + 0.001, // omen ~ free
    },
  });
  const policies = new Set([...result.policy.values()].filter(Boolean));
  assert.ok(policies.has('regal_dextral'),
    `cheap omen-Regal should appear in optimal policy; got: ${[...policies]}`);
});

test('expensive Dextral Coronation omen ⇒ plain Regal preferred', () => {
  const result = solveMDP({
    ...baseInput,
    ...baseRates,
    orbCosts: {
      ...baseRates.orbCosts,
      regal_dextral: 0.5 + 5000,
    },
  });
  const policies = new Set([...result.policy.values()].filter(Boolean));
  assert.ok(!policies.has('regal_dextral'),
    `expensive omen-Regal should be rejected; got: ${[...policies]}`);
  assert.ok(policies.has('regal'),
    `plain Regal should remain in policy; got: ${[...policies]}`);
});

test('Dextral Coronation Regal: suffix-only pool restricts the draw', () => {
  // With SUFFIX-irrelevant=0, Dextral Regal sees only wished SUFFIX
  // (2k weight) in its pool — every draw lands wished (100% hit).
  const result = solveMDP({
    ...baseInput,
    irrelevantWeightBySide: { PREFIX: 60000, SUFFIX: 0 },
    irrelevantWeight: 60000,
    ...baseRates,
    orbCosts: {
      ...baseRates.orbCosts,
      regal_dextral: 0.5 + 0.001,
    },
  });
  const policies = new Set([...result.policy.values()].filter(Boolean));
  assert.ok(policies.has('regal_dextral'),
    `Dextral Regal should be picked when suffix pool is wish-pure; got: ${[...policies]}`);
});

console.log(`\n${passed} passed · ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
