import { computed, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useCraftStore } from './stores/craft.js';
import { games } from './games/index.js';

export default {
  setup() {
    const route = useRoute();
    const craft = useCraftStore();

    /** Current game from the route, with a fallback. */
    const game = computed(() => route.params.game || 'poe2');

    /** Sync the store's active game with the route. */
    watch(
      game,
      (g) => {
        if (!games[g]) return; // unknown game — leave the store alone
        if (g !== craft.gameId) craft.selectGame(g);
        else if (!craft.game) craft.selectGame(g); // first-load
      },
      { immediate: true },
    );

    /** Game-aware label for the page heading. */
    const gameLabel = computed(() => games[game.value]?.label ?? game.value);

    /** Embed mode hides the chrome (title + nav) so the chain
     *  can claim near-fullscreen — designed for iframes. The
     *  footer (legal / report-issue / disclaimer link) stays.
     *  Triggered by the `mdp-embed` route. */
    const embedMode = computed(() => route.name === 'mdp-embed');

    /** Build identifier from the <meta name="build-sha"> tag in
     *  index.html. The CI workflow rewrites the placeholder to the
     *  commit SHA at deploy time, so the footer can show users
     *  exactly which revision is live. Stays "dev" locally. */
    const buildSha = computed(() => {
      const tag = document.querySelector('meta[name="build-sha"]');
      return tag?.getAttribute('content') || 'dev';
    });
    const buildShaShort = computed(() => buildSha.value.slice(0, 8));
    const buildShaUrl = computed(() =>
      buildSha.value === 'dev'
        ? null
        : `https://github.com/solven-eu/craft_simulator/commit/${buildSha.value}`);

    return { game, gameLabel, games, embedMode, buildShaShort, buildShaUrl };
  },
  template: `
    <main class="app" :class="{ 'embed-mode': embedMode }">
      <header v-if="!embedMode">
        <h1>Craft Simulator <small class="game-tag">{{ gameLabel }}</small></h1>
        <nav>
          <router-link :to="'/' + game">Plan</router-link>
          <router-link :to="'/' + game + '/divine-bench'">Divine Bench</router-link>
          <router-link :to="'/' + game + '/about'">About</router-link>
          <router-link :to="'/' + game + '/disclaimer'">Disclaimer</router-link>
        </nav>
      </header>
      <router-view :game="game" />
      <footer class="app-footer">
        <small>
          Craft Simulator is not affiliated with or endorsed by Grinding Gear Games. ·
          {{ gameLabel }} content © its respective rights-holders · whole project
          licensed under
          <a href="https://creativecommons.org/licenses/by-nc-sa/4.0/" target="_blank" rel="noopener">CC BY-NC-SA 4.0</a> ·
          <a href="https://github.com/solven-eu/craft_simulator/issues" target="_blank" rel="noopener">🐛 report issue / ask question</a> ·
          <router-link :to="'/' + game + '/disclaimer'">full disclaimer & sources</router-link> ·
          <a v-if="buildShaUrl" :href="buildShaUrl" target="_blank" rel="noopener"
             :title="'Deployed commit — click to view on GitHub'">build {{ buildShaShort }}</a>
          <span v-else :title="'Local serving — no commit SHA injected'">build {{ buildShaShort }}</span>
        </small>
      </footer>
    </main>
  `,
};
