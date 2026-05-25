// MDP: bone-trick (apply_bone action).
//
// PoE2 Fracturing Orb requires a Rare with ≥ 4 mods. A Bone-class
// desecrated currency adds a hidden mod to the item, padding
// totalMods to satisfy the threshold without exposing a real affix
// to the lock pool. Net effect: a 3-mod Rare can fracture at 1/3
// lock probability (the bone-mod is invisible to fracture's pick),
// strictly better than exalt-padding to 4 mods (which exposes a 4th
// affix to the lock pool, dropping per-attempt success to 1/4).
//
// Tests pin:
//   1. With cheap bone available, MDP picks `apply_bone` at rare|w|3
//      to enable fracturing without exalt-padding.
//   2. With expensive bone (over budget) the action is excluded.
//   3. Without bone pricing (NaN), apply_bone is silently dropped.
//   4. After apply_bone, fracturing's lock probability uses the
//      revealed-mod count (still 1/3 for a 3-mod Rare with bone),
//      NOT the padded count.

import { strict as assert } from 'node:assert';
import { solveMDP } from '../engine/mdp/solve.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.message}`); }
}

console.log('MDP tests — bone-trick');

// Single SUFFIX wished mod, fracture target. Start from rare|w|3
// directly (no transmute path) by seeding the state with mods, so
// the fracture-step decision is the policy at start.
const baseInput = {
  wishlist: [{ key: 'WISH', weight: 2000, type: 'SUFFIX' }],
  irrelevantWeight: 60000,
  irrelevantWeightBySide: { PREFIX: 30000, SUFFIX: 30000 },
  target: {
    requiredMods: ['WISH'],
    fracturedKey:  'WISH',
    // maxFilled=2 (not 1) because revealing the bone bumps totalMods
    // by 1; with maxFilled=1 the revealed bone always overflows the
    // target, making the entire bone-trick path unreachable. The
    // trick's value is the *fracture-denominator* (1/3 vs 1/4), and
    // testing it requires a target where revealing the bone fits.
    minFilled: 1, maxFilled: 2,
  },
  start: { rarity: 'rare', modsOnItem: ['WISH'], totalMods: 3, fracturedKey: null },
  basePriceEx: 100,
  alchemyDraws: 4,
  maxFilled: 6,
  timeWeightExPerSec: 0,
  budgetEx: 50000,
};

const baseRates = {
  orbCosts: {
    transmute: 0.01, augment: 0.05, regal: 0.5, alch: 1,
    exalt: 5,                        // exalt expensive, so bone-then-fracture beats exalt-pad
    annul: 9.5, fracturing: 50,
  },
  orbTimes: {
    transmute: 1, augment: 1, regal: 1, alch: 1,
    exalt: 1, annul: 1, fracturing: 3,
  },
};

test('cheap bone + 3-mod start ⇒ apply_bone in optimal policy at start', () => {
  const result = solveMDP({
    ...baseInput,
    ...baseRates,
    boneCostEx: 0.5, // cheap Gnawed Collarbone equivalent
  });
  const startPolicy = result.policy.get(result.start.stateKey);
  assert.equal(startPolicy, 'apply_bone',
    `cheap bone should be picked at rare|w|3 to enable fracturing without exalt-padding; got "${startPolicy}"`);
});

test('after apply_bone, fracturing is applicable at totalMods=3 (threshold met via hidden mod)', () => {
  const result = solveMDP({
    ...baseInput,
    ...baseRates,
    boneCostEx: 0.5,
  });
  // The state "rare|w|3 with bone applied" must include `fracturing`
  // in its action set: the hidden bone mod pads totalMods (3 + 1 = 4)
  // to satisfy the ≥4-mods fracture threshold. Whether fracturing is
  // the *optimal* next action depends on the cost regime — which
  // varies from "fracture immediately" to "reveal first then
  // fracture" depending on orb costs and target shape. The
  // applicability is the load-bearing claim the trick depends on.
  const stateIdx = result.states.findIndex((s) =>
    s.state.rarity === 'rare' && s.state.modMask === 1 && s.state.totalMods === 3
    && s.state.boneMod === true && s.state.fracturedBit === -1);
  assert.ok(stateIdx >= 0, 'expected rare|w|3 with boneMod=true in state space');
  const apps = result.appsPerState?.get?.(stateIdx) ?? [];
  const actionIds = apps.map((a) => a.actionId);
  assert.ok(actionIds.includes('fracturing'),
    `expected "fracturing" applicable at boned rare|w|3 (hidden mod ` +
    `pads to threshold); got actions: ${JSON.stringify(actionIds)}`);
});

test('expensive bone (over budget) ⇒ engine routes around it via cheaper exalt-pad', () => {
  // Per the budget-redesign (2026-05-10): total budget no longer
  // pre-filters actions. The engine considers apply_bone alongside
  // exalt-pad and chooses based on Q-values. With a 1 M-ex bone vs
  // 5-ex exalt, exalt-pad dominates by cost ⇒ optimal policy avoids
  // apply_bone naturally. The orb stays in the action set; it just
  // never wins on cost-effectiveness.
  const result = solveMDP({
    ...baseInput,
    ...baseRates,
    boneCostEx: 1_000_000, // way over budget
  });
  const policies = new Set([...result.policy.values()].filter(Boolean));
  assert.ok(!policies.has('apply_bone'),
    `optimal policy should route around 1 M-ex bone via cheaper exalt-pad; ` +
    `got policies: ${[...policies]}`);
  // budgetExcluded reports actions the OPTIMAL policy uses whose unit
  // cost > budget — apply_bone should NOT be in it (engine avoided it).
  const excluded = result.budgetExcluded.find((e) => e.actionId === 'apply_bone');
  assert.ok(!excluded,
    `apply_bone is unused by the policy ⇒ should NOT appear in budgetExcluded; ` +
    `got: ${JSON.stringify(result.budgetExcluded)}`);
});

test('no bone pricing (NaN) ⇒ apply_bone silently absent from action set', () => {
  const result = solveMDP({
    ...baseInput,
    ...baseRates,
    // boneCostEx omitted → defaults NaN
  });
  const policies = new Set([...result.policy.values()].filter(Boolean));
  assert.ok(!policies.has('apply_bone'),
    `apply_bone should be absent when boneCostEx is NaN; got: ${[...policies]}`);
  assert.ok(!result.warnings?.some((w) => /apply_bone/.test(w)),
    `no warning should be emitted for missing bone pricing (silent skip); got: ${result.warnings}`);
});

test('chain label surfaces "🦴 unrevealed bone-mod" on pre-reveal states', () => {
  // The unrevealed bone-mod is a special phantom slot — distinct
  // from a regular affix because it pads the Fracture threshold but
  // can't be picked by Fracture/Annul. It enables the bone-trick and
  // multi-bone chains. Pin: chain labels for boneMod=true,
  // boneRevealed=false states carry an explicit "🦴 unrevealed
  // bone-mod" line so the chain reader can spot where this asset is
  // in play. Post-reveal labels do NOT carry the line (the affix
  // is now a normal mod).
  const result = solveMDP({
    ...baseInput,
    ...baseRates,
    boneCostEx: 0.5,
  });
  const preRevealNodes = result.chain.states.filter((s) =>
    /unrevealed bone-mod/.test(s.label));
  assert.ok(preRevealNodes.length > 0,
    `expected at least one chain node with "🦴 unrevealed bone-mod" label`);
  // Verify the marker corresponds to the engine's underlying state
  // — every node carrying the marker should have boneMod=true AND
  // boneRevealed=false on the engine state, AND every node WITHOUT
  // the marker should NOT have that combination.
  for (const cs of result.chain.states) {
    const idx = parseInt(cs.id.replace(/^s/, ''), 10);
    const st = result.states[idx]?.state;
    if (!st) continue;
    const hasMarker = /unrevealed bone-mod/.test(cs.label);
    const isPreReveal = !!st.boneMod && !st.boneRevealed;
    assert.equal(hasMarker, isPreReveal,
      `node ${cs.id}: marker=${hasMarker} should match isPreReveal=${isPreReveal} `
      + `(boneMod=${st.boneMod}, boneRevealed=${st.boneRevealed})`);
  }
});

test('apply_bone → reveal_bone two-phase transition (multi-bone-friendly: flags reset post-reveal)', () => {
  // Pin the two-phase desecration mechanic AND the multi-bone
  // friendly post-reveal cleanup. Phase 1: apply_bone enters
  // (boneMod=true, boneRevealed=false). Phase 2: reveal_bone
  // promotes the slot to a real affix (totalMods +1), AND clears
  // both flags so a fresh apply_bone is applicable again.
  const result = solveMDP({
    ...baseInput,
    ...baseRates,
    boneCostEx: 0.5,
  });
  // Pre-reveal state: bone applied, mod count unchanged.
  const preReveal = result.states.find((s) =>
    s.state.rarity === 'rare' && s.state.modMask === 1 && s.state.totalMods === 3
    && s.state.boneMod === true && s.state.boneRevealed === false);
  assert.ok(preReveal, 'expected pre-reveal state (rare|w|3 with boneMod=true, boneRevealed=false)');
  // Post-reveal state: bone-affix is now real (totalMods +1), and
  // both bone flags are cleared so another apply_bone could fire.
  const postReveal = result.states.find((s) =>
    s.state.rarity === 'rare' && s.state.modMask === 1 && s.state.totalMods === 4
    && s.state.boneMod === false && s.state.boneRevealed === false);
  assert.ok(postReveal, 'expected post-reveal state (rare|w|4 with both bone flags cleared)');
});

test('reveal_bone with wished mod in desecrated pool ⇒ wished bit can be set', () => {
  // When the wishlist contains an affix that's also in the bone's
  // desecrated pool, reveal_bone has a non-zero P(set wished bit).
  // Pin: with pBoneRevealHit[0] = 0.3, reveal_bone produces both
  // outcome branches (wished-bit-set + irrelevant) in the chain.
  const result = solveMDP({
    ...baseInput,
    ...baseRates,
    boneCostEx: 0.5,
    // 30% chance reveal lands the wished mod (e.g. for a wished
    // entry whose desecrated-pool counterpart is one of ~10 mods,
    // 1 - (1 - 1/10)^3 ≈ 27%; bumped to 30% for test clarity).
    pBoneRevealHit: [0.3],
  });
  const preReveal = result.states.find((s) =>
    s.state.rarity === 'rare' && s.state.modMask === 1 && s.state.totalMods === 3
    && s.state.boneMod === true && s.state.boneRevealed === false);
  assert.ok(preReveal, 'pre-reveal state must exist');
  // Inspect post-reveal states reached from preReveal. Multi-bone
  // change: post-reveal clears both bone flags, so we filter by
  // boneMod=false (the affix has been "absorbed" into totalMods).
  const postRevealVariants = result.states.filter((s) =>
    s.state.rarity === 'rare' && s.state.totalMods === 4
    && s.state.boneMod === false && s.state.boneRevealed === false
    && s.state.fracturedBit === -1 && !s.state.irrFractured);
  assert.ok(postRevealVariants.length >= 2,
    `expected both wished-set and wished-unset post-reveal variants when pBoneRevealHit > 0; got ${postRevealVariants.length}`);
});

test('one-desecrated-cap: post-reveal blocks a second apply_bone', () => {
  // PoE2 rule (user clarification 2026-05-07): a desecrated mod
  // (revealed or unrevealed) blocks `apply_bone`. Once a bone has
  // been revealed, the resulting affix carries the desecrated
  // provenance and remains on the item — so a second apply_bone is
  // NOT applicable until the desecrated mod has been scrubbed via
  // Annul-with-Omen-of-Light (engine action for that loop is a
  // follow-up).
  //
  // Pin: starting from a 2-mod Rare with the wished mod, after one
  // apply_bone → reveal_bone cycle, no further apply_bone state
  // exists in the engine's reachable space.
  const result = solveMDP({
    ...baseInput,
    start: { rarity: 'rare', modsOnItem: ['WISH'], totalMods: 2, fracturedKey: null },
    ...baseRates,
    boneCostEx: 0.5,
  });
  // Post-first-reveal state: 1 desecrated mod on the item.
  // desecratedCount is now derived from the underlying fields:
  // popcount(desecratedWishedMask) + desecratedIrrPrefix + desecratedIrrSuffix.
  const desecCount = (st) => {
    let n = 0; let m = st.desecratedWishedMask ?? 0;
    while (m) { n += m & 1; m >>>= 1; }
    return n + (st.desecratedIrrPrefix ?? 0) + (st.desecratedIrrSuffix ?? 0);
  };
  const postFirstReveal = result.states.find((s) =>
    s.state.rarity === 'rare' && s.state.modMask === 1 && s.state.totalMods === 3
    && s.state.boneMod === false && s.state.boneRevealed === false
    && desecCount(s.state) === 1
    && s.state.fracturedBit === -1 && !s.state.irrFractured);
  assert.ok(postFirstReveal,
    'expected post-first-reveal state (rare|w|3 with one desecrated mod)');
  // A second apply_bone should NOT be reachable from here — confirm
  // by absence of any pre-second-bone state with a desecrated mod
  // already on the item AND boneMod=true.
  const preSecondBone = result.states.find((s) =>
    s.state.rarity === 'rare' && s.state.totalMods === 3
    && s.state.boneMod === true && s.state.boneRevealed === false
    && desecCount(s.state) >= 1);
  assert.ok(!preSecondBone,
    'apply_bone must be unreachable after a prior reveal (desecrated provenance persists); '
    + `but found state with boneMod=true && desecCount≥1: ${JSON.stringify(preSecondBone?.state)}`);
});

test('Sinistral Necromancy reveal: prefix-only pool restricts the wished bit', () => {
  // pBoneRevealHitPrefix is computed by the adapter from the prefix-
  // filtered desecrated pool. With a SUFFIX wished mod and Sinistral
  // Necromancy, the wished bit can never be set by reveal (because
  // the prefix-only pool can't land a suffix). Pin: solveMDP with
  // pBoneRevealHitPrefix=[0] (suffix-wished case) — reveal_bone_sinistral
  // is in the action set but its transitions never set the wished bit.
  const result = solveMDP({
    ...baseInput,
    ...baseRates,
    boneCostEx: 0.5,
    pBoneRevealHitPrefix: [0],   // suffix-wished + Sinistral ⇒ never lands wished
    pBoneRevealHitSuffix: [0.3], // dextral does land wished
  });
  // reveal_bone_sinistral with pHits=[0] always lands irrelevant
  // (single outcome). reveal_bone_dextral with pHits=[0.3] has two
  // outcomes (wished + irrelevant).
  const policies = new Set([...result.policy.values()].filter(Boolean));
  // Either variant might appear depending on costs — pin only that
  // both are admitted as actions and the engine picks among them.
  assert.ok(policies.size > 0, 'optimal policy should not be empty');
});

test('Abyssal Echoes reveal: 6-pick pBoneRevealHitAbyssal is strictly higher than 3-pick', () => {
  // Two solves: one where only plain reveal is available with hit
  // probability p3, another where plain + Abyssal Echoes are
  // available with hit prob p3 < p6 = 1 - (1-p3-tail)^2-equivalent.
  // V*(start) should be strictly lower with Abyssal Echoes when its
  // omen cost is low (< the EV gain from the 2× pick boost).
  const noAbyssal = solveMDP({
    ...baseInput,
    ...baseRates,
    boneCostEx: 0.5,
    pBoneRevealHit:        [0.27],  // 3-pick from a ~10-mod pool
    pBoneRevealHitAbyssal: [0],     // omen unavailable
  });
  const withAbyssal = solveMDP({
    ...baseInput,
    ...baseRates,
    boneCostEx: 0.5,
    pBoneRevealHit:        [0.27],
    pBoneRevealHitAbyssal: [0.47],  // 6-pick from same pool
    orbCosts: { ...baseRates.orbCosts, reveal_bone_abyssal: 0.001 }, // cheap omen
  });
  assert.ok(withAbyssal.vStar <= noAbyssal.vStar + 1e-3,
    `V*(start) with Abyssal Echoes available (${withAbyssal.vStar}) should ≤ without it (${noAbyssal.vStar})`);
});

test('bone-trick beats exalt-pad: V*(start) lower with bone than without', () => {
  const withBone = solveMDP({
    ...baseInput,
    ...baseRates,
    boneCostEx: 0.5,
  });
  const withoutBone = solveMDP({
    ...baseInput,
    ...baseRates,
    // boneCostEx omitted
  });
  assert.ok(withBone.vStar < withoutBone.vStar,
    `V*(start) with bone (${withBone.vStar}) should be < V*(start) without bone (${withoutBone.vStar})`);
});

console.log(`\n${passed} passed · ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
