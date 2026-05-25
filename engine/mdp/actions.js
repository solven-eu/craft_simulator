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
function singleDrawMaskDistribution(modMask, env, actionId, sideFilter = null, prefixMods = 0, totalMods = 0) {
  const N = env.wishlistWeights.length;
  const pAccept = env.pTierAcceptable?.[actionId] ?? new Array(N).fill(1);
  const types = env.wishlistTypes ?? new Array(N).fill(null);
  // Side-saturation gates: max 3 prefixes and 3 suffixes per the
  // PoE2 game rule. When a side is full, the orb's pool excludes
  // mods of that side (no slot to land in). Without these gates,
  // prefixMods/suffixMods could exceed 3, blowing up the state
  // space with unreachable-by-game configurations.
  const prefixFull = prefixMods >= 3;
  const suffixFull = (totalMods - prefixMods) >= 3;
  const sideMatch = (i) => {
    if (sideFilter && types[i] !== sideFilter) return false;
    if (prefixFull && types[i] === 'PREFIX') return false;
    if (suffixFull && types[i] === 'SUFFIX') return false;
    return true;
  };
  const onItemWeight = (() => {
    let s = 0;
    for (let i = 0; i < N; i++) {
      if (modMask & (1 << i) && sideMatch(i)) s += env.wishlistWeights[i];
    }
    return s;
  })();
  // Irrelevant pool — restricted to sides that have room.
  const irrPrefixRaw = (sideFilter === 'PREFIX')
    ? (env.irrelevantWeightBySide?.PREFIX ?? 0)
    : (sideFilter === 'SUFFIX' ? 0 : (env.irrelevantWeightBySide?.PREFIX ?? 0));
  const irrSuffixRaw = (sideFilter === 'SUFFIX')
    ? (env.irrelevantWeightBySide?.SUFFIX ?? 0)
    : (sideFilter === 'PREFIX' ? 0 : (env.irrelevantWeightBySide?.SUFFIX ?? 0));
  let irrPrefix = prefixFull ? 0 : irrPrefixRaw;
  let irrSuffix = suffixFull ? 0 : irrSuffixRaw;
  // Legacy fallback when side data is absent: lump all irr in suffix
  // (as long as suffix isn't saturated, else prefix). Keeps engines
  // without irrelevantWeightBySide self-consistent.
  if (irrPrefix === 0 && irrSuffix === 0) {
    const fallback = sideFilter
      ? (env.irrelevantWeightBySide?.[sideFilter] ?? 0)
      : (env.irrelevantWeight ?? 0);
    if (fallback > 0) {
      if (!suffixFull)      irrSuffix = fallback;
      else if (!prefixFull) irrPrefix = fallback;
    }
  }
  const irrW = irrPrefix + irrSuffix;
  // Side-filtered total pool: sum of wished weights matching the side
  // + irrelevant pool of that side.
  let sideTotal = irrW;
  for (let i = 0; i < N; i++) {
    if (sideMatch(i)) sideTotal += env.wishlistWeights[i];
  }
  const pool = sideTotal - onItemWeight;
  if (pool <= 0) {
    // Empty-pool fallback: the orb deterministically lands an
    // irrelevant slot. Respect side saturation — if suffix is full
    // we must land prefix and vice versa. If both sides are full we
    // return no outcomes so the orb effectively becomes a no-op
    // rather than silently overflowing the affix cap.
    if (!suffixFull) return new Map([['0|0', 1]]);
    if (!prefixFull) return new Map([['0|1', 1]]);
    return new Map();
  }
  // Outcome key: `${maskBit}|${prefixDelta}` so distinct (maskBit, side)
  // tuples don't merge — a wished prefix and a wished suffix are
  // separate outcomes; an irrelevant prefix and irrelevant suffix are
  // separate outcomes. This is what surfaces "+ 1 P irrelevant" vs
  // "+ 1 S irrelevant" branches in the chain.
  const out = new Map();
  const add = (maskBit, prefixDelta, prob) => {
    if (prob <= 0) return;
    const k = `${maskBit}|${prefixDelta}`;
    out.set(k, (out.get(k) ?? 0) + prob);
  };
  for (let i = 0; i < N; i++) {
    if (modMask & (1 << i)) continue;
    if (!sideMatch(i)) continue;
    const pHit = env.wishlistWeights[i] / pool;
    if (pHit <= 0) continue;
    const pOk = pAccept[i] ?? 1;
    const pSet = pHit * pOk;
    const pSubTier = pHit * (1 - pOk);
    const isPrefix = types[i] === 'PREFIX' ? 1 : 0;
    add(1 << i, isPrefix, pSet);          // wished bit set, side intrinsic
    add(0,      isPrefix, pSubTier);       // sub-tier — slot consumed, side intrinsic
  }
  add(0, 1, irrPrefix / pool);             // irrelevant prefix landed
  add(0, 0, irrSuffix / pool);             // irrelevant suffix landed
  return out;
}

// ---------- Actions ----------

// Helper: emit a single-draw transition list reusing
// singleDrawMaskDistribution. `actionId` is the orb identifier used to
// look up the per-(orb, mod) tier-acceptance probabilities in
// env.pTierAcceptable.
function singleDrawTransitions(s, env, { actionId, targetRarity, costEx, costSec }) {
  const dist = singleDrawMaskDistribution(s.modMask, env, actionId, null, s.prefixMods ?? 0, s.totalMods ?? 0);
  const out = [];
  for (const [key, prob] of dist) {
    const [maskBitStr, prefixDeltaStr] = key.split('|');
    const maskBit = Number(maskBitStr);
    const prefixDelta = Number(prefixDeltaStr);
    out.push({
      to: makeState({
        ...s,
        rarity: targetRarity,
        modMask: s.modMask | maskBit,
        totalMods: s.totalMods + 1,
        prefixMods: (s.prefixMods ?? 0) + prefixDelta,
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
      const dist = singleDrawMaskDistribution(s.modMask, env, id, null, s.prefixMods ?? 0, s.totalMods ?? 0);
      const out = [];
      for (const [key, prob] of dist) {
        const [maskBitStr, prefixDeltaStr] = key.split('|');
        const maskBit = Number(maskBitStr);
        const prefixDelta = Number(prefixDeltaStr);
        out.push({
          to: makeState({
            ...s,
            modMask: s.modMask | maskBit,
            totalMods: s.totalMods + 1,
            prefixMods: (s.prefixMods ?? 0) + prefixDelta,
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

// Exalt-with-Greater-Exaltation: PoE2 omen "your next Exalted Orb
// will add two random modifiers". Applicability: same as base exalt
// but requires 2 free slots (totalMods + 2 ≤ maxFilled). Outcomes:
// composition of two consecutive single-draws over the same pool —
// the second draw sees the post-first state (one extra mod on item,
// possibly tripping a side cap that the first draw didn't).
//
// Cost = base orb price + omen price (both flow through env.orbCosts;
// the variant's id is used to look up the OMEN cost only — base
// orb cost is added at transition time via baseId).
function makeExaltedDoubleOrb(id, name, baseId) {
  return {
    id, name,
    applicable: (s, env) => s.rarity === 'rare'
      && (s.totalMods + 2) <= env.maxFilled
      // Need 2 affix slots somewhere: at least one side has room
      // for both, OR each side has at least one slot. Conservative
      // gate; the singleDraw machinery handles per-side saturation
      // correctly mid-transition.
      && (s.prefixMods ?? 0) < 3
      && (s.totalMods - (s.prefixMods ?? 0)) < 3,
    transitions: (s, env) => {
      const cost = (env.orbCosts[baseId] ?? 0) + (env.orbCosts[id] ?? 0);
      const time = (env.orbTimes[baseId] ?? 0);
      const dist1 = singleDrawMaskDistribution(s.modMask, env, baseId, null, s.prefixMods ?? 0, s.totalMods ?? 0);
      const merged = new Map();
      for (const [k1, p1] of dist1) {
        const [m1Str, dp1Str] = k1.split('|');
        const m1 = Number(m1Str);
        const dp1 = Number(dp1Str);
        const newMask1   = s.modMask | m1;
        const newPrefix1 = (s.prefixMods ?? 0) + dp1;
        const newTotal1  = (s.totalMods ?? 0) + 1;
        const dist2 = singleDrawMaskDistribution(newMask1, env, baseId, null, newPrefix1, newTotal1);
        for (const [k2, p2] of dist2) {
          const [m2Str, dp2Str] = k2.split('|');
          const m2 = Number(m2Str);
          const dp2 = Number(dp2Str);
          const finalMask   = newMask1 | m2;
          const finalPrefix = newPrefix1 + dp2;
          const finalTotal  = newTotal1 + 1;
          const sk = `${finalMask}|${finalPrefix}|${finalTotal}`;
          merged.set(sk, (merged.get(sk) ?? 0) + p1 * p2);
        }
      }
      const out = [];
      for (const [k, prob] of merged) {
        const [maskStr, prefixStr, totalStr] = k.split('|');
        out.push({
          to: makeState({
            ...s,
            modMask: Number(maskStr),
            prefixMods: Number(prefixStr),
            totalMods: Number(totalStr),
          }),
          prob,
          costEx: cost,
          costSec: time,
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

// Bone-reveal factory. Models the Well-of-Souls reveal step with
// side allocation per project memory `project_bone_side_allocation`:
//   - 6/6 full ⇒ remove + replace same-side (NOT modeled — apply_bone
//     is gated on totalMods < maxFilled so this state is unreachable
//     from a normal craft chain; if encountered, falls through to
//     50/50 as a graceful degradation).
//   - one side full (3 / <3) ⇒ forced opposite side; uses that side's
//     filtered hit-prob pool (pBoneRevealHitPrefix / Suffix) and routes
//     all irrelevant residual to the open side.
//   - both sides have room ⇒ wished hits use the natural full-pool
//     rate (each wished mod's intrinsic side determines which slot
//     it lands in); the 50/50 coin only governs which open slot the
//     IRRELEVANT residual consumes.
//
// Variants:
//   - reveal_bone:           natural side rule, full 3-pick pool.
//   - reveal_bone_sinistral: forced PREFIX (Sinistral Crystallisation
//                             omen overrides natural rule); uses
//                             pBoneRevealHitPrefix as hit pool.
//   - reveal_bone_dextral:   forced SUFFIX (Dextral Crystallisation
//                             omen).
//   - reveal_bone_abyssal:   natural rule, uses pBoneRevealHitAbyssal.
//                             NOTE on Abyssal Echoes mechanics: per
//                             user clarification (2026-05-07), this
//                             omen offers TWO sequential 3-picks. If
//                             the first set is rejected, the second
//                             set is rolled and the first is LOST
//                             (not best-of-six). A naive 6-pick
//                             best-of approximation overstates the
//                             hit rate because the first set's
//                             affixes can't be retroactively chosen.
//                             A faithful model needs an extra state
//                             flag "first-set-shown, decision pending"
//                             so the policy can decide whether to
//                             accept or reject. Today's engine treats
//                             pBoneRevealHitAbyssal as a flat
//                             single-step rate — adapter decides what
//                             value to plug in. Modeling the
//                             sequential-decision properly is a
//                             follow-up (project memory:
//                             abyssal_echoes_two_step).
//
// `forceSide`: 'PREFIX' | 'SUFFIX' | null (natural).
// `hitsKey`:   env field used when natural-side or matching the
//              forced side; for forced variants, points to the
//              already-side-filtered hit array.
function makeRevealBoneOrb(id, name, hitsKey, forceSide = null) {
  const sideOpen = (s) => {
    const p = s.prefixMods ?? 0;
    return { prefixOpen: p < 3, suffixOpen: (s.totalMods - p) < 3 };
  };
  return {
    id, name,
    applicable: (s, env) => {
      if (!(s.rarity === 'rare' && s.boneMod && !s.boneRevealed
            && s.fracturedBit < 0 && !s.irrFractured)) return false;
      // Reveal bumps totalMods by 1; gate on totalMods < maxFilled so
      // the bumped count stays within the affix cap. Without this gate,
      // an exalt-after-apply_bone path can reach totalMods=6 with a
      // pending bone, then reveal would push to 7 (invalid).
      if (s.totalMods >= (env.maxFilled ?? 6)) return false;
      // Pre-declared bone side (e.g., starting craft with a known
      // already-applied bone): a forced-side variant must match the
      // bone's known side, and the plain reveal_bone is disabled
      // because the bone's side is already pinned.
      if (s.boneSide) {
        if (forceSide && forceSide !== s.boneSide) return false;
      }
      const { prefixOpen, suffixOpen } = sideOpen(s);
      if (forceSide === 'PREFIX') return prefixOpen;
      if (forceSide === 'SUFFIX') return suffixOpen;
      return prefixOpen || suffixOpen;
    },
    transitions: (s, env) => {
      const N = env.wishlistWeights.length;
      const types = env.wishlistTypes ?? new Array(N).fill(null);
      const cost = env.orbCosts?.[id] ?? 0;
      const time = env.orbTimes?.[id] ?? 1;
      const { prefixOpen, suffixOpen } = sideOpen(s);

      // Resolve mode: 'PREFIX' | 'SUFFIX' | 'NATURAL'.
      // Precedence: omen-forced > known-bone-side > open-slot rule
      //   > 50/50 (both open).
      // The known-bone-side override (state.boneSide) reflects a bone
      // applied with a Crystallisation omen OR a starting bone whose
      // slot the user has already observed; either way the reveal
      // must use the matching side's hit pool.
      let mode;
      if (forceSide === 'PREFIX')             mode = 'PREFIX';
      else if (forceSide === 'SUFFIX')        mode = 'SUFFIX';
      else if (s.boneSide === 'PREFIX')       mode = 'PREFIX';
      else if (s.boneSide === 'SUFFIX')       mode = 'SUFFIX';
      else if (prefixOpen && !suffixOpen)     mode = 'PREFIX';
      else if (!prefixOpen && suffixOpen)     mode = 'SUFFIX';
      else                                    mode = 'NATURAL';

      // Hit pool + irrelevant-side allocation per mode.
      // - Forced/auto-forced side → use that side's filtered hit
      //   array (smaller pool ⇒ higher per-affix p).
      // - Natural (both open) → use the configured hit pool
      //   (full-pool 3-pick or 6-pick for Abyssal); irrelevant
      //   residual splits 50/50.
      let pHits, pIrrelevantPrefix;
      if (mode === 'PREFIX') {
        pHits = env.pBoneRevealHitPrefix ?? new Array(N).fill(0);
        pIrrelevantPrefix = 1;
      } else if (mode === 'SUFFIX') {
        pHits = env.pBoneRevealHitSuffix ?? new Array(N).fill(0);
        pIrrelevantPrefix = 0;
      } else {
        pHits = env[hitsKey] ?? new Array(N).fill(0);
        pIrrelevantPrefix = 0.5;
      }

      const out = [];
      // Pre-normalise per-wished hit probabilities so they don't sum
      // past 1.0. The closed-form `1 - (1 - 1/N)^3` per-wished is an
      // approximation that overcounts when several wished mods are
      // in the desecrated pool (each treated independently, ignoring
      // that they compete for the same 3 picks). When `Σ pHits > 1`,
      // we scale every entry down proportionally so the irrelevant
      // tail `1 - Σ pHits` stays ≥ 0 — otherwise pIrrelevant goes
      // negative, the irrelevant branch is skipped, and the action's
      // outgoing prob mass exceeds 1, propagating into pSuccess > 1.
      let pHitsSum = 0;
      for (let i = 0; i < N; i++) {
        if (s.modMask & (1 << i)) continue;
        pHitsSum += pHits[i] ?? 0;
      }
      const pHitsScale = pHitsSum > 1 ? (1 / pHitsSum) : 1;
      let pIrrelevant = 1;
      for (let i = 0; i < N; i++) {
        if (s.modMask & (1 << i)) continue;
        const p = (pHits[i] ?? 0) * pHitsScale;
        if (p > 0) {
          // Wished mod's side is intrinsic — bumps prefixMods iff
          // the affix is a PREFIX. (env.pBoneRevealHitPrefix is
          // already side-filtered, so a SUFFIX wished mod has
          // p=0 in PREFIX mode and won't reach this branch.)
          const isPrefix = types[i] === 'PREFIX';
          out.push({
            to: makeState({ ...s,
              modMask: s.modMask | (1 << i),
              totalMods: s.totalMods + 1,
              prefixMods: (s.prefixMods ?? 0) + (isPrefix ? 1 : 0),
              // Reveal stamps the affix with desecrated provenance —
              // wished-bit-i is now a desecrated wished slot. Total
              // and per-side desecrated counts derive from this mask
              // + the irrelevant counts (state.js helpers).
              desecratedWishedMask: (s.desecratedWishedMask ?? 0) | (1 << i),
              boneMod: false, boneRevealed: false, boneSide: null,
            }),
            prob: p, costEx: cost, costSec: time,
          });
          pIrrelevant -= p;
        }
      }
      pIrrelevant = Math.max(0, pIrrelevant);
      if (pIrrelevant > 1e-12) {
        const pIrrPrefix = pIrrelevant * pIrrelevantPrefix;
        const pIrrSuffix = pIrrelevant - pIrrPrefix;
        if (pIrrPrefix > 1e-12) {
          out.push({
            to: makeState({ ...s,
              totalMods: s.totalMods + 1,
              prefixMods: (s.prefixMods ?? 0) + 1,
              desecratedIrrPrefix: (s.desecratedIrrPrefix ?? 0) + 1,
              boneMod: false, boneRevealed: false, boneSide: null,
            }),
            prob: pIrrPrefix, costEx: cost, costSec: time,
          });
        }
        if (pIrrSuffix > 1e-12) {
          out.push({
            to: makeState({ ...s,
              totalMods: s.totalMods + 1,
              desecratedIrrSuffix: (s.desecratedIrrSuffix ?? 0) + 1,
              boneMod: false, boneRevealed: false, boneSide: null,
            }),
            prob: pIrrSuffix, costEx: cost, costSec: time,
          });
        }
      }
      return out;
    },
  };
}

// ── Annul-with-Omen-of-Light: scrub a desecrated mod ──────────────
// Per PoE2 rule: Orb of Annulment + Omen of Light removes a desecrated
// modifier (revealed bone-mod) uniformly at random from the desecrated
// subset of mods on the item. Critical for the desecration cleanup
// loop: apply_bone → reveal → (bad outcome) → omen-of-light annul →
// retry.
//
// Outcome distribution (uniform over the `desecratedCount` desecrated
// mods on the item, where desecratedCount is derived from
// `popcount(desecratedWishedMask) + desecratedIrrPrefix + desecratedIrrSuffix`):
//   - For each wished bit `i` in `desecratedWishedMask`:
//       prob 1/desecratedCount → clear bit i, decrement totalMods,
//       decrement prefixMods iff wished i is PREFIX.
//   - Irrelevant desecrated prefix (prob desecratedIrrPrefix /
//     desecratedCount): decrement desecratedIrrPrefix and prefixMods.
//   - Irrelevant desecrated suffix (prob desecratedIrrSuffix /
//     desecratedCount): decrement desecratedIrrSuffix.
const annulOmenOfLight = {
  id: 'annul_omen_of_light',
  name: 'Orb of Annulment (Omen of Light)',
  applicable: (s) => {
    if (s.rarity !== 'rare' || s.boneMod) return false;
    if (s.fracturedBit >= 0 || s.irrFractured) return false;
    const total = popcount(s.desecratedWishedMask ?? 0)
                + (s.desecratedIrrPrefix ?? 0)
                + (s.desecratedIrrSuffix ?? 0);
    return total > 0;
  },
  transitions: (s, env) => {
    const N = env.wishlistWeights.length;
    const types = env.wishlistTypes ?? new Array(N).fill(null);
    const cost = env.orbCosts?.annul_omen_of_light ?? 0;
    const time = env.orbTimes?.annul_omen_of_light ?? 1;
    const desecWishedMask = s.desecratedWishedMask ?? 0;
    const irrPrefix = s.desecratedIrrPrefix ?? 0;
    const irrSuffix = s.desecratedIrrSuffix ?? 0;
    const desecCount = popcount(desecWishedMask) + irrPrefix + irrSuffix;
    const out = [];
    if (desecCount === 0) return out;
    // Per-wished desecrated bit removal.
    for (let i = 0; i < N; i++) {
      if (!(desecWishedMask & (1 << i))) continue;
      const isPrefix = types[i] === 'PREFIX';
      out.push({
        to: makeState({ ...s,
          modMask: s.modMask & ~(1 << i),
          totalMods: s.totalMods - 1,
          prefixMods: Math.max(0, (s.prefixMods ?? 0) - (isPrefix ? 1 : 0)),
          desecratedWishedMask: desecWishedMask & ~(1 << i),
        }),
        prob: 1 / desecCount, costEx: cost, costSec: time,
      });
    }
    // Irrelevant desecrated prefix removal — clamp prefixMods to ≥0
    // so an upstream-stale state (prefixMods=0 but irrPrefix=1) can't
    // cascade a -1 prefixMods through this transition.
    if (irrPrefix > 0) {
      out.push({
        to: makeState({ ...s,
          totalMods: s.totalMods - 1,
          prefixMods: Math.max(0, (s.prefixMods ?? 0) - 1),
          desecratedIrrPrefix: irrPrefix - 1,
        }),
        prob: irrPrefix / desecCount, costEx: cost, costSec: time,
      });
    }
    // Irrelevant desecrated suffix removal.
    if (irrSuffix > 0) {
      out.push({
        to: makeState({ ...s,
          totalMods: s.totalMods - 1,
          desecratedIrrSuffix: irrSuffix - 1,
        }),
        prob: irrSuffix / desecCount, costEx: cost, costSec: time,
      });
    }
    return out;
  },
};

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
        // Single-draw add from the post-removal state — outcomes are
        // keyed `${maskBit}|${prefixDelta}` so prefix-side and
        // suffix-side adds branch separately.
        const addDist = singleDrawMaskDistribution(
          postRemoveState.modMask, env, id, null,
          postRemoveState.prefixMods ?? 0,
          postRemoveState.totalMods ?? 0);
        for (const [key, pAdd] of addDist) {
          const [maskBitStr, prefixDeltaStr] = key.split('|');
          const maskBit = Number(maskBitStr);
          const prefixDelta = Number(prefixDeltaStr);
          out.push({
            to: makeState({
              ...postRemoveState,
              modMask: postRemoveState.modMask | maskBit,
              totalMods: postRemoveState.totalMods + 1, // restore
              prefixMods: (postRemoveState.prefixMods ?? 0) + prefixDelta,
            }),
            prob: pRemove * pAdd,
            costEx: cost,
            costSec: time,
          });
        }
      };
      const wTypes = env.wishlistTypes ?? [];
      const desecMask = s.desecratedWishedMask ?? 0;
      const irrPrefixDesec = s.desecratedIrrPrefix ?? 0;
      const irrSuffixDesec = s.desecratedIrrSuffix ?? 0;
      for (const i of wishedOnItem) {
        const isPrefix = wTypes[i] === 'PREFIX' ? 1 : 0;
        const removed = makeState({
          ...s,
          modMask: s.modMask & ~(1 << i),
          totalMods: s.totalMods - 1,
          prefixMods: Math.max(0, (s.prefixMods ?? 0) - isPrefix),
          // Removing a wished bit that was desecrated clears it from
          // the wished-desec mask.
          desecratedWishedMask: desecMask & ~(1 << i),
        });
        emit(removed, 1 / totalRemovable);
      }
      if (irrCount > 0) {
        // Count ALL prefix bits on item (wished + fractured) when
        // sizing the irrelevant pool, mirroring the annul fix.
        let prefixOnItem = 0;
        for (let i = 0; i < (env.wishlistTypes ?? []).length; i++) {
          if ((s.modMask & (1 << i)) && wTypes[i] === 'PREFIX') prefixOnItem++;
        }
        const irrPrefix = Math.max(0, (s.prefixMods ?? 0) - prefixOnItem);
        const irrSuffix = Math.max(0, irrCount - irrPrefix);
        // Branch each side's irrelevant removal into desec vs clean
        // outcomes (mirrors annul). Without this, an irrelevant
        // desecrated slot can be removed from the modMask side
        // without decrementing the desecratedIrr counter, leaving
        // `desecratedIrrPrefix=1` on a state with no prefix slots
        // — which then propagates a -1 prefixMods downstream.
        if (irrPrefix > 0) {
          const irrPrefDesec = Math.min(irrPrefixDesec, irrPrefix);
          const irrPrefClean = irrPrefix - irrPrefDesec;
          if (irrPrefDesec > 0) {
            emit(makeState({
              ...s,
              totalMods: s.totalMods - 1,
              prefixMods: Math.max(0, (s.prefixMods ?? 0) - 1),
              desecratedIrrPrefix: irrPrefixDesec - 1,
            }), irrPrefDesec / totalRemovable);
          }
          if (irrPrefClean > 0) {
            emit(makeState({
              ...s,
              totalMods: s.totalMods - 1,
              prefixMods: Math.max(0, (s.prefixMods ?? 0) - 1),
            }), irrPrefClean / totalRemovable);
          }
        }
        if (irrSuffix > 0) {
          const irrSufDesec = Math.min(irrSuffixDesec, irrSuffix);
          const irrSufClean = irrSuffix - irrSufDesec;
          if (irrSufDesec > 0) {
            emit(makeState({
              ...s,
              totalMods: s.totalMods - 1,
              desecratedIrrSuffix: irrSuffixDesec - 1,
            }), irrSufDesec / totalRemovable);
          }
          if (irrSufClean > 0) {
            emit(makeState({
              ...s,
              totalMods: s.totalMods - 1,
            }), irrSufClean / totalRemovable);
          }
        }
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
      const dist = singleDrawMaskDistribution(s.modMask, env, id, sideFilter, s.prefixMods ?? 0, s.totalMods ?? 0);
      const out = [];
      for (const [key, prob] of dist) {
        const [maskBitStr, prefixDeltaStr] = key.split('|');
        const maskBit = Number(maskBitStr);
        const prefixDelta = Number(prefixDeltaStr);
        out.push({
          to: makeState({
            ...s,
            rarity: targetRarity,
            modMask: s.modMask | maskBit,
            totalMods: s.totalMods + 1,
            prefixMods: (s.prefixMods ?? 0) + prefixDelta,
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

// Apply-bone with Sinistral/Dextral Necromancy. Same transition
// shape as plain apply_bone but pins post-state.boneSide so the
// reveal phase uses the matching-side pool. Applicability requires
// an open slot on the chosen side (modelling the simple case; the
// "remove a prefix to make room" branch isn't exercised by the user
// flows we've seen).
function makeApplyBoneOmenVariant(id, name, side) {
  const sideOpen = (s) => {
    const p = s.prefixMods ?? 0;
    return side === 'PREFIX' ? p < 3 : (s.totalMods - p) < 3;
  };
  return {
    id, name,
    applicable: (s, env) => {
      if (s.rarity !== 'rare' || s.boneMod) return false;
      if (s.totalMods >= env.maxFilled) return false; // open-slot only
      if (!sideOpen(s)) return false;
      if ((s.desecratedWishedMask ?? 0) !== 0) return false;
      if ((s.desecratedIrrPrefix ?? 0) > 0) return false;
      if ((s.desecratedIrrSuffix ?? 0) > 0) return false;
      return true;
    },
    transitions: (s, env) => {
      const cost = (env.boneCostEx ?? 0) + (env.orbCosts?.[id] ?? 0);
      const time = env.boneTimeSec ?? env.orbTimes?.[id] ?? env.orbTimes?.apply_bone ?? 1;
      return [{
        to: makeState({ ...s, boneMod: true, boneRevealed: false, boneSide: side }),
        prob: 1, costEx: cost, costSec: time,
      }];
    },
  };
}

// Adding / removing / renaming a key in ACTIONS requires a matching
// edit in `docs/actions-coverage.md`. The bidirectional sync is
// enforced by `tests/actions-coverage-doc.test.js` — the test fails
// when the two lists drift.
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
      const types = env.wishlistTypes ?? [];
      const prefixWeight = env.irrelevantWeightBySide?.PREFIX ?? 0;
      const suffixWeight = env.irrelevantWeightBySide?.SUFFIX ?? 0;
      const irrTotalW = prefixWeight + suffixWeight;
      // Prefix-share for irrelevant slots: proportional to side
      // weights when both are positive; else 50/50 fallback.
      const prefixShare = irrTotalW > 0 ? (prefixWeight / irrTotalW) : 0.5;
      const binC = (n, k) => {
        if (k < 0 || k > n) return 0;
        let c = 1;
        for (let i = 0; i < k; i++) c = c * (n - i) / (i + 1);
        return c;
      };
      for (const [mask, prob] of dist) {
        let nPrefixWished = 0;
        for (let i = 0; i < types.length; i++) {
          if ((mask & (1 << i)) && types[i] === 'PREFIX') nPrefixWished++;
        }
        const irrCount = env.alchemyDraws - popcount(mask);
        // Branch the irrelevant-side allocation by k = 0..irrCount,
        // weighted Binomial(irrCount, prefixShare). Each branch is a
        // separate outcome state with its own prefixMods. Replaces
        // the earlier deterministic round-to-most-likely-k heuristic.
        //
        // Two-pass: first compute valid (k, weight) pairs respecting
        // the 3-per-side cap, then RENORMALISE so the surviving
        // branches sum to the input `prob` mass. Without
        // renormalisation, dropping invalid branches (e.g. k=0 →
        // 4 suffixes which exceeds the suffix cap) shrinks alch's
        // outgoing mass below 1.0 — the engine treats the lost mass
        // as "free outcome" and under-counts alch's expected cost,
        // making it look artificially attractive.
        const branches = [];
        let weightSum = 0;
        for (let k = 0; k <= irrCount; k++) {
          const newPrefix = nPrefixWished + k;
          const newSuffix = env.alchemyDraws - newPrefix;
          if (newPrefix > 3 || newSuffix > 3) continue;
          const w = binC(irrCount, k)
            * Math.pow(prefixShare, k)
            * Math.pow(1 - prefixShare, irrCount - k);
          if (w <= 0) continue;
          branches.push({ newPrefix, w });
          weightSum += w;
        }
        if (weightSum <= 0) {
          // Degenerate side share (e.g. prefixShare=0 with 4 draws —
          // the would-be all-suffix outcome violates the 3-per-side
          // cap and every binomial branch with non-zero weight is
          // invalid). Fall back to the round-to-nearest-valid-k
          // heuristic so alch remains a usable action in these
          // skewed-pool fixtures rather than disappearing entirely
          // and forcing the engine into a different policy branch.
          const targetK = Math.round(irrCount * prefixShare);
          let bestK = -1, bestDist = Infinity;
          for (let k = 0; k <= irrCount; k++) {
            const newPrefix = nPrefixWished + k;
            const newSuffix = env.alchemyDraws - newPrefix;
            if (newPrefix > 3 || newSuffix > 3) continue;
            const dist = Math.abs(k - targetK);
            if (dist < bestDist) { bestDist = dist; bestK = k; }
          }
          if (bestK < 0) continue; // truly no valid branch — skip mask
          branches.push({ newPrefix: nPrefixWished + bestK, w: 1 });
          weightSum = 1;
        }
        for (const { newPrefix, w } of branches) {
          const branchProb = prob * (w / weightSum);
          if (branchProb <= 1e-12) continue;
          out.push({
            to: makeState({
              rarity: 'rare',
              modMask: mask,
              totalMods: env.alchemyDraws,
              prefixMods: newPrefix,
              fracturedBit: -1,
              irrFractured: false,
            }),
            prob: branchProb,
            costEx: env.orbCosts.alch ?? 0,
            costSec: env.orbTimes.alch ?? 0,
          });
        }
      }
      return out;
    },
  },

  exalt:           makeExaltedOrb('exalt',         'Exalted Orb'),
  exalt_greater:   makeExaltedOrb('exalt_greater', 'Greater Exalted Orb'),
  exalt_perfect:   makeExaltedOrb('exalt_perfect', 'Perfect Exalted Orb'),

  // Greater-Exaltation omen variants — adds 2 mods in one cast.
  // Per-tier so the engine can compare base/Greater/Perfect flavours
  // when paired with the omen.
  exalt_double:         makeExaltedDoubleOrb('exalt_double',         'Exalted Orb (Greater Exaltation)',         'exalt'),
  exalt_greater_double: makeExaltedDoubleOrb('exalt_greater_double', 'Greater Exalted Orb (Greater Exaltation)', 'exalt_greater'),
  exalt_perfect_double: makeExaltedDoubleOrb('exalt_perfect_double', 'Perfect Exalted Orb (Greater Exaltation)', 'exalt_perfect'),

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
      const wTypes = env.wishlistTypes ?? [];
      const desecMask = s.desecratedWishedMask ?? 0;
      const irrPrefixDesec = s.desecratedIrrPrefix ?? 0;
      const irrSuffixDesec = s.desecratedIrrSuffix ?? 0;
      for (const i of wishedRemovable) {
        const isPrefix = wTypes[i] === 'PREFIX' ? 1 : 0;
        const newPrefix = Math.max(0, (s.prefixMods ?? 0) - isPrefix);
        // If wished bit i was desecrated, removing it clears the
        // bit from desecratedWishedMask.
        const newDesecMask = desecMask & ~(1 << i);
        out.push({
          to: makeState({
            ...s,
            modMask: s.modMask & ~(1 << i),
            totalMods: s.totalMods - 1,
            prefixMods: newPrefix,
            desecratedWishedMask: newDesecMask,
          }),
          prob: 1 / totalRemovable,
          costEx: env.orbCosts.annul ?? 0,
          costSec: env.orbTimes.annul ?? 0,
        });
      }
      if (irrCount > 0) {
        // Count ALL prefix bits currently on the item (wished AND
        // fractured) to size the irrelevant-prefix pool — using
        // `wishedRemovable` would exclude fractured bits and let
        // annul's prefix-decrement underflow.
        let prefixOnItem = 0;
        for (let i = 0; i < N; i++) {
          if ((s.modMask & (1 << i)) && wTypes[i] === 'PREFIX') prefixOnItem++;
        }
        const irrPrefix = Math.max(0, (s.prefixMods ?? 0) - prefixOnItem);
        const irrSuffix = Math.max(0, irrCount - irrPrefix);
        // Branch each side's irrelevant removal into desecrated vs
        // non-desecrated outcomes — required so removing a desecrated
        // slot also decrements the per-side desecrated-irr count.
        // Without this, a state can carry a desecratedIrrPrefix=1
        // counter that survives the only prefix slot being annulled,
        // producing inconsistent downstream states.
        if (irrPrefix > 0) {
          const irrPrefDesec = Math.min(irrPrefixDesec, irrPrefix);
          const irrPrefClean = irrPrefix - irrPrefDesec;
          if (irrPrefDesec > 0) {
            out.push({
              to: makeState({
                ...s,
                totalMods: s.totalMods - 1,
                prefixMods: (s.prefixMods ?? 0) - 1,
                desecratedIrrPrefix: irrPrefixDesec - 1,
              }),
              prob: irrPrefDesec / totalRemovable,
              costEx: env.orbCosts.annul ?? 0,
              costSec: env.orbTimes.annul ?? 0,
            });
          }
          if (irrPrefClean > 0) {
            out.push({
              to: makeState({
                ...s,
                totalMods: s.totalMods - 1,
                prefixMods: (s.prefixMods ?? 0) - 1,
              }),
              prob: irrPrefClean / totalRemovable,
              costEx: env.orbCosts.annul ?? 0,
              costSec: env.orbTimes.annul ?? 0,
            });
          }
        }
        if (irrSuffix > 0) {
          const irrSufDesec = Math.min(irrSuffixDesec, irrSuffix);
          const irrSufClean = irrSuffix - irrSufDesec;
          if (irrSufDesec > 0) {
            out.push({
              to: makeState({
                ...s,
                totalMods: s.totalMods - 1,
                desecratedIrrSuffix: irrSuffixDesec - 1,
              }),
              prob: irrSufDesec / totalRemovable,
              costEx: env.orbCosts.annul ?? 0,
              costSec: env.orbTimes.annul ?? 0,
            });
          }
          if (irrSufClean > 0) {
            out.push({
              to: makeState({ ...s, totalMods: s.totalMods - 1 }),
              prob: irrSufClean / totalRemovable,
              costEx: env.orbCosts.annul ?? 0,
              costSec: env.orbTimes.annul ?? 0,
            });
          }
        }
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
    // PoE2 rule (user clarification 2026-05-07): an item that already
    // carries a desecrated mod — REVEALED OR UNREVEALED — cannot be
    // desecrated again. The desecrated provenance persists across
    // reveal, so a previously-revealed bone-mod blocks future
    // apply_bone calls. To unstick, the user must Annul-with-
    // Omen-of-Light to scrub the desecrated affix (engine action
    // for that loop is a follow-up). Net effect: the FINAL item can
    // carry at most ONE desecrated mod under any path the engine
    // currently models.
    //
    // Earlier comment incorrectly described "multi-bone-per-item:
    // after a reveal, boneMod resets so a fresh bone can be applied."
    // That contradicts the game rule and was a bug.
    applicable: (s, env) => {
      if (s.rarity !== 'rare' || s.boneMod) return false;
      // Per game rule (user clarification 2026-05-08): on a full
      // 6/6 item, applying a Bone removes a random non-fractured
      // mod and replaces it with the bone-phantom. So 6/6 is
      // applicable as long as there's at least one non-fractured
      // mod to displace. Fully-fractured items still block.
      if (s.totalMods >= env.maxFilled) {
        const removable = s.totalMods - (s.fracturedBit >= 0 ? 1 : 0) - (s.irrFractured ? 1 : 0);
        if (removable <= 0) return false;
      }
      // Block apply_bone when ANY desecrated mod is on item — wished
      // (in mask) or irrelevant (per side count).
      if ((s.desecratedWishedMask ?? 0) !== 0) return false;
      if ((s.desecratedIrrPrefix ?? 0) > 0) return false;
      if ((s.desecratedIrrSuffix ?? 0) > 0) return false;
      return true;
    },
    transitions: (s, env) => {
      // Open-slot case: no removal needed. Bone-phantom takes the
      // implicit slot, totalMods unchanged.
      if (s.totalMods < env.maxFilled) {
        return [{
          to: makeState({ ...s, boneMod: true, boneRevealed: false }),
          prob: 1,
          costEx: env.boneCostEx ?? 0,
          costSec: env.boneTimeSec ?? env.orbTimes.apply_bone ?? 1,
        }];
      }
      // Full-item case: pick one non-fractured mod uniformly, remove
      // it, then place the bone-phantom in its slot. totalMods drops
      // by 1 (the removed mod is gone; the bone is a phantom that
      // doesn't count). Mirror of annul's removal logic.
      const N = env.wishlistWeights.length;
      const wishedRemovable = [];
      for (let i = 0; i < N; i++) {
        if ((s.modMask & (1 << i)) && i !== s.fracturedBit) wishedRemovable.push(i);
      }
      const irrCount = s.totalMods - popcount(s.modMask) - (s.irrFractured ? 1 : 0);
      const totalRemovable = wishedRemovable.length + irrCount;
      if (totalRemovable === 0) {
        // Fully-fractured 6/6 — no removable mod. (Defensive: the
        // applicable gate already excludes this, but keep the
        // transition self-consistent.)
        return [{
          to: s, prob: 1,
          costEx: env.boneCostEx ?? 0,
          costSec: env.boneTimeSec ?? env.orbTimes.apply_bone ?? 1,
        }];
      }
      const out = [];
      const wTypes = env.wishlistTypes ?? [];
      const desecMask = s.desecratedWishedMask ?? 0;
      const cost = env.boneCostEx ?? 0;
      const time = env.boneTimeSec ?? env.orbTimes.apply_bone ?? 1;
      // Wished-bit removals: one outcome per wished bit on item.
      for (const i of wishedRemovable) {
        const isPrefix = wTypes[i] === 'PREFIX' ? 1 : 0;
        const newPrefix = Math.max(0, (s.prefixMods ?? 0) - isPrefix);
        const newDesecMask = desecMask & ~(1 << i);
        out.push({
          to: makeState({
            ...s,
            modMask: s.modMask & ~(1 << i),
            totalMods: s.totalMods - 1,
            prefixMods: newPrefix,
            desecratedWishedMask: newDesecMask,
            boneMod: true, boneRevealed: false,
          }),
          prob: 1 / totalRemovable,
          costEx: cost, costSec: time,
        });
      }
      // Irrelevant removals: count prefix-irr / suffix-irr separately
      // since they decrement different counters.
      if (irrCount > 0) {
        let prefixOnItem = 0;
        for (let i = 0; i < N; i++) {
          if ((s.modMask & (1 << i)) && wTypes[i] === 'PREFIX') prefixOnItem++;
        }
        const irrPrefix = Math.max(0, (s.prefixMods ?? 0) - prefixOnItem);
        const irrSuffix = Math.max(0, irrCount - irrPrefix);
        if (irrPrefix > 0) {
          out.push({
            to: makeState({
              ...s,
              totalMods: s.totalMods - 1,
              prefixMods: (s.prefixMods ?? 0) - 1,
              boneMod: true, boneRevealed: false,
            }),
            prob: irrPrefix / totalRemovable,
            costEx: cost, costSec: time,
          });
        }
        if (irrSuffix > 0) {
          out.push({
            to: makeState({
              ...s,
              totalMods: s.totalMods - 1,
              boneMod: true, boneRevealed: false,
            }),
            prob: irrSuffix / totalRemovable,
            costEx: cost, costSec: time,
          });
        }
      }
      return out;
    },
  },

  // ── Apply Bone with Sinistral/Dextral Necromancy ─────────────
  // PoE2 omen: "your next Desecration attempt will add only prefix
  // modifiers" (or suffix). Effect: the bone-phantom is committed
  // to the chosen side, which propagates to plain reveal_bone via
  // state.boneSide so the matching-side hit pool is used.
  //
  // Cost = boneCostEx + omen price (flows through env.orbCosts[id]).
  //
  // Applicability: same as plain apply_bone, but additionally
  // requires the chosen side to have an open slot — Necromancy can't
  // force a prefix on a 3/3-prefix item without first removing a
  // prefix, and the engine doesn't currently model that "remove from
  // forced side" branch (could be added if observed in real play).
  apply_bone_sinistral: makeApplyBoneOmenVariant('apply_bone_sinistral',
    'Apply Bone (Sinistral Necromancy)', 'PREFIX'),
  apply_bone_dextral:   makeApplyBoneOmenVariant('apply_bone_dextral',
    'Apply Bone (Dextral Necromancy)',   'SUFFIX'),

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
  // Side-forcing on bone reveal is NOT a separate omen — it's a
  // consequence of having applied the bone with Sinistral/Dextral
  // Crystallisation at desecration time. The state's `boneSide`
  // flag (set by adapter.js when Crystallisation was used at
  // apply_bone) drives plain reveal_bone to use the matching side
  // pool automatically. Earlier this engine carried separate
  // `reveal_bone_sinistral` / `reveal_bone_dextral` actions
  // referencing a non-existent "Omen of Sinistral/Dextral
  // Necromancy" — that omen doesn't exist in PoE2; the user
  // confirmed (2026-05-11) the side is set at desecration time, so
  // these variants were removed.
  // Abyssal Echoes — reveal can re-roll once, effectively 6 picks
  // instead of 3. Uses the same pool as plain reveal_bone but with
  // a different precomputed hit-probability array (1 - (1-1/N)^6).
  reveal_bone_abyssal:   makeRevealBoneOrb('reveal_bone_abyssal',   'Reveal Bone-mod (Abyssal Echoes)',           'pBoneRevealHitAbyssal'),

  // ── Annul + Omen of Light — desecrated cleanup ───────────────────
  annul_omen_of_light: annulOmenOfLight,

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
  // Side delta for prefixMods: the new affix lands on the essence's
  // natural side (PREFIX/SUFFIX as declared in the catalog row).
  // Without this, post-essence states have a wished bit set but
  // prefixMods=0 — and downstream annul/chaos try to remove the
  // "phantom prefix," driving prefixMods negative and exploding the
  // BFS state space.
  const sidePrefixDelta = spec.side === 'PREFIX' ? 1 : 0;
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
            prefixMods: (s.prefixMods ?? 0) + sidePrefixDelta,
          }),
          prob: pAcc,
          costEx: cost, costSec: time,
        });
      }
      const pNoBit = newBits !== 0 ? 1 - pAcc : 1;
      if (pNoBit > 0) {
        // Sub-tier outcome — the rolled affix occupies a slot on the
        // essence's natural side but the wished bit isn't set.
        out.push({
          to: makeState({ ...s,
            rarity: 'rare',
            totalMods: s.totalMods + 1,
            prefixMods: (s.prefixMods ?? 0) + sidePrefixDelta,
          }),
          prob: pNoBit,
          costEx: cost, costSec: time,
        });
      }
      return out;
    },
  };
}

// ── Perfect-essence overwrite action ─────────────────────────────
// Per project memory `project_perfect_essence_rules`, Perfect (and
// Corrupted) essences apply on a RARE item and overwrite a
// uniformly-random affix of the essence's natural side (PREFIX or
// SUFFIX). Same-family overwrite is blocked: if the essence's affix
// is already on the item, the action is inapplicable.
//
// State transition:
//   - Pick a random target slot uniformly from `side`-side affixes.
//   - Replace it: if target was a wished bit, clear it; then set the
//     essence's matched bit(s) with prob `pAcceptable`.
//   - totalMods unchanged (1-for-1 swap); side count unchanged.
//
// Side handling: when the essence's `side` is null (catalog entry
// missing the column), we fall back to overwriting a random affix
// from EITHER side — engine treats this as "approximate" and the
// action's EV may be slightly off. Most catalog rows have side set.
export function makePerfectEssenceOverwriteAction(spec, keyToBit, env) {
  const matchedKeys = spec.matchedKeys ?? [];
  let mask = 0;
  for (const k of matchedKeys) {
    const bit = keyToBit.get(k);
    if (bit !== undefined) mask |= (1 << bit);
  }
  const pAcc = Number.isFinite(spec.pAcceptable) ? spec.pAcceptable : 1;
  const side = spec.side ?? null; // 'PREFIX' | 'SUFFIX' | null
  return {
    id: spec.id,
    name: spec.name ?? spec.id,
    applicable: (s) => {
      if (s.rarity !== 'rare' || s.totalMods < 1) return false;
      if (s.fracturedBit >= 0 || s.irrFractured) return false;
      if (s.boneMod) return false;
      // Same-family-blocked: if all matched bits are already set,
      // the essence has nothing new to add.
      if ((mask & ~s.modMask) === 0) return false;
      // Side gating only fires for the omen-augmented variants
      // (Sinistral / Dextral Crystallisation), where `side` is set
      // to PREFIX or SUFFIX. The base variant has side=null and
      // accepts any rare with totalMods ≥ 1. For omen variants we
      // need at least one affix on the forced side to overwrite.
      if (side === 'PREFIX' && (s.prefixMods ?? 0) < 1) return false;
      if (side === 'SUFFIX' && (s.totalMods - (s.prefixMods ?? 0)) < 1) return false;
      return true;
    },
    transitions: (s) => {
      const cost = spec.costEx;
      const time = spec.timeSec ?? 1;
      const newBits = mask & ~s.modMask;
      const out = [];
      // Side-restricted pick when an omen forces the side; otherwise
      // uniform over all affixes (default Perfect-essence behaviour).
      const sideCount = side === 'PREFIX' ? (s.prefixMods ?? 0)
                      : side === 'SUFFIX' ? (s.totalMods - (s.prefixMods ?? 0))
                      : s.totalMods;
      if (sideCount <= 0) return [];
      const wishedOnSide = [];
      const wishlistTypes = env?.wishlistTypes ?? [];
      for (let i = 0; i < wishlistTypes.length; i++) {
        if (!(s.modMask & (1 << i))) continue;
        if (side && wishlistTypes[i] !== side) continue;
        wishedOnSide.push(i);
      }
      // Per-side breakdown of irrelevants in the picking pool — needed
      // because removing an irrelevant prefix vs suffix produces a
      // different prefixMods delta when the essence's affix is added
      // back. Without this, modMask gets a wished prefix bit set but
      // prefixMods isn't bumped, leaving the state inconsistent (a
      // PREFIX wished mod present but prefixMods unchanged).
      let irrPrefix = 0, irrSuffix = 0;
      if (side === 'PREFIX')      irrPrefix = sideCount - wishedOnSide.length;
      else if (side === 'SUFFIX') irrSuffix = sideCount - wishedOnSide.length;
      else {
        const wishedPrefixOnItem = wishedOnSide.filter((i) => wishlistTypes[i] === 'PREFIX').length;
        const wishedSuffixOnItem = wishedOnSide.length - wishedPrefixOnItem;
        irrPrefix = Math.max(0, (s.prefixMods ?? 0) - wishedPrefixOnItem);
        irrSuffix = Math.max(0, (s.totalMods - (s.prefixMods ?? 0)) - wishedSuffixOnItem);
      }
      // The essence's affix occupies the picked slot's side AND
      // carries the essence's natural side. When the picked slot's
      // side ≠ essence's side, prefixMods shifts by the difference.
      // Source the essence's natural side from spec.side (catalog
      // row); when missing (legacy / under-spec'd row), fall back
      // to the matched wishlist bit's type — the essence's affix
      // IS that wishlist mod, so its side is the same.
      let addPrefixDelta = 0;
      if (spec.side === 'PREFIX')      addPrefixDelta = 1;
      else if (spec.side === 'SUFFIX') addPrefixDelta = 0;
      else {
        // Fallback: use the first matched wishlist bit's type.
        const firstMatchedBit = matchedKeys.length ? keyToBit.get(matchedKeys[0]) : null;
        if (firstMatchedBit != null && wishlistTypes[firstMatchedBit] === 'PREFIX') addPrefixDelta = 1;
      }
      const recordOutcome = (postRemoveMask, postRemoveDesecMask, removedPrefixDelta, pickProb) => {
        const newPrefixMods = Math.max(0, Math.min(3,
          (s.prefixMods ?? 0) - removedPrefixDelta + addPrefixDelta));
        if (newBits !== 0 && pAcc > 0) {
          out.push({
            to: makeState({ ...s,
              modMask: postRemoveMask | newBits,
              prefixMods: newPrefixMods,
              desecratedWishedMask: postRemoveDesecMask,
              // totalMods unchanged (1-for-1 overwrite). The new
              // affix is NOT desecrated (essences are not the Well
              // of Souls).
            }),
            prob: pickProb * pAcc,
            costEx: cost, costSec: time,
          });
        }
        const pNoBit = newBits !== 0 ? (1 - pAcc) : 1;
        if (pNoBit > 0) {
          // Sub-tier — new affix occupies the slot but the wished
          // bit isn't set. Side delta still applies (the essence's
          // affix family took the slot, even at sub-tier).
          out.push({
            to: makeState({ ...s,
              modMask: postRemoveMask,
              prefixMods: newPrefixMods,
              desecratedWishedMask: postRemoveDesecMask,
            }),
            prob: pickProb * pNoBit,
            costEx: cost, costSec: time,
          });
        }
      };
      // Removing a wished bit i (uniform 1/sideCount each). Clears
      // the bit from desecratedWishedMask if the bit was desecrated.
      for (const i of wishedOnSide) {
        const postMask = s.modMask & ~(1 << i);
        const postDesec = (s.desecratedWishedMask ?? 0) & ~(1 << i);
        const removedPrefix = wishlistTypes[i] === 'PREFIX' ? 1 : 0;
        recordOutcome(postMask, postDesec, removedPrefix, 1 / sideCount);
      }
      // Per-side irrelevant removal — branch into desecrated vs clean
      // outcomes so the per-side desecrated-irr count is decremented
      // when the removed slot is the desecrated one (mirrors the
      // annul / chaos fix). Without the branch, e.g. overwriting the
      // only irrelevant prefix on an item whose `desecratedIrrPrefix=1`
      // leaves the counter pointing at a slot that no longer exists.
      const irrPrefDesec = Math.min(s.desecratedIrrPrefix ?? 0, irrPrefix);
      const irrPrefClean = irrPrefix - irrPrefDesec;
      const irrSufDesec  = Math.min(s.desecratedIrrSuffix ?? 0, irrSuffix);
      const irrSufClean  = irrSuffix - irrSufDesec;
      if (irrPrefDesec > 0) {
        // recordOutcome doesn't know about per-side desec counts —
        // patch the resulting state's `desecratedIrrPrefix` after.
        const before = out.length;
        recordOutcome(s.modMask, s.desecratedWishedMask ?? 0, 1, irrPrefDesec / sideCount);
        for (let i = before; i < out.length; i++) {
          out[i].to = makeState({ ...out[i].to,
            desecratedIrrPrefix: (s.desecratedIrrPrefix ?? 0) - 1,
          });
        }
      }
      if (irrPrefClean > 0) {
        recordOutcome(s.modMask, s.desecratedWishedMask ?? 0, 1, irrPrefClean / sideCount);
      }
      if (irrSufDesec > 0) {
        const before = out.length;
        recordOutcome(s.modMask, s.desecratedWishedMask ?? 0, 0, irrSufDesec / sideCount);
        for (let i = before; i < out.length; i++) {
          out[i].to = makeState({ ...out[i].to,
            desecratedIrrSuffix: (s.desecratedIrrSuffix ?? 0) - 1,
          });
        }
      }
      if (irrSufClean > 0) {
        recordOutcome(s.modMask, s.desecratedWishedMask ?? 0, 0, irrSufClean / sideCount);
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
