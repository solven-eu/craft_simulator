// Concrete-item DSL — round-trip + parser robustness.

import { strict as assert } from 'node:assert';
import { parseConcreteItem, serializeConcreteItem } from '../engine/concrete-item-syntax.js';
import { parseModRange, rollValue } from '../engine/mod-range-parser.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.message}`); }
}

console.log('Concrete-item DSL + mod-range parser tests');

test('parses a hand-typed concrete bow item with full ranges', () => {
  const text = `
    type: Bow
    base: BOW
    ilvl: 84
    rarity: rare
    S T1 =9 [8..12] "#% Surpassing chance to fire an additional Arrow" frac
    P T2 =180 [170..200] "# increased Physical Damage"
    P T3 =50 [40..60] "# to maximum Life"
  `;
  const r = parseConcreteItem(text);
  assert.equal(r.ok, true, `parse should succeed; got ${JSON.stringify(r.errors)}`);
  assert.equal(r.item.itemType, 'Bow');
  assert.equal(r.item.rarity, 'rare');
  assert.equal(r.item.affixes.length, 3);
  const arrow = r.item.affixes[0];
  assert.equal(arrow.side, 'SUFFIX');
  assert.equal(arrow.tier, 1);
  assert.equal(arrow.value, 9);
  assert.equal(arrow.vmin, 8);
  assert.equal(arrow.vmax, 12);
  assert.equal(arrow.fractured, true);
  const phys = r.item.affixes[1];
  assert.equal(phys.side, 'PREFIX');
  assert.equal(phys.tier, 2);
  assert.equal(phys.fractured, false);
});

test('round-trip: serialize → parse preserves all affix fields', () => {
  const original = {
    itemType: 'Body Armour',
    base: 'BODY (STR)',
    itemLevel: 82,
    rarity: 'rare',
    totalEx: 1234,
    totalSec: 567,
    buyBaseEvents: 2,
    orbCounts: { transmute: 5, regal: 1 },
    affixes: [
      { side: 'PREFIX', tier: 1, value: 88, vmin: 80, vmax: 99, name: '+# to maximum Life', fractured: true },
      { side: 'SUFFIX', tier: 3, value: 22, vmin: 20, vmax: 25, name: '#% increased Attack Speed', fractured: false },
    ],
  };
  const text = serializeConcreteItem(original);
  const r = parseConcreteItem(text);
  assert.equal(r.ok, true, `parse should succeed; got ${JSON.stringify(r.errors)}`);
  assert.equal(r.item.itemType, original.itemType);
  assert.equal(r.item.rarity, original.rarity);
  assert.equal(r.item.totalEx, original.totalEx);
  assert.equal(r.item.buyBaseEvents, original.buyBaseEvents);
  assert.deepEqual(r.item.orbCounts, original.orbCounts);
  for (let i = 0; i < original.affixes.length; i++) {
    const a = r.item.affixes[i];
    const b = original.affixes[i];
    assert.equal(a.side, b.side);
    assert.equal(a.tier, b.tier);
    assert.equal(a.value, b.value);
    assert.equal(a.vmin, b.vmin);
    assert.equal(a.vmax, b.vmax);
    assert.equal(a.name, b.name);
    assert.equal(a.fractured, b.fractured);
  }
});

test('range is optional in affix line', () => {
  const text = `
    type: Ring
    rarity: rare
    P T2 =50 "# to maximum Life"
  `;
  const r = parseConcreteItem(text);
  assert.equal(r.ok, true);
  const a = r.item.affixes[0];
  assert.equal(a.value, 50);
  assert.ok(a.vmin === undefined && a.vmax === undefined,
    `vmin/vmax should be unset when range absent; got vmin=${a.vmin} vmax=${a.vmax}`);
});

test('mod-range parser extracts (min—max) from display text', () => {
  // EM-dash (PoE2 convention).
  let r = parseModRange('+(30—39) to maximum Life');
  assert.deepEqual(r, { vmin: 30, vmax: 39 });
  // Hyphen (hand-typed).
  r = parseModRange('+(30-39) to maximum Life');
  assert.deepEqual(r, { vmin: 30, vmax: 39 });
  // Decimal.
  r = parseModRange('(0.5—1.5)% chance to ignite');
  assert.deepEqual(r, { vmin: 0.5, vmax: 1.5 });
  // Multi-range: span across all (lowest min to highest max).
  r = parseModRange('Adds (5—8) to (12—16) Fire Damage');
  assert.deepEqual(r, { vmin: 5, vmax: 16 });
  // Single value, no range.
  r = parseModRange('+5 to maximum Life');
  assert.deepEqual(r, { vmin: 5, vmax: 5 });
  // No numeric content.
  r = parseModRange('Some flavour text without numbers');
  assert.equal(r, null);
});

test('rollValue picks within range; integer endpoints ⇒ integer result', () => {
  // Stub RNG so we can pin the output.
  for (const r of [0, 0.25, 0.5, 0.75, 0.99]) {
    const v = rollValue({ vmin: 30, vmax: 50 }, () => r);
    assert.ok(Number.isInteger(v), `expected integer; got ${v}`);
    assert.ok(v >= 30 && v <= 50, `out of range: ${v}`);
  }
  // Float endpoints ⇒ 2dp result.
  const f = rollValue({ vmin: 1.5, vmax: 2.0 }, () => 0.5);
  assert.ok(Math.abs(f - 1.75) < 1e-9, `got ${f}`);
});

test('garbage line surfaces as warning, not hard error', () => {
  const text = `
    type: Bow
    !!! garbage
    P T1 =50 "# to Life"
  `;
  const r = parseConcreteItem(text);
  assert.equal(r.ok, true);
  assert.ok(r.warnings.length >= 1);
  assert.equal(r.item.affixes.length, 1);
});

console.log(`\n${passed} passed · ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
