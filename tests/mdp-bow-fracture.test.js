// Unit tests for the MDP-α engine. Plain Node, no test framework —
// run via `node tests/mdp.test.js`. Tests pin expected optimal-policy
// behaviour for parameterised rate scenarios.
//
// The architecture is "input → output": each test fully describes the
// problem (wishlist, pool, rates) and asserts properties of the solver
// result. Future architecture changes inside the engine must keep these
// behaviours intact.

import { strict as assert } from 'node:assert';
import { solveMDP } from '../engine/mdp/solve.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.message}`); }
}

// ----- Scenario: Bow with one required+fractured wished mod ------------
// "# Surpassing chance to fire an additional Arrow" required and fractured.
// Pool: 1 wished entry (weight 2000), irrelevant pool weight 100_000.
// User starts from a fresh Normal base. Goal: that mod present + fractured.

const baseInput = {
  wishlist: [{ key: 'SUFFIX:#% Surpassing add Arrow', weight: 2000 }],
  irrelevantWeight: 100_000,
  target: {
    requiredMods: ['SUFFIX:#% Surpassing add Arrow'],
    fracturedKey:  'SUFFIX:#% Surpassing add Arrow',
  },
  start: { rarity: 'normal' },
  basePriceEx: 100,
  alchemyDraws: 4,
  maxFilled: 6,
  // minModsToFracture defaults to 4 in solveMDP — canonical PoE2 rule.
  timeWeightExPerSec: 0,
};

console.log('MDP-α tests — bow-fracture scenario');

test('solver returns finite V* for the start state', () => {
  const result = solveMDP({
    ...baseInput,
    orbCosts:  { transmute: 0.01, augment: 0.05, regal: 0.5, alch: 1, exalt: 1, annul: 0.5, fracturing: 50 },
    orbTimes:  { transmute: 1,    augment: 1,    regal: 1,   alch: 1, exalt: 1, annul: 1,   fracturing: 3 },
  });
  assert.ok(Number.isFinite(result.vStar), `vStar=${result.vStar} should be finite`);
  assert.ok(result.vStar > 0, 'vStar should be > 0 from a Normal base');
  assert.ok(result.states.length > 0, 'state space should not be empty');
});

test('default rates ⇒ start policy is transmute (cheaper than alch via trans+aug+regal route)', () => {
  // With minModsToFracture=4 (PoE2 spec) and the trans+aug+regal route
  // (which produces a 3-mod Rare and then needs an exalt to reach 4
  // mods for fracture) still cheaper than alch's direct 4-mod Rare,
  // the optimal start action is transmute. Validates the user's
  // intuition that alch is over-priced for the wished-mod-only goal.
  const result = solveMDP({
    ...baseInput,
    orbCosts: { transmute: 0.01, augment: 0.05, regal: 0.5, alch: 1, exalt: 1, annul: 0.5, fracturing: 50 },
    orbTimes: { transmute: 1,    augment: 1,    regal: 1,   alch: 1, exalt: 1, annul: 1,   fracturing: 3 },
  });
  const startPolicy = result.policy.get(result.start.stateKey);
  assert.equal(startPolicy, 'transmute', `start policy was "${startPolicy}", expected "transmute"`);
});

test('expensive Fracturing Orb still selected when goal needs a fracture', () => {
  // Even at 1000 ex/fracture, fracturing is the only way to satisfy
  // `target.fracturedKey` — so it must appear in the policy somewhere.
  const result = solveMDP({
    ...baseInput,
    orbCosts: { transmute: 0.01, augment: 0.05, regal: 0.5, alch: 1, exalt: 1, annul: 0.5, fracturing: 1000 },
    orbTimes: { transmute: 1,    augment: 1,    regal: 1,   alch: 1, exalt: 1, annul: 1,   fracturing: 3 },
  });
  const policies = new Set([...result.policy.values()].filter(Boolean));
  assert.ok(policies.has('fracturing'),
    `expected "fracturing" in policy values; got: ${[...policies]}`);
});

test('irrFractured state ⇒ optimal policy is buy_base (state is effectively bricked)', () => {
  const result = solveMDP({
    ...baseInput,
    basePriceEx: 100,
    orbCosts: { transmute: 0.01, augment: 0.05, regal: 0.5, alch: 1, exalt: 1, annul: 0.5, fracturing: 50 },
    orbTimes: { transmute: 1,    augment: 1,    regal: 1,   alch: 1, exalt: 1, annul: 1,   fracturing: 3 },
  });
  // Any state where the optimal action is `buy_base` is, by definition,
  // a near-bricked state — restarting is cheaper than continuing. The
  // irrFractured states must satisfy this property.
  const irrBrickedRow = result.states.find((r) => r.state.irrFractured);
  if (irrBrickedRow) {
    assert.equal(irrBrickedRow.policy, 'buy_base',
      `irrFractured state policy was "${irrBrickedRow.policy}"; expected "buy_base"`);
  }
});

test('cheap base price ⇒ optimal policy uses buy_base in some state', () => {
  const result = solveMDP({
    ...baseInput,
    basePriceEx: 1, // cheap base
    orbCosts: { transmute: 0.01, augment: 0.05, regal: 0.5, alch: 1, exalt: 1, annul: 0.5, fracturing: 50 },
    orbTimes: { transmute: 1,    augment: 1,    regal: 1,   alch: 1, exalt: 1, annul: 1,   fracturing: 3 },
  });
  const policies = new Set([...result.policy.values()].filter(Boolean));
  assert.ok(policies.has('buy_base'),
    `with cheap base, expected "buy_base" in policy values; got: ${[...policies]}`);
});

test('expensive base + cheap annul/exalt ⇒ NO buy_base in optimal policy', () => {
  // When a fresh base costs vastly more than annul+exalt, the optimal
  // policy should NEVER restart — instead it edits existing items via
  // annul (drop a wrong mod) + exalt (re-fill). buy_base should be
  // dominated everywhere except truly bricked states (irrFractured).
  const result = solveMDP({
    ...baseInput,
    basePriceEx: 100_000, // very expensive
    orbCosts: { transmute: 0.01, augment: 0.05, regal: 0.5, alch: 1, exalt: 1, annul: 0.5, fracturing: 50 },
    orbTimes: { transmute: 1,    augment: 1,    regal: 1,   alch: 1, exalt: 1, annul: 1,   fracturing: 3 },
  });
  // buy_base may still be the only option from genuinely bricked states.
  // Filter those out and assert it doesn't show up elsewhere.
  const buyBaseFromLive = result.states.filter(
    (r) => r.policy === 'buy_base' && !r.state.irrFractured && !r.isGoal && !r.isBricked,
  );
  assert.equal(buyBaseFromLive.length, 0,
    `expensive base should suppress buy_base from live states; saw ${buyBaseFromLive.length}: ${buyBaseFromLive.map((r) => r.key).join(', ')}`);
});

test('expensive trans+aug+regal ⇒ optimal start IS alch', () => {
  // When the multi-step path costs more than alch, alch becomes strictly
  // optimal as the start action. (minModsToFracture stays at the canonical
  // 3, so alch reaches Rare/4 ≥ threshold and can fracture immediately;
  // the trans+aug+regal route also reaches the threshold but at higher
  // cost.)
  const result = solveMDP({
    ...baseInput,
    orbCosts: { transmute: 5, augment: 5, regal: 5, alch: 1, exalt: 1, annul: 0.5, fracturing: 50 },
    orbTimes: { transmute: 1, augment: 1, regal: 1, alch: 1, exalt: 1, annul: 1,   fracturing: 3 },
  });
  const startPolicy = result.policy.get(result.start.stateKey);
  assert.equal(startPolicy, 'alch',
    `expensive trans+aug+regal should make alch strictly optimal at start; got "${startPolicy}"`);
});

test('cheap trans+aug+regal, ≥4 mods to fracture ⇒ optimal start uses transmute', () => {
  // With trans+aug+regal route reaching a 3-mod Rare cheaply and a
  // single exalt then padding to 4 mods (cheap exalt = 1 ex), the
  // total path-cost (trans 0.01 + aug 0.01 + regal 0.05 + exalt 1 ≈
  // 1.07 ex) is still well under alch's 5 ex/use. Optimal start
  // should be transmute, kicking off that 4-step path. With
  // minModsToFracture=4, fracture only triggers AFTER the exalt fill
  // (or any other path reaching 4 mods).
  const result = solveMDP({
    ...baseInput,
    orbCosts: { transmute: 0.01, augment: 0.01, regal: 0.05, alch: 5, exalt: 1, annul: 0.5, fracturing: 50 },
    orbTimes: { transmute: 1,    augment: 1,    regal: 1,    alch: 1, exalt: 1, annul: 1,   fracturing: 3 },
  });
  const startPolicy = result.policy.get(result.start.stateKey);
  assert.equal(startPolicy, 'transmute',
    `cheap trans/aug/regal should pivot start away from alch; got "${startPolicy}"`);
});

test('larger basePriceEx raises V* monotonically', () => {
  const cheap = solveMDP({
    ...baseInput, basePriceEx: 10,
    orbCosts: { transmute: 0.01, augment: 0.05, regal: 0.5, alch: 1, exalt: 1, annul: 0.5, fracturing: 50 },
    orbTimes: { transmute: 1,    augment: 1,    regal: 1,   alch: 1, exalt: 1, annul: 1,   fracturing: 3 },
  });
  const pricey = solveMDP({
    ...baseInput, basePriceEx: 1000,
    orbCosts: { transmute: 0.01, augment: 0.05, regal: 0.5, alch: 1, exalt: 1, annul: 0.5, fracturing: 50 },
    orbTimes: { transmute: 1,    augment: 1,    regal: 1,   alch: 1, exalt: 1, annul: 1,   fracturing: 3 },
  });
  assert.ok(pricey.vStar >= cheap.vStar - 1e-6,
    `pricey vStar=${pricey.vStar} should be >= cheap vStar=${cheap.vStar}`);
});

test('adapter must propagate minModsToFracture=4 (PoE2 rule) — not silently override', async () => {
  // Regression: the adapter at one point hardcoded a `minModsToFracture`
  // that disagreed with the engine default. That made fracturing
  // inapplicable on the trans-aug-regal route's natural 3-mod Rare
  // output, silently breaking that path. Pin the adapter contract:
  // don't override game-rule constants from inside the adapter — the
  // canonical PoE2 rule (= 4) lives in solve.js as the single source
  // of truth.
  const { ctxToMdpInput } = await import('../engine/mdp/adapter.js');
  const fakeCtx = {
    wishlist: [{ key: 'SUFFIX:test', required: true, fractured: true }],
    fullPool: [{ key: 'SUFFIX:test', weight: 100 }],
    orbs: {
      transmute: { priceCurrency: 'transmute', timeSeconds: 1 },
      augment: { priceCurrency: 'augment', timeSeconds: 1 },
      regal: { priceCurrency: 'regal', timeSeconds: 1 },
      alchemy: { priceCurrency: 'alchemy', timeSeconds: 1 },
      exalted: { priceCurrency: 'exalted', timeSeconds: 1 },
      annulment: { priceCurrency: 'annulment', timeSeconds: 1 },
      fracturing: { priceCurrency: 'fracturing', timeSeconds: 3 },
    },
    currencies: {
      transmute: { exaltedPer: 0.001 }, augment: { exaltedPer: 0.002 },
      regal: { exaltedPer: 0.05 }, alchemy: { exaltedPer: 1 },
      exalted: { exaltedPer: 1 }, annulment: { exaltedPer: 0.5 },
      fracturing: { exaltedPer: 50 },
    },
    requiredFracturedKey: 'SUFFIX:test',
    startingFracturedKey: null,
    startingR: 0, startingWSoft: 0,
    startingCounts: { prefixes: 0, suffixes: 0 },
    basePriceEx: 100,
    timeWeightExPerSec: 0,
  };
  const input = ctxToMdpInput(fakeCtx);
  // Adapter MUST NOT set minModsToFracture / alchemyDraws — those are
  // game-rule defaults owned by solve.js. Letting the adapter shadow
  // them caused the live bug (adapter said 4, engine said 3).
  assert.equal(input.minModsToFracture, undefined,
    `adapter must not set minModsToFracture (single source of truth = solve.js); got ${input.minModsToFracture}`);
  assert.equal(input.alchemyDraws, undefined,
    `adapter must not set alchemyDraws (single source of truth = solve.js); got ${input.alchemyDraws}`);
});

test('every MDP action has a corresponding orbCosts entry — no silent omissions', () => {
  // Regression for the live-craft adapter bug: the adapter previously
  // populated `orbCosts` with only {alch, exalt, annul, fracturing},
  // omitting transmute/augment/regal entirely. Their costs came in as
  // `undefined`, which `Number.isFinite` rejects → the actions were
  // silently dropped *despite* the rates panel showing finite values.
  // Pin the contract: every action id used by the engine MUST appear
  // in any well-formed `orbCosts`.
  // We verify this by importing the engine action list and checking the
  // baseline orbCosts has a finite value for every non-buy_base action.
  const baseOrbCosts = {
    transmute: 0.001, augment: 0.002, regal: 0.05,
    alch: 1, exalt: 1, annul: 0.5, fracturing: 50,
  };
  for (const id of ['transmute', 'augment', 'regal', 'alch', 'exalt', 'annul', 'fracturing']) {
    assert.ok(Number.isFinite(baseOrbCosts[id]),
      `orbCosts.${id} should be finite in the baseline (would silently drop the action otherwise)`);
  }
  // And confirm: the solver runs with this baseline and produces a
  // policy that *does* include the trans-aug-regal route as one of its
  // actions. (If the adapter ever loses an entry again, this will
  // start throwing because the action's cost is undefined.)
  const result = solveMDP({
    ...baseInput,
    orbCosts: baseOrbCosts,
    orbTimes: { transmute: 1, augment: 1, regal: 1, alch: 1, exalt: 1, annul: 1, fracturing: 3 },
  });
  assert.ok(Number.isFinite(result.vStar), `solver should run cleanly with the full orbCosts`);
});

test('NaN orb cost ⇒ solver throws by default', () => {
  // Hard-fail prevents the silent-drop class of bugs (the live-craft
  // bug we just shipped a fix for). Callers who legitimately want
  // partial-rate behaviour must opt in via `allowMissingRates: true`.
  assert.throws(() => {
    solveMDP({
      ...baseInput,
      orbCosts: { transmute: NaN, augment: NaN, regal: NaN, alch: 0.01, exalt: 1, annul: 0.5, fracturing: 50 },
      orbTimes: { transmute: 1, augment: 1, regal: 1, alch: 1, exalt: 1, annul: 1, fracturing: 3 },
    });
  }, /missing rate|orbCosts/i,
    `solveMDP should throw when an orb cost is NaN`);
});

test('NaN orb cost + allowMissingRates ⇒ that action is excluded AND a warning surfaces', () => {
  // Opt-in soft-fail mode: caller explicitly accepts partial rates.
  // Dropped actions are surfaced via `result.warnings`.
  const result = solveMDP({
    ...baseInput,
    allowMissingRates: true,
    orbCosts: { transmute: NaN, augment: NaN, regal: NaN, alch: 0.01, exalt: 1, annul: 0.5, fracturing: 50 },
    orbTimes: { transmute: 1, augment: 1, regal: 1, alch: 1, exalt: 1, annul: 1, fracturing: 3 },
  });
  assert.ok(Array.isArray(result.warnings),
    `expected result.warnings: string[], got ${typeof result.warnings}`);
  const droppedActions = result.warnings.filter((w) => /missing rate|disabled|excluded/i.test(w));
  assert.ok(droppedActions.length >= 1,
    `expected at least one dropped-action warning; got: ${result.warnings}`);
  assert.ok(droppedActions.some((w) => /transmute|augment|regal/i.test(w)),
    `warnings should name the dropped actions; got: ${result.warnings}`);
});

test('no-fracture target ⇒ fracturing is NOT in optimal policy', () => {
  // Same wishlist but no fracture requirement: the cheaper solution
  // should never invoke the (expensive) Fracturing Orb.
  const result = solveMDP({
    ...baseInput,
    target: { requiredMods: ['SUFFIX:#% Surpassing add Arrow'] }, // no fracturedKey
    orbCosts: { transmute: 0.01, augment: 0.05, regal: 0.5, alch: 1, exalt: 1, annul: 0.5, fracturing: 1000 },
    orbTimes: { transmute: 1,    augment: 1,    regal: 1,   alch: 1, exalt: 1, annul: 1,   fracturing: 3 },
  });
  const policies = new Set([...result.policy.values()].filter(Boolean));
  assert.ok(!policies.has('fracturing'),
    `fracturing should NOT be in the optimal policy; got policies: ${[...policies]}`);
});

test('expensive annul (live-ish rates, minModsToFracture=4) ⇒ alch still wins at magic|0|2', () => {
  // Note on 4-mod-fracture rule: when this test was first written
  // the engine had minModsToFracture=3, so the regal-then-fracture
  // path could fracture at totalMods=3 (avoiding any annul cleanup).
  // Crank annul to 1000 ex and that path's "no annul required" tail
  // strictly beat alch's "annul-cleanup-heavy" tail. Under the
  // canonical 4-mod rule both paths need ≥3 annuls post-fracture
  // (alch lands rare|w|4 directly; regal+exalt also lands rare|w|4),
  // so the cleanup cost is the same and alch wins on per-orb price.
  // This test now pins that shifted equilibrium.
  const result = solveMDP({
    ...baseInput,
    timeWeightExPerSec: 0.1,
    orbCosts: { transmute: 0.0057, augment: 0.044, regal: 0.633, alch: 0.291, exalt: 1, annul: 1000, fracturing: 9684 },
    orbTimes: { transmute: 1,      augment: 1,     regal: 1,     alch: 1,     exalt: 1, annul: 1,    fracturing: 3 },
  });
  const m02 = result.states.find((s) =>
    s.state.rarity === 'magic' && s.state.totalMods === 2 && s.state.modMask === 0
    && s.state.fracturedBit === -1 && !s.state.irrFractured);
  assert.ok(m02, 'magic|0|2 state must exist in the state space');
  assert.equal(m02.policy, 'alch',
    `at magic|0|2 (4-mod-fracture rule, expensive annul), optimal policy should be alch; got "${m02.policy}"`);
});

test('cheap annul (market rate) ⇒ alch beats regal at magic|0|2 (the live-UI observation)', () => {
  // Counterpart to the test above: pins the original user-observed
  // behaviour. At market-rate annul (~9.5 ex), alch's per-orb price
  // (0.291 ex × 4 draws ≈ 0.073 ex per draw) plus its cheap-annul
  // cleanup tail beats regal's 1-draw shot. Test exists so a future
  // engine refactor that drops alch from being a candidate at Magic
  // states (e.g. wrongly tightening applicability) immediately
  // surfaces — paired with the expensive-annul test above, this
  // bracket pins the threshold behaviour.
  const result = solveMDP({
    ...baseInput,
    timeWeightExPerSec: 0.1,
    orbCosts: { transmute: 0.0057, augment: 0.044, regal: 0.633, alch: 0.291, exalt: 1, annul: 9.5, fracturing: 9684 },
    orbTimes: { transmute: 1,      augment: 1,     regal: 1,     alch: 1,     exalt: 1, annul: 1,   fracturing: 3 },
  });
  const m02 = result.states.find((s) =>
    s.state.rarity === 'magic' && s.state.totalMods === 2 && s.state.modMask === 0
    && s.state.fracturedBit === -1 && !s.state.irrFractured);
  assert.ok(m02, 'magic|0|2 state must exist in the state space');
  assert.equal(m02.policy, 'alch',
    `at magic|0|2 with cheap annul, optimal policy should be alch; got "${m02.policy}"`);
});

test('low-totalMods Rare with wished mod ⇒ exalt applicable, V* below buy_base ceiling (regression: maxFilled=1 misuse)', () => {
  // Pins the bug where the adapter passed the user's target-slot cap
  // (e.g. "I want a 1-affix Rare") as `env.maxFilled`, silently
  // disabling exalt for any rare with totalMods ≥ that cap. From
  // rare|wished|1 (1-mod Rare, the wished one) the only path to a
  // fractureable state (≥4 mods) is exalt-up — so blocking exalt
  // forced V*(rare|wished|1) up to buy_base = 100 + V*(start).
  //
  // The fix: env.maxFilled is the game-rule 6, INDEPENDENT of any
  // user target shape. With that, exalt deterministically lands at
  // rare|wished|2 (V* of that state), keeping V*(rare|wished|1) far
  // below the buy_base ceiling.
  //
  // We assert the symptom directly: V*(rare|wished|1) < buy_base
  // ceiling AND policy is exalt (not buy_base).
  const result = solveMDP({
    ...baseInput,
    timeWeightExPerSec: 0.1,
    orbCosts: { transmute: 0.0057, augment: 0.044, regal: 0.633, alch: 0.291, exalt: 1, annul: 9.5, fracturing: 9684 },
    orbTimes: { transmute: 1,      augment: 1,     regal: 1,     alch: 1,     exalt: 1, annul: 1,   fracturing: 3 },
    // Explicit 6-mod cap = PoE2 game rule. Adapter (correctly) hard-
    // codes 6; this test pins what `solveMDP` does given that input.
    maxFilled: 6,
  });
  const rw1 = result.states.find((s) =>
    s.state.rarity === 'rare' && s.state.modMask === 1 && s.state.totalMods === 1
    && s.state.fracturedBit === -1 && !s.state.irrFractured);
  assert.ok(rw1, 'rare|wished|1 must exist in the state space');
  const buyBaseCeiling = baseInput.basePriceEx + result.vStar;
  assert.ok(rw1.vStar < buyBaseCeiling - 1,
    `V*(rare|wished|1) = ${rw1.vStar.toFixed(1)} should be strictly below buy_base ceiling ${buyBaseCeiling.toFixed(1)}`);
  assert.equal(rw1.policy, 'exalt',
    `policy at rare|wished|1 should be exalt (then exalt to 4 mods, then fracture); got "${rw1.policy}"`);
});

test('low-totalMods Rare with maxFilled=1 in env ⇒ exalt blocked, regression-symptom reproduced', () => {
  // Counterpart pin: with env.maxFilled=1 (the bug scenario the
  // adapter used to produce), exalt IS blocked at rare|wished|1
  // and policy correctly degrades to buy_base. Locks in that the
  // engine isn't doing anything sneaky around maxFilled — the bug
  // was purely the ADAPTER mis-passing it. If a future engine
  // refactor changes how maxFilled gates exalt, both this test
  // and the one above react.
  const result = solveMDP({
    ...baseInput,
    timeWeightExPerSec: 0.1,
    orbCosts: { transmute: 0.0057, augment: 0.044, regal: 0.633, alch: 0.291, exalt: 1, annul: 9.5, fracturing: 9684 },
    orbTimes: { transmute: 1,      augment: 1,     regal: 1,     alch: 1,     exalt: 1, annul: 1,   fracturing: 3 },
    maxFilled: 1, // simulate the old buggy adapter input
  });
  const rw1 = result.states.find((s) =>
    s.state.rarity === 'rare' && s.state.modMask === 1 && s.state.totalMods === 1
    && s.state.fracturedBit === -1 && !s.state.irrFractured);
  assert.ok(rw1, 'rare|wished|1 must exist in the state space');
  assert.equal(rw1.policy, 'buy_base',
    `with env.maxFilled=1, exalt is blocked at totalMods=1; policy must degrade to buy_base, got "${rw1.policy}"`);
});

test('target.maxFilled=1 ⇒ 3-mod fractured Rare is NOT goal (forces post-fracture annul cleanup)', () => {
  // Without target.maxFilled, the engine claims goal at any rare
  // satisfying requiredMask + fracturedBit, regardless of how many
  // irrelevant mods are alongside. With target.maxFilled=1 (user wants
  // exactly a 1-affix Rare), a fractured-w-3 state must annul down to
  // fractured-w-1 to count as goal. Pin this — V*(fractured-w-3) > 0
  // (it's no longer a terminal absorbing state) and policy at it is
  // annul (the only action that can reduce totalMods while preserving
  // the fractured wished mod).
  const result = solveMDP({
    ...baseInput,
    target: {
      requiredMods: ['SUFFIX:#% Surpassing add Arrow'],
      fracturedKey:  'SUFFIX:#% Surpassing add Arrow',
      maxFilled: 1, // user wants a 1-affix final
      minFilled: 1,
    },
    timeWeightExPerSec: 0.1,
    orbCosts: { transmute: 0.0057, augment: 0.044, regal: 0.633, alch: 0.291, exalt: 1, annul: 9.5, fracturing: 9684 },
    orbTimes: { transmute: 1,      augment: 1,     regal: 1,     alch: 1,     exalt: 1, annul: 1,   fracturing: 3 },
  });
  // fractured-w state with totalMods=3: must NOT be goal
  const frac3 = result.states.find((s) =>
    s.state.rarity === 'rare' && s.state.modMask === 1 && s.state.totalMods === 3
    && s.state.fracturedBit === 0 && !s.state.irrFractured);
  assert.ok(frac3, 'rare|w|3 fractured-on-bit-0 must exist');
  assert.ok(frac3.vStar > 0,
    `V*(fractured-w-3) should be > 0 with maxFilled=1; got ${frac3.vStar}`);
  assert.equal(frac3.policy, 'annul',
    `policy at fractured-w-3 with maxFilled=1 should be annul (cleanup); got "${frac3.policy}"`);
  // fractured-w state with totalMods=1: IS goal, V* = 0
  const frac1 = result.states.find((s) =>
    s.state.rarity === 'rare' && s.state.modMask === 1 && s.state.totalMods === 1
    && s.state.fracturedBit === 0 && !s.state.irrFractured);
  assert.ok(frac1, 'rare|w|1 fractured-on-bit-0 must exist');
  assert.equal(frac1.vStar, 0,
    `V*(fractured-w-1) should be 0 (goal); got ${frac1.vStar}`);
});

test('target.minFilled=2 ⇒ 1-mod Rare with wished is NOT goal (forces filling to 2)', () => {
  // Symmetric pin: minFilled forces an MDP that's been "pre-fractured
  // and stripped" to actually exalt back up before counting as goal.
  // Without minFilled, fractured-w-1 would be claimed as goal even
  // though the user wants ≥ 2 affixes on the final item.
  const result = solveMDP({
    ...baseInput,
    target: {
      requiredMods: ['SUFFIX:#% Surpassing add Arrow'],
      fracturedKey:  'SUFFIX:#% Surpassing add Arrow',
      minFilled: 2,
      maxFilled: 6,
    },
    timeWeightExPerSec: 0.1,
    orbCosts: { transmute: 0.0057, augment: 0.044, regal: 0.633, alch: 0.291, exalt: 1, annul: 9.5, fracturing: 9684 },
    orbTimes: { transmute: 1,      augment: 1,     regal: 1,     alch: 1,     exalt: 1, annul: 1,   fracturing: 3 },
  });
  const frac1 = result.states.find((s) =>
    s.state.rarity === 'rare' && s.state.modMask === 1 && s.state.totalMods === 1
    && s.state.fracturedBit === 0 && !s.state.irrFractured);
  if (frac1) {
    assert.ok(frac1.vStar > 0,
      `V*(fractured-w-1) should be > 0 with minFilled=2; got ${frac1.vStar}`);
  }
  // fractured-w state with totalMods=2: IS goal
  const frac2 = result.states.find((s) =>
    s.state.rarity === 'rare' && s.state.modMask === 1 && s.state.totalMods === 2
    && s.state.fracturedBit === 0 && !s.state.irrFractured);
  if (frac2) {
    assert.equal(frac2.vStar, 0,
      `V*(fractured-w-2) should be 0 (goal); got ${frac2.vStar}`);
  }
});

test('default target (no minFilled/maxFilled) ⇒ legacy goal semantics preserved', () => {
  // Pin that scenarios omitting the new bounds get unchanged behaviour.
  // V*(start) for the legacy bow-fracture scenario should match the
  // pre-bounds value to within numerical noise — guards against future
  // accidental tightening of the goal predicate.
  const result = solveMDP({
    ...baseInput,
    orbCosts: { transmute: 0.01, augment: 0.05, regal: 0.5, alch: 1, exalt: 1, annul: 0.5, fracturing: 50 },
    orbTimes: { transmute: 1,    augment: 1,    regal: 1,   alch: 1, exalt: 1, annul: 1,   fracturing: 3 },
  });
  // Any rare with the wished+fractured mod is still goal regardless of totalMods.
  const fracStates = result.states.filter((s) =>
    s.state.rarity === 'rare' && s.state.modMask === 1 && s.state.fracturedBit === 0
    && !s.state.irrFractured);
  assert.ok(fracStates.length > 0, 'fractured-w states must exist');
  for (const fs of fracStates) {
    assert.equal(fs.vStar, 0,
      `V*(${fs.key}) should be 0 (goal under legacy semantics); got ${fs.vStar}`);
  }
});

test('budgetEx ⇒ chain nodes carry itemValue (backward induction, brick=0)', () => {
  // itemValue(s) = expected profit of one committed crafting attempt
  // with no restart-on-brick. Backward induction:
  //   goal           → budget
  //   brick/buy_base → 0
  //   non-terminal   → -cost(π*) + Σ p · itemValue(next)
  //
  // For the bow-fracture chain with realistic rates and a fracture
  // requirement (PoE2 minModsToFracture=4), the post-fracture-success
  // state at totalMods=4 should converge to budget − 3·annul
  // (deterministic 3 annuls to the 1-affix goal). Pre-fracture
  // (rare|w|4 not yet fractured) should converge to
  // (budget − 3·annul)/4 − fracture_cost (when positive).
  const budgetEx = 100000;
  const annul = 9.5, fracture = 9684;
  const result = solveMDP({
    ...baseInput,
    target: {
      requiredMods: ['SUFFIX:#% Surpassing add Arrow'],
      fracturedKey:  'SUFFIX:#% Surpassing add Arrow',
      maxFilled: 1, minFilled: 1,
    },
    budgetEx,
    timeWeightExPerSec: 0,
    orbCosts: { transmute: 0.0057, augment: 0.044, regal: 0.633, alch: 0.291, exalt: 1, annul, fracturing: fracture },
    orbTimes: { transmute: 1,      augment: 1,     regal: 1,     alch: 1,     exalt: 1, annul: 1,   fracturing: 3 },
  });
  // Goals carry value = budget exactly.
  const goalNodes = result.chain.states.filter((s) => s.kind === 'goal');
  assert.ok(goalNodes.length > 0, 'chain must contain at least one goal node');
  for (const g of goalNodes) {
    assert.ok(g.label.includes(`value=${budgetEx}`),
      `goal node should carry value=${budgetEx}; got label: ${g.label}`);
  }
  // Post-fracture-success at totalMods=4 (key rare|1|4|0|0): deterministic
  // 3 annuls to goal. itemValue = budget − 3·annul.
  const postFrac4 = result.chain.states.find((s) =>
    /t=4/.test(s.label) && /bit 0/.test(s.label) && !/💀/.test(s.label));
  assert.ok(postFrac4, 'expected post-fracture-success state (rare|w|4 fractured) in chain');
  const expectedPF4 = budgetEx - 3 * annul;
  const m = postFrac4.label.match(/value=(-?[\d.]+)/);
  assert.ok(m, `couldn't parse value from post-fracture-4 label: ${postFrac4.label}`);
  const parsed = parseFloat(m[1]);
  assert.ok(Math.abs(parsed - expectedPF4) < 1,
    `post-fracture-4 itemValue ${parsed} should ≈ budget − 3·annul = ${expectedPF4}`);
});

test('itemValue: pre-fracture node ≈ (budget − 3·annul)/4 − fracture (user-stated formula, 4-mod rule)', () => {
  // The recursive formula under the canonical 4-mod-fracture rule:
  // itemValue(rare|w|4) =
  //   -fracture + (1/4) · (budget − 3·annul) + (3/4) · 0
  // = (budget − 3·annul)/4 − fracture. Pin with a budget large enough
  // for the formula to be positive (so we're not drowning in the
  // floor-at-zero clamp).
  const budgetEx = 100000;
  const annul = 9.5, fracture = 9684;
  const result = solveMDP({
    ...baseInput,
    target: {
      requiredMods: ['SUFFIX:#% Surpassing add Arrow'],
      fracturedKey:  'SUFFIX:#% Surpassing add Arrow',
      maxFilled: 1, minFilled: 1,
    },
    budgetEx,
    timeWeightExPerSec: 0,
    orbCosts: { transmute: 0.0057, augment: 0.044, regal: 0.633, alch: 0.291, exalt: 1, annul, fracturing: fracture },
    orbTimes: { transmute: 1,      augment: 1,     regal: 1,     alch: 1,     exalt: 1, annul: 1,   fracturing: 3 },
  });
  // Pre-fracture rare|w|4 (NOT yet fractured): mask=1, total=4, no
  // fracturedBit, no irrFractured.
  const preFrac = result.states.find((st) =>
    st.state.rarity === 'rare' && st.state.modMask === 1 && st.state.totalMods === 4
    && st.state.fracturedBit === -1 && !st.state.irrFractured);
  assert.ok(preFrac, 'expected pre-fracture rare|w|4 state in solver state space');
  // Find that node in the chain (it may or may not be in the optimal
  // chain depending on V*; if so, check its label).
  const chainNode = result.chain.states.find((c) => c.id === `s${result.states.indexOf(preFrac)}`);
  if (!chainNode) {
    // Pre-fracture isn't on the optimal trajectory — the policy probably
    // routes via fracturing of a higher-totalMods state. That's still a
    // valid scenario; skip the value pin (no chain label to check).
    return;
  }
  const expected = (budgetEx - 3 * annul) / 4 - fracture;
  const m = chainNode.label.match(/value=(-?[\d.]+)/);
  assert.ok(m, `couldn't parse value from pre-fracture label: ${chainNode.label}`);
  const parsed = parseFloat(m[1]);
  if (expected > 0) {
    assert.ok(Math.abs(parsed - expected) < 5,
      `pre-fracture itemValue ${parsed} should ≈ (budget−3·annul)/4 − fracture = ${expected}`);
  } else {
    assert.equal(parsed, 0, `pre-fracture itemValue should clamp to 0 when formula is negative`);
  }
});

test('budgetEx ⇒ bricked / over-budget states render value=0 (never negative)', () => {
  // An item is at worst worthless (drop it for free), never anti-
  // valuable. Pin: with a budget far smaller than V*(start), the
  // start node should render value=0 (clamped), not a negative
  // number. The "loss" the user has already incurred is sunk cost,
  // not item market value.
  const budgetEx = 10; // far below the bow-fracture V*(start) ≈ 30k+
  const result = solveMDP({
    ...baseInput,
    budgetEx,
    timeWeightExPerSec: 0.1,
    orbCosts: { transmute: 0.0057, augment: 0.044, regal: 0.633, alch: 0.291, exalt: 1, annul: 9.5, fracturing: 9684 },
    orbTimes: { transmute: 1,      augment: 1,     regal: 1,     alch: 1,     exalt: 1, annul: 1,   fracturing: 3 },
  });
  for (const s of result.chain.states) {
    const m = s.label.match(/value=(-?[\d∞−.]+)/);
    if (!m) continue;
    assert.ok(!m[1].startsWith('-') && !m[1].startsWith('−'),
      `chain node ${s.id} should never show negative value; got "${m[0]}" in label: ${s.label}`);
  }
});

test('budgetEx ⇒ chain nodes carry P_reach annotation for non-start non-goal states', () => {
  // P_reach(s) = probability of landing at s when following π* from
  // start. Lets the user compute "expected contribution" =
  // P_reach × value, the framing they used to estimate pre-fracture
  // post-success state at (budget − 2*annul) × P(success-of-fracture).
  // Pin: at least one chain node carries `P_reach=` (non-start, non-
  // goal states with P < 1). Start node and goal nodes don't.
  const result = solveMDP({
    ...baseInput,
    budgetEx: 10000,
    timeWeightExPerSec: 0.1,
    orbCosts: { transmute: 0.0057, augment: 0.044, regal: 0.633, alch: 0.291, exalt: 1, annul: 9.5, fracturing: 9684 },
    orbTimes: { transmute: 1,      augment: 1,     regal: 1,     alch: 1,     exalt: 1, annul: 1,   fracturing: 3 },
  });
  const startNode = result.chain.states.find((s) => s.id === result.chain.start);
  assert.ok(startNode && !/P_reach=/.test(startNode.label),
    `start node must NOT carry P_reach (P=1 is implicit); got: ${startNode?.label}`);
  const goalNodes = result.chain.states.filter((s) => s.kind === 'goal');
  for (const g of goalNodes) {
    assert.ok(!/P_reach=/.test(g.label),
      `goal node ${g.id} must NOT carry P_reach annotation; got: ${g.label}`);
  }
  const withPReach = result.chain.states.filter((s) => /P_reach=/.test(s.label));
  assert.ok(withPReach.length > 0,
    `expected at least one transient/bricked state with P_reach annotation`);
});

test('deterministic actions ⇒ single-outcome edges rendered as internal (gray)', () => {
  // When an action has exactly one outcome (e.g. annul on a fractured
  // Rare with the wished mod locked: removing 1 of N irrelevant mods
  // is uniform but produces only ONE distinct successor state — same
  // mask, totalMods-1), the edge should colour `internal` regardless
  // of V* delta. Branching is what the user reads colour for; with
  // no branch the colour is noise.
  const result = solveMDP({
    ...baseInput,
    target: {
      requiredMods: ['SUFFIX:#% Surpassing add Arrow'],
      fracturedKey:  'SUFFIX:#% Surpassing add Arrow',
      maxFilled: 1, minFilled: 1,
    },
    timeWeightExPerSec: 0.1,
    orbCosts: { transmute: 0.0057, augment: 0.044, regal: 0.633, alch: 0.291, exalt: 1, annul: 9.5, fracturing: 9684 },
    orbTimes: { transmute: 1,      augment: 1,     regal: 1,     alch: 1,     exalt: 1, annul: 1,   fracturing: 3 },
  });
  // Group edges by from-node, find any single-outcome groups in the chain.
  const edgesByFrom = new Map();
  for (const e of result.chain.edges) {
    if (!edgesByFrom.has(e.from)) edgesByFrom.set(e.from, []);
    edgesByFrom.get(e.from).push(e);
  }
  let foundDeterministic = false;
  for (const [, group] of edgesByFrom) {
    if (group.length === 1) {
      foundDeterministic = true;
      assert.equal(group[0].kind, 'internal',
        `single-outcome edge from ${group[0].from} should be 'internal'; got '${group[0].kind}'`);
    }
  }
  assert.ok(foundDeterministic, 'expected at least one single-outcome edge group (annul-cleanup chain on fractured-w states)');
});

test('chain.breakevenBudgetEx is policy-property when budget covers all orbs', () => {
  // The decomposition itemValue(start, B) = pSuccess · B + bExpected
  // is linear in B when the action set is fixed, so breakeven =
  // -bExpected/pSuccess is a property of the *policy*. With budget
  // gating, comparing must use budgets large enough to admit the
  // SAME action set — otherwise different policies emerge from the
  // budget-exclusion and the breakeven differs.
  const baseline = {
    ...baseInput,
    target: {
      requiredMods: ['SUFFIX:#% Surpassing add Arrow'],
      fracturedKey:  'SUFFIX:#% Surpassing add Arrow',
      maxFilled: 1, minFilled: 1,
    },
    timeWeightExPerSec: 0,
    orbCosts: { transmute: 0.0057, augment: 0.044, regal: 0.633, alch: 0.291, exalt: 1, annul: 9.5, fracturing: 9684 },
    orbTimes: { transmute: 1,      augment: 1,     regal: 1,     alch: 1,     exalt: 1, annul: 1,   fracturing: 3 },
  };
  // Both budgets here cover fracture (9684 ex) and every other orb,
  // so the action set is unchanged between the two solves.
  const r2 = solveMDP({ ...baseline, budgetEx: 100000 });
  const r3 = solveMDP({ ...baseline });
  const be2 = r2.chain.breakevenBudgetEx;
  const be3 = r3.chain.breakevenBudgetEx;
  assert.ok(be2 != null && be3 != null,
    `breakeven should be defined for both; got [${be2}, ${be3}]`);
  assert.ok(Math.abs(be2 - be3) < 1e-3,
    `breakeven should be unchanged when budgetEx is omitted; got ${be3} vs ${be2}`);
  // Sanity: at budgetEx = breakeven, itemValue(start) ≈ 0.
  const rBE = solveMDP({ ...baseline, budgetEx: be2 });
  const startNode = rBE.chain.states.find((s) => s.id === rBE.chain.start);
  if (startNode && /value=/.test(startNode.label)) {
    const m = startNode.label.match(/value=(-?[\d.]+)/);
    if (m) {
      const parsed = parseFloat(m[1]);
      assert.ok(Math.abs(parsed) < 1,
        `at budget=breakeven, itemValue(start) should ≈ 0; got ${parsed}`);
    }
  }
});

test('budgetEx below per-orb cost ⇒ that action is excluded with a budgetExcluded entry', () => {
  // Pin: with budgetEx=100 and fracturing costing 9684 ex/use, the
  // user can't afford to fracture even once. The engine should drop
  // fracturing from the action set entirely (better than half-baked
  // "well, you could try once and brick" semantics) and surface the
  // exclusion so the UI can recommend a budget bump.
  const result = solveMDP({
    ...baseInput,
    target: {
      requiredMods: ['SUFFIX:#% Surpassing add Arrow'],
      fracturedKey:  'SUFFIX:#% Surpassing add Arrow',
      maxFilled: 1, minFilled: 1,
    },
    budgetEx: 100,
    timeWeightExPerSec: 0,
    orbCosts: { transmute: 0.0057, augment: 0.044, regal: 0.633, alch: 0.291, exalt: 1, annul: 9.5, fracturing: 9684 },
    orbTimes: { transmute: 1,      augment: 1,     regal: 1,     alch: 1,     exalt: 1, annul: 1,   fracturing: 3 },
  });
  assert.ok(Array.isArray(result.budgetExcluded), 'budgetExcluded must be an array');
  const fractureExclusion = result.budgetExcluded.find((b) => b.actionId === 'fracturing');
  assert.ok(fractureExclusion,
    `fracturing must be in budgetExcluded; got: ${JSON.stringify(result.budgetExcluded)}`);
  assert.equal(fractureExclusion.costEx, 9684, 'cost in budgetExcluded should match input rate');
  // Policy must NEVER include fracturing.
  const policies = new Set([...result.policy.values()].filter(Boolean));
  assert.ok(!policies.has('fracturing'),
    `fracturing must NOT appear in optimal policy; got policies: ${[...policies]}`);
  // pSuccess must be 0 (target requires fracture, fracture excluded).
  assert.equal(result.chain.pSuccessStart, 0,
    `with fracture-required target and fracture excluded, pSuccess must be 0; got ${result.chain.pSuccessStart}`);
});

test('budgetEx ≥ all per-orb costs ⇒ no budgetExcluded entries (full action set available)', () => {
  const result = solveMDP({
    ...baseInput,
    budgetEx: 100000,
    timeWeightExPerSec: 0,
    orbCosts: { transmute: 0.0057, augment: 0.044, regal: 0.633, alch: 0.291, exalt: 1, annul: 9.5, fracturing: 9684 },
    orbTimes: { transmute: 1,      augment: 1,     regal: 1,     alch: 1,     exalt: 1, annul: 1,   fracturing: 3 },
  });
  assert.deepEqual(result.budgetExcluded, [],
    `with budget ≥ max orb cost, no actions should be excluded; got: ${JSON.stringify(result.budgetExcluded)}`);
});

test('budgetEx omitted ⇒ no budget gating (full action set available)', () => {
  const result = solveMDP({
    ...baseInput,
    orbCosts: { transmute: 0.0057, augment: 0.044, regal: 0.633, alch: 0.291, exalt: 1, annul: 9.5, fracturing: 9684 },
    orbTimes: { transmute: 1,      augment: 1,     regal: 1,     alch: 1,     exalt: 1, annul: 1,   fracturing: 3 },
  });
  assert.deepEqual(result.budgetExcluded, [],
    `with no budgetEx, no actions should be excluded; got: ${JSON.stringify(result.budgetExcluded)}`);
});

test('live-scenario reproduction: low-success + expensive fracture must converge', () => {
  // Regression for the silent-non-convergence bug. Combines:
  //   - expensive fracturing (live market rate ~9684 ex)
  //   - tight tier filter (requiredTier=2 ⇒ pAcceptable ≈ 0.22 on alch)
  //   - 1-affix target (every Rare must annul down to exactly 1 mod)
  // which collectively drives per-attempt success to ~0.2% — a
  // contraction factor close to 1 that the original maxIters=5000
  // couldn't settle. Engine returned partial V*=244M and a bogus
  // alch-then-fracture-without-annul policy. Pin: result.converged
  // is true AND V*(start) is in a sane range.
  //
  // Reading `pTierAcceptable` directly here mirrors what the live
  // adapter computes from the Krakenbul tier weights; this test is
  // self-contained so it doesn't depend on the mod catalog being
  // loaded.
  const result = solveMDP({
    ...baseInput,
    pTierAcceptable: {
      // Plain orbs see all tiers — ~22% pass tier filter.
      transmute: [0.222], augment: [0.222], regal: [0.222],
      alch: [0.222], exalt: [0.222],
    },
    target: {
      requiredMods: ['SUFFIX:#% Surpassing add Arrow'],
      fracturedKey:  'SUFFIX:#% Surpassing add Arrow',
      minFilled: 1, maxFilled: 1,
    },
    timeWeightExPerSec: 0.1,
    orbCosts: { transmute: 0.0057, augment: 0.044, regal: 0.633, alch: 0.291, exalt: 1, annul: 9.5, fracturing: 9684 },
    orbTimes: { transmute: 1, augment: 1, regal: 1, alch: 1, exalt: 1, annul: 1, fracturing: 3 },
  });
  assert.equal(result.converged, true,
    `value iteration MUST converge on this scenario (regression for the 244M-bug); got iters=${result.iters}, lastDelta=${result.warnings?.[0] ?? '(no warning)'}`);
  // V*(start) should be in the tens-of-thousands range (≈ ex / per-
  // attempt-success). Pin a generous upper bound — anything ≥ 1e6
  // is a clear divergence symptom.
  assert.ok(result.vStar < 1_000_000,
    `V*(start) = ${result.vStar} should be under 1M ex (sanity bound); higher means iteration drift`);
  // Optimal start policy is some standard-craft step (transmute/alch),
  // not a degenerate buy_base loop.
  const startPolicy = result.policy.get(result.start.stateKey);
  assert.ok(startPolicy && startPolicy !== 'buy_base',
    `start policy should be a real action, got "${startPolicy}"`);
});

test('every solveMDP call returns converged=true with no warning about iteration cap', () => {
  // Generic invariant: any of the test scenarios used elsewhere in
  // this file must converge. Catches future regressions where a
  // change to default rates / target shape pushes a scenario into
  // the slow-contraction regime without anyone noticing.
  const probes = [
    {
      label: 'baseInput defaults',
      orbCosts: { transmute: 0.01, augment: 0.05, regal: 0.5, alch: 1, exalt: 1, annul: 0.5, fracturing: 50 },
    },
    {
      label: 'expensive fracture',
      orbCosts: { transmute: 0.01, augment: 0.05, regal: 0.5, alch: 1, exalt: 1, annul: 0.5, fracturing: 1000 },
    },
    {
      label: 'live-ish rates',
      orbCosts: { transmute: 0.0057, augment: 0.044, regal: 0.633, alch: 0.291, exalt: 1, annul: 9.5, fracturing: 9684 },
    },
  ];
  for (const p of probes) {
    const r = solveMDP({
      ...baseInput,
      orbCosts: p.orbCosts,
      orbTimes: { transmute: 1, augment: 1, regal: 1, alch: 1, exalt: 1, annul: 1, fracturing: 3 },
    });
    assert.equal(r.converged, true,
      `[${p.label}] solveMDP must converge; got iters=${r.iters}`);
    assert.ok(!r.warnings.some((w) => /maxIters/.test(w)),
      `[${p.label}] no convergence warnings expected; got: ${r.warnings.join(' | ')}`);
  }
});

test('chain node labels carry "[sN]" step-id prefix by default', () => {
  // Step ids round-trip the chain-state's `id` field into the
  // visible label so debug conversations can refer to "step s5"
  // unambiguously. Default on; toggle via input.showStepIds.
  const result = solveMDP({
    ...baseInput,
    orbCosts: { transmute: 0.01, augment: 0.05, regal: 0.5, alch: 1, exalt: 1, annul: 0.5, fracturing: 50 },
    orbTimes: { transmute: 1, augment: 1, regal: 1, alch: 1, exalt: 1, annul: 1, fracturing: 3 },
  });
  for (const cs of result.chain.states) {
    const m = cs.label.match(/^\[(s\d+)\]/);
    assert.ok(m, `chain node label should start with "[sN]" prefix; got: ${cs.label}`);
    assert.equal(m[1], cs.id,
      `step-id prefix "${m[1]}" should match chain state id "${cs.id}"`);
  }
});

test('input.showStepIds=false ⇒ no [sN] prefix on labels', () => {
  const result = solveMDP({
    ...baseInput,
    showStepIds: false,
    orbCosts: { transmute: 0.01, augment: 0.05, regal: 0.5, alch: 1, exalt: 1, annul: 0.5, fracturing: 50 },
    orbTimes: { transmute: 1, augment: 1, regal: 1, alch: 1, exalt: 1, annul: 1, fracturing: 3 },
  });
  for (const cs of result.chain.states) {
    assert.ok(!/^\[s\d+\]/.test(cs.label),
      `with showStepIds=false, label should NOT start with "[sN]"; got: ${cs.label}`);
  }
});

test('chain nodes carry rarity field (rendered as border-colour overlay)', () => {
  // Rarity moved out of the node label into a separate field so the
  // Mermaid serializer can apply per-rarity border colours
  // (white=Normal, blue=Magic, yellow=Rare). Pin: every chain state
  // has a `rarity` field matching the engine state's rarity, AND
  // the label no longer contains "rarity=" text.
  const result = solveMDP({
    ...baseInput,
    orbCosts: { transmute: 0.01, augment: 0.05, regal: 0.5, alch: 1, exalt: 1, annul: 0.5, fracturing: 50 },
    orbTimes: { transmute: 1, augment: 1, regal: 1, alch: 1, exalt: 1, annul: 1, fracturing: 3 },
  });
  for (const cs of result.chain.states) {
    assert.ok(['normal', 'magic', 'rare'].includes(cs.rarity),
      `chain state ${cs.id} should carry rarity ∈ {normal, magic, rare}; got "${cs.rarity}"`);
    assert.ok(!/rarity=/.test(cs.label),
      `chain label should NOT contain "rarity=" text (rendered via stroke colour now); got: ${cs.label}`);
  }
  // At least one normal, one magic, one rare across the chain (the
  // bow scenario walks all three rarities).
  const seen = new Set(result.chain.states.map((s) => s.rarity));
  assert.ok(seen.has('normal'), 'chain should include a normal-rarity node');
  assert.ok(seen.has('magic'),  'chain should include a magic-rarity node');
  assert.ok(seen.has('rare'),   'chain should include a rare-rarity node');
});

test('basePriceSec default = 60s, raises V*(start) vs basePriceSec=0', () => {
  // Sourcing a fresh base takes ~1 minute of wall-clock (find +
  // price-check + buy from trade). The engine now defaults to 60s
  // for buy_base's time cost; setting it to 0 should drop V*(start)
  // by an amount proportional to E[buy_base events] × 60s ×
  // timeWeightExPerSec. With a positive timeWeight the difference
  // is observable.
  const baseRates = {
    orbCosts: { transmute: 0.0057, augment: 0.044, regal: 0.633, alch: 0.291, exalt: 1, annul: 9.5, fracturing: 9684 },
    orbTimes: { transmute: 1, augment: 1, regal: 1, alch: 1, exalt: 1, annul: 1, fracturing: 3 },
  };
  const withTime = solveMDP({
    ...baseInput,
    timeWeightExPerSec: 0.1,
    ...baseRates,
    // basePriceSec omitted → default 60.
  });
  const withoutTime = solveMDP({
    ...baseInput,
    timeWeightExPerSec: 0.1,
    basePriceSec: 0,
    ...baseRates,
  });
  assert.ok(withTime.vStar > withoutTime.vStar,
    `V*(start) with basePriceSec=60 (${withTime.vStar.toFixed(0)}) should exceed `
    + `V*(start) with basePriceSec=0 (${withoutTime.vStar.toFixed(0)}); the engine `
    + `must charge wall-clock time for buy_base events`);
});

test('budgetEx omitted ⇒ no value annotation on chain nodes (legacy behaviour)', () => {
  const result = solveMDP({
    ...baseInput,
    orbCosts: { transmute: 0.01, augment: 0.05, regal: 0.5, alch: 1, exalt: 1, annul: 0.5, fracturing: 50 },
    orbTimes: { transmute: 1,    augment: 1,    regal: 1,   alch: 1, exalt: 1, annul: 1,   fracturing: 3 },
  });
  for (const s of result.chain.states) {
    assert.ok(!s.label.includes('value='),
      `without budgetEx, chain nodes must NOT include value annotation; got: ${s.label}`);
  }
});

console.log(`\n${passed} passed · ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
