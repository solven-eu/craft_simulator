// Regression: every essence with side=UNKNOWN in essences.csv must have
// a curated entry in essence_side_overrides.json (keyed by target_affix
// or by a #-stripped alias). When a new essence is scraped that the
// auto-resolver can't classify, the user is forced to add an override
// rather than silently shipping UNKNOWN — which the UI cannot render
// (Mark of the Abyssal Lord regressed exactly like this).
//
// Scope-limited: only fails for essence tiers/families we *expect* to
// classify (Perfect, plus ABYSS-tagged ones). Lesser/Greater elemental
// essences of Abrasion/Flames/etc. roll across many bases/sides and
// remain UNKNOWN by design.

import { strict as assert } from 'node:assert';
import fs from 'node:fs';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.message}`); }
}

console.log('Data — essence side resolution');

function parseCSV(text) {
  const rows = []; let row = []; let cur = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += c;
    } else {
      if (c === '"') q = true;
      else if (c === ',') { row.push(cur); cur = ''; }
      else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
      else cur += c;
    }
  }
  if (cur.length || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

function stripRanges(s) {
  return s.replace(/\(\s*[\d.]+\s*[—\-–]\s*[\d.]+\s*\)/g, '#').trim();
}

const csv = parseCSV(fs.readFileSync('data/poe2/essences.csv', 'utf8'));
const header = csv[0];
const iName = header.indexOf('name');
const iSide = header.indexOf('side');
const iTarget = header.indexOf('target_affix');
const dataRows = csv.slice(1).filter((r) => r.length > 1 && r[iName]);

const overridesJson = JSON.parse(
  fs.readFileSync('data/poe2/essence_side_overrides.json', 'utf8'),
);
const overrideKeys = new Set(Object.keys(overridesJson.overrides || {}));
const overrideKeysStripped = new Set(
  [...overrideKeys].map(stripRanges),
);

test('Mark of the Abyssal Lord essence (Essence of the Abyss) is classified ABYSS', () => {
  const row = dataRows.find((r) => r[iName] === 'Essence of the Abyss');
  assert.ok(row, 'Essence of the Abyss should be present in essences.csv');
  assert.equal(row[iSide], 'ABYSS',
    `Essence of the Abyss should be ABYSS (got ${row[iSide]}). ` +
    'Symptom: full-width "Mark of the Abyssal Lord" row disappears from the UI.');
});

test('every Perfect essence has a non-UNKNOWN side OR a curated override', () => {
  const orphans = [];
  for (const r of dataRows) {
    const name = r[iName];
    const side = r[iSide];
    const target = r[iTarget];
    if (!name.startsWith('Perfect Essence')) continue;
    if (side && side !== 'UNKNOWN') continue;
    // UNKNOWN: must have an override entry (literal or #-aliased).
    const stripped = stripRanges(target);
    if (overrideKeys.has(target) || overrideKeysStripped.has(stripped)) continue;
    orphans.push(`${name} → "${target}"`);
  }
  assert.equal(orphans.length, 0,
    `Perfect essences with UNKNOWN side and no override:\n  ${orphans.join('\n  ')}\n` +
    'Add classifications to data/poe2/essence_side_overrides.json (key = target_affix verbatim) ' +
    'and re-run scripts/update-poe2-essences.sh.');
});

test('every essence with side=ABYSS appears in the override map', () => {
  for (const r of dataRows) {
    if (r[iSide] !== 'ABYSS') continue;
    const target = r[iTarget];
    assert.ok(overrideKeys.has(target),
      `${r[iName]} has side=ABYSS but its target "${target}" is not in essence_side_overrides.json`);
  }
});

test('the Perfect essences flagged previously are now PREFIX/SUFFIX', () => {
  // Ground-truth from user (verified on poe2db / wiki):
  const expected = {
    'Perfect Essence of Enhancement': 'PREFIX',
    'Perfect Essence of the Infinite': 'SUFFIX',
    'Perfect Essence of Ruin': 'PREFIX',
    'Essence of Delirium': 'PREFIX',
    'Essence of Horror': 'SUFFIX',
    'Essence of Insanity': 'SUFFIX',
  };
  for (const [name, want] of Object.entries(expected)) {
    const row = dataRows.find((r) => r[iName] === name);
    assert.ok(row, `${name} should be present in essences.csv`);
    assert.equal(row[iSide], want,
      `${name} should be ${want}, got ${row[iSide]}. ` +
      'If this row is UNKNOWN, the override map probably lost an entry.');
  }
});

// ─────────────────────────────────────────────────────────────────
// Cross-file homogeneity checks: essences.csv (scrape output) +
// extra_mods.json (UI-facing essence pool) + essence_side_overrides.json
// (manual fallback) must agree.
//
// These exist because the UI reads `extra_mods.json`, NOT `essences.csv`,
// and resolves side via a runtime lookup. Drift between the files
// silently surfaces as "N mods with unknown side" in the essence panel.
// ─────────────────────────────────────────────────────────────────

const extraMods = JSON.parse(
  fs.readFileSync('data/poe2/extra_mods.json', 'utf8'),
);
const csvNameSide = new Map();
for (const r of dataRows) {
  if (r[iName]) csvNameSide.set(r[iName], r[iSide]);
}

// Collect every (tier_name, text) pair in extra_mods.json's essence pool.
function* extraEssenceRows() {
  for (const base of Object.keys(extraMods)) {
    const ess = extraMods[base]?.essence || [];
    for (const m of ess) yield { base, ...m };
  }
}

test('every extra_mods.json essence tier_name appears in essences.csv', () => {
  const missing = new Set();
  for (const m of extraEssenceRows()) {
    if (!m.tier_name) continue;
    if (!csvNameSide.has(m.tier_name)) missing.add(m.tier_name);
  }
  assert.equal(missing.size, 0,
    `tier_names present in extra_mods.json but absent from essences.csv:\n  ` +
    [...missing].sort().join('\n  ') +
    '\nThe essence panel will show these without any side context.');
});

test('every essence row in extra_mods.json resolves to a non-UNKNOWN side via the static lookup chain', () => {
  // Mirrors the UI's resolution chain (override → per-mod sides → CSV by name
  // → registry → unknown), but only the static steps — the runtime registry
  // is excluded since it depends on modSideByName loaded by the app. If the
  // static three steps resolve every row, the UI's "N mods with unknown side"
  // panel is empty without needing the registry's loose matching (which has
  // been the source of misclassifications, e.g. Opulence's rarity affix
  // inheriting PREFIX from an unrelated base mod).
  const overridesByText = {};
  for (const [text, info] of Object.entries(overridesJson.overrides || {})) {
    if (info?.side) overridesByText[text] = info.side;
  }
  const modSidesPath = 'data/poe2/essence_mod_sides.json';
  let perModSides = {};
  try {
    perModSides = JSON.parse(fs.readFileSync(modSidesPath, 'utf8')).mod_sides || {};
  } catch {}
  const unresolved = new Set();
  for (const m of extraEssenceRows()) {
    if (!m.tier_name) continue;
    const fromOverride = overridesByText[m.text];
    const fromPerMod = perModSides[m.tier_name]?.[m.text];
    const fromCSV = csvNameSide.get(m.tier_name);
    const side = fromOverride
      || fromPerMod
      || (fromCSV && fromCSV !== 'UNKNOWN' ? fromCSV : null);
    if (!side) unresolved.add(`${m.tier_name} → "${m.text}"`);
  }
  assert.equal(unresolved.size, 0,
    `Essence rows in extra_mods.json with no resolvable side via override+per-mod+CSV:\n  ` +
    [...unresolved].sort().slice(0, 30).join('\n  ') +
    (unresolved.size > 30 ? `\n  …and ${unresolved.size - 30} more` : '') +
    '\nFix by classifying the essence on poe2db (Pre/Suf column) and re-running scripts/update-poe2-essences.sh.');
});

test('Helmet PREFIX-side rarity-of-items must NOT show essence-chip (Opulence is SUFFIX)', () => {
  // Specific scenario from the user-reported bug: Helmet's base mod
  // registry has "% increased Rarity of Items found" as a PREFIX (rare,
  // but it exists on Helmets only — Boots/Amulet/Ring/Glove rarity is
  // SUFFIX-only). The pool-table chip must not light up here, since
  // Opulence is SUFFIX-only and can't guarantee a PREFIX rarity mod.
  const overridesByText = {};
  for (const [text, info] of Object.entries(overridesJson.overrides || {})) {
    if (info?.side) overridesByText[text] = info.side;
  }
  let perModSides = {};
  try {
    perModSides = JSON.parse(
      fs.readFileSync('data/poe2/essence_mod_sides.json', 'utf8'),
    ).mod_sides || {};
  } catch {}
  const sideFor = (e) =>
    overridesByText[e.text]
    || perModSides[e.tier_name]?.[e.text]
    || csvNameSide.get(e.tier_name)
    || null;
  // Mirror essenceableNamesBySide construction.
  const helmetEssences = (extraMods['HELMET (STR)']?.essence
                       || extraMods['HELMET']?.essence
                       || []);
  const prefixSet = new Set(), suffixSet = new Set();
  for (const m of helmetEssences) {
    if (!m.text) continue;
    const side = sideFor(m);
    const target = side === 'PREFIX' ? prefixSet : side === 'SUFFIX' ? suffixSet : null;
    if (target) target.add(m.text);
    // Unknown/null fallback would add to both, but for this test we only
    // care about the SUFFIX leak — so leave the both-fallback alone.
  }
  // The bug: rarity in PREFIX set. Opulence-rolled rarity-of-items must
  // NOT appear on the prefix side.
  const rarityName = '#% increased Rarity of Items found';
  assert.ok(suffixSet.has(rarityName) || helmetEssences.length === 0,
    `Helmet should have rarity essence-chip on the suffix side. Got: ${[...suffixSet].slice(0,5).join(', ')}`);
  assert.ok(!prefixSet.has(rarityName),
    `Helmet PREFIX-side rarity-of-items should NOT have a green essence chip ` +
    `(Opulence is SUFFIX-only). Got: ${[...prefixSet].slice(0,5).join(', ')}`);
});

test('Opulence rarity-of-items must NOT show essence-chip on PREFIX side', () => {
  // Mirror of stores/craft/mod-helpers.js essenceableTiers side-gate logic.
  // Bug: green chip 🟢 was lighting up next to "% increased Rarity of Items
  // found" in PREFIX target rows because essenceableTiers ignored its `type`
  // argument. The fix: filter essence rows by resolved side before testing
  // tier coverage. This test pins the *side filter* itself, not the tier set.
  const overridesByText = {};
  for (const [text, info] of Object.entries(overridesJson.overrides || {})) {
    if (info?.side) overridesByText[text] = info.side;
  }
  let perModSides = {};
  try {
    perModSides = JSON.parse(
      fs.readFileSync('data/poe2/essence_mod_sides.json', 'utf8'),
    ).mod_sides || {};
  } catch {}
  const sideFor = (e) => {
    const ov = overridesByText[e.text];
    if (ov) return ov;
    const pm = perModSides[e.tier_name]?.[e.text];
    if (pm) return pm;
    return csvNameSide.get(e.tier_name) || null;
  };
  // Find every Opulence rarity-of-items row in extra_mods.json.
  const rows = [];
  for (const m of extraEssenceRows()) {
    if (!/Opulence/.test(m.tier_name || '')) continue;
    if (!/Rarity of Items found/.test(m.text || '')) continue;
    rows.push({ ...m, side: sideFor(m) });
  }
  assert.ok(rows.length > 0, 'Opulence rarity-of-items rows should exist in extra_mods.json');
  for (const r of rows) {
    assert.equal(r.side, 'SUFFIX',
      `${r.tier_name} on ${r.base} → "${r.text}" should resolve to SUFFIX, got ${r.side}. ` +
      'If this is PREFIX, the prefix-side essence chip will erroneously light up on PREFIX wishlist rows.');
  }
});

test('Essence of Opulence (rarity-of-items) resolves to SUFFIX on amulets', () => {
  // Regression: this affix is essence-only (no base-pool peer to anchor
  // against), so the base-mod registry's loose matching used to fall
  // through to PREFIX from an unrelated base mod. The CSV fix makes
  // poe2db's own Pre/Suf table authoritative.
  const row = dataRows.find((r) => r[iName] === 'Essence of Opulence');
  assert.ok(row, 'Essence of Opulence must be in essences.csv');
  assert.equal(row[iSide], 'SUFFIX',
    `Essence of Opulence is SUFFIX on poe2db; CSV says ${row[iSide]}.`);
  // Sanity: extra_mods.json should reference this essence on AMULET.
  const amuletEssences = extraMods['AMULET']?.essence || [];
  const opulenceOnAmulet = amuletEssences.find(
    (m) => m.tier_name === 'Essence of Opulence',
  );
  assert.ok(opulenceOnAmulet,
    'Essence of Opulence should appear in AMULET\'s essence pool in extra_mods.json');
});

test('every essence_side_overrides.json key is reachable from extra_mods.json or essences.csv', () => {
  // An override key that nothing references is dead weight — usually a
  // sign of a typo, a stale row, or a key written in the wrong format
  // (e.g. with ranges when the UI passes the #-stripped form).
  const extraTexts = new Set();
  for (const m of extraEssenceRows()) {
    if (m.text) extraTexts.add(m.text);
  }
  const csvTargets = new Set(dataRows.map((r) => r[iTarget]).filter(Boolean));
  const csvTargetsStripped = new Set([...csvTargets].map(stripRanges));
  const orphans = [];
  for (const k of overrideKeys) {
    if (extraTexts.has(k)) continue;
    if (csvTargets.has(k)) continue;
    if (csvTargetsStripped.has(stripRanges(k))) continue;
    orphans.push(k);
  }
  assert.equal(orphans.length, 0,
    `Override keys with no peer in extra_mods.json (text) or essences.csv ` +
    `(target_affix, with or without ranges):\n  ${orphans.join('\n  ')}\n` +
    `These keys cannot be matched at runtime — likely a typo.`);
});

test('CSV side and override side agree where both exist (no contradictions)', () => {
  // For each override entry, find the matching CSV row (by target_affix
  // literal or #-stripped). If both have a non-UNKNOWN side, they must
  // agree; otherwise the override is a silent contradiction.
  const conflicts = [];
  for (const [key, info] of Object.entries(overridesJson.overrides || {})) {
    if (!info?.side) continue;
    const stripped = stripRanges(key);
    for (const r of dataRows) {
      const target = r[iTarget];
      if (target !== key && stripRanges(target) !== stripped) continue;
      const csvSide = r[iSide];
      if (csvSide && csvSide !== 'UNKNOWN' && csvSide !== info.side) {
        conflicts.push(`${r[iName]}: CSV=${csvSide} but override=${info.side} (key="${key}")`);
      }
    }
  }
  assert.equal(conflicts.length, 0,
    `Side disagreements between essences.csv and essence_side_overrides.json:\n  ` +
    conflicts.join('\n  '));
});

console.log(`\n${passed} passed · ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
