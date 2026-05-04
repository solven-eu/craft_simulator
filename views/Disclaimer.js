import { computed } from 'vue';
import { useRoute } from 'vue-router';

const POE2_DISCLAIMER = {
  title: 'Path of Exile 2 — disclaimer',
  rightsHolder: 'Grinding Gear Games',
  rightsHolderUrl: 'https://www.grindinggear.com/',
  sources: [
    {
      what: 'Mod weights, item levels, tier names, mod IDs',
      source: `Krakenbul — <em>WEIGHTS + ILVLS</em> Google Sheet, distributed via the
        <a href="https://discord.gg/3VxKY6gt7j" target="_blank" rel="noopener">Prohibited Library Discord</a>.
        Cached locally as <code>data/poe2/mods.json</code>.`,
      license: "Community spreadsheet; respect the Discord's terms.",
    },
    {
      what: 'Essence catalog (target affixes, item-class restrictions)',
      source: `<a href="https://poe2db.tw/us/Essence" target="_blank" rel="noopener">poe2db.tw — Essences</a>.
        Enriched and cached as <code>data/poe2/essences.csv</code>.`,
      license: 'CC BY-NC-SA 3.0',
    },
    {
      what: 'Per-mod tags (damage / elemental / fire / life / …)',
      source: `<a href="https://poe2db.tw/us/Gloves_dex#ModifiersCalc" target="_blank" rel="noopener">poe2db.tw per-base modifier tables</a>.
        Cached as <code>data/poe2/mod_tags.json</code> (best-effort).`,
      license: 'CC BY-NC-SA 3.0',
    },
    {
      what: 'Orb / omen names, descriptions, icons',
      source: `<a href="https://poe2db.tw/us/Modifiers#Acronym" target="_blank" rel="noopener">poe2db.tw — Modifiers (Acronym tab)</a>.
        Snapshot via <code>scripts/update-poe2-item-descriptions.sh</code> into
        <code>data/poe2/item_descriptions.csv</code>. Wording drift between snapshots signals mechanic changes.`,
      license: 'CC BY-NC-SA 3.0',
    },
    {
      what: 'Desecration consumables (Bones / Skulls / Soul Cores)',
      source: `<a href="https://poe2db.tw/us/Desecrated_Modifiers#AbyssalifyRef" target="_blank" rel="noopener">poe2db.tw — Desecrated Modifiers</a>.
        Snapshot via <code>scripts/update-poe2-desecrated.sh</code> into
        <code>data/poe2/desecrated.csv</code> (item-class + ilvl restrictions per consumable).`,
      license: 'CC BY-NC-SA 3.0',
    },
    {
      what: 'Desecration consumable prices',
      source: `<a href="https://poe.ninja/poe2/economy/vaal/abyssal-bones" target="_blank" rel="noopener">poe.ninja — Abyssal Bones</a>.
        Manual screenshot (CF-blocked) → <code>data/poe2/desecrated_prices.csv</code>.`,
      license: 'poe.ninja terms; live rates fluctuate.',
    },
    {
      what: 'Omen catalog',
      source: `<a href="https://mobalytics.gg/poe-2/guides/omen-crafting" target="_blank" rel="noopener">Mobalytics — Omen Crafting</a>.
        Cached as <code>data/poe2/omens.csv</code>.`,
      license: "Used per Mobalytics' terms of use; no commercial reuse.",
    },
    {
      what: 'Currency / orb / essence prices',
      source: `<a href="https://poe.ninja/poe2/economy/vaal/currency" target="_blank" rel="noopener">poe.ninja PoE2 economy</a>.
        Manual screenshots; rates are user-editable in the app.`,
      license: 'poe.ninja terms; live rates fluctuate, treat seeded values as snapshots.',
    },
    {
      what: 'Crafting strategies (fracture-anchor, etc.)',
      source: `<a href="https://www.reddit.com/r/PathOfExile2/comments/1kbdnzv/beginner_crafting_guide_for_path_of_exile_2/" target="_blank" rel="noopener">r/PathOfExile2 community guide</a>.`,
      license: 'Inspirational; engine analytics derived independently.',
    },
  ],
};

const STUB_DISCLAIMER = (game) => ({
  title: game.toUpperCase() + ' — disclaimer',
  rightsHolder: 'its respective rights-holders',
  rightsHolderUrl: '#',
  sources: [],
  stub: true,
});

const DISCLAIMERS = { poe2: POE2_DISCLAIMER };

export default {
  props: ['game'],
  setup(props) {
    const route = useRoute();
    const game = computed(() => props.game || route.params.game || 'poe2');
    const data = computed(() => DISCLAIMERS[game.value] ?? STUB_DISCLAIMER(game.value));
    return { game, data };
  },
  template: `
    <section class="disclaimer">
      <h2>{{ data.title }}</h2>

      <p class="lede">
        Craft Simulator is a non-commercial, community-built planning tool. It does
        not host, mirror, or claim authorship of any game-publisher content.
        All in-game assets, names, and intellectual property belong to
        <a :href="data.rightsHolderUrl" target="_blank" rel="noopener">{{ data.rightsHolder }}</a>.
        This tool is not affiliated with or endorsed by them.
      </p>

      <template v-if="data.stub">
        <p class="hint">
          Data sources for <strong>{{ game }}</strong> have not been ingested yet.
          Only Path of Exile 2 is currently active —
          <router-link to="/poe2/disclaimer">see the PoE2 disclaimer</router-link>.
        </p>
      </template>

      <template v-else>
        <h3>Data sources</h3>
        <p>
          The crafting data used by this tool, for <strong>{{ data.title.split('—')[0].trim() }}</strong>,
          is aggregated from the community sources below. Each is attributed
          inline in the app and listed here with its license.
        </p>
        <table class="sources-table">
          <thead><tr><th>What</th><th>Source</th><th>License / terms</th></tr></thead>
          <tbody>
            <tr v-for="(s, i) in data.sources" :key="i">
              <td><strong v-html="s.what"></strong></td>
              <td v-html="s.source"></td>
              <td>{{ s.license }}</td>
            </tr>
          </tbody>
        </table>

        <h3>Licensing</h3>
        <p>
          Some redistributed data (essence catalog, mod tags from poe2db) is
          licensed under <strong>CC BY-NC-SA 3.0</strong>; the share-alike
          clause requires derivatives that incorporate this data to use the
          same license. Therefore the <strong>data assets in
          <code>data/{{ game }}/</code></strong> are redistributed under
          <a href="https://creativecommons.org/licenses/by-nc-sa/3.0/" target="_blank" rel="noopener">
          Creative Commons Attribution-NonCommercial-ShareAlike 3.0</a>.
        </p>
        <p>
          The <strong>application source code</strong> (Vue components, the
          analytical engine, scripts) is original work and may be relicensed
          by the project author under any compatible terms; a permissive code
          license such as MIT or Apache-2.0 alongside CC BY-NC-SA 3.0 data is
          a typical choice. (Project author to confirm.)
        </p>
        <p><strong>Use of this tool is non-commercial.</strong></p>

        <h3>Trademarks</h3>
        <p>
          All in-game item names, assets, and graphics for {{ data.title.split('—')[0].trim() }}
          are property of <a :href="data.rightsHolderUrl" target="_blank" rel="noopener">{{ data.rightsHolder }}</a>.
          Use of these names in this tool is for identification purposes only.
        </p>

        <h3>Limitations of liability</h3>
        <p>
          This tool computes <em>analytical estimates</em> based on
          community-aggregated data and user-editable parameters. Numbers are
          best-effort; actual crafting outcomes vary with patches, server-side
          rounding, undocumented mechanics, and individual luck. Do not use
          these estimates as a basis for real-money decisions.
        </p>

        <p class="hint">
          Source code, data caches, and update scripts are visible in this
          repository — <code>scripts/update-{{ game }}-data.sh</code> and
          friends — so all attributions remain traceable as the data refreshes.
        </p>
      </template>
    </section>
  `,
};
