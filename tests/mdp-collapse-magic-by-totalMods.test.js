// Magic-state merging — supersedes the 2026-05-08 design.
// Earlier, the policy was "merge 1-wished and 1-irr magic states
// when they share the same next-action; render as `magic with 1
// affix`." The user reverted this on 2026-05-09 after a
// transmute_greater chain showed `s0 → ★ S:{cold|fire} / 100%` —
// the wished and irr branches collapsed to one rep, hiding the
// 95% irrelevant outcome entirely. Spec §3 now requires
// `wishedCount` in the partition: two magic-tm=1 states differing
// in wished bits are GENUINELY different (per G2: each item maps
// to one rep). This test now pins the new rule.

import { strict as assert } from 'node:assert';
import { solveMDP } from '../engine/mdp/solve.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.message}`); }
}

console.log('Collapse — magic states merge by totalMods alone');

const fixture = {
  wishlist: [
    { key: 'SUFFIX:cold_res', weight: 1000, type: 'SUFFIX', requiredTier: 1, required: true },
    { key: 'SUFFIX:fire_res', weight: 1000, type: 'SUFFIX', requiredTier: 1, required: true },
  ],
  irrelevantWeight: 30000,
  irrelevantWeightBySide: { PREFIX: 15000, SUFFIX: 15000 },
  target: { requiredMods: ['SUFFIX:cold_res', 'SUFFIX:fire_res'], minFilled: 2, maxFilled: 5 },
  start: { rarity: 'normal' },
  basePriceEx: 100,
  alchemyDraws: 4, maxFilled: 5, timeWeightExPerSec: 0, budgetEx: 5000,
  orbCosts: { transmute: 0.01, augment: 0.05, regal: 0.5, alch: 1, exalt: 1, annul: 0.5, fracturing: 50, chaos: 5 },
  orbTimes: { transmute: 1, augment: 1, regal: 1, alch: 1, exalt: 1, annul: 1, fracturing: 3, chaos: 1 },
};

test('1-wished magic and 1-irrelevant magic stay distinct under same policy (G2)', () => {
  // Each concrete item must map to ONE rep label. A 1-wished magic
  // and a 1-irrelevant magic are different items even when their
  // optimal next-action coincides — collapsing them produces a
  // misleading rep where the label only reflects one branch.
  const result = solveMDP(fixture);
  // Bucket strictly by (kind, policy, totalMods, wishedCount). Each
  // bucket should hold at most one rep.
  const popcount = (n) => { let c = 0; for (n = n | 0; n; n &= n - 1) c++; return c; };
  const buckets = new Map();
  for (const s of result.chain.states) {
    const policy = s.meta?.policy ?? '-';
    if (policy === '-' || policy === 'buy_base') continue;
    const idx = parseInt(s.id.replace(/^s/, ''), 10);
    const st = result.states[idx]?.state;
    if (!st) continue;
    if (st.totalMods !== 1) continue;
    const w = popcount(st.modMask ?? 0);
    const k = `${s.kind}|${policy}|tm=1|w=${w}`;
    const arr = buckets.get(k) ?? [];
    arr.push(s);
    buckets.set(k, arr);
  }
  const offenders = [...buckets.entries()].filter(([, arr]) => arr.length > 1);
  assert.equal(offenders.length, 0,
    `expected each (kind, policy, totalMods, wishedCount) bucket to hold ≤1 rep; ` +
    `offenders: ${offenders.map(([k, arr]) => `${k}: ${arr.map(s => s.id).join(',')}`).join('; ')}`);
});

test('post-transmute split: 1-wished branch and 0-wished+1-irr branch are SEPARATE reps', () => {
  // The user-reported regression (2026-05-09): on a craft where
  // transmute leads to two outcomes (wished cold/fire OR irrelevant),
  // both with the same optimal next-action, those outcomes must NOT
  // merge into a single rep. Pin the property: at totalMods=1 magic,
  // we expect AT LEAST one wished-bearing rep AND one irr-only rep.
  const result = solveMDP(fixture);
  const popcount = (n) => { let c = 0; for (n = n | 0; n; n &= n - 1) c++; return c; };
  let hasWishedTm1 = false, hasIrrTm1 = false;
  for (const s of result.chain.states) {
    const idx = parseInt(s.id.replace(/^s/, ''), 10);
    const st = result.states[idx]?.state;
    if (!st || st.totalMods !== 1 || st.rarity !== 'magic') continue;
    const w = popcount(st.modMask ?? 0);
    if (w >= 1) hasWishedTm1 = true;
    if (w === 0) hasIrrTm1 = true;
  }
  assert.ok(hasWishedTm1, 'expected at least one wished-bearing tm=1 magic rep');
  assert.ok(hasIrrTm1, 'expected at least one irr-only tm=1 magic rep (got merged with wished?)');
});

console.log(`\n${passed} passed · ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
