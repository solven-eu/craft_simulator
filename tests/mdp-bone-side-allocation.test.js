// Regression test: bone-reveal side allocation must respect the
// open-slot rule.
//
// PoE2 game rule (per project memory `project_bone_side_allocation`):
//   - 6/6 full ⇒ remove a random affix and replace on the same side.
//   - One side full (3/3), other side has room ⇒ forced add to the
//     OTHER side. A wished mod whose side is the FULL side cannot
//     land — its hit probability is dropped on the floor.
//   - Both sides have room ⇒ 50/50 random side.
//
// User answer (2026-05-07): both-open is 50/50; Sinistral / Dextral
// Crystallisation omens force the side outright.
//
// This test pins the "one side full, forced opposite" branch:
// 3 prefixes filled + 0 suffixes + bone applied + a wished prefix in
// the desecrated pool ⇒ reveal CANNOT land that wished prefix
// (forced suffix-side reveal). The plain 3-pick formula does not
// know this and returns the unfiltered pBoneRevealHit, so the test
// catches the missing rule.
//
// We assert via the transition distribution: after reveal_bone from
// the 3P/0S state, P(wished prefix bit set) MUST be 0.

import { strict as assert } from 'node:assert';
import { ACTIONS } from '../engine/mdp/actions.js';
import { makeState } from '../engine/mdp/state.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.message}`); }
}

console.log('MDP bone-reveal side-allocation tests');

// Wishlist: bit 0 = a PREFIX wished mod that exists in the desecrated
// pool (so plain 3-pick gives it a positive hit probability); bit 1 =
// SUFFIX wished mod also in desecrated pool.
const env = {
  wishlistWeights: [1, 1],
  wishlistTypes: ['PREFIX', 'SUFFIX'],
  pBoneRevealHit:        [0.20, 0.20],
  pBoneRevealHitPrefix:  [0.20, 0],
  pBoneRevealHitSuffix:  [0,    0.20],
  pBoneRevealHitAbyssal: [0.36, 0.36],
  orbCosts: { reveal_bone: 0 },
  orbTimes: { reveal_bone: 1 },
};

test('one side full ⇒ reveal forced to open side (wished on full side cannot land)', () => {
  // 3P / 0S: prefixes saturated, suffixes empty. A bone-mod is
  // applied (pending). The reveal must land on a suffix slot, so
  // the wished PREFIX bit (bit 0) cannot land regardless of its
  // unfiltered hit probability.
  const s = makeState({
    rarity: 'rare',
    modMask: 0,             // no wished mods on item yet
    totalMods: 3,           // 3 prefixes occupy the side
    prefixMods: 3,          // forces the side-allocation rule
    boneMod: true,
    boneRevealed: false,
    fracturedBit: -1,
    irrFractured: false,
  });
  const transitions = ACTIONS.reveal_bone.transitions(s, env);
  // Sum probability mass that lands the wished PREFIX bit (bit 0).
  let pPrefixHit = 0;
  for (const t of transitions) {
    if (t.to.modMask & 1) pPrefixHit += t.prob;
  }
  assert.equal(pPrefixHit, 0,
    `forced-suffix reveal must not land a wished prefix; got pPrefixHit=${pPrefixHit}. `
    + `The plain reveal_bone formula ignores side-allocation and will fail this until we plumb `
    + `prefixMods through state and split reveal hits by side.`);
});

test('one side full ⇒ wished mod on the OPEN side still lands at its full pBoneRevealHit', () => {
  const s = makeState({
    rarity: 'rare',
    modMask: 0,
    totalMods: 3,
    prefixMods: 3,
    boneMod: true,
    boneRevealed: false,
    fracturedBit: -1,
    irrFractured: false,
  });
  const transitions = ACTIONS.reveal_bone.transitions(s, env);
  let pSuffixHit = 0;
  for (const t of transitions) {
    if (t.to.modMask & 0b10) pSuffixHit += t.prob;
  }
  // When forced to suffix, the suffix-side hit probability must
  // equal pBoneRevealHitSuffix[1] = 0.20 (NOT the unfiltered
  // pBoneRevealHit[1], which conflates both sides).
  assert.ok(Math.abs(pSuffixHit - 0.20) < 1e-9,
    `forced-suffix reveal lands wished suffix at 0.20; got ${pSuffixHit}.`);
});

test('both sides have room ⇒ wished hits use full-pool rate (side is intrinsic to the affix)', () => {
  // 1P / 1S: room on both. Each wished mod naturally has its own
  // side, so a hit lands in its intrinsic slot without contention.
  // The 50/50 side coin only governs IRRELEVANT outcomes (which open
  // slot the irrelevant affix consumes). Wished hit rates therefore
  // use pBoneRevealHit (full pool).
  const s = makeState({
    rarity: 'rare',
    modMask: 0,
    totalMods: 2,
    prefixMods: 1,
    boneMod: true,
    boneRevealed: false,
    fracturedBit: -1,
    irrFractured: false,
  });
  const transitions = ACTIONS.reveal_bone.transitions(s, env);
  let pPrefix = 0, pSuffix = 0;
  for (const t of transitions) {
    if (t.to.modMask & 1)    pPrefix += t.prob;
    if (t.to.modMask & 0b10) pSuffix += t.prob;
  }
  assert.ok(Math.abs(pPrefix - 0.20) < 1e-9,
    `both-open reveal ⇒ wished prefix lands at 0.20 (full-pool rate); got ${pPrefix}.`);
  assert.ok(Math.abs(pSuffix - 0.20) < 1e-9,
    `both-open reveal ⇒ wished suffix lands at 0.20 (full-pool rate); got ${pSuffix}.`);
});

if (failed > 0) process.exit(1);
console.log(`\n${passed} passed, ${failed} failed`);
