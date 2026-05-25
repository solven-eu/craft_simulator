// Regression: when a wishlist entry has `required: false`, the
// adapter must NOT enforce the essence-rank-vs-requiredTier gate.
// A soft wish is a preference, not a threshold, so Lesser/Normal
// essences should still surface with pAcceptable=1 — they still
// LAND the mod, just at a lower base-pool tier than the user's
// minTier hint.
//
// Bug surface (2026-05-25): user clicked an essence-pool "+ wish"
// (saved state predating the required=true UI fix), state recorded
// `required: false, minTier: 3`. The adapter applied
// pickFiniteMin(null, 3) = 3 and silently excluded Lesser (essence
// rank 5) and Normal (rank 4) Essence of the Body. The user
// wondered why cheap essence paths weren't surfacing at all.

import { strict as assert } from 'node:assert';
import { ctxToMdpInput } from '../engine/mdp/adapter.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.message}`); }
}

console.log('Adapter — soft wish must not gate Lesser/Normal essences');

const baseCtx = {
  modIds: { '# to maximum Life': 'max_life', '+# to maximum Life': 'max_life' },
  fullPool: [{ key: 'PREFIX:# to maximum Life', type: 'PREFIX', weight: 1000 }],
  itemClass: 'Boots',
  base: 'BOOTS (DEX/INT)',
  basePriceEx: 40,
  startingCounts: { prefixes: 0, suffixes: 0 },
  essencePrices: {
    'Lesser Essence of the Body':  { priceEx: 1.67 },
    'Essence of the Body':         { priceEx: 1 },
    'Greater Essence of the Body': { priceEx: 7.57 },
  },
};

const bodyEssences = [
  {
    poe2db_slug: 'Lesser_Essence_of_the_Body', name: 'Lesser Essence of the Body',
    tier: 'Lesser', side: 'PREFIX', item_classes: 'Boots',
    target_affix: '+(30—39) to maximum Life (Armour/Belt) or +(20—29) (Jewellery)',
    matched_mods: '+# to maximum Life',
  },
  {
    poe2db_slug: 'Essence_of_the_Body', name: 'Essence of the Body',
    tier: 'Normal', side: 'PREFIX', item_classes: 'Boots',
    target_affix: '+(85—99) to maximum Life',
    matched_mods: '+# to maximum Life',
  },
  {
    poe2db_slug: 'Greater_Essence_of_the_Body', name: 'Greater Essence of the Body',
    tier: 'Greater', side: 'PREFIX', item_classes: 'Boots',
    target_affix: '+(100—119) to maximum Life',
    matched_mods: '+# to maximum Life',
  },
];

test('soft wish (required:false) keeps Lesser/Normal essences with pAcceptable=1', () => {
  const input = ctxToMdpInput({
    ...baseCtx,
    essences: bodyEssences,
    wishlist: [{
      key: 'PREFIX:# to maximum Life',
      type: 'PREFIX',
      required: false,         // soft wish — the bug surface
      minTier: 3,
      requiredTier: null,
    }],
  });
  const essMap = Object.fromEntries(
    (input.essences || [])
      .filter((e) => /Body/.test(e.name))
      .map((e) => [e.name, e])
  );
  for (const name of ['Lesser Essence of the Body', 'Essence of the Body', 'Greater Essence of the Body']) {
    const e = essMap[name];
    assert.ok(e, `${name} must be emitted (was silently dropped pre-fix)`);
    assert.equal(e.pAcceptable, 1,
      `${name} on a soft wish must have pAcceptable=1 (it still lands the mod); ` +
      `got ${e.pAcceptable}`);
  }
});

test('hard wish (required:true) still gates Lesser/Normal essences by tier', () => {
  // The fix is scoped to soft wishes only. A genuinely required
  // wish with requiredTier=2 still excludes Lesser (rank 5) and
  // Normal (rank 4) — they can't reach the user's bar.
  const input = ctxToMdpInput({
    ...baseCtx,
    essences: bodyEssences,
    wishlist: [{
      key: 'PREFIX:# to maximum Life',
      type: 'PREFIX',
      required: true,          // hard wish — gate still applies
      requiredTier: 2,
    }],
  });
  const essMap = Object.fromEntries(
    (input.essences || [])
      .filter((e) => /Body/.test(e.name))
      .map((e) => [e.name, e])
  );
  assert.equal(essMap['Lesser Essence of the Body']?.pAcceptable, 0,
    'Lesser (rank 5) must be gated out by required-T2 hard wish');
  assert.equal(essMap['Essence of the Body']?.pAcceptable, 0,
    'Normal (rank 4) must be gated out by required-T2 hard wish');
  assert.equal(essMap['Greater Essence of the Body']?.pAcceptable, 1,
    'Greater (rank 2) must pass required-T2 hard wish');
});

console.log(`\n${passed} passed · ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
