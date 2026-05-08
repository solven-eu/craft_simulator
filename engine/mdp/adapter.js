// Adapter: convert the craft-store strategy ctx into the MDP-α input.
// Same `ctx` already plumbed for compareStrategies, plus a few derived
// fields (wishlist weights from the conditional pool).
//
// Output is the input shape consumed by `solveMDP(input)`. Pure function;
// no store / DOM / async.

import { resolveTypedKey } from '../mod-ids.js';

/**
 * @param {object} ctx                Strategy context (see strategiesAnalytics).
 * @returns input for solveMDP, or null if the problem is degenerate
 *          (no wishlist, no required mods, etc.).
 */
export function ctxToMdpInput(ctx) {
  if (!ctx?.wishlist?.length) return null;

  // Phase 1 of the mod-identity refactor: canonicalise every typed
  // key (PREFIX:..., SUFFIX:...) via resolveTypedKey so wishlist
  // entries spelled with the essence-text form (`+# to maximum Life`)
  // resolve to the same id as the base-pool entry (`# to maximum
  // Life`). Without this, `find(m => m.key === w.key)` silently
  // misses, the wished bit gets weight 0, and the engine reports the
  // craft as unreachable.
  const modIds = ctx.modIds ?? {};
  const canonKey = (k) => resolveTypedKey(k, modIds);

  // Index the pool by canonical key for O(1) match.
  const poolByCanon = new Map();
  for (const m of (ctx.fullPool ?? [])) {
    poolByCanon.set(canonKey(m.key), m);
  }

  // Build wishlist with pool weights. Use the *full* pool (not conditional)
  // since the MDP models alchemy-from-scratch where prior item state is
  // irrelevant; exalt's per-state pool exclusion is computed separately
  // inside the action's transitions.
  const wishlist = ctx.wishlist.map((w) => {
    const wKey = canonKey(w.key);
    const poolEntry = poolByCanon.get(wKey);
    return {
      key: wKey,
      type: w.type ?? poolEntry?.type ?? null, // PREFIX | SUFFIX
      weight: poolEntry?.weight ?? 0,
      required: !!w.required,
      fractured: !!w.fractured,
      // Per-desired-mod desecration constraint (mirror of fracture
      // toggle). 'require' ⇒ this affix MUST be on the final item
      // with desecrated provenance. 'forbid' ⇒ this affix must NOT
      // be desecrated (e.g. user reserves the one-desecrated slot
      // for a different mod). null ⇒ MDP is free to use desecration
      // strategies or not.
      desecrationConstraint: w.desecrationConstraint ?? null,
      tierScores: w.tierScores ?? null,
      requiredTier: pickFiniteMin(w.requiredTier, w.minTier),
      tiers: poolEntry?.tiers ?? [],
    };
  });
  const totalPool = (ctx.fullPool ?? []).reduce((s, m) => s + (m.weight ?? 0), 0);
  const wishedW = wishlist.reduce((s, w) => s + w.weight, 0);
  const irrelevantWeight = Math.max(0, totalPool - wishedW);
  // Side-typed pool sums for omen-side-filtered orbs (Sinistral /
  // Dextral Coronation, etc). Each side's irrelevant pool = total
  // weight of mods of that type minus wished mods of that type.
  const totalPoolPrefix = (ctx.fullPool ?? [])
    .filter((m) => m.type === 'PREFIX').reduce((s, m) => s + (m.weight ?? 0), 0);
  const totalPoolSuffix = (ctx.fullPool ?? [])
    .filter((m) => m.type === 'SUFFIX').reduce((s, m) => s + (m.weight ?? 0), 0);
  const wishedPrefixW = wishlist.filter((w) => w.type === 'PREFIX').reduce((s, w) => s + w.weight, 0);
  const wishedSuffixW = wishlist.filter((w) => w.type === 'SUFFIX').reduce((s, w) => s + w.weight, 0);
  const irrelevantWeightBySide = {
    PREFIX: Math.max(0, totalPoolPrefix - wishedPrefixW),
    SUFFIX: Math.max(0, totalPoolSuffix - wishedSuffixW),
  };

  const requiredMods = wishlist.filter((w) => w.required).map((w) => w.key);
  // Fractured target: prefer an explicit user flag; fall back to the
  // store-level `requiredFracturedKey` if plumbed. Canonicalise via
  // the id table so it matches the wishlist entries' canonical keys.
  const fracturedKey = ctx.requiredFracturedKey
    ? canonKey(ctx.requiredFracturedKey)
    : (wishlist.find((w) => w.fractured && w.required)?.key ?? null);

  // Map every MDP action to its game-orb costs/times. Missing any key
  // here causes the action to be silently dropped — that's what bit us
  // earlier with transmute/augment/regal absent from this dict.
  // Omen prices come from ctx.omenPrices (loaded by the store from
  // omens.csv → poe2 economy table). Each Sinistral/Dextral Coronation
  // omen-orb action's cost = orb cost + omen cost. Missing omens (e.g.
  // user hasn't loaded that specific omen's price) → NaN → action
  // silently excluded by the engine's quality-variant skip rule.
  const omenCost = (slug) => {
    const v = ctx.omenPrices?.[slug];
    return Number.isFinite(v) ? v : NaN;
  };
  const sumCost = (...vs) => {
    let s = 0;
    for (const v of vs) {
      if (!Number.isFinite(v)) return NaN;
      s += v;
    }
    return s;
  };
  // Bone-trick: cheapest applicable Bone-class desecrated currency
  // for the current item class. Bones are item-class-restricted (e.g.
  // collarbones for Amulet/Ring/Belt; rib-cage for Body Armour; …).
  // The cheapest applicable one is what the user would actually use
  // to pad totalMods to fracture-eligible. If none applies / no
  // rates loaded, boneCostEx stays NaN and the engine silently
  // excludes apply_bone.
  let boneCostEx = NaN;
  const itemClass = ctx.itemClass ?? null;
  for (const c of Object.values(ctx.currencies ?? {})) {
    if (c.kind !== 'desecrated') continue;
    // Bone family: collarbone / rib / cranium / jawbone / vertebra.
    // Filter strictly on item-class applicability when known.
    const applies = !itemClass
      || !c.appliesToItemClasses
      || c.appliesToItemClasses.includes(itemClass);
    if (!applies) continue;
    if (!Number.isFinite(c.exaltedPer)) continue;
    if (!Number.isFinite(boneCostEx) || c.exaltedPer < boneCostEx) {
      boneCostEx = c.exaltedPer;
    }
  }
  // Per-wished P(reveal lands wished mod i). The bone REVEAL step
  // shows 3 random affixes from the bone's affix pool (per-base
  // desecrated mod list, sourced from `data/poe2/extra_mods.json`).
  // The user picks the best of 3:
  //   P(specific wished i present in the 3 picks) ≈ 1 - (1 - 1/N)^3
  // where N = pool size for this base. The "with replacement" model
  // is a small-error approximation; for sparse pools (N ~ 30-100)
  // the actual without-replacement P is within a few % of this.
  // Wishlist entries not in the desecrated pool get pBoneRevealHit=0
  // — the reveal lands an irrelevant desecrated affix.
  const desecratedPool = (ctx.extraMods?.[ctx.base]?.desecrated) ?? [];
  const desecratedPoolSize = desecratedPool.length;
  // Side-typed sub-pools — used by Sinistral/Dextral Necromancy omens
  // which restrict the reveal pick to one side. The pool entry's `tags`
  // / `tier_name` don't always carry side info; fall back to checking
  // the `text` against known prefix/suffix patterns when the entry
  // doesn't directly classify. Approximate but works for the bulk of
  // mods. Mods with unknown side go in BOTH sub-pools (conservative —
  // they could land under either omen).
  const desecPoolPrefix = desecratedPool.filter((d) => d.type === 'PREFIX' || d.type == null);
  const desecPoolSuffix = desecratedPool.filter((d) => d.type === 'SUFFIX' || d.type == null);
  const desecratedNames        = new Set(desecratedPool.map((d) => d.text));
  const desecratedNamesPrefix  = new Set(desecPoolPrefix.map((d) => d.text));
  const desecratedNamesSuffix  = new Set(desecPoolSuffix.map((d) => d.text));

  // 3-pick hit prob (plain reveal): user picks best of 3 random affixes.
  const hit3 = (poolSize) => poolSize > 0 ? 1 - Math.pow(1 - 1/poolSize, 3) : 0;
  // Abyssal Echoes 2-step hit prob (per user clarification 2026-05-07):
  // the omen offers TWO sequential 3-picks. The user sees the first 3
  // and chooses to ACCEPT one or REJECT the whole set; on rejection
  // the first set is LOST and a fresh 3-pick is drawn (must accept
  // from second set).
  //
  // Optimal user policy: accept the first set iff at least one wished
  // mod appears in it; otherwise reject and take whatever lands in
  // the second set.
  //
  // Closed-form per-wished hit prob:
  //   P(land i) = P(i in first set)
  //             + P(no wished in first set) × P(i in second set)
  //   = p_first_i + (1 - p_first_any) × p_second_i
  // where p_first_i = p_second_i = 1 - (1 - 1/N)^3 (same per-pick odds
  // for first and second draws — i.i.d. for the model). p_first_any
  // applies only to wished mods that COULD appear in the desecrated
  // pool — wished mods absent from the pool can never be in either
  // set, so they contribute 0 to both terms.
  // p_first_any = 1 - Π_i (1 - p_i_per_pick)^3 over wished mods in pool
  //             = 1 - (1 - K/N)^3
  // where K = number of wished mods in the desecrated pool, N = pool size.
  const hitAbyssal = (wInPool, poolSize, kWishedInPool) => {
    if (!wInPool || poolSize <= 0) return 0;
    const pPerPick = 1 / poolSize;
    const pFirstI  = 1 - Math.pow(1 - pPerPick, 3);
    const kSharePerPick = (kWishedInPool ?? 0) / poolSize;
    const pFirstAny = 1 - Math.pow(1 - kSharePerPick, 3);
    return pFirstI + (1 - pFirstAny) * pFirstI;
  };
  // Count of wished mods present in each desecrated sub-pool — the
  // `K` in the formula above. Computed once, used for every wished
  // entry's Abyssal odds.
  const wishedNamesInPool = wishlist.map((w) => w.key.split(':').slice(1).join(':'));
  const kInFullPool = wishedNamesInPool.filter((n) => desecratedNames.has(n)).length;

  const pBoneRevealHit        = wishlist.map((w) => {
    const name = w.key.split(':').slice(1).join(':');
    return desecratedNames.has(name) ? hit3(desecratedPoolSize) : 0;
  });
  const pBoneRevealHitPrefix  = wishlist.map((w) => {
    if (w.type !== 'PREFIX') return 0;
    const name = w.key.split(':').slice(1).join(':');
    return desecratedNamesPrefix.has(name) ? hit3(desecPoolPrefix.length) : 0;
  });
  const pBoneRevealHitSuffix  = wishlist.map((w) => {
    if (w.type !== 'SUFFIX') return 0;
    const name = w.key.split(':').slice(1).join(':');
    return desecratedNamesSuffix.has(name) ? hit3(desecPoolSuffix.length) : 0;
  });
  const pBoneRevealHitAbyssal = wishlist.map((w) => {
    const name = w.key.split(':').slice(1).join(':');
    return hitAbyssal(desecratedNames.has(name), desecratedPoolSize, kInFullPool);
  });
  const orbCosts = {
    transmute:         safeCost('transmute',        ctx),
    transmute_greater: safeCost('transmuteGreater', ctx),
    transmute_perfect: safeCost('transmutePerfect', ctx),
    augment:           safeCost('augment',          ctx),
    augment_greater:   safeCost('augmentGreater',   ctx),
    augment_perfect:   safeCost('augmentPerfect',   ctx),
    regal:             safeCost('regal',            ctx),
    regal_greater:     safeCost('regalGreater',     ctx),
    regal_perfect:     safeCost('regalPerfect',     ctx),
    regal_sinistral:   sumCost(safeCost('regal', ctx), omenCost('omen-of-sinistral-coronation')),
    regal_dextral:     sumCost(safeCost('regal', ctx), omenCost('omen-of-dextral-coronation')),
    // Bone reveal omens — cost is just the omen (in-game reveal is
    // a free confirm step). Plain reveal is free (cost=0). When the
    // omen has no rate loaded the variant's cost is NaN; the engine
    // silently skips it.
    reveal_bone:           0,
    reveal_bone_sinistral: omenCost('omen-of-sinistral-necromancy'),
    reveal_bone_dextral:   omenCost('omen-of-dextral-necromancy'),
    reveal_bone_abyssal:   omenCost('omen-of-abyssal-echoes'),
    alch:              safeCost('alchemy',          ctx),
    exalt:             safeCost('exalted',          ctx),
    exalt_greater:     safeCost('exaltedGreater',   ctx),
    exalt_perfect:     safeCost('exaltedPerfect',   ctx),
    annul:             safeCost('annulment',        ctx),
    // Annul + Omen of Light — desecrated cleanup. Cost = annul price
    // plus omen-of-light price; both must be priced for the cleanup
    // loop to be available.
    annul_omen_of_light: sumCost(safeCost('annulment', ctx), omenCost('omen-of-light')),
    chaos:             safeCost('chaos',            ctx),
    chaos_greater:     safeCost('chaosGreater',     ctx),
    chaos_perfect:     safeCost('chaosPerfect',     ctx),
    fracturing:        safeCost('fracturing',       ctx),
  };
  const orbTimes = {
    transmute:         ctx.orbs?.transmute?.timeSeconds         ?? 1,
    transmute_greater: ctx.orbs?.transmuteGreater?.timeSeconds  ?? 1,
    transmute_perfect: ctx.orbs?.transmutePerfect?.timeSeconds  ?? 1,
    augment:           ctx.orbs?.augment?.timeSeconds           ?? 1,
    augment_greater:   ctx.orbs?.augmentGreater?.timeSeconds    ?? 1,
    augment_perfect:   ctx.orbs?.augmentPerfect?.timeSeconds    ?? 1,
    regal:             ctx.orbs?.regal?.timeSeconds             ?? 1,
    regal_greater:     ctx.orbs?.regalGreater?.timeSeconds      ?? 1,
    regal_perfect:     ctx.orbs?.regalPerfect?.timeSeconds      ?? 1,
    regal_sinistral:   ctx.orbs?.regal?.timeSeconds             ?? 1,
    regal_dextral:     ctx.orbs?.regal?.timeSeconds             ?? 1,
    alch:              ctx.orbs?.alchemy?.timeSeconds           ?? 1,
    exalt:             ctx.orbs?.exalted?.timeSeconds           ?? 1,
    exalt_greater:     ctx.orbs?.exaltedGreater?.timeSeconds    ?? 1,
    exalt_perfect:     ctx.orbs?.exaltedPerfect?.timeSeconds    ?? 1,
    annul:             ctx.orbs?.annulment?.timeSeconds         ?? 1,
    chaos:             ctx.orbs?.chaos?.timeSeconds             ?? 1,
    chaos_greater:     ctx.orbs?.chaosGreater?.timeSeconds      ?? 1,
    chaos_perfect:     ctx.orbs?.chaosPerfect?.timeSeconds      ?? 1,
    fracturing:        ctx.orbs?.fracturing?.timeSeconds        ?? 3,
  };
  // ---- pTierAcceptable[actionId][i] = P(orb i, having drawn wished
  // mod i, lands at an acceptable tier). Computed exactly from the
  // mod's per-tier weight table crossed with the orb's "Minimum
  // Modifier Level" filter (game-rule, scraped from poe2db.tw):
  //
  //   pAcceptable(orb, mod) =
  //     Σ(weight of tier t : t.ilvl ≥ orb.minLevel ∧ tier-acceptable-to-user)
  //     / Σ(weight of tier t : t.ilvl ≥ orb.minLevel)
  //
  // Plain orbs use minLevel=0 (no filter). Greater/Perfect minLevel
  // values verified at https://poe2db.tw/us/<orb_name> (see commit
  // notes for fetched evidence).
  const orbMinLevel = {
    transmute: 0, transmute_greater: 55, transmute_perfect: 70,
    augment:   0, augment_greater:   55, augment_perfect:   70,
    regal:     0, regal_greater:     35, regal_perfect:     50,
    regal_sinistral: 0, regal_dextral: 0, // omens preserve plain Regal's tier filter
    alch:      0,
    exalt:     0, exalt_greater:     35, exalt_perfect:     50,
    // Chaos minLevel values from poe2db's per-orb pages (verified
    // 2026-05-04, same scrape pattern as the Greater/Perfect Exalt
    // values). Plain Chaos: no filter. Greater: ≥35. Perfect: ≥50.
    chaos:     0, chaos_greater:     35, chaos_perfect:     50,
  };
  // Acceptance test per tier:
  //   requiredTier: hard bar — tier T is acceptable iff T ≤ requiredTier
  //                 (lower tier number = better in PoE2). Takes
  //                 precedence when set.
  //   tierScores:   per-tier desire flags. Tier acceptable iff
  //                 tierScores[T] > 0. Used only when requiredTier
  //                 isn't set.
  // Without either, every tier in the mod's tier table is acceptable.
  const isTierAcceptable = (tier, requiredTier, tierScores) => {
    if (Number.isFinite(requiredTier)) return tier <= requiredTier;
    if (tierScores && typeof tierScores === 'object') {
      const s = tierScores[String(tier)] ?? tierScores[tier];
      return Number(s) > 0;
    }
    return true;
  };
  const pAcceptableForOrbMod = (w, minLevel) => {
    const tiers = w.tiers ?? [];
    if (tiers.length === 0) {
      // No per-tier data: fall back to tierScores-based count ratio
      // (best effort when the mod catalog is unavailable).
      if (w.tierScores && typeof w.tierScores === 'object') {
        const tnums = Object.keys(w.tierScores).map(Number).filter(Number.isFinite);
        if (tnums.length === 0) return 1;
        const acc = tnums.filter((t) => isTierAcceptable(t, w.requiredTier, w.tierScores)).length;
        return acc / tnums.length;
      }
      return 1;
    }
    // Per-tier exact: filter by orb's minLevel, then by user acceptance.
    const eligible = tiers.filter((t) => (t.ilvl ?? 0) >= minLevel);
    if (eligible.length === 0) return 0; // orb's filter excludes every tier this mod has
    const eligibleW = eligible.reduce((s, t) => s + (t.weight ?? 0), 0);
    if (eligibleW <= 0) return 0;
    const acceptableW = eligible
      .filter((t) => isTierAcceptable(t.tier, w.requiredTier, w.tierScores))
      .reduce((s, t) => s + (t.weight ?? 0), 0);
    return acceptableW / eligibleW;
  };
  const pTierAcceptable = {};
  for (const [orbId, minLevel] of Object.entries(orbMinLevel)) {
    pTierAcceptable[orbId] = wishlist.map((w) => pAcceptableForOrbMod(w, minLevel));
  }

  // Starting item: derive from `startingR` / `startingWSoft`. We don't
  // know which specific wished mods are on the start item from the ctx,
  // so we canonicalize: first R required + first WSoft soft. Same as
  // chaos-spam / exalt-annul-cycle do internally.
  const wIsReq = wishlist.map((w) => !!w.required);
  const startMods = [];
  let placedR = 0, placedW = 0;
  const startR = ctx.startingR ?? 0;
  const startWS = ctx.startingWSoft ?? 0;
  for (let i = 0; i < wishlist.length && (placedR < startR || placedW < startWS); i++) {
    if (wIsReq[i] && placedR < startR)        { startMods.push(wishlist[i].key); placedR++; }
    else if (!wIsReq[i] && placedW < startWS) { startMods.push(wishlist[i].key); placedW++; }
  }
  const startingFracturedKey = ctx.startingFracturedKey
    ? canonKey(ctx.startingFracturedKey) : null;
  const startTotal = (ctx.startingCounts?.prefixes ?? 0) + (ctx.startingCounts?.suffixes ?? 0);

  return {
    // Live UI: opt into partial-rate mode so a missing rate surfaces as
    // a warning rather than crashing the panel. Tests / programmatic
    // callers default to hard-fail so silent-drop bugs can't recur.
    allowMissingRates: true,
    wishlist,
    irrelevantWeight,
    irrelevantWeightBySide,
    target: {
      requiredMods,
      // Per-wished desecration-constraint mod keys. Solver translates
      // these to bitmasks (desecrationRequiredMask /
      // desecrationForbiddenMask) using the wishlist→bit mapping.
      desecrationRequiredMods: wishlist
        .filter((w) => w.desecrationConstraint === 'require').map((w) => w.key),
      desecrationForbiddenMods: wishlist
        .filter((w) => w.desecrationConstraint === 'forbid').map((w) => w.key),
      fracturedKey,
      // Acceptance bounds (game-target shape, NOT crafting cap).
      minFilled: ctx.minFilled ?? null,
      maxFilled: ctx.maxFilled ?? null,
      // Allow the goal state to carry a pending unrevealed bone-mod.
      // Default false: a pending bone is treated as "step still
      // pending" and the state isn't goal until reveal completes.
      // True: the user wants to STOP at "bone applied, awaiting
      // reveal" — useful for deferring the Well of Souls decision.
      allowBonePending: !!ctx.targetBoneMod,
    },
    start: {
      // Rough rarity inference: any starting mods OR a pending
      // unrevealed bone-mod ⇒ Rare (apply_bone requires rare, so the
      // user must have a rare item to be in the pre-reveal state);
      // else Normal.
      rarity: (startTotal === 0 && !ctx.startingBoneMod) ? 'normal' : 'rare',
      modsOnItem: startMods,
      totalMods: startTotal,
      // Prefix-side count drives bone-reveal side allocation (3P/0S ⇒
      // forced suffix etc.). Suffix count derived as totalMods - prefixMods.
      prefixMods: ctx.startingCounts?.prefixes ?? 0,
      fracturedKey: startingFracturedKey,
      // Starting desecrated affix (max 1 per the one-cap rule). The
      // typed key is canonicalised so the wished-mask machinery can
      // line it up with a wishlist bit if applicable.
      desecratedKey: ctx.startingDesecratedKey ? canonKey(ctx.startingDesecratedKey) : null,
      desecratedSide: ctx.startingDesecratedSide ?? null,
      // Pending unrevealed bone-mod on the starting item. Maps to
      // engine state.boneMod = true (boneRevealed = false). Note: the
      // engine convention is that totalMods does NOT include the
      // unrevealed slot — it pads the fracture-threshold check only.
      boneMod: !!ctx.startingBoneMod,
      // Optional pre-declared side for the unrevealed bone. When set
      // ('PREFIX' or 'SUFFIX'), the reveal action uses the matching
      // side's hit pool. Null = natural open-slot allocation at reveal.
      boneSide: ctx.startingBoneSide ?? null,
    },
    orbCosts, orbTimes, pTierAcceptable,
    boneCostEx,
    pBoneRevealHit,
    pBoneRevealHitPrefix,
    pBoneRevealHitSuffix,
    pBoneRevealHitAbyssal,
    essences: buildEssenceSpecs(ctx, wishlist, { omenCost, sumCost }),
    basePriceEx: ctx.basePriceEx ?? 0,
    // Default 60 sec — see solve.js note. Adapter reads from ctx if
    // the user surfaces a per-base-source override (e.g. hideout
    // stash = 5 sec, trade = 60 sec, SSF rolling = much higher).
    basePriceSec: ctx.basePriceSec ?? 60,
    // Trade-equivalent value of the desired final item. Used purely for
    // the chain renderer to show itemValue(s) = budgetEx − V*(s) on each
    // node (a "what's this in-progress item worth right now?" annotation).
    // Doesn't influence solver decisions — purely cosmetic. Falls back
    // to ctx.totalBudgetEx (the strategy comparator's budget cap) so the
    // user doesn't have to maintain two separate "budget" inputs.
    budgetEx: ctx.budgetEx ?? ctx.totalBudgetEx ?? null,
    // Toggle from store/UI: include step-id prefix (e.g. "[s5] ") on
    // chain node labels. Default true so debug conversations can
    // refer to "step s5" unambiguously.
    showStepIds: ctx.showStepIds ?? true,
    timeWeightExPerSec: ctx.timeWeightExPerSec ?? 0,
    // Game-rule cap on a Rare's affix count during crafting — NOT the
    // user's target final-mod count. ctx.maxFilled is plumbed separately
    // through `target.maxFilled` so isGoalState can enforce it on the
    // final item; env.maxFilled stays at the PoE2 6-affix game rule so
    // exalt remains applicable during crafting. Earlier these were
    // conflated and a 1-affix target silently blocked exalt at every
    // rare with totalMods ≥ 1.
    maxFilled: 6,
    // Game-rule constants like `alchemyDraws` and `minModsToFracture`
    // live in `engine/mdp/solve.js` as defaults — single source of
    // truth. The adapter intentionally does NOT pass them so any future
    // change to the canonical PoE2 rule lands in one place. (Earlier
    // we duplicated them here and a stale `minModsToFracture: 4` shadowed
    // the engine's correct default of 3, silently disabling fracturing
    // on 3-mod Rares.)
  };
}

function safeCost(orbId, ctx) {
  // User-disabled orbs (per-orb checkbox in the rates panel): return
  // NaN so the engine's missing-cost gate excludes the action from
  // its policy. Cheaper than a separate "disabled action" code path
  // through the solver — NaN propagates naturally.
  if (ctx.disabledOrbs && ctx.disabledOrbs[orbId]) return NaN;
  const orb = ctx.orbs?.[orbId];
  if (!orb) return NaN;
  const ccy = ctx.currencies?.[orb.priceCurrency];
  if (!ccy || !Number.isFinite(ccy.exaltedPer)) return NaN;
  return ccy.exaltedPer;
}

// Build the MDP-ε `essences` input list from the strategy ctx. For
// each essence applicable to the current item class with matched_mods
// overlapping the wishlist, emit one spec:
//   { id, name, costEx, timeSec, matchedKeys, pAcceptable }
// where:
//   - matchedKeys: the wishlist keys the essence's affix would set.
//   - pAcceptable: 1.0 if essence's tier band is at or above the
//     user's requiredTier, 0 otherwise (binary v1 — refined later
//     when essence-tier-to-affix-tier mapping is encoded).
//
// Tier ordinal heuristic (lower = better in PoE2):
//   Lesser    ≈ T5     (modest tier)
//   Normal    ≈ T4
//   Greater   ≈ T2
//   Perfect   ≈ T1     (top tier)
//   Corrupted ≈ T1     (corrupted essences hit highest tier band)
// Refinement deferred to MDP-ε v2; for v1 the binary check works for
// "user wants ≤ T2 ⇒ Greater/Perfect essences are acceptable, Lesser
// isn't" — the most common case.
function buildEssenceSpecs(ctx, wishlist, helpers = {}) {
  const omenCost = helpers.omenCost ?? (() => NaN);
  const sumCost  = helpers.sumCost  ?? ((...vs) => vs.reduce((a, b) => a + b, 0));
  const out = [];
  const essences = ctx.essences ?? [];
  const prices = ctx.essencePrices ?? {};
  const itemClass = ctx.itemClass ?? null;
  const modIds = ctx.modIds ?? {};
  // Mod-name canonicaliser: looks up the id, returns the wishlist
  // key it's already paired with (since wishlist keys were
  // canonicalised earlier via resolveTypedKey). Without this,
  // essence catalog spellings ("+# to maximum Life") don't match
  // canonicalised wishlist keys ("# to maximum Life") and the
  // essence is silently skipped.
  const idForName = (n) => modIds[n] ?? n;
  // Map wishlist canonical mod-name → wishlist key (fast lookup).
  const nameToKey = new Map();
  const idToKey = new Map();
  for (const w of wishlist) {
    const name = w.key.split(':').slice(1).join(':');
    nameToKey.set(name, w.key);
    idToKey.set(idForName(name), w.key);
  }
  const tierOrdinal = { Lesser: 5, Normal: 4, Greater: 2, Perfect: 1, Corrupted: 1 };
  for (const ess of essences) {
    // Item-class filter — essences carry pipe-separated `item_classes`.
    // Engine uses singular ("Amulet"); CSV uses plural ("Amulets").
    // Normalise both sides by stripping trailing 's' so "Amulet"
    // matches "Amulets", "Body Armour" matches "Body Armours", etc.
    const classes = (ess.item_classes ?? '').split('|').map((s) => s.trim()).filter(Boolean);
    if (itemClass && classes.length > 0) {
      const norm = (s) => s.toLowerCase().replace(/s$/, '');
      const wantedNorm = norm(itemClass);
      const matchClass = classes.some((c) => norm(c) === wantedNorm);
      if (!matchClass) continue;
    }
    // Match the essence's `matched_mods` against the wishlist via:
    //   1) exact name (covers cases where catalog spelling already
    //      matches the canonical wishlist spelling), then
    //   2) canonical id (handles "+# to maximum Life" essence text vs
    //      canonical "# to maximum Life" wishlist).
    //
    // Fallback: when `matched_mods` is empty (it's an optional column
    // and many CSV rows leave it blank), derive a candidate name from
    // `target_affix` by stripping the value-range pattern. E.g.
    //   "(27—42)% increased Armour, Evasion or Energy Shield"
    //   → "#% increased Armour, Evasion or Energy Shield"
    //   "+(25—34) to maximum Mana" → "+# to maximum Mana"
    // Then run the same canonical-id lookup. Without this fallback,
    // every essence with empty matched_mods is silently dropped and
    // the MDP reports the craft unreachable.
    const stripRangeToHash = (s) => (s ?? '')
      .replace(/\+?\((-?\d+(?:\.\d+)?)\s*[—–-]\s*(-?\d+(?:\.\d+)?)\)/g, (m) =>
        m.startsWith('+') ? '+#' : '#');
    const candidateNames = [];
    for (const n of (ess.matched_mods ?? '').split('|')) {
      const t = n.trim();
      if (t) candidateNames.push(t);
    }
    // Always also try `target_affix` (range-stripped) — covers two
    // cases: (a) `matched_mods` empty, (b) `matched_mods` populated
    // with junk that doesn't map to any wishlist key (e.g. the
    // scraper writing "detail-page Pre/Suf table → SUFFIX" into the
    // column instead of leaving it blank). Without this, every
    // essence with non-empty-but-unrecognised matched_mods is
    // silently dropped from the action set. User report
    // (2026-05-08): "Essence of Thawing missing from `Why this orb?`
    // even though it guarantees the wishlist mod."
    if (ess.target_affix) {
      candidateNames.push(stripRangeToHash(ess.target_affix).trim());
    }
    const matchedKeys = [];
    for (const n of candidateNames) {
      const key = nameToKey.get(n) ?? idToKey.get(idForName(n));
      if (key && !matchedKeys.includes(key)) matchedKeys.push(key);
    }
    if (matchedKeys.length === 0) continue;
    // Price lookup (essence_prices.csv via ctx.essencePrices map).
    const priceEntry = prices[ess.name];
    const costEx = Number.isFinite(priceEntry?.priceEx) ? priceEntry.priceEx : NaN;
    if (!Number.isFinite(costEx)) continue;
    // Per-essence tier acceptance: binary check vs each matched
    // wished mod's requiredTier. If the essence's tier ordinal is
    // ≤ the wished's requiredTier, the rolled affix is at acceptable
    // tier ⇒ pAcc=1; else 0.
    //
    // Exception: when the wished mod is essence-only (zero base-pool
    // weight), the user's "requiredTier" doesn't correspond to a
    // base-pool tier hierarchy — the synthesised UI tiers map T1 to
    // "best available essence variant," T2 to next, etc. In that
    // case the tier check is meaningless and we accept every essence
    // variant that matches. Without this branch, an affix that only
    // has Lesser Essence of Foo would never reach the user's
    // requiredTier=1 wish, the engine reports the craft as
    // unreachable, and V*=∞.
    const essenceTier = tierOrdinal[ess.tier] ?? 5;
    let pAcceptable = 1;
    for (const k of matchedKeys) {
      const w = wishlist.find((x) => x.key === k);
      const required = w?.requiredTier;
      const essenceOnly = (w?.weight ?? 0) === 0;
      if (essenceOnly) continue;
      if (Number.isFinite(required) && essenceTier > required) {
        pAcceptable = 0; // essence's tier band is below the user's bar
        break;
      }
    }
    // Perfect-essence overwrite mechanic: per project memory
    // `project_perfect_essence_rules`, Perfect essences apply on a
    // RARE item and overwrite a uniformly-random affix (across both
    // sides, modulo Sinistral/Dextral Crystallisation omens which
    // force the side; the same-family-blocked rule prevents
    // overwriting an existing same-family affix). Lower-tier
    // essences (Lesser/Normal/Greater) upgrade Magic→Rare.
    const isPerfect = (ess.tier === 'Perfect') || (ess.tier === 'Corrupted');
    const baseSlug = ess.poe2db_slug ?? ess.name.toLowerCase().replace(/[^a-z0-9]+/g, '_');
    const baseSide = ess.side === 'PREFIX' || ess.side === 'SUFFIX' ? ess.side : null;
    out.push({
      id: `essence_${baseSlug}`,
      name: ess.name,
      costEx,
      timeSec: 1,
      matchedKeys,
      pAcceptable,
      // Side filter from the essence's catalog row (PREFIX | SUFFIX |
      // null). For the BASE variant of a Perfect-essence overwrite,
      // null means "pick from any side" — Sinistral/Dextral Crystal-
      // lisation omens are emitted as separate variants below to
      // force the side. For Magic→Rare essences the side is just
      // informational (the new affix lands in the matching empty
      // slot regardless).
      side: isPerfect ? null : baseSide,
      mode: isPerfect ? 'rare_overwrite' : 'magic_to_rare',
    });
    // Crystallisation omen variants — only meaningful for the rare-
    // overwrite mechanic. Sinistral forces PREFIX-side overwrite,
    // Dextral forces SUFFIX. CRITICAL: the omen's side must MATCH
    // the essence's natural side — otherwise the new affix has
    // nowhere to land (e.g. PREFIX-essence + Dextral-suffix-only
    // would have to put a PREFIX affix into a suffix slot, which
    // the game doesn't allow). Only emit the matching variant.
    // Each variant's cost = essence + omen. Silently skipped when
    // the omen has no rate (NaN propagates and the engine's
    // optional-variant skip kicks in).
    if (isPerfect && baseSide === 'PREFIX') {
      const sinCost = sumCost(costEx, omenCost('omen-of-sinistral-crystallisation'));
      if (Number.isFinite(sinCost)) {
        out.push({
          id: `essence_${baseSlug}_sinistral`,
          name: `${ess.name} (Sinistral Crystallisation)`,
          costEx: sinCost,
          timeSec: 1,
          matchedKeys,
          pAcceptable,
          side: 'PREFIX',
          mode: 'rare_overwrite',
        });
      }
    }
    if (isPerfect && baseSide === 'SUFFIX') {
      const dexCost = sumCost(costEx, omenCost('omen-of-dextral-crystallisation'));
      if (Number.isFinite(dexCost)) {
        out.push({
          id: `essence_${baseSlug}_dextral`,
          name: `${ess.name} (Dextral Crystallisation)`,
          costEx: dexCost,
          timeSec: 1,
          matchedKeys,
          pAcceptable,
          side: 'SUFFIX',
          mode: 'rare_overwrite',
        });
      }
    }
  }
  return out;
}

// Smallest finite value among the args, or null if none are finite.
// Used to merge requiredTier and minTier — the more permissive (lower
// tier number) of the two represents the user's tier acceptance bar.
function pickFiniteMin(...vals) {
  let best = null;
  for (const v of vals) {
    if (!Number.isFinite(v)) continue;
    if (best === null || v < best) best = v;
  }
  return best;
}
