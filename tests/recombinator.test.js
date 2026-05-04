// Recombinator strategy — closed-form. Pins the Butsicles formula
// against the Reddit guide's spear example numbers.
//
// Source: https://www.reddit.com/r/PathOfExile2/comments/1jzu2py/
//   poe_2_patch_020_guide_to_recombinators_part_1/
//
// Two-mod EI formula:
//   RS = SC(mod_A) + SC(mod_B), each SC capped at 50%.
//   SC(mod) = min(50, A_scale · Σ tier_weight(t ≤ chosen, t ≤ ilvl)
//                                  / total_pool_weight_same_side).

import { strict as assert } from 'node:assert';
import { recombinator } from '../engine/strategies.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.message}`); }
}

console.log('Recombinator (closed-form) tests');

// Synthetic ctx: two prefix wished mods on a base with a small,
// known total prefix-pool weight. Tunable to hit specific SC values.
function makeCtx(opts = {}) {
  const wishlist = opts.wishlist ?? [
    { key: 'PREFIX:wishA', weight: 200, type: 'PREFIX', requiredTier: 1 },
    { key: 'PREFIX:wishB', weight: 200, type: 'PREFIX', requiredTier: 1 },
  ];
  // For SC computation, fullPool entries need `tiers` arrays with
  // per-tier weights. The strategy sums tiers ≤ chosen-tier.
  const fullPool = wishlist.map((w) => ({
    key: w.key, type: w.type, weight: w.weight,
    tiers: opts.tiers ?? [{ tier: 1, weight: 200, ilvl: 80 }],
  }));
  // Pool floor — total prefix pool weight across all mods (incl.
  // irrelevant). 100k is a typical pool size.
  // Pad with a synthetic irrelevant entry so SC is computable.
  fullPool.push({
    key: 'PREFIX:irrelevant', type: 'PREFIX',
    weight: opts.irrelevantWeight ?? 99_600,
    tiers: [],
  });
  return {
    wishlist,
    fullPool,
    basePriceEx: opts.basePriceEx ?? 5,
    recombinatorInputCostEx: opts.recombinatorInputCostEx,
    recombinatorArtifactCostEx: opts.recombinatorArtifactCostEx,
    orbs: { recombinator: { timeSeconds: 5 } },
    ...opts.ctxOverrides,
  };
}

test('two-mod combine on equal-weight prefixes ⇒ symmetric SC contributions', () => {
  // Both mods have weight 200, total pool 100,000. Per-mod SC:
  //   SC = min(50, A_scale · 200 / 100_000) = min(50, 500_000 · 0.002)
  //      = min(50, 1000) = 50%.
  // (At these large A_scale values almost any reasonable mod hits
  // the cap. Real PoE2 weights have wider spread; this just sanity-
  // checks the cap path.)
  const ctx = makeCtx({});
  const recomb = recombinator(ctx);
  
  assert.ok(recomb, 'recombinator strategy must be present');
  assert.ok(recomb.available, `expected available; got: ${JSON.stringify(recomb)}`);
  // Two mods, each capped at 50% ⇒ RS = 100% ⇒ pSuccess = 1.
  assert.equal(recomb.p, 1, `expected pSuccess=1 (both mods at SC cap); got ${recomb.p}`);
});

test('rare top-tier mod with tiny weight ⇒ SC well below 50%', () => {
  // weight=1 in a 100k pool: SC = 500_000 · 1 / 100_000 = 5%.
  // With another mod at SC=50% (cap), RS = 55%.
  const ctx = makeCtx({
    wishlist: [
      { key: 'PREFIX:wishA', weight: 1, type: 'PREFIX', requiredTier: 1 },
      { key: 'PREFIX:wishB', weight: 200, type: 'PREFIX', requiredTier: 1 },
    ],
    irrelevantWeight: 99_799,
  });
  // Override tiers per mod individually.
  ctx.fullPool = [
    { key: 'PREFIX:wishA', type: 'PREFIX', weight: 1,
      tiers: [{ tier: 1, weight: 1, ilvl: 80 }] },
    { key: 'PREFIX:wishB', type: 'PREFIX', weight: 200,
      tiers: [{ tier: 1, weight: 200, ilvl: 80 }] },
    { key: 'PREFIX:irrelevant', type: 'PREFIX', weight: 99_799, tiers: [] },
  ];
  const recomb = recombinator(ctx);
  
  // SC_A = 500_000 · 1 / 100_000 = 5%
  // SC_B = capped at 50%
  // RS = 55%
  assert.ok(Math.abs(recomb.p - 0.55) < 1e-3,
    `expected pSuccess ≈ 0.55 (5% + 50%); got ${recomb.p}`);
});

test('expectedAttempts = 1 / RS (geometric retry)', () => {
  // RS = 50% ⇒ expectedAttempts = 2.
  const ctx = makeCtx({
    wishlist: [{ key: 'PREFIX:wishA', weight: 200, type: 'PREFIX', requiredTier: 1 }],
    irrelevantWeight: 99_800,
  });
  ctx.fullPool = [
    { key: 'PREFIX:wishA', type: 'PREFIX', weight: 200,
      tiers: [{ tier: 1, weight: 200, ilvl: 80 }] },
    { key: 'PREFIX:irrelevant', type: 'PREFIX', weight: 99_800, tiers: [] },
  ];
  const recomb = recombinator(ctx);
  
  assert.ok(Math.abs(recomb.expectedAttempts - (1 / recomb.p)) < 1e-6,
    `expectedAttempts should be 1/p; got ${recomb.expectedAttempts} vs 1/${recomb.p}`);
});

test('per-attempt cost = inputCost + artifactCost (geometric over attempts)', () => {
  // 2 mods, RS=100% (both at cap), per-attempt = 100 ex (input) + 1 ex (artifact).
  // expected cost = 101 ex × 1 = 101 ex.
  const ctx = makeCtx({
    recombinatorInputCostEx: 100,
    recombinatorArtifactCostEx: 1,
  });
  const recomb = recombinator(ctx);
  
  assert.ok(Math.abs(recomb.expectedCostEx - 101) < 1e-6,
    `expected cost = 101 ex (input + artifact, single attempt); got ${recomb.expectedCostEx}`);
});

test('empty wishlist ⇒ recombinator unavailable', () => {
  const ctx = { wishlist: [], fullPool: [] };
  const recomb = recombinator(ctx);
  
  assert.ok(recomb, 'recombinator must still appear in results');
  assert.equal(recomb.available, false,
    `expected unavailable on empty wishlist; got: ${JSON.stringify(recomb)}`);
});

console.log(`\n${passed} passed · ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
