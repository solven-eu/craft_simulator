// Analytical evaluator — closed-form / Markov chain only.
//
// Design rule (see feedback_analytical_not_simulation memory): this engine
// must NOT use random sampling to produce reported statistics. Every value
// returned here must be exact (or an analytical bound) and traceable to
// weights and combinatorics. The leading reference tools (craftofexile,
// pathofcrafting) rely on Monte Carlo; differentiating on rigor is a core
// value proposition of this project.

/**
 * Probability of drawing a specific candidate from a weighted pool.
 *
 * @param {number} weight    Candidate's weight.
 * @param {number} totalWeight  Sum of all eligible candidates' weights.
 * @returns {number} probability in [0, 1] (0 if pool empty).
 */
export function poolProbability(weight, totalWeight) {
  if (!totalWeight) return 0;
  return weight / totalWeight;
}

/**
 * Geometric statistics for "repeat an independent Bernoulli trial of success
 * probability `p` until the first success".
 *
 *   P(success on trial k)        = (1-p)^(k-1) · p
 *   P(success within n trials)   = 1 - (1-p)^n
 *   E[trials until success]      = 1/p
 *   Var[trials until success]    = (1-p)/p²
 *
 * @param {number} p   Per-trial success probability, in (0, 1].
 * @returns {{ expected: number, variance: number, stdDev: number,
 *             pWithin: (n: number) => number, pAtTrial: (k: number) => number }}
 */
export function geometric(p) {
  if (p <= 0) {
    return {
      expected: Infinity,
      variance: Infinity,
      stdDev: Infinity,
      pWithin: () => 0,
      pAtTrial: () => 0,
    };
  }
  const q = 1 - p;
  return {
    expected: 1 / p,
    variance: q / (p * p),
    stdDev: Math.sqrt(q) / p,
    pWithin: (n) => 1 - Math.pow(q, n),
    pAtTrial: (k) => Math.pow(q, k - 1) * p,
  };
}

/**
 * Build a transition matrix for a Markov chain over a finite, enumerated
 * state set. Caller supplies a function returning weighted outcomes per
 * state; this normalises them into row-stochastic transition probabilities.
 *
 * @template S
 * @param {S[]} states                          Enumerated state set.
 * @param {(s: S) => { to: S, weight: number }[]} transitions
 *        Outcome list for state `s` (weights need not sum to 1).
 * @param {(s: S) => number} index              Maps a state to its row index.
 * @returns {number[][]} P[i][j] = P(state i → state j) in one step.
 */
export function transitionMatrix(states, transitions, index) {
  const n = states.length;
  const P = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    const out = transitions(states[i]);
    const total = out.reduce((s, o) => s + o.weight, 0);
    if (!total) { P[i][i] = 1; continue; } // absorbing if no moves
    for (const o of out) {
      const j = index(o.to);
      P[i][j] += o.weight / total;
    }
  }
  return P;
}

/**
 * Expected hitting time from each transient state to any absorbing state,
 * by solving (I - Q) · t = 1 where Q is the sub-matrix over transient states.
 *
 * Uses Gauss-Jordan elimination — fine for the small state spaces the planner
 * deals with (typically ≤ a few hundred reachable states). For larger chains
 * we'll switch to an iterative solver.
 *
 * @param {number[][]} P                   Full transition matrix.
 * @param {number[]} transientIdx          Indices of transient states in P.
 * @returns {number[]} Expected steps to absorption, one per transient state.
 */
export function expectedHittingTime(P, transientIdx) {
  const n = transientIdx.length;
  // A = I - Q, b = 1
  const A = Array.from({ length: n }, (_, i) =>
    transientIdx.map((j, k) => (i === k ? 1 : 0) - P[transientIdx[i]][j]),
  );
  const b = new Array(n).fill(1);
  return solveLinear(A, b);
}

/** Solve A · x = b for x via Gauss-Jordan elimination with partial pivoting. */
export function solveLinear(A, b) {
  const n = A.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let i = 0; i < n; i++) {
    let pivot = i;
    for (let r = i + 1; r < n; r++) {
      if (Math.abs(M[r][i]) > Math.abs(M[pivot][i])) pivot = r;
    }
    if (Math.abs(M[pivot][i]) < 1e-12) throw new Error('Singular matrix');
    [M[i], M[pivot]] = [M[pivot], M[i]];
    const piv = M[i][i];
    for (let c = i; c <= n; c++) M[i][c] /= piv;
    for (let r = 0; r < n; r++) {
      if (r === i) continue;
      const factor = M[r][i];
      if (!factor) continue;
      for (let c = i; c <= n; c++) M[r][c] -= factor * M[i][c];
    }
  }
  return M.map((row) => row[n]);
}
