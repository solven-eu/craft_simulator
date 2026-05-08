// MDP trajectory sampler — walks π* from start with random outcome
// sampling per step, producing one concrete realisation of the
// optimal policy. Used by the Plan view's "🎲 Simulate" button to
// give users a feel for what a typical run looks like (orbs spent,
// brick-and-restart events, final item shape).
//
// Output shape:
//   {
//     steps: [{ from, action, costEx, costSec, to, sampledProb }],
//     finalState,
//     totalEx, totalSec,
//     reachedGoal, reachedBrick,
//     buyBaseEvents,
//     orbCounts: { transmute: 3, regal: 1, ... },
//     concreteItem: { rarity, mask, totalMods, fracturedBit,
//                     irrFractured, boneMod, boneRevealed,
//                     wishedModNames: [string], affixCount }
//   }

/**
 * Walk the optimal policy from `mdpResult.start` once, sampling one
 * outcome per transition. Stops on goal, on a buy_base loop counter
 * exceeding `maxRestarts` (so high-brick scenarios don't run forever),
 * or after `maxSteps` total steps as a hard safety cap.
 *
 * @param {object} mdpResult — return value of `solveMDP`.
 * @param {object} [opts]
 *   @param {() => number} [opts.rng]          — uniform [0, 1) RNG. Default Math.random.
 *   @param {number}       [opts.maxSteps=500] — hard step cap.
 *   @param {number}       [opts.maxRestarts=20] — stop after this many buy_base events.
 *   @param {object[]}     [opts.wishlist]    — wishlist for naming wished mods in the
 *                                               concreteItem result. Pass `input.wishlist`.
 */
export function sampleTrajectory(mdpResult, opts = {}) {
  const rng = opts.rng ?? Math.random;
  const maxSteps = opts.maxSteps ?? 500;
  const maxRestarts = opts.maxRestarts ?? 20;
  const wishlist = opts.wishlist ?? [];

  const startIdx = mdpResult.startIdx ?? 0;
  let i = startIdx;
  const steps = [];
  // Seed the trajectory with the initial-base acquisition so totalEx
  // matches V*(start). Without this, the displayed scenario cost is
  // missing one base price — a noticeable gap when the base is
  // expensive (e.g. trade-bought fractured anchor at hundreds of ex).
  // Synthetic step: action='buy_base', deterministic prob=1, no `to`
  // since this happens BEFORE entering the MDP. Counted in
  // orbCounts['buy_base'] but NOT in buyBaseEvents (which tracks
  // restart loops, not the initial acquisition).
  const basePriceEx = Number.isFinite(mdpResult.basePriceEx) ? mdpResult.basePriceEx : 0;
  const basePriceSec = Number.isFinite(mdpResult.basePriceSec) ? mdpResult.basePriceSec : 0;
  let totalEx = basePriceEx;
  let totalSec = basePriceSec;
  let buyBaseEvents = 0;
  const orbCounts = {};
  if (basePriceEx > 0 || basePriceSec > 0) {
    steps.push({
      from: '∅',
      action: 'buy_base',
      costEx: basePriceEx,
      costSec: basePriceSec,
      to: mdpResult.states[startIdx]?.key,
      sampledProb: 1,
      initial: true,
    });
    orbCounts.buy_base = 1;
  }
  // Trajectory-level budget cap: when the user sets `budgetEx` on
  // the solver input, the engine excludes per-action costs above
  // that, but until now the trajectory walker still ran unbounded —
  // a craft could rack up many cheap orbs and far exceed budgetEx
  // in total. Enforce the budget here so the histogram's cost axis
  // actually respects the user's "stop after N ex" constraint.
  // `opts.budgetEx` overrides the MDP's stored budgetCap when set;
  // null/undefined falls back to the cap; null cap = unbounded.
  const budgetCap = Number.isFinite(opts.budgetEx)
    ? opts.budgetEx
    : (Number.isFinite(mdpResult.budgetCap) ? mdpResult.budgetCap : null);
  let reachedGoal = false;
  let truncated = false;
  // Initial-buy may already exceed budget if budget is tighter than
  // the base price; truncate immediately rather than entering the
  // MDP loop with an over-budget state.
  if (budgetCap != null && totalEx > budgetCap) {
    truncated = true;
  }

  for (let step = 0; step < maxSteps && !truncated; step++) {
    const stateRow = mdpResult.states[i];
    if (!stateRow) break;
    if (stateRow.isGoal) { reachedGoal = true; break; }
    const action = stateRow.policy;
    if (!action) break;
    const apps = mdpResult.appsPerState?.get?.(i);
    const app = apps?.find?.((a) => a.actionId === action);
    if (!app) break;
    const outcome = sampleOutcome(app.outcomes, rng);
    if (!outcome) break;
    const stepCostEx = outcome.costEx ?? 0;
    const stepCostSec = outcome.costSec ?? 0;
    // Budget guard: if this step would push us over the cap, refuse
    // to take it. Truncate at the cap value (cost = budgetCap) so the
    // user-facing histogram piles up cleanly at the right edge rather
    // than scattering above the line.
    if (budgetCap != null && totalEx + stepCostEx > budgetCap) {
      truncated = true;
      // Charge the partial cost up to the cap so totalEx == budgetCap
      // for any over-budget abandonment. Without this, two over-budget
      // truncations at different points produce different totalEx
      // values and the right-edge bar smears.
      const partial = Math.max(0, budgetCap - totalEx);
      steps.push({
        from: stateRow.key,
        action,
        costEx: partial,
        costSec: stepCostSec,
        to: null,
        sampledProb: outcome.prob,
        budgetTruncated: true,
      });
      totalEx += partial;
      totalSec += stepCostSec;
      orbCounts[action] = (orbCounts[action] ?? 0) + 1;
      break;
    }
    steps.push({
      from: stateRow.key,
      action,
      costEx: stepCostEx,
      costSec: stepCostSec,
      to: mdpResult.states[outcome.to]?.key,
      sampledProb: outcome.prob,
    });
    totalEx += stepCostEx;
    totalSec += stepCostSec;
    orbCounts[action] = (orbCounts[action] ?? 0) + 1;
    if (action === 'buy_base') {
      buyBaseEvents++;
      if (buyBaseEvents > maxRestarts) { truncated = true; break; }
    }
    i = outcome.to;
  }

  const finalState = mdpResult.states[i]?.state;
  const concreteItem = finalState
    ? buildConcreteItem(finalState, wishlist)
    : null;

  return {
    steps,
    finalStateKey: mdpResult.states[i]?.key,
    totalEx, totalSec,
    reachedGoal,
    reachedBrick: !reachedGoal && !truncated && steps.length === 0
      ? false
      : false, // detection is via final state's `irrFractured` or wrong fracturedBit
    truncated,
    buyBaseEvents,
    orbCounts,
    concreteItem,
  };
}

/**
 * Pick one outcome from a list using cumulative-probability sampling.
 * Falls back to the last outcome if rounding leaves the random value
 * just above the total — defensive against `Σ prob ≠ 1.0` edge cases.
 */
export function sampleOutcome(outcomes, rng) {
  if (!outcomes?.length) return null;
  const r = rng();
  let acc = 0;
  for (const o of outcomes) {
    acc += o.prob;
    if (r <= acc) return o;
  }
  return outcomes[outcomes.length - 1];
}

/**
 * Translate the final MDP state into a "concrete item" shape suitable
 * for display and for piping into the Divine Bench. Wished mods set
 * in `modMask` are listed by name; irrelevant slots are reported as
 * a count only (we don't track which specific irrelevant rolled).
 */
function buildConcreteItem(state, wishlist) {
  const wishedModNames = [];
  for (let i = 0; i < wishlist.length; i++) {
    if (state.modMask & (1 << i)) wishedModNames.push(wishlist[i].key);
  }
  const fracturedKey = state.fracturedBit >= 0
    ? wishlist[state.fracturedBit]?.key ?? null
    : null;
  return {
    rarity: state.rarity,
    affixCount: state.totalMods,
    mask: state.modMask,
    fracturedBit: state.fracturedBit,
    fracturedKey,
    irrFractured: state.irrFractured,
    boneMod: state.boneMod,
    boneRevealed: state.boneRevealed,
    wishedModNames,
    irrelevantCount: state.totalMods - wishedModNames.length,
  };
}

/**
 * Build a concrete item suitable for the Divine Bench: each wished
 * affix that ended up on the item is assigned a tier (from the
 * wishlist's requiredTier) and a rolled value from `modRanges`
 * lookup + `rollValue`. Caller passes the parsed mod-range table
 * (already per-base/per-mod/per-tier) and an RNG.
 *
 * Irrelevant slots are NOT enumerated (we don't track which specific
 * irrelevant landed). For Divine Bench purposes, the user typically
 * cares about the wished mods' value-roll math anyway.
 *
 * @param {object} concreteItem — output of sampleTrajectory's
 *   `concreteItem` field (the final-state shape).
 * @param {object[]} wishlist — input.wishlist [{ key, requiredTier, ... }].
 * @param {object} modRanges — { [base]: { [modName]: { [tier]: rangeText } } }.
 * @param {string} base — current item base id.
 * @param {() => number} [rng]
 * @returns {object[]} affixes — [{ side, tier, value, vmin, vmax, name, fractured }]
 */
export function buildConcreteAffixes({ concreteItem, wishlist, modRanges, base, rng = Math.random, parseModRange, rollValue }) {
  const affixes = [];
  if (!concreteItem) return affixes;
  for (const wishedKey of (concreteItem.wishedModNames ?? [])) {
    const w = wishlist.find((x) => x.key === wishedKey);
    if (!w) continue;
    const [sideRaw, ...nameParts] = wishedKey.split(':');
    const side = sideRaw === 'PREFIX' ? 'PREFIX' : 'SUFFIX';
    const name = nameParts.join(':');
    const tier = Number.isFinite(w.requiredTier) ? w.requiredTier : 1;
    const rangeText = modRanges?.[base]?.[name]?.[String(tier)]
                   ?? modRanges?.[base]?.[name]?.[tier];
    let vmin, vmax, value;
    if (rangeText && parseModRange) {
      const parsed = parseModRange(rangeText);
      if (parsed) {
        vmin = parsed.vmin;
        vmax = parsed.vmax;
        value = rollValue ? rollValue(parsed, rng) : (parsed.vmin + parsed.vmax) / 2;
      }
    }
    affixes.push({
      side,
      tier,
      value: value ?? 0,
      vmin, vmax,
      name,
      fractured: wishedKey === concreteItem.fracturedKey,
    });
  }
  return affixes;
}

/**
 * Mulberry32 — small, fast, seedable PRNG. For deterministic tests.
 */
export function mulberry32(seed) {
  let t = seed >>> 0;
  return function () {
    t = (t + 0x6D2B79F5) >>> 0;
    let r = t;
    r = Math.imul(r ^ (r >>> 15), r | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}
