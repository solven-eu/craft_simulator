// Regression test: every reachable chain node must render a label
// distinct from every other node (modulo the `[sN] ` step-id
// prefix, which is trivially unique). When two states share the
// same label, the chain reader can't tell what makes them different
// — either the label rendering hides a distinguishing field or the
// BFS produced two indices for genuinely-equivalent states.
//
// User report (2026-05-07): live Body Armour craft showed two goal
// nodes (s12 and s15) with identical descriptions despite having
// different state keys. This file exercises the same scenario and
// asserts `result.chain.duplicateLabels` is empty.

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

console.log('Chain duplicate-label detector');

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
  const px = parseFloat(r.priceEx);
  if (Number.isFinite(px)) essencePrices[r.name] = { priceEx: px };
}
const modIds = JSON.parse(readFileSync(join(ROOT, 'data/poe2/mod_ids.json'), 'utf8')).name_to_id ?? {};

test('live data: 2 PREFIX essence-only mods, no duplicate chain-node labels', () => {
  const input = ctxToMdpInput({
    modIds, fullPool: [], itemClass: 'Body Armour',
    basePriceEx: 100,
    startingCounts: { prefixes: 0, suffixes: 0 },
    wishlist: [
      { key: 'PREFIX:#% increased Armour, Evasion or Energy Shield', type: 'PREFIX', requiredTier: 1, required: true },
      { key: 'PREFIX:#% increased maximum Life',                      type: 'PREFIX', requiredTier: 1, required: true },
    ],
    essences,
    essencePrices,
    omenPrices: {},
  });
  const result = solveMDP({
    ...input,
    target: { ...input.target, minFilled: 2, maxFilled: 6 },
    orbCosts: { transmute: 0.01, augment: 0.05, regal: 0.5, alch: 1, exalt: 5, annul: 9.5, fracturing: 50, chaos: 5 },
    orbTimes: { transmute: 1, augment: 1, regal: 1, alch: 1, exalt: 1, annul: 1, fracturing: 3, chaos: 1 },
    budgetEx: 50000,
  });
  const dups = result.chain.duplicateLabels;
  assert.ok(Array.isArray(dups), 'chain should expose duplicateLabels array');
  if (dups.length) {
    const sample = dups.slice(0, 3).map((d) => `  ${d.ids.join(', ')}: ${d.label.replace(/\n/g, ' / ')}`).join('\n');
    assert.fail(`expected zero duplicate labels; got ${dups.length}:\n${sample}`);
  }
});

// Synthesised fullPool that mirrors the live UI's shape — many
// PREFIX + SUFFIX irrelevants with non-zero weights. This routes
// orb transitions through the non-empty-pool branch (different
// probability split than the empty-pool deterministic fallback).
const POOL_LIKE_BODY_ARMOUR = [
  ...Array.from({ length: 12 }, (_, i) => ({
    key: `PREFIX:irr_p_${i}`, type: 'PREFIX', weight: 800 + i * 30, tiers: [],
  })),
  ...Array.from({ length: 12 }, (_, i) => ({
    key: `SUFFIX:irr_s_${i}`, type: 'SUFFIX', weight: 800 + i * 30, tiers: [],
  })),
];

test('live data with non-empty pool + omens: no duplicate chain-node labels', () => {
  const input = ctxToMdpInput({
    modIds, fullPool: POOL_LIKE_BODY_ARMOUR, itemClass: 'Body Armour',
    basePriceEx: 100,
    startingCounts: { prefixes: 0, suffixes: 0 },
    wishlist: [
      { key: 'PREFIX:#% increased Armour, Evasion or Energy Shield', type: 'PREFIX', requiredTier: 1, required: true },
      { key: 'PREFIX:#% increased maximum Life',                      type: 'PREFIX', requiredTier: 1, required: true },
    ],
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
  });
  const result = solveMDP({
    ...input,
    target: { ...input.target, minFilled: 2, maxFilled: 6 },
    orbCosts: {
      transmute: 0.01, augment: 0.05, regal: 0.5, alch: 1, exalt: 5,
      annul: 9.5, fracturing: 50, chaos: 5,
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
  const dups = result.chain.duplicateLabels;
  assert.ok(Array.isArray(dups));
  if (dups.length) {
    const sample = dups.slice(0, 5).map((d) => `  ${d.ids.join(', ')}: ${d.label.replace(/\n/g, ' / ')}`).join('\n');
    assert.fail(`expected zero duplicate labels; got ${dups.length}:\n${sample}`);
  }
});

test('live data with omens loaded: no duplicate chain-node labels', () => {
  const input = ctxToMdpInput({
    modIds, fullPool: [], itemClass: 'Body Armour',
    basePriceEx: 100,
    startingCounts: { prefixes: 0, suffixes: 0 },
    wishlist: [
      { key: 'PREFIX:#% increased Armour, Evasion or Energy Shield', type: 'PREFIX', requiredTier: 1, required: true },
      { key: 'PREFIX:#% increased maximum Life',                      type: 'PREFIX', requiredTier: 1, required: true },
    ],
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
  });
  const result = solveMDP({
    ...input,
    target: { ...input.target, minFilled: 2, maxFilled: 6 },
    orbCosts: {
      transmute: 0.01, augment: 0.05, regal: 0.5, alch: 1, exalt: 5,
      annul: 9.5, fracturing: 50, chaos: 5,
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
  const dups = result.chain.duplicateLabels;
  assert.ok(Array.isArray(dups));
  if (dups.length) {
    const sample = dups.slice(0, 5).map((d) => `  ${d.ids.join(', ')}: ${d.label.replace(/\n/g, ' / ')}`).join('\n');
    assert.fail(`expected zero duplicate labels; got ${dups.length}:\n${sample}`);
  }
});

console.log(`\n${passed} passed · ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
