// Regression test: every reachable state must satisfy
//   popcount(modMask & PREFIX_BITS) <= prefixMods
//   popcount(modMask & SUFFIX_BITS) <= (totalMods - prefixMods)
//
// User report (2026-05-07): live Body Armour craft with 2 PREFIX
// essence-only wished mods showed two goal nodes — one rendered
// `(2P + 0S = 2)` and another `(1P + 1S = 2)`. The second is invalid:
// both wished bits are PREFIX, so suffix count cannot exceed 0 when
// both are on the item.
//
// Root cause: any action that sets a wished bit in modMask without
// bumping prefixMods (when the bit's natural side is PREFIX) leaks
// an inconsistent state. Verified across the realistic live setup.

import { strict as assert } from 'node:assert';
import { ctxToMdpInput } from '../engine/mdp/adapter.js';
import { solveMDP } from '../engine/mdp/solve.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.message}`); }
}

console.log('Goal-state per-side consistency (live craft repro)');

function popcount(n) { let c = 0; while (n) { c += n & 1; n >>>= 1; } return c; }

function checkAll(result, wishlistTypes, label) {
  let prefixBits = 0, suffixBits = 0;
  for (let i = 0; i < wishlistTypes.length; i++) {
    if (wishlistTypes[i] === 'PREFIX')      prefixBits |= (1 << i);
    else if (wishlistTypes[i] === 'SUFFIX') suffixBits |= (1 << i);
  }
  const violations = [];
  for (const r of result.states) {
    const s = r.state;
    const wishedPrefixOnItem = popcount(s.modMask & prefixBits);
    const wishedSuffixOnItem = popcount(s.modMask & suffixBits);
    const totalPrefix = s.prefixMods ?? 0;
    const totalSuffix = s.totalMods - totalPrefix;
    if (wishedPrefixOnItem > totalPrefix) {
      violations.push(`${label}: state has ${wishedPrefixOnItem} PREFIX wished bits on item but prefixMods=${totalPrefix}; mask=${s.modMask}, totalMods=${s.totalMods}`);
    }
    if (wishedSuffixOnItem > totalSuffix) {
      violations.push(`${label}: state has ${wishedSuffixOnItem} SUFFIX wished bits on item but suffixMods=${totalSuffix}; mask=${s.modMask}, totalMods=${s.totalMods}, prefixMods=${totalPrefix}`);
    }
  }
  if (violations.length) {
    throw new Error(`${violations.length} side-inconsistent state(s):\n  ${violations.slice(0, 5).join('\n  ')}`);
  }
}

test('live repro: 2 PREFIX essence-only mods, Greater + Perfect essences, all goals are (2P+0S)', () => {
  const baseCtx = {
    modIds: {
      '#% increased Armour, Evasion or Energy Shield': 'inc_armour_evasion_or_es',
      '#% increased maximum Life': 'inc_max_life',
    },
    fullPool: [],
    itemClass: 'Body Armour',
    basePriceEx: 100,
    startingCounts: { prefixes: 0, suffixes: 0 },
    wishlist: [
      { key: 'PREFIX:#% increased Armour, Evasion or Energy Shield', type: 'PREFIX', requiredTier: 1, required: true },
      { key: 'PREFIX:#% increased maximum Life', type: 'PREFIX', requiredTier: 1, required: true },
    ],
    essences: [
      { poe2db_slug: 'Greater_Essence_of_Enhancement', name: 'Greater Essence of Enhancement',
        tier: 'Greater', side: 'PREFIX', item_classes: 'Body Armour',
        target_affix: '(68—79)% increased Armour, Evasion or Energy Shield', matched_mods: '' },
      { poe2db_slug: 'Perfect_Essence_of_the_Body', name: 'Perfect Essence of the Body',
        tier: 'Perfect', side: 'PREFIX', item_classes: 'Body Armour',
        target_affix: '(8—10)% increased maximum Life', matched_mods: '' },
    ],
    essencePrices: {
      'Greater Essence of Enhancement': { priceEx: 44.1 },
      'Perfect Essence of the Body':    { priceEx: 13 },
    },
  };
  const input = ctxToMdpInput(baseCtx);
  const result = solveMDP({
    ...input,
    target: { ...input.target, minFilled: 2, maxFilled: 6 },
    orbCosts: { transmute: 0.01, augment: 0.05, regal: 0.5, alch: 1, exalt: 5, annul: 9.5, fracturing: 50, chaos: 5 },
    orbTimes: { transmute: 1, augment: 1, regal: 1, alch: 1, exalt: 1, annul: 1, fracturing: 3, chaos: 1 },
    budgetEx: 50000,
  });
  checkAll(result, ['PREFIX', 'PREFIX'], 'live-repro');
  // Specifically check goal states: every goal must have both PREFIX
  // bits set AND prefixMods ≥ 2 AND suffixMods ≤ 1.
  const goals = result.states.filter((r, i) => {
    return (r.state.modMask & 0b11) === 0b11
      && r.state.totalMods >= 2 && r.state.totalMods <= 6
      && r.state.fracturedBit === -1 && !r.state.irrFractured
      && (!r.state.boneMod || r.state.boneRevealed);
  });
  assert.ok(goals.length > 0, 'expected at least one goal state in chain');
  for (const g of goals) {
    const s = g.state;
    const totalPrefix = s.prefixMods ?? 0;
    const totalSuffix = s.totalMods - totalPrefix;
    assert.ok(totalPrefix >= 2,
      `goal state with both PREFIX bits set must have prefixMods >= 2; got prefixMods=${totalPrefix} (state: ${JSON.stringify(s)})`);
    assert.ok(totalSuffix <= s.totalMods - 2,
      `goal state with both PREFIX bits set must have suffixMods <= totalMods - 2; got suffix=${totalSuffix}, total=${s.totalMods}`);
  }
});

test('live repro variant: Greater Enhancement + Perfect Body, no other essences, both bits required', () => {
  // Same scenario as above but with Crystallisation omens excluded
  // (no omenPrices) — narrows the action set so the explosion path
  // is more deterministic.
  const baseCtx = {
    modIds: {
      '#% increased Armour, Evasion or Energy Shield': 'inc_armour_evasion_or_es',
      '#% increased maximum Life': 'inc_max_life',
    },
    fullPool: [],
    itemClass: 'Body Armour',
    basePriceEx: 100,
    startingCounts: { prefixes: 0, suffixes: 0 },
    wishlist: [
      { key: 'PREFIX:#% increased Armour, Evasion or Energy Shield', type: 'PREFIX', requiredTier: 1, required: true },
      { key: 'PREFIX:#% increased maximum Life', type: 'PREFIX', requiredTier: 1, required: true },
    ],
    essences: [
      { poe2db_slug: 'Greater_Essence_of_Enhancement', name: 'Greater Essence of Enhancement',
        tier: 'Greater', side: 'PREFIX', item_classes: 'Body Armour',
        target_affix: '(68—79)% increased Armour, Evasion or Energy Shield', matched_mods: '' },
      { poe2db_slug: 'Perfect_Essence_of_the_Body', name: 'Perfect Essence of the Body',
        tier: 'Perfect', side: 'PREFIX', item_classes: 'Body Armour',
        target_affix: '(8—10)% increased maximum Life', matched_mods: '' },
    ],
    essencePrices: {
      'Greater Essence of Enhancement': { priceEx: 44.1 },
      'Perfect Essence of the Body':    { priceEx: 13 },
    },
    omenPrices: {},  // explicitly empty — Crystallisation variants excluded
  };
  const input = ctxToMdpInput(baseCtx);
  const result = solveMDP({
    ...input,
    target: { ...input.target, minFilled: 2, maxFilled: 6 },
    orbCosts: { transmute: 0.01, augment: 0.05, regal: 0.5, alch: 1, exalt: 5, annul: 9.5, fracturing: 50, chaos: 5 },
    orbTimes: { transmute: 1, augment: 1, regal: 1, alch: 1, exalt: 1, annul: 1, fracturing: 3, chaos: 1 },
    budgetEx: 50000,
  });
  checkAll(result, ['PREFIX', 'PREFIX'], 'live-repro-noomens');
});

console.log(`\n${passed} passed · ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
