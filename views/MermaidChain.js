// MermaidChain — renders a strategy chain via Mermaid client-side, with
// wheel-zoom / drag-pan and a near-fullscreen modal toggle. Mermaid is
// loaded lazily on first render via importmap (no build step).

import { ref, computed, watchEffect, onMounted, onUnmounted, nextTick } from 'vue';
import { chainToMermaid } from '../engine/strategies/chain-mermaid.js';

let mermaidInstance = null;
let mermaidLoading = null;

async function loadMermaid() {
  if (mermaidInstance) return mermaidInstance;
  if (!mermaidLoading) {
    mermaidLoading = import('mermaid').then((m) => {
      const mod = m.default ?? m;
      mod.initialize({
        startOnLoad: false,
        theme: 'dark',
        securityLevel: 'loose',
        // NOTE: We tried Mermaid's ELK renderer (defaultRenderer: 'elk')
        // because dagre is poor for cyclic graphs, but Mermaid 10.9's ELK
        // adapter throws on the linkStyle + subgraph + :::class combo we
        // emit ("Cannot read properties of null (reading 're')").
        // Falling back to dagre. ROADMAP entry tracks integrating elkjs
        // directly (bypassing Mermaid's wrapper) for proper cycle layout.
        flowchart: { curve: 'basis', useMaxWidth: false, htmlLabels: true },
      });
      mermaidInstance = mod;
      return mod;
    });
  }
  return mermaidLoading;
}

let renderUid = 0;
const nextId = () => `mermaid-chain-${++renderUid}`;

/**
 * Attach wheel-zoom + drag-pan handlers to a freshly rendered container's
 * SVG. Pan uses the container's scroll position; zoom resizes the SVG's
 * CSS box (not via CSS `transform`) so that scrollbars stay in sync with
 * the visible content size — fitting the graph also shrinks the scroll
 * area, so the user doesn't have to hunt the rendered chain inside
 * a giant scrollable region.
 */
function attachPanZoom(container) {
  const svg = container.querySelector('svg');
  if (!svg) return () => {};
  // Capture the SVG's natural size (preferred from viewBox; fall back to
  // the rendered bounding box). This is the "1:1" reference.
  const vb = svg.viewBox?.baseVal;
  const intrinsicW = (vb && vb.width)  ? vb.width  : svg.getBoundingClientRect().width;
  const intrinsicH = (vb && vb.height) ? vb.height : svg.getBoundingClientRect().height;
  // Default scale: fit the chart's natural width to the container so
  // the graph doesn't overflow horizontally on first render. The user
  // still sees a 1:1 button to zoom up, and Ctrl+wheel works
  // afterwards. We don't fit by height (the chain is tall and the
  // user expects to scroll vertically to follow the policy).
  let scale = 1;
  // Track whether the user has manually overridden scale (via zoom or
  // 1:1 button). While they haven't, every container-resize event
  // (including the `<details>` opening from 0-width to its final
  // width, which is when first render happens) re-fits to width. Once
  // the user takes control, leave their zoom alone.
  let userOverrode = false;
  const fitToWidth = () => {
    const cw = container.clientWidth;
    if (intrinsicW <= 0 || cw <= 0) return;
    if (intrinsicW > cw) scale = (cw / intrinsicW) * 0.98;
    else                 scale = 1;
  };
  const apply = () => {
    svg.style.width  = (intrinsicW * scale) + 'px';
    svg.style.height = (intrinsicH * scale) + 'px';
  };
  fitToWidth();
  apply();
  // ResizeObserver catches the late-mount case (chart inside a closed
  // <details> that has 0 width until expanded). Plain `resize` window
  // event won't fire on container-only changes.
  let ro = null;
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => {
      if (userOverrode) return;
      fitToWidth();
      apply();
    });
    ro.observe(container);
  }
  const setScale = (newScale, anchorClientX, anchorClientY) => {
    userOverrode = true; // user just zoomed — stop auto-fitting on resize
    // Lower bound = the scale at which the WHOLE graph just fits the
    // container (both axes). Zooming out beyond this is meaningless
    // (the chart shrinks but stays fully visible — the user gains
    // nothing). Falls back to the absolute floor of 0.05 when the
    // container hasn't been measured yet.
    const cw = container.clientWidth;
    const ch = container.clientHeight;
    let minScale = 0.05;
    if (intrinsicW > 0 && intrinsicH > 0 && cw > 0 && ch > 0) {
      minScale = Math.max(0.05, Math.min(cw / intrinsicW, ch / intrinsicH));
    }
    const next = Math.max(minScale, Math.min(8, newScale));
    if (next === scale) return;
    const rect = container.getBoundingClientRect();
    // Anchor point in SVG-content coordinates (intrinsic), at current scale.
    const ax = anchorClientX != null ? anchorClientX - rect.left + container.scrollLeft : 0;
    const ay = anchorClientY != null ? anchorClientY - rect.top  + container.scrollTop  : 0;
    const ratio = next / scale;
    scale = next;
    apply();
    if (anchorClientX != null) {
      container.scrollLeft = ax * ratio - (anchorClientX - rect.left);
      container.scrollTop  = ay * ratio - (anchorClientY - rect.top);
    }
  };
  const onWheel = (e) => {
    if (!e.ctrlKey && !e.metaKey && !e.altKey) return;
    e.preventDefault();
    const delta = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    setScale(scale * delta, e.clientX, e.clientY);
  };
  // Drag-to-pan via container scroll.
  let dragging = false, startX = 0, startY = 0, startSL = 0, startST = 0;
  const onMouseDown = (e) => {
    if (e.button !== 0) return;
    dragging = true;
    startX = e.clientX; startY = e.clientY;
    startSL = container.scrollLeft;
    startST = container.scrollTop;
    svg.style.cursor = 'grabbing';
    e.preventDefault();
  };
  const onMouseMove = (e) => {
    if (!dragging) return;
    container.scrollLeft = startSL - (e.clientX - startX);
    container.scrollTop  = startST - (e.clientY - startY);
  };
  const onMouseUp = () => { dragging = false; svg.style.cursor = 'grab'; };
  svg.style.cursor = 'grab';
  container.addEventListener('wheel', onWheel, { passive: false });
  svg.addEventListener('mousedown', onMouseDown);
  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);

  svg._panZoomReset = () => {
    userOverrode = true;
    scale = 1;
    apply();
    container.scrollLeft = 0;
    container.scrollTop  = 0;
  };
  svg._panZoomFit = () => {
    const cw = container.clientWidth;
    const ch = container.clientHeight;
    if (intrinsicW > 0 && intrinsicH > 0 && cw > 0 && ch > 0) {
      const sx = cw / intrinsicW, sy = ch / intrinsicH;
      scale = Math.max(0.05, Math.min(sx, sy) * 0.95);
      apply();
      // Center the chain in the container by setting scroll so the
      // shrunk SVG occupies the middle.
      container.scrollLeft = Math.max(0, (intrinsicW * scale - cw) / 2);
      container.scrollTop  = Math.max(0, (intrinsicH * scale - ch) / 2);
    }
  };

  return () => {
    if (ro) ro.disconnect();
    container.removeEventListener('wheel', onWheel);
    svg.removeEventListener('mousedown', onMouseDown);
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseup', onMouseUp);
  };
}

export default {
  props: {
    chain: { type: Object, default: null },
  },
  setup(props) {
    const svg = ref('');
    const error = ref(null);
    const loading = ref(false);
    const fullscreen = ref(false);
    // Layout direction for the Mermaid flowchart. Default 'TD'
    // (top-down) matches the chain's "start above, goal below"
    // reading order; users can switch to horizontal (LR / RL) or
    // bottom-up (BT) when the graph shape favours a different axis.
    const layoutDirection = ref('TD');
    const inlineRef = ref(null);
    const fsRef = ref(null);
    const id = nextId();
    let alive = true;
    let cleanupInline = () => {};
    let cleanupFs = () => {};

    const render = async () => {
      if (!props.chain) { svg.value = ''; return; }
      loading.value = true;
      error.value = null;
      try {
        const mermaid = await loadMermaid();
        const src = chainToMermaid(props.chain, { direction: layoutDirection.value });
        const result = await mermaid.render(`${id}-${Date.now()}`, src);
        if (!alive) return;
        svg.value = result.svg;
        await nextTick();
        cleanupInline();
        cleanupFs();
        if (inlineRef.value) cleanupInline = attachPanZoom(inlineRef.value);
        if (fsRef.value)     cleanupFs     = attachPanZoom(fsRef.value);
        // Re-fit on the next animation frame: `attachPanZoom` runs
        // synchronously after the SVG insert, but the container's
        // post-layout `clientWidth` isn't always settled yet (notably
        // in the embed view, where the chain mounts inside a
        // freshly-shown layout box). Without this kick, wide graphs
        // don't auto-fit on first render and overflow horizontally.
        if (typeof requestAnimationFrame !== 'undefined') {
          requestAnimationFrame(() => {
            const inlineFit = inlineRef.value?.querySelector?.('svg')?._panZoomFit;
            if (inlineFit) inlineFit();
            const fsFit = fsRef.value?.querySelector?.('svg')?._panZoomFit;
            if (fsFit) fsFit();
          });
        }
      } catch (e) {
        if (alive) error.value = String(e?.message ?? e);
      } finally {
        if (alive) loading.value = false;
      }
    };

    onMounted(() => {
      watchEffect(() => {
        void props.chain;
        void layoutDirection.value;   // re-render when user picks a new direction
        render();
      });
    });

    const onKey = (e) => { if (e.key === 'Escape') fullscreen.value = false; };
    if (typeof window !== 'undefined') window.addEventListener('keydown', onKey);
    onUnmounted(() => {
      alive = false;
      cleanupInline();
      cleanupFs();
      if (typeof window !== 'undefined') window.removeEventListener('keydown', onKey);
    });

    // Re-attach pan/zoom whenever fullscreen toggles (the FS DOM node is
    // mounted/unmounted by v-if).
    watchEffect(async () => {
      if (!fullscreen.value) return;
      await nextTick();
      cleanupFs();
      if (fsRef.value) cleanupFs = attachPanZoom(fsRef.value);
    });

    const reset = () => {
      const el = (fullscreen.value ? fsRef.value : inlineRef.value);
      el?.querySelector('svg')?._panZoomReset?.();
    };
    const fit = () => {
      const el = (fullscreen.value ? fsRef.value : inlineRef.value);
      el?.querySelector('svg')?._panZoomFit?.();
    };

    // Embed link: build a `mdp-embed` URL from the current
    // location's hash (which carries the `?s=...` craft state).
    // Lets the user open the headless graph view in a new tab —
    // useful for iframe sharing or for opening multiple craft
    // variants side-by-side without losing the planner context.
    const embedHref = computed(() => {
      if (typeof window === 'undefined') return null;
      const hash = window.location.hash || '#/poe2';
      // hash looks like `#/poe2?s=xxx` — extract the game segment +
      // query and rebuild as `#/<game>/mdp-embed?s=xxx`.
      const m = /^#\/([^/?]+)(.*)$/.exec(hash);
      if (!m) return null;
      const game = m[1];
      const rest = m[2] ?? '';
      return `${window.location.pathname}#/${game}/mdp-embed${rest}`;
    });

    // Per-state alternatives: which actions does the engine consider
    // at each chain node, and what's their Q-value? Surfaced as a
    // selector + table beneath the chain. Default to the start node.
    const selectedNodeId = ref(null);
    const selectedAlternatives = computed(() => {
      const states = props.chain?.states ?? [];
      if (!selectedNodeId.value && states.length) selectedNodeId.value = states[0].id;
      const node = states.find((s) => s.id === selectedNodeId.value);
      return node?.meta?.alternatives ?? [];
    });
    const selectedNodePolicy = computed(() => {
      const node = (props.chain?.states ?? []).find((s) => s.id === selectedNodeId.value);
      return node?.meta?.policy ?? null;
    });

    return {
      svg, error, loading, fullscreen, inlineRef, fsRef, reset, fit, embedHref,
      selectedNodeId, selectedAlternatives, selectedNodePolicy,
      layoutDirection,
    };
  },
  template: `
    <div class="mermaid-chain-wrap">
      <div class="mermaid-chain-toolbar">
        <button class="link" @click="fullscreen = true" :disabled="!svg">⤢ Open fullscreen</button>
        <a v-if="embedHref" class="link" :href="embedHref" target="_blank" rel="noopener"
           title="Open headless mermaid view in new tab — iframe-friendly, F5-safe">↗ Embed</a>
        <button class="link" @click="fit" :disabled="!svg" title="Fit to viewport">⤡ Fit</button>
        <button class="link" @click="reset" :disabled="!svg" title="Reset zoom">↺ 1:1</button>
        <label class="hint" title="Mermaid flowchart direction. TD = top-down (default), LR = left-right, RL = right-left, BT = bottom-up.">
          dir:
          <select v-model="layoutDirection" style="margin-left: 0.2rem; font-size: 0.78rem;">
            <option value="TD">↓ TD</option>
            <option value="LR">→ LR</option>
            <option value="RL">← RL</option>
            <option value="BT">↑ BT</option>
          </select>
        </label>
        <span class="hint">Ctrl/Cmd + scroll to zoom · drag to pan</span>
        <span v-if="loading" class="hint">Rendering chain…</span>
      </div>
      <p v-if="error" class="hint" style="color:#d96">Mermaid error: {{ error }}</p>
      <div class="mermaid-chain" ref="inlineRef" v-html="svg"></div>

      <details v-if="chain?.states?.length" class="chain-alternatives">
        <summary>
          Why this orb? — per-state action Q-values
          <small class="hint">(click to inspect alternatives at any chain node)</small>
        </summary>
        <div class="chain-alt-controls">
          <label>Node:
            <select v-model="selectedNodeId">
              <option v-for="cs in chain.states" :key="cs.id" :value="cs.id">
                {{ cs.id }} ({{ cs.kind }})
              </option>
            </select>
          </label>
        </div>
        <p v-if="!selectedAlternatives.length" class="hint">
          No alternatives — this node is terminal (goal / bricked / buy_base).
        </p>
        <table v-else class="chain-alt-table">
          <thead><tr><th>Action</th><th>Q (ex)</th><th>Δ vs optimal</th><th>Cost (ex)</th></tr></thead>
          <tbody>
            <tr v-for="a in selectedAlternatives" :key="a.actionId"
                :class="{ optimal: a.actionId === selectedNodePolicy }">
              <td>{{ a.actionId === selectedNodePolicy ? '★ ' + a.actionId : a.actionId }}</td>
              <td>{{ Number.isFinite(a.qValue) ? a.qValue.toFixed(2) : '∞' }}</td>
              <td>{{ Number.isFinite(a.deltaQ) ? '+' + a.deltaQ.toFixed(2) : '∞' }}</td>
              <td>{{ a.costEx?.toFixed?.(2) ?? a.costEx }}</td>
            </tr>
          </tbody>
        </table>
      </details>

      <div v-if="fullscreen" class="mermaid-fullscreen-backdrop" @click.self="fullscreen = false">
        <div class="mermaid-fullscreen">
          <header class="mermaid-chain-toolbar mermaid-fs-toolbar">
            <button class="link" @click="fit" title="Fit to viewport">⤡ Fit</button>
            <button class="link" @click="reset" title="Reset zoom">↺ 1:1</button>
            <span class="hint">Ctrl/Cmd + scroll to zoom · drag to pan · Esc closes</span>
            <button class="link mermaid-fs-close" @click="fullscreen = false">× close</button>
          </header>
          <div class="mermaid-chain mermaid-chain-fs" ref="fsRef" v-html="svg"></div>
        </div>
      </div>
    </div>
  `,
};
