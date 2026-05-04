# Roadmap

A running list of ideas & enhancements past the current shipped state. Not
ordered strictly by priority — the top of each section is the highest-impact
item I'd reach for next.

## Mermaid chain visualisation

The strategy comparison table now exposes a Markov chain per strategy.
Iterations from there:

- **Switch renderer to Cytoscape.js** — Mermaid is fundamentally a
  flowchart tool; its dagre layout arcs cycles wildly, and its ELK
  adapter (in Mermaid 10.9) throws "Cannot read properties of null
  (reading 're')" on our linkStyle + subgraph + `:::class` combo so
  we can't even use it via Mermaid. Cytoscape.js is purpose-built for
  graphs, with native compound nodes (clusters), cycle-friendly layouts
  (`fcose`, `cose-bilkent`), and a "level of detail" abstraction toggle
  that fits naturally — same chain object, user dials the bucket key
  from `mask` (most detailed) → `(r,w,i,t)` → `(r,w)` → `success/fail`.
  Bigger refactor (~400KB extra dep), so deferred until the chain UX
  stabilises.
- **Integrate elkjs directly** — middle-ground option: drive the layout
  ourselves with elkjs (250KB) and render plain SVG. Bypasses Mermaid's
  flaky ELK adapter while keeping the Markov-chain-aware features
  (clusters, level-of-detail). Same data shape; smaller surface than
  Cytoscape but more work than waiting for Mermaid to fix theirs.
- **`reduceChain(chain, bucketKey)` utility** — now that summaryChain
  is dropped, derive the abstracted view by node-merging on a bucket
  key with edge probabilities summed. Keep the strategy emitting the
  detailed chain only; the renderer / utility computes the summary
  on demand.
- **Unify geometric strategies onto the bitmask chain** — emit the
  same detailed chain shape for alch / essence / exalt-fill / coupled
  / fracture-anchor; the `geometricChain` triangle helper becomes
  redundant. The chain is the same single Markov walk; "geometric"
  is just a degenerate subset where the Markov has 1 transient
  reaching the goal in expectation 1/p attempts.

- **Currency icons on edges** — replace the unicode glyphs (`✯`, `✦`, `✧`,
  `✂`, `🌀`) with real PoE orb icons. Two routes:
  - **Local assets** (preferred): ship a small set under `assets/orbs/*.png`
    or inline SVG. Zero round-trips, no third-party dependency, predictable
    layout. Mermaid edge labels with `htmlLabels: true` accept
    `<img src="./assets/orbs/exalted.png" width="14"/>`.
  - **Hot-link from poewiki.net**: technically works (no CORS issue for
    `<img>`), but adds ~20 third-party round-trips on first render and
    relies on the wiki's hosting + hot-link policy.
- **Heat-map annotation** — append `E[cost remaining] = N ex` to each
  transient state's label using the value-iteration vector already
  computed for exalt-annul cycles. The big payoff: turns the picture
  into "states you don't want to be in," which is the differentiator
  vs craftofexile.
- **Most-likely-path highlighting** — greedy max-prob walk from start;
  render its edges thicker / brighter so the modal trajectory stands
  out from low-probability branches. Helps when a 26-state grid would
  otherwise look like spaghetti.
- **Self-loop collapse toggle** — for exalt-annul, ~half the edges are
  no-op self-loops. A "hide self-loops" checkbox would clean up the
  dense view.
- **Tier-aware "pointless mod" states** — chaos-spam currently aggregates
  `T-w pointless mods` into one bucket. For Whittling-aware analytics
  each state would need to track tier composition (probably overkill
  until the v2 mixed-policy solver lands; revisit then).
- **Comparative chain** — one Mermaid graph rooted in a shared `base`
  with branches per strategy. Visually answers "which strategy gives
  me the cheapest path?" — but probably needs a smarter layout engine
  than Mermaid's auto.

## Strategy engine

- **Same-mod exclusion in exalt-annul** — chaos-spam now uses a *bitmask*
  Markov state over the wishlist (so per-state `qR / qW` correctly
  account for which wished mods are excluded from the pool because they
  are already on the item). Exalt-annul still uses the (r, w, t) count
  abstraction; for heterogeneous wished-weights this gives biased
  numbers. Lift the same bitmask treatment into the exalt-annul factory:
  state becomes (subsetMask, t) with t bounded by maxFilled. State
  count: 2^N × (maxFilled+1) — still tractable for typical wishlists.
- **Tier-aware analytics (Whittling)** — once same-mod exclusion is in,
  the next refinement is tier-tracking: Whittling forces removing the
  *lowest-tier* affix, which makes tier composition matter. State
  becomes (subsetMask + per-mod tier) — explodes quickly, so this is
  reserved for advanced scenarios. The user has explicitly deferred
  this until after the required-vs-soft split.
- **MDP-α — generic engine, single-action library, validated by unit tests**
  — `engine/mdp/`, public API `solveMDP(input)`. Input fully describes the
  problem (base item, desired mods, pool, rates, budget); output is an
  action graph + V* + π* + P(success within budget). Tests pin expected
  policies for parameterised rate scenarios (e.g. cheap Perfect Exalt vs
  expensive Perfect Exalt selects different optima for the bow-fracture
  case). Action library starts with alch / exalt / annul / fracturing /
  restart. Pruning is implicit in `argmin Q(s,a)` — no special-casing
  "skip pointless actions"; the value function naturally rejects them.
  Fracturing rule: ≥`minModsToFracture` mods on a Rare to be allowed
  (parameter, default per user spec).

- **MDP-β — omens (mostly compute, no new feature)** — fold each
  Sinistral / Dextral × {exalt, chaos} into its own action. State stays
  identical; only the action library grows. Pruning naturally surfaces
  "don't sinistral when no prefix slot open."

- **MDP-γ v1 — tier-aware via `pTierOk` × `qBoost`** ✅ **shipped**.
  Each wished mod carries `pTierOk` ∈ (0, 1] (P that a roll lands at
  acceptable tier). Each orb action carries `qBoost` ≥ 1, multiplying
  pTierOk on its draws (clamped to 1). Greater/Perfect orb variants
  are siblings of plain orbs in the action set
  (`exalt_greater` / `exalt_perfect` / `regal_greater` / etc.) — the
  MDP picks between them given costs + tier requirements. Adapter
  populates `pTierOk` from `tierScores`, `qBoosts` from a hardcoded
  game-rule table (Greater 4×, Perfect 100×). Tests:
  `tests/mdp-tier-aware.test.js` (6 scenarios). Closed-form
  strategies become removable once UI parity is reached — the MDP
  produces strictly better policies via mixed action selection.

- **Divine Bench — divine-roll optimization tab** ✅ **shipped (v1)**.
  New `/poe2/divine-bench` route in `router.js`, view in
  `views/DivineBench.js`, math in `engine/divine.js` (`discretize`,
  `pModMeetsTarget`, `pItemMeetsTargets`, `pSuccessWithinN`,
  `expectedDivinesToSuccess`, `summarize`). Discretization rule
  per user spec: range ≥ 3 ⇒ integer round-numbers, range < 3 ⇒
  10 evenly-spaced buckets. Uniform per-bucket density. 12 unit
  tests in `tests/divine.test.js`. UI surfaces P(per divine),
  P(within N divines), E[divines to success], E[cost in ex] using
  the live divine rate. v2 candidates: per-bucket weight tables
  when measured data is available, auto-load mod ranges from
  `mod_ranges.json`, multi-target Pareto-optimal stopping rules.
  *(Original spec, retained for v2 reference:)* Per-modifier value ranges sit on
  the item alongside affix identity / tier; **Divine Orb** re-rolls
  values within their tier's range without changing affix or tier.
  Today the engine ignores per-roll values entirely. The Divine
  Bench would let the user:
  1. Load a finished item (e.g. a 6-affix Rare).
  2. Per modifier, see the rolled value range (min..max) AND set a
     target threshold (e.g. "+3 to projectiles, +180% phys, 200+
     life — accept anything ≥ this").
  3. Compute P(item improvement after N divine orbs) — closed-form
     since each divine independently re-rolls all values within their
     tier ranges. P(target) per divine = ∏ P(value_i ≥ threshold_i).
     Geometric over N: P(improved within N divines) = 1 − (1 − p)^N.
  4. Surface E[divines to hit target], cost in ex (divine = 187 ex
     baseline), and ROI vs trading the item as-is.
  Implementation: new view `views/DivineBench.js` (own tab in PoE2
  view), engine helper `engine/divine.js` for the per-mod range math,
  data plumbing reuses the existing `mod_ranges.json` (per-base, per-
  mod, per-tier value text — already loaded by `loadModRanges()`).
  Pure UI / closed-form — no state-space cost, no MDP changes
  required.

- **MDP-γ v2 — exact tier-table integration** *(future)*. The
  `pTierOk × qBoost` model is a scalar approximation. v2 would
  replace it with per-mod tier-weight arrays, sampling tiers
  exactly during draws and tracking present-mod tier in state. Adds
  ~k× state-space cost (k = max acceptable tiers per mod). Worth
  doing only once v1 surfaces tangible mismatches in user-observed
  outcomes vs predicted V*.

- **MDP framing — phase A: diagnose** — for each chain, additionally
  solve for `V*(s)` (expected cost-to-goal) and `H*(s)` (expected
  hitting time) at *every* transient state, not just the start. Single
  extra linear solve over the existing transition matrix. Render:
  - Heat-map node background by `H*(s)` (green near goal, red far).
  - Per-state badge `E[steps] ≈ N`.
  - **`bricked` states** (strict trap): goal unreachable from this
    state under any pure orb action — reverse-BFS from goal excluding
    the restart action; every state not reached is bricked. Render
    with a distinct "bricked" treatment (skull, dim red); no outgoing
    reset edge needed — the user reads "bricked ⇒ start over"
    naturally. The user explicitly chose this representation.
  - **`near-trap` states**: `V*(s)` much higher than `V*(s_initial)`,
    e.g. `≥ V*(s_initial) + 2 × resetCost`. Orange "uphill" badge
    with the cost ratio. The bow-with-3-required-prefixes case lives
    here — goal is theoretically reachable but the loop is so high-
    probability that escape costs more than restarting.
  Phase A changes the *visualisation*, not the strategy logic.

- **MDP framing — phase B: optimal-mixed policy** — formalise an
  `engine/mdp.js` layer:
  - `Action = { id, cost, time, transitions: state → P(state') }`
  - `MDP = { states, actions(state) → Action[], goal: predicate }`
  - Each existing strategy maps to a "restricted action set" — e.g.
    exalt-annul = `{ exalt when t<max, annul when t=max }`. This
    means today's "strategies" are *each one specific deterministic
    policy*, not whole independent algorithms.
  - `restart` is always in `A(s)` with `cost = resetToWhite(s),
    transitions = { s_initial: 1 }`. It is *not rendered as an
    explicit edge* — instead, when restart dominates a state under
    `V*`, the state is marked `bricked` (with restart-cost shown on
    the badge) and the user reads "bricked ⇒ start over" implicitly.
  - Solve via value iteration. Output `π*(s) → Action`, plus the
    pruned chain showing only the optimal action's edges per state.
  - Surface as a **separate "Optimal mixed" panel** alongside the
    closed-form comparison table — not as a row in it. Framed as
    "closed-form table = quick rough estimates if you stick to one
    fixed strategy; MDP panel = the optimal mixed-policy answer."
    Two-tier UX preserves the speed of the rough comparison while
    giving the careful user a precise plan.
  - "Counter-productive edge" gets a precise definition: any edge
    from action `a` where `c(s, a) + Σ P · V*(s') > V*(s)`
    (i.e. `a ∉ argmin`). The per-strategy view can dim such edges
    ("you'd be better off doing X here"); the optimal-mixed view
    only shows the argmin action.
  - Memory note: `engine/policy.js` already scaffolded. The user's
    `project_strategies_as_actions.md` and `project_dominated_actions.md`
    memories already commit to this framing.
- **Reset sub-strategy reuse on remaining strategies** — `resetToWhite`
  is wired into alchemy / essence / exalt-fill / coupled-exalt-fill /
  fracture-anchor (rolled). `sideExaltFill` (sinistral / dextral) still
  uses a one-time amortised base price; the reset is partial (off-side
  preserved) so it needs a side-aware variant of `resetToWhite`.
- **Greater / Perfect Exalt accuracy** — `qBoost` is currently a coarse
  scalar (1.6× / 2.8×). Real model: integrate over per-tier weights so
  the bias maps correctly to *which* tiers are wished. Per-mod
  probabilities in the chain wishlist would then be exact.
- **Annul-cleanup probability** — chaos-spam currently appends a naive
  per-attempt annul tail without folding the success probability into
  `p`. Honest computation: each annul has `(T-w)/T` chance of removing
  a non-wished mod; chain `excess` annuls geometrically.
- **Score-aware solver** — current "requirement" is a hit-count
  threshold; user can express finer-grained desires via per-tier
  scores and `minDesireScore`, but the analytics ignore them. Need
  to fold them into the goal-set definition.

## UI / UX

- **Open chain in a tab/file** — for users who want to study the chain
  outside the browser. `chainToMermaid()` already returns plain text;
  a "copy as Mermaid" button or "open in Mermaid Live Editor" link
  is one-line.
- **Wished-mod tier picker on the chain wishlist** — currently the
  wishlist subgraph shows the user's chosen tier; click-to-edit would
  let users explore "what if I lower required to T3?" without leaving
  the chain view.
- **Comparison columns for outcome quality** — under each strategy
  row, surface "best you typically end with" vs "worst you can land
  on after hits/misses." Pairs naturally with the better/worse edge
  coloring already shown in chains.
- **Chain export** — PNG / SVG download of the rendered chain for
  blog posts, Discord shares, league-start guides.

## Data / scraping

- **Live poe.ninja rates** — currently the rates panel is manual
  (poe.ninja blocks fetch). The Playwright scrape script
  (`scripts/fetch-poe-ninja-rates.mjs`) is wired but needs to be run
  by hand. Consider a GitHub Action that produces a static JSON drop.
- **Essence / omen prices** — same problem; placeholders are in use.
- **Per-base spawn-weight overrides** — some bases gate certain mod
  *families* (e.g. only-corrupted, league-restricted). Today the data
  layer ignores these; user has to mentally subtract them.

## Multi-game

- **PoE 1** support — the engine layer is game-agnostic but no PoE 1
  data has been seeded. Mostly a data-import job + game-specific
  strategy adjustments (PoE 1 has different orb costs, action rules,
  Harvest crafting).
- **Diablo 4 / D4** — a longer reach, different mechanic family
  (tempering, masterworking) but the core probability-engine reuse
  story holds.

## Performance

- **Lazy chain rendering** — chains only render when the user opens
  the per-strategy details panel (already true). Could go further
  by precomputing only available strategies' chains and skipping
  ineligible ones.
- **Mermaid bundle size** — the CDN ESM build of mermaid 10.9 is
  ~700kB. Acceptable for a developer tool but worth swapping to
  a slimmer renderer (e.g. Graphviz WASM via @hpcc-js/wasm) if the
  chain UI grows significantly.
