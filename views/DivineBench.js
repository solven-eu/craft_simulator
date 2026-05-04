// Divine Bench — separate tab from the strategy MDP. Closed-form
// probability that N Divine Orbs improve a finished item to user-
// specified per-mod target value thresholds.
//
// State: a list of mods, each with { name, vmin, vmax, target }, plus
// a divine count budget N. Engine math lives in `engine/divine.js`;
// this view is purely the editor + summary table.

import { reactive, computed, ref } from 'vue';
import { useCraftStore } from '../stores/craft.js';
import {
  discretize, summarize,
} from '../engine/divine.js';

export default {
  setup() {
    const craft = useCraftStore();
    // Local state (not persisted to URL hash for now — keeps the
    // view self-contained while we iterate). Pre-populated with one
    // example row so the panel isn't empty on first open.
    const mods = reactive([
      { name: '+ to maximum Life', vmin: 30, vmax: 50, target: 45 },
    ]);
    const N = ref(10);
    const divinePriceEx = computed(() =>
      craft.effectiveCurrencies?.divine?.exaltedPer ?? 187);

    const summary = computed(() =>
      summarize(mods, { N: Number(N.value) || 0, divinePriceEx: divinePriceEx.value }));

    const addMod = () => {
      mods.push({ name: '', vmin: 0, vmax: 100, target: 80 });
    };
    const removeMod = (i) => mods.splice(i, 1);

    const fmt = {
      pct(p) { return Number.isFinite(p) ? `${(p * 100).toFixed(2)}%` : '—'; },
      ex(v) { return Number.isFinite(v) ? `${v.toFixed(0)} ex` : '∞'; },
      n(v, d = 1) { return Number.isFinite(v) ? v.toFixed(d) : '∞'; },
    };

    const bucketsPreview = (mod) => {
      const b = discretize(mod.vmin, mod.vmax);
      if (b.length <= 6) return b.join(', ');
      return `${b[0]}, ${b[1]}, …, ${b[b.length - 1]}  (${b.length} buckets)`;
    };

    return { mods, N, summary, addMod, removeMod, fmt, bucketsPreview };
  },

  template: `
    <section class="planner">
      <h2>Divine Bench</h2>
      <p class="hint">
        Closed-form probability that <em>N</em> Divine Orbs improve a
        finished item. Each Divine independently re-rolls every
        modifier's value within its range; you specify per-mod target
        thresholds (the floor you'd accept), and the bench reports
        P(success per divine), P(success within N divines), and
        E[divines needed]. Pure value-roll math — no state-space
        crafting.
      </p>
      <p class="hint">
        <strong>Discretization rule:</strong> if a mod's range
        (max−min) is ≥ 3, values are integer round-numbers.
        Otherwise the range splits into 10 evenly-spaced buckets.
        Uniform density across buckets.
      </p>

      <div class="divine-bench">
        <table class="divine-mods">
          <thead>
            <tr>
              <th>Modifier</th>
              <th>Range (min .. max)</th>
              <th>Target ≥</th>
              <th>Buckets</th>
              <th>P / divine</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(m, i) in mods" :key="i">
              <td><input v-model="m.name" placeholder="Mod name (display only)" /></td>
              <td>
                <input type="number" step="any" v-model.number="m.vmin" style="width:5rem" />
                ..
                <input type="number" step="any" v-model.number="m.vmax" style="width:5rem" />
              </td>
              <td><input type="number" step="any" v-model.number="m.target" style="width:6rem" /></td>
              <td class="hint">{{ bucketsPreview(m) }}</td>
              <td class="num">{{ fmt.pct(summary.perMod[i]?.pPerDivine) }}</td>
              <td><button class="link" @click="removeMod(i)" title="Remove this row">×</button></td>
            </tr>
          </tbody>
        </table>
        <p>
          <button class="link" @click="addMod">+ Add modifier</button>
        </p>

        <div class="divine-summary">
          <h3>Summary</h3>
          <label class="field inline">
            <span>Divine budget (N)</span>
            <input type="number" min="1" v-model.number="N" style="width:6rem" />
          </label>
          <table class="summary-grid">
            <tbody>
              <tr>
                <th>Divine price (live)</th>
                <td>{{ fmt.ex(summary.divinePriceEx) }}</td>
              </tr>
              <tr>
                <th>P(every target met) per single divine</th>
                <td>{{ fmt.pct(summary.pPerDivine) }}</td>
              </tr>
              <tr>
                <th>P(success within {{ N }} divines)</th>
                <td>{{ fmt.pct(summary.pWithinN) }}</td>
              </tr>
              <tr>
                <th>E[divines to first success]</th>
                <td>{{ fmt.n(summary.expectedDivines, 1) }}</td>
              </tr>
              <tr>
                <th>E[cost in exalted]</th>
                <td>{{ fmt.ex(summary.expectedCostEx) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <p class="hint" style="margin-top: 1rem">
        Caveats: assumes per-bucket uniform density (real PoE2 may
        weight rolls differently within the range — refine when
        measured data is available). Each modifier re-rolls
        independently. Affix identity and tier are unchanged by Divine
        Orb; only values move.
      </p>
    </section>
  `,
};
