// Recipe DSL — round-trip + parser robustness tests.
//
// Format spec lives in `engine/recipe-syntax.js`. These tests pin:
//   1. Hand-typed example parses cleanly.
//   2. serialize → parse → equals original (round-trip).
//   3. Comments and `#` inside quoted mod names don't break parsing.
//   4. Header keys are case-insensitive; affix tier / flags optional.
//   5. Garbage lines surface as warnings, not hard errors.

import { strict as assert } from 'node:assert';
import { parseRecipe, serializeRecipe } from '../engine/recipe-syntax.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.message}`); }
}

console.log('Recipe DSL tests');

test('parses a hand-typed bow-fracture recipe', () => {
  const text = `
    # PoE2 Crafter recipe
    type: Bow
    base: BOW
    ilvl: 84
    budget_ex: 50000
    filled: 1..1
    required_hits: 1
    time_weight_ex_per_sec: 0.1

    # Affixes:
    S T1+ "#% Surpassing chance to fire an additional Arrow" req frac
    P T3+ "# to maximum Life"
  `;
  const r = parseRecipe(text);
  assert.equal(r.ok, true, `parse should succeed; errors=${r.errors?.join(';')}`);
  const s = r.state;
  assert.equal(s.itemType, 'Bow');
  assert.equal(s.base, 'BOW');
  assert.equal(s.itemLevel, 84);
  assert.equal(s.totalBudgetEx, 50000);
  assert.equal(s.minFilled, 1);
  assert.equal(s.maxFilled, 1);
  assert.equal(s.requiredHits, 1);
  assert.equal(s.timeWeightExPerSec, 0.1);
  assert.equal(s.targetEntries.length, 2);
  const [arrow, life] = s.targetEntries;
  assert.equal(arrow.type, 'SUFFIX');
  assert.equal(arrow.name, '#% Surpassing chance to fire an additional Arrow');
  assert.equal(arrow.minTier, 1);
  assert.equal(arrow.required, true);
  assert.equal(arrow.fractured, true);
  assert.equal(life.type, 'PREFIX');
  assert.equal(life.name, '# to maximum Life');
  assert.equal(life.minTier, 3);
  assert.equal(life.required, false);
  assert.equal(life.fractured, false);
});

test('round-trip: serialize → parse equals original (modulo undefined ↔ optional fields)', () => {
  const original = {
    itemType: 'Body Armour',
    base: 'BODY (STR)',
    itemLevel: 82,
    totalBudgetEx: 12000,
    minFilled: 1,
    maxFilled: 6,
    requiredHits: 2,
    timeWeightExPerSec: 0.05,
    targetEntries: [
      { kind: 'mod', type: 'PREFIX', name: '# to maximum Life', minTier: 1, requiredTier: 1, required: true, fractured: true },
      { kind: 'mod', type: 'PREFIX', name: '#% increased Energy Shield', minTier: 3, requiredTier: 3, required: false, fractured: false },
      { kind: 'mod', type: 'SUFFIX', name: '#% to all Resistances', minTier: 5, requiredTier: 5, required: false, fractured: false },
    ],
  };
  const text = serializeRecipe(original);
  const r = parseRecipe(text);
  assert.equal(r.ok, true, `parse should succeed; errors=${r.errors?.join(';')}`);
  // Header round-trip.
  assert.equal(r.state.itemType, original.itemType);
  assert.equal(r.state.base, original.base);
  assert.equal(r.state.itemLevel, original.itemLevel);
  assert.equal(r.state.totalBudgetEx, original.totalBudgetEx);
  assert.equal(r.state.minFilled, original.minFilled);
  assert.equal(r.state.maxFilled, original.maxFilled);
  assert.equal(r.state.requiredHits, original.requiredHits);
  assert.equal(r.state.timeWeightExPerSec, original.timeWeightExPerSec);
  // Affixes round-trip (compare relevant fields, not strict deepEqual
  // since `requiredTier` is parsed from the same `Tn+` syntax as
  // `minTier`).
  assert.equal(r.state.targetEntries.length, original.targetEntries.length);
  for (let i = 0; i < original.targetEntries.length; i++) {
    const a = r.state.targetEntries[i];
    const b = original.targetEntries[i];
    assert.equal(a.type, b.type);
    assert.equal(a.name, b.name);
    assert.equal(a.minTier, b.minTier);
    assert.equal(!!a.required, !!b.required);
    assert.equal(!!a.fractured, !!b.fractured);
  }
});

test('# inside a quoted mod name is preserved (not stripped as a comment)', () => {
  // "# to Stun Threshold" begins with `#` — the parser must not
  // treat that as the start of an end-of-line comment.
  const text = `
    type: Boots
    base: BOOTS
    ilvl: 80
    S T2+ "# to Stun Threshold" req
  `;
  const r = parseRecipe(text);
  assert.equal(r.ok, true, `parse should succeed; got errors=${r.errors?.join(';')}`);
  assert.equal(r.state.targetEntries.length, 1);
  assert.equal(r.state.targetEntries[0].name, '# to Stun Threshold');
});

test('header keys are case-insensitive', () => {
  const text = `
    Type: Helmet
    BASE: HELMET
    ILvl: 75
    Budget_EX: 200
  `;
  const r = parseRecipe(text);
  assert.equal(r.ok, true);
  assert.equal(r.state.itemType, 'Helmet');
  assert.equal(r.state.base, 'HELMET');
  assert.equal(r.state.itemLevel, 75);
  assert.equal(r.state.totalBudgetEx, 200);
});

test('affix without tier or flags parses as soft-wished entry', () => {
  const text = `
    type: Ring
    base: RING
    ilvl: 80
    P "# to maximum Life"
  `;
  const r = parseRecipe(text);
  assert.equal(r.ok, true);
  const e = r.state.targetEntries[0];
  assert.equal(e.type, 'PREFIX');
  assert.equal(e.name, '# to maximum Life');
  assert.equal(e.required, false);
  assert.equal(e.fractured, false);
  assert.ok(e.minTier === undefined || e.minTier === null,
    `no tier provided ⇒ minTier should be unset; got ${e.minTier}`);
});

test('garbage lines surface as warnings, not hard errors', () => {
  const text = `
    type: Bow
    base: BOW
    ilvl: 80
    !!! random garbage line that is neither a header nor an affix
    P T1+ "# to Life"
  `;
  const r = parseRecipe(text);
  assert.equal(r.ok, true, 'parser should succeed despite garbage line');
  assert.ok(r.warnings.length >= 1, `expected at least one warning; got ${r.warnings.length}`);
  assert.ok(/random garbage/.test(r.warnings[0]));
  // Valid lines should still be parsed.
  assert.equal(r.state.itemType, 'Bow');
  assert.equal(r.state.targetEntries.length, 1);
});

test('non-string input ⇒ ok=false with error', () => {
  const r = parseRecipe(null);
  assert.equal(r.ok, false);
  assert.ok(r.errors?.length > 0);
});

console.log(`\n${passed} passed · ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
