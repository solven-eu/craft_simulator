// Mod-related helper actions extracted from stores/craft.js. Exports
// a spreadable object that the main store mixes directly into its
// `actions:` block — no thin-wrapper delegation. `this` binds to the
// Pinia store instance, so these read `this.base`, `this.mods`, etc.
// the same way they would inline in craft.js.
//
// All functions in this module read state and don't mutate it; they
// could be `getters:` instead, but Pinia getters require a single
// `state` arg per getter and we want positional args (name, tier).
// Keeping them under `actions:` is the conventional Pinia pattern
// for parametric "computed" methods.

// Best → worst quality order (Perfect is best, Lesser is worst).
// When synthesising tiers for an essence-only mod, we walk this list
// in order and assign T1, T2, ... to whichever variants ARE present —
// so the dropdown always offers a T1 row (the best reachable
// variant), regardless of how many variants exist for that affix.
// Without this remap, an affix with only `Lesser Essence of …`
// available would expose T4 as its best tier and the user couldn't
// score T1 from the per-tier UI.
const ESS_QUALITY_ORDER = ['Perfect', 'Greater', 'Normal', 'Lesser'];

export const modHelperActions = {
  /**
   * Display text for a specific (mod, tier) on the current base.
   * Returns the actual value range (e.g. "+(10—19) to maximum Life")
   * if available, otherwise falls back to the canonical mod name.
   */
  getModDisplay(name, tier) {
    const t = String(tier);
    return this.modRanges?.[this.base]?.[name]?.[t] ?? name;
  },

  /**
   * Worst-case roll display at a given tier — the lower bound of the
   * per-tier range, substituted back into the display template (e.g.
   * `+(70—84) to maximum Life` → `+70 to maximum Life`). Used by the
   * desired-mod UI to render "T2 ≥ +70 to maximum Life" next to the
   * tier slider so the user reads the implied floor at a glance.
   *
   * Falls back to the full display string if no parseable range is
   * found (essence/desecrated mods, single-literal tier rows).
   */
  minRollAtTier(name, tier) {
    const display = this.getModDisplay(name, tier);
    if (!display) return null;
    return display.replace(/\((\d+(?:\.\d+)?)\s*[—–-]\s*\d+(?:\.\d+)?\)/g, '$1');
  },

  /**
   * Eligible tiers (with names + ilvl) for a mod on the current
   * base+ilvl. Returns [] if not found. Sorted ascending by tier.
   */
  getEligibleTiers(type, name) {
    if (!this.base) return [];
    const m = this.mods.find((x) => x.base === this.base && x.type === type && x.name === name);
    if (!m) return [];
    return m.tiers
      .filter((t) => (t.ilvl ?? 0) <= this.itemLevel)
      .slice()
      .sort((a, b) => a.tier - b.tier);
  },

  /**
   * Canonical display name for a mod, given any spelling. Two
   * spellings of the same affix (essence text `+# to maximum Life`
   * and base-pool `# to maximum Life`) collapse to the same id in
   * mod_ids.json; this helper picks the registry's canonical form so
   * wishlist / target / starting keys stay consistent regardless of
   * which panel triggered the add.
   *
   * Returns the input unchanged for essence/desecrated-only mods
   * with no base-pool registry entry.
   */
  canonicalModName(name) {
    if (typeof name !== 'string' || !name) return name;
    const reg = this.mods ?? [];
    if (reg.some((m) => m.name === name)) return name;
    const nameToId = this.modIds?.name_to_id ?? {};
    const wantId = nameToId[name];
    if (wantId) {
      const hit = reg.find((m) => nameToId[m.name] === wantId);
      if (hit) return hit.name;
    }
    return name;
  },

  /**
   * For a base mod, returns the set of tier numbers that are
   * essence-grantable — i.e. the tier whose display range contains
   * the essence's affix range. Used by the desired-mod UI to chip
   * each tier row that an essence consumable can guarantee.
   *
   * Implementation: for each essence row whose `text` matches `name`
   * (or its loose-key form), parse the numeric range from `display`,
   * then check which base tier (from `modRanges`) contains that
   * range. The check is "essence range ⊆ base-tier range." For
   * essence-only mods (no base-pool tiers), every essence variant
   * trivially maps to its synthesised T1..TN — that case is already
   * handled by `getAllTiers` and doesn't need this helper.
   *
   * Returns a Set<number> of grantable tiers; empty when no essence
   * grants this affix.
   */
  essenceableTiers(type, name) {
    if (!this.base || !name) return new Set();
    const out = new Set();
    const extra = this.extraMods?.[this.base] ?? {};
    const essRows = (extra.essence ?? []).filter((e) => {
      if (!e.text) return false;
      if (e.text === name) return true;
      // Loose-key match (`+# to maximum Life` essence vs `# to
      // maximum Life` base): strip leading `+`, collapse `+#` → `#`.
      const loose = e.text.replace(/^\+/, '').replace(/\+#/g, '#').trim();
      return loose === name;
    });
    if (!essRows.length) return out;
    const ranges = this.modRanges?.[this.base] ?? {};
    // Try both base-name forms (with/without leading `+`).
    const tierMap = ranges[name] ?? ranges['+' + name] ?? ranges[name.replace(/^\+/, '')] ?? null;
    if (!tierMap) return out;
    // Parse "(N—M)" or "+(N—M)" → [N, M]. Returns null if no range.
    const parseRange = (s) => {
      const m = /\(\s*(-?\d+(?:\.\d+)?)\s*[—–-]\s*(-?\d+(?:\.\d+)?)\s*\)/.exec(s ?? '');
      return m ? [parseFloat(m[1]), parseFloat(m[2])] : null;
    };
    for (const ess of essRows) {
      const er = parseRange(ess.display);
      if (!er) continue;
      const [eLo, eHi] = er;
      for (const [tierStr, display] of Object.entries(tierMap)) {
        const tr = parseRange(display);
        if (!tr) continue;
        const [tLo, tHi] = tr;
        // Essence range fully contained in tier range ⇒ this essence
        // grants the affix at this tier.
        if (eLo >= tLo && eHi <= tHi) {
          out.add(Number(tierStr));
        }
      }
    }
    return out;
  },

  /**
   * All tiers (eligible or not) for a mod, each with an `ilvlOk` flag.
   * Resolution order:
   *   1. Direct match on registry name.
   *   2. Cross-resolve via mod-id table.
   *   3. Synthesised essence-variant rows (Lesser / Normal / Greater /
   *      Perfect → tier 4 / 3 / 2 / 1).
   *   4. Desecrated-row single-placeholder fallback.
   *   5. Empty array.
   */
  getAllTiers(type, name) {
    if (!this.base) return [];
    let m = this.mods.find((x) => x.base === this.base && x.type === type && x.name === name);
    if (!m) {
      const nameToId = this.modIds?.name_to_id ?? {};
      const wantId = nameToId[name];
      if (wantId) {
        m = this.mods.find((x) => x.base === this.base && x.type === type
          && nameToId[x.name] === wantId);
      }
    }
    if (m) {
      return m.tiers.slice().sort((a, b) => a.tier - b.tier).map((t) => ({
        ...t,
        ilvlOk: (t.ilvl ?? 0) <= this.itemLevel,
      }));
    }
    const extra = this.extraMods?.[this.base] ?? {};
    const essRows = (extra.essence ?? []).filter((e) => e.text === name);
    if (essRows.length) {
      const byVariant = new Map();
      for (const r of essRows) {
        const tn = r.tier_name || '';
        let variant = 'Normal';
        if (/^Lesser\s+/i.test(tn))      variant = 'Lesser';
        else if (/^Greater\s+/i.test(tn)) variant = 'Greater';
        else if (/^Perfect\s+/i.test(tn)) variant = 'Perfect';
        if (!byVariant.has(variant)) byVariant.set(variant, r);
      }
      // Walk best→worst, assigning T1, T2, ... to variants that
      // actually exist for this mod. So a Lesser-only essence affix
      // surfaces as T1 (its only and therefore best tier).
      const tiers = [];
      let nextTier = 1;
      for (const v of ESS_QUALITY_ORDER) {
        const r = byVariant.get(v);
        if (!r) continue;
        tiers.push({
          tier: nextTier++,
          tierName: r.tier_name || `${v} essence`,
          ilvl: 0, ilvlOk: true, weight: 0,
        });
      }
      if (tiers.length) return tiers;
    }
    const desRow = (extra.desecrated ?? []).find((e) => e.text === name);
    if (desRow) {
      return [{
        tier: 1,
        tierName: desRow.tier_name || '(desecrated mod)',
        ilvl: 0, ilvlOk: true, weight: 0,
      }];
    }
    return [];
  },
};
