// Regression: `minDesireScore` is the "Σ desire-score must be ≥ N"
// goal clause (per project memory `required-plus-desire-score`).
// The engine's goal check must enforce it; otherwise a state with
// only irrelevant affixes is accepted as goal whenever minFilled is
// satisfied — defeating the purpose of the score gate.
//
// User report (2026-05-25, live craft inspection):
//   Boots (DEX/INT), wishlist = +# to maximum Life (soft, score 1),
//   minFilled=1, minDesireScore=1. Engine's chain shows BOTH "Magic
//   with Life" AND "Magic with irrelevant affix" as goals → the
//   transmute step alone "satisfies" the craft, no augment/regal/
//   essence ever evaluated. minDesireScore was never plumbed from
//   store → ctx → input.target, so the engine treated it as 0.

import { strict as assert } from 'node:assert';
import { solveMDP } from '../engine/mdp/solve.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.message}`); }
}

console.log('MDP — minDesireScore goal clause');

const baseInput = {
  wishlist: [{
    key: 'PREFIX:# to maximum Life',
    weight: 1000,
    type: 'PREFIX',
    score: 1,
    tierScores: { 1: 1, 2: 1, 3: 1, 4: 1, 5: 1 },
  }],
  irrelevantWeight: 33000,
  irrelevantWeightBySide: { PREFIX: 16500, SUFFIX: 16500 },
  start: { rarity: 'normal' },
  basePriceEx: 40,
  alchemyDraws: 4,
  maxFilled: 6,
  timeWeightExPerSec: 0,
  budgetEx: 10000,
  orbCosts: {
    transmute: 0.01, augment: 0.02, regal: 0.06,
    alch: 0.43, exalt: 1, annul: 0.5, fracturing: 50,
  },
  orbTimes: {
    transmute: 1, augment: 1, regal: 1,
    alch: 1, exalt: 1, annul: 1, fracturing: 3,
  },
};

test('minDesireScore=0 ⇒ any single affix satisfies goal (legacy)', () => {
  // Pre-fix behaviour: with score gate at 0, a Magic state with any
  // single (possibly irrelevant) affix passes the goal check. Pin
  // it so we don't regress the unconstrained case.
  const result = solveMDP({
    ...baseInput,
    target: { requiredMods: [], minFilled: 1, maxFilled: 6, minDesireScore: 0 },
  });
  const goalStates = result.states.filter((s) => s.isGoal);
  const goalWithoutLife = goalStates.filter((s) =>
    s.state.rarity === 'magic' && s.state.totalMods === 1 && s.state.modMask === 0);
  assert.ok(goalWithoutLife.length > 0,
    'with minDesireScore=0, Magic-with-irrelevant-affix must remain a valid goal');
});

test('minDesireScore=1 ⇒ Magic state with irrelevant affix is NOT goal', () => {
  // The bug: even with minDesireScore=1, the engine accepted Magic-
  // with-irrelevant as goal because the score clause wasn't enforced.
  const result = solveMDP({
    ...baseInput,
    target: { requiredMods: [], minFilled: 1, maxFilled: 6, minDesireScore: 1 },
  });
  const irrelevantMagic = result.states.find((s) =>
    s.state.rarity === 'magic' && s.state.totalMods === 1 && s.state.modMask === 0);
  if (irrelevantMagic) {
    assert.equal(irrelevantMagic.isGoal, false,
      `Magic state with only an irrelevant affix must NOT be goal under minDesireScore=1; ` +
      `got isGoal=${irrelevantMagic.isGoal}`);
  }
  // The reachable Magic-with-Life state IS goal (1 wished mod present,
  // score 1 = minDesireScore=1).
  const lifeMagic = result.states.find((s) =>
    s.state.rarity === 'magic' && s.state.modMask === 1);
  if (lifeMagic) {
    assert.equal(lifeMagic.isGoal, true,
      `Magic state with the wished Life affix must be goal under minDesireScore=1; ` +
      `got isGoal=${lifeMagic.isGoal}`);
  }
});

test('minDesireScore=1 ⇒ optimal policy advances past first transmute', () => {
  // Concrete consequence of the goal clause: the policy must take
  // MORE than one step (transmute → augment → ... → goal-with-Life)
  // when the score gate is non-zero, since transmute alone can't
  // guarantee the wished mod lands.
  const result = solveMDP({
    ...baseInput,
    target: { requiredMods: [], minFilled: 1, maxFilled: 6, minDesireScore: 1 },
  });
  // Find the start state's policy.
  const start = result.states[result.startIdx];
  assert.ok(start, 'expected a start state');
  // The optimal start action's resulting state(s) must NOT include
  // a Magic-irrelevant goal — that was the bug surface.
  // We pin: chain has more than 2 transient steps OR the engine
  // routes through actions that target Life specifically (essence /
  // augment-regal cycle).
  const policies = new Set([...result.policy.values()].filter(Boolean));
  // Either an essence or a multi-step orb chain — the key invariant
  // is "more than just transmute" because transmute alone has a 97%
  // miss probability and a missed transmute state isn't goal anymore.
  const hasMultiStepEvidence = policies.size >= 2
    || [...policies].some((p) => /essence|augment|regal/.test(p));
  assert.ok(hasMultiStepEvidence,
    `with minDesireScore=1 the policy must do more than transmute; got actions: ${[...policies]}`);
});

console.log(`\n${passed} passed · ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
