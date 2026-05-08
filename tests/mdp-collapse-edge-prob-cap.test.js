// Regression test: after equivalence-class collapse, every chain
// node's outgoing edges (per chosen-action group) must sum to ≤ 1.0
// — probabilities are not additive across collapsed source states,
// they're averaged.
//
// User report (2026-05-07): live craft on Amulet (2 required mods,
// minFilled=2, maxFilled=6, budget=1870ex) showed an edge from s18
// to s60 labelled 200%. Root cause: parallel edges from N collapsed
// sources to a common destination were SUMMED (each source had
// outgoing mass 1.0; N-way merge → mass N).

import { strict as assert } from 'node:assert';
import { solveMDP } from '../engine/mdp/solve.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.message}`); }
}

console.log('Collapse — outgoing edge probability cap');

const baseInput = {
  wishlist: [
    { key: 'PREFIX:WISH_P', weight: 1000, type: 'PREFIX', requiredTier: 1, required: true },
    { key: 'SUFFIX:WISH_S', weight: 1000, type: 'SUFFIX', requiredTier: 1, required: true },
  ],
  irrelevantWeight: 50000,
  irrelevantWeightBySide: { PREFIX: 25000, SUFFIX: 25000 },
  target: { requiredMods: ['PREFIX:WISH_P', 'SUFFIX:WISH_S'], minFilled: 2, maxFilled: 6 },
  start: { rarity: 'normal' },
  basePriceEx: 100,
  alchemyDraws: 4,
  maxFilled: 6,
  timeWeightExPerSec: 0,
  budgetEx: 5000,
  orbCosts: { transmute: 0.01, augment: 0.05, regal: 0.5, alch: 1, exalt: 1, annul: 0.5, fracturing: 50, chaos: 5 },
  orbTimes: { transmute: 1, augment: 1, regal: 1, alch: 1, exalt: 1, annul: 1, fracturing: 3, chaos: 1 },
};

test('collapsed chain: every (from, action) outgoing total is ≤ 1.0 + ε', () => {
  const result = solveMDP({ ...baseInput, collapseEquivalent: true });
  const groupTotals = new Map();
  for (const e of result.chain.edges) {
    const action = (e.label ?? '').split('\n')[0];
    const k = `${e.from}|${action}`;
    groupTotals.set(k, (groupTotals.get(k) ?? 0) + (e.prob ?? 0));
  }
  const violations = [];
  for (const [k, total] of groupTotals) {
    if (total > 1 + 1e-6) violations.push(`${k} sums to ${(total * 100).toFixed(1)}%`);
  }
  if (violations.length) {
    assert.fail(`expected every (from, action) outgoing total ≤ 1.0; got:\n  ${violations.slice(0, 5).join('\n  ')}`);
  }
});

test('individual edge probability never exceeds 100%', () => {
  const result = solveMDP({ ...baseInput, collapseEquivalent: true });
  for (const e of result.chain.edges) {
    assert.ok((e.prob ?? 0) <= 1 + 1e-6,
      `edge ${e.from} → ${e.to} (action ${(e.label ?? '').split('\n')[0]}) has prob ${e.prob} > 1`);
  }
});

test('collapsed chain: every (from, action) outgoing total is ≥ 1.0 - ε (no missing mass)', () => {
  // Companion to the upper-bound test above. User report (2026-05-08):
  // "from s72 I see 2 edges for annul, one 50% the other 33%; doesn't
  // sum to 100%." If outcomes are missing entirely (e.g. dropped on
  // pruning a bricked branch, or merged with their probability lost),
  // the user can't reason about what 17% of the mass is doing.
  // Either every outcome must appear on the chart, OR the missing
  // mass must land on a self-loop / collapsed sibling that's still
  // visible elsewhere — but we shouldn't silently drop it.
  const result = solveMDP({ ...baseInput, collapseEquivalent: true });
  const groupTotals = new Map();
  // Track only states that actually have outgoing edges (terminals
  // legitimately have none).
  const sourcesWithEdges = new Set();
  for (const e of result.chain.edges) {
    const action = (e.label ?? '').split('\n')[0];
    const k = `${e.from}|${action}`;
    groupTotals.set(k, (groupTotals.get(k) ?? 0) + (e.prob ?? 0));
    sourcesWithEdges.add(e.from);
  }
  const shortfalls = [];
  for (const [k, total] of groupTotals) {
    if (total < 1 - 1e-3) {
      shortfalls.push(`${k} sums to only ${(total * 100).toFixed(1)}%`);
    }
  }
  if (shortfalls.length) {
    assert.fail(
      `expected every (from, action) outgoing total ≥ 1.0; missing mass:\n  ` +
      shortfalls.slice(0, 8).join('\n  ') +
      (shortfalls.length > 8 ? `\n  …and ${shortfalls.length - 8} more` : ''),
    );
  }
});

test('annul/chaos outcomes still account for their probability mass after collapse', () => {
  // User report (2026-05-08): "from s72 I see 2 edges for annul, one
  // 50% other 33%; doesn't sum to 100%." Reproduced with a fracture-
  // anchor + tight-budget fixture where chaos action edges visibly
  // shed probability mass. Likely cause: collapse drops self-loops
  // (where an outcome's destination redirects to the same
  // representative as the source) without renormalising.
  const fractureInput = {
    ...baseInput,
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
    basePriceEx: 200,
    budgetEx: 3000,
    orbCosts: { ...baseInput.orbCosts, annul: 5, fracturing: 100 },
  };
  const result = solveMDP(fractureInput);
  const groupTotals = new Map();
  for (const e of result.chain.edges) {
    const action = (e.label ?? '').split('\n')[0];
    const k = `${e.from}|${action}`;
    groupTotals.set(k, (groupTotals.get(k) ?? 0) + (e.prob ?? 0));
  }
  const shortfalls = [];
  for (const [k, total] of groupTotals) {
    if (total < 1 - 1e-3) {
      shortfalls.push(`${k} sums to only ${(total * 100).toFixed(1)}%`);
    }
  }
  // Allow shortfalls only when there's a corresponding edge to a
  // bricked / near-trap state that visibly explains the missing mass.
  // If shortfalls exist with no visible "lost branch" representation,
  // the user can't see what the missing % went to.
  const stateById = new Map(result.chain.states.map((s) => [s.id, s]));
  const unexplained = [];
  for (const k of shortfalls) {
    const fromId = k.split('|')[0].split(' ')[0];
    const action = k.split('|')[1];
    const outgoing = result.chain.edges.filter(
      (e) => e.from === fromId && (e.label ?? '').split('\n')[0] === action,
    );
    const reachesTerminal = outgoing.some((e) => {
      const dst = stateById.get(e.to);
      return dst?.kind === 'bricked' || dst?.kind === 'near-trap';
    });
    if (!reachesTerminal) unexplained.push(k);
  }
  assert.equal(unexplained.length, 0,
    `expected (from, action) totals ≥ 1.0 OR a visible terminal/bricked sink ` +
    `representing the lost probability mass. Unexplained:\n  ` +
    unexplained.slice(0, 8).join('\n  '));
});

test('collapse does not change pSuccessStart vs uncollapsed chain', () => {
  // The collapse is a presentational re-shape; the underlying
  // probability of reaching goal under π* should be invariant.
  const off = solveMDP({ ...baseInput, collapseEquivalent: false });
  const on  = solveMDP({ ...baseInput, collapseEquivalent: true });
  assert.ok(Math.abs(off.chain.pSuccessStart - on.chain.pSuccessStart) < 1e-6,
    `pSuccessStart should be invariant under collapse; off=${off.chain.pSuccessStart}, on=${on.chain.pSuccessStart}`);
});

console.log(`\n${passed} passed · ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
