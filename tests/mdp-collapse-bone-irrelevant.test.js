// Bone-mod presence shouldn't fragment classes when the policy and
// canonical attributes are otherwise identical. User report (2026-
// 05-08): "I still see different nodes with and without desecrated
// mod, while they seem equivalent (desecrated counts as irrelevant)
// and lead to same next action."
//
// Concretely: the engine attribute `boneMod` (and `boneRevealed`)
// previously appeared in the canonical signature, so a state with
// pending unrevealed bone vs. a state without it landed in
// different classes even when their policy + wished + irr-bucket
// were identical. The fix is to drop `bone` from canonAttrs
// default so it doesn't fragment merging — actions that genuinely
// gate on bone presence (apply_bone requires no bone, reveal_bone
// requires bone) differentiate via the policy axis instead.

import { strict as assert } from 'node:assert';
import { solveMDP } from '../engine/mdp/solve.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.message}`); }
}

console.log('Collapse — bone-mod doesn\'t fragment classes');

const fixture = {
  wishlist: [
    { key: 'PREFIX:WISH_P', weight: 800, type: 'PREFIX', requiredTier: 1, required: true },
    { key: 'SUFFIX:WISH_S', weight: 800, type: 'SUFFIX', requiredTier: 1, required: true },
  ],
  irrelevantWeight: 30000,
  irrelevantWeightBySide: { PREFIX: 15000, SUFFIX: 15000 },
  target: { requiredMods: ['PREFIX:WISH_P', 'SUFFIX:WISH_S'], minFilled: 2, maxFilled: 5 },
  start: { rarity: 'normal' },
  basePriceEx: 100,
  alchemyDraws: 4, maxFilled: 5, timeWeightExPerSec: 0.1, budgetEx: 5000,
  targetBoneMod: true, // allow bone on goal
  orbCosts: { transmute: 0.01, augment: 0.05, regal: 0.5, alch: 1, exalt: 1, annul: 9.5, fracturing: 50, chaos: 5, apply_bone: 100 },
  orbTimes: { transmute: 1, augment: 1, regal: 1, alch: 1, exalt: 1, annul: 1, fracturing: 3, chaos: 1, apply_bone: 5 },
};

test('states with same policy+wished+irr-bucket merge regardless of bone-mod presence', () => {
  const result = solveMDP(fixture);
  // Bucket by (kind, policy, wished-pattern, irr-presence). Two
  // states in the same bucket should be ONE rep, even if one has
  // bone-mod and the other doesn't.
  const stateById = new Map(result.chain.states.map((s) => [s.id, s]));
  const buckets = new Map();
  for (const cs of result.chain.states) {
    const policy = cs.meta?.policy ?? '-';
    if (policy === '-' || policy === 'buy_base') continue;
    const lines = cs.label.split('\n');
    // Wished-pattern: just count ★ and · lines (mod-identity-merged
    // labels look like "★ S:cold_res | S:fire_res" — count as 1).
    const wishedLines = lines.filter((l) => /^[★·] [PS]:/.test(l)).length;
    const hasIrr = lines.some((l) => /irrelevant|irr/.test(l));
    const k = `${cs.kind}|${policy}|wished=${wishedLines}|irr=${hasIrr}`;
    const arr = buckets.get(k) ?? [];
    arr.push(cs);
    buckets.set(k, arr);
  }
  // Look for buckets where the only diff between members is bone-mod
  // presence. (Members with same bucket key but differing in 🦴 line
  // are the ones we want merged.)
  const offenders = [];
  for (const [k, arr] of buckets) {
    if (arr.length <= 1) continue;
    const withBone = arr.filter((s) => /🦴/.test(s.label));
    const withoutBone = arr.filter((s) => !/🦴/.test(s.label));
    if (withBone.length > 0 && withoutBone.length > 0) {
      offenders.push({
        bucket: k,
        withBone: withBone.map((s) => s.id),
        withoutBone: withoutBone.map((s) => s.id),
      });
    }
  }
  if (offenders.length > 0) {
    const sample = offenders.slice(0, 3).map((o) =>
      `bucket=${o.bucket}\n     bone=[${o.withBone.join(',')}] no-bone=[${o.withoutBone.join(',')}]`,
    ).join('\n  ');
    assert.fail(
      `expected bone-having and bone-less states to merge when policy + wished + irr-bucket match. ` +
      `Found ${offenders.length} bucket(s) with both:\n  ` + sample,
    );
  }
});

console.log(`\n${passed} passed · ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
