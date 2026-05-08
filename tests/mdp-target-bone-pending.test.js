// Symmetric "allow pending unrevealed bone on goal" toggle.
//
// Default (target.allowBonePending=false): a state with
// `boneMod && !boneRevealed` is NEVER a goal — the policy must
// resolve the bone via the Well-of-Souls reveal step.
//
// Opt-in (target.allowBonePending=true): pre-reveal states that
// otherwise satisfy the goal (required mask, fracture, side-cap,
// totalMods bounds) ARE goals — useful for crafts that want to
// stop at "bone applied, defer reveal".

import { strict as assert } from 'node:assert';
import { isGoalState, makeState } from '../engine/mdp/state.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.message}`); }
}

console.log('Target — allow pending unrevealed bone-mod');

// One required wished mod (bit 0). Final-item shape: 1..6 mods.
const baseTarget = {
  requiredMask: 0b1,
  fracturedBit: -1,
  desecrationRequiredMask: 0,
  desecrationForbiddenMask: 0,
  minFilled: 1,
  maxFilled: 6,
};

const baseState = {
  rarity: 'rare',
  modMask: 0b1,                 // wished bit 0 set
  totalMods: 1,
  prefixMods: 1,
  desecratedWishedMask: 0,
  desecratedIrrPrefix: 0,
  desecratedIrrSuffix: 0,
  fracturedBit: -1,
  irrFractured: false,
};

test('default: state with pending bone is NOT goal even if mask satisfies', () => {
  const s = makeState({ ...baseState, boneMod: true, boneRevealed: false });
  assert.ok(!isGoalState(s, { ...baseTarget, allowBonePending: false }),
    'pending-bone state should not be goal under default predicate');
});

test('opt-in: same state IS goal when target.allowBonePending=true', () => {
  const s = makeState({ ...baseState, boneMod: true, boneRevealed: false });
  assert.ok(isGoalState(s, { ...baseTarget, allowBonePending: true }),
    'pending-bone state should be goal when allowBonePending=true');
});

test('opt-in does NOT relax other gates (e.g. maxFilled, fracture)', () => {
  // Same state but totalMods exceeds maxFilled.
  const s1 = makeState({ ...baseState, totalMods: 7, boneMod: true, boneRevealed: false });
  assert.ok(!isGoalState(s1, { ...baseTarget, maxFilled: 6, allowBonePending: true }),
    'allowBonePending must not bypass maxFilled');
  // Same state but missing required mask.
  const s2 = makeState({ ...baseState, modMask: 0, boneMod: true, boneRevealed: false });
  assert.ok(!isGoalState(s2, { ...baseTarget, allowBonePending: true }),
    'allowBonePending must not bypass requiredMask');
});

test('non-bone goal states unaffected by allowBonePending toggle', () => {
  const s = makeState({ ...baseState, boneMod: false, boneRevealed: false });
  assert.ok(isGoalState(s, { ...baseTarget, allowBonePending: false }),
    'normal goal state remains goal regardless');
  assert.ok(isGoalState(s, { ...baseTarget, allowBonePending: true }),
    'normal goal state remains goal under opt-in too');
});

console.log(`\n${passed} passed · ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
