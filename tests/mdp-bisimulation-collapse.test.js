// Bisimulation-based chain collapse: replace the one-shot eqKey
// grouping with a partition-refinement fixed point. Two states are
// in the same partition iff:
//   1. Same chosen policy action (or both terminals).
//   2. Same user-visible label (canonical form — strips step-id
//      prefix and floating-point annotations).
//   3. Transition outcomes land in the same destination classes
//      with the same per-class probability mass.
//
// The result is the smallest partition that preserves both the
// optimal policy and the user's ability to identify which node a
// concrete item maps to.

import { strict as assert } from 'node:assert';
import { solveMDP } from '../engine/mdp/solve.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.message}`); }
}

console.log('Bisimulation chain collapse');

const symmetricInput = {
  // Two interchangeable required suffixes — classic mirror case.
  wishlist: [
    { key: 'SUFFIX:cold', weight: 800, type: 'SUFFIX', requiredTier: 3, required: true },
    { key: 'SUFFIX:fire', weight: 800, type: 'SUFFIX', requiredTier: 3, required: true },
  ],
  irrelevantWeight: 30000,
  irrelevantWeightBySide: { PREFIX: 15000, SUFFIX: 15000 },
  target: { requiredMods: ['SUFFIX:cold', 'SUFFIX:fire'], minFilled: 2, maxFilled: 5 },
  start: { rarity: 'normal' },
  basePriceEx: 100,
  alchemyDraws: 4,
  maxFilled: 5,
  timeWeightExPerSec: 0,
  budgetEx: 5000,
  orbCosts: { transmute: 0.01, augment: 0.05, regal: 0.5, alch: 1, exalt: 1, annul: 9.5, fracturing: 50 },
  orbTimes: { transmute: 1, augment: 1, regal: 1, alch: 1, exalt: 1, annul: 1, fracturing: 3 },
};

function canonLabel(label) {
  return String(label)
    .replace(/^\[s\d+\]\s*/m, '')
    .replace(/V\*=[^\n]*/g, '')
    .replace(/fromBudget=[^\n]*/g, '')
    .replace(/fromBase=[^\n]*/g, '')
    .replace(/P_reach=[^\n]*/g, '')
    .replace(/visits=[^\n]*/g, '')
    .replace(/\n+/g, '\n')
    .trim();
}

test('chain.states are uniquely identifiable by (kind, policy, canonicalLabel)', () => {
  // The user's distinguishability invariant: given a concrete item,
  // exactly one chain node corresponds to it. After collapse, two
  // chain states sharing kind+policy+canonical-label MUST have
  // genuinely different transition behaviour — otherwise they're
  // indistinguishable to the user and should be merged.
  const result = solveMDP({ ...symmetricInput, collapseEquivalent: true });
  // Bucket chainStates by (kind, policy, canonical-label).
  const buckets = new Map();
  for (const s of result.chain.states) {
    const policy = s.meta?.policy ?? '-';
    const k = `${s.kind}|${policy}|${canonLabel(s.label)}`;
    const arr = buckets.get(k) ?? [];
    arr.push(s);
    buckets.set(k, arr);
  }
  // Build edge index for the transition-equivalence check.
  const outBy = new Map();
  for (const e of result.chain.edges) {
    if (!outBy.has(e.from)) outBy.set(e.from, []);
    outBy.get(e.from).push(e);
  }
  // For each multi-state bucket, compute each member's transition
  // signature and assert that members with the SAME signature are
  // a true partition violation.
  const stateById = new Map(result.chain.states.map((s) => [s.id, s]));
  const transitionSig = (s) => {
    const out = outBy.get(s.id) ?? [];
    // Aggregate outgoing prob per destination's bucket key.
    const byTarget = new Map();
    for (const e of out) {
      const target = stateById.get(e.to);
      if (!target) continue;
      const tk = `${target.kind}|${target.meta?.policy ?? '-'}|${canonLabel(target.label)}`;
      byTarget.set(tk, (byTarget.get(tk) ?? 0) + (e.prob ?? 0));
    }
    return [...byTarget.entries()].sort()
      .map(([k, p]) => `${k}::${p.toFixed(3)}`)
      .join('|');
  };
  const offenders = [];
  for (const [bk, members] of buckets) {
    if (members.length <= 1) continue;
    // Group by transition signature; if any sig has 2+ members,
    // those are duplicates the user can't tell apart.
    const sigGroups = new Map();
    for (const s of members) {
      const sig = transitionSig(s);
      const arr = sigGroups.get(sig) ?? [];
      arr.push(s.id);
      sigGroups.set(sig, arr);
    }
    for (const [_, ids] of sigGroups) {
      if (ids.length > 1) {
        offenders.push({ bucket: bk, ids });
      }
    }
  }
  assert.equal(offenders.length, 0,
    `every multi-state bucket should differ in transition signature (otherwise members are indistinguishable). ` +
    `Offenders:\n  ` + offenders.slice(0, 3).map((o) => `${o.ids.length} ids in "${o.bucket.slice(0, 60)}…": ${o.ids.join(', ')}`).join('\n  '));
});

test('non-symmetric wishlist (different weights) keeps states distinct', () => {
  // Sanity: when wished mods have different weights, "got cold" and
  // "got fire" produce different transition probabilities downstream
  // (chasing the missing one has different success rate). Bisimulation
  // splits them — they must remain distinct.
  const nonSym = {
    ...symmetricInput,
    wishlist: [
      { key: 'SUFFIX:cold', weight: 800,  type: 'SUFFIX', requiredTier: 3, required: true },
      { key: 'SUFFIX:fire', weight: 1500, type: 'SUFFIX', requiredTier: 3, required: true },
    ],
  };
  const result = solveMDP({ ...nonSym, collapseEquivalent: true });
  // Verify both cold-only and fire-only states still exist.
  const labels = result.chain.states.map((s) => s.label);
  const hasColdOnly = labels.some((l) => /cold/i.test(l) && !/fire/i.test(l));
  const hasFireOnly = labels.some((l) => /fire/i.test(l) && !/cold/i.test(l));
  if (!hasColdOnly && !hasFireOnly) return; // chain too small, vacuous
  assert.ok(hasColdOnly && hasFireOnly,
    `non-equivalent wished mods should keep separate identity-specific states; cold-only=${hasColdOnly}, fire-only=${hasFireOnly}`);
});

test('terminal states with same canonical label collapse regardless of engine details', () => {
  // Goals/bricked have no outgoing transitions, so the transition-
  // equivalence axiom is vacuous: any two terminals with the same
  // (kind, label) must collapse since there's no behaviour left to
  // distinguish them. Engine-level details (irrFractured, bone state)
  // are invisible to the user once the goal is reached, so they
  // shouldn't proliferate goal nodes.
  const result = solveMDP({ ...symmetricInput, collapseEquivalent: true });
  const goalsByLabel = new Map();
  for (const s of result.chain.states) {
    if (s.kind !== 'goal') continue;
    const k = canonLabel(s.label);
    const arr = goalsByLabel.get(k) ?? [];
    arr.push(s.id);
    goalsByLabel.set(k, arr);
  }
  for (const [k, ids] of goalsByLabel) {
    assert.equal(ids.length, 1,
      `expected ≤1 goal state per canonical label; got ${ids.length} for "${k.slice(0,60)}…": ${ids.join(', ')}`);
  }
});

console.log(`\n${passed} passed · ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
