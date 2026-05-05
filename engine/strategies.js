// Crafting strategies — each one is a closed-form recipe that, given the
// current state and pool, computes per-strategy:
//   { p, expectedAttempts, expectedCostEx, expectedTimeSec, notes }
//
// All strategies are analytical (no Monte Carlo). The chaos-spam strategy
// uses a small Markov chain over the wished-count state and solves for
// expected hitting time exactly via Gauss–Jordan.

import { pHitWishlist, pHitWishlistUnified, geometricCost } from './wishlist.js';
import { transitionMatrix, expectedHittingTime, solveLinear } from './evaluator.js';
import { orbCostEx } from './strategy-utils.js';
import { chaosSpam } from './strategies/chaos-spam.js';
import { resetToWhite } from './strategies/reset-to-white.js';
import { geometricChain } from './strategies/chain.js';
import {
  exaltAnnulCycle,
  greaterExaltAnnulCycle,
  perfectExaltAnnulCycle,
} from './strategies/exalt-annul-cycle.js';

/**
 * @typedef {Object} StratResult
 * @property {string} id
 * @property {string} label
 * @property {boolean} available
 * @property {number} [p]                   probability per "attempt unit"
 * @property {number} [expectedAttempts]
 * @property {number} [expectedCostEx]
 * @property {number} [expectedTimeSec]
 * @property {string} [notes]
 */

/**
 * @typedef {Object} StratContext
 * @property {{ key: string, type: 'PREFIX'|'SUFFIX', weight: number }[]} fullPool
 *            Eligible pool for this base+ilvl, NOT conditioned on starting item.
 * @property {{ key: string, type: 'PREFIX'|'SUFFIX', weight: number }[]} conditionalPool
 *            Same as fullPool minus mods already on the starting item.
 * @property {{ key: string }[]} wishlist     Wished entries.
 * @property {number} requiredHits            Min |M ∩ wishlist| on final item.
 * @property {number} startingHits            Wished mods already on starting.
 * @property {{ prefixes: number, suffixes: number }} startingCounts
 *            How many slots are already occupied on the starting item.
 * @property {Record<string, { exaltedPer: number }>} currencies
 * @property {Record<string, { priceCurrency: string, timeSeconds: number }>} orbs
 */

// `orbCostEx` is now in ./strategy-utils.js so it can be shared with
// per-strategy modules (e.g. ./strategies/chaos-spam.js).

/**
 * Alch fresh bases (NOT "alchemy spam" — alchemy turns Normal/Magic → Rare,
 * so a single item can only be alched once. The pattern is: discard the
 * current item, procure a fresh Normal/Magic base, apply Orb of Alchemy,
 * evaluate. Repeat with a NEW base each iteration — never re-alch a Rare.
 *
 * In PoE2 0.3.1+, Alchemy works on Magic items too (previously Normal only),
 * so "fresh base" can mean either rarity. Either way, the per-attempt cost
 * folds in `basePriceEx` (the cost of acquiring the next base item).
 *
 * Each attempt produces a 4-mod Rare. The prefix/suffix split is *not* fixed
 * at 2+2 — affixes are drawn from a unified weighted pool, with each mod
 * carrying its intrinsic type. Starting item is ignored.
 */
const ALCHEMY_TOTAL_DRAWS = 4;
function alchemySpam(ctx) {
  const required = ctx.requiredHits; // start from scratch — no startingHits
  if (required > ALCHEMY_TOTAL_DRAWS) {
    return {
      id: 'alchemy-spam', label: 'Alchemy spam', available: false,
      notes: `requirement (${required}) exceeds ${ALCHEMY_TOTAL_DRAWS} affixes per alchemy`,
    };
  }
  if (ctx.minFilled > ALCHEMY_TOTAL_DRAWS) {
    return {
      id: 'alchemy-spam', label: 'Alchemy spam', available: false,
      notes: `minFilled (${ctx.minFilled}) exceeds 4 affixes; alchemy alone can't fill 5+ slots`,
    };
  }
  if (ctx.maxFilled < ALCHEMY_TOTAL_DRAWS) {
    return {
      id: 'alchemy-spam', label: 'Alchemy spam', available: false,
      notes: `maxFilled (${ctx.maxFilled}) is below 4; alchemy always produces 4 affixes`,
    };
  }
  // Unified Wallenius draw across the full pool — prefix/suffix split emerges
  // naturally from each mod's intrinsic type. (PoE2 alchemy in practice may
  // also enforce ≤3 prefixes / ≤3 suffixes; we ignore that cap here since
  // hitting 4 of either side is rare for a typical pool.)
  const p = pHitWishlistUnified(ctx.fullPool, ctx.wishlist, ALCHEMY_TOTAL_DRAWS, required);
  const costEx = orbCostEx('alchemy', ctx);
  // Each attempt produces a Rare; alchemy can't re-roll a Rare, so the next
  // attempt must reset back to Normal/Magic. resetToWhite picks the cheaper
  // of (annul every mod) vs (procure a fresh base). For a 4-mod Rare,
  // procure usually wins, but if the base is pricey annulling 4 may beat it.
  const reset = resetToWhite(ctx, { fractured: false, modCount: ALCHEMY_TOTAL_DRAWS });
  const resetCost = Number.isFinite(reset.costEx) ? reset.costEx : 0;
  const resetTime = Number.isFinite(reset.timeSec) ? reset.timeSec : 0;
  const stats = geometricCost(p, (Number.isFinite(costEx) ? costEx : 1) + resetCost);
  const time = ((ctx.orbs.alchemy?.timeSeconds ?? 0) + resetTime) * stats.expectedAttempts;
  return {
    id: 'alchemy-spam',
    label: 'Alch fresh bases',
    available: true,
    p,
    expectedAttempts: stats.expectedAttempts,
    expectedCostEx: Number.isFinite(costEx) ? stats.expectedCost : NaN,
    expectedTimeSec: time,
    notes: Number.isFinite(costEx)
      ? `each attempt = reset (${reset.notes}) + 1 alch; 4 affixes from unified pool (random P/S split)`
      : 'alchemy rate not set — cost unavailable',
    chain: geometricChain({
      baseLabel: 'Normal/Magic base\n(no affixes)',
      attemptLabel: `4-mod Rare\nP(satisfy)=${(p * 100).toFixed(2)}%`,
      orbName: 'Orb of Alchemy',
      orbCostEx: Number.isFinite(costEx) ? costEx : NaN,
      successProb: p,
      expectedAttempts: stats.expectedAttempts,
      resetCostEx: resetCost,
      resetMethod: reset.method ? `${reset.method}: ${reset.notes}` : reset.notes,
    }),
  };
}

/**
 * Exalt-fill: keep the current starting item, apply Exalted Orbs to fill all
 * remaining open slots. One-shot per "attempt"; on failure, restart with a
 * new base of the same type (cost = base + open_slots × ex).
 *
 * v1 simplification: ignore base-procurement cost; cost-per-attempt =
 * open_slots Exalted (the orbs themselves). Pool conditioned on starting.
 */
function exaltFill(ctx) {
  const openP = 3 - ctx.startingCounts.prefixes;
  const openS = 3 - ctx.startingCounts.suffixes;
  const open = openP + openS;
  const startTotal = ctx.startingCounts.prefixes + ctx.startingCounts.suffixes;
  const finalTotal = startTotal + open;
  if (open <= 0) {
    return {
      id: 'exalt-fill', label: 'Exalt-fill', available: false,
      notes: 'no open slots on starting item',
    };
  }
  if (finalTotal > ctx.maxFilled) {
    return {
      id: 'exalt-fill', label: 'Exalt-fill', available: false,
      notes: `exalt-fill would produce ${finalTotal} affixes, exceeding maxFilled=${ctx.maxFilled}`,
    };
  }
  if (finalTotal < ctx.minFilled) {
    return {
      id: 'exalt-fill', label: 'Exalt-fill', available: false,
      notes: `exalt-fill produces only ${finalTotal} affixes, below minFilled=${ctx.minFilled}`,
    };
  }
  const remaining = Math.max(0, ctx.requiredHits - ctx.startingHits);
  if (remaining > open) {
    return {
      id: 'exalt-fill', label: 'Exalt-fill', available: false,
      notes: `need ${remaining} more wished mods but only ${open} open slot(s)`,
    };
  }
  const p = pHitWishlist(
    ctx.conditionalPool,
    ctx.wishlist,
    { prefixDraws: openP, suffixDraws: openS },
    remaining,
  );
  const exCost = ctx.currencies.exalted?.exaltedPer ?? 1;
  // Each failed attempt resets to a Normal base from the *post-fill* state
  // (the item carries `finalTotal` mods at the moment of failure, NOT
  // `startingCounts`). resetToWhite picks the cheaper of (annul every mod)
  // vs (procure a fresh base). No fractured anchor here — plain exalt-fill
  // doesn't lock anything.
  const reset = resetToWhite(ctx, { fractured: false, modCount: finalTotal });
  const resetCost = Number.isFinite(reset.costEx) ? reset.costEx : 0;
  const resetTime = Number.isFinite(reset.timeSec) ? reset.timeSec : 0;
  const costPerAttempt = open * exCost + resetCost;
  const stats = geometricCost(p, costPerAttempt);
  const time = ((ctx.orbs.exalted?.timeSeconds ?? 0) * open + resetTime) * stats.expectedAttempts;
  return {
    id: 'exalt-fill',
    label: 'Exalt-fill',
    available: true,
    p,
    expectedAttempts: stats.expectedAttempts,
    expectedCostEx: stats.expectedCost,
    expectedTimeSec: time,
    notes: `${open} exalt(s) per attempt; reset = ${reset.notes}`,
    description:
      'Take the existing starting item (assumed Rare with < 6 mods). Apply ' +
      'Exalted Orbs one by one until every open slot is filled. Each Exalted ' +
      'adds one random affix to the item — picks a random side, then a random ' +
      'mod from that side\'s pool. If the final item doesn\'t satisfy the ' +
      'target, you can\'t un-do; the strategy assumes you re-procure a ' +
      'similar partial Rare and try again.',
    chain: geometricChain({
      baseLabel: `Partial Rare\n${ctx.startingCounts.prefixes}P + ${ctx.startingCounts.suffixes}S\n${open} open slot(s)`,
      attemptLabel: `Filled Rare\n(${finalTotal} affixes)\nP(satisfy)=${(p * 100).toFixed(2)}%`,
      orbName: `${open}× Exalted Orb`,
      orbCostEx: open * exCost,
      successProb: p,
      expectedAttempts: stats.expectedAttempts,
      resetCostEx: resetCost,
      resetMethod: reset.method ? `${reset.method}: ${reset.notes}` : reset.notes,
    }),
  };
}

// chaosSpam now lives in ./strategies/chaos-spam.js and is imported above.

/**
 * Fracture-anchor: lock the rarest wished affix with a Fracturing Orb, then
 * iteratively annul-and-refill the rest of the item. The fracture is safe
 * across resets, so each retry has bounded downside.
 *
 * Closed-form decomposition:
 *   E[cost] = phase1 + retryCost / pRetrySatisfies
 *   phase1  = alchemyCost / pAlchHitsAnchor + fractureCost
 *   pRetrySatisfies = P(non-anchor fills supply ≥ requiredHits − 1 hits)
 *
 * Approximations (documented for the UI):
 *   - The anchor is auto-picked as the lowest-weight wished mod (rarest).
 *   - Per-retry cost ≈ 6 × annul + 5 × exalt (heuristic: ~6 annuls to clear
 *     5 non-anchor mods, then 5 exalts to refill).
 *   - Phase-1 alch hit probability uses the same-side pool only.
 *   - Refill draws all 5 non-anchor slots; the anchor occupies one slot
 *     of its type, so refill draws are (3, 2) or (2, 3) depending on type.
 */

// ────────────────────────────────────────────────────────────────
// Recombinator (PoE2 patch 0.2.0+)
//
// Mechanic per the Butsicles guide
// (https://www.reddit.com/r/PathOfExile2/comments/1jzu2py/):
//
// - Combine two same-class items, select N total mods (1..6) across
//   them. The game returns a recombination success chance (RS); a
//   successful recombine produces ONE rare with the selected mods on
//   one of the two source bases (the other is destroyed); failure
//   destroys both items.
//
// - For two-mod combines on items at equivalent ilvl (EI):
//     RS = SC(mod_A) + SC(mod_B), each SC capped at 50%.
//     SC(mod) ≈ A · ( Σ weight(t) for t ≥ chosen tier, t ≤ ilvl )
//                  / total_pool_weight_of_same_side_at_this_ilvl
//   Higher tier ⇒ smaller numerator (fewer "helping" tiers above) ⇒
//   smaller SC. Lower tier ⇒ SC quickly hits the 50% cap. The user
//   maximizes tier until SC starts dropping in-game.
//
// - Fractured-mod interaction: a fractured affix on a source base
//   CANNOT be selected, but transfers FREE to the output if its
//   base wins. Choosing a low-weight mod on the fractured base
//   maximises P(fractured base wins) but lowers RS proportionally;
//   per the Butsicles conjecture the two effects cancel for fracture
//   carry-over, so the user can pick whichever mod is cheap to roll
//   alongside the fracture.
//
// - Failure destroys both inputs. Geometric retry over per-attempt
//   cost (item_A + item_B + Expedition Artifact value).
//
// This strategy is closed-form (the MDP is single-item, recombinator
// is 2-input — modelling natively would require a 2-item state
// space). User supplies the two source-mod tiers via wishlist
// `requiredTier`; SC comes from per-tier mod weights (already in
// `mod.tiers` for each pool entry); RS = capped sum; expected cost
// = per-attempt / RS.
export function recombinator(ctx) {
  if (!ctx?.wishlist?.length) {
    return { id: 'recombinator', label: 'Recombinator', available: false,
      notes: 'no wishlist' };
  }
  // Pick the two highest-weight wished mods to try carrying over.
  // Practical heuristic: the user typically wants the two "best"
  // wishlist entries combined into a single output. For richer
  // multi-mod combines, this strategy is a lower bound on cost.
  const sorted = [...ctx.wishlist].sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0));
  if (sorted.length < 1) {
    return { id: 'recombinator', label: 'Recombinator', available: false,
      notes: 'no wishlist mods to combine' };
  }
  const modA = sorted[0];
  const modB = sorted[1] ?? sorted[0]; // single-mod scenario uses only mod A

  // Per-side total pool weight at this ilvl. fullPool entries already
  // carry per-tier eligibility, so summing weights is straightforward.
  const totalPrefixW = (ctx.fullPool ?? [])
    .filter((m) => m.type === 'PREFIX').reduce((s, m) => s + (m.weight ?? 0), 0);
  const totalSuffixW = (ctx.fullPool ?? [])
    .filter((m) => m.type === 'SUFFIX').reduce((s, m) => s + (m.weight ?? 0), 0);
  // Per-base scaling constant from the Butsicles analysis. 500_000
  // for body armours, 800_000 for spears at low ilvl, 817_000 at
  // ilvl 79. We use 500_000 as the conservative default until per-
  // base tuning lands.
  const A_SCALE = 500_000;
  // Compute SC for one wished mod given its requiredTier.
  const computeSC = (w) => {
    const poolEntry = (ctx.fullPool ?? []).find((m) => m.key === w.key);
    if (!poolEntry?.tiers?.length) return 0;
    const total = w.type === 'PREFIX' ? totalPrefixW : totalSuffixW;
    if (total <= 0) return 0;
    // Σ weight(t) for t ≥ chosen tier (lower tier number = higher
    // tier in PoE2; chosen tier T means we include T..top).
    const reqT = Number.isFinite(w.requiredTier) ? w.requiredTier : 1;
    const sumW = poolEntry.tiers
      .filter((t) => t.tier <= reqT)
      .reduce((s, t) => s + (t.weight ?? 0), 0);
    if (sumW <= 0) return 0;
    const unbounded = (A_SCALE * sumW) / total;
    return Math.min(50, unbounded);
  };
  const scA = computeSC(modA);
  const scB = sorted.length >= 2 ? computeSC(modB) : 0;
  const RS = Math.min(100, scA + scB);
  if (RS <= 0) {
    return { id: 'recombinator', label: 'Recombinator', available: false,
      notes: 'RS=0 (mod tiers / pool data missing)' };
  }
  const pSuccess = RS / 100;

  // Per-attempt cost = both source items + 1 artifact.
  // Source items come either from the user's `fracturedAnchorPriceEx`
  // (trade-bought) or from a roll-cost approximation. Default: 2 ×
  // basePriceEx as a rough acquisition floor; the user can refine
  // this via ctx.recombinatorInputCostEx if they have specific
  // numbers from trade. Artifact cost defaults to 1 ex (placeholder
  // — Expedition artifacts aren't directly tradable; needs user-
  // supplied conversion).
  const inputCost = ctx.recombinatorInputCostEx
    ?? (2 * (ctx.basePriceEx ?? 0));
  const artifactCost = ctx.recombinatorArtifactCostEx ?? 1;
  const perAttemptCost = inputCost + artifactCost;
  const expectedAttempts = 1 / pSuccess;
  const expectedCostEx = perAttemptCost * expectedAttempts;

  const tFracture = ctx.orbs?.recombinator?.timeSeconds ?? 5;
  const expectedTimeSec = tFracture * expectedAttempts;

  return {
    id: 'recombinator',
    label: 'Recombinator',
    available: true,
    p: pSuccess,
    expectedAttempts,
    expectedCostEx,
    expectedTimeSec,
    notes:
      `RS=${RS.toFixed(1)}% (SC_A=${scA.toFixed(1)}% + SC_B=${scB.toFixed(1)}%); `
      + `per-attempt=${perAttemptCost.toFixed(0)} ex (2× input + artifact); `
      + `Reddit/Butsicles formula, A_scale=${A_SCALE} (default body-armour value).`,
    description:
      'Combine two same-class items, each carrying one of the wished mods. '
      + 'Per-mod success contribution (SC) follows the Butsicles formula: '
      + 'SC ∝ Σ tier-weights(t ≥ chosen tier) / total_pool_weight, capped '
      + 'at 50%. RS = SC_A + SC_B. Failure destroys both inputs ⇒ geometric '
      + 'retry. Strong with cheap fractured bases (fracture carries free if '
      + 'its base wins).',
  };
}

function fractureAnchor(ctx) {
  if (!ctx.wishlist.length) {
    return {
      id: 'fracture-anchor', label: 'Fracture-anchor', available: false,
      notes: 'no wishlist',
    };
  }
  // Anchor selection:
  //   1. If the user explicitly flagged a target entry as fractured, use
  //      THAT mod as the anchor — the user's intent overrides the
  //      auto-pick. This is the new Phase-1 fix: the strategy used to
  //      ignore `requiredFracturedKey` and always auto-pick the rarest.
  //   2. Otherwise, fall back to the rarest wished affix in the pool.
  const wishedSet = new Set(ctx.wishlist.map((w) => w.key));
  let anchor = null;
  if (ctx.requiredFracturedKey) {
    anchor = ctx.fullPool.find(
      (m) => m.key === ctx.requiredFracturedKey && m.weight > 0,
    ) ?? null;
    if (!anchor) {
      return {
        id: 'fracture-anchor', label: 'Fracture-anchor', available: false,
        notes: `target requires a fractured "${ctx.requiredFracturedKey}" but that mod isn't in the eligible pool at this ilvl — raise ilvl or change the target`,
      };
    }
  }
  if (!anchor) {
    const candidates = ctx.fullPool
      .filter((m) => wishedSet.has(m.key) && m.weight > 0)
      .sort((a, b) => a.weight - b.weight);
    if (!candidates.length) {
      return {
        id: 'fracture-anchor', label: 'Fracture-anchor', available: false,
        notes: 'no wished mod is in the eligible pool — anchor undefined',
      };
    }
    anchor = candidates[0];
  }

  // Phase 1: alch-until-anchor, then fracture.
  const sameSidePool = ctx.fullPool.filter((m) => m.type === anchor.type);
  const sideTotal = sameSidePool.reduce((s, m) => s + m.weight, 0);
  // Approximate: an alch produces ~2 affixes of this side. P(anchor in 2 draws):
  // = 1 − P(both draws miss anchor). Using Wallenius two-draw probability of
  // anchor presence (≈ inclusion probability under without-replacement):
  const alchSideDraws = anchor.type === 'PREFIX'
    ? 2 : 2; // symmetric default
  const pAnchorOnAlch = sideTotal > 0
    ? 1 - Math.pow(1 - anchor.weight / sideTotal, alchSideDraws) // independent-draw approximation
    : 0;
  if (pAnchorOnAlch <= 0) {
    return {
      id: 'fracture-anchor', label: 'Fracture-anchor', available: false,
      notes: 'anchor unreachable on alchemy',
    };
  }

  const alchCost = orbCostEx('alchemy', ctx);
  const fractureCost = orbCostEx('fracturing', ctx);
  const annulCost = orbCostEx('annulment', ctx);
  const exaltCost = orbCostEx('exalted', ctx);
  const missing = [];
  if (!Number.isFinite(alchCost))     missing.push('alchemy');
  if (!Number.isFinite(fractureCost)) missing.push('fracturing');
  if (!Number.isFinite(annulCost))    missing.push('annulment');
  if (!Number.isFinite(exaltCost))    missing.push('exalted');
  if (missing.length) {
    return {
      id: 'fracture-anchor', label: 'Fracture-anchor', available: false,
      notes: `missing rate(s): ${missing.join(', ')}`,
    };
  }

  // Phase-1 alternative: trade-bought already-fractured anchor item (often
  // dramatically cheaper than rolling-and-fracturing for rare anchors).
  // Rolled path: each alch attempt needs a fresh Normal/Magic base; reuse
  // resetToWhite so annulling a 4-mod Rare can substitute when cheaper than
  // re-buying. NESTED geometric:
  //   inner: alch until anchor lands  ⇒  E[inner cost] = (alch + reset) /
  //          pAnchorOnAlch
  //   outer: fracture, hope it locks the anchor  ⇒  P(success) = 1/N where
  //          N = totalMods on the Rare at fracture time (alch produces a
  //          4-mod Rare, so typically 1/4; if the user annuls down before
  //          fracturing we'd hit a smaller N — the model uses ctx.alchemyDraws
  //          since this strategy fractures the post-alch item directly).
  // Earlier this factor was missing entirely — fracture was treated as a
  // deterministic step costing only `fractureCost`, ignoring the 75%-or-
  // worse brick-and-restart-phase-1 branch. That collapsed the displayed
  // expected cost (and hence inflated pWithinCaps to a bogus ~100%).
  const rollReset = resetToWhite(ctx, { fractured: false, modCount: 4 });
  const rollResetCost = Number.isFinite(rollReset.costEx) ? rollReset.costEx : 0;
  const fractureModCount = ctx.alchemyDraws ?? 4;
  const pFractureLocksAnchor = 1 / fractureModCount;
  const phase1RollPerOuterTrial = (alchCost + rollResetCost) / pAnchorOnAlch + fractureCost;
  const phase1Roll = phase1RollPerOuterTrial / pFractureLocksAnchor;
  const phase1Trade = Number.isFinite(ctx.fracturedAnchorPriceEx)
    ? ctx.fracturedAnchorPriceEx : Infinity;
  const phase1 = Math.min(phase1Roll, phase1Trade);
  const phase1Source = phase1Trade < phase1Roll ? 'trade-bought' : 'rolled';

  // Phase 2: retry distribution. Conditional pool excludes the anchor
  // itself (it's locked) plus any other starting-item mods.
  const refillPool = ctx.conditionalPool.filter((m) => m.key !== anchor.key);
  // Refill draws: anchor occupies one slot of its type.
  const refillPrefix = anchor.type === 'PREFIX' ? 2 : 3;
  const refillSuffix = anchor.type === 'SUFFIX' ? 2 : 3;
  const remainingHits = Math.max(0, ctx.requiredHits - 1); // anchor contributes 1
  const pRetry = pHitWishlist(
    refillPool,
    ctx.wishlist.filter((w) => w.key !== anchor.key),
    { prefixDraws: refillPrefix, suffixDraws: refillSuffix },
    remainingHits,
  );
  if (pRetry <= 0) {
    return {
      id: 'fracture-anchor', label: 'Fracture-anchor', available: false,
      notes: 'no refill outcome can satisfy the requirement',
    };
  }

  const annulsPerRetry = 6; // heuristic: harmonic sum across 5 non-anchor mods
  const exaltsPerRetry = 5;
  const retryCost = annulsPerRetry * annulCost + exaltsPerRetry * exaltCost;
  const expectedRetries = 1 / pRetry;
  const expectedCostEx = phase1 + retryCost * expectedRetries;

  const tFracture = ctx.orbs.fracturing?.timeSeconds ?? 0;
  const tAlch = ctx.orbs.alchemy?.timeSeconds ?? 0;
  const tAnnul = ctx.orbs.annulment?.timeSeconds ?? 0;
  const tExalt = ctx.orbs.exalted?.timeSeconds ?? 0;
  // Same nested-geometric structure as cost: inner alch loop, outer
  // fracture-locks-anchor loop. Factor 1/pFractureLocksAnchor was
  // missing previously, undercounting wall-clock time.
  const phase1TimePerOuterTrial = tAlch / pAnchorOnAlch + tFracture;
  const phase1Time = phase1TimePerOuterTrial / pFractureLocksAnchor;
  const retryTime = annulsPerRetry * tAnnul + exaltsPerRetry * tExalt;
  const expectedTimeSec = phase1Time + retryTime * expectedRetries;

  // Two-phase chain. Phase 1: alch-spam-then-fracture loop bouncing back
  // to the base on miss; once the anchor lands and fracture is applied, we
  // enter the fractured-anchor state. Phase 2: from there, the annul-and-
  // refill cycle is its own self-loop ending in the goal.
  const anchorShort = anchor.key.split(':').slice(1).join(':').slice(0, 28);
  const phase1RollCostPerAttempt = alchCost + rollResetCost;
  // Chain now models the fracture step explicitly, with its
  // brick branch back to `base`. Earlier the chain showed fracture as
  // a deterministic edge `rolled → fractured` — operationally
  // misleading, since 1 − 1/N of fracture attempts brick the item.
  const fractureChain = {
    states: [
      { id: 'base',           label: 'Normal/Magic base\n(no affixes)',                                                                                          kind: 'start' },
      { id: 'rolled',         label: `${fractureModCount}-mod Rare with anchor\nP(anchor lands)=${(pAnchorOnAlch * 100).toFixed(2)}%`,                            kind: 'transient' },
      { id: 'fractured',      label: `Fractured-anchor item\n"${anchorShort}" locked\n(${refillPrefix}P + ${refillSuffix}S free)`,                                kind: 'transient' },
      { id: 'goal',           label: '✓ goal',                                                                                                                    kind: 'goal' },
    ],
    edges: [
      { from: 'base',      to: 'rolled',    label: `Orb of Alchemy + reset\n${phase1RollCostPerAttempt.toFixed(2)} ex/attempt`,                                  kind: 'orb' },
      { from: 'rolled',    to: 'base',      label: `1−p=${(1 - pAnchorOnAlch).toFixed(3)}\nanchor missed → reset (${rollReset.notes})`,                          kind: 'fail' },
      { from: 'rolled',    to: 'fractured', label: `p=${(pAnchorOnAlch * pFractureLocksAnchor).toFixed(3)}\nFracturing Orb locks anchor (1/${fractureModCount})`, kind: 'success' },
      { from: 'rolled',    to: 'base',      label: `${(pAnchorOnAlch * (1 - pFractureLocksAnchor)).toFixed(3)}\nFracturing Orb locks WRONG mod → brick → reset`,  kind: 'fail' },
      { from: 'fractured', to: 'goal',      label: `p=${pRetry.toFixed(3)}\n× E[retries]≈${expectedRetries.toFixed(1)}`,                                          kind: 'success' },
      { from: 'fractured', to: 'fractured', label: `1−p=${(1 - pRetry).toFixed(3)}\n${annulsPerRetry}× annul + ${exaltsPerRetry}× exalt\n${retryCost.toFixed(0)} ex/retry`, kind: 'fail' },
    ],
    start: 'base',
    goals: ['goal'],
  };
  // If trade-bought is the cheaper phase 1, swap the alchemy loop for a
  // single direct edge — clearer story for the user.
  if (phase1Source === 'trade-bought') {
    fractureChain.edges = [
      { from: 'base',      to: 'fractured', label: `Trade-buy\n${phase1Trade.toFixed(0)} ex`,                                  kind: 'orb' },
      { from: 'fractured', to: 'goal',      label: `p=${pRetry.toFixed(3)}\n× E[retries]≈${expectedRetries.toFixed(1)}`,        kind: 'success' },
      { from: 'fractured', to: 'fractured', label: `1−p=${(1 - pRetry).toFixed(3)}\n${annulsPerRetry}× annul + ${exaltsPerRetry}× exalt\n${retryCost.toFixed(0)} ex/retry`, kind: 'fail' },
    ];
    fractureChain.states = fractureChain.states.filter((s) => s.id !== 'rolled');
  }
  return {
    id: 'fracture-anchor',
    label: 'Fracture-anchor',
    available: true,
    p: pRetry, // marginal P per retry attempt (not per orb)
    expectedAttempts: expectedRetries,
    expectedCostEx,
    expectedTimeSec,
    notes: `anchor = "${anchor.key}" (w=${anchor.weight.toFixed(0)}); phase1 ${phase1Source} ≈ ${phase1.toFixed(0)} ex (rolled=${phase1Roll.toFixed(0)}, trade=${Number.isFinite(phase1Trade) ? phase1Trade.toFixed(0) : '—'}); retry ≈ ${retryCost.toFixed(0)} ex × ${expectedRetries.toFixed(2)}`,
    description:
      'Two-phase craft. Phase 1 (one-off): obtain an item with the rarest ' +
      'wished mod locked by a Fracturing Orb — either roll-and-fracture (alch ' +
      'until the anchor mod lands, then Fracture) or buy a pre-fractured ' +
      'item from trade. Phase 2 (geometric retry): annul-and-refill the ' +
      'remaining slots until the rest of the wishlist is satisfied. The ' +
      'fracture survives every annul/refill cycle, so the downside is bounded.',
    chain: fractureChain,
  };
}

/**
 * Sinistral Exalt-fill: like exalt-fill but each Exalted is paired with an
 * Omen of Sinistral Exaltation, restricting the new affix to a *prefix*
 * slot. Cost per fill = exalt + omen. Useful when the wishlist is heavy on
 * prefixes and the player has spare suffix slots they don't want to clutter.
 *
 * Modelled per attempt:
 *   - Open prefix slots only get filled.
 *   - Pool restricted to PREFIX type, conditioned on starting state.
 *   - Refill draws = (open prefix slots) prefix + 0 suffix.
 *   - Cost = open_prefix × (exalt_ex + omen_ex). Omen price is a placeholder
 *     until the poe2db Economy_Omen snapshot seeds in (~10 ex assumed).
 */
function sideExaltFill(side) {
  const id = side === 'PREFIX' ? 'sinistral-exalt-fill' : 'dextral-exalt-fill';
  const omenId = side === 'PREFIX' ? 'omen-of-sinistral-exaltation'
                                   : 'omen-of-dextral-exaltation';
  const label = side === 'PREFIX' ? 'Sinistral Exalt-fill (prefix-only)'
                                  : 'Dextral Exalt-fill (suffix-only)';
  const omenPlaceholderEx = 10; // until poe2db Economy_Omen seeds omen prices
  return function (ctx) {
    if (ctx.isAvailable && !ctx.isAvailable('omen', omenId)) {
      return { id, label, available: false, notes: `${omenId} is disabled (toggle it on under Crafting items)` };
    }
    const openP = 3 - ctx.startingCounts.prefixes;
    const openS = 3 - ctx.startingCounts.suffixes;
    const open = side === 'PREFIX' ? openP : openS;
    const offside = side === 'PREFIX' ? openS : openP;
    const startTotal = ctx.startingCounts.prefixes + ctx.startingCounts.suffixes;
    const finalTotal = startTotal + open; // off-side stays untouched
    if (open <= 0) {
      return { id, label, available: false, notes: `no open ${side.toLowerCase()} slots` };
    }
    if (finalTotal > ctx.maxFilled) {
      return { id, label, available: false, notes: `would produce ${finalTotal} affixes; exceeds maxFilled=${ctx.maxFilled}` };
    }
    if (finalTotal < ctx.minFilled) {
      return { id, label, available: false, notes: `would produce only ${finalTotal} affixes; below minFilled=${ctx.minFilled}` };
    }
    const exCost = ctx.currencies.exalted?.exaltedPer ?? 1;
    // basePriceEx is paid once (we reuse the starting item across attempts)
    // We approximate: amortise over expected attempts by adding it as a
    // front-loaded constant rather than per-attempt.
    const basePrice = Number.isFinite(ctx.basePriceEx) ? ctx.basePriceEx : 0;
    const costPerAttempt = open * (exCost + omenPlaceholderEx);
    const remaining = Math.max(0, ctx.requiredHits - ctx.startingHits);
    // Wishlist solver over side-restricted pool. We feed prefix/suffix draws
    // matching the side; the convolved tail captures only side hits.
    const draws = side === 'PREFIX' ? { prefixDraws: open, suffixDraws: 0 }
                                    : { prefixDraws: 0, suffixDraws: open };
    const sidePool = ctx.conditionalPool.filter((m) => m.type === side);
    if (!sidePool.length) {
      return { id, label, available: false, notes: `no eligible ${side.toLowerCase()} mods left` };
    }
    const p = pHitWishlist(sidePool, ctx.wishlist, draws, remaining);
    const stats = geometricCost(p, costPerAttempt);
    const tEx = ctx.orbs.exalted?.timeSeconds ?? 0;
    // omen application time ~= an orb action (placeholder)
    const time = (tEx + 2) * open * stats.expectedAttempts;
    return {
      id, label, available: true,
      p,
      expectedAttempts: stats.expectedAttempts,
      expectedCostEx: stats.expectedCost + basePrice, // base paid once
      expectedTimeSec: time,
      notes: `${open} exalt+omen pair(s) per attempt; off-side (${offside} open ${side === 'PREFIX' ? 'suffix' : 'prefix'} slot(s)) untouched. Omen = ${omenPlaceholderEx} ex placeholder. Base = ${basePrice} ex (one-off).`,
      description: side === 'PREFIX'
        ? 'Pair every Exalted Orb with an Omen of Sinistral Exaltation, which ' +
          'restricts the new affix to a *prefix* slot. Suffix slots stay ' +
          'untouched. Useful when you have a fractured prefix anchor (or ' +
          'pre-rolled suffixes you want to preserve) and need to fill only ' +
          'the prefix side without disturbing the rest.'
        : 'Pair every Exalted Orb with an Omen of Dextral Exaltation, which ' +
          'restricts the new affix to a *suffix* slot. Prefix slots stay ' +
          'untouched. Symmetric to the sinistral variant — useful when ' +
          'prefixes are already locked in.',
      chain: geometricChain({
        baseLabel: `Partial Rare\n${ctx.startingCounts.prefixes}P + ${ctx.startingCounts.suffixes}S\n${open} open ${side.toLowerCase()}, ${offside} preserved off-side`,
        attemptLabel: `${side.toLowerCase()}-filled\n(${finalTotal} affixes)\nP(satisfy)=${(p * 100).toFixed(2)}%`,
        orbName: `${open}× ${side === 'PREFIX' ? 'Sinistral' : 'Dextral'}\n(Exalted + Omen)`,
        orbCostEx: open * (exCost + omenPlaceholderEx),
        successProb: p,
        expectedAttempts: stats.expectedAttempts,
        // sideExaltFill amortises basePrice once over the geometric series;
        // the chain's per-attempt reset cost reflects only the within-cycle
        // cost (annul the side just filled).
        resetCostEx: 0,
        resetMethod: 'preserve off-side; re-roll fresh',
      }),
    };
  };
}

const sinistralExaltFill = sideExaltFill('PREFIX');
const dextralExaltFill   = sideExaltFill('SUFFIX');

/**
 * Coupled Sinistral + Dextral Exalt-fill: a single composite that fills
 * BOTH sides with side-restricted exalts (Sinistral for prefixes, Dextral
 * for suffixes). Replaces the common case where the user wants every open
 * slot filled but with deterministic side allocation rather than the
 * random-side roll of plain exalt-fill.
 *
 * Per attempt we apply:
 *   - openP × (Exalted + Omen of Sinistral Exaltation) → fills prefix side
 *   - openS × (Exalted + Omen of Dextral  Exaltation)  → fills suffix side
 *
 * Probability: the existing pHitWishlist accepts an explicit
 * { prefixDraws, suffixDraws } split, so deterministic side allocation is
 * just `(openP, openS)` over the side-restricted pool. Cost per attempt =
 * (openP + openS) × (exalt + omen). Failed attempts re-procure the base.
 */
function coupledExaltFill(ctx) {
  const id = 'coupled-exalt-fill';
  const label = 'Coupled Exalt-fill (Sinistral + Dextral)';
  const omenSinId = 'omen-of-sinistral-exaltation';
  const omenDexId = 'omen-of-dextral-exaltation';
  const omenPlaceholderEx = 10;
  if (ctx.isAvailable) {
    if (!ctx.isAvailable('omen', omenSinId)) {
      return { id, label, available: false, notes: `${omenSinId} is disabled (toggle it on under Crafting items)` };
    }
    if (!ctx.isAvailable('omen', omenDexId)) {
      return { id, label, available: false, notes: `${omenDexId} is disabled (toggle it on under Crafting items)` };
    }
  }
  const openP = 3 - ctx.startingCounts.prefixes;
  const openS = 3 - ctx.startingCounts.suffixes;
  const open = openP + openS;
  if (open <= 0) {
    return { id, label, available: false, notes: 'no open slots on starting item' };
  }
  const startTotal = ctx.startingCounts.prefixes + ctx.startingCounts.suffixes;
  const finalTotal = startTotal + open;
  if (finalTotal > ctx.maxFilled) {
    return { id, label, available: false, notes: `would produce ${finalTotal} affixes; exceeds maxFilled=${ctx.maxFilled}` };
  }
  if (finalTotal < ctx.minFilled) {
    return { id, label, available: false, notes: `would produce only ${finalTotal} affixes; below minFilled=${ctx.minFilled}` };
  }
  const remaining = Math.max(0, ctx.requiredHits - ctx.startingHits);
  if (remaining > open) {
    return { id, label, available: false, notes: `need ${remaining} more wished mods but only ${open} open slot(s)` };
  }
  // Pool stays unsplit — pHitWishlist convolves prefix and suffix draws
  // separately using the entries' `type` field, so an untyped pool works
  // because each draw is keyed off prefix/suffix membership internally.
  const p = pHitWishlist(
    ctx.conditionalPool,
    ctx.wishlist,
    { prefixDraws: openP, suffixDraws: openS },
    remaining,
  );
  const exCost = ctx.currencies.exalted?.exaltedPer ?? 1;
  // Reset cost is computed against the post-fill state (finalTotal mods),
  // since the reset only happens after a failed attempt where the item
  // carries every newly-rolled affix.
  const reset = resetToWhite(ctx, { fractured: false, modCount: finalTotal });
  const resetCost = Number.isFinite(reset.costEx) ? reset.costEx : 0;
  const resetTime = Number.isFinite(reset.timeSec) ? reset.timeSec : 0;
  // Each failed attempt resets, then re-rolls — same as plain exalt-fill.
  const costPerAttempt = open * (exCost + omenPlaceholderEx) + resetCost;
  const stats = geometricCost(p, costPerAttempt);
  const tEx = ctx.orbs.exalted?.timeSeconds ?? 0;
  const time = ((tEx + 2) * open + resetTime) * stats.expectedAttempts;
  return {
    id, label, available: true,
    p,
    expectedAttempts: stats.expectedAttempts,
    expectedCostEx: stats.expectedCost,
    expectedTimeSec: time,
    notes: `${openP} sinistral + ${openS} dextral pair(s) per attempt; reset = ${reset.notes}; omen placeholder ${omenPlaceholderEx} ex/orb`,
    description:
      'Composite of the two side-restricted exalt-fills. Pair each Exalted ' +
      'Orb spent on the prefix side with an Omen of Sinistral Exaltation, ' +
      'and each Exalted Orb spent on the suffix side with an Omen of ' +
      'Dextral Exaltation. Every new affix is forced to its intended side, ' +
      'eliminating the random-side roll of plain exalt-fill. Useful in the ' +
      'common case where you want every open slot filled but with ' +
      'deterministic side allocation (e.g. pool has heavy prefix/suffix ' +
      'imbalance, or you want even coverage). Failed attempts re-procure ' +
      'the base as in plain exalt-fill.',
    chain: geometricChain({
      baseLabel: `Partial Rare\n${ctx.startingCounts.prefixes}P + ${ctx.startingCounts.suffixes}S\n${openP} open P + ${openS} open S`,
      attemptLabel: `Filled Rare\n(${finalTotal} affixes)\nP(satisfy)=${(p * 100).toFixed(2)}%`,
      orbName: `${openP}× Sinistral + ${openS}× Dextral\n(Exalted + Omen)`,
      orbCostEx: open * (exCost + omenPlaceholderEx),
      successProb: p,
      expectedAttempts: stats.expectedAttempts,
      resetCostEx: resetCost,
      resetMethod: reset.method ? `${reset.method}: ${reset.notes}` : reset.notes,
    }),
  };
}

/** Normalise an affix string for substring matching: drop value ranges and
 *  most numeric tokens, lowercase, collapse whitespace. */
function normaliseAffix(s) {
  return s
    .replace(/\(\s*[\d.]+\s*[—\-–]\s*[\d.]+\s*\)/g, '#')
    .replace(/[\d.]+/g, '#')
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .trim();
}

/**
 * Essence spam: each attempt = apply an essence to a fresh white base,
 * producing a Rare with the essence's guaranteed affix + 3 random affixes.
 *
 * Auto-picks the *cheapest* essence whose target affix matches a wishlist
 * mod and whose item-class restriction includes the current base's class.
 *
 * Per attempt:
 *   P(satisfy) = P(remaining 3 unified draws cover requiredHits − 1 wished
 *               mods, where the pool excludes the essence's targeted family).
 * Cost per attempt = essence price (in ex). Base procurement ignored.
 *
 * Approximations: target-affix → wishlist match by substring on normalised
 * descriptions; item-class match by substring of `ctx.itemClass` in
 * essence.item_classes; same-family exclusion uses mod-name as the family.
 */
function essenceSpam(ctx) {
  const id = 'essence-spam', label = 'Essence spam';
  if (!ctx.essences || !ctx.essences.length) {
    return { id, label, available: false, notes: 'essence catalog not loaded' };
  }
  if (ctx.requiredHits > 4) {
    return { id, label, available: false, notes: `requirement (${ctx.requiredHits}) exceeds 4 affixes per essence` };
  }
  if (ctx.minFilled > 4 || ctx.maxFilled < 4) {
    return { id, label, available: false, notes: `essence produces 4 affixes; outside [${ctx.minFilled},${ctx.maxFilled}]` };
  }

  // Build a quick lookup: normalised wishlist-mod-name -> wishlist key.
  const wishedNorms = ctx.wishlist.map((w) => {
    const colon = w.key.indexOf(':');
    const name = colon >= 0 ? w.key.slice(colon + 1) : w.key;
    return { norm: normaliseAffix(name), key: w.key };
  });

  let best = null;
  for (const ess of ctx.essences) {
    if (!ess.target_affix) continue;
    // Honour user availability override
    if (ctx.isAvailable && !ctx.isAvailable('essence', ess.name)) continue;
    // Item-class compatibility (lenient: any class listed contains itemClass)
    if (ctx.itemClass && ess.item_classes) {
      const cls = ctx.itemClass.toLowerCase();
      const list = ess.item_classes.toLowerCase();
      if (list && !list.split('|').some((c) => c.trim() === cls)) continue;
    }
    // Match essence target against wishlist
    const targetNorm = normaliseAffix(ess.target_affix);
    const matched = wishedNorms.find(
      ({ norm }) => norm.length > 4 && (targetNorm.includes(norm) || norm.includes(targetNorm.slice(0, Math.min(40, targetNorm.length)))),
    );
    if (!matched) continue;

    // Conditional pool excludes the matched mod's family (anchor-style).
    const pool3 = ctx.conditionalPool.filter((m) => m.key !== matched.key);
    const remaining = Math.max(0, ctx.requiredHits - 1);
    const wishlistMinusAnchor = ctx.wishlist.filter((w) => w.key !== matched.key);
    const pRest = pHitWishlistUnified(pool3, wishlistMinusAnchor, 3, remaining);
    const price = (ctx.essencePrices?.[ess.name]?.priceEx) ?? 44.1; // 7 chaos placeholder
    if (!Number.isFinite(price) || price <= 0) continue;
    // Each essence-spam attempt = fresh Normal/Magic base + 1 essence. On
    // failure, reset back to a Normal/Magic state for the next try.
    const reset = resetToWhite(ctx, { fractured: false, modCount: 4 });
    const resetCost = Number.isFinite(reset.costEx) ? reset.costEx : 0;
    const resetTime = Number.isFinite(reset.timeSec) ? reset.timeSec : 0;
    const stats = geometricCost(pRest, price + resetCost);
    const tEss = 3; // essence apply ≈ 3s
    const candidate = {
      id, label,
      available: true,
      p: pRest,
      expectedAttempts: stats.expectedAttempts,
      expectedCostEx: stats.expectedCost,
      expectedTimeSec: (tEss + resetTime) * stats.expectedAttempts,
      chain: geometricChain({
        baseLabel: 'Normal/Magic base\n(no affixes)',
        attemptLabel: `4-mod Rare\nanchor "${matched.key.split(':').slice(1).join(':').slice(0, 30)}" guaranteed\nremaining 3 draws · P(rest)=${(pRest * 100).toFixed(2)}%`,
        orbName: `${ess.name}\n(${price.toFixed(1)} ex)`,
        orbCostEx: price,
        successProb: pRest,
        expectedAttempts: stats.expectedAttempts,
        resetCostEx: resetCost,
        resetMethod: reset.method ? `${reset.method}: ${reset.notes}` : reset.notes,
      }),
      essenceName: ess.name,
      essencePrice: price,
      notes: `${ess.name} (${price.toFixed(1)} ex) + reset (${reset.notes}) per attempt; guarantees "${matched.key.split(':').slice(1).join(':')}"; remaining 3 draws need ${remaining} more`,
    };
    if (!best || candidate.expectedCostEx < best.expectedCostEx) best = candidate;
  }
  return best ?? {
    id, label, available: false,
    notes: 'no essence target matches the wishlist on this base',
  };
}
// Exalt + Annul cycle (baseline / Greater / Perfect) extracted to
// ./strategies/exalt-annul-cycle.js — imported above. The shared Markov
// analysis (bricked / near-trap / V* / H*) lives in markov-analysis.js.

export const STRATEGIES = [
  alchemySpam,
  essenceSpam,
  exaltFill,
  sinistralExaltFill,
  dextralExaltFill,
  coupledExaltFill,
  exaltAnnulCycle,
  greaterExaltAnnulCycle,
  perfectExaltAnnulCycle,
  chaosSpam,
  fractureAnchor,
  recombinator,
];

/**
 * Run all strategies and return their results, sorted by E[cost] ascending
 * (unavailable strategies pushed to the end).
 *
 * Two cross-strategy gates applied here so individual strategies don't
 * each duplicate the same logic:
 *
 *   1. Starting fracture mismatch ⇒ EVERY strategy is unavailable. You
 *      can't unfracture an affix, so the starting item is permanently
 *      bricked relative to the target. Restart with a fresh base.
 *
 *   2. Target requires a fracture but starting item has none ⇒ every
 *      non-fracture strategy is unavailable. The user must run
 *      `fracture-anchor` first to obtain a fractured starting item, then
 *      apply the chosen strategy on the post-fracture base. (Phase 3
 *      composition will fold this into a single composite strategy.)
 */
export function compareStrategies(ctx) {
  const fracMismatch = ctx.startingFracturedKey
    && ctx.requiredFracturedKey
    && ctx.startingFracturedKey !== ctx.requiredFracturedKey;
  const fractureNeeded = ctx.requiredFracturedKey && !ctx.startingFracturedKey;

  const results = STRATEGIES.map((fn) => {
    if (fracMismatch) {
      return {
        id: 'gate-fracture-mismatch',
        // Best-effort id; concrete id is overwritten by the strategy's own
        // when it runs. We bypass the strategy entirely here.
        label: '(bricked: fracture mismatch)',
        available: false,
        notes: `bricked — starting item has fractured "${ctx.startingFracturedKey}" but target wants "${ctx.requiredFracturedKey}". Fractures cannot be unfractured; restart with a fresh base.`,
      };
    }
    if (fractureNeeded && fn !== fractureAnchor) {
      // Compute id/label by invoking the strategy with a minimal dry-run
      // would be expensive; instead, mirror what the strategy would have
      // shown but mark it gated. We invoke it then overwrite the result —
      // strategies are pure and cheap to call for their metadata.
      const r = fn(ctx);
      return {
        ...r,
        available: false,
        notes: `requires a fractured anchor on the starting item — run Fracture-anchor first to obtain "${ctx.requiredFracturedKey}", then apply this strategy on the post-fracture base.`,
      };
    }
    return fn(ctx);
  });
  results.sort((a, b) => {
    if (!a.available && !b.available) return 0;
    if (!a.available) return 1;
    if (!b.available) return -1;
    const ca = Number.isFinite(a.expectedCostEx) ? a.expectedCostEx : Infinity;
    const cb = Number.isFinite(b.expectedCostEx) ? b.expectedCostEx : Infinity;
    return ca - cb;
  });
  return results;
}
