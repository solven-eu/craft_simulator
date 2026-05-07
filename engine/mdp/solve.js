// Public entry point for MDP-α.
//
// Input: a self-contained problem description.
// Output: optimal value V*, optimal policy π*, action graph (chain
// shape compatible with the existing Mermaid renderer), and the
// expected cost / steps from the start state.
//
// The architecture is deliberately input-pure / output-pure so unit
// tests can pin behaviour without touching the rest of the codebase.
// Same input ⇒ same output, regardless of what UI changes around it.
//
// Input shape (all fields required unless marked optional):
//
//   wishlist:                 [{ key, weight, fractured?: bool }]
//   target: {
//     requiredMods:           [key]               // every required mod must be present
//     fracturedKey?:          key | null          // which mod (if any) must be fractured
//   }
//   irrelevantWeight:         number              // sum of pool weights NOT in wishlist
//   start: {
//     rarity:                 'normal'|'magic'|'rare'
//     modsOnItem?:            [key]               // wished mods already on item (default [])
//     totalMods?:             number              // default = modsOnItem.length
//     fracturedKey?:          key | null
//   }
//   orbCosts:                 { alch, exalt, annul, fracturing }   // ex per use
//   orbTimes:                 { alch, exalt, annul, fracturing }   // sec per use
//   basePriceEx:              number              // ex to buy a fresh Normal base
//   basePriceSec?:            number              // default 60 (≈ 1 min to source a fresh base)
//   timeWeightExPerSec?:      number              // default 0 (pure-ex objective)
//   maxFilled?:               number              // default 6
//   alchemyDraws?:            number              // default 4
//   minModsToFracture?:       number              // default 4 (PoE2 spec; user may override)
//
// Output:
//   {
//     vStar:                   number              // unified cost-to-goal from start
//     policy:                  Map<stateKey, actionId>
//     start:                   { stateKey, state }
//     states:                  [{ key, state, vStar, policy }]   // BFS order
//     chain:                   { states, edges, ... }            // Mermaid-compatible
//     pSucceedWithinBudget?:   number              // future
//   }

import { ACTIONS, makeEssenceAction, makePerfectEssenceOverwriteAction } from './actions.js';
import { makeState, stateKey, isGoalState, isBrickedByFracture, popcount } from './state.js';
import { buildStateSpace, valueIterate } from './value-iteration.js';

export function solveMDP(input) {
  // ---- Normalise wishlist + target → bit indices ------------
  const wishlist = input.wishlist ?? [];
  const N = wishlist.length;
  // Hard cap: state space grows as 2^N × (rarity × totalMods ×
  // fracturedBit × irrFractured × boneMod × boneRevealed). At N=12
  // the worst case is ~250k states × ~7 actions per state = manageable
  // but slow to value-iterate. JS Number safely encodes the modMask
  // up to N=53 (Number.MAX_SAFE_INTEGER bit width) so the bitmask
  // itself isn't the limit; state-space size is. Lifting from 8 → 12
  // covers most realistic wishlists; bump further only if you've
  // confirmed solve performance is acceptable.
  const MAX_WISHLIST_ENTRIES = 12;
  if (N > MAX_WISHLIST_ENTRIES) {
    throw new Error(
      `MDP-α supports up to ${MAX_WISHLIST_ENTRIES} wished entries; got ${N}. `
      + `State space grows as 2^N — beyond 12 the value iteration is slow. `
      + `Consider splitting the wishlist or relaxing some entries to optional.`,
    );
  }
  const keyToBit = new Map();
  wishlist.forEach((w, i) => keyToBit.set(w.key, i));
  const wishlistWeights = wishlist.map((w) => w.weight ?? 0);
  const totalPoolWeight = wishlistWeights.reduce((a, b) => a + b, 0)
    + (input.irrelevantWeight ?? 0);
  const requiredMask = (input.target?.requiredMods ?? []).reduce((m, k) => {
    const bit = keyToBit.get(k);
    if (bit === undefined) throw new Error(`required mod "${k}" not in wishlist`);
    return m | (1 << bit);
  }, 0);
  const fracturedBit = input.target?.fracturedKey != null
    ? (keyToBit.get(input.target.fracturedKey) ?? -1) : -1;
  // Translate per-wished desecration-constraint key lists into
  // bitmasks. Goal predicate consumes these to enforce
  // "must / must-not be desecrated" on each affix.
  const buildMask = (keys) => (keys ?? []).reduce((m, k) => {
    const bit = keyToBit.get(k);
    if (bit === undefined) return m;
    return m | (1 << bit);
  }, 0);
  const target = {
    requiredMask,
    fracturedBit,
    desecrationRequiredMask:  buildMask(input.target?.desecrationRequiredMods),
    desecrationForbiddenMask: buildMask(input.target?.desecrationForbiddenMods),
    // Optional acceptance bounds on final totalMods. Distinct from
    // env.maxFilled (the game-rule cap on what a Rare can carry during
    // crafting). See isGoalState for semantics.
    minFilled: input.target?.minFilled ?? null,
    maxFilled: input.target?.maxFilled ?? null,
  };

  // ---- Build the start state ------------
  const startMods = input.start?.modsOnItem ?? [];
  let startMask = 0;
  for (const k of startMods) {
    const bit = keyToBit.get(k);
    if (bit === undefined) throw new Error(`start mod "${k}" not in wishlist`);
    startMask |= (1 << bit);
  }
  const startFracBit = input.start?.fracturedKey != null
    ? (keyToBit.get(input.start.fracturedKey) ?? -1) : -1;
  // Starting desecrated provenance: at most one slot is desecrated
  // (engine one-cap rule). When the desecrated key matches a wishlist
  // entry, set its bit in desecratedWishedMask; the prefix/suffix
  // count is bumped only for the prefix-side case.
  const startDesecKey = input.start?.desecratedKey ?? null;
  const startDesecSide = input.start?.desecratedSide ?? null;
  let startDesecratedWishedMask = 0;
  let startDesecratedIrrPrefix = 0;
  let startDesecratedIrrSuffix = 0;
  if (startDesecKey) {
    const bit = keyToBit.get(startDesecKey);
    if (bit !== undefined) {
      // Starting desecrated affix matches a wished bit — record it
      // as a wished-desecrated.
      startDesecratedWishedMask |= (1 << bit);
    } else if (startDesecSide === 'PREFIX') {
      // Starting desecrated affix is irrelevant prefix-side.
      startDesecratedIrrPrefix = 1;
    } else {
      // Default: irrelevant suffix-side.
      startDesecratedIrrSuffix = 1;
    }
  }
  // Pending unrevealed bone-mod on the starting item. When the user
  // checks "the item has an applied-but-not-revealed bone affix", we
  // start at boneMod=true so the engine offers reveal_bone as the
  // first action. The bone itself is a phantom slot — apply_bone's
  // own gate (boneMod=false AND no desecrated mod on item) prevents
  // a second bone, regardless of whether the desecrated counters
  // already register the pending one.
  const startBoneMod = !!input.start?.boneMod;
  const start = makeState({
    rarity: input.start?.rarity ?? 'normal',
    modMask: startMask,
    totalMods: input.start?.totalMods ?? startMods.length,
    prefixMods: input.start?.prefixMods ?? 0,
    desecratedWishedMask: startDesecratedWishedMask,
    desecratedIrrPrefix: startDesecratedIrrPrefix,
    desecratedIrrSuffix: startDesecratedIrrSuffix,
    fracturedBit: startFracBit,
    irrFractured: false,
    boneMod: startBoneMod,
    boneRevealed: false,
  });

  // ---- Env (immutable, passed to every transition) ----------
  // pTierAcceptable[actionId][i] = P(this orb, having drawn wished
  // mod i, lands at an acceptable tier per the user's per-mod
  // requiredTier). Precomputed by the adapter from each mod's tier
  // weight table and the orb's tier filter; the engine just looks
  // it up. Plain orbs typically map all-1.0 (no filter); Perfect
  // orbs map 1.0 for mods within the orb's filter and 0 otherwise.
  // Missing entries default to 1.0 (legacy / non-tier-aware setups
  // behave as MDP-α).
  const wishlistTypes = wishlist.map((w) => w.type ?? null);
  const env = {
    wishlistWeights,
    wishlistTypes,
    pTierAcceptable: input.pTierAcceptable ?? {},
    totalPoolWeight,
    irrelevantWeight: input.irrelevantWeight ?? 0,
    // Side-typed irrelevant pool sums for omen-augmented orbs
    // (Sinistral / Dextral). Adapter computes from the typed full
    // pool. Defaults to {} when caller doesn't provide; side-filtered
    // actions then degrade to "no irrelevant on this side", which
    // makes them inapplicable in practice.
    irrelevantWeightBySide: input.irrelevantWeightBySide ?? {},
    maxFilled: input.maxFilled ?? 6,
    alchemyDraws: input.alchemyDraws ?? 4,
    // PoE2 rule: Fracturing Orb requires a Rare item with ≥4 mods.
    // (Earlier code had 3 — that was a misread by the assistant; the
    // canonical PoE2 rule is 4. Workaround: a Bone-class desecrated
    // currency adds a HIDDEN mod that brings totalMods up to 4 but
    // can't itself be fracture-locked, so the per-attempt success
    // odds match what the user would expect from a "3-mod-fracture"
    // mental model — but the count threshold is still 4.)
    minModsToFracture: input.minModsToFracture ?? 4,
    orbCosts: input.orbCosts ?? {},
    orbTimes: input.orbTimes ?? {},
    basePriceEx: input.basePriceEx ?? 0,
    // Default 60 sec ≈ 1 minute to find + price-check + buy a fresh
    // base from trade. Treating base procurement as instant
    // under-counted the wall-clock cost of buy_base loops; the MDP
    // would over-pick "abandon and re-buy" when the user's actual
    // time-to-acquire is non-trivial. Override via input.basePriceSec
    // when SSF or hideout-stash sourcing applies.
    basePriceSec: input.basePriceSec ?? 60,
    // Bone-trick: cheapest applicable Bone-class desecrated currency
    // (e.g. Gnawed/Preserved/Ancient Collarbone). Setting NaN ⇒
    // `apply_bone` action is silently excluded (handled by the same
    // optional-variant skip rule as Greater/Perfect orbs).
    boneCostEx: input.boneCostEx ?? NaN,
    boneTimeSec: input.boneTimeSec ?? 1,
    // Per-wished-mod hit probability for the bone REVEAL step. Models
    // the "3 random affixes shown, pick best" mechanic: P(specific
    // wished i landed) = 1 - (1 - p_pick)^3 where p_pick is the
    // wished's weight share in the bone's affix pool. Adapter computes
    // from extra_mods.json (per-base desecrated pool). Defaults to all
    // zeros so reveal lands an irrelevant desecrated affix when no
    // wished mod is in the desecrated pool — typical for wishlists
    // that target normal-pool mods.
    pBoneRevealHit:        input.pBoneRevealHit        ?? [],
    // Side-filtered variants (Sinistral / Dextral Necromancy omens)
    // and the 6-pick re-roll variant (Abyssal Echoes). Each is the
    // same shape as pBoneRevealHit but with the pool / pick-count
    // adjustment baked in — adapter precomputes from extra_mods.
    pBoneRevealHitPrefix:  input.pBoneRevealHitPrefix  ?? [],
    pBoneRevealHitSuffix:  input.pBoneRevealHitSuffix  ?? [],
    pBoneRevealHitAbyssal: input.pBoneRevealHitAbyssal ?? [],
  };

  // ---- Build action set + missing-rate handling ------------
  // Default: hard-fail when any action's rate is missing (NaN). Silent
  // dropping caused a live-craft bug — the MDP picked an obviously
  // sub-optimal action because cheap alternatives had unseeded rates.
  // Callers who genuinely want partial-rate behaviour opt in via
  // `allowMissingRates: true`; dropped actions surface in `warnings`.
  //
  // SECOND filter (after rate-availability): per-orb cost vs budget.
  // If a single use of an orb exceeds `input.budgetEx`, the user
  // literally can't afford to take that action — exclude it. This
  // forces the solver to find a "best effort" policy under the budget
  // constraint (e.g. exalt-spam instead of perfect-exalt when the
  // user is broke), and we surface each excluded action so the UI can
  // recommend a budget bump that would unlock it.
  const allowMissing = !!input.allowMissingRates;
  const warnings = [];
  const missing = [];
  const budgetExcluded = [];
  const actionList = [];
  const budgetCap = (input.budgetEx != null && Number.isFinite(input.budgetEx))
    ? input.budgetEx : null;
  for (const action of Object.values(ACTIONS)) {
    if (action.id === 'buy_base') {
      if (!Number.isFinite(env.basePriceEx)) {
        missing.push('basePriceEx');
        if (allowMissing) warnings.push('Action "buy_base" excluded: missing rate basePriceEx.');
        continue;
      }
      // Treat buy_base as a perpetual escape hatch — never gated by
      // budget (the user always can drop the in-progress item). If we
      // gated it the engine would have no terminal action when every
      // orb is over-budget, and value iteration would diverge.
      actionList.push(action);
      continue;
    }
    // Bone action reads its cost from env.boneCostEx, not orbCosts —
    // the cost is sourced separately from desecrated currencies, not
    // the orb-rate list. Optional: silent skip if no bone is priced.
    if (action.id === 'apply_bone') {
      if (!Number.isFinite(env.boneCostEx)) continue;
      if (budgetCap != null && env.boneCostEx > budgetCap) {
        budgetExcluded.push({ actionId: action.id, costEx: env.boneCostEx });
        warnings.push(
          `Action "apply_bone" excluded: per-use cost ${env.boneCostEx.toFixed(2)} ex `
          + `exceeds budget ${budgetCap.toFixed(2)} ex. Raise budget to ≥ `
          + `${env.boneCostEx.toFixed(2)} ex to unlock.`,
        );
        continue;
      }
      actionList.push(action);
      continue;
    }
    // Reveal-bone family (plain + Sinistral/Dextral/Abyssal omen
    // variants). All gated on bone availability (apply_bone has to
    // be reachable) and on the variant's hit-probability array
    // being supplied — the omen-augmented variants are silently
    // skipped if the adapter didn't compute their hit probabilities
    // (typically because the corresponding omen has no rate, or
    // because the desecrated pool is empty for this base).
    if (/^reveal_bone(?:_(?:sinistral|dextral|abyssal))?$/.test(action.id)) {
      if (!Number.isFinite(env.boneCostEx)) continue;
      // Plain reveal_bone is always available alongside apply_bone.
      // Omen variants require a non-empty hit-prob array AND a
      // priced reveal action (cost = omen price). When the cost
      // entry is missing entirely we still admit the action with
      // cost=0 fallback — the engine will quickly drop it via Q-
      // value comparison if the omen rule provides no benefit.
      actionList.push(action);
      continue;
    }
    // annul_omen_of_light: same bone-availability gate as reveal_bone
    // (the cleanup loop only matters when desecration is on the
    // table). Cost = base annul + omen-of-light. Silently skipped if
    // the priced cost is missing (no Omen of Light rate) — engine
    // gracefully degrades to "no cleanup tool, one-cap is hard."
    if (action.id === 'annul_omen_of_light') {
      if (!Number.isFinite(env.boneCostEx)) continue;
      const c = env.orbCosts[action.id];
      if (!Number.isFinite(c)) continue;
      if (budgetCap != null && c > budgetCap) {
        budgetExcluded.push({ actionId: action.id, costEx: c });
        warnings.push(
          `Action "annul_omen_of_light" excluded: per-use cost ${c.toFixed(2)} ex `
          + `exceeds budget ${budgetCap.toFixed(2)} ex.`,
        );
        continue;
      }
      actionList.push(action);
      continue;
    }
    const cost = env.orbCosts[action.id];
    if (!Number.isFinite(cost)) {
      // Greater / Perfect orb variants are optional — silently skip
      // if the user hasn't priced them, even in strict mode. Missing
      // a *plain* orb rate (transmute / regal / exalt / alch / annul
      // / fracturing) is still an error in strict mode since plain
      // orbs are baseline assumptions in PoE2; a missing rate there
      // signals a config gap.
      // Optional variants — silently exclude when missing instead of
      // erroring in strict mode:
      //   - Quality (Greater/Perfect) variants and omen-augmented
      //     (Sinistral/Dextral) variants of the standard orbs.
      //   - Plain `chaos` itself: chaos is recent in this engine
      //     (added MDP-η), legacy test scenarios don't supply its
      //     rate, and the adapter resolves it via the catalog default
      //     in production. Treating it as mandatory would break
      //     every pre-chaos test scenario.
      // Missing a *plain* legacy orb rate (transmute / regal / exalt
      // / alch / annul / fracturing) is still a real config gap and
      // raises in strict mode.
      const isOptionalVariant = /^chaos(?:_greater|_perfect)?$/.test(action.id)
        || /_(?:greater|perfect|sinistral|dextral)$/.test(action.id);
      if (isOptionalVariant) continue;
      missing.push(`orbCosts.${action.id}`);
      if (allowMissing) warnings.push(`Action "${action.id}" excluded: missing rate (orbCosts.${action.id}).`);
      continue;
    }
    if (budgetCap != null && cost > budgetCap) {
      budgetExcluded.push({ actionId: action.id, costEx: cost });
      warnings.push(
        `Action "${action.id}" excluded: per-orb cost ${cost.toFixed(2)} ex `
        + `exceeds budget ${budgetCap.toFixed(2)} ex. Raise budget to ≥ `
        + `${cost.toFixed(2)} ex to unlock.`,
      );
      continue;
    }
    actionList.push(action);
  }
  if (missing.length && !allowMissing) {
    throw new Error(
      `solveMDP: missing rate(s): ${missing.join(', ')}. `
      + `Pass them in input.orbCosts / input.basePriceEx, or opt into `
      + `partial-rate mode with input.allowMissingRates = true.`,
    );
  }

  // ---- Inject dynamic essence actions ──────────────────────────
  // Each entry in input.essences becomes a distinct MDP action with
  // its own cost / matched bits / tier acceptance. The adapter has
  // already filtered to essences applicable to the item class with
  // matched_mods overlapping the wishlist, so this list is small
  // (typically 0-6 entries). Budget gating applies as for orb
  // actions; missing/NaN cost is silently skipped.
  for (const ess of (input.essences ?? [])) {
    if (!ess?.id || !Number.isFinite(ess.costEx)) continue;
    if (budgetCap != null && ess.costEx > budgetCap) {
      budgetExcluded.push({ actionId: ess.id, costEx: ess.costEx });
      warnings.push(
        `Action "${ess.id}" excluded: per-orb cost ${ess.costEx.toFixed(2)} ex `
        + `exceeds budget ${budgetCap.toFixed(2)} ex. Raise budget to ≥ `
        + `${ess.costEx.toFixed(2)} ex to unlock.`,
      );
      continue;
    }
    // Two essence shapes:
    //   - 'magic_to_rare' (default — Lesser/Normal/Greater): upgrades
    //     a Magic item to Rare with the affix guaranteed.
    //   - 'rare_overwrite' (Perfect/Corrupted): overwrites a random
    //     affix on a Rare item with the essence's affix.
    if (ess.mode === 'rare_overwrite') {
      actionList.push(makePerfectEssenceOverwriteAction(ess, keyToBit, env));
    } else {
      actionList.push(makeEssenceAction(ess, keyToBit));
    }
  }

  // ---- Build state space + solve via value iteration -------
  const { states, stateIdx, appsPerState, startIdx } = buildStateSpace({
    start, actions: actionList, env, target,
  });
  const { vStar, policy, iters, converged, lastDelta } = valueIterate({
    states, appsPerState, target,
    timeWeightExPerSec: input.timeWeightExPerSec ?? 0,
  });
  if (!converged) {
    warnings.push(
      `value iteration hit maxIters (${iters}) without converging — ` +
      `lastDelta=${lastDelta?.toExponential(2)}. V* values are partial; ` +
      `optimal policy may flip if maxIters is raised. Often signals a ` +
      `near-impossible scenario (very low per-attempt success and ` +
      `expensive recovery — slow contraction toward fixed point).`,
    );
  }

  // ---- Output: per-state value + chain ----------
  const stateRows = states.map((s, i) => ({
    key: stateKey(s),
    state: s,
    vStar: vStar[i],
    policy: policy[i],
    isGoal: isGoalState(s, target),
    isBricked: isBrickedByFracture(s, target),
  }));
  const chain = buildChain({ states, appsPerState, vStar, policy, target, startIdx,
    wishlist,
    basePriceEx: input.basePriceEx ?? 0,
    budgetEx: input.budgetEx ?? null,
    timeWeightExPerSec: input.timeWeightExPerSec ?? 0,
    // Toggle for step-id prefix on node labels. Default on so debug
    // conversations can refer to "step s5" unambiguously; callers
    // can set false when the chart is too dense and the prefix
    // adds visual noise.
    showStepIds: input.showStepIds ?? true });

  // Surface chain-node label collisions as warnings on the top-level
  // result. Each duplicate group means two distinct chain nodes
  // render the same text — a hint that a state-rendering or BFS
  // dedup bug is hiding behind otherwise-clean output.
  if (chain?.duplicateLabels?.length) {
    for (const dup of chain.duplicateLabels) {
      warnings.push(
        `Duplicate chain-node labels (${dup.ids.length} nodes): `
        + `${dup.ids.join(', ')} — label="${dup.label.replace(/\n/g, ' \\n ')}"`,
      );
    }
  }

  return {
    vStar: vStar[startIdx],
    expectedSteps: null,                       // could derive from per-state H*
    policy: new Map(stateRows.map((r, i) => [r.key, policy[i]])),
    start: { stateKey: stateRows[startIdx].key, state: start },
    states: stateRows,
    chain,
    iters,
    converged,
    warnings,
    // Expose the per-state action applications + their outcome
    // distributions so callers can sample trajectories through the
    // optimal policy (engine/mdp/sample.js). Map<stateIdx,
    // ActionApplication[]> where each application is
    // { actionId, outcomes: [{ to, prob, costEx, costSec }] }.
    appsPerState,
    startIdx,
    // Per-orb actions excluded because their per-use cost is above the
    // user's `budgetEx`. UI surfaces this as "raise budget to ≥ X to
    // unlock orb Y" — addresses the case where a user is doing best-
    // effort under a tight budget and would benefit from knowing what
    // a budget bump would unlock (e.g. Perfect Exalt vs plain Exalt).
    budgetExcluded,
    // Expose the budget cap as a sampler input, so trajectories can
    // truncate when they exceed budget. Otherwise null = unbounded.
    budgetCap,
  };
}

// ---- Chain serialiser (compatible with the existing Mermaid renderer)
//
// The graph reflects what the user would ACTUALLY DO under the optimal
// policy:
//   - Walk π* from `start` via BFS — only reachable-under-optimal states
//     end up in the rendered graph. (Earlier we emitted every BFS-
//     discovered state; that produced orphan nodes that the user
//     spotted as "where do these even come from?".)
//   - States whose optimal action is `buy_base` are rendered as
//     `bricked` — operationally the policy says "stop and restart this
//     branch." Their outgoing reset edge is intentionally suppressed
//     (the bricked styling already implies "go back to start").
//   - Strict-bricked states (goal-unreachable under any action) keep
//     the same `bricked` kind too — the renderer doesn't need to
//     distinguish "near-trap" from "strict trap" for this purpose.
function buildChain({ states, appsPerState, vStar, policy, target, startIdx, budgetEx, timeWeightExPerSec, showStepIds = true, wishlist = [], basePriceEx = 0 }) {
  // Percentages read more naturally for orb-outcome odds. Below 0.01% use
  // scientific so 1e-6-class outcomes stay visible.
  const fmtP = (p) => {
    const pct = p * 100;
    if (pct < 0.01) return `${pct.toExponential(1)}%`;
    if (pct < 1)    return `${pct.toFixed(2)}%`;
    return `${pct.toFixed(1)}%`;
  };
  const fmtV = (v) => Number.isFinite(v)
    ? (v < 100 ? v.toFixed(2) : v.toFixed(0))
    : '∞';
  // itemValue(s) = expected profit of a single committed crafting
  // attempt with NO restart-on-brick. Backward induction on the chain
  // DAG:
  //   itemValue(goal)          = budgetEx
  //   itemValue(brick)         = 0          (give up the item, no recovery)
  //   itemValue(buy_base node) = 0          (policy says restart — count as "abandon")
  //   itemValue(s)             = -cost(π*(s)) + Σ p(o) · itemValue(o.next)
  //
  // For the canonical fractured-bow chain this gives:
  //   pre-fracture  → (budget − 2·annul)/3 − fracture_cost
  //   post-fracture → budget − 2·annul
  //   pre-1-annul   → budget − annul
  //   goal          → budget
  // i.e. exactly the recursive formula the user spelled out. The cost
  // is paid once per orb use (same value across outcomes of an action),
  // and brick / buy_base contribute 0 — capturing "you'd give up here,
  // not pay 100 for a fresh base and try again."
  // budgetEx=null ⇒ skip rendering (no value baseline given).
  const fmtVal = (v) => {
    if (!Number.isFinite(v)) return '−∞';
    if (Math.abs(v) < 0.5) return '0';
    if (Math.abs(v) < 100) return v.toFixed(1);
    return v.toFixed(0);
  };
  // BFS reachable-under-optimal-policy from start, computing P_reach
  // along the way. P_reach(s) = probability of arriving at s when
  // following π* from start (treating buy_base / bricked as absorbing
  // restart — we don't propagate through them). For pre-fracture
  // states P_reach=1; for post-fracture-success states P_reach equals
  // the success probability of the upstream fracture (e.g. 1/3 for a
  // 3-mod Rare). Lets the user compute "expected contribution" =
  // P_reach × itemValue if that framing is what they want, while we
  // keep the in-state itemValue = budget − V*(s) as the headline
  // number.
  const reachable = new Set();
  const pReach = new Map();
  pReach.set(startIdx, 1);
  // BFS in topological-ish order: process state, push successors with
  // accumulated probability. Cycles (e.g. annul-no-op self-loops) are
  // safe because a state's pReach can only increase; we cap iterations
  // by a node-visit count.
  const queue = [startIdx];
  const visited = new Array(states.length).fill(0);
  while (queue.length) {
    const i = queue.shift();
    if (visited[i] > 16) continue; // safety: bounded re-visits on cycles
    visited[i]++;
    reachable.add(i);
    if (isGoalState(states[i], target)) continue;
    const a = policy[i];
    if (!a || a === 'buy_base') continue;
    if (isBrickedByFracture(states[i], target)) continue;
    const apps = appsPerState.get(i) ?? [];
    const app = apps.find((x) => x.actionId === a);
    if (!app) continue;
    const piHere = pReach.get(i) ?? 0;
    for (const o of app.outcomes) {
      // Self-loop (annul on no-removable): skip pReach accumulation,
      // it would double-count without changing anything.
      if (o.to === i) continue;
      const prev = pReach.get(o.to) ?? 0;
      pReach.set(o.to, prev + piHere * o.prob);
      queue.push(o.to);
    }
  }
  // ---- Forward-pass secondary value: `valueFromBase` ----
  // Per user direction (corrected 2026-05-07):
  //   fromBase(start) = basePriceEx
  //   fromBase(s)     = min over incoming (parent → s, prob, cost)
  //                     of [fromBase(parent) / prob + cost]
  //
  // Reading: the in-progress item carries an expected "market value"
  // proportional to how rare it is. Each transition INFLATES the
  // parent's value by 1/prob (a 10% branch landed multiplies the
  // sunk cost by 10× — replicating this state in expectation
  // requires that many average attempts), then adds the orb cost
  // paid at this step. The MIN over incoming edges picks the
  // cheapest-to-replicate estimate.
  //
  // Note: low-probability transitions amplify fromBase super-
  // linearly. A chain of 1% branches makes fromBase explode — which
  // correctly reflects how rare the resulting item is.
  //
  // Complementary to the existing `fromBudget=...ex` line
  // (= pSuccess(s) × budgetEx + bExpected(s), backward induction
  // from goal):
  //   - `fromBudget` = forward-going expected payoff under π*
  //                    (what this state is worth, given budget)
  //   - `fromBase`   = expected sunk-cost replicate-value
  //                    (what an in-expectation copy of this state
  //                     would cost to produce from base)
  const valueFromBase = new Map();
  valueFromBase.set(startIdx, basePriceEx);
  const unifiedCostFwd = (ex, sec) => ex + sec * (timeWeightExPerSec ?? 0);
  for (let iter = 0; iter < 64; iter++) {
    let changed = false;
    for (const i of reachable) {
      if (isGoalState(states[i], target)) continue;
      const a = policy[i];
      if (!a || a === 'buy_base') continue;
      if (isBrickedByFracture(states[i], target)) continue;
      const apps = appsPerState.get(i) ?? [];
      const app = apps.find((x) => x.actionId === a);
      if (!app) continue;
      const parentVal = valueFromBase.get(i);
      if (parentVal == null) continue;
      const stepCost = unifiedCostFwd(app.outcomes[0].costEx ?? 0, app.outcomes[0].costSec ?? 0);
      for (const o of app.outcomes) {
        if (o.to === i) continue;       // skip self-loops
        if (!(o.prob > 0)) continue;    // unreachable branch — guard against /0
        // Replicate-value form: parent fromBase divided by branch
        // probability (the "luck multiplier" needed in expectation
        // to land this branch), plus the orb cost paid at this step.
        const candidate = parentVal / o.prob + stepCost;
        const prev = valueFromBase.get(o.to);
        if (prev == null || candidate < prev) {
          valueFromBase.set(o.to, candidate);
          changed = true;
        }
      }
    }
    if (!changed) break;
  }

  // ---- itemValueAlt via backward induction over the reachable chain ----
  // Cycles in the chain DAG are rare but possible (e.g. an annul-no-op
  // self-loop on a state where every removable mod is fractured). We
  // run a fixed-point iteration with a damping rule: terminals (goal /
  // brick / buy_base) are pinned, and non-terminals are updated via
  // value-iteration-style sweeps. Since the underlying recurrence is
  // contractive whenever transitions either decrease totalMods (annul),
  // increase fracture-lock count, or hit an absorbing terminal, the
  // iteration converges in O(|chain|) sweeps even with self-loops —
  // self-loops contribute `(1 - p_self) · itemValue(s) = -cost + Σ p · v(o)`
  // which has a unique fixed point. We cap at 200 iterations + tol=1e-6.
  // Decompose itemValue(s) = pSuccess(s) · budget + bExpected(s)
  // (linear in budget). Useful because:
  //   - Together they let us compute itemValue at any budget without
  //     re-iterating: itemValue(s, B) = pSuccess(s) · B + bExpected(s).
  //   - Breakeven budget for the start state is `-bExpected(start) /
  //     pSuccess(start)`: the budget at which one committed attempt
  //     has expected profit zero (and any larger budget is profitable).
  // pSuccess(s) is the probability of reaching goal from s under π*
  // without bricking; bExpected(s) is the negated expected orb cost
  // along all branches under π* (always ≤ 0).
  const pSuccess = new Map();
  const bExpected = new Map();
  const unifiedCost = (ex, sec) => ex + sec * (timeWeightExPerSec ?? 0);
  for (const i of reachable) {
    pSuccess.set(i, isGoalState(states[i], target) ? 1 : 0);
    bExpected.set(i, 0);
  }
  for (let iter = 0; iter < 200; iter++) {
    let maxDelta = 0;
    for (const i of reachable) {
      if (isGoalState(states[i], target)) continue;
      if (policy[i] === 'buy_base') continue;
      if (isBrickedByFracture(states[i], target)) continue;
      const a = policy[i];
      if (!a) continue;
      const apps = appsPerState.get(i) ?? [];
      const app = apps.find((x) => x.actionId === a);
      if (!app) continue;
      const cost = unifiedCost(app.outcomes[0].costEx, app.outcomes[0].costSec);
      let pNext = 0, bNext = -cost;
      for (const o of app.outcomes) {
        pNext += o.prob * (pSuccess.get(o.to) ?? 0);
        bNext += o.prob * (bExpected.get(o.to) ?? 0);
      }
      const dp = Math.abs(pNext - (pSuccess.get(i) ?? 0));
      const db = Math.abs(bNext - (bExpected.get(i) ?? 0));
      if (dp > maxDelta) maxDelta = dp;
      if (db > maxDelta) maxDelta = db;
      pSuccess.set(i, pNext);
      bExpected.set(i, bNext);
    }
    if (maxDelta < 1e-6) break;
  }
  // Cycles in the chain DAG are rare but possible (e.g. an annul-no-op
  // self-loop on a state where every removable mod is fractured). The
  // value-iteration-style fixed point converges because every non-self
  // branch eventually hits an absorbing terminal (goal or brick/
  // buy_base), and self-loops have a unique fixed point. We cap at
  // 200 iterations + tol=1e-6.
  const itemValueAlt = new Map();
  if (budgetEx != null && Number.isFinite(budgetEx)) {
    for (const i of reachable) {
      const v = (pSuccess.get(i) ?? 0) * budgetEx + (bExpected.get(i) ?? 0);
      itemValueAlt.set(i, v);
    }
  }
  // Breakeven budget for the start state (smallest budget at which
  // itemValue(start) ≥ 0 under the "no-restart" formula). null if
  // pSuccess(start) = 0 (no path to goal under π*) — in that case no
  // budget makes crafting profitable.
  const pStart = pSuccess.get(startIdx) ?? 0;
  const bStart = bExpected.get(startIdx) ?? 0;
  const breakevenBudgetEx = pStart > 1e-9 ? (-bStart / pStart) : null;

  // Mod-name shortener — same shape as closed-form chains
  // (chaos-spam, exalt-annul-cycle) so labels read consistently
  // across all chart variants.
  //   "PREFIX:#% increased Evasion Rating" → "P:Evasion Rating"
  const shortName = (key) => {
    const [side, rest] = key.split(/:(.+)/);
    const tag = side === 'PREFIX' ? 'P' : side === 'SUFFIX' ? 'S' : '';
    const trim = (rest ?? '').replace(/[#%,]/g, '').replace(/\s+/g, ' ').trim();
    return `${tag}:${trim.slice(0, 26)}`;
  };
  // Build a per-state mod list label: one line per wished bit on the
  // item (★ if required, · if soft-wished), plus an irrelevant-count
  // line. Replaces the cryptic `mask=00000101` representation.
  const wIsReq = wishlist.map((w) => !!w.required);
  const wKeys  = wishlist.map((w) => w.key);
  const wTypes = wishlist.map((w) => w.type ?? null);
  const desecBit = (s, i) => !!((s.desecratedWishedMask ?? 0) & (1 << i));
  const stateModListLabel = (s) => {
    const onBits = [];
    for (let i = 0; i < wKeys.length; i++) {
      if (s.modMask & (1 << i)) onBits.push(i);
    }
    // Per-side wished counts (drives the irrelevant split below).
    let wishedPrefix = 0, wishedSuffix = 0;
    for (const i of onBits) {
      if (wTypes[i] === 'PREFIX') wishedPrefix++;
      else if (wTypes[i] === 'SUFFIX') wishedSuffix++;
    }
    const totalPrefix = s.prefixMods ?? 0;
    const totalSuffix = s.totalMods - totalPrefix;
    // Independent of the side split: exact total of irrelevant slots.
    const irrTotal  = s.totalMods - onBits.length;
    // Side-split — relies on prefixMods which isn't maintained by
    // every action; can be inaccurate.
    const irrPrefix = Math.max(0, totalPrefix - wishedPrefix);
    const irrSuffix = Math.max(0, totalSuffix - wishedSuffix);
    const sideUnknown = irrTotal > 0 && (irrPrefix + irrSuffix) === 0;
    const lines = [];
    for (const i of onBits) {
      const tag = wIsReq[i] ? '★' : '·';
      const desecMark = desecBit(s, i) ? ' 🦴' : '';
      lines.push(`${tag} ${shortName(wKeys[i])}${desecMark}`);
    }
    if (irrTotal > 0) {
      // Reuse the same `P:` / `S:` side-tag convention as wished
      // mods so the rendered list reads uniformly. The 🦴 mark
      // tracks how many of the irrelevant slots came from a Well-
      // of-Souls reveal (desecrated provenance) — read directly
      // from the per-side fields, no derivation needed.
      const desecPrefixIrr = s.desecratedIrrPrefix ?? 0;
      const desecSuffixIrr = s.desecratedIrrSuffix ?? 0;
      const pMark = desecPrefixIrr > 0 ? ` 🦴×${desecPrefixIrr}` : '';
      const sMark = desecSuffixIrr > 0 ? ` 🦴×${desecSuffixIrr}` : '';
      if (sideUnknown) {
        const allMark = (desecPrefixIrr + desecSuffixIrr) > 0
          ? ` 🦴×${desecPrefixIrr + desecSuffixIrr}` : '';
        lines.push(`· ?: ${irrTotal} irrelevant${allMark}`);
      } else {
        if (irrPrefix > 0) lines.push(`· P: ${irrPrefix} irrelevant${pMark}`);
        if (irrSuffix > 0) lines.push(`· S: ${irrSuffix} irrelevant${sMark}`);
      }
    }
    // (Per-side fingerprint footer like `(2P + 1S = 3)` was
    // surfaced earlier as a debug aid while we were chasing
    // state-consistency bugs — it's hidden by default now that
    // those bugs are fixed. Re-enable here if a future state
    // representation makes two distinct states share a label.)
    if (!lines.length) lines.push('(empty)');
    return lines.join('\n');
  };

  const chainStates = [];
  const chainEdges = [];
  const present = (i) => reachable.has(i);
  for (const i of reachable) {
    const s = states[i];
    const isGoal = isGoalState(s, target);
    const strictBricked = isBrickedByFracture(s, target);
    const policyBricked = policy[i] === 'buy_base';
    // Step ID at the top of every node — same id used as Mermaid
    // node id and as the chain-state's `id` field, so the user can
    // refer to a node as "step s5" in conversation / bug reports
    // and the engine output round-trips. Toggle via input.showStepIds
    // (default true) — set false to omit when the chart is too dense.
    // Rarity is rendered as the node's border colour (white=Normal,
    // blue=Magic, yellow=Rare) by the Mermaid serializer — see
    // chain-mermaid.js NODE_STYLE per-rarity entries. Dropped from
    // the label since the colour cue is more glance-able than a text
    // field and saves a line of vertical space per node.
    // Mod list (one line per wished mod on the item, plus a count
    // line for irrelevant slots split by side). Reads at a glance
    // what the item carries — replaces the cryptic `mask=00000101`
    // binary representation. The total mod count (`t=...`) is no
    // longer surfaced — it's redundant with the per-line breakdown
    // (sum the wished + irrelevant lines).
    let label = (showStepIds ? `[${`s${i}`}] ` : '')
              + stateModListLabel(s);
    // Fractured wished bit — render as the mod name (via shortName)
    // rather than a bare bit index, so two goals fractured on
    // different mods are visually distinguishable.
    if (s.fracturedBit >= 0 && wKeys[s.fracturedBit] != null) {
      label += `\n🔒 ${shortName(wKeys[s.fracturedBit])}`;
    } else if (s.fracturedBit >= 0) {
      label += `\n🔒 bit ${s.fracturedBit}`;
    }
    if (s.irrFractured) label += `\n💀 irr-fractured`;
    // Total desecrated count — surfaces even when there are no
    // irrelevant slots (in which case the per-irrelevant-line
    // appendix can't fire). Two goals that differ only in desec
    // would otherwise render identically. Derived from
    // `popcount(desecratedWishedMask) + irrPrefix + irrSuffix`.
    const totalDesec = popcount(s.desecratedWishedMask ?? 0)
      + (s.desecratedIrrPrefix ?? 0) + (s.desecratedIrrSuffix ?? 0);
    if (totalDesec > 0) {
      label += `\n🦴 desecrated×${totalDesec}`;
    }
    // Post-reveal flag distinguishes "bone was applied + revealed"
    // from "bone was never applied" when the wished bits coincide.
    if (s.boneRevealed && !s.boneMod) {
      label += `\n✓ bone revealed`;
    }
    // Unrevealed bone-mod is a special "phantom slot" — pads the
    // fracture-threshold check, can't be picked by Fracture/Annul,
    // and is a key crafting trick (the bone-trick + multi-bone
    // chains). Surface it explicitly so the chain reader can spot
    // states where this asset is in play. Once revealed, the affix
    // is a normal mod and shows up in totalMods like any other.
    if (s.boneMod && !s.boneRevealed) label += `\n🦴 unrevealed bone-mod`;
    let kind = 'transient';
    if (isGoal) kind = 'goal';
    else if (strictBricked || policyBricked) kind = 'bricked';
    // Render bricked V* as ∞: the displayed value should match the
    // visual cue. The internal V*(s) under our action set is finite
    // (buy_base = 100 + V*(start) is always available), but a bricked
    // node says "no in-place rescue from here" — that's the *intrinsic*
    // V* (= ∞), and the buy_base cost is captured by the implicit
    // restart edge. Showing finite V* alongside the red-skull styling
    // confused the user into thinking "wait, this isn't actually dead?"
    // — which it is, modulo paying for a fresh base.
    label += kind === 'bricked'
      ? `\nV*=∞ (restart costs ${fmtV(vStar[i])})`
      : `\nV*=${fmtV(vStar[i])}`;
    if (budgetEx != null && Number.isFinite(budgetEx)) {
      const raw = itemValueAlt.get(i);
      const val = Number.isFinite(raw) ? Math.max(0, raw) : 0;
      // `fromBudget`: backward-induction value from goal under π*
      // = pSuccess(s) × budgetEx + bExpected(s). Reads as "what this
      // state is worth going forward, given the user's budget cap."
      // Renamed from generic `value` to make the contrast with the
      // forward-pass `fromBase` explicit in the label.
      label += `\nfromBudget=${fmtVal(val)} ex`;
      // P_reach annotation: probability of landing here when following
      // π* from start. Useful alongside itemValue to compute "weighted
      // contribution to outcome." Skip on start (P=1) and goal
      // (implicit terminal state).
      const p = pReach.get(i) ?? 0;
      if (i !== startIdx && !isGoal && p > 0 && p < 1) {
        label += `\nP_reach=${fmtP(p)}`;
      }
    }
    // Secondary value: forward-pass value from base item (basePriceEx
    // × min cumulative probability through the chain). Always shown
    // when basePriceEx > 0 — it doesn't depend on budget.
    if (basePriceEx > 0) {
      const fv = valueFromBase.get(i);
      if (Number.isFinite(fv)) {
        label += `\nfromBase=${fmtVal(fv)} ex`;
      }
    }
    chainStates.push({
      id: `s${i}`,
      label,
      kind,
      // Rarity flows separately so the renderer can apply per-rarity
      // border colour (white/blue/yellow) without parsing the label.
      rarity: s.rarity,
      meta: { vStar: vStar[i], policy: policy[i] },
    });
  }
  // Edges: only outbound from non-bricked, non-goal states.
  for (const i of reachable) {
    const s = states[i];
    if (isGoalState(s, target)) continue;
    if (isBrickedByFracture(s, target)) continue;
    const a = policy[i];
    if (!a || a === 'buy_base') continue;
    const apps = appsPerState.get(i) ?? [];
    const app = apps.find((x) => x.actionId === a);
    if (!app) continue;
    // Single-outcome (deterministic) actions get a gray `internal` edge
    // regardless of V* delta — there's no branching for the user to
    // reason about, so colouring it as success/fail/improving carries
    // no information beyond the V* annotation already on the nodes.
    // Probabilistic actions colour each outcome by ΔV* delta.
    const isDeterministic = app.outcomes.length === 1;
    for (const o of app.outcomes) {
      if (!present(o.to)) continue; // shouldn't happen — BFS already pulled it in
      // Edge kind reflects how much closer the outcome gets us to the
      // goal — quantified by ΔV* = V*(s) - V*(s'). All four buckets show
      // up inside a single orb's outcome fan (e.g. transmute: hit wished
      // ⇒ big V* drop = success; hit irrelevant ⇒ small drop = improving;
      // brick ⇒ V* spikes = fail; nothing changed ⇒ flat = internal).
      // Threshold is tight (0.01%) on purpose: even a small V* uptick on
      // an irrelevant-mod hit (e.g. transmute on Normal landing a useless
      // affix and now you're stuck on a 1-mod Magic) deserves the `fail`
      // colour — the user reads outcome colours to spot which branch is
      // the lucky one. Equal-V* loops (rare in practice — usually means
      // the action is genuinely a no-op for that branch) stay `internal`.
      let kind = 'internal';
      if (!isDeterministic) {
        const v0 = vStar[i], v1 = vStar[o.to];
        if (isGoalState(states[o.to], target)) kind = 'success';
        else if (Number.isFinite(v0) && Number.isFinite(v1)) {
          if (v1 < v0 * 0.9999)      kind = 'improving';
          else if (v1 > v0 * 1.0001) kind = 'fail';
        }
      }
      chainEdges.push({
        from: `s${i}`, to: `s${o.to}`,
        label: `${a}\n${fmtP(o.prob)}`,
        kind,
        // Raw transition probability, exposed so the renderer can
        // scale edge stroke-width by likelihood (high-prob outcomes
        // appear thick; tail outcomes appear thin).
        prob: o.prob,
      });
    }
  }
  // Duplicate-label detector: distinct chain states should render
  // distinct labels. When two nodes share the same label modulo the
  // `[sN] ` step-id prefix, either (a) the BFS produced two indices
  // for genuinely-equivalent states (a dedupe bug — `stateKey`
  // should have collapsed them), or (b) the label rendering hides a
  // distinguishing field. Surface as a warning so debugging starts
  // with the offending node ids in hand.
  const labelGroups = new Map();
  for (const cs of chainStates) {
    // Strip the leading "[sN] " prefix so node IDs don't make every
    // label trivially unique.
    const stripped = cs.label.replace(/^\[s\d+\]\s*/, '');
    const arr = labelGroups.get(stripped) ?? [];
    arr.push(cs.id);
    labelGroups.set(stripped, arr);
  }
  const duplicateLabels = [];
  for (const [label, ids] of labelGroups) {
    if (ids.length > 1) duplicateLabels.push({ label, ids });
  }

  return {
    states: chainStates,
    edges: chainEdges,
    start: `s${startIdx}`,
    goals: chainStates.filter((c) => c.kind === 'goal').map((c) => c.id),
    // No-restart-formula decomposition exposed for UI:
    // itemValue(start, B) = pSuccessStart · B + bExpectedStart, so the
    // home view can compute itemValue at any candidate budget without
    // re-solving and surface a "increase budget to ≥ X to make crafting
    // profitable" hint.
    pSuccessStart: pStart,
    bExpectedStart: bStart,
    breakevenBudgetEx,
    // Diagnostic: groups of chain nodes whose labels collide
    // (excluding the step-id prefix). Each entry is
    // { label, ids: [stepId...] }. Empty array means every node
    // is visually distinct.
    duplicateLabels,
  };
}
