// Optimal policy solver via value iteration.
//
// Computes V*(s) = E[remaining cost from s under optimal play], the
// per-state best action, and uses dominance check (no per-orb hardcoding —
// see `dominated actions` memory):
//
//   V*(s) = 0                                            if s ∈ Goal
//   V*(s) = min_a [ cost(a) + Σ_s' P(s'|s,a) · V*(s') ]   otherwise
//
// Algorithm:
//   1. BFS-enumerate the reachable state graph from `startState`, applying
//      every applicable action and recording resulting states. Cap the
//      enumeration with `maxStates` for safety.
//   2. Initialise V(s) = 0 for goal states, V(s) = ∞ otherwise.
//   3. Sweep all transient states, computing the Bellman update. Repeat
//      until ‖ΔV‖ ≤ ε or `maxIter` is reached.
//   4. Return values, optimal action per state, and the start-state E[cost].
//
// Per the strict design rule, "this orb is bad here" is derived from the
// post-convergence comparison `cost(a) + Σ P·V*(s') > V*(s)` rather than
// hardcoded.

import { stateKey, makeState } from './state.js';

/**
 * @param {object} startState
 * @param {Array} actions                      Output of `buildActions(ctx)`.
 * @param {(s:object)=>boolean} isGoal
 * @param {{ maxStates?: number, maxIter?: number, epsilon?: number }} [opts]
 * @returns {{
 *   start: object,
 *   reachableCount: number,
 *   values: Map<string, number>,
 *   bestAction: Map<string, string|null>,
 *   expectedCostFromStart: number,
 *   converged: boolean,
 *   iterations: number
 * }}
 */
export function solveOptimalPolicy(startState, actions, isGoal, opts = {}) {
  const maxStates = opts.maxStates ?? 50_000;
  const maxIter   = opts.maxIter   ?? 500;
  const epsilon   = opts.epsilon   ?? 1e-4;

  // ---- 1. Enumerate reachable states (BFS) ------------------------------
  const states = [];
  const indexOf = new Map();
  const queue = [startState];
  indexOf.set(stateKey(startState), 0);
  states.push(startState);

  while (queue.length) {
    const s = queue.shift();
    if (isGoal(s)) continue;
    for (const a of actions) {
      if (!a.applicable(s)) continue;
      for (const { to, prob } of a.transitions(s) || []) {
        if (prob <= 0) continue;
        const k = stateKey(to);
        if (indexOf.has(k)) continue;
        if (states.length >= maxStates) {
          return {
            start: startState,
            reachableCount: states.length,
            values: new Map(),
            bestAction: new Map(),
            expectedCostFromStart: NaN,
            converged: false,
            iterations: 0,
            error: `state-space cap (${maxStates}) reached`,
          };
        }
        indexOf.set(k, states.length);
        states.push(to);
        queue.push(to);
      }
    }
  }

  // ---- 2. Initialise values ---------------------------------------------
  const n = states.length;
  const V = new Array(n);
  const goalIdx = new Set();
  for (let i = 0; i < n; i++) {
    if (isGoal(states[i])) { V[i] = 0; goalIdx.add(i); }
    else V[i] = Infinity;
  }

  // Pre-cache transitions per (state, action) — sparse.
  const transCache = new Array(n);
  for (let i = 0; i < n; i++) {
    if (goalIdx.has(i)) continue;
    const arr = [];
    for (const a of actions) {
      if (!a.applicable(states[i])) continue;
      const tr = (a.transitions(states[i]) || [])
        .filter(({ prob }) => prob > 0)
        .map(({ to, prob }) => ({ idx: indexOf.get(stateKey(to)), prob }))
        .filter(({ idx }) => idx !== undefined);
      if (!tr.length) continue;
      arr.push({ id: a.id, costEx: a.costEx, transitions: tr });
    }
    transCache[i] = arr;
  }

  // ---- 3. Value iteration ------------------------------------------------
  let iter = 0;
  let converged = false;
  for (; iter < maxIter; iter++) {
    let maxDelta = 0;
    for (let i = 0; i < n; i++) {
      if (goalIdx.has(i)) continue;
      const arr = transCache[i];
      if (!arr || !arr.length) continue;
      let bestV = Infinity;
      for (const { costEx, transitions } of arr) {
        let acc = costEx;
        for (const { idx, prob } of transitions) acc += prob * V[idx];
        if (acc < bestV) bestV = acc;
      }
      const delta = Math.abs(bestV - V[i]);
      if (delta > maxDelta) maxDelta = delta;
      V[i] = bestV;
    }
    if (maxDelta < epsilon) { converged = true; break; }
  }

  // ---- 4. Best action per state -----------------------------------------
  const values = new Map();
  const bestAction = new Map();
  for (let i = 0; i < n; i++) {
    values.set(stateKey(states[i]), V[i]);
    if (goalIdx.has(i)) { bestAction.set(stateKey(states[i]), null); continue; }
    let bestId = null, bestV = Infinity;
    for (const { id, costEx, transitions } of transCache[i] || []) {
      let acc = costEx;
      for (const { idx, prob } of transitions) acc += prob * V[idx];
      if (acc < bestV) { bestV = acc; bestId = id; }
    }
    bestAction.set(stateKey(states[i]), bestId);
  }

  return {
    start: startState,
    reachableCount: n,
    values,
    bestAction,
    expectedCostFromStart: values.get(stateKey(startState)) ?? Infinity,
    converged,
    iterations: iter + 1,
  };
}

/**
 * Brick detection: a state s is "bricked" iff
 *   V*(s) > V*(start)
 * — the cheapest cost-to-target from s exceeds the cost-to-target from
 * scratch. Falls out of the solver for free; surface this in the UI to flag
 * which post-irreversible-action outcomes are bricks.
 */
export function isBricked(state, startState, values) {
  const v = values.get(stateKey(state));
  const v0 = values.get(stateKey(startState));
  if (v === undefined || v0 === undefined) return false;
  return v > v0;
}

void makeState;
