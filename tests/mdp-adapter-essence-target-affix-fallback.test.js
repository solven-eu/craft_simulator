// Regression test: when an essence row has empty `matched_mods`,
// the adapter must fall back to deriving a candidate match from
// `target_affix` (stripping the value-range pattern). Without the
// fallback, every essence with blank matched_mods is silently
// dropped, and a craft targeting an essence-only mod (e.g. `#%
// increased Armour, Evasion or Energy Shield` on Body Armour, only
// granted by Lesser/Normal/Greater Essence of Enhancement) reports
// "no path found."
//
// User-visible bug (2026-05-07, shared via URL):
//   - White Body Armour (STR), ilvl 74, budget 34226 ex.
//   - Wishlist: 1 required PREFIX `#% increased Armour, Evasion or
//     Energy Shield`.
//   - MDP returned no solution because matched_mods column is empty
//     in essences.csv for the Enhancement family — the only path
//     to the affix.

import { strict as assert } from 'node:assert';
import { ctxToMdpInput } from '../engine/mdp/adapter.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.message}`); }
}

console.log('Adapter — essence target_affix fallback');

const baseCtx = {
  // mod_ids canonical map (only the affix we care about).
  modIds: {
    '#% increased Armour, Evasion or Energy Shield': 'inc_armour_evasion_or_es',
  },
  fullPool: [],   // affix is essence-only — not in the base pool.
  itemClass: 'Body Armour',
  basePriceEx: 100,
  startingCounts: { prefixes: 0, suffixes: 0 },
};

const wishlist = [{
  key: 'PREFIX:#% increased Armour, Evasion or Energy Shield',
  type: 'PREFIX',
  requiredTier: 1,
  required: true,
}];

test('essence with empty matched_mods + target_affix ⇒ fallback yields matchedKeys', () => {
  const input = ctxToMdpInput({
    ...baseCtx,
    wishlist,
    essences: [{
      poe2db_slug: 'Greater_Essence_of_Enhancement',
      name: 'Greater Essence of Enhancement',
      tier: 'Greater',
      side: 'PREFIX',
      item_classes: 'Amulet|Body Armour|Boots|Gloves|Helmet|Shield',
      target_affix: '(68—79)% increased Armour, Evasion or Energy Shield',
      matched_mods: '',           // <-- the bug surface
    }],
    essencePrices: { 'Greater Essence of Enhancement': { priceEx: 44.1 } },
  });
  const ess = input.essences.find((e) => /Enhancement/.test(e.name));
  assert.ok(ess, 'Greater Essence of Enhancement should appear in input.essences');
  assert.ok(ess.matchedKeys?.length > 0,
    `essence with derived target_affix must yield matchedKeys; got ${JSON.stringify(ess?.matchedKeys)}`);
  // The wishlist key is the canonical typed key (PREFIX:<canonical id>).
  // The matched key should be one of the wishlist keys.
  assert.equal(ess.matchedKeys.length, 1,
    `expected one matched key for the single wishlist entry; got ${JSON.stringify(ess.matchedKeys)}`);
});

test('essence with leading-+ value pattern ⇒ +# is preserved in fallback', () => {
  const input = ctxToMdpInput({
    ...baseCtx,
    modIds: { '+# to maximum Mana': 'max_mana', '# to maximum Mana': 'max_mana' },
    wishlist: [{ key: 'PREFIX:+# to maximum Mana', type: 'PREFIX', requiredTier: 4, required: true }],
    essences: [{
      poe2db_slug: 'Lesser_Essence_of_the_Mind',
      name: 'Lesser Essence of the Mind',
      tier: 'Lesser',
      side: 'PREFIX',
      item_classes: 'Body Armour',
      target_affix: '+(25—34) to maximum Mana',
      matched_mods: '',
    }],
    essencePrices: { 'Lesser Essence of the Mind': { priceEx: 1 } },
  });
  const ess = input.essences.find((e) => /Mind/.test(e.name));
  assert.ok(ess?.matchedKeys?.length > 0,
    `+(N—M) pattern should normalise to +# and match wishlist; got ${JSON.stringify(ess?.matchedKeys)}`);
});

test('essence with non-empty matched_mods ⇒ explicit field still used (no regression)', () => {
  const input = ctxToMdpInput({
    ...baseCtx,
    wishlist,
    essences: [{
      poe2db_slug: 'Greater_Essence_of_Enhancement',
      name: 'Greater Essence of Enhancement',
      tier: 'Greater',
      side: 'PREFIX',
      item_classes: 'Body Armour',
      target_affix: 'IGNORE THIS',
      matched_mods: '#% increased Armour, Evasion or Energy Shield',
    }],
    essencePrices: { 'Greater Essence of Enhancement': { priceEx: 44.1 } },
  });
  const ess = input.essences.find((e) => /Enhancement/.test(e.name));
  assert.ok(ess?.matchedKeys?.length > 0,
    `explicit matched_mods must still resolve; fallback should not override it`);
});

console.log(`\n${passed} passed · ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
