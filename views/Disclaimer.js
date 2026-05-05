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
      source: `<a href="https://poe2db.tw/Economy_Abyssal_Bones" target="_blank" rel="noopener">poe2db.tw — Economy: Abyssal Bones</a>.
        Snapshot via <code>scripts/update-poe2-rates.sh</code> into
        <code>data/poe2/rates.csv</code> (older entries in
        <code>data/poe2/desecrated_prices.csv</code> retained as a
        historical seed).`,
      license: 'CC BY-NC-SA 3.0',
    },
    {
      what: 'Omen catalog',
      source: `<a href="https://poe2db.tw/Omen" target="_blank" rel="noopener">poe2db.tw — Omen</a>.
        Cached as <code>data/poe2/omens.csv</code>.`,
      license: 'CC BY-NC-SA 3.0',
    },
    {
      what: 'Currency / orb / essence prices',
      source: `<a href="https://poe2db.tw/Economy_Currency" target="_blank" rel="noopener">poe2db.tw — Economy tables</a>.
        Snapshot via <code>scripts/update-poe2-rates.sh</code> into
        <code>data/poe2/rates.csv</code>; rates are user-editable in the app.`,
      license: 'CC BY-NC-SA 3.0; live rates fluctuate, treat seeded values as snapshots.',
    },
    {
      what: 'Crafting strategies (fracture-anchor, etc.)',
      source: `Community guides on <a href="https://www.reddit.com/r/PathOfExile2/" target="_blank" rel="noopener">r/PathOfExile2</a>
        and the old-Reddit mirror at
        <a href="https://old.reddit.com/r/PathOfExile2/" target="_blank" rel="noopener">old.reddit.com/r/PathOfExile2</a>
        (the old subdomain serves plain HTML, which is cURL-friendly for
        offline analysis). Specific articles cited in commit messages and
        engine comments as they're consulted.`,
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
          The <strong>entire project — code AND data</strong> — is
          licensed under
          <a href="https://creativecommons.org/licenses/by-nc-sa/4.0/" target="_blank" rel="noopener">
          Creative Commons Attribution-NonCommercial-ShareAlike 4.0
          International (CC BY-NC-SA 4.0)</a>. Full license text in
          the repository's <code>LICENSE</code> file.
        </p>
        <p>
          Single-license-for-everything was chosen because:
          (i) some redistributed game data (poe2db tables, essence
          catalog, mod tags) is upstream-licensed under
          <strong>CC BY-NC-SA 3.0</strong>; the share-alike clause
          requires derivatives that incorporate this data to use the
          same license. CC BY-NC-SA 4.0 is one-way upgrade-compatible
          with 3.0 and satisfies the inheritance.
          (ii) keeping a single license across code and data avoids
          the maintenance overhead of dual-licensing for a fan tool
          where the data and the analysis engine are tightly coupled.
        </p>
        <p>
          What this means for users:
          <ul>
            <li><strong>You can</strong> share, fork, modify, redistribute
                the entire project (code + data) provided you keep
                the same license and credit the project.</li>
            <li><strong>You cannot</strong> use this tool, its code,
                or its data for primarily commercial purposes — no
                paywall, no embedding in a paid service, no commercial
                resale of derivative datasets.</li>
            <li><strong>Derivatives must remain CC BY-NC-SA 4.0.</strong></li>
          </ul>
        </p>
        <p>
          For software-licensing tooling (Snyk, FOSSA, npm dependency
          audits) that may not natively handle CC licenses on code:
          GitHub's license-detection picks up the root <code>LICENSE</code>
          file and tags the repo correctly; per-file SPDX headers were
          intentionally omitted to keep source files clean (the tool is
          a self-contained application, not a library to be vendored).
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
