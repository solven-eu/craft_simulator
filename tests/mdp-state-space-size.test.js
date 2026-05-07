// Diagnostic test file: count reachable states across a matrix of
// scenarios, each restricting the action set + wishlist composition
// so explosions are easy to localise.
//
// Each scenario reports `states.length` (BFS-reachable from start
// under the optimal policy build). The numbers are *measured*, not
// asserted tight — the goal is to surface "this scenario should be
// tiny but is huge" anomalies during code review. A loose ceiling
// (per scenario) trips CI when a regression blows past sane bounds.
//
// Reading the output:
//   - Tiny scenarios (a handful of orbs, N=1) should produce O(10)
//     states. Anything ≥ 100 means the engine is materialising
//     invalid or duplicate equivalence-class states.
//   - Wider scenarios are bounded by a back-of-envelope physical
//     state count: see the comments per scenario for derivations.
//   - When this file fails, the new state count tells you which
//     action's transition introduced the bug.

import { strict as assert } from 'node:assert';
import { solveMDP } from '../engine/mdp/solve.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.message}`); }
}

console.log('MDP state-space size — per scenario');

// ─── Common fixture builder ────────────────────────────────────────
// Each scenario is a small recipe: which wishlist, which orbs,
// optionally bone / essences. Excluding an orb is done by leaving
// its cost out (NaN ⇒ silently skipped by solveMDP).
function buildInput({
  wishlist = [{ key: 'WISH_A', weight: 1000, type: 'PREFIX' }],
  orbs = ['transmute'],         // names from orbCosts table
  start = { rarity: 'normal' },
  target = null,                // overrides default { requiredMods: [first wished], minFilled: 1, maxFilled: 6 }
  irrelevantWeight = 50000,
  irrelevantWeightBySide = { PREFIX: 25000, SUFFIX: 25000 },
  basePriceEx = 100,
  budgetEx = 10000,
  boneCostEx = NaN,
  pBoneRevealHit = [],
  pBoneRevealHitPrefix = [],
  pBoneRevealHitSuffix = [],
  pBoneRevealHitAbyssal = [],
  essences = undefined,
  alchemyDraws = 4,
  maxFilled = 6,
} = {}) {
  // Default rates table — we set ALL costs to a finite default so
  // every variant exists. The `orbs` filter then NaNs the ones we
  // want excluded.
  const defaultCosts = {
    transmute: 0.01, augment: 0.05, regal: 0.5, alch: 1,
    exalt: 1, annul: 9.5, fracturing: 50, chaos: 5,
    transmute_greater: NaN, transmute_perfect: NaN,
    augment_greater: NaN, augment_perfect: NaN,
    regal_greater: NaN, regal_perfect: NaN,
    regal_sinistral: NaN, regal_dextral: NaN,
    exalt_greater: NaN, exalt_perfect: NaN,
    exalt_sinistral: NaN, exalt_dextral: NaN,
    chaos_greater: NaN, chaos_perfect: NaN,
    reveal_bone: 0, reveal_bone_sinistral: NaN, reveal_bone_dextral: NaN,
    reveal_bone_abyssal: NaN, annul_omen_of_light: NaN,
  };
  const defaultTimes = Object.fromEntries(Object.keys(defaultCosts).map((k) => [k, 1]));
  // Apply orb filter: NaN any cost not in the allow-list.
  const orbCosts = { ...defaultCosts };
  if (orbs && orbs.length) {
    const allow = new Set(orbs);
    for (const k of Object.keys(orbCosts)) {
      if (!allow.has(k)) orbCosts[k] = NaN;
    }
  }
  const tgt = target ?? {
    requiredMods: [wishlist[0].key],
    minFilled: 1, maxFilled,
  };
  const input = {
    wishlist,
    irrelevantWeight,
    irrelevantWeightBySide,
    target: tgt,
    start,
    basePriceEx, alchemyDraws, maxFilled,
    timeWeightExPerSec: 0, budgetEx,
    orbCosts, orbTimes: defaultTimes,
    boneCostEx, pBoneRevealHit, pBoneRevealHitPrefix,
    pBoneRevealHitSuffix, pBoneRevealHitAbyssal,
    // Diagnostic: skip missing rates silently so each scenario only
    // exercises the orbs in its allow-list (the rest are NaN'd above).
    allowMissingRates: true,
  };
  if (essences) input.essences = essences;
  return input;
}

function countStates(scenario, opts) {
  const result = solveMDP(buildInput(opts));
  return result.states.length;
}

// Pin the structural invariants on every state in the BFS: no
// negative counts, no overshoots past the game-rule caps. When the
// engine produces an invalid state (e.g. annul of a phantom prefix
// when prefixMods is unmaintained upstream) the BFS materialises
// it and its descendants — leading to the explosion the user saw.
// This test runs against a scenario known to exercise every
// dimension; failures pinpoint which transition broke an invariant.
function assertStateInvariants(label, opts, maxFilled = 6) {
  const result = solveMDP(buildInput({ ...opts, maxFilled }));
  const violations = [];
  for (const r of result.states) {
    const s = r.state;
    if ((s.prefixMods ?? 0) < 0)         violations.push(`${label}: prefixMods=${s.prefixMods} < 0 (state ${JSON.stringify(s)})`);
    if ((s.prefixMods ?? 0) > 3)         violations.push(`${label}: prefixMods=${s.prefixMods} > 3 (state ${JSON.stringify(s)})`);
    if (s.totalMods < 0)                 violations.push(`${label}: totalMods=${s.totalMods} < 0`);
    if (s.totalMods > maxFilled)         violations.push(`${label}: totalMods=${s.totalMods} > maxFilled (state ${JSON.stringify(s)})`);
    if ((s.totalMods - (s.prefixMods ?? 0)) < 0) violations.push(`${label}: suffixMods<0`);
    if ((s.totalMods - (s.prefixMods ?? 0)) > 3) violations.push(`${label}: suffixMods>3 (state ${JSON.stringify(s)})`);
    if ((s.desecratedCount ?? 0) < 0)    violations.push(`${label}: desecratedCount<0`);
    if ((s.desecratedCount ?? 0) > s.totalMods) violations.push(`${label}: desecratedCount>totalMods`);
    if ((s.desecratedPrefixCount ?? 0) > (s.desecratedCount ?? 0)) violations.push(`${label}: desecratedPrefixCount>desecratedCount`);
  }
  if (violations.length) throw new Error(violations.slice(0, 5).join('\n'));
}

// ─── Scenarios ─────────────────────────────────────────────────────

// Default goal for these scenarios: require the first wished mod.
// Without a non-trivial requirement, the Normal/0 start trivially
// satisfies a `requiredMods=[]` target ⇒ start is goal ⇒ 1 state.
const REQ_FIRST = { requiredMods: ['WISH_A'], minFilled: 1, maxFilled: 6 };

// (A) Trivial: empty start, only transmute. Reaches normal|0,
// magic|1 + per-mask-outcome. With N=1 wished, magic|1 has at most
// 2 outcomes (wished bit set vs not).
test('A. N=1, transmute only ⇒ a handful of states', () => {
  const n = countStates('A', {
    orbs: ['transmute'],
    target: REQ_FIRST,
  });
  console.log(`     states=${n}`);
  assert.ok(n < 50, `transmute-only should be ≪ 50 states; got ${n}`);
});

// (B) Magic→Rare ladder (transmute, augment, regal). N=1.
// State count grows with totalMods 0..3 + side branching.
test('B. N=1, transmute+augment+regal ⇒ tens of states', () => {
  const n = countStates('B', {
    orbs: ['transmute', 'augment', 'regal'],
    target: REQ_FIRST,
  });
  console.log(`     states=${n}`);
  assert.ok(n < 200, `Magic→Rare ladder should stay under 200 states; got ${n}`);
});

// (C) Rare with exalt only. N=1. State space is rare|*|1..6 × side
// distributions. 6 totalMods × ~4 prefixMods × 2 modMask ≈ 50 states.
test('C. N=1, rare-start exalt only ⇒ ≲ 100 states', () => {
  const n = countStates('C', {
    orbs: ['exalt'],
    start: { rarity: 'rare', modsOnItem: ['WISH_A'], totalMods: 1 },
    // Force the chain to play out — require min 6 mods so exalt
    // must fire repeatedly. Otherwise start is trivially goal.
    target: { requiredMods: ['WISH_A'], minFilled: 6, maxFilled: 6 },
  });
  console.log(`     states=${n}`);
  assert.ok(n < 200, `exalt-only on rare should be ≲ 200 states; got ${n}`);
});

// (D) Annul only on a rare. N=1. annul decrements totalMods; without
// the prefixMods underflow bug, state count = totalMods 0..6 × side
// distributions ≈ 30.
test('D. N=1, rare-start annul only ⇒ ≲ 60 states', () => {
  const n = countStates('D', {
    orbs: ['annul'],
    start: { rarity: 'rare', modsOnItem: ['WISH_A'], totalMods: 4 },
    // Goal: clean down to a 1-mod fractured-style item. Annul is
    // the only tool, so the chain plays out fully.
    target: { requiredMods: ['WISH_A'], minFilled: 1, maxFilled: 1 },
  });
  console.log(`     states=${n}`);
  assert.ok(n < 200, `annul-only on rare should be ≲ 200 states; got ${n}. ` +
    `Larger counts indicate prefixMods going negative on annul of irrelevant ` +
    `slots when prefixMods is unmaintained upstream.`);
});

// (E) Exalt + annul cycle (the canonical "fracture-anchor cleanup"
// idiom). N=1. Bounded by reachable rare|*|1..6 × side splits.
test('E. N=1, rare-start exalt+annul ⇒ ≲ 200 states', () => {
  const n = countStates('E', {
    orbs: ['exalt', 'annul'],
    start: { rarity: 'rare', modsOnItem: ['WISH_A'], totalMods: 4 },
    target: { requiredMods: ['WISH_A'], minFilled: 6, maxFilled: 6 },
  });
  console.log(`     states=${n}`);
  assert.ok(n < 500, `exalt+annul on rare should be ≲ 500 states; got ${n}`);
});

// (F) Chaos only on a rare. N=1. Chaos is the highest-fan-out orb
// (remove × add product). Risk of explosion if the side-aware
// branching multiplies past the bounded valid domain.
test('F. N=1, rare-start chaos only ⇒ ≲ 300 states', () => {
  // Start without the wished mod so chaos has to swap until it
  // lands. Highest-fan-out single orb in our action set.
  const n = countStates('F', {
    orbs: ['chaos'],
    start: { rarity: 'rare', modsOnItem: [], totalMods: 4 },
    target: { requiredMods: ['WISH_A'], minFilled: 1, maxFilled: 6 },
  });
  console.log(`     states=${n}`);
  assert.ok(n < 500, `chaos-only on rare should be ≲ 500 states; got ${n}. ` +
    `Higher counts indicate (remove,add) tuples generating invalid ` +
    `(prefixMods, totalMods) combinations.`);
});

// (G) Bone-trick: apply_bone + reveal_bone. N=1.
test('G. N=1, rare-start apply_bone+reveal_bone ⇒ ≲ 200 states', () => {
  const n = countStates('G', {
    orbs: ['exalt'],            // priced so the engine has at least one non-bone orb
    start: { rarity: 'rare', modsOnItem: ['WISH_A'], totalMods: 3 },
    target: { requiredMods: ['WISH_A'], minFilled: 4, maxFilled: 6 },
    boneCostEx: 0.5,
    pBoneRevealHit: [0],         // wished not in desecrated pool
  });
  console.log(`     states=${n}`);
  assert.ok(n < 500, `bone-trick scenario should be ≲ 500 states; got ${n}. ` +
    `Higher counts indicate reveal_bone bumping totalMods past maxFilled, ` +
    `or apply_bone+exalt+reveal chains overshooting.`);
});

// (H) N=2, transmute only. Adds a second wished mod (different
// side); modMask cardinality grows from 2 to 4 but state count
// should stay small.
test('H. N=2 mixed-side, transmute only ⇒ a handful of states', () => {
  const n = countStates('H', {
    wishlist: [
      { key: 'WISH_P', weight: 1000, type: 'PREFIX' },
      { key: 'WISH_S', weight: 1000, type: 'SUFFIX' },
    ],
    orbs: ['transmute'],
    target: { requiredMods: ['WISH_P', 'WISH_S'], minFilled: 1, maxFilled: 6 },
  });
  console.log(`     states=${n}`);
  assert.ok(n < 60, `N=2 transmute-only should be ≪ 60 states; got ${n}`);
});

// (I) N=2 mixed-side, all standard orbs. The full action set on a
// 2-mod wishlist. This is the user-reported regression scenario.
// Realistic reachable set should be a few thousand states, not
// millions.
test('I. N=2 mixed-side, all standard orbs ⇒ ≲ 10 K states', () => {
  const n = countStates('I', {
    wishlist: [
      { key: 'WISH_P', weight: 1000, type: 'PREFIX' },
      { key: 'WISH_S', weight: 1000, type: 'SUFFIX' },
    ],
    orbs: ['transmute', 'augment', 'regal', 'alch', 'exalt', 'annul', 'chaos'],
    target: { requiredMods: ['WISH_P', 'WISH_S'], minFilled: 2, maxFilled: 6 },
  });
  console.log(`     states=${n}`);
  assert.ok(n < 10000, `N=2 standard orbs should be ≲ 10 K states; got ${n}. ` +
    `Past this, the BFS is materialising invalid (prefixMods, totalMods) tuples.`);
});

// (J) N=2 same-side (both PREFIX), all standard orbs + bone reveal.
// User's original "Body Armour STR + 2 essence-only PREFIX" repro.
test('J. N=2 same-side + bone, full action set ⇒ ≲ 20 K states', () => {
  const n = countStates('J', {
    wishlist: [
      { key: 'WISH_P1', weight: 0, type: 'PREFIX' }, // essence-only
      { key: 'WISH_P2', weight: 0, type: 'PREFIX' },
    ],
    orbs: ['transmute', 'augment', 'regal', 'alch', 'exalt', 'annul', 'chaos'],
    target: { requiredMods: ['WISH_P1', 'WISH_P2'], minFilled: 2, maxFilled: 6 },
    boneCostEx: 0.5,
    pBoneRevealHit: [0, 0],
  });
  console.log(`     states=${n}`);
  assert.ok(n < 20000, `N=2 same-side + bone should be ≲ 20 K states; got ${n}`);
});

// (K) N=2 same-side + bone + 2 essences (1 Magic→Rare + 1 Perfect-
// overwrite). The ACTUAL padding-trick repro from the user's URL.
// This is the scenario that exploded to 1M+ states pre-clamping.
test('K. N=2 same-side + bone + 2 essences (padding-trick repro) ⇒ ≲ 30 K states', () => {
  const n = countStates('K', {
    wishlist: [
      { key: 'WISH_P1', weight: 0, type: 'PREFIX' },
      { key: 'WISH_P2', weight: 0, type: 'PREFIX' },
    ],
    orbs: ['transmute', 'augment', 'regal', 'alch', 'exalt', 'annul', 'chaos'],
    target: { requiredMods: ['WISH_P1', 'WISH_P2'], minFilled: 2, maxFilled: 6 },
    boneCostEx: 0.5,
    pBoneRevealHit: [0, 0],
    essences: [
      { id: 'ess_M2R', name: 'Magic→Rare essence', costEx: 44, timeSec: 1,
        matchedKeys: ['WISH_P1'], pAcceptable: 1, side: 'PREFIX', mode: 'magic_to_rare' },
      { id: 'ess_overwrite', name: 'Perfect overwrite essence', costEx: 13, timeSec: 1,
        matchedKeys: ['WISH_P2'], pAcceptable: 1, side: null, mode: 'rare_overwrite' },
    ],
  });
  console.log(`     states=${n}`);
  assert.ok(n < 30000, `padding-trick repro should be ≲ 30 K states; got ${n}. ` +
    `Past this, the BFS is materialising invalid (prefixMods, totalMods) ` +
    `tuples — most likely from the chaos remove + add or annul irrelevant decrement ` +
    `producing prefixMods < 0 or totalMods > maxFilled.`);
});

// (K2) Same as K but with irrelevantWeight=0 (essence-only craft on
// a base where every wished mod and every irrelevant mod has weight 0
// — the natural pool is empty). This is the EXACT live-craft setup
// that the user's URL repro produces. Pre-clamping, this explodes
// past 1 M states; ceiling here pins the explosion as a regression
// guard.
test('K2. N=2 essence-only, irrelevantWeight=0 + 2 essences ⇒ ≲ 30 K states', () => {
  const n = countStates('K2', {
    wishlist: [
      { key: 'WISH_P1', weight: 0, type: 'PREFIX' },
      { key: 'WISH_P2', weight: 0, type: 'PREFIX' },
    ],
    orbs: ['transmute', 'augment', 'regal', 'alch', 'exalt', 'annul', 'chaos'],
    target: { requiredMods: ['WISH_P1', 'WISH_P2'], minFilled: 2, maxFilled: 6 },
    irrelevantWeight: 0,
    irrelevantWeightBySide: { PREFIX: 0, SUFFIX: 0 },
    essences: [
      { id: 'ess_M2R', name: 'Magic→Rare essence', costEx: 44, timeSec: 1,
        matchedKeys: ['WISH_P1'], pAcceptable: 1, side: 'PREFIX', mode: 'magic_to_rare' },
      { id: 'ess_overwrite', name: 'Perfect overwrite essence', costEx: 13, timeSec: 1,
        matchedKeys: ['WISH_P2'], pAcceptable: 1, side: null, mode: 'rare_overwrite' },
    ],
  });
  console.log(`     states=${n}`);
  assert.ok(n < 30000, `essence-only-pool craft should be ≲ 30 K states; got ${n}. ` +
    `Hits the pool=0 branch in singleDrawMaskDistribution where every orb returns a ` +
    `single deterministic outcome — should produce far fewer states than a non-zero ` +
    `pool, not vastly more.`);
});

// ─── State-invariant tests ─────────────────────────────────────────
// Each invariant probe targets a specific action class. When a
// transition violates `prefixMods ∈ [0,3]` / `totalMods ∈ [0, maxFilled]`,
// the assertion fires with the exact offending state, surfacing the
// bug at its source rather than as a generic "state space exploded."

test('inv-D. annul never produces prefixMods < 0', () => {
  // Annul on a state with unmaintained prefixMods (e.g. starting
  // state has totalMods=4 but prefixMods=0) historically decremented
  // prefixMods past zero on the irrelevant-prefix branch.
  // Start with a valid 2P/2S split; wished mod is suffix-side.
  assertStateInvariants('inv-D', {
    wishlist: [{ key: 'WISH_S', weight: 1000, type: 'SUFFIX' }],
    orbs: ['annul'],
    start: { rarity: 'rare', modsOnItem: ['WISH_S'], totalMods: 4, prefixMods: 2 },
    target: { requiredMods: ['WISH_S'], minFilled: 1, maxFilled: 1 },
  });
});

test('inv-F. chaos never produces invalid (prefixMods, totalMods)', () => {
  assertStateInvariants('inv-F', {
    orbs: ['chaos'],
    start: { rarity: 'rare', modsOnItem: [], totalMods: 4, prefixMods: 2 },
    target: { requiredMods: ['WISH_A'], minFilled: 1, maxFilled: 6 },
  });
});

test('inv-G. apply_bone+reveal_bone never overshoots totalMods=maxFilled', () => {
  assertStateInvariants('inv-G', {
    orbs: ['exalt'],
    start: { rarity: 'rare', modsOnItem: ['WISH_A'], totalMods: 5, prefixMods: 3 },
    target: { requiredMods: ['WISH_A'], minFilled: 4, maxFilled: 6 },
    boneCostEx: 0.5,
    pBoneRevealHit: [0],
  });
});

test('inv-K2. essence-only craft (irr=0 + 2 essences) keeps states valid', () => {
  assertStateInvariants('inv-K2', {
    wishlist: [
      { key: 'WISH_P1', weight: 0, type: 'PREFIX' },
      { key: 'WISH_P2', weight: 0, type: 'PREFIX' },
    ],
    orbs: ['transmute', 'augment', 'regal', 'alch', 'exalt', 'annul', 'chaos'],
    target: { requiredMods: ['WISH_P1', 'WISH_P2'], minFilled: 2, maxFilled: 6 },
    irrelevantWeight: 0,
    irrelevantWeightBySide: { PREFIX: 0, SUFFIX: 0 },
    essences: [
      { id: 'ess_M2R', name: 'Magic→Rare', costEx: 44, timeSec: 1,
        matchedKeys: ['WISH_P1'], pAcceptable: 1, side: 'PREFIX', mode: 'magic_to_rare' },
      { id: 'ess_overwrite', name: 'Perfect overwrite', costEx: 13, timeSec: 1,
        matchedKeys: ['WISH_P2'], pAcceptable: 1, side: null, mode: 'rare_overwrite' },
    ],
  });
});

// (L) N=3 with a mix of sides and full action set. Realistic
// upper bound for a craftable item — should still be tractable.
test('L. N=3 mixed-side, full standard action set ⇒ ≲ 50 K states', () => {
  const n = countStates('L', {
    wishlist: [
      { key: 'WISH_P', weight: 1000, type: 'PREFIX' },
      { key: 'WISH_S', weight: 1000, type: 'SUFFIX' },
      { key: 'WISH_S2', weight: 800, type: 'SUFFIX' },
    ],
    orbs: ['transmute', 'augment', 'regal', 'alch', 'exalt', 'annul', 'chaos'],
    target: { requiredMods: ['WISH_P', 'WISH_S'], minFilled: 3, maxFilled: 6 },
  });
  console.log(`     states=${n}`);
  assert.ok(n < 50000, `N=3 standard orbs should be ≲ 50 K states; got ${n}`);
});

console.log(`\n${passed} passed · ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
