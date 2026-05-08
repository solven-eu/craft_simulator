// Per-state Q-value alternatives — surfaces every applicable
// action's expected cost from each chain state, sorted by ascending
// Q. Answers "why this orb over the others?" at any node in the
// chain (and lets the UI render a "next-best alternative" annotation).
//
// Each alternative entry: { actionId, costEx, qValue, deltaQ }
//   - qValue = cost + Σ outcome.prob · V*(outcome.to). Infinite when
//     any outcome leads to a bricked state.
//   - deltaQ = qValue - bestQ at this state. The optimal action has
//     deltaQ === 0; runners-up have positive deltas.

import { strict as assert } from 'node:assert';
import { solveMDP } from '../engine/mdp/solve.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.message}`); }
}

console.log('Chain per-state alternatives');

const baseInput = {
  wishlist: [{ key: 'PREFIX:WISH_P', weight: 1000, type: 'PREFIX', requiredTier: 1, required: true }],
  irrelevantWeight: 50000,
  irrelevantWeightBySide: { PREFIX: 25000, SUFFIX: 25000 },
  target: { requiredMods: ['PREFIX:WISH_P'], minFilled: 1, maxFilled: 6 },
  start: { rarity: 'normal' },
  basePriceEx: 100,
  alchemyDraws: 4,
  maxFilled: 6,
  timeWeightExPerSec: 0,
  budgetEx: 5000,
  orbCosts: { transmute: 0.01, augment: 0.05, regal: 0.5, alch: 1, exalt: 1, annul: 0.5, fracturing: 50 },
  orbTimes: { transmute: 1, augment: 1, regal: 1, alch: 1, exalt: 1, annul: 1, fracturing: 3 },
};

test('every non-terminal chain state exposes a non-empty alternatives array', () => {
  const result = solveMDP(baseInput);
  for (const cs of result.chain.states) {
    if (cs.kind === 'goal' || cs.kind === 'bricked') continue;
    const alts = cs.meta?.alternatives ?? [];
    assert.ok(alts.length > 0,
      `non-terminal state ${cs.id} should have ≥1 alternative; got ${alts.length}`);
  }
});

test('alternatives are sorted by ascending qValue', () => {
  const result = solveMDP(baseInput);
  for (const cs of result.chain.states) {
    const alts = cs.meta?.alternatives ?? [];
    for (let i = 1; i < alts.length; i++) {
      assert.ok(alts[i - 1].qValue <= alts[i].qValue,
        `state ${cs.id}: alternative ${alts[i - 1].actionId} (Q=${alts[i - 1].qValue}) ` +
        `comes before ${alts[i].actionId} (Q=${alts[i].qValue}) — sort broken`);
    }
  }
});

test('the chosen-policy action has the smallest qValue (deltaQ === 0)', () => {
  const result = solveMDP(baseInput);
  for (const cs of result.chain.states) {
    if (cs.kind === 'goal' || cs.kind === 'bricked') continue;
    const alts = cs.meta?.alternatives ?? [];
    if (!alts.length) continue;
    const policy = cs.meta?.policy;
    if (!policy || policy === 'buy_base') continue;
    const optimal = alts[0];
    assert.equal(optimal.actionId, policy,
      `state ${cs.id}: top alternative should match policy ${policy}; got ${optimal.actionId}`);
    assert.ok(Math.abs(optimal.deltaQ) < 1e-9,
      `state ${cs.id}: optimal deltaQ should be 0; got ${optimal.deltaQ}`);
  }
});

test('runner-up deltaQ is positive (more expensive than the chosen action)', () => {
  const result = solveMDP(baseInput);
  // Find any state with at least 2 alternatives and verify the second
  // is strictly more expensive (or tied at deltaQ === 0).
  let checked = 0;
  for (const cs of result.chain.states) {
    const alts = cs.meta?.alternatives ?? [];
    if (alts.length < 2) continue;
    assert.ok(alts[1].deltaQ >= 0,
      `state ${cs.id}: runner-up (${alts[1].actionId}) deltaQ=${alts[1].deltaQ} should be ≥0`);
    checked++;
  }
  assert.ok(checked > 0, 'expected at least one state with multiple alternatives');
});

console.log(`\n${passed} passed · ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
