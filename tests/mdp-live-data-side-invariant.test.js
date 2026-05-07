// Live-data regression test: load the actual essence catalog,
// essence prices, mod IDs, item-class tags, and exercise the user's
// reported craft scenario through ctxToMdpInput → solveMDP. Then
// assert the side invariant on every reachable state.
//
// User report (2026-05-07): live Body Armour craft with 2 PREFIX
// wished essence-only mods showed two goal nodes — one rendered
// `(2P + 0S = 2)`, another `(1P + 1S = 2)`. The second is invalid:
// both wished bits are PREFIX, so `prefixMods` must be ≥ 2.
//
// Earlier `mdp-goal-state-consistency.test.js` only fed two
// hand-crafted essence rows; live ctx pulls 60+ rows + omen-augmented
// variants the adapter synthesises. This file reads the real files
// so the test surfaces ANY action interaction that violates the
// `popcount(modMask & PREFIX_BITS) ≤ prefixMods` invariant.

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ctxToMdpInput } from '../engine/mdp/adapter.js';
import { solveMDP } from '../engine/mdp/solve.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.message}`); }
}

console.log('Live-data side invariant — user craft repro');

function popcount(n) { let c = 0; while (n) { c += n & 1; n >>>= 1; } return c; }

// CSV parser that handles quoted commas (needed for `target_affix`
// rows that contain commas inside the value range).
function parseCsv(text) {
  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  const parseRow = (r) => {
    const out = []; let cur = ''; let q = false;
    for (const c of r) {
      if (c === '"') { q = !q; continue; }
      if (c === ',' && !q) { out.push(cur); cur = ''; continue; }
      cur += c;
    }
    out.push(cur);
    return out;
  };
  const hdr = parseRow(lines[0]).map((h) => h.replace(/\r$/, ''));
  return lines.slice(1).map((l) => {
    const r = parseRow(l);
    const o = {};
    hdr.forEach((h, i) => { o[h] = r[i] ?? ''; });
    return o;
  });
}

const essences = parseCsv(readFileSync(join(ROOT, 'data/poe2/essences.csv'), 'utf8'));
const priceRows = parseCsv(readFileSync(join(ROOT, 'data/poe2/essence_prices.csv'), 'utf8'));
const essencePrices = {};
for (const r of priceRows) {
  const px = parseFloat(r.priceEx ?? r.price ?? r['priceEx '] ?? '');
  if (Number.isFinite(px)) essencePrices[r.name] = { priceEx: px };
}
const modIds = JSON.parse(readFileSync(join(ROOT, 'data/poe2/mod_ids.json'), 'utf8')).name_to_id ?? {};

function checkSideInvariant(result, wishlistTypes, label) {
  let prefixBits = 0;
  for (let i = 0; i < wishlistTypes.length; i++) {
    if (wishlistTypes[i] === 'PREFIX') prefixBits |= (1 << i);
  }
  const violations = [];
  for (const r of result.states) {
    const s = r.state;
    const wishedPrefixOnItem = popcount(s.modMask & prefixBits);
    const totalPrefix = s.prefixMods ?? 0;
    if (wishedPrefixOnItem > totalPrefix) {
      violations.push(`${label}: ${wishedPrefixOnItem} PREFIX wished bits set but prefixMods=${totalPrefix}; mask=${s.modMask}, totalMods=${s.totalMods}`);
    }
    if (totalPrefix > 3) {
      violations.push(`${label}: prefixMods=${totalPrefix} > 3; ${JSON.stringify(s)}`);
    }
    if (s.totalMods - totalPrefix > 3) {
      violations.push(`${label}: suffixMods=${s.totalMods - totalPrefix} > 3; ${JSON.stringify(s)}`);
    }
  }
  if (violations.length) {
    throw new Error(`${violations.length} violation(s):\n  ${violations.slice(0, 5).join('\n  ')}`);
  }
}

// Synthesised pool that mimics the live UI's `fullPool` shape — many
// PREFIX + SUFFIX irrelevants with non-zero weights, and the wished
// essence-only mods absent from the pool (weight stays 0). The live
// craft's `irrelevantWeightBySide` is then non-zero, which routes
// orb transitions through the non-empty-pool branch — exercising
// different probabilities than `fullPool: []`.
const BODY_ARMOUR_LIKE_POOL = [
  // 12 prefix irrelevants
  ...Array.from({ length: 12 }, (_, i) => ({
    key: `PREFIX:irr_p_${i}`, type: 'PREFIX', weight: 800 + i * 30, tiers: [],
  })),
  // 12 suffix irrelevants
  ...Array.from({ length: 12 }, (_, i) => ({
    key: `SUFFIX:irr_s_${i}`, type: 'SUFFIX', weight: 800 + i * 30, tiers: [],
  })),
];

test('live data: Body Armour STR + 2 PREFIX essence-only mods (user URL repro)', () => {
  const wishlist = [
    { key: 'PREFIX:#% increased Armour, Evasion or Energy Shield', type: 'PREFIX', requiredTier: 1, required: true },
    { key: 'PREFIX:#% increased maximum Life',                      type: 'PREFIX', requiredTier: 1, required: true },
  ];
  const ctx = {
    modIds, fullPool: BODY_ARMOUR_LIKE_POOL, itemClass: 'Body Armour',
    basePriceEx: 100,
    startingCounts: { prefixes: 0, suffixes: 0 },
    wishlist,
    essences,
    essencePrices,
    omenPrices: {},   // no omen variants — narrows to base + Crystallisation excluded
  };
  const input = ctxToMdpInput(ctx);
  const result = solveMDP({
    ...input,
    target: { ...input.target, minFilled: 2, maxFilled: 6 },
    orbCosts: { transmute: 0.01, augment: 0.05, regal: 0.5, alch: 1, exalt: 5, annul: 9.5, fracturing: 50, chaos: 5 },
    orbTimes: { transmute: 1, augment: 1, regal: 1, alch: 1, exalt: 1, annul: 1, fracturing: 3, chaos: 1 },
    budgetEx: 50000,
  });
  checkSideInvariant(result, ['PREFIX', 'PREFIX'], 'live-data');
});

test('live data: same craft + omen prices (Crystallisation variants emitted)', () => {
  // Mirror the live UI more faithfully — supply omen prices so the
  // adapter emits Sinistral/Dextral Crystallisation variants of the
  // Perfect-essence overwrite. This is the path the live craft uses
  // when the user has those omens priced.
  const wishlist = [
    { key: 'PREFIX:#% increased Armour, Evasion or Energy Shield', type: 'PREFIX', requiredTier: 1, required: true },
    { key: 'PREFIX:#% increased maximum Life',                      type: 'PREFIX', requiredTier: 1, required: true },
  ];
  const ctx = {
    modIds, fullPool: BODY_ARMOUR_LIKE_POOL, itemClass: 'Body Armour',
    basePriceEx: 100,
    startingCounts: { prefixes: 0, suffixes: 0 },
    wishlist,
    essences,
    essencePrices,
    omenPrices: {
      'omen-of-sinistral-crystallisation': 50,
      'omen-of-dextral-crystallisation':   50,
      'omen-of-light':                     20,
      'omen-of-sinistral-coronation':      30,
      'omen-of-dextral-coronation':        30,
      'omen-of-sinistral-necromancy':      40,
      'omen-of-dextral-necromancy':        40,
      'omen-of-abyssal-echoes':            60,
    },
    currencies: [],
  };
  const input = ctxToMdpInput(ctx);
  const result = solveMDP({
    ...input,
    target: { ...input.target, minFilled: 2, maxFilled: 6 },
    orbCosts: {
      transmute: 0.01, augment: 0.05, regal: 0.5, alch: 1, exalt: 5,
      annul: 9.5, fracturing: 50, chaos: 5,
      // Side-augmented standard orbs need their costs piped through too.
      regal_sinistral: 30, regal_dextral: 30,
      exalt_sinistral: 35, exalt_dextral: 35,
      reveal_bone: 0, reveal_bone_sinistral: 40, reveal_bone_dextral: 40,
      reveal_bone_abyssal: 60, annul_omen_of_light: 30,
    },
    orbTimes: { transmute: 1, augment: 1, regal: 1, alch: 1, exalt: 1, annul: 1, fracturing: 3, chaos: 1 },
    boneCostEx: 0.5,
    pBoneRevealHit:        [0, 0],
    pBoneRevealHitPrefix:  [0, 0],
    pBoneRevealHitSuffix:  [0, 0],
    pBoneRevealHitAbyssal: [0, 0],
    budgetEx: 50000,
  });
  checkSideInvariant(result, ['PREFIX', 'PREFIX'], 'live-data-omens');
});

test('live data: every reachable state passes both-side caps (≤3 P, ≤3 S, ≤6 total)', () => {
  // Cover N=2 mixed-side too — the most common craft shape with
  // standard orbs + alch + Perfect-overwrite via essences.
  const wishlist = [
    { key: 'PREFIX:# to maximum Life',     type: 'PREFIX', requiredTier: 1, required: true },
    { key: 'SUFFIX:#% to Fire Resistance', type: 'SUFFIX', requiredTier: 1, required: true },
  ];
  const ctx = {
    modIds, fullPool: BODY_ARMOUR_LIKE_POOL, itemClass: 'Body Armour',
    basePriceEx: 100,
    startingCounts: { prefixes: 0, suffixes: 0 },
    wishlist,
    essences,
    essencePrices,
    omenPrices: {},
  };
  const input = ctxToMdpInput(ctx);
  const result = solveMDP({
    ...input,
    target: { ...input.target, minFilled: 2, maxFilled: 6 },
    orbCosts: { transmute: 0.01, augment: 0.05, regal: 0.5, alch: 1, exalt: 5, annul: 9.5, fracturing: 50, chaos: 5 },
    orbTimes: { transmute: 1, augment: 1, regal: 1, alch: 1, exalt: 1, annul: 1, fracturing: 3, chaos: 1 },
    budgetEx: 50000,
  });
  checkSideInvariant(result, ['PREFIX', 'SUFFIX'], 'live-data-mixed');
});

console.log(`\n${passed} passed · ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
