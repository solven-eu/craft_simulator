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
import { buildStateSpace, valueIterate, valueIterateAsync } from './value-iteration.js';
import { buildChain } from './chain.js';

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
    // Allow goal states to carry a pending unrevealed bone-mod —
    // user opt-in for "stop at bone applied, defer reveal."
    allowBonePending: !!input.target?.allowBonePending,
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
  const startBoneSide = (input.start?.boneSide === 'PREFIX' || input.start?.boneSide === 'SUFFIX')
    ? input.start.boneSide : null;
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
    // Bone side carries through only when there's actually a pending
    // bone — otherwise the field is meaningless and should stay null
    // for clean state-key dedup.
    boneSide: startBoneMod ? startBoneSide : null,
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
  // Both code paths (sync and async value-iteration) feed into the
  // same post-iterate body, defined as the inner function below.
  // Closures over `states`, `startIdx`, `target`, `warnings`,
  // `wishlist`, `budgetExcluded`, `budgetCap`, `start`, `input`.
  // ---- Output: per-state value + chain ----------
  function _finishOutput({ vStar, policy, iters, converged }) {
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
    // Whether to collapse states that differ only by side allocation
    // (irrelevant prefix vs suffix split, when behaviorally equivalent
    // for the chain reader). Default on — large chains shrink
    // significantly without losing user-relevant information.
    collapseEquivalent: input.collapseEquivalent !== false,
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
  // Surface outgoing-probability mismatches as warnings. When a node
  // has outgoing edges that don't sum to 1.0, an outcome was dropped
  // — the user will see "annul 66%" without the missing 33% sibling.
  if (chain?.incompleteEdges?.length) {
    for (const inc of chain.incompleteEdges) {
      warnings.push(
        `Chain node ${inc.from} action "${inc.action}": outgoing edges sum `
        + `to ${(inc.total * 100).toFixed(1)}% (missing ${(inc.missing * 100).toFixed(1)}%). `
        + `Visible edges: ${inc.edges.map((e) => `→${e.to} (${(e.prob * 100).toFixed(1)}%)`).join(', ')}`,
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
    // Initial-base acquisition cost. Restart-buy_base events are
    // already accounted for as MDP transitions, but the FIRST base
    // (acquiring the white item before any crafting) isn't a step in
    // the trajectory walker — it's a pre-condition. Surfaced here so
    // sampleTrajectory can prepend it to totalEx.
    basePriceEx: input.basePriceEx ?? 0,
    basePriceSec: input.basePriceSec ?? 60,
  };
  } // end _finishOutput

  // Shared between sync and async paths: take a value-iteration
  // result and run the convergence check + output build.
  const finish = (vi) => {
    const { vStar, policy, iters, converged, lastDelta } = vi;
    if (!converged) {
      warnings.push(
        `value iteration hit maxIters (${iters}) without converging — ` +
        `lastDelta=${lastDelta?.toExponential(2)}. V* values are partial; ` +
        `optimal policy may flip if maxIters is raised. Often signals a ` +
        `near-impossible scenario (very low per-attempt success and ` +
        `expensive recovery — slow contraction toward fixed point).`,
      );
    }
    return _finishOutput({ vStar, policy, iters, converged });
  };
  // Caller supplied a progress callback (or a cancel signal): take
  // the async path so the value-iteration loop yields to the event
  // loop and the UI can repaint a progress bar. Synchronous callers
  // (tests, CLI use) skip the await and pay no overhead.
  if (input.onProgress || input.shouldCancel) {
    input.onProgress?.({ phase: 'build', states: states.length });
    return valueIterateAsync({
      states, appsPerState, target,
      timeWeightExPerSec: input.timeWeightExPerSec ?? 0,
      onProgress: input.onProgress
        ? (p) => input.onProgress({ phase: 'iterate', states: states.length, ...p })
        : null,
      yieldEvery: input.yieldEvery ?? 20,
      shouldCancel: input.shouldCancel ?? null,
    }).then((vi) => vi.cancelled ? { cancelled: true } : finish(vi));
  }
  return finish(valueIterate({
    states, appsPerState, target,
    timeWeightExPerSec: input.timeWeightExPerSec ?? 0,
  }));
}

