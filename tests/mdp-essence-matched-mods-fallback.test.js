// Essence matching fallback: when `matched_mods` is non-empty but
// none of its entries correspond to a wishlist key, the adapter
// must ALSO try the `target_affix` (with range placeholders) before
// giving up. User report (2026-05-08): essences silently missing
// from `Why this orb?` because the scraper populated matched_mods
// with bookkeeping text ("detail-page Pre/Suf table → SUFFIX") and
// the existing fallback only fired when matched_mods was empty.

import { strict as assert } from 'node:assert';
import { ctxToMdpInput } from '../engine/mdp/adapter.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.message}`); }
}

console.log('Essence matching — target_affix fallback when matched_mods is junk');

const ctx = {
  wishlist: [{ key: 'SUFFIX:cold_res', type: 'SUFFIX', required: true, requiredTier: 3 }],
  fullPool: [{ key: 'SUFFIX:cold_res', type: 'SUFFIX', weight: 7000, tiers: [
    { tier: 1, weight: 1000, ilvl: 82 },{ tier: 2, weight: 1000, ilvl: 71 },
    { tier: 3, weight: 1000, ilvl: 60 },{ tier: 4, weight: 1000, ilvl: 50 },
  ]}],
  modIds: { '#% to Cold Resistance': 'cold_res', '+#% to Cold Resistance': 'cold_res' },
  target: { requiredMods: ['SUFFIX:cold_res'], minFilled: 1, maxFilled: 5 },
  minFilled: 1, maxFilled: 5, basePriceEx: 100, totalBudgetEx: 1630,
  currencies: { exalted: { exaltedPer: 1 }, transmute: { exaltedPer: 0.01 }, augment: { exaltedPer: 0.05 }, regal: { exaltedPer: 0.5 }, alchemy: { exaltedPer: 0.01 } },
  orbs: {
    transmute: { id:'transmute', priceCurrency:'transmute', priceAmount:1, timeSeconds:1 },
    augment: { id:'augment', priceCurrency:'augment', priceAmount:1, timeSeconds:1 },
    regal: { id:'regal', priceCurrency:'regal', priceAmount:1, timeSeconds:1 },
    alchemy: { id:'alchemy', priceCurrency:'alchemy', priceAmount:1, timeSeconds:1 },
  },
  disabledOrbs: {},
  essences: [
    // Mirrors a real CSV row: matched_mods has bookkeeping text from
    // the scraper; target_affix is the actual mod text (range form).
    {
      name: 'Essence of Thawing', tier: 'Normal',
      target_affix: '+(21—25)% to Cold Resistance',
      side: 'SUFFIX', guarantee: 'guaranteed',
      item_classes: 'Amulets|Belts|Body Armours',
      matched_mods: 'detail-page Pre/Suf table → SUFFIX', // junk; doesn't match wishlist
    },
  ],
  essencePrices: { 'Essence of Thawing': { priceEx: 15 } },
  omenPrices: {},
  isAvailable: () => true, base: 'AMULET', itemClass: 'Amulet',
  extraMods: {},
};

test('essence with junk matched_mods still matches via target_affix fallback', () => {
  const input = ctxToMdpInput(ctx);
  // The MDP input should include at least one essence spec for Thawing,
  // since target_affix `+(21—25)% to Cold Resistance` canonicalises to
  // `+#% to Cold Resistance` → mod id `cold_res` → wishlist key
  // `SUFFIX:cold_res`.
  const thawing = (input.essences ?? []).find((e) => /Thawing/.test(e.name ?? ''));
  assert.ok(thawing,
    `expected Essence of Thawing to be in MDP input despite junk matched_mods. ` +
    `essences: ${JSON.stringify(input.essences?.map((e) => e.name) ?? [])}`);
});

console.log(`\n${passed} passed · ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
