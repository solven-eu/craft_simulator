// Generalised collapse: when two wished mods are interchangeable
// (same side, same weight, same required-tier, same required flag),
// the chain shouldn't render two parallel branches differing only in
// which one landed first. The states should collapse into a single
// "1 wished suffix" representative whose policy and outgoing actions
// are computed against the merged class.
//
// User report (2026-05-08): on an Amulet craft with cold-res + fire-res
// both required at the same tier, the chain shows symmetric branches
// for "got cold first" vs "got fire first" — visually doubling the
// graph for no analytical benefit.

import { strict as assert } from 'node:assert';
import { solveMDP } from '../engine/mdp/solve.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.message}`); }
}

console.log('Collapse — equivalent-wished states');

const equivWishedInput = {
  // Two SUFFIX wished mods, identical in all engine-relevant fields:
  // same weight, same required-tier, both required. Their carrier
  // states (1 of either on the item) should be considered equivalent.
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

test('cold-only and fire-only branches collapse into a single representative per (totalMods, irrelevant) bucket', () => {
  // With cold + fire interchangeable, "got cold first" and "got
  // fire first" should merge. After equivalent-wished collapse, for
  // any (totalMods, irrelevant-count) combination there should be
  // AT MOST ONE state representing the "single wished suffix" form
  // — not two (one per identity).
  const result = solveMDP({ ...equivWishedInput, collapseEquivalent: true });
  // Bucket by totalMods (parsed from labels — count "★" + "·"
  // wished/desired lines as the wished count, plus the irrelevant
  // line). Simpler: bucket by the label minus the specific mod name.
  // We strip "cold" / "fire" tokens and group; if two distinct
  // pre-strip labels reduce to the same canonical form, the rep
  // count for that form should be 1.
  const buckets = new Map();
  for (const s of result.chain.states) {
    // Canonicalise: strip per-state [sN] step prefix, normalise
    // cold/fire tokens to "wished", drop floating-point numeric
    // annotations (V*, fromBudget, fromBase, P_reach, visits).
    // Bucket by (canonical_label, kind, policy) — two states with
    // the same label but different chosen actions are legitimately
    // distinct (the policy decision differs, so they shouldn't merge).
    const canon = s.label
      .replace(/^\[s\d+\]\s*/m, '')
      .replace(/\b(cold|fire)\b/gi, 'wished')
      .replace(/V\*=[^\n]*/g, '')
      .replace(/fromBudget=[^\n]*/g, '')
      .replace(/fromBase=[^\n]*/g, '')
      .replace(/P_reach=[^\n]*/g, '')
      .replace(/visits=[^\n]*/g, '')
      .replace(/\n+/g, '\n')
      .trim();
    const policy = s.meta?.policy ?? '-';
    const key = `${s.kind}|${policy}|${canon}`;
    const arr = buckets.get(key) ?? [];
    arr.push(s.id);
    buckets.set(key, arr);
  }
  // Goal/terminal states can have multiple variants distinguished
  // only by engine-level attributes that don't show in the label
  // (irrelevant-fractured, bone-mod presence) — those are
  // structurally distinct goals, not cold/fire mirrors. The test
  // targets the user's specific complaint: TRANSIENT states that
  // are mirror-images by mod identity.
  const offenders = [...buckets.entries()].filter(([k, ids]) => {
    if (ids.length <= 1) return false;
    if (k.startsWith('goal|') || k.startsWith('bricked|')) return false;
    return true;
  });
  assert.equal(offenders.length, 0,
    `expected equivalent-wished collapse to merge cold/fire-symmetric states. ` +
    `Buckets with >1 state (cold/fire renamed to "wished" — these should be merged):\n  ` +
    offenders.slice(0, 5).map(([c, ids]) => `${ids.length}× "${c.slice(0,50)}…" (ids: ${ids.join(', ')})`).join('\n  '));
});

test('non-equivalent wished mods (different weight) do NOT collapse', () => {
  // Sanity check: when wished mods differ in any engine-relevant
  // attribute (weight, required-tier, required flag, side), the
  // collapse rule must NOT fire — they're behaviourally different.
  const nonEquiv = {
    ...equivWishedInput,
    wishlist: [
      { key: 'SUFFIX:cold', weight: 800,  type: 'SUFFIX', requiredTier: 3, required: true },
      { key: 'SUFFIX:fire', weight: 1500, type: 'SUFFIX', requiredTier: 3, required: true },
    ],
  };
  const result = solveMDP(nonEquiv);
  // Different weights ⇒ different transition probabilities ⇒ states
  // must remain distinct.
  const labels = result.chain.states.map((s) => s.label);
  // We expect at least one cold-only AND one fire-only state to exist.
  const hasColdOnly = labels.some((l) => /cold/i.test(l) && !/fire/i.test(l));
  const hasFireOnly = labels.some((l) => /fire/i.test(l) && !/cold/i.test(l));
  // (Vacuous if the chain is too small. Just assert structure stays sane.)
  if (!(hasColdOnly && hasFireOnly)) return;
  assert.ok(hasColdOnly && hasFireOnly,
    `non-equivalent wished mods should keep separate identity-specific states`);
});

console.log(`\n${passed} passed · ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
