// Per-orb transition operators for the policy solver.
//
// Each `Action` encapsulates one orb (or orb+omen pair) as a state-graph
// transition: applicableRarities + applicable(state) gate where it can fire,
// transitions(state) returns the distribution over next states, and
// costEx/timeSeconds are bound at build time from the live currency table.
//
// Convention: state.wishedMask bit i corresponds to ctx.wishlist[i]. Whether
// a wishlist slot is a prefix or suffix is given by ctx.prefixWishlistBits
// (a bitmask: bit i set ⟺ wishlist[i] is a PREFIX). This avoids an extra
// per-bit lookup in the hot path.

import { popcount, makeState, stateKey } from './state.js';

/**
 * @typedef {Object} ActionCtx
 * @property {Array<{key:string,type:'PREFIX'|'SUFFIX',weight:number}>} wishlist
 *           Ordered wishlist; index = bit position in state.wishedMask.
 * @property {number} prefixWishlistBits   Bitmask of wishlist indices that are PREFIX.
 * @property {number[]} wishedWeights      Per-wishlist-index pool weight (0 if missing).
 * @property {number} prefixTotalWeight    Total prefix-side pool weight (eligible at ilvl).
 * @property {number} suffixTotalWeight    Total suffix-side pool weight.
 * @property {number} prefixWishedTotalWeight  Sum of prefix-side wishedWeights.
 * @property {number} suffixWishedTotalWeight  Sum of suffix-side wishedWeights.
 * @property {Record<string, {exaltedPer:number}>} currencies
 * @property {Record<string, {priceCurrency:string, timeSeconds:number}>} orbs
 */

/* ------------------------------------------------------------------ utils */

function orbCostEx(orbId, ctx) {
  const o = ctx.orbs[orbId];
  if (!o) return NaN;
  const c = ctx.currencies[o.priceCurrency];
  return c && Number.isFinite(c.exaltedPer) ? c.exaltedPer : NaN;
}

function totalOnItem(state) {
  return popcount(state.wishedMask) + state.prefixIrrelevant + state.suffixIrrelevant;
}

function prefixCount(state, ctx) {
  return popcount(state.wishedMask & ctx.prefixWishlistBits) + state.prefixIrrelevant;
}

function suffixCount(state, ctx) {
  return popcount(state.wishedMask & ~ctx.prefixWishlistBits) + state.suffixIrrelevant;
}

/**
 * Per-side draw distribution for "add one new mod to side X". Returns an array
 * of `{ patch, prob }` where `patch(state)` produces the next state.
 *
 * - With prob `wishedNotPresentWeight_i / sideTotalWeight` the addition lands
 *   on wishlist index `i` (sets bit i).
 * - With prob `irrelevantWeight / sideTotalWeight` the addition is irrelevant
 *   (increments prefix/suffix Irrelevant counter).
 *
 * `irrelevantWeight = sideTotalWeight - sum(wishedNotPresentWeights)`. This
 * collapses the "could be any of many irrelevant mods" branches into a single
 * outcome, matching the count-only state representation.
 */
function sideAddOutcomes(state, ctx, side) {
  const isPrefix = side === 'PREFIX';
  const sideTotal = isPrefix ? ctx.prefixTotalWeight : ctx.suffixTotalWeight;
  if (!sideTotal) return [];
  const out = [];
  let wishedAccounted = 0;
  for (let i = 0; i < ctx.wishlist.length; i++) {
    const isP = (ctx.prefixWishlistBits >> i) & 1;
    if (isP !== (isPrefix ? 1 : 0)) continue;
    const present = (state.wishedMask >> i) & 1;
    if (present) continue;
    const w = ctx.wishedWeights[i];
    if (w <= 0) continue;
    out.push({
      kind: 'addWished',
      index: i,
      prob: w / sideTotal,
    });
    wishedAccounted += w;
  }
  const irrelevantW = sideTotal - wishedAccounted;
  if (irrelevantW > 0) {
    out.push({
      kind: 'addIrrelevant',
      side,
      prob: irrelevantW / sideTotal,
    });
  }
  return out;
}

/** Sum probabilities of duplicate states in a transition list. */
function mergeDuplicates(transitions) {
  const byKey = new Map();
  for (const { to, prob } of transitions) {
    if (prob <= 0) continue;
    const k = stateKey(to);
    const cur = byKey.get(k);
    if (cur) cur.prob += prob;
    else byKey.set(k, { to, prob });
  }
  return [...byKey.values()];
}

/**
 * "Add one random mod" outcome distribution — the kernel underlying both
 * exalt and the post-remove half of chaos. Side selected by open-slots ×
 * side-pool weight; outcomes split by wished-bit / irrelevant-bucket.
 */
function addOneModOutcomes(state, ctx) {
  const openP = 3 - prefixCount(state, ctx);
  const openS = 3 - suffixCount(state, ctx);
  if (openP <= 0 && openS <= 0) return [{ to: state, prob: 1 }];
  const wP = Math.max(0, openP) * ctx.prefixTotalWeight;
  const wS = Math.max(0, openS) * ctx.suffixTotalWeight;
  const total = wP + wS;
  if (total <= 0) return [{ to: state, prob: 1 }];
  const out = [];
  if (wP > 0) {
    const sideProb = wP / total;
    for (const o of sideAddOutcomes(state, ctx, 'PREFIX')) {
      out.push({ to: applyAdd(state, o), prob: sideProb * o.prob });
    }
  }
  if (wS > 0) {
    const sideProb = wS / total;
    for (const o of sideAddOutcomes(state, ctx, 'SUFFIX')) {
      out.push({ to: applyAdd(state, o), prob: sideProb * o.prob });
    }
  }
  return out;
}

/**
 * "Remove one random mod" outcome distribution — the kernel underlying both
 * annul and the pre-add half of chaos.
 */
function removeOneModOutcomes(state, ctx) {
  const total = totalOnItem(state);
  if (total <= 0) return [{ to: state, prob: 1 }];
  const out = [];
  for (let i = 0; i < ctx.wishlist.length; i++) {
    if (((state.wishedMask >> i) & 1) === 0) continue;
    const next = makeState({ ...state, wishedMask: state.wishedMask & ~(1 << i) });
    out.push({ to: next, prob: 1 / total });
  }
  if (state.prefixIrrelevant > 0) {
    out.push({
      to: makeState({ ...state, prefixIrrelevant: state.prefixIrrelevant - 1 }),
      prob: state.prefixIrrelevant / total,
    });
  }
  if (state.suffixIrrelevant > 0) {
    out.push({
      to: makeState({ ...state, suffixIrrelevant: state.suffixIrrelevant - 1 }),
      prob: state.suffixIrrelevant / total,
    });
  }
  return out;
}

function applyAdd(state, outcome) {
  if (outcome.kind === 'addWished') {
    return makeState({
      ...state,
      wishedMask: state.wishedMask | (1 << outcome.index),
    });
  }
  if (outcome.side === 'PREFIX') {
    return makeState({ ...state, prefixIrrelevant: state.prefixIrrelevant + 1 });
  }
  return makeState({ ...state, suffixIrrelevant: state.suffixIrrelevant + 1 });
}

/* --------------------------------------------------------------- actions */

/**
 * Exalted Orb: Rare with < 6 mods → adds 1 random mod.
 * Side selected weighted by `(open_slots_side × side_pool_weight)` —
 * approximation that captures both the available-slot constraint and the
 * pool's intrinsic side bias.
 */
function exaltAction(ctx) {
  return {
    id: 'exalt',
    label: 'Exalted Orb',
    costEx: orbCostEx('exalted', ctx),
    timeSeconds: ctx.orbs.exalted?.timeSeconds ?? 2,
    applicableRarities: ['rare'],
    applicable: (s) => s.rarity === 'rare' && totalOnItem(s) < 6,
    transitions: (state) => addOneModOutcomes(state, ctx),
  };
}

/** Sinistral / Dextral exalt: forces side. */
function sideExaltAction(ctx, side) {
  const isPrefix = side === 'PREFIX';
  const id = isPrefix ? 'exalt-sinistral' : 'exalt-dextral';
  const omenCostEx = 10; // placeholder until poe2db Economy_Omen seeds omen prices
  return {
    id,
    label: isPrefix ? 'Exalt + Sinistral Omen (prefix-only)' : 'Exalt + Dextral Omen (suffix-only)',
    costEx: orbCostEx('exalted', ctx) + omenCostEx,
    timeSeconds: (ctx.orbs.exalted?.timeSeconds ?? 2) + 1,
    applicableRarities: ['rare'],
    applicable(s) {
      if (s.rarity !== 'rare') return false;
      const open = isPrefix ? (3 - prefixCount(s, ctx)) : (3 - suffixCount(s, ctx));
      return open > 0;
    },
    transitions(state) {
      const out = [];
      for (const o of sideAddOutcomes(state, ctx, side)) {
        out.push({ to: applyAdd(state, o), prob: o.prob });
      }
      return out.length ? out : [{ to: state, prob: 1 }];
    },
  };
}

/**
 * Orb of Annulment: removes 1 random affix uniformly from the item.
 * Magic items become Normal if last affix removed; Rare items stay Rare
 * (in PoE2; correct as of 0.3+).
 */
function annulAction(ctx) {
  return {
    id: 'annul',
    label: 'Orb of Annulment',
    costEx: orbCostEx('annulment', ctx),
    timeSeconds: ctx.orbs.annulment?.timeSeconds ?? 2,
    applicableRarities: ['magic', 'rare'],
    applicable: (s) => (s.rarity === 'magic' || s.rarity === 'rare') && totalOnItem(s) > 0,
    transitions: (state) => removeOneModOutcomes(state, ctx),
  };
}

/**
 * Chaos Orb: Rare → Rare. Removes one random mod, then adds one random mod.
 * Composition of `removeOneMod` and `addOneMod` kernels.
 */
function chaosAction(ctx) {
  return {
    id: 'chaos',
    label: 'Chaos Orb',
    costEx: orbCostEx('chaos', ctx),
    timeSeconds: ctx.orbs.chaos?.timeSeconds ?? 2,
    applicableRarities: ['rare'],
    applicable: (s) => s.rarity === 'rare' && totalOnItem(s) > 0,
    transitions(state) {
      const removed = removeOneModOutcomes(state, ctx);
      const out = [];
      for (const { to: midState, prob: pRemove } of removed) {
        const added = addOneModOutcomes(midState, ctx);
        for (const { to: finalState, prob: pAdd } of added) {
          out.push({ to: finalState, prob: pRemove * pAdd });
        }
      }
      return mergeDuplicates(out);
    },
  };
}

/**
 * Regal Orb: Magic → Rare, preserves existing affixes and adds 1 random mod.
 * Same add kernel as exalt; the rarity flips from 'magic' to 'rare'.
 */
function regalAction(ctx) {
  return {
    id: 'regal',
    label: 'Regal Orb',
    costEx: orbCostEx('regal', ctx),
    timeSeconds: ctx.orbs.regal?.timeSeconds ?? 2,
    applicableRarities: ['magic'],
    applicable: (s) => s.rarity === 'magic',
    transitions(state) {
      const rareState = makeState({ ...state, rarity: 'rare' });
      const adds = addOneModOutcomes(rareState, ctx);
      // adjust each outcome's rarity (already 'rare' from rareState seed).
      return adds.map(({ to, prob }) => ({ to, prob }));
    },
  };
}

/**
 * Orb of Transmutation: Normal → Magic, adds 1 mod (PoE2 0.3.1+ may add 2 —
 * we model the 1-mod baseline; aug fills the second slot if desired).
 */
function transmuteAction(ctx) {
  return {
    id: 'transmute',
    label: 'Orb of Transmutation',
    costEx: orbCostEx('transmute', ctx),
    timeSeconds: ctx.orbs.transmute?.timeSeconds ?? 2,
    applicableRarities: ['normal'],
    applicable: (s) => s.rarity === 'normal',
    transitions(state) {
      const magicState = makeState({ ...state, rarity: 'magic' });
      const adds = addOneModOutcomes(magicState, ctx);
      return adds;
    },
  };
}

/**
 * Orb of Augmentation: Magic with 1 mod → Magic with 2 mods.
 */
function augmentAction(ctx) {
  return {
    id: 'augment',
    label: 'Orb of Augmentation',
    costEx: orbCostEx('augment', ctx),
    timeSeconds: ctx.orbs.augment?.timeSeconds ?? 2,
    applicableRarities: ['magic'],
    applicable: (s) => s.rarity === 'magic' && totalOnItem(s) === 1,
    transitions: (state) => addOneModOutcomes(state, ctx),
  };
}

/**
 * Vaal Orb: any non-corrupted → corrupted (terminal). The full Vaal kernel
 * has multiple sub-outcomes (re-roll, add socket, change implicit, no
 * change, brick) — for v1 we model only the "corrupts" effect, marking the
 * action as irreversible.
 */
function vaalAction(ctx) {
  return {
    id: 'vaal',
    label: 'Vaal Orb',
    costEx: orbCostEx('vaal', ctx),
    timeSeconds: ctx.orbs.vaal?.timeSeconds ?? 3,
    applicableRarities: ['normal', 'magic', 'rare'],
    irreversible: true,
    applicable: (s) => s.rarity !== 'corrupted',
    transitions(state) {
      // v1: simple "freeze the current state, mark corrupted". Real Vaal
      // has a multi-arm distribution; refine when modelling Vaal strategies.
      return [{ to: makeState({ ...state, rarity: 'corrupted' }), prob: 1 }];
    },
  };
}

/* Still scaffolded:
 *
 *   alchemy     normal/magic → rare + 4 mods   — multi-arm 4-draw kernel.
 *                                                Covered today by the
 *                                                whole-game "Alch fresh bases"
 *                                                strategy; per-step Action
 *                                                model needs the unified
 *                                                Wallenius enumeration.
 *
 * The other rarity-shifters (transmute, augment, regal, chaos, exalt, annul,
 * vaal) are now concrete `Action` objects.
 */

/** Build the full action set for a given context. */
export function buildActions(ctx) {
  const actions = [
    transmuteAction(ctx),
    augmentAction(ctx),
    regalAction(ctx),
    exaltAction(ctx),
    sideExaltAction(ctx, 'PREFIX'),
    sideExaltAction(ctx, 'SUFFIX'),
    annulAction(ctx),
    chaosAction(ctx),
    vaalAction(ctx),
  ];
  // Drop actions whose costEx is NaN (= currency rate missing) — they'd
  // cause the solver to reject every path.
  return actions.filter((a) => Number.isFinite(a.costEx));
}
