// Regression: when an orb is disabled in the rates panel
// (per-orb checkbox), the engine warning must say "disabled by
// user" — not "missing rate". The misleading old text sent users
// to scripts/update-poe2-rates.sh for nothing.

import { strict as assert } from 'node:assert';
import { solveMDP } from '../engine/mdp/solve.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.message}`); }
}

console.log('Solve — disabled-orb warning vs missing-rate warning');

const baseInput = {
  wishlist: [{ key: 'PREFIX:# to maximum Life', weight: 1000, type: 'PREFIX' }],
  irrelevantWeight: 50000,
  irrelevantWeightBySide: { PREFIX: 25000, SUFFIX: 25000 },
  target: { requiredMods: [], minFilled: 1, maxFilled: 6 },
  start: { rarity: 'normal' },
  basePriceEx: 40,
  alchemyDraws: 4,
  maxFilled: 6,
  timeWeightExPerSec: 0,
  budgetEx: 10000,
  allowMissingRates: true,
  orbCosts: {
    transmute: null,   // missing or disabled — distinguish via disabledActionIds
    regal: null,       // ditto
    augment: 0.05, alch: 5, exalt: 1, annul: 0.5, fracturing: 50,
  },
  orbTimes: {
    transmute: 1, augment: 1, regal: 1,
    alch: 1, exalt: 1, annul: 1, fracturing: 3,
  },
};

test('disabled orb ⇒ "disabled by user" warning, not "missing rate"', () => {
  const result = solveMDP({
    ...baseInput,
    disabledActionIds: { transmute: true },  // explicitly disabled
  });
  const transmuteWarn = result.warnings.find((w) => /Action "transmute"/.test(w));
  assert.ok(transmuteWarn, 'expected a warning about transmute');
  assert.match(transmuteWarn, /disabled by user/,
    `expected "disabled by user" wording; got: ${transmuteWarn}`);
  assert.doesNotMatch(transmuteWarn, /missing rate/,
    `must NOT use the misleading "missing rate" wording for a disabled orb; got: ${transmuteWarn}`);
});

test('genuinely missing rate still emits "missing rate" warning', () => {
  const result = solveMDP({
    ...baseInput,
    disabledActionIds: {},  // regal is unpriced, NOT disabled
  });
  const regalWarn = result.warnings.find((w) => /Action "regal"/.test(w));
  assert.ok(regalWarn, 'expected a warning about regal');
  assert.match(regalWarn, /missing rate/,
    `unpriced orb should keep the "missing rate" wording; got: ${regalWarn}`);
});

console.log(`\n${passed} passed · ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
