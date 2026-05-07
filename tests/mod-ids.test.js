// Mod-id helpers — pin the slug recipe matches scripts/assign-mod-ids.py
// and the curated data/poe2/mod_ids.json table is consistent with it.
//
// If the JS port drifts from the Python script the curated table
// becomes wrong and the engine adapter can't resolve user-typed
// wishlist keys. The test loads mod_ids.json and asserts every
// (name, id) row round-trips through slugifyModName.

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  slugifyModName, resolveModId, splitTypedKey, resolveTypedKey,
} from '../engine/mod-ids.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.message}`); }
}

console.log('Mod-id helpers');

test('slugifyModName covers the canonical examples', () => {
  const cases = [
    ['+# to maximum Life',                          'max_life'],
    ['# to maximum Life',                           'max_life'],
    ['#% to Cold Resistance',                       'cold_res'],
    ['+#% to Cold Resistance',                      'cold_res'],
    ['# to # Physical Thorns damage',               'physical_thorns_dmg'],
    ['#% increased Critical Hit Chance',            'inc_crit_hit_chance'],
    ['# to maximum Energy Shield',                  'max_es'],
    ['Mark of the Abyssal Lord',                    'mark_the_abyssal_lord'],
    ['# to Strength',                               'str'],
    ['# to Dexterity',                              'dex'],
    ['# to Intelligence',                           'int'],
  ];
  for (const [input, expected] of cases) {
    const got = slugifyModName(input);
    assert.equal(got, expected,
      `slugifyModName(${JSON.stringify(input)}) → ${JSON.stringify(got)}, ` +
      `expected ${JSON.stringify(expected)}`);
  }
});

test('JS slugify matches the curated mod_ids.json (round-trip)', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const path = resolve(here, '..', 'data', 'poe2', 'mod_ids.json');
  const data = JSON.parse(readFileSync(path, 'utf-8'));
  const mismatches = [];
  for (const [name, expected] of Object.entries(data.name_to_id)) {
    const got = slugifyModName(name);
    if (got !== expected) mismatches.push({ name, expected, got });
  }
  assert.equal(mismatches.length, 0,
    `${mismatches.length} mismatch(es) between JS slugify and Python-generated table:\n` +
    mismatches.slice(0, 10).map(({ name, expected, got }) =>
      `  ${JSON.stringify(name)} → JS ${JSON.stringify(got)} vs Py ${JSON.stringify(expected)}`,
    ).join('\n'));
});

test('resolveModId prefers the curated map', () => {
  const map = { '+# to maximum Life': 'max_life' };
  assert.equal(resolveModId('+# to maximum Life', map), 'max_life');
  // Already-an-id passes through unchanged.
  assert.equal(resolveModId('max_life', map), 'max_life');
  // Unknown name falls back to live slugify.
  assert.equal(resolveModId('+# to Strength', map), 'str');
  // Empty / non-string returns null.
  assert.equal(resolveModId('', map), null);
  assert.equal(resolveModId(null, map), null);
});

test('splitTypedKey + resolveTypedKey round-trip', () => {
  const map = { '+# to maximum Life': 'max_life', '# to Strength': 'str' };
  assert.deepEqual(splitTypedKey('PREFIX:+# to maximum Life'),
    { type: 'PREFIX', rest: '+# to maximum Life' });
  assert.equal(resolveTypedKey('PREFIX:+# to maximum Life', map), 'PREFIX:max_life');
  assert.equal(resolveTypedKey('SUFFIX:# to Strength', map), 'SUFFIX:str');
  // Already canonical, passes through.
  assert.equal(resolveTypedKey('PREFIX:max_life', map), 'PREFIX:max_life');
  // No colon, returned unchanged.
  assert.equal(resolveTypedKey('plain-name', map), 'plain-name');
});

if (failed > 0) process.exit(1);
console.log(`\n${passed} passed, ${failed} failed`);
