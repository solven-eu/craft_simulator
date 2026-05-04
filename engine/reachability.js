// Reachability check — STUB.
//
// Question: from `state`, can ANY sequence of *reversible* actions reach a
// state in the goal-set? Pure graph problem: BFS over edges with prob > 0,
// using only actions tagged `irreversible: false` (or unspecified).
//
// Used after irreversible-action outcomes (Fracturing Orb, Vaal Orb,
// some Perfect/Corrupted Essences). For each outcome state of an irreversible
// action, ask `canReach(outcome, isGoal, reversibleActions)`. If false, fold
// that outcome's probability mass into a "brick sink" with cost +∞.
//
// See `project_reachability_and_irreversible` memory for the full design.

import { stateKey, makeState } from './state.js';

/**
 * BFS-based reachability check.
 *
 * @param {object} state             Starting state.
 * @param {(s: object) => boolean} isGoal
 * @param {Array<{ irreversible?: boolean, transitions: (s: any) => Array<{ to: any, prob: number }> }>} actions
 *        Action set. Only actions with `irreversible !== true` are followed.
 * @param {{ maxStates?: number }} [opts]
 * @returns {boolean} true iff a goal state is reachable from `state`.
 */
export function canReach(state, isGoal, actions, opts = {}) {
  const maxStates = opts.maxStates ?? 50_000;
  const reversible = actions.filter((a) => !a.irreversible);
  const seen = new Set();
  const queue = [state];
  seen.add(stateKey(state));
  while (queue.length) {
    const s = queue.shift();
    if (isGoal(s)) return true;
    for (const a of reversible) {
      const transitions = a.transitions(s) || [];
      for (const { to, prob } of transitions) {
        if (prob <= 0) continue;
        const k = stateKey(to);
        if (seen.has(k)) continue;
        seen.add(k);
        if (seen.size > maxStates) return false; // safety
        queue.push(to);
      }
    }
  }
  return false;
}

/**
 * Convenience: precompute the set of "good" states (reachability TRUE)
 * once for a given goal + reversible-action-set, so subsequent
 * irreversible-action evaluations can lookup in O(1).
 *
 * Returns a Set of stateKeys for which a goal is reachable.
 */
export function reachableGoodSet(allStates, isGoal, reversibleActions) {
  // Build reverse graph and BFS backward from goal states.
  const byKey = new Map();
  for (const s of allStates) byKey.set(stateKey(s), s);
  const reverseAdj = new Map(); // key -> [predecessor keys]
  for (const s of allStates) {
    const sk = stateKey(s);
    for (const a of reversibleActions) {
      for (const { to, prob } of a.transitions(s) || []) {
        if (prob <= 0) continue;
        const tk = stateKey(to);
        if (!reverseAdj.has(tk)) reverseAdj.set(tk, []);
        reverseAdj.get(tk).push(sk);
      }
    }
  }
  const good = new Set();
  const queue = [];
  for (const s of allStates) {
    if (isGoal(s)) {
      const k = stateKey(s);
      good.add(k);
      queue.push(k);
    }
  }
  while (queue.length) {
    const k = queue.shift();
    for (const p of reverseAdj.get(k) ?? []) {
      if (good.has(p)) continue;
      good.add(p);
      queue.push(p);
    }
  }
  return good;
}

void makeState; // keep import alive for future use
