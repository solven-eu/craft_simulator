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
  totalMods = 0,
  fracturedBit = -1,
  irrFractured = false,
  boneMod = false,
  boneRevealed = false,
} = {}) {
  return Object.freeze({ rarity, modMask, totalMods, fracturedBit, irrFractured, boneMod, boneRevealed });
}

export function stateKey(s) {
  return `${s.rarity}|${s.modMask}|${s.totalMods}|${s.fracturedBit}|${s.irrFractured ? 1 : 0}|${s.boneMod ? 1 : 0}|${s.boneRevealed ? 1 : 0}`;
}

export function popcount(n) {
  let c = 0;
  while (n) { c += n & 1; n >>>= 1; }
  return c;
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
