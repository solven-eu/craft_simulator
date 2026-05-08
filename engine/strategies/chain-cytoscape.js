// Pure transducer: chain object → cytoscape.js elements/style/layout.
//
// Same input contract as chain-mermaid.js. The data model is identical
// (states, edges, loops, sccIndex, etc.); only the output format differs.
// Cytoscape was added because Mermaid's dagre layout produces unnecessarily
// long edges on cyclic chains — fcose handles cycles natively and bundles
// edges by minimising stroke length.

// Edge stroke-width by probability. Sqrt scale so 5% is visible (~1.5px)
// while 100% caps at ~4.5px — matches the Mermaid renderer's curve so
// switching engines doesn't change visual emphasis.
function strokeWidthForProb(prob) {
  if (!Number.isFinite(prob)) return 2;
  const p = Math.max(0, Math.min(1, prob));
  return 0.6 + 3.9 * Math.sqrt(p);
}

// Edge opacity by probability. Sqrt scale (matches width) with a 0.4
// floor so the rarest branch stays legible. High-probability edges
// stay vivid (1.0); low-probability fade to background.
function opacityForProb(prob) {
  if (!Number.isFinite(prob)) return 0.85;
  const p = Math.max(0, Math.min(1, prob));
  return 0.4 + 0.6 * Math.sqrt(p);
}

// Ideal edge length by probability — drives fcose's spring rest
// length per-edge. High-prob edges (the chain's trunk) should sit
// close together; rare branches can sprawl. Inverse relationship:
// p=1 → 80px, p≈0 → 380px. fcose reads this off `data(idealLength)`
// when the layout's `idealEdgeLength` returns the data value.
function idealLengthForProb(prob) {
  if (!Number.isFinite(prob)) return 180;
  const p = Math.max(0, Math.min(1, prob));
  return 80 + 300 * (1 - p);
}

// Mirror of chain-mermaid.js: importance score `pReach × max(1, log(1+visits))`
// and 6-tier opacity scale 0.60..1.00. Anchors (start / goal / bricked /
// near-trap) always full opacity.
const ALWAYS_VIVID = new Set(['start', 'goal', 'bricked', 'near-trap']);
const TIERS = [0.60, 0.68, 0.76, 0.84, 0.92, 1.00];

function importanceOf(s) {
  if (ALWAYS_VIVID.has(s.kind)) return Infinity;
  const p = Number.isFinite(s.pReach) ? s.pReach : 0;
  const v = Number.isFinite(s.expectedVisits) ? s.expectedVisits : p;
  if (p <= 0) return 0;
  return p * Math.max(1, Math.log(1 + v));
}

// Cytoscape's text rendering uses '\n' as the line break; the chain
// labels arrive with '\n' already, but Mermaid's renderer rewrites
// them as '<br/>' tags. Make sure we emit literal '\n' so wrap='wrap'
// produces multi-line node labels instead of one running string with
// '<br/>' visible as text.
function nodeLabel(s) {
  if (s == null) return '';
  return String(s)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/\r\n?/g, '\n');
}

// Edge labels go on a single curved arc; they don't wrap well, so
// flatten any '\n' into ' / '. The two-line "action / 50%" form
// Mermaid uses gets joined visually with the slash separator.
function edgeLabel(s) {
  if (s == null) return '';
  return String(s)
    .replace(/<br\s*\/?>/gi, ' / ')
    .replace(/\r\n?/g, '\n')
    .replace(/\n/g, ' / ');
}

/**
 * Convert an engine chain (states/edges/loops) into the cytoscape-ready
 * triple. Compound (parent) nodes are emitted for SCC and bundle-loop
 * subgraphs — cytoscape draws them as auto-sized boxes around their
 * children, mirroring Mermaid's nested-subgraph hierarchy.
 *
 * @param {object} chain — { states, edges, loops? }
 * @param {object} [options]
 * @param {string} [options.layoutName] — 'fcose' (default) | 'cola' | 'dagre'
 * @returns {{ elements: object[], style: object[], layout: object }}
 */
export function chainToCytoscape(chain, options = {}) {
  const layoutName = options.layoutName ?? 'fcose';
  const elements = [];
  const states = Array.isArray(chain?.states) ? chain.states : [];
  const edges  = Array.isArray(chain?.edges)  ? chain.edges  : [];
  const loops  = Array.isArray(chain?.loops)  ? chain.loops  : [];

  // Importance opacity
  let maxImportance = 0;
  for (const s of states) {
    if (ALWAYS_VIVID.has(s.kind)) continue;
    const I = importanceOf(s);
    if (Number.isFinite(I) && I > maxImportance) maxImportance = I;
  }
  const opacityFor = (s) => {
    if (ALWAYS_VIVID.has(s.kind) || maxImportance <= 0) return TIERS[TIERS.length - 1];
    const I = importanceOf(s);
    if (!Number.isFinite(I) || I === Infinity) return TIERS[TIERS.length - 1];
    const norm = Math.max(0, Math.min(1, I / maxImportance));
    const idx = Math.min(TIERS.length - 1, Math.floor(norm * TIERS.length));
    return TIERS[idx];
  };

  // ── Compound parents: outer SCC wraps + inner bundle-loops ────────
  // Group loops by sccIndex so SCCs containing ≥2 bundle-loops get an
  // outer parent; single-loop SCCs stay flat.
  const loopsBySccIndex = new Map();
  loops.forEach((loop, i) => {
    const k = Number.isInteger(loop.sccIndex) ? loop.sccIndex : -1 - i;
    if (!loopsBySccIndex.has(k)) loopsBySccIndex.set(k, []);
    loopsBySccIndex.get(k).push({ loop, idx: i });
  });

  // Map: stateId → bundle-loop parent id (e.g. 'loop_2'); null if not in any loop.
  const loopParentByNode = new Map();
  // Map: bundle-loop id → outer SCC parent id (or null when flat).
  const sccParentByLoop = new Map();

  for (const [sccKey, group] of loopsBySccIndex) {
    const useSccWrap = group.length >= 2 && sccKey >= 0;
    if (useSccWrap) {
      const totalVisits = group.reduce((a, g) => a + (g.loop.totalVisits ?? 0), 0);
      const bundles = [...new Set(group.map((g) => g.loop.bundle).filter(Boolean))];
      const macroLabel = `${bundles.join(' / ')} cycle · ~${totalVisits.toFixed(1)}× visits`;
      const sccId = `scc_${sccKey}`;
      elements.push({
        group: 'nodes',
        data: { id: sccId, label: macroLabel, kind: 'scc' },
      });
      for (const { loop, idx } of group) sccParentByLoop.set(`loop_${idx}`, sccId);
    }
    for (const { loop, idx } of group) {
      const loopId = `loop_${idx}`;
      const visitsTag = Number.isFinite(loop.totalVisits)
        ? ` · ~${loop.totalVisits.toFixed(1)}× visits`
        : '';
      const actionList = (loop.dominantActions || []).slice(0, 3).join(' + ');
      const label = actionList
        ? `${actionList} loop${visitsTag}`
        : `loop${visitsTag}`;
      elements.push({
        group: 'nodes',
        data: {
          id: loopId,
          label,
          kind: 'loop',
          parent: sccParentByLoop.get(loopId),
        },
      });
      for (const id of loop.nodes) loopParentByNode.set(id, loopId);
    }
  }

  // ── Pendant inclusion ─────────────────────────────────────────────
  // A node whose every neighbour (in OR out) sits inside a single
  // loop is visually part of that loop, even though Tarjan didn't
  // include it (Tarjan only finds states inside cycles). Most common
  // case: a goal terminal whose only incoming edges come from a
  // loop's members. Generalise the rule: any non-loop state whose
  // every edge connects to one specific loop gets pulled into that
  // loop's parent. Iterate to fixpoint so chains of pendants get
  // resolved (a → loop A → goal becomes loop A wraps both).
  const neighboursOf = (() => {
    const out = new Map();
    const ensure = (id) => { if (!out.has(id)) out.set(id, new Set()); return out.get(id); };
    for (const e of edges) {
      ensure(e.from).add(e.to);
      ensure(e.to).add(e.from);
    }
    return out;
  })();
  let changed = true;
  while (changed) {
    changed = false;
    for (const s of states) {
      if (loopParentByNode.has(s.id)) continue;
      const nbrs = neighboursOf.get(s.id);
      if (!nbrs || nbrs.size === 0) continue;
      // Collect distinct loop parents across neighbours; ignore self
      // and ignore neighbours that are themselves still un-parented.
      const parents = new Set();
      let hasUnparented = false;
      for (const n of nbrs) {
        if (n === s.id) continue;
        const p = loopParentByNode.get(n);
        if (p) parents.add(p);
        else hasUnparented = true;
      }
      // Pull in only when every neighbour belongs to the SAME loop
      // (no straddling between different loops, no top-level
      // neighbours that would dilute the inclusion).
      if (parents.size === 1 && !hasUnparented) {
        loopParentByNode.set(s.id, [...parents][0]);
        changed = true;
      }
    }
  }

  // ── State nodes ───────────────────────────────────────────────────
  for (const s of states) {
    elements.push({
      group: 'nodes',
      data: {
        id: s.id,
        label: nodeLabel(s.label),
        kind: s.kind,
        rarity: s.rarity ?? null,
        opacity: opacityFor(s),
        parent: loopParentByNode.get(s.id),
      },
    });
  }

  // ── Edges ─────────────────────────────────────────────────────────
  for (const e of edges) {
    const prob = Number.isFinite(e.prob) ? e.prob : 1;
    elements.push({
      group: 'edges',
      data: {
        id: `${e.from}__${e.to}__${(e.label ?? '').split('\n')[0]}`,
        source: e.from,
        target: e.to,
        label: edgeLabel(e.label),
        kind: e.kind ?? 'internal',
        prob,
        width: strokeWidthForProb(prob),
        // Per-edge fade: low-prob branches recede visually, high-prob
        // stay vivid. Read by the edge style selector via data().
        opacity: opacityForProb(prob),
        // Per-edge spring rest length: rare branches sprawl, trunk
        // edges pull tight. fcose reads this when configured below.
        idealLength: idealLengthForProb(prob),
      },
    });
  }

  // ── Style sheet ───────────────────────────────────────────────────
  // Cytoscape style is selector-based; we lean on `data(...)` mappers
  // so per-node opacity / per-edge width work without one class-def
  // per state.
  const style = [
    {
      selector: 'node',
      style: {
        'label': 'data(label)',
        'text-valign': 'center',
        'text-halign': 'center',
        'text-wrap': 'wrap',
        'text-max-width': 200,
        'font-size': 11,
        'color': '#ddd',
        'background-color': '#2a2a2a',
        'border-color': '#888',
        'border-width': 1.5,
        'shape': 'round-rectangle',
        // Auto-size nodes to fit their label. Without an explicit
        // size, fcose treats every node as a 30×30 default and
        // collapses long-label states onto each other — symptom is
        // the entire chain on a diagonal.
        'width': 'label',
        'height': 'label',
        'padding': '8',
        'opacity': 'data(opacity)',
      },
    },
    { selector: 'node[kind = "start"]',     style: { 'background-color': '#1e3a5f', 'border-color': '#5db', 'color': '#cfeaff' } },
    { selector: 'node[kind = "goal"]',      style: { 'background-color': '#1e4a2c', 'border-color': '#5d9', 'color': '#d6f5d8', 'shape': 'ellipse' } },
    { selector: 'node[kind = "reset"]',     style: { 'background-color': '#4a2c1c', 'border-color': '#d96', 'color': '#ffd9b8' } },
    { selector: 'node[kind = "bricked"]',   style: { 'background-color': '#3a1a1a', 'border-color': '#a44', 'color': '#fbb', 'font-weight': 'bold' } },
    { selector: 'node[kind = "near-trap"]', style: { 'background-color': '#3f2c14', 'border-color': '#d96', 'color': '#fc8', 'font-weight': 'bold' } },
    // Compound parents (loop / scc): no fill, soft border, label at top.
    {
      selector: 'node[kind = "loop"], node[kind = "scc"]',
      style: {
        'background-color': 'rgba(255, 255, 255, 0.02)',
        'border-color': '#666',
        'border-style': 'dashed',
        'border-width': 1,
        'text-valign': 'top',
        'text-halign': 'center',
        'text-margin-y': -8,
        'font-size': 10,
        'color': '#aaa',
        'font-style': 'italic',
        'shape': 'round-rectangle',
        'padding': 16,
        'opacity': 1,
      },
    },
    { selector: 'node[kind = "scc"]', style: { 'border-color': '#88a', 'border-width': 1.5 } },
    // Per-rarity stroke overlay.
    { selector: 'node[rarity = "normal"]', style: { 'border-color': '#eaeaea', 'border-width': 2 } },
    { selector: 'node[rarity = "magic"]',  style: { 'border-color': '#88aaff', 'border-width': 2 } },
    { selector: 'node[rarity = "rare"]',   style: { 'border-color': '#dcdc6e', 'border-width': 2 } },
    {
      selector: 'edge',
      style: {
        // taxi: orthogonal routing with rounded corners — the closest
        // Cytoscape gets to Mermaid's dagre-style segmented curves.
        // Each edge runs horizontally then vertically (or v/h with
        // auto direction) with a turn point partway through, plus a
        // gentle radius at the corner. Auto direction picks h vs v
        // per-edge based on source/target offset, which works well
        // for fcose's non-layered layout.
        'curve-style': 'taxi',
        'taxi-direction': 'auto',
        'taxi-turn': '50%',
        'taxi-turn-min-distance': 16,
        'taxi-radius': 12,
        'target-arrow-shape': 'triangle',
        'arrow-scale': 0.9,
        'width': 'data(width)',
        'line-color': '#888',
        'target-arrow-color': '#888',
        'label': 'data(label)',
        'font-size': 9,
        'color': '#aaa',
        'text-background-color': '#1a1a1a',
        'text-background-opacity': 0.85,
        'text-background-padding': 2,
        'opacity': 'data(opacity)',
      },
    },
    { selector: 'edge[kind = "success"]',   style: { 'line-color': '#4caf50', 'target-arrow-color': '#4caf50', 'color': '#9be3a8' } },
    { selector: 'edge[kind = "improving"]', style: { 'line-color': '#7bc481', 'target-arrow-color': '#7bc481', 'color': '#bde7c0' } },
    { selector: 'edge[kind = "fail"]',      style: { 'line-color': '#e07a5f', 'target-arrow-color': '#e07a5f', 'color': '#f5b09c', 'line-style': 'dashed' } },
    { selector: 'edge[kind = "reset"]',     style: { 'line-color': '#d97a4a', 'target-arrow-color': '#d97a4a', 'color': '#ffd0b0' } },
    { selector: 'edge[kind = "orb"]',       style: { 'line-color': '#5cb',    'target-arrow-color': '#5cb',    'color': '#cfeaff' } },
    // Self-loops need cytoscape's loop curve style explicitly —
    // unbundled-bezier with a single midpoint control collapses
    // a from===to edge to a single point.
    {
      selector: 'edge[source = data(target)]',
      style: {
        'curve-style': 'bezier',
        'control-point-step-size': 80,
        'loop-direction': '-45deg',
        'loop-sweep': '60deg',
      },
    },
  ];

  // ── Layout ────────────────────────────────────────────────────────
  // fcose: force-directed, handles cycles and compound nodes well.
  // `randomize: true` is critical — without it, fcose seeds from
  // existing positions, and since we're creating a fresh graph
  // every node starts at (0,0); the engine then resolves the
  // collision symmetrically along a diagonal, producing the line
  // artefact instead of a real layout.
  const layout = {
    name: layoutName,
    quality: 'proof',
    randomize: true,
    animate: false,
    // Spacing tuned for chain readability: tripled `nodeRepulsion`
    // and bumped `idealEdgeLength` so nodes don't pile up. Lower
    // `gravity` keeps the central pull from compressing the graph
    // back together. Compound children get extra padding via the
    // tiling-padding knobs so loop boxes have visible breathing room.
    nodeRepulsion: 14000,
    // Per-edge ideal spring length: read off the edge's `data.idealLength`
    // (stamped by `idealLengthForProb`). High-prob edges return a
    // shorter rest length so the trunk stays compact; rare branches
    // return a longer length so they can sprawl out.
    idealEdgeLength: (edge) => {
      const v = edge?.data?.('idealLength');
      return Number.isFinite(v) ? v : 180;
    },
    edgeElasticity: 0.35,
    nestingFactor: 0.6,
    gravity: 0.12,
    gravityRange: 3.0,
    gravityCompound: 1.0,
    numIter: 2500,
    tile: true,
    tilingPaddingVertical: 24,
    tilingPaddingHorizontal: 24,
    padding: 30,
    fit: true,
    sampleSize: 50,
    // Component packing keeps disconnected sub-chains from drifting
    // wildly apart — at this spacing they'd otherwise blow the
    // viewport. `componentSpacing` controls inter-component gap.
    packComponents: true,
    componentSpacing: 80,
  };

  return { elements, style, layout };
}
