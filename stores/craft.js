import { defineStore } from 'pinia';
import { games } from '../games/index.js';
import { compareStrategies } from '../engine/strategies.js';
import { readURLState, writeURLState, debounce, SHAREABLE_FIELDS } from '../lib/urlState.js';
import { solveMDP } from '../engine/mdp/solve.js';
import { ctxToMdpInput } from '../engine/mdp/adapter.js';
import { modHelperActions } from './craft/mod-helpers.js';
import { savedCraftActions, loadInitialSavedCrafts } from './craft/saved-crafts.js';
import { targetGetters, targetActions } from './craft/target.js';
import { poolGetters } from './craft/pool.js';

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
    /** True iff the starting item has a pending unrevealed bone-mod
     *  (applied but not yet reveled at the Well of Souls). The
     *  unrevealed slot is its own mod kind — not a flag on a normal
     *  affix — and is always desecrated by definition. Engine maps
     *  to start.boneMod = true. */
    startingBoneMod: fromUrlOr('startingBoneMod', false),
    /** Side of the pending unrevealed bone-mod, when known. null
     *  means natural side allocation at reveal time; 'PREFIX' or
     *  'SUFFIX' tells the engine which side the bone slot occupies
     *  (e.g., observed from the in-game item). */
    startingBoneSide: fromUrlOr('startingBoneSide', null),
    /** True iff the desired/target item is allowed to end with a
     *  pending unrevealed bone-mod. Mirrors `startingBoneMod` for the
     *  goal side — useful when the user wants to plan a craft that
     *  STOPS at "bone applied, not yet revealed" (defer the Well of
     *  Souls decision). Engine relaxes the goal predicate's
     *  `boneMod && !boneRevealed ⇒ not goal` check when this is true. */
    targetBoneMod: fromUrlOr('targetBoneMod', false),
    /** Side of the goal-state pending unrevealed bone-mod, when known.
     *  Mirrors `startingBoneSide`. Used purely for UI affordance — the
     *  goal predicate currently only checks the boolean. */
    targetBoneSide: fromUrlOr('targetBoneSide', null),
    /** Per-orb enable/disable toggle — keyed by orb id. Disabled
     *  orbs are excluded from the MDP's action set (cost = Infinity)
     *  so the engine plans without them. Useful for reproducing
     *  bug reports against a simplified action set, or for
     *  "what-if I only had transmute + augment" exploration. */
    disabledOrbs: fromUrlOr('disabledOrbs', {}),
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
     * Chain merge strategy. See docs/chain-rendering.md.
     *   'none'        — no merging (one node per engine state).
     *   'per-action'  — group all states by (kind, policy).
     *   'top-down'    — partition by (kind, policy, fractured, totalMods)
     *                   then disambiguator (current default).
     *   'bottom-up'   — sibling-merge: A→B and A→C with same next ⇒ merge.
     */
    mdpMergeStrategy: fromUrlOr('mdpMergeStrategy', 'top-down'),
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
    // How many ex one second of player wall-clock time is worth.
    // Default = 50 ex / 60 sec ≈ 0.833 ex/sec — the user's stated
    // value-of-time at "I'd accept 50 ex per minute spent crafting."
    // The rates panel surfaces this as a per-MINUTE rate (× 60) so
    // the value the user reads/edits matches the natural unit.
    timeWeightExPerSec: fromUrlOr('timeWeightExPerSec', 50 / 60),
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
    /** Mod-id table loaded from data/poe2/mod_ids.json. Phase 1 of the
     *  mod-identity refactor: canonicalises wishlist + pool keys so
     *  spelling drift across sources (essence text vs base-pool name)
     *  doesn't break matching. Shape: { _meta, name_to_id }. */
    modIds: { name_to_id: {} },
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
    /** Prefix/suffix classification for desecrated mods, scraped from
     *  poe2db (scripts/update-poe2-desecrated-sides.sh). Used by the UI
     *  to resolve the side of mods that don't appear in the regular
     *  pool (i.e. desecrated-only). Shape: { fetchedAt, mods: [...] }. */
    desecratedSides: { mods: [] },
    /** Curated side overrides for essence-only / meta affixes whose
     *  side isn't derivable from the base mod registry (Mark of the
     *  Abyssal Lord, Allocates a random Notable, etc.). Keyed by
     *  essence row text. Shape: { overrides: { [text]: { side, source } } }. */
    essenceSideOverrides: { overrides: {} },
    /** Per-essence per-mod side map for multi-mod essences (Hysteria
     *  primarily). Shape: { mod_sides: { [essenceName]: { [canonicalText]: side } } }. */
    essenceModSides: { mod_sides: {} },
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
    /**
     * Currency unit for cost display: 'ex' renders every cost in
     * Exalted, 'div' renders every cost in Divine. One unit per panel
     * keeps comparisons cognitively cheap; the live exalted-per-divine
     * rate from the rates panel handles the conversion.
     */
    displayUnit: fromUrlOr('displayUnit', 'ex'),
    /**
     * Confidence level for the practical "how many attempts to succeed
     * with high probability" column (N_p). 0.95 by default — PoE2
     * players craft 1–2 items, so the geometric mean is misleading;
     * N_p answers "how many bases do I need to set aside?"
     */
    successProbTarget: fromUrlOr('successProbTarget', 0.95),
    /**
     * How tier comparison operators read.
     *  'gameplay' (default): T1 is "best"; "this tier or better" reads as `≥ T3`.
     *  'math': tier numbers are pure indices; "T1, T2, or T3" reads as `≤ T3`.
     * Affects the rendered symbol in target-tier dropdowns and similar UI.
     */
    tierComparisonMode: fromUrlOr('tierComparisonMode', 'gameplay'),
    /** Loaded essence catalog. */
    essences: [],
    /**
     * Essence price lookup is no longer a state field — it's derived
     * on the fly from `state.rates.byName` via the
     * `effectiveEssencePrices` getter. Missing entries are surfaced
     * as warnings (see solveMdp) rather than silently falling back
     * to placeholder values.
     */
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
     * Live progress from an in-flight solve. `null` when idle. Shape:
     *   { phase: 'build'|'iterate', states, iters, delta, fraction }
     * `fraction` is a heuristic 0..1 (log of delta vs convergence
     * tolerance) — not exact, but monotonic, useful for a progress bar.
     */
    mdpProgress: null,
    /**
     * Sampled trajectory scenarios — each click of "🎲 Simulate"
     * appends one. Cleared by `clearMdpScenarios`.
     */
    mdpScenarios: [],
    /** Auto-incrementing scenario id; private. */
    _scenarioCounter: 0,
    /**
     * Distribution of trajectory costs from N independent samples.
     * Populated by `simulateMdpBatch`; cleared whenever the MDP
     * solution changes. Shape:
     *   { samples: [{ totalEx, totalSec, reachedGoal, truncated, steps }],
     *     at: ISOTimestamp,
     *     n: number }
     * `null` when no batch has been run yet.
     */
    mdpDistribution: null,
    mdpDistributionEvaluating: false,
    /**
     * One-shot handoff slot for the Plan view's "→ Divine Bench"
     * button. Set by `sendScenarioToDivineBench`; the Divine Bench
     * view consumes it on mount and clears it.
     */
    pendingDivineBenchItem: null,
    /**
     * User-saved craft snapshots (favorites). Each entry =
     *   { id, name, savedAt, snapshot: {<SHAREABLE_FIELDS subset>} }
     * Persisted to localStorage so they survive reloads.
     */
    savedCrafts: loadInitialSavedCrafts(),
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
    // Target/desired-mods getters spread in from stores/craft/target.js.
    ...targetGetters,
    // Slot/pool getters spread in from stores/craft/pool.js — covers
    // startingByType / startingCounts / startingHits / conditionalPool /
    // fullPool / availablePool / basesForType.
    ...poolGetters,
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
          // Per-desired-mod desecration constraint plumbed through to
          // the adapter (which converts to desecrationRequiredMask /
          // desecrationForbiddenMask for the goal predicate).
          desecrationConstraint: w.desecrationConstraint
            ?? tgt?.desecrationConstraint ?? null,
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
      // Disabled-orbs filter: when the user has unticked an orb, set
      // its priceAmount to Infinity so the adapter's safeCost returns
      // NaN, the action's per-use cost exceeds budget, and the engine
      // excludes it from the policy. Lets users reproduce bugs
      // against a simplified action set or do "what-if I only had X
      // and Y" exploration.
      const disabled = state.disabledOrbs ?? {};
      for (const [k, o] of Object.entries(baseOrbs)) {
        const overrideTime = effectiveTime(k);
        const priceAmount = disabled[k] ? Infinity : o.priceAmount;
        orbs[k] = { ...o, priceAmount, timeSeconds: overrideTime };
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
      // Desecrated starting affix — at most one slot can be desecrated
      // per the engine's one-cap rule. Capture both the typed key (for
      // wished-mask plumbing) and the side (for the prefix-count
      // bookkeeping in the engine).
      let startingDesecratedKey = null;
      let startingDesecratedSide = null;
      for (const s of state.slots.prefixes) {
        if (s?.desecrated) { startingDesecratedKey = `PREFIX:${s.name}`; startingDesecratedSide = 'PREFIX'; }
      }
      for (const s of state.slots.suffixes) {
        if (s?.desecrated) { startingDesecratedKey = `SUFFIX:${s.name}`; startingDesecratedSide = 'SUFFIX'; }
      }

      const ctx = {
        // Mod-id name→id table; the adapter uses it to canonicalise
        // wishlist + pool keys before matching, so spelling drift
        // (e.g. essence text "+# to maximum Life" vs base-pool name
        // "# to maximum Life") doesn't break the join.
        modIds: this.modIds?.name_to_id ?? {},
        fullPool: this.fullPool,
        conditionalPool: this.conditionalPool,
        wishlist: wishlistInput,
        requiredHits: state.requiredHits,
        minFilled: state.minFilled,
        minDesireScore: state.minDesireScore,
        maxFilled: state.maxFilled,
        startingHits: this.startingHits,
        startingR,
        startingWSoft,
        requiredFracturedKey,
        startingFracturedKey,
        startingDesecratedKey,
        startingDesecratedSide,
        startingBoneMod: state.startingBoneMod,
        startingBoneSide: state.startingBoneSide,
        targetBoneMod: state.targetBoneMod,
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
        // User-set disable flags (per-orb checkbox in rates panel).
        // Adapter reads this in safeCost to return NaN for disabled
        // orbs, which in turn excludes the action from the engine's
        // policy. Setting priceAmount=Infinity above isn't sufficient
        // — safeCost reads the currency-to-exalted rate, not the
        // priceAmount, so the disable wouldn't bite without this.
        disabledOrbs: state.disabledOrbs ?? {},
        isAvailable: (kind, id) => this.isMechanicEnabled(kind, id),
        essences: state.essences,
        essencePrices: this.effectiveEssencePrices,
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
        mergeStrategy: state.mdpMergeStrategy,
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
    /**
     * Essence price lookup, sourced exclusively from the live
     * `rates.csv` snapshot. Missing essences are NOT papered over with
     * placeholder values — the engine surfaces them as warnings (see
     * the adapter's price-lookup branch) so the user knows the chosen
     * action set is incomplete and can refresh rates / list the
     * missing essence on poe2db.
     *
     * Returns: `{ [essenceName]: { priceEx, source } }`.
     */
    effectiveEssencePrices(state) {
      const out = {};
      const live = state.rates?.byName ?? {};
      for (const [name, entry] of Object.entries(live)) {
        if (entry?.kind !== 'essence') continue;
        if (!Number.isFinite(entry.exaltedPer)) continue;
        out[name] = { priceEx: entry.exaltedPer, source: 'rates.csv (live)' };
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
      // Surface live-only entries (currently: omens; rates.csv carries
      // ~30 omen rows but the static catalog tracks omens separately
      // via state.omens, so they'd otherwise be invisible in the
      // rates panel). Use the live slug as the synthetic id; skip
      // anything that already collided on name.
      const seenNames = new Set(Object.values(out).map((c) => c.name));
      // Build a name → essence-row index from the loaded essences.csv
      // so live-loaded essence entries can pick up their item-class
      // restrictions. Without this, every essence shows as
      // "applicable to current item" in the rates panel even when
      // its item_classes (from the CSV) explicitly excludes the
      // user's current base. Normalisation strips trailing 's' so
      // "Amulets" → "Amulet" matches state.itemType.
      const essenceByName = new Map();
      for (const e of (state.essences ?? [])) {
        if (e?.name) essenceByName.set(e.name, e);
      }
      const normClass = (s) => String(s || '').toLowerCase().replace(/s$/, '');
      const expandClass = (s) => s.charAt(0).toUpperCase() + s.slice(1); // "amulet" → "Amulet"
      for (const [name, e] of Object.entries(live)) {
        if (seenNames.has(name)) continue;
        const id = `live:${e.slug || name}`;
        const override = state.rateOverrides[id];
        const exaltedPer = Number.isFinite(override) ? override
          : (Number.isFinite(e.exaltedPer) ? e.exaltedPer : NaN);
        // Pick up `item_classes` for essences from the loaded CSV.
        let appliesToItemClasses;
        const essRow = essenceByName.get(name);
        if (essRow?.item_classes) {
          // CSV uses "Amulets|Belts|…"; engine + UI use "Amulet" /
          // "Belt" (singular). Normalise to singular for the
          // applicability chip's containment check.
          const csvClasses = essRow.item_classes.split('|').map((s) => s.trim()).filter(Boolean);
          appliesToItemClasses = csvClasses.map((c) => expandClass(normClass(c)));
        }
        out[id] = {
          id,
          name: e.name,
          short: e.slug || '',
          kind: e.kind || 'other',
          exaltedPer,
          overridden: Number.isFinite(override),
          live: !Number.isFinite(override),
          trend7dPct: e.trend7dPct ?? null,
          dailyVolume: e.dailyVolume ?? null,
          rateFetchedAt: e.fetchedAt ?? '',
          appliesToItemClasses,
        };
      }
      // (essence_prices.csv was removed 2026-05-10 — rates.csv is the
      // single source. Lesser / Normal essences not in the live
      // snapshot are intentionally invisible in the rates panel and
      // surface as engine warnings if the user's craft would have
      // used them.)
      // Virtual "Player time" currency. The engine stores the rate as
      // `timeWeightExPerSec` (ex per second), but the natural unit a
      // user reasons in is ex per MINUTE — "I'd take 50 ex per minute
      // of my time to grind." The rates panel surfaces the per-minute
      // rate; setRate('time:player', X) treats X as ex/min and divides
      // by 60 before writing the per-second store value. This keeps
      // the user input in a familiar unit while the engine sees the
      // canonical per-second weight everywhere downstream.
      const tw = Number.isFinite(state.timeWeightExPerSec) ? state.timeWeightExPerSec : (50 / 60);
      out['time:player'] = {
        id: 'time:player',
        name: 'Player time (per minute)',
        short: 'min',
        kind: 'meta',
        exaltedPer: tw * 60,
        overridden: false,
        live: false,
        trend7dPct: null,
        dailyVolume: null,
        rateFetchedAt: '',
        __virtual: 'time',
        __unit: 'minute',
      };
      return out;
    },
    /**
     * Currencies grouped by kind (matching the poe2db Economy_* table grouping).
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
          // `appliesToItemClasses` is stored singular ("Boot",
          // "Glove") per the CSV-normalisation comment above;
          // `state.itemType` is plural ("Boots", "Gloves"). Without
          // matching normalisation here the equality check NEVER
          // hits and every item_classes-tagged essence was marked
          // not-applicable, greying it in the rates panel even when
          // the engine adapter (which normalises both sides) would
          // happily use it.
          const norm = (s) => String(s || '').toLowerCase().replace(/s$/, '');
          const itemNorm = norm(state.itemType);
          const violated = state.itemType
            && !c.appliesToItemClasses.some((cls) => norm(cls) === itemNorm);
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
    // availablePool / basesForType moved to stores/craft/pool.js (see
    // `...poolGetters` spread above).
  },
  actions: {
    // Spread-in extracted action modules. `this` inside their bodies
    // binds to the Pinia store instance — same as if they were
    // declared inline. Order: action methods on the same name later
    // in the literal would override these, so spreads come first.
    ...modHelperActions,
    ...savedCraftActions,
    ...targetActions,
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
      // Cancel any in-flight solve — the user clicked Re-solve while
      // a previous run was still going. Bumping the token causes the
      // prior async loop's `shouldCancel` check to fire on its next
      // yield, and the current task's bookkeeping is short-circuited.
      this._mdpSolveToken = (this._mdpSolveToken ?? 0) + 1;
      const myToken = this._mdpSolveToken;
      this.mdpEvaluating = true;
      this.mdpResult = null;
      this.mdpProgress = { phase: 'starting', states: 0, iters: 0, delta: null, fraction: 0 };
      // Re-solving invalidates any cached distribution from prior MDP.
      this.mdpDistribution = null;
      // Yield once so the spinner paints before solveMDP begins
      // synchronous setup work (state-space build, etc.).
      Promise.resolve().then(() => new Promise((r) => setTimeout(r, 0))).then(async () => {
        if (this._mdpSolveToken !== myToken) return;
        try {
          // Force the strategiesResults computed property to evaluate
          // — its side-effect populates `_lastStrategyCtx`, which the
          // adapter below depends on. Without this read we'd silently
          // bail at the next `if (!ctx)` and leave mdpResult as null.
          // eslint-disable-next-line no-unused-vars
          const _ = this._computeStrategies;
          const ctx = this._lastStrategyCtx;
          if (!ctx) return;
          const input = ctxToMdpInput(ctx);
          if (!input) return;
          if (this._mdpSolveToken !== myToken) return;
          // Track the first delta we see to estimate progress fraction
          // as log(initialDelta / currentDelta) / log(initialDelta / tol).
          // The convergence tolerance is engine-internal (1e-6); use
          // that as the denominator scale.
          let initialDelta = null;
          let lastProgressAt = 0;
          const TOL = 1e-6;
          // Yield every 200 sweeps. Browsers clamp setTimeout(0) to
          // ~4ms after a few levels of nesting, so K=10 with a 50000
          // maxIters cap could spend ~20s just yielding. K=200 keeps
          // the cap-bounded yield budget under 1s while still leaving
          // the UI responsive between yields. Progress callback is
          // rate-limited to 4 Hz so reactivity churn stays modest.
          this.mdpResult = await solveMDP({
            ...input,
            yieldEvery: 200,
            shouldCancel: () => this._mdpSolveToken !== myToken,
            onProgress: (p) => {
              if (this._mdpSolveToken !== myToken) return;
              if (p.phase === 'iterate' && Number.isFinite(p.delta) && p.delta > 0) {
                if (initialDelta == null || p.delta > initialDelta) initialDelta = p.delta;
              }
              const now = Date.now();
              if (now - lastProgressAt < 250 && p.phase === 'iterate') return;
              lastProgressAt = now;
              if (p.phase === 'iterate' && Number.isFinite(p.delta) && p.delta > 0) {
                const num = Math.log10(initialDelta / Math.max(p.delta, TOL));
                const den = Math.log10(initialDelta / TOL);
                const fraction = den > 0 ? Math.max(0, Math.min(1, num / den)) : 0;
                this.mdpProgress = { ...p, fraction };
              } else {
                this.mdpProgress = { ...p, fraction: 0 };
              }
            },
          });
          if (this.mdpResult?.cancelled) {
            this.mdpResult = null;
          }
        } catch (e) {
          if (this._mdpSolveToken === myToken) {
            this.mdpResult = { error: String(e?.message ?? e) };
          }
        } finally {
          if (this._mdpSolveToken === myToken) {
            this.mdpEvaluating = false;
            this.mdpProgress = null;
          }
        }
      });
    },
    /** Cancel the in-flight MDP solve. Bumps the solve token so any
     *  microtask-deferred work checks `myToken !== _mdpSolveToken`
     *  and bails out before applying the result. The synchronous
     *  inner solveMDP() call can't be interrupted mid-iteration
     *  (no abort point inside value-iteration), but the surrounding
     *  bookkeeping is short-circuited and the spinner clears. */
    cancelMdp() {
      this._mdpSolveToken = (this._mdpSolveToken ?? 0) + 1;
      this.mdpEvaluating = false;
    },
    clearMdp() { this.mdpResult = null; },
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
        // `loadEssencePrices` was retired with `essence_prices.csv`
        // (2026-05-10). Live rates.csv is now the only source.
        this.modTags = mod.game.loadModTags ? await mod.game.loadModTags() : {};
        this.modRanges = mod.game.loadModRanges ? await mod.game.loadModRanges() : {};
        this.modIds = mod.game.loadModIds
          ? await mod.game.loadModIds()
          : { name_to_id: {} };
        this.extraMods = mod.game.loadExtraMods ? await mod.game.loadExtraMods() : {};
        this.desecratedSides = mod.game.loadDesecratedSides
          ? await mod.game.loadDesecratedSides()
          : { mods: [] };
        this.essenceSideOverrides = mod.game.loadEssenceSideOverrides
          ? await mod.game.loadEssenceSideOverrides()
          : { overrides: {} };
        this.essenceModSides = mod.game.loadEssenceModSides
          ? await mod.game.loadEssenceModSides()
          : { mod_sides: {} };
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
      if (bases.length === 1) {
        this.base = bases[0].base;
        this._refreshBaseData();
      }
    },
    setBase(base) {
      this.base = base || null;
      this.slots = EMPTY_SLOTS();
      this.wishlist = {};
      this.targetEntries = [];
      this._syncTargetConstraints();
      this._refreshBaseData();
    },
    /**
     * Refresh the active base's slice of mod data from the per-base files
     * emitted by update-poe2-data.sh / update-poe2-tags.sh
     * (data/poe2/by-base/<slug>.{mods,tags,extra,ranges}.json).
     *
     * Why: the consolidated load at game-init is a snapshot. This pulls
     * the smaller per-base bundle on demand so partial re-scrapes (e.g.
     * `scripts/update-poe2-tags.sh BOW`) reflect immediately without
     * forcing a full reload of the 1.5 MB consolidated mods.json.
     *
     * Idempotent: merges by (base, type, name) for mods.json records and
     * overwrites the per-base entry for the keyed maps. Safe to call
     * repeatedly. Best-effort — silently no-ops if loadBaseBundle isn't
     * wired (e.g. a future game module without per-base files).
     */
    async _refreshBaseData() {
      if (!this.base || !this.game?.loadBaseBundle) return;
      try {
        const bundle = await this.game.loadBaseBundle(this.base);
        if (!bundle) return;
        if (bundle.tags && Object.keys(bundle.tags).length) {
          this.modTags = { ...this.modTags, [this.base]: bundle.tags };
        }
        if (bundle.ranges && Object.keys(bundle.ranges).length) {
          this.modRanges = { ...this.modRanges, [this.base]: bundle.ranges };
        }
        if (bundle.extra && Object.keys(bundle.extra).length) {
          this.extraMods = { ...this.extraMods, [this.base]: bundle.extra };
        }
        if (Array.isArray(bundle.mods) && bundle.mods.length) {
          // Replace this base's slice in the global mods array, leaving
          // every other base untouched. Cheaper than a full re-load and
          // preserves anything the consolidated load already populated
          // (e.g. itemTypes derived from all bases).
          const others = this.mods.filter((m) => m.base !== this.base);
          this.mods = [...others, ...bundle.mods];
        }
      } catch { /* per-base file may not exist for this base — fall back to consolidated data */ }
    },
    isWished(type, name) {
      // Canonicalise so a wish added from the base-pool panel (stored
      // under the registry's canonical spelling) matches when the
      // essence panel queries with its own essence-text spelling.
      // Without this, "+# to maximum Life" (base) and "# to maximum
      // Life" (essence) would hash to different wishlist keys and the
      // ★ wished badge wouldn't surface in the essence row.
      const canon = this.canonicalModName(name);
      return Boolean(this.wishlist[wlKey(type, canon)] || this.wishlist[wlKey(type, name)]);
    },
    getScore(type, name) {
      const canon = this.canonicalModName(name);
      return (this.wishlist[wlKey(type, canon)] || this.wishlist[wlKey(type, name)])?.score ?? 1;
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
      const canon = this.canonicalModName(name);
      const k = wlKey(type, canon);
      const base = 1;
      const tierScores = {};
      for (const t of eligibleTiers ?? []) {
        tierScores[t.tier] = t.tier <= minTier ? base : 0;
      }
      this.wishlist[k] = { type, name: canon, score: base, tierScores };
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
    // Target/desired-mods action methods are spread in from
    // stores/craft/target.js (see top-level `...targetActions`).
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
    setDisplayUnit(u) {
      if (u !== 'ex' && u !== 'div') return;
      this.displayUnit = u;
      // Keep `referenceCurrency` in lockstep — same concept, two
      // legacy property names. The rates panel's "report cost in"
      // select used to be independent; we now treat the displayUnit
      // toggle as the single source of truth.
      this.referenceCurrency = u === 'div' ? 'divine' : 'exalted';
    },
    setSuccessProbTarget(p) {
      const v = Number(p);
      // Clamp to [0.5, 0.999]: below 50% the "high-probability"
      // framing breaks down; above 99.9% N_p explodes for low-p crafts.
      this.successProbTarget = Number.isFinite(v) ? Math.max(0.5, Math.min(0.999, v)) : 0.95;
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
     * Add a mod to the starting item at a specific tier (defaults to best).
     * Fills the first empty slot of the matching affix type.
     */
    addToStarting(mod) {
      const canonName = this.canonicalModName(mod.name);
      const arr = mod.type === 'PREFIX' ? this.slots.prefixes : this.slots.suffixes;
      if (arr.some((s) => s && s.name === canonName)) return false;
      const i = arr.findIndex((s) => s == null);
      if (i < 0) return false;
      const tier = mod.tier ?? mod.bestTier;
      const tierName = mod.tierName ?? mod.bestTierName;
      arr[i] = { ...mod, name: canonName, tier, tierName, bestTier: tier, bestTierName: tierName };
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
    /**
     * Mark / unmark a starting-item affix as desecrated. A desecrated
     * mod was applied via Well-of-Souls reveal; it carries the
     * desecrated provenance permanently and blocks `apply_bone` until
     * scrubbed via Annul + Omen of Light. At most one desecrated mod
     * fits on the item under the engine's current cleanup model — UI
     * gates the chip so only one can be set at a time.
     */
    setStartingDesecrated(type, index, desecrated) {
      const arr = type === 'PREFIX' ? this.slots.prefixes : this.slots.suffixes;
      const slot = arr[index];
      if (!slot) return;
      if (desecrated) {
        // Refuse a second desecrated chip — the engine's apply_bone
        // gate enforces "no desecrated mod present" (one-cap rule).
        const otherDesec = (a) => a.findIndex((s) => s && s.desecrated);
        const pIdx = otherDesec(this.slots.prefixes);
        const sIdx = otherDesec(this.slots.suffixes);
        const alreadyHas = (pIdx >= 0 && !(type === 'PREFIX' && pIdx === index))
                       || (sIdx >= 0 && !(type === 'SUFFIX' && sIdx === index));
        if (alreadyHas) return;
      }
      arr[index] = { ...slot, desecrated: Boolean(desecrated) };
    },
    /** True iff any starting-item affix is desecrated. */
    hasDesecratedStarting() {
      return this.slots.prefixes.some((s) => s?.desecrated)
          || this.slots.suffixes.some((s) => s?.desecrated);
    },
    /**
     * Toggle the starting-item's pending unrevealed bone-mod. The
     * unrevealed bone counts as a desecrated phantom slot (so it
     * blocks `apply_bone` until revealed) but does NOT consume a
     * normal prefix/suffix slot — the engine pads totalMods only
     * after reveal. Setting this requires that no other desecrated
     * mod already exists on the item (one-cap rule).
     */
    /** Toggle whether the desired/target item allows a pending
     *  unrevealed bone-mod end-state (mirror of setStartingBoneMod). */
    setTargetBoneMod(on) {
      this.targetBoneMod = Boolean(on);
      if (!on) this.targetBoneSide = null;
    },
    /** Set the side of the goal-state pending unrevealed bone-mod.
     *  Setting a non-null side implies targetBoneMod = true. */
    setTargetBoneSide(side) {
      const valid = side === 'PREFIX' || side === 'SUFFIX' || side == null;
      if (!valid) return;
      this.targetBoneSide = side;
      if (side != null && !this.targetBoneMod) this.targetBoneMod = true;
    },
    setStartingBoneMod(on) {
      if (on && this.hasDesecratedStarting()) return; // refuse — one cap
      this.startingBoneMod = Boolean(on);
      // Clear the side when the bone toggle is turned off — the field
      // is meaningless without an active bone.
      if (!on) this.startingBoneSide = null;
    },
    /** Toggle a specific orb on/off. When disabled, the engine
     *  excludes this orb from its action set. Used to reproduce
     *  bug reports against a simplified action set. */
    setOrbDisabled(orbId, disabled) {
      if (!orbId) return;
      const next = { ...this.disabledOrbs };
      if (disabled) next[orbId] = true;
      else           delete next[orbId];
      this.disabledOrbs = next;
    },
    /** Re-enable every orb (for "reset to default action set"). */
    resetOrbDisabled() { this.disabledOrbs = {}; },
    /**
     * Set the side of the pending unrevealed bone-mod.
     * Accepts null (natural allocation), 'PREFIX', or 'SUFFIX'.
     * Implies startingBoneMod = true when a non-null side is set.
     */
    setStartingBoneSide(side) {
      const valid = side === 'PREFIX' || side === 'SUFFIX' || side == null;
      if (!valid) return;
      this.startingBoneSide = side;
      // Setting a side implies the bone exists.
      if (side != null && !this.startingBoneMod && !this.hasDesecratedStarting()) {
        this.startingBoneMod = true;
      }
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
    /**
     * Cycle the desecration constraint on a target mod entry through
     * null → 'require' → 'forbid' → null. Mirrors the fracture toggle
     * but supports three states (since "must be desecrated" and "must
     * NOT be desecrated" are distinct intents). At most one target mod
     * can be desecration-required (PoE2: only one desecrated mod fits
     * on the final item under the engine's current cleanup model).
     * Wishlist + targetEntries kept in sync so the adapter sees the
     * constraint downstream.
     */
    cycleTargetEntryDesecration(index) {
      const entry = this.targetEntries[index];
      if (!entry || entry.kind !== 'mod') return;
      const current = entry.desecrationConstraint ?? null;
      const next = current === null ? 'require'
                 : current === 'require' ? 'forbid'
                 : null;
      if (next === 'require') {
        const otherRequired = this.targetEntries.findIndex(
          (e, i) => i !== index && e.kind === 'mod' && e.desecrationConstraint === 'require',
        );
        if (otherRequired >= 0) return; // refuse — only one desecration-required allowed
      }
      this.targetEntries[index] = { ...entry, desecrationConstraint: next };
      const k = `${entry.type}:${entry.name}`;
      if (this.wishlist[k]) this.wishlist[k] = { ...this.wishlist[k], desecrationConstraint: next };
    },
    /** Index of the desecration-required target mod entry, or -1 if none. */
    desecrationRequiredTargetIdx() {
      return this.targetEntries.findIndex(
        (e) => e?.kind === 'mod' && e.desecrationConstraint === 'require');
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
      // Virtual "Player time" entry: write through to the dedicated
      // setter, not into rateOverrides. Keeps timeWeightExPerSec the
      // single source of truth for engine consumers while letting the
      // rates panel act as the universal editor surface.
      if (currencyId === 'time:player') {
        // Input is ex/MINUTE (per the rates-panel display). Convert
        // to ex/sec for the engine-canonical timeWeightExPerSec.
        const v = Number(exaltedPer);
        if (Number.isFinite(v) && v > 0) this.setTimeWeightExPerSec(v / 60);
        return;
      }
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
      // Mirror onto displayUnit so the rates-panel select and the
      // Display-preferences toggle stay one canonical value.
      this.displayUnit = id === 'divine' ? 'div' : 'ex';
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
    setMdpMergeStrategy(s) {
      if (['none', 'per-action', 'top-down', 'bottom-up'].includes(s)) {
        this.mdpMergeStrategy = s;
      }
    },

    /**
     * Sample one trajectory through the optimal MDP policy and append
     * a concrete-item scenario to `mdpScenarios`. Each click of the
     * "🎲 Simulate" button calls this; scenarios stack so the user
     * can build intuition over multiple runs. `mdpScenarios[]` is
     * cleared by `clearMdpScenarios`.
     */
    async simulateMdp() {
      if (!this.mdpResult) return null;
      const [{ sampleTrajectory, buildConcreteAffixes },
             { parseModRange, rollValue }]
        = await Promise.all([
          import('../engine/mdp/sample.js'),
          import('../engine/mod-range-parser.js'),
        ]);
      const wishlist = this._lastStrategyCtx?.wishlist ?? [];
      const traj = sampleTrajectory(this.mdpResult, { wishlist });
      const affixes = buildConcreteAffixes({
        concreteItem: traj.concreteItem,
        wishlist,
        modRanges: this.modRanges ?? {},
        base: this.base,
        parseModRange, rollValue,
      });
      const scenario = {
        id: ++this._scenarioCounter,
        traj,
        affixes,
        // Stable copy of the metadata we need for the Divine Bench
        // export; doesn't depend on store state changing later.
        itemType: this.itemType,
        base: this.base,
        itemLevel: this.itemLevel,
      };
      this.mdpScenarios.push(scenario);
      return scenario;
    },
    clearMdpScenarios() { this.mdpScenarios = []; },
    /**
     * Run N trajectory samples and store the cost distribution.
     * Visualised as a histogram + CDF in the Plan view; helps the
     * user gauge variance / tail risk rather than relying on a
     * single sampled trajectory. Failure paths (truncated /
     * goal-not-reached) are kept and naturally pile up at the
     * expensive end of the histogram — the user explicitly asked
     * for that bar to be visible. Default N=1000; clamps to
     * [50, 50000] to keep the call snappy.
     */
    async simulateMdpBatch(n = 1000) {
      if (!this.mdpResult || this.mdpDistributionEvaluating) return null;
      this.mdpDistributionEvaluating = true;
      // Yield once so the loading spinner paints before we start the
      // synchronous sampling loop. Same trick as solveMdp uses for its
      // spinner — without this the user sees "click → click sticks
      // → 800ms freeze → result" instead of "click → spinner → result".
      await new Promise((r) => setTimeout(r, 0));
      try {
        const N = Math.max(50, Math.min(50000, Math.floor(n) || 1000));
        const { sampleTrajectory } = await import('../engine/mdp/sample.js');
        const wishlist = this._lastStrategyCtx?.wishlist ?? [];
        const samples = new Array(N);
        for (let i = 0; i < N; i++) {
          const t = sampleTrajectory(this.mdpResult, { wishlist });
          samples[i] = {
            totalEx: t.totalEx,
            totalSec: t.totalSec,
            reachedGoal: t.reachedGoal,
            truncated: t.truncated,
            steps: t.steps.length,
            buyBaseEvents: t.buyBaseEvents,
          };
        }
        this.mdpDistribution = {
          samples,
          n: N,
          at: new Date().toISOString(),
        };
        return this.mdpDistribution;
      } finally {
        this.mdpDistributionEvaluating = false;
      }
    },
    clearMdpDistribution() { this.mdpDistribution = null; },
    removeMdpScenario(id) {
      this.mdpScenarios = this.mdpScenarios.filter((s) => s.id !== id);
    },
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
