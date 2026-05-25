// Regression: `essenceableTiers(type, name)` must handle essences
// whose display is a SINGLE numeric value (no parenthesised range).
// Hysteria's Movement Speed for boots displays as "30% increased
// Movement Speed" (fixed 30%, not a range), and base-mod tiers for
// Movement Speed are also single values ("35%", "30%", ...). The
// old parser only matched "(N—M)" patterns, so both sides returned
// null and the green 🟢 chip never lit up for fixed-roll essences.
//
// User report (2026-05-25): "movement speed is achievable with
// hysteria — we should see an essence chip on the proper tier"
// (T2 = 30% for Hysteria on Boots).

import { strict as assert } from 'node:assert';
import { modHelperActions as modHelpers } from '../stores/craft/mod-helpers.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.message}`); }
}

console.log('Mod helpers — essenceableTiers fixed-roll parsing');

// Minimal store-like context. essenceableTiers reads:
//   this.base, this.extraMods, this.essenceSideOverrides,
//   this.essenceModSides, this.essences, this.modRanges, this.getAllTiers
function makeCtx(overrides = {}) {
  return {
    base: 'BOOTS (DEX/INT)',
    extraMods: {
      'BOOTS (DEX/INT)': {
        essence: [
          // Hysteria-shaped: single fixed value in `display`.
          {
            text: '#% increased Movement Speed',
            tier_name: 'Essence of Hysteria',
            display: '30% increased Movement Speed',
          },
        ],
      },
    },
    essenceSideOverrides: { overrides: {} },
    essenceModSides: {
      mod_sides: {
        'Essence of Hysteria': { '#% increased Movement Speed': 'PREFIX' },
      },
    },
    essences: [
      { name: 'Essence of Hysteria', side: 'UNKNOWN', tier: 'Perfect' },
    ],
    modRanges: {
      'BOOTS (DEX/INT)': {
        '#% increased Movement Speed': {
          '1': '35% increased Movement Speed',
          '2': '30% increased Movement Speed',
          '3': '25% increased Movement Speed',
          '4': '20% increased Movement Speed',
          '5': '15% increased Movement Speed',
          '6': '10% increased Movement Speed',
        },
      },
    },
    getAllTiers() { return []; },
    ...overrides,
  };
}

test('Hysteria (30% fixed) maps to base-mod T2 (30%) on Boots Movement Speed', () => {
  const ctx = makeCtx();
  const tiers = modHelpers.essenceableTiers.call(ctx, 'PREFIX', '#% increased Movement Speed');
  assert.equal(tiers.size, 1,
    `expected exactly 1 tier (T2); got ${[...tiers].sort().join(',')}`);
  assert.ok(tiers.has(2),
    `expected T2 to be essence-grantable (30% essence ⊆ 30% base T2); got ${[...tiers].sort().join(',')}`);
  assert.ok(!tiers.has(1),
    `T1 (35%) is NOT reachable via Hysteria (30%); chip must not light up there`);
});

test('Ranged essence (Greater Body, "+(85—99) to Life") still maps correctly', () => {
  // Regression guard for the existing parenthesised-range code path.
  // Greater Essence of the Body rolls +(85—99) Life; on Boots base
  // tiers are also ranged ("+(70—84) Life" etc.), so a range-vs-range
  // containment check is what's exercised here.
  const ctx = makeCtx({
    extraMods: {
      'BOOTS (DEX/INT)': {
        essence: [{
          text: '+# to maximum Life',
          tier_name: 'Greater Essence of the Body',
          display: '+(85—99) to maximum Life',
        }],
      },
    },
    essenceModSides: {
      mod_sides: { 'Greater Essence of the Body': { '+# to maximum Life': 'PREFIX' } },
    },
    essences: [{ name: 'Greater Essence of the Body', side: 'PREFIX', tier: 'Greater' }],
    modRanges: {
      'BOOTS (DEX/INT)': {
        '+# to maximum Life': {
          '1': '+(100—119) to maximum Life',
          '2': '+(85—99) to maximum Life',
          '3': '+(70—84) to maximum Life',
        },
      },
    },
  });
  const tiers = modHelpers.essenceableTiers.call(ctx, 'PREFIX', '+# to maximum Life');
  assert.ok(tiers.has(2),
    `Greater Body (85—99) ⊆ T2 (85—99) — chip must light at T2; got ${[...tiers]}`);
  assert.ok(!tiers.has(1),
    `Greater Body (85—99) is NOT ⊆ T1 (100—119) — chip must NOT light at T1; got ${[...tiers]}`);
});

console.log(`\n${passed} passed · ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
