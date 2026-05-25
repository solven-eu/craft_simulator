// Chain sub-graph (loop) detection.
//
// Spec: docs/chain-rendering.md §7.
//
// A "loop" is a region of the chain where the optimal policy spends
// non-trivial time before progressing — captured analytically as a
// strongly-connected component (SCC) whose member states have a
// summed `expectedVisits` ≥ a threshold (default 3, see VISIT_THRESHOLD).
//
// Single-node self-loops (e.g. chaos-spam where every chaos roll
// returns to the same canonical state) ARE valid loops and are
// included — what matters is stationary behaviour, not node count.
//
// The box title is purely descriptive: it lists the orb action ids
// observed on intra-SCC edges, joined by `+` in descending order of
// transition-probability mass. No static "bundle map" — if exalt
// and annul truly co-cycle in an SCC, they emerge as `exalt+annul`
// from observed mass; if the engine bug-fragments them into separate
// SCCs, the title differs and surfaces the bug instead of papering
// over it.
//
// Output shape: array of
//   {
//     nodes: [stateId, …],          // member chain-state ids
//     dominantActions: [action, …], // intra-SCC actions, descending mass
//     totalVisits: number,          // Σ expectedVisits across nodes
//     sccIndex: number,             // index of the source SCC
//   }

/**
 * Detect inner-loop sub-graphs in a chain.
 *
 * @param {object} chain — `{ states, edges }` where each state has
 *   `id`, `meta?.policy`, `expectedVisits` and each edge has
 *   `from`, `to`, `prob`, `label` (first line of which is the action id).
 * @param {object} [opts]
 * @param {number} [opts.visitThreshold=3] — minimum summed
 *   `expectedVisits` for an SCC to surface as a loop. The default 3
 *   captures "the policy enters this region at least three times in
 *   expectation per attempt" — empirically the bar above which a
 *   loop is worth boxing visually rather than a one-off detour.
 * @returns {Array<object>} loop entries, in the order Tarjan emits
 *   their roots (post-order on the DFS).
 */
export function detectLoops(chain, opts = {}) {
  const visitThreshold = opts.visitThreshold ?? 3;
  const states = chain?.states ?? [];
  const edges = chain?.edges ?? [];
  if (!states.length) return [];
  // Build outbound adjacency keyed by state id. Each neighbour record
  // carries the destination, the action id (first line of the edge
  // label), and the probability — used for both SCC discovery and
  // post-pass mass accounting.
  const adj = new Map();
  for (const cs of states) adj.set(cs.id, []);
  for (const e of edges) {
    if (!adj.has(e.from) || !adj.has(e.to)) continue;
    const action = (e.label ?? '').split('\n')[0] || null;
    adj.get(e.from).push({ to: e.to, prob: e.prob ?? 0, action });
  }
  const sccs = tarjan(adj);
  const stateById = new Map(states.map((cs) => [cs.id, cs]));
  const out = [];
  for (let sccIndex = 0; sccIndex < sccs.length; sccIndex++) {
    const comp = sccs[sccIndex];
    // E[visits] threshold. Sum across every member; the policy may
    // visit different members on different iterations, so what
    // matters is total stationary residency, not per-node max.
    let totalVisits = 0;
    for (const id of comp) {
      const cs = stateById.get(id);
      if (cs && Number.isFinite(cs.expectedVisits)) totalVisits += cs.expectedVisits;
    }
    if (totalVisits < visitThreshold - 1e-9) continue;
    // Title: orb ids on intra-SCC edges, descending probability mass.
    // No external interpretation, no global bundle map (spec §7.3).
    const memberSet = new Set(comp);
    const actionMass = new Map();
    for (const id of comp) {
      for (const nb of adj.get(id) ?? []) {
        if (!memberSet.has(nb.to)) continue;
        if (!nb.action) continue;
        actionMass.set(nb.action, (actionMass.get(nb.action) ?? 0) + nb.prob);
      }
    }
    let dominantActions = [...actionMass.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([a]) => a);
    // Fallback: a singleton SCC whose only intra-edge is a self-loop
    // counts; if no intra-edges have actions (rare — e.g. action
    // metadata missing), fall back to the policy of the member states.
    if (!dominantActions.length) {
      const seen = new Set();
      for (const id of comp) {
        const p = stateById.get(id)?.meta?.policy;
        if (p && !seen.has(p)) { seen.add(p); dominantActions.push(p); }
      }
    }
    out.push({ nodes: [...comp], dominantActions, totalVisits, sccIndex });
  }
  return out;
}

/**
 * Iterative Tarjan's strongly-connected-components algorithm.
 * Recursion would blow the stack on large chains; the iterative
 * version uses an explicit call stack with per-frame state
 * `(node, neighbour-iterator-index, child-return)`.
 *
 * Returns an array of components, each component is an array of node
 * ids. Includes singleton components only when they have a self-loop
 * (i.e. they are genuinely a 1-node strongly-connected sub-graph) —
 * isolated nodes with no self-edge do NOT count as loops, which is
 * Tarjan's natural output and matches the spec.
 *
 * @param {Map<string, Array<{to: string}>>} adj — outbound adjacency.
 * @returns {Array<Array<string>>} SCCs.
 */
function tarjan(adj) {
  const indexMap = new Map();
  const lowlink = new Map();
  const onStack = new Set();
  const tarjStack = [];
  const sccs = [];
  let nextIndex = 0;
  // Quick lookup: does node `id` have a self-loop edge?
  const hasSelfLoop = (id) => (adj.get(id) ?? []).some((nb) => nb.to === id);
  for (const root of adj.keys()) {
    if (indexMap.has(root)) continue;
    const callStack = [{ node: root, iter: 0, childRet: null }];
    indexMap.set(root, nextIndex);
    lowlink.set(root, nextIndex);
    nextIndex++;
    tarjStack.push(root);
    onStack.add(root);
    while (callStack.length) {
      const frame = callStack[callStack.length - 1];
      const { node, iter, childRet } = frame;
      if (childRet != null) {
        lowlink.set(node, Math.min(lowlink.get(node), lowlink.get(childRet)));
        frame.childRet = null;
      }
      const neighbours = adj.get(node) ?? [];
      if (iter < neighbours.length) {
        const w = neighbours[iter].to;
        frame.iter = iter + 1;
        if (!indexMap.has(w)) {
          indexMap.set(w, nextIndex);
          lowlink.set(w, nextIndex);
          nextIndex++;
          tarjStack.push(w);
          onStack.add(w);
          callStack.push({ node: w, iter: 0, childRet: null });
        } else if (onStack.has(w)) {
          lowlink.set(node, Math.min(lowlink.get(node), indexMap.get(w)));
        }
      } else {
        if (lowlink.get(node) === indexMap.get(node)) {
          const comp = [];
          while (tarjStack.length) {
            const w = tarjStack.pop();
            onStack.delete(w);
            comp.push(w);
            if (w === node) break;
          }
          // Multi-node SCCs are loops. Singleton SCCs are loops ONLY
          // when the node has a self-loop edge — otherwise it's an
          // isolated transient and not a sub-graph.
          if (comp.length >= 2) sccs.push(comp);
          else if (comp.length === 1 && hasSelfLoop(comp[0])) sccs.push(comp);
        }
        callStack.pop();
        if (callStack.length) callStack[callStack.length - 1].childRet = node;
      }
    }
  }
  return sccs;
}
