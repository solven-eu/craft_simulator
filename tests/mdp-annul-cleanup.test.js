// Regression test: post-fracture annul cleanup.
//
// Scenario: Bow with target = exactly 1 mod (the fractured wished
// suffix), all other slots required-empty. Once the fracture lands on
// a 4-mod Rare, the chain has 4 mods (1 fractured + 3 irrelevant) but
// the goal demands totalMods <= 1. The MDP must annul the 3
// irrelevant mods to satisfy `target.maxFilled = 1`.
//
// User-visible bug: "with live item, why don't we remove the
// unrevealed mod? We requested empty affixes out of the fractured
// item." Expected: optimal policy at the post-fracture 4-mod Rare
// state is 'annul'.

import { strict as assert } from 'node:assert';
import { solveMDP } from '../engine/mdp/solve.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.message}`); }
}

console.log('MDP annul-cleanup tests');

const baseInput = {
  wishlist: [{ key: 'SUFFIX:#% Surpassing add Arrow', weight: 2000 }],
  irrelevantWeight: 100_000,
  target: {
    requiredMods: ['SUFFIX:#% Surpassing add Arrow'],
    fracturedKey:  'SUFFIX:#% Surpassing add Arrow',
    maxFilled: 1,
    minFilled: 1,
  },
  basePriceEx: 100,
  alchemyDraws: 4,
  maxFilled: 6,
  timeWeightExPerSec: 0,
  orbCosts:  { transmute: 0.01, augment: 0.05, regal: 0.5, alch: 1, exalt: 1, annul: 0.5, fracturing: 50 },
  orbTimes:  { transmute: 1,    augment: 1,    regal: 1,   alch: 1, exalt: 1, annul: 1,   fracturing: 3 },
};

test('post-fracture 4-mod state → optimal policy is annul', () => {
  // Inject the start state directly: Rare, 4 total mods (1 wished
  // already locked as fracture + 3 irrelevant). Goal demands
  // totalMods ≤ 1 ⇒ must annul down.
  const result = solveMDP({
    ...baseInput,
    start: {
      rarity: 'rare',
      modsOnItem: ['SUFFIX:#% Surpassing add Arrow'],
      totalMods: 4,
      fracturedKey: 'SUFFIX:#% Surpassing add Arrow',
    },
  });
  const startKey = result.start.stateKey;
  const startPolicy = result.policy.get(startKey);
  assert.equal(
    startPolicy, 'annul',
    `expected post-fracture cleanup policy = annul, got "${startPolicy}". ` +
    'If the policy is buy_base or something else, the live-item simulator ' +
    'will not strip the unrevealed (irrelevant) mods after fracture.',
  );
});

test('post-fracture 1-mod state (cleaned) → goal reached', () => {
  const result = solveMDP({
    ...baseInput,
    start: {
      rarity: 'rare',
      modsOnItem: ['SUFFIX:#% Surpassing add Arrow'],
      totalMods: 1,
      fracturedKey: 'SUFFIX:#% Surpassing add Arrow',
    },
  });
  assert.equal(result.vStar, 0,
    `expected V*=0 at goal state (1-mod fractured wished), got ${result.vStar}`);
});

if (failed > 0) process.exit(1);
console.log(`\n${passed} passed, ${failed} failed`);
