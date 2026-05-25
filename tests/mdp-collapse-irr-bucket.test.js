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

test('irr-only states with same policy stay distinct when totalMods differs (G2 invariant)', () => {
  // Per chain-rendering spec §3, the partition includes `totalMods`
  // exactly so each concrete item maps to a unique rep. Irr-only
  // states at different totalMods (e.g. 0-wished + 2 irr vs 0-wished
  // + 3 irr) are GENUINELY different items — collapsing them would
  // violate G2 (an item with tm=3 fits both reps' label envelopes).
  // The previous test asserted the OPPOSITE (loose-irr bucket merge
  // across totalMods) under an older partition design; the spec
  // shifted to favor disambiguity over fewer nodes.
  const result = solveMDP(fixture);
  const bucketByPolicy = new Map();
  for (const s of result.chain.states) {
    const policy = s.meta?.policy ?? '-';
    if (policy === '-' || policy === 'buy_base') continue;
    // Only purely-irr states (no wished bits in label).
    if (/★/.test(s.label)) continue;
    const labelIrrCount = (s.label.match(/^· (\d+) irr/m) ?? [])[1];
    if (!labelIrrCount) continue;
    const k = `${s.kind}|${policy}|irr-only`;
    const arr = bucketByPolicy.get(k) ?? [];
    arr.push({ id: s.id, irrCount: parseInt(labelIrrCount, 10) });
    bucketByPolicy.set(k, arr);
  }
  // Within each bucket, all reps must have DIFFERENT irrCounts —
  // otherwise we have two reps representing the same concrete item
  // shape, which IS the bug we want to flag.
  for (const [k, arr] of bucketByPolicy) {
    const counts = arr.map((a) => a.irrCount);
    const uniqueCounts = new Set(counts);
    assert.equal(uniqueCounts.size, counts.length,
      `duplicate irrCounts within bucket ${k}: ${arr.map(a => a.id + '(' + a.irrCount + ')').join(', ')}`);
  }
});

console.log(`\n${passed} passed · ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
