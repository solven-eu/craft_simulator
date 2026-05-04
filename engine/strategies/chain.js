// Markov-chain data shape shared by every strategy.
//
// Goal: one uniform structure that the Mermaid renderer can consume, so the
// user sees the *same* visual grammar across strategies — base, transient
// states, goal, reset. Reset is an explicit edge (often back to `base`),
// not a hidden geometric tail.
//
// State kinds drive node colours:
//   - 'start'     — entry point (the base item, fresh and unattempted)
//   - 'transient' — intermediate craft state
//   - 'goal'      — absorbing success
//   - 'reset'     — transient "reset" sink that the chain bounces back from
//                   (used when the reset itself has a non-trivial cost we
//                    want to surface as an edge)
//
// Edge kinds drive edge colours / dashing:
//   - 'orb'      — apply a crafting currency (cost in label)
//   - 'success'  — outcome lands in the goal set
//   - 'fail'     — outcome misses the goal, going back toward reset
//   - 'reset'    — explicit reset edge (annul-everything or buy-new-base)
//   - 'internal' — transition inside a Markov chain (for chaos-spam,
//                  exalt-annul cycle, etc.); label carries probability
//
// State `meta` is free-form and held alongside the label so a future
// renderer can show E[remaining cost], heat-mapping, etc.

/**
 * Canonical 4-node "geometric" chain.
 *
 * base ── orb ──▶ attempt ── p ──▶ goal
 *                    │
 *                    └── 1-p ──▶ reset ── reset cost ──▶ base
 *
 * Used by every strategy whose closed-form expression is "one orb
 * application, success geometric over attempts, reset between." For
 * Markov-rich strategies (chaos-spam, exalt-annul, fracture-anchor) the
 * `attempt` node is replaced by a state grid; the entry/exit pattern
 * stays identical.
 *
 * Pass numbers as raw values; this fn handles formatting.
 */
export function geometricChain({
  baseLabel,
  attemptLabel,
  orbName,
  orbCostEx,
  successProb,
  expectedAttempts,
  resetCostEx,
  resetMethod, // e.g. 'annul ×4' or 'procure new base'
}) {
  const fmt = (n) => Number.isFinite(n) ? n.toFixed(2) : '∞';
  const fmtP = (p) => Number.isFinite(p) ? (p < 0.001 ? p.toExponential(1) : p.toFixed(3)) : '—';
  const fmtA = (n) => Number.isFinite(n) ? (n >= 100 ? n.toFixed(0) : n.toFixed(1)) : '∞';
  return {
    states: [
      { id: 'base',    label: baseLabel,    kind: 'start' },
      { id: 'attempt', label: attemptLabel, kind: 'transient' },
      { id: 'goal',    label: '✓ goal',      kind: 'goal' },
    ],
    edges: [
      {
        from: 'base', to: 'attempt',
        label: `${orbName}\n${fmt(orbCostEx)} ex`,
        kind: 'orb',
      },
      {
        from: 'attempt', to: 'goal',
        label: `p=${fmtP(successProb)}\n× E[att]≈${fmtA(expectedAttempts)}`,
        kind: 'success',
      },
      {
        from: 'attempt', to: 'base',
        label: `1−p=${fmtP(1 - successProb)}\nreset ${fmt(resetCostEx)} ex\n(${resetMethod})`,
        kind: 'fail',
      },
    ],
    start: 'base',
    goals: ['goal'],
  };
}

/**
 * Optional informational fields on a chain (rendered as floating subgraphs
 * at the top of the diagram by `chainToMermaid`):
 *
 *   chain.glossary: [{ sym, desc }]
 *     Variable definitions, e.g. `{ sym: 'w', desc: 'wished mods on item' }`.
 *     Rendered as a "Legend" subgraph at top-left.
 *
 *   chain.wishlistInfo: [{ name, tier, perOrbProb, weight }]
 *     One row per wished mod with its tier selection and the marginal
 *     probability that a single orb application hits this mod. Helps the
 *     user reason about why some strategies are slow even at low p.
 *     Rendered as a "Wishlist" subgraph next to the legend.
 */
