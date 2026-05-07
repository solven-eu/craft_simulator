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

import { computed, watch, onMounted } from 'vue';
import { useCraftStore } from '../stores/craft.js';
import MermaidChain from './MermaidChain.js';

export default {
  components: { MermaidChain },
  setup() {
    const craft = useCraftStore();

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

    return { craft, status, isLoading };
  },
  template: `
    <div class="mdp-embed">
      <div v-if="isLoading" class="mdp-embed-loading" role="status" aria-live="polite">
        <div class="mdp-embed-spinner"></div>
        <p class="mdp-embed-status">{{ status }}</p>
      </div>
      <p v-else-if="status" class="hint">{{ status }}</p>
      <MermaidChain v-if="craft.mdpResult?.chain" :chain="craft.mdpResult.chain" />
    </div>
  `,
};
