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
    </section>
  `,
};
