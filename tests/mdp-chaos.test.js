// MDP-η: Chaos Orb (and Greater/Perfect variants).
//
// Closes the rare|0|6 dead-end where every other action either
// can't apply (exalt blocked at maxFilled, alch/transmute/etc. wrong
// rarity) or fails (fracture bricks since no wished bit on item).
// Chaos's "remove 1 random + add 1 random" composite gives a per-
// orb attempt at landing the wished mod from any rare|*|6 state
// without changing totalMods — geometric retry until the wished
// mod lands.

import { strict as assert } from 'node:assert';
import { solveMDP } from '../engine/mdp/solve.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.message}`); }
}

console.log('MDP-η tests — Chaos Orb');

const baseInput = {
  // Inflated wished weight so chaos hit rate is non-trivial
  // (20k / 80k = 25% per chaos draw). Real PoE2 wished mods sit at
  // 1-3% per draw; the test scenario boosts the rate to make the
  // chaos-vs-rest comparison crisp.
  wishlist: [{ key: 'WISH', weight: 20000, type: 'SUFFIX' }],
  irrelevantWeight: 60000,
  irrelevantWeightBySide: { PREFIX: 30000, SUFFIX: 30000 },
  // Goal: wished bit present, ANY totalMods. No fracture, no
  // minFilled/maxFilled. Simplifies the test so the chaos rescue
  // step (rare|0|6 → chaos → rare|w|6 = goal) has a single-step
  // payoff and rate-tuning is straightforward.
  target: {
    requiredMods: ['WISH'],
  },
  // Start FROM rare|0|6 directly (the dead-end state) so the policy
  // at start is the rescue decision.
  start: { rarity: 'rare', modsOnItem: [], totalMods: 6, fracturedKey: null },
  basePriceEx: 100,
  alchemyDraws: 4,
  maxFilled: 6,
  timeWeightExPerSec: 0,
  budgetEx: 50000,
};

// Rates tuned so Chaos is the optimal rare|0|6 rescue:
//   - exalt expensive (so exalt-pad can't refill cheaply)
//   - annul expensive (so annul-down-and-retry-cycle is costly)
//   - chaos cheap (so per-orb retry is the cheapest path)
const baseRates = {
  orbCosts: {
    transmute: 0.01, augment: 0.05, regal: 0.5, alch: 1,
    exalt: 100, annul: 100, fracturing: 50,
  },
  orbTimes: {
    transmute: 1, augment: 1, regal: 1, alch: 1,
    exalt: 1, annul: 1, fracturing: 3,
  },
};

test('rare|0|6 with cheap Chaos in action set ⇒ chaos in optimal policy (no longer dead-end)', () => {
  const result = solveMDP({
    ...baseInput,
    ...baseRates,
    orbCosts: {
      ...baseRates.orbCosts,
      chaos: 6.3,
      chaos_greater: 18,
    },
    orbTimes: {
      ...baseRates.orbTimes,
      chaos: 1, chaos_greater: 1,
    },
  });
  // The start state IS rare|0|6 (per baseInput.start). Its optimal
  // policy must NOT be buy_base — chaos provides an in-place rescue.
  const startPolicy = result.policy.get(result.start.stateKey);
  assert.ok(startPolicy && /^chaos/.test(startPolicy),
    `rare|0|6 start should pick a chaos variant (no longer dead-end); got "${startPolicy}"`);
});

test('rare|0|6 without Chaos ⇒ buy_base wins (regression: dead-end persists if chaos absent)', () => {
  // Same scenario but no chaos rates — chaos action silently
  // excluded. Pin: policy reverts to buy_base, confirming chaos is
  // the specific feature that resolves the dead-end.
  const result = solveMDP({
    ...baseInput,
    ...baseRates,
    // omit chaos costs — silent skip via the optional-variant rule.
  });
  const startPolicy = result.policy.get(result.start.stateKey);
  assert.equal(startPolicy, 'buy_base',
    `rare|0|6 without chaos should fall back to buy_base; got "${startPolicy}"`);
});

test('Chaos transitions preserve totalMods (remove 1 + add 1 = same count)', () => {
  // Chaos is a swap: net zero change in totalMods. Pin: every
  // outcome state of a chaos transition from rare|0|6 has totalMods=6.
  const result = solveMDP({
    ...baseInput,
    ...baseRates,
    orbCosts: { ...baseRates.orbCosts, chaos: 6.3 },
    orbTimes: { ...baseRates.orbTimes, chaos: 1 },
  });
  // Locate any chaos-action edge in the chain — its destination's
  // totalMods must equal the source's totalMods.
  const chaosEdges = result.chain.edges.filter((e) =>
    /^chaos/.test((e.label ?? '').split('\n')[0]));
  assert.ok(chaosEdges.length > 0, 'expected chaos edges in the optimal chain');
  for (const e of chaosEdges) {
    const fromIdx = parseInt(e.from.replace(/^s/, ''), 10);
    const toIdx   = parseInt(e.to.replace(/^s/, ''), 10);
    const from = result.states[fromIdx];
    const to   = result.states[toIdx];
    assert.equal(to.state.totalMods, from.state.totalMods,
      `chaos transition ${e.from}→${e.to} should preserve totalMods; ${from.state.totalMods} → ${to.state.totalMods}`);
  }
});

test('V*(start) is strictly lower with Chaos available than without (rare|0|6 rescue)', () => {
  // Cleanest invariant: Chaos-in-action-set ≼ Chaos-absent in V*
  // terms, with strict inequality whenever the chaos path is at
  // all helpful. This sidesteps action-tie-breaks while still
  // pinning that Chaos genuinely buys the user something.
  const withChaos = solveMDP({
    ...baseInput,
    ...baseRates,
    orbCosts: { ...baseRates.orbCosts, chaos: 6.3 },
    orbTimes: { ...baseRates.orbTimes, chaos: 1 },
  });
  const withoutChaos = solveMDP({
    ...baseInput,
    ...baseRates,
  });
  assert.ok(withChaos.vStar < withoutChaos.vStar,
    `V*(start with chaos) = ${withChaos.vStar.toFixed(0)} should be < `
    + `V*(start without chaos) = ${withoutChaos.vStar.toFixed(0)} — `
    + `having chaos in the action set should never hurt and should help here`);
});

console.log(`\n${passed} passed · ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
