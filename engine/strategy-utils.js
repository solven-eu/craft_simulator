// Shared helpers for strategy modules.

/** Cost of one orb in Exalted, or NaN if rate missing. */
export function orbCostEx(orbId, ctx) {
  const orb = ctx.orbs[orbId];
  if (!orb) return NaN;
  const ccy = ctx.currencies[orb.priceCurrency];
  if (!ccy || !Number.isFinite(ccy.exaltedPer)) return NaN;
  return ccy.exaltedPer; // priceAmount is 1 for the orbs we model
}
