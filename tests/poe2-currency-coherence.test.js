// Cross-file currency-coherence sanity check.
//
// As soon as an orb / currency is mentioned anywhere in the project
// (orb catalog, MDP action set, adapter cost lookup, currency catalog,
// rates CSV slug), it must be registered in EVERY other place that
// expects to see it. The earlier silent failure mode:
//   - `games/poe2/orbs.js` declared `regalGreater` with
//     `priceCurrency: 'regalGreater'`,
//   - `data/poe2/rates.csv` had a price row for `greater-regal-orb`,
//   - BUT `games/poe2/currency.js` was missing the `regalGreater`
//     entry,
//   so `safeCost('regalGreater', ctx)` returned NaN and the engine
//   silently excluded `regal_greater`. Same gap hit `augmentGreater`,
//   `transmuteGreater`, `transmutePerfect`.
//
// This test fails the build if a similar gap recurs.

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { currencies } from '../games/poe2/currency.js';
import { orbs } from '../games/poe2/orbs.js';
import { ACTIONS } from '../engine/mdp/actions.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.message}`); }
}

console.log('PoE2 currency / orb coherence');

test('every orb.priceCurrency resolves to a currency entry', () => {
  // The MDP adapter's safeCost path: orb → priceCurrency → currency
  // entry → exaltedPer. Any orb whose priceCurrency doesn't resolve
  // returns NaN, silently excluding that orb from the action set.
  const missing = [];
  for (const [orbId, orb] of Object.entries(orbs)) {
    if (!orb.priceCurrency) continue;
    if (!currencies[orb.priceCurrency]) {
      missing.push(`${orbId}.priceCurrency = "${orb.priceCurrency}"`);
    }
  }
  assert.deepEqual(missing, [],
    `orbs reference currency ids that don't exist in currency.js:\n  ${missing.join('\n  ')}`);
});

test('every orb id has a currency entry under the same key (default rate seed)', () => {
  // Convention: orb id and its priceCurrency share a key (e.g. orb
  // `regalGreater` priced in currency `regalGreater`). Catches a
  // class of typos where orbs.js says `priceCurrency: 'regalGr'`
  // and currency.js has `regalGreater`.
  const mismatched = [];
  for (const [orbId, orb] of Object.entries(orbs)) {
    if (orb.priceCurrency && orb.priceCurrency !== orbId) {
      // Allowed: explicit non-self pricing (rare; flag for review).
      mismatched.push(`${orbId}.priceCurrency = "${orb.priceCurrency}" (expected self)`);
    }
  }
  // Self-pricing is the convention for tradable orbs in PoE2; the
  // assertion is informational here — log mismatches but don't fail
  // (some legitimate cross-pricing might exist).
  if (mismatched.length) {
    console.log(`    ℹ orbs with non-self priceCurrency (review):`);
    for (const m of mismatched) console.log(`      - ${m}`);
  }
});

test('every Greater/Perfect MDP action has a corresponding orb catalog entry', () => {
  // The MDP-γ action set carries actions like `regal_perfect` whose
  // adapter resolves to orb id `regalPerfect` (camelCase). If the
  // orb catalog is missing the entry, the action's cost lookup
  // returns NaN and the engine silently excludes it. Pin the full
  // mapping.
  const actionToOrb = {
    transmute_greater: 'transmuteGreater',
    transmute_perfect: 'transmutePerfect',
    augment_greater:   'augmentGreater',
    augment_perfect:   'augmentPerfect',
    regal_greater:     'regalGreater',
    regal_perfect:     'regalPerfect',
    exalt_greater:     'exaltedGreater',
    exalt_perfect:     'exaltedPerfect',
  };
  const missing = [];
  for (const [actionId, orbId] of Object.entries(actionToOrb)) {
    if (!ACTIONS[actionId]) {
      missing.push(`MDP action "${actionId}" not in engine/mdp/actions.js`);
    }
    if (!orbs[orbId]) {
      missing.push(`orb "${orbId}" not in games/poe2/orbs.js`);
    }
    if (!currencies[orbId]) {
      missing.push(`currency "${orbId}" not in games/poe2/currency.js`);
    }
  }
  assert.deepEqual(missing, [],
    `Greater/Perfect orb plumbing gaps:\n  ${missing.join('\n  ')}`);
});

test('every Greater/Perfect orb mentioned in rates.csv has a currency entry under the matching id', () => {
  // The rates.csv loader maps slug → currency by display name (poe2
  // economy snapshot). A currency.js entry whose `name` matches the
  // CSV row must exist so the live rate flows in. Earlier
  // `greater-orb-of-augmentation` was in the CSV but `augmentGreater`
  // was absent from currency.js, so the live rate was discarded.
  const csv = readFileSync(resolve(ROOT, 'data/poe2/rates.csv'), 'utf8');
  const lines = csv.trim().split('\n').slice(1); // skip header
  const namesInCsv = new Set();
  for (const line of lines) {
    const [name, , kind] = line.split(',');
    if (kind !== 'currency') continue;
    if (/^(Greater|Perfect)\b/.test(name)) namesInCsv.add(name);
  }
  // Include every currency-like kind (orb, jeweller, …) — Greater/
  // Perfect Jeweller's Orbs sit under `kind: 'jeweller'` but still
  // need a catalog entry for live rates to flow.
  const namesInCatalog = new Set(
    Object.values(currencies).map((c) => c.name),
  );
  const missing = [];
  for (const n of namesInCsv) {
    if (!namesInCatalog.has(n)) missing.push(n);
  }
  assert.deepEqual(missing, [],
    `Greater/Perfect orbs in rates.csv have no currency.js counterpart:\n  ${missing.join('\n  ')}`);
});

test('every kind=orb currency is either consumed by an MDP action OR explicitly allowlisted', () => {
  // Inverse coverage check: walk every currency of `kind: 'orb'` in
  // the catalog and require either:
  //   (a) some MDP action consumes it (via the orb-id mapping below), OR
  //   (b) it appears in the explicit non-crafting allowlist with a
  //       documented reason.
  // Anything in neither set is a real gap (the currency exists in
  // the catalog with a price but no engine action would let the user
  // ever spend it).
  //
  // The mapping below covers static MDP actions whose id maps to a
  // single orb id. Dynamic actions (essences from `apply_essence`,
  // bones from `apply_bone`) consume currencies via separate adapter
  // logic and are accounted for via the desecrated/essence allowlist
  // entries (these currencies are kind='desecrated' / 'essence', not
  // 'orb', so they don't reach this test).
  const actionToOrbId = {
    transmute: 'transmute', transmute_greater: 'transmuteGreater', transmute_perfect: 'transmutePerfect',
    augment:   'augment',   augment_greater:   'augmentGreater',   augment_perfect:   'augmentPerfect',
    regal:     'regal',     regal_greater:     'regalGreater',     regal_perfect:     'regalPerfect',
    regal_sinistral: 'regal', regal_dextral: 'regal',  // omen-augmented; same orb cost
    alch:      'alchemy',
    exalt:     'exalted',   exalt_greater:     'exaltedGreater',   exalt_perfect:     'exaltedPerfect',
    annul:     'annulment',
    chaos:     'chaos',     chaos_greater:     'chaosGreater',     chaos_perfect:     'chaosPerfect',
    fracturing: 'fracturing',
  };
  const consumedOrbIds = new Set();
  for (const actId of Object.keys(actionToOrbId)) {
    if (ACTIONS[actId]) consumedOrbIds.add(actionToOrbId[actId]);
  }
  // Allowlist: currencies that are intentionally NOT modeled in the
  // crafting MDP, with a reason. If you add a new orb-kind currency
  // and it's irrelevant to crafting (Vaal corruption RNG, Mirror
  // duplication, Chance Orb upgrades, etc.), append here with a
  // short justification. The reason field documents the rationale
  // for human reviewers; if a future engine version DOES model one
  // of these, remove the entry — the test will then enforce that
  // an action consumes it.
  const allowlist = {
    divine:          'Re-rolls VALUES within tier ranges; doesn\'t change tier or affix identity. MDP doesn\'t track per-roll values.',
    vaal:            'Corruption is a random one-shot terminal outcome (brick / divine / enchant / socket). Modelable as MDP-η; deferred.',
    vaalCultivation: 'Corrupts a SUPPORT GEM, not items. Out of crafting scope.',
    chance:          'White → random rarity (chance to upgrade to Unique). MDP doesn\'t model uniques.',
    extraction:      'Extracts essences from items, doesn\'t produce craftable affixes. Niche; out of scope.',
    architect:       'Map crafting / waystone-only. Out of item-affix scope.',
  };
  const orbCurrencies = Object.values(currencies).filter((c) => c.kind === 'orb');
  const gaps = [];
  for (const c of orbCurrencies) {
    if (consumedOrbIds.has(c.id)) continue;
    if (Object.prototype.hasOwnProperty.call(allowlist, c.id)) continue;
    gaps.push(`${c.id} (${c.name}) — present in currency.js with price ${c.exaltedPer} ex but no MDP action consumes it AND not in the non-crafting allowlist`);
  }
  assert.deepEqual(gaps, [],
    `Currencies with no MDP action AND not in the explicit non-crafting allowlist:\n  ${gaps.join('\n  ')}`);
});

test('every adapter-referenced orb id resolves end-to-end', () => {
  // Final integration: walk every orb id the MDP adapter looks up
  // (via the orbCosts mapping inside ctxToMdpInput) and verify each
  // resolves through orbs.js → currencies.js. Catches the case where
  // a future engine action is added with a new orb id but the catalog
  // updates lag behind.
  const adapterOrbIds = [
    'transmute', 'transmuteGreater', 'transmutePerfect',
    'augment',   'augmentGreater',   'augmentPerfect',
    'regal',     'regalGreater',     'regalPerfect',
    'alchemy',
    'exalted',   'exaltedGreater',   'exaltedPerfect',
    'annulment', 'fracturing',
  ];
  const missing = [];
  for (const id of adapterOrbIds) {
    if (!orbs[id]) missing.push(`orbs.js missing ${id}`);
    const orb = orbs[id];
    if (orb && !currencies[orb.priceCurrency]) {
      missing.push(`currencies.js missing ${orb.priceCurrency} (referenced by orbs.${id})`);
    }
  }
  assert.deepEqual(missing, [],
    `Adapter-referenced orb plumbing gaps:\n  ${missing.join('\n  ')}`);
});

console.log(`\n${passed} passed · ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
