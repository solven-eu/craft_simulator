// resetToWhite — sub-strategy / utility, not a top-level strategy.
//
// "Reset to a Normal (white) base with no affixes" is a building block many
// strategies need between attempts. There are two ways to do it:
//
//   1. Annul every current mod (T annulments). Only valid when no affix is
//      fractured (annul cannot remove a fractured affix), and the item is
//      Rare/Magic (annul accepts those rarities).
//   2. Procure a fresh base at `basePriceEx`. Always valid; produces a
//      Normal item.
//
// We pick whichever is cheaper. Returns { costEx, timeSec, method, notes }.
// Callers fold this cost into their per-attempt accounting.

import { orbCostEx } from '../strategy-utils.js';

/**
 * @param {object} ctx                      Strategy context (same shape used
 *                                          everywhere else).
 * @param {object} [opts]
 * @param {boolean} [opts.fractured]        true if the current item has any
 *                                          fractured affix (annul cannot
 *                                          clear it). Defaults to false.
 * @param {number}  [opts.modCount]         Override the count of mods to
 *                                          annul. Defaults to the starting
 *                                          item's prefixes + suffixes.
 */
export function resetToWhite(ctx, opts = {}) {
  const fractured = !!opts.fractured;
  const modCount = Number.isFinite(opts.modCount)
    ? opts.modCount
    : (ctx.startingCounts?.prefixes ?? 0) + (ctx.startingCounts?.suffixes ?? 0);

  const annulPer = orbCostEx('annulment', ctx);
  const annulTimePer = ctx.orbs?.annulment?.timeSeconds ?? 0;
  const annulCost = Number.isFinite(annulPer) ? modCount * annulPer : NaN;
  const annulTime = modCount * annulTimePer;
  const annulPossible = !fractured && Number.isFinite(annulCost) && modCount >= 0;

  const basePrice = Number.isFinite(ctx.basePriceEx) ? ctx.basePriceEx : NaN;
  // Procurement time isn't tracked separately yet — treat as ~0 wall-clock
  // (purchases are async / out-of-band relative to crafting).
  const baseTime = 0;
  const basePossible = Number.isFinite(basePrice);

  // Pick the cheaper option that's actually applicable.
  const candidates = [];
  if (annulPossible) candidates.push({ method: 'annul', costEx: annulCost, timeSec: annulTime });
  if (basePossible) candidates.push({ method: 'procure', costEx: basePrice, timeSec: baseTime });

  if (!candidates.length) {
    return { costEx: NaN, timeSec: NaN, method: null, notes: 'no reset path: annul blocked (fractured) and base price missing' };
  }
  candidates.sort((a, b) => a.costEx - b.costEx);
  const best = candidates[0];
  const note = best.method === 'annul'
    ? `annul ×${modCount} = ${annulCost.toFixed(2)} ex (vs procure ${Number.isFinite(basePrice) ? basePrice : '∞'} ex)`
    : `procure new base = ${basePrice} ex (vs ${annulPossible ? 'annul ' + annulCost.toFixed(2) + ' ex' : (fractured ? 'annul blocked: fractured' : 'annul N/A')})`;
  return { ...best, notes: note };
}
