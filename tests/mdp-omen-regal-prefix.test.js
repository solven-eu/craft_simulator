// MDP-β: Sinistral Coronation Regal omen for a PREFIX wishlist.
//
// **Generated from `mdp-omen-regal-suffix.test.js`** — derived sibling
// with the wished mod's type swapped (PREFIX here, SUFFIX there) and
// the omen swapped to match (Sinistral here for prefix-only Regal,
// Dextral there for suffix-only). Keep the two files in lockstep:
// when one's scenario shape changes, propagate to the other so the
// PREFIX × SUFFIX coverage stays symmetric.
//
// Scenario: chest-fracture (single PREFIX wished mod, fracture target).
// Plain Regal draws from full pool (50% prefix-mix, 50% suffix-irrelevant);
// Sinistral Coronation Regal restricts to the prefix side, concentrating
// wished probability mass. Action cost = orb + omen.
//
// Pivot tests:
//   - Cheap omen (~0 ex) ⇒ Sinistral Regal preferred over plain.
//   - Expensive omen (≫ EV gain) ⇒ plain Regal wins.

import { strict as assert } from 'node:assert';
import { solveMDP } from '../engine/mdp/solve.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.message}`); }
}

console.log('MDP-β tests — Sinistral Coronation (PREFIX wishlist)');

const baseInput = {
  // Single PREFIX wished mod (e.g. body armour's "+# to maximum Life").
  wishlist: [{ key: 'WISH_PREFIX', weight: 2000, type: 'PREFIX' }],
  irrelevantWeight: 60000,
  irrelevantWeightBySide: { PREFIX: 30000, SUFFIX: 30000 },
  target: {
    requiredMods: ['WISH_PREFIX'],
    fracturedKey:  'WISH_PREFIX',
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

test('cheap Sinistral Coronation omen ⇒ omen-Regal in optimal policy', () => {
  // From a magic|0|2 state (2 irrelevant, no wished yet), plain Regal
  // sees the full 60k+2k pool: P(land wished) = 2k / 62k ≈ 3.2%.
  // Sinistral Regal restricts to the prefix side: P(land wished) =
  // 2k / 32k ≈ 6.3%. Doubled hit rate at near-zero omen cost ⇒ omen
  // is worth it.
  const result = solveMDP({
    ...baseInput,
    ...baseRates,
    orbCosts: {
      ...baseRates.orbCosts,
      regal_sinistral: 0.5 + 0.001, // omen ~ free
    },
  });
  const policies = new Set([...result.policy.values()].filter(Boolean));
  assert.ok(policies.has('regal_sinistral'),
    `cheap omen-Regal should appear in optimal policy; got: ${[...policies]}`);
});

test('expensive Sinistral Coronation omen ⇒ plain Regal preferred', () => {
  const result = solveMDP({
    ...baseInput,
    ...baseRates,
    orbCosts: {
      ...baseRates.orbCosts,
      regal_sinistral: 0.5 + 5000,
    },
  });
  const policies = new Set([...result.policy.values()].filter(Boolean));
  assert.ok(!policies.has('regal_sinistral'),
    `expensive omen-Regal should be rejected; got: ${[...policies]}`);
  assert.ok(policies.has('regal'),
    `plain Regal should remain in policy; got: ${[...policies]}`);
});

test('Sinistral Coronation Regal: prefix-only pool restricts the draw', () => {
  // With PREFIX-irrelevant=0, Sinistral Regal sees only wished PREFIX
  // (2k weight) in its pool — every draw lands wished (100% hit).
  const result = solveMDP({
    ...baseInput,
    irrelevantWeightBySide: { PREFIX: 0, SUFFIX: 60000 },
    irrelevantWeight: 60000,
    ...baseRates,
    orbCosts: {
      ...baseRates.orbCosts,
      regal_sinistral: 0.5 + 0.001,
    },
  });
  const policies = new Set([...result.policy.values()].filter(Boolean));
  assert.ok(policies.has('regal_sinistral'),
    `Sinistral Regal should be picked when prefix pool is wish-pure; got: ${[...policies]}`);
});

console.log(`\n${passed} passed · ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
