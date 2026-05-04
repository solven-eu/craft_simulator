import { onMounted, computed, ref } from 'vue';
import { useCraftStore } from '../stores/craft.js';
import MermaidChain from './MermaidChain.js';

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
  components: { MermaidChain },
  setup() {
    const craft = useCraftStore();
    onMounted(() => { if (!craft.game) craft.selectGame(craft.gameId); });

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
     * Format a cost in Exalted; auto-switches to Divine when the cost
     * exceeds `craft.divThresholdDiv` divines. Threshold configurable in
     * Display preferences. Returns "X ex" or "X.X div".
     */
    const fmtCost = (costEx) => {
      if (!Number.isFinite(costEx)) return '∞';
      const divPer = craft.effectiveCurrencies?.divine?.exaltedPer;
      if (Number.isFinite(divPer) && divPer > 0
          && costEx > (craft.divThresholdDiv ?? 3) * divPer) {
        return `${fmt.num(costEx / divPer)} div`;
      }
      return `${fmt.num(costEx)} ex`;
    };

    /** Live "1 divine = X exalted" reading. */
    const divToEx = computed(() => {
      const div = craft.effectiveCurrencies?.divine;
      return div && Number.isFinite(div.exaltedPer) ? div.exaltedPer : null;
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

    return { craft, showSpecStep, fmt, toRef, fmtTime, fmtCost, divToEx, prefixesFull, suffixesFull,
             expand, collapse, isExpanded, confirmTier,
             selectedMod, openModModal, closeModModal, tagStyle,
             promptSaveCraft, confirmDeleteCraft, confirmOverwriteCraft, attemptMeaning,
             recipeText, recipeStatus, recipeExport, recipeImport };
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
              <input
                type="text" list="item-types-list"
                placeholder="— pick a type —"
                :value="craft.itemType ?? ''"
                @change="craft.itemTypes.includes($event.target.value) && craft.setItemType($event.target.value)"
              />
              <datalist id="item-types-list">
                <option v-for="t in craft.itemTypes" :key="t" :value="t"></option>
              </datalist>
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
            </label>
          </li>

          <li class="step" v-if="craft.base">
            <label class="field">
              <span>{{ showSpecStep ? '3' : '2' }}. Item level</span>
              <span class="ilvl-control">
                <input
                  type="range" min="1" max="86" step="1"
                  :value="craft.itemLevel"
                  @input="craft.setItemLevel($event.target.value)"
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
              <h5>Prefixes</h5>
              <h5>Suffixes</h5>
              <div class="prefix-col">
              <div v-for="(slot, i) in craft.slots.prefixes" :key="'p'+i" class="affix prefix" :class="{ filled: slot, fractured: slot?.fractured }">
                <template v-if="slot">
                  <span class="name">{{ craft.getModDisplay(slot.name, slot.tier) }}</span>
                  <span class="affix-controls">
                    <button v-if="slot.fractured || !craft.hasFractured()" class="link fracture-btn"
                      :class="{ active: slot.fractured }"
                      :title="slot.fractured ? 'fractured (locked) — click to unmark' : 'mark as fractured (lock this affix)'"
                      @click="craft.setStartingFractured('PREFIX', i, !slot.fractured)"><img src="./assets/fracturing-orb.svg" alt="fractured" class="orb-icon" /></button>
                    <select class="tier-select" :value="slot.tier"
                      @change="craft.setStartingTier('PREFIX', i, $event.target.value)">
                      <option v-for="t in craft.getAllTiers('PREFIX', slot.name)" :key="'pt'+i+t.tier" :value="t.tier" :disabled="!t.ilvlOk">
                        T{{ t.tier }} · {{ t.tierName }}{{ t.ilvlOk ? '' : ' (ilvl ' + t.ilvl + '+)' }}
                      </option>
                    </select>
                    <button class="link" @click="craft.removeFromStarting('PREFIX', i)">×</button>
                  </span>
                </template>
                <span v-else class="empty">— empty prefix —</span>
              </div>
              </div>
              <div class="suffix-col">
              <div v-for="(slot, i) in craft.slots.suffixes" :key="'s'+i" class="affix suffix" :class="{ filled: slot, fractured: slot?.fractured }">
                <template v-if="slot">
                  <span class="name">{{ craft.getModDisplay(slot.name, slot.tier) }}</span>
                  <span class="affix-controls">
                    <button v-if="slot.fractured || !craft.hasFractured()" class="link fracture-btn"
                      :class="{ active: slot.fractured }"
                      :title="slot.fractured ? 'fractured (locked) — click to unmark' : 'mark as fractured (lock this affix)'"
                      @click="craft.setStartingFractured('SUFFIX', i, !slot.fractured)"><img src="./assets/fracturing-orb.svg" alt="fractured" class="orb-icon" /></button>
                    <select class="tier-select" :value="slot.tier"
                      @change="craft.setStartingTier('SUFFIX', i, $event.target.value)">
                      <option v-for="t in craft.getAllTiers('SUFFIX', slot.name)" :key="'st'+i+t.tier" :value="t.tier" :disabled="!t.ilvlOk">
                        T{{ t.tier }} · {{ t.tierName }}{{ t.ilvlOk ? '' : ' (ilvl ' + t.ilvl + '+)' }}
                      </option>
                    </select>
                    <button class="link" @click="craft.removeFromStarting('SUFFIX', i)">×</button>
                  </span>
                </template>
                <span v-else class="empty">— empty suffix —</span>
              </div>
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
            <div class="desire-score-row" v-if="craft.targetTotals.desired || craft.targetTotals.required">
              <label class="field inline desire-score-slider">
                <span>Min desire score</span>
                <input type="range" min="0" :max="craft.maxDesireScore || 0" step="0.5"
                  :value="Math.min(craft.minDesireScore, craft.maxDesireScore || 0)"
                  :disabled="!craft.maxDesireScore"
                  @input="craft.setMinDesireScore($event.target.value)" />
                <input type="number" min="0" :max="craft.maxDesireScore || 0" step="0.5"
                  class="desire-score-number"
                  :value="craft.minDesireScore"
                  @input="craft.setMinDesireScore($event.target.value)" />
                <small class="hint">
                  / {{ craft.maxDesireScore }} max —
                  required mods must always be present; desired mods + tier
                  upgrades feed this soft pool. <em>(Score-aware solver pending — the strategy table currently approximates with a hit-count threshold.)</em>
                </small>
              </label>
            </div>
            <div class="target-sides-grid">
            <div class="target-side">
              <h4>Prefixes
                <small>({{ craft.targetSummary.prefixes.required }} required, {{ craft.targetSummary.prefixes.desired }} desired, {{ craft.targetSummary.prefixes.empty }}/3 empty)</small>
                <button class="link inline-add"
                  :disabled="craft.targetSummary.prefixes.empty + craft.targetSummary.prefixes.required >= 3"
                  @click="craft.addTargetEmpty('PREFIX')"
                  :title="craft.targetSummary.prefixes.empty + craft.targetSummary.prefixes.required >= 3 ? 'No prefix slot left — required + empty already fill 3/3' : 'Require an empty prefix slot'">+ empty prefix</button>
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
                  <button v-if="e.fractured || craft.fracturedTargetIdx() === -1"
                    class="link fracture-btn"
                    :class="{ active: e.fractured }"
                    :title="e.fractured ? 'fractured target (locked) — click to unmark' : 'mark this as the fractured target (only one allowed per item)'"
                    @click="craft.setTargetEntryFractured(e.idx, !e.fractured)"><img src="./assets/fracturing-orb.svg" alt="fractured" class="orb-icon" /></button>
                  <button class="pause-chip" :class="{ paused: e.disabled }"
                    :title="e.disabled ? 'Resume — re-include in analytics' : 'Pause — keep entry but exclude from analytics'"
                    @click="craft.setTargetEntryDisabled(e.idx, !e.disabled)">{{ e.disabled ? '▶' : '⏸' }}</button>
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
                      @input="craft.setTargetEntryTierBand(e.idx, craft.tierBandFor(e, craft.getAllTiers('PREFIX', e.name)).requiredTier == null ? null : Number($event.target.value), Number($event.target.value), craft.tierBandFor(e, craft.getAllTiers('PREFIX', e.name)).maxTier)" />
                    <span class="band-summary">T{{ craft.tierBandFor(e, craft.getAllTiers('PREFIX', e.name)).desiredTier }}</span>
                  </div>
                  <div v-if="!e.disabled && !craft.isEntryShadowed(e)" class="tier-score-row">
                    <span class="hint">score per tier:</span>
                    <label v-for="t in craft.getAllTiers('PREFIX', e.name)" :key="'tps'+e.idx+t.tier"
                           :class="{ rejected: (e.tierScores?.[t.tier] ?? 0) === 0, 'ilvl-locked': !t.ilvlOk, meaningless: t.tier > craft.tierBandFor(e, craft.getAllTiers('PREFIX', e.name)).desiredTier }"
                           :title="t.tierName + ' · ilvl ' + t.ilvl + (t.ilvlOk ? '' : ' (locked: requires ilvl ' + t.ilvl + '+)') + (t.tier > craft.tierBandFor(e, craft.getAllTiers('PREFIX', e.name)).desiredTier ? ' — meaningless: outside desired band' : '')">
                      <span>T{{ t.tier }}</span>
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
            </div>
            <div class="target-side">
              <h4>Suffixes
                <small>({{ craft.targetSummary.suffixes.required }} required, {{ craft.targetSummary.suffixes.desired }} desired, {{ craft.targetSummary.suffixes.empty }}/3 empty)</small>
                <button class="link inline-add"
                  :disabled="craft.targetSummary.suffixes.empty + craft.targetSummary.suffixes.required >= 3"
                  @click="craft.addTargetEmpty('SUFFIX')"
                  :title="craft.targetSummary.suffixes.empty + craft.targetSummary.suffixes.required >= 3 ? 'No suffix slot left — required + empty already fill 3/3' : 'Require an empty suffix slot'">+ empty suffix</button>
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
                  <button v-if="e.fractured || craft.fracturedTargetIdx() === -1"
                    class="link fracture-btn"
                    :class="{ active: e.fractured }"
                    :title="e.fractured ? 'fractured target (locked) — click to unmark' : 'mark this as the fractured target (only one allowed per item)'"
                    @click="craft.setTargetEntryFractured(e.idx, !e.fractured)"><img src="./assets/fracturing-orb.svg" alt="fractured" class="orb-icon" /></button>
                  <button class="pause-chip" :class="{ paused: e.disabled }"
                    :title="e.disabled ? 'Resume — re-include in analytics' : 'Pause — keep entry but exclude from analytics'"
                    @click="craft.setTargetEntryDisabled(e.idx, !e.disabled)">{{ e.disabled ? '▶' : '⏸' }}</button>
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
                      @input="craft.setTargetEntryTierBand(e.idx, craft.tierBandFor(e, craft.getAllTiers('SUFFIX', e.name)).requiredTier == null ? null : Number($event.target.value), Number($event.target.value), craft.tierBandFor(e, craft.getAllTiers('SUFFIX', e.name)).maxTier)" />
                    <span class="band-summary">T{{ craft.tierBandFor(e, craft.getAllTiers('SUFFIX', e.name)).desiredTier }}</span>
                  </div>
                  <div v-if="!e.disabled && !craft.isEntryShadowed(e)" class="tier-score-row">
                    <span class="hint">score per tier:</span>
                    <label v-for="t in craft.getAllTiers('SUFFIX', e.name)" :key="'tss'+e.idx+t.tier"
                           :class="{ rejected: (e.tierScores?.[t.tier] ?? 0) === 0, 'ilvl-locked': !t.ilvlOk, meaningless: t.tier > craft.tierBandFor(e, craft.getAllTiers('SUFFIX', e.name)).desiredTier }"
                           :title="t.tierName + ' · ilvl ' + t.ilvl + (t.ilvlOk ? '' : ' (locked: requires ilvl ' + t.ilvl + '+)')">
                      <span>T{{ t.tier }}</span>
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
            :title="craft.tagFilters[t] === 'include' ? 'including only this tag — click to exclude' :
                    craft.tagFilters[t] === 'exclude' ? 'excluding this tag — click to reset' :
                    'click to include only this tag'"
            @click="craft.cycleTagFilter(t)">{{ t }}</button>
          <button v-if="Object.keys(craft.tagFilters).length"
            class="link" @click="craft.clearTagFilters()">reset all</button>
        </div>

        <div v-if="craft.base" class="pool">
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
                      <template v-if="!isExpanded('add', 'PREFIX', m.name)">
                        <button class="link"
                          :disabled="prefixesFull || !m.ilvlOk"
                          :title="!m.ilvlOk ? 'Requires ilvl ' + m.requiredIlvl + '+' : (prefixesFull ? 'Prefix slots full (3/3)' : 'Click to choose a tier and add')"
                          @click="expand('add', 'PREFIX', m.name)">+ start</button>
                      </template>
                      <span v-else class="add-confirm">
                        <span class="hint">add as:</span>
                        <button v-for="t in m.allTiers" :key="'pcb'+m.name+t.tier"
                          class="link tier-btn"
                          :class="{ ineligible: !t.ilvlOk }"
                          :disabled="!t.ilvlOk"
                          :title="t.tierName + ' · ilvl ' + t.ilvl + (t.ilvlOk ? '' : ' (above current ilvl)')"
                          @click="confirmTier('add', 'PREFIX', m, t.tier)">T{{ t.tier }}</button>
                        <button class="link cancel" @click="collapse('add', 'PREFIX', m.name)" title="cancel">×</button>
                      </span>
                    </template>
                    <span v-else class="hint">on item</span>
                  </td>
                  <td>
                    <button class="mname mod-link" :title="'Click for tier details (T1..T' + m.tiersTotal + ')'"
                      @click="openModModal(m)">{{ m.name }}</button>
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
                      <template v-if="!isExpanded('add', 'SUFFIX', m.name)">
                        <button class="link"
                          :disabled="suffixesFull || !m.ilvlOk"
                          :title="!m.ilvlOk ? 'Requires ilvl ' + m.requiredIlvl + '+' : (suffixesFull ? 'Suffix slots full (3/3)' : 'Click to choose a tier and add')"
                          @click="expand('add', 'SUFFIX', m.name)">+ start</button>
                      </template>
                      <span v-else class="add-confirm">
                        <span class="hint">add as:</span>
                        <button v-for="t in m.allTiers" :key="'scb'+m.name+t.tier"
                          class="link tier-btn"
                          :class="{ ineligible: !t.ilvlOk }"
                          :disabled="!t.ilvlOk"
                          :title="t.tierName + ' · ilvl ' + t.ilvl + (t.ilvlOk ? '' : ' (above current ilvl)')"
                          @click="confirmTier('add', 'SUFFIX', m, t.tier)">T{{ t.tier }}</button>
                        <button class="link cancel" @click="collapse('add', 'SUFFIX', m.name)" title="cancel">×</button>
                      </span>
                    </template>
                    <span v-else class="hint">on item</span>
                  </td>
                  <td>
                    <button class="mname mod-link" :title="'Click for tier details (T1..T' + m.tiersTotal + ')'"
                      @click="openModModal(m)">{{ m.name }}</button>
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

        <div v-if="craft.base && craft.wishlistCounts.total" class="wishlist-summary">
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
              <span>Total budget (Ex)</span>
              <input type="number" min="0" step="any"
                :value="Number.isFinite(craft.totalBudgetEx) ? craft.totalBudgetEx : ''"
                placeholder="∞"
                @input="craft.setTotalBudgetEx($event.target.value)" />
              <small class="hint">
                default 1,870 ex ≈ 10 div · stop-loss for most players
                <span v-if="divToEx && Number.isFinite(craft.totalBudgetEx)">
                  · current = {{ (craft.totalBudgetEx / divToEx).toFixed(1) }} div
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
            <label class="field inline">
              <span>Per-action cap (Ex)</span>
              <input type="number" min="0" step="any"
                :value="Number.isFinite(craft.actionCostCapEx) ? craft.actionCostCapEx : ''"
                placeholder="∞"
                @input="craft.setActionCostCapEx($event.target.value)" />
              <small class="hint">drops actions costing more than this per use</small>
            </label>
            <label class="field inline">
              <span>Time → Ex (ex/sec)</span>
              <input type="number" min="0" step="0.01"
                :value="craft.timeWeightExPerSec"
                placeholder="0.1"
                @input="craft.setTimeWeightExPerSec($event.target.value)" />
              <small class="hint">unifies time + currency in V*; default 0.1 ⇒ 1 ex ≈ 10 sec. Set 0 to ignore time.</small>
            </label>
          </div>

          <div class="analytics" v-if="craft.targetEntries.length || Object.keys(craft.wishlist).length">
            <h4>
              Compare strategies <small>(closed-form, no simulation)</small>
              <button class="link evaluate-strategies-btn"
                :disabled="craft.strategiesEvaluating"
                @click="craft.evaluateStrategies()">
                {{ craft.strategiesEvaluating ? 'Evaluating…' : (craft.strategiesResults ? '↻ Re-evaluate' : '▶ Evaluate strategies') }}
              </button>
            </h4>
            <p v-if="!craft.strategiesResults" class="hint" style="margin-top: 0.4rem">
              Strategy analytics aren't computed reactively (Markov solves are heavy).
              Click <em>Evaluate strategies</em> when your wishlist + item state are settled.
            </p>
          </div>
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
                        <MermaidChain :chain="s.chain" />
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
          <div class="analytics mdp-panel" v-if="craft.targetEntries.length || Object.keys(craft.wishlist).length">
            <h4>
              Optimal MDP policy <small>(mixed-policy value-iteration)</small>
              <button class="link evaluate-strategies-btn"
                :disabled="craft.mdpEvaluating"
                @click="craft.solveMdp()">
                {{ craft.mdpEvaluating ? 'Solving…' : (craft.mdpResult ? '↻ Re-solve' : '▶ Solve MDP') }}
              </button>
              <label class="hint" style="margin-left: 0.6rem; font-weight: normal;"
                title="Prefix every chain node with its step id (e.g. [s5]) so you can refer to a specific node when discussing the policy. Disable when the chart gets too dense.">
                <input type="checkbox"
                  :checked="craft.showMdpStepIds"
                  @change="craft.setShowMdpStepIds($event.target.checked); craft.solveMdp();" />
                show step ids
              </label>
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
              <p class="hint">
                <strong title="Optimal value: the minimum total expected cost (in exalted, with time folded in via timeWeightExPerSec) to reach a goal state from the start, assuming the optimal action is chosen at every step. V*(s) at any state s already accounts for ALL downstream actions and brick risks — comparing actions means comparing per-state Q(s,a) = cost(a) + Σ p·V*(s'), which is what value iteration solves.">V* (start)</strong>
                = {{ Number.isFinite(craft.mdpResult.vStar) ? craft.mdpResult.vStar.toFixed(2) : '∞' }} ex
                · <strong>{{ craft.mdpResult.states.length }}</strong> reachable states
                · {{ craft.mdpResult.iters }} value-iteration sweeps
                · optimal start action = <code>{{ craft.mdpResult.policy.get(craft.mdpResult.start.stateKey) ?? '(none)' }}</code>
              </p>
              <p class="hint mdp-vstar-explainer">
                <em>V\*</em> = expected total cost (ex) to reach the goal from
                a given state under the optimal policy. It already includes
                every downstream orb, every brick + restart, every annul-cycle
                risk — no need to add per-step costs by hand. Two actions are
                compared via <code>Q(s,a) = cost(a) + Σ p·V*(s')</code>; the
                solver picks the action with the smallest <em>Q</em>.
              </p>
              <ul v-if="craft.mdpResult.warnings?.length" class="hint" style="color:#d96">
                <li v-for="w in craft.mdpResult.warnings" :key="w">⚠ {{ w }}</li>
              </ul>
              <p v-if="craft.mdpResult.budgetExcluded?.length"
                 class="hint" style="color:#d96">
                🚫 Excluded by budget ({{ craft.totalBudgetEx }} ex):
                <span v-for="(ex, i) in craft.mdpResult.budgetExcluded" :key="ex.actionId">
                  <code>{{ ex.actionId }}</code> ({{ ex.costEx.toFixed(0) }} ex){{ i < craft.mdpResult.budgetExcluded.length - 1 ? ', ' : '' }}
                </span>.
                Crafting is currently a best-effort under-budget run.
                <button class="link"
                  @click="craft.setTotalBudgetEx(Math.ceil(Math.max(...craft.mdpResult.budgetExcluded.map(e => e.costEx)))); craft.solveMdp();">
                  Set budget to {{ Math.ceil(Math.max(...craft.mdpResult.budgetExcluded.map(e => e.costEx))) }} ex
                </button>
                to unlock all of them.
              </p>
              <p v-if="craft.mdpResult.chain?.breakevenBudgetEx != null
                       && craft.totalBudgetEx < craft.mdpResult.chain.breakevenBudgetEx"
                 class="hint" style="color:#d96">
                💸 Current budget = <strong>{{ craft.totalBudgetEx }} ex</strong> is below the
                <strong>breakeven budget</strong> of
                <strong>{{ craft.mdpResult.chain.breakevenBudgetEx.toFixed(0) }} ex</strong>
                (= expected orb spending / P(success-on-one-attempt)
                = {{ craft.mdpResult.chain.bExpectedStart.toFixed(0) }} ex spent ÷
                {{ (craft.mdpResult.chain.pSuccessStart * 100).toFixed(2) }}% success).
                At any budget below this, the optimal item value clamps to 0 — the
                expected return on a single committed attempt is negative.
                <button class="link" @click="craft.setTotalBudgetEx(Math.ceil(craft.mdpResult.chain.breakevenBudgetEx)); craft.solveMdp();">Set budget to {{ Math.ceil(craft.mdpResult.chain.breakevenBudgetEx) }} ex</button>
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
                <MermaidChain :chain="craft.mdpResult.chain" />
              </details>
            </div>
          </div>
        </div>

        <details class="extra-pool"
          v-if="craft.base && craft.extraMods?.[craft.base]?.desecrated?.length">
          <summary>
            Desecrated modifiers
            <small>{{ craft.extraMods[craft.base].desecrated.length }} mods · only roll on Desecrated items</small>
          </summary>
          <ul class="extra-mod-list">
            <li v-for="(m, i) in craft.extraMods[craft.base].desecrated" :key="'des'+i">
              <span class="tname">{{ m.tier_name }}</span>
              <span class="mname">{{ m.text }}</span>
              <span v-if="m.tags?.length" class="mod-tags">
                <button v-for="t in m.tags" :key="'dt'+i+t"
                  class="tag-chip mini filter"
                  :class="craft.tagFilters[t] || 'neutral'"
                :style="tagStyle(t)"
                  @click="craft.cycleTagFilter(t)">{{ t }}</button>
              </span>
            </li>
          </ul>
        </details>

        <details class="extra-pool"
          v-if="craft.base && craft.extraMods?.[craft.base]?.essence?.length">
          <summary>
            Essence modifiers
            <small>{{ craft.extraMods[craft.base].essence.length }} mods · forced by an Essence consumable</small>
          </summary>
          <ul class="extra-mod-list">
            <li v-for="(m, i) in craft.extraMods[craft.base].essence" :key="'ess'+i">
              <span class="tname">{{ m.tier_name }}</span>
              <span class="mname">{{ m.text }}</span>
              <span v-if="m.tags?.length" class="mod-tags">
                <button v-for="t in m.tags" :key="'et'+i+t"
                  class="tag-chip mini filter"
                  :class="craft.tagFilters[t] || 'neutral'"
                :style="tagStyle(t)"
                  @click="craft.cycleTagFilter(t)">{{ t }}</button>
              </span>
            </li>
          </ul>
        </details>

        <details class="mechanics" v-if="craft.game && craft.omens.length">
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
            Defaults seeded from poe.ninja (Vaal, 2026-04-29). Rates are
            <strong>1 unit of this currency = X Exalted Orbs</strong>.
            Edit any value below; overrides are saved locally.
            <button class="link" @click="craft.resetRates()" v-if="Object.keys(craft.rateOverrides).length">
              reset all overrides
            </button>
          </p>
          <template v-for="kind in (craft.game?.CURRENCY_KINDS ?? [])" :key="kind.id">
          <details v-if="(craft.currenciesByKind[kind.id] ?? []).length"
                   class="rates-group" open>
            <summary>
              {{ kind.label }}
              <small v-if="craft.currenciesByKind[kind.id]">
                {{ craft.currenciesByKind[kind.id].filter(c => c.applicable).length }}
                / {{ craft.currenciesByKind[kind.id].length }} applicable to current item
              </small>
            </summary>
            <table class="rates-table">
              <thead><tr><th>Currency</th><th class="num">1 ↔ Exalted</th><th class="num" title="Time per single use, in seconds">Time (s)</th><th></th></tr></thead>
              <tbody>
                <tr v-for="c in (craft.currenciesByKind[kind.id] ?? [])" :key="c.id"
                    :class="{ overridden: c.overridden, 'not-applicable': !c.applicable }"
                    :title="c.applicable ? '' : c.reason">
                  <td class="ccy-name-cell">
                    <img v-if="craft.itemDescriptions?.[c.name]?.image_url"
                         :src="craft.itemDescriptions[c.name].image_url"
                         :alt="c.name" class="ccy-icon" loading="lazy" />
                    {{ c.name }} <small>({{ c.short }})</small>
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
                    <input v-if="Number.isFinite(c.timeSeconds)"
                      type="number" min="1" step="1"
                      :value="c.timeSeconds"
                      :readonly="!!c.timeBaseOrb"
                      :title="c.timeBaseOrb
                        ? ('Synced with ' + (craft.game?.orbs?.[c.timeBaseOrb]?.name ?? c.timeBaseOrb) + ' — edit that row to change')
                        : ('Time factor to use one ' + c.name + ' (seconds — at least 1s to glance at the outcome)')"
                      @input="!c.timeBaseOrb && craft.setTime(c.id, $event.target.value)" />
                    <span v-else class="hint">—</span>
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
            <span>Switch cost to Divine when above</span>
            <input type="number" min="0" step="any"
              :value="craft.divThresholdDiv"
              @input="craft.setDivThresholdDiv($event.target.value)" />
            <span>div</span>
            <small class="hint">Strategy table costs render in ex by default; auto-switches to div above this threshold.</small>
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
    </section>
  `,
};
