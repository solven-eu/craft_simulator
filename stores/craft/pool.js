// Slot/pool getters extracted from stores/craft.js. Exports a
// spreadable `poolGetters` object that the main store mixes into its
// `getters:` block — `this` and the `state` arg behave the same way
// as if these were declared inline.
//
// Covers:
//   - starting-item summaries (startingByType, startingCounts,
//     startingHits)
//   - eligible-mod pool (availablePool, conditionalPool, fullPool)
//   - basesForType (drives the base-selector dropdown)

function splitBase(base) {
  const m = /^(.+?)\s*\(([^)]+)\)\s*$/.exec(base);
  if (m) return { type: m[1].trim(), spec: m[2].trim() };
  return { type: base, spec: null };
}

export const poolGetters = {
  /**
   * Names of mods already on the starting item, by affix type. Used to
   * approximate same-family exclusion (each `name` treated as its own
   * family — correct for non-hybrid mods; ignores the rare hybrid case).
   */
  startingByType(state) {
    const out = { PREFIX: new Set(), SUFFIX: new Set() };
    for (const s of state.slots.prefixes) if (s) out.PREFIX.add(s.name);
    for (const s of state.slots.suffixes) if (s) out.SUFFIX.add(s.name);
    return out;
  },
  /** Counts of filled slots on the starting item. */
  startingCounts() {
    return {
      prefixes: this.startingByType.PREFIX.size,
      suffixes: this.startingByType.SUFFIX.size,
    };
  },
  /** Number of wished mods already on the starting item. */
  startingHits(state) {
    let hits = 0;
    for (const e of Object.values(state.wishlist)) {
      const set = e.type === 'PREFIX'
        ? this.startingByType.PREFIX : this.startingByType.SUFFIX;
      if (set.has(e.name)) hits++;
    }
    return hits;
  },
  /** Pool conditioned on starting state: excludes mods already on item. */
  conditionalPool() {
    const { PREFIX, SUFFIX } = this.startingByType;
    const out = [];
    for (const m of this.availablePool.prefixes) {
      if (!PREFIX.has(m.name)) out.push({
        key: `PREFIX:${m.name}`, type: 'PREFIX', weight: m.totalWeight,
        // Per-tier breakdown: needed by MDP-γ to compute pTierAcceptable
        // exactly (Σ weights of tiers within the orb's mod-level filter
        // ∩ user-accepted tiers / Σ weights of orb-eligible tiers).
        // Each entry: { tier, weight, ilvl, spawnLvl, tierName }.
        tiers: m.eligibleTiers ?? [],
      });
    }
    for (const m of this.availablePool.suffixes) {
      if (!SUFFIX.has(m.name)) out.push({
        key: `SUFFIX:${m.name}`, type: 'SUFFIX', weight: m.totalWeight,
        tiers: m.eligibleTiers ?? [],
      });
    }
    return out;
  },
  /** Unconditional pool (all eligible mods at this base + ilvl). */
  fullPool() {
    return [
      ...this.availablePool.prefixes.map((m) => ({
        key: `PREFIX:${m.name}`, type: 'PREFIX', weight: m.totalWeight,
        tiers: m.eligibleTiers ?? [],
      })),
      ...this.availablePool.suffixes.map((m) => ({
        key: `SUFFIX:${m.name}`, type: 'SUFFIX', weight: m.totalWeight,
        tiers: m.eligibleTiers ?? [],
      })),
    ];
  },
  /**
   * Available mods for the current base + itemLevel, split by affix type.
   * For each mod (one per `name`), keeps only tiers that can spawn at the
   * current ilvl (tier.ilvl ≤ itemLevel) and reports:
   *   - bestTier:     the highest available tier (lowest `tier` number),
   *   - bestWeight:   that tier's weight (single-tier roll weight),
   *   - totalWeight:  sum of weights across all available tiers (probability
   *                   that this mod is rolled at all on the affix slot).
   * Pool totals (returned alongside) drive per-mod probabilities.
   */
  availablePool(state) {
    const empty = { prefixes: [], suffixes: [], totals: { prefix: 0, suffix: 0 } };
    if (!state.base) return empty;
    const out = { ...empty, prefixes: [], suffixes: [] };
    // Pre-compute tag filters for cheap per-mod check.
    const includes = Object.entries(state.tagFilters)
      .filter(([, v]) => v === 'include').map(([t]) => t);
    const excludes = Object.entries(state.tagFilters)
      .filter(([, v]) => v === 'exclude').map(([t]) => t);
    const tagsForMod = (mod) => {
      // Direct lookup: tags for this exact (base, mod-name) pair.
      const direct = state.modTags?.[mod.base]?.[mod.name];
      if (direct?.length) return direct;
      // Cross-base fallback: PoE2 mods carry the same name + same
      // tags across most bases ("# to maximum Life" is `life` on
      // every wearable). The mod_tags scraper is best-effort and
      // didn't cover every base — for missing bases we search any
      // populated base for the same mod name. This made tags
      // disappear on Bow / Crossbow / Spear etc. where the scrape
      // hasn't reached.
      for (const baseMap of Object.values(state.modTags ?? {})) {
        const tags = baseMap?.[mod.name];
        if (tags?.length) return tags;
      }
      return [];
    };
    for (const mod of state.mods) {
      if (mod.base !== state.base) continue;
      if (!mod.tiers?.length) continue;
      // Tag filters: keep the row in the list but flag it so the UI can
      // render it disabled (greyed, no "+ wish") instead of hiding it.
      const tags = tagsForMod(mod);
      const includeFail = includes.length > 0 && !includes.some((t) => tags.includes(t));
      const excludeFail = excludes.length > 0 && excludes.some((t) => tags.includes(t));
      const tagFiltered = includeFail || excludeFail;
      const eligible = mod.tiers.filter((t) => (t.ilvl ?? 0) <= state.itemLevel);
      const ilvlOk = eligible.length > 0;
      const allIlvls = mod.tiers.map((t) => t.ilvl ?? 0);
      const requiredIlvl = Math.min(...allIlvls);    // lowest ilvl-req = minimum to roll any tier
      // "best" is the highest-quality (lowest-tier-number) entry we'd pick;
      // for ineligible mods, fall back to the highest-quality known tier
      // for display purposes (greyed/strikethrough).
      const pickBest = (list) => list.reduce((a, b) => (a.tier <= b.tier ? a : b));
      const best = ilvlOk ? pickBest(eligible) : pickBest(mod.tiers);
      const totalWeight = ilvlOk
        ? eligible.reduce((s, t) => s + (t.weight ?? 0), 0) : 0;
      const entry = {
        base: mod.base,
        type: mod.type,
        name: mod.name,
        bestTier: best.tier,
        bestTierName: best.tierName,
        bestWeight: ilvlOk ? (best.weight ?? 0) : 0,
        totalWeight,
        tiersAvailable: eligible.length,
        tiersTotal: mod.tiers.length,
        eligibleTiers: eligible.slice().sort((a, b) => a.tier - b.tier),
        /** All tiers of this mod, with an `ilvlOk` flag per tier for the UI. */
        allTiers: mod.tiers
          .slice()
          .sort((a, b) => a.tier - b.tier)
          .map((t) => ({ ...t, ilvlOk: (t.ilvl ?? 0) <= state.itemLevel })),
        ilvlOk,
        requiredIlvl,
        tags,
        tagFiltered,
      };
      if (mod.type === 'PREFIX') {
        out.prefixes.push(entry);
        if (ilvlOk && !tagFiltered) out.totals.prefix += totalWeight;
      } else if (mod.type === 'SUFFIX') {
        out.suffixes.push(entry);
        if (ilvlOk && !tagFiltered) out.totals.suffix += totalWeight;
      }
    }
    // Stable ilvl-independent ordering: by requiredIlvl asc (lowest hurdle
    // first), then by name. Eligibility/weight depend on the current ilvl,
    // so sorting by them would reshuffle the list every time ilvl changes.
    const order = (a, b) =>
      (a.requiredIlvl - b.requiredIlvl) || a.name.localeCompare(b.name);
    out.prefixes.sort(order);
    out.suffixes.sort(order);
    return out;
  },
  /** Distinct bases for the current itemType, with attribute spec parsed out. */
  basesForType(state) {
    if (!state.itemType) return [];
    const seen = new Set();
    const list = [];
    for (const m of state.mods) {
      if (m.itemClass !== state.itemType) continue;
      if (seen.has(m.base)) continue;
      seen.add(m.base);
      list.push({ base: m.base, ...splitBase(m.base) });
    }
    list.sort((a, b) => (a.spec ?? '').localeCompare(b.spec ?? ''));
    return list;
  },
};
