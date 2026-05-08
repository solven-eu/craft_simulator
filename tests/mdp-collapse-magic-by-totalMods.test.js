// Magic-state merging by totalMods alone: when two states have the
// same kind, same policy, and same total affix count — but one has
// the wished mod and the other has only irrelevant — they should
// still merge into one chain rep. User report (2026-05-08): "after
// transmute we always apply augment, so post-transmute states (1
// wished or 1 irrelevant, both magic) are eligible for merging.
// Rendering may state `magic with 1 affix` without specifying
// wished vs irrelevant."

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

test('1-wished and 1-irrelevant magic states with same policy merge into one rep', () => {
  const result = solveMDP(fixture);
  // Group by (kind, policy). Within each group, count the distinct
  // 1-affix-magic representatives. There should be at most ONE rep
  // per (kind, policy) for any given totalMods bucket — even if the
  // group's members include both "1 wished" and "1 irrelevant".
  const buckets = new Map();
  for (const s of result.chain.states) {
    const policy = s.meta?.policy ?? '-';
    if (policy === '-' || policy === 'buy_base') continue;
    // The label-parsing heuristic conflates "tm=1 with ≥1 irr" with
    // "tm=2 with `· 1 irrelevant` line" — both render as one ★/· line.
    // Use the underlying engine state for an accurate total.
    const idx = parseInt(s.id.replace(/^s/, ''), 10);
    const tm = result.states[idx]?.state?.totalMods ?? 0;
    if (tm !== 1) continue;
    const k = `${s.kind}|${policy}|totalMods=1`;
    const arr = buckets.get(k) ?? [];
    arr.push(s);
    buckets.set(k, arr);
  }
  const offenders = [...buckets.entries()].filter(([, arr]) => arr.length > 1);
  if (offenders.length > 0) {
    const sample = offenders.slice(0, 3).map(([k, arr]) =>
      `${k}: ${arr.map((s) => s.id + '(' + s.label.split('\\n')[0].replace(/\[s\d+\]\s*/, '').slice(0,30) + ')').join(', ')}`,
    ).join('\n  ');
    assert.fail(
      `expected 1-affix magic states with same policy to merge into ONE rep:\n  ${sample}`,
    );
  }
});

console.log(`\n${passed} passed · ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
