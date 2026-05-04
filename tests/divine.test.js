// Divine Bench — closed-form math tests.

import { strict as assert } from 'node:assert';
import {
  discretize, pModMeetsTarget, pItemMeetsTargets,
  pSuccessWithinN, expectedDivinesToSuccess, summarize,
} from '../engine/divine.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.message}`); }
}

console.log('Divine Bench tests');

test('discretize: range ≥ 3 ⇒ integer values inclusive of both ends', () => {
  // "+30..+50 maximum Life" → 21 integer values: [30, 31, ..., 50].
  const buckets = discretize(30, 50);
  assert.equal(buckets.length, 21, `expected 21 buckets, got ${buckets.length}`);
  assert.equal(buckets[0], 30);
  assert.equal(buckets[buckets.length - 1], 50);
});

test('discretize: range = 3 ⇒ exactly 4 integer buckets (boundary)', () => {
  // Range = 3 hits the ≥3 branch. Buckets: [10, 11, 12, 13].
  const buckets = discretize(10, 13);
  assert.equal(buckets.length, 4);
  assert.deepEqual(buckets, [10, 11, 12, 13]);
});

test('discretize: range < 3 ⇒ 10 evenly-spaced buckets', () => {
  // "+1.5..+2.0% increased movement speed" — range 0.5 < 3, split
  // into 10 buckets covering both endpoints (step = 0.5 / 9).
  const buckets = discretize(1.5, 2.0);
  assert.equal(buckets.length, 10);
  assert.ok(Math.abs(buckets[0] - 1.5) < 1e-9);
  assert.ok(Math.abs(buckets[buckets.length - 1] - 2.0) < 1e-9);
  // Step verification.
  for (let i = 1; i < buckets.length; i++) {
    const step = buckets[i] - buckets[i - 1];
    assert.ok(Math.abs(step - (0.5 / 9)) < 1e-9,
      `step at i=${i} should be ~${0.5 / 9}; got ${step}`);
  }
});

test('discretize: vmin === vmax ⇒ single-bucket', () => {
  // Edge: range 0 < 3 enters the 10-bucket branch with all buckets =
  // vmin (step = 0). The function returns [vmin, vmin, ..., vmin]
  // with 10 entries — degenerate but stable; pModMeetsTarget treats
  // it as 100% acceptance if target ≤ vmin.
  const buckets = discretize(50, 50);
  assert.ok(buckets.every((b) => b === 50));
});

test('pModMeetsTarget: integer range, target inside ⇒ correct fraction', () => {
  // Range [30, 50] = 21 buckets. Target 45 ⇒ acceptable {45..50}
  // = 6 / 21 ≈ 0.2857.
  const p = pModMeetsTarget({ vmin: 30, vmax: 50, target: 45 });
  assert.ok(Math.abs(p - 6 / 21) < 1e-9, `got ${p}`);
});

test('pModMeetsTarget: target ≤ vmin ⇒ p = 1', () => {
  const p = pModMeetsTarget({ vmin: 30, vmax: 50, target: 30 });
  assert.equal(p, 1);
});

test('pModMeetsTarget: target > vmax ⇒ p = 0', () => {
  const p = pModMeetsTarget({ vmin: 30, vmax: 50, target: 51 });
  assert.equal(p, 0);
});

test('pItemMeetsTargets: independence ⇒ probabilities multiply', () => {
  const mods = [
    { name: 'Life',  vmin: 30, vmax: 50, target: 45 }, // p = 6/21
    { name: 'Mana',  vmin: 20, vmax: 40, target: 30 }, // p = 11/21
  ];
  const expected = (6 / 21) * (11 / 21);
  const got = pItemMeetsTargets(mods);
  assert.ok(Math.abs(got - expected) < 1e-9, `got ${got}, expected ${expected}`);
});

test('pSuccessWithinN: matches 1 - (1-p)^N', () => {
  const mods = [
    { name: 'Life', vmin: 30, vmax: 50, target: 45 }, // p = 6/21
  ];
  const p = 6 / 21;
  for (const N of [1, 5, 10, 50]) {
    const expected = 1 - Math.pow(1 - p, N);
    const got = pSuccessWithinN(mods, N);
    assert.ok(Math.abs(got - expected) < 1e-9,
      `N=${N}: got ${got}, expected ${expected}`);
  }
});

test('expectedDivinesToSuccess: 1 / p; ∞ if any mod target > vmax', () => {
  const reachable = [{ name: 'Life', vmin: 30, vmax: 50, target: 45 }];
  assert.ok(Math.abs(expectedDivinesToSuccess(reachable) - 21 / 6) < 1e-9);
  const unreachable = [{ name: 'Life', vmin: 30, vmax: 50, target: 60 }];
  assert.equal(expectedDivinesToSuccess(unreachable), Infinity);
});

test('summarize: produces full UI-ready object', () => {
  const mods = [
    { name: 'Life',  vmin: 30, vmax: 50, target: 45 },
    { name: 'Speed', vmin: 1.5, vmax: 2.0, target: 1.8 },
  ];
  const out = summarize(mods, { N: 10, divinePriceEx: 187 });
  assert.equal(out.perMod.length, 2);
  assert.equal(out.perMod[0].bucketCount, 21);     // integer range
  assert.equal(out.perMod[1].bucketCount, 10);     // <3 range → 10 buckets
  assert.ok(out.pPerDivine > 0 && out.pPerDivine < 1);
  assert.ok(out.pWithinN > out.pPerDivine, 'within-N P should exceed per-divine P');
  assert.ok(out.expectedDivines > 1, 'should need >1 divine on average');
  assert.ok(out.expectedCostEx > 0);
});

test('summarize: vacuous mods array ⇒ p=1, expectedDivines≈1', () => {
  const out = summarize([], { N: 10, divinePriceEx: 187 });
  assert.equal(out.pPerDivine, 1);
  assert.equal(out.pWithinN, 1);  // already met (or trivially)
  assert.equal(out.expectedDivines, 1);
});

console.log(`\n${passed} passed · ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
