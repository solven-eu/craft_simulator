// chainToCytoscape: pure transducer turning the engine's chain
// object into cytoscape's `{ elements, style, layout }` triple.
// Same input contract as chainToMermaid; renderer-only difference.

import { strict as assert } from 'node:assert';
import { chainToCytoscape } from '../engine/strategies/chain-cytoscape.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.message}`); }
}

console.log('Cytoscape chain renderer');

const baseChain = {
  states: [
    { id: 's0', kind: 'start',     label: 'start',          pReach: 1.0, expectedVisits: 1.0 },
    { id: 's1', kind: 'transient', label: '· P: 1\nV*=10',  pReach: 0.95, expectedVisits: 1.0 },
    { id: 's2', kind: 'transient', label: 'mid',            pReach: 0.50, expectedVisits: 2.5 },
    { id: 's3', kind: 'transient', label: 'rare',           pReach: 0.05, expectedVisits: 0.05 },
    { id: 's4', kind: 'goal',      label: 'goal',           pReach: 0.85, expectedVisits: 0.85 },
  ],
  edges: [
    { from: 's0', to: 's1', kind: 'orb',     prob: 1.0,  label: 'alch\n100%' },
    { from: 's1', to: 's2', kind: 'improving', prob: 0.5,  label: 'exalt\n50%' },
    { from: 's2', to: 's1', kind: 'fail',    prob: 0.5,  label: 'annul\n50%' },
    { from: 's2', to: 's4', kind: 'success', prob: 0.5,  label: 'exalt\n50%' },
    { from: 's0', to: 's3', kind: 'fail',    prob: 0.05, label: 'alch\n5%' },
  ],
  loops: [
    { nodes: ['s1', 's2'], bundle: 'exalt+annul', dominantActions: ['exalt', 'annul'], totalVisits: 4.0, sccIndex: 0 },
  ],
};

test('returns { elements, style, layout } shape', () => {
  const out = chainToCytoscape(baseChain);
  assert.ok(Array.isArray(out.elements), 'elements must be an array');
  assert.ok(Array.isArray(out.style), 'style must be an array');
  assert.equal(typeof out.layout, 'object', 'layout must be an object');
  assert.ok(out.layout.name, 'layout.name must be set (fcose / cola / dagre)');
});

test('every state becomes a node element with id + label', () => {
  const out = chainToCytoscape(baseChain);
  const nodes = out.elements.filter((e) => e.group === 'nodes' || (!e.group && !e.data?.source));
  const ids = new Set(nodes.map((n) => n.data.id));
  for (const s of baseChain.states) {
    assert.ok(ids.has(s.id), `expected node ${s.id} in elements`);
  }
});

test('every edge becomes an edge element with source/target/label/prob', () => {
  const out = chainToCytoscape(baseChain);
  const edges = out.elements.filter((e) => e.group === 'edges' || e.data?.source);
  assert.equal(edges.length, baseChain.edges.length,
    `expected ${baseChain.edges.length} edges; got ${edges.length}`);
  for (const e of baseChain.edges) {
    const found = edges.find((x) => x.data.source === e.from && x.data.target === e.to);
    assert.ok(found, `edge ${e.from} → ${e.to} missing`);
    assert.equal(found.data.prob, e.prob, `edge prob should propagate`);
  }
});

test('loops produce compound parent nodes; member states reference their parent', () => {
  const out = chainToCytoscape(baseChain);
  const nodes = out.elements.filter((e) => !e.data?.source);
  // A compound parent node for the loop should exist with id = loop_0.
  const parent = nodes.find((n) => n.data.id === 'loop_0');
  assert.ok(parent, `expected compound node loop_0 for the bundle-loop; got ids: ${nodes.map((n) => n.data.id).join(', ')}`);
  assert.match(parent.data.label, /exalt.*annul/i, `loop_0 label should mention dominant actions`);
  // Member states must declare `parent: 'loop_0'` so cytoscape draws
  // them inside the compound.
  for (const id of ['s1', 's2']) {
    const node = nodes.find((n) => n.data.id === id);
    assert.ok(node, `loop member ${id} must exist`);
    assert.equal(node.data.parent, 'loop_0',
      `loop member ${id} must declare parent=loop_0; got ${node.data.parent}`);
  }
  // States with mixed-or-top-level neighbours stay at top level.
  // s0 (start): connects to s1 (in loop_0) and s3 (top-level) — mixed,
  // stays out. s3 (rare): only connects to s0 (top-level) — stays out.
  for (const id of ['s0', 's3']) {
    const node = nodes.find((n) => n.data.id === id);
    assert.ok(!node.data.parent, `${id} has top-level neighbours; should stay out of any loop. Got parent='${node.data.parent}'`);
  }
  // s4 (goal): only neighbour is s2 (in loop_0) — pendant inclusion
  // rule pulls it into loop_0. (Tested directly in the dedicated
  // pendant test below; recorded here as a positive expectation so
  // regression of the pull-in shows up in this test too.)
  const s4 = nodes.find((n) => n.data.id === 's4');
  assert.equal(s4.data.parent, 'loop_0',
    `s4's only edge comes from inside loop_0 — pendant inclusion should pull it in; got parent='${s4.data.parent}'`);
});

test('SCC with ≥2 loops emits an outer compound parent wrapping the inner loop parents', () => {
  const chain2Loops = {
    ...baseChain,
    loops: [
      { nodes: ['s1', 's2'], bundle: 'exalt+annul', dominantActions: ['exalt', 'annul'], totalVisits: 4.0, sccIndex: 0 },
      { nodes: ['s3'],       bundle: 'chaos',       dominantActions: ['chaos'],          totalVisits: 1.5, sccIndex: 0 },
    ],
  };
  const out = chainToCytoscape(chain2Loops);
  const nodes = out.elements.filter((e) => !e.data?.source);
  const sccParent = nodes.find((n) => n.data.id === 'scc_0');
  assert.ok(sccParent, `expected outer scc_0 compound when 2 loops share an SCC`);
  // Inner loop_0 / loop_1 must declare scc_0 as their parent.
  const loop0 = nodes.find((n) => n.data.id === 'loop_0');
  const loop1 = nodes.find((n) => n.data.id === 'loop_1');
  assert.equal(loop0?.data.parent, 'scc_0',
    `loop_0 must nest inside scc_0; parent=${loop0?.data.parent}`);
  assert.equal(loop1?.data.parent, 'scc_0',
    `loop_1 must nest inside scc_0; parent=${loop1?.data.parent}`);
});

test('importance opacity flows onto node data so style selectors can use it', () => {
  const out = chainToCytoscape(baseChain);
  const nodes = out.elements.filter((e) => !e.data?.source);
  for (const n of nodes) {
    if (n.data.id === 'loop_0' || n.data.id === 'scc_0') continue; // compound parents
    assert.ok(Number.isFinite(n.data.opacity),
      `node ${n.data.id} must carry an opacity in [0,1]; got ${n.data.opacity}`);
    assert.ok(n.data.opacity >= 0.6 && n.data.opacity <= 1.0,
      `node ${n.data.id} opacity ${n.data.opacity} out of [0.6, 1.0] floor range`);
  }
});

test('edge opacity scales with probability — low-P edges fade, high-P stay vivid', () => {
  const out = chainToCytoscape(baseChain);
  const edges = out.elements.filter((e) => e.data?.source);
  for (const e of edges) {
    assert.ok(Number.isFinite(e.data.opacity),
      `edge ${e.data.source}→${e.data.target} must carry numeric opacity; got ${e.data.opacity}`);
    assert.ok(e.data.opacity >= 0.4 && e.data.opacity <= 1.0,
      `edge opacity ${e.data.opacity} should sit in [0.4, 1.0] floor range`);
  }
  // Monotonic: a 100% edge should be more opaque than a 5% edge.
  const high = edges.find((e) => e.data.source === 's0' && e.data.target === 's1'); // 100%
  const low  = edges.find((e) => e.data.source === 's0' && e.data.target === 's3'); // 5%
  assert.ok(high && low);
  assert.ok(high.data.opacity > low.data.opacity,
    `100%-prob opacity (${high.data.opacity}) should be > 5%-prob (${low.data.opacity})`);
});

test('low-probability edges get a longer ideal length than high-probability ones', () => {
  // High-prob edges sit on the trunk of the chain — they should
  // pull tightly together. Low-prob branches are noise and can
  // sprawl. Per-edge `idealLength` data drives fcose's spring rest
  // length, so stamping prob-derived values on the edge produces
  // the desired spacing.
  const out = chainToCytoscape(baseChain);
  const edges = out.elements.filter((e) => e.data?.source);
  for (const e of edges) {
    assert.ok(Number.isFinite(e.data.idealLength) && e.data.idealLength > 0,
      `edge ${e.data.source}→${e.data.target} must carry numeric idealLength; got ${e.data.idealLength}`);
  }
  const high = edges.find((e) => e.data.source === 's0' && e.data.target === 's1'); // 100%
  const low  = edges.find((e) => e.data.source === 's0' && e.data.target === 's3'); // 5%
  assert.ok(high.data.idealLength < low.data.idealLength,
    `100%-prob idealLength (${high.data.idealLength}) should be SHORTER than 5%-prob (${low.data.idealLength})`);
});

test('edge stroke-width scales with probability (sqrt scale, capped)', () => {
  const out = chainToCytoscape(baseChain);
  const edges = out.elements.filter((e) => e.data?.source);
  for (const e of edges) {
    assert.ok(Number.isFinite(e.data.width) && e.data.width > 0,
      `edge ${e.data.source}→${e.data.target} must have a positive numeric width`);
  }
  // High-prob edge should be wider than low-prob edge.
  const high = edges.find((e) => e.data.source === 's0' && e.data.target === 's1'); // 100%
  const low  = edges.find((e) => e.data.source === 's0' && e.data.target === 's3'); // 5%
  assert.ok(high && low);
  assert.ok(high.data.width > low.data.width,
    `100%-prob edge width (${high.data.width}) should be > 5%-prob (${low.data.width})`);
});

test('a terminal whose every neighbour is inside one loop gets pulled into that loop', () => {
  // User report (2026-05-08): goal state sits outside its enclosing
  // loop even though all its edges originate from members of the
  // loop. Generalised rule: any node whose every neighbour (in OR
  // out) belongs to a single loop is visually part of that loop and
  // should declare it as parent. Goal terminals are the obvious
  // case, but the same heuristic applies to other "pendant" states.
  const chainGoalAfterLoop = {
    states: [
      { id: 's0', kind: 'start',     label: 'start',  pReach: 1.0, expectedVisits: 1.0 },
      { id: 's1', kind: 'transient', label: 'a1',     pReach: 1.0, expectedVisits: 2.0 },
      { id: 's2', kind: 'transient', label: 'a2',     pReach: 1.0, expectedVisits: 2.0 },
      { id: 's3', kind: 'goal',      label: 'goal',   pReach: 0.85, expectedVisits: 0.85 },
    ],
    edges: [
      { from: 's0', to: 's1', kind: 'orb',     prob: 1.0,  label: 'alch\n100%' },
      { from: 's1', to: 's2', kind: 'orb',     prob: 0.5,  label: 'exalt\n50%' },
      { from: 's2', to: 's1', kind: 'orb',     prob: 0.5,  label: 'annul\n50%' },
      // Goal's only edge: from inside the loop.
      { from: 's2', to: 's3', kind: 'success', prob: 0.5,  label: 'exalt\n50%' },
    ],
    loops: [
      { nodes: ['s1', 's2'], bundle: 'exalt+annul', dominantActions: ['exalt', 'annul'], totalVisits: 4.0, sccIndex: 0 },
    ],
  };
  const out = chainToCytoscape(chainGoalAfterLoop);
  const goalNode = out.elements.find((e) => e.data.id === 's3');
  assert.ok(goalNode, 'goal node must be present');
  assert.equal(goalNode.data.parent, 'loop_0',
    `goal s3 has all neighbours in loop_0; expected parent='loop_0', got '${goalNode.data.parent}'`);
});

test('a state straddling two loops stays at top level (no over-inclusion)', () => {
  // Counter-example: if the pendant has neighbours in TWO different
  // loops, it doesn't visually belong to either — keep it at top
  // level. Otherwise the heuristic could pull every cross-loop
  // bridging state into one or the other arbitrarily.
  const chainBridge = {
    states: [
      { id: 's0', kind: 'start',     label: 'start',  pReach: 1.0, expectedVisits: 1.0 },
      { id: 's1', kind: 'transient', label: 'a1',     pReach: 1.0, expectedVisits: 2.0 },
      { id: 's2', kind: 'transient', label: 'a2',     pReach: 1.0, expectedVisits: 2.0 },
      { id: 's3', kind: 'transient', label: 'bridge', pReach: 0.5, expectedVisits: 1.0 },
      { id: 's4', kind: 'transient', label: 'b1',     pReach: 0.5, expectedVisits: 1.5 },
      { id: 's5', kind: 'transient', label: 'b2',     pReach: 0.5, expectedVisits: 1.5 },
      { id: 's6', kind: 'goal',      label: 'goal',   pReach: 0.4, expectedVisits: 0.4 },
    ],
    edges: [
      { from: 's0', to: 's1', kind: 'orb', prob: 1.0, label: 'alch' },
      { from: 's1', to: 's2', kind: 'orb', prob: 0.5, label: 'exalt' },
      { from: 's2', to: 's1', kind: 'orb', prob: 0.5, label: 'annul' },
      { from: 's2', to: 's3', kind: 'orb', prob: 0.5, label: 'chaos' },
      { from: 's3', to: 's4', kind: 'orb', prob: 1.0, label: 'regal' },
      { from: 's4', to: 's5', kind: 'orb', prob: 0.5, label: 'exalt' },
      { from: 's5', to: 's4', kind: 'orb', prob: 0.5, label: 'annul' },
      { from: 's5', to: 's6', kind: 'success', prob: 0.5, label: 'exalt' },
    ],
    loops: [
      { nodes: ['s1', 's2'], bundle: 'exalt+annul', dominantActions: ['exalt', 'annul'], totalVisits: 4.0, sccIndex: 0 },
      { nodes: ['s4', 's5'], bundle: 'exalt+annul', dominantActions: ['exalt', 'annul'], totalVisits: 3.0, sccIndex: 1 },
    ],
  };
  const out = chainToCytoscape(chainBridge);
  const bridgeNode = out.elements.find((e) => e.data.id === 's3');
  assert.ok(bridgeNode);
  assert.ok(!bridgeNode.data.parent,
    `bridge s3 connects to BOTH loops; should remain top-level. Got parent='${bridgeNode.data.parent}'`);
});

test('chains with no loops produce no compound parents', () => {
  const flat = { ...baseChain, loops: [] };
  const out = chainToCytoscape(flat);
  const nodes = out.elements.filter((e) => !e.data?.source);
  const compoundIds = nodes
    .map((n) => n.data.id)
    .filter((id) => /^(loop_|scc_)/.test(id));
  assert.equal(compoundIds.length, 0,
    `chains with no loops should produce no compound parents; got: ${compoundIds.join(', ')}`);
  // Every state node must have no parent reference.
  for (const n of nodes) {
    assert.ok(!n.data.parent, `node ${n.data.id} should have no parent in flat chain`);
  }
});

console.log(`\n${passed} passed · ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
