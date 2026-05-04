// MDP action library — each action exports `applicable(s, env)` and
// `transitions(s, env)`. Transitions return an array of
// `{ to: nextState, prob, costEx, costSec }`. Probabilities sum to 1.
//
// Actions modelled in MDP-α:
//   transmute   Normal/0 → Magic/1 (single draw).
//   augment     Magic/1 → Magic/2 (single draw, no duplicates).
//   regal       Magic/(1|2) → Rare/(2|3) (single draw, no duplicates).
//   alch        Normal/Magic → Rare with N draws from pool (re-roll).
//   exalt       Rare with t<6 → adds 1 random mod.
//   annul       Rare with t≥1 → removes 1 random NON-FRACTURED mod uniformly.
//   fracturing  Rare with t≥minModsToFracture → locks 1 random non-fractured mod.
//   buy_base    Any state → fresh Normal base. Cost = basePriceEx.
//
// Future: Greater/Perfect variants (qBoost), regal, transmute/augment,
// chaos, omens (Sinistral/Dextral × {exalt, chaos}). Same shape.
//
// `env` is the immutable problem context:
//   wishlistWeights[]    weight of each wished mod in the eligible pool
//   irrelevantWeight     summed weight of all non-wished pool entries
//   maxFilled            6 in standard PoE2
//   alchemyDraws         4 in standard PoE2
//   minModsToFracture    threshold. PoE2 canonical rule = 4 mods on
//                         the Rare. (Bone-class desecrated currencies
//                         can pad totalMods to 4 with an unrevealed
//                         mod that the fracture can't pick — same
//                         per-attempt success odds as a "3-mod"
//                         fracture would have, but the count is 4.)
//   orbCosts             { alch, exalt, annul, fracturing }: per-orb ex
//   orbTimes             { alch, exalt, annul, fracturing }: per-orb sec
//   basePriceEx          cost of a fresh Normal base
//   basePriceSec         time to procure a fresh base (default 60s
//                         ≈ 1 minute to find + buy via trade)
//
// Alchemy is modelled exactly: N draws WITHOUT replacement (no mod
// repeats). The joint distribution over "which subset of wished mods
// lands in the 4 picks" is computed by enumerating every ordered draw
// sequence weighted by its weighted-without-replacement probability.
// For N≤8 wished, |sequences| is bounded by (N+1)^k = 5^4 = 625 — fast.

import { makeState, popcount } from './state.js';

// ---------- Helper: exact mask distribution after `nDraws` weighted
// samples without replacement from a pool of N wished + 1 irrelevant
// "category" (irrelevant is treated as a bucket — we don't track which
// specific irrelevant lands). ----------
//
// Implementation: recursive enumeration. At each step, the conditional
// pool is (totalPool − weight of already-picked wished mods). Picking
// a specific wished mod consumes its weight; picking "irrelevant" is
// modelled as picking from the irrelevant bucket — the irrelevant
// weight stays in the pool for subsequent draws (since each irrelevant
// pick is a different specific mod, but we don't track WHICH, the
// remaining irrelevant mass barely changes for huge pools — tiny error
// vs the strict "without replacement" model and avoids exponential
// state blowup over which-irrelevant-was-picked).
//
// The wished-mod side IS exact: a wished mod can only land at most once.
function alchMaskDistribution(nDraws, env, actionId = 'alch') {
  const N = env.wishlistWeights.length;
  const totalW = env.totalPoolWeight;
  const irrW = env.irrelevantWeight;
  // pTierAcceptable[actionId][i] = P(when this orb draws wished mod i,
  // the resulting tier is acceptable to the user's per-mod requirement).
  // Computed once by the adapter from each mod's tier weights and the
  // orb's tier filter (e.g. Perfect Exalt rolls only top tiers); the
  // engine just looks it up. No runtime scalar boost / clamp logic.
  // Default 1.0 = no tier restriction (legacy / non-tier-aware setup).
  const pAccept = env.pTierAcceptable?.[actionId] ?? new Array(N).fill(1);
  const out = new Map();
  // Recurse: (drawsLeft, pickedMask, weightConsumedByWished). When a
  // wished mod lands, with probability pAccept[i] the tier is OK and
  // the bit is set; otherwise the slot is consumed but the bit stays
  // unset (sub-spec wished = irrelevant slot for state purposes).
  const rec = (drawsLeft, mask, consumedW, prob) => {
    if (drawsLeft === 0) {
      out.set(mask, (out.get(mask) ?? 0) + prob);
      return;
    }
    const remaining = totalW - consumedW;
    if (remaining <= 0) return;
    for (let i = 0; i < N; i++) {
      if (mask & (1 << i)) continue;
      const w = env.wishlistWeights[i];
      if (w <= 0) continue;
      const pHit = w / remaining;
      const pOk = pAccept[i] ?? 1;
      // Acceptable-tier branch: bit set, weight consumed.
      if (pOk > 0) rec(drawsLeft - 1, mask | (1 << i), consumedW + w, prob * pHit * pOk);
      // Sub-tier branch: slot consumed, bit unchanged. Weight still
      // "consumed" since this specific mod can no longer roll on
      // subsequent draws (wo-replacement semantics).
      if (pOk < 1) rec(drawsLeft - 1, mask, consumedW + w, prob * pHit * (1 - pOk));
    }
    if (irrW > 0) {
      rec(drawsLeft - 1, mask, consumedW, prob * (irrW / remaining));
    }
  };
  rec(nDraws, 0, 0, 1);
  return out;
}

// Single-draw distribution: bit i is set with prob (w_i/pool)·pAccept_i,
// where pAccept_i = env.pTierAcceptable[actionId][i] is the precomputed
// probability that this specific orb, having drawn wished mod i, lands
// at an acceptable tier. Sub-tier landings consume the slot but don't
// set the bit (state-equivalent to irrelevant). All tier-filter logic
// lives in the adapter; the engine just looks up the resolved
// probability.
//
// Optional `sideFilter` ∈ {'PREFIX', 'SUFFIX', null} restricts the
// draw to mods of one type — used for Sinistral/Dextral omens that
// force the next orb to add only prefixes or only suffixes. When set,
// the irrelevant-pool weight comes from env.irrelevantWeightBySide
// (precomputed by the adapter) and wished mods of the wrong type are
// excluded.
function singleDrawMaskDistribution(modMask, env, actionId, sideFilter = null) {
  const N = env.wishlistWeights.length;
  const pAccept = env.pTierAcceptable?.[actionId] ?? new Array(N).fill(1);
  const types = env.wishlistTypes ?? new Array(N).fill(null);
  const sideMatch = (i) => !sideFilter || types[i] === sideFilter;
  const onItemWeight = (() => {
    let s = 0;
    for (let i = 0; i < N; i++) {
      if (modMask & (1 << i) && sideMatch(i)) s += env.wishlistWeights[i];
    }
    return s;
  })();
  const irrW = sideFilter
    ? (env.irrelevantWeightBySide?.[sideFilter] ?? 0)
    : env.irrelevantWeight;
  // Side-filtered total pool: sum of wished weights matching the side
  // + irrelevant pool of that side.
  let sideTotal = irrW;
  for (let i = 0; i < N; i++) {
    if (sideMatch(i)) sideTotal += env.wishlistWeights[i];
  }
  const pool = sideTotal - onItemWeight;
  if (pool <= 0) return new Map([[0, 1]]);
  const out = new Map();
  let subTierMass = 0;
  for (let i = 0; i < N; i++) {
    if (modMask & (1 << i)) continue;
    if (!sideMatch(i)) continue;
    const pHit = env.wishlistWeights[i] / pool;
    if (pHit <= 0) continue;
    const pOk = pAccept[i] ?? 1;
    const pSet = pHit * pOk;
    const pSubTier = pHit * (1 - pOk);
    if (pSet > 0) out.set(1 << i, pSet);
    if (pSubTier > 0) subTierMass += pSubTier;
  }
  const pIrr = irrW / pool;
  const pNoBit = pIrr + subTierMass;
  if (pNoBit > 0) out.set(0, (out.get(0) ?? 0) + pNoBit);
  return out;
}

// ---------- Actions ----------

// Helper: emit a single-draw transition list reusing
// singleDrawMaskDistribution. `actionId` is the orb identifier used to
// look up the per-(orb, mod) tier-acceptance probabilities in
// env.pTierAcceptable.
function singleDrawTransitions(s, env, { actionId, targetRarity, costEx, costSec }) {
  const dist = singleDrawMaskDistribution(s.modMask, env, actionId);
  const out = [];
  for (const [maskBit, prob] of dist) {
    out.push({
      to: makeState({
        ...s,
        rarity: targetRarity,
        modMask: s.modMask | maskBit,
        totalMods: s.totalMods + 1,
      }),
      prob,
      costEx,
      costSec,
    });
  }
  return out;
}

// Exalted-orb variant factory. The plain / Greater / Perfect siblings
// differ only in id (which selects orbCosts, orbTimes, and the
// per-mod tier-acceptance table the adapter built). The transition
// function is identical.
function makeExaltedOrb(id, name) {
  return {
    id, name,
    applicable: (s, env) => s.rarity === 'rare' && s.totalMods < env.maxFilled,
    transitions: (s, env) => {
      const dist = singleDrawMaskDistribution(s.modMask, env, id);
      const out = [];
      for (const [maskBit, prob] of dist) {
        out.push({
          to: makeState({
            ...s,
            modMask: s.modMask | maskBit,
            totalMods: s.totalMods + 1,
          }),
          prob,
          costEx: env.orbCosts[id] ?? 0,
          costSec: env.orbTimes[id] ?? 0,
        });
      }
      return out;
    },
  };
}

// Build a single-draw orb action (transmute/augment/regal/exalt) with
// optional Greater/Perfect tier-bias. The only thing that varies
// between plain and quality variants is `id` (used to look up
// orbCosts, orbTimes, and pTierAcceptable in env). The transition
// function reads these by id at call time so a single template covers
// all variants.
function makeSingleDrawOrb(id, name, applicable, targetRarity) {
  return {
    id, name, applicable,
    transitions: (s, env) => singleDrawTransitions(s, env, {
      actionId: id,
      targetRarity,
      costEx: env.orbCosts[id] ?? 0,
      costSec: env.orbTimes[id] ?? 0,
    }),
  };
}

// Bone-reveal factory. All variants share the same state transition
// shape (boneMod=true && !boneRevealed → totalMods+=1, both flags
// cleared so a fresh bone can be applied next — multi-bone-per-item).
// Variants differ only in `hitsKey` (which env field provides the
// per-wished hit probabilities — desecrated pool filtered by side
// and/or doubled by re-roll mechanic).
//   - reveal_bone:           plain 3-pick, full desecrated pool.
//   - reveal_bone_sinistral: 3-pick, prefix-only pool (Sinistral
//                             Necromancy omen).
//   - reveal_bone_dextral:   3-pick, suffix-only pool (Dextral
//                             Necromancy omen).
//   - reveal_bone_abyssal:   6-pick (Abyssal Echoes omen, re-roll
//                             once → 1 - (1-1/N)^6 vs 3-pick's 1 -
//                             (1-1/N)^3).
function makeRevealBoneOrb(id, name, hitsKey) {
  return {
    id, name,
    applicable: (s) => s.rarity === 'rare' && s.boneMod && !s.boneRevealed
      && s.fracturedBit < 0 && !s.irrFractured,
    transitions: (s, env) => {
      const N = env.wishlistWeights.length;
      const pHits = env[hitsKey] ?? new Array(N).fill(0);
      const out = [];
      let pIrrelevant = 1;
      const cost = env.orbCosts?.[id] ?? 0;
      const time = env.orbTimes?.[id] ?? 1;
      for (let i = 0; i < N; i++) {
        if (s.modMask & (1 << i)) continue;
        const p = pHits[i] ?? 0;
        if (p > 0) {
          out.push({
            to: makeState({ ...s,
              modMask: s.modMask | (1 << i),
              totalMods: s.totalMods + 1,
              // Both flags cleared so apply_bone is applicable again.
              boneMod: false, boneRevealed: false,
            }),
            prob: p, costEx: cost, costSec: time,
          });
          pIrrelevant -= p;
        }
      }
      if (pIrrelevant > 1e-12) {
        out.push({
          to: makeState({ ...s,
            totalMods: s.totalMods + 1,
            boneMod: false, boneRevealed: false,
          }),
          prob: pIrrelevant, costEx: cost, costSec: time,
        });
      }
      return out;
    },
  };
}

// Chaos Orb factory. Models the "remove 1 random + add 1 random"
// composite: pick a removable mod uniformly (denominator = totalMods,
// excluding fractured), drop it, then draw 1 from the side-untyped
// pool subject to the orb's tier-acceptance (plain / Greater /
// Perfect via env.pTierAcceptable[id]). Net totalMods unchanged.
//
// Outcome bookkeeping: we track per-removal × per-add pairs so the
// state distribution covers every transition (removed-wished-then-
// added-wished, removed-irrelevant-then-added-wished, etc.). The
// transition fan is at most ~(N+1)² entries which stays small.
function makeChaosOrb(id, name) {
  return {
    id, name,
    applicable: (s) => s.rarity === 'rare' && s.totalMods >= 1
      && s.fracturedBit < 0 && !s.irrFractured,
    transitions: (s, env) => {
      const N = env.wishlistWeights.length;
      const cost = env.orbCosts[id] ?? 0;
      const time = env.orbTimes[id] ?? 0;
      const pAccept = env.pTierAcceptable?.[id] ?? new Array(N).fill(1);
      // Removable wished bits = wished on item, excluding fractured.
      // (fracturedBit is -1 here per applicability, so all wished
      // on item are removable.)
      const wishedOnItem = [];
      for (let i = 0; i < N; i++) if (s.modMask & (1 << i)) wishedOnItem.push(i);
      const irrCount = s.totalMods - wishedOnItem.length;
      const totalRemovable = wishedOnItem.length + irrCount;
      if (totalRemovable === 0) {
        return [{ to: s, prob: 1, costEx: cost, costSec: time }];
      }
      // For each (remove i, add j) outcome, compute the resulting
      // mask and probability. The add step uses the post-removal
      // pool (modMask after removing the chosen mod) for the
      // single-draw distribution.
      const out = [];
      const emit = (postRemoveState, pRemove) => {
        // Single-draw add from the post-removal state.
        const addDist = singleDrawMaskDistribution(
          postRemoveState.modMask, env, id);
        for (const [maskBit, pAdd] of addDist) {
          out.push({
            to: makeState({
              ...postRemoveState,
              modMask: postRemoveState.modMask | maskBit,
              totalMods: postRemoveState.totalMods + 1, // restore
            }),
            prob: pRemove * pAdd,
            costEx: cost,
            costSec: time,
          });
        }
      };
      for (const i of wishedOnItem) {
        const removed = makeState({
          ...s,
          modMask: s.modMask & ~(1 << i),
          totalMods: s.totalMods - 1,
        });
        emit(removed, 1 / totalRemovable);
      }
      if (irrCount > 0) {
        const removed = makeState({
          ...s,
          totalMods: s.totalMods - 1,
        });
        emit(removed, irrCount / totalRemovable);
      }
      // pAccept is consumed inside singleDrawMaskDistribution via
      // env.pTierAcceptable[id]; suppress unused-var lint
      void pAccept;
      return out;
    },
  };
}

// Side-filtered single-draw orb: same template but the pool is
// restricted to one mod side (PREFIX or SUFFIX). Used for omen-
// augmented orbs (e.g. Sinistral / Dextral Coronation Regal).
function makeSingleDrawOrbSide(id, name, applicable, targetRarity, sideFilter) {
  return {
    id, name, applicable,
    transitions: (s, env) => {
      const dist = singleDrawMaskDistribution(s.modMask, env, id, sideFilter);
      const out = [];
      for (const [maskBit, prob] of dist) {
        out.push({
          to: makeState({
            ...s,
            rarity: targetRarity,
            modMask: s.modMask | maskBit,
            totalMods: s.totalMods + 1,
          }),
          prob,
          costEx: env.orbCosts[id] ?? 0,
          costSec: env.orbTimes[id] ?? 0,
        });
      }
      return out;
    },
  };
}

export const ACTIONS = {
  transmute:         makeSingleDrawOrb('transmute',         'Orb of Transmutation',          (s) => s.rarity === 'normal' && s.totalMods === 0, 'magic'),
  // Greater / Perfect Transmutation: same applicability, higher
  // qBoost so the rolled tier is more likely to be acceptable. The
  // ACTION-id distinction lets the MDP choose between plain (cheap,
  // low qBoost) and Perfect (expensive, qBoost ≈ guarantees top tier)
  // depending on the per-mod tier requirement and the user's budget.
  transmute_greater: makeSingleDrawOrb('transmute_greater', 'Greater Orb of Transmutation',  (s) => s.rarity === 'normal' && s.totalMods === 0, 'magic'),
  transmute_perfect: makeSingleDrawOrb('transmute_perfect', 'Perfect Orb of Transmutation',  (s) => s.rarity === 'normal' && s.totalMods === 0, 'magic'),

  augment:           makeSingleDrawOrb('augment',           'Orb of Augmentation',           (s) => s.rarity === 'magic' && s.totalMods === 1,  'magic'),
  augment_greater:   makeSingleDrawOrb('augment_greater',   'Greater Orb of Augmentation',   (s) => s.rarity === 'magic' && s.totalMods === 1,  'magic'),
  augment_perfect:   makeSingleDrawOrb('augment_perfect',   'Perfect Orb of Augmentation',   (s) => s.rarity === 'magic' && s.totalMods === 1,  'magic'),

  // PoE2 Regal: Magic (1 or 2 mods) → Rare with +1 mod.
  regal:             makeSingleDrawOrb('regal',             'Regal Orb',                     (s) => s.rarity === 'magic' && (s.totalMods === 1 || s.totalMods === 2), 'rare'),
  regal_greater:     makeSingleDrawOrb('regal_greater',     'Greater Regal Orb',             (s) => s.rarity === 'magic' && (s.totalMods === 1 || s.totalMods === 2), 'rare'),
  regal_perfect:     makeSingleDrawOrb('regal_perfect',     'Perfect Regal Orb',             (s) => s.rarity === 'magic' && (s.totalMods === 1 || s.totalMods === 2), 'rare'),
  // Omen-augmented Regal variants (action cost = orb + omen, set by
  // adapter). Sinistral Coronation forces prefix-only; Dextral forces
  // suffix-only — same single-draw shape as plain Regal but with a
  // side filter on the pool. State extension to track prefix/suffix
  // counts isn't needed because the omen's effect is purely on the
  // draw distribution, not on which slot the new mod occupies.
  regal_sinistral:   makeSingleDrawOrbSide('regal_sinistral', 'Regal Orb (Sinistral Coronation)', (s) => s.rarity === 'magic' && (s.totalMods === 1 || s.totalMods === 2), 'rare', 'PREFIX'),
  regal_dextral:     makeSingleDrawOrbSide('regal_dextral',   'Regal Orb (Dextral Coronation)',   (s) => s.rarity === 'magic' && (s.totalMods === 1 || s.totalMods === 2), 'rare', 'SUFFIX'),

  alch: {
    id: 'alch',
    name: 'Orb of Alchemy',
    // PoE2 0.3.1+: alchemy applies to Normal AND Magic items. Whatever
    // mods were on a Magic item are wiped; the result is a fresh 4-mod
    // Rare. The 4 draws are weighted-without-replacement (no duplicates
    // among the 4 picks) but independent of the input item's modMask /
    // totalMods — alchemy is a *re-roll*, not an additive operation.
    applicable: (s) => s.rarity === 'normal' || s.rarity === 'magic',
    transitions: (s, env) => {
      const dist = alchMaskDistribution(env.alchemyDraws, env, 'alch');
      const out = [];
      for (const [mask, prob] of dist) {
        out.push({
          to: makeState({
            rarity: 'rare',
            modMask: mask,
            totalMods: env.alchemyDraws,
            fracturedBit: -1,
            irrFractured: false,
          }),
          prob,
          costEx: env.orbCosts.alch ?? 0,
          costSec: env.orbTimes.alch ?? 0,
        });
      }
      return out;
    },
  },

  exalt:           makeExaltedOrb('exalt',         'Exalted Orb'),
  exalt_greater:   makeExaltedOrb('exalt_greater', 'Greater Exalted Orb'),
  exalt_perfect:   makeExaltedOrb('exalt_perfect', 'Perfect Exalted Orb'),

  annul: {
    id: 'annul',
    name: 'Orb of Annulment',
    applicable: (s) => s.rarity === 'rare' && s.totalMods >= 1
      // Annul cannot remove a fractured mod — protected. If everything
      // on the item is fractured, annul has nothing to remove.
      && (s.fracturedBit < 0 ? s.totalMods >= 1
                             : (s.totalMods - 1) >= 1 || !s.irrFractured),
    transitions: (s, env) => {
      const N = env.wishlistWeights.length;
      // Set of removable mods = wished mods on item (excluding fractured)
      // + irrelevant count. Each removable mod is hit uniformly.
      const wishedRemovable = [];
      for (let i = 0; i < N; i++) {
        if ((s.modMask & (1 << i)) && i !== s.fracturedBit) wishedRemovable.push(i);
      }
      const irrCount = s.totalMods - popcount(s.modMask) - (s.irrFractured ? 1 : 0);
      const totalRemovable = wishedRemovable.length + irrCount;
      if (totalRemovable === 0) {
        // No-op: cannot remove anything.
        return [{
          to: s, prob: 1,
          costEx: env.orbCosts.annul ?? 0, costSec: env.orbTimes.annul ?? 0,
        }];
      }
      const out = [];
      for (const i of wishedRemovable) {
        out.push({
          to: makeState({
            ...s,
            modMask: s.modMask & ~(1 << i),
            totalMods: s.totalMods - 1,
          }),
          prob: 1 / totalRemovable,
          costEx: env.orbCosts.annul ?? 0,
          costSec: env.orbTimes.annul ?? 0,
        });
      }
      if (irrCount > 0) {
        out.push({
          to: makeState({ ...s, totalMods: s.totalMods - 1 }),
          prob: irrCount / totalRemovable,
          costEx: env.orbCosts.annul ?? 0,
          costSec: env.orbTimes.annul ?? 0,
        });
      }
      return out;
    },
  },

  // ── Desecration phase 1: apply Bone-class currency ────────────
  // Adds an UNREVEALED mod slot to the Rare. The slot pads totalMods
  // for the Fracturing-Orb threshold check (lets a 3-mod Rare reach
  // ≥4 effective mods) without exposing a real affix to Fracture's
  // lock pool — strictly better than exalt-padding when the threshold
  // is the limiting factor. Followed by `reveal_bone` to resolve the
  // hidden slot into a real desecrated affix (or skipped entirely if
  // the user only needs the threshold-pad to fracture an existing
  // wished mod).
  apply_bone: {
    id: 'apply_bone',
    name: 'Apply Bone (desecrated)',
    // Multi-bone-per-item: after a reveal, boneMod resets so a fresh
    // bone can be applied — limited only by the maxFilled affix cap
    // (each revealed bone-mod consumes a real slot; once totalMods
    // reaches maxFilled, no more bones fit).
    applicable: (s, env) => s.rarity === 'rare' && !s.boneMod
      && s.fracturedBit < 0 && !s.irrFractured
      && s.totalMods < env.maxFilled,
    transitions: (s, env) => [{
      to: makeState({ ...s, boneMod: true, boneRevealed: false }),
      prob: 1,
      costEx: env.boneCostEx ?? 0,
      costSec: env.boneTimeSec ?? env.orbTimes.apply_bone ?? 1,
    }],
  },

  // ── Desecration phase 2: reveal the Bone-mod ──────────────────
  // The desecration UI shows 3 random affixes from the bone's pool
  // and the user picks one. Modelled as a single draw with effective
  // P(specific desecrated wished i) = 1 - (1 - 1/N)^3 where N is the
  // bone's pool size — ≈ 3/N for sparse pools (the "best of 3 picks"
  // boost over a single draw). For wishlist entries not present in
  // the desecrated pool (typical: most wished mods are normal-pool),
  // pBoneRevealHit[i] = 0 and the reveal lands an irrelevant
  // desecrated affix (consumes the slot, totalMods += 1, no bit set).
  // After reveal, `boneRevealed=true` so this action is no longer
  // applicable; the new affix is just a normal-state affix from the
  // engine's perspective (counts toward Fracture's lock pool, can be
  // annulled, etc.).
  reveal_bone:           makeRevealBoneOrb('reveal_bone',           'Reveal Bone-mod',                            'pBoneRevealHit'),
  reveal_bone_sinistral: makeRevealBoneOrb('reveal_bone_sinistral', 'Reveal Bone-mod (Sinistral Necromancy)',     'pBoneRevealHitPrefix'),
  reveal_bone_dextral:   makeRevealBoneOrb('reveal_bone_dextral',   'Reveal Bone-mod (Dextral Necromancy)',       'pBoneRevealHitSuffix'),
  // Abyssal Echoes — reveal can re-roll once, effectively 6 picks
  // instead of 3. Uses the same pool as plain reveal_bone but with
  // a different precomputed hit-probability array (1 - (1-1/N)^6).
  reveal_bone_abyssal:   makeRevealBoneOrb('reveal_bone_abyssal',   'Reveal Bone-mod (Abyssal Echoes)',           'pBoneRevealHitAbyssal'),

  // ── Chaos Orb family ──────────────────────────────────────────
  // PoE2 Chaos Orb: "Rare: remove a random mod, add a random mod."
  // Net totalMods unchanged; the swap can flip a wished bit on, off,
  // or be a no-op (irrelevant out, irrelevant in). Greater / Perfect
  // Chaos use the same shape with elevated tier-acceptance via
  // `pTierAcceptable` (same machinery as Greater/Perfect Exalt).
  // Closes the rare|0|6 dead-end where every other action either
  // can't apply (exalt blocked at maxFilled) or fails (fracture
  // bricks since no wished bit on item).
  chaos:           makeChaosOrb('chaos',         'Chaos Orb'),
  chaos_greater:   makeChaosOrb('chaos_greater', 'Greater Chaos Orb'),
  chaos_perfect:   makeChaosOrb('chaos_perfect', 'Perfect Chaos Orb'),

  fracturing: {
    id: 'fracturing',
    name: 'Fracturing Orb',
    applicable: (s, env) =>
      s.rarity === 'rare'
      && s.fracturedBit < 0 && !s.irrFractured  // can't double-fracture
      // Unrevealed bone-mod counts toward the threshold but not the
      // lock pool (it's hidden, fracture can't pick it). Once
      // revealed, the bone-affix is a normal mod and is already
      // counted in totalMods.
      && (s.totalMods + (s.boneMod && !s.boneRevealed ? 1 : 0)) >= env.minModsToFracture,
    transitions: (s, env) => {
      const N = env.wishlistWeights.length;
      // Picks a random mod uniformly from all mods on the item and
      // locks it. Since we don't track which specific irrelevant mod is
      // locked (would explode state), an irrelevant lock just sets
      // `irrFractured = true` (bricked for any wished-fracture target).
      const wishedOnItem = [];
      for (let i = 0; i < N; i++) if (s.modMask & (1 << i)) wishedOnItem.push(i);
      const irrCount = s.totalMods - wishedOnItem.length;
      const out = [];
      for (const i of wishedOnItem) {
        out.push({
          to: makeState({ ...s, fracturedBit: i }),
          prob: 1 / s.totalMods,
          costEx: env.orbCosts.fracturing ?? 0,
          costSec: env.orbTimes.fracturing ?? 0,
        });
      }
      if (irrCount > 0) {
        out.push({
          to: makeState({ ...s, irrFractured: true }),
          prob: irrCount / s.totalMods,
          costEx: env.orbCosts.fracturing ?? 0,
          costSec: env.orbTimes.fracturing ?? 0,
        });
      }
      return out;
    },
  },

};

// ── Dynamic essence-action factory ────────────────────────────────
// PoE2 essences upgrade a Magic item to Rare with one specific affix
// guaranteed (the essence's `target_affix`). Each essence is a
// distinct MDP action — different essences target different mods at
// different tier guarantees, and the MDP compares them against
// regal/orb-of-alchemy/etc. via Q-values.
//
// `spec` shape (from adapter):
//   { id, name, costEx, timeSec, matchedKeys: [string],
//     pAcceptable: number ∈ [0, 1] }
//
//   - matchedKeys: wishlist keys the essence's affix sets when its
//     rolled tier is acceptable. Multiple keys when an essence's
//     affix matches several wishlist entries (rare).
//   - pAcceptable: P(rolled tier is acceptable to user). 1.0 for
//     Greater/Perfect essences targeting an in-tier mod; 0 if the
//     essence's tier band is below the user's requiredTier; values
//     between for partial matches.
//
// Applicable on Magic with 1 or 2 mods (matches Regal). Result is a
// Rare with totalMods+1 and the matched bits set (with prob
// pAcceptable) or unset (with prob 1-pAcceptable; the affix landed
// at a sub-tier and is treated as irrelevant for state purposes).
export function makeEssenceAction(spec, keyToBit) {
  const matchedKeys = spec.matchedKeys ?? [];
  let mask = 0;
  for (const k of matchedKeys) {
    const bit = keyToBit.get(k);
    if (bit !== undefined) mask |= (1 << bit);
  }
  const pAcc = Number.isFinite(spec.pAcceptable) ? spec.pAcceptable : 1;
  return {
    id: spec.id,
    name: spec.name ?? spec.id,
    applicable: (s) => s.rarity === 'magic'
      && (s.totalMods === 1 || s.totalMods === 2)
      && s.fracturedBit < 0 && !s.irrFractured && !s.boneMod,
    transitions: (s, env) => {
      const cost = spec.costEx;
      const time = spec.timeSec ?? 1;
      // Effective bits the essence WOULD set: only those not already
      // on the item. (If they're all already set, the essence's
      // affix is degenerate — same probabilistic shape but no bit
      // change.)
      const newBits = mask & ~s.modMask;
      const out = [];
      if (newBits !== 0 && pAcc > 0) {
        out.push({
          to: makeState({ ...s,
            rarity: 'rare',
            modMask: s.modMask | newBits,
            totalMods: s.totalMods + 1,
          }),
          prob: pAcc,
          costEx: cost, costSec: time,
        });
      }
      const pNoBit = newBits !== 0 ? 1 - pAcc : 1;
      if (pNoBit > 0) {
        out.push({
          to: makeState({ ...s,
            rarity: 'rare',
            totalMods: s.totalMods + 1,
          }),
          prob: pNoBit,
          costEx: cost, costSec: time,
        });
      }
      return out;
    },
  };
}

// buy_base is appended after the dynamic essence factory so the
// factory definition sits between the static orb actions and the
// terminal buy_base action.
ACTIONS.buy_base = {
  id: 'buy_base',
  name: 'Buy fresh base',
  // Always applicable. The MDP solver naturally selects it only when
  // V*(s_initial) + basePrice < V*(s_current under any other action).
  applicable: () => true,
  transitions: (s, env) => [{
    to: makeState({ rarity: 'normal' }),
    prob: 1,
    costEx: env.basePriceEx ?? 0,
    costSec: env.basePriceSec ?? 0,
  }],
};
