import { defineStore } from 'pinia';
import { games } from '../games/index.js';
import { compareStrategies } from '../engine/strategies.js';
import { readURLState, writeURLState, debounce, SHAREABLE_FIELDS } from '../lib/urlState.js';
import { solveMDP } from '../engine/mdp/solve.js';
import { ctxToMdpInput } from '../engine/mdp/adapter.js';

// localStorage keys are game-scoped: `craft-simulator:<gameId>:<field>`.
// This lets PoE2 / PoE1 / D4 each remember their own custom currency rates,
// reference-currency choice, and mechanics overrides without collision.
const NS = 'craft-simulator';
const rateKey  = (g) => `${NS}:${g}:rateOverrides`;
const refKey   = (g) => `${NS}:${g}:referenceCurrency`;
const mechKey  = (g) => `${NS}:${g}:mechanicsOverrides`;
const timeKey  = (g) => `${NS}:${g}:timeOverrides`;

function loadOverrides(g) {
  try {
    const raw = localStorage.getItem(rateKey(g));
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}
function saveOverrides(g, overrides) {
  try { localStorage.setItem(rateKey(g), JSON.stringify(overrides)); }
  catch { /* ignore quota / private mode */ }
}
function loadReference(g) {
  try { return localStorage.getItem(refKey(g)) || 'exalted'; }
  catch { return 'exalted'; }
}
function saveReference(g, id) {
  try { localStorage.setItem(refKey(g), id); } catch { /* ignore */ }
}
function loadMechanics(g) {
  try {
    const raw = localStorage.getItem(mechKey(g));
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}
function saveMechanics(g, o) {
  try { localStorage.setItem(mechKey(g), JSON.stringify(o)); }
  catch { /* ignore */ }
}
function loadTimeOverrides(g) {
  try {
    const raw = localStorage.getItem(timeKey(g));
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}
function saveTimeOverrides(g, o) {
  try { localStorage.setItem(timeKey(g), JSON.stringify(o)); }
  catch { /* ignore */ }
}

const INITIAL_GAME = (typeof window !== 'undefined'
  && readURLState && (readURLState() ?? {}).gameId) || 'poe2';

/**
 * Initial state loader: URL state takes precedence over localStorage so a
 * shared link recreates the planner on any machine.
 */
const URL_INITIAL = readURLState() ?? {};
function fromUrlOr(field, fallback) {
  return field in URL_INITIAL ? URL_INITIAL[field] : fallback;
}

const EMPTY_SLOTS = () => ({
  prefixes: [null, null, null],
  suffixes: [null, null, null],
});

/** Wishlist key — unique within a base. */
const wlKey = (type, name) => `${type}:${name}`;

/**
 * "BOOTS (INT/DEX)" -> { type: "BOOTS", spec: "INT/DEX" }
 * "RING"            -> { type: "RING",  spec: null }
 */
function splitBase(base) {
  const m = /^(.+?)\s*\(([^)]+)\)\s*$/.exec(base);
  if (m) return { type: m[1].trim(), spec: m[2].trim() };
  return { type: base, spec: null };
}

export const useCraftStore = defineStore('craft', {
  state: () => ({
    gameId: fromUrlOr('gameId', 'poe2'),
    game: null,
    mods: [],
    /** Selected item type (ItemClass) — e.g. "Boots", "Quiver". */
    itemType: fromUrlOr('itemType', null),
    /** Selected full base — e.g. "BOOTS (INT)". */
    base: fromUrlOr('base', null),
    /** Item level (1..100). Gates which tiers can roll. Default 74 — most
     *  players can reach this; ilvl 82+ items are far rarer. */
    itemLevel: fromUrlOr('itemLevel', 74),
    /**
     * Starting item — concrete affixes already on the item (e.g. from a drop
     * or trade-bought item). Empty slots = "not yet rolled". Each slot stores
     * the mod record (or null). The wishlist solver conditions on this state.
     */
    slots: fromUrlOr('slots', EMPTY_SLOTS()),
    /**
     * Rarity of the starting item: 'normal' / 'magic' / 'rare' / 'corrupted'.
     * Gates which orbs are applicable. Defaults to 'normal' (= a fresh white
     * base); auto-bumps to 'rare' once 3+ affixes are present.
     */
    startRarity: fromUrlOr('startRarity', 'normal'),
    /**
     * Acceptable affixes for the soft-wishlist cost estimator.
     * Keyed by `${type}:${name}` so prefixes/suffixes never collide.
     * Value: { type, name, score }. Score defaults to 1.
     */
    wishlist: fromUrlOr('wishlist', {}),
    /** Minimum |M ∩ wishlist| for an attempt to count as "satisfied".
     *  Derived from `targetSlots` when slots are used; manual override otherwise. */
    requiredHits: fromUrlOr('requiredHits', 5),
    /** Minimum total affixes on the final item (default = rare's 4). */
    minFilled: fromUrlOr('minFilled', 4),
    /** Maximum total affixes on the final item (default = PoE2's 6 cap). */
    maxFilled: fromUrlOr('maxFilled', 6),
    /**
     * Minimum desire-score the final item must achieve. Score = sum across
     * rolled affixes of the per-tier score from the matching desired entry.
     * Required entries' tier-scores ALSO contribute (since a required hit
     * is also a "desired" outcome). 0 = no soft threshold.
     */
    minDesireScore: fromUrlOr('minDesireScore', 0),
    /**
     * Flat list of target constraints. Each entry is one of:
     *   { kind:'mod', required:boolean, type, name, minTier, tierScores }
     *   { kind:'empty', type }
     *
     * - `required: true` mods MUST appear on the final item.
     * - `required: false` mods are "desired" — count toward the soft pool.
     *
     * **Implicit-required rule:** when one side (prefix or suffix) carries
     * 3 mod entries, all three become *effectively* required regardless of
     * their checkbox state — there are no slots left for "any-of" semantics
     * once a side is full.
     */
    targetEntries: fromUrlOr('targetEntries',
      // Legacy slot-shaped state migration
      (URL_INITIAL.targetSlots
        ? [
            ...(URL_INITIAL.targetSlots.prefixes || [])
              .filter(Boolean)
              .map((s) => s.kind === 'empty'
                ? { kind: 'empty', type: 'PREFIX' }
                : { kind: 'mod', required: false, type: 'PREFIX', name: s.name, minTier: s.minTier, tierScores: s.tierScores }),
            ...(URL_INITIAL.targetSlots.suffixes || [])
              .filter(Boolean)
              .map((s) => s.kind === 'empty'
                ? { kind: 'empty', type: 'SUFFIX' }
                : { kind: 'mod', required: false, type: 'SUFFIX', name: s.name, minTier: s.minTier, tierScores: s.tierScores }),
          ]
        : []).map((e) => {
          // Migrate legacy `requirement: 'required'|'desired'` → `required: bool`
          if (e.kind === 'mod' && e.required === undefined && e.requirement) {
            const { requirement, ...rest } = e;
            return { ...rest, required: requirement === 'required' };
          }
          return e;
        })),
    /**
     * User overrides for currency rates, keyed by currency id.
     * Persisted to localStorage so they survive reloads.
     * Value: exaltedPer (rate of 1 unit in Exalted Orbs).
     */
    rateOverrides: fromUrlOr('rateOverrides', loadOverrides(INITIAL_GAME)),
    /**
     * User overrides for per-orb time-per-use, in seconds. Keyed by orb id.
     * Defaults come from games/poe2/orbs.js's `timeSeconds`. Floor of 1 sec
     * (you have to at least glance at the result).
     */
    timeOverrides: fromUrlOr('timeOverrides', loadTimeOverrides(INITIAL_GAME)),
    /** Currency in which expected costs are reported (`exalted` or `divine`). */
    referenceCurrency: fromUrlOr('referenceCurrency', loadReference(INITIAL_GAME)),
    /**
     * How many prefix/suffix mods a single crafting attempt produces.
     * Defaults model an Orb of Alchemy (2 prefixes + 2 suffixes ≈ 4-mod rare).
     */
    drawSpec: { prefixDraws: 2, suffixDraws: 2 },
    /** Cost per attempt in Exalted Orbs (default: 1 Exalted = 1 ex). */
    costPerAttemptEx: fromUrlOr('costPerAttemptEx', 1),
    /**
     * Starting-item base price (Exalted). Folded into strategies that
     * produce a fresh base each attempt (alch-spam, essence-spam) per
     * attempt; folded once for strategies that reuse the starting item
     * (chaos-spam, exalt-fill).
     */
    basePriceEx: fromUrlOr('basePriceEx', 40),
    /**
     * Optional override: cost in ex of a trade-bought already-fractured
     * anchor item. When set and lower than the roll-and-fracture path,
     * fracture-anchor uses this as phase-1 cost. NaN = unset / use roll path.
     */
    fracturedAnchorPriceEx: fromUrlOr('fracturedAnchorPriceEx', NaN),
    /**
     * Total budget stop-loss: abandon the craft after spending this much.
     * Default 1870 ex (≈ 10 Divine Orbs at the seeded rate) — a reasonable
     * mid-budget for most players. NaN/Infinity = unbounded.
     */
    totalBudgetEx: fromUrlOr('totalBudgetEx', 1870),
    /**
     * Whether the MDP chain renders a step-id prefix (e.g. "[s5] ") on
     * each node label. Default true so debug discussions can refer to
     * "step s5" unambiguously; users can turn it off via the MDP panel
     * when the chart is too dense.
     */
    showMdpStepIds: fromUrlOr('showMdpStepIds', true),
    /**
     * Total time stop-loss in seconds: abandon the craft after this much
     * wall-clock time. Infinity = unbounded.
     */
    totalTimeSec: fromUrlOr('totalTimeSec', 3600),
    /**
     * Time-to-currency exchange rate used to fold wall-clock seconds into
     * the unified MDP cost: unifiedCost = costEx + timeSec × timeWeightExPerSec.
     * Default 0.1 ex/sec ⇒ "1 ex = 10 sec" — seconds spent crafting count
     * roughly the same as 0.1 ex per second. Tunable per-user; entered as
     * a single positive float. Set to 0 to ignore time entirely.
     */
    timeWeightExPerSec: fromUrlOr('timeWeightExPerSec', 0.1),
    /**
     * Per-action cost cap: actions whose single-application cost exceeds
     * this are dropped from the action set. Infinity = unbounded.
     */
    actionCostCapEx: fromUrlOr('actionCostCapEx', Infinity),
    /** Loaded omen catalog (parsed from omens.csv). */
    omens: [],
    /** Loaded mod-tag map: { base: { name: [tags] } }. Best-effort. */
    modTags: {},
    /** Per-(base, mod, tier) display strings with actual value ranges. */
    modRanges: {},
    /** Map: item display name → { description, image_url, ... } from poe2db. */
    itemDescriptions: {},
    /**
     * Live currency-rate snapshot from poe2db Economy_* tables (loaded by
     * games/poe2/index.js#loadRates). Shape:
     *   { byName, bySlug, fetchedAt, exaltedPerDivine, exaltedPerChaos }
     * Each entry carries `exaltedPer` already resolved to exalted, plus
     * 7-day trend and daily volume for context. Empty when the snapshot
     * file is missing — falls back to currency.js defaults.
     */
    rates: { byName: {}, bySlug: {}, fetchedAt: '', exaltedPerDivine: null, exaltedPerChaos: null },
    /** Loaded extra-bucket mods (desecrated, essence, corrupted) per base. */
    extraMods: {},
    /**
     * Tag filter state. Keyed by tag name. Values:
     *   'include' = only mods carrying this tag pass.
     *   'exclude' = mods carrying this tag are hidden.
     *   undefined = neutral.
     * Multiple includes are OR'd; multiple excludes are AND'd.
     */
    tagFilters: {},
    /** Show raw data columns (Tier, Weight) in the pool — hidden by default. */
    showRawData: fromUrlOr('showRawData', false),
    /**
     * Switch displayed strategy costs from Exalted to Divine when the cost
     * exceeds this many Divines. Default 3 — at 187 ex/div, costs above ~561 ex
     * read more naturally as `3.0 div` than `561 ex`.
     */
    divThresholdDiv: fromUrlOr('divThresholdDiv', 3),
    /**
     * How tier comparison operators read.
     *  'gameplay' (default): T1 is "best"; "this tier or better" reads as `≥ T3`.
     *  'math': tier numbers are pure indices; "T1, T2, or T3" reads as `≤ T3`.
     * Affects the rendered symbol in target-tier dropdowns and similar UI.
     */
    tierComparisonMode: fromUrlOr('tierComparisonMode', 'gameplay'),
    /** Loaded essence catalog. */
    essences: [],
    /** Essence price lookup: { [name]: { priceEx, source } }. */
    essencePrices: {},
    /**
     * User availability overrides for catalog items.
     * Key: `${kind}:${id}` (e.g. `omen:omen-of-homogenising-exaltation`).
     * Value: boolean (true = enable, false = disable). Persisted to localStorage.
     */
    mechanicsOverrides: fromUrlOr('mechanicsOverrides', loadMechanics(INITIAL_GAME)),
    loading: false,
    // Strategy analytics are heavy (Markov chains for chaos-spam and the
    // exalt-annul cycles). Evaluating reactively on every wishlist tweak
    // makes the UI sluggish; instead we cache the latest result and let
    // the user trigger re-evaluation explicitly via an "Evaluate" button.
    strategiesResults: null,
    strategiesEvaluating: false,
    /**
     * MDP-α result cache. Populated by `solveMdp()`; null when the user
     * hasn't run it. Same on-demand pattern as strategiesResults — the
     * solver is cheap for small wishlists but the user explicitly opts in.
     */
    mdpResult: null,
    mdpEvaluating: false,
    /**
     * User-saved craft snapshots (favorites). Each entry =
     *   { id, name, savedAt, snapshot: {<SHAREABLE_FIELDS subset>} }
     * Persisted to localStorage so they survive reloads.
     */
    savedCrafts: (() => {
      try {
        const raw = typeof window !== 'undefined' ? window.localStorage?.getItem('savedCrafts') : null;
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed : [];
      } catch { return []; }
    })(),
  }),
  getters: {
    /** All target mod-entries (wished mods on the final item). */
    targetMods(state) {
      return state.targetEntries.filter((e) => e?.kind === 'mod');
    },
    /**
     * Factory-getter: returns a function `(entry) => boolean`.
     *
     * Pinia getters are accessed as PROPERTIES (no parens). To allow callers
     * to pass an `entry` arg, the getter returns a closure. Templates and
     * other getters can then write:
     *   craft.isEntryEffectivelyRequired(entry)
     *   this.isEntryEffectivelyRequired(entry)
     * which read the property (memoised by Pinia) and invoke the closure.
     */
    isEntryEffectivelyRequired(state) {
      return (entry) => {
        if (entry?.kind !== 'mod') return false;
        if (entry.disabled) return false;
        // Required only when the user explicitly toggled it. Filling a side
        // with 3 desired entries does NOT auto-promote them — the user may
        // still want a soft target (e.g. "any 2 of these 3 is acceptable")
        // expressed via desire score, not by forcing every entry required.
        return (entry.requiredTier !== undefined && entry.requiredTier !== null)
          || entry.required === true;
      };
    },
    /**
     * Factory-getter: returns `(entry) => boolean`.
     * A desired entry is "shadowed" when its side already has 3 required
     * mod-entries — those 3 fill every slot, so a 4th (desired) entry can
     * never land on the item. Render it muted/disabled-looking.
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
     * Factory-getter: returns `(entry, eligibleTiers) => { requiredTier, desiredTier, maxTier }`.
     *
     * Resolves the per-entry tier-band thresholds. New model fields take
     * precedence; legacy `required`/`minTier` are migrated lazily on read.
     *   requiredTier: int | null  — worst tier still satisfying the mandatory check
     *   desiredTier:  int         — worst tier still earning desire-score
     *   maxTier:      int         — highest tier index in `eligibleTiers` (1-based)
     *
     * Invariant the UI must preserve: `requiredTier` is null OR ≤ `desiredTier`.
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
        // Clamp invariant: requiredTier ≤ desiredTier.
        if (requiredTier != null && requiredTier > desiredTier) requiredTier = desiredTier;
        return { requiredTier, desiredTier, maxTier };
      };
    },
    /**
     * Factory-getter: returns `(entry) => { reachable, minIlvlNeeded }`.
     * Same factory pattern as `isEntryEffectivelyRequired` — Pinia getters
     * are property accesses, so we return a closure that takes the entry.
     */
    targetEntryReachability(state) {
      return (entry) => {
        if (!entry || entry.kind !== 'mod') return { reachable: true, minIlvlNeeded: null };
        // Read all tiers for this mod from the loaded mods.json.
        const m = state.mods.find(
          (x) => x.base === state.base && x.type === entry.type && x.name === entry.name,
        );
        if (!m || !m.tiers?.length) return { reachable: true, minIlvlNeeded: null };
        // Reachability uses the *desired* band — anything beyond `desiredTier`
        // is meaningless, so it doesn't matter if it's ilvl-locked.
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
    /** List of selected wishlist entries, with their score. */
    wishlistEntries(state) {
      return Object.values(state.wishlist);
    },
    /**
     * Maximum achievable desire score: per side (prefix/suffix) we can fit at
     * most 3 affixes. So for each side we take the *top-K best per-entry
     * scores* where K is the number of free affix slots on that side
     * (3 minus explicit-empty entries). Entries whose tier-band has no
     * achievable tier contribute 0.
     */
    maxDesireScore(state) {
      // Tier-ilvl lookup so we only count tiers actually rollable at the
      // current item level — a required T3 with ilvl-locked T1/T2 is pinned
      // at T3 and should contribute 0 desire upside.
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
        // Pass 1: max score across reachable tiers within the desired band.
        let best = 0;
        for (const [t, s] of Object.entries(e.tierScores ?? {})) {
          const tn = Number(t);
          const sn = Number(s) || 0;
          if (tn <= desired && reachable.has(tn) && sn > best) best = sn;
        }
        // Pass 2: best tier number (= smallest, since T1 is best) attaining
        // that max. With score ties (e.g. all tiers default-1), this picks
        // the strictest top — required pinned there means zero upside.
        let bestTierNum = Infinity;
        for (const [t, s] of Object.entries(e.tierScores ?? {})) {
          const tn = Number(t);
          const sn = Number(s) || 0;
          if (tn <= desired && reachable.has(tn) && sn === best && tn < bestTierNum) {
            bestTierNum = tn;
          }
        }
        // Required pinned at the best *reachable* tier → no desire upside left.
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
     * What-if warnings: lists items where the active state diverges from
     * the data default, split into two categories.
     *   usedDeprecated      = items deprecated by default that the user re-enabled
     *   excludedAvailable   = items available by default that the user disabled
     */
    mechanicsWarnings(state) {
      const out = { usedDeprecated: [], excludedAvailable: [] };
      for (const o of state.omens) {
        const enabled = this.isMechanicEnabled('omen', o.id);
        if (!o.available && enabled) out.usedDeprecated.push({ kind: 'omen', name: o.name });
        if (o.available && !enabled) out.excludedAvailable.push({ kind: 'omen', name: o.name });
      }
      return out;
    },
    /**
     * Cached side-by-side analytics. Populated by the `evaluateStrategies()`
     * action (button-triggered) — NOT reactive on every wishlist edit, since
     * the underlying Markov solves are heavy. Returns whatever was last
     * stored, or null if the user hasn't evaluated yet.
     */
    strategiesAnalytics(state) {
      return state.strategiesResults;
    },
    /**
     * Pure computation behind `evaluateStrategies`. Defined as a getter so
     * it can be invoked on demand and reuse the store's helper getters
     * (fullPool, conditionalPool, startingHits, …) without re-deriving
     * them. Result is *not* cached here — call sites copy into
     * `strategiesResults`.
     */
    _computeStrategies(state) {
      // Union over the legacy flat wishlist and the slot-shaped
      // targetEntries list — either being non-empty should drive analytics.
      // Earlier code keyed off the legacy mirror only, which silently
      // returned null when the user had only edited targetEntries.
      const seen = new Set();
      const wished = [];
      for (const e of Object.values(state.wishlist)) {
        const key = `${e.type}:${e.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        wished.push(e);
      }
      for (const e of state.targetEntries) {
        if (e.kind !== 'mod') continue;
        const key = `${e.type}:${e.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        // Forward tierScores so MDP-γ can compute pTierAcceptable per
        // (orb, mod) pair. Earlier we stripped it here, leaving the
        // adapter with `tierScores: null` and a fall-back-to-1 (any
        // tier acceptable) — which silently disabled tier-aware
        // selection for any entry that lived only in targetEntries.
        wished.push({
          type: e.type, name: e.name,
          tierScores: e.tierScores,
          requiredTier: e.requiredTier,
          minTier: e.minTier,
        });
      }
      if (!state.base || !wished.length) return null;
      // Mark each entry's required-ness by cross-referencing the target
      // entries (the slot-shaped acceptable-final panel). Required entries
      // contribute to a separate "Σ required" line in the chain wishlist.
      const isReq = this.isEntryEffectivelyRequired;
      const requiredKeys = new Set(
        state.targetEntries
          .filter((e) => e.kind === 'mod' && isReq(e))
          .map((e) => `${e.type}:${e.name}`),
      );
      // Pull tierScores / requiredTier from the slot-shaped target
      // entries when the legacy `wished` entry was sourced from
      // state.wishlist (which doesn't carry tier info). The matching
      // happens by (type, name) — both panels key the same way.
      const targetByKey = new Map();
      for (const e of state.targetEntries) {
        if (e.kind === 'mod') targetByKey.set(`${e.type}:${e.name}`, e);
      }
      const wishlistInput = wished.map((w) => {
        const k = `${w.type}:${w.name}`;
        const tgt = targetByKey.get(k);
        // Prefer per-entry tierScores from the targetEntry if present,
        // else the wished entry's own tierScores (when sourced from
        // state.targetEntries directly). Either way, MDP-γ's
        // pTierAcceptable computation gets the per-tier flags it
        // needs to prune Greater/Perfect orbs that can't reach the
        // user's accepted tier band.
        const tierScores = w.tierScores ?? tgt?.tierScores ?? null;
        return {
          key: k,
          type: w.type,
          required: requiredKeys.has(k),
          tierScores,
          requiredTier: w.requiredTier ?? tgt?.requiredTier ?? null,
          minTier: w.minTier ?? tgt?.minTier ?? null,
        };
      });
      // Split startingHits into "required already on item" vs "soft already on item"
      // so the Markov chains can track the (r, w) decomposition without
      // re-deriving it. Same matching rule as `startingHits` (mod-name on side).
      let startingR = 0, startingWSoft = 0;
      for (const e of wished) {
        const onSide = e.type === 'PREFIX'
          ? this.startingByType.PREFIX : this.startingByType.SUFFIX;
        if (onSide.has(e.name)) {
          if (requiredKeys.has(`${e.type}:${e.name}`)) startingR++;
          else                                         startingWSoft++;
        }
      }
      // Apply time overrides on top of orbs.js defaults so per-orb time
      // edits flow into expected-time analytics. Greater / Perfect variants
      // (`timeBaseOrb` set) inherit from their base orb's effective time —
      // editing the base orb propagates to all its variants.
      const baseOrbs = state.game?.orbs ?? {};
      const orbs = {};
      const effectiveTime = (id) => {
        const o = baseOrbs[id];
        if (!o) return undefined;
        if (o.timeBaseOrb) return effectiveTime(o.timeBaseOrb);
        const override = state.timeOverrides[id];
        return Number.isFinite(override) ? override : o.timeSeconds;
      };
      for (const [k, o] of Object.entries(baseOrbs)) {
        orbs[k] = { ...o, timeSeconds: effectiveTime(k) };
      }
      // Fracture state plumbed through ctx so strategies can:
      //   - gate themselves out when the user requires a fracture but the
      //     starting item has none (need fracture-anchor first);
      //   - mark the item bricked if starting fracture differs from the
      //     target fracture (you can't unfracture).
      // Non-required fractured target entries are intentionally ignored
      // for now — the v2 MDP solver should decide whether to fracture
      // opportunistically; until then, treat them as a no-op.
      const requiredFractureEntry = state.targetEntries.find(
        (e) => e.kind === 'mod' && e.fractured && requiredKeys.has(`${e.type}:${e.name}`),
      );
      const requiredFracturedKey = requiredFractureEntry
        ? `${requiredFractureEntry.type}:${requiredFractureEntry.name}` : null;
      let startingFracturedKey = null;
      for (const s of state.slots.prefixes) if (s?.fractured) startingFracturedKey = `PREFIX:${s.name}`;
      for (const s of state.slots.suffixes) if (s?.fractured) startingFracturedKey = `SUFFIX:${s.name}`;

      const ctx = {
        fullPool: this.fullPool,
        conditionalPool: this.conditionalPool,
        wishlist: wishlistInput,
        requiredHits: state.requiredHits,
        minFilled: state.minFilled,
        maxFilled: state.maxFilled,
        startingHits: this.startingHits,
        startingR,
        startingWSoft,
        requiredFracturedKey,
        startingFracturedKey,
        startingCounts: this.startingCounts,
        currencies: this.effectiveCurrencies,
        omenPrices: this.omenPrices,
        // Per-base desecrated mod pool — used by the MDP-δ adapter
        // to compute pBoneRevealHit for the reveal step. Wishlist
        // entries that match a desecrated mod's text get a non-zero
        // hit probability via the "best of 3 picks" mechanic.
        extraMods: state.extraMods,
        base: state.base,
        orbs,
        isAvailable: (kind, id) => this.isMechanicEnabled(kind, id),
        essences: state.essences,
        essencePrices: state.essencePrices,
        itemClass: this.itemType,
        basePriceEx: state.basePriceEx,
        fracturedAnchorPriceEx: state.fracturedAnchorPriceEx,
        actionCostCapEx: state.actionCostCapEx,
        timeWeightExPerSec: state.timeWeightExPerSec,
        // Total budget — used by strategy comparator for "P(within
        // budget)" calcs AND by the MDP-α adapter as the trade-equiv
        // value of the desired final item, so chain nodes can render
        // itemValue = budgetEx − V*(s).
        totalBudgetEx: state.totalBudgetEx,
        showStepIds: state.showMdpStepIds,
        startingFracturedKey,
        requiredFracturedKey,
      };
      this._lastStrategyCtx = ctx;
      const results = compareStrategies(ctx);
      // Layer the stop-loss caps on top: each strategy gets P(succeed within
      // total budget) and P(succeed within total time) via truncated geometric.
      const budget = state.totalBudgetEx;
      const timeCap = state.totalTimeSec;
      for (const r of results) {
        if (!r.available) continue;
        const p = r.p ?? 0;
        const cAtt = (r.expectedAttempts && Number.isFinite(r.expectedCostEx))
          ? r.expectedCostEx / r.expectedAttempts : NaN;
        const tAtt = (r.expectedAttempts && Number.isFinite(r.expectedTimeSec))
          ? r.expectedTimeSec / r.expectedAttempts : NaN;
        let nMax = Infinity;
        if (Number.isFinite(budget) && Number.isFinite(cAtt) && cAtt > 0) {
          nMax = Math.min(nMax, Math.floor(budget / cAtt));
        }
        if (Number.isFinite(timeCap) && Number.isFinite(tAtt) && tAtt > 0) {
          nMax = Math.min(nMax, Math.floor(timeCap / tAtt));
        }
        r.permittedAttempts = Number.isFinite(nMax) ? nMax : null;
        r.pWithinCaps = (Number.isFinite(nMax) && p > 0)
          ? 1 - Math.pow(1 - p, nMax) : (p > 0 ? 1 : 0);
        r.overBudget = Number.isFinite(budget) && r.expectedCostEx > budget;
        r.overTime   = Number.isFinite(timeCap) && r.expectedTimeSec > timeCap;
      }
      return results;
    },
    /**
     * Effective currency table: defaults from the game module, overlaid with
     * user overrides. Always returns a fresh object so Vue tracks deps cleanly.
     */
    /**
     * Omen-slug → exaltedPer price map. Built from the live rates
     * snapshot. Used by the MDP-β adapter to compute omen-augmented
     * action costs (orb + omen) — e.g. Sinistral Coronation Regal
     * = regal_cost + omen-of-sinistral-coronation_cost.
     */
    omenPrices(state) {
      const out = {};
      const bySlug = state.rates?.bySlug ?? {};
      for (const [slug, entry] of Object.entries(bySlug)) {
        if (entry?.kind !== 'omen') continue;
        if (Number.isFinite(entry.exaltedPer)) out[slug] = entry.exaltedPer;
      }
      return out;
    },
    effectiveCurrencies(state) {
      const defaults = state.game?.currencies ?? {};
      const live = state.rates?.byName ?? {};
      const out = {};
      for (const [id, c] of Object.entries(defaults)) {
        const override = state.rateOverrides[id];
        const liveEntry = live[c.name];
        const liveRate = liveEntry && Number.isFinite(liveEntry.exaltedPer)
          ? liveEntry.exaltedPer : null;
        const hardcoded = Number.isFinite(c.exaltedPer) ? c.exaltedPer : NaN;
        // Resolution order: user override > live snapshot > hardcoded fallback.
        const exaltedPer = Number.isFinite(override) ? override
          : (liveRate != null ? liveRate : hardcoded);
        out[id] = {
          ...c,
          exaltedPer,
          overridden: Number.isFinite(override),
          live: liveRate != null && !Number.isFinite(override),
          trend7dPct: liveEntry?.trend7dPct ?? null,
          dailyVolume: liveEntry?.dailyVolume ?? null,
          rateFetchedAt: liveEntry?.fetchedAt ?? '',
        };
      }
      return out;
    },
    /**
     * Currencies grouped by kind (matching poe.ninja's section structure).
     * Each kind also carries a `applicable: boolean` per entry, computed from
     * the current item type and ilvl — the rates panel can hide non-applicable
     * entries when the user enables the filter.
     */
    currenciesByKind(state) {
      const groups = {};
      for (const c of Object.values(this.effectiveCurrencies)) {
        const kind = c.kind || 'other';
        if (!groups[kind]) groups[kind] = [];
        // Build the visible restriction "chips" (one per restriction type).
        // Each chip carries text + an `active` flag — active means the
        // restriction is currently violating the item's state.
        const chips = [];
        if (Number.isFinite(c.maxIlvl)) {
          const violated = Number.isFinite(state.itemLevel) && state.itemLevel > c.maxIlvl;
          chips.push({
            text: `ilvl ≤ ${c.maxIlvl}`,
            active: violated,
            fixIlvl: c.maxIlvl,    // click → lower the ilvl to N
            fixDirection: 'down',
          });
        }
        if (Number.isFinite(c.minIlvl)) {
          const violated = Number.isFinite(state.itemLevel) && state.itemLevel < c.minIlvl;
          chips.push({
            text: `ilvl ≥ ${c.minIlvl}`,
            active: violated,
            fixIlvl: c.minIlvl,    // click → raise the ilvl to N
            fixDirection: 'up',
          });
        }
        if (c.appliesToItemClasses && c.appliesToItemClasses.length) {
          const violated = state.itemType
            && !c.appliesToItemClasses.includes(state.itemType);
          const classes = c.appliesToItemClasses;
          const display = classes.length <= 2 ? classes.join(' / ')
            : classes.slice(0, 2).join(' / ') + '…';
          chips.push({ text: display, active: violated });
        }
        // Applicable iff every chip is non-violating.
        const applicable = !chips.some((ch) => ch.active);
        const reason = chips.filter((ch) => ch.active).map((ch) => ch.text).join('; ');
        // Effective time-per-use. Greater / Perfect variants delegate to
        // their base orb (e.g. Greater Exalt → exalted) — same animation
        // & click cost — so their input is read-only in the UI and the
        // value tracks the base orb's effective time.
        const orbDef = state.game?.orbs?.[c.id];
        const timeBaseOrb = orbDef?.timeBaseOrb ?? null;
        let timeSeconds, timeOverridden;
        if (timeBaseOrb) {
          const baseOverride = state.timeOverrides[timeBaseOrb];
          timeSeconds = Number.isFinite(baseOverride)
            ? baseOverride
            : state.game?.orbs?.[timeBaseOrb]?.timeSeconds;
          timeOverridden = false;
        } else {
          const tOverride = state.timeOverrides[c.id];
          timeSeconds = Number.isFinite(tOverride) ? tOverride : orbDef?.timeSeconds;
          timeOverridden = Number.isFinite(tOverride);
        }
        groups[kind].push({ ...c, applicable, reason, chips,
          timeSeconds, timeOverridden, timeBaseOrb });
      }
      // Sort each kind by *default* rate descending — expensive first.
      // Users care more about precisely calibrating the high-priced
      // orbs (10s-1000s of ex) than the trivially-cheap ones. Use the
      // hard-coded `exaltedPer` from the currency catalog (NOT the
      // override) so the order stays stable as the user edits values.
      const defaultRate = (c) => {
        const def = state.game?.currencies?.[c.id]?.exaltedPer;
        return Number.isFinite(def) ? def : 0;
      };
      for (const kind of Object.keys(groups)) {
        groups[kind].sort((a, b) => defaultRate(b) - defaultRate(a));
      }
      return groups;
    },
    /** Counts split by affix type. */
    wishlistCounts(state) {
      // Union over the legacy flat wishlist and the new target-entries
      // panel — either being non-empty should keep the strategy view
      // visible. Keys match by `${type}:${name}` so we don't double-count.
      const seen = new Set();
      let prefixes = 0, suffixes = 0;
      const add = (type) => {
        if (type === 'PREFIX') prefixes++;
        else if (type === 'SUFFIX') suffixes++;
      };
      for (const e of Object.values(state.wishlist)) {
        const key = `${e.type}:${e.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        add(e.type);
      }
      for (const e of state.targetEntries) {
        if (e.kind !== 'mod') continue;
        const key = `${e.type}:${e.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        add(e.type);
      }
      return { prefixes, suffixes, total: prefixes + suffixes };
    },
    /** Distinct item types (ItemClass), sorted. */
    itemTypes(state) {
      return [...new Set(state.mods.map((m) => m.itemClass).filter(Boolean))].sort();
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
        const baseMap = state.modTags?.[mod.base];
        return baseMap ? (baseMap[mod.name] ?? []) : [];
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
  },
  actions: {
    /**
     * Run the strategy comparison and cache the result. UI uses
     * `strategiesAnalytics` to read the cached value. Heavy synchronous
     * work — kept off the auto-reactive path so wishlist edits stay snappy.
     */
    evaluateStrategies() {
      this.strategiesEvaluating = true;
      try {
        this.strategiesResults = this._computeStrategies;
      } finally {
        this.strategiesEvaluating = false;
      }
    },
    /** Forget the last result so the UI shows the empty state again. */
    clearStrategies() {
      this.strategiesResults = null;
    },
    /**
     * Solve the MDP-α for the current craft. Reuses the same `ctx` shape
     * the per-strategy comparator builds, then maps to MDP input via
     * `ctxToMdpInput`. The solver is synchronous; we wrap in a try/finally
     * so the UI's spinner clears even if the state space blows past the
     * cap (e.g. user widened the wishlist beyond 8 entries).
     */
    solveMdp() {
      this.mdpEvaluating = true;
      this.mdpResult = null;
      try {
        // ALWAYS rebuild ctx — `_lastStrategyCtx` is a cache from a
        // previous strategy-comparator run and can be stale if the user
        // loaded a different item / changed the wishlist / toggled rates
        // since. Earlier we gated on `!this._lastStrategyCtx`, which
        // meant Re-solve after an item swap silently solved the OLD
        // problem and re-rendered the OLD chain. Touching the
        // `_computeStrategies` getter unconditionally forces a fresh
        // ctx; solveMDP itself is the expensive part anyway so the
        // strategies recomputation is in the noise.
        // eslint-disable-next-line no-unused-vars
        const _ = this._computeStrategies;
        const ctx = this._lastStrategyCtx;
        if (!ctx) return;
        const input = ctxToMdpInput(ctx);
        if (!input) return;
        this.mdpResult = solveMDP(input);
      } catch (e) {
        this.mdpResult = { error: String(e?.message ?? e) };
      } finally {
        this.mdpEvaluating = false;
      }
    },
    clearMdp() { this.mdpResult = null; },
    /**
     * Snapshot the current craft and store it under the savedCrafts list.
     * If no name is given, a default like "Bow ilvl 72" is auto-generated.
     * Persists to localStorage.
     */
    saveCurrentCraft(name) {
      const snapshot = {};
      for (const f of SHAREABLE_FIELDS) {
        if (f in this.$state) snapshot[f] = JSON.parse(JSON.stringify(this.$state[f]));
      }
      const auto = `${this.itemType ?? 'craft'}${this.base && this.base !== this.itemType ? ` (${this.base})` : ''} · ilvl ${this.itemLevel}`;
      const entry = {
        id: `c${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        name: (name && name.trim()) || auto,
        savedAt: new Date().toISOString(),
        snapshot,
      };
      this.savedCrafts = [entry, ...this.savedCrafts];
      this._persistSavedCrafts();
      return entry;
    },
    /** Restore a previously-saved snapshot by id. Wipes current cache. */
    loadSavedCraft(id) {
      const entry = this.savedCrafts.find((c) => c.id === id);
      if (!entry) return false;
      for (const [k, v] of Object.entries(entry.snapshot)) {
        // Don't overwrite gameId on restore — switching games is heavier
        // and likely surprises the user.
        if (k === 'gameId') continue;
        this[k] = JSON.parse(JSON.stringify(v));
      }
      // Reset transient analytics so the user gets a fresh "Evaluate" cycle.
      this.strategiesResults = null;
      // Re-derive the constraint counts from the restored entries.
      this._syncTargetConstraints?.();
      return true;
    },
    deleteSavedCraft(id) {
      this.savedCrafts = this.savedCrafts.filter((c) => c.id !== id);
      this._persistSavedCrafts();
    },
    /** Replace the snapshot of an existing saved entry with the current
     *  state, keeping the entry's id and name. Used by the per-row
     *  "overwrite" button. */
    overwriteSavedCraft(id) {
      const entry = this.savedCrafts.find((c) => c.id === id);
      if (!entry) return false;
      const snapshot = {};
      for (const f of SHAREABLE_FIELDS) {
        if (f in this.$state) snapshot[f] = JSON.parse(JSON.stringify(this.$state[f]));
      }
      entry.snapshot = snapshot;
      entry.savedAt = new Date().toISOString();
      this._persistSavedCrafts();
      return true;
    },
    renameSavedCraft(id, name) {
      const entry = this.savedCrafts.find((c) => c.id === id);
      if (!entry) return;
      entry.name = name;
      this._persistSavedCrafts();
    },
    _persistSavedCrafts() {
      try {
        if (typeof window !== 'undefined') {
          window.localStorage?.setItem('savedCrafts', JSON.stringify(this.savedCrafts));
        }
      } catch { /* quota / disabled storage — best-effort */ }
    },
    async selectGame(id) {
      this.loading = true;
      try {
        const mod = await games[id].load();
        const switchingGame = id !== this.gameId;
        this.gameId = id;
        this.game = mod.game;
        this.mods = mod.game.loadMods ? await mod.game.loadMods() : [];
        this.omens = mod.game.loadOmens ? await mod.game.loadOmens() : [];
        this.essences = mod.game.loadEssences ? await mod.game.loadEssences() : [];
        this.essencePrices = mod.game.loadEssencePrices
          ? await mod.game.loadEssencePrices() : {};
        this.modTags = mod.game.loadModTags ? await mod.game.loadModTags() : {};
        this.modRanges = mod.game.loadModRanges ? await mod.game.loadModRanges() : {};
        this.extraMods = mod.game.loadExtraMods ? await mod.game.loadExtraMods() : {};
        this.itemDescriptions = mod.game.loadItemDescriptions
          ? await mod.game.loadItemDescriptions() : {};
        this.rates = mod.game.loadRates
          ? await mod.game.loadRates()
          : { byName: {}, bySlug: {}, fetchedAt: '', exaltedPerDivine: null, exaltedPerChaos: null };
        // Reload game-scoped persisted settings — but only when the URL hash
        // didn't carry an explicit override for them. This means a shared
        // link's rates take precedence over local per-game settings.
        if (switchingGame) {
          if (!('rateOverrides' in URL_INITIAL))      this.rateOverrides     = loadOverrides(id);
          if (!('referenceCurrency' in URL_INITIAL))  this.referenceCurrency = loadReference(id);
          if (!('mechanicsOverrides' in URL_INITIAL)) this.mechanicsOverrides = loadMechanics(id);
          if (!('timeOverrides' in URL_INITIAL))      this.timeOverrides     = loadTimeOverrides(id);
        }
      } finally {
        this.loading = false;
      }
    },
    isMechanicEnabled(kind, id) {
      const key = `${kind}:${id}`;
      if (key in this.mechanicsOverrides) return this.mechanicsOverrides[key];
      // Defaults from data
      if (kind === 'omen') {
        const o = this.omens.find((x) => x.id === id);
        return o ? o.available !== false : true;
      }
      return true;
    },
    setMechanicEnabled(kind, id, enabled) {
      const key = `${kind}:${id}`;
      // Compare against the data default; if it matches, drop the override
      let dataDefault = true;
      if (kind === 'omen') {
        const o = this.omens.find((x) => x.id === id);
        dataDefault = o ? o.available !== false : true;
      }
      if (Boolean(enabled) === dataDefault) {
        delete this.mechanicsOverrides[key];
      } else {
        this.mechanicsOverrides[key] = Boolean(enabled);
      }
      saveMechanics(this.gameId, this.mechanicsOverrides);
    },
    resetMechanicsOverrides() {
      this.mechanicsOverrides = {};
      saveMechanics(this.gameId, this.mechanicsOverrides);
    },
    /**
     * Drop overrides that re-enable deprecated mechanics — restoring the
     * default-disabled state. Removes the "What-if mode" warning banner.
     */
    dropDeprecatedOverrides() {
      // For omens, find any whose data default is `available: false` but the
      // override has flipped them to enabled. Reset those overrides.
      for (const o of this.omens) {
        if (o.available === false) {
          const k = `omen:${o.id}`;
          if (this.mechanicsOverrides[k] === true) delete this.mechanicsOverrides[k];
        }
      }
      saveMechanics(this.gameId, this.mechanicsOverrides);
    },
    /**
     * Drop overrides that disable currently-available mechanics — restoring
     * them. Removes the "Restricted mode" warning banner.
     */
    restoreDisabledMechanics() {
      for (const o of this.omens) {
        if (o.available !== false) {
          const k = `omen:${o.id}`;
          if (this.mechanicsOverrides[k] === false) delete this.mechanicsOverrides[k];
        }
      }
      saveMechanics(this.gameId, this.mechanicsOverrides);
    },
    setItemType(type) {
      this.itemType = type || null;
      this.base = null;
      this.slots = EMPTY_SLOTS();
      this.wishlist = {};
      this.targetEntries = [];
      this._syncTargetConstraints();
      // Auto-pick the base if only one variant exists for this type.
      const bases = this.basesForType;
      if (bases.length === 1) this.base = bases[0].base;
    },
    setBase(base) {
      this.base = base || null;
      this.slots = EMPTY_SLOTS();
      this.wishlist = {};
      this.targetEntries = [];
      this._syncTargetConstraints();
    },
    isWished(type, name) {
      return Boolean(this.wishlist[wlKey(type, name)]);
    },
    getScore(type, name) {
      return this.wishlist[wlKey(type, name)]?.score ?? 1;
    },
    toggleWish(type, name) {
      const k = wlKey(type, name);
      if (this.wishlist[k]) delete this.wishlist[k];
      else this.wishlist[k] = { type, name, score: 1, tierScores: {} };
    },
    /**
     * Wish a mod with `minTier` as the minimum acceptable tier (T1 = best).
     * Sets tierScores so all tiers ≤ minTier (better-or-equal) carry the
     * base score, and all tiers > minTier carry 0. Mirrors the "+ start"
     * tier-picker flow for consistency.
     */
    wishWithMinTier(type, name, minTier, eligibleTiers) {
      const k = wlKey(type, name);
      const base = 1;
      const tierScores = {};
      for (const t of eligibleTiers ?? []) {
        tierScores[t.tier] = t.tier <= minTier ? base : 0;
      }
      this.wishlist[k] = { type, name, score: base, tierScores };
    },
    setScore(type, name, score) {
      const k = wlKey(type, name);
      const n = Number(score);
      const v = Number.isFinite(n) ? n : 1;
      if (!this.wishlist[k]) this.wishlist[k] = { type, name, score: v, tierScores: {} };
      else this.wishlist[k].score = v;
    },
    /** Returns the per-tier score for a wished mod (override or base). */
    getTierScore(type, name, tier) {
      const e = this.wishlist[wlKey(type, name)];
      if (!e) return 0;
      const override = e.tierScores ? e.tierScores[tier] : undefined;
      return Number.isFinite(override) ? override : e.score;
    },
    /** Sets a per-tier score override; pass empty / null to clear the override. */
    setTierScore(type, name, tier, score) {
      const k = wlKey(type, name);
      const e = this.wishlist[k];
      if (!e) return;
      if (!e.tierScores) e.tierScores = {};
      const n = Number(score);
      if (score === '' || score === null || !Number.isFinite(n)) {
        delete e.tierScores[tier];
      } else {
        e.tierScores[tier] = n;
      }
    },
    /** Clear BOTH the legacy flat wishlist and the slot-shaped target
     *  entries — they're really two views on the same user intent and
     *  should reset together. Keeps the strategies panel coherent. */
    clearWishlist() {
      this.wishlist = {};
      this.targetEntries = [];
      this._syncTargetConstraints();
      this.strategiesResults = null;
    },
    /**
     * Re-derive `requiredHits`, `minFilled`, `maxFilled` from `targetEntries`.
     * No-op when the entries list is empty (legacy flat-wishlist mode keeps
     * the user's manual values).
     */
    _syncTargetConstraints() {
      if (!this.targetEntries.length) return;
      const isEffReq = this.isEntryEffectivelyRequired;
      let required = 0, desired = 0, emptyP = 0, emptyS = 0;
      for (const e of this.targetEntries) {
        if (e.kind === 'mod') {
          if (e.disabled) continue; // disabled entries are excluded from analytics
          if (isEffReq(e)) required++;
          else desired++;
        } else if (e.kind === 'empty') {
          if (e.type === 'PREFIX') emptyP++;
          else if (e.type === 'SUFFIX') emptyS++;
        }
      }
      emptyP = Math.min(3, emptyP);
      emptyS = Math.min(3, emptyS);
      // v1 solver is hit-count based: threshold = effective required + all desired
      // (= total mod entries). The "all desired must hit" interpretation is the
      // strictest reading of the slot model when no extra threshold is exposed.
      const total = required + desired;
      this.requiredHits = total;
      this.minFilled = total;
      this.maxFilled = 6 - emptyP - emptyS;
    },
    /**
     * Append a wished mod to the target list. Defaults to a desired-only band
     * (`requiredTier: null, desiredTier: minTier`). Pass `required: true` to
     * pre-set the required band to `minTier`.
     */
    addTargetMod(type, name, minTier, eligibleTiers, required = false) {
      // Default per-tier scores to 1 across the board, including tiers that
      // are currently ineligible at this ilvl — a wished high tier is still
      // desired even if unreachable now. User can fine-tune any tier-score
      // afterwards.
      const tierScores = {};
      const base = 1;
      const t0 = Number(minTier);
      const allTiers = this.mods.find((m) => m.base === this.base && m.type === type && m.name === name)?.tiers ?? eligibleTiers ?? [];
      for (const t of allTiers) {
        tierScores[t.tier] = base;
      }
      this.targetEntries.push({
        kind: 'mod', type, name,
        // New canonical fields:
        requiredTier: required ? t0 : null,
        desiredTier: t0,
        tierScores,
        // Legacy fields — written for now so any unconverted reader still works.
        required, minTier: t0,
      });
      this.wishlist[wlKey(type, name)] = { type, name, score: base, tierScores };
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
      // Mirror to legacy wishlist for the analytics solver.
      const k = wlKey(entry.type, entry.name);
      if (this.wishlist[k]) this.wishlist[k] = { ...this.wishlist[k], tierScores };
    },
    /**
     * Disable / re-enable a target mod entry. Disabled entries stay in the
     * list (visible, strikethrough) but are excluded from analytics — useful
     * for parking a mod aside without losing its config.
     */
    setTargetEntryDisabled(index, disabled) {
      const entry = this.targetEntries[index];
      if (!entry || entry.kind !== 'mod') return;
      this.targetEntries[index] = { ...entry, disabled: Boolean(disabled) };
      // Mirror to legacy wishlist used by the analytics solver.
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
      // Cap explicit required at 3 per side.
      if (required) {
        const sideRequiredCount = this.targetEntries.filter(
          (e, i) => i !== index && e.kind === 'mod' && e.type === entry.type
            && (e.requiredTier != null || e.required === true),
        ).length;
        if (sideRequiredCount >= 3) return; // refuse — already at cap
      }
      // Mirror to new tier-band fields. When promoting to required, default
      // the required band to the current desiredTier (= "must roll within
      // the same band that earns score"). When demoting, drop requiredTier.
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
     * Set the per-entry tier band. `requiredTier` may be null (no required
     * band) or an integer tier. `desiredTier` is the worst-tier still earning
     * score. Enforces requiredTier ≤ desiredTier; clamps to [1, maxTier].
     * Does NOT touch tierScores — those stay user-edited; tier rows above
     * `desiredTier` are simply rendered as meaningless until the band widens.
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
      // Cap explicit required at 3 per side when promoting from null → int.
      if (rT != null && (entry.requiredTier == null && entry.required !== true)) {
        const sideRequiredCount = this.targetEntries.filter(
          (e, i) => i !== index && e.kind === 'mod' && e.type === entry.type
            && (e.requiredTier != null || e.required === true),
        ).length;
        if (sideRequiredCount >= 3) rT = null; // refuse — already at cap
      }
      this.targetEntries[index] = {
        ...entry,
        requiredTier: rT,
        desiredTier: dT,
        // Mirror to legacy fields so any unconverted reader (engine, etc.)
        // still sees consistent data.
        required: rT != null,
        minTier: dT,
      };
      this._syncTargetConstraints();
    },
    /**
     * Append an explicit-empty entry for a side. Caps at 3 per side, and
     * also rejects when (required + empty) already fills the 3 affix slots —
     * an additional empty would be unsatisfiable.
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
        // Drop the legacy wishlist mirror if no other mod entry shares this name.
        const stillUsed = this.targetEntries.some((e, i) =>
          i !== index && e.kind === 'mod' && e.type === entry.type && e.name === entry.name);
        if (!stillUsed) delete this.wishlist[wlKey(entry.type, entry.name)];
      }
      this.targetEntries.splice(index, 1);
      this._syncTargetConstraints();
    },
    /**
     * Legacy entry-point: update min-tier and bulk-reset per-tier scores.
     * Kept for callers still hitting the old API; new UI uses
     * `setTargetEntryTierBand` + `setTargetEntryTierScore`.
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
        // If the entry was already required, slide the required band to the
        // new desired floor (preserves the "required = strictest" gameplay).
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
    setRequiredHits(n) {
      const v = Math.max(0, Math.floor(Number(n) || 0));
      this.requiredHits = v;
    },
    setMinFilled(n) {
      const v = Math.max(0, Math.min(6, Math.floor(Number(n) || 0)));
      this.minFilled = v;
    },
    setMaxFilled(n) {
      const v = Math.max(0, Math.min(6, Math.floor(Number(n) || 0)));
      this.maxFilled = v;
    },
    setMinDesireScore(n) {
      const v = Number(n);
      this.minDesireScore = Number.isFinite(v) && v >= 0 ? v : 0;
    },
    /** 3-state cycle on a tag filter: neutral → include → exclude → neutral. */
    cycleTagFilter(tag) {
      const cur = this.tagFilters[tag];
      if (!cur) this.tagFilters[tag] = 'include';
      else if (cur === 'include') this.tagFilters[tag] = 'exclude';
      else delete this.tagFilters[tag];
    },
    clearTagFilters() { this.tagFilters = {}; },
    toggleRawData() { this.showRawData = !this.showRawData; },
    setTierComparisonMode(mode) {
      if (mode === 'gameplay' || mode === 'math') this.tierComparisonMode = mode;
    },
    setDivThresholdDiv(n) {
      const v = Number(n);
      this.divThresholdDiv = Number.isFinite(v) && v >= 0 ? v : 3;
    },
    /** Returns true if `name` is already on the starting item under `type`. */
    isOnStarting(type, name) {
      const arr = type === 'PREFIX' ? this.slots.prefixes : this.slots.suffixes;
      return arr.some((s) => s && s.name === name);
    },
    /**
     * The "tier or better" operator to render in UI. In gameplay mode, T1
     * is best, so `T3 or better` reads as `≥ T3`. In math mode, `T1..T3`
     * reads as `≤ T3`. Returns just the symbol so callers can interpolate.
     */
    /** NOTE: defined under `actions:` (this section) so accessed as a method.
     *  Called with parens in templates: `craft.tierOpBetter()`. */
    tierOpBetter() {
      return this.tierComparisonMode === 'math' ? '≤' : '≥';
    },
    /**
     * poe2db's URL for the current base. Action-method form; call with
     * parens: craft.poe2dbBaseUrl().
     */
    poe2dbBaseUrl() {
      if (!this.base) return null;
      const m = /^(.+?)\s*\(([^)]+)\)\s*$/.exec(this.base);
      let head, spec;
      if (m) { head = m[1]; spec = m[2].toLowerCase().replace(/\//g, ''); }
      else   { head = this.base; spec = ''; }
      head = head.trim().toLowerCase();
      // Singular → plural, mirroring poe2db's URL convention.
      const PLURAL = {
        ring: 'rings', quiver: 'quivers', amulet: 'amulets',
        belt: 'belts', wand: 'wands', staff: 'staves',
        sceptre: 'sceptres', focus: 'foci', shield: 'shields',
        helmet: 'helmets', boot: 'boots', glove: 'gloves',
      };
      head = PLURAL[head] ?? head;
      const title = head.split(/\s+/)
        .map((w) => w[0].toUpperCase() + w.slice(1))
        .join('_');
      const slug = spec ? `${title}_${spec}` : title;
      return `https://poe2db.tw/us/${slug}#ModifiersCalc`;
    },
    /**
     * Aggregated tag counts across the modifiers currently on the starting
     * item. Returned as `[tag, count][]` sorted by count desc, then alpha.
     * Useful for spotting catalyst opportunities (high-count tags).
     */
    tagsOnStarting() {
      const baseMap = this.modTags?.[this.base] ?? {};
      const counts = new Map();
      for (const s of [...this.slots.prefixes, ...this.slots.suffixes]) {
        if (!s) continue;
        for (const t of (baseMap[s.name] ?? [])) {
          counts.set(t, (counts.get(t) ?? 0) + 1);
        }
      }
      return [...counts.entries()].sort((a, b) =>
        b[1] - a[1] || a[0].localeCompare(b[0]));
    },
    /**
     * Aggregated tag counts across non-disabled mod entries in the target.
     * Same shape as `tagsOnStarting`.
     */
    tagsOnTarget() {
      const baseMap = this.modTags?.[this.base] ?? {};
      const counts = new Map();
      for (const e of this.targetEntries) {
        if (e.kind !== 'mod' || e.disabled) continue;
        for (const t of (baseMap[e.name] ?? [])) {
          counts.set(t, (counts.get(t) ?? 0) + 1);
        }
      }
      return [...counts.entries()].sort((a, b) =>
        b[1] - a[1] || a[0].localeCompare(b[0]));
    },
    /**
     * Set of distinct tags present in the current base's pool — drives the
     * filter row above the mod tables. Sorted alphabetically.
     */
    availableTags() {
      if (!this.base) return [];
      const seen = new Set();
      const baseMap = this.modTags?.[this.base] ?? {};
      for (const tags of Object.values(baseMap)) for (const t of tags) seen.add(t);
      return [...seen].sort();
    },
    /**
     * Display text for a specific (mod, tier) on the current base — returns
     * the actual value range (e.g. "+(10—19) to maximum Life") if available,
     * otherwise falls back to the canonical mod name (with "#" placeholder).
     * Defined as an action-method (this section). Use parens at call sites:
     *   craft.getModDisplay(name, tier)
     */
    getModDisplay(name, tier) {
      const t = String(tier);
      return this.modRanges?.[this.base]?.[name]?.[t] ?? name;
    },
    /**
     * Eligible tiers (with names + ilvl) for a mod on the current base+ilvl.
     * Returns [] if not found. Sorted ascending by tier number.
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
     * All tiers (eligible or not) for a mod, each with an `ilvlOk` flag.
     * Used by UI dropdowns that show everything but disable out-of-reach tiers.
     */
    getAllTiers(type, name) {
      if (!this.base) return [];
      const m = this.mods.find((x) => x.base === this.base && x.type === type && x.name === name);
      if (!m) return [];
      return m.tiers.slice().sort((a, b) => a.tier - b.tier).map((t) => ({
        ...t,
        ilvlOk: (t.ilvl ?? 0) <= this.itemLevel,
      }));
    },
    /**
     * Add a mod to the starting item at a specific tier (defaults to best).
     * Fills the first empty slot of the matching affix type.
     */
    addToStarting(mod) {
      const arr = mod.type === 'PREFIX' ? this.slots.prefixes : this.slots.suffixes;
      if (arr.some((s) => s && s.name === mod.name)) return false;
      const i = arr.findIndex((s) => s == null);
      if (i < 0) return false;
      const tier = mod.tier ?? mod.bestTier;
      const tierName = mod.tierName ?? mod.bestTierName;
      arr[i] = { ...mod, tier, tierName, bestTier: tier, bestTierName: tierName };
      return true;
    },
    /** Change the tier of an affix already on the starting item. */
    setStartingTier(type, index, tier) {
      const arr = type === 'PREFIX' ? this.slots.prefixes : this.slots.suffixes;
      const slot = arr[index];
      if (!slot) return;
      const tiers = this.getEligibleTiers(type, slot.name);
      const t = tiers.find((x) => x.tier === Number(tier));
      if (!t) return;
      arr[index] = { ...slot, tier: t.tier, tierName: t.tierName, bestTier: t.tier, bestTierName: t.tierName };
    },
    /**
     * Mark / unmark a starting-item affix as fractured. A fractured affix
     * is permanently locked and cannot be removed by Chaos, Annul, Scour,
     * etc. The policy solver must treat its slot as immutable.
     */
    setStartingFractured(type, index, fractured) {
      const arr = type === 'PREFIX' ? this.slots.prefixes : this.slots.suffixes;
      const slot = arr[index];
      if (!slot) return;
      arr[index] = { ...slot, fractured: Boolean(fractured) };
    },
    /** True iff any affix on the starting item is fractured. */
    hasFractured() {
      return this.slots.prefixes.some((s) => s?.fractured)
          || this.slots.suffixes.some((s) => s?.fractured);
    },
    /**
     * Toggle fracture on a target mod entry. At most one target mod can be
     * fractured (PoE2 game rule). Toggling a different mod when one is
     * already fractured silently fails — caller is expected to gate the UI
     * so the chip is hidden on other rows.
     */
    setTargetEntryFractured(index, fractured) {
      const entry = this.targetEntries[index];
      if (!entry || entry.kind !== 'mod') return;
      if (fractured) {
        const alreadyFractured = this.targetEntries.findIndex(
          (e, i) => i !== index && e.kind === 'mod' && e.fractured,
        );
        if (alreadyFractured >= 0) return; // refuse — only one fractured allowed
      }
      this.targetEntries[index] = { ...entry, fractured: Boolean(fractured) };
    },
    /** Index of the fractured target mod entry, or -1 if none. */
    fracturedTargetIdx() {
      return this.targetEntries.findIndex((e) => e?.kind === 'mod' && e.fractured);
    },
    removeFromStarting(type, index) {
      if (type === 'PREFIX') this.slots.prefixes[index] = null;
      else this.slots.suffixes[index] = null;
    },
    clearStarting() { this.slots = EMPTY_SLOTS(); this.startRarity = 'normal'; },
    setStartRarity(r) {
      // 'corrupted' is intentionally excluded — a corrupted item cannot be
      // mutated further, so it has no place as a *starting* state for crafting.
      if (['normal', 'magic', 'rare'].includes(r)) this.startRarity = r;
    },
    /** Set or clear an override for a currency rate. Pass NaN/null to clear. */
    setRate(currencyId, exaltedPer) {
      const v = Number(exaltedPer);
      if (!Number.isFinite(v) || v <= 0) {
        delete this.rateOverrides[currencyId];
      } else {
        this.rateOverrides[currencyId] = v;
      }
      saveOverrides(this.gameId, this.rateOverrides);
    },
    resetRates() {
      this.rateOverrides = {};
      saveOverrides(this.gameId, this.rateOverrides);
    },
    setReferenceCurrency(id) {
      this.referenceCurrency = id;
      saveReference(this.gameId, id);
    },
    /** Set or clear a per-orb time override (in seconds). */
    setTime(orbId, seconds) {
      const v = Number(seconds);
      if (!Number.isFinite(v) || v < 1) delete this.timeOverrides[orbId];
      else this.timeOverrides[orbId] = v;
      saveTimeOverrides(this.gameId, this.timeOverrides);
    },
    resetTimes() {
      this.timeOverrides = {};
      saveTimeOverrides(this.gameId, this.timeOverrides);
    },
    /** Effective time-per-use for an orb id (override > orbs.js default > 2). */
    effectiveTimeFor(orbId) {
      const override = this.timeOverrides[orbId];
      if (Number.isFinite(override)) return override;
      return this.game?.orbs?.[orbId]?.timeSeconds ?? 2;
    },
    setDrawSpec(prefixDraws, suffixDraws) {
      this.drawSpec = {
        prefixDraws: Math.max(0, Math.min(3, Math.floor(Number(prefixDraws) || 0))),
        suffixDraws: Math.max(0, Math.min(3, Math.floor(Number(suffixDraws) || 0))),
      };
    },
    setCostPerAttemptEx(v) {
      const n = Number(v);
      this.costPerAttemptEx = Number.isFinite(n) && n > 0 ? n : 1;
    },
    setBasePriceEx(v) {
      const n = Number(v);
      this.basePriceEx = Number.isFinite(n) && n >= 0 ? n : 0;
    },
    setFracturedAnchorPriceEx(v) {
      const n = Number(v);
      this.fracturedAnchorPriceEx = Number.isFinite(n) && n >= 0 ? n : NaN;
    },
    setTotalBudgetEx(v) {
      const n = Number(v);
      this.totalBudgetEx = Number.isFinite(n) && n > 0 ? n : Infinity;
    },
    setShowMdpStepIds(v) { this.showMdpStepIds = !!v; },
    /**
     * Export the current craft state as a recipe DSL string. Round-
     * trips with `applyRecipe` so users can copy-paste a recipe
     * between sessions, share it in chat / forum posts, or persist
     * it externally.
     */
    exportRecipe() {
      // Late import keeps the engine module out of the store's
      // initial dependency graph (the store mounts before the
      // engine is needed for solve/comparator runs).
      // eslint-disable-next-line no-undef
      return import('../engine/recipe-syntax.js').then(({ serializeRecipe }) =>
        serializeRecipe({
          itemType: this.itemType,
          base: this.base,
          itemLevel: this.itemLevel,
          totalBudgetEx: this.totalBudgetEx,
          minFilled: this.minFilled,
          maxFilled: this.maxFilled,
          requiredHits: this.requiredHits,
          timeWeightExPerSec: this.timeWeightExPerSec,
          targetEntries: this.targetEntries,
        }));
    },
    /**
     * Apply a parsed recipe (from `parseRecipe`) to the store.
     * Each field is applied via the existing setter so all reactive
     * downstream state (analytics ctx, MDP cache, URL hash, …) re-
     * computes naturally.
     */
    applyRecipe(parsed) {
      if (!parsed || !parsed.ok) return parsed;
      const s = parsed.state;
      // Item type / base / ilvl drive the mod pool. Apply in this
      // order so each setter sees a consistent prior state.
      if (s.itemType) this.setItemType(s.itemType);
      if (s.base) this.setBase(s.base);
      if (Number.isFinite(s.itemLevel)) this.setItemLevel(s.itemLevel);
      if (Number.isFinite(s.totalBudgetEx)) this.setTotalBudgetEx(s.totalBudgetEx);
      if (Number.isFinite(s.minFilled)) this.setMinFilled(s.minFilled);
      if (Number.isFinite(s.maxFilled)) this.setMaxFilled(s.maxFilled);
      if (Number.isFinite(s.requiredHits)) this.setRequiredHits(s.requiredHits);
      if (Number.isFinite(s.timeWeightExPerSec)) this.setTimeWeightExPerSec(s.timeWeightExPerSec);
      // Replace targetEntries wholesale. Existing UI / strategy ctx
      // re-derives wishlist from this list.
      if (Array.isArray(s.targetEntries)) {
        this.targetEntries = s.targetEntries;
      }
      // Invalidate any cached MDP / strategies result so the next
      // Solve / Evaluate uses the imported state.
      this.mdpResult = null;
      this.strategiesResults = null;
      this._lastStrategyCtx = null;
      return parsed;
    },
    setTotalTimeHours(h) {
      const n = Number(h);
      this.totalTimeSec = Number.isFinite(n) && n > 0 ? n * 3600 : Infinity;
    },
    setTimeWeightExPerSec(v) {
      const n = Number(v);
      this.timeWeightExPerSec = Number.isFinite(n) && n >= 0 ? n : 0;
    },
    setActionCostCapEx(v) {
      const n = Number(v);
      this.actionCostCapEx = Number.isFinite(n) && n > 0 ? n : Infinity;
    },
    setItemLevel(lvl) {
      this.itemLevel = Math.max(1, Math.min(100, Number(lvl) || 1));
    },
    clearSlot(kind, index) {
      this.slots[kind][index] = null;
    },
  },
});
