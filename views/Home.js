import { onMounted, computed, ref, watch } from 'vue';
import { useCraftStore } from '../stores/craft.js';
import MermaidChain from './MermaidChain.js';
import CytoscapeChain from './CytoscapeChain.js';

const fmt = {
  pct: (p) => Number.isFinite(p) ? (100 * p).toFixed(2) + '%' : '—',
  num: (n) => {
    if (!Number.isFinite(n)) return '∞';
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
    if (n >= 1_000) return (n / 1_000).toFixed(2) + 'k';
    if (n >= 100) return n.toFixed(0);
    if (n >= 10) return n.toFixed(1);
    return n.toFixed(2);
  },
};

export default {
  components: { MermaidChain, CytoscapeChain },
  setup() {
    const craft = useCraftStore();
    onMounted(() => { if (!craft.game) craft.selectGame(craft.gameId); });

    // "Browse all affixes" panel — collapse-by-default heuristic
    // applies only on initial page load: if the user landed with a
    // non-empty wishlist (URL state, saved craft), assume they're
    // here to *solve* a craft, not to add more mods. Earlier this
    // was reactively bound to wishlistCounts.total, which made the
    // panel snap shut every time the user added a wish — annoying.
    // Now the value is a one-shot snapshot taken after store
    // hydration; subsequent toggles stick to the user's choice.
    const allAffixesPanelOpen = ref(true);
    let allAffixesInitialised = false;
    watch(
      () => [craft.loading, craft.wishlistCounts?.total, craft.base],
      ([loading, total]) => {
        if (allAffixesInitialised) return;
        if (loading) return;
        allAffixesInitialised = true;
        allAffixesPanelOpen.value = !total;
      },
      { immediate: true },
    );

    const showSpecStep = computed(
      () => craft.itemType && craft.basesForType.length > 1,
    );

    /** Convert an Exalted cost into the chosen reference currency, or null. */
    const toRef = (costEx) => {
      if (!Number.isFinite(costEx)) return null;
      const ref = craft.effectiveCurrencies[craft.referenceCurrency];
      if (!ref || !Number.isFinite(ref.exaltedPer)) return null;
      return costEx / ref.exaltedPer;
    };

    const fmtTime = (sec) => {
      if (!Number.isFinite(sec)) return '∞';
      if (sec < 60) return sec.toFixed(0) + 's';
      if (sec < 3600) return (sec / 60).toFixed(1) + 'm';
      if (sec < 86400) return (sec / 3600).toFixed(1) + 'h';
      return (sec / 86400).toFixed(1) + 'd';
    };

    /**
     * Format a cost. Picks unit from `craft.displayUnit` ('ex' or
     * 'div'); the panel renders every cost in that single unit so
     * cross-panel comparisons stay cognitively cheap.
     */
    const fmtCost = (costEx) => {
      if (!Number.isFinite(costEx)) return '∞';
      const divPer = craft.effectiveCurrencies?.divine?.exaltedPer;
      const hasDiv = Number.isFinite(divPer) && divPer > 0;
      if ((craft.displayUnit ?? 'ex') === 'div' && hasDiv) {
        return `${fmt.num(costEx / divPer)} div`;
      }
      return `${fmt.num(costEx)} ex`;
    };

    /** Live "1 divine = X exalted" reading. */
    const divToEx = computed(() => {
      const div = craft.effectiveCurrencies?.divine;
      return div && Number.isFinite(div.exaltedPer) ? div.exaltedPer : null;
    });

    // Unit for the Total-budget input. Derived from `craft.displayUnit`
    // so the budget follows the same currency-pref toggle the rest of
    // the panel obeys — no separate per-input override.
    const budgetUnit = computed(() => {
      if ((craft.displayUnit ?? 'ex') === 'div' && divToEx.value) return 'div';
      return 'ex';
    });
    const budgetDisplayValue = computed(() => {
      const ex = craft.totalBudgetEx;
      if (!Number.isFinite(ex)) return '';
      if (budgetUnit.value === 'div' && divToEx.value) {
        return Number((ex / divToEx.value).toFixed(2));
      }
      return Number(ex.toFixed(2));
    });
    const setBudgetFromInput = (raw) => {
      const v = Number(raw);
      if (!Number.isFinite(v) || v < 0) {
        craft.setTotalBudgetEx(NaN);
        return;
      }
      const ex = budgetUnit.value === 'div' && divToEx.value ? v * divToEx.value : v;
      craft.setTotalBudgetEx(ex);
    };

    /**
     * Rates snapshot badge: short headline + tooltip detail. Drives both the
     * coloured pill in the rates panel header and the human-readable
     * "Snapshot: poe2db /us — fetched 3d ago" line. Reads `craft.rates`
     * (populated by loadRates() at game-init), so it's reactive without an
     * extra subscription.
     */
    const ratesSnapshotLabel = computed(() => {
      const r = craft.rates;
      if (!r || !r.fetchedAt) return 'Rates snapshot: not loaded';
      const region = r.region ? `/${r.region}` : '';
      const hours = r.ageHours;
      const days = r.ageDays;
      // Sub-48h windows benefit from hour-precision because the user
      // typically refreshes rates manually right before a heavy
      // simulation; "since 6h" tells them the snapshot is current
      // for this session, "1d ago" doesn't.
      let age;
      if (hours == null) age = '?';
      else if (hours < 1) age = 'just now';
      else if (hours < 48) age = `since ${hours} hour${hours === 1 ? '' : 's'}`;
      else if (days === 1) age = 'yesterday';
      else age = `${days}d ago`;
      const league = r.league ? ` · league ${r.league}` : '';
      return `Snapshot: poe2db${region}${league} — fetched ${age}`;
    });
    const ratesSnapshotTitle = computed(() => {
      const r = craft.rates;
      if (!r || !r.fetchedAt) return 'No rates snapshot loaded — run scripts/update-poe2-rates.sh';
      const lines = [
        `fetched_at: ${r.fetchedAt}`,
        `region: ${r.region || '(unknown)'}`,
        `league: ${r.league || '(unknown)'}`,
        `age: ${r.ageDays == null ? '?' : r.ageDays + 'd'}`,
        `staleness: ${r.staleness} (green ≤7d · orange 8–30d · red >30d)`,
      ];
      return lines.join('\n');
    });

    const prefixesFull = computed(() => craft.startingCounts.prefixes >= 3);
    const suffixesFull = computed(() => craft.startingCounts.suffixes >= 3);

    /**
     * Generic tier-picker expansion state, scoped by `kind` ('add' or 'wish')
     * × `${type}:${name}`. Same component, two callsites.
     */
    const expanded = ref({});
    const expandKey = (kind, type, name) => `${kind}:${type}:${name}`;
    const expand = (kind, type, name) => { expanded.value[expandKey(kind, type, name)] = true; };
    const collapse = (kind, type, name) => { delete expanded.value[expandKey(kind, type, name)]; };
    const isExpanded = (kind, type, name) => Boolean(expanded.value[expandKey(kind, type, name)]);
    /** Picker confirmation. `kind` decides what the chosen tier means. */
    const confirmTier = (kind, type, m, tier) => {
      const eligible = m.eligibleTiers ?? [];
      const t = eligible.find((x) => x.tier === Number(tier));
      if (kind === 'add') {
        craft.addToStarting({
          type, name: m.name,
          tier: t?.tier ?? m.bestTier,
          tierName: t?.tierName ?? m.bestTierName,
          bestTier: m.bestTier, bestTierName: m.bestTierName,
        });
      } else if (kind === 'wish') {
        // Slot-shaped target: insert into next any-prefix/any-suffix slot.
        const ok = craft.addTargetMod(type, m.name, Number(tier), eligible);
        if (!ok) {
          // Fallback to legacy flat wishlist if all target slots are full.
          craft.wishWithMinTier(type, m.name, Number(tier), eligible);
        }
      }
      collapse(kind, type, m.name);
    };

    // Per-mod-name lookup tables for the essence/desecrated chips
    // surfaced inline in the prefix/suffix tables. The user asked
    // for desecrated + essence affixes to be visible in the main
    // bench (rather than only in the bottom panels). The chips give
    // a glance-able marker on each row that's also reachable via
    // the special-pool consumables.
    const desecratedNames = computed(() => {
      const out = new Set();
      const list = craft.extraMods?.[craft.base]?.desecrated ?? [];
      for (const m of list) if (m.text) out.add(m.text);
      return out;
    });
    // The essence-able set is consumed by `essenceableNamesBySide.{PREFIX,SUFFIX}.has(name)`
    // checks throughout the UI (live item, base-pool tables, target
    // tier rows). Mod-name conventions don't always match between
    // sources: `extra_mods.json` essence rows use `+# to maximum Life`
    // (with leading `+`), while base-pool mod names land as
    // `# to maximum Life` (without). We index both forms so a chip
    // lights up regardless of which side of the `+` quirk the caller
    // hands us. Same loose-key idea used in `modSideByName`.
    // Side-keyed essence-name index. Used by the green 🟢 chip on
    // prefix/suffix pool tables: the chip should only light up when
    // an essence ON THAT SIDE can guarantee the affix. A bug where
    // the chip lit up on Helmet's PREFIX-side "Rarity of Items found"
    // (because Opulence — a SUFFIX essence — guarantees rarity)
    // was the catalyst for splitting this from the old flat set.
    // Resolution mirror of essenceableTiers + groupedEssences:
    //   override JSON → per-mod side map → CSV by name → null.
    // Rows with side=null (couldn't resolve) and side=ABYSS go into
    // both sets so the chip stays informative for unclassified rows.
    const essenceableNamesBySide = computed(() => {
      const out = { PREFIX: new Set(), SUFFIX: new Set() };
      const overrides = craft.essenceSideOverrides?.overrides || {};
      const perModSides = craft.essenceModSides?.mod_sides || {};
      const csvByName = new Map();
      for (const r of (craft.essences ?? [])) {
        if (r?.name && r.side && r.side !== 'UNKNOWN') csvByName.set(r.name, r.side);
      }
      const sideFor = (m) =>
        overrides[m.text]?.side
        || perModSides[m.tier_name]?.[m.text]
        || csvByName.get(m.tier_name)
        || null;
      const addTo = (set, name) => {
        if (!name) return;
        set.add(name);
        const loose = name.replace(/^\+/, '').replace(/\+#/g, '#').trim();
        if (loose && loose !== name) set.add(loose);
      };
      const list = craft.extraMods?.[craft.base]?.essence ?? [];
      for (const m of list) {
        if (!m.text) continue;
        const side = sideFor(m);
        if (side === 'PREFIX') addTo(out.PREFIX, m.text);
        else if (side === 'SUFFIX') addTo(out.SUFFIX, m.text);
        else { addTo(out.PREFIX, m.text); addTo(out.SUFFIX, m.text); }
      }
      return out;
    });

    // Per-(side, name) annotation: when a mod is wished AND the
    // essences targeting it can only land at tier ordinals BELOW the
    // user's `requiredTier`, the 🟢 chip is misleading on its own —
    // an essence is "available" but its outcome is automatically
    // rejected by the tier bar. Surface the mismatch so the user can
    // either lower the bar (the chip exposes a one-click action) or
    // ignore the essence path altogether.
    const essenceTierMismatch = computed(() => {
      const out = { PREFIX: new Map(), SUFFIX: new Map() };
      for (const e of (craft.targetEntries ?? [])) {
        if (e?.kind !== 'mod') continue;
        if (!Number.isFinite(e.requiredTier)) continue;
        const reachable = craft.essenceableTiers(e.type, e.name);
        if (!reachable || !reachable.size) continue;
        let bestEssT = Infinity;
        for (const t of reachable) if (t < bestEssT) bestEssT = t;
        if (Number.isFinite(bestEssT) && bestEssT > e.requiredTier) {
          out[e.type]?.set(e.name, { bestEssT, requiredT: e.requiredTier });
        }
      }
      return out;
    });

    // One-click affordance on the mismatch chip: relax requiredTier
    // (and desiredTier, since required ≤ desired) to the best tier
    // an essence can land. Mirrors the ilvl chip pattern (clickable
    // restriction → applies the relaxation).
    const lowerRequiredTierForEssence = (side, name) => {
      const info = essenceTierMismatch.value[side]?.get(name);
      if (!info) return;
      const idx = craft.targetEntries.findIndex(
        (e) => e?.kind === 'mod' && e.type === side && e.name === name,
      );
      if (idx < 0) return;
      const allTiers = craft.getAllTiers(side, name) || [];
      const maxTier = allTiers.length || 8;
      const cur = craft.targetEntries[idx];
      const desired = Math.max(info.bestEssT, Number(cur.desiredTier) || info.bestEssT);
      craft.setTargetEntryTierBand(idx, info.bestEssT, desired, maxTier);
    };

    // Group essence rows so that the same affix doesn't appear three
    // times (once per Lesser / normal / Greater tier). Each group keys
    // on (family, text) — family being the essence family with the
    // tier prefix stripped (e.g. "Essence of the Body"). Within a
    // group we record the display ranges per tier so the panel can
    // show them as columns, mirroring how affix tiers are presented
    // elsewhere. Identical rows from upstream data are deduped.
    const ESSENCE_TIERS = ['lesser', 'normal', 'greater'];
    const ESSENCE_TIER_LABELS = { lesser: 'Lesser', normal: 'Normal', greater: 'Greater' };
    const essenceTierOf = (tierName) => {
      if (!tierName) return 'normal';
      if (/^Lesser\s+/i.test(tierName)) return 'lesser';
      if (/^Greater\s+/i.test(tierName)) return 'greater';
      return 'normal';
    };
    const essenceFamilyOf = (tierName) =>
      (tierName || '').replace(/^(Lesser|Greater)\s+/i, '').trim();
    // External-link builders. poe2db uses underscores, fextralife wiki
    // uses '+' as the space separator. We don't validate that the page
    // exists — broken links open as a 404, which is fine for a "jump
    // out and double-check" affordance.
    const poedbItemUrl = (name) =>
      name ? `https://poe2db.tw/us/${encodeURI(name.trim().replace(/\s+/g, '_'))}` : null;
    const poedbEconomyUrl = (slug) =>
      slug ? `https://poe2db.tw/Economy_${encodeURI(slug)}` : null;
    const wikiUrl = (name) =>
      name ? `https://pathofexile2.wiki.fextralife.com/${encodeURI(name.trim().replace(/\s+/g, '+'))}` : null;

    // Map mod display name -> 'PREFIX' | 'SUFFIX'.
    // Source: the full `craft.mods` registry (every base/ilvl), not
    // just the currently visible pool — otherwise essence rows whose
    // mod is gated above the current ilvl resolve to side 'unknown'
    // and lose their +start / +wish controls. The registry carries
    // `type` per (base, name) tuple, which is what we need.
    //
    // We index three keys per mod: the exact `name`, a "loose" key
    // (drop a leading `+` and any `+#` -> `#` quirks), and a fully
    // canonical key (digits collapsed + lowercase) — so essence rows
    // like `+# to maximum Life` resolve against base mods named
    // `# to maximum Life`. The lookup tries exact → loose → canonical.
    const looseKey = (s) => (s || '').replace(/^\+/, '').replace(/\+#/g, '#').trim();
    const canonicaliseModText = (s) =>
      (s || '')
        .toLowerCase()
        .replace(/\d+(\.\d+)?/g, '#')
        .replace(/\s+/g, ' ')
        .trim();
    // Significant tokens for fuzzy join: lowercase words ≥4 chars,
    // skipping fillers ("with", "more", "from", etc.). Used to side-
    // match essences whose text doesn't appear verbatim in the base
    // mod registry (e.g. "+# to Strength, Dexterity or Intelligence"
    // joins to base mod "# to Strength" / "# to Dexterity" — all
    // attribute mods are SUFFIX, so any of those matches resolves
    // the essence as SUFFIX).
    const STOPWORDS = new Set([
      'with','from','more','have','your','this','that','than','then','also',
      'when','will','take','give','gain','some','very','into','onto','upon','only',
    ]);
    const significantTokens = (s) => {
      const out = new Set();
      for (const tok of (s || '').toLowerCase().match(/[a-z]+/g) || []) {
        if (tok.length >= 4 && !STOPWORDS.has(tok)) out.add(tok);
      }
      return out;
    };
    const modSideByName = computed(() => {
      const exact = new Map();
      const loose = new Map();
      const canon = new Map();
      // Per-side index of token sets, for the fuzzy fallback.
      const byTokens = []; // [{ tokens: Set, type: 'PREFIX'|'SUFFIX' }]
      const allMods = craft.mods ?? [];
      const base = craft.base;
      const record = (name, type) => {
        if (!name || !type) return;
        if (!exact.has(name)) exact.set(name, type);
        const lk = looseKey(name);
        if (lk && !loose.has(lk)) loose.set(lk, type);
        const ck = canonicaliseModText(name);
        if (ck && !canon.has(ck)) canon.set(ck, type);
      };
      const seenForTokens = new Set();
      for (const m of allMods) {
        if (m.base === base) record(m.name, m.type);
        if (!seenForTokens.has(m.name)) {
          seenForTokens.add(m.name);
          byTokens.push({ tokens: significantTokens(m.name), type: m.type });
        }
      }
      for (const m of allMods) record(m.name, m.type);
      // Token-overlap fuzzy match: for an unresolved name, pick the
      // registry entries with the largest shared-significant-token set
      // and resolve only if their side is *unanimous* — otherwise
      // returns null. Threshold = 1 shared token, because some essence
      // texts are disjunctions of single-token attributes (e.g.
      // "+# to Strength, Dexterity or Intelligence" hits three single-
      // token base mods, all SUFFIX, via 1-token overlap each). The
      // unanimity guard is what prevents 1-token noise like "increased"
      // from picking a side at random.
      const fuzzy = (name) => {
        const want = significantTokens(name);
        if (!want.size) return null;
        let bestScore = 0;
        const winners = [];
        for (const entry of byTokens) {
          let score = 0;
          for (const t of entry.tokens) if (want.has(t)) score++;
          if (score < 1 || score < bestScore) continue;
          if (score > bestScore) { bestScore = score; winners.length = 0; }
          winners.push(entry.type);
        }
        if (!winners.length) return null;
        const allSame = winners.every((t) => t === winners[0]);
        return allSame ? winners[0] : null;
      };
      const lookup = (name) =>
        exact.get(name)
        || loose.get(looseKey(name))
        || canon.get(canonicaliseModText(name))
        || fuzzy(name)
        || null;
      // Return a Map-shape object so existing call sites (`.get(name)`)
      // keep working; under the hood the lookup is the multi-key one.
      return { get: lookup };
    });

    // Essence-detail modal (replaces the inline tier-grid expansion).
    // Shape: { family, text, tags, tiers: { lesser, normal, greater } }.
    const selectedEssence = ref(null);
    const openEssenceModal = (row) => { selectedEssence.value = row; };
    const closeEssenceModal = () => { selectedEssence.value = null; };

    // Desecrated-detail modal: same UX as the essence/base-mod modal.
    // Shape: { tierName, text, display, tags, side }.
    const selectedDesecrated = ref(null);
    const openDesecratedModal = (row) => { selectedDesecrated.value = row; };
    const closeDesecratedModal = () => { selectedDesecrated.value = null; };
    if (typeof window !== 'undefined') {
      window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          selectedEssence.value = null;
          selectedDesecrated.value = null;
        }
      });
    }

    // Side overrides for essence-only / meta affixes — sourced from
    // data/poe2/essence_side_overrides.json (loaded into the store as
    // craft.essenceSideOverrides). Computed map keyed by essence row
    // text → 'PREFIX' | 'SUFFIX' | 'ABYSS'. Add entries to the JSON
    // file when poe2db's essence page calls something a prefix or
    // suffix that no base mod corroborates.
    const essenceSideOverrides = computed(() => {
      const out = {};
      const raw = craft.essenceSideOverrides?.overrides ?? {};
      for (const [text, info] of Object.entries(raw)) {
        if (info?.side) out[text] = info.side;
      }
      return out;
    });

    // CSV-driven side index: keyed by full essence name (matches
    // m.tier_name in extra_mods.json). Source: data/poe2/essences.csv,
    // which is now resolved authoritatively from poe2db's own Pre/Suf
    // table by scripts/update-poe2-essences.sh. Trumps the base-mod
    // registry because it covers essence-only affixes (no base-pool
    // peer to match against, e.g. "(20—30)% increased Global Defences").
    const essenceSidesByName = computed(() => {
      const map = new Map();
      for (const r of (craft.essences ?? [])) {
        if (r?.name && r.side && r.side !== 'UNKNOWN') {
          map.set(r.name, r.side);
        }
      }
      return map;
    });
    // Per-essence per-mod side index: handles multi-mod essences
    // (Hysteria) where the unanimous-side rule in essences.csv falls
    // through to UNKNOWN. Source: data/poe2/essence_mod_sides.json,
    // auto-generated from poe2db's per-class Pre/Suf rows. Lookup is
    // (essenceName, canonicalText) → side.
    const essenceModSides = computed(() => {
      const ms = craft.essenceModSides?.mod_sides || {};
      // Wrap in a Map for O(1) per-essence lookup; values stay plain objects.
      const out = new Map();
      for (const [name, perMod] of Object.entries(ms)) {
        out.set(name, perMod);
      }
      return out;
    });

    const groupedEssences = computed(() => {
      const list = craft.extraMods?.[craft.base]?.essence ?? [];
      const map = new Map();
      for (const m of list) {
        const family = essenceFamilyOf(m.tier_name);
        const tier = essenceTierOf(m.tier_name);
        const key = family + ' ' + (m.text || '');
        let row = map.get(key);
        if (!row) {
          row = { key, family, text: m.text, tags: m.tags || [], tiers: {}, _tierNames: [] };
          map.set(key, row);
        }
        if (m.tier_name && !row._tierNames.includes(m.tier_name)) {
          row._tierNames.push(m.tier_name);
        }
        row.tiers[tier] = m.display || m.text;
      }
      const sides = modSideByName.value;
      const csvSides = essenceSidesByName.value;
      const perModSides = essenceModSides.value;
      const sideFromPerMod = (r) => {
        // For multi-mod essences (Hysteria), the per-mod map is the
        // most specific source — it knows that "+# to Stun Threshold"
        // is SUFFIX while "#% increased Movement Speed" is PREFIX
        // even though both are emitted by the same essence.
        for (const tn of (r._tierNames || [])) {
          const perMod = perModSides.get(tn);
          if (perMod && perMod[r.text]) return perMod[r.text];
        }
        return null;
      };
      const sideFromCSV = (r) => {
        for (const tn of (r._tierNames || [])) {
          const s = csvSides.get(tn);
          if (s) return s;
        }
        return null;
      };
      const rows = Array.from(map.values()).map((r) => ({
        ...r,
        // Resolution order: manual override JSON → per-mod side map
        // (multi-mod essences) → essences.csv (single-side essences) →
        // base-mod registry → 'unknown'.
        side: essenceSideOverrides.value[r.text]
          || sideFromPerMod(r)
          || sideFromCSV(r)
          || sides.get(r.text)
          || 'unknown',
      }));
      return rows.sort((a, b) => {
        if (a.family !== b.family) return a.family.localeCompare(b.family);
        return (a.text || '').localeCompare(b.text || '');
      });
    });

    // Side index for desecrated mods, keyed two ways:
    //   1) exact text  -> side  (preferred match)
    //   2) canonical text -> side  (lowercase + literal digits collapsed
    //      to '#'; this absorbs upstream wording differences such as
    //      "expend at least 10 Combo" vs "expend at least # Combo")
    const desecratedSidesIndex = computed(() => {
      const exact = new Map();
      const canon = new Map();
      const rows = craft.desecratedSides?.mods ?? [];
      for (const r of rows) {
        if (!r?.text || !r?.side) continue;
        exact.set(r.text, r.side);
        canon.set(canonicaliseModText(r.text), r.side);
      }
      return { exact, canon };
    });

    // Desecrated rows: dedup by (tier_name, text); side resolution order:
    //   poe2db scrape (exact) → poe2db scrape (canonical) → mod registry
    //   → 'unknown'.
    const groupedDesecrated = computed(() => {
      const list = craft.extraMods?.[craft.base]?.desecrated ?? [];
      const poolSides = modSideByName.value;
      const { exact: scrapeExact, canon: scrapeCanon } = desecratedSidesIndex.value;
      const seen = new Map();
      for (const m of list) {
        const key = (m.tier_name || '') + ' ' + (m.text || '');
        if (seen.has(key)) continue;
        const text = m.text || '';
        const side = scrapeExact.get(text)
          || scrapeCanon.get(canonicaliseModText(text))
          || poolSides.get(text)
          || 'unknown';
        seen.set(key, {
          key,
          tierName: m.tier_name || '',
          text,
          display: m.display || text,
          tags: m.tags || [],
          side,
        });
      }
      return Array.from(seen.values()).sort((a, b) => {
        if (a.tierName !== b.tierName) return a.tierName.localeCompare(b.tierName);
        return a.text.localeCompare(b.text);
      });
    });

    // Desecrated-only filter tags: tags ending in `_mod`
    // (amanamu_mod, kurgal_mod, ulaman_mod, kulemak_mod, ...).
    // Reuses craft.tagFilters so include / exclude / clear cycles
    // behave identically to the base-pool filter row.
    const desecratedFamilyTags = computed(() => {
      const set = new Set();
      const list = craft.extraMods?.[craft.base]?.desecrated ?? [];
      for (const m of list) {
        for (const t of (m.tags || [])) {
          if (t.endsWith('_mod')) set.add(t);
        }
      }
      return Array.from(set).sort();
    });

    const matchesTagFilters = (rowTags) => {
      const filters = craft.tagFilters || {};
      const includes = [], excludes = [];
      for (const [t, mode] of Object.entries(filters)) {
        if (mode === 'include') includes.push(t);
        else if (mode === 'exclude') excludes.push(t);
      }
      const tagSet = new Set(rowTags);
      for (const t of includes) if (!tagSet.has(t)) return false;
      for (const t of excludes) if (tagSet.has(t)) return false;
      return true;
    };
    // Tag filters now annotate rather than hide — matches the base
    // prefix/suffix tables, where tag-filtered rows stay visible but
    // greyed and have +start / +wish disabled. Hiding rows here was a
    // UX inconsistency: in the base panel a filter "narrows your
    // attention," in the special-mod panels it "removes options," and
    // the user reasonably expects the same gesture to mean the same
    // thing across the page.
    const annotateTagFilter = (rows) =>
      rows.map((r) => ({ ...r, tagFiltered: !matchesTagFilters(r.tags) }));
    const filteredDesecrated = computed(
      () => annotateTagFilter(groupedDesecrated.value),
    );
    const filteredEssences = computed(
      () => annotateTagFilter(groupedEssences.value),
    );
    // Prefix/Suffix splits for the two-column layouts. Rows with side
    // 'unknown' fall into a separate bucket the UI can render below
    // the columns (instead of silently hiding them).
    const splitBySide = (rows) => {
      const out = { PREFIX: [], SUFFIX: [], ABYSS: [], unknown: [] };
      for (const r of rows) {
        if (r.side === 'PREFIX') out.PREFIX.push(r);
        else if (r.side === 'SUFFIX') out.SUFFIX.push(r);
        else if (r.side === 'ABYSS') out.ABYSS.push(r);
        else out.unknown.push(r);
      }
      return out;
    };
    const desecratedBySide = computed(() => splitBySide(filteredDesecrated.value));
    const essencesBySide   = computed(() => splitBySide(filteredEssences.value));

    // ─────────────────────────────────────────────────────────
    // Pending-bone-mod helpers (rendered inline as a green-glow
    // "encrypted-glyph" affix slot, matching the in-game tooltip).
    // ─────────────────────────────────────────────────────────
    const BONE_GIBBERISH = '⡳⣟⢾⠿⢿⣽⣟⠾⡶';
    const startingFreeSlotsBySide = computed(() => ({
      PREFIX: craft.slots.prefixes.filter((s) => !s).length,
      SUFFIX: craft.slots.suffixes.filter((s) => !s).length,
    }));
    const canAddStartingBone = (side) => {
      if (craft.startingBoneMod) return false;
      if (craft.hasDesecratedStarting()) return false;
      return startingFreeSlotsBySide.value[side] > 0;
    };
    const canSwapStartingBone = computed(() => {
      if (!craft.startingBoneMod || !craft.startingBoneSide) return false;
      const other = craft.startingBoneSide === 'PREFIX' ? 'SUFFIX' : 'PREFIX';
      return startingFreeSlotsBySide.value[other] > 0;
    });
    const targetFreeSlotsBySide = computed(() => ({
      PREFIX: Math.max(0, 3 - (craft.targetSummary?.prefixes?.required ?? 0)
                            - (craft.targetSummary?.prefixes?.empty ?? 0)),
      SUFFIX: Math.max(0, 3 - (craft.targetSummary?.suffixes?.required ?? 0)
                            - (craft.targetSummary?.suffixes?.empty ?? 0)),
    }));
    const canAddTargetBone = (side) => {
      if (craft.targetBoneMod) return false;
      return targetFreeSlotsBySide.value[side] > 0;
    };
    const canSwapTargetBone = computed(() => {
      if (!craft.targetBoneMod || !craft.targetBoneSide) return false;
      const other = craft.targetBoneSide === 'PREFIX' ? 'SUFFIX' : 'PREFIX';
      return targetFreeSlotsBySide.value[other] > 0;
    });

    /** Currently-open modifier modal — null when no modal is shown. */
    const selectedMod = ref(null);
    const openModModal = (m) => { selectedMod.value = m; };
    const closeModModal = () => { selectedMod.value = null; };
    // Escape key to close.
    if (typeof window !== 'undefined') {
      window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') selectedMod.value = null;
      });
    }

    // Deterministic tag → color. djb2-ish hash → HSL hue; saturation/lightness
    // fixed for readability on the dark background. Same string ⇒ same color
    // across the app, so users can spot a tag visually before reading it.
    const tagStyle = (tag) => {
      let h = 5381;
      for (let i = 0; i < tag.length; i++) h = ((h << 5) + h + tag.charCodeAt(i)) | 0;
      const hue = ((h % 360) + 360) % 360;
      return {
        backgroundColor: `hsl(${hue} 55% 28%)`,
        borderColor:     `hsl(${hue} 65% 45%)`,
        color:           `hsl(${hue} 70% 85%)`,
      };
    };

    /**
     * Per-strategy explanation of what one "attempt" represents. The unit
     * differs between closed-form geometric strategies (whole reset+roll
     * cycles) and Markov-rich strategies (single orb applications), so the
     * `(N att.)` count needs disambiguation in the table.
     */
    const attemptMeaning = (id) => {
      switch (id) {
        case 'alchemy-spam':
          return '1 attempt = reset to a Normal/Magic base + apply 1 Orb of Alchemy (produces a 4-mod Rare from scratch).';
        case 'essence-spam':
          return '1 attempt = reset to a Normal/Magic base + apply 1 essence (produces a 4-mod Rare with one anchor mod guaranteed).';
        case 'exalt-fill':
          return '1 attempt = reset + apply N Exalted Orbs to fill every open slot (N = open slots; e.g. 6 for a fresh Normal base).';
        case 'coupled-exalt-fill':
          return '1 attempt = reset + (openP × Sinistral) + (openS × Dextral) Exalted+Omen pairs, deterministically allocating each new affix per side.';
        case 'sinistral-exalt-fill':
          return '1 attempt = (open prefix slots) × (Exalted + Omen of Sinistral Exaltation). Off-side suffixes are preserved across attempts.';
        case 'dextral-exalt-fill':
          return '1 attempt = (open suffix slots) × (Exalted + Omen of Dextral Exaltation). Off-side prefixes are preserved across attempts.';
        case 'fracture-anchor':
          return '1 attempt = one phase-2 retry cycle (≈ 6 annuls + 5 exalts on the fractured-anchor item). Phase 1 (rolling/buying the fractured anchor) is a one-off, not counted as attempts.';
        case 'chaos-spam':
          return '1 attempt = a SINGLE Chaos Orb application. The Markov chain steps one orb at a time, so this is per-orb — not per full reset cycle.';
        case 'exalt-annul-cycle':
        case 'greater-exalt-annul-cycle':
        case 'perfect-exalt-annul-cycle':
          return '1 attempt = a SINGLE orb application — an Exalt when t < maxFilled, an Annul when t = maxFilled. Markov hitting time over per-orb steps, not per full reset cycle.';
        default:
          return '1 attempt = 1 unit of this strategy\'s work (per-strategy meaning may differ).';
      }
    };

    const promptSaveCraft = () => {
      const auto = `${craft.itemType ?? 'craft'}${craft.base && craft.base !== craft.itemType ? ` (${craft.base})` : ''} · ilvl ${craft.itemLevel}`;
      const name = window.prompt('Save current craft as…', auto);
      if (name !== null) craft.saveCurrentCraft(name);
    };
    const confirmDeleteCraft = (c) => {
      if (window.confirm(`Delete "${c.name}"?`)) craft.deleteSavedCraft(c.id);
    };
    const confirmOverwriteCraft = (c) => {
      if (!craft.itemType) return;
      if (window.confirm(`Replace "${c.name}" with the current craft? The previous snapshot will be lost.`)) {
        craft.overwriteSavedCraft(c.id);
      }
    };

    // Renderer toggle for the strategy chain. Mermaid (dagre) is the
    // default; cytoscape (fcose) is an alternative for cyclic chains
    // where dagre routes long unnecessary edges. Persisted per-tab via
    // localStorage so users keep their preference between solves.
    const chainRenderer = ref(
      (typeof localStorage !== 'undefined' && localStorage.getItem('chainRenderer')) || 'mermaid',
    );
    const setChainRenderer = (v) => {
      chainRenderer.value = v;
      try { localStorage.setItem('chainRenderer', v); } catch {}
    };
    // Group orbs by family for the action-set panel. Family ≈ "what
    // does this orb do conceptually" — so quality variants
    // (Greater/Perfect) sit alongside their base and the user can
    // disable them as a unit. Falls back to "other" for anything
    // unrecognised so no orb disappears from the list.
    const orbFamilyOf = (id) => {
      if (/^transmute/.test(id)) return 'Transmute';
      if (/^augment/.test(id))   return 'Augment';
      if (/^regal/.test(id))     return 'Regal';
      if (/^alch/.test(id))      return 'Alchemy';
      if (/^chaos/.test(id))     return 'Chaos';
      if (/^exalt/.test(id))     return 'Exalt';
      if (/^annul/.test(id))     return 'Annul';
      if (/^fractur/.test(id))   return 'Fracture';
      if (/^vaal/.test(id))      return 'Vaal';
      if (/^divine/.test(id))    return 'Divine';
      if (/^chance/.test(id))    return 'Chance';
      if (/^jeweller/.test(id) || id === 'artificer') return 'Jeweller';
      return 'Other';
    };
    const orbsByFamily = computed(() => {
      const groups = new Map();
      for (const [id, o] of Object.entries(craft.game?.orbs ?? {})) {
        const f = orbFamilyOf(id);
        if (!groups.has(f)) groups.set(f, []);
        groups.get(f).push({ id, ...o });
      }
      // Stable family order: dominant orbs first, niche last.
      const order = ['Alchemy','Transmute','Augment','Regal','Exalt','Annul','Chaos','Fracture','Vaal','Divine','Chance','Jeweller','Other'];
      return order
        .filter((f) => groups.has(f))
        .map((f) => ({ family: f, orbs: groups.get(f) }));
    });
    // Per-orb icon: substring-matched on the orb id so the same emoji
    // covers Greater/Perfect variants without a per-id table.
    const orbIconForId = (id) => {
      const a = String(id ?? '');
      if (a.includes('fractur')) return '🔒';
      if (a.includes('annul')) return '❌';
      if (a.includes('exalt')) return '⭐';
      if (a.includes('chaos')) return '🟠';
      if (a.includes('regal')) return '🟣';
      if (a.includes('alch')) return '🟡';
      if (a.includes('augment')) return '🟢';
      if (a.includes('transmute')) return '🔵';
      if (a.includes('divine')) return '💎';
      if (a.includes('vaal')) return '🔴';
      if (a.includes('chance')) return '🎲';
      if (a.includes('jeweller') || a === 'artificer') return '💠';
      return '·';
    };
    // Currency rate (in exalted) for a given orb. Reads
    // effectiveCurrencies — same source the engine uses — so the chip
    // shows the live rate including user overrides.
    const orbRateEx = (orb) => {
      const c = craft.effectiveCurrencies?.[orb.priceCurrency];
      const r = c?.exaltedPer;
      return Number.isFinite(r) ? r : null;
    };
    const fmtRate = (r) => {
      if (r == null) return '—';
      if (r >= 100) return `${r.toFixed(0)} ex`;
      if (r >= 1) return `${r.toFixed(2)} ex`;
      if (r >= 0.01) return `${r.toFixed(3)} ex`;
      return `${r.toExponential(1)} ex`;
    };
    const copyChainDump = async () => {
      const chain = craft.mdpResult?.chain;
      if (!chain) return;
      const lines = [
        `# chain (${chain.states.length} states, ${chain.edges.length} edges)`,
        '',
        '## states',
      ];
      for (const s of chain.states) {
        lines.push(`### ${s.id} [kind=${s.kind} policy=${s.meta?.policy ?? '-'}]`);
        lines.push(s.label.split('\n').map((l) => '  ' + l).join('\n'));
      }
      lines.push('', '## edges');
      for (const e of chain.edges) {
        lines.push(`${e.from} → ${e.to} | ${e.label.replace(/\n/g, ' / ')} | prob=${e.prob ?? '?'} | kind=${e.kind}`);
      }
      const text = lines.join('\n');
      try { await navigator.clipboard.writeText(text); }
      catch (err) { console.log(text); }
    };

    // Recipe DSL panel state. `recipeText` mirrors the textarea;
    // `recipeStatus` shows ephemeral feedback (success / error)
    // after an Import or Export click.
    const recipeText = ref('');
    const recipeStatus = ref(null);
    const recipeExport = async () => {
      try {
        recipeText.value = await craft.exportRecipe();
        recipeStatus.value = { kind: 'ok', message: 'Exported current craft.' };
      } catch (e) {
        recipeStatus.value = { kind: 'err', message: `Export failed: ${e?.message ?? e}` };
      }
    };
    const recipeImport = async () => {
      try {
        const { parseRecipe } = await import('../engine/recipe-syntax.js');
        const parsed = parseRecipe(recipeText.value);
        if (!parsed.ok) {
          recipeStatus.value = { kind: 'err', message: `Parse errors: ${parsed.errors.join('; ')}` };
          return;
        }
        craft.applyRecipe(parsed);
        const warns = parsed.warnings?.length ? ` (${parsed.warnings.length} warning(s))` : '';
        recipeStatus.value = { kind: 'ok', message: `Imported${warns}: ${parsed.state.targetEntries?.length ?? 0} affix entries.` };
      } catch (e) {
        recipeStatus.value = { kind: 'err', message: `Import failed: ${e?.message ?? e}` };
      }
    };

    // ─────────────────────────────────────────────────────────
    // Scenario panel helpers: orb icon, per-action subtotal,
    // overall trajectory probability.
    // ─────────────────────────────────────────────────────────
    // Emoji map for action IDs in `traj.orbCounts`. Matched in order
    // (substring-based) so it covers Greater/Perfect variants and
    // omen-coupled forms (regal_sinistral etc.) without listing every
    // permutation. Falls back to a neutral bullet when nothing matches.
    const orbIconFor = (action) => {
      if (!action) return '·';
      const a = String(action);
      if (a.startsWith('essence')) return '🟢';
      if (a.startsWith('omen')) return '✨';
      if (a.includes('fractur')) return '🔒';
      if (a.includes('annul')) return '❌';
      if (a.includes('exalt')) return '⭐';
      if (a.includes('chaos')) return '🟠';
      if (a.includes('regal')) return '🟣';
      if (a.includes('alch')) return '🟡';
      if (a.includes('augment')) return '🟢';
      if (a.includes('transmute')) return '🔵';
      if (a.includes('divine')) return '💎';
      if (a.includes('vaal')) return '🔴';
      if (a.includes('chance')) return '🎲';
      if (a.includes('bone')) return '🦴';
      if (a === 'buy_base') return '🛒';
      return '·';
    };
    // Per-action breakdown: sum step.costEx by action so the panel
    // can show "alch × 5 · 7.2 ex (1.4 ex/each)". Iterates the steps
    // (which carry the actual incurred cost) rather than re-deriving
    // from craft.orbCosts — keeps display + simulation in sync if the
    // user tweaked rates between solve and sample.
    const scenarioActionLines = (s) => {
      const out = new Map();
      for (const st of (s?.traj?.steps ?? [])) {
        const row = out.get(st.action) ?? { count: 0, costEx: 0 };
        row.count += 1;
        row.costEx += Number.isFinite(st.costEx) ? st.costEx : 0;
        out.set(st.action, row);
      }
      return Array.from(out.entries()).map(([action, r]) => ({
        action,
        count: r.count,
        costEx: r.costEx,
        perOrbEx: r.count > 0 ? r.costEx / r.count : 0,
        icon: orbIconFor(action),
      }));
    };
    // Map an action id (e.g. "exalt_perfect", "regal_dextral") to the
    // closest matching orb in `craft.game.orbs`, so the scenario
    // orb-spend chip can show a friendly name + effect string in its
    // hover popup. Returns null for actions with no orb counterpart
    // (essence_*, omen_*, apply_bone, buy_base) — caller falls back
    // to the raw action id.
    const orbForAction = (actionId) => {
      const orbs = craft.game?.orbs;
      if (!actionId || !orbs) return null;
      const a = String(actionId);
      if (orbs[a]) return orbs[a];
      // Action prefixes that don't match the orb id directly.
      const aliases = { exalt: 'exalted', alch: 'alchemy', annul: 'annulment' };
      const cap = (s) => s ? s[0].toUpperCase() + s.slice(1) : '';
      const tryVariant = (base, rest) => {
        const candidate = base + cap(rest);
        return orbs[candidate] ?? orbs[base] ?? null;
      };
      for (const [aliasFrom, aliasTo] of Object.entries(aliases)) {
        if (a === aliasFrom) return orbs[aliasTo];
        if (a.startsWith(aliasFrom + '_')) return tryVariant(aliasTo, a.slice(aliasFrom.length + 1));
      }
      for (const base of ['transmute', 'augment', 'regal', 'chaos', 'divine', 'vaal', 'chance', 'fracturing']) {
        if (a.startsWith(base + '_')) return tryVariant(base, a.slice(base.length + 1));
      }
      if (a === 'apply_bone' || a === 'reveal_bone' || a.startsWith('reveal_bone_')) {
        const itemClass = craft.itemType ?? null;
        let cheapest = null;
        for (const c of Object.values(craft.effectiveCurrencies ?? {})) {
          if (c.kind !== 'desecrated') continue;
          if (itemClass && c.appliesToItemClasses && !c.appliesToItemClasses.includes(itemClass)) continue;
          if (!Number.isFinite(c.exaltedPer)) continue;
          if (!cheapest || c.exaltedPer < cheapest.exaltedPer) cheapest = c;
        }
        if (cheapest) {
          return {
            name: cheapest.name,
            priceCurrency: cheapest.id,
            effect: a === 'apply_bone'
              ? 'Apply a Bone to a Rare item — pads totalMods toward fracture-eligibility'
              : 'Reveal the bone-mod (3-pick from the desecrated pool)',
          };
        }
      }
      return null;
    };
    // Chip-display formatters for the orb-spend chips: friendly
    // name including count ("Exalted × 5"), and consolidated rate
    // ("5 × 32.4 ex = 162 ex"). Mirror the rate-format used by the
    // action-set chip.
    const orbSpendChipName = (line) => {
      const orb = orbForAction(line.action);
      const base = orb?.name?.replace(/^Orb of /, '').replace(/ Orb$/, '') ?? line.action;
      return line.count > 1 ? `${base} × ${line.count}` : base;
    };
    const orbSpendChipRate = (line) => {
      if (line.count <= 1) return fmtCost(line.costEx);
      return `${line.count} × ${fmtCost(line.perOrbEx)} = ${fmtCost(line.costEx)}`;
    };
    // Shopping list for "stockpile before crafting" planning. For N
    // runs at the user's confidence target, sum expected per-orb uses
    // across the chain (P_reach × policy → expected uses per attempt)
    // and multiply by N. `buy_base` collapses into one entry — every
    // run consumes one base — and gets the basePriceEx unit cost.
    const materialsShoppingList = computed(() => {
      const chain = craft.mdpResult?.chain;
      if (!chain?.states?.length) return null;
      const p = chain.pSuccessStart;
      if (!Number.isFinite(p) || p <= 0) return null;
      const target = craft.successProbTarget ?? 0.95;
      // N attempts to be `target` confident of one success.
      // Closed form: N = ⌈log(1-target) / log(1-p)⌉. Edge case:
      // p=1 ⇒ log(0)=-∞ ⇒ ratio → 0 ⇒ ceil(0)=0 — but you still
      // need to *acquire* one base / take one shot to materialise
      // the success, so floor at 1 (user report 2026-05-11).
      const N = Math.max(1, Math.ceil(Math.log(1 - target) / Math.log(1 - p)));
      // expectedVisits is now the engine's full visit-count
      // (self-loops applied) rather than just inflow. Sum across
      // chain states grouped by their policy action to get expected
      // per-attempt orb counts.
      const expected = new Map();
      for (const s of chain.states) {
        const a = s.meta?.policy;
        if (!a) continue;
        if (a === 'buy_base') continue;
        const visits = Number.isFinite(s.expectedVisits)
          ? s.expectedVisits
          : (s.pReach ?? 0);
        expected.set(a, (expected.get(a) ?? 0) + visits);
      }
      const orbs = craft.game?.orbs ?? {};
      const lines = [];
      const basePriceEx = craft.mdpResult.basePriceEx ?? 0;
      // Bases first: one per run.
      lines.push({
        action: 'buy_base',
        icon: '🛒',
        count: N,
        perEx: basePriceEx,
        totalEx: N * basePriceEx,
        expectedPerAttempt: 1,
        orb: null,
      });
      const orbForActionLocal = (a) => {
        if (orbs[a]) return orbs[a];
        const aliases = { exalt: 'exalted', alch: 'alchemy', annul: 'annulment' };
        const cap = (s) => s ? s[0].toUpperCase() + s.slice(1) : '';
        const tryVariant = (base, rest) => orbs[base + cap(rest)] ?? orbs[base] ?? null;
        for (const [from, to] of Object.entries(aliases)) {
          if (a === from) return orbs[to];
          if (a.startsWith(from + '_')) return tryVariant(to, a.slice(from.length + 1));
        }
        for (const base of ['transmute', 'augment', 'regal', 'chaos', 'divine', 'vaal', 'chance', 'fracturing']) {
          if (a.startsWith(base + '_')) return tryVariant(base, a.slice(base.length + 1));
        }
        // Bone actions (apply_bone, reveal_bone, reveal_bone_*) consume
        // a desecrated currency. Resolve to the cheapest item-class-
        // applicable bone in effectiveCurrencies — same rule the engine
        // uses (engine/mdp/adapter.js boneCostEx). Without this, the
        // shopping list would label the row "apply_bone" with no price.
        if (a === 'apply_bone' || a === 'reveal_bone' || a.startsWith('reveal_bone_')) {
          const itemClass = craft.itemType ?? null;
          let cheapest = null;
          for (const c of Object.values(craft.effectiveCurrencies ?? {})) {
            if (c.kind !== 'desecrated') continue;
            if (itemClass && c.appliesToItemClasses && !c.appliesToItemClasses.includes(itemClass)) continue;
            if (!Number.isFinite(c.exaltedPer)) continue;
            if (!cheapest || c.exaltedPer < cheapest.exaltedPer) cheapest = c;
          }
          if (cheapest) {
            return {
              name: cheapest.name,
              priceCurrency: cheapest.id,
              effect: a === 'apply_bone'
                ? 'Apply a Bone to a Rare item — pads totalMods toward fracture-eligibility'
                : 'Reveal the bone-mod (3-pick from the desecrated pool)',
            };
          }
        }
        return null;
      };
      for (const [action, perAtt] of expected.entries()) {
        if (perAtt <= 1e-9) continue;
        const totalCountRaw = N * perAtt;
        const count = Math.ceil(totalCountRaw);
        const orb = orbForActionLocal(action);
        const perEx = orb ? (craft.effectiveCurrencies?.[orb.priceCurrency]?.exaltedPer ?? NaN) : NaN;
        const totalEx = Number.isFinite(perEx) ? count * perEx : NaN;
        lines.push({
          action,
          icon: orbIconFor(action),
          count,
          perEx,
          totalEx,
          expectedPerAttempt: perAtt,
          orb,
        });
      }
      lines.sort((a, b) => (b.totalEx || 0) - (a.totalEx || 0));
      const grandTotalEx = lines.reduce((s, l) => s + (Number.isFinite(l.totalEx) ? l.totalEx : 0), 0);
      return { N, target, lines, grandTotalEx };
    });
    // Trajectory probability: Π step.sampledProb. Useful as a
    // "how rare was this exact path" heatmap — a 100k-ex scenario
    // with p=10⁻⁶ is *expected* to be extreme, while one with
    // p=0.4 means the planner thinks this is the typical run.
    const scenarioProbability = (s) => {
      const steps = s?.traj?.steps ?? [];
      let p = 1;
      for (const st of steps) {
        if (Number.isFinite(st.sampledProb)) p *= st.sampledProb;
      }
      return p;
    };
    const fmtProbability = (p) => {
      if (!Number.isFinite(p) || p <= 0) return '—';
      if (p >= 0.01) return `${(p * 100).toFixed(2)}%`;
      if (p >= 1e-6) return `${(p * 100).toPrecision(2)}%`;
      return p.toExponential(1);
    };

    // ─────────────────────────────────────────────────────────
    // Distribution panel: histogram + CDF over batch-sampled cost.
    // ─────────────────────────────────────────────────────────
    // Bin the totalEx values into a fixed-count histogram (40 bins).
    // Failure paths (truncated / not goal-reached) are kept — they
    // naturally land at the expensive end since their costs include
    // restart loops + base re-buys before truncation.
    const HIST_BINS = 40;
    const distributionStats = computed(() => {
      const dist = craft.mdpDistribution;
      if (!dist?.samples?.length) return null;
      const xs = dist.samples.map((s) => s.totalEx).filter(Number.isFinite);
      if (!xs.length) return null;
      xs.sort((a, b) => a - b);
      const n = xs.length;
      const min = xs[0];
      const max = xs[n - 1];
      const mean = xs.reduce((a, b) => a + b, 0) / n;
      const median = xs[Math.floor(n / 2)];
      const q = (p) => xs[Math.max(0, Math.min(n - 1, Math.floor(p * (n - 1))))];
      // The "doubling chain": for a strategy with per-attempt success
      // rate s at cost ≤ c, k restarts achieve 1-(1-s)^k success at
      // cost ≤ k·c. So the user's expectation chain is:
      //   p50 ≤ c0       (one attempt)
      //   p75 ≤ 2·p50    (k=2 from s=0.5; 1-(1-0.5)²=0.75)
      //   p93.75 ≤ 2·p75 (k=2 from s=0.75; 1-(1-0.75)²=0.9375)
      // If the engine is restart-savvy these inequalities should hold;
      // a violation means the policy is leaving doubling-better restart
      // wins on the table.
      const p75    = q(0.75);
      const p9375  = q(0.9375);
      const successCount = dist.samples.filter((s) => s.reachedGoal).length;
      const failCount = n - successCount;
      // Histogram: linear bins from min..max. Edge case min===max: one bin.
      const binWidth = max > min ? (max - min) / HIST_BINS : 1;
      const bins = new Array(HIST_BINS).fill(0);
      const binSuccess = new Array(HIST_BINS).fill(0);
      const binFail = new Array(HIST_BINS).fill(0);
      for (const s of dist.samples) {
        if (!Number.isFinite(s.totalEx)) continue;
        let idx = max > min ? Math.floor((s.totalEx - min) / binWidth) : 0;
        if (idx >= HIST_BINS) idx = HIST_BINS - 1;
        if (idx < 0) idx = 0;
        bins[idx] += 1;
        if (s.reachedGoal) binSuccess[idx] += 1;
        else binFail[idx] += 1;
      }
      const peakBin = Math.max(...bins, 1);
      // CDF: monotone non-decreasing curve over the same x-axis.
      const cdf = new Array(HIST_BINS + 1);
      let cum = 0;
      for (let i = 0; i < HIST_BINS; i++) {
        cum += bins[i];
        cdf[i + 1] = cum / n;
      }
      cdf[0] = 0;
      // Doubling-chain ratios. If the policy is restart-savvy these
      // should hold:  p75 ≤ 2·p50  and  p93.75 ≤ 2·p75. Excess > 1
      // means the histogram has cost mass that smarter stop-and-restart
      // would have avoided — i.e. evidence the engine's expected-cost
      // objective is leaving stop-loss wins on the table.
      const p75over2p50    = (median > 0)            ? p75   / (2 * median) : null;
      const p9375over2p75  = (Number.isFinite(p75) && p75 > 0) ? p9375 / (2 * p75)    : null;
      // Headline chance-constrained statistic: P(success | budget B)
      // under the current MDP-optimal-by-E[cost] policy. This is the
      // primary number the user actually wants when they say "I have
      // a 10-div budget." It's a lower bound on what a chance-
      // constrained MDP solver could achieve — but if it's already
      // ≥0.9, building one isn't worth the effort.
      const budgetEx = (Number.isFinite(craft.totalBudgetEx) && craft.totalBudgetEx > 0)
        ? craft.totalBudgetEx : null;
      let successWithinBudget = 0;
      // Single-base success: trajectories that reached goal WITHOUT
      // ever restarting (buyBaseEvents === 0). Models the "I have one
      // physical item, no restock" scenario. Compute both the
      // unconditional rate and the budget-restricted rate.
      let successSingleBase = 0;
      let successSingleBaseAtBudget = 0;
      for (const s of dist.samples) {
        if (s.reachedGoal && Number.isFinite(s.totalEx)) {
          if (budgetEx != null && s.totalEx <= budgetEx) successWithinBudget += 1;
          if ((s.buyBaseEvents ?? 0) === 0) {
            successSingleBase += 1;
            if (budgetEx != null && s.totalEx <= budgetEx) successSingleBaseAtBudget += 1;
          }
        }
      }
      const pSuccessAtBudget = budgetEx != null ? successWithinBudget / n : null;
      const pSuccessSingleBase = successSingleBase / n;
      const pSuccessSingleBaseAtBudget = budgetEx != null ? successSingleBaseAtBudget / n : null;
      return {
        n, min, max, mean, median,
        p75, p9375,
        p75over2p50, p9375over2p75,
        successCount, failCount,
        budgetEx, successWithinBudget, pSuccessAtBudget,
        successSingleBase, pSuccessSingleBase,
        successSingleBaseAtBudget, pSuccessSingleBaseAtBudget,
        binWidth, bins, binSuccess, binFail, peakBin, cdf,
      };
    });

    // Build SVG path data for the bars + CDF line. Renders inside an
    // 800×220 viewBox; the parent CSS scales it responsively.
    const SVG_W = 800, SVG_H = 220, PAD_L = 50, PAD_R = 30, PAD_T = 14, PAD_B = 36;
    const plotX = (frac) => PAD_L + frac * (SVG_W - PAD_L - PAD_R);
    const plotY = (frac) => SVG_H - PAD_B - frac * (SVG_H - PAD_T - PAD_B);
    const distributionPlot = computed(() => {
      const stats = distributionStats.value;
      if (!stats) return null;
      const innerW = SVG_W - PAD_L - PAD_R;
      const barW = innerW / HIST_BINS;
      const bars = [];
      for (let i = 0; i < HIST_BINS; i++) {
        const x = PAD_L + i * barW;
        const totalH = (stats.bins[i] / stats.peakBin) * (SVG_H - PAD_T - PAD_B);
        const failH = (stats.binFail[i] / stats.peakBin) * (SVG_H - PAD_T - PAD_B);
        const successH = totalH - failH;
        const xMid = stats.min + (i + 0.5) * stats.binWidth;
        bars.push({
          xLeft: x, w: barW - 1,
          successY: SVG_H - PAD_B - successH,
          successH,
          failY: SVG_H - PAD_B - successH - failH,
          failH,
          count: stats.bins[i],
          successCount: stats.binSuccess[i],
          failCount: stats.binFail[i],
          xMid,
        });
      }
      // CDF polyline: (xLeft of bin i, cdf[i]) for i=0..HIST_BINS,
      // ending at (xRight of last bin, 1).
      const cdfPoints = [];
      for (let i = 0; i <= HIST_BINS; i++) {
        const x = PAD_L + i * barW;
        const y = plotY(stats.cdf[i]);
        cdfPoints.push(`${x.toFixed(1)},${y.toFixed(1)}`);
      }
      const cdfPath = 'M' + cdfPoints.join(' L');
      // X-axis tick labels (5 ticks).
      const ticks = [];
      for (let i = 0; i <= 5; i++) {
        const frac = i / 5;
        const v = stats.min + frac * (stats.max - stats.min);
        ticks.push({ x: plotX(frac), label: fmtCost(v) });
      }
      // Quantile markers (median, p90).
      const markerLine = (qVal, label, color) => {
        if (!Number.isFinite(qVal) || stats.max === stats.min) return null;
        const frac = (qVal - stats.min) / (stats.max - stats.min);
        return { x: plotX(frac), label, color };
      };
      const markers = [
        markerLine(stats.median, `p50 ${fmtCost(stats.median)}`,    '#5d9'),
        markerLine(stats.p75,    `p75 ${fmtCost(stats.p75)}`,       '#cd6'),
        markerLine(stats.p9375,  `p93.75 ${fmtCost(stats.p9375)}`,  '#d96'),
      ].filter(Boolean);
      // Budget marker — heavier line so it stands out from the
      // quantile guides. Only drawn when the budget falls within the
      // x-axis range of the histogram (otherwise the marker would
      // overshoot the chart).
      const budgetMarker = (() => {
        const B = stats.budgetEx;
        if (!Number.isFinite(B) || stats.max === stats.min) return null;
        if (B < stats.min || B > stats.max) return null;
        const frac = (B - stats.min) / (stats.max - stats.min);
        return { x: plotX(frac), label: `budget ${fmtCost(B)}`, color: '#fff' };
      })();
      return { bars, cdfPath, ticks, markers, budgetMarker, SVG_W, SVG_H, PAD_L, PAD_R, PAD_T, PAD_B };
    });

    // Scenario serialization + handoff to Divine Bench. Lazy-imports
    // the concrete-item DSL serializer so the engine module isn't on
    // the Home view's hot path.
    const copyScenarioToClipboard = async (scenario) => {
      const text = await scenarioToDSL(scenario);
      try { await navigator.clipboard.writeText(text); }
      catch { /* fallback: nothing — user can use the Divine Bench send instead */ }
    };
    const sendScenarioToDivineBench = async (scenario) => {
      const text = await scenarioToDSL(scenario);
      craft.pendingDivineBenchItem = text;
      // Navigate to the Divine Bench tab so it picks up the staged
      // item via its own setup() reading craft.pendingDivineBenchItem.
      window.location.hash = `#/${craft.gameId ?? 'poe2'}/divine-bench`;
    };
    const scenarioToDSL = async (scenario) => {
      const { serializeConcreteItem } = await import('../engine/concrete-item-syntax.js');
      return serializeConcreteItem({
        itemType: scenario.itemType,
        base: scenario.base,
        itemLevel: scenario.itemLevel,
        rarity: scenario.traj.concreteItem?.rarity,
        totalEx: scenario.traj.totalEx,
        totalSec: scenario.traj.totalSec,
        buyBaseEvents: scenario.traj.buyBaseEvents,
        orbCounts: scenario.traj.orbCounts,
        affixes: scenario.affixes,
      });
    };

    return { craft, showSpecStep, fmt, toRef, fmtTime, fmtCost, divToEx,
             budgetUnit, budgetDisplayValue, setBudgetFromInput,
             prefixesFull, suffixesFull,
             expand, collapse, isExpanded, confirmTier,
             selectedMod, openModModal, closeModModal, tagStyle,
             allAffixesPanelOpen,
             essenceableNamesBySide, essenceTierMismatch, lowerRequiredTierForEssence,
             desecratedNames,
             groupedEssences, filteredEssences, essencesBySide,
             groupedDesecrated, filteredDesecrated, desecratedBySide,
             desecratedFamilyTags,
             ESSENCE_TIERS, ESSENCE_TIER_LABELS,
             selectedEssence, openEssenceModal, closeEssenceModal,
             selectedDesecrated, openDesecratedModal, closeDesecratedModal,
             poedbItemUrl, poedbEconomyUrl, wikiUrl,
             ratesSnapshotLabel, ratesSnapshotTitle,
             promptSaveCraft, confirmDeleteCraft, confirmOverwriteCraft, attemptMeaning,
             recipeText, recipeStatus, recipeExport, recipeImport,
             BONE_GIBBERISH, canAddStartingBone, canSwapStartingBone,
             canAddTargetBone, canSwapTargetBone,
             orbIconFor, scenarioActionLines, scenarioProbability, fmtProbability,
             distributionStats, distributionPlot,
             chainRenderer, setChainRenderer, copyChainDump, orbsByFamily,
             orbIconForId, orbRateEx, fmtRate,
             orbForAction, orbSpendChipName, orbSpendChipRate, materialsShoppingList,
             copyScenarioToClipboard, sendScenarioToDivineBench };
  },
  template: `
    <section class="planner">
      <p v-if="craft.loading">Loading game data…</p>

      <template v-else-if="craft.game">
        <details class="saved-crafts">
          <summary>
            ★ Saved crafts <small>({{ craft.savedCrafts.length }})</small>
            <button class="link save-craft-btn"
              :disabled="!craft.itemType"
              @click.stop="promptSaveCraft"
              title="Save the current item type / base / ilvl / wished mods as a named favorite">
              ★ Save current
            </button>
          </summary>
          <ul v-if="craft.savedCrafts.length" class="saved-crafts-list">
            <li v-for="c in craft.savedCrafts" :key="c.id" class="saved-craft">
              <button class="link saved-craft-restore"
                :title="'Saved ' + c.savedAt + ' — click to restore'"
                @click="craft.loadSavedCraft(c.id)">↺ {{ c.name }}</button>
              <button class="link saved-craft-overwrite"
                :disabled="!craft.itemType"
                :title="craft.itemType ? 'Overwrite this saved craft with the current one (keeps the name)' : 'Pick an item type first'"
                @click="confirmOverwriteCraft(c)">⤓</button>
              <button class="link saved-craft-delete" title="Delete this saved craft"
                @click="confirmDeleteCraft(c)">×</button>
            </li>
          </ul>
          <p v-else class="hint">No saved crafts yet — pick an item type, edit your wishlist, then click <em>★ Save current</em>.</p>
        </details>

        <ol class="steps">
          <li class="step">
            <label class="field">
              <span>1. Item type</span>
              <!-- Native <select> instead of <datalist>: HTML5
                   datalist popovers in Chromium have a positioning
                   quirk where they sometimes open beside the input
                   instead of below it (browser-controlled, not
                   CSS-tunable). Switching to <select> matches the
                   step-2 dropdown's UX and guarantees the dropdown
                   opens directly under the input. Item types are a
                   closed enumeration, so type-to-filter on free-text
                   isn't needed here. -->
              <select :value="craft.itemType ?? ''"
                      @change="craft.setItemType($event.target.value || null)">
                <option value="">— pick a type —</option>
                <option v-for="t in craft.itemTypes" :key="t" :value="t">{{ t }}</option>
              </select>
            </label>
          </li>

          <li class="step" v-if="showSpecStep">
            <label class="field">
              <span>2. Specialization</span>
              <select :value="craft.base ?? ''" @change="craft.setBase($event.target.value)">
                <option value="" disabled>— pick attributes —</option>
                <option v-for="b in craft.basesForType" :key="b.base" :value="b.base">
                  {{ b.spec ?? '—' }}
                </option>
              </select>
              <small v-if="!craft.base" class="hint">
                Pick a specialization to see modifiers — the affix pool depends on
                the attribute requirement (e.g. Boots (STR) and Boots (INT) roll
                different stats).
              </small>
            </label>
          </li>

          <li class="step" v-if="craft.base">
            <label class="field">
              <span>{{ showSpecStep ? '3' : '2' }}. Item level</span>
              <span class="ilvl-control">
                <input
                  type="range" min="1" max="86" step="1"
                  :value="craft.itemLevel"
                  @change="craft.setItemLevel($event.target.value)"
                  class="ilvl-slider"
                />
                <input
                  type="number" min="1" max="100"
                  :value="craft.itemLevel"
                  @input="craft.setItemLevel($event.target.value)"
                  class="ilvl-number"
                />
              </span>
            </label>
          </li>
        </ol>

        <div v-if="craft.base" class="state-panels">
          <!-- ============================================================ -->
          <!-- START ITEM — concrete, exact affixes already on the item.    -->
          <!-- ============================================================ -->
          <article class="item-card start" :class="'rarity-' + craft.startRarity">
            <header>
              <h3>Base item</h3>
              <small>
                <select class="rarity-select" :value="craft.startRarity"
                  @change="craft.setStartRarity($event.target.value)">
                  <option value="normal">Normal</option>
                  <option value="magic">Magic</option>
                  <option value="rare">Rare</option>
                </select>
                · {{ craft.startingCounts.prefixes + craft.startingCounts.suffixes }} affix(es) on {{ craft.base }} (ilvl {{ craft.itemLevel }})
              </small>
              <button class="reset-btn"
                :disabled="!(craft.slots.prefixes.some(Boolean) || craft.slots.suffixes.some(Boolean) || craft.startRarity !== 'normal')"
                @click="craft.clearStarting()" title="Reset start item to a Normal blank base">Reset</button>
            </header>
            <div class="affix-list-grid">
              <div class="prefix-col">
              <div v-for="(slot, i) in craft.slots.prefixes" :key="'p'+i" class="affix prefix" :class="{ filled: slot, fractured: slot?.fractured, desecrated: slot?.desecrated }">
                <template v-if="slot">
                  <span class="name">{{ craft.getModDisplay(slot.name, slot.tier) }}</span>
                  <span class="affix-controls">
                    <button v-if="slot.fractured || !craft.hasFractured()" class="link fracture-btn"
                      :class="{ active: slot.fractured }"
                      :title="slot.fractured ? 'fractured (locked) — click to unmark' : 'mark as fractured (lock this affix)'"
                      @click="craft.setStartingFractured('PREFIX', i, !slot.fractured)"><img src="./assets/fracturing-orb.svg" alt="fractured" class="orb-icon" /></button>
                    <button v-if="slot.desecrated || !craft.hasDesecratedStarting()" class="link desec-btn"
                      :class="{ active: slot.desecrated }"
                      :title="slot.desecrated ? 'desecrated (from Well of Souls) — click to unmark' : 'mark this affix as desecrated (from a bone reveal); blocks apply_bone until scrubbed'"
                      @click="craft.setStartingDesecrated('PREFIX', i, !slot.desecrated)">🦴</button>
                    <select class="tier-select" :value="slot.tier"
                      @change="craft.setStartingTier('PREFIX', i, $event.target.value)">
                      <option v-for="t in craft.getAllTiers('PREFIX', slot.name)" :key="'pt'+i+t.tier" :value="t.tier" :disabled="!t.ilvlOk">
                        T{{ t.tier }} · {{ t.tierName }}{{ t.ilvlOk ? '' : ' (ilvl ' + t.ilvl + '+)' }}
                      </option>
                    </select>
                    <button class="link" @click="craft.removeFromStarting('PREFIX', i)">×</button>
                  </span>
                </template>
              </div>
              <div v-if="craft.startingBoneMod && craft.startingBoneSide === 'PREFIX'"
                   class="affix prefix bone-pending"
                   title="Pending unrevealed bone-mod — applied but awaiting Well of Souls reveal. The mod identity is hidden in-game until reveal.">
                <span class="name">🦴 {{ BONE_GIBBERISH }}</span>
                <span class="affix-controls">
                  <button class="bone-swap-btn"
                    :disabled="!canSwapStartingBone"
                    :title="canSwapStartingBone ? 'Move pending bone to suffix side' : 'No free suffix slot to swap into'"
                    @click="craft.setStartingBoneSide('SUFFIX')">⇄</button>
                  <button class="link"
                    title="Remove the pending bone-mod"
                    @click="craft.setStartingBoneMod(false)">×</button>
                </span>
              </div>
              <button v-if="!craft.startingBoneMod" class="bone-add-btn"
                :disabled="!canAddStartingBone('PREFIX')"
                :title="canAddStartingBone('PREFIX') ? 'Add a pending unrevealed bone-mod to the prefix side' : (craft.hasDesecratedStarting() ? 'A starting affix is already desecrated — clear it first (one-cap rule)' : 'No free prefix slot')"
                @click="craft.setStartingBoneSide('PREFIX')">🦴 + bone</button>
              </div>
              <div class="suffix-col">
              <div v-for="(slot, i) in craft.slots.suffixes" :key="'s'+i" class="affix suffix" :class="{ filled: slot, fractured: slot?.fractured, desecrated: slot?.desecrated }">
                <template v-if="slot">
                  <span class="name">{{ craft.getModDisplay(slot.name, slot.tier) }}</span>
                  <span class="affix-controls">
                    <button v-if="slot.fractured || !craft.hasFractured()" class="link fracture-btn"
                      :class="{ active: slot.fractured }"
                      :title="slot.fractured ? 'fractured (locked) — click to unmark' : 'mark as fractured (lock this affix)'"
                      @click="craft.setStartingFractured('SUFFIX', i, !slot.fractured)"><img src="./assets/fracturing-orb.svg" alt="fractured" class="orb-icon" /></button>
                    <button v-if="slot.desecrated || !craft.hasDesecratedStarting()" class="link desec-btn"
                      :class="{ active: slot.desecrated }"
                      :title="slot.desecrated ? 'desecrated (from Well of Souls) — click to unmark' : 'mark this affix as desecrated (from a bone reveal); blocks apply_bone until scrubbed'"
                      @click="craft.setStartingDesecrated('SUFFIX', i, !slot.desecrated)">🦴</button>
                    <select class="tier-select" :value="slot.tier"
                      @change="craft.setStartingTier('SUFFIX', i, $event.target.value)">
                      <option v-for="t in craft.getAllTiers('SUFFIX', slot.name)" :key="'st'+i+t.tier" :value="t.tier" :disabled="!t.ilvlOk">
                        T{{ t.tier }} · {{ t.tierName }}{{ t.ilvlOk ? '' : ' (ilvl ' + t.ilvl + '+)' }}
                      </option>
                    </select>
                    <button class="link" @click="craft.removeFromStarting('SUFFIX', i)">×</button>
                  </span>
                </template>
              </div>
              <div v-if="craft.startingBoneMod && craft.startingBoneSide === 'SUFFIX'"
                   class="affix suffix bone-pending"
                   title="Pending unrevealed bone-mod — applied but awaiting Well of Souls reveal. The mod identity is hidden in-game until reveal.">
                <span class="name">🦴 {{ BONE_GIBBERISH }}</span>
                <span class="affix-controls">
                  <button class="bone-swap-btn"
                    :disabled="!canSwapStartingBone"
                    :title="canSwapStartingBone ? 'Move pending bone to prefix side' : 'No free prefix slot to swap into'"
                    @click="craft.setStartingBoneSide('PREFIX')">⇄</button>
                  <button class="link"
                    title="Remove the pending bone-mod"
                    @click="craft.setStartingBoneMod(false)">×</button>
                </span>
              </div>
              <button v-if="!craft.startingBoneMod" class="bone-add-btn"
                :disabled="!canAddStartingBone('SUFFIX')"
                :title="canAddStartingBone('SUFFIX') ? 'Add a pending unrevealed bone-mod to the suffix side' : (craft.hasDesecratedStarting() ? 'A starting affix is already desecrated — clear it first (one-cap rule)' : 'No free suffix slot')"
                @click="craft.setStartingBoneSide('SUFFIX')">🦴 + bone</button>
              </div>
            </div>
            <div class="start-pricing">
              <label class="field inline">
                <span>Base item price (Ex)</span>
                <input type="number" min="0" step="any"
                  :value="craft.basePriceEx"
                  @input="craft.setBasePriceEx($event.target.value)" />
                <small class="hint">cost to acquire this item — covers white bases, drop value, OR a pre-fractured trade-buy (whichever applies)</small>
              </label>
            </div>
            <div class="card-tag-row" v-if="craft.tagsOnStarting().length">
              <span class="tag-filter-label">Tags on item:</span>
              <button v-for="[tag, count] in craft.tagsOnStarting()" :key="'sti'+tag"
                class="tag-chip filter"
                :class="craft.tagFilters[tag] || 'neutral'"
                :style="tagStyle(tag)"
                :title="'Click to cycle filter (include / exclude / clear) on ' + tag"
                @click="craft.cycleTagFilter(tag)">{{ tag }} <small>×{{ count }}</small></button>
            </div>
            <footer>
              <small>Add affixes via the <em>+ start</em> buttons in the mod pool below. Use the <img src="./assets/fracturing-orb.svg" alt="Fracturing Orb" class="orb-icon" /> to mark one as fractured (PoE2 allows max 1 per item).</small>
            </footer>
          </article>

          <!-- ============================================================ -->
          <!-- TARGET ACCEPTABLE SET — flat list, grows freely.             -->
          <!-- ============================================================ -->
          <article class="item-card target">
            <header>
              <h3>Acceptable final items</h3>
              <small>
                {{ craft.targetTotals.required }} required,
                {{ craft.targetTotals.desired }} desired,
                {{ craft.targetTotals.empty }} empty ·
                hit threshold = {{ craft.requiredHits }}, maxFilled = {{ craft.maxFilled }}
              </small>
              <button class="reset-btn"
                :disabled="!craft.hasTargetSlots()"
                @click="craft.clearTarget()" title="Remove every required/desired/empty target entry">Reset</button>
            </header>
            <p v-if="craft.targetTotals.required === 0
                       && craft.minDesireScore === 0
                       && (craft.targetTotals.desired + craft.targetTotals.required) > 0"
               class="hint" style="color:#d96; padding: 0.4rem 0.6rem; border-left: 3px solid #d96; background: rgba(217,150,0,0.08); margin: 0.4rem 0;">
              ⚠ Goal is trivially satisfiable: 0 required mods and
              minimum desire score = 0. Any item — including a White
              base — satisfies the goal as written, so the engine will
              report V*(start) ≈ 0 and "do nothing". Either
              <button class="link" @click="craft.markAllTargetEntriesRequired(true)"
                title="Promote every desired mod to required (must be present at the listed tier)">mark all desired as required</button>,
              or raise the minimum desire score below.
            </p>
            <div class="desire-score-row" v-if="craft.targetTotals.desired || craft.targetTotals.required">
              <label class="field inline desire-score-slider">
                <span>Min desire score</span>
                <input type="range" min="0" :max="craft.maxDesireScore || 0" step="0.5"
                  :value="Math.min(craft.minDesireScore, craft.maxDesireScore || 0)"
                  :disabled="!craft.maxDesireScore"
                  @change="craft.setMinDesireScore($event.target.value)" />
                <input type="number" min="0" :max="craft.maxDesireScore || 0" step="0.5"
                  class="desire-score-number"
                  :value="craft.minDesireScore"
                  @input="craft.setMinDesireScore($event.target.value)" />
                <small class="hint">
                  / {{ craft.maxDesireScore }} max ·
                  <strong>{{ craft.targetTotals.required }}</strong> required +
                  <strong>{{ craft.targetTotals.desired }}</strong> desired.
                  Required mods must always be present; desired mods + tier
                  upgrades feed this soft pool. <em>(Score-aware solver pending — the strategy table currently approximates with a hit-count threshold.)</em>
                </small>
              </label>
              <div class="bulk-required-toggle" style="display: flex; gap: 0.4rem; align-items: center; flex-wrap: wrap;">
                <button v-if="craft.targetTotals.desired > 0 && craft.targetTotals.required === 0"
                  class="link"
                  :disabled="craft.targetSummary.prefixes.desired > 3 || craft.targetSummary.suffixes.desired > 3"
                  :title="craft.targetSummary.prefixes.desired > 3 || craft.targetSummary.suffixes.desired > 3 ? 'Per-side required cap is 3 — cannot promote all desired mods' : 'Promote every desired mod to required'"
                  @click="craft.markAllTargetEntriesRequired(true)">
                  ☑ Mark all required ({{ craft.targetTotals.desired }})
                </button>
                <button v-if="craft.targetTotals.required > 0 && craft.targetTotals.desired === 0"
                  class="link"
                  title="Demote every required mod to desired-only (soft constraint)"
                  @click="craft.markAllTargetEntriesRequired(false)">
                  ☐ Mark all desired ({{ craft.targetTotals.required }})
                </button>
              </div>
              <p v-if="craft.minDesireScore > (craft.maxDesireScore || 0)"
                 class="desire-score-cap-notice">
                <strong>⚠ Desire-score cap applied.</strong>
                Configured value <strong>{{ craft.minDesireScore }}</strong>
                exceeds the maximum achievable
                <strong>{{ craft.maxDesireScore || 0 }}</strong>
                given the current wishlist + ilvl. The solver is using
                <strong>{{ craft.maxDesireScore || 0 }}</strong>; otherwise
                no item could ever satisfy the threshold and the goal
                would be unreachable. Lower the threshold or add desired
                mods / raise tiers to grow the cap.
                <button class="link"
                  @click="craft.setMinDesireScore(craft.maxDesireScore || 0)"
                  :title="'Set min desire score to ' + (craft.maxDesireScore || 0)">
                  Set to {{ craft.maxDesireScore || 0 }}
                </button>
              </p>
            </div>
            <div class="target-sides-grid">
            <div class="target-side">
              <h4>Prefixes
                <small>({{ craft.targetSummary.prefixes.required }} required, {{ craft.targetSummary.prefixes.desired }} desired, {{ craft.targetSummary.prefixes.empty }}/3 empty)</small>
                <button class="link inline-add"
                  :disabled="craft.targetSummary.prefixes.empty + craft.targetSummary.prefixes.required >= 3"
                  @click="craft.addTargetEmpty('PREFIX')"
                  :title="craft.targetSummary.prefixes.empty + craft.targetSummary.prefixes.required >= 3 ? 'No prefix slot left — required + empty already fill 3/3' : 'Require an empty prefix slot'">+ empty prefix</button>
                <button v-if="!craft.targetBoneMod" class="bone-add-btn"
                  :disabled="!canAddTargetBone('PREFIX')"
                  :title="canAddTargetBone('PREFIX') ? 'Allow a pending unrevealed bone-mod on the prefix side at goal time' : 'No free prefix slot'"
                  @click="craft.setTargetBoneSide('PREFIX')">🦴 + bone</button>
              </h4>
              <div v-if="craft.targetByType.PREFIX.length === 0" class="empty-list">— add wished prefixes via <em>+ wish</em> in the pool below —</div>
              <div v-for="e in craft.targetByType.PREFIX" :key="'tep'+e.idx" class="affix prefix"
                   :class="{ filled: e.kind === 'mod', explicit: e.kind === 'empty', shadowed: craft.isEntryShadowed(e) }">
                <template v-if="e.kind === 'mod'">
                  <span class="name" :class="{ disabled: e.disabled || craft.isEntryShadowed(e), unreachable: !e.disabled && !craft.isEntryShadowed(e) && !craft.targetEntryReachability(e).reachable }"
                    :title="craft.isEntryShadowed(e) ? 'Shadowed — this side already has 3 required mods, no slot left for this desired entry' : ''">{{ e.name }}</span>
                  <span v-if="(craft.modTags?.[craft.base]?.[e.name] ?? []).length" class="mod-tags">
                    <button v-for="t in (craft.modTags?.[craft.base]?.[e.name] ?? [])" :key="'tetp'+e.idx+t"
                      class="tag-chip mini filter"
                      :class="craft.tagFilters[t] || 'neutral'"
                      :style="tagStyle(t)"
                      :title="(craft.tagFilters[t] === 'include' ? 'Excluding next' : craft.tagFilters[t] === 'exclude' ? 'Resetting next' : 'Including next') + ' — ' + t"
                      @click.stop="craft.cycleTagFilter(t)">{{ t }}</button>
                  </span>
                  <button v-if="!e.disabled && !craft.targetEntryReachability(e).reachable && craft.targetEntryReachability(e).minIlvlNeeded"
                    class="restriction-chip violated clickable"
                    :title="'Raise item level to ' + craft.targetEntryReachability(e).minIlvlNeeded + ' to unlock this tier'"
                    @click="craft.setItemLevel(craft.targetEntryReachability(e).minIlvlNeeded)">ilvl ≥ {{ craft.targetEntryReachability(e).minIlvlNeeded }}</button>
                  <button class="link remove-btn" @click="craft.removeTargetEntry(e.idx)" title="remove">×</button>
                  <div v-if="!e.disabled && !craft.isEntryShadowed(e)" class="tier-band-row"
                       :title="'Slider: minimal acceptable tier. Tiers worse than this are meaningless. Click the req/des badge to toggle required vs desired.'">
                    <button type="button" class="req-badge"
                      :class="{ required: craft.isEntryEffectivelyRequired(e), implicit: craft.tierBandFor(e, craft.getAllTiers('PREFIX', e.name)).requiredTier == null && craft.isEntryEffectivelyRequired(e) }"
                      :disabled="e.disabled || (craft.tierBandFor(e, craft.getAllTiers('PREFIX', e.name)).requiredTier == null && craft.isEntryEffectivelyRequired(e))"
                      :title="craft.tierBandFor(e, craft.getAllTiers('PREFIX', e.name)).requiredTier != null ? 'Required — click to demote to desired-only' : (craft.isEntryEffectivelyRequired(e) ? 'Implicitly required: this side has 3 mods' : 'Desired — click to mark required')"
                      @click="craft.setTargetEntryRequired(e.idx, !(craft.tierBandFor(e, craft.getAllTiers('PREFIX', e.name)).requiredTier != null))">
                      {{ craft.isEntryEffectivelyRequired(e) ? 'required' : 'desired' }} {{ craft.tierOpBetter() }}
                    </button>
                    <input type="range" min="1" :max="craft.tierBandFor(e, craft.getAllTiers('PREFIX', e.name)).maxTier" step="1" class="tier-slider"
                      :class="{ required: craft.isEntryEffectivelyRequired(e) }"
                      :value="craft.tierBandFor(e, craft.getAllTiers('PREFIX', e.name)).desiredTier"
                      @change="craft.setTargetEntryTierBand(e.idx, craft.tierBandFor(e, craft.getAllTiers('PREFIX', e.name)).requiredTier == null ? null : Number($event.target.value), Number($event.target.value), craft.tierBandFor(e, craft.getAllTiers('PREFIX', e.name)).maxTier)" />
                    <span class="band-summary">T{{ craft.tierBandFor(e, craft.getAllTiers('PREFIX', e.name)).desiredTier }}</span>
                    <button v-if="e.fractured || craft.fracturedTargetIdx() === -1"
                      class="link fracture-btn"
                      :class="{ active: e.fractured }"
                      :title="e.fractured ? 'fractured target (locked) — click to unmark' : 'mark this as the fractured target (only one allowed per item)'"
                      @click="craft.setTargetEntryFractured(e.idx, !e.fractured)"><img src="./assets/fracturing-orb.svg" alt="fractured" class="orb-icon" /></button>
                    <button v-if="(e.desecrationConstraint ?? null) !== null || craft.desecrationRequiredTargetIdx() === -1 || (e.desecrationConstraint === 'require')"
                      class="link desec-btn"
                      :class="{ active: e.desecrationConstraint === 'require', forbidden: e.desecrationConstraint === 'forbid' }"
                      :title="e.desecrationConstraint === 'require' ? 'desecration REQUIRED — click to forbid'
                            : e.desecrationConstraint === 'forbid'  ? 'desecration FORBIDDEN — click to clear'
                            :                                          'click to require desecrated provenance (max one per item)'"
                      @click="craft.cycleTargetEntryDesecration(e.idx)">🦴</button>
                    <button class="pause-chip" :class="{ paused: e.disabled }"
                      :title="e.disabled ? 'Resume — re-include in analytics' : 'Pause — keep entry but exclude from analytics'"
                      @click="craft.setTargetEntryDisabled(e.idx, !e.disabled)">{{ e.disabled ? '▶' : '⏸' }}</button>
                  </div>
                  <small v-if="!e.disabled && !craft.isEntryShadowed(e)" class="tier-implies hint"
                         :title="'Worst-case roll at the chosen minimum tier — i.e. the floor any acceptable item must clear.'">
                    ≥ {{ craft.minRollAtTier(e.name, craft.tierBandFor(e, craft.getAllTiers('PREFIX', e.name)).desiredTier) }}
                  </small>
                  <div v-if="!e.disabled && !craft.isEntryShadowed(e)" class="tier-score-row">
                    <span class="hint">score per tier:</span>
                    <label v-for="t in craft.getAllTiers('PREFIX', e.name)" :key="'tps'+e.idx+t.tier"
                           :class="{ rejected: (e.tierScores?.[t.tier] ?? 0) === 0, 'ilvl-locked': !t.ilvlOk, meaningless: t.tier > craft.tierBandFor(e, craft.getAllTiers('PREFIX', e.name)).desiredTier }"
                           :title="t.tierName + ' · ilvl ' + t.ilvl + (t.ilvlOk ? '' : ' (locked: requires ilvl ' + t.ilvl + '+)') + (t.tier > craft.tierBandFor(e, craft.getAllTiers('PREFIX', e.name)).desiredTier ? ' — meaningless: outside desired band' : '')">
                      <span>T{{ t.tier }}</span>
                      <span v-if="craft.essenceableTiers('PREFIX', e.name).has(t.tier)"
                        class="essence-chip mini" title="An Essence consumable can guarantee this mod at this tier">🟢</span>
                      <input v-if="t.ilvlOk" type="number" min="0" step="0.5" class="score tier-score"
                        :value="e.tierScores?.[t.tier] ?? 0"
                        @input="craft.setTargetEntryTierScore(e.idx, t.tier, $event.target.value)" />
                      <button v-else class="restriction-chip violated clickable tier-ilvl-chip"
                        :title="'Raise item level to ' + t.ilvl + ' to unlock T' + t.tier"
                        @click="craft.setItemLevel(t.ilvl)">ilvl ≥ {{ t.ilvl }}</button>
                    </label>
                  </div>
                </template>
                <template v-else>
                  <span class="empty-explicit">— must be empty —</span>
                  <button class="link remove-btn" @click="craft.removeTargetEntry(e.idx)" title="remove">×</button>
                </template>
              </div>
              <div v-if="craft.targetBoneMod && craft.targetBoneSide === 'PREFIX'"
                   class="affix prefix bone-pending"
                   title="Goal-state allows a pending unrevealed bone-mod on this side. The Well of Souls reveal step is optional.">
                <span class="name">🦴 {{ BONE_GIBBERISH }}</span>
                <span class="affix-controls">
                  <button class="bone-swap-btn"
                    :disabled="!canSwapTargetBone"
                    :title="canSwapTargetBone ? 'Move pending bone to suffix side' : 'No free suffix slot to swap into'"
                    @click="craft.setTargetBoneSide('SUFFIX')">⇄</button>
                  <button class="link"
                    title="Remove the goal-state pending bone allowance"
                    @click="craft.setTargetBoneMod(false)">×</button>
                </span>
              </div>
            </div>
            <div class="target-side">
              <h4>Suffixes
                <small>({{ craft.targetSummary.suffixes.required }} required, {{ craft.targetSummary.suffixes.desired }} desired, {{ craft.targetSummary.suffixes.empty }}/3 empty)</small>
                <button class="link inline-add"
                  :disabled="craft.targetSummary.suffixes.empty + craft.targetSummary.suffixes.required >= 3"
                  @click="craft.addTargetEmpty('SUFFIX')"
                  :title="craft.targetSummary.suffixes.empty + craft.targetSummary.suffixes.required >= 3 ? 'No suffix slot left — required + empty already fill 3/3' : 'Require an empty suffix slot'">+ empty suffix</button>
                <button v-if="!craft.targetBoneMod" class="bone-add-btn"
                  :disabled="!canAddTargetBone('SUFFIX')"
                  :title="canAddTargetBone('SUFFIX') ? 'Allow a pending unrevealed bone-mod on the suffix side at goal time' : 'No free suffix slot'"
                  @click="craft.setTargetBoneSide('SUFFIX')">🦴 + bone</button>
              </h4>
              <div v-if="craft.targetByType.SUFFIX.length === 0" class="empty-list">— add wished suffixes via <em>+ wish</em> in the pool below —</div>
              <div v-for="e in craft.targetByType.SUFFIX" :key="'tes'+e.idx" class="affix suffix"
                   :class="{ filled: e.kind === 'mod', explicit: e.kind === 'empty', shadowed: craft.isEntryShadowed(e) }">
                <template v-if="e.kind === 'mod'">
                  <span class="name" :class="{ disabled: e.disabled || craft.isEntryShadowed(e), unreachable: !e.disabled && !craft.isEntryShadowed(e) && !craft.targetEntryReachability(e).reachable }"
                    :title="craft.isEntryShadowed(e) ? 'Shadowed — this side already has 3 required mods, no slot left for this desired entry' : ''">{{ e.name }}</span>
                  <span v-if="(craft.modTags?.[craft.base]?.[e.name] ?? []).length" class="mod-tags">
                    <button v-for="t in (craft.modTags?.[craft.base]?.[e.name] ?? [])" :key="'tets'+e.idx+t"
                      class="tag-chip mini filter"
                      :class="craft.tagFilters[t] || 'neutral'"
                      :style="tagStyle(t)"
                      :title="(craft.tagFilters[t] === 'include' ? 'Excluding next' : craft.tagFilters[t] === 'exclude' ? 'Resetting next' : 'Including next') + ' — ' + t"
                      @click.stop="craft.cycleTagFilter(t)">{{ t }}</button>
                  </span>
                  <button v-if="!e.disabled && !craft.targetEntryReachability(e).reachable && craft.targetEntryReachability(e).minIlvlNeeded"
                    class="restriction-chip violated clickable"
                    :title="'Raise item level to ' + craft.targetEntryReachability(e).minIlvlNeeded + ' to unlock this tier'"
                    @click="craft.setItemLevel(craft.targetEntryReachability(e).minIlvlNeeded)">ilvl ≥ {{ craft.targetEntryReachability(e).minIlvlNeeded }}</button>
                  <button class="link remove-btn" @click="craft.removeTargetEntry(e.idx)" title="remove">×</button>
                  <div v-if="!e.disabled && !craft.isEntryShadowed(e)" class="tier-band-row"
                       :title="'Slider: minimal acceptable tier. Tiers worse than this are meaningless. Click the req/des badge to toggle required vs desired.'">
                    <button type="button" class="req-badge"
                      :class="{ required: craft.isEntryEffectivelyRequired(e), implicit: craft.tierBandFor(e, craft.getAllTiers('SUFFIX', e.name)).requiredTier == null && craft.isEntryEffectivelyRequired(e) }"
                      :disabled="e.disabled || (craft.tierBandFor(e, craft.getAllTiers('SUFFIX', e.name)).requiredTier == null && craft.isEntryEffectivelyRequired(e))"
                      :title="craft.tierBandFor(e, craft.getAllTiers('SUFFIX', e.name)).requiredTier != null ? 'Required — click to demote to desired-only' : (craft.isEntryEffectivelyRequired(e) ? 'Implicitly required: this side has 3 mods' : 'Desired — click to mark required')"
                      @click="craft.setTargetEntryRequired(e.idx, !(craft.tierBandFor(e, craft.getAllTiers('SUFFIX', e.name)).requiredTier != null))">
                      {{ craft.isEntryEffectivelyRequired(e) ? 'required' : 'desired' }} {{ craft.tierOpBetter() }}
                    </button>
                    <input type="range" min="1" :max="craft.tierBandFor(e, craft.getAllTiers('SUFFIX', e.name)).maxTier" step="1" class="tier-slider"
                      :class="{ required: craft.isEntryEffectivelyRequired(e) }"
                      :value="craft.tierBandFor(e, craft.getAllTiers('SUFFIX', e.name)).desiredTier"
                      @change="craft.setTargetEntryTierBand(e.idx, craft.tierBandFor(e, craft.getAllTiers('SUFFIX', e.name)).requiredTier == null ? null : Number($event.target.value), Number($event.target.value), craft.tierBandFor(e, craft.getAllTiers('SUFFIX', e.name)).maxTier)" />
                    <span class="band-summary">T{{ craft.tierBandFor(e, craft.getAllTiers('SUFFIX', e.name)).desiredTier }}</span>
                    <button v-if="e.fractured || craft.fracturedTargetIdx() === -1"
                      class="link fracture-btn"
                      :class="{ active: e.fractured }"
                      :title="e.fractured ? 'fractured target (locked) — click to unmark' : 'mark this as the fractured target (only one allowed per item)'"
                      @click="craft.setTargetEntryFractured(e.idx, !e.fractured)"><img src="./assets/fracturing-orb.svg" alt="fractured" class="orb-icon" /></button>
                    <button v-if="(e.desecrationConstraint ?? null) !== null || craft.desecrationRequiredTargetIdx() === -1 || (e.desecrationConstraint === 'require')"
                      class="link desec-btn"
                      :class="{ active: e.desecrationConstraint === 'require', forbidden: e.desecrationConstraint === 'forbid' }"
                      :title="e.desecrationConstraint === 'require' ? 'desecration REQUIRED — click to forbid'
                            : e.desecrationConstraint === 'forbid'  ? 'desecration FORBIDDEN — click to clear'
                            :                                          'click to require desecrated provenance (max one per item)'"
                      @click="craft.cycleTargetEntryDesecration(e.idx)">🦴</button>
                    <button class="pause-chip" :class="{ paused: e.disabled }"
                      :title="e.disabled ? 'Resume — re-include in analytics' : 'Pause — keep entry but exclude from analytics'"
                      @click="craft.setTargetEntryDisabled(e.idx, !e.disabled)">{{ e.disabled ? '▶' : '⏸' }}</button>
                  </div>
                  <small v-if="!e.disabled && !craft.isEntryShadowed(e)" class="tier-implies hint"
                         :title="'Worst-case roll at the chosen minimum tier — i.e. the floor any acceptable item must clear.'">
                    ≥ {{ craft.minRollAtTier(e.name, craft.tierBandFor(e, craft.getAllTiers('SUFFIX', e.name)).desiredTier) }}
                  </small>
                  <div v-if="!e.disabled && !craft.isEntryShadowed(e)" class="tier-score-row">
                    <span class="hint">score per tier:</span>
                    <label v-for="t in craft.getAllTiers('SUFFIX', e.name)" :key="'tss'+e.idx+t.tier"
                           :class="{ rejected: (e.tierScores?.[t.tier] ?? 0) === 0, 'ilvl-locked': !t.ilvlOk, meaningless: t.tier > craft.tierBandFor(e, craft.getAllTiers('SUFFIX', e.name)).desiredTier }"
                           :title="t.tierName + ' · ilvl ' + t.ilvl + (t.ilvlOk ? '' : ' (locked: requires ilvl ' + t.ilvl + '+)')">
                      <span>T{{ t.tier }}</span>
                      <span v-if="craft.essenceableTiers('SUFFIX', e.name).has(t.tier)"
                        class="essence-chip mini" title="An Essence consumable can guarantee this mod at this tier">🟢</span>
                      <input v-if="t.ilvlOk" type="number" min="0" step="0.5" class="score tier-score"
                        :value="e.tierScores?.[t.tier] ?? 0"
                        @input="craft.setTargetEntryTierScore(e.idx, t.tier, $event.target.value)" />
                      <button v-else class="restriction-chip violated clickable tier-ilvl-chip"
                        :title="'Raise item level to ' + t.ilvl + ' to unlock T' + t.tier"
                        @click="craft.setItemLevel(t.ilvl)">ilvl ≥ {{ t.ilvl }}</button>
                    </label>
                  </div>
                </template>
                <template v-else>
                  <span class="empty-explicit">— must be empty —</span>
                  <button class="link remove-btn" @click="craft.removeTargetEntry(e.idx)" title="remove">×</button>
                </template>
              </div>
              <div v-if="craft.targetBoneMod && craft.targetBoneSide === 'SUFFIX'"
                   class="affix suffix bone-pending"
                   title="Goal-state allows a pending unrevealed bone-mod on this side. The Well of Souls reveal step is optional.">
                <span class="name">🦴 {{ BONE_GIBBERISH }}</span>
                <span class="affix-controls">
                  <button class="bone-swap-btn"
                    :disabled="!canSwapTargetBone"
                    :title="canSwapTargetBone ? 'Move pending bone to prefix side' : 'No free prefix slot to swap into'"
                    @click="craft.setTargetBoneSide('PREFIX')">⇄</button>
                  <button class="link"
                    title="Remove the goal-state pending bone allowance"
                    @click="craft.setTargetBoneMod(false)">×</button>
                </span>
              </div>
            </div>
            </div>
            <div class="card-tag-row" v-if="craft.tagsOnTarget().length">
              <span class="tag-filter-label">Tags on target:</span>
              <button v-for="[tag, count] in craft.tagsOnTarget()" :key="'tgt'+tag"
                class="tag-chip filter"
                :class="craft.tagFilters[tag] || 'neutral'"
                :style="tagStyle(tag)"
                :title="'Click to cycle filter (include / exclude / clear) on ' + tag"
                @click="craft.cycleTagFilter(tag)">{{ tag }} <small>×{{ count }}</small></button>
            </div>
            <footer>
              <small>Add wished mods with <em>+ wish</em> in the pool — list grows freely. <em>+ empty</em> requires an unfilled slot on that side.</small>
            </footer>
          </article>
        </div>

        <div v-if="craft.base && craft.availableTags().length" class="tag-filter-row">
          <span class="tag-filter-label">Filter by tag:</span>
          <button v-for="t in craft.availableTags()" :key="'tf'+t"
            class="tag-chip filter"
            :class="craft.tagFilters[t] || 'neutral'"
            :style="tagStyle(t)"
            :title="craft.tagFilters[t] === 'include' ? 'including only this tag — click to exclude' :
                    craft.tagFilters[t] === 'exclude' ? 'excluding this tag — click to reset' :
                    'click to include only this tag'"
            @click="craft.cycleTagFilter(t)">{{ t }}</button>
          <button v-if="Object.keys(craft.tagFilters).length"
            class="link" @click="craft.clearTagFilters()">reset all</button>
        </div>

        <details v-if="craft.base" class="all-affixes-panel"
          :open="allAffixesPanelOpen"
          @toggle="allAffixesPanelOpen = $event.target.open">
          <summary>
            📚 Browse all affixes
            <small v-if="!allAffixesPanelOpen && craft.wishlistCounts.total">— collapsed; expand to add more (you have {{ craft.wishlistCounts.total }} wished mod(s))</small>
            <small v-else-if="!allAffixesPanelOpen">— pick mods to wish for</small>
          </summary>

        <div class="pool">
          <div class="pool-column" :class="{ 'side-full': prefixesFull }">
            <h3>
              Available prefixes
              <small>
                {{ craft.availablePool.prefixes.length }} mods<span v-if="craft.showRawData"> · pool weight {{ craft.availablePool.totals.prefix.toLocaleString() }}</span><span v-if="prefixesFull"> · <em>3/3 prefix slots filled</em></span>
                · <a v-if="craft.poe2dbBaseUrl()" :href="craft.poe2dbBaseUrl()" target="_blank" rel="noopener" class="poe2db-link" title="Open this base's full mod table on poe2db">poe2db ↗</a>
                · <button class="link" @click="craft.toggleRawData()">{{ craft.showRawData ? 'hide raw data' : 'show raw data' }}</button>
              </small>
            </h3>
            <table v-if="craft.availablePool.prefixes.length">
              <thead>
                <tr>
                  <th></th>
                  <th>Mod</th>
                  <th v-if="craft.showRawData">T</th>
                  <th v-if="craft.showRawData" class="num">Weight</th>
                  <th v-if="craft.showRawData" class="num">% of pool</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="m in craft.availablePool.prefixes" :key="'pp'+m.name"
                    :class="{ wished: craft.isWished('PREFIX', m.name), 'on-item': craft.isOnStarting('PREFIX', m.name), 'side-full-row': prefixesFull && !craft.isOnStarting('PREFIX', m.name), 'ineligible': !m.ilvlOk, 'tag-filtered': m.tagFiltered }"
                    :title="m.tagFiltered ? 'Filtered out by tag selection — clear or adjust tag filters to enable' : (m.ilvlOk ? '' : 'Requires ilvl ' + m.requiredIlvl + '+')">
                  <td class="add-cell">
                    <template v-if="!craft.isOnStarting('PREFIX', m.name)">
                      <button class="link"
                        :disabled="prefixesFull || !m.ilvlOk"
                        :title="!m.ilvlOk ? 'Requires ilvl ' + m.requiredIlvl + '+' : (prefixesFull ? 'Prefix slots full (3/3)' : 'Add at best tier (T' + m.bestTier + '). Edit tier in the base-item slot afterwards.')"
                        @click="craft.addToStarting({ type: 'PREFIX', name: m.name, tier: m.bestTier, tierName: m.bestTierName, bestTier: m.bestTier, bestTierName: m.bestTierName })">+ start</button>
                    </template>
                    <span v-else class="hint">on item</span>
                  </td>
                  <td>
                    <button class="mname mod-link" :title="'Click for tier details (T1..T' + m.tiersTotal + ')'"
                      @click="openModModal(m)">{{ m.name }}</button>
                    <span v-if="essenceableNamesBySide.PREFIX.has(m.name)"
                      class="essence-chip"
                      :class="{ 'tier-mismatch': essenceTierMismatch.PREFIX.has(m.name) }"
                      :title="essenceTierMismatch.PREFIX.has(m.name)
                        ? 'Essence reaches T' + essenceTierMismatch.PREFIX.get(m.name).bestEssT + ' but you require T' + essenceTierMismatch.PREFIX.get(m.name).requiredT + ' or better — essence cannot satisfy this wish'
                        : 'An Essence consumable can guarantee this mod on the prefix side'">🟢</span>
                    <button v-if="essenceTierMismatch.PREFIX.has(m.name)"
                      class="restriction-chip violated clickable"
                      :title="'Click to lower required tier to T' + essenceTierMismatch.PREFIX.get(m.name).bestEssT + ' (the best tier the essence can reach)'"
                      @click="lowerRequiredTierForEssence('PREFIX', m.name)">tier ≤ T{{ essenceTierMismatch.PREFIX.get(m.name).bestEssT }}</button>
                    <span v-if="desecratedNames.has(m.name)" class="desecrated-chip" title="Also rollable via Desecrated currencies (Bones)">💀</span>
                    <button v-if="!m.ilvlOk" class="restriction-chip violated clickable"
                      :title="'Raise item level to ' + m.requiredIlvl + ' to unlock this modifier'"
                      @click="craft.setItemLevel(m.requiredIlvl)">ilvl ≥ {{ m.requiredIlvl }}</button>
                    <span v-if="m.tags && m.tags.length" class="mod-tags">
                      <button v-for="t in m.tags" :key="'mt'+m.name+t"
                        class="tag-chip mini filter"
                        :class="craft.tagFilters[t] || 'neutral'"
                        :style="tagStyle(t)"
                        :title="(craft.tagFilters[t] === 'include' ? 'Excluding next' : craft.tagFilters[t] === 'exclude' ? 'Resetting next' : 'Including next') + ' — ' + t"
                        @click.stop="craft.cycleTagFilter(t)">{{ t }}</button>
                    </span>
                  </td>
                  <td v-if="craft.showRawData">T{{ m.bestTier }}<small v-if="m.tiersAvailable < m.tiersTotal">/{{ m.tiersTotal }}</small></td>
                  <td v-if="craft.showRawData" class="num">{{ m.totalWeight.toLocaleString() }}</td>
                  <td v-if="craft.showRawData" class="num">{{ (100 * m.totalWeight / craft.availablePool.totals.prefix).toFixed(2) }}%</td>
                  <td class="wishcell">
                    <template v-if="!craft.isWished('PREFIX', m.name)">
                      <button class="link"
                        :disabled="!m.ilvlOk || m.tagFiltered"
                        :title="m.tagFiltered ? 'Filtered out by tag selection' : (!m.ilvlOk ? 'Requires ilvl ' + m.requiredIlvl + '+' : 'Add to wishlist at highest tier (T' + m.bestTier + '). Edit min-tier on the entry afterwards.')"
                        @click="craft.addTargetMod('PREFIX', m.name, m.bestTier, m.eligibleTiers)">+ wish</button>
                    </template>
                    <span v-else class="hint wished-tag" title="Remove from the desired-item panel above to un-wish">★ wished</span>
                  </td>
                </tr>
              </tbody>
            </table>
            <p v-else class="empty">No prefixes spawn at ilvl {{ craft.itemLevel }}.</p>
          </div>

          <div class="pool-column" :class="{ 'side-full': suffixesFull }">
            <h3>
              Available suffixes
              <small>
                {{ craft.availablePool.suffixes.length }} mods<span v-if="craft.showRawData"> · pool weight {{ craft.availablePool.totals.suffix.toLocaleString() }}</span><span v-if="suffixesFull"> · <em>3/3 suffix slots filled</em></span>
                · <a v-if="craft.poe2dbBaseUrl()" :href="craft.poe2dbBaseUrl()" target="_blank" rel="noopener" class="poe2db-link" title="Open this base's full mod table on poe2db">poe2db ↗</a>
              </small>
            </h3>
            <table v-if="craft.availablePool.suffixes.length">
              <thead>
                <tr>
                  <th></th>
                  <th>Mod</th>
                  <th v-if="craft.showRawData">T</th>
                  <th v-if="craft.showRawData" class="num">Weight</th>
                  <th v-if="craft.showRawData" class="num">% of pool</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="m in craft.availablePool.suffixes" :key="'sp'+m.name"
                    :class="{ wished: craft.isWished('SUFFIX', m.name), 'on-item': craft.isOnStarting('SUFFIX', m.name), 'side-full-row': suffixesFull && !craft.isOnStarting('SUFFIX', m.name), 'ineligible': !m.ilvlOk, 'tag-filtered': m.tagFiltered }"
                    :title="m.tagFiltered ? 'Filtered out by tag selection — clear or adjust tag filters to enable' : (m.ilvlOk ? '' : 'Requires ilvl ' + m.requiredIlvl + '+')">
                  <td class="add-cell">
                    <template v-if="!craft.isOnStarting('SUFFIX', m.name)">
                      <button class="link"
                        :disabled="suffixesFull || !m.ilvlOk"
                        :title="!m.ilvlOk ? 'Requires ilvl ' + m.requiredIlvl + '+' : (suffixesFull ? 'Suffix slots full (3/3)' : 'Add at best tier (T' + m.bestTier + '). Edit tier in the base-item slot afterwards.')"
                        @click="craft.addToStarting({ type: 'SUFFIX', name: m.name, tier: m.bestTier, tierName: m.bestTierName, bestTier: m.bestTier, bestTierName: m.bestTierName })">+ start</button>
                    </template>
                    <span v-else class="hint">on item</span>
                  </td>
                  <td>
                    <button class="mname mod-link" :title="'Click for tier details (T1..T' + m.tiersTotal + ')'"
                      @click="openModModal(m)">{{ m.name }}</button>
                    <span v-if="essenceableNamesBySide.SUFFIX.has(m.name)"
                      class="essence-chip"
                      :class="{ 'tier-mismatch': essenceTierMismatch.SUFFIX.has(m.name) }"
                      :title="essenceTierMismatch.SUFFIX.has(m.name)
                        ? 'Essence reaches T' + essenceTierMismatch.SUFFIX.get(m.name).bestEssT + ' but you require T' + essenceTierMismatch.SUFFIX.get(m.name).requiredT + ' or better — essence cannot satisfy this wish'
                        : 'An Essence consumable can guarantee this mod on the suffix side'">🟢</span>
                    <button v-if="essenceTierMismatch.SUFFIX.has(m.name)"
                      class="restriction-chip violated clickable"
                      :title="'Click to lower required tier to T' + essenceTierMismatch.SUFFIX.get(m.name).bestEssT + ' (the best tier the essence can reach)'"
                      @click="lowerRequiredTierForEssence('SUFFIX', m.name)">tier ≤ T{{ essenceTierMismatch.SUFFIX.get(m.name).bestEssT }}</button>
                    <span v-if="desecratedNames.has(m.name)" class="desecrated-chip" title="Also rollable via Desecrated currencies (Bones)">💀</span>
                    <button v-if="!m.ilvlOk" class="restriction-chip violated clickable"
                      :title="'Raise item level to ' + m.requiredIlvl + ' to unlock this modifier'"
                      @click="craft.setItemLevel(m.requiredIlvl)">ilvl ≥ {{ m.requiredIlvl }}</button>
                    <span v-if="m.tags && m.tags.length" class="mod-tags">
                      <button v-for="t in m.tags" :key="'mt'+m.name+t"
                        class="tag-chip mini filter"
                        :class="craft.tagFilters[t] || 'neutral'"
                        :style="tagStyle(t)"
                        :title="(craft.tagFilters[t] === 'include' ? 'Excluding next' : craft.tagFilters[t] === 'exclude' ? 'Resetting next' : 'Including next') + ' — ' + t"
                        @click.stop="craft.cycleTagFilter(t)">{{ t }}</button>
                    </span>
                  </td>
                  <td v-if="craft.showRawData">T{{ m.bestTier }}<small v-if="m.tiersAvailable < m.tiersTotal">/{{ m.tiersTotal }}</small></td>
                  <td v-if="craft.showRawData" class="num">{{ m.totalWeight.toLocaleString() }}</td>
                  <td v-if="craft.showRawData" class="num">{{ (100 * m.totalWeight / craft.availablePool.totals.suffix).toFixed(2) }}%</td>
                  <td class="wishcell">
                    <template v-if="!craft.isWished('SUFFIX', m.name)">
                      <button class="link"
                        :disabled="!m.ilvlOk || m.tagFiltered"
                        :title="m.tagFiltered ? 'Filtered out by tag selection' : (!m.ilvlOk ? 'Requires ilvl ' + m.requiredIlvl + '+' : 'Add to wishlist at highest tier (T' + m.bestTier + '). Edit min-tier on the entry afterwards.')"
                        @click="craft.addTargetMod('SUFFIX', m.name, m.bestTier, m.eligibleTiers)">+ wish</button>
                    </template>
                    <span v-else class="hint wished-tag" title="Remove from the desired-item panel above to un-wish">★ wished</span>
                  </td>
                </tr>
              </tbody>
            </table>
            <p v-else class="empty">No suffixes spawn at ilvl {{ craft.itemLevel }}.</p>
          </div>
        </div>

        <details class="extra-pool" open
          v-if="craft.base && groupedEssences.length">
          <summary>
            🟢 Essence-guaranteed modifiers
            <small>{{ groupedEssences.length }} mods · forced by an Essence consumable</small>
            <a class="ext-link mini" :href="poedbEconomyUrl('Essences')"
               target="_blank" rel="noopener" @click.stop>↗ poe2db</a>
          </summary>
          <p class="hint">
            <strong>Lesser / Normal / Greater</strong> apply only to a
            <strong>Magic</strong> item and upgrade it to a 4-affix Rare.
            <strong>Perfect</strong> essences apply only to an existing
            <strong>Rare</strong> item. Click a modifier name to see
            the per-tier roll ranges in a modal.
          </p>
          <!-- Special-case row for Essence of the Abyss → Mark of the
               Abyssal Lord. The Mark is a placeholder, not a prefix
               or suffix; it inherits the side of whatever affix it
               replaced (random by default, or steered by Sinistral /
               Dextral Crystallisation). Render full-width so it's
               not shoehorned into the side-split table. -->
          <div class="pool extra-pool-cols">
            <div class="pool-column">
              <h3>Essence-able prefixes <small>{{ essencesBySide.PREFIX.length }}</small></h3>
              <table v-if="essencesBySide.PREFIX.length" class="extra-pool-table">
                <thead><tr><th></th><th>Modifier</th><th></th></tr></thead>
                <tbody>
                  <template v-for="(row, i) in essencesBySide.PREFIX" :key="row.key">
                  <tr class="essence-mod-row" :class="{ 'tag-filtered': row.tagFiltered, wished: craft.isWished('PREFIX', row.text) }">
                    <td class="add-cell">
                      <button class="link"
                        :disabled="row.tagFiltered || prefixesFull || craft.isOnStarting('PREFIX', row.text)"
                        :title="row.tagFiltered ? 'Filtered out by tag selection' : craft.isOnStarting('PREFIX', row.text) ? 'Already on item' : (prefixesFull ? 'Prefix slots full' : 'Add as starting affix')"
                        @click="craft.addToStarting({ type: 'PREFIX', name: row.text, tier: 1, tierName: row.family, bestTier: 1, bestTierName: row.family })">+ start</button>
                    </td>
                    <td>
                      <button class="mname mod-link"
                        title="Click to see per-tier roll ranges"
                        @click="openEssenceModal(row)">{{ row.text }}</button>
                      <span class="essence-chip" title="Reachable via Essence">🟢</span>
                      <div v-if="row.tags?.length" class="mod-tags">
                        <button v-for="t in row.tags" :key="'ept'+i+t"
                          class="tag-chip mini filter"
                          :class="craft.tagFilters[t] || 'neutral'"
                          :style="tagStyle(t)"
                          @click.stop="craft.cycleTagFilter(t)">{{ t }}</button>
                      </div>
                    </td>
                    <td class="wishcell">
                      <button v-if="!craft.isWished('PREFIX', row.text)"
                        class="link"
                        :disabled="row.tagFiltered"
                        :title="row.tagFiltered ? 'Filtered out by tag selection' : 'Add to wishlist (prefix)'"
                        @click="craft.addTargetMod('PREFIX', row.text, 1, [])">+ wish</button>
                      <span v-else class="hint wished-tag">★ wished</span>
                    </td>
                  </tr>
                  <tr class="essence-family-row" :class="{ 'tag-filtered': row.tagFiltered }">
                    <td></td>
                    <td colspan="2" class="tname">
                      <small class="hint">via</small>
                      {{ row.family }}
                      <a class="ext-link mini" :href="poedbItemUrl(row.family)"
                         target="_blank" rel="noopener" @click.stop>↗ db</a>
                      <a class="ext-link mini" :href="wikiUrl(row.family)"
                         target="_blank" rel="noopener" @click.stop>↗ wiki</a>
                    </td>
                  </tr>
                  </template>
                </tbody>
              </table>
              <p v-else class="empty">No essence-able prefixes match the current filter.</p>
            </div>
            <div class="pool-column">
              <h3>Essence-able suffixes <small>{{ essencesBySide.SUFFIX.length }}</small></h3>
              <table v-if="essencesBySide.SUFFIX.length" class="extra-pool-table">
                <thead><tr><th></th><th>Modifier</th><th></th></tr></thead>
                <tbody>
                  <template v-for="(row, i) in essencesBySide.SUFFIX" :key="row.key">
                  <tr class="essence-mod-row" :class="{ 'tag-filtered': row.tagFiltered, wished: craft.isWished('SUFFIX', row.text) }">
                    <td class="add-cell">
                      <button class="link"
                        :disabled="row.tagFiltered || suffixesFull || craft.isOnStarting('SUFFIX', row.text)"
                        :title="row.tagFiltered ? 'Filtered out by tag selection' : craft.isOnStarting('SUFFIX', row.text) ? 'Already on item' : (suffixesFull ? 'Suffix slots full' : 'Add as starting affix')"
                        @click="craft.addToStarting({ type: 'SUFFIX', name: row.text, tier: 1, tierName: row.family, bestTier: 1, bestTierName: row.family })">+ start</button>
                    </td>
                    <td>
                      <button class="mname mod-link"
                        title="Click to see per-tier roll ranges"
                        @click="openEssenceModal(row)">{{ row.text }}</button>
                      <span class="essence-chip" title="Reachable via Essence">🟢</span>
                      <div v-if="row.tags?.length" class="mod-tags">
                        <button v-for="t in row.tags" :key="'est'+i+t"
                          class="tag-chip mini filter"
                          :class="craft.tagFilters[t] || 'neutral'"
                          :style="tagStyle(t)"
                          @click.stop="craft.cycleTagFilter(t)">{{ t }}</button>
                      </div>
                    </td>
                    <td class="wishcell">
                      <button v-if="!craft.isWished('SUFFIX', row.text)"
                        class="link"
                        :disabled="row.tagFiltered"
                        :title="row.tagFiltered ? 'Filtered out by tag selection' : 'Add to wishlist (suffix)'"
                        @click="craft.addTargetMod('SUFFIX', row.text, 1, [])">+ wish</button>
                      <span v-else class="hint wished-tag">★ wished</span>
                    </td>
                  </tr>
                  <tr class="essence-family-row" :class="{ 'tag-filtered': row.tagFiltered }">
                    <td></td>
                    <td colspan="2" class="tname">
                      <small class="hint">via</small>
                      {{ row.family }}
                      <a class="ext-link mini" :href="poedbItemUrl(row.family)"
                         target="_blank" rel="noopener" @click.stop>↗ db</a>
                      <a class="ext-link mini" :href="wikiUrl(row.family)"
                         target="_blank" rel="noopener" @click.stop>↗ wiki</a>
                    </td>
                  </tr>
                  </template>
                </tbody>
              </table>
              <p v-else class="empty">No essence-able suffixes match the current filter.</p>
            </div>
          </div>
          <!-- Essence of the Abyss → Mark of the Abyssal Lord lives
               at the bottom: it's a special-case placeholder (neither
               prefix nor suffix; inherits whatever affix it replaces),
               not part of the routine prefix/suffix table. Rendering
               below the side-split keeps the user's eye on the
               common-case essences first. -->
          <div v-for="row in essencesBySide.ABYSS" :key="row.key" class="abyss-row">
            <div class="abyss-banner">
              <span class="abyss-icon" aria-hidden="true">⚫</span>
              <div class="abyss-meta">
                <button class="mname mod-link"
                  title="Click to see per-tier roll ranges"
                  @click="openEssenceModal(row)">{{ row.text }}</button>
                <small class="hint">
                  {{ row.family }} · neither prefix nor suffix —
                  inherits the side of whatever affix it replaces
                  (random; steerable with Sinistral / Dextral
                  Crystallisation omens)
                </small>
                <div v-if="row.tags?.length" class="mod-tags">
                  <button v-for="t in row.tags" :key="'abt'+t"
                    class="tag-chip mini filter"
                    :class="craft.tagFilters[t] || 'neutral'"
                    :style="tagStyle(t)"
                    @click.stop="craft.cycleTagFilter(t)">{{ t }}</button>
                </div>
              </div>
              <a class="ext-link mini" :href="poedbItemUrl(row.family)"
                 target="_blank" rel="noopener">↗ db</a>
              <a class="ext-link mini" :href="wikiUrl(row.family)"
                 target="_blank" rel="noopener">↗ wiki</a>
            </div>
          </div>
          <details v-if="essencesBySide.unknown.length" class="extra-pool-unknown">
            <summary>{{ essencesBySide.unknown.length }} mods with unknown side</summary>
            <ul class="extra-mod-list">
              <li v-for="(row, i) in essencesBySide.unknown" :key="row.key">
                <span class="tname">{{ row.family }}</span>
                <button class="mname mod-link" @click="openEssenceModal(row)">{{ row.text }}</button>
              </li>
            </ul>
          </details>
        </details>

        <details class="extra-pool"
          v-if="craft.base && groupedDesecrated.length">
          <summary>
            💀 Desecrated modifiers
            <small>{{ groupedDesecrated.length }} mods · only roll on Desecrated items (apply a Bone-class currency)</small>
            <a class="ext-link mini" :href="poedbEconomyUrl('Soul_Cores')"
               target="_blank" rel="noopener" @click.stop>↗ poe2db</a>
          </summary>
          <div v-if="desecratedFamilyTags.length" class="tag-filter-row">
            <span class="tag-filter-label">Desecrated source:</span>
            <button v-for="t in desecratedFamilyTags" :key="'dft'+t"
              class="tag-chip filter"
              :class="craft.tagFilters[t] || 'neutral'"
              :style="tagStyle(t)"
              :title="craft.tagFilters[t] === 'include' ? 'including only this source — click to exclude' : craft.tagFilters[t] === 'exclude' ? 'excluding this source — click to reset' : 'click to include only this source'"
              @click="craft.cycleTagFilter(t)">{{ t.replace(/_mod$/, '') }}</button>
          </div>
          <div class="pool extra-pool-cols">
            <div class="pool-column">
              <h3>Desecrated prefixes <small>{{ desecratedBySide.PREFIX.length }}</small></h3>
              <table v-if="desecratedBySide.PREFIX.length" class="extra-pool-table">
                <thead><tr><th></th><th>Modifier</th><th></th></tr></thead>
                <tbody>
                  <tr v-for="(row, i) in desecratedBySide.PREFIX" :key="row.key"
                      :class="{ 'tag-filtered': row.tagFiltered }">
                    <td class="add-cell">
                      <button class="link"
                        :disabled="row.tagFiltered || prefixesFull || craft.isOnStarting('PREFIX', row.text)"
                        :title="row.tagFiltered ? 'Filtered out by tag selection' : craft.isOnStarting('PREFIX', row.text) ? 'Already on item' : (prefixesFull ? 'Prefix slots full' : 'Add as starting affix')"
                        @click="craft.addToStarting({ type: 'PREFIX', name: row.text, tier: 1, tierName: row.tierName, bestTier: 1, bestTierName: row.tierName })">+ start</button>
                    </td>
                    <td>
                      <button class="mname mod-link"
                        title="Click to see roll range and source"
                        @click="openDesecratedModal(row)">{{ row.text }}</button>
                      <div v-if="row.tags?.length" class="mod-tags">
                        <button v-for="t in row.tags" :key="'dpt'+i+t"
                          class="tag-chip mini filter"
                          :class="craft.tagFilters[t] || 'neutral'"
                          :style="tagStyle(t)"
                          @click.stop="craft.cycleTagFilter(t)">{{ t }}</button>
                      </div>
                    </td>
                    <td class="wishcell">
                      <button v-if="!craft.isWished('PREFIX', row.text)"
                        class="link"
                        :disabled="row.tagFiltered"
                        :title="row.tagFiltered ? 'Filtered out by tag selection' : 'Add to wishlist (prefix)'"
                        @click="craft.addTargetMod('PREFIX', row.text, 1, [])">+ wish</button>
                      <span v-else class="hint wished-tag">★ wished</span>
                    </td>
                  </tr>
                </tbody>
              </table>
              <p v-else class="empty">No desecrated prefixes.</p>
            </div>
            <div class="pool-column">
              <h3>Desecrated suffixes <small>{{ desecratedBySide.SUFFIX.length }}</small></h3>
              <table v-if="desecratedBySide.SUFFIX.length" class="extra-pool-table">
                <thead><tr><th></th><th>Modifier</th><th></th></tr></thead>
                <tbody>
                  <tr v-for="(row, i) in desecratedBySide.SUFFIX" :key="row.key"
                      :class="{ 'tag-filtered': row.tagFiltered }">
                    <td class="add-cell">
                      <button class="link"
                        :disabled="row.tagFiltered || suffixesFull || craft.isOnStarting('SUFFIX', row.text)"
                        :title="row.tagFiltered ? 'Filtered out by tag selection' : craft.isOnStarting('SUFFIX', row.text) ? 'Already on item' : (suffixesFull ? 'Suffix slots full' : 'Add as starting affix')"
                        @click="craft.addToStarting({ type: 'SUFFIX', name: row.text, tier: 1, tierName: row.tierName, bestTier: 1, bestTierName: row.tierName })">+ start</button>
                    </td>
                    <td>
                      <button class="mname mod-link"
                        title="Click to see roll range and source"
                        @click="openDesecratedModal(row)">{{ row.text }}</button>
                      <div v-if="row.tags?.length" class="mod-tags">
                        <button v-for="t in row.tags" :key="'dst'+i+t"
                          class="tag-chip mini filter"
                          :class="craft.tagFilters[t] || 'neutral'"
                          :style="tagStyle(t)"
                          @click.stop="craft.cycleTagFilter(t)">{{ t }}</button>
                      </div>
                    </td>
                    <td class="wishcell">
                      <button v-if="!craft.isWished('SUFFIX', row.text)"
                        class="link"
                        :disabled="row.tagFiltered"
                        :title="row.tagFiltered ? 'Filtered out by tag selection' : 'Add to wishlist (suffix)'"
                        @click="craft.addTargetMod('SUFFIX', row.text, 1, [])">+ wish</button>
                      <span v-else class="hint wished-tag">★ wished</span>
                    </td>
                  </tr>
                </tbody>
              </table>
              <p v-else class="empty">No desecrated suffixes.</p>
            </div>
          </div>
          <details v-if="desecratedBySide.unknown.length" class="extra-pool-unknown">
            <summary>{{ desecratedBySide.unknown.length }} mods with unknown side <small>(not visible in the regular pool — manual side disambiguation needed)</small></summary>
            <ul class="extra-mod-list">
              <li v-for="(row, i) in desecratedBySide.unknown" :key="row.key">
                <span class="tname">{{ row.tierName }}</span>
                <button class="mname mod-link" @click="openDesecratedModal(row)">{{ row.text }}</button>
              </li>
            </ul>
          </details>
        </details>
        </details>

        <!-- ─── Recipe DSL (paste-able human-readable target spec) ─── -->
        <!-- Round-trips with the rest of the UI: Export fills the box
             with the current craft, Import parses a pasted recipe
             and applies it. Lets the user share a craft target in
             chat / a forum post and round-trip it back. Format docs
             in engine/recipe-syntax.js. The earlier version of this
             comment used backticks around the path, which terminated
             the surrounding JS template literal and threw a runtime
             SyntaxError — keep this comment backtick-free. -->
        <details v-if="craft.base" class="recipe-panel">
          <summary>📝 Recipe (paste-able DSL)</summary>
          <p class="hint">
            Human-readable text format for the target craft. Paste a
            recipe into the box and click Import to load it; click
            Export to fill the box with the current craft state.
          </p>
          <div class="recipe-toolbar">
            <button class="link" @click="recipeExport">Export current craft</button>
            <button class="link" @click="recipeImport" :disabled="!recipeText.trim()">Import pasted recipe</button>
            <span v-if="recipeStatus" class="hint" :style="recipeStatus.kind === 'err' ? 'color:#d96' : 'color:#5d9'">
              {{ recipeStatus.message }}
            </span>
          </div>
          <textarea v-model="recipeText" rows="14" class="recipe-textarea"
            placeholder="# PoE2 Crafter recipe&#10;type: Bow&#10;base: BOW&#10;ilvl: 84&#10;budget_ex: 50000&#10;filled: 1..1&#10;required_hits: 1&#10;&#10;# Affixes (P=Prefix, S=Suffix; Tn+ = min tier; flags: req frac)&#10;S T1+ &quot;#% Surpassing chance to fire an additional Arrow&quot; req frac"></textarea>
        </details>

        <div v-if="craft.base" class="wishlist-summary">
          <h3>Strategy comparison</h3>
          <p class="hint">
            <strong>{{ craft.wishlistCounts.total }}</strong> wished mod(s)
            ({{ craft.wishlistCounts.prefixes }}P / {{ craft.wishlistCounts.suffixes }}S)
          </p>

          <!-- Cost / time / budget inputs — lifted out of the strategies
               results panel so the user can edit them BEFORE clicking
               "Evaluate strategies" or "Solve MDP". Both downstream
               panels read these (totalBudgetEx feeds MDP's per-orb
               budget gating + breakeven recommendation; timeWeightExPerSec
               feeds V* unification; actionCostCapEx prunes expensive
               niche strategies). Earlier these were buried under the
               strategies results, so a fresh user couldn't tune the
               budget without first running an irrelevant evaluation. -->
          <div class="base-pricing" v-if="craft.targetEntries.length || Object.keys(craft.wishlist).length">
            <label class="field inline">
              <span>Total budget ({{ budgetUnit === 'div' ? 'Div' : 'Ex' }})</span>
              <input type="number" min="0" step="any"
                :value="budgetDisplayValue"
                placeholder="∞"
                @input="setBudgetFromInput($event.target.value)" />
              <small class="hint">
                default 1,870 ex ≈ 10 div · stop-loss for most players
                <span v-if="divToEx && Number.isFinite(craft.totalBudgetEx)">
                  · current =
                  {{ budgetUnit === 'div'
                      ? craft.totalBudgetEx.toFixed(0) + ' ex'
                      : (craft.totalBudgetEx / divToEx).toFixed(1) + ' div' }}
                </span>
              </small>
            </label>
            <label class="field inline">
              <span>Total time (h)</span>
              <input type="number" min="0" step="any"
                :value="Number.isFinite(craft.totalTimeSec) ? (craft.totalTimeSec / 3600).toFixed(2) : ''"
                placeholder="∞"
                @input="craft.setTotalTimeHours($event.target.value)" />
              <small class="hint">stop-loss in wall-clock hours</small>
            </label>
            <label class="field inline" v-if="false"
              title="Distinct from Total budget. Per-action cap is a per-orb sticker-price filter applied at solver time: any single orb whose unit price exceeds this cap is dropped from the action set entirely, even if total budget could accommodate it. Use to model 'I refuse to push a button that costs more than X ex even once' — typically to exclude Fracturing Orbs (~10k ex) or Perfect-tier orbs from low-stakes crafts. Leave empty (∞) to let the solver consider every orb.">
              <span>Per-action cap (Ex)</span>
              <input type="number" min="0" step="any"
                :value="Number.isFinite(craft.actionCostCapEx) ? craft.actionCostCapEx : ''"
                placeholder="∞"
                @input="craft.setActionCostCapEx($event.target.value)" />
              <small class="hint">
                drops any orb whose <em>unit price</em> exceeds this — e.g. set 100
                to forbid Fracturing Orbs (~10k ex) from the action set. Differs
                from <em>Total budget</em>, which truncates the run after that
                much spent <em>cumulatively</em>.
              </small>
            </label>
            <label class="field inline" v-if="false">
              <!-- Now lives in the rates panel as the virtual
                   "Player time (1s)" currency under the Meta group;
                   editing it there writes through to
                   timeWeightExPerSec via setRate's special branch. -->
              <span>Time → Ex (ex/sec)</span>
              <input type="number" min="0" step="0.01"
                :value="craft.timeWeightExPerSec"
                placeholder="0.1"
                @input="craft.setTimeWeightExPerSec($event.target.value)" />
              <small class="hint">unifies time + currency in V*; default 0.1 ⇒ 1 ex ≈ 10 sec. Set 0 to ignore time.</small>
            </label>
          </div>

          <details class="analytics secondary" v-if="false">
            <summary>Closed-form strategies (hidden)</summary>
          </details>

          <!-- Closed-form whole-game strategies block intentionally
               removed from the template. The MDP solver below is the
               headline cost number; the closed-form table was
               sanity-check noise users didn't need. To bring it back,
               restore the markup from git history. -->
          <!-- Strategies header / Evaluate button block intentionally
               removed (was inside v-if="false"); the markup contained
               an orphan <summary> outside any <details>, which Vue
               warned about at compile time. Restore from git history
               if the closed-form panel ever returns. -->
          <div class="analytics" v-if="craft.strategiesResults">
            <h4 style="display:none">Compare strategies</h4>

            <div v-if="craft.mechanicsWarnings.usedDeprecated.length" class="warning-banner deprecated-banner">
              <button class="banner-close" title="Disable all deprecated mechanics — restores current-game baseline"
                @click="craft.dropDeprecatedOverrides()">×</button>
              ⚠️ <strong>What-if mode:</strong> these cost estimates use
              <strong>deprecated mechanic(s)</strong> the user has re-enabled —
              <em>{{ craft.mechanicsWarnings.usedDeprecated.map(w => w.name).join(', ') }}</em>.
              Numbers below do <strong>not</strong> reflect current-game costs.
            </div>
            <div v-if="craft.mechanicsWarnings.excludedAvailable.length" class="warning-banner excluded-banner">
              <button class="banner-close" title="Re-enable all currently-available mechanics — restores baseline"
                @click="craft.restoreDisabledMechanics()">×</button>
              ℹ️ <strong>Restricted mode:</strong> these estimates exclude
              currently-available mechanic(s) you've disabled —
              <em>{{ craft.mechanicsWarnings.excludedAvailable.map(w => w.name).join(', ') }}</em>.
              Numbers below assume you don't use these.
            </div>
            <p class="hint" v-if="craft.startingHits">
              Starting item already carries <strong>{{ craft.startingHits }}</strong> wished mod(s)
              ({{ craft.startingCounts.prefixes }}P + {{ craft.startingCounts.suffixes }}S filled);
              strategies condition on this state.
            </p>

            <table class="strategies">
              <thead>
                <tr>
                  <th>Strategy</th>
                  <th class="num primary">★ P succeed within budget</th>
                  <th class="num">P / attempt</th>
                  <th class="num">E[attempts]</th>
                  <th class="num">E[cost]</th>
                  <th class="num">E[time]</th>
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(s, i) in craft.strategiesAnalytics" :key="s.id"
                    :class="{ unavailable: !s.available, best: i === 0 && s.available, 'over-cap': s.overBudget || s.overTime }">
                  <td>
                    <details class="strategy-detail" v-if="s.description">
                      <summary><strong>{{ s.label }}</strong></summary>
                      <p class="strategy-description">{{ s.description }}</p>
                      <p v-if="s.notes" class="strategy-notes-detail">{{ s.notes }}</p>
                      <details v-if="s.chain" class="chain-detail">
                        <summary>▶ Markov chain ({{ s.chain.states.length }} states · {{ s.chain.edges.length }} edges)</summary>
                        <CytoscapeChain v-if="chainRenderer === 'cytoscape'" :chain="s.chain" />
                        <MermaidChain v-else :chain="s.chain" />
                      </details>
                    </details>
                    <strong v-else>{{ s.label }}</strong>
                    <span v-if="s.overBudget" class="cap-badge over-budget" title="Expected cost exceeds total budget">over budget</span>
                    <span v-if="s.overTime" class="cap-badge over-time" title="Expected time exceeds total time cap">over time</span>
                    <span v-if="!s.available && /missing rate/.test(s.notes ?? '')" class="missing-rate-link">
                      <a href="#rates-panel" @click.prevent="document.getElementById('rates-panel')?.scrollIntoView({ behavior: 'smooth' })">↓ jump to rates panel</a>
                    </span>
                  </td>
                  <template v-if="s.available">
                    <td class="num primary" :class="{ 'p-low': s.pWithinCaps !== undefined && s.pWithinCaps < 0.5, 'p-high': s.pWithinCaps !== undefined && s.pWithinCaps >= 0.8 }">
                      <span v-if="s.pWithinCaps !== undefined"><strong>{{ fmt.pct(s.pWithinCaps) }}</strong></span>
                      <span v-else class="hint">—</span>
                      <small v-if="s.permittedAttempts !== null && Number.isFinite(s.permittedAttempts)"
                        class="att-count" :title="attemptMeaning(s.id)">
                        ({{ s.permittedAttempts }} att.)
                      </small>
                    </td>
                    <td class="num">{{ fmt.pct(s.p) }}</td>
                    <td class="num">{{ fmt.num(s.expectedAttempts) }}</td>
                    <td class="num">{{ fmtCost(s.expectedCostEx) }}</td>
                    <td class="num">{{ fmtTime(s.expectedTimeSec) }}</td>
                    <td><small>{{ s.notes || '' }}</small></td>
                  </template>
                  <template v-else>
                    <td class="num primary">—</td><td class="num">—</td><td class="num">—</td><td class="num">—</td><td class="num">—</td>
                    <td><small>{{ s.notes }}</small></td>
                  </template>
                </tr>
              </tbody>
            </table>
            <p class="hint">
              Same-family exclusion approximated by mod-name match (correct for
              non-hybrid mods); chaos-spam uses an abstract Markov chain over
              the wished-count state. Base-procurement cost not included.
            </p>
            <p class="hint analytics-stub">
              <strong>Note:</strong> these costs assume each strategy is a
              <em>whole-game commitment</em>. The mixed-policy MDP solver
              below picks the best action per state — its V* should be a
              tighter lower bound on what a careful crafter actually pays.
            </p>
          </div>

          <!-- ============================================================ -->
          <!-- MDP-α: optimal mixed-policy solver. Fast for small wishlists -->
          <!-- (≤8 wished entries); user runs on demand, separate from the  -->
          <!-- closed-form comparison table.                                -->
          <!-- ============================================================ -->
          <div class="analytics mdp-panel headline" v-if="craft.targetEntries.length || Object.keys(craft.wishlist).length">
            <details open class="orb-disable-panel">
              <summary>
                🔧 Action set <small class="hint">— untick to exclude an orb from the engine ({{ Object.keys(craft.disabledOrbs ?? {}).length }} disabled)</small>
                <button v-if="Object.keys(craft.disabledOrbs ?? {}).length" class="link"
                  @click.stop.prevent="craft.resetOrbDisabled(); craft.solveMdp();"
                  title="Re-enable every orb">reset</button>
              </summary>
              <div class="ccy-chip-families">
                <div v-for="g in orbsByFamily" :key="'fam-'+g.family" class="ccy-chip-family">
                  <h6 :title="'Toggle all ' + g.family + ' variants at once'"
                    @click="g.orbs.forEach(o => craft.setOrbDisabled(o.id, g.orbs.every(x => !(craft.disabledOrbs ?? {})[x.id]))); craft.solveMdp();">
                    {{ g.family }}
                    <small v-if="g.orbs.some(o => (craft.disabledOrbs ?? {})[o.id])" class="hint">
                      ({{ g.orbs.filter(o => !(craft.disabledOrbs ?? {})[o.id]).length }}/{{ g.orbs.length }})
                    </small>
                  </h6>
                  <div class="ccy-chip-row">
                    <button v-for="o in g.orbs" :key="'orb-'+o.id" type="button"
                      class="ccy-chip has-tip"
                      :class="{ disabled: (craft.disabledOrbs ?? {})[o.id] }"
                      @click="craft.setOrbDisabled(o.id, !(craft.disabledOrbs ?? {})[o.id]); craft.solveMdp();">
                      <span class="ccy-chip-icon">{{ orbIconForId(o.id) }}</span>
                      <span class="ccy-chip-name">{{ o.name.replace(/^Orb of /, '').replace(/ Orb$/, '') }}</span>
                      <span class="ccy-chip-rate">{{ fmtRate(orbRateEx(o)) }}</span>
                      <span class="tip-popup">
                        <strong>{{ o.name }}</strong>
                        <span class="tip-rate">{{ fmtRate(orbRateEx(o)) }}</span>
                        <span v-if="craft.itemDescriptions?.[o.name]?.description" class="tip-effect">{{ craft.itemDescriptions[o.name].description }}</span>
                        <span v-else-if="o.effect" class="tip-effect">{{ o.effect }}</span>
                        <em class="tip-hint">click to {{ (craft.disabledOrbs ?? {})[o.id] ? 'enable' : 'disable' }}</em>
                      </span>
                    </button>
                  </div>
                </div>
              </div>
            </details>
            <h4>
              <small class="primary-tag">primary</small>
              Optimal MDP policy <small>(mixed-policy value-iteration)</small>
              <button class="link evaluate-strategies-btn primary-cta"
                :disabled="craft.mdpEvaluating"
                @click="craft.solveMdp()">
                <span v-if="craft.mdpEvaluating" class="mdp-solve-spinner" aria-hidden="true"></span>
                {{ craft.mdpEvaluating ? 'Solving…' : (craft.mdpResult ? '↻ Re-solve' : '▶ Solve MDP') }}
              </button>
              <button v-if="craft.mdpEvaluating" class="link"
                @click="craft.cancelMdp()"
                title="Cancel the in-flight solve. The async value-iteration loop checks the cancel signal each yield, so this stops within a few ms.">
                ✖ Cancel
              </button>
              <span v-if="craft.mdpEvaluating && craft.mdpProgress" class="mdp-progress"
                :title="craft.mdpProgress.phase === 'iterate'
                  ? ('value iteration · sweep ' + craft.mdpProgress.iters + ' · δ=' + (craft.mdpProgress.delta != null ? craft.mdpProgress.delta.toExponential(2) : '—') + ' · ' + craft.mdpProgress.states + ' states')
                  : (craft.mdpProgress.phase === 'build' ? ('building state space · ' + craft.mdpProgress.states + ' states') : 'preparing…')">
                <progress :value="craft.mdpProgress.fraction ?? 0" max="1"></progress>
                <small class="hint">
                  <span v-if="craft.mdpProgress.phase === 'iterate'">
                    iter {{ craft.mdpProgress.iters }} · δ {{ craft.mdpProgress.delta != null ? craft.mdpProgress.delta.toExponential(1) : '—' }}
                  </span>
                  <span v-else-if="craft.mdpProgress.phase === 'build'">
                    {{ craft.mdpProgress.states }} states
                  </span>
                  <span v-else>preparing…</span>
                </small>
              </span>
              <label class="hint" style="margin-left: 0.6rem; font-weight: normal;"
                title="Prefix every chain node with its step id (e.g. [s5]) so you can refer to a specific node when discussing the policy. Disable when the chart gets too dense.">
                <input type="checkbox"
                  :checked="craft.showMdpStepIds"
                  @change="craft.setShowMdpStepIds($event.target.checked); craft.solveMdp();" />
                show step ids
              </label>
              <label class="hint" style="margin-left: 0.6rem; font-weight: normal;"
                title="Chain merge strategy. See docs/chain-rendering.md.&#10;• none — one chain node per engine state (raw view).&#10;• per-action — group every state by next-action; high-level overview.&#10;• top-down — partition by (kind, policy, fractured, totalMods) + disambiguator.&#10;• bottom-up — sibling-merge: A→B and A→C with same next ⇒ merge.">
                merge:
                <select :value="craft.mdpMergeStrategy"
                  @change="craft.setMdpMergeStrategy($event.target.value); craft.solveMdp();">
                  <option value="none">none (raw)</option>
                  <option value="per-action">per-action</option>
                  <option value="top-down">top-down</option>
                  <option value="bottom-up">bottom-up</option>
                </select>
              </label>
              <button v-if="craft.mdpResult" class="link" @click="craft.simulateMdp()"
                title="Sample one trajectory through the optimal policy. Click multiple times to stack scenarios."
                style="margin-left: 0.6rem;">
                🎲 Simulate one craft
              </button>
              <button v-if="craft.mdpResult" class="link"
                :disabled="craft.mdpDistributionEvaluating"
                @click="craft.simulateMdpBatch(1000)"
                title="Run 1000 sampled trajectories and plot the cost distribution (histogram + CDF). Failure paths are kept and pile up at the expensive tail."
                style="margin-left: 0.4rem;">
                <span v-if="craft.mdpDistributionEvaluating">⏳ sampling…</span>
                <span v-else>📊 1000-run distribution</span>
              </button>
              <button v-if="craft.mdpScenarios.length" class="link"
                @click="craft.clearMdpScenarios()" style="margin-left: 0.4rem;"
                title="Remove all simulated scenarios.">
                clear scenarios
              </button>
              <button v-if="craft.mdpDistribution" class="link"
                @click="craft.clearMdpDistribution()" style="margin-left: 0.4rem;"
                title="Remove the distribution panel.">
                clear distribution
              </button>
            </h4>
            <p v-if="!craft.mdpResult" class="hint">
              Walks every reachable item state, picks the optimal action per
              state via value iteration. Includes <code>buy_base</code> as an
              explicit action — bricked / near-trap states naturally pick
              "restart" when continuing is more expensive.
            </p>
            <div v-if="craft.mdpResult?.error" class="hint" style="color:#d96">
              MDP error: {{ craft.mdpResult.error }}
            </div>
            <div v-else-if="craft.mdpResult">
              <!-- Impossibility banner: when no policy can ever reach
                   a goal state (P(success/attempt) = 0, V* = ∞), say
                   so loudly. Otherwise the user stares at a chain
                   with no green edges and has to infer the cause —
                   most often a fractured affix shadowing the only
                   wished slot on its side, or an ilvl gate that
                   excludes every wished tier from the pool. -->
              <div v-if="craft.mdpResult.chain
                       && (craft.mdpResult.chain.pSuccessStart === 0
                           || !Number.isFinite(craft.mdpResult.vStar))"
                 class="mdp-impossible">
                <strong>❌ Impossible craft</strong> — no orb sequence reaches the
                wishlist from this starting item under the current
                rules. Common causes:
                <ul>
                  <li>a fractured affix is locking the side that holds the only wished mod (fractures cannot be unfractured);</li>
                  <li>a wished mod's lowest acceptable tier is gated above the current item level;</li>
                  <li>required-mod count exceeds what the side allows (e.g. 4 wished prefixes when prefixes cap at 3);</li>
                  <li>the per-action cap excludes the only orb that could reach a wished state.</li>
                </ul>
                Adjust the starting item, ilvl, wishlist tiers, or budget
                and re-solve.
              </div>
              <!-- Synthetic summary, mirroring the closed-form
                   strategies table: P(success), E[attempts], E[cost],
                   plus P(within-budget) when a cap is set. Numbers
                   come from craft.mdpResult.chain (pSuccessStart =
                   probability one committed attempt finishes the goal
                   before bricking; bExpectedStart = expected orb
                   spending per committed attempt). -->
              <table v-if="craft.mdpResult.chain" class="mdp-summary">
                <thead>
                  <tr>
                    <th title="Probability that one committed attempt reaches the goal before bricking, under the optimal policy">P(success / attempt)</th>
                    <th :title="'Expected attempts (geometric mean = 1/p) and N_p: bases needed to be at least ' + Math.round((craft.successProbTarget ?? 0.95) * 100) + '% confident of one success — a more practical figure for low-volume PoE2 crafting (configurable in Display preferences).'">E[attempts] · N<sub>{{ Math.round((craft.successProbTarget ?? 0.95) * 100) }}</sub></th>
                    <th title="Expected total cost of one committed attempt (success or brick), under the optimal policy. Includes both the orb spending along the path AND the base's purchase price (paid up-front for each fresh base). Lets P(within budget) and Breakeven budget reflect the full cash outlay per attempt rather than orbs only.">E[cost / attempt]</th>
                    <th title="V*(start) — total expected cost to satisfy the wishlist with restarts, given the current total-budget cap">V* (total)</th>
                    <th title="Probability of success with exactly 1 base — same as P(success/attempt). Shown explicitly so the user can compare 'one shot, no restart' to the multi-attempt within-budget figure. Assumes your total budget covers any single attempt's orb spend (rarely binding).">P(1 base)</th>
                    <th v-if="Number.isFinite(craft.totalBudgetEx)"
                        title="P(reach goal within the total budget) = 1 − (1 − p)^N where N = ⌊budget / E[cost/attempt]⌋. Multi-attempt: each brick triggers a fresh-base restart until budget runs out.">P(within budget)</th>
                    <th title="Budget at which committing to one attempt has non-negative expected return; below this, V*(start) clamps to 0">Breakeven budget</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td class="num primary">
                      <strong>{{ fmt.pct(craft.mdpResult.chain.pSuccessStart) }}</strong>
                    </td>
                    <td class="num"
                        :title="craft.mdpResult.chain.pSuccessStart > 0
                          ? ('mean = 1/p = ' + (1 / craft.mdpResult.chain.pSuccessStart).toFixed(2) + ' · N_p = max(1, ⌈log(' + (1 - (craft.successProbTarget ?? 0.95)).toFixed(3) + ') / log(1−p)⌉) = ' + Math.max(1, Math.ceil(Math.log(1 - (craft.successProbTarget ?? 0.95)) / Math.log(1 - craft.mdpResult.chain.pSuccessStart))))
                          : 'unreachable'">
                      <span v-if="craft.mdpResult.chain.pSuccessStart > 0">
                        {{ fmt.num(1 / craft.mdpResult.chain.pSuccessStart) }}
                        <small class="hint">· N<sub>{{ Math.round((craft.successProbTarget ?? 0.95) * 100) }}</sub> {{ Math.max(1, Math.ceil(Math.log(1 - (craft.successProbTarget ?? 0.95)) / Math.log(1 - craft.mdpResult.chain.pSuccessStart))) }}</small>
                      </span>
                      <span v-else>∞</span>
                    </td>
                    <td class="num"
                        :title="'orbs ' + fmtCost(-craft.mdpResult.chain.bExpectedStart) + ' + base ' + fmtCost(craft.mdpResult.basePriceEx ?? 0) + ' = ' + fmtCost(-craft.mdpResult.chain.bExpectedStart + (craft.mdpResult.basePriceEx ?? 0))">
                      {{ fmtCost(-craft.mdpResult.chain.bExpectedStart + (craft.mdpResult.basePriceEx ?? 0)) }}
                    </td>
                    <td class="num">
                      {{ Number.isFinite(craft.mdpResult.vStar)
                          ? fmtCost(craft.mdpResult.vStar) : '∞' }}
                    </td>
                    <td class="num"
                        :title="'P(success) on a single base, no restart — ' + fmt.pct(craft.mdpResult.chain.pSuccessStart) + '. Same as P(success/attempt); shown next to P(within budget) for direct comparison: '
                          + 'one-shot ' + fmt.pct(craft.mdpResult.chain.pSuccessStart)
                          + ' vs multi-attempt under budget.'">
                      {{ fmt.pct(craft.mdpResult.chain.pSuccessStart) }}
                    </td>
                    <td v-if="Number.isFinite(craft.totalBudgetEx)" class="num"
                        :title="(-craft.mdpResult.chain.bExpectedStart + (craft.mdpResult.basePriceEx ?? 0)) > 0
                          ? ('budget ' + fmtCost(craft.totalBudgetEx) + ' ÷ E[cost/attempt] ' + fmtCost(-craft.mdpResult.chain.bExpectedStart + (craft.mdpResult.basePriceEx ?? 0)) + ' = ' + Math.floor(craft.totalBudgetEx / (-craft.mdpResult.chain.bExpectedStart + (craft.mdpResult.basePriceEx ?? 0))) + ' attempts within budget')
                          : '—'">
                      <span v-if="(-craft.mdpResult.chain.bExpectedStart + (craft.mdpResult.basePriceEx ?? 0)) > 0">
                        {{ fmt.pct(
                          1 - Math.pow(
                            1 - craft.mdpResult.chain.pSuccessStart,
                            Math.floor(craft.totalBudgetEx / (-craft.mdpResult.chain.bExpectedStart + (craft.mdpResult.basePriceEx ?? 0))),
                          )
                        ) }}
                        <small class="hint">·
                          {{ Math.floor(craft.totalBudgetEx / (-craft.mdpResult.chain.bExpectedStart + (craft.mdpResult.basePriceEx ?? 0))) }} attempts
                        </small>
                      </span>
                      <span v-else class="hint">—</span>
                    </td>
                    <td class="num">
                      <span v-if="craft.mdpResult.chain.pSuccessStart > 0">
                        {{ fmtCost((-craft.mdpResult.chain.bExpectedStart + (craft.mdpResult.basePriceEx ?? 0)) / craft.mdpResult.chain.pSuccessStart) }}
                      </span>
                      <span v-else class="hint">∞</span>
                    </td>
                  </tr>
                </tbody>
              </table>
              <div v-if="materialsShoppingList" class="mdp-materials-synthesis">
                <p class="mdp-materials-headline">
                  <strong>Stockpile for {{ Math.round(materialsShoppingList.target * 100) }}% confidence:</strong>
                  {{ materialsShoppingList.N }} runs
                  <small class="hint">·</small>
                  <strong>≈ {{ fmtCost(materialsShoppingList.grandTotalEx) }}</strong>
                  <small class="hint">total cash outlay</small>
                </p>
                <table class="mdp-materials-table">
                  <thead>
                    <tr>
                      <th></th>
                      <th>Currency</th>
                      <th class="num" title="Total units to buy: ⌈expected per run × N runs⌉">Count</th>
                      <th class="num">Unit price</th>
                      <th class="num">Stockpile cost</th>
                      <th class="num" title="Expected uses per single run, summed across the optimal-policy chain">per run</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="line in materialsShoppingList.lines" :key="line.action">
                      <td class="num"><span class="orb-icon-glyph">{{ line.icon }}</span></td>
                      <td>
                        <span v-if="line.action === 'buy_base'" title="One fresh base per run">Base</span>
                        <span v-else class="has-tip">
                          {{ line.orb?.name ?? line.action }}
                          <span class="tip-popup">
                            <strong>{{ line.orb?.name ?? line.action }}</strong>
                            <span v-if="Number.isFinite(line.perEx)" class="tip-rate">{{ fmtCost(line.perEx) }} / unit</span>
                            <span v-if="craft.itemDescriptions?.[line.orb?.name]?.description" class="tip-effect">{{ craft.itemDescriptions[line.orb.name].description }}</span>
                            <span v-else-if="line.orb?.effect" class="tip-effect">{{ line.orb.effect }}</span>
                          </span>
                        </span>
                      </td>
                      <td class="num">{{ line.count }}</td>
                      <td class="num">{{ Number.isFinite(line.perEx) ? fmtCost(line.perEx) : '—' }}</td>
                      <td class="num"><strong>{{ Number.isFinite(line.totalEx) ? fmtCost(line.totalEx) : '—' }}</strong></td>
                      <td class="num hint">{{ line.expectedPerAttempt.toFixed(2) }}</td>
                    </tr>
                  </tbody>
                  <tfoot>
                    <tr>
                      <td></td>
                      <td><strong>Total</strong></td>
                      <td></td>
                      <td></td>
                      <td class="num"><strong>{{ fmtCost(materialsShoppingList.grandTotalEx) }}</strong></td>
                      <td></td>
                    </tr>
                  </tfoot>
                </table>
              </div>
              <details class="mdp-metrics-glossary">
                <summary>📖 What do these metrics mean?</summary>
                <dl class="metrics-glossary">
                  <dt>Attempt</dt>
                  <dd>One full crafting run on a <em>single</em> base, ending when the wishlist is met (success) <strong>or</strong> the optimal policy declares the item bricked (must restart). It is not capped by orb count or by clicks — only by reaching one of those two terminals.</dd>

                  <dt>P(success / attempt)</dt>
                  <dd>Probability one single-base attempt reaches the goal under the optimal policy.</dd>

                  <dt>E[attempts]</dt>
                  <dd>Geometric mean — over many crafts, the <em>average</em> number of bases consumed before one succeeds. Equals <code>1 / P(success)</code>.</dd>

                  <dt>N₉₅ (attempts for 95%)</dt>
                  <dd>The smallest <em>N</em> such that <code>1 − (1−p)^N ≥ 95%</code>. PoE2 players typically craft 1–2 items, so the geometric mean misleads: half the time you'll need <em>more</em> attempts than the mean. N₉₅ answers "how many bases do I need to set aside to be 95% confident?".</dd>

                  <dt>E[cost / attempt]</dt>
                  <dd>Average <em>total</em> spending during one attempt (mixing the success and brick paths): orbs along the path <strong>plus</strong> the base's purchase price. Hover the cell to see the orb / base split.</dd>

                  <dt>V* (total)</dt>
                  <dd>The engine's full cost-to-success across all attempts to first success. Equals <code>E[attempts] × E[cost/attempt]</code>.</dd>

                  <dt>P(1 base)</dt>
                  <dd>Probability of success with exactly one base, no restart — same value as <em>P(success / attempt)</em>, shown next to <em>P(within budget)</em> for direct comparison: "one-shot" vs "multi-attempt under budget". Assumes the total budget covers a single attempt's orb spend (rarely binding for realistic budgets).</dd>

                  <dt>P(within budget)</dt>
                  <dd>Probability of at least one success when allowed to <em>restart</em> on brick, capped by your total budget: <code>1 − (1−p)^N</code> with <code>N = ⌊budget / E[cost/attempt]⌋</code>. The cell also shows <em>N</em> directly so the implied "attempts permitted by your budget" is visible.</dd>

                  <dt>Breakeven budget</dt>
                  <dd>The trade-equivalent value at which one single-base attempt has zero expected profit: <code>E[cost/attempt] / P(success)</code>. If a successful goal-item sells for more than this, the craft is profitable in expectation. <em>Not</em> the budget required to finish a craft.</dd>

                  <dt>V* (s)</dt>
                  <dd>The expected total cost (ex, with wall-clock time folded in via <code>timeWeightExPerSec</code>) to reach a goal state from <em>any</em> state <em>s</em> under the optimal policy. Already accounts for every downstream orb, every brick + restart, every cycle risk — no need to add per-step costs by hand. The table's <em>V* (total)</em> is <code>V*(start)</code>.</dd>

                  <dt>Q(s, a)</dt>
                  <dd>The expected total cost from state <em>s</em> if you take action <em>a</em> at this step and follow the optimal policy thereafter: <code>Q(s, a) = cost(a) + Σ p(s' | s, a) · V*(s')</code>. The "Why this orb?" panel lists Q-values for every applicable action at the clicked state; the engine picks the action with the smallest Q. <strong>ΔQ</strong> is the gap between this action's Q and the chosen action's Q — small ΔQ means the alternative is nearly as good (e.g. a 1-ex gap between essence and augment), large ΔQ means it's strictly worse.</dd>

                  <dt>P_reach (s)</dt>
                  <dd>Probability that one execution of the optimal policy <em>visits</em> state <em>s</em>, starting from the start node. Marginal visit probability under π* — accumulated by walking the policy graph and multiplying outcome probabilities along each followed edge. <code>buy_base</code> / bricked / goal nodes are absorbing (successors not propagated), so a downstream node's P_reach answers "given that the policy reaches a non-terminal step here, with what probability does the fan land on this branch?" — <strong>not</strong> "given any history, what's the chance this state ever appears?" and <strong>not</strong> "P(success from here)".</dd>
                </dl>
              </details>
              <p class="hint mdp-meta-line">
                <strong>{{ craft.mdpResult.states.length }}</strong> reachable states
                · {{ craft.mdpResult.iters }} value-iteration sweeps
                · optimal start action = <code>{{ craft.mdpResult.policy.get(craft.mdpResult.start.stateKey) ?? '(none)' }}</code>
              </p>
              <ul v-if="craft.mdpResult.warnings?.length" class="hint" style="color:#d96">
                <li v-for="w in craft.mdpResult.warnings" :key="w">⚠ {{ w }}</li>
              </ul>
              <p v-if="craft.mdpResult.unpricedEssences?.length"
                 class="hint" style="color:#d96">
                <small>
                  Likely cause: poe2db's Economy_Essences table only lists
                  essences with recent trades. Click through to confirm
                  "no price history" upstream:
                  <span v-for="(name, i) in craft.mdpResult.unpricedEssences" :key="name">
                    <a :href="'https://poe2db.tw/us/' + name.replace(/ /g, '_')"
                       target="_blank" rel="noopener">{{ name }} ↗</a>{{ i < craft.mdpResult.unpricedEssences.length - 1 ? ', ' : '' }}
                  </span>.
                </small>
              </p>
              <p v-if="craft.mdpResult.budgetExcluded?.length"
                 class="hint" style="color:#d96">
                ⚠ The optimal policy recommends an orb whose unit price exceeds
                your budget ({{ craft.totalBudgetEx }} ex):
                <span v-for="(ex, i) in craft.mdpResult.budgetExcluded" :key="ex.actionId">
                  <code>{{ ex.actionId }}</code> ({{ ex.costEx.toFixed(0) }} ex){{ i < craft.mdpResult.budgetExcluded.length - 1 ? ', ' : '' }}
                </span>.
                You can either raise the budget to afford it, or disable the orb
                so the solver re-plans without it.
                <br>
                <button class="link"
                  @click="craft.setTotalBudgetEx(Math.ceil(Math.max(...craft.mdpResult.budgetExcluded.map(e => e.costEx)))); craft.solveMdp();">
                  Raise budget to {{ Math.ceil(Math.max(...craft.mdpResult.budgetExcluded.map(e => e.costEx))) }} ex
                </button>
                <span v-for="(ex, i) in craft.mdpResult.budgetExcluded" :key="'dis'+ex.actionId">
                  ·
                  <button class="link"
                    @click="craft.setOrbDisabled(ex.actionId, true); craft.solveMdp();">
                    Disable <code>{{ ex.actionId }}</code>
                  </button>
                </span>
              </p>
              <p v-if="craft.mdpResult.chain?.breakevenBudgetEx != null
                       && craft.totalBudgetEx < craft.mdpResult.chain.breakevenBudgetEx"
                 class="hint" style="color:#d96">
                💸 This craft loses ex on average. Producing one finished item
                costs about
                <strong>{{ craft.mdpResult.chain.breakevenBudgetEx.toFixed(0) }} ex</strong> in orbs
                (= {{ (-craft.mdpResult.chain.bExpectedStart).toFixed(0) }} ex per attempt
                ÷ {{ (craft.mdpResult.chain.pSuccessStart * 100).toFixed(2) }}% success).
                Your budget ({{ craft.totalBudgetEx }} ex) is below that, so you're
                paying more than the item is worth — on average.
                <br>
                <small>
                  Raising your budget <em>doesn't fix this</em>: each item still costs
                  ~{{ craft.mdpResult.chain.breakevenBudgetEx.toFixed(0) }} ex on average — a
                  bigger budget just lets you keep paying. To actually make
                  this craft profitable, either <em>relax the wishlist</em> (cheaper
                  attempts and/or higher success rate), <em>pick a different
                  target</em>, or <em>accept the loss</em> as the cost of trying.
                </small>
              </p>
              <p v-else-if="craft.mdpResult.chain?.breakevenBudgetEx == null
                            && craft.mdpResult.chain?.pSuccessStart === 0
                            && !craft.mdpResult.budgetExcluded?.length"
                 class="hint" style="color:#d96">
                ⚠ P(success on one committed attempt) = 0 — the optimal policy
                bricks 100% before reaching goal under the current rates / target.
                No budget makes this scenario profitable; revisit the wishlist or
                rates panel.
              </p>
              <details class="chain-detail">
                <summary>▶ Optimal policy chain ({{ craft.mdpResult.chain.states.length }} states · {{ craft.mdpResult.chain.edges.length }} edges)</summary>
                <div class="chain-renderer-toggle">
                  <label class="hint">renderer:</label>
                  <select :value="chainRenderer" @change="setChainRenderer($event.target.value)">
                    <option value="mermaid">Mermaid (dagre, layered)</option>
                    <option value="cytoscape">Cytoscape (fcose, force-directed)</option>
                  </select>
                  <button class="link" @click="copyChainDump" title="Copy a text dump of every state label + edge to the clipboard.">📋 copy chain</button>
                  <small class="hint">— fcose handles cycles + minimises edge length; dagre is faster on small DAGs.</small>
                </div>
                <CytoscapeChain v-if="chainRenderer === 'cytoscape'" :chain="craft.mdpResult.chain" />
                <MermaidChain v-else :chain="craft.mdpResult.chain" />
              </details>

              <!-- Stacked scenarios from the 🎲 Simulate button. Each
                   click samples one trajectory through π* and pushes a
                   scenario card here so the user builds intuition over
                   multiple runs. Each card surfaces the resource ledger
                   (orbs spent, ex spent, buy_base events) plus the
                   final concrete item; the "Send to Divine Bench"
                   button serializes the affixes via the concrete-item
                   DSL and stages them on the store for the Divine
                   Bench tab to pick up. -->
              <!-- Cost distribution panel: histogram + CDF over N
                   batch-sampled trajectories. Shows variance / tail
                   risk that a single 🎲 Simulate-one-craft button
                   can't convey. -->
              <div v-if="distributionStats" class="mdp-distribution">
                <h5>📊 Cost distribution ({{ distributionStats.n }} runs)</h5>
                <p v-if="distributionStats.pSuccessAtBudget != null" class="dist-headline"
                   :title="'Fraction of sampled trajectories that reached the goal AND stayed within ' + fmtCost(distributionStats.budgetEx) + '. This is what \\'P(success under budget)\\' means under the current expected-cost-optimal policy. A budget-aware solver could in principle do better, but if this number is already ≥0.9 the gain is marginal.'">
                  P(success | budget {{ fmtCost(distributionStats.budgetEx) }}) =
                  <strong :style="distributionStats.pSuccessAtBudget >= 0.9 ? 'color:#5d9' : (distributionStats.pSuccessAtBudget >= 0.5 ? 'color:#cd6' : 'color:#d96')">
                    {{ (distributionStats.pSuccessAtBudget * 100).toFixed(1) }}%
                  </strong>
                  <small class="hint">
                    ({{ distributionStats.successWithinBudget }} / {{ distributionStats.n }})
                  </small>
                </p>
                <p class="dist-headline"
                   :title="'Fraction of sampled trajectories that reached the goal WITHOUT ever restarting (zero buy_base events)' + (distributionStats.budgetEx != null ? ' AND stayed within ' + fmtCost(distributionStats.budgetEx) : '') + '. Answers \\'I have a single base, what\\'s P(success)?\\' under the current policy. Lower than the with-restart number because every brick now counts as failure.'">
                  P(success | single base{{ distributionStats.budgetEx != null ? ', budget ' + fmtCost(distributionStats.budgetEx) : '' }}) =
                  <strong :style="(distributionStats.pSuccessSingleBaseAtBudget ?? distributionStats.pSuccessSingleBase) >= 0.9 ? 'color:#5d9' : ((distributionStats.pSuccessSingleBaseAtBudget ?? distributionStats.pSuccessSingleBase) >= 0.5 ? 'color:#cd6' : 'color:#d96')">
                    {{ ((distributionStats.pSuccessSingleBaseAtBudget ?? distributionStats.pSuccessSingleBase) * 100).toFixed(1) }}%
                  </strong>
                  <small class="hint">
                    ({{ distributionStats.successSingleBaseAtBudget ?? distributionStats.successSingleBase }} / {{ distributionStats.n }})
                  </small>
                </p>
                <div class="dist-summary hint">
                  <span><strong>p50</strong> {{ fmtCost(distributionStats.median) }}</span>
                  <span>· <strong>p75</strong> {{ fmtCost(distributionStats.p75) }}</span>
                  <span>· <strong>p93.75</strong> {{ fmtCost(distributionStats.p9375) }}</span>
                  <span>· <strong>mean</strong> {{ fmtCost(distributionStats.mean) }}</span>
                  <span>· <strong>min</strong> {{ fmtCost(distributionStats.min) }}</span>
                  <span>· <strong>max</strong> {{ fmtCost(distributionStats.max) }}</span>
                  <span v-if="distributionStats.p75over2p50 != null"
                        :title="'p75 / (2·p50). Doubling-chain check: with a stop-and-restart strategy at p50, two attempts achieve 75% success at cost ≤ 2·p50. Ratio ≤ 1 means the policy already exploits this. Ratio > 1 means the histogram has cost mass that a stop-loss + restart would avoid.'"
                        :style="distributionStats.p75over2p50 > 1 ? 'color:#d96' : 'color:#5d9'">
                    · <strong>p75 / 2·p50</strong> {{ distributionStats.p75over2p50.toFixed(2) }}×
                  </span>
                  <span v-if="distributionStats.p9375over2p75 != null"
                        :title="'p93.75 / (2·p75). Iterating the doubling chain one more time: stop+restart at p75, two attempts achieve 93.75% success at cost ≤ 2·p75. Ratio > 1 means the deep tail leaks through.'"
                        :style="distributionStats.p9375over2p75 > 1 ? 'color:#d96' : 'color:#5d9'">
                    · <strong>p93.75 / 2·p75</strong> {{ distributionStats.p9375over2p75.toFixed(2) }}×
                  </span>
                  <span>·
                    <span style="color:#5d9">{{ distributionStats.successCount }} ✓</span>
                    /
                    <span :style="distributionStats.failCount > 0 ? 'color:#d96' : 'color:#888'">{{ distributionStats.failCount }} ✗</span>
                  </span>
                </div>
                <svg v-if="distributionPlot" class="dist-svg"
                     :viewBox="'0 0 ' + distributionPlot.SVG_W + ' ' + distributionPlot.SVG_H"
                     preserveAspectRatio="xMidYMid meet">
                  <!-- axis -->
                  <line :x1="distributionPlot.PAD_L"
                        :x2="distributionPlot.SVG_W - distributionPlot.PAD_R"
                        :y1="distributionPlot.SVG_H - distributionPlot.PAD_B"
                        :y2="distributionPlot.SVG_H - distributionPlot.PAD_B"
                        stroke="#666" stroke-width="1" />
                  <line :x1="distributionPlot.PAD_L" :x2="distributionPlot.PAD_L"
                        :y1="distributionPlot.PAD_T"
                        :y2="distributionPlot.SVG_H - distributionPlot.PAD_B"
                        stroke="#666" stroke-width="1" />
                  <!-- right Y axis (CDF 0..1) -->
                  <line :x1="distributionPlot.SVG_W - distributionPlot.PAD_R"
                        :x2="distributionPlot.SVG_W - distributionPlot.PAD_R"
                        :y1="distributionPlot.PAD_T"
                        :y2="distributionPlot.SVG_H - distributionPlot.PAD_B"
                        stroke="#666" stroke-width="1" stroke-dasharray="2 3" />
                  <!-- bars: success (green) stacked under fail (amber) -->
                  <g class="dist-bars">
                    <g v-for="(b, i) in distributionPlot.bars" :key="'bar'+i">
                      <rect v-if="b.successH > 0"
                        :x="b.xLeft" :y="b.successY" :width="b.w" :height="b.successH"
                        fill="rgba(80, 200, 130, 0.55)" stroke="rgba(80, 200, 130, 0.9)" stroke-width="0.5">
                        <title>{{ fmtCost(b.xMid) }} · {{ b.count }} runs ({{ b.successCount }} ✓ / {{ b.failCount }} ✗)</title>
                      </rect>
                      <rect v-if="b.failH > 0"
                        :x="b.xLeft" :y="b.failY" :width="b.w" :height="b.failH"
                        fill="rgba(220, 130, 80, 0.65)" stroke="rgba(220, 130, 80, 0.95)" stroke-width="0.5">
                        <title>{{ fmtCost(b.xMid) }} · {{ b.count }} runs ({{ b.successCount }} ✓ / {{ b.failCount }} ✗)</title>
                      </rect>
                    </g>
                  </g>
                  <!-- CDF polyline -->
                  <path :d="distributionPlot.cdfPath"
                        fill="none" stroke="rgba(180, 200, 255, 0.9)" stroke-width="1.6" />
                  <!-- quantile markers -->
                  <g v-for="(m, i) in distributionPlot.markers" :key="'mk'+i">
                    <line :x1="m.x" :x2="m.x"
                          :y1="distributionPlot.PAD_T"
                          :y2="distributionPlot.SVG_H - distributionPlot.PAD_B"
                          :stroke="m.color" stroke-width="1" stroke-dasharray="3 3" opacity="0.7" />
                    <text :x="m.x + 3" :y="distributionPlot.PAD_T + 10"
                          :fill="m.color" font-size="10">{{ m.label }}</text>
                  </g>
                  <!-- budget marker — heavier solid white line so it stands out -->
                  <g v-if="distributionPlot.budgetMarker">
                    <line :x1="distributionPlot.budgetMarker.x" :x2="distributionPlot.budgetMarker.x"
                          :y1="distributionPlot.PAD_T"
                          :y2="distributionPlot.SVG_H - distributionPlot.PAD_B"
                          :stroke="distributionPlot.budgetMarker.color" stroke-width="1.6" opacity="0.85" />
                    <text :x="distributionPlot.budgetMarker.x + 3"
                          :y="distributionPlot.SVG_H - distributionPlot.PAD_B - 4"
                          :fill="distributionPlot.budgetMarker.color" font-size="10" font-weight="600">
                      {{ distributionPlot.budgetMarker.label }}
                    </text>
                  </g>
                  <!-- x-axis tick labels -->
                  <g class="dist-ticks">
                    <text v-for="(t, i) in distributionPlot.ticks" :key="'tk'+i"
                          :x="t.x" :y="distributionPlot.SVG_H - distributionPlot.PAD_B + 14"
                          fill="#aaa" font-size="10" text-anchor="middle">{{ t.label }}</text>
                  </g>
                  <!-- y-axis labels: left=count, right=CDF 0..1 -->
                  <text :x="distributionPlot.PAD_L - 6" :y="distributionPlot.PAD_T + 4"
                        fill="#aaa" font-size="10" text-anchor="end">runs</text>
                  <text :x="distributionPlot.SVG_W - distributionPlot.PAD_R + 6"
                        :y="distributionPlot.PAD_T + 4"
                        fill="#aaa" font-size="10" text-anchor="start">CDF</text>
                  <text :x="distributionPlot.SVG_W - distributionPlot.PAD_R + 6"
                        :y="distributionPlot.SVG_H - distributionPlot.PAD_B + 4"
                        fill="#aaa" font-size="10" text-anchor="start">0</text>
                  <text :x="distributionPlot.SVG_W - distributionPlot.PAD_R + 6"
                        :y="distributionPlot.PAD_T + 4"
                        fill="#aaa" font-size="10" text-anchor="start">1</text>
                </svg>
                <p class="hint dist-legend">
                  <span style="color:rgba(80,200,130,0.95)">■</span> goal reached
                  <span style="margin-left:1rem;color:rgba(220,130,80,0.95)">■</span> truncated / failed
                  <span style="margin-left:1rem;color:rgba(180,200,255,0.9)">—</span> CDF (right axis 0..1)
                </p>
              </div>

              <div v-if="craft.mdpScenarios.length" class="mdp-scenarios">
                <h5>🎲 Simulated scenarios ({{ craft.mdpScenarios.length }})</h5>
                <div v-for="s in craft.mdpScenarios" :key="s.id" class="scenario-card">
                  <div class="scenario-head">
                    <strong>Scenario #{{ s.id }}</strong>
                    <span class="hint">
                      {{ s.traj.steps.length }} step(s) ·
                      {{ s.traj.totalEx.toFixed(0) }} ex ·
                      {{ (s.traj.totalSec / 60).toFixed(1) }} min ·
                      <span :title="'Joint probability of this exact trajectory: Π of each step\\'s sampledProb. Lower = rarer outcome path.'">
                        p ≈ {{ fmtProbability(scenarioProbability(s)) }}
                      </span> ·
                      <span :style="s.traj.reachedGoal ? 'color:#5d9' : 'color:#d96'">
                        {{ s.traj.reachedGoal ? '✓ goal reached' : (s.traj.truncated ? '⚠ truncated' : '— stopped') }}
                      </span>
                      <span v-if="s.traj.buyBaseEvents > 0">
                        · {{ s.traj.buyBaseEvents }}× buy_base
                      </span>
                    </span>
                    <span style="margin-left:auto">
                      <button class="link" @click="copyScenarioToClipboard(s)" title="Copy concrete-item DSL to clipboard">📋 copy</button>
                      <button class="link" @click="sendScenarioToDivineBench(s)" title="Stage this item on the Divine Bench tab">→ Divine Bench</button>
                      <button class="link" @click="craft.removeMdpScenario(s.id)" title="Remove this scenario">×</button>
                    </span>
                  </div>
                  <details>
                    <summary>orb spend</summary>
                    <table class="mdp-materials-table">
                      <thead>
                        <tr>
                          <th></th>
                          <th>Currency</th>
                          <th class="num">Count</th>
                          <th class="num">Unit price</th>
                          <th class="num">Total</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr v-for="line in scenarioActionLines(s)" :key="line.action">
                          <td class="num"><span class="orb-icon-glyph">{{ line.icon }}</span></td>
                          <td>
                            <span class="has-tip">
                              {{ orbForAction(line.action)?.name ?? line.action }}
                              <span class="tip-popup">
                                <strong>{{ orbForAction(line.action)?.name ?? line.action }}</strong>
                                <span v-if="Number.isFinite(line.perOrbEx)" class="tip-rate">{{ fmtCost(line.perOrbEx) }} / unit</span>
                                <span v-if="craft.itemDescriptions?.[orbForAction(line.action)?.name]?.description" class="tip-effect">{{ craft.itemDescriptions[orbForAction(line.action).name].description }}</span>
                                <span v-else-if="orbForAction(line.action)?.effect" class="tip-effect">{{ orbForAction(line.action).effect }}</span>
                              </span>
                            </span>
                          </td>
                          <td class="num">{{ line.count }}</td>
                          <td class="num">{{ fmtCost(line.perOrbEx) }}</td>
                          <td class="num"><strong>{{ fmtCost(line.costEx) }}</strong></td>
                        </tr>
                      </tbody>
                      <tfoot>
                        <tr>
                          <td></td>
                          <td><strong>Total</strong></td>
                          <td></td>
                          <td></td>
                          <td class="num"><strong>{{ fmtCost(scenarioActionLines(s).reduce((sum, l) => sum + (Number.isFinite(l.costEx) ? l.costEx : 0), 0)) }}</strong></td>
                        </tr>
                      </tfoot>
                    </table>
                  </details>
                  <details>
                    <summary>final item ({{ s.traj.concreteItem?.rarity ?? '—' }} · {{ s.traj.concreteItem?.affixCount ?? 0 }} affix)</summary>
                    <ul class="hint">
                      <li v-for="(a, i) in s.affixes" :key="i">
                        [<strong>{{ a.side === 'PREFIX' ? 'P' : 'S' }} T{{ a.tier }}</strong>]
                        <span v-if="a.fractured" title="fractured">🔒</span>
                        {{ a.name }}
                        <span v-if="Number.isFinite(a.value)"> = <strong>{{ a.value }}</strong></span>
                        <span v-if="Number.isFinite(a.vmin) && Number.isFinite(a.vmax)" class="hint">
                          [{{ a.vmin }}..{{ a.vmax }}]
                        </span>
                      </li>
                      <li v-if="(s.traj.concreteItem?.irrelevantCount ?? 0) > 0" class="hint">
                        + {{ s.traj.concreteItem.irrelevantCount }} irrelevant slot(s)
                      </li>
                      <li v-if="s.traj.concreteItem?.boneMod && !s.traj.concreteItem?.boneRevealed" class="hint">
                        🦴 unrevealed bone-mod
                      </li>
                    </ul>
                  </details>
                </div>
              </div>
            </div>
          </div>
        </div>

        <details id="rates-panel" class="rates" v-if="craft.game">
          <summary>
            Currency rates
            <small>
              <span v-if="divToEx">1 div = {{ divToEx.toFixed(2) }} ex</span>
              · {{ Object.keys(craft.rateOverrides).length }} overridden ·
              report cost in
              <select :value="craft.referenceCurrency"
                      @change="craft.setReferenceCurrency($event.target.value)"
                      @click.stop>
                <option value="exalted">Exalted Orb</option>
                <option value="divine">Divine Orb</option>
              </select>
            </small>
          </summary>
          <p class="hint">
            <span class="rates-snapshot" :class="'rates-' + (craft.rates?.staleness || 'unknown')"
                  :title="ratesSnapshotTitle">
              <span class="rates-dot" aria-hidden="true">●</span>
              {{ ratesSnapshotLabel }}
            </span>
            Rates are <strong>1 unit of this currency = X Exalted Orbs</strong>.
            Edit any value below; overrides are saved locally. Refresh with
            <code>scripts/update-poe2-rates.sh [region]</code> (region defaults to
            <code>us</code>; <code>cn de fr ru kr tw jp</code> are language
            variants — prices are identical, only item names localise).
            <button class="link" @click="craft.resetRates()" v-if="Object.keys(craft.rateOverrides).length">
              reset all overrides
            </button>
          </p>
          <template v-for="kind in (craft.game?.CURRENCY_KINDS ?? [])" :key="kind.id">
          <details v-if="!kind.hiddenInRatesPanel && (craft.currenciesByKind[kind.id] ?? []).length"
                   class="rates-group">
            <summary>
              {{ kind.label }}
              <small v-if="craft.currenciesByKind[kind.id]">
                {{ craft.currenciesByKind[kind.id].filter(c => c.applicable).length }}
                / {{ craft.currenciesByKind[kind.id].length }} applicable to current item
              </small>
              <a v-if="kind.poedbEconomy"
                 class="ext-link"
                 :href="poedbEconomyUrl(kind.poedbEconomy)"
                 target="_blank" rel="noopener"
                 :title="'Open poe2db Economy_' + kind.poedbEconomy + ' page'"
                 @click.stop>↗ poe2db</a>
            </summary>
            <table class="rates-table">
              <thead><tr><th>Currency</th><th class="num">1 ↔ Exalted</th><th class="num" title="Time per single use, in seconds">Time (s)</th><th title="Untick to exclude from the engine's policy">Available</th><th></th></tr></thead>
              <tbody>
                <tr v-for="c in (craft.currenciesByKind[kind.id] ?? [])" :key="c.id"
                    :class="{ overridden: c.overridden, 'not-applicable': !c.applicable }"
                    :title="c.applicable ? '' : c.reason">
                  <td class="ccy-name-cell">
                    <img v-if="craft.itemDescriptions?.[c.name]?.image_url"
                         :src="craft.itemDescriptions[c.name].image_url"
                         :alt="c.name" class="ccy-icon" loading="lazy" />
                    {{ c.name }} <small>({{ c.short }})</small>
                    <a class="ext-link mini" :href="poedbItemUrl(c.name)"
                       target="_blank" rel="noopener"
                       :title="'Open ' + c.name + ' on poe2db'">↗ db</a>
                    <a class="ext-link mini" :href="wikiUrl(c.name)"
                       target="_blank" rel="noopener"
                       :title="'Open ' + c.name + ' on the fextralife wiki'">↗ wiki</a>
                    <template v-for="(chip, ci) in (c.chips ?? [])" :key="ci">
                      <button v-if="chip.fixIlvl"
                            class="restriction-chip"
                            :class="{ violated: chip.active, clickable: true }"
                            :title="(chip.fixDirection === 'down' ? 'Lower' : 'Raise') + ' item level to ' + chip.fixIlvl + ' to satisfy this restriction'"
                            @click="craft.setItemLevel(chip.fixIlvl)">{{ chip.text }}</button>
                      <span v-else class="restriction-chip" :class="{ violated: chip.active }">{{ chip.text }}</span>
                    </template>
                  </td>
                  <td class="num">
                    <input type="number" min="0" step="any"
                      :value="Number.isFinite(c.exaltedPer) ? c.exaltedPer : ''"
                      :placeholder="c.id === 'exalted' ? '1 (fixed)' : '—'"
                      :disabled="c.id === 'exalted'"
                      @input="craft.setRate(c.id, $event.target.value)" />
                  </td>
                  <td class="num" :class="{ overridden: c.timeOverridden, 'time-synced': !!c.timeBaseOrb }">
                    <span v-if="c.timeBaseOrb" class="hint"
                      :title="'Synced with ' + (craft.game?.orbs?.[c.timeBaseOrb]?.name ?? c.timeBaseOrb)">
                      ↑
                    </span>
                    <input v-else-if="Number.isFinite(c.timeSeconds)"
                      type="number" min="1" step="1"
                      :value="c.timeSeconds"
                      :title="'Time factor to use one ' + c.name + ' (seconds — at least 1s to glance at the outcome)'"
                      @input="craft.setTime(c.id, $event.target.value)" />
                    <span v-else class="hint">—</span>
                  </td>
                  <td class="num">
                    <input v-if="craft.game?.orbs?.[c.id]"
                      type="checkbox"
                      :checked="!(craft.disabledOrbs ?? {})[c.id]"
                      @change="craft.setOrbDisabled(c.id, !$event.target.checked); craft.solveMdp();"
                      title="Untick to exclude this orb from the MDP's action set (re-solves automatically)" />
                  </td>
                  <td>
                    <button v-if="c.overridden" class="link" @click="craft.setRate(c.id, NaN)" title="reset rate">↺ rate</button>
                    <button v-if="c.timeOverridden && !c.timeBaseOrb" class="link" @click="craft.setTime(c.id, '')" title="reset time">↺ time</button>
                    <small v-if="c.timeBaseOrb" class="hint" :title="'Time synced with ' + (craft.game?.orbs?.[c.timeBaseOrb]?.name ?? c.timeBaseOrb)">⇆ synced</small>
                  </td>
                </tr>
              </tbody>
            </table>
          </details>
          </template>

          <!-- Mechanics availability moved inside the rates panel: it's
               an "I don't have access to omen X" what-if knob, rarely
               customised, naturally grouped with currency rates. -->
          <details class="mechanics" v-if="craft.omens.length">
            <summary>
              Crafting items availability
              <small>{{ Object.keys(craft.mechanicsOverrides).length }} overridden</small>
            </summary>
            <p class="hint">
              Toggle items on/off to model "what-if" scenarios — e.g. compare a craft
              cost <em>with</em> vs <em>without</em> a deprecated omen, or with a
              mechanic you don't personally have access to. Overrides persist locally.
              <button class="link" v-if="Object.keys(craft.mechanicsOverrides).length" @click="craft.resetMechanicsOverrides()">
                reset all overrides
              </button>
            </p>
            <table class="rates-table">
              <thead><tr><th>Omen</th><th>Effect</th><th class="num">Enabled</th></tr></thead>
              <tbody>
                <tr v-for="o in craft.omens" :key="o.id" :class="{ deprecated: !o.available, overridden: (o.id in (Object.fromEntries(Object.entries(craft.mechanicsOverrides).map(([k,v]) => [k.replace('omen:',''), v])))) }">
                  <td>
                    <span>{{ o.name }}</span>
                    <small v-if="!o.available" class="deprecated-tag"> · deprecated</small>
                  </td>
                  <td><small>{{ o.effect }}</small></td>
                  <td class="num">
                    <input type="checkbox"
                      :checked="craft.isMechanicEnabled('omen', o.id)"
                      @change="craft.setMechanicEnabled('omen', o.id, $event.target.checked)" />
                  </td>
                </tr>
              </tbody>
            </table>
          </details>
        </details>
      </template>

      <!-- App-wide preferences (collapsed by default) -->
      <details class="app-prefs" v-if="craft.game">
        <summary>Display preferences</summary>
        <div class="prefs-row">
          <label class="field inline">
            <span>Tier comparison</span>
            <select :value="craft.tierComparisonMode"
                    @change="craft.setTierComparisonMode($event.target.value)">
              <option value="gameplay">Gameplay — T1 is best (≥ T3 = "T3 or better")</option>
              <option value="math">Math — tier numbers ascend (≤ T3 = "T1, T2, or T3")</option>
            </select>
            <small class="hint">Inverts comparison symbols on tier dropdowns. Stored per-share via URL.</small>
          </label>
          <label class="field inline">
            <span>Cost display unit</span>
            <select :value="craft.displayUnit ?? 'ex'"
                    @change="craft.setDisplayUnit($event.target.value)">
              <option value="ex">Exalted</option>
              <option value="div">Divine</option>
            </select>
            <small class="hint">Every cost in this panel renders in the chosen currency.</small>
          </label>
          <label class="field inline">
            <span>Success-probability target (N_p column)</span>
            <input type="number" min="0.5" max="0.999" step="0.01"
              :value="craft.successProbTarget ?? 0.95"
              @input="craft.setSuccessProbTarget($event.target.value)" />
            <small class="hint">PoE2 players typically craft 1–2 items, so the geometric mean misleads. N_p shows the bases needed for ≥ this success probability.</small>
          </label>
        </div>
      </details>

      <!-- Modifier-detail modal: tier breakdown for a clicked mod -->
      <div v-if="selectedMod" class="mod-modal-overlay" @click.self="closeModModal()">
        <div class="mod-modal">
          <header>
            <h3>{{ selectedMod.name }}</h3>
            <small>{{ craft.base }} · {{ selectedMod.type }}</small>
            <button class="banner-close" @click="closeModModal()">×</button>
          </header>
          <table class="mod-modal-table">
            <thead>
              <tr><th>Tier</th><th>Tier name</th><th class="num">ilvl</th><th class="num">Weight</th></tr>
            </thead>
            <tbody>
              <tr v-for="t in selectedMod.allTiers" :key="'mmt'+t.tier" :class="{ unreachable: !t.ilvlOk }">
                <td>T{{ t.tier }}</td>
                <td>{{ t.tierName }}</td>
                <td class="num">{{ t.ilvl }}</td>
                <td class="num">{{ t.weight }}</td>
              </tr>
            </tbody>
          </table>
          <footer v-if="selectedMod.tags?.length || craft.poe2dbBaseUrl">
            <span v-if="selectedMod.tags?.length" class="mod-tags">
              <button v-for="t in selectedMod.tags" :key="'mmtg'+t"
                class="tag-chip mini filter"
                :class="craft.tagFilters[t] || 'neutral'"
                :style="tagStyle(t)"
                :title="(craft.tagFilters[t] === 'include' ? 'Excluding next' : craft.tagFilters[t] === 'exclude' ? 'Resetting next' : 'Including next') + ' — ' + t"
                @click="craft.cycleTagFilter(t)">{{ t }}</button>
            </span>
            <a v-if="craft.poe2dbBaseUrl()" :href="craft.poe2dbBaseUrl()" target="_blank" rel="noopener" class="poe2db-link">view full base on poe2db ↗</a>
          </footer>
        </div>
      </div>

      <!-- Essence-detail modal: per-tier roll ranges (Lesser / Normal / Greater) -->
      <div v-if="selectedEssence" class="mod-modal-overlay" @click.self="closeEssenceModal()">
        <div class="mod-modal">
          <header>
            <h3>{{ selectedEssence.text }}</h3>
            <small>{{ selectedEssence.family }}</small>
            <button class="banner-close" @click="closeEssenceModal()">×</button>
          </header>
          <table class="mod-modal-table">
            <thead>
              <tr><th>Essence tier</th><th>Roll range</th><th>Input rarity</th></tr>
            </thead>
            <tbody>
              <tr v-for="tier in ESSENCE_TIERS" :key="'em'+tier"
                  :class="{ unreachable: !selectedEssence.tiers[tier] }">
                <td>{{ ESSENCE_TIER_LABELS[tier] }}</td>
                <td>{{ selectedEssence.tiers[tier] || '—' }}</td>
                <td><small class="hint">Magic → Rare</small></td>
              </tr>
              <tr class="unreachable">
                <td>Perfect</td>
                <td><small class="hint">(no data)</small></td>
                <td><small class="hint">Rare → Rare</small></td>
              </tr>
            </tbody>
          </table>
          <footer>
            <span v-if="selectedEssence.tags?.length" class="mod-tags">
              <button v-for="t in selectedEssence.tags" :key="'emtg'+t"
                class="tag-chip mini filter"
                :class="craft.tagFilters[t] || 'neutral'"
                :style="tagStyle(t)"
                @click="craft.cycleTagFilter(t)">{{ t }}</button>
            </span>
            <a :href="poedbItemUrl(selectedEssence.family)" target="_blank" rel="noopener" class="poe2db-link">poe2db ↗</a>
            <a :href="wikiUrl(selectedEssence.family)" target="_blank" rel="noopener" class="poe2db-link">fextralife wiki ↗</a>
          </footer>
        </div>
      </div>

      <!-- Desecrated-detail modal: roll range + source family for one mod -->
      <div v-if="selectedDesecrated" class="mod-modal-overlay" @click.self="closeDesecratedModal()">
        <div class="mod-modal">
          <header>
            <h3>{{ selectedDesecrated.text }}</h3>
            <small>
              {{ selectedDesecrated.tierName || 'Desecrated' }}
              · {{ selectedDesecrated.side === 'PREFIX' ? 'Prefix' : selectedDesecrated.side === 'SUFFIX' ? 'Suffix' : 'Unknown side' }}
            </small>
            <button class="banner-close" @click="closeDesecratedModal()">×</button>
          </header>
          <table class="mod-modal-table">
            <thead><tr><th>Source</th><th>Roll range</th></tr></thead>
            <tbody>
              <tr>
                <td>{{ selectedDesecrated.tierName || '—' }}</td>
                <td>{{ selectedDesecrated.display || selectedDesecrated.text }}</td>
              </tr>
            </tbody>
          </table>
          <footer>
            <span v-if="selectedDesecrated.tags?.length" class="mod-tags">
              <button v-for="t in selectedDesecrated.tags" :key="'dmtg'+t"
                class="tag-chip mini filter"
                :class="craft.tagFilters[t] || 'neutral'"
                :style="tagStyle(t)"
                @click="craft.cycleTagFilter(t)">{{ t }}</button>
            </span>
            <a :href="poedbEconomyUrl('Soul_Cores')" target="_blank" rel="noopener" class="poe2db-link">poe2db ↗</a>
          </footer>
        </div>
      </div>
    </section>
  `,
};
