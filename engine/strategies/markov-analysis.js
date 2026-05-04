// Shared Markov-chain analysis used by chaos-spam and the exalt-annul
// cycle. Computes:
//   - reverse-reachability from goal ⇒ bricked states
//   - per-state V* (expected cost-to-goal) and H* (expected steps-to-goal)
//     using the existing solveLinear / expectedHittingTime path
//   - near-trap threshold V*(start) + restartCost — states above which the
//     optimal MDP would restart instead of continuing
//   - a `unifiedCost(ex, sec)` helper that mixes wall-clock time into the
//     cost function via `timeWeightExPerSec` (default 0.1, i.e. 1 ex = 10 sec)
//
// The V* solve uses unified per-state costs so the resulting threshold is
// expressed in the same unit (ex-equivalent), letting the renderer treat
// "is restarting cheaper?" as a clean numeric comparison even when an
// action is dominated by time rather than orb price alone.
//
// Inputs are normalised to `{ states, expanded, goalCheck, perStepCostEx,
//   perStepTimeSec, timeWeightExPerSec, restartCostEx }` where:
//   - `expanded[i]` = array of `{ to, weight }` (next-state index, prob)
//   - `perStepCostEx(i)` = ex cost of the action taken at state i
//   - `perStepTimeSec(i)` = wall-clock seconds at state i
// The "transition weight" naming is unified to `weight` for both
// strategies — chaos-spam already used it; exalt-annul migrates here.

import { solveLinear } from '../evaluator.js';

export function unifiedCostFn(timeWeightExPerSec) {
  const w = Number.isFinite(timeWeightExPerSec) ? timeWeightExPerSec : 0;
  return (ex, sec) =>
    (Number.isFinite(ex) ? ex : 0) + (Number.isFinite(sec) ? sec : 0) * w;
}

/**
 * @typedef {Object} MarkovAnalysis
 * @property {Set<number>} canReachGoal
 * @property {(i: number) => boolean} isBricked
 * @property {(i: number) => boolean} isNearTrap
 * @property {(i: number) => boolean} isCollapsed     bricked OR near-trap
 * @property {Map<number, number>} vPerState          unified ex-equivalent V*
 * @property {Map<number, number>} hPerState          E[steps]
 * @property {Map<number, number>} vCostPerState      pure-ex V* (no time)
 * @property {number | null} startV                    V* at start (unified)
 * @property {number | null} nearTrapCutoff
 */
export function analyzeAbsorbingMC({
  states,
  expanded,
  goalCheck,
  startStateIdx,
  perStepCostEx,
  perStepTimeSec,
  timeWeightExPerSec,
  restartCostEx,
  restartTimeSec,
}) {
  const n = states.length;
  // Reverse-BFS from goal states.
  const canReachGoal = new Set();
  for (let i = 0; i < n; i++) if (goalCheck(states[i])) canReachGoal.add(i);
  const revAdj = states.map(() => []);
  for (let i = 0; i < n; i++) {
    for (const tr of expanded[i]) if (i !== tr.to) revAdj[tr.to].push(i);
  }
  {
    const stk = [...canReachGoal];
    while (stk.length) {
      const j = stk.pop();
      for (const i of revAdj[j]) {
        if (!canReachGoal.has(i)) { canReachGoal.add(i); stk.push(i); }
      }
    }
  }
  const isBricked = (i) => !canReachGoal.has(i);

  // Build (I − Q) over non-bricked transients, then solve for V* (unified)
  // and H* (steps) in two passes.
  const transientIdx = [];
  for (let i = 0; i < n; i++) {
    if (!goalCheck(states[i]) && !isBricked(i)) transientIdx.push(i);
  }
  const m = transientIdx.length;
  const unifiedCost = unifiedCostFn(timeWeightExPerSec);
  const vPerState = new Map();
  const hPerState = new Map();
  const vCostPerState = new Map();
  let startV = null;
  if (m > 0) {
    // Build Q rows over transientIdx.
    const tIdxOf = new Map();
    transientIdx.forEach((i, k) => tIdxOf.set(i, k));
    const A = Array.from({ length: m }, (_, ii) => {
      const i = transientIdx[ii];
      const row = new Array(m).fill(0);
      row[ii] = 1;
      for (const tr of expanded[i]) {
        const k = tIdxOf.get(tr.to);
        if (k !== undefined) row[k] -= tr.weight;
      }
      return row;
    });
    const bUnified = transientIdx.map((i) =>
      unifiedCost(perStepCostEx(i), perStepTimeSec(i)));
    const bCostEx  = transientIdx.map((i) => perStepCostEx(i));
    const bSteps   = transientIdx.map(() => 1);
    let vU, vC, h;
    try {
      vU = solveLinear(A.map((row) => row.slice()), bUnified);
      vC = solveLinear(A.map((row) => row.slice()), bCostEx);
      h  = solveLinear(A.map((row) => row.slice()), bSteps);
    } catch {
      // Singular system — leave maps empty, callers fall back gracefully.
      return {
        canReachGoal, isBricked,
        isNearTrap: () => false,
        isCollapsed: (i) => isBricked(i),
        vPerState, hPerState, vCostPerState,
        startV: null, nearTrapCutoff: null,
      };
    }
    transientIdx.forEach((i, k) => {
      vPerState.set(i, vU[k]);
      vCostPerState.set(i, vC[k]);
      hPerState.set(i, h[k]);
    });
    startV = vPerState.get(startStateIdx) ?? null;
  }

  // Near-trap: V*(s) > V*(start) + unified(restartCostEx, restartTimeSec).
  // Above that threshold, optimal MDP says restart.
  const restartUnified = unifiedCost(restartCostEx ?? 0, restartTimeSec ?? 0);
  const nearTrapCutoff = (Number.isFinite(startV) && Number.isFinite(restartUnified))
    ? startV + restartUnified : null;
  const isNearTrap = (i) => {
    if (nearTrapCutoff == null) return false;
    const v = vPerState.get(i);
    return Number.isFinite(v) && v > nearTrapCutoff;
  };
  const isCollapsed = (i) => isBricked(i) || isNearTrap(i);
  // Connected components per "collapsed kind" (bricked vs near-trap).
  // Frontier→collapsed edges land in the cluster the collapsed target
  // belongs to, so the user sees *which* subgraph is dead-ending. We use
  // weakly-connected components on the induced subgraph of collapsed
  // states (ignoring edge direction).
  const brickedCluster  = new Map(); // i → clusterId
  const nearTrapCluster = new Map();
  const computeClusters = (matchFn, out) => {
    let next = 0;
    for (let i = 0; i < n; i++) {
      if (!matchFn(i)) continue;
      if (out.has(i)) continue;
      const id = next++;
      const stk = [i];
      out.set(i, id);
      while (stk.length) {
        const u = stk.pop();
        // Forward edges
        for (const tr of expanded[u]) {
          if (matchFn(tr.to) && !out.has(tr.to)) { out.set(tr.to, id); stk.push(tr.to); }
        }
        // Reverse edges
        for (const v of revAdj[u]) {
          if (matchFn(v) && !out.has(v)) { out.set(v, id); stk.push(v); }
        }
      }
    }
  };
  computeClusters(isBricked, brickedCluster);
  computeClusters(isNearTrap, nearTrapCluster);

  return {
    canReachGoal, isBricked, isNearTrap, isCollapsed,
    vPerState, hPerState, vCostPerState,
    startV, nearTrapCutoff,
    brickedCluster, nearTrapCluster,
  };
}

/**
 * Aggregator for collapsed-sink edges. Caller iterates outbound edges
 * from frontier states and calls `accumulate(sourceIdx, targetIdx,
 * weight)` for every edge into a collapsed (bricked or near-trap) state.
 * Returns the maps used by `appendCollapsedSinks` below.
 */
export function makeCollapsedAccumulator({
  isBricked, isNearTrap,
  brickedCluster, nearTrapCluster,
}) {
  // Keyed by clusterId → { fromMap: Map<sourceIdx, cumProb> }
  const bricked  = new Map();
  const nearTrap = new Map();
  const accumulate = (sourceIdx, targetIdx, weight) => {
    if (isBricked(targetIdx)) {
      const cid = brickedCluster.get(targetIdx);
      if (!bricked.has(cid)) bricked.set(cid, new Map());
      const m = bricked.get(cid);
      m.set(sourceIdx, (m.get(sourceIdx) ?? 0) + weight);
      return true;
    }
    if (isNearTrap(targetIdx)) {
      const cid = nearTrapCluster.get(targetIdx);
      if (!nearTrap.has(cid)) nearTrap.set(cid, new Map());
      const m = nearTrap.get(cid);
      m.set(sourceIdx, (m.get(sourceIdx) ?? 0) + weight);
      return true;
    }
    return false;
  };
  return { accumulate, bricked, nearTrap };
}

/**
 * Emit one bricked sink and one near-trap sink *per connected component*.
 * Each sink gets one inbound edge per (frontier source) → that cluster.
 * The user reads "which subgraph is this branch dead-ending into?" without
 * the cluttered subgraph itself.
 */
export function appendCollapsedSinks({
  chainStates, chainEdges,
  bricked, nearTrap,
  nearTrapCutoff,
}) {
  const fmtP = (p) => p < 0.001 ? p.toExponential(1) : p.toFixed(3);
  for (const [cid, fromMap] of bricked) {
    const sinkId = `bricked_${cid}`;
    chainStates.push({
      id: sinkId,
      label: '💀 bricked\n(restart the item)',
      kind: 'bricked',
    });
    for (const [i, p] of fromMap) {
      chainEdges.push({
        from: `s${i}`, to: sinkId,
        label: `p=${fmtP(p)}\n→ no path to goal`,
        kind: 'fail',
      });
    }
  }
  const cutoffEx = Number.isFinite(nearTrapCutoff)
    ? `≈${nearTrapCutoff.toFixed(0)} ex` : '';
  for (const [cid, fromMap] of nearTrap) {
    const sinkId = `near-trap_${cid}`;
    chainStates.push({
      id: sinkId,
      label: `⚠ near-trap\nrestart cheaper than\ncontinuing (V* > ${cutoffEx})`,
      kind: 'near-trap',
    });
    for (const [i, p] of fromMap) {
      chainEdges.push({
        from: `s${i}`, to: sinkId,
        label: `p=${fmtP(p)}\n→ uphill — restart`,
        kind: 'fail',
      });
    }
  }
}

/** Common label-annotator: appends "E[steps]≈N · V*≈N ex" when available. */
export function annotateLabelFn(hPerState, vPerState) {
  return (i, baseLabel) => {
    const h = hPerState.get(i);
    const v = vPerState.get(i);
    const lines = [];
    if (Number.isFinite(h)) lines.push(`E[steps]≈${h < 100 ? h.toFixed(1) : h.toFixed(0)}`);
    if (Number.isFinite(v)) lines.push(`V*≈${v < 100 ? v.toFixed(1) : v.toFixed(0)} ex`);
    return lines.length ? `${baseLabel}\n${lines.join(' · ')}` : baseLabel;
  };
}
