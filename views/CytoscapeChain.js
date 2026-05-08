// CytoscapeChain — alternative chain renderer using cytoscape.js + fcose.
// Same prop contract as MermaidChain (`chain`); switchable via a toggle
// in the parent view. Cytoscape's force-directed `fcose` layout handles
// cycles natively and minimises edge length, fixing the "many edges very
// long unnecessarily" complaint dagre produced.

import { defineComponent, ref, watch, onMounted, onBeforeUnmount, h } from 'vue';
import { chainToCytoscape } from '../engine/strategies/chain-cytoscape.js';

let cyLib = null;
let cyLoading = null;
async function loadCy() {
  if (cyLib) return cyLib;
  if (!cyLoading) {
    cyLoading = (async () => {
      const cytoscape = (await import('cytoscape')).default;
      const fcoseMod = await import('cytoscape-fcose');
      const fcose = fcoseMod.default ?? fcoseMod;
      // Defensive registration: if fcose isn't a function (esm.sh
      // wrapping artefact), cytoscape.use(...) becomes a no-op and
      // the layout silently falls back to a built-in (often producing
      // a diagonal line — that's the symptom we keep hitting).
      // Throw loudly so the symptom is impossible to mistake for
      // success.
      if (typeof fcose !== 'function') {
        throw new Error(
          `cytoscape-fcose did not export a function (got ${typeof fcose}). ` +
          `The fcose layout will not be registered; cytoscape will fall back ` +
          `to a default layout and nodes may stack on a diagonal. ` +
          `Check the importmap entry for 'cytoscape-fcose'.`,
        );
      }
      cytoscape.use(fcose);
      cyLib = cytoscape;
      return cytoscape;
    })();
  }
  return cyLoading;
}

export default defineComponent({
  name: 'CytoscapeChain',
  props: {
    chain: { type: Object, default: null },
  },
  setup(props) {
    const containerRef = ref(null);
    const error = ref(null);
    const loading = ref(false);
    let cyInstance = null;

    const render = async () => {
      if (!props.chain || !containerRef.value) return;
      loading.value = true;
      error.value = null;
      try {
        const cytoscape = await loadCy();
        const { elements, style, layout } = chainToCytoscape(props.chain);
        if (cyInstance) {
          try { cyInstance.destroy(); } catch {}
          cyInstance = null;
        }
        cyInstance = cytoscape({
          container: containerRef.value,
          elements,
          style,
          layout,
          wheelSensitivity: 0.2,
          minZoom: 0.1,
          maxZoom: 4,
        });
      } catch (e) {
        error.value = String(e?.message ?? e);
      } finally {
        loading.value = false;
      }
    };

    // Mount-time render: queueMicrotask ran before the ref was bound,
    // so the first render() call short-circuited. onMounted fires
    // after the template has been inserted into the DOM, guaranteeing
    // containerRef.value is the actual <div>.
    onMounted(render);
    watch(() => props.chain, render, { immediate: false });

    onBeforeUnmount(() => {
      if (cyInstance) {
        try { cyInstance.destroy(); } catch {}
        cyInstance = null;
      }
    });

    return () => h('div', { class: 'cytoscape-chain-wrap' }, [
      error.value
        ? h('p', { class: 'error' }, `Cytoscape error: ${error.value}`)
        : null,
      loading.value
        ? h('p', { class: 'hint' }, '⏳ rendering chain…')
        : null,
      h('div', { ref: containerRef, class: 'cytoscape-chain' }),
    ]);
  },
});
