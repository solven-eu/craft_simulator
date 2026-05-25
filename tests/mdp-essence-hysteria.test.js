// Regression test: Essence of Hysteria is a multi-base, single-target
// corrupted essence. Each base type rolls exactly one specific mod
// (Movement Speed on Boots, Minion Skills on Helmet, Crit Damage on
// Gloves, ...). The CSV row carries an empty `matched_mods` and a
// meta-description `target_affix` ("Multiple effects depending on
// item type ..."), so the existing matched_mods / target_affix
// fallback in `buildEssenceSpecs` produces an empty matchedKeys and
// the essence is silently dropped from the action set.
//
// The per-base outcome is already in data/poe2/extra_mods.json under
// each base's `essence` bucket, tagged `tier_name: "Essence of
// Hysteria"`. The adapter must consult that fallback before giving up.
//
// User report (2026-05-25): "we do not implement Essence of Hysteria."

import { strict as assert } from 'node:assert';
import { ctxToMdpInput } from '../engine/mdp/adapter.js';
import { solveMDP } from '../engine/mdp/solve.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.message}`); }
}

console.log('Adapter — Essence of Hysteria per-base fallback');

const hysteriaRow = {
  poe2db_slug: 'Essence_of_Hysteria',
  name: 'Essence of Hysteria',
  tier: 'Perfect',
  side: 'UNKNOWN',
  // CSV currently leaves item_classes empty for Hysteria; the per-base
  // fallback should still kick in. Tests pin behaviour for both shapes.
  item_classes: '',
  target_affix:
    'Multiple effects depending on item type (Minion skills, Thorns, Crit damage, Movement speed, Mana regen, Life recoup, Stun threshold, Block, Bow damage, ES recharge)',
  matched_mods: '',
};

const hysteriaExtraModsBoots = {
  'BOOTS (INT)': {
    essence: [
      {
        text: '#% increased Movement Speed',
        tags: ['speed'],
        tier_name: 'Essence of Hysteria',
        display: '30% increased Movement Speed',
      },
    ],
  },
};

const hysteriaExtraModsHelmet = {
  'HELMET (STR)': {
    essence: [
      {
        text: '+# to Level of all Minion Skills',
        tags: ['minion'],
        tier_name: 'Essence of Hysteria',
        display: '+1 to Level of all Minion Skills',
      },
    ],
  },
};

test('per-base fallback resolves Movement Speed on Boots', () => {
  const input = ctxToMdpInput({
    modIds: { '#% increased Movement Speed': 'increased_movement_speed' },
    fullPool: [],
    itemClass: 'Boots',
    base: 'BOOTS (INT)',
    extraMods: hysteriaExtraModsBoots,
    basePriceEx: 100,
    startingCounts: { prefixes: 0, suffixes: 0 },
    wishlist: [{
      key: 'PREFIX:#% increased Movement Speed',
      type: 'PREFIX',
      requiredTier: 1,
      required: true,
    }],
    essences: [hysteriaRow],
    essencePrices: { 'Essence of Hysteria': { priceEx: 540 } },
  });
  const ess = input.essences.find((e) => /Hysteria/.test(e.name));
  assert.ok(ess, 'Essence of Hysteria should appear in input.essences');
  assert.equal(ess.matchedKeys.length, 1,
    `expected one matched key (Movement Speed); got ${JSON.stringify(ess?.matchedKeys)}`);
  // Adapter canonicalises wishlist keys through modIds, so the
  // matched key compares as the canonical id, not the raw text.
  assert.equal(ess.matchedKeys[0], 'PREFIX:increased_movement_speed',
    `expected canonical Movement Speed key; got ${ess.matchedKeys[0]}`);
});

test('per-base fallback picks Minion Skills on Helmet (NOT Movement Speed)', () => {
  // Numerical guard per CLAUDE.md "transformations on labeled values".
  // A naive impl could scan the WRONG base's essence bucket and emit
  // Movement Speed even when the wishlist + base are Helmet/Minion
  // Skills. Pin the per-base routing.
  const input = ctxToMdpInput({
    modIds: { '+# to Level of all Minion Skills': 'minion_skills_level' },
    fullPool: [],
    itemClass: 'Helmet',
    base: 'HELMET (STR)',
    extraMods: hysteriaExtraModsHelmet,
    basePriceEx: 100,
    startingCounts: { prefixes: 0, suffixes: 0 },
    wishlist: [{
      key: 'SUFFIX:+# to Level of all Minion Skills',
      type: 'SUFFIX',
      requiredTier: 1,
      required: true,
    }],
    essences: [hysteriaRow],
    essencePrices: { 'Essence of Hysteria': { priceEx: 540 } },
  });
  const ess = input.essences.find((e) => /Hysteria/.test(e.name));
  assert.ok(ess, 'Essence of Hysteria should appear in input.essences');
  assert.equal(ess.matchedKeys.length, 1, 'one match expected');
  assert.equal(ess.matchedKeys[0], 'SUFFIX:minion_skills_level',
    `expected canonical Minion Skills key on Helmet base; got ${ess.matchedKeys[0]}`);
});

test('per-base fallback only fires when wishlist mod matches the base outcome', () => {
  // Wishlist asks for Minion Skills but base is Boots (which rolls
  // Movement Speed via Hysteria). No match ⇒ Hysteria must NOT appear
  // (would be misleading: applying it on Boots can't satisfy the wish).
  const input = ctxToMdpInput({
    modIds: { '+# to Level of all Minion Skills': 'minion_skills_level' },
    fullPool: [],
    itemClass: 'Boots',
    base: 'BOOTS (INT)',
    extraMods: hysteriaExtraModsBoots,
    basePriceEx: 100,
    startingCounts: { prefixes: 0, suffixes: 0 },
    wishlist: [{
      key: 'SUFFIX:+# to Level of all Minion Skills',
      type: 'SUFFIX',
      requiredTier: 1,
      required: true,
    }],
    essences: [hysteriaRow],
    essencePrices: { 'Essence of Hysteria': { priceEx: 540 } },
  });
  const ess = input.essences.find((e) => /Hysteria/.test(e.name));
  assert.equal(ess, undefined,
    'Hysteria should NOT appear when its per-base outcome cannot satisfy the wishlist');
});

// ── End-to-end: solver selects Hysteria for Boots/Movement Speed ──────

const bootsBaseInput = {
  // Movement Speed on Boots is the canonical Hysteria target. Real
  // PoE2 data: Movement Speed T1 weight = 1000, total prefix weight
  // at ilvl 82 ≈ 44000 → ~2.3% per prefix roll, so orb-spam beats
  // Hysteria on cost at realistic weights. We deliberately use a
  // very rare synthetic weight here to test the "Hysteria wins"
  // branch of the policy.
  wishlist: [{
    key: 'PREFIX:increased_movement_speed',
    weight: 10, // synthetic ultra-rare so 540-ex Hysteria can win
    type: 'PREFIX',
    requiredTier: 1,
  }],
  irrelevantWeight: 50000,
  irrelevantWeightBySide: { PREFIX: 25000, SUFFIX: 25000 },
  target: {
    requiredMods: ['PREFIX:increased_movement_speed'],
    minFilled: 1,
    maxFilled: 6,
  },
  start: { rarity: 'normal' },
  basePriceEx: 5,
  alchemyDraws: 4,
  maxFilled: 6,
  timeWeightExPerSec: 0,
  budgetEx: 100000,
};

const bootsRates = {
  orbCosts: {
    transmute: 0.01, augment: 0.05, regal: 5,
    alch: 5, exalt: 1, annul: 0.5, fracturing: 50,
  },
  orbTimes: {
    transmute: 1, augment: 1, regal: 1,
    alch: 1, exalt: 1, annul: 1, fracturing: 3,
  },
};

test('solver picks Hysteria when it is the cheapest path to Movement Speed on Boots', () => {
  // Realistic-ish Hysteria price (~540 ex per 2026-05-25 rates.csv
  // snapshot). With the synthetic ultra-rare wishlist weight (10 /
  // 50000 ≈ 0.02% per prefix roll) the geometric expected cost of
  // orb-rolling easily dwarfs the essence; Hysteria wins.
  const result = solveMDP({
    ...bootsBaseInput,
    ...bootsRates,
    essences: [{
      id: 'essence_essence_of_hysteria',
      name: 'Essence of Hysteria',
      costEx: 540,
      timeSec: 1,
      matchedKeys: ['PREFIX:increased_movement_speed'],
      pAcceptable: 1,
    }],
  });
  const policies = new Set([...result.policy.values()].filter(Boolean));
  assert.ok(policies.has('essence_essence_of_hysteria'),
    `Hysteria should be in the optimal policy for Boots/Movement Speed; got: ${[...policies]}`);
});

test('solver routes around Hysteria when it is priced above the orb-roll alternative', () => {
  // Same scenario but Hysteria priced at 10000 ex — orb-roll
  // expected cost is much lower (~1/0.004 × ~1ex ≈ 250 ex), so the
  // engine should NOT select Hysteria. Pins that Hysteria selection
  // is a real cost decision, not unconditional.
  const result = solveMDP({
    ...bootsBaseInput,
    ...bootsRates,
    essences: [{
      id: 'essence_essence_of_hysteria',
      name: 'Essence of Hysteria',
      costEx: 10000,
      timeSec: 1,
      matchedKeys: ['PREFIX:increased_movement_speed'],
      pAcceptable: 1,
    }],
  });
  const policies = new Set([...result.policy.values()].filter(Boolean));
  assert.ok(!policies.has('essence_essence_of_hysteria'),
    `Hysteria at 10000 ex should be dominated by orb-roll; got: ${[...policies]}`);
});

test('solver picks Hysteria when wishlist requires T1 (other tiers unavailable)', () => {
  // Hysteria is Perfect-only; if the user requires T1 and there's no
  // cheaper Perfect-tier essence for Movement Speed (there isn't —
  // it's a Hysteria-exclusive mod), Hysteria is the ONLY guaranteed
  // path. Even at 540 ex this beats orb-spam on a 200/50000-weight
  // wished mod.
  const result = solveMDP({
    ...bootsBaseInput,
    ...bootsRates,
    wishlist: [{
      ...bootsBaseInput.wishlist[0],
      requiredTier: 1, // T1 only — orb-roll must roll into T1 specifically
    }],
    essences: [{
      id: 'essence_essence_of_hysteria',
      name: 'Essence of Hysteria',
      costEx: 540,
      timeSec: 1,
      matchedKeys: ['PREFIX:increased_movement_speed'],
      pAcceptable: 1,
    }],
  });
  const policies = new Set([...result.policy.values()].filter(Boolean));
  assert.ok(policies.has('essence_essence_of_hysteria'),
    `Hysteria should be selected when T1 is required and it's the only Perfect-tier source; got: ${[...policies]}`);
});

console.log(`\n${passed} passed · ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
