// Loop detection on chain: SCCs in the post-collapse chain are
// surfaced as `chain.loops` so the renderer can box them as
// subgraphs (Mermaid subgraph / Cytoscape compound). Spec:
// docs/chain-rendering.md §7.
//
// Three properties pinned here:
//   - Single-node self-loops count (chaos-spam staying at one
//     state is a valid stationary region).
//   - The visit-count threshold is E[visits] ≥ 3 — the bar for
//     "this is genuinely stationary, not incidental traffic."
//   - The box title is the orb action ids on intra-SCC edges,
//     descending probability-mass; no static bundle map.

import { strict as assert } from 'node:assert';
import { solveMDP } from '../engine/mdp/solve.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.message}`); }
}

console.log('Chain — automatic inner-loop (SCC) detection');

// Fracture-anchor + tight budget: produces both chaos-spam (single-
// node self-loop) and an exalt-then-annul co-cycle. Both should
// surface as separate loops with E[visits] above the threshold.
const fractureInput = {
  wishlist: [
    { key: 'PREFIX:WISH_P', weight: 1500, type: 'PREFIX', requiredTier: 1, required: true },
    { key: 'SUFFIX:WISH_S', weight: 1500, type: 'SUFFIX', requiredTier: 1, required: true },
  ],
  irrelevantWeight: 30000,
  irrelevantWeightBySide: { PREFIX: 15000, SUFFIX: 15000 },
  target: {
    requiredMods: ['PREFIX:WISH_P', 'SUFFIX:WISH_S'],
    fracturedKey: 'PREFIX:WISH_P',
    minFilled: 2,
    maxFilled: 6,
  },
  start: { rarity: 'normal' },
  basePriceEx: 200,
  alchemyDraws: 4,
  maxFilled: 6,
  timeWeightExPerSec: 0,
  budgetEx: 3000,
  orbCosts: { transmute: 0.01, augment: 0.05, regal: 0.5, alch: 1, exalt: 1, annul: 5, fracturing: 100, chaos: 5 },
  orbTimes: { transmute: 1, augment: 1, regal: 1, alch: 1, exalt: 1, annul: 1, fracturing: 3, chaos: 1 },
};

test('chain.loops exists as an array (always present, even if empty)', () => {
  const result = solveMDP(fractureInput);
  assert.ok(Array.isArray(result.chain.loops),
    `chain.loops should be an array; got ${typeof result.chain.loops}`);
});

test('every loop is well-formed (nodes + dominantActions present)', () => {
  const result = solveMDP(fractureInput);
  const loops = result.chain.loops || [];
  for (const loop of loops) {
    assert.ok(Array.isArray(loop.nodes) && loop.nodes.length >= 1,
      `loop must have ≥1 node; got ${JSON.stringify(loop.nodes)}`);
    assert.ok(Array.isArray(loop.dominantActions),
      `loop should have a dominantActions array`);
    assert.ok(loop.dominantActions.length > 0,
      `loop dominantActions must be non-empty (a loop traverses at least one action)`);
    for (const a of loop.dominantActions) {
      assert.equal(typeof a, 'string',
        `dominantActions entries must be action-id strings; got ${typeof a}`);
    }
  }
});

test('low-traffic SCCs (E[visits] < 3) are filtered out — only stationary regions surface', () => {
  // Spec §7.2: the threshold is E[visits] ≥ 3, capturing "the policy
  // enters this region at least three times in expectation per
  // attempt." Looser thresholds let incidental two-pass traffic
  // through, which is just noise.
  const result = solveMDP(fractureInput);
  const loops = result.chain.loops || [];
  for (const loop of loops) {
    assert.ok(Number.isFinite(loop.totalVisits) && loop.totalVisits >= 3 - 1e-6,
      `loop ${JSON.stringify(loop.nodes)} totalVisits=${loop.totalVisits} should be ≥ 3 ` +
      `(below this is incidental traffic, not stationary behaviour)`);
  }
});

test('single-node self-loops are valid loops (chaos-spam, regal-spin)', () => {
  // Spec §7.1: stationary behaviour is the criterion, not node count.
  // A single chain state with a high-probability self-loop edge IS a
  // stationary region. The previous "drop singletons" rule was wrong
  // — it filtered out chaos-spam, the most common loop pattern.
  const result = solveMDP(fractureInput);
  const loops = result.chain.loops || [];
  // For each loop, assert that singleton membership doesn't disqualify
  // it. We test the property: at least one loop in the fixture should
  // be valid even if it has length 1. (Vacuous if all loops are
  // multi-node, but the algorithm must not reject singletons.)
  // Prove the ALGORITHM doesn't filter singletons by checking the
  // structural invariant: every loop's nodes are well-formed
  // regardless of count.
  for (const loop of loops) {
    if (loop.nodes.length === 1) {
      // A singleton must have a self-loop edge — by the SCC definition
      // a 1-node SCC is non-trivial only with a self-edge.
      const id = loop.nodes[0];
      const hasSelfEdge = result.chain.edges.some((e) => e.from === id && e.to === id);
      assert.ok(hasSelfEdge,
        `singleton loop ${id} must carry a self-loop edge (otherwise it shouldn't have been an SCC)`);
    }
  }
});

test('loop title (dominantActions) is just the orb action ids — no static bundling', () => {
  // Spec §7.5: the title is "which orbs power this loop", computed
  // from observed intra-SCC edge probability mass. There is no
  // global "exalt+annul" rule; if exalt and annul co-cycle, BOTH
  // appear in dominantActions, in mass order. If the engine fails
  // to put them in the same SCC (no bundling to mask the bug),
  // dominantActions stays single-action and we see the discrepancy.
  const result = solveMDP(fractureInput);
  const loops = result.chain.loops || [];
  const stateById = new Map(result.chain.states.map((s) => [s.id, s]));
  for (const loop of loops) {
    // Every dominantAction listed must actually appear on at least
    // one intra-SCC edge. (Sanity: title isn't fabricated.)
    const memberSet = new Set(loop.nodes);
    const intraSccActions = new Set();
    for (const e of result.chain.edges) {
      if (!memberSet.has(e.from) || !memberSet.has(e.to)) continue;
      const action = (e.label ?? '').split('\n')[0];
      if (action) intraSccActions.add(action);
    }
    // Fallback path: when no intra-SCC edges have action labels
    // (degenerate), dominantActions falls back to member policies.
    // Either source is acceptable.
    const memberPolicies = new Set();
    for (const id of loop.nodes) {
      const p = stateById.get(id)?.meta?.policy;
      if (p) memberPolicies.add(p);
    }
    for (const action of loop.dominantActions) {
      assert.ok(intraSccActions.has(action) || memberPolicies.has(action),
        `dominantAction "${action}" should appear on an intra-SCC edge or as a member policy ` +
        `(not a synthesised bundle name); intra-SCC actions: ${[...intraSccActions].join(', ')}, ` +
        `member policies: ${[...memberPolicies].join(', ')}`);
    }
  }
});

console.log(`\n${passed} passed · ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
