// Wishlist analytics — closed-form / DP, never sampled.
//
// Headline question (see project_problem_statement memory):
//   Given an acceptable affix set A (each with score s_a), and a hit
//   requirement (e.g. "≥ k of A"), what is the expected cost to craft an
//   item satisfying the requirement, under a chosen orb strategy?

/**
 * @typedef {Object} PoolMod
 * @property {string} key
 * @property {"PREFIX"|"SUFFIX"} type
 * @property {number} weight
 */

/**
 * @typedef {Object} DrawSpec
 * @property {number} prefixDraws
 * @property {number} suffixDraws
 */

/**
 * Exact Wallenius (weighted sampling without replacement) distribution of
 * "number of drawn items that match the wished predicate", for a single
 * pool and k draws.
 *
 * Returns an array `out[h]` = P(exactly h matches in k draws), h ∈ [0, k].
 *
 * Algorithm: enumerate ordered draws via DFS. At depth i, the conditional
 * probability of drawing item j next is `w_j / (W - Σ w_already_drawn)`.
 * Each leaf increments the bucket for its final hit count by the path
 * probability. Sums of orderings of a given subset reconstruct that subset's
 * Wallenius probability automatically.
 *
 * Complexity: O(M! / (M-k)!), fine for the project's typical sizes
 * (M ≲ 60, k ≤ 3).
 */
export function distributionByHits(pool, k, isWished) {
  const out = new Array(k + 1).fill(0);
  if (k === 0) { out[0] = 1; return out; }
  const W = pool.reduce((s, m) => s + (m.weight || 0), 0);
  if (!Number.isFinite(W) || W <= 0 || pool.length < k) { out[0] = 1; return out; }

  const drawn = new Array(pool.length).fill(false);
  function dfs(depth, hits, prob, remainingW) {
    if (depth === k) { out[hits] += prob; return; }
    for (let i = 0; i < pool.length; i++) {
      if (drawn[i]) continue;
      const m = pool[i];
      const w = m.weight || 0;
      if (w <= 0) continue;
      drawn[i] = true;
      const p = w / remainingW;
      dfs(depth + 1, hits + (isWished(m) ? 1 : 0), prob * p, remainingW - w);
      drawn[i] = false;
    }
  }
  dfs(0, 0, 1, W);
  return out;
}

/**
 * P(satisfy ≥ requiredHits) when `k` mods are drawn from a *single, unified*
 * pool by Wallenius weighted-without-replacement. Each mod carries its
 * inherent prefix/suffix tag, so the prefix/suffix split that emerges is the
 * natural outcome of the draw — no fixed split assumed.
 *
 * Use this for orbs that don't enforce a prefix/suffix split on their draw
 * (Alchemy in PoE2 produces a 4-mod rare with a *random* split; Chaos picks
 * uniformly across mods on the item; etc.).
 */
export function pHitWishlistUnified(pool, wishlist, k, requiredHits) {
  if (requiredHits <= 0) return 1;
  const wishedKeys = new Set(wishlist.map((w) => w.key));
  const dist = distributionByHits(pool, k, (m) => wishedKeys.has(m.key));
  let p = 0;
  for (let i = requiredHits; i < dist.length; i++) p += dist[i];
  return p;
}

/**
 * Probability that a single attempt satisfies "≥ requiredHits of A appear
 * on the rolled item", when prefix and suffix draw counts are *fixed*
 * independently (e.g. an exalt that targets only prefix slots).
 *
 * Convolves the prefix-side and suffix-side hit distributions and sums the
 * tail P(h_p + h_s ≥ requiredHits).
 */
export function pHitWishlist(pool, wishlist, draws, requiredHits) {
  const wishedKeys = new Set(wishlist.map((w) => w.key));
  const isWished = (m) => wishedKeys.has(m.key);
  const prefixPool = pool.filter((m) => m.type === 'PREFIX');
  const suffixPool = pool.filter((m) => m.type === 'SUFFIX');
  const distP = distributionByHits(prefixPool, draws.prefixDraws, isWished);
  const distS = distributionByHits(suffixPool, draws.suffixDraws, isWished);
  if (requiredHits <= 0) return 1;
  let p = 0;
  for (let i = 0; i < distP.length; i++) {
    if (!distP[i]) continue;
    for (let j = 0; j < distS.length; j++) {
      if (i + j >= requiredHits) p += distP[i] * distS[j];
    }
  }
  return p;
}

/**
 * Expected attempts and cost via geometric (i.i.d. attempts).
 *
 * @param {number} pPerAttempt
 * @param {number} costPerAttempt   In some currency (caller decides).
 */
export function geometricCost(pPerAttempt, costPerAttempt) {
  if (pPerAttempt <= 0) {
    return {
      pPerAttempt: 0,
      expectedAttempts: Infinity,
      expectedCost: Infinity,
      pWithin: () => 0,
    };
  }
  return {
    pPerAttempt,
    expectedAttempts: 1 / pPerAttempt,
    expectedCost: costPerAttempt / pPerAttempt,
    pWithin: (n) => 1 - Math.pow(1 - pPerAttempt, n),
  };
}
