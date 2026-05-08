// Loose-irrelevant-count merge: when a chain of states differs only
// in their exact irrelevant count (5 irr → 4 irr → 3 irr → … all
// using policy=annul), the chain should collapse into one rep
// labelled `≥N irrelevant`. User report (2026-05-08): "s49 (5 irr) →
// s12 (4 irr) → s39 (3 irr) is a chain of annuls — they should
// merge since the action and outcome behaviour is uniform."

import { strict as assert } from 'node:assert';
import { solveMDP } from '../engine/mdp/solve.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.message}`); }
}

console.log('Chain — loose irrelevant-count merge');

// Synthetic chain that produces multi-irr-only states using annul.
// Use a tight budget + cheap annul so the policy frequently picks
// annul to clear irrelevants on its way to fitting the wished mods.
const fixture = {
  wishlist: [
    { key: 'PREFIX:WISH_P', weight: 800, type: 'PREFIX', requiredTier: 1, required: true },
    { key: 'SUFFIX:WISH_S', weight: 800, type: 'SUFFIX', requiredTier: 1, required: true },
  ],
  irrelevantWeight: 30000,
  irrelevantWeightBySide: { PREFIX: 15000, SUFFIX: 15000 },
  target: { requiredMods: ['PREFIX:WISH_P', 'SUFFIX:WISH_S'], minFilled: 2, maxFilled: 6 },
  start: { rarity: 'normal' },
  basePriceEx: 50,
  alchemyDraws: 4,
  maxFilled: 6,
  timeWeightExPerSec: 0,
  budgetEx: 5000,
  orbCosts: { transmute: 0.01, augment: 0.05, regal: 0.5, alch: 1, exalt: 1, annul: 0.5, fracturing: 50, chaos: 5 },
  orbTimes: { transmute: 1, augment: 1, regal: 1, alch: 1, exalt: 1, annul: 1, fracturing: 3, chaos: 1 },
};

test('multiple irr-only states with same policy collapse into one rep', () => {
  // The chain has multiple states differing only by exact irrelevant
  // count (e.g., 0-wished + 2 irr, 0-wished + 3 irr, etc.) using
  // the same policy. After the loose-irrelevant rule, they should
  // merge.
  const result = solveMDP(fixture);
  // Bucket states by (kind, policy, modMask, wished count) — these
  // should map to a single rep after loose-irr merging. If multiple
  // reps share the same bucket, the loose-irr rule didn't fire.
  const bucketByPolicy = new Map();
  for (const s of result.chain.states) {
    const policy = s.meta?.policy ?? '-';
    if (policy === '-' || policy === 'buy_base') continue; // skip terminals / restart
    // Strip exact irr counts from the label to canonicalise.
    const labelIrrCount = (s.label.match(/^· (\d+) irr/m) ?? [])[1];
    if (!labelIrrCount) continue; // not an irr-bearing state
    // Only consider purely-irr states (no wished bits in label).
    if (/★/.test(s.label)) continue;
    const k = `${s.kind}|${policy}|irr-only`;
    const arr = bucketByPolicy.get(k) ?? [];
    arr.push({ id: s.id, irrCount: parseInt(labelIrrCount, 10) });
    bucketByPolicy.set(k, arr);
  }
  for (const [k, arr] of bucketByPolicy) {
    if (arr.length <= 1) continue;
    assert.fail(
      `expected loose-irr merge: states ${arr.map(a => a.id + '(' + a.irrCount + ')').join(', ')} ` +
      `share kind+policy+wished-pattern but stayed separate. Bucket: ${k}`,
    );
  }
});

console.log(`\n${passed} passed · ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
