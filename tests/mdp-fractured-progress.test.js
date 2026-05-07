// Regression test: when the goal requires a *fractured* version of a
// wished mod, having that mod present-but-unfractured must be modelled
// as forward progress (lower V* than an irrelevant-mod state) — even
// though it does not yet satisfy the goal predicate. The user's
// intuition: "rolling Surpassing-Arrow on the augment, even unfractured,
// is progress, because you still need to land it before you fracture."
//
// Scenario: Bow, target = single fractured Surpassing-Arrow suffix
// (requiredMods + fracturedKey set, maxFilled=1). We compare two
// Magic-1-mod start states injected explicitly via `start.modMask`:
//   A) the wished bit is on    → "we landed the wished mod"
//   B) the wished bit is off   → "we landed an irrelevant mod"
// The solver should report V*(A) < V*(B); otherwise the chain has
// no green/improving edge for "augment lands wished" and the user
// stares at a flat fan of outcomes from transmute.

import { strict as assert } from 'node:assert';
import { solveMDP } from '../engine/mdp/solve.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.message}`); }
}

console.log('MDP fractured-progress tests');

const baseInput = {
  wishlist: [{ key: 'SUFFIX:#% Surpassing add Arrow', weight: 2000 }],
  irrelevantWeight: 100_000,
  target: {
    requiredMods: ['SUFFIX:#% Surpassing add Arrow'],
    fracturedKey:  'SUFFIX:#% Surpassing add Arrow',
    maxFilled: 1,
  },
  basePriceEx: 100,
  alchemyDraws: 4,
  maxFilled: 6,
  timeWeightExPerSec: 0,
  orbCosts:  { transmute: 0.01, augment: 0.05, regal: 0.5, alch: 1, exalt: 1, annul: 0.5, fracturing: 50 },
  orbTimes:  { transmute: 1,    augment: 1,    regal: 1,   alch: 1, exalt: 1, annul: 1,   fracturing: 3 },
};

// Solve once from each start state and pull V*(start) out of the result.
function vStarFromStart(start) {
  const r = solveMDP({ ...baseInput, start });
  return r.vStar;
}

test('V*(magic-1-with-wished) < V*(magic-1-with-irrelevant)', () => {
  // Magic state, 1 mod, wished present: "we landed Surpassing-Arrow".
  const wished = vStarFromStart({
    rarity: 'magic',
    modsOnItem: ['SUFFIX:#% Surpassing add Arrow'],
    totalMods: 1,
  });
  // Magic state, 1 mod, no wished: "we landed an irrelevant mod".
  const irrelevant = vStarFromStart({
    rarity: 'magic',
    modsOnItem: [],
    totalMods: 1,
  });
  assert.ok(Number.isFinite(wished), `wished V* should be finite, got ${wished}`);
  assert.ok(Number.isFinite(irrelevant), `irrelevant V* should be finite, got ${irrelevant}`);
  assert.ok(
    wished < irrelevant,
    `expected V*(wished landed) < V*(irrelevant landed); got ${wished} vs ${irrelevant}. ` +
    'If equal, the transmute/augment fan from a Normal base shows no improving edge — ' +
    'the user-visible regression "no green edge on first augment" comes from this.',
  );
});

if (failed > 0) process.exit(1);
console.log(`\n${passed} passed, ${failed} failed`);
