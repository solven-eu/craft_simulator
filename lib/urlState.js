// URL state synchronisation. Encodes a small subset of the planner's state
// into the URL hash so reloading or sharing the link restores everything:
// game, item base/ilvl, start slots, target slots, budget/time caps, custom
// currency rates, mechanic overrides.
//
// Format: `#...&s=<base64(URI(JSON))>`. Plain Vue-router-friendly (we use
// hash history). On reload we read the hash; on state change we
// `history.replaceState` so we don't pollute the back stack.

/** Fields persisted to URL. Order matters only for stability of diffs. */
export const SHAREABLE_FIELDS = [
  'gameId',
  'itemType',
  'base',
  'itemLevel',
  'slots',
  'startRarity',
  // Whether the starting item carries an unrevealed bone-mod (a
  // phantom slot from a prior apply_bone awaiting Well-of-Souls
  // reveal). Engine maps to start.boneMod = true.
  'startingBoneMod',
  'targetEntries',
  'targetSlots',  // legacy — read on load for migration; new writes use targetEntries
  'wishlist',
  'requiredHits',
  'minFilled',
  'maxFilled',
  'minDesireScore',
  'basePriceEx',
  'fracturedAnchorPriceEx',
  'totalBudgetEx',
  'totalTimeSec',
  'timeWeightExPerSec',
  'actionCostCapEx',
  'referenceCurrency',
  'rateOverrides',
  'mechanicsOverrides',
  'timeOverrides',
  'showRawData',
  'tierComparisonMode',
  'divThresholdDiv',
];

const PARAM = 's';

function encode(obj) {
  // Drop fields that hold the loaded catalogs (mods/omens/etc.) — they're
  // big and re-fetched on game load.
  const json = JSON.stringify(obj, (k, v) => {
    if (typeof v === 'number' && !Number.isFinite(v)) {
      return v === Infinity ? '__inf' : v === -Infinity ? '__minf' : null;
    }
    return v;
  });
  return btoa(encodeURIComponent(json));
}

function decode(str) {
  try {
    const json = decodeURIComponent(atob(str));
    return JSON.parse(json, (k, v) => {
      if (v === '__inf') return Infinity;
      if (v === '__minf') return -Infinity;
      return v;
    });
  } catch { return null; }
}

/** Read shareable state from the current URL hash; returns null if none. */
export function readURLState() {
  if (typeof window === 'undefined') return null;
  const h = window.location.hash || '';
  const m = new RegExp(`[?&]${PARAM}=([^&]+)`).exec(h);
  if (!m) return null;
  return decode(m[1]);
}

/**
 * Update the URL hash to reflect `state` (only the SHAREABLE_FIELDS subset).
 * Uses history.replaceState so we don't add to the back-button stack.
 */
export function writeURLState(state) {
  if (typeof window === 'undefined') return;
  const subset = {};
  for (const f of SHAREABLE_FIELDS) {
    if (f in state) subset[f] = state[f];
  }
  const encoded = encode(subset);
  let hash = window.location.hash || '#/';
  hash = hash.replace(new RegExp(`[?&]${PARAM}=[^&]*`), '');
  const sep = hash.includes('?') ? '&' : '?';
  const newHash = hash + sep + PARAM + '=' + encoded;
  if (newHash !== window.location.hash) {
    history.replaceState(null, '', window.location.pathname + window.location.search + newHash);
  }
}

/** Tiny debounce for hot-write paths (typing in inputs). */
export function debounce(fn, ms = 200) {
  let t = null;
  return function (...args) {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn.apply(this, args), ms);
  };
}
