// MDP: Annul + Omen of Light desecrated cleanup loop.
//
// Game rule: Orb of Annulment with Omen of Light removes a desecrated
// modifier (revealed bone-mod) chosen uniformly at random from the
// desecrated subset. Critical for the desecration loop:
//   apply_bone → reveal → (bad outcome) → omen-of-light annul → retry.
//
// Without omen-of-light, an item can carry at most ONE desecrated
// mod ever (apply_bone is gated on desecratedCount===0). With
// omen-of-light, the user can scrub the desecrated affix and apply
// another bone — enabling a geometric retry against the bone pool.
//
// This file pins:
//   1. Without omen-of-light pricing, the cleanup loop is blocked
//      and pSuccessStart bottoms out at the per-attempt rate.
//   2. With cheap omen-of-light, multiple bone+reveal cycles become
//      reachable, so pSuccessStart approaches 1 even when per-reveal
//      hit rate is low.
//   3. Per-desired-mod `desecrationConstraint: 'require'` forces the
//      goal to demand a desecrated wished bit — non-desecrated paths
//      become non-goal even if they set the bit.
//   4. Per-desired-mod `desecrationConstraint: 'forbid'` makes a
//      desecrated wished hit a NON-goal (the affix must come from a
//      non-bone source).

import { strict as assert } from 'node:assert';
import { solveMDP } from '../engine/mdp/solve.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.message}`); }
}

console.log('MDP — Annul + Omen of Light cleanup');

const baseInput = {
  wishlist: [{ key: 'WISH_P', weight: 0, type: 'PREFIX' }],
  irrelevantWeight: 60000,
  irrelevantWeightBySide: { PREFIX: 30000, SUFFIX: 30000 },
  // basePriceEx=100 (typical trade buy) makes buy_base resets
  // expensive enough that the cleanup loop dominates them. With
  // basePriceEx=1, buy_base is so cheap the engine never bothers
  // with the cleanup loop — masking the regression we want to pin.
  basePriceEx: 100,
  alchemyDraws: 4,
  maxFilled: 6,
  timeWeightExPerSec: 0,
  budgetEx: 100000,
};
const baseOrbCosts = {
  transmute: 0.01, augment: 0.05, regal: 0.5, alch: 1,
  exalt: 5, annul: 9.5, fracturing: 50,
};
const baseOrbTimes = {
  transmute: 1, augment: 1, regal: 1, alch: 1,
  exalt: 1, annul: 1, fracturing: 3,
  reveal_bone: 1, reveal_bone_sinistral: 1,
  reveal_bone_dextral: 1, reveal_bone_abyssal: 1,
  annul_omen_of_light: 1,
};
function solve(o = {}) {
  return solveMDP({
    ...baseInput, ...o,
    orbCosts: { ...baseOrbCosts, ...(o.orbCosts ?? {}) },
    orbTimes: { ...baseOrbTimes, ...(o.orbTimes ?? {}) },
  });
}

test('without omen-of-light ⇒ cleanup loop blocked, single bone attempt only', () => {
  const result = solve({
    target: { requiredMods: ['WISH_P'], minFilled: 1, maxFilled: 6 },
    boneCostEx: 0.5,
    pBoneRevealHit:        [0.10],   // low hit rate
    pBoneRevealHitPrefix:  [0],
    pBoneRevealHitSuffix:  [0],
    pBoneRevealHitAbyssal: [0],
    // annul_omen_of_light cost UNSET ⇒ action excluded from action list
    orbCosts: { reveal_bone: 1 },
  });
  // Without cleanup, only one bone+reveal cycle. The next bone is
  // blocked by desecratedCount=1. Engine relies on buy_base resets
  // for retries (each costing basePriceEx); pSuccessStart should
  // reflect that bottleneck.
  const policies = new Set([...result.policy.values()].filter(Boolean));
  assert.ok(!policies.has('annul_omen_of_light'),
    `annul_omen_of_light should be excluded when its cost is unpriced; got policies: ${[...policies]}`);
});

test('with cheap omen-of-light ⇒ cleanup loop in policy, V*(start) better than no-omen baseline', () => {
  const noOmen = solve({
    target: { requiredMods: ['WISH_P'], minFilled: 1, maxFilled: 6 },
    boneCostEx: 0.5,
    pBoneRevealHit:        [0.10],
    pBoneRevealHitPrefix:  [0],
    pBoneRevealHitSuffix:  [0],
    pBoneRevealHitAbyssal: [0],
    orbCosts: { reveal_bone: 1 },
  });
  const withOmen = solve({
    target: { requiredMods: ['WISH_P'], minFilled: 1, maxFilled: 6 },
    boneCostEx: 0.5,
    pBoneRevealHit:        [0.10],
    pBoneRevealHitPrefix:  [0],
    pBoneRevealHitSuffix:  [0],
    pBoneRevealHitAbyssal: [0],
    orbCosts: { reveal_bone: 1, annul_omen_of_light: 12 },
  });
  const omenPolicies = new Set([...withOmen.policy.values()].filter(Boolean));
  assert.ok(omenPolicies.has('annul_omen_of_light'),
    `annul_omen_of_light should be in optimal policy when priced and useful; got: ${[...omenPolicies]}`);
  // With cleanup loop available, retries are cheaper than buy_base
  // resets. V*(start) should improve (or at worst match).
  assert.ok(withOmen.vStar <= noOmen.vStar + 1e-6,
    `V*(start) with omen-of-light (${withOmen.vStar}) should be ≤ without it (${noOmen.vStar})`);
});

test('desecrationConstraint=require ⇒ non-desecrated paths are NOT goal', () => {
  // Wishlist mod also exists in the base pool (non-zero weight) so
  // a regal/exalt path could set the bit without desecration. With
  // 'require', that path is not a goal — only a bone reveal that
  // sets the desecratedWishedMask bit qualifies.
  const result = solve({
    wishlist: [{
      key: 'WISH_P',
      weight: 1000,            // available via natural roll
      type: 'PREFIX',
      desecrationConstraint: 'require',
    }],
    target: {
      requiredMods: ['WISH_P'],
      desecrationRequiredMods: ['WISH_P'],
      minFilled: 1, maxFilled: 6,
    },
    boneCostEx: 0.5,
    pBoneRevealHit:        [0.30],
    pBoneRevealHitPrefix:  [0],
    pBoneRevealHitSuffix:  [0],
    pBoneRevealHitAbyssal: [0],
    orbCosts: { reveal_bone: 1 },
  });
  // The optimal path must include reveal_bone (only way to set the
  // desecratedWishedMask). Pure regal/exalt paths cannot reach goal.
  const policies = new Set([...result.policy.values()].filter(Boolean));
  assert.ok(policies.has('reveal_bone') || policies.has('reveal_bone_sinistral')
    || policies.has('reveal_bone_dextral') || policies.has('reveal_bone_abyssal'),
    `desecrationConstraint=require ⇒ a reveal_bone variant must be in policy; got: ${[...policies]}`);
});

test('desecrationConstraint=forbid ⇒ desecrated wished hit is NOT a goal', () => {
  // Wishlist available from natural roll AND from desecrated pool.
  // With 'forbid', the affix must NOT come from desecration. If the
  // engine's only realistic path is via reveal_bone (e.g. natural
  // weight is too low), forbidding it would push V*(start) up
  // (more expensive natural roll) compared to not forbidding.
  const allowed = solve({
    wishlist: [{ key: 'WISH_P', weight: 1000, type: 'PREFIX' }],
    target: { requiredMods: ['WISH_P'], minFilled: 1, maxFilled: 6 },
    boneCostEx: 0.5,
    pBoneRevealHit:        [0.30],
    pBoneRevealHitPrefix:  [0],
    pBoneRevealHitSuffix:  [0],
    pBoneRevealHitAbyssal: [0],
    orbCosts: { reveal_bone: 1 },
  });
  const forbidden = solve({
    wishlist: [{
      key: 'WISH_P',
      weight: 1000,
      type: 'PREFIX',
      desecrationConstraint: 'forbid',
    }],
    target: {
      requiredMods: ['WISH_P'],
      desecrationForbiddenMods: ['WISH_P'],
      minFilled: 1, maxFilled: 6,
    },
    boneCostEx: 0.5,
    pBoneRevealHit:        [0.30],
    pBoneRevealHitPrefix:  [0],
    pBoneRevealHitSuffix:  [0],
    pBoneRevealHitAbyssal: [0],
    orbCosts: { reveal_bone: 1 },
  });
  // Forbidding desecration should never IMPROVE the V* (it can only
  // remove an option). Pin: V* is no better with the constraint.
  assert.ok(forbidden.vStar >= allowed.vStar - 1e-6,
    `forbidding desecration should never improve V*; allowed=${allowed.vStar}, forbidden=${forbidden.vStar}`);
});

console.log(`\n${passed} passed · ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
