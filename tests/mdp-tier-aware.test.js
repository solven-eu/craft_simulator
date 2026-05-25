// MDP-γ: tier-aware action selection.
//
// Per (orb, wished mod) pair, the adapter precomputes
// pTierAcceptable[orbId][i] = P(this orb, having drawn wished mod i,
// lands at an acceptable tier per the user's per-mod requirement). The
// engine looks up that probability per draw — no scalar "qBoost"
// multiplier or runtime clamping. All tier-filter logic lives in the
// adapter where game data (mod tier weights × orb tier filter) is
// available.
//
// Tests pin the qualitative pivots:
//   1. pTierAcceptable defaulted to all-1 ⇒ MDP-γ ≡ MDP-α (legacy).
//   2. Tighter pTierAcceptable on plain orb ⇒ V* rises.
//   3. Plain orb tier-restricted + Perfect orb tier-OK ⇒ Perfect picked.
//   4. Perfect over-budget ⇒ excluded, plain falls back even if worse.

import { strict as assert } from 'node:assert';
import { solveMDP } from '../engine/mdp/solve.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.message}`); }
}

console.log('MDP-γ tests — tier-aware');

const baseInput = {
  wishlist: [{ key: 'WISH', weight: 2000 }],
  irrelevantWeight: 100_000,
  target: { requiredMods: ['WISH'] },
  start: { rarity: 'normal' },
  basePriceEx: 100,
  alchemyDraws: 4,
  maxFilled: 6,
  timeWeightExPerSec: 0,
};

test('no pTierAcceptable ⇒ MDP-γ ≡ MDP-α legacy', () => {
  const r1 = solveMDP({
    ...baseInput,
    orbCosts: { transmute: 0.01, augment: 0.05, regal: 0.5, alch: 1, exalt: 1, annul: 0.5, fracturing: 50 },
    orbTimes: { transmute: 1, augment: 1, regal: 1, alch: 1, exalt: 1, annul: 1, fracturing: 3 },
  });
  // Identical input plus a no-op pTierAcceptable that maps every orb to all-1.
  const r2 = solveMDP({
    ...baseInput,
    pTierAcceptable: {
      transmute: [1], augment: [1], regal: [1], alch: [1], exalt: [1],
    },
    orbCosts: { transmute: 0.01, augment: 0.05, regal: 0.5, alch: 1, exalt: 1, annul: 0.5, fracturing: 50 },
    orbTimes: { transmute: 1, augment: 1, regal: 1, alch: 1, exalt: 1, annul: 1, fracturing: 3 },
  });
  assert.ok(Math.abs(r1.vStar - r2.vStar) < 1e-6,
    `pTierAcceptable=all-1 should match legacy; got ${r2.vStar} vs ${r1.vStar}`);
});

test('plain orbs tier-restricted ⇒ V* significantly higher than unrestricted', () => {
  // pTierAcceptable=0.25 on every plain orb means only 1 in 4 wished
  // landings counts (sub-tier landings consume the slot but don't set
  // the bit). Total expected cost should rise — exact ratio depends
  // on which orbs get used in the optimal policy.
  const ratesAndTimes = {
    orbCosts: { transmute: 0.01, augment: 0.05, regal: 0.5, alch: 1, exalt: 1, annul: 0.5, fracturing: 50 },
    orbTimes: { transmute: 1, augment: 1, regal: 1, alch: 1, exalt: 1, annul: 1, fracturing: 3 },
  };
  const rOpen = solveMDP({ ...baseInput, ...ratesAndTimes });
  const rTight = solveMDP({
    ...baseInput,
    pTierAcceptable: {
      transmute: [0.25], augment: [0.25], regal: [0.25], alch: [0.25], exalt: [0.25],
    },
    ...ratesAndTimes,
  });
  assert.ok(rTight.vStar > rOpen.vStar * 1.5,
    `pTierAcceptable=0.25 should push V* > 1.5× baseline; got ${rTight.vStar} vs ${rOpen.vStar}`);
});

test('plain orbs tier=0 + Perfect Exalt tier=1 ⇒ Perfect Exalt in optimal policy', () => {
  // Plain Exalt can never land an acceptable tier (pTierAcceptable=0).
  // Perfect Exalt always lands acceptable (pTierAcceptable=1). At a
  // reasonable Perfect Exalt cost the policy must use it — there's
  // literally no other way to set the wished bit on a Rare.
  const result = solveMDP({
    ...baseInput,
    pTierAcceptable: {
      transmute: [0], augment: [0], regal: [0], alch: [0],
      exalt: [0], exalt_perfect: [1],
    },
    orbCosts: {
      transmute: 0.01, augment: 0.05, regal: 0.5, alch: 1,
      exalt: 1, exalt_perfect: 5,
      annul: 0.5, fracturing: 50,
    },
    orbTimes: {
      transmute: 1, augment: 1, regal: 1, alch: 1,
      exalt: 1, exalt_perfect: 1,
      annul: 1, fracturing: 3,
    },
  });
  const policies = new Set([...result.policy.values()].filter(Boolean));
  assert.ok(policies.has('exalt_perfect'),
    `exalt_perfect should appear in optimal policy when plain orbs can't reach acceptable tier; got: ${[...policies]}`);
});

test('Perfect Exalt over budget ⇒ engine routes around it via cheaper plain Exalt', () => {
  // Per the budget-redesign (2026-05-10): total budget no longer
  // pre-filters actions. Plain exalt (cost 1, geometric retry @ 0.5
  // acceptance ⇒ ~2 ex per success) dominates exalt_perfect (cost 200
  // for guaranteed-acceptable). The engine routes around the
  // expensive variant on Q, not because of budget. budgetExcluded
  // only fires when the optimal policy actually depends on the
  // over-budget action.
  const result = solveMDP({
    ...baseInput,
    budgetEx: 100,
    pTierAcceptable: {
      transmute: [0.5], augment: [0.5], regal: [0.5], alch: [0.5],
      exalt: [0.5], exalt_perfect: [1],
    },
    orbCosts: {
      transmute: 0.01, augment: 0.05, regal: 0.5, alch: 1,
      exalt: 1, exalt_perfect: 200,
      annul: 0.5, fracturing: 50,
    },
    orbTimes: {
      transmute: 1, augment: 1, regal: 1, alch: 1,
      exalt: 1, exalt_perfect: 1,
      annul: 1, fracturing: 3,
    },
  });
  const policies = new Set([...result.policy.values()].filter(Boolean));
  assert.ok(!policies.has('exalt_perfect'),
    `cheaper plain exalt dominates on Q ⇒ exalt_perfect must NOT be in policy; ` +
    `got policies: ${[...policies]}`);
  // Engine routed around it ⇒ NOT in budgetExcluded.
  const excluded = result.budgetExcluded.find((e) => e.actionId === 'exalt_perfect');
  assert.ok(!excluded,
    `exalt_perfect is unused by the policy ⇒ should NOT appear in budgetExcluded; ` +
    `got: ${JSON.stringify(result.budgetExcluded)}`);
});

test('Perfect Regal preferred when its tier-acceptance dominates plain Regal', () => {
  const result = solveMDP({
    ...baseInput,
    pTierAcceptable: {
      transmute: [0.1], augment: [0.1],
      regal: [0.1], regal_perfect: [1],
      alch: [0.1], exalt: [0.1],
    },
    orbCosts: {
      transmute: 0.01, augment: 0.05,
      regal: 0.5, regal_perfect: 1,
      alch: 1, exalt: 1, annul: 0.5, fracturing: 50,
    },
    orbTimes: {
      transmute: 1, augment: 1,
      regal: 1, regal_perfect: 1,
      alch: 1, exalt: 1, annul: 1, fracturing: 3,
    },
  });
  const policies = new Set([...result.policy.values()].filter(Boolean));
  assert.ok(policies.has('regal_perfect'),
    `regal_perfect should be picked when its tier-acceptance is strictly better; got: ${[...policies]}`);
});

console.log(`\n${passed} passed · ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
