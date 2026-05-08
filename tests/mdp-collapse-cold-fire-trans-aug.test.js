// Focused repro: cold + fire interchangeable wished mods, restricted
// to transmute + augment so the chain is small enough to fully audit.
// User-claim (2026-05-08): cold-only and fire-only states still
// render as separate nodes in their live craft despite the wishlist
// equivalence-class console output showing (MERGES).
//
// This test pins the expected behaviour: after collapse, no chain
// state should have a label containing exactly one of "cold" or "fire"
// without the other — they must merge into a single rep (whose label
// is either "cold | fire" via the merge-rewriter, or one of the names
// inherited by the rep).

import { strict as assert } from 'node:assert';
import { solveMDP } from '../engine/mdp/solve.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.message}`); }
}

console.log('Cold/fire collapse — transmute + augment only');

// Restricted-action fixture: only transmute and augment are cheap
// enough to use; everything else priced out via budgetEx so it stays
// a small chain (start → magic-1 → magic-2).
const trAugInput = {
  wishlist: [
    { key: 'SUFFIX:cold_res', weight: 7000, type: 'SUFFIX', requiredTier: 3, required: true },
    { key: 'SUFFIX:fire_res', weight: 7000, type: 'SUFFIX', requiredTier: 3, required: true },
  ],
  irrelevantWeight: 30000,
  irrelevantWeightBySide: { PREFIX: 15000, SUFFIX: 15000 },
  target: { requiredMods: ['SUFFIX:cold_res', 'SUFFIX:fire_res'], minFilled: 2, maxFilled: 5 },
  start: { rarity: 'normal' },
  basePriceEx: 1,
  alchemyDraws: 4,
  maxFilled: 5,
  timeWeightExPerSec: 0,
  // Tight per-action cap: only the cheapest orbs survive, restricting
  // the chain to transmute + augment paths. Pricing the others above
  // budget excludes them via the engine's per-action budget gate.
  budgetEx: 0.05,
  orbCosts: {
    transmute: 0.001, augment: 0.002,
    regal: 100, alch: 100, exalt: 100, annul: 100, fracturing: 100, chaos: 100,
  },
  orbTimes: { transmute: 1, augment: 1, regal: 1, alch: 1, exalt: 1, annul: 1, fracturing: 3, chaos: 1 },
};

test('no chain state has a cold-only label without a corresponding fire-only equivalent merging into the same rep', () => {
  const result = solveMDP(trAugInput);
  const states = result.chain.states;
  // First — verify the equiv-class diagnostic shows MERGES (sanity).
  const eqEntries = result.chain.diagnostics?.wishedEquivClasses ?? [];
  const classes = new Map();
  for (const e of eqEntries) {
    if (!classes.has(e.equivClass)) classes.set(e.equivClass, []);
    classes.get(e.equivClass).push(e.key);
  }
  const merged = [...classes.values()].find((arr) => arr.length > 1);
  assert.ok(merged, `expected wishlist to have an equiv class with >1 member; got ${JSON.stringify([...classes.entries()])}`);
  // Now the actual claim: NO state should have a label that mentions
  // only one of cold_res / fire_res without merging. Either the label
  // is the joined "cold_res | fire_res" form (merge-rewriter applied),
  // or it mentions just one name as the rep's inherited identity (in
  // which case there should not be ANOTHER state mentioning only the
  // OTHER name — i.e. cold-only and fire-only must not coexist).
  const coldOnly = states.filter((s) => /\bcold_res\b/.test(s.label) && !/\bfire_res\b/.test(s.label));
  const fireOnly = states.filter((s) => /\bfire_res\b/.test(s.label) && !/\bcold_res\b/.test(s.label));
  // For every cold-only state, there should be NO corresponding fire-
  // only state with the same canonical (mod-name-replaced) label.
  // If there is, those two states are mirrors that failed to merge.
  const canonicaliseModNames = (lbl) => lbl
    .replace(/\bcold_res\b/g, 'wished')
    .replace(/\bfire_res\b/g, 'wished')
    .replace(/^\[s\d+\]\s*/m, '')
    .replace(/V\*=[^\n]*/g, '')
    .replace(/fromBudget=[^\n]*/g, '')
    .replace(/fromBase=[^\n]*/g, '')
    .replace(/P_reach=[^\n]*/g, '')
    .replace(/visits=[^\n]*/g, '')
    .replace(/^next:[^\n]*/gm, '')
    .replace(/\n+/g, '\n')
    .trim();
  const coldCanons = new Set(coldOnly.map((s) => canonicaliseModNames(s.label) + '|' + (s.meta?.policy ?? '-')));
  const collisions = fireOnly.filter((s) => coldCanons.has(canonicaliseModNames(s.label) + '|' + (s.meta?.policy ?? '-')));
  if (collisions.length > 0) {
    const sample = collisions.slice(0, 3).map((s) => `id=${s.id} kind=${s.kind} policy=${s.meta?.policy} label=${JSON.stringify(s.label)}`).join('\n  ');
    assert.fail(
      `expected cold-only and fire-only states to merge — found ${collisions.length} fire-only state(s) ` +
      `whose canonical label + policy matches a cold-only state:\n  ${sample}\n\n` +
      `Cold-only states:\n  ` +
      coldOnly.slice(0, 5).map((s) => `id=${s.id} label=${JSON.stringify(s.label)}`).join('\n  '),
    );
  }
});

test('full-orb fixture (mimics user live craft) also merges cold/fire', () => {
  // The transmute+augment-only fixture above is a tight repro. The
  // user reports cold/fire still split in their LIVE craft which has
  // all orbs available. Reproduce that scope here so we either catch
  // the live bug or rule out fixture-specific differences.
  const liveLike = {
    wishlist: [
      {
        key: 'SUFFIX:cold_res', weight: 7000, type: 'SUFFIX',
        requiredTier: 3, required: true,
        // Per-tier scores from the user's URL.
        tierScores: { 1:1, 2:1, 3:1, 4:1, 5:1, 6:1, 7:1, 8:1 },
        // Tier table from mods.json (Cold Resistance on Amulet).
        tiers: [
          { tier:1, weight:1000, ilvl:82 },{ tier:2, weight:1000, ilvl:71 },
          { tier:3, weight:1000, ilvl:60 },{ tier:4, weight:1000, ilvl:50 },
          { tier:5, weight:1000, ilvl:38 },{ tier:6, weight:1000, ilvl:26 },
          { tier:7, weight:1000, ilvl:14 },{ tier:8, weight:1000, ilvl:1 },
        ],
      },
      {
        key: 'SUFFIX:fire_res', weight: 7000, type: 'SUFFIX',
        requiredTier: 3, required: true,
        tierScores: { 1:1, 2:1, 3:1, 4:1, 5:1, 6:1, 7:1, 8:1 },
        // Fire Resistance T4=ilvl48 vs Cold T4=ilvl50 — user's data.
        tiers: [
          { tier:1, weight:1000, ilvl:82 },{ tier:2, weight:1000, ilvl:71 },
          { tier:3, weight:1000, ilvl:60 },{ tier:4, weight:1000, ilvl:48 },
          { tier:5, weight:1000, ilvl:36 },{ tier:6, weight:1000, ilvl:24 },
          { tier:7, weight:1000, ilvl:12 },{ tier:8, weight:1000, ilvl:1 },
        ],
      },
    ],
    irrelevantWeight: 30000,
    irrelevantWeightBySide: { PREFIX: 15000, SUFFIX: 15000 },
    target: {
      requiredMods: ['SUFFIX:cold_res', 'SUFFIX:fire_res'],
      minFilled: 2,
      maxFilled: 5,
    },
    start: { rarity: 'normal' },
    basePriceEx: 100,
    alchemyDraws: 4,
    maxFilled: 5,
    itemLevel: 72,
    timeWeightExPerSec: 0.1,
    budgetEx: 1630,
    orbCosts: {
      transmute: 0.01, augment: 0.05, regal: 0.5, alch: 1, exalt: 1,
      annul: 9.5, fracturing: 50, chaos: 5,
    },
    orbTimes: { transmute: 1, augment: 1, regal: 1, alch: 1, exalt: 1, annul: 1, fracturing: 3, chaos: 1 },
  };
  const result = solveMDP(liveLike);
  const states = result.chain.states;
  const canonicaliseModNames = (lbl) => lbl
    .replace(/\bcold_res\b/g, 'wished')
    .replace(/\bfire_res\b/g, 'wished')
    .replace(/^\[s\d+\]\s*/m, '')
    .replace(/V\*=[^\n]*/g, '')
    .replace(/fromBudget=[^\n]*/g, '')
    .replace(/fromBase=[^\n]*/g, '')
    .replace(/P_reach=[^\n]*/g, '')
    .replace(/visits=[^\n]*/g, '')
    .replace(/^next:[^\n]*/gm, '')
    .replace(/\n+/g, '\n')
    .trim();
  const coldOnly = states.filter((s) => /\bcold_res\b/.test(s.label) && !/\bfire_res\b/.test(s.label));
  const fireOnly = states.filter((s) => /\bfire_res\b/.test(s.label) && !/\bcold_res\b/.test(s.label));
  const coldCanons = new Map();
  for (const s of coldOnly) {
    coldCanons.set(canonicaliseModNames(s.label) + '|' + (s.meta?.policy ?? '-'), s);
  }
  const collisions = [];
  for (const s of fireOnly) {
    const k = canonicaliseModNames(s.label) + '|' + (s.meta?.policy ?? '-');
    if (coldCanons.has(k)) {
      collisions.push({ cold: coldCanons.get(k), fire: s });
    }
  }
  if (collisions.length > 0) {
    const sample = collisions.slice(0, 3).map(({ cold, fire }) =>
      `\n  cold ${cold.id} (policy=${cold.meta?.policy}, kind=${cold.kind}): ${JSON.stringify(cold.label)}` +
      `\n  fire ${fire.id} (policy=${fire.meta?.policy}, kind=${fire.kind}): ${JSON.stringify(fire.label)}`,
    ).join('\n');
    assert.fail(
      `live-like fixture: cold-only and fire-only states with the SAME canonical-label + policy still appear separately. ` +
      `Found ${collisions.length} mirror pairs:` + sample,
    );
  }
});

console.log(`\n${passed} passed · ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
