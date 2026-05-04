// Item-state representation for the Markov-chain solver.
//
// Today's strategies in engine/strategies.js operate at whole-game granularity
// (E[cost] per standalone strategy). This module is the foundation for the
// per-step state graph: each state captures everything that affects the
// distribution of next-step transitions, and nothing more.
//
// Equivalence rule (default, no whittling in scope):
//   Two items are the same state iff they have the same wishlist-bitmask AND
//   the same count of irrelevant prefixes AND the same count of irrelevant
//   suffixes. Tier and tag of irrelevant affixes are dropped — none of the
//   default action operators (Chaos / Exalt / Annul / Alch / Essence /
//   Sinistral- or Dextral-Exalt) depend on them.
//
// With whittling in scope, the state extends with two booleans:
//   prefixLowestIsIrrelevant, suffixLowestIsIrrelevant
// — capturing whether the lowest-ilvl mod on each side is one of the
// irrelevants (which whittling will remove on next click). Absolute tiers
// don't matter even here; only relative order does.
//
// See `project_state_representation` and `project_budget_scoped_actions`
// memories for the design discussion.

/**
 * Canonical Markov state.
 *
 * @typedef {Object} ItemState
 * @property {'normal'|'magic'|'rare'|'corrupted'} rarity
 *           Normal: no affixes; Magic: 1–2; Rare: up to 6; Corrupted: terminal.
 *           Most orbs gate on rarity (e.g. Chaos requires Rare; Alchemy
 *           requires Normal/Magic; Vaal makes the item Corrupted — terminal).
 * @property {number} wishedMask              Bit i set iff wishlist[i] is on the item.
 * @property {number} prefixIrrelevant        Count of irrelevant prefix affixes (0..3).
 * @property {number} suffixIrrelevant        Count of irrelevant suffix affixes (0..3).
 * @property {boolean} [prefixLowestIsIrrelevant]
 *           Optional: only populated when whittling is in the action set.
 * @property {boolean} [suffixLowestIsIrrelevant]
 *           Optional: only populated when whittling is in the action set.
 */

/** Build a canonical state. Counts are clamped into [0, 3]. */
export function makeState({
  rarity = 'rare',
  wishedMask = 0,
  prefixIrrelevant = 0,
  suffixIrrelevant = 0,
  prefixLowestIsIrrelevant,
  suffixLowestIsIrrelevant,
} = {}) {
  const s = {
    rarity,
    wishedMask,
    prefixIrrelevant: Math.max(0, Math.min(3, prefixIrrelevant | 0)),
    suffixIrrelevant: Math.max(0, Math.min(3, suffixIrrelevant | 0)),
  };
  if (prefixLowestIsIrrelevant !== undefined) {
    s.prefixLowestIsIrrelevant = Boolean(prefixLowestIsIrrelevant);
  }
  if (suffixLowestIsIrrelevant !== undefined) {
    s.suffixLowestIsIrrelevant = Boolean(suffixLowestIsIrrelevant);
  }
  return s;
}

const RARITY_CODES = { normal: 'n', magic: 'm', rare: 'r', corrupted: 'c' };

/** Stable string key for use in Maps / Sets when enumerating states. */
export function stateKey(s) {
  let k = `${RARITY_CODES[s.rarity] ?? 'r'}|${s.wishedMask}|${s.prefixIrrelevant}|${s.suffixIrrelevant}`;
  if (s.prefixLowestIsIrrelevant !== undefined) {
    k += `|p${s.prefixLowestIsIrrelevant ? 1 : 0}`;
  }
  if (s.suffixLowestIsIrrelevant !== undefined) {
    k += `|s${s.suffixLowestIsIrrelevant ? 1 : 0}`;
  }
  return k;
}

export function statesEqual(a, b) {
  return stateKey(a) === stateKey(b);
}

/** Helper: number of set bits in `mask` (popcount). */
export function popcount(mask) {
  let n = 0;
  while (mask) { mask &= mask - 1; n++; }
  return n;
}

/** Number of wished slots filled on `state`. */
export function wishedHits(state) { return popcount(state.wishedMask); }

/** Total filled prefix slots (wished prefixes + irrelevant prefixes). */
export function prefixCount(state, prefixWishedMask) {
  return popcount(state.wishedMask & prefixWishedMask) + state.prefixIrrelevant;
}

/** Total filled suffix slots. */
export function suffixCount(state, prefixWishedMask) {
  // suffix wished slots = wishedMask AND (NOT prefixWishedMask)
  return popcount(state.wishedMask & ~prefixWishedMask) + state.suffixIrrelevant;
}

/**
 * Estimated state-space size for given parameters. Useful as a sanity check
 * before the policy solver enumerates reachable states.
 */
export function estimateStateSpaceSize({ wishlistSize, whittling = false }) {
  const wished = 1 << wishlistSize;          // 2^|wishlist|
  const counts = 4 * 4;                       // prefixIrrelevant × suffixIrrelevant ∈ [0..3]
  const whittleMul = whittling ? 4 : 1;       // (P_low, S_low) ∈ {true,false}²
  return wished * counts * whittleMul;
}

/**
 * @typedef {Object} Action
 * @property {string} id
 * @property {string} label
 * @property {number} costEx        Cost of one application in Exalted.
 * @property {number} timeSeconds   Wall-clock per application.
 * @property {('normal'|'magic'|'rare'|'corrupted')[]} [applicableRarities]
 *           If specified, action is only applicable to states with one of
 *           these rarities. e.g. Chaos: ['rare']; Alchemy: ['normal','magic'];
 *           Vaal: ['normal','magic','rare']; etc. Default: any non-corrupted.
 * @property {boolean} [irreversible]   true for Fracturing, Vaal-corrupt, etc.
 * @property {(state: ItemState, ctx: any) => boolean} applicable
 *           Returns true iff this action can legally be applied to `state`.
 * @property {(state: ItemState, ctx: any) => { to: ItemState, prob: number }[]}
 *           transitions
 *           Pure function returning the distribution over next states.
 *           Probabilities must sum to 1.
 */

// NOTE: The actual transition operators (chaos, exalt, alchemy, essence,
// fracture, sinistral-exalt, …) will be implemented in a follow-up alongside
// `engine/policy.js` (Dijkstra over expected cost). This file establishes
// the data-class only.
