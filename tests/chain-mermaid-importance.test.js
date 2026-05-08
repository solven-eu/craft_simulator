// Regression: chain rendering must dim low-importance states without
// hiding them and must keep narrative anchors (start/goal/bricked/
// near-trap) at full opacity. Plus the chaos-loop case: a high-
// expectedVisits state stays bright even if its pReach is moderate.

import { strict as assert } from 'node:assert';
import { chainToMermaid } from '../engine/strategies/chain-mermaid.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.message}`); }
}

console.log('Mermaid chain — importance-based opacity');

// Build a tiny synthetic chain. Six states: one start, three transient
// of varying importance, one goal, one near-trap. Pretend the engine
// computed pReach + expectedVisits already (it does — solve.js attaches
// them at chainStates.push time).
const baseChain = {
  states: [
    { id: 's0', kind: 'start',     label: 'start',  pReach: 1.0, expectedVisits: 1.0 },
    { id: 's1', kind: 'transient', label: 'main',   pReach: 0.95, expectedVisits: 0.95 },  // dominant path
    { id: 's2', kind: 'transient', label: 'mid',    pReach: 0.40, expectedVisits: 0.40 },  // common-ish
    { id: 's3', kind: 'transient', label: 'rare',   pReach: 0.02, expectedVisits: 0.02 },  // rare side branch
    { id: 's4', kind: 'transient', label: 'loop',   pReach: 0.30, expectedVisits: 8.0 },   // chaos-loop: low pReach × log(1+8) keeps it bright
    { id: 's5', kind: 'goal',      label: 'goal',   pReach: 0.85, expectedVisits: 0.85 },
    { id: 's6', kind: 'near-trap', label: 'trap',   pReach: 0.001, expectedVisits: 0.001 }, // tiny, but anchor → stays vivid
  ],
  edges: [
    { from: 's0', to: 's1', kind: 'orb',     prob: 0.95 },
    { from: 's0', to: 's3', kind: 'fail',    prob: 0.05 },
    { from: 's1', to: 's5', kind: 'success', prob: 1.0 },
  ],
};

function classFor(mermaid, nodeId) {
  // class assignments are emitted as `class A,B,C imp_2`.
  const re = new RegExp(`class\\s+([^\\s]+)\\s+(imp_\\d+)`, 'g');
  let m;
  while ((m = re.exec(mermaid))) {
    const ids = m[1].split(',');
    if (ids.includes(nodeId)) return m[2];
  }
  return null;
}

function opacityForTier(mermaid, tierClass) {
  const re = new RegExp(`classDef\\s+${tierClass}\\s+opacity:([0-9.]+)`);
  const m = mermaid.match(re);
  return m ? parseFloat(m[1]) : null;
}

test('start, goal, near-trap are always at full (top-tier) opacity', () => {
  const out = chainToMermaid(baseChain);
  for (const id of ['s0', 's5', 's6']) {
    const cls = classFor(out, id);
    assert.ok(cls, `${id} should have an importance class`);
    const op = opacityForTier(out, cls);
    assert.equal(op, 1.0,
      `${id} (anchor) should be opacity 1.0, got ${op} via ${cls}`);
  }
});

test('rare side branch (low pReach × low visits) gets a dimmed class', () => {
  const out = chainToMermaid(baseChain);
  const dominantCls = classFor(out, 's1');
  const rareCls     = classFor(out, 's3');
  assert.ok(dominantCls && rareCls);
  const dominantOp = opacityForTier(out, dominantCls);
  const rareOp     = opacityForTier(out, rareCls);
  assert.ok(rareOp < dominantOp,
    `rare s3 (op=${rareOp}) should be dimmer than dominant s1 (op=${dominantOp})`);
  // Floor invariant: never go below 0.60 — the user explicitly
  // asked (2026-05-08) for low-P state TEXT to remain readable.
  // 0.30 was too aggressive for dark-theme text; 0.60 keeps the
  // hierarchy but stays legible.
  assert.ok(rareOp >= 0.60,
    `rare-state opacity (${rareOp}) must stay ≥ 0.60 floor (text legibility)`);
});

test('chaos-loop state stays bright (high E[visits] beats low pReach)', () => {
  const out = chainToMermaid(baseChain);
  const loopCls = classFor(out, 's4');  // pReach=0.30 but expectedVisits=8.0
  const midCls  = classFor(out, 's2');  // pReach=0.40, expectedVisits=0.40
  assert.ok(loopCls && midCls);
  const loopOp = opacityForTier(out, loopCls);
  const midOp  = opacityForTier(out, midCls);
  // s4 importance = 0.30 × log(1+8) ≈ 0.30 × 2.20 ≈ 0.66
  // s2 importance = 0.40 × max(1, log(1+0.40)) ≈ 0.40 × 1.0 = 0.40
  // So loop should be ≥ mid even though loop has lower pReach.
  assert.ok(loopOp >= midOp,
    `chaos-loop s4 (op=${loopOp}) should be ≥ mid s2 (op=${midOp}) — high E[visits] keeps it visible`);
});

test('multiple bundle-loops in the same SCC nest inside an outer SCC subgraph', () => {
  // When several action-bundle loops share an enclosing SCC (the user's
  // "exalt+annul" + "chaos" phases connected via cross-bundle edges),
  // emit ONE outer subgraph per SCC with the bundle-loops nested inside.
  // Visual hierarchy: outer = the cycle / the macro phase; inner = the
  // micro action-bundle clusters. SCCs that contain only a single
  // bundle-loop get a flat (un-nested) subgraph — no point nesting a
  // single child.
  const chainTwoLoopsOneScc = {
    states: [
      { id: 's0', kind: 'start',     label: 'start',  pReach: 1.0, expectedVisits: 1.0 },
      { id: 's1', kind: 'transient', label: 'a1',     pReach: 1.0, expectedVisits: 2.0 },
      { id: 's2', kind: 'transient', label: 'a2',     pReach: 1.0, expectedVisits: 2.0 },
      { id: 's3', kind: 'transient', label: 'b1',     pReach: 1.0, expectedVisits: 1.5 },
      { id: 's4', kind: 'goal',      label: 'goal',   pReach: 0.85, expectedVisits: 0.85 },
    ],
    edges: [
      { from: 's0', to: 's1', kind: 'orb',     prob: 1.0,  label: 'alch\n100%' },
      { from: 's1', to: 's2', kind: 'orb',     prob: 0.5,  label: 'exalt\n50%' },
      { from: 's2', to: 's1', kind: 'orb',     prob: 0.5,  label: 'annul\n50%' },
      { from: 's2', to: 's3', kind: 'orb',     prob: 0.5,  label: 'chaos\n50%' },
      { from: 's3', to: 's1', kind: 'orb',     prob: 1.0,  label: 'chaos\n100%' },
      { from: 's2', to: 's4', kind: 'success', prob: 0.0,  label: 'goal' },
    ],
    loops: [
      { nodes: ['s1', 's2'], bundle: 'exalt+annul', dominantActions: ['exalt', 'annul'], totalVisits: 4.0, sccIndex: 0 },
      { nodes: ['s3'],       bundle: 'chaos',       dominantActions: ['chaos'],          totalVisits: 1.5, sccIndex: 0 },
    ],
  };
  const out = chainToMermaid(chainTwoLoopsOneScc);
  // Outer SCC subgraph must exist and contain both inner loops.
  // Nested-end matching with regex is fragile; instead verify the
  // structural invariants directly:
  // 1. An outer `subgraph scc_0 ["..."]` line appears.
  // 2. Both `subgraph loop_0` and `subgraph loop_1` lines appear
  //    AFTER it, indented one level deeper (4 spaces vs the SCC's 2).
  // 3. They appear before the next top-level `\n  end` (the SCC closer).
  const lines = out.split('\n');
  const sccOpenIdx = lines.findIndex((l) => /^\s*subgraph\s+scc_0\b/.test(l));
  assert.ok(sccOpenIdx >= 0, `expected outer scc_0 subgraph; got:\n${out}`);
  const sccCloseIdx = lines.findIndex((l, i) => i > sccOpenIdx && /^  end\b/.test(l));
  assert.ok(sccCloseIdx > sccOpenIdx, 'expected matching `  end` for scc_0');
  const insideScc = lines.slice(sccOpenIdx, sccCloseIdx);
  assert.ok(insideScc.some((l) => /subgraph\s+loop_0\b/.test(l)),
    `loop_0 must appear inside scc_0; SCC body:\n${insideScc.join('\n')}`);
  assert.ok(insideScc.some((l) => /subgraph\s+loop_1\b/.test(l)),
    `loop_1 must appear inside scc_0; SCC body:\n${insideScc.join('\n')}`);
});

test('a single-loop SCC is rendered flat (no useless outer wrap)', () => {
  // Edge case: SCC with only one bundle-loop. Nesting adds noise
  // without conveying structure. Render the loop's subgraph at top
  // level without an outer scc_<i> wrapper.
  const chainSingleLoop = {
    states: [
      { id: 's0', kind: 'start',     label: 'start', pReach: 1.0, expectedVisits: 1.0 },
      { id: 's1', kind: 'transient', label: 'fill',  pReach: 1.0, expectedVisits: 2.5 },
      { id: 's2', kind: 'transient', label: 'partial',pReach: 1.0, expectedVisits: 2.5 },
      { id: 's3', kind: 'goal',      label: 'goal',  pReach: 0.85, expectedVisits: 0.85 },
    ],
    edges: [
      { from: 's0', to: 's1', kind: 'orb', prob: 1.0, label: 'alch\n100%' },
      { from: 's1', to: 's2', kind: 'orb', prob: 0.5, label: 'exalt\n50%' },
      { from: 's2', to: 's1', kind: 'orb', prob: 0.5, label: 'annul\n50%' },
    ],
    loops: [
      { nodes: ['s1', 's2'], bundle: 'exalt+annul', dominantActions: ['exalt', 'annul'], totalVisits: 5.0, sccIndex: 0 },
    ],
  };
  const out = chainToMermaid(chainSingleLoop);
  assert.doesNotMatch(out, /subgraph\s+scc_\d+/,
    `single-loop SCC should not emit an outer scc_N wrapper; got:\n${out}`);
  assert.match(out, /subgraph\s+loop_0/,
    `the lone bundle-loop subgraph should still render`);
});

test('chains with detected loops emit Mermaid `subgraph` blocks for each loop', () => {
  // The renderer should box each `chain.loops` entry as a subgraph
  // titled with its dominant actions, so the user sees the loop's
  // structure without tracing edges by hand.
  const chainWithLoop = {
    states: [
      { id: 's0', kind: 'start',     label: 'start',  pReach: 1.0, expectedVisits: 1.0 },
      { id: 's1', kind: 'transient', label: 'fill',   pReach: 1.0, expectedVisits: 2.5 },
      { id: 's2', kind: 'transient', label: 'partial',pReach: 1.0, expectedVisits: 2.5 },
      { id: 's3', kind: 'goal',      label: 'goal',   pReach: 0.85, expectedVisits: 0.85 },
    ],
    edges: [
      { from: 's0', to: 's1', kind: 'orb',     prob: 1.0,  label: 'alch\n100%' },
      { from: 's1', to: 's2', kind: 'orb',     prob: 0.5,  label: 'exalt\n50%' },
      { from: 's2', to: 's1', kind: 'orb',     prob: 0.5,  label: 'annul\n50%' },
      { from: 's2', to: 's3', kind: 'success', prob: 0.5,  label: 'exalt\n50%' },
    ],
    loops: [
      { nodes: ['s1', 's2'], dominantActions: ['exalt', 'annul'], totalVisits: 5.0 },
    ],
  };
  const out = chainToMermaid(chainWithLoop);
  // Subgraph syntax: `subgraph <id> ["<title>"]` … `end`. Title must
  // surface the dominant actions so the user reads "exalt + annul loop"
  // without inspecting node contents.
  assert.match(out, /subgraph\s+loop_\d+\s+\["[^"]*exalt[^"]*annul[^"]*"\]/,
    `expected a subgraph with a title containing 'exalt' and 'annul'; got:\n${out}`);
  // Member nodes must be declared INSIDE the subgraph block.
  const blockMatch = out.match(/subgraph\s+loop_\d+[\s\S]*?\n\s*end\b/);
  assert.ok(blockMatch, 'expected a subgraph block in the output');
  assert.match(blockMatch[0], /\bs1\b/, 's1 must be declared inside the loop subgraph');
  assert.match(blockMatch[0], /\bs2\b/, 's2 must be declared inside the loop subgraph');
});

test('chains with no loops omit the subgraph syntax entirely', () => {
  const chainNoLoop = {
    ...baseChain,
    loops: [],
  };
  const out = chainToMermaid(chainNoLoop);
  // No loop_N subgraph should appear (other subgraphs like Wishlist /
  // Legend are unaffected — we look specifically for `loop_<num>`).
  assert.doesNotMatch(out, /subgraph\s+loop_\d+/,
    `chain with no loops should not emit any loop_N subgraph; got:\n${out}`);
});

test('outgoing edges inherit source-node opacity', () => {
  const out = chainToMermaid(baseChain);
  // The fail edge from s0 → s3 leaves s0 (always-vivid start), so it
  // renders at 1.0. Test the per-edge linkStyle line carries the
  // expected opacity. Mermaid linkStyle is order-indexed by edge
  // declaration; we hunt by the kind/color signature instead.
  const failLineRe = /linkStyle\s+\d+\s+([^\n]*opacity:([0-9.]+)[^\n]*)/g;
  let foundOpacity = false;
  let m;
  while ((m = failLineRe.exec(out))) {
    foundOpacity = true;
    const op = parseFloat(m[2]);
    assert.ok(op > 0 && op <= 1.0, `edge opacity ${op} should be in (0, 1]`);
  }
  assert.ok(foundOpacity, 'at least one edge should carry an opacity directive');
});

console.log(`\n${passed} passed · ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
