// Chain edge probability invariant: every chain node's outgoing
// edges sum to AT MOST 1.0 across ALL actions combined. Each chain
// node has a single optimal policy action, so per-source edges share
// one action and sum to 1.0. After any merge strategy, the rep's
// outgoing should still respect this — if it doesn't, two reps with
// different policies got merged into one (a partition leak) or the
// renormalisation pass missed a case.
//
// User report (2026-05-09): on an Amulet ilvl=72 craft with cold+fire
// suffix wishlist + targetBoneMod=true + budget=1630ex, s28 has 2
// outgoing edges each at 100% probability. This test should catch it
// across every merge strategy.

import { strict as assert } from 'node:assert';
import { solveMDP } from '../engine/mdp/solve.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.message}`); }
}

console.log('Chain — per-node outgoing probability sums to ≤ 1.0');

// Mirrors the user-reported scenario closely enough to provoke the
// same bug shape: cold + fire suffix wishlist + bone-mod target,
// modest budget, time-weighted.
const baseInput = {
  wishlist: [
    { key: 'SUFFIX:cold', weight: 800, type: 'SUFFIX', requiredTier: 3, required: true },
    { key: 'SUFFIX:fire', weight: 800, type: 'SUFFIX', requiredTier: 3, required: true },
  ],
  irrelevantWeight: 30000,
  irrelevantWeightBySide: { PREFIX: 15000, SUFFIX: 15000 },
  target: {
    requiredMods: ['SUFFIX:cold', 'SUFFIX:fire'],
    minFilled: 2, maxFilled: 5,
    allowBonePending: true,
  },
  start: { rarity: 'normal' },
  basePriceEx: 100, alchemyDraws: 4, maxFilled: 5, timeWeightExPerSec: 0.1,
  budgetEx: 1630,
  orbCosts: { transmute: 0.01, augment: 0.05, regal: 0.5, alch: 1, exalt: 1, annul: 9.5, fracturing: 50, chaos: 5 },
  orbTimes: { transmute: 1, augment: 1, regal: 1, alch: 1, exalt: 1, annul: 1, fracturing: 3, chaos: 1 },
};

// Run the invariant against several scenario permutations. The user-
// reported bug surfaced on a specific Amulet+bone-pending+budget
// fixture; the same bug class can plausibly appear elsewhere too.
const scenarios = [
  { name: 'baseline', tweak: (i) => i },
  { name: 'without-bone', tweak: (i) => ({ ...i, target: { ...i.target, allowBonePending: false } }) },
  { name: 'tighter-budget', tweak: (i) => ({ ...i, budgetEx: 500 }) },
  { name: 'looser-budget', tweak: (i) => ({ ...i, budgetEx: 10000 }) },
  { name: 'no-time-weight', tweak: (i) => ({ ...i, timeWeightExPerSec: 0 }) },
  { name: 'fracture-required',
    tweak: (i) => ({
      ...i,
      target: { ...i.target, fracturedKey: 'SUFFIX:cold' },
    }),
  },
  { name: 'minFilled-3',
    tweak: (i) => ({ ...i, target: { ...i.target, minFilled: 3 } }),
  },
];

// User report (2026-05-09): chain edge displays "100%" twice when
// the underlying edge prob is actually halved by the post-merge
// renormalisation. Cause: applyKeyMerge updated `e.prob` but left
// `e.label` (which the Mermaid renderer uses for the displayed
// percentage). Pin label-vs-prob consistency across all strategies.
const labelPctRe = /(\d+(?:\.\d+)?(?:e[+-]?\d+)?)%$/;
for (const scn of [{ name: 'baseline', tweak: (i) => i }]) {
  for (const strategy of ['per-action', 'top-down', 'bottom-up']) {
    test(`edge labels reflect the post-merge prob (${scn.name}, strategy=${strategy})`, () => {
      const result = solveMDP({ ...scn.tweak(baseInput), mergeStrategy: strategy });
      for (const e of result.chain.edges) {
        const lastLine = (e.label ?? '').split('\n').at(-1) ?? '';
        const m = labelPctRe.exec(lastLine);
        if (!m) continue; // edges without a percentage suffix are exempt
        const labelled = parseFloat(m[1]);
        const actual = (e.prob ?? 0) * 100;
        // 0.5% tolerance — fmtP rounds to one decimal, plus we accept
        // small floating drift from successive sums/divides.
        assert.ok(Math.abs(labelled - actual) < 0.5,
          `edge ${e.from}→${e.to}: label says ${labelled}% but prob=${actual.toFixed(2)}%; ` +
          `label "${e.label}" out of sync with prob`);
      }
    });
  }
}

for (const scn of scenarios) {
  for (const strategy of ['none', 'per-action', 'top-down', 'bottom-up']) {
    test(`every chain node's total outgoing probability ≤ 1.0 (${scn.name}, strategy=${strategy})`, () => {
      const result = solveMDP({ ...scn.tweak(baseInput), mergeStrategy: strategy });
      const totals = new Map();
      const byFrom = new Map();
      for (const e of result.chain.edges) {
        totals.set(e.from, (totals.get(e.from) ?? 0) + (e.prob ?? 0));
        if (!byFrom.has(e.from)) byFrom.set(e.from, []);
        byFrom.get(e.from).push(e);
      }
      const offenders = [...totals.entries()]
        .filter(([, t]) => t > 1 + 1e-3)
        .map(([from, t]) => ({
          from,
          total: Number(t.toFixed(3)),
          edges: byFrom.get(from).map((e) => ({
            to: e.to,
            action: (e.label ?? '').split('\n')[0],
            prob: Number((e.prob ?? 0).toFixed(3)),
          })),
        }));
      assert.equal(offenders.length, 0,
        `expected every node's outgoing probability sum ≤ 1.0; got ${offenders.length} offenders:\n  ` +
        offenders.slice(0, 3).map((o) => JSON.stringify(o)).join('\n  '));
    });
  }
}

console.log(`\n${passed} passed · ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
