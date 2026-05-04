// Chaos Spam strategy.
//
// Each Chaos Orb removes one random mod and adds one random mod, preserving
// rarity and total mod count T. The state is a *bitmask over the user's
// wishlist*: which specific wished mods are currently on the item. This is
// crucial for correctness: a wished mod already on the item is excluded
// from the pool for the next add, so per-state add-probabilities differ.
// Treating wished mods as fungible (flat (r, w) counts) gives wrong
// numbers when wishlist weights are heterogeneous.
//
// Tracked dimensions:
//   - bitmask S over the N wishlist entries (which are currently on item)
//   - irrelevant count = T - popcount(S) (implicit)
//
// Goal: every required entry's bit is set, AND popcount(S) >= requiredHits
// (or the capped form when requiredHits exceeds T).
//
// State size: 2^N where N = |wishlist|. Capped at N ≤ 8 (256 states); for
// larger wishlists we fall back to the previous (r, w) approximation
// (warning surfaced in notes). Typical wishlists are 2-5 entries.
//
// Approximations preserved:
//   - Same-modifier exclusion is tracked exactly for *wished* mods (the
//     ones that matter). Irrelevant mods on the item are NOT tracked
//     individually — there's a huge pool of them and double-counting any
//     specific irrelevant has tiny probability.
//   - Annul-cleanup tail (when target shape needs fewer mods than T)
//     stays the naive lower-bound it was.
//   - qBoost not applied — chaos has no Greater/Perfect variant.

import { orbCostEx } from '../strategy-utils.js';
import {
  analyzeAbsorbingMC, makeCollapsedAccumulator, appendCollapsedSinks,
  annotateLabelFn,
} from './markov-analysis.js';

const popcount = (n) => {
  let c = 0;
  while (n) { c += n & 1; n >>>= 1; }
  return c;
};

export function chaosSpam(ctx) {
  const T = Math.max(4, ctx.startingCounts.prefixes + ctx.startingCounts.suffixes);
  const N = ctx.wishlist.length;
  const requiredHits = ctx.requiredHits;
  const cp = ctx.conditionalPool;

  // Per-wishlist-entry pool weight + required flag.
  const wkeys = ctx.wishlist.map((w) => w.key);
  const wIsReq = ctx.wishlist.map((w) => !!w.required);
  const wWeight = wkeys.map((k) => cp.find((m) => m.key === k)?.weight ?? 0);
  const totalW = cp.reduce((s, m) => s + (m.weight ?? 0), 0);
  const wishedW = wWeight.reduce((s, x) => s + x, 0);
  const irrelevantW = Math.max(0, totalW - wishedW);
  const reqMask = wIsReq.reduce((m, isReq, i) => isReq ? (m | (1 << i)) : m, 0);
  const R = popcount(reqMask);

  const K = Math.min(T, N);
  const effectiveGoal = Math.min(requiredHits, K);
  const partial = effectiveGoal < requiredHits;

  // State-size guard.
  if (N > 8) {
    return {
      id: 'chaos-spam', label: 'Chaos spam', available: false,
      notes: `wishlist of ${N} entries exceeds the bitmask limit (8). Reduce wishlist or wait for the (r, w) fallback to be re-enabled.`,
    };
  }

  // Goal predicate over a state bitmask S.
  const goalCheck = (S) => ((S & reqMask) === reqMask) && (popcount(S) >= effectiveGoal);

  // Starting state: bitmask of wishlist entries already present on the
  // starting item. Use ctx.startingR / startingWSoft to count, then
  // construct a representative bitmask. Without per-mod start info we
  // canonicalise by picking the "first R required + first startingW soft"
  // bits as the on-item set. (Exact identity of starting hits doesn't
  // affect the chain's expected time when the user's wishlist is symmetric;
  // for asymmetric weights this is a coarse start-state approximation —
  // good enough until starting items typically carry wished mods.)
  const startingR = Math.min(ctx.startingR ?? 0, R);
  const startingWS = Math.min(ctx.startingWSoft ?? 0, N - R);
  let startMask = 0;
  let placedR = 0, placedW = 0;
  for (let i = 0; i < N && (placedR < startingR || placedW < startingWS); i++) {
    const isReq = wIsReq[i];
    if (isReq && placedR < startingR) { startMask |= (1 << i); placedR++; }
    else if (!isReq && placedW < startingWS) { startMask |= (1 << i); placedW++; }
  }

  if (goalCheck(startMask)) {
    return {
      id: 'chaos-spam', label: 'Chaos spam', available: true,
      p: 1, expectedAttempts: 0, expectedCostEx: 0, expectedTimeSec: 0,
      notes: 'starting item already satisfies requirement',
    };
  }
  if (totalW <= 0 || (wishedW <= 0 && startMask !== ((1 << N) - 1))) {
    return {
      id: 'chaos-spam', label: 'Chaos spam', available: false,
      notes: 'no wished mass in conditional pool — chaos cannot reach goal',
    };
  }

  // Reachable subset enumeration (BFS) so the Markov system is small.
  // The unreachable bitmasks (e.g. with more bits set than T) are skipped.
  const stateIdx = new Map();
  const states = [];
  const enqueue = (S) => {
    if (popcount(S) > T) return;
    if (stateIdx.has(S)) return;
    stateIdx.set(S, states.length);
    states.push(S);
  };
  enqueue(startMask);

  // Compute outgoing transitions for state S.
  // Per-Chaos: remove one of T mods uniformly, then add one from pool
  // (weighted, excluding mods currently on item).
  // We aggregate (remove, add) pairs into a flat list of next-state probs.
  const transitionsFor = (S) => {
    const pop = popcount(S);
    const irrCount = T - pop;
    // ---- ADD step probability table, conditioned on the post-remove
    // bitmask. The post-remove bitmask is either S (if we removed an
    // irrelevant) or S without bit i (if we removed wished i).
    //
    // We compute add-probabilities lazily per scenario.
    const addDist = (postRemoveMask) => {
      // Pool weight excluding mods currently on item.
      const onItemWeight = wkeys.reduce(
        (s, _, i) => s + ((postRemoveMask & (1 << i)) ? wWeight[i] : 0), 0,
      );
      const pool = Math.max(0, totalW - onItemWeight);
      if (pool <= 0) return [];
      const out = [];
      // Per-wished-not-on-item: prob = w_i / pool, lands on bit i set.
      for (let i = 0; i < N; i++) {
        if (postRemoveMask & (1 << i)) continue;
        const p = wWeight[i] / pool;
        if (p > 0) out.push({ delta: 1 << i, prob: p });
      }
      // Irrelevant: bitmask unchanged, prob = irrelevantW / pool.
      if (irrelevantW > 0) out.push({ delta: 0, prob: irrelevantW / pool });
      return out;
    };

    // Build accumulator: nextState → cumulative probability.
    const acc = new Map();
    const accumulate = (nextMask, prob) => {
      acc.set(nextMask, (acc.get(nextMask) ?? 0) + prob);
    };

    // Scenario 1: remove a specific wished mod i (i ∈ S). Probability 1/T
    // each. After remove, postRemoveMask = S & ~(1<<i).
    if (T > 0) {
      for (let i = 0; i < N; i++) {
        if (!(S & (1 << i))) continue;
        const pRem = 1 / T;
        const postMask = S & ~(1 << i);
        const adds = addDist(postMask);
        for (const a of adds) {
          accumulate(postMask | a.delta, pRem * a.prob);
        }
      }
      // Scenario 2: remove an irrelevant mod (one of irrCount of them).
      // Probability irrCount/T total, postRemoveMask = S.
      if (irrCount > 0) {
        const pRem = irrCount / T;
        const adds = addDist(S);
        for (const a of adds) {
          accumulate(S | a.delta, pRem * a.prob);
        }
      }
    }

    // Filter unreachable next states (popcount > T) and queue new ones.
    const trs = [];
    for (const [nextMask, prob] of acc) {
      if (popcount(nextMask) > T) continue;
      enqueue(nextMask);
      trs.push({ to: stateIdx.get(nextMask), weight: prob });
    }
    return trs;
  };

  // BFS expansion.
  const expanded = [];
  while (expanded.length < states.length) {
    const i = expanded.length;
    const S = states[i];
    if (goalCheck(S)) {
      expanded.push([{ to: i, weight: 1 }]);
    } else {
      expanded.push(transitionsFor(S));
    }
  }

  // ----------------------------------------------------------------------
  // Shared Markov analysis: reverse-reachability for `bricked`, V*/H* via
  // linear solve, near-trap threshold using unified ex+time cost.
  // ----------------------------------------------------------------------
  const startStateIdx = stateIdx.get(startMask);
  const chaosCostPer  = Number.isFinite(orbCostEx('chaos', ctx)) ? orbCostEx('chaos', ctx) : NaN;
  const chaosTimePer  = ctx.orbs.chaos?.timeSeconds ?? 0;
  const timeWeightExPerSec = Number.isFinite(ctx.timeWeightExPerSec)
    ? ctx.timeWeightExPerSec : 0;
  const restartCostEx  = Number.isFinite(ctx.basePriceEx) ? ctx.basePriceEx : NaN;
  const restartTimeSec = 0;
  const goalCheckByIdx = (s) => goalCheck(s);
  const analysis = analyzeAbsorbingMC({
    states, expanded,
    goalCheck: goalCheckByIdx,
    startStateIdx,
    perStepCostEx:  () => chaosCostPer,
    perStepTimeSec: () => chaosTimePer,
    timeWeightExPerSec,
    restartCostEx, restartTimeSec,
  });
  const {
    isBricked, isNearTrap, isCollapsed,
    vPerState, hPerState, vCostPerState,
    brickedCluster, nearTrapCluster,
    nearTrapCutoff,
  } = analysis;
  if (vCostPerState.size === 0 && !goalCheck(startMask)) {
    return {
      id: 'chaos-spam', label: 'Chaos spam', available: false,
      notes: 'Markov system singular — goal likely unreachable',
    };
  }
  const expectedAttempts = hPerState.get(startStateIdx) ?? (goalCheck(startMask) ? 0 : Infinity);

  const chaosCostEx  = Number.isFinite(chaosCostPer) ? expectedAttempts * chaosCostPer : NaN;
  const chaosTimeSec = chaosTimePer * expectedAttempts;

  // Annul-cleanup phase (unchanged from prior).
  const excess = Number.isFinite(ctx.maxFilled) ? Math.max(0, T - ctx.maxFilled) : 0;
  let annulCostEx = 0, annulTimeSec = 0, annulNote = '';
  if (excess > 0) {
    const annulCostPer = orbCostEx('annulment', ctx);
    annulCostEx = Number.isFinite(annulCostPer) ? excess * annulCostPer : NaN;
    annulTimeSec = (ctx.orbs.annulment?.timeSeconds ?? 0) * excess;
    annulNote = `; +${excess} annul(s) to clear excess mods (T=${T} → maxFilled=${ctx.maxFilled}, naive)`;
  }

  const expectedCostEx = (Number.isFinite(chaosCostEx) ? chaosCostEx : NaN)
    + (Number.isFinite(annulCostEx) ? annulCostEx : 0);
  const expectedTimeSec = chaosTimeSec + annulTimeSec;

  // ---------------------------------------------------------------------
  // Chain export. Each transient state shows its r/w/i counts plus a
  // short list of which wished mods are present (so the user sees that
  // p_add changes per state). Edges still labelled with action + p.
  // ---------------------------------------------------------------------
  const shortName = (key) => {
    // "PREFIX:#% increased Evasion Rating" → "P:Evasion Rating"
    const [side, rest] = key.split(/:(.+)/);
    const tag = side === 'PREFIX' ? 'P' : side === 'SUFFIX' ? 'S' : '';
    const trim = (rest ?? '').replace(/[#%,]/g, '').replace(/\s+/g, ' ').trim();
    return `${tag}:${trim.slice(0, 24)}`;
  };
  const stateLabel = (S) => {
    const onBits = [];
    for (let i = 0; i < N; i++) if (S & (1 << i)) onBits.push(i);
    const irr = T - onBits.length;
    const lines = [];
    for (const i of onBits) {
      const tag = wIsReq[i] ? '★' : '·';
      lines.push(`${tag} ${shortName(wkeys[i])}`);
    }
    if (irr > 0) lines.push(`+ ${irr} irrelevant`);
    if (!lines.length) lines.push('(empty)');
    return lines.join('\n');
  };
  const chainStates = [];
  const chainEdges = [];
  const annotateLabel = annotateLabelFn(hPerState, vPerState);
  states.forEach((S, i) => {
    if (isCollapsed(i)) return; // bricked + near-trap subgraphs are hidden
    const kind = goalCheck(S) ? 'goal' : 'transient';
    const baseLabel = goalCheck(S) ? `${stateLabel(S)}\n✓` : stateLabel(S);
    chainStates.push({
      id: `s${i}`,
      label: annotateLabel(i, baseLabel),
      kind,
      meta: {
        mask: S,
        hStar: hPerState.get(i) ?? null,
        vStar: vPerState.get(i) ?? null,
      },
    });
  });
  chainStates.unshift({
    id: 'base',
    label: `Starting Rare\n${stateLabel(startMask)}`,
    kind: 'start',
  });
  chainEdges.push({
    from: 'base', to: `s${stateIdx.get(startMask)}`,
    label: 'starting state', kind: 'orb',
  });
  const chaosAction = '🌀 Chaos';
  const fmtP = (p) => p < 0.001 ? p.toExponential(1) : p.toFixed(3);
  const sinkAcc = makeCollapsedAccumulator({
    isBricked, isNearTrap, brickedCluster, nearTrapCluster,
  });
  states.forEach((S, i) => {
    if (isCollapsed(i)) return;
    if (goalCheck(S)) return;
    const trs = expanded[i];
    for (const tr of trs) {
      const j = tr.to;
      if (sinkAcc.accumulate(i, j, tr.weight)) continue;
      const targetMask = states[j];
      const noOp = i === j ? ' (swap-in-place)' : '';
      const score = (S2) => {
        let r = 0, w = 0;
        for (let k = 0; k < N; k++) if (S2 & (1 << k)) (wIsReq[k] ? r++ : w++);
        return r * 100 + (r + w);
      };
      const ds = score(targetMask) - score(S);
      let kind = 'internal';
      if (goalCheck(targetMask))   kind = 'success';
      else if (ds > 0)             kind = 'improving';
      else if (ds < 0)             kind = 'fail';
      chainEdges.push({
        from: `s${i}`, to: `s${j}`,
        label: `${chaosAction}\np=${fmtP(tr.weight)}${noOp}`,
        kind,
      });
    }
  });
  appendCollapsedSinks({
    chainStates, chainEdges,
    bricked: sinkAcc.bricked,
    nearTrap: sinkAcc.nearTrap,
    nearTrapCutoff,
  });

  // Wishlist info: each wished entry's per-orb hit probability *from the
  // starting (or current) state*. We surface the value at S = startMask
  // so the user has a baseline; the per-state numbers are visible on edges.
  const baselinePool = totalW - wkeys.reduce(
    (s, _, i) => s + ((startMask & (1 << i)) ? wWeight[i] : 0), 0,
  );
  const wishlistInfo = ctx.wishlist.map((wEntry, i) => ({
    name: wEntry.key,
    type: wEntry.type,
    required: !!wEntry.required,
    tier: wEntry.minTier,
    weight: wWeight[i],
    perOrbProb: baselinePool > 0 && !(startMask & (1 << i)) ? wWeight[i] / baselinePool : 0,
  }));

  const chain = {
    states: chainStates,
    edges: chainEdges,
    start: 'base',
    goals: chainStates.filter((s) => s.kind === 'goal').map((s) => s.id),
    glossary: [
      { sym: 'r', desc: `required mods on item (R = ${R} required entries)` },
      { sym: 'w', desc: `soft-wished mods on item (Wmax = ${N - R} non-required entries)` },
      { sym: 'i', desc: 'irrelevant mods on item (i = T − r − w)' },
      { sym: 'T', desc: `total mods on item; chaos preserves T = ${T}` },
      { sym: 'goal', desc: `every required entry on item AND total wishlist count ≥ ${effectiveGoal}` },
      { sym: 'state', desc: `bitmask over the ${N} wishlist entries — same-mod exclusion is tracked exactly, so add-probabilities differ per state` },
      { sym: 'p_add baseline', desc: `from the start state: irrelevant ${(irrelevantW / totalW * 100).toFixed(2)}%, wished ${(wishedW / totalW * 100).toFixed(2)}%` },
    ],
    wishlistInfo,
    poolStats: {
      totalWeight: totalW,
      wishedWeight: wishedW,
      requiredWeight: wWeight.reduce((s, w, i) => s + (wIsReq[i] ? w : 0), 0),
    },
  };

  return {
    id: 'chaos-spam',
    label: 'Chaos spam',
    available: true,
    p: 1 / expectedAttempts,
    expectedAttempts,
    expectedCostEx,
    expectedTimeSec,
    notes: `bitmask Markov over ${N} wished entries (${states.length} reachable states; T=${T}, R=${R}); same-mod exclusion tracked exactly${partial ? `; PARTIAL — required ${requiredHits} exceeds T, chaos can fit at most ${effectiveGoal}` : ''}${annulNote}`,
    description:
      'Take the existing Rare item. Apply Chaos Orbs one after another. Each ' +
      'Chaos removes one random mod and adds one random mod. The state of the ' +
      'Markov chain is a bitmask over your wishlist entries — which specific ' +
      'wished mods are currently on the item — so the per-state probability ' +
      'of adding any given wished mod accounts for which weights are excluded ' +
      'because that mod is already there. Goal: every required entry on the ' +
      'item AND total wishlist count meets the threshold.',
    chain,
  };
}
