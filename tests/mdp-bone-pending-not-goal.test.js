// Regression test: a state with an unrevealed bone-affix
// (`boneMod=true && boneRevealed=false`) must NOT be classified as a
// goal state, even when its visible mods satisfy the goal predicate.
// The bone is a pending affix that resolves into a real mod on reveal,
// at which point totalMods grows by 1 — so accepting the pre-reveal
// state as goal silently ignores an affix that may violate the
// target's `maxFilled`. The user-visible bug: "the live item still
// has an unrevealed affix while it is not compatible with the
// desired item."

import { strict as assert } from 'node:assert';
import { isGoalState, makeState } from '../engine/mdp/state.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.message}`); }
}

console.log('MDP goal-predicate / pending-bone tests');

// Single wished mod, required + fractured; goal demands totalMods<=1.
const target = {
  requiredMask: 0b1,
  fracturedBit: 0,
  minFilled: 1,
  maxFilled: 1,
};

test('post-fracture 1-mod state without bone ⇒ goal', () => {
  const s = makeState({
    rarity: 'rare',
    modMask: 0b1,
    totalMods: 1,
    fracturedBit: 0,
    boneMod: false,
    boneRevealed: false,
  });
  assert.ok(isGoalState(s, target),
    'clean 1-mod fractured state must be goal');
});

test('1-mod state with PENDING bone (unrevealed) ⇒ NOT goal', () => {
  const s = makeState({
    rarity: 'rare',
    modMask: 0b1,
    totalMods: 1,
    fracturedBit: 0,
    boneMod: true,
    boneRevealed: false, // bone applied but not yet revealed
  });
  assert.ok(!isGoalState(s, target),
    'state with an unrevealed bone is not a goal — the reveal will ' +
    'add an affix, possibly violating maxFilled. Accepting this as goal ' +
    'is the user-reported "live item has unrevealed affix" bug.');
});

test('1-mod state with REVEALED bone integrated into totalMods=1 ⇒ goal', () => {
  // Post-reveal, the bone slot is a normal affix and totalMods has
  // already been bumped. If totalMods=1 (i.e. the bone was the only
  // affix), it's a normal goal check — boneRevealed is just a marker
  // that no further reveal is pending.
  const s = makeState({
    rarity: 'rare',
    modMask: 0b1,
    totalMods: 1,
    fracturedBit: 0,
    boneMod: true,
    boneRevealed: true,
  });
  assert.ok(isGoalState(s, target),
    'post-reveal state with totalMods within maxFilled remains goal');
});

if (failed > 0) process.exit(1);
console.log(`\n${passed} passed, ${failed} failed`);
