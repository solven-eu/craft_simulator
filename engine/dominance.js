// Action-dominance detection — STUB.
//
// Strict design rule (see `dominated actions` memory): the engine MUST NOT
// hardcode per-orb "this is bad" rules. Dominance is derived from the value
// function V*, computed by `engine/policy.js`'s value iteration:
//
//   action `a` from state `s` is dominated iff
//     cost(a) + Σ_s' P(s'|s,a) · V*(s')   >   V*(s)
//
// Equivalently: applying `a` is strictly worse than picking the best
// alternative from `s`. The Bellman optimum picks the un-dominated action.
//
// This module exposes:
//   - `isDominatedByValue(state, action, ctx, V)` — runtime check using the
//     converged or partially-converged value function `V`.
//   - `staticallyDominated(state, action, ctx)` — cheaper precomputation:
//     true when every outcome state is strictly worse than `state` under a
//     partial order on states (no costs / no V* needed). Useful as a first
//     pruning pass before invoking the full solver.

import { stateKey, popcount } from './state.js';

/**
 * Dominance check using the (possibly partial) value function.
 *
 * @param {object} state
 * @param {{ costEx: number, transitions: (s) => Array<{to,prob}> }} action
 * @param {Map<string, number>} V       state-key -> V*(state)
 * @param {number} [tol=0]              tolerance for ties
 * @returns {boolean}
 */
export function isDominatedByValue(state, action, V, tol = 0) {
  const sk = stateKey(state);
  const vSelf = V.get(sk);
  if (vSelf === undefined) return false; // can't decide
  const transitions = action.transitions(state) || [];
  let expected = 0;
  for (const { to, prob } of transitions) {
    const v = V.get(stateKey(to));
    if (v === undefined) return false; // outcome unscored — can't decide
    expected += prob * v;
  }
  return action.costEx + expected > vSelf + tol;
}

/**
 * Static dominance check using a *partial order* on states.
 *
 * The order used here: a state s' is "weakly worse" than s iff
 *   - it has at most as many wished hits, AND
 *   - it has at least as many irrelevant affixes per side.
 * "Strictly worse" requires at least one strict comparison.
 *
 * If every outcome of `action` is strictly worse than `state` under this
 * order, the action is dominated regardless of costs (any positive cost
 * would only make it worse).
 *
 * @param {object} state
 * @param {{ transitions: (s) => Array<{to,prob}> }} action
 * @returns {boolean}
 */
export function staticallyDominated(state, action) {
  const transitions = action.transitions(state) || [];
  if (!transitions.length) return false;
  const w0 = popcount(state.wishedMask);
  for (const { to, prob } of transitions) {
    if (prob <= 0) continue;
    const w1 = popcount(to.wishedMask);
    const wishedNotWorse = w1 < w0;             // strictly fewer hits
    const wishedTied = w1 === w0;
    const irrPNotWorse = to.prefixIrrelevant > state.prefixIrrelevant;
    const irrSNotWorse = to.suffixIrrelevant > state.suffixIrrelevant;
    const wishedSame = wishedTied && to.prefixIrrelevant >= state.prefixIrrelevant && to.suffixIrrelevant >= state.suffixIrrelevant;
    const strictlyWorse = wishedNotWorse || (wishedTied && (irrPNotWorse || irrSNotWorse));
    const weaklyWorse = (w1 <= w0) && (to.prefixIrrelevant >= state.prefixIrrelevant) && (to.suffixIrrelevant >= state.suffixIrrelevant);
    if (!(strictlyWorse || (weaklyWorse && wishedSame))) {
      // outcome is NOT weakly-worse → action might be useful
      return false;
    }
  }
  // every outcome is at-best equal-or-worse, with at least one strict-worse
  // outcome → action cannot improve the state on average → dominated.
  // (We require at least one strict to avoid pruning no-ops.)
  return transitions.some(({ to, prob }) => {
    if (prob <= 0) return false;
    const w1 = popcount(to.wishedMask);
    return (w1 < popcount(state.wishedMask))
      || (to.prefixIrrelevant > state.prefixIrrelevant)
      || (to.suffixIrrelevant > state.suffixIrrelevant);
  });
}
