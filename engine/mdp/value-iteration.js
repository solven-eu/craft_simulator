// Value iteration for the MDP-α.
//
// Bellman optimality:
//   V*(s) = 0                     if s is goal
//   V*(s) = ∞                     if s is bricked w/ no path to goal
//   V*(s) = min over a ∈ A(s) of [ E[c(s,a)] + Σ P(s'|s,a) · V*(s') ]
//
// We expand the state space lazily by BFS from the start state (each
// action's `transitions` reveals reachable next-states), then iterate
// V over the discovered set until convergence.
//
// Uses a unified cost: `costUnified = costEx + costSec × timeWeightExPerSec`.
// Currency and wall-clock time are mixed in the same scalar so the
// optimal policy trades them off automatically (e.g. "is the time saved
// by Perfect Exalt worth its higher orb price?").

import { stateKey, isGoalState, isBrickedByFracture } from './state.js';

/**
 * @typedef {Object} ActionApplication
 * @property {string} actionId
 * @property {{ to: object, prob: number, costEx: number, costSec: number }[]} outcomes
 */

/**
 * Discover all reachable states from `start` under the given action set.
 * Returns:
 *   states: state[] in BFS order (states[0] === start canonicalised)
 *   stateIdx: Map<key, number>
 *   appsPerState: Map<idx, ActionApplication[]> — every applicable action
 *     and its outcomes, with `to` resolved to indices.
 */
export function buildStateSpace({ start, actions, env, target, maxStates = 65536 }) {
  // maxStates bumped from 4096 → 65536 alongside the wishlist cap
  // lift from 8 → 12. State space scales 2^N so going from 8 wished
  // (2^8 = 256 masks) to 12 wished (2^12 = 4096 masks) needs ~16×
  // the headroom; 65536 covers the worst-case 12-wished × all-other-
  // dims scenario without being so large it hides genuine bugs.
  const states = [];
  const stateIdx = new Map();
  const enqueue = (s) => {
    const k = stateKey(s);
    if (stateIdx.has(k)) return stateIdx.get(k);
    const idx = states.length;
    stateIdx.set(k, idx);
    states.push(s);
    return idx;
  };
  const startIdx = enqueue(start);

  const appsPerState = new Map();
  let head = 0;
  while (head < states.length) {
    const i = head++;
    const s = states[i];
    if (states.length > maxStates) {
      throw new Error(`MDP state space exceeded ${maxStates} — too many states; reduce wishlist or tighten action set.`);
    }
    if (isGoalState(s, target)) { appsPerState.set(i, []); continue; }
    // Bricked-by-fracture states (irrFractured, or wrong-bit fracture)
    // keep their action set — `buy_base` is the only sensible action and
    // the solver picks it naturally. Stripping apps would orphan the
    // state at V*=Inf and freeze upstream propagation.
    const apps = [];
    for (const action of actions) {
      if (!action.applicable(s, env)) continue;
      const outcomes = action.transitions(s, env)
        .filter((o) => o.prob > 1e-12)
        .map((o) => ({ to: enqueue(o.to), prob: o.prob, costEx: o.costEx, costSec: o.costSec }));
      if (!outcomes.length) continue;
      apps.push({ actionId: action.id, outcomes });
    }
    appsPerState.set(i, apps);
  }
  return { states, stateIdx, appsPerState, startIdx };
}

/**
 * Value-iterate to convergence over the built state space.
 * @returns { vStar: number[], policy: (string|null)[], iters: number,
 *           converged: boolean, lastDelta: number }
 *
 * `converged=false` means iteration hit `maxIters` without reaching
 * `tol` — V* values are partial and the policy may flip when run
 * longer. Callers should surface this in user-visible warnings.
 */
export function valueIterate({ states, appsPerState, target, timeWeightExPerSec, tol = 1e-6, maxIters = 50000 }) {
  // maxIters bumped from 5000 because high-brick scenarios (e.g.
  // fracture-required target with ~0.2% per-attempt success) have
  // contraction factor ~ 1 − ε with ε very small; iteration needs
  // ~log(tol)/log(1−ε) ≈ 21/ε sweeps to settle. At ε=0.002 that's
  // ~10500. Bumping to 50000 keeps a comfortable margin.
  const n = states.length;
  // Initialise V* with a large *finite* upper bound so the first sweep
  // can compute meaningful expectations. Pessimistic infinity fails to
  // propagate through cyclic transition graphs (every Q stays ∞ until
  // some neighbour drops to finite, but with init=∞ no neighbour ever
  // drops). V_INIT must exceed the true V* for monotone descent;
  // beyond that, smaller is faster (fewer sweeps to settle from
  // V_INIT down to V*). 1e9 is generous (plausible V* ceiling for
  // multi-million-ex crafts is ~1e7) and ~3 orders of magnitude
  // tighter than the previous 1e12 — saves ~3000 iterations on
  // high-brick scenarios where contraction is slow.
  const V_INIT = 1e9;
  const vStar = new Array(n).fill(V_INIT);
  const policy = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    if (isGoalState(states[i], target)) vStar[i] = 0;
  }
  const unified = (ex, sec) => ex + sec * (timeWeightExPerSec ?? 0);

  let iters = 0;
  let lastDelta = Infinity;
  let converged = false;
  for (; iters < maxIters; iters++) {
    let maxDelta = 0;
    for (let i = 0; i < n; i++) {
      if (isGoalState(states[i], target)) continue;
      const apps = appsPerState.get(i) ?? [];
      if (!apps.length) continue;
      let bestQ = Infinity;
      let bestA = null;
      for (const app of apps) {
        let q = 0;
        for (const o of app.outcomes) {
          q += o.prob * (unified(o.costEx, o.costSec) + vStar[o.to]);
        }
        if (q < bestQ) { bestQ = q; bestA = app.actionId; }
      }
      if (bestQ < vStar[i] - tol) {
        maxDelta = Math.max(maxDelta, vStar[i] - bestQ);
        vStar[i] = bestQ;
        policy[i] = bestA;
      } else if (bestA) {
        // Always refresh the policy to the current argmin, even when
        // V* is already converged within tol. The earlier `policy[i] == null`
        // guard locked the policy to whichever action ran first in the
        // action-list ordering — so two near-tied actions (e.g. `alch`
        // and `transmute` for the bow-fracture scenario) couldn't be
        // disambiguated by post-convergence Q comparison.
        policy[i] = bestA;
      }
    }
    lastDelta = maxDelta;
    if (maxDelta < tol) { converged = true; break; }
  }
  // Mark states whose V* is still at the initial pessimistic ceiling as
  // unreachable from goal (truly bricked, no escape — shouldn't happen
  // with `buy_base` available, but defensive).
  for (let i = 0; i < n; i++) {
    if (vStar[i] >= V_INIT * 0.5) vStar[i] = Infinity;
  }
  return { vStar, policy, iters, converged, lastDelta };
}
