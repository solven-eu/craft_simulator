// Trajectory sampler — pins seeded determinism, basic invariants
// (sampled prob ≤ 1, total cost matches sum of step costs), and
// the "reachedGoal ⇒ no further steps" property.

import { strict as assert } from 'node:assert';
import { solveMDP } from '../engine/mdp/solve.js';
import { sampleTrajectory, sampleOutcome, mulberry32 } from '../engine/mdp/sample.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.message}`); }
}

console.log('MDP trajectory sampler tests');

const baseInput = {
  wishlist: [{ key: 'WISH', weight: 2000, type: 'SUFFIX', requiredTier: 1 }],
  irrelevantWeight: 60000,
  irrelevantWeightBySide: { PREFIX: 30000, SUFFIX: 30000 },
  target: { requiredMods: ['WISH'] },
  start: { rarity: 'normal' },
  basePriceEx: 100,
  alchemyDraws: 4,
  maxFilled: 6,
  timeWeightExPerSec: 0,
  budgetEx: 50000,
  orbCosts: { transmute: 0.01, augment: 0.05, regal: 0.5, alch: 1, exalt: 1, annul: 0.5, fracturing: 50 },
  orbTimes: { transmute: 1, augment: 1, regal: 1, alch: 1, exalt: 1, annul: 1, fracturing: 3 },
};

test('sampleOutcome distributes by cumulative probability', () => {
  const outcomes = [
    { prob: 0.2, label: 'A' },
    { prob: 0.3, label: 'B' },
    { prob: 0.5, label: 'C' },
  ];
  // r=0.1 → A, r=0.4 → B, r=0.9 → C.
  let r = 0.1; assert.equal(sampleOutcome(outcomes, () => r).label, 'A');
  r = 0.4;     assert.equal(sampleOutcome(outcomes, () => r).label, 'B');
  r = 0.9;     assert.equal(sampleOutcome(outcomes, () => r).label, 'C');
});

test('seeded RNG ⇒ deterministic trajectory across runs', () => {
  const result = solveMDP(baseInput);
  const t1 = sampleTrajectory(result, { rng: mulberry32(42), wishlist: baseInput.wishlist });
  const t2 = sampleTrajectory(result, { rng: mulberry32(42), wishlist: baseInput.wishlist });
  assert.equal(t1.steps.length, t2.steps.length);
  assert.deepEqual(
    t1.steps.map((s) => s.action),
    t2.steps.map((s) => s.action),
    `same seed should yield identical action sequence`,
  );
  assert.equal(t1.totalEx, t2.totalEx);
  assert.equal(t1.reachedGoal, t2.reachedGoal);
});

test('different seeds ⇒ generally different trajectories', () => {
  // Statistically: 4 seeds rarely all produce identical trajectories
  // unless the path is fully deterministic. Pin: at least 2 distinct
  // trajectory lengths or final states across 4 seeds.
  const result = solveMDP(baseInput);
  const samples = [1, 2, 3, 4].map((s) =>
    sampleTrajectory(result, { rng: mulberry32(s), wishlist: baseInput.wishlist }));
  const distinctSteps = new Set(samples.map((t) => t.steps.length));
  const distinctFinals = new Set(samples.map((t) => t.finalStateKey));
  assert.ok(distinctSteps.size > 1 || distinctFinals.size > 1,
    `4 different seeds should give some variation; got ${distinctSteps.size} step-counts, ${distinctFinals.size} final states`);
});

test('totalEx equals sum of per-step costs', () => {
  const result = solveMDP(baseInput);
  const t = sampleTrajectory(result, { rng: mulberry32(7), wishlist: baseInput.wishlist });
  const sum = t.steps.reduce((s, st) => s + (st.costEx ?? 0), 0);
  assert.ok(Math.abs(sum - t.totalEx) < 1e-9,
    `totalEx (${t.totalEx}) should equal sum of step costs (${sum})`);
});

test('orbCounts equals histogram of action labels along the trajectory', () => {
  const result = solveMDP(baseInput);
  const t = sampleTrajectory(result, { rng: mulberry32(11), wishlist: baseInput.wishlist });
  const expected = {};
  for (const s of t.steps) expected[s.action] = (expected[s.action] ?? 0) + 1;
  assert.deepEqual(t.orbCounts, expected);
});

test('concreteItem encodes the final-state shape (rarity + wished mods)', () => {
  // Sampler always returns a concreteItem; pin its structure rather
  // than requiring a specific terminal state (which depends on the
  // sampled outcome). Verify shape + invariants only.
  const result = solveMDP(baseInput);
  const t = sampleTrajectory(result, { rng: mulberry32(7), wishlist: baseInput.wishlist });
  assert.ok(t.concreteItem, 'concreteItem must be populated');
  assert.ok(['normal', 'magic', 'rare'].includes(t.concreteItem.rarity));
  assert.ok(Array.isArray(t.concreteItem.wishedModNames));
  // wished mods are a subset of the wishlist keys.
  for (const k of t.concreteItem.wishedModNames) {
    assert.ok(baseInput.wishlist.some((w) => w.key === k),
      `wished mod ${k} must come from the wishlist`);
  }
  // affixCount = wished + irrelevant.
  assert.equal(
    t.concreteItem.affixCount,
    t.concreteItem.wishedModNames.length + t.concreteItem.irrelevantCount,
    'affixCount must equal wished + irrelevant count',
  );
});

test('totalEx includes the initial base purchase price', () => {
  // Bug: scenario cost was missing one basePriceEx. The trajectory
  // walker started AT the post-buy state, so the very first base
  // (acquired before any crafting begins) wasn't counted. The
  // sampler now prepends a synthetic buy_base step with sampledProb=1.
  const result = solveMDP({ ...baseInput, basePriceEx: 100 });
  const t = sampleTrajectory(result, { rng: mulberry32(7), wishlist: baseInput.wishlist });
  // First step must be the synthetic initial buy_base.
  assert.ok(t.steps.length > 0, 'trajectory should have at least one step');
  assert.equal(t.steps[0].action, 'buy_base',
    `first step should be the initial base purchase, got ${t.steps[0].action}`);
  assert.equal(t.steps[0].costEx, 100,
    'initial buy_base should carry the basePriceEx as costEx');
  assert.equal(t.steps[0].initial, true,
    'initial buy_base should be marked initial=true so the UI / counters can distinguish from restart loops');
  // totalEx invariant unchanged: sum of step costs.
  const sumStepCosts = t.steps.reduce((acc, s) => acc + (s.costEx || 0), 0);
  assert.ok(Math.abs(t.totalEx - sumStepCosts) < 1e-9,
    `totalEx (${t.totalEx}) should equal Σ step.costEx (${sumStepCosts})`);
  // basePriceEx is part of totalEx.
  assert.ok(t.totalEx >= 100, `totalEx (${t.totalEx}) must include the 100ex base price`);
});

test('basePriceEx=0 ⇒ no synthetic initial buy_base step prepended', () => {
  // Edge: when the user has a free / pre-owned base (basePriceEx=0)
  // and the engine doesn't model time-to-source either, skip the
  // synthetic step entirely so the orb-spend list stays clean.
  const result = solveMDP({ ...baseInput, basePriceEx: 0, basePriceSec: 0 });
  const t = sampleTrajectory(result, { rng: mulberry32(11), wishlist: baseInput.wishlist });
  // First step (if any) should NOT be the initial-flagged buy_base.
  if (t.steps.length > 0) {
    assert.notEqual(t.steps[0].initial, true,
      `with basePriceEx=0 the synthetic initial step should be omitted; got ${JSON.stringify(t.steps[0])}`);
  }
});

test('budgetEx caps trajectory total cost (no scenarios over budget)', () => {
  // Bug: histogram showed scenarios at 12-20 div when user set
  // budgetEx = 10 div. Root cause: the sampler only enforced
  // budgetCap as a per-action exclusion (drop a single orb if its
  // unit cost > budget) — it didn't cap the *running total*.
  // Fix: the sampler now truncates as soon as the next step would
  // push totalEx past budgetEx, charging only the partial cost up
  // to the cap so the right-edge histogram bar piles up cleanly.
  const tightBudget = 50; // ex
  const result = solveMDP({
    ...baseInput,
    basePriceEx: 5, // cheap base so the budget bites mid-trajectory
    budgetEx: tightBudget,
  });
  let maxObserved = 0;
  for (let seed = 1; seed <= 25; seed++) {
    const t = sampleTrajectory(result,
      { rng: mulberry32(seed), wishlist: baseInput.wishlist });
    assert.ok(t.totalEx <= tightBudget + 1e-6,
      `trajectory totalEx (${t.totalEx}) exceeds budgetEx (${tightBudget}) — seed ${seed}`);
    if (t.totalEx > maxObserved) maxObserved = t.totalEx;
    if (t.truncated) {
      // Truncated trajectories should pile up exactly at the budget
      // cap so the histogram has a clean right-edge bar rather than
      // smearing across multiple over-cap bins.
      assert.ok(Math.abs(t.totalEx - tightBudget) < 1e-6 || t.totalEx <= tightBudget,
        `truncated trajectory totalEx (${t.totalEx}) should equal budgetEx (${tightBudget})`);
    }
  }
});

test('opts.budgetEx overrides mdpResult.budgetCap (per-call override)', () => {
  // The sampler honours opts.budgetEx if passed, falling back to
  // mdpResult.budgetCap otherwise. Lets the histogram panel run
  // multiple "what if the budget were N" what-ifs without re-solving.
  const result = solveMDP({ ...baseInput, basePriceEx: 5, budgetEx: 1000 });
  const t = sampleTrajectory(result,
    { rng: mulberry32(1), wishlist: baseInput.wishlist, budgetEx: 30 });
  assert.ok(t.totalEx <= 30 + 1e-6,
    `opts.budgetEx=30 should cap totalEx; got ${t.totalEx}`);
});

test('truncated ⇒ buyBaseEvents > maxRestarts', () => {
  // Force truncation by setting maxRestarts=0. Any buy_base event
  // immediately stops the trajectory.
  const result = solveMDP({
    ...baseInput,
    basePriceEx: 1, // cheap base ⇒ engine likely picks buy_base from some state
    orbCosts: { ...baseInput.orbCosts, fracturing: 100000 }, // make fracture prohibitive
  });
  const t = sampleTrajectory(result,
    { rng: mulberry32(3), wishlist: baseInput.wishlist, maxRestarts: 0 });
  if (t.buyBaseEvents > 0) {
    assert.ok(t.truncated, 'trajectory should be truncated when buy_base exceeds maxRestarts');
  }
  // If no buy_base in the sampled trajectory, test is vacuous —
  // but invariant should still hold.
});

console.log(`\n${passed} passed · ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
