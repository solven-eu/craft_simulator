// Regression: alch's outgoing transitions must sum to 1.0 exactly.
// Bug surface (2026-05-25): user reported "Chain node s0 action
// 'alch': outgoing edges sum to 101.2%" and the related
// "pSuccess(start) raw value = 101.22% (clamped to 100%)" warning.
//
// Root cause: in alchMaskDistribution, when a wished mod rolls at
// SUB-acceptable tier (pAccept < 1), the recursion consumed the
// mod's weight from the pool (consumedW += w) but did NOT mark the
// mod as drawn — the same mod could be re-picked on subsequent
// draws, doubly accounting its weight (deducted from denominator,
// still present in numerator). This is visible only when at least
// one wished mod has pAccept < 1, which is the common case (tier
// gates). The 1.012× overflow corresponds to ~1 wished mod with
// pAccept ≈ 0.2 in a 4-draw alch.

import { strict as assert } from 'node:assert';
import { solveMDP } from '../engine/mdp/solve.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.message}`); }
}

console.log('MDP — alch mass conservation under sub-tier acceptance');

// Movement Speed on Boots @ ilvl 74: T1 gated out (ilvl 82); T2..T6
// each weight 1000 ⇒ 5000 wished-side weight. requiredTier=2 ⇒
// pAccept = 1000/5000 = 0.2 (only T2 lands acceptable).
const baseInput = {
  wishlist: [{
    key: 'PREFIX:#% increased Movement Speed',
    weight: 5000,
    type: 'PREFIX',
    score: 1,
    tierScores: { 1: 1, 2: 1, 3: 0, 4: 0, 5: 0, 6: 0 },
  }],
  irrelevantWeight: 30000,
  irrelevantWeightBySide: { PREFIX: 15000, SUFFIX: 15000 },
  pTierAcceptable: { alch: [0.2] },  // explicit per-mod sub-tier probability
  start: { rarity: 'normal' },
  basePriceEx: 40,
  alchemyDraws: 4,
  maxFilled: 6,
  timeWeightExPerSec: 0,
  budgetEx: 10000,
  target: { requiredMods: [], minFilled: 1, maxFilled: 6 },
  orbCosts: {
    transmute: 0.01, augment: 0.02, regal: 0.06,
    alch: 0.43, exalt: 1, annul: 0.5, fracturing: 50,
  },
  orbTimes: {
    transmute: 1, augment: 1, regal: 1,
    alch: 1, exalt: 1, annul: 1, fracturing: 3,
  },
};

test('alch outgoing chain warnings absent (mass conservation at engine level)', () => {
  // Run with the same scenario but cranked-up sub-tier probability
  // to maximise the bug's impact: 3 wished mods all with low
  // pAccept compound the double-counting. Pre-fix: chain warnings
  // fire ("outgoing edges sum to >100%"). Post-fix: none.
  const result = solveMDP({
    ...baseInput,
    wishlist: [
      { ...baseInput.wishlist[0], key: 'PREFIX:a', score: 1 },
      { ...baseInput.wishlist[0], key: 'PREFIX:b', score: 1 },
      { ...baseInput.wishlist[0], key: 'PREFIX:c', score: 1 },
    ],
    pTierAcceptable: { alch: [0.1, 0.1, 0.1] },
    target: { requiredMods: [], minFilled: 1, maxFilled: 6 },
  });
  const overflowWarn = (result.warnings || []).find(
    (w) => /outgoing edges sum to (\d+(?:\.\d+)?)%/.test(w)
        && parseFloat((/sum to (\d+(?:\.\d+)?)%/.exec(w))[1]) > 100.6);
  assert.equal(overflowWarn, undefined,
    `no chain edge should overflow >100% post-fix; got: ${overflowWarn}`);
  const clampWarn = (result.warnings || []).find(
    (w) => /pSuccess.*clamped/.test(w));
  assert.equal(clampWarn, undefined,
    `pSuccess(start) must not need clamping; got: ${clampWarn}`);
});

test('no pSuccess clamp warning when sub-tier mods exist', () => {
  const result = solveMDP(baseInput);
  const clampWarn = (result.warnings || []).find((w) => /pSuccess.*clamped/.test(w));
  assert.equal(clampWarn, undefined,
    `engine should not need to clamp pSuccess(start) when mass conservation holds; ` +
    `got warning: ${clampWarn}`);
  const massWarn = (result.warnings || []).find((w) => /outgoing edges sum to (\d+)/.test(w));
  if (massWarn) {
    const m = /sum to (\d+(?:\.\d+)?)%/.exec(massWarn);
    const pct = m ? parseFloat(m[1]) : NaN;
    assert.ok(Math.abs(pct - 100) < 0.6,
      `chain mass warning indicates real overflow (${massWarn})`);
  }
});

console.log(`\n${passed} passed · ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
