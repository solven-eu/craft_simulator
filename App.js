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

    return { game, gameLabel, games };
  },
  template: `
    <main class="app">
      <header>
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
          <router-link :to="'/' + game + '/disclaimer'">full disclaimer & sources</router-link>
        </small>
      </footer>
    </main>
  `,
};
