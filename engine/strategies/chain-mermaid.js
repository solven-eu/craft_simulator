// Serialize a strategy chain ({states, edges, start, goals}) into Mermaid
// `flowchart` syntax. Pure function; no DOM access.
//
// Flowchart (rather than stateDiagram-v2) was chosen because it supports
// per-edge styling via `linkStyle` (dashed for fail, thick for reset, etc.)
// and arbitrary node shapes — both useful for conveying the chain's
// dynamics at a glance.

function sid(id) {
  return String(id).replace(/[^a-zA-Z0-9_]/g, '_');
}

// Mermaid uses `<br/>` inside node labels for line breaks, double-quotes
// to wrap labels containing punctuation. We escape stray double-quotes
// and curly braces (the latter are reserved in mermaid).
function escapeLabel(s) {
  if (s == null) return '';
  return String(s)
    .replace(/"/g, "'")
    .replace(/[{}]/g, '')
    .replace(/\n/g, '<br/>');
}

// Node shape per kind: rounded for start, double-circle for goal, regular
// for transient. Mermaid syntax: `id["label"]`, `id(("label"))`, etc.
function nodeDecl(state) {
  const id = sid(state.id);
  const label = `"${escapeLabel(state.label)}"`;
  switch (state.kind) {
    case 'start': return `${id}([${label}])`;        // stadium
    case 'goal':  return `${id}(((${label})))`;      // double circle
    case 'reset': return `${id}[/${label}/]`;        // parallelogram
    case 'transient':
    default:      return `${id}[${label}]`;
  }
}

// Edge color/dash per kind. `stroke-width` is computed per-edge from
// the transition probability so high-prob branches read at a glance
// as the dominant path. Indexes are 1:1 with edges in declaration
// order when applied via `linkStyle`.
const EDGE_COLOR = {
  // Outcome-quality coloring: success (reaches goal) is the boldest green,
  // `improving` is a softer green for "item got better but not yet at the
  // goal", `fail` is dashed-red for degrading transitions, `internal` is
  // gray for flat / no-op transitions.
  success:   'stroke:#4caf50,color:#9be3a8',
  improving: 'stroke:#7bc481,color:#bde7c0',
  fail:      'stroke:#e07a5f,stroke-dasharray:4 3,color:#f5b09c',
  reset:     'stroke:#d97a4a,color:#ffd0b0',
  orb:       'stroke:#5cb,color:#cfeaff',
  internal:  'stroke:#888,color:#aaa',
};

// Map a transition probability ∈ [0, 1] to a stroke-width in px.
// Edges without a probability (e.g. deterministic orb steps) fall
// back to a default mid-width. The scale is non-linear: a prob=0.05
// tail still gets a visible 1px line; a prob=0.5 reads ~2.5px;
// prob=1 (deterministic) caps at 4.5px so the chart doesn't get
// dominated by buy_base reset arrows.
function strokeWidthForProb(prob) {
  if (!Number.isFinite(prob)) return 2;
  const p = Math.max(0, Math.min(1, prob));
  // Sqrt scale: emphasises low-prob edges enough to remain visible,
  // while still giving a clear visual lead to the dominant outcomes.
  return (0.6 + 3.9 * Math.sqrt(p)).toFixed(2);
}

const NODE_STYLE = {
  start:     'fill:#1e3a5f,stroke:#5db,color:#cfeaff',
  goal:      'fill:#1e4a2c,stroke:#5d9,color:#d6f5d8',
  reset:     'fill:#4a2c1c,stroke:#d96,color:#ffd9b8',
  transient: 'fill:#2a2a2a,stroke:#888,color:#ddd',
  // "bricked": no path to goal under any orb action — the user should
  //  restart the item. Rendered as a single sink node, dim red, skull.
  bricked:   'fill:#3a1a1a,stroke:#a44,color:#fbb,font-weight:bold',
  // "near-trap": V*(s) ≫ V*(start) + 2·resetCost, i.e. you'd be better
  //  off restarting than continuing. Orange-amber to distinguish from
  //  outright bricked.
  'near-trap': 'fill:#3f2c14,stroke:#d96,color:#fc8,font-weight:bold',
  legend:           'fill:#2c2c3a,stroke:#88b,color:#dde,font-size:11px',
  wishlist:         'fill:#2a3a2a,stroke:#8b8,color:#dfd,font-size:11px',
  wishlistSummary:  'fill:#1f2f1f,stroke:#5d8,color:#cfd,font-size:11px,font-weight:bold',
};

// Per-rarity border-colour overlays. Applied to MDP chain nodes via
// classDef + class assignment so the rarity is glance-able without
// reading the label. White / blue / yellow match the in-game rarity
// colours. Stroke is wider than the base style's so the colour reads
// even at low zoom; the fill stays from the kind-based style above.
const RARITY_STROKE = {
  normal: 'stroke:#eaeaea,stroke-width:3px',  // White (Normal)
  magic:  'stroke:#88aaff,stroke-width:3px',  // Blue (Magic)
  rare:   'stroke:#dcdc6e,stroke-width:3px',  // Yellow (Rare)
};

export function chainToMermaid(chain, options = {}) {
  if (!chain || !Array.isArray(chain.states) || !Array.isArray(chain.edges)) {
    return 'flowchart LR\n  NoChain["(no chain)"]';
  }
  // Layout direction is configurable: TD (top-down) is the default
  // since it matches normal HTML reading order (start at top, goal
  // at bottom) and avoids the wide-aspect issue LR creates for
  // long chains. LR / RL / BT exposed for users who prefer a
  // horizontal flow or reverse axes.
  const dir = options.direction ?? 'TD';
  const validDir = ['TD', 'TB', 'LR', 'RL', 'BT'].includes(dir) ? dir : 'TD';
  const lines = [`flowchart ${validDir}`];
  // Track invisible edges so we can hide them after declaration. Mermaid's
  // nested `direction TB` is unreliable inside a flowchart-LR parent, so we
  // chain items vertically with invisible edges. Keep their indices to apply
  // `linkStyle ... stroke:none` later.
  const invisibleEdgeIdx = [];
  let edgeIdx = 0;

  // Wishlist FIRST (so it sits left of the legend in the LR layout). Split
  // into Prefix and Suffix sub-subgraphs so the user can scan side-grouped
  // entries: prefixes column on the left, suffixes column on the right.
  // The pool-stats summary (Σ wished / required / irrelevant / total) sits
  // above, in its own row.
  if (Array.isArray(chain.wishlistInfo) && chain.wishlistInfo.length) {
    lines.push('  subgraph Wishlist ["Wishlist · per-orb hit probabilities"]');
    lines.push('    direction TB');
    const ps = chain.poolStats;
    let summaryNodeId = null;
    if (ps && Number.isFinite(ps.totalWeight) && ps.totalWeight > 0) {
      const wished = Math.round(ps.wishedWeight ?? 0);
      const total  = Math.round(ps.totalWeight);
      const irrel  = Math.max(0, total - wished);
      const wishedPct = (100 * (ps.wishedWeight ?? 0) / ps.totalWeight).toFixed(2);
      const irrelPct  = (100 * irrel / ps.totalWeight).toFixed(2);
      let reqLine = '';
      if (Number.isFinite(ps.requiredWeight) && ps.requiredWeight > 0) {
        const req = Math.round(ps.requiredWeight);
        const reqPct = (100 * ps.requiredWeight / ps.totalWeight).toFixed(2);
        reqLine = `<br/><b>Σ required</b> = ${req} (${reqPct}%)`;
      }
      const summary = `<b>Σ wished</b> = ${wished} (${wishedPct}%)`
                    + reqLine
                    + `<br/><b>irrelevant</b> = ${irrel} (${irrelPct}%)`
                    + `<br/><b>total pool</b> = ${total}`;
      lines.push(`    wish_summary["${summary}"]:::wishlistSummary`);
      summaryNodeId = 'wish_summary';
    }
    // Inner LR row of two columns: Prefixes (left) and Suffixes (right).
    lines.push('    subgraph WishlistRow [" "]');
    lines.push('      direction LR');
    const prefRows = [];
    const suffRows = [];
    chain.wishlistInfo.forEach((w, i) => {
      const tierLine = (w.tier != null) ? ` · T${w.tier}+` : '';
      const reqMark  = w.required ? ' <b>(req)</b>' : '';
      const probLine = Number.isFinite(w.perOrbProb)
        ? `<br/>p/orb=${(w.perOrbProb * 100).toFixed(2)}%${Number.isFinite(w.weight) ? ` (w=${Math.round(w.weight)})` : ''}`
        : '';
      const id = `wish_${i}`;
      const decl = `        ${id}["${escapeLabel(w.name)}${reqMark}${tierLine}${probLine}"]:::wishlist`;
      if (w.type === 'SUFFIX') suffRows.push({ id, decl });
      else                     prefRows.push({ id, decl });
    });
    lines.push('      subgraph WishlistP ["Prefix"]');
    lines.push('        direction TB');
    prefRows.forEach((r) => lines.push(r.decl));
    for (let i = 0; i < prefRows.length - 1; i++) {
      lines.push(`        ${prefRows[i].id} ~~~ ${prefRows[i + 1].id}`);
      invisibleEdgeIdx.push(edgeIdx++);
    }
    lines.push('      end');
    lines.push('      subgraph WishlistS ["Suffix"]');
    lines.push('        direction TB');
    suffRows.forEach((r) => lines.push(r.decl));
    for (let i = 0; i < suffRows.length - 1; i++) {
      lines.push(`        ${suffRows[i].id} ~~~ ${suffRows[i + 1].id}`);
      invisibleEdgeIdx.push(edgeIdx++);
    }
    lines.push('      end');
    // Force Prefix-left / Suffix-right side-by-side via invisible edge.
    if (prefRows.length && suffRows.length) {
      lines.push('      WishlistP ~~~ WishlistS');
      invisibleEdgeIdx.push(edgeIdx++);
    }
    lines.push('    end');
    if (summaryNodeId) {
      // Push summary on top of the row.
      lines.push(`    ${summaryNodeId} ~~~ WishlistRow`);
      invisibleEdgeIdx.push(edgeIdx++);
    }
    lines.push('  end');
  }

  // Legend SECOND so it lays out to the right of the Wishlist in the LR root.
  // An invisible edge from Wishlist → Legend forces same-row placement
  // (without it Mermaid auto-stacks unconnected subgraphs vertically).
  if (Array.isArray(chain.glossary) && chain.glossary.length) {
    lines.push('  subgraph Legend ["Legend / definitions"]');
    lines.push('    direction TB');
    chain.glossary.forEach((g, i) => {
      const txt = `<b>${escapeLabel(g.sym)}</b> — ${escapeLabel(g.desc)}`;
      lines.push(`    legend_${i}["${txt}"]:::legend`);
    });
    for (let i = 0; i < chain.glossary.length - 1; i++) {
      lines.push(`    legend_${i} ~~~ legend_${i + 1}`);
      invisibleEdgeIdx.push(edgeIdx++);
    }
    lines.push('  end');
    // Pin Legend to the right of Wishlist if both exist.
    if (Array.isArray(chain.wishlistInfo) && chain.wishlistInfo.length) {
      lines.push('  Wishlist ~~~ Legend');
      invisibleEdgeIdx.push(edgeIdx++);
    }
  }
  // Importance-based opacity. Goal: rare side branches recede
  // visually while the dominant policy path + chaos-loop states
  // stay vivid. Importance score:
  //   I = pReach × max(1, log(1 + expectedVisits))
  // The visits term keeps loop-prone states bright even when their
  // per-step pReach is moderate. Mapping I → opacity is normalised
  // against the chain's max. Floor at 0.60 (was 0.30) — the lower
  // floor made low-P state text genuinely hard to read on the dark
  // theme; this keeps the hierarchy but preserves legibility per
  // user request (2026-05-08). Terminals (start/goal/bricked/
  // near-trap) are always full opacity — they're narrative anchors.
  const ALWAYS_VIVID = new Set(['start', 'goal', 'bricked', 'near-trap']);
  const TIERS = [0.60, 0.68, 0.76, 0.84, 0.92, 1.00];
  const importanceOf = (s) => {
    if (ALWAYS_VIVID.has(s.kind)) return Infinity;
    const p = Number.isFinite(s.pReach) ? s.pReach : 0;
    const v = Number.isFinite(s.expectedVisits) ? s.expectedVisits : p;
    if (p <= 0) return 0;
    return p * Math.max(1, Math.log(1 + v));
  };
  let maxImportance = 0;
  for (const s of chain.states) {
    if (ALWAYS_VIVID.has(s.kind)) continue;
    const I = importanceOf(s);
    if (Number.isFinite(I) && I > maxImportance) maxImportance = I;
  }
  const tierForState = (s) => {
    if (ALWAYS_VIVID.has(s.kind) || maxImportance <= 0) return TIERS.length - 1;
    const I = importanceOf(s);
    if (!Number.isFinite(I) || I === Infinity) return TIERS.length - 1;
    const norm = Math.max(0, Math.min(1, I / maxImportance));
    const idx = Math.floor(norm * TIERS.length);
    return Math.min(TIERS.length - 1, idx);
  };
  // Stamp opacity onto each state in-place so edges can inherit it
  // (no second pass over states needed when we render edges below).
  for (const s of chain.states) {
    s._renderOpacity = TIERS[tierForState(s)];
  }
  // Inner-loop boxing. `chain.loops` (built by solve.js Tarjan SCC
  // → action-bundle sub-partition) groups states whose policy
  // traverses them cyclically. Two-level rendering:
  //  - Outer subgraph per SCC (when the SCC contains ≥2 bundle-loops):
  //    visualises "this is one cycle in graph terms, with multiple
  //    micro-phases inside". Title summarises the macro structure.
  //  - Inner subgraph per bundle-loop: titled by dominant actions
  //    (e.g. "annul + exalt loop · ~2.1× visits"). Always rendered.
  // SCCs containing a single loop render flat — no useless outer wrap.
  const loops = Array.isArray(chain.loops) ? chain.loops : [];
  const loopByNode = new Map();
  loops.forEach((loop, i) => {
    for (const id of loop.nodes) loopByNode.set(id, i);
  });
  // Group loops by their parent SCC.
  const loopsBySccIndex = new Map();
  loops.forEach((loop, i) => {
    const k = Number.isInteger(loop.sccIndex) ? loop.sccIndex : -i; // unique fallback per loop
    if (!loopsBySccIndex.has(k)) loopsBySccIndex.set(k, []);
    loopsBySccIndex.get(k).push({ loop, idx: i });
  });
  const loopStateById = new Map(chain.states.map((s) => [s.id, s]));
  // Helper to emit a bundle-loop subgraph at a given indent.
  const emitLoop = (loop, idx, indent) => {
    const visitsTag = Number.isFinite(loop.totalVisits)
      ? ` · ~${loop.totalVisits.toFixed(1)}× visits`
      : '';
    const actionList = (loop.dominantActions || []).slice(0, 3).join(' + ');
    const title = actionList
      ? `${actionList} loop${visitsTag}`
      : `loop${visitsTag}`;
    lines.push(`${indent}subgraph loop_${idx} ["${escapeLabel(title)}"]`);
    for (const id of loop.nodes) {
      const s = loopStateById.get(id);
      if (s) lines.push(`${indent}  ${nodeDecl(s)}`);
    }
    lines.push(`${indent}end`);
  };
  for (const [sccKey, group] of loopsBySccIndex) {
    if (group.length >= 2 && sccKey >= 0) {
      // Outer SCC wrap: aggregate visits + dominant bundles for the
      // macro title. Bundles list is short (~2-3 entries), reads as
      // "exalt+annul / chaos cycle".
      const totalVisits = group.reduce((a, g) => a + (g.loop.totalVisits ?? 0), 0);
      const bundles = [...new Set(group.map((g) => g.loop.bundle).filter(Boolean))];
      const macroTitle = `${bundles.join(' / ')} cycle · ~${totalVisits.toFixed(1)}× visits`;
      lines.push(`  subgraph scc_${sccKey} ["${escapeLabel(macroTitle)}"]`);
      for (const { loop, idx } of group) emitLoop(loop, idx, '    ');
      lines.push('  end');
    } else {
      // Single-loop SCC (or unparented loop): render flat.
      for (const { loop, idx } of group) emitLoop(loop, idx, '  ');
    }
  }
  // Non-loop nodes declared at top level.
  for (const s of chain.states) {
    if (loopByNode.has(s.id)) continue;
    lines.push(`  ${nodeDecl(s)}`);
  }
  // Edges (with labels). Mermaid supports `A -- "label" --> B` for labeled
  // arrows; works for every flowchart edge kind.
  chain.edges.forEach((e) => {
    const from = sid(e.from);
    const to   = sid(e.to);
    const label = escapeLabel(e.label);
    if (label) {
      lines.push(`  ${from} -- "${label}" --> ${to}`);
    } else {
      lines.push(`  ${from} --> ${to}`);
    }
  });
  // Per-edge styling. Indices include invisible edges declared earlier in
  // the legend / wishlist subgraphs, so chain edges are offset by
  // `invisibleEdgeIdx.length`.
  const offset = invisibleEdgeIdx.length;
  // Quick lookup for source-state importance so edges leaving a faded
  // state fade with it. (Built up once below; harmless if no states
  // have importance signals — every edge then renders at full opacity.)
  const stateById = new Map(chain.states.map((s) => [s.id, s]));
  chain.edges.forEach((e, i) => {
    const color = EDGE_COLOR[e.kind ?? 'internal'];
    if (!color) return;
    const width = strokeWidthForProb(e.prob);
    let style = `${color},stroke-width:${width}px`;
    // Inherit opacity from the source state's importance bucket so
    // edges from a faded peripheral state read as faded too. Avoids
    // the visual artefact of dim nodes connected by bright edges.
    const fromState = stateById.get(e.from);
    if (fromState && Number.isFinite(fromState._renderOpacity)) {
      style += `,opacity:${fromState._renderOpacity.toFixed(2)}`;
    }
    lines.push(`  linkStyle ${offset + i} ${style}`);
  });
  // Invisible edges in legend/wishlist subgraphs: hide them entirely.
  for (const idx of invisibleEdgeIdx) {
    lines.push(`  linkStyle ${idx} stroke:transparent,stroke-width:0px`);
  }
  // Per-node styling. classDef + class assignment.
  for (const [kind, style] of Object.entries(NODE_STYLE)) {
    lines.push(`  classDef ${kind} ${style}`);
  }
  const byKind = {};
  for (const s of chain.states) (byKind[s.kind ?? 'transient'] ||= []).push(sid(s.id));
  for (const [kind, ids] of Object.entries(byKind)) {
    if (NODE_STYLE[kind]) lines.push(`  class ${ids.join(',')} ${kind}`);
  }
  // Per-rarity border colour overlay. Mermaid lets a node belong to
  // multiple classes; the kind-class sets fill+text colour, the
  // rarity-class overrides stroke. Order matters — rarity classes
  // come AFTER kind classes so their stroke wins.
  for (const [rarity, style] of Object.entries(RARITY_STROKE)) {
    lines.push(`  classDef rarity_${rarity} ${style}`);
  }
  const byRarity = {};
  for (const s of chain.states) {
    if (!s.rarity || !RARITY_STROKE[s.rarity]) continue;
    (byRarity[s.rarity] ||= []).push(sid(s.id));
  }
  for (const [rarity, ids] of Object.entries(byRarity)) {
    lines.push(`  class ${ids.join(',')} rarity_${rarity}`);
  }
  // Importance opacity classDefs: bucket states into discrete tiers
  // so we emit O(buckets) classDefs instead of O(states). 6 tiers
  // between 0.30 and 1.00 give the eye enough resolution to read
  // "main path / common / occasional / rare side branch" at a glance.
  // The actual tier values are defined above (TIERS); mirroring is
  // intentional so this section reads standalone for the renderer
  // pass without scrolling back to the importance computation.
  for (let t = 0; t < TIERS.length; t++) {
    lines.push(`  classDef imp_${t} opacity:${TIERS[t].toFixed(2)}`);
  }
  const byTier = {};
  for (const s of chain.states) {
    (byTier[tierForState(s)] ||= []).push(sid(s.id));
  }
  for (const [t, ids] of Object.entries(byTier)) {
    lines.push(`  class ${ids.join(',')} imp_${t}`);
  }
  return lines.join('\n');
}
