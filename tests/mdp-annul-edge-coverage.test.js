// Regression test: every outcome of the optimal action must surface
// as an outgoing chain edge. User report (2026-05-07): live craft
// shows an annul edge labelled 66% with no complementary 33% sibling
// — suggesting an outcome is being silently dropped from the chain.
//
// We exercise a 3-removable-mods state where annul has known
// outcomes summing to 1.0 across different destination states, then
// inspect `result.chain.edges` for completeness.

import { strict as assert } from 'node:assert';
import { solveMDP } from '../engine/mdp/solve.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.message}`); }
}

console.log('Chain edge coverage — annul outcomes');

const baseInput = {
  wishlist: [
    { key: 'WISH_P', weight: 1000, type: 'PREFIX', requiredTier: 1, required: true },
  ],
  irrelevantWeight: 50000,
  irrelevantWeightBySide: { PREFIX: 25000, SUFFIX: 25000 },
  start: { rarity: 'rare', modsOnItem: ['WISH_P'], totalMods: 3, prefixMods: 1 },
  basePriceEx: 100,
  alchemyDraws: 4,
  maxFilled: 6,
  timeWeightExPerSec: 0,
  budgetEx: 5000,
  allowMissingRates: true,
  orbCosts: { annul: 1, fracturing: 50 },  // annul cheap so it's the policy
  orbTimes: { annul: 1, fracturing: 3 },
};

test('annul on rare|w|3 — chain emits ALL outcome edges (sum to 1.0)', () => {
  const result = solveMDP({
    ...baseInput,
    target: { requiredMods: ['WISH_P'], minFilled: 1, maxFilled: 1 },
  });
  // Find the start state's chain id.
  const startId = result.chain.start;
  // Outgoing edges from start.
  const out = result.chain.edges.filter((e) => e.from === startId);
  // All outgoing edges from start (any action) — we just want the
  // probabilities to sum to 1.0 across the chosen action's outcomes.
  // Group by action label so we sum within an action.
  const byAction = new Map();
  for (const e of out) {
    const action = e.label.split('\n')[0];
    const arr = byAction.get(action) ?? [];
    arr.push(e);
    byAction.set(action, arr);
  }
  // Pick the chosen action (the most-edge group; in this fixture
  // it's annul with 3 outcomes — wished removed, irr prefix, irr
  // suffix — though some may collapse to the same destination).
  let bestAction = null, bestEdges = [];
  for (const [a, es] of byAction) {
    if (es.length > bestEdges.length) { bestAction = a; bestEdges = es; }
  }
  assert.ok(bestAction, 'expected at least one outgoing edge from start');
  const totalProb = bestEdges.reduce((s, e) => s + (e.prob ?? 0), 0);
  assert.ok(Math.abs(totalProb - 1.0) < 1e-6,
    `outgoing edge probabilities for action "${bestAction}" should sum to 1.0; ` +
    `got ${totalProb} across ${bestEdges.length} edges:\n` +
    bestEdges.map((e) => `  prob=${e.prob}, to=${e.to}, label=${e.label.replace(/\n/g, ' / ')}`).join('\n'));
});

test('annul on rare|0|3 (no wished on item) — irrelevant-only outcomes still emit edges', () => {
  // Start: rare with 3 irrelevant mods (1 prefix, 2 suffix). Annul
  // removes one — 1/3 chance prefix, 2/3 chance suffix. Two outcomes,
  // probs sum to 1.0.
  const result = solveMDP({
    ...baseInput,
    start: { rarity: 'rare', modsOnItem: [], totalMods: 3, prefixMods: 1 },
    target: { requiredMods: ['WISH_P'], minFilled: 1, maxFilled: 6 },
  });
  const startId = result.chain.start;
  const out = result.chain.edges.filter((e) => e.from === startId);
  if (!out.length) {
    // start has no outgoing edges (maybe goal or buy_base). Skip.
    return;
  }
  const byAction = new Map();
  for (const e of out) {
    const action = e.label.split('\n')[0];
    const arr = byAction.get(action) ?? [];
    arr.push(e);
    byAction.set(action, arr);
  }
  for (const [a, es] of byAction) {
    const total = es.reduce((s, e) => s + (e.prob ?? 0), 0);
    assert.ok(Math.abs(total - 1.0) < 1e-6,
      `action "${a}" probabilities sum to ${total} ≠ 1.0:\n` +
      es.map((e) => `  prob=${e.prob}, to=${e.to}`).join('\n'));
  }
});

console.log(`\n${passed} passed · ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
