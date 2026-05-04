// Divine Bench — closed-form probability that N Divine Orbs improve
// a given item to user-specified target value thresholds.
//
// PoE2 Divine Orb re-rolls each modifier's VALUE within its tier-
// determined range, leaving affix identity and tier untouched. Mods
// re-roll independently per orb. The user states a target threshold
// per modifier (the floor they'd accept); we compute:
//
//   - per-mod P(rolled value ≥ target) — using a discretized value
//     space (round-numbers density).
//   - joint per-divine P = Π per-mod P (independence assumption).
//   - geometric over N orbs: P(success within N) = 1 - (1-P)^N.
//   - E[divines to first success] = 1 / P.
//
// Discretization rule (per user spec):
//   - If max − min ≥ 3: integer round-number values (max − min + 1
//     buckets). Fits the typical PoE2 ranges like "+30..+50 Life"
//     where the player thinks in integers.
//   - If max − min < 3 (e.g. "+1.5%..+2.0% movement speed"): split
//     the range into 10 evenly spaced buckets so percentage / decimal
//     mods get useful resolution.

/**
 * Build the discrete value set a Divine Orb can roll for a modifier
 * with continuous range [vmin, vmax].
 */
export function discretize(vmin, vmax) {
  if (!Number.isFinite(vmin) || !Number.isFinite(vmax) || vmax < vmin) return [vmin];
  const range = vmax - vmin;
  if (range >= 3) {
    // Integer round-numbers across [round(vmin), round(vmax)].
    const lo = Math.round(vmin);
    const hi = Math.round(vmax);
    const out = new Array(hi - lo + 1);
    for (let i = 0; i <= hi - lo; i++) out[i] = lo + i;
    return out;
  }
  // 10 evenly-spaced buckets inclusive of both endpoints (step =
  // range / 9 covers exactly 10 values from vmin to vmax).
  const N = 10;
  const out = new Array(N);
  for (let i = 0; i < N; i++) out[i] = vmin + (range * i) / (N - 1);
  return out;
}

/**
 * Per-mod probability that a fresh divine roll lands at or above the
 * user's target threshold. Each bucket is equally likely (uniform
 * density assumption — refine to per-bucket weights once measured).
 *
 * @param {object} mod — { vmin, vmax, target }
 */
export function pModMeetsTarget(mod) {
  const { vmin, vmax, target } = mod;
  const buckets = discretize(vmin, vmax);
  if (!buckets.length) return 0;
  const acceptable = buckets.filter((v) => v >= target).length;
  return acceptable / buckets.length;
}

/**
 * Joint probability per divine that every modifier on the item lands
 * at or above its target. Mods are independent under Divine Orb (it
 * re-rolls every value once per use), so probabilities multiply.
 */
export function pItemMeetsTargets(mods) {
  if (!Array.isArray(mods) || mods.length === 0) return 1; // vacuous
  let p = 1;
  for (const m of mods) p *= pModMeetsTarget(m);
  return p;
}

/**
 * Probability that within N divines (N ≥ 0), at least one re-roll
 * satisfies every target. Geometric: 1 − (1 − p)^N.
 */
export function pSuccessWithinN(mods, N) {
  if (!Number.isFinite(N) || N <= 0) return 0;
  const p = pItemMeetsTargets(mods);
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  return 1 - Math.pow(1 - p, N);
}

/**
 * Expected number of divines until the first roll satisfies every
 * target. Returns Infinity when at least one mod is unreachable
 * (target above the mod's max).
 */
export function expectedDivinesToSuccess(mods) {
  const p = pItemMeetsTargets(mods);
  if (p <= 0) return Infinity;
  return 1 / p;
}

/**
 * Convenience: full summary for the UI.
 *
 * @param {object[]} mods — list of { name, vmin, vmax, target } per mod.
 * @param {object} opts
 *   @param {number} opts.N             — divine count budget.
 *   @param {number} opts.divinePriceEx — divine cost in exalted.
 * @returns {object}
 */
export function summarize(mods, { N = 1, divinePriceEx = 187 } = {}) {
  const perMod = mods.map((m) => ({
    name: m.name,
    vmin: m.vmin,
    vmax: m.vmax,
    target: m.target,
    bucketCount: discretize(m.vmin, m.vmax).length,
    pPerDivine: pModMeetsTarget(m),
  }));
  const pPerDivine = pItemMeetsTargets(mods);
  const pWithinN = pSuccessWithinN(mods, N);
  const expectedDivines = expectedDivinesToSuccess(mods);
  const expectedCostEx = Number.isFinite(expectedDivines)
    ? expectedDivines * divinePriceEx
    : Infinity;
  return {
    perMod,
    pPerDivine,
    pWithinN,
    expectedDivines,
    expectedCostEx,
    divinePriceEx,
    N,
  };
}
