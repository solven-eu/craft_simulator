import { computed } from 'vue';
import { useRoute } from 'vue-router';

export default {
  props: ['game'],
  setup(props) {
    const route = useRoute();
    const game = computed(() => props.game || route.params.game || 'poe2');
    return { game };
  },
  template: `
    <section class="about">
      <h2>About — {{ game.toUpperCase() }}</h2>
      <p>
        Craft Simulator is a closed-form analytical planner for crafting items in
        <strong>{{ game === 'poe2' ? 'Path of Exile 2' : game }}</strong>.
        Unlike the major existing tools, it does <em>not</em> rely on Monte
        Carlo simulation: every probability and expected cost is computed via
        Wallenius distributions, value iteration, and other closed-form
        techniques.
      </p>
      <p>
        See the <router-link :to="'/' + game + '/disclaimer'">disclaimer</router-link>
        for data sources and licensing.
      </p>

      <h3>Other crafting tools</h3>
      <p>
        These existing tools cover broader UX surface (full mod planner,
        full orb action set, fossil / harvest UI). Both rely on Monte
        Carlo simulation rather than closed-form analytics, which is
        what this project differentiates against — but they're worth
        knowing about, and useful as cross-references when validating
        edge-case probabilities.
      </p>
      <ul class="other-tools">
        <li>
          <a href="https://www.craftofexile.com/?game=poe2"
             target="_blank" rel="noopener">Craft of Exile (PoE2)</a>
          — full mod planner with cascade flow (type → base → ilvl →
          mod plan → method → simulate). UX reference for the wishlist
          → recipe → solver pipeline.
        </li>
        <li>
          <a href="https://pathofcrafting.net/craft/interactive"
             target="_blank" rel="noopener">Path of Crafting — Interactive</a>
          — alternative interactive crafter. Step-by-step orb-by-orb
          manual simulation; the "evaluate" button runs Monte Carlo
          trials.
        </li>
      </ul>
    </section>
  `,
};
