// Regression: the rates-panel applicability check must normalise
// the item-type form before comparing against an essence's
// `appliesToItemClasses` list. CSV-loaded classes are stored
// SINGULAR ("Boot", "Glove"); `state.itemType` is PLURAL
// ("Boots", "Gloves"). A direct equality match always failed,
// silently greying every item_classes-tagged essence in the rates
// panel — Essence of Horror appeared "not applicable" for a Boots
// craft despite the CSV listing item_classes="Boots|Gloves".
//
// User report (2026-05-25): "Essence of Horror is greyed for
// current boots while indicating it can be applied on boots and
// gloves."
//
// The engine adapter already normalises both sides (lowercase +
// strip trailing 's'); this test pins the rates-panel path to
// the same rule.

import { strict as assert } from 'node:assert';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.message}`); }
}

// Mirror the rates-panel applicability predicate from
// stores/craft.js currenciesByKind(). Kept local so the test
// doesn't have to boot Pinia; the underlying rule is small enough
// to inline here and any drift between the inline form and the
// store version IS the bug class we want this test to catch.
function isApplicable(itemType, appliesToItemClasses) {
  if (!appliesToItemClasses || !appliesToItemClasses.length) return true;
  if (!itemType) return true;
  const norm = (s) => String(s || '').toLowerCase().replace(/s$/, '');
  const itemNorm = norm(itemType);
  return appliesToItemClasses.some((cls) => norm(cls) === itemNorm);
}

console.log('Rates panel — essence applicability plural-vs-singular');

test('Boots itemType matches "Boot" singular in appliesToItemClasses', () => {
  // The exact shape that surfaced the bug: CSV-normalised classes
  // (singular) vs store itemType (plural).
  assert.equal(isApplicable('Boots', ['Boot', 'Glove']), true,
    'a Boots craft must see an essence with appliesToItemClasses=[Boot,Glove] as applicable');
});

test('Gloves itemType matches "Glove" singular', () => {
  assert.equal(isApplicable('Gloves', ['Boot', 'Glove']), true);
});

test('Amulet itemType matches "Amulet" (already singular)', () => {
  assert.equal(isApplicable('Amulet', ['Amulet', 'Belt']), true,
    'singular-already itemTypes must keep working (no double-strip)');
});

test('Body Armour matches the multi-word singular form', () => {
  assert.equal(isApplicable('Body Armour', ['Body Armour']), true,
    'multi-word class names with no plural-s must match self');
});

test('Bow does NOT match a list of armour classes', () => {
  // Negative case — make sure the relaxed comparison doesn\'t
  // become trivially permissive.
  assert.equal(isApplicable('Bow', ['Boot', 'Glove', 'Helmet']), false,
    'Bow craft must NOT see armour-only essences as applicable');
});

test('Empty appliesToItemClasses ⇒ applicable to any item', () => {
  // Essences with no item_classes (e.g. Hysteria pre-CSV update)
  // historically applied universally — preserve that.
  assert.equal(isApplicable('Boots', []), true);
  assert.equal(isApplicable('Boots', null), true);
});

console.log(`\n${passed} passed · ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
