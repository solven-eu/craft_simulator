// Headless MDP-graph view — strips the planner UI and renders just
// the Mermaid chain for the URL-encoded craft state. Designed for:
//   - iframe embeds: drop the URL into an <iframe> and the consumer
//     gets a self-contained chain visual.
//   - F5 reload: see the graph immediately on refresh, no clicks.
//   - Bug repro: paste a craft URL and see exactly what the engine
//     produces, side-by-side with the live planner view.
//
// Path: /:game/mdp-embed?s=<base64-uri-encoded-state>
// (the same `?s=` codec the planner uses to share craft state).

import { computed, ref, watch, onMounted } from 'vue';
import { useCraftStore } from '../stores/craft.js';
import MermaidChain from './MermaidChain.js';
import CytoscapeChain from './CytoscapeChain.js';

export default {
  components: { MermaidChain, CytoscapeChain },
  setup() {
    const craft = useCraftStore();
    // URL-driven renderer toggle: ?renderer=cytoscape switches engines.
    // Falls back to localStorage preference, then 'mermaid'.
    const params = typeof window !== 'undefined'
      ? new URLSearchParams(window.location.hash.split('?')[1] || '')
      : new URLSearchParams();
    const chainRenderer = ref(
      params.get('renderer')
      || (typeof localStorage !== 'undefined' && localStorage.getItem('chainRenderer'))
      || 'mermaid',
    );

    async function init() {
      // Ensure the game data is loaded — the URL state is decoded
      // automatically by the store on first read, but solveMdp
      // needs the loaded mods/essences/etc. before it can run.
      if (!craft.mods?.length) await craft.selectGame(craft.gameId || 'poe2');
      // One render tick so the store has settled with URL-derived
      // wishlist / target / starting slots before solving.
      await new Promise((r) => setTimeout(r, 0));
      craft.solveMdp();
    }

    onMounted(init);
    // Re-solve if the URL state changes (Vue Router emits a hashchange
    // for the same path with a different `?s=`, but the store updates
    // its fields via the URL-state subscription — so we just re-run).
    watch(() => craft.gameId, () => init());

    const status = computed(() => {
      if (!craft.game)              return 'Loading game data…';
      if (craft.mdpEvaluating)      return 'Solving MDP…';
      if (craft.mdpResult?.error)   return `Error: ${craft.mdpResult.error}`;
      if (!craft.mdpResult?.chain)  return 'Preparing solver…';
      return null;
    });
    const isLoading = computed(() =>
      !craft.game || craft.mdpEvaluating || (!craft.mdpResult?.error && !craft.mdpResult?.chain));

    const setRenderer = (v) => {
      chainRenderer.value = v;
      try { localStorage.setItem('chainRenderer', v); } catch {}
    };
    // Copy a textual dump of the chain's states + edges to the clipboard
    // so users can paste it into a debug session. Mermaid's SVG text
    // doesn't select cleanly, and the user explicitly asked for a way
    // to grab state labels (cold/fire mirror-pair debugging needs the
    // exact text on each node).
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
      try {
        await navigator.clipboard.writeText(text);
        console.log(`[copy-chain] copied ${text.length} chars to clipboard`);
      } catch (e) {
        console.error('[copy-chain] failed:', e);
        // Fallback: log to console so the user can copy from there.
        console.log(text);
      }
    };
    // Group orbs by family for the action-set panel — same logic as
    // Home.js. (Inlined here rather than factored into a shared
    // module to keep the embed view dependency-light.)
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
      const order = ['Alchemy','Transmute','Augment','Regal','Exalt','Annul','Chaos','Fracture','Vaal','Divine','Chance','Jeweller','Other'];
      return order.filter((f) => groups.has(f)).map((f) => ({ family: f, orbs: groups.get(f) }));
    });
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
    return { craft, status, isLoading, chainRenderer, setRenderer, copyChainDump, orbsByFamily, orbIconForId, orbRateEx, fmtRate };
  },
  template: `
    <div class="mdp-embed">
      <div v-if="isLoading" class="mdp-embed-loading" role="status" aria-live="polite">
        <div class="mdp-embed-spinner"></div>
        <p class="mdp-embed-status">{{ status }}</p>
      </div>
      <p v-else-if="status" class="hint">{{ status }}</p>
      <div v-if="craft.mdpResult?.chain" class="chain-renderer-toggle">
        <label class="hint">renderer:</label>
        <select :value="chainRenderer" @change="setRenderer($event.target.value)">
          <option value="mermaid">Mermaid (dagre, layered)</option>
          <option value="cytoscape">Cytoscape (fcose, force-directed)</option>
        </select>
        <label class="hint" style="margin-left: 0.6rem;"
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
        <button class="link" @click="copyChainDump" title="Copy a textual dump of every state's label and edge to the clipboard. Paste into chat / a bug report so labels can be inspected without DOM-fighting Mermaid's SVG selection.">📋 copy chain</button>
      </div>
      <details open v-if="craft.mdpResult?.chain && craft.game" class="orb-disable-panel">
        <summary>
          🔧 Action set <small class="hint">— untick to exclude ({{ Object.keys(craft.disabledOrbs ?? {}).length }} disabled)</small>
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
                  <span v-if="o.effect" class="tip-effect">{{ o.effect }}</span>
                  <em class="tip-hint">click to {{ (craft.disabledOrbs ?? {})[o.id] ? 'enable' : 'disable' }}</em>
                </span>
              </button>
            </div>
          </div>
        </div>
      </details>
      <CytoscapeChain v-if="craft.mdpResult?.chain && chainRenderer === 'cytoscape'" :chain="craft.mdpResult.chain" />
      <MermaidChain v-else-if="craft.mdpResult?.chain" :chain="craft.mdpResult.chain" />
    </div>
  `,
};
