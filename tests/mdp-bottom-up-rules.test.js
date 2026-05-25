// Unit tests for the bottom-up merge rules (chain.js
// applyBottomUpSiblingMerge). Tests build synthetic chain states +
// edges, run the merge function, and assert the rule's intended
// behaviour. No engine call — keeps the test focused on the rule
// logic itself.
//
// Spec: docs/chain-rendering.md §8.

import { strict as assert } from 'node:assert';
import { applyBottomUpSiblingMerge } from '../engine/mdp/chain.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.message}`); }
}

console.log('Bottom-up merge — per-rule unit tests');

// Helper: build a chain state. Minimal shape that the merge function
// inspects (id, kind, meta.policy).
const makeState = (id, policy) => ({
  id,
  label: `[${id}] ${policy ? `(${policy})` : 'terminal'}`,
  kind: policy ? 'transient' : 'goal',
  meta: { policy: policy ?? null },
});
// Helper: build an edge. Probability defaults to 1 so per-action
// totals stay clean; tests that want renorm checks pass explicit prob.
const makeEdge = (from, to, action, prob = 1.0) => ({
  from, to,
  label: `${action}\n${(prob * 100).toFixed(1)}%`,
  prob,
  kind: 'internal',
});

// ─────────────────────────────────────────────────────────
// R1: sibling merge.
// ─────────────────────────────────────────────────────────

test('R1 sibling merge — two children of the same parent under one action with same next-action collapse', () => {
  // Chain shape:
  //   A (next: alpha) → B (next: beta)
  //   A (next: alpha) → C (next: beta)
  //   B (next: beta)  → D (terminal)
  //   C (next: beta)  → E (terminal)
  // R1 should merge B and C (same parent A, same parent action alpha,
  // same next-action beta). D and E independently merge under R1
  // when seen as B-and-C's siblings post-merge → one rep, both
  // terminals. End state: A, [BC], [DE].
  const states = [
    makeState('s0', 'alpha'),
    makeState('s1', 'beta'),
    makeState('s2', 'beta'),
    makeState('s3', null),
    makeState('s4', null),
  ];
  const edges = [
    makeEdge('s0', 's1', 'alpha', 0.5),
    makeEdge('s0', 's2', 'alpha', 0.5),
    makeEdge('s1', 's3', 'beta', 1.0),
    makeEdge('s2', 's4', 'beta', 1.0),
  ];
  applyBottomUpSiblingMerge(states, edges);
  // s1 and s2 should merge. s3 and s4 are terminals (policy=null);
  // R1 requires a non-null next-action, so they DON'T merge — they
  // stay as separate goals.
  const ids = new Set(states.map((s) => s.id));
  assert.ok(ids.has('s0'), 's0 (parent) should remain');
  // Exactly one of s1, s2 remains (rep is the lower-id member).
  const remaining = ['s1', 's2'].filter((id) => ids.has(id));
  assert.equal(remaining.length, 1,
    `exactly one of s1/s2 should remain (R1 merges them); got: ${remaining.join(', ')}`);
  assert.equal(remaining[0], 's1', 'rep should be the lower-id member');
});

test('R1 sibling merge — children with DIFFERENT next-actions stay separate', () => {
  // Shape:
  //   A (next: alpha) → B (next: beta)
  //   A (next: alpha) → C (next: gamma)
  // R1 must NOT fire — B and C have different next-actions, so the
  // user genuinely needs to see them as different phases.
  const states = [
    makeState('s0', 'alpha'),
    makeState('s1', 'beta'),
    makeState('s2', 'gamma'),
  ];
  const edges = [
    makeEdge('s0', 's1', 'alpha', 0.5),
    makeEdge('s0', 's2', 'alpha', 0.5),
  ];
  applyBottomUpSiblingMerge(states, edges);
  const ids = new Set(states.map((s) => s.id));
  assert.ok(ids.has('s1') && ids.has('s2'),
    `s1 and s2 should both remain (different next-actions, no R1 merge); states: ${[...ids].join(', ')}`);
});

test('R1 sibling merge — children of DIFFERENT parents stay separate', () => {
  // Shape:
  //   A (next: alpha) → B (next: gamma)
  //   X (next: alpha) → C (next: gamma)
  // B and C have the same parent action AND the same next-action,
  // but different parents — they're NOT siblings under R1's rule
  // and should not merge. (Distant-state merging is the top-down
  // strategy's job, not bottom-up.)
  const states = [
    makeState('s0', 'alpha'),
    makeState('s1', 'gamma'),
    makeState('s2', 'alpha'),
    makeState('s3', 'gamma'),
  ];
  const edges = [
    makeEdge('s0', 's1', 'alpha', 1.0),
    makeEdge('s2', 's3', 'alpha', 1.0),
  ];
  applyBottomUpSiblingMerge(states, edges);
  const ids = new Set(states.map((s) => s.id));
  assert.ok(ids.has('s1') && ids.has('s3'),
    `s1 and s3 should both remain (different parents, no sibling relation); got: ${[...ids].join(', ')}`);
});

// ─────────────────────────────────────────────────────────
// R2: linear-chain merge.
// ─────────────────────────────────────────────────────────

test('R2 linear-chain merge — A→B with same next-action collapses', () => {
  // Shape:
  //   A (next: alpha) → B (next: alpha) → C (next: beta)
  // R2 fires on the A→B edge: same next-action on both endpoints.
  // After merge, [AB] → C remains; [AB] has next=alpha, C has
  // next=beta, so no further linear merge.
  const states = [
    makeState('s0', 'alpha'),
    makeState('s1', 'alpha'),
    makeState('s2', 'beta'),
  ];
  const edges = [
    makeEdge('s0', 's1', 'alpha', 1.0),
    makeEdge('s1', 's2', 'alpha', 1.0),
  ];
  applyBottomUpSiblingMerge(states, edges);
  const ids = new Set(states.map((s) => s.id));
  // s0 and s1 merge (rep = s0, lower id); s2 stays.
  assert.ok(ids.has('s0'), 's0 (rep) should remain');
  assert.ok(ids.has('s2'), 's2 should remain (different next-action)');
  assert.ok(!ids.has('s1'), `s1 should have merged into s0; remaining: ${[...ids].join(', ')}`);
  // Edge from rep to s2 should still exist.
  const repToS2 = edges.find((e) => e.from === 's0' && e.to === 's2');
  assert.ok(repToS2, 's0 → s2 edge should survive the merge');
});

test('R2 linear-chain merge — long chain A→B→C→D all same action collapses transitively', () => {
  // Iterative passes should collapse A,B,C,D into one rep when every
  // adjacent pair has the same next-action. After pass 1: A-B and
  // C-D merge (each pair). Pass 2: [AB] connected to [CD] via the
  // B→C edge, both still same action ⇒ further merge. End: one rep.
  const states = [
    makeState('s0', 'alpha'),
    makeState('s1', 'alpha'),
    makeState('s2', 'alpha'),
    makeState('s3', 'alpha'),
    makeState('s4', 'beta'),
  ];
  const edges = [
    makeEdge('s0', 's1', 'alpha', 1.0),
    makeEdge('s1', 's2', 'alpha', 1.0),
    makeEdge('s2', 's3', 'alpha', 1.0),
    makeEdge('s3', 's4', 'alpha', 1.0),
  ];
  applyBottomUpSiblingMerge(states, edges);
  const ids = new Set(states.map((s) => s.id));
  // s0..s3 all collapse into one rep (s0). s4 stays.
  assert.ok(ids.has('s0'), 's0 (rep of the chain) should remain');
  assert.ok(ids.has('s4'), 's4 should remain (different next-action)');
  for (const id of ['s1', 's2', 's3']) {
    assert.ok(!ids.has(id), `${id} should have merged into s0; remaining: ${[...ids].join(', ')}`);
  }
});

test('R2 linear-chain merge — different next-actions stay separate', () => {
  // Shape:
  //   A (next: alpha) → B (next: beta) → C
  // R2 must NOT fire across the A→B edge (different next-actions).
  const states = [
    makeState('s0', 'alpha'),
    makeState('s1', 'beta'),
    makeState('s2', null),
  ];
  const edges = [
    makeEdge('s0', 's1', 'alpha', 1.0),
    makeEdge('s1', 's2', 'beta', 1.0),
  ];
  applyBottomUpSiblingMerge(states, edges);
  const ids = new Set(states.map((s) => s.id));
  assert.ok(ids.has('s0') && ids.has('s1'),
    `s0 and s1 should both remain (different next-actions); got: ${[...ids].join(', ')}`);
});

test('R2 linear-chain merge — self-loop is not treated as A→B', () => {
  // A self-loop (s0→s0) shouldn't trigger R2 — there's no "B" to
  // merge into. The state should remain alone.
  const states = [
    makeState('s0', 'alpha'),
    makeState('s1', 'beta'),
  ];
  const edges = [
    makeEdge('s0', 's0', 'alpha', 0.5), // self-loop
    makeEdge('s0', 's1', 'alpha', 0.5),
  ];
  applyBottomUpSiblingMerge(states, edges);
  const ids = new Set(states.map((s) => s.id));
  assert.equal(states.length, 2, `expected 2 states (no R2 self-merge); got: ${[...ids].join(', ')}`);
});

// ─────────────────────────────────────────────────────────
// R3: reverse-sibling merge (mirror of R1).
// ─────────────────────────────────────────────────────────

test('R3 reverse-sibling merge — two predecessors converging to one destination via same action collapse', () => {
  // Shape:
  //   B (next: alpha) → A
  //   C (next: alpha) → A
  // Both B and C transition to A via action alpha. R3 merges B and C
  // because they're presentationally interchangeable (both lead to
  // A under alpha).
  const states = [
    makeState('s0', null),       // A (terminal)
    makeState('s1', 'alpha'),    // B
    makeState('s2', 'alpha'),    // C
  ];
  const edges = [
    makeEdge('s1', 's0', 'alpha', 1.0),
    makeEdge('s2', 's0', 'alpha', 1.0),
  ];
  applyBottomUpSiblingMerge(states, edges);
  const ids = new Set(states.map((s) => s.id));
  // B and C merge (rep = s1, lower id).
  assert.ok(ids.has('s0'), 's0 (destination) should remain');
  const remaining = ['s1', 's2'].filter((id) => ids.has(id));
  assert.equal(remaining.length, 1,
    `exactly one of s1/s2 should remain after R3 merge; got: ${remaining.join(', ')}`);
  assert.equal(remaining[0], 's1', 'rep should be the lower-id member');
});

test('R3 reverse-sibling merge — predecessors with DIFFERENT actions stay separate', () => {
  // B → A via alpha, C → A via beta. Different actions, so R3 must
  // NOT fire — the user's view distinguishes "annul lands at A" from
  // "exalt lands at A" since the orb cost / probability differ.
  const states = [
    makeState('s0', null),
    makeState('s1', 'alpha'),
    makeState('s2', 'beta'),
  ];
  const edges = [
    makeEdge('s1', 's0', 'alpha', 1.0),
    makeEdge('s2', 's0', 'beta', 1.0),
  ];
  applyBottomUpSiblingMerge(states, edges);
  const ids = new Set(states.map((s) => s.id));
  assert.ok(ids.has('s1') && ids.has('s2'),
    `s1 and s2 should both remain (different actions); got: ${[...ids].join(', ')}`);
});

test('R3 reverse-sibling merge — predecessors converging to DIFFERENT destinations stay separate', () => {
  // B → A and C → D, both via action alpha. Different destinations,
  // R3 must not merge B and C — they're behaviourally distinct (B
  // alpha-lands at A, C alpha-lands at D).
  const states = [
    makeState('s0', null),       // A
    makeState('s1', 'alpha'),    // B
    makeState('s2', 'alpha'),    // C
    makeState('s3', null),       // D
  ];
  const edges = [
    makeEdge('s1', 's0', 'alpha', 1.0),
    makeEdge('s2', 's3', 'alpha', 1.0),
  ];
  applyBottomUpSiblingMerge(states, edges);
  const ids = new Set(states.map((s) => s.id));
  assert.ok(ids.has('s1') && ids.has('s2'),
    `s1 and s2 should both remain (different destinations); got: ${[...ids].join(', ')}`);
});

// ─────────────────────────────────────────────────────────
// R1 + R2 interaction.
// ─────────────────────────────────────────────────────────

test('R1 + R3 cascade — full parallel chains collapse iteratively', () => {
  // Shape (two parallel paths from S to G):
  //   S → A1 (next: alpha) → B1 (next: beta) → G
  //   S → A2 (next: alpha) → B2 (next: beta) → G
  // Pass 1 R1: A1 and A2 are siblings under S+rootAction with same
  //            next-action alpha → merge. Similarly B1 and B2 are
  //            siblings under their respective parents with same
  //            next-action beta — but only AFTER A1,A2 merge would
  //            they share a parent.
  // Pass 1 R3: B1 → G and B2 → G via beta → merge B1, B2 immediately.
  // Pass 2: with B1,B2 merged → [B] and A1, A2 each have one outgoing
  //         edge to [B] under alpha. R3 fires again to merge A1, A2.
  // End: S → A → B → G.
  const states = [
    makeState('s0', 'root'),
    makeState('s1', 'alpha'),  // A1
    makeState('s2', 'alpha'),  // A2
    makeState('s3', 'beta'),   // B1
    makeState('s4', 'beta'),   // B2
    makeState('s5', null),     // G
  ];
  const edges = [
    makeEdge('s0', 's1', 'root', 0.5),
    makeEdge('s0', 's2', 'root', 0.5),
    makeEdge('s1', 's3', 'alpha', 1.0),
    makeEdge('s2', 's4', 'alpha', 1.0),
    makeEdge('s3', 's5', 'beta', 1.0),
    makeEdge('s4', 's5', 'beta', 1.0),
  ];
  applyBottomUpSiblingMerge(states, edges);
  const ids = new Set(states.map((s) => s.id));
  // Expected: S, [A1+A2], [B1+B2], G — exactly 4 states.
  assert.equal(states.length, 4,
    `expected 4 states after R1+R3 cascade (S, merged-A, merged-B, G); got ${states.length}: ${[...ids].join(', ')}`);
  // S, G must still be present.
  assert.ok(ids.has('s0'), 's0 (start) should remain');
  assert.ok(ids.has('s5'), 's5 (goal) should remain');
});

test('R1 and R2 compose — sibling merge enables linear-chain merge in next pass', () => {
  // Shape:
  //   A (next: alpha) → B (next: beta) → D (next: beta)
  //   A (next: alpha) → C (next: beta) → E (next: beta)
  // Pass 1: R1 merges {B,C} → [BC] under shared parent A and shared
  // next-action beta. After R1, [BC] has TWO outgoing edges (to D
  // and E), both labelled beta, both leading to states with next=beta.
  // Pass 1 R1 also merges D and E (siblings of [BC] under same
  // parent action beta, same next-action beta).
  // Pass 2: R2 fires on [BC]→[DE] (same next-action beta on both),
  // merging them. End: A, [BCDE].
  const states = [
    makeState('s0', 'alpha'),
    makeState('s1', 'beta'),
    makeState('s2', 'beta'),
    makeState('s3', 'beta'),
    makeState('s4', 'beta'),
  ];
  const edges = [
    makeEdge('s0', 's1', 'alpha', 0.5),
    makeEdge('s0', 's2', 'alpha', 0.5),
    makeEdge('s1', 's3', 'beta', 1.0),
    makeEdge('s2', 's4', 'beta', 1.0),
  ];
  applyBottomUpSiblingMerge(states, edges);
  const ids = new Set(states.map((s) => s.id));
  assert.ok(ids.has('s0'), 's0 (parent) should remain');
  // After full merging: s0 + ONE merged rep covering s1,s2,s3,s4.
  assert.equal(states.length, 2,
    `expected 2 states after R1+R2 cascade (parent + merged-children); got ${states.length}: ${[...ids].join(', ')}`);
});

console.log(`\n${passed} passed · ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
