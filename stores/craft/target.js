// Target / desired-mods cluster — getters + actions for the
// `targetEntries` array and its derived per-side summaries, tier
// bands, reachability, and desire-score cap.
//
// Spreadable into the Pinia store: `targetGetters` ⇒ `getters:`
// (each fn takes `state` as its first arg and may read `this` for
// other getters); `targetActions` ⇒ `actions:` (`this` is the store
// instance).

import { wlKey } from './keys.js';

export const targetGetters = {
  /**
   * Factory-getter: returns `(entry) => boolean`.
   * Required only when the user explicitly toggled it. Filling a
   * side with 3 desired entries does NOT auto-promote them — the
   * user may still want a soft target (e.g. "any 2 of these 3 is
   * acceptable") expressed via desire score.
   */
  isEntryEffectivelyRequired(state) {
    return (entry) => {
      if (entry?.kind !== 'mod') return false;
      if (entry.disabled) return false;
      return (entry.requiredTier !== undefined && entry.requiredTier !== null)
        || entry.required === true;
    };
  },

  /**
   * Factory-getter: returns `(entry) => boolean`.
   * A desired entry is "shadowed" when its side already has 3
   * required mod-entries — those 3 fill every slot, so a 4th
   * (desired) entry can never land on the item. Render it
   * muted/disabled-looking.
   */
  isEntryShadowed(state) {
    return (entry) => {
      if (entry?.kind !== 'mod') return false;
      if (entry.disabled) return false;
      const isReq = (e) =>
        (e.requiredTier !== undefined && e.requiredTier !== null) || e.required === true;
      if (isReq(entry)) return false;
      const reqOnSide = state.targetEntries.filter(
        (e) => e.kind === 'mod' && e.type === entry.type && !e.disabled && isReq(e),
      ).length;
      return reqOnSide >= 3;
    };
  },

  /**
   * Factory-getter: returns
   *   `(entry, eligibleTiers) => { requiredTier, desiredTier, maxTier }`.
   *
   * Resolves the per-entry tier-band thresholds. New model fields
   * take precedence; legacy `required`/`minTier` are migrated lazily
   * on read. Invariant the UI must preserve: `requiredTier` is null
   * OR ≤ `desiredTier`.
   */
  tierBandFor() {
    return (entry, eligibleTiers) => {
      const tiers = (eligibleTiers ?? []).map((t) => Number(t.tier)).filter(Number.isFinite);
      const maxTier = tiers.length ? Math.max(...tiers) : 1;
      let desiredTier;
      if (Number.isFinite(entry?.desiredTier)) {
        desiredTier = Number(entry.desiredTier);
      } else if (Number.isFinite(entry?.minTier)) {
        desiredTier = Number(entry.minTier);
      } else {
        // Last resort: the worst tier with a non-zero score.
        const scored = Object.entries(entry?.tierScores ?? {})
          .filter(([, v]) => Number(v) > 0)
          .map(([t]) => Number(t));
        desiredTier = scored.length ? Math.max(...scored) : maxTier;
      }
      let requiredTier;
      if (entry?.requiredTier === null) {
        requiredTier = null;
      } else if (Number.isFinite(entry?.requiredTier)) {
        requiredTier = Number(entry.requiredTier);
      } else if (entry?.required === true) {
        // Legacy: required boolean + minTier ⇒ required band == minTier.
        requiredTier = Number.isFinite(entry?.minTier) ? Number(entry.minTier) : desiredTier;
      } else {
        requiredTier = null;
      }
      if (requiredTier != null && requiredTier > desiredTier) requiredTier = desiredTier;
      return { requiredTier, desiredTier, maxTier };
    };
  },

  /**
   * Factory-getter: returns `(entry) => { reachable, minIlvlNeeded }`.
   * Reachability uses the *desired* band — anything beyond
   * `desiredTier` is meaningless, so it doesn't matter if it's
   * ilvl-locked.
   */
  targetEntryReachability(state) {
    return (entry) => {
      if (!entry || entry.kind !== 'mod') return { reachable: true, minIlvlNeeded: null };
      const m = state.mods.find(
        (x) => x.base === state.base && x.type === entry.type && x.name === entry.name,
      );
      if (!m || !m.tiers?.length) return { reachable: true, minIlvlNeeded: null };
      const desired = Number.isFinite(entry.desiredTier) ? Number(entry.desiredTier)
        : Number.isFinite(entry.minTier) ? Number(entry.minTier)
        : Math.max(...m.tiers.map((t) => t.tier));
      const acceptable = m.tiers.filter((t) => t.tier <= desired);
      if (!acceptable.length) return { reachable: false, minIlvlNeeded: null };
      const reachable = acceptable.some((t) => (t.ilvl ?? 0) <= state.itemLevel);
      const minIlvlNeeded = reachable ? null
        : acceptable.reduce(
            (best, t) => (t.ilvl < (best ?? Infinity) ? t.ilvl : best),
            null,
          );
      return { reachable, minIlvlNeeded };
    };
  },

  /** Per-side counts: mod (= total), required (effective), desired, empty. */
  targetSummary(state) {
    const summary = {
      prefixes: { mod: 0, required: 0, desired: 0, empty: 0 },
      suffixes: { mod: 0, required: 0, desired: 0, empty: 0 },
    };
    const isEffReq = this.isEntryEffectivelyRequired;
    for (const e of state.targetEntries) {
      const bucket = e.type === 'PREFIX' ? summary.prefixes : summary.suffixes;
      if (e.kind === 'mod') {
        bucket.mod++;
        if (e.disabled) continue;
        if (isEffReq(e)) bucket.required++;
        else bucket.desired++;
      } else if (e.kind === 'empty') bucket.empty++;
    }
    return summary;
  },

  /** Total counts across both sides. */
  targetTotals(state) {
    const isEffReq = this.isEntryEffectivelyRequired;
    let required = 0, desired = 0, empty = 0;
    for (const e of state.targetEntries) {
      if (e.kind === 'mod') {
        if (isEffReq(e)) required++;
        else desired++;
      } else if (e.kind === 'empty') empty++;
    }
    return { required, desired, empty };
  },

  /** Target entries split by type for display. */
  targetByType(state) {
    const out = { PREFIX: [], SUFFIX: [] };
    state.targetEntries.forEach((e, idx) => {
      if (e.type === 'PREFIX') out.PREFIX.push({ ...e, idx });
      else if (e.type === 'SUFFIX') out.SUFFIX.push({ ...e, idx });
    });
    return out;
  },

  /** Selected wishlist entries with their score. */
  wishlistEntries(state) {
    return Object.values(state.wishlist);
  },

  /**
   * Maximum achievable desire score: per side, take top-K best
   * per-entry scores where K = 3 minus explicit-empty entries.
   * Entries with no achievable tier in their desired band → 0.
   */
  maxDesireScore(state) {
    const ilvlOkSet = (e) => {
      const mod = state.mods.find(
        (m) => m.base === state.base && m.type === e.type && m.name === e.name,
      );
      const ok = new Set();
      for (const t of mod?.tiers ?? []) {
        if ((t.ilvl ?? 0) <= state.itemLevel) ok.add(Number(t.tier));
      }
      return ok;
    };
    const bestForEntry = (e) => {
      const desired = Number.isFinite(e.desiredTier) ? Number(e.desiredTier)
        : Number.isFinite(e.minTier) ? Number(e.minTier)
        : Infinity;
      const reachable = ilvlOkSet(e);
      let best = 0;
      for (const [t, s] of Object.entries(e.tierScores ?? {})) {
        const tn = Number(t);
        const sn = Number(s) || 0;
        if (tn <= desired && reachable.has(tn) && sn > best) best = sn;
      }
      let bestTierNum = Infinity;
      for (const [t, s] of Object.entries(e.tierScores ?? {})) {
        const tn = Number(t);
        const sn = Number(s) || 0;
        if (tn <= desired && reachable.has(tn) && sn === best && tn < bestTierNum) {
          bestTierNum = tn;
        }
      }
      const reqTier = (e.requiredTier !== undefined && e.requiredTier !== null)
        ? Number(e.requiredTier) : null;
      if (reqTier != null && reqTier <= bestTierNum) return 0;
      return best;
    };
    const sideTotal = (type) => {
      const empties = state.targetEntries.filter(
        (e) => e.kind === 'empty' && e.type === type,
      ).length;
      const slots = Math.max(0, 3 - empties);
      const scores = state.targetEntries
        .filter((e) => e.kind === 'mod' && e.type === type && !e.disabled)
        .map(bestForEntry)
        .sort((a, b) => b - a);
      return scores.slice(0, slots).reduce((s, v) => s + v, 0);
    };
    return sideTotal('PREFIX') + sideTotal('SUFFIX');
  },

  /**
   * Min-desire-score the engine should actually use, capped to
   * `maxDesireScore`. Without this cap, a user-typed value above
   * the achievable max would render the goal unreachable in every
   * state and trip the "impossible craft" banner.
   */
  effectiveMinDesireScore(state) {
    const max = this.maxDesireScore || 0;
    const v = Number(state.minDesireScore);
    if (!Number.isFinite(v) || v <= 0) return 0;
    return v > max ? max : v;
  },
};

export const targetActions = {
  _syncTargetConstraints() {
    if (!this.targetEntries.length) return;
    const isEffReq = this.isEntryEffectivelyRequired;
    let required = 0, desired = 0, emptyP = 0, emptyS = 0;
    for (const e of this.targetEntries) {
      if (e.kind === 'mod') {
        if (e.disabled) continue;
        if (isEffReq(e)) required++;
        else desired++;
      } else if (e.kind === 'empty') {
        if (e.type === 'PREFIX') emptyP++;
        else if (e.type === 'SUFFIX') emptyS++;
      }
    }
    emptyP = Math.min(3, emptyP);
    emptyS = Math.min(3, emptyS);
    const total = required + desired;
    this.requiredHits = total;
    this.minFilled = total;
    this.maxFilled = 6 - emptyP - emptyS;
  },

  /**
   * Append a wished mod to the target list. Defaults to a desired-only
   * band (`requiredTier: null, desiredTier: minTier`). Pass
   * `required: true` to pre-set the required band to `minTier`.
   */
  addTargetMod(type, name, minTier, eligibleTiers, required = false) {
    const canon = this.canonicalModName(name);
    const tierScores = {};
    const base = 1;
    const t0 = Number(minTier);
    // Pull tiers via getAllTiers so essence-only mods (no base-pool
    // entry, but synthesised Lesser→Perfect rows in extra_mods) get a
    // populated tierScores map. Without this fallback the per-tier
    // scoreboard defaulted every essence tier to 0, which the wishlist
    // engine then read as "rejected at every tier".
    const allTiers = this.getAllTiers(type, canon);
    const fallbackTiers = allTiers.length ? allTiers
      : (this.mods.find((m) => m.base === this.base && m.type === type && m.name === canon)?.tiers
         ?? eligibleTiers ?? []);
    for (const t of fallbackTiers) tierScores[t.tier] = base;
    this.targetEntries.push({
      kind: 'mod', type, name: canon,
      requiredTier: required ? t0 : null,
      desiredTier: t0,
      tierScores,
      required, minTier: t0,
    });
    this.wishlist[wlKey(type, canon)] = { type, name: canon, score: base, tierScores };
    this._syncTargetConstraints();
    return true;
  },

  /** Set a per-tier score on a target mod entry. Empty/NaN clears to 0. */
  setTargetEntryTierScore(index, tier, score) {
    const entry = this.targetEntries[index];
    if (!entry || entry.kind !== 'mod') return;
    const tierScores = { ...(entry.tierScores ?? {}) };
    const n = Number(score);
    tierScores[tier] = Number.isFinite(n) && n >= 0 ? n : 0;
    this.targetEntries[index] = { ...entry, tierScores };
    const k = wlKey(entry.type, entry.name);
    if (this.wishlist[k]) this.wishlist[k] = { ...this.wishlist[k], tierScores };
  },

  /**
   * Disable / re-enable a target mod entry. Disabled entries stay in
   * the list but are excluded from analytics.
   */
  setTargetEntryDisabled(index, disabled) {
    const entry = this.targetEntries[index];
    if (!entry || entry.kind !== 'mod') return;
    this.targetEntries[index] = { ...entry, disabled: Boolean(disabled) };
    const k = wlKey(entry.type, entry.name);
    if (disabled) {
      delete this.wishlist[k];
    } else {
      this.wishlist[k] = { type: entry.type, name: entry.name, score: 1, tierScores: entry.tierScores };
    }
    this._syncTargetConstraints();
  },

  /** Set the required checkbox for a target mod entry. */
  setTargetEntryRequired(index, required) {
    const entry = this.targetEntries[index];
    if (!entry || entry.kind !== 'mod') return;
    if (required) {
      const sideRequiredCount = this.targetEntries.filter(
        (e, i) => i !== index && e.kind === 'mod' && e.type === entry.type
          && (e.requiredTier != null || e.required === true),
      ).length;
      if (sideRequiredCount >= 3) return;
    }
    const desiredTier = Number.isFinite(entry.desiredTier) ? Number(entry.desiredTier)
      : Number.isFinite(entry.minTier) ? Number(entry.minTier) : 1;
    this.targetEntries[index] = {
      ...entry,
      required: Boolean(required),
      requiredTier: required ? desiredTier : null,
    };
    this._syncTargetConstraints();
  },

  /**
   * Set the per-entry tier band. `requiredTier` may be null or an
   * integer tier. `desiredTier` is the worst-tier still earning
   * score. Enforces requiredTier ≤ desiredTier; clamps to [1, maxTier].
   */
  setTargetEntryTierBand(index, requiredTier, desiredTier, maxTier) {
    const entry = this.targetEntries[index];
    if (!entry || entry.kind !== 'mod') return;
    const cap = Number.isFinite(maxTier) ? Math.max(1, Number(maxTier)) : Infinity;
    let dT = Math.max(1, Math.min(cap, Math.round(Number(desiredTier))));
    if (!Number.isFinite(dT)) dT = 1;
    let rT = requiredTier === null || requiredTier === undefined || requiredTier === ''
      ? null : Math.round(Number(requiredTier));
    if (rT != null) {
      if (!Number.isFinite(rT)) rT = null;
      else rT = Math.max(1, Math.min(cap, rT));
      if (rT != null && rT > dT) rT = dT;
    }
    if (rT != null && (entry.requiredTier == null && entry.required !== true)) {
      const sideRequiredCount = this.targetEntries.filter(
        (e, i) => i !== index && e.kind === 'mod' && e.type === entry.type
          && (e.requiredTier != null || e.required === true),
      ).length;
      if (sideRequiredCount >= 3) rT = null;
    }
    this.targetEntries[index] = {
      ...entry,
      requiredTier: rT,
      desiredTier: dT,
      required: rT != null,
      minTier: dT,
    };
    this._syncTargetConstraints();
  },

  /**
   * Append an explicit-empty entry for a side. Caps at 3 per side,
   * and rejects when (required + empty) already fills the 3 slots.
   */
  addTargetEmpty(type) {
    const isReq = (e) =>
      (e.requiredTier !== undefined && e.requiredTier !== null) || e.required === true;
    const empties = this.targetEntries.filter((e) => e.kind === 'empty' && e.type === type).length;
    const required = this.targetEntries.filter(
      (e) => e.kind === 'mod' && e.type === type && !e.disabled && isReq(e),
    ).length;
    if (empties + required >= 3) return false;
    this.targetEntries.push({ kind: 'empty', type });
    this._syncTargetConstraints();
    return true;
  },

  /** Remove a target entry by index. */
  removeTargetEntry(index) {
    const entry = this.targetEntries[index];
    if (!entry) return;
    if (entry.kind === 'mod') {
      const stillUsed = this.targetEntries.some((e, i) =>
        i !== index && e.kind === 'mod' && e.type === entry.type && e.name === entry.name);
      if (!stillUsed) delete this.wishlist[wlKey(entry.type, entry.name)];
    }
    this.targetEntries.splice(index, 1);
    this._syncTargetConstraints();
  },

  /**
   * Legacy entry-point: update min-tier and bulk-reset per-tier
   * scores. Kept for callers still hitting the old API; new UI
   * uses `setTargetEntryTierBand` + `setTargetEntryTierScore`.
   */
  setTargetEntryMinTier(index, minTier, eligibleTiers) {
    const entry = this.targetEntries[index];
    if (!entry || entry.kind !== 'mod') return;
    const t0 = Number(minTier);
    const tierScores = {};
    const base = 1;
    for (const t of eligibleTiers ?? []) {
      tierScores[t.tier] = t.tier <= t0 ? base : 0;
    }
    this.targetEntries[index] = {
      ...entry,
      minTier: t0,
      tierScores,
      desiredTier: t0,
      requiredTier: (entry.requiredTier != null || entry.required === true) ? t0 : null,
    };
    this.wishlist[wlKey(entry.type, entry.name)] = { type: entry.type, name: entry.name, score: base, tierScores };
  },

  clearTarget() {
    this.targetEntries = [];
    this.wishlist = {};
  },

  hasTargetSlots() {
    return this.targetEntries.length > 0;
  },

  setMinDesireScore(n) {
    const v = Number(n);
    this.minDesireScore = Number.isFinite(v) && v >= 0 ? v : 0;
  },
};
