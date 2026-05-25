// MDP-ε: essences as deterministic Magic→Rare upgrades.
//
// Each essence applicable to the current item class becomes an MDP
// action whose `matchedKeys` lists the wishlist keys it sets at
// acceptable tier. Cost = essence price. Tier acceptance is binary
// (essence's tier band vs user's requiredTier) — Lesser/Normal essences
// won't satisfy a high-tier requirement; Greater/Perfect will.
//
// Tests pin:
//   1. Cheap matching essence ⇒ used as the Magic→Rare step (vs regal).
//   2. Non-matching essence ⇒ never picked (no wished bit advance).
//   3. Lesser essence below user's requiredTier ⇒ pAcceptable=0,
//      doesn't help even though the action is in the set.
//   4. Expensive essence over budget ⇒ excluded.
//   5. Multiple essences ⇒ engine picks the cheapest one whose tier
//      meets requirements.

import { strict as assert } from 'node:assert';
import { solveMDP } from '../engine/mdp/solve.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.message}`); }
}

console.log('MDP-ε tests — essences');

const baseInput = {
  wishlist: [{ key: 'PREFIX:# to maximum Life', weight: 1000, type: 'PREFIX', requiredTier: 2 }],
  irrelevantWeight: 50000,
  irrelevantWeightBySide: { PREFIX: 25000, SUFFIX: 25000 },
  target: { requiredMods: ['PREFIX:# to maximum Life'], minFilled: 1, maxFilled: 6 },
  start: { rarity: 'normal' },
  basePriceEx: 100,
  alchemyDraws: 4,
  maxFilled: 6,
  timeWeightExPerSec: 0,
  budgetEx: 10000,
};

const baseRates = {
  orbCosts: {
    transmute: 0.01, augment: 0.05, regal: 5,    // expensive regal so essence has a chance
    alch: 5, exalt: 1, annul: 0.5, fracturing: 50,
  },
  orbTimes: {
    transmute: 1, augment: 1, regal: 1,
    alch: 1, exalt: 1, annul: 1, fracturing: 3,
  },
};

test('cheap matching essence ⇒ used as Magic→Rare step', () => {
  // Greater Essence of the Body matches "# to maximum Life" wishlist
  // entry, guarantees the affix at acceptable tier (essenceTier=2,
  // requiredTier=2 ⇒ pAcceptable=1). Cheap (1 ex) so should beat
  // regal (5 ex) for the Magic→Rare step.
  const result = solveMDP({
    ...baseInput,
    ...baseRates,
    essences: [{
      id: 'essence_body_greater',
      name: 'Greater Essence of the Body',
      costEx: 1,
      timeSec: 1,
      matchedKeys: ['PREFIX:# to maximum Life'],
      pAcceptable: 1,
    }],
  });
  const policies = new Set([...result.policy.values()].filter(Boolean));
  assert.ok(policies.has('essence_body_greater'),
    `cheap matching essence should appear in optimal policy; got: ${[...policies]}`);
});

test('non-matching essence ⇒ never picked (no wished bit advance)', () => {
  // Essence whose matchedKeys is empty (e.g. essence affix doesn't
  // match any wishlist entry). The action is degenerate — same shape
  // as regal-into-irrelevant — and at higher cost than regal, never
  // optimal. Pin: not in policy.
  const result = solveMDP({
    ...baseInput,
    ...baseRates,
    essences: [{
      id: 'essence_nonmatching',
      name: 'Essence of Random Stat (non-matching)',
      // Cost > regal so the non-matching essence is strictly worse:
      // both produce a Rare with no wished bit (regal can also miss),
      // but regal additionally has a chance to LAND the wished bit.
      // Pricing the essence cheaper than regal would let it dominate
      // as a "cheap rare upgrade" stepping stone — that's a different
      // strategic question; this test pins the inferiority case only.
      costEx: 10,
      timeSec: 1,
      matchedKeys: [],               // no wishlist match
      pAcceptable: 1,
    }],
  });
  const policies = new Set([...result.policy.values()].filter(Boolean));
  assert.ok(!policies.has('essence_nonmatching'),
    `non-matching essence should not be picked; got: ${[...policies]}`);
});

test('Lesser essence below requiredTier ⇒ pAcceptable=0 ⇒ never sets wished bit', () => {
  // Lesser Essence (essenceTier=5) targeting a mod with requiredTier=2.
  // Adapter would set pAcceptable=0 — engine should never use this
  // essence to advance toward the goal, since the rolled tier never
  // qualifies. The action might still appear in the set (as a
  // deterministic Magic→Rare with-irrelevant-affix), but won't help.
  const result = solveMDP({
    ...baseInput,
    ...baseRates,
    essences: [{
      id: 'essence_body_lesser',
      name: 'Lesser Essence of the Body',
      costEx: 0.01,
      timeSec: 1,
      matchedKeys: ['PREFIX:# to maximum Life'],
      pAcceptable: 0,                // tier mismatch
    }],
  });
  // The wished bit can never be set via Lesser essence under tier
  // mismatch — no transition from any essence-action state has
  // modMask=1. (Verified indirectly: the wished bit is set ONLY by
  // single-draw orbs that pass tierAcceptance, not by Lesser
  // essence with pAcceptable=0.)
  const fromEssence = result.chain.edges
    .filter((e) => /essence_body_lesser/.test(e.label))
    .map((e) => result.chain.states.find((s) => s.id === e.to))
    .filter(Boolean);
  for (const dest of fromEssence) {
    assert.ok(!/mask=00000001/.test(dest.label),
      `Lesser essence with pAcceptable=0 should NOT reach a wished-bit-set state; got dest ${dest.label}`);
  }
});

test('expensive essence over budget ⇒ engine considers but routes around when alternative is cheaper', () => {
  // Per the budget-redesign (2026-05-10): total budget no longer
  // pre-filters actions. The engine considers the expensive essence
  // alongside cheaper orbs and chooses based on Q-values. A 5000-ex
  // essence vs cheap orb-roll alternatives ⇒ orb roll wins on cost.
  // budgetExcluded only fires when the optimal policy actually
  // recommends an over-budget action.
  const result = solveMDP({
    ...baseInput,
    ...baseRates,
    budgetEx: 100,                   // tight budget
    essences: [{
      id: 'essence_expensive',
      name: 'Perfect Essence of the Body',
      costEx: 5000,                  // way over budget
      timeSec: 1,
      matchedKeys: ['PREFIX:# to maximum Life'],
      pAcceptable: 1,
    }],
  });
  const policies = new Set([...result.policy.values()].filter(Boolean));
  assert.ok(!policies.has('essence_expensive'),
    `cheap orb-roll alternative dominates 5000-ex essence on Q; ` +
    `expensive essence must NOT be in optimal policy; got: ${[...policies]}`);
  // Engine routed around it ⇒ NOT in budgetExcluded.
  const excluded = result.budgetExcluded.find((e) => e.actionId === 'essence_expensive');
  assert.ok(!excluded,
    `essence is unused by the policy ⇒ should NOT appear in budgetExcluded; ` +
    `got: ${JSON.stringify(result.budgetExcluded)}`);
});

test('multiple essences ⇒ cheapest acceptable-tier one wins', () => {
  // Both essences match the wished mod and have pAcceptable=1. The
  // cheaper one should be used; the expensive one should not.
  const result = solveMDP({
    ...baseInput,
    ...baseRates,
    essences: [
      {
        id: 'essence_body_greater', name: 'Greater Essence of the Body',
        costEx: 1, timeSec: 1,
        matchedKeys: ['PREFIX:# to maximum Life'], pAcceptable: 1,
      },
      {
        id: 'essence_body_perfect', name: 'Perfect Essence of the Body',
        costEx: 100, timeSec: 1,
        matchedKeys: ['PREFIX:# to maximum Life'], pAcceptable: 1,
      },
    ],
  });
  const policies = new Set([...result.policy.values()].filter(Boolean));
  assert.ok(policies.has('essence_body_greater'),
    `cheaper essence should be picked; got: ${[...policies]}`);
  assert.ok(!policies.has('essence_body_perfect'),
    `more expensive equivalent essence should not be picked; got: ${[...policies]}`);
});

console.log(`\n${passed} passed · ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
