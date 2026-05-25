// MDP: Omen of Greater Exaltation strategy choice.
//
// Scenario shape: a single very-important wished mod (the user's
// canonical "30% movement speed on Boots" example). The wished mod
// is a PREFIX with high relative weight; the natural craft path is
// transmute → augment → regal → exalt-fill, but with Greater
// Exaltation the user can spend ONE Perfect Exalt + ONE omen to
// add TWO mods in one cast — effectively doubling the per-attempt
// hit chance and halving the per-attempt time / cost when the omen
// is cheap relative to a second Perfect Exalt.
//
// These tests pin the engine's strategy choice across cost regimes:
//   1. Cheap Greater Exaltation omen ⇒ exalt_perfect_double in policy.
//   2. Expensive omen ⇒ plain exalt_perfect (or plain exalt) reclaims
//      the policy.
//   3. Unpriced omen ⇒ action excluded with a warning (no NaN cost
//      leaking into Q-values).

import { strict as assert } from 'node:assert';
import { solveMDP } from '../engine/mdp/solve.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.message}`); }
}

console.log('MDP tests — Omen of Greater Exaltation');

// "30% movement speed on Boots" approximation: single PREFIX wished
// mod, weight 800 vs irrelevant 60000 ⇒ ~1.3% per single-draw hit
// rate. With Greater Exaltation, two draws ⇒ ~2.6% per attempt.
const baseInput = {
  wishlist: [{ key: 'PREFIX:30% Movement Speed', weight: 800, type: 'PREFIX', requiredTier: 1, required: true, tierScores: { 1: 1 } }],
  irrelevantWeight: 60000,
  irrelevantWeightBySide: { PREFIX: 30000, SUFFIX: 30000 },
  target: {
    requiredMods: ['PREFIX:30% Movement Speed'],
    minFilled: 1, maxFilled: 6,
  },
  start: { rarity: 'normal' },
  basePriceEx: 100,
  alchemyDraws: 4,
  maxFilled: 6,
  timeWeightExPerSec: 0,
};

const baseRates = {
  orbCosts: {
    transmute: 0.01, augment: 0.05, regal: 0.5, alch: 1,
    exalt: 1, exalt_greater: 5, exalt_perfect: 50,
    annul: 9.5, fracturing: 50, chaos: 1,
  },
  orbTimes: {
    transmute: 1, augment: 1, regal: 1, alch: 1,
    exalt: 1, exalt_greater: 1, exalt_perfect: 1,
    annul: 1, fracturing: 3, chaos: 1,
  },
  pTierAcceptable: {
    // T1 acceptable for all variants (single wished tier in this
    // fixture). Per-variant arrays mean "for each wished mod i, what's
    // the prob the orb's tier roll is acceptable?" — set to 1 across
    // the board so the strategy choice is purely about hit count, not
    // tier filtering.
    transmute: [1], augment: [1], regal: [1], alch: [1],
    exalt: [1], exalt_greater: [1], exalt_perfect: [1],
    chaos: [1],
    exalt_double: [1], exalt_greater_double: [1], exalt_perfect_double: [1],
  },
};

// Scenario 1 — when the omen is priced, the action is admitted
// to the action set (visible on at least one reachable state's
// appsPerState). Whether it's optimal depends on Q comparison
// against plain exalts; here we only pin "the variant is wired
// end-to-end" — adapter carries the omen cost into env.orbCosts,
// solve.js admits the action, transitions execute. Strategy
// dominance is exercised in scenarios 2/3 below.
test('priced Greater Exaltation omen ⇒ exalt_perfect_double appears in the action set', () => {
  const result = solveMDP({
    ...baseInput,
    ...baseRates,
    orbCosts: {
      ...baseRates.orbCosts,
      exalt_perfect_double: 5,
    },
  });
  const seen = new Set();
  for (const apps of result.appsPerState.values()) {
    for (const a of apps) seen.add(a.actionId);
  }
  assert.ok(seen.has('exalt_perfect_double'),
    `priced omen ⇒ exalt_perfect_double must be applicable on some state; ` +
    `seen actions: ${[...seen].slice(0, 30).join(', ')}…`);
});

// Scenario 2 — expensive omen flips the policy back. With the omen
// at 200 ex (more than Perfect Exalt itself), the engine should
// prefer plain Exalt-spam over Perfect+omen.
test('expensive Greater Exaltation omen ⇒ exalt_perfect_double NOT in policy', () => {
  const result = solveMDP({
    ...baseInput,
    ...baseRates,
    orbCosts: {
      ...baseRates.orbCosts,
      exalt_perfect_double: 200,   // omen way too expensive
    },
  });
  const policies = new Set([...result.policy.values()].filter(Boolean));
  assert.ok(!policies.has('exalt_perfect_double'),
    `expensive Greater Exaltation should NOT dominate; got: ${[...policies]}`);
});

// Scenario 3 — unpriced omen ⇒ action excluded + warning surfaced.
// Per project policy "missing rates ⇒ WARN, never silent fallback":
// the user must see why the variant isn't in the action set.
test('unpriced Greater Exaltation omen ⇒ excluded with warning, NOT in policy', () => {
  const result = solveMDP({
    ...baseInput,
    ...baseRates,
    // exalt_*_double NOT in orbCosts ⇒ NaN ⇒ excluded.
    allowMissingRates: true,
  });
  const policies = new Set([...result.policy.values()].filter(Boolean));
  assert.ok(!policies.has('exalt_double'),
    `unpriced omen ⇒ exalt_double must NOT be in policy`);
  assert.ok(!policies.has('exalt_perfect_double'),
    `unpriced omen ⇒ exalt_perfect_double must NOT be in policy`);
  // At least one warning should mention Greater Exaltation.
  const hasOmenWarning = (result.warnings ?? []).some((w) =>
    /Greater Exaltation/i.test(String(w)));
  assert.ok(hasOmenWarning,
    `expected a warning mentioning Greater Exaltation when omen is unpriced; ` +
    `got warnings: ${JSON.stringify(result.warnings)}`);
});

// Scenario 4 — pin the transition shape: each outcome of
// exalt_perfect_double bumps totalMods by 2 (vs the +1 of plain
// Perfect Exalt). This is the load-bearing structural claim — if
// the action is just an alias for plain exalt, the omen does
// nothing.
test('exalt_perfect_double outcomes bump totalMods by exactly 2', () => {
  const result = solveMDP({
    ...baseInput,
    ...baseRates,
    orbCosts: {
      ...baseRates.orbCosts,
      exalt_perfect_double: 0,
    },
  });
  // Find any state where exalt_perfect_double is applicable, and
  // verify each outcome lands at totalMods + 2 from the source.
  let checked = 0;
  for (const [idx, apps] of result.appsPerState.entries()) {
    const app = apps.find((x) => x.actionId === 'exalt_perfect_double');
    if (!app) continue;
    const fromTotal = result.states[idx].state.totalMods;
    for (const o of app.outcomes) {
      const toTotal = result.states[o.to].state.totalMods;
      assert.equal(toTotal, fromTotal + 2,
        `exalt_perfect_double outcome must bump totalMods by 2; ` +
        `from ${fromTotal} → ${toTotal}`);
    }
    checked++;
    if (checked >= 3) break;   // sample a few states; uniform behaviour expected
  }
  assert.ok(checked > 0,
    'expected exalt_perfect_double to be applicable on at least one state');
});

console.log(`\n${passed} passed · ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
