// MDP state representation.
//
// State of an item under MDP-α: a small struct that captures everything
// the solver needs to decide the next action.
//
//   rarity       'normal' | 'magic' | 'rare'
//   modMask      bitmask over the user's wishlist (bit i set ⇒ wished
//                  mod i is currently on the item)
//   totalMods    total mod count on the item (incl. irrelevant). For
//                  Normal / Magic this is constrained: 0 / 1-2 / 4-6.
//   fracturedBit bit index of the wished mod that's fractured, or -1
//                  if no wished mod is fractured. (We DON'T track
//                  fracturing of irrelevant mods — that's still a brick
//                  for any target that demands a specific fracture, and
//                  modeling it would explode the state space.)
//   irrFractured  true ⇔ an irrelevant mod is fractured (poisons the
//                  item — no wished fracture can ever land here).
//   boneMod      true ⇔ a Bone-class desecrated currency has been
//                  applied. Two phases:
//                  - Pre-reveal (boneMod=true, boneRevealed=false):
//                    one hidden affix slot exists; pads totalMods for
//                    Fracture's ≥minModsToFracture threshold without
//                    being pickable by Fracture/Annul.
//                  - Post-reveal (boneRevealed=true): the bone slot
//                    has been resolved into a real affix; totalMods
//                    grew by 1, modMask may have a wished bit set if
//                    the reveal landed a desecrated wished mod, and
//                    Fracture's lock pool now includes that affix
//                    (it's a normal mod from this point on).
//   boneRevealed true ⇔ the bone-mod has gone through the reveal
//                  step. Once revealed, the slot is a normal affix.
//
// State key (string) is the canonical form for use as Map key. Two
// states with identical keys are operationally identical.

export function makeState({
  rarity = 'normal',
  modMask = 0,
  // Symmetric side counts: prefixMods + suffixMods = totalMods.
  // We track BOTH explicitly — the previous representation stored
  // `(totalMods, prefixMods)` and derived `suffixMods = total -
  // prefix`, but that's asymmetric and let total drift from the
  // sum of the two sides on partial updates. Now totalMods is a
  // computed convenience field on the returned state object so
  // every read is the live sum.
  prefixMods = 0,
  suffixMods = null, // null ⇒ derive from totalMods if provided (legacy callers)
  totalMods = null,  // legacy: when suffixMods is omitted, suffixMods = totalMods - prefixMods.
  desecratedWishedMask = 0,
  desecratedIrrPrefix = 0,
  desecratedIrrSuffix = 0,
  fracturedBit = -1,
  irrFractured = false,
  boneMod = false,
  boneRevealed = false,
  boneSide = null,
} = {}) {
  // Resolve suffixMods. Priority order:
  //   1. totalMods passed → suffix = total - prefix (legacy actions
  //      pass `{...s, totalMods: s.totalMods + 1, prefixMods: …}`;
  //      the spread brings along the OLD suffixMods, but the
  //      override of totalMods is the caller's intent — derive
  //      suffix from total to keep the sum consistent).
  //   2. suffixMods passed (new-style callers): use as-is.
  //   3. Neither passed:                      suffix = 0.
  let pref = prefixMods | 0;
  let suff;
  if (totalMods != null) {
    suff = Math.max(0, (totalMods | 0) - pref);
  } else if (suffixMods != null) {
    suff = suffixMods | 0;
  } else {
    suff = 0;
  }
  const total = pref + suff;
  return Object.freeze({
    rarity, modMask,
    prefixMods: pref, suffixMods: suff, totalMods: total,
    desecratedWishedMask, desecratedIrrPrefix, desecratedIrrSuffix,
    fracturedBit, irrFractured, boneMod, boneRevealed, boneSide,
  });
}

export function stateKey(s) {
  // Key by (rarity, modMask, prefixMods, suffixMods, …) — totalMods is
  // intentionally omitted because it's prefixMods + suffixMods. Two
  // states with the same per-side breakdown have the same total by
  // definition, so dropping totalMods removes the redundant axis from
  // the partition without losing information.
  return `${s.rarity}|${s.modMask}|${s.prefixMods ?? 0}|${s.suffixMods ?? 0}|${s.desecratedWishedMask ?? 0}|${s.desecratedIrrPrefix ?? 0}|${s.desecratedIrrSuffix ?? 0}|${s.fracturedBit}|${s.irrFractured ? 1 : 0}|${s.boneMod ? 1 : 0}|${s.boneRevealed ? 1 : 0}|${s.boneSide ?? '-'}`;
}

export function popcount(n) {
  let c = 0;
  while (n) { c += n & 1; n >>>= 1; }
  return c;
}

/**
 * Total desecrated count on the item, derived from state. Replaces the
 * previous `s.desecratedCount` field — that field could drift from the
 * underlying mask + per-side counts if any action updated one without
 * the others. Now computed on demand so the invariants hold by
 * construction.
 */
export function desecratedCount(s) {
  return popcount(s.desecratedWishedMask ?? 0)
       + (s.desecratedIrrPrefix ?? 0)
       + (s.desecratedIrrSuffix ?? 0);
}

/**
 * Per-side desecrated count, derived. Needs `wishlistTypes` so the
 * function knows each wished bit's natural side.
 */
export function desecratedPrefixCount(s, wishlistTypes = []) {
  let n = 0;
  const mask = s.desecratedWishedMask ?? 0;
  for (let i = 0; i < wishlistTypes.length; i++) {
    if ((mask & (1 << i)) && wishlistTypes[i] === 'PREFIX') n++;
  }
  return n + (s.desecratedIrrPrefix ?? 0);
}

export function desecratedSuffixCount(s, wishlistTypes = []) {
  let n = 0;
  const mask = s.desecratedWishedMask ?? 0;
  for (let i = 0; i < wishlistTypes.length; i++) {
    if ((mask & (1 << i)) && wishlistTypes[i] === 'SUFFIX') n++;
  }
  return n + (s.desecratedIrrSuffix ?? 0);
}

/**
 * Goal predicate. Encodes the user's wishlist:
 *   - requiredMask: every bit in `requiredMask` must be set in `modMask`.
 *   - fracturedBit: if `targetFracturedBit != -1`, that bit must be both
 *     set in `modMask` AND match the state's `fracturedBit`.
 *   - poisoned: an irrelevant fracture immediately disqualifies (the
 *     fracture target can never land afterwards).
 *
 * Returns true ⇔ the state satisfies the goal. The state is then
 * absorbing in the MDP.
 */
export function isGoalState(s, target) {
  if (s.irrFractured && target.fracturedBit >= 0) return false;
  if ((s.modMask & target.requiredMask) !== target.requiredMask) return false;
  if (target.fracturedBit >= 0 && s.fracturedBit !== target.fracturedBit) return false;
  // A pending bone (boneMod && !boneRevealed) is a hidden affix slot
  // that hasn't been resolved at the Well of Souls yet. Its reveal
  // will bump totalMods by 1 and may violate maxFilled or change the
  // mod-mask in ways the goal check hasn't accounted for. Treat the
  // pre-reveal state as not-yet-goal — the reveal is still a pending
  // step the policy needs to take.
  // Opt-out: when `target.allowBonePending` is true, a pending bone
  // is acceptable as the final state (user wants to STOP at "bone
  // applied, defer the reveal" — symmetric to the starting-bone
  // toggle for in-progress crafts).
  if (s.boneMod && !s.boneRevealed && !target.allowBonePending) return false;
  // Per-desired-mod desecration constraint:
  //   target.desecrationRequiredMask: every bit here must be a
  //     desecrated wished bit on the item (the user explicitly wants
  //     a desecrated provenance for this affix — e.g. "I want this
  //     mod from a bone, not from a normal roll").
  //   target.desecrationForbiddenMask: no bit here may be a
  //     desecrated wished bit on the item. (User wants this affix
  //     specifically NOT from desecration — e.g. to reserve the one
  //     desecrated-slot allowance for another mod, or because the
  //     desecrated tier-band differs from the natural-pool one.)
  const desecMask = s.desecratedWishedMask ?? 0;
  if (target.desecrationRequiredMask != null
      && (desecMask & target.desecrationRequiredMask) !== target.desecrationRequiredMask) {
    return false;
  }
  if (target.desecrationForbiddenMask != null
      && (desecMask & target.desecrationForbiddenMask) !== 0) {
    return false;
  }
  // Optional totalMods bounds: encodes "the user wants exactly K affixes
  // on the final item." Without these, a fractured Rare would be
  // claimed as goal even when the user wanted a 1-mod final (under-
  // counting the post-fracture annul-cleanup cost). Both bounds default
  // to undefined so simpler scenarios that don't care still work.
  if (target.minFilled != null && s.totalMods < target.minFilled) return false;
  if (target.maxFilled != null && s.totalMods > target.maxFilled) return false;
  return true;
}

/**
 * Bricked-on-fracture predicate: any state from which the target cannot
 * possibly be reached. Used by the solver to prune entire branches
 * before value-iterating. Currently:
 *   - Irrelevant fracture poisons the item if target wants a specific
 *     wished fracture.
 *   - Wished fracture wrong-bit (state.fracturedBit != target.fracturedBit
 *     and state.fracturedBit != -1): bricked, since fracture is permanent.
 */
export function isBrickedByFracture(s, target) {
  if (target.fracturedBit < 0) return false;
  if (s.irrFractured) return true;
  if (s.fracturedBit >= 0 && s.fracturedBit !== target.fracturedBit) return true;
  return false;
}
