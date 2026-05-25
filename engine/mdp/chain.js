// Chain (graph) builder — extracted from solve.js (2026-05-09).
// Same input shape buildChain previously consumed inside solve.js;
// the move keeps solve.js focused on the value-iteration pipeline
// and lets the chain rendering evolve independently. No public-API
// change: solve.js still imports and calls buildChain via the same
// arguments and returns the same chain shape.

import { isGoalState, isBrickedByFracture, stateKey, popcount } from './state.js';
import { detectLoops } from './chain-loops.js';

// ─────────────────────────────────────────────────────────
// Simple merge strategies (per docs/chain-rendering.md §3 / §8).
// These mutate `chainStates` and `chainEdges` in place.
// Labels for merged reps stay as the first member's natural label —
// no rewriting / disambiguator pass. The user accepts that labels
// are "off" for these strategies; the merge is the contribution.
// ─────────────────────────────────────────────────────────

/**
 * Generic key-based merge: every state gets a key, states sharing a
 * key collapse to one rep (the first state in BFS order). Edges
 * rewritten to point at reps; parallel edges with the same action
 * sum their probabilities. When a rep covers N members, outgoing
 * probability is averaged across the N source distributions.
 */
function applyKeyMerge(chainStates, chainEdges, keyOf) {
  // Probability formatter — mirrors the per-state edge labeller in
  // buildChain (line ~36). Used here to keep edge labels in sync
  // with `prob` after merge / renormalisation; otherwise the
  // renderer shows stale percentages while `e.prob` is correct
  // (user-visible bug 2026-05-09: "s28 has 2 edges each at 100%").
  const fmtP = (p) => {
    const pct = p * 100;
    if (pct < 0.01) return `${pct.toExponential(1)}%`;
    if (pct < 1)    return `${pct.toFixed(2)}%`;
    return `${pct.toFixed(1)}%`;
  };
  const updateLabel = (edge, action) => {
    edge.label = `${action}\n${fmtP(edge.prob)}`;
  };
  const keyMap = new Map(); // key → rep id
  const redirect = new Map(); // any id → rep id
  for (const cs of chainStates) {
    const k = keyOf(cs);
    if (!keyMap.has(k)) keyMap.set(k, cs.id);
    redirect.set(cs.id, keyMap.get(k));
  }
  const sourceCount = new Map();
  for (const cs of chainStates) {
    const rep = redirect.get(cs.id);
    sourceCount.set(rep, (sourceCount.get(rep) ?? 0) + 1);
  }
  const repIds = new Set(redirect.values());
  const repFiltered = chainStates.filter((cs) => repIds.has(cs.id));
  chainStates.length = 0;
  chainStates.push(...repFiltered);
  const merged = new Map();
  for (const e of chainEdges) {
    const from = redirect.get(e.from) ?? e.from;
    const to = redirect.get(e.to) ?? e.to;
    const action = (e.label ?? '').split('\n')[0];
    const k = `${from}|${to}|${action}`;
    const cur = merged.get(k);
    if (cur) {
      cur.prob = (cur.prob ?? 0) + (e.prob ?? 0);
      updateLabel(cur, action);
    } else {
      merged.set(k, { ...e, from, to });
    }
  }
  const groupTotals = new Map();
  for (const e of merged.values()) {
    const action = (e.label ?? '').split('\n')[0];
    const k = `${e.from}|${action}`;
    groupTotals.set(k, (groupTotals.get(k) ?? 0) + (e.prob ?? 0));
  }
  for (const e of merged.values()) {
    const action = (e.label ?? '').split('\n')[0];
    const total = groupTotals.get(`${e.from}|${action}`) ?? 1;
    if (total > 1 + 1e-6) {
      const n = sourceCount.get(e.from) ?? 1;
      if (n > 1) {
        e.prob = (e.prob ?? 0) / n;
        updateLabel(e, action);
      }
    }
  }
  chainEdges.length = 0;
  chainEdges.push(...merged.values());
}

/**
 * Bottom-up merge (spec §8). Iterative: each pass collects merge
 * candidates from a small set of rules, unions them via union-find,
 * applies the merge, repeats until no rule fires.
 *
 * Rules currently in play:
 *
 *   (R1) Sibling merge — when parent A's outgoing edges under one
 *        action α reach children B, C, … with the same next-action,
 *        merge those children. Spec §8.1.
 *
 *   (R2) Linear-chain merge — when A→B and both A and B have the
 *        same next-action α, merge A and B. Captures the case where
 *        a single orb-spam phase produces a long linear chain of
 *        states (e.g. annul-then-annul-then-annul before reaching
 *        a state where the policy switches). Iteratively collapses
 *        the whole linear segment into one rep.
 *
 *   (R3) Reverse-sibling merge (mirror of R1) — when B→A and C→A,
 *        both via the same action α, merge B and C. Sibling-by-
 *        destination: two predecessors that converge to the same
 *        successor under the same action are presentationally
 *        interchangeable (the user's view: "no matter where you
 *        started, this orb lands you at A").
 *
 * Termination: each pass either reduces |chainStates| (a successful
 * union shrinks the state count by ≥ 1) or fires no rule and breaks.
 * The state count is monotonically non-increasing, so the loop
 * terminates in at most |chainStates_initial| passes. Safety cap of
 * 1024 catches a hypothetical bug where union-find claims progress
 * but the merge doesn't take effect; we emit a console.warn on hit
 * so the bug surfaces visibly instead of just clipping the output.
 */
export function applyBottomUpSiblingMerge(chainStates, chainEdges) {
  // Union-find with path compression — one parent map per pass,
  // populated by collecting merge candidates from each rule and
  // unioning them.
  const unionFind = (size) => {
    const parent = new Map();
    const find = (x) => {
      let cur = x;
      while (parent.has(cur) && parent.get(cur) !== cur) cur = parent.get(cur);
      // Compress along the original path.
      let p = x;
      while (parent.has(p) && parent.get(p) !== p) {
        const nxt = parent.get(p);
        parent.set(p, cur);
        p = nxt;
      }
      return cur;
    };
    const ensure = (x) => { if (!parent.has(x)) parent.set(x, x); };
    const union = (a, b) => {
      ensure(a); ensure(b);
      const ra = find(a), rb = find(b);
      if (ra === rb) return false;
      // Stable rep: lowest numeric id wins, so passing the same
      // chain through the same rules deterministically picks the
      // same rep regardless of insertion order.
      const ai = parseInt(ra.replace(/^s/, ''), 10);
      const bi = parseInt(rb.replace(/^s/, ''), 10);
      if (ai <= bi) parent.set(rb, ra); else parent.set(ra, rb);
      return true;
    };
    return { find, union, ensure };
  };

  const SAFETY_CAP = 1024;
  for (let pass = 0; pass < SAFETY_CAP; pass++) {
    if (pass === SAFETY_CAP - 1 && typeof console !== 'undefined' && console.warn) {
      console.warn(
        `[chain bottom-up merge] hit ${SAFETY_CAP}-pass safety cap. ` +
        `Each pass should monotonically reduce state count, so this either ` +
        `means the chain is genuinely larger than 1024 states OR a rule is ` +
        `claiming progress without shrinking the state space. ` +
        `Current state count: ${chainStates.length}.`,
      );
    }
    const stateById = new Map(chainStates.map((cs) => [cs.id, cs]));
    const uf = unionFind(chainStates.length);
    for (const cs of chainStates) uf.ensure(cs.id);

    // Build outgoing-edges map once per pass.
    const outgoing = new Map();
    for (const e of chainEdges) {
      if (!outgoing.has(e.from)) outgoing.set(e.from, []);
      outgoing.get(e.from).push(e);
    }

    let anyUnion = false;

    // R1: sibling merge.
    for (const [from, edges] of outgoing) {
      const byPair = new Map();
      for (const e of edges) {
        if (e.to === from) continue;
        const childPolicy = stateById.get(e.to)?.meta?.policy ?? '-';
        const parentAction = (e.label ?? '').split('\n')[0];
        const key = `${parentAction}|${childPolicy}`;
        if (!byPair.has(key)) byPair.set(key, []);
        byPair.get(key).push(e.to);
      }
      for (const [, ids] of byPair) {
        if (ids.length < 2) continue;
        const seed = ids[0];
        for (let i = 1; i < ids.length; i++) {
          if (uf.union(seed, ids[i])) anyUnion = true;
        }
      }
    }

    // R2: linear-chain merge — A→B with same next-action.
    for (const e of chainEdges) {
      if (e.from === e.to) continue; // self-loop
      const aPolicy = stateById.get(e.from)?.meta?.policy;
      const bPolicy = stateById.get(e.to)?.meta?.policy;
      // Both endpoints must have a policy AND it must match. Skip
      // when either side has no policy (terminals: goal / brick) —
      // those aren't part of a same-action linear segment.
      if (!aPolicy || !bPolicy) continue;
      if (aPolicy !== bPolicy) continue;
      if (uf.union(e.from, e.to)) anyUnion = true;
    }

    // R3: reverse-sibling merge — B→A and C→A both via action α
    // (and B, C policies are α since the chain only emits policy
    // edges). Group edges by (to, action); any group with ≥2 distinct
    // sources → merge those sources.
    const incomingByPair = new Map();
    for (const e of chainEdges) {
      if (e.from === e.to) continue;
      const action = (e.label ?? '').split('\n')[0];
      const key = `${e.to}|${action}`;
      if (!incomingByPair.has(key)) incomingByPair.set(key, new Set());
      incomingByPair.get(key).add(e.from);
    }
    for (const [, sources] of incomingByPair) {
      if (sources.size < 2) continue;
      const arr = [...sources];
      const seed = arr[0];
      for (let i = 1; i < arr.length; i++) {
        if (uf.union(seed, arr[i])) anyUnion = true;
      }
    }

    if (!anyUnion) break;

    // Apply: keyOf returns the union-find root, so the existing
    // applyKeyMerge plumbing handles state filtering, edge merge,
    // probability renormalisation, and label sync.
    applyKeyMerge(chainStates, chainEdges, (cs) => uf.find(cs.id));
  }
}
// ─────────────────────────────────────────────────────────

// ---- Chain serialiser (compatible with the existing Mermaid renderer)
//
// The graph reflects what the user would ACTUALLY DO under the optimal
// policy:
//   - Walk π* from `start` via BFS — only reachable-under-optimal states
//     end up in the rendered graph. (Earlier we emitted every BFS-
//     discovered state; that produced orphan nodes that the user
//     spotted as "where do these even come from?".)
//   - States whose optimal action is `buy_base` are rendered as
//     `bricked` — operationally the policy says "stop and restart this
//     branch." Their outgoing reset edge is intentionally suppressed
//     (the bricked styling already implies "go back to start").
//   - Strict-bricked states (goal-unreachable under any action) keep
//     the same `bricked` kind too — the renderer doesn't need to
//     distinguish "near-trap" from "strict trap" for this purpose.
export function buildChain({ states, appsPerState, vStar, policy, target, startIdx, budgetEx, timeWeightExPerSec, showStepIds = true, wishlist = [], basePriceEx = 0, collapseEquivalent = true, mergeStrategy = 'top-down', policyEquivClassMap = null, actionDisplayMap: actionDisplayMapInput = null }) {
  // Stored on the chain output so external renderers (MermaidChain
  // alternatives table) can resolve action ids to friendly names —
  // mirrors what the engine uses internally for edge labels.
  const actionDisplayMap = actionDisplayMapInput;
  // Display-name lookup: replace generic action ids (e.g. `apply_bone`)
  // with the concrete name the adapter resolved (e.g. "Gnawed Jawbone")
  // when assembling the edge labels. Falls back to the raw id when no
  // mapping is provided or the id isn't in the map.
  const displayAction = (a) =>
    (actionDisplayMap && actionDisplayMap[a]) ? actionDisplayMap[a] : a;
  // Percentages read more naturally for orb-outcome odds. Below 0.01% use
  // scientific so 1e-6-class outcomes stay visible.
  const fmtP = (p) => {
    const pct = p * 100;
    if (pct < 0.01) return `${pct.toExponential(1)}%`;
    if (pct < 1)    return `${pct.toFixed(2)}%`;
    return `${pct.toFixed(1)}%`;
  };
  const fmtV = (v) => Number.isFinite(v)
    ? (v < 100 ? v.toFixed(2) : v.toFixed(0))
    : '∞';
  // itemValue(s) = expected profit of a single committed crafting
  // attempt with NO restart-on-brick. Backward induction on the chain
  // DAG:
  //   itemValue(goal)          = budgetEx
  //   itemValue(brick)         = 0          (give up the item, no recovery)
  //   itemValue(buy_base node) = 0          (policy says restart — count as "abandon")
  //   itemValue(s)             = -cost(π*(s)) + Σ p(o) · itemValue(o.next)
  //
  // For the canonical fractured-bow chain this gives:
  //   pre-fracture  → (budget − 2·annul)/3 − fracture_cost
  //   post-fracture → budget − 2·annul
  //   pre-1-annul   → budget − annul
  //   goal          → budget
  // i.e. exactly the recursive formula the user spelled out. The cost
  // is paid once per orb use (same value across outcomes of an action),
  // and brick / buy_base contribute 0 — capturing "you'd give up here,
  // not pay 100 for a fresh base and try again."
  // budgetEx=null ⇒ skip rendering (no value baseline given).
  const fmtVal = (v) => {
    if (!Number.isFinite(v)) return '−∞';
    if (Math.abs(v) < 0.5) return '0';
    if (Math.abs(v) < 100) return v.toFixed(1);
    return v.toFixed(0);
  };
  // BFS reachable-under-optimal-policy from start, computing P_reach
  // along the way. P_reach(s) = probability of arriving at s when
  // following π* from start (treating buy_base / bricked as absorbing
  // restart — we don't propagate through them). For pre-fracture
  // states P_reach=1; for post-fracture-success states P_reach equals
  // the success probability of the upstream fracture (e.g. 1/3 for a
  // 3-mod Rare). Lets the user compute "expected contribution" =
  // P_reach × itemValue if that framing is what they want, while we
  // keep the in-state itemValue = budget − V*(s) as the headline
  // number.
  // Reachable-set discovery (BFS) is independent of the pReach
  // computation — each state visited at most once here.
  const reachable = new Set();
  const reachQueue = [startIdx];
  while (reachQueue.length) {
    const i = reachQueue.shift();
    if (reachable.has(i)) continue;
    reachable.add(i);
    if (isGoalState(states[i], target)) continue;
    const a = policy[i];
    if (!a || a === 'buy_base') continue;
    if (isBrickedByFracture(states[i], target)) continue;
    const apps = appsPerState.get(i) ?? [];
    const app = apps.find((x) => x.actionId === a);
    if (!app) continue;
    for (const o of app.outcomes) {
      if (o.to === i) continue;
      reachQueue.push(o.to);
    }
  }
  // pReach computation via fixed-point iteration. The previous BFS-
  // accumulator approach added to successors' pReach on every
  // revisit, capped at 16 per state — producing up to 16× over-
  // count when cycles or fan-in pulled the same state through the
  // queue repeatedly. Fixed-point iteration is structurally correct:
  // pReach(s) = Σ over (parent → s, prob_p→s) of pReach(parent) × p,
  // computed by sweeping until no value changes. Self-loops are
  // skipped (they don't change the inflow).
  const pReach = new Map();
  pReach.set(startIdx, 1);
  for (const i of reachable) if (i !== startIdx) pReach.set(i, 0);
  // Pre-collect inbound edges per reachable state under π* AND
  // per-state self-loop probability. Self-loops are skipped from the
  // fixed-point sweep (they'd just hold pReach equal to itself), but
  // we re-introduce them analytically after convergence: with a
  // self-loop probability `pSelf(s)`, expected total visits to s =
  // inflow(s) / (1 − pSelf(s)) — the geometric series. Skipping
  // self-loops without that correction (the previous behaviour) caused
  // chaos-spam states' visit counts to be silently truncated, which
  // showed up as under-counted orbs in the user-facing materials
  // stockpile.
  const inbound = new Map();
  const selfLoop = new Map();
  for (const i of reachable) inbound.set(i, []);
  for (const i of reachable) {
    if (isGoalState(states[i], target)) continue;
    const a = policy[i];
    if (!a || a === 'buy_base') continue;
    if (isBrickedByFracture(states[i], target)) continue;
    const apps = appsPerState.get(i) ?? [];
    const app = apps.find((x) => x.actionId === a);
    if (!app) continue;
    for (const o of app.outcomes) {
      if (o.to === i) {
        selfLoop.set(i, (selfLoop.get(i) ?? 0) + o.prob);
        continue;
      }
      const arr = inbound.get(o.to);
      if (arr) arr.push({ from: i, prob: o.prob });
    }
  }
  for (let iter = 0; iter < 200; iter++) {
    let maxDelta = 0;
    for (const i of reachable) {
      if (i === startIdx) continue;
      let next = 0;
      for (const inEdge of inbound.get(i) ?? []) {
        // Inbound from a state with a self-loop: each visit to the
        // parent contributes `prob` to inflow, but the parent is
        // visited 1/(1 − pSelf(parent)) times in expectation. Apply
        // that geometric scaling here so child states inherit the
        // upstream loop multiplier rather than just the single-pass
        // probability.
        const parentLoop = selfLoop.get(inEdge.from) ?? 0;
        const parentScale = parentLoop > 0 && parentLoop < 1 ? 1 / (1 - parentLoop) : 1;
        next += (pReach.get(inEdge.from) ?? 0) * inEdge.prob * parentScale;
      }
      const delta = Math.abs(next - (pReach.get(i) ?? 0));
      if (delta > maxDelta) maxDelta = delta;
      pReach.set(i, next);
    }
    if (maxDelta < 1e-9) break;
  }
  // After convergence, multiply each state's pReach by its own
  // self-loop multiplier so the value reflects expected visits
  // (inflow + self-recurrences) rather than just inflow.
  for (const i of reachable) {
    const sl = selfLoop.get(i) ?? 0;
    if (sl > 0 && sl < 1) {
      pReach.set(i, (pReach.get(i) ?? 0) / (1 - sl));
    }
  }
  // ---- Forward-pass secondary value: `valueFromBase` ----
  // Per user direction (corrected 2026-05-07):
  //   fromBase(start) = basePriceEx
  //   fromBase(s)     = min over incoming (parent → s, prob, cost)
  //                     of [fromBase(parent) / prob + cost]
  //
  // Reading: the in-progress item carries an expected "market value"
  // proportional to how rare it is. Each transition INFLATES the
  // parent's value by 1/prob (a 10% branch landed multiplies the
  // sunk cost by 10× — replicating this state in expectation
  // requires that many average attempts), then adds the orb cost
  // paid at this step. The MIN over incoming edges picks the
  // cheapest-to-replicate estimate.
  //
  // Note: low-probability transitions amplify fromBase super-
  // linearly. A chain of 1% branches makes fromBase explode — which
  // correctly reflects how rare the resulting item is.
  //
  // Complementary to the existing `fromBudget=...ex` line
  // (= pSuccess(s) × budgetEx + bExpected(s), backward induction
  // from goal):
  //   - `fromBudget` = forward-going expected payoff under π*
  //                    (what this state is worth, given budget)
  //   - `fromBase`   = expected sunk-cost replicate-value
  //                    (what an in-expectation copy of this state
  //                     would cost to produce from base)
  const valueFromBase = new Map();
  valueFromBase.set(startIdx, basePriceEx);
  const unifiedCostFwd = (ex, sec) => ex + sec * (timeWeightExPerSec ?? 0);
  for (let iter = 0; iter < 64; iter++) {
    let changed = false;
    for (const i of reachable) {
      if (isGoalState(states[i], target)) continue;
      const a = policy[i];
      if (!a || a === 'buy_base') continue;
      if (isBrickedByFracture(states[i], target)) continue;
      const apps = appsPerState.get(i) ?? [];
      const app = apps.find((x) => x.actionId === a);
      if (!app) continue;
      const parentVal = valueFromBase.get(i);
      if (parentVal == null) continue;
      const stepCost = unifiedCostFwd(app.outcomes[0].costEx ?? 0, app.outcomes[0].costSec ?? 0);
      for (const o of app.outcomes) {
        if (o.to === i) continue;       // skip self-loops
        if (!(o.prob > 0)) continue;    // unreachable branch — guard against /0
        // Replicate-value form: parent fromBase divided by branch
        // probability (the "luck multiplier" needed in expectation
        // to land this branch), plus the orb cost paid at this step.
        const candidate = parentVal / o.prob + stepCost;
        const prev = valueFromBase.get(o.to);
        if (prev == null || candidate < prev) {
          valueFromBase.set(o.to, candidate);
          changed = true;
        }
      }
    }
    if (!changed) break;
  }

  // ---- itemValueAlt via backward induction over the reachable chain ----
  // Cycles in the chain DAG are rare but possible (e.g. an annul-no-op
  // self-loop on a state where every removable mod is fractured). We
  // run a fixed-point iteration with a damping rule: terminals (goal /
  // brick / buy_base) are pinned, and non-terminals are updated via
  // value-iteration-style sweeps. Since the underlying recurrence is
  // contractive whenever transitions either decrease totalMods (annul),
  // increase fracture-lock count, or hit an absorbing terminal, the
  // iteration converges in O(|chain|) sweeps even with self-loops —
  // self-loops contribute `(1 - p_self) · itemValue(s) = -cost + Σ p · v(o)`
  // which has a unique fixed point. We cap at 200 iterations + tol=1e-6.
  // Decompose itemValue(s) = pSuccess(s) · budget + bExpected(s)
  // (linear in budget). Useful because:
  //   - Together they let us compute itemValue at any budget without
  //     re-iterating: itemValue(s, B) = pSuccess(s) · B + bExpected(s).
  //   - Breakeven budget for the start state is `-bExpected(start) /
  //     pSuccess(start)`: the budget at which one committed attempt
  //     has expected profit zero (and any larger budget is profitable).
  // pSuccess(s) is the probability of reaching goal from s under π*
  // without bricking; bExpected(s) is the negated expected orb cost
  // along all branches under π* (always ≤ 0).
  const pSuccess = new Map();
  const bExpected = new Map();
  const unifiedCost = (ex, sec) => ex + sec * (timeWeightExPerSec ?? 0);
  for (const i of reachable) {
    pSuccess.set(i, isGoalState(states[i], target) ? 1 : 0);
    bExpected.set(i, 0);
  }
  for (let iter = 0; iter < 200; iter++) {
    let maxDelta = 0;
    for (const i of reachable) {
      if (isGoalState(states[i], target)) continue;
      if (policy[i] === 'buy_base') continue;
      if (isBrickedByFracture(states[i], target)) continue;
      const a = policy[i];
      if (!a) continue;
      const apps = appsPerState.get(i) ?? [];
      const app = apps.find((x) => x.actionId === a);
      if (!app) continue;
      const cost = unifiedCost(app.outcomes[0].costEx, app.outcomes[0].costSec);
      let pNext = 0, bNext = -cost;
      for (const o of app.outcomes) {
        pNext += o.prob * (pSuccess.get(o.to) ?? 0);
        bNext += o.prob * (bExpected.get(o.to) ?? 0);
      }
      const dp = Math.abs(pNext - (pSuccess.get(i) ?? 0));
      const db = Math.abs(bNext - (bExpected.get(i) ?? 0));
      if (dp > maxDelta) maxDelta = dp;
      if (db > maxDelta) maxDelta = db;
      pSuccess.set(i, pNext);
      bExpected.set(i, bNext);
    }
    if (maxDelta < 1e-6) break;
  }
  // Cycles in the chain DAG are rare but possible (e.g. an annul-no-op
  // self-loop on a state where every removable mod is fractured). The
  // value-iteration-style fixed point converges because every non-self
  // branch eventually hits an absorbing terminal (goal or brick/
  // buy_base), and self-loops have a unique fixed point. We cap at
  // 200 iterations + tol=1e-6.
  const itemValueAlt = new Map();
  if (budgetEx != null && Number.isFinite(budgetEx)) {
    for (const i of reachable) {
      const v = (pSuccess.get(i) ?? 0) * budgetEx + (bExpected.get(i) ?? 0);
      itemValueAlt.set(i, v);
    }
  }
  // Breakeven budget for the start state (smallest budget at which
  // itemValue(start) ≥ 0 under the "no-restart" formula). null if
  // pSuccess(start) = 0 (no path to goal under π*) — in that case no
  // budget makes crafting profitable.
  let pStart = pSuccess.get(startIdx) ?? 0;
  let pSuccessOverflow = null;
  const bStart = bExpected.get(startIdx) ?? 0;
  // Defensive clamp: pSuccess is a probability in [0, 1] by construction
  // (it's a weighted sum of [0, 1] values where the weights are
  // outcome probabilities that should sum to ≤ 1). Anything > 1.0 +
  // epsilon means an engine bug — outcome mass exceeded 1, the most
  // common cause being a transition function emitting probabilities
  // that don't sum exactly to 1 due to a stale/missing branch. Clamp
  // for display correctness AND surface the discrepancy as a warning
  // so the bug stays visible (downstream `Math.log(1 - pStart)` goes
  // NaN when pStart > 1, propagating NaN into the materials
  // shopping list — bug 2026-05-11).
  if (pStart > 1 + 1e-6) {
    pSuccessOverflow = pStart;  // surfaced via build-chain caller below
    pStart = 1;
  } else if (pStart > 1) {
    pStart = 1; // tolerate ε floating-point drift silently
  }
  const breakevenBudgetEx = pStart > 1e-9 ? (-bStart / pStart) : null;

  // Mod-name shortener — same shape as closed-form chains
  // (chaos-spam, exalt-annul-cycle) so labels read consistently
  // across all chart variants.
  //   "PREFIX:#% increased Evasion Rating" → "P:Evasion Rating"
  const shortName = (key) => {
    const [side, rest] = key.split(/:(.+)/);
    const tag = side === 'PREFIX' ? 'P' : side === 'SUFFIX' ? 'S' : '';
    const trim = (rest ?? '').replace(/[#%,]/g, '').replace(/\s+/g, ' ').trim();
    return `${tag}:${trim.slice(0, 26)}`;
  };
  // Build a per-state mod list label: one line per wished bit on the
  // item (★ if required, · if soft-wished), plus an irrelevant-count
  // line. Replaces the cryptic `mask=00000101` representation.
  const wIsReq = wishlist.map((w) => !!w.required);
  const wKeys  = wishlist.map((w) => w.key);
  const wTypes = wishlist.map((w) => w.type ?? null);
  const desecBit = (s, i) => !!((s.desecratedWishedMask ?? 0) & (1 << i));
  // Per-state (irrPrefix, irrSuffix) computation, factored out so
  // the collapse rewriter can compute min-floor + variable across
  // a merge group. Mirrors the inline logic in stateModListLabel.
  const irrSidesFor = (s) => {
    let wishedPrefix = 0, wishedSuffix = 0;
    for (let i = 0; i < wKeys.length; i++) {
      if (!(s.modMask & (1 << i))) continue;
      if (wTypes[i] === 'PREFIX') wishedPrefix++;
      else if (wTypes[i] === 'SUFFIX') wishedSuffix++;
    }
    const totalPrefix = s.prefixMods ?? 0;
    const totalSuffix = s.totalMods - totalPrefix;
    const irrPrefix = Math.max(0, totalPrefix - wishedPrefix);
    const irrSuffix = Math.max(0, totalSuffix - wishedSuffix);
    return { irrPrefix, irrSuffix };
  };
  const stateModListLabel = (s) => {
    const onBits = [];
    for (let i = 0; i < wKeys.length; i++) {
      if (s.modMask & (1 << i)) onBits.push(i);
    }
    // Per-side wished counts (drives the irrelevant split below).
    let wishedPrefix = 0, wishedSuffix = 0;
    for (const i of onBits) {
      if (wTypes[i] === 'PREFIX') wishedPrefix++;
      else if (wTypes[i] === 'SUFFIX') wishedSuffix++;
    }
    const totalPrefix = s.prefixMods ?? 0;
    const totalSuffix = s.totalMods - totalPrefix;
    // Independent of the side split: exact total of irrelevant slots.
    const irrTotal  = s.totalMods - onBits.length;
    // Side-split — relies on prefixMods which isn't maintained by
    // every action; can be inaccurate.
    const irrPrefix = Math.max(0, totalPrefix - wishedPrefix);
    const irrSuffix = Math.max(0, totalSuffix - wishedSuffix);
    const sideUnknown = irrTotal > 0 && (irrPrefix + irrSuffix) === 0;
    const lines = [];
    for (const i of onBits) {
      const tag = wIsReq[i] ? '★' : '·';
      const desecMark = desecBit(s, i) ? ' 🦴' : '';
      lines.push(`${tag} ${shortName(wKeys[i])}${desecMark}`);
    }
    if (irrTotal > 0) {
      // Reuse the same `P:` / `S:` side-tag convention as wished
      // mods so the rendered list reads uniformly. The 🦴 mark
      // tracks how many of the irrelevant slots came from a Well-
      // of-Souls reveal (desecrated provenance) — read directly
      // from the per-side fields, no derivation needed.
      const desecPrefixIrr = s.desecratedIrrPrefix ?? 0;
      const desecSuffixIrr = s.desecratedIrrSuffix ?? 0;
      const pMark = desecPrefixIrr > 0 ? ` 🦴×${desecPrefixIrr}` : '';
      const sMark = desecSuffixIrr > 0 ? ` 🦴×${desecSuffixIrr}` : '';
      // Single-line side signature with the ↕ glyph for "either side"
      // sandwiched between Prefix and Suffix counts: `P×n ↕×k S×m`.
      // The ↕ visually conveys "this slot can land prefix or suffix"
      // without spelling out the words. Order P → ↕ → S keeps the
      // variable portion central, mirroring its meaning.
      if (sideUnknown) {
        const allMark = (desecPrefixIrr + desecSuffixIrr) > 0
          ? ` 🦴×${desecPrefixIrr + desecSuffixIrr}` : '';
        lines.push(`· irr: ↕×${irrTotal}${allMark}`);
      } else {
        const parts = [];
        if (irrPrefix > 0) parts.push(`P×${irrPrefix}${pMark}`);
        if (irrSuffix > 0) parts.push(`S×${irrSuffix}${sMark}`);
        if (parts.length) lines.push(`· irr: ${parts.join(' ')}`);
      }
    }
    // (Per-side fingerprint footer like `(2P + 1S = 3)` was
    // surfaced earlier as a debug aid while we were chasing
    // state-consistency bugs — it's hidden by default now that
    // those bugs are fixed. Re-enable here if a future state
    // representation makes two distinct states share a label.)
    if (!lines.length) lines.push('(empty)');
    return lines.join('\n');
  };

  const chainStates = [];
  const chainEdges = [];
  const present = (i) => reachable.has(i);
  for (const i of reachable) {
    const s = states[i];
    const isGoal = isGoalState(s, target);
    const strictBricked = isBrickedByFracture(s, target);
    const policyBricked = policy[i] === 'buy_base';
    // Step ID at the top of every node — same id used as Mermaid
    // node id and as the chain-state's `id` field, so the user can
    // refer to a node as "step s5" in conversation / bug reports
    // and the engine output round-trips. Toggle via input.showStepIds
    // (default true) — set false to omit when the chart is too dense.
    // Rarity is rendered as the node's border colour (white=Normal,
    // blue=Magic, yellow=Rare) by the Mermaid serializer — see
    // chain-mermaid.js NODE_STYLE per-rarity entries. Dropped from
    // the label since the colour cue is more glance-able than a text
    // field and saves a line of vertical space per node.
    // Mod list (one line per wished mod on the item, plus a count
    // line for irrelevant slots split by side). Reads at a glance
    // what the item carries — replaces the cryptic `mask=00000101`
    // binary representation. The total mod count (`t=...`) is no
    // longer surfaced — it's redundant with the per-line breakdown
    // (sum the wished + irrelevant lines).
    let label = (showStepIds ? `[${`s${i}`}] ` : '')
              + stateModListLabel(s);
    // Fractured wished bit — render as the mod name (via shortName)
    // rather than a bare bit index, so two goals fractured on
    // different mods are visually distinguishable.
    if (s.fracturedBit >= 0 && wKeys[s.fracturedBit] != null) {
      label += `\n🔒 ${shortName(wKeys[s.fracturedBit])}`;
    } else if (s.fracturedBit >= 0) {
      label += `\n🔒 bit ${s.fracturedBit}`;
    }
    if (s.irrFractured) label += `\n💀 irr-fractured`;
    // Total desecrated count — surfaces even when there are no
    // irrelevant slots (in which case the per-irrelevant-line
    // appendix can't fire). Two goals that differ only in desec
    // would otherwise render identically. Derived from
    // `popcount(desecratedWishedMask) + irrPrefix + irrSuffix`.
    const totalDesec = popcount(s.desecratedWishedMask ?? 0)
      + (s.desecratedIrrPrefix ?? 0) + (s.desecratedIrrSuffix ?? 0);
    if (totalDesec > 0) {
      label += `\n🦴 desecrated×${totalDesec}`;
    }
    // Post-reveal flag distinguishes "bone was applied + revealed"
    // from "bone was never applied" when the wished bits coincide.
    if (s.boneRevealed && !s.boneMod) {
      label += `\n✓ bone revealed`;
    }
    // Unrevealed bone-mod is a special "phantom slot" — pads the
    // fracture-threshold check, can't be picked by Fracture/Annul,
    // and is a key crafting trick (the bone-trick + multi-bone
    // chains). Surface it explicitly so the chain reader can spot
    // states where this asset is in play. Once revealed, the affix
    // is a normal mod and shows up in totalMods like any other.
    if (s.boneMod && !s.boneRevealed) label += `\n🦴 unrevealed bone-mod`;
    let kind = 'transient';
    if (isGoal) kind = 'goal';
    // Two distinct senses of "the engine doesn't progress here":
    //   - strictBricked: truly stuck (fracture wrong-bit, or
    //     irrelevant-fractured + fracture target on goal). No
    //     in-place action can ever reach goal — restart is the only
    //     option. Rendered in red 'bricked' style.
    //   - policyBricked: engine's optimal action is `buy_base`
    //     because V*(restart) < V*(any in-place action). Not stuck;
    //     just unprofitable to continue. Rendered in orange-amber
    //     'near-trap' so the user can distinguish "give up, restart"
    //     from "literally cannot continue." Particularly important
    //     for states where annul or chaos COULD recover but the
    //     expected cost (over outcomes) makes restart cheaper.
    else if (strictBricked) kind = 'bricked';
    else if (policyBricked) kind = 'near-trap';
    // Render bricked V* as ∞: the displayed value should match the
    // visual cue. The internal V*(s) under our action set is finite
    // (buy_base = 100 + V*(start) is always available), but a bricked
    // node says "no in-place rescue from here" — that's the *intrinsic*
    // V* (= ∞), and the buy_base cost is captured by the implicit
    // restart edge. Showing finite V* alongside the red-skull styling
    // confused the user into thinking "wait, this isn't actually dead?"
    // — which it is, modulo paying for a fresh base.
    if (kind === 'bricked') {
      label += `\nV*=∞ (restart costs ${fmtV(vStar[i])})`;
    } else if (kind === 'near-trap') {
      // Engine prefers restart, but the state is recoverable in
      // principle. Show the actual V* (=cost of buy_base) plus a
      // hint so the reader knows annul/chaos COULD work, just not
      // optimally. The "Why this orb?" alternatives panel exposes
      // each in-place option's Q-value for comparison.
      label += `\nV*=${fmtV(vStar[i])} (restart preferred)`;
    } else {
      label += `\nV*=${fmtV(vStar[i])}`;
    }
    if (budgetEx != null && Number.isFinite(budgetEx)) {
      const raw = itemValueAlt.get(i);
      const val = Number.isFinite(raw) ? Math.max(0, raw) : 0;
      // `fromBudget`: backward-induction value from goal under π*
      // = pSuccess(s) × budgetEx + bExpected(s). Reads as "what this
      // state is worth going forward, given the user's budget cap."
      // Renamed from generic `value` to make the contrast with the
      // forward-pass `fromBase` explicit in the label.
      label += `\nfromBudget=${fmtVal(val)} ex`;
      // Reach metrics: two distinct quantities sourced from the
      // same fixed-point iteration over expected visits.
      //   P_reach   = approximate probability the trajectory passes
      //               through this state at least once. Clamped at
      //               100%. For terminals (goal/bricked, absorbing)
      //               this equals exactly E[visits]; for cycle-
      //               prone non-terminals it's an upper-bound proxy.
      //   visits    = expected number of times the trajectory
      //               passes through this state per attempt. Shown
      //               only when > 1 (i.e. the state is inside a
      //               loop — annul-then-refill, chaos cycle, etc.)
      //               so the user can distinguish "lands here once
      //               with high prob" from "iterates here several
      //               times".
      const p = pReach.get(i) ?? 0;
      if (i !== startIdx && p > 0) {
        label += `\nP_reach=${fmtP(Math.min(1, p))}`;
        if (p > 1 + 1e-3) {
          label += `\nvisits=${p < 10 ? p.toFixed(2) : p.toFixed(1)}×`;
        }
      }
    }
    // Secondary value: forward-pass value from base item (basePriceEx
    // × min cumulative probability through the chain). Always shown
    // when basePriceEx > 0 — it doesn't depend on budget.
    if (basePriceEx > 0) {
      const fv = valueFromBase.get(i);
      if (Number.isFinite(fv)) {
        label += `\nfromBase=${fmtVal(fv)} ex`;
      }
    }
    // Next-action annotation. Placed last so it's the most prominent
    // line at the bottom of the node — the reader's eye lands on
    // "what's the policy here?" without scanning past V*/budget/etc.
    // Skip terminals (goal/bricked) since their policy is null /
    // restart-only.
    if (!isGoal && !strictBricked && policy[i] && policy[i] !== 'buy_base') {
      label += `\nnext: ${policy[i]}`;
    }
    // Per-state alternatives: every applicable action's Q-value
    // (= cost + Σ p · V*(s')) plus a delta vs the chosen policy.
    // Answers "why not <orb>?" — the action with the lowest Q is
    // the one π* picked; the rest are sorted by ascending Q so the
    // closest-runner-up surfaces first. Bricked actions (V*=∞ on
    // every outcome) get qValue=Infinity and stay at the bottom.
    const alternatives = [];
    if (!isGoal && !strictBricked) {
      const apps = appsPerState.get(i) ?? [];
      const stateUnifiedCost = (ex, sec) => ex + sec * (timeWeightExPerSec ?? 0);
      for (const app of apps) {
        const unitEx  = app.outcomes[0]?.costEx  ?? 0;
        const unitSec = app.outcomes[0]?.costSec ?? 0;
        // Unified cost (ex + time × weight) drives Q. Per-action
        // breakdown (raw monetary + raw seconds) is also surfaced so
        // the renderer can show both — labelling unified cost as
        // "Cost (ex)" was confusing users (e.g. transmute shows up
        // as 450.01 ex with timeWeight=5/sec × 90s = 450 of "time
        // money"; the raw orb price is 0.01).
        const unifiedCost = stateUnifiedCost(unitEx, unitSec);
        let q = unifiedCost;
        let bricked = false;
        for (const o of app.outcomes) {
          const v = vStar[o.to];
          if (!Number.isFinite(v)) { bricked = true; break; }
          q += o.prob * v;
        }
        alternatives.push({
          actionId: app.actionId,
          costEx: unitEx,
          costSec: unitSec,
          unifiedCostEx: unifiedCost,
          qValue: bricked ? Infinity : q,
        });
      }
      alternatives.sort((a, b) => a.qValue - b.qValue);
      // Annotate Δ vs the optimal action so consumers can render
      // "annul: Q=12.5 ex (+0)" / "exalt: Q=18.7 ex (+6.2)".
      const best = alternatives.length ? alternatives[0].qValue : 0;
      for (const a of alternatives) {
        a.deltaQ = Number.isFinite(a.qValue) ? a.qValue - best : Infinity;
      }
    }
    // Importance signals for the renderer: `pReach` is the raw
    // fixed-point value (capped at 1.0 = "always visited", > 1 means
    // expected revisits — the chaos-loop case). `expectedVisits` is
    // the same value uncapped; we store both because the importance
    // formula `pReach × max(1, log(1+visits))` keeps loop states
    // visually prominent even when their per-step probability is low.
    const pReachRaw = pReach.get(i) ?? 0;
    chainStates.push({
      id: `s${i}`,
      label,
      kind,
      // Rarity flows separately so the renderer can apply per-rarity
      // border colour (white/blue/yellow) without parsing the label.
      rarity: s.rarity,
      pReach: Math.min(1, pReachRaw),
      expectedVisits: pReachRaw,
      meta: { vStar: vStar[i], policy: policy[i], alternatives },
    });
  }
  // Edges: only outbound from non-bricked, non-goal states.
  for (const i of reachable) {
    const s = states[i];
    if (isGoalState(s, target)) continue;
    if (isBrickedByFracture(s, target)) continue;
    const a = policy[i];
    if (!a || a === 'buy_base') continue;
    const apps = appsPerState.get(i) ?? [];
    const app = apps.find((x) => x.actionId === a);
    if (!app) continue;
    // Single-outcome (deterministic) actions get a gray `internal` edge
    // regardless of V* delta — there's no branching for the user to
    // reason about, so colouring it as success/fail/improving carries
    // no information beyond the V* annotation already on the nodes.
    // Probabilistic actions colour each outcome by ΔV* delta.
    const isDeterministic = app.outcomes.length === 1;
    // First pass: collapse outcomes that share the same destination
    // state into one bucket per (to). Mermaid renders parallel edges
    // (multiple lines between the same node pair) by stacking them
    // visually — only the topmost is reliably visible. Two annul
    // outcomes both landing at the same post-state would otherwise
    // appear as a single edge labelled with one of the two probs,
    // hiding the rest of the mass. Sum probs per destination so the
    // edge label reads e.g. `annul / 99%` (combined) instead of just
    // `annul / 66%` with the 33% sibling invisible.
    const byDest = new Map();
    for (const o of app.outcomes) {
      if (!present(o.to)) continue; // shouldn't happen — BFS already pulled it in
      const key = o.to;
      const cur = byDest.get(key) ?? { to: o.to, prob: 0 };
      cur.prob += o.prob;
      byDest.set(key, cur);
    }
    for (const o of byDest.values()) {
      // Edge kind reflects how much closer the outcome gets us to the
      // goal — quantified by ΔV* = V*(s) - V*(s'). All four buckets show
      // up inside a single orb's outcome fan (e.g. transmute: hit wished
      // ⇒ big V* drop = success; hit irrelevant ⇒ small drop = improving;
      // brick ⇒ V* spikes = fail; nothing changed ⇒ flat = internal).
      let kind = 'internal';
      if (!isDeterministic) {
        const v0 = vStar[i], v1 = vStar[o.to];
        if (isGoalState(states[o.to], target)) kind = 'success';
        else if (Number.isFinite(v0) && Number.isFinite(v1)) {
          if (v1 < v0 * 0.9999)      kind = 'improving';
          else if (v1 > v0 * 1.0001) kind = 'fail';
        }
      }
      chainEdges.push({
        from: `s${i}`, to: `s${o.to}`,
        label: `${displayAction(a)}\n${fmtP(o.prob)}`,
        // Raw action id preserved alongside the display label so
        // renderers can classify edges (e.g. essence ⇒ purple stroke)
        // without regex-parsing the user-facing label, which now
        // carries the friendly name (e.g. "Lesser Essence of
        // Insulation") rather than the engine id (e.g.
        // "essence_Lesser_Essence_of_Insulation").
        actionId: a,
        kind,
        // Raw transition probability, exposed so the renderer can
        // scale edge stroke-width by likelihood (high-prob outcomes
        // appear thick; tail outcomes appear thin).
        prob: o.prob,
      });
    }
  }

  // Equivalence-class collapse: states that differ ONLY by side
  // allocation (prefixMods, desecratedIrrPrefix, desecratedIrrSuffix)
  // — i.e. how irrelevant slots distribute across prefix/suffix —
  // and that landed on the same chosen action are presentationally
  // identical for the chain reader. Merging them shrinks large
  // chains without hiding meaningful policy decisions. The
  // underlying engine state space stays untouched (the engine still
  // distinguishes for downstream side-aware actions like
  // bone-reveal); collapse is purely a chart-rendering simplification.
  let collapsedNotice = null;
  // Collected during collapse, surfaced on the chain object so the
  // UI can introspect how the merge happened. Empty when collapse
  // didn't run.
  const diagnostics = {};
  // Strategy selector. 'none' skips collapse entirely; 'per-action'
  // and 'bottom-up' run separate (simpler) merge passes; 'top-down'
  // is the existing default. Spec: docs/chain-rendering.md (§3 for
  // the top-down approach, §8 for bottom-up). The legacy
  // `collapseEquivalent: false` knob still works as an alias for
  // 'none'.
  const strategy = collapseEquivalent === false ? 'none' : mergeStrategy;
  if (strategy === 'per-action' && chainStates.length > 1) {
    applyKeyMerge(chainStates, chainEdges,
      (cs) => `${cs.kind ?? '-'}|${cs.meta?.policy ?? '-'}`);
  } else if (strategy === 'bottom-up' && chainStates.length > 1) {
    applyBottomUpSiblingMerge(chainStates, chainEdges);
  } else if (strategy === 'top-down' && chainStates.length > 1) {
    // Equivalence-class collapse with TWO levels of merging:
    // 1. Side allocation: states differing only in prefix/suffix
    //    split (prefixMods, desecratedIrrPrefix, desecratedIrrSuffix)
    //    are presentationally interchangeable.
    // 2. Wished-mod identity: states differing only in WHICH wished
    //    mod is on the item (when those mods are interchangeable —
    //    same side, weight, requiredTier, required flag) are also
    //    interchangeable. User report (2026-05-08): cold-res and
    //    fire-res with identical roll attributes produce mirror
    //    branches in the chain that visually double the graph.
    // The mod-equivalence groups depend only on the wishlist, so
    // computed once outside eqKey().
    const wishedEquivClass = wishlist.map((w) =>
      `${w.type ?? '?'}|${w.weight ?? 0}|${w.requiredTier ?? '-'}|${w.required ? 1 : 0}`
    );
    // Diagnostic: surface the equiv-class string for every wishlist
    // entry. When two mods the user expects to merge stay separate,
    // the user can inspect this and spot the field that's breaking
    // equivalence (typically a weight differing by 1 between mods
    // the user thinks are interchangeable).
    diagnostics.wishedEquivClasses = wishlist.map((w, i) => ({
      key: w.key,
      type: w.type,
      weight: w.weight,
      requiredTier: w.requiredTier,
      required: !!w.required,
      equivClass: wishedEquivClass[i],
    }));
    // Print the equiv classes so they're visible without DevTools
    // navigation. One log per solve — minimal noise, immediate
    // visibility on whether two mods landed in the same class.
    if (typeof console !== 'undefined' && console.log) {
      const groups = new Map();
      for (const entry of diagnostics.wishedEquivClasses) {
        if (!groups.has(entry.equivClass)) groups.set(entry.equivClass, []);
        groups.get(entry.equivClass).push(entry.key);
      }
      console.log('[chain collapse] wishlist equivalence classes:');
      for (const [cls, keys] of groups) {
        const tag = keys.length > 1 ? '(MERGES)' : '(unique)';
        console.log(`  ${tag} ${cls}  ⇐  ${keys.join(', ')}`);
      }
    }
    const wishedSignature = (mask) => {
      const counts = new Map();
      for (let i = 0; i < wishedEquivClass.length; i++) {
        if (!(mask & (1 << i))) continue;
        const cls = wishedEquivClass[i];
        counts.set(cls, (counts.get(cls) ?? 0) + 1);
      }
      return [...counts.entries()].sort().map(([k, v]) => `${k}#${v}`).join(';');
    };
    // fracturedBit is a wishlist index (0..N-1) — same caveat as
    // modMask: bit 0 vs bit 1 are different identities but same
    // class when the mods are equivalent. Normalise to the class
    // string so "cold fractured" and "fire fractured" share an eqKey.
    const fracturedClassOf = (s) => {
      if (s.fracturedBit == null || s.fracturedBit < 0) return '-';
      return wishedEquivClass[s.fracturedBit] ?? '-';
    };
    // Bisimulation partition refinement. Replaces the previous
    // one-shot eqKey grouping. Algorithm:
    //   1. Initial partition: by (kind, policy, canonical-label).
    //      The canonical label drops step-id prefix and floating-
    //      point annotations (V*, fromBudget, P_reach) so layout-
    //      irrelevant differences don't fragment classes.
    //      The label itself is the user's distinguishability axiom:
    //      two states with different labels can NEVER merge (the
    //      user must be able to identify which node a concrete item
    //      maps to).
    //   2. Refine: iteratively split classes whose members have
    //      different transition signatures (= sorted list of
    //      (destinationClass, totalProb) entries). Fixed point.
    // Result: smallest partition consistent with both the optimal
    // policy and user-visible labels. Strictly more aggressive
    // than the prior eqKey approach (e.g. two terminal-goal states
    // with identical labels but different irrFractured / bone
    // attributes now correctly merge — they're indistinguishable).
    // Identity → equivalence-class placeholder. When multiple wished
    // mods share an equiv class (same side, weight, requiredTier,
    // required flag), their specific short-names become interchangeable
    // for visualisation. E.g., "S:cold" and "S:fire" both rewrite to
    // a single class placeholder so the canonical label is the same.
    // States with single-member classes keep their specific name.
    const classMembers = new Map();
    for (let i = 0; i < wishlist.length; i++) {
      const cls = wishedEquivClass[i];
      if (!classMembers.has(cls)) classMembers.set(cls, []);
      classMembers.get(cls).push(i);
    }
    const shortNameReplacements = new Map();
    for (const [cls, members] of classMembers) {
      if (members.length <= 1) continue;
      const parts = cls.split('|'); // type | weight | reqTier | required
      const tag = `[${parts[0][0] ?? '?'}-w${parts[1]}-T${parts[2]}${parts[3] === '1' ? '-req' : ''}]`;
      for (const i of members) {
        shortNameReplacements.set(shortName(wKeys[i]), tag);
      }
    }
    // Attribute-based canonical signature. Operates on the underlying
    // engine state object (not on the rendered label) so the rules
    // are explicit and structured rather than regex-on-strings. The
    // `opts` object selects which attributes go into the signature —
    // a richer opts produces a finer partition. To split a class
    // that's collapsing two behaviorally-different states, add the
    // discriminating attribute to opts and re-run; the per-class
    // signatures change and the states fall into different classes.
    //
    // Default opts capture the minimum-information set: wished bits
    // (per equiv-class count), irrelevant presence (≥1 bucket), and
    // counts that any policy might consult (totalMods bucket via
    // canonical irr count, prefix-vs-suffix masked out for the
    // side-allocation collapse rule).
    const canonAttrs = (s, opts = {}) => {
      const attrs = {};
      // Default classification: bucketed total affix count (NOT
      // separated into wished vs irrelevant). User report (2026-05-08):
      // "after transmute we always apply augment — post-transmute
      // states are mergeable, label should say `magic with 1 affix`
      // regardless of wished/irrelevant split."
      // Buckets: 0 / 1 / 2 / ≥3. Exact counts for the early states
      // (where the user genuinely cares about "what affix did I
      // just gain"), bucketed for later states (where the engine's
      // exalt-spam doesn't depend on the precise count). Set
      // opts.exactTotalMods=true to disable bucketing.
      const tm = s.totalMods ?? 0;
      attrs.totalMods = opts.exactTotalMods
        ? tm
        : (tm <= 2 ? tm : '≥3');
      // opts.showWished=true brings back the wished-class-count
      // breakdown when a future scenario needs to separate "1 wished
      // + 0 irr" from "0 wished + 1 irr" states whose downstream
      // policy chains might genuinely diverge.
      if (opts.showWished) {
        const wishedCounts = {};
        for (let i = 0; i < wishedEquivClass.length; i++) {
          if (s.modMask & (1 << i)) {
            const cls = wishedEquivClass[i];
            wishedCounts[cls] = (wishedCounts[cls] ?? 0) + 1;
          }
        }
        attrs.wished = wishedCounts;
      }
      // Side allocation: NOT included by default — mirrors the
      // previous collapse rule that excluded prefixMods. Set
      // opts.showSide=true to differentiate by which side has irrs.
      if (opts.showSide) attrs.prefixMods = s.prefixMods ?? 0;
      // Fractured: record "is something fractured" since the specific
      // bit is wished-class-mapped via fracturedClassOf. Set
      // opts.exactFracture=true to keep the specific bit's class.
      attrs.fractured = (s.fracturedBit >= 0)
        ? (opts.exactFracture ? wishedEquivClass[s.fracturedBit] : '?')
        : (s.irrFractured ? 'irr' : '-');
      // Bone-mod state: dropped from the default signature. Actions
      // that genuinely care about bone presence (apply_bone requires
      // no bone, reveal_bone requires bone, etc.) differentiate via
      // the policy axis already, so including `boneMod` here would
      // over-fragment classes that should otherwise merge. User
      // report (2026-05-08): "I still see different nodes with and
      // without desecrated/bone, while they look equivalent and
      // lead to the same next action." Set opts.showBone=true to
      // include if a future scenario needs it.
      if (opts.showBone) {
        attrs.bone = s.boneMod ? (s.boneRevealed ? 'rev' : 'unrev') : '-';
      }
      if (opts.showBoneSide) attrs.boneSide = s.boneSide ?? '-';
      // Desecrated-provenance: dropped by default (action-gating
      // already differentiates desec-vs-not at the policy axis;
      // including it here would over-fragment). Set opts.showDesec
      // to include if a future need arises.
      if (opts.showDesec) {
        attrs.desecratedWishedCount = popcount(s.desecratedWishedMask ?? 0);
        attrs.desecratedIrrCount = (s.desecratedIrrPrefix ?? 0) + (s.desecratedIrrSuffix ?? 0);
      }
      return JSON.stringify(attrs, Object.keys(attrs).sort());
    };
    const canonLabel = (cs) => {
      const idx = parseInt(cs.id.replace(/^s/, ''), 10);
      const s = states[idx];
      if (!s) return cs.id;
      return canonAttrs(s);
    };
    const idxById = new Map(chainStates.map((cs, i) => [cs.id, i]));
    const outBy = new Map();
    for (const e of chainEdges) {
      if (!outBy.has(e.from)) outBy.set(e.from, []);
      outBy.get(e.from).push(e);
    }
    // Initial classes by (kind, policy) only — the user-suggested
    // merge-by-next-action strategy. Two states with the same kind
    // and the same optimal action are presentationally equivalent;
    // any covering label difference (e.g. one shows `1 S irrelevant`,
    // another shows `≥1 irrelevant`) is reconciled by the rewriter
    // below and by the disambiguation post-pass that adds attribute
    // breakdowns where needed. Previously the partition included
    // `canonLabel` (= canonAttrs string), which kept fragmenting
    // groups that should have merged — e.g. s14 (totalMods=2 with
    // 1S+1unknown irrelevant) vs s22 (totalMods varying with ≥1
    // irrelevant) under the same exalt policy stayed separate even
    // though they describe overlapping sets of concrete items.
    let classIds = new Array(chainStates.length);
    {
      const initToCls = new Map();
      let nextCls = 0;
      // Partition attributes (in order, all required in the key):
      //
      //   kind, policy   — coarse shape (transient / goal / brick)
      //                    + chosen action.
      //   fractured      — fracture state is irreversible; mixing
      //                    fractured & unfractured states would
      //                    silently lose behavioural info.
      //   totalMods      — exact, per user direction (2026-05-09):
      //                    "each concrete item should fit exactly
      //                    one rep." Bucketing tm leaks ambiguity
      //                    (an item with tm=4 fits both `tm=2–4`
      //                    and `tm=3–5` rep labels). Including the
      //                    exact value forces each rep to cover a
      //                    single tm — labels become precise without
      //                    needing disc-line ranges.
      //
      // Trade-off: chain has more reps. User explicitly accepts this
      // ("acceptable to split into 2 nodes with same action, as long
      // as it enables readable graph"). The disambiguation post-pass
      // still handles residual collisions on attrs not in the
      // partition (bone, prefixMods, etc.).
      const fracturedClassFor = (cs) => {
        const idx = parseInt((cs.id ?? '').replace(/^s/, ''), 10);
        const s = states[idx];
        if (!s) return '-';
        if (s.fracturedBit >= 0) return wishedEquivClass[s.fracturedBit] ?? '?';
        return s.irrFractured ? 'irr' : '-';
      };
      const totalModsFor = (cs) => {
        const idx = parseInt((cs.id ?? '').replace(/^s/, ''), 10);
        const s = states[idx];
        return s?.totalMods ?? 0;
      };
      // Wished count must be in the partition. Otherwise two states
      // with the same (kind, policy, fractured, totalMods) but
      // different #wished collapse into one rep — and the rep's
      // label only reflects ONE member's wished bits, hiding the
      // rest. User report (2026-05-09): on Amulet ilvl=72 + cold/fire
      // wishlist + Greater Transmute, the 5%-wished and 95%-irrelevant
      // outcomes both had the same optimal next-action (augment_greater)
      // and same totalMods=1 → same partition → merged into one rep
      // labelled `★ S:{cold|fire}` only. The rendered chain showed
      // s0 → merged-rep at 100%, with the irrelevant branch invisible.
      // Including wishedCount in the partition splits them back into
      // a wished-rep and an irrelevant-rep, exposing both branches.
      const wishedCountFor = (cs) => {
        const idx = parseInt((cs.id ?? '').replace(/^s/, ''), 10);
        const s = states[idx];
        return popcount(s?.modMask ?? 0);
      };
      // Canonicalize policy via the equiv-class map (if provided). For
      // essence actions targeting wished mods in the same equiv-class,
      // the map collapses them to one canonical string, so e.g.
      // "essence_Greater_Insulation (cold)" and "essence_Greater_
      // Thawing (fire)" share one partition class when cold and fire
      // are mirror wished mods. Without the map, falls back to the
      // raw action id.
      const canonicalPolicy = (cs) => {
        const p = cs.meta?.policy ?? '-';
        if (policyEquivClassMap && policyEquivClassMap.has(p)) {
          return policyEquivClassMap.get(p);
        }
        return p;
      };
      for (let i = 0; i < chainStates.length; i++) {
        const cs = chainStates[i];
        const k = `${cs.kind ?? '-'}|${canonicalPolicy(cs)}|${fracturedClassFor(cs)}|tm=${totalModsFor(cs)}|w=${wishedCountFor(cs)}`;
        if (!initToCls.has(k)) initToCls.set(k, nextCls++);
        classIds[i] = initToCls.get(k);
      }
    }
    // No transition-signature refinement: the user's ask (2026-05-08)
    // is "same next action + same visible label ⇒ merge". Subtle
    // engine-level prob differences (e.g. cold-T4-ilvl-50 vs fire-T4-
    // ilvl-48 producing slightly different Perfect-Regal success
    // rates) don't show up in the label and don't matter for chart
    // readability — over-splitting on them just fragments the chain.
    // The initial (kind, policy, canonLabel) partition is the final
    // partition. Subtle behaviour differences get absorbed via the
    // edge-merge / renormalisation pass below.
    // eqKey now returns the partition class id; groups map by it.
    const eqKey = (cs) => {
      const i = idxById.get(cs.id);
      return i == null ? cs.id : `cls_${classIds[i]}`;
    };
    const groups = new Map();
    for (const cs of chainStates) {
      const k = eqKey(cs);
      const arr = groups.get(k) ?? [];
      arr.push(cs);
      groups.set(k, arr);
    }
    // Build a redirect map: every chain id → canonical id (the first
    // state in each group becomes the representative).
    const redirect = new Map();
    let collapsedCount = 0;
    for (const arr of groups.values()) {
      const rep = arr[0];
      for (const cs of arr) redirect.set(cs.id, rep.id);
      if (arr.length > 1) collapsedCount += arr.length - 1;
    }
    if (collapsedCount > 0) {
      // Filter chainStates to representatives only.
      const representatives = new Set();
      for (const id of redirect.values()) representatives.add(id);
      const newChainStates = chainStates.filter((cs) => representatives.has(cs.id));
      // Attach the collapsed-group member state-indices to each rep
      // so the downstream label-disambiguation pass can introspect
      // per-attribute distributions (totalMods, fractured, bone, ...)
      // without having to re-derive grouping. _underlyingIdxs lives
      // on the chain state object as an internal aid; it's preserved
      // through serialisation but not part of the public API.
      const idxFromCsId = (id) => {
        const m = /^s(\d+)$/.exec(id ?? '');
        return m ? Number(m[1]) : null;
      };
      for (const cs of newChainStates) {
        const arr = groups.get(eqKey(cs)) ?? [];
        cs._underlyingIdxs = arr.map((m) => idxFromCsId(m.id)).filter((x) => x != null);
      }
      // For per-(from, action) probability renormalisation: when
      // collapse merges multiple source states into a representative,
      // each source contributed outgoing edges that summed to 1.0.
      // Naively summing across sources can drive the representative's
      // outgoing total past 1.0 (e.g. 0.6 + 0.5 to the same dest →
      // 1.1). Compute per-source outgoing totals BEFORE merging so
      // we can renormalise after.
      const sourceCount = new Map();
      for (const arr of groups.values()) {
        sourceCount.set(arr[0].id, arr.length);
      }
      // Re-label representatives whose group had >1 member: the side
      // breakdown is no longer meaningful (the collapsed siblings had
      // different prefix/suffix splits), so replace per-side
      // irrelevant lines with a single `· N irrelevant` line.
      const groupSize = new Map();
      for (const arr of groups.values()) {
        if (arr.length > 1) groupSize.set(arr[0].id, arr.length);
      }
      for (const cs of newChainStates) {
        if (!groupSize.has(cs.id)) continue;
        const arr = groups.get(eqKey(cs));
        if (!arr || arr.length <= 1) continue;
        // Strip per-side irrelevant lines, then re-emit using the
        // group's per-side floor + variable residue. User report
        // (2026-05-08): "merged label '3 irrelevant' loses info —
        // when all members have ≥2S, label should keep '· S: 2'
        // and only mark 1 as 'either side'."
        // Detach the `[sN] ` step-id prefix from the first line so
        // per-side line regexes match cleanly even when the state
        // has no wished mods (label starts with `[s3] · P: …`).
        // Re-attached to the rewritten output before assignment.
        const stepIdMatch = /^(\[s\d+\])\s*/.exec(cs.label);
        const stepIdPrefix = stepIdMatch ? stepIdMatch[1] : '';
        const labelBody = stepIdMatch ? cs.label.slice(stepIdMatch[0].length) : cs.label;
        const lines = labelBody.split('\n');
        let totalIrr = 0;
        let desecMark = '';
        const kept = [];
        for (const ln of lines) {
          // Match the new compact `· irr: P×N S×M ?×K` line so we can
          // re-emit it post-collapse with the merged group's floor +
          // variable breakdown. Total = sum of N + M + K parsed out.
          const irrMatch = /^· irr: (.*)$/.exec(ln);
          if (irrMatch) {
            const sig = irrMatch[1];
            // Sum any digit run preceded by P×, S×, or ?×.
            for (const m of sig.matchAll(/[PS?]×(\d+)/g)) totalIrr += Number(m[1]);
            const desecMatch = sig.match(/🦴×\d+/);
            if (desecMatch && !desecMark) desecMark = ' ' + desecMatch[0];
          } else {
            kept.push(ln);
          }
        }
        if (totalIrr > 0) {
          // Floor: smallest irr count per side across all merged members.
          let minP = Infinity, minS = Infinity;
          for (const sib of arr) {
            const idx = parseInt(sib.id.replace(/^s/, ''), 10);
            const sibState = states[idx];
            if (!sibState) continue;
            const { irrPrefix, irrSuffix } = irrSidesFor(sibState);
            if (irrPrefix < minP) minP = irrPrefix;
            if (irrSuffix < minS) minS = irrSuffix;
          }
          if (!Number.isFinite(minP)) minP = 0;
          if (!Number.isFinite(minS)) minS = 0;
          const variable = Math.max(0, totalIrr - minP - minS);
          const insertAt = kept.findIndex((l) => /^V\*=|^fromBudget=|^fromBase=|^P_reach=/.test(l));
          // Single-line tight signature `P×n ↕×k S×m` so reps with
          // the same total irrelevant count but different side
          // allocations are scannable side-by-side. The ↕ glyph
          // (instead of `?`) conveys "this slot can land prefix or
          // suffix" with the up/down arrow visually mirroring the
          // semantics, sandwiched between the fixed P and S counts.
          const insertLines = [];
          if (totalIrr > 0) {
            const parts = [];
            if (minP > 0)     parts.push(`P×${minP}`);
            if (variable > 0) parts.push(`↕×${variable}`);
            if (minS > 0)     parts.push(`S×${minS}`);
            const signature = parts.length ? parts.join(' ') : `${totalIrr}`;
            insertLines.push(`· irr: ${signature}${desecMark}`);
          }
          if (insertAt >= 0) kept.splice(insertAt, 0, ...insertLines);
          else kept.push(...insertLines);
        }
        // Re-attach the step-id prefix to the first line.
        const joined = kept.join('\n');
        cs.label = stepIdPrefix
          ? (joined.startsWith('\n') ? `${stepIdPrefix}${joined}` : `${stepIdPrefix} ${joined}`)
          : joined;
      }
      // Rewrite edge endpoints + merge parallel edges (same from/to/action).
      // Self-loops (from === to after redirect) used to be dropped here —
      // but that silently lost probability mass when an outcome's
      // destination state happened to redirect to the same representative
      // as the source. User report (2026-05-08): "from s72 I see 2 edges
      // for annul, 50% + 33% = 83% — where's the other 17%?" — that 17%
      // was a chaos outcome whose destination collapsed back into s72's
      // equivalence class. Keeping self-loops makes the missing mass
      // visible (rendered as a curve from the node back to itself);
      // the per-(from, action) renormalisation below handles the math.
      // Canonical action key: when two actions are policy-equivalent
      // (mirror essences targeting wished mods in the same equiv-class
      // and at the same cost), edges to the same destination via either
      // action collapse into one edge. Without this, a merged rep
      // (e.g. one that absorbed s18=Insulation and s28=Thawing) ends
      // up with two parallel edges to the goal, one per essence —
      // misleading because the user sees "two distinct policy options"
      // when really it's one option modulo the wished-mod swap.
      const canonAction = (a) => {
        if (policyEquivClassMap && policyEquivClassMap.has(a)) {
          return policyEquivClassMap.get(a);
        }
        return a;
      };
      const merged = new Map();
      const actionsByKey = new Map(); // canonical-key → Set<raw action ids>
      for (const e of chainEdges) {
        const from = redirect.get(e.from) ?? e.from;
        const to   = redirect.get(e.to)   ?? e.to;
        // Use the raw action id (stable engine identifier) for both
        // canonicalisation and the joined-mirror label, NOT the
        // user-facing label — labels are now display names like
        // "Essence of Cold" and don't survive canonicalisation
        // (the policyEquivClassMap is keyed by raw ids).
        const aId = e.actionId ?? (e.label ?? '').split('\n')[0];
        const cAction = canonAction(aId);
        const k = `${from}→${to}|${cAction}`;
        if (!actionsByKey.has(k)) actionsByKey.set(k, new Set());
        actionsByKey.get(k).add(aId);
        const cur = merged.get(k);
        if (cur) {
          cur.prob = (cur.prob ?? 0) + (e.prob ?? 0);
        } else {
          merged.set(k, { ...e, from, to });
        }
      }
      // Render the merged label using all original raw action ids
      // that contributed (joined with `|` for the multi-action case).
      // For a single-action edge the displayAction map is applied so
      // the user sees e.g. "Essence of Cold" rather than the raw id;
      // for joined mirrors the raw ids stay so the equiv-class
      // collapse remains explicit (e.g.
      // "essence_cold|essence_fire / 50.0%").
      for (const [k, e] of merged) {
        const ids = [...(actionsByKey.get(k) ?? [])].sort();
        const labelAction = ids.length > 1
          ? ids.join('|')
          : displayAction(ids[0]);
        e.actionId = ids.length === 1 ? ids[0] : ids.join('|');
        e.label = `${labelAction}\n${fmtP(e.prob)}`;
      }
      // Renormalise per (from, action) so the representative's
      // outgoing edges sum to 1.0. When N sources collapse into the
      // representative, each contributed outgoing mass of 1.0; the
      // naive sum is N. Divide by N (the source count) to get the
      // average outgoing distribution. Equivalent to: compute per
      // (from, action) group total, then if total > 1, scale all
      // edges in the group by 1 / N.
      const mergedArr = [...merged.values()];
      const groupTotals = new Map();
      for (const e of mergedArr) {
        const k = `${e.from}|${(e.label ?? '').split('\n')[0]}`;
        groupTotals.set(k, (groupTotals.get(k) ?? 0) + (e.prob ?? 0));
      }
      for (const e of mergedArr) {
        const action = (e.label ?? '').split('\n')[0];
        const total = groupTotals.get(`${e.from}|${action}`) ?? 1;
        // If total exceeds 1.0 due to N-way source collapse, divide
        // by N (= source count) so the representative's outgoing
        // probability is the AVERAGE over collapsed sources rather
        // than their SUM. Tolerance 1e-6 — floating-point summing of
        // probabilities can produce 1.0000001 even without collapse.
        if (total > 1 + 1e-6) {
          const n = sourceCount.get(e.from) ?? 1;
          if (n > 1) {
            e.prob = (e.prob ?? 0) / n;
            e.label = `${action}\n${fmtP(e.prob)}`;
          }
        }
      }
      // Re-compute the representative's P_reach as the SUM of the
      // merged sources' P_reach values, then rewrite the label so
      // the displayed P_reach reflects the collapsed-group total
      // rather than just the first source's individual pReach.
      // Without this fix, e.g. an irrelevant-landed magic|0|1 group
      // whose 4 sources each had pReach≈25% would display 25% on
      // the representative — the user expects 97.4% (the sum).
      for (const cs of newChainStates) {
        const arr = groups.get(eqKey(cs));
        if (!arr || arr.length <= 1) continue;
        let totalReach = 0;
        const distinctPrefixCounts = new Set();
        for (const sib of arr) {
          const idx = parseInt(sib.id.replace(/^s/, ''), 10);
          totalReach += pReach.get(idx) ?? 0;
          const sibState = states[idx];
          if (sibState) distinctPrefixCounts.add(sibState.prefixMods ?? 0);
        }
        // Rewrite the P_reach + visits annotations to reflect the
        // group total (matching the split-line scheme used for
        // uncollapsed states above).
        if (totalReach > 0) {
          const reachLine  = `P_reach=${fmtP(Math.min(1, totalReach))}`;
          const visitsLine = totalReach > 1 + 1e-3
            ? `visits=${totalReach < 10 ? totalReach.toFixed(2) : totalReach.toFixed(1)}×`
            : null;
          // Strip any prior P_reach / visits lines, then re-insert them
          // BEFORE the trailing `next: <action>` line. The user wants
          // `next:` to remain the last line of the label so the policy
          // decision is the eye's final landing point.
          let stripped = cs.label
            .replace(/\nP_reach=[^\n]*/, '')
            .replace(/\nvisits=[^\n]*/, '');
          const newLines = [reachLine];
          if (visitsLine) newLines.push(visitsLine);
          // Insert before any leading `next:` line; otherwise append.
          const nextIdx = stripped.lastIndexOf('\nnext:');
          if (nextIdx >= 0) {
            stripped = stripped.slice(0, nextIdx) +
                       '\n' + newLines.join('\n') +
                       stripped.slice(nextIdx);
          } else {
            stripped += '\n' + newLines.join('\n');
          }
          cs.label = stripped;
          // Sync pReach / expectedVisits on the merged representative
          // too — the renderer's importance formula reads these
          // directly, so leaving them at the original (non-merged)
          // single-source value would understate loop-prone collapsed
          // groups.
          cs.pReach = Math.min(1, totalReach);
          cs.expectedVisits = totalReach;
        }
        // Wished-mod identity merge: when the group's members differ
        // in WHICH specific wished bit is on the item (e.g. cold-only
        // and fire-only states sharing an equiv class), rewrite the
        // wished-mod lines on the rep to show the union of identities.
        // Otherwise the rep keeps one specific name (whichever sibling
        // landed first), making the merge invisible to the reader.
        const distinctMasks = new Set();
        for (const sib of arr) {
          const idx = parseInt(sib.id.replace(/^s/, ''), 10);
          const sibState = states[idx];
          if (sibState) distinctMasks.add(sibState.modMask);
        }
        if (distinctMasks.size > 1) {
          // Per equiv-class, collect the specific shortNames present
          // across the merged group. If a class has multiple distinct
          // names in use, the wished-mod line gets rewritten to
          // "★ S:nameA | S:nameB". Single-identity classes keep their
          // original line untouched.
          const namesByClass = new Map();
          for (const mask of distinctMasks) {
            for (let i = 0; i < wishedEquivClass.length; i++) {
              if (!(mask & (1 << i))) continue;
              const cls = wishedEquivClass[i];
              const name = shortName(wKeys[i]);
              if (!namesByClass.has(cls)) namesByClass.set(cls, new Set());
              namesByClass.get(cls).add(name);
            }
          }
          let label = cs.label;
          for (const [cls, names] of namesByClass) {
            if (names.size <= 1) continue;
            // Render the equiv-class collapse so it CLEARLY reads as
            // "one mod, alternate names" rather than "two mods listed
            // together." Format: keep the side tag (S: / P:) once,
            // then drop into curly braces for the name alternation.
            // Example: ★ S:{cold|fire} vs the prior ambiguous
            // ★ S:cold | S:fire (which read as two separate mods).
            const sortedNames = [...names].sort();
            const sideMatch = /^([PS]):/.exec(sortedNames[0]);
            const sideTag = sideMatch ? sideMatch[1] + ':' : '';
            const stripped = sortedNames.map((n) => n.replace(/^[PS]:/, ''));
            const joined = `${sideTag}{${stripped.join('|')}}`;
            // Replace ANY of the alternate names with the joined form.
            // Use the first occurrence's surrounding context (★ or ·)
            // to preserve the required-vs-desired tag.
            for (const n of names) {
              const re = new RegExp(`(★|·)\\s+${n.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}(?=\\s|$|\\n|🦴)`, 'g');
              label = label.replace(re, `$1 ${joined}`);
            }
            // Collapse duplicate joined-form lines (the rewrite above
            // produces one per original name, e.g. "★ A|B" appears
            // twice if both names existed in the label).
            const lines = label.split('\n');
            const seen = new Set();
            const kept = [];
            for (const ln of lines) {
              if (seen.has(ln)) continue;
              seen.add(ln);
              kept.push(ln);
            }
            label = kept.join('\n');
          }
          cs.label = label;
        }
        // Irrelevant-count merge: when the class collapses members
        // with different total irr counts (e.g., 1 irr, 2 irr, 3 irr
        // all sharing wished+policy+canonical-attrs under the loose-irr
        // canonAttrs rule), the rep's label currently shows the rep's
        // SPECIFIC irr count — misleading because the class genuinely
        // spans multiple counts (often resulting in a self-loop on
        // annul that's only sensible under "≥1 irr").
        // User report (2026-05-08): "s34 has a self-loop on annul
        // but the label says specific counts — confusing."
        const distinctIrrTotals = new Set();
        for (const sib of arr) {
          const idx = parseInt(sib.id.replace(/^s/, ''), 10);
          const sibState = states[idx];
          if (sibState) {
            const irrTotal = sibState.totalMods - popcount(sibState.modMask) - (sibState.irrFractured ? 1 : 0);
            distinctIrrTotals.add(irrTotal);
          }
        }
        if (distinctIrrTotals.size > 1) {
          // Strip every irr-line variant; emit one ≥1 irrelevant line
          // in its place so the rep's label matches the loose canonical.
          const stepIdMatch = /^(\[s\d+\])\s*/.exec(cs.label);
          const stepIdPrefix = stepIdMatch ? stepIdMatch[1] : '';
          const labelBody = stepIdMatch ? cs.label.slice(stepIdMatch[0].length) : cs.label;
          const lines = labelBody.split('\n');
          let hasAnyIrr = false;
          const kept = [];
          for (const ln of lines) {
            if (/^· (?:[PS?]:\s*)?\d+ irr(?:elevant)?(?:\s*\(either side\))?/.test(ln)) {
              hasAnyIrr = true;
            } else {
              kept.push(ln);
            }
          }
          if (hasAnyIrr) {
            const insertAt = kept.findIndex((ln) =>
              /^V\*=|^fromBudget=|^fromBase=|^P_reach=|^visits=|^next:/.test(ln));
            const looseLine = '· ≥1 irrelevant';
            if (insertAt >= 0) kept.splice(insertAt, 0, looseLine);
            else kept.push(looseLine);
            const joined = kept.join('\n');
            cs.label = stepIdPrefix ? `${stepIdPrefix} ${joined}` : joined;
          }
        }
        // Side-agnostic irrelevant label when the group merges states
        // with different prefixMods. Without this, a representative
        // whose siblings include both 1P+0S and 0P+1S still renders
        // as one specific side ("· P: 1 irrelevant" or "· S: 1 ...")
        // — and an outgoing edge to a "2 suffix" representative looks
        // like an impossible "1 prefix → 2 suffix" transition under
        // exalt-greater (which can't move existing affixes).
        // Replace the per-side lines with a single combined line so
        // the rendered transition reads honestly: "1 irrelevant → 2
        // irrelevant via exalt_greater" (with the side allocation
        // intentionally hidden, matching the eqKey's collapse rule).
        // (The floor + variable irrelevant rewrite that used to live
        // here is now done exclusively by the earlier rewriter under
        // `if (groupSize.has(cs.id))`. Running it twice produced
        // duplicate `· P: N irrelevant` lines because this loop's
        // strip pass didn't recognise the previous loop's
        // `· N irrelevant (either side)` output. User report
        // (2026-05-08): "s11 shows 2 rows of `P: 1 irrelevant`".)
      }
      chainStates.length = 0;
      chainStates.push(...newChainStates);
      chainEdges.length = 0;
      chainEdges.push(...mergedArr);
      // Re-classify edges whose from-group is now size 1 (single
      // outcome after collapse) as `internal` — matches the
      // pre-collapse convention that probabilistic kinds (success /
      // improving / fail) only apply to branching outcomes.
      const fromCounts = new Map();
      for (const e of chainEdges) {
        fromCounts.set(e.from, (fromCounts.get(e.from) ?? 0) + 1);
      }
      for (const e of chainEdges) {
        if (fromCounts.get(e.from) === 1) e.kind = 'internal';
      }
      collapsedNotice = `chain collapsed: merged ${collapsedCount} equivalent state(s) by side-allocation`;
      // Surface merge stats so the user can verify the collapse
      // step actually ran in their browser session. If the live
      // craft shows 0 merges but the test fixture shows N>0, the
      // browser has stale JS — hard refresh.
      diagnostics.collapseStats = {
        statesBefore: chainStates.length + collapsedCount,
        statesAfter: chainStates.length,
        merged: collapsedCount,
      };
      if (typeof console !== 'undefined' && console.log) {
        console.log(`[chain collapse] ${collapsedCount} state(s) merged ` +
          `(${chainStates.length + collapsedCount} → ${chainStates.length})`);
      }
    }
  }

  // ─────────────────────────────────────────────────────────
  // Label disambiguation pass.
  //
  // After collapse, two distinct chain reps can render with very
  // similar BODY labels (everything except the trailing `next: <action>`
  // line). The user complained: "I can't differentiate s21 and s22 —
  // both `≥ 1 irrelevant`, only the action differs." Strategy
  // (suggested 2026-05-09): merge by next action, label with the
  // most-specific covering of the group's members, then split until
  // labels are distinct. Implementation:
  //
  //   1. Strip volatile + next-line annotations to get a "body
  //      fingerprint" per rep.
  //   2. Group reps by body fingerprint.
  //   3. For any fingerprint with >1 rep (collision), walk a list of
  //      candidate discriminator attributes. The cheapest disjoint
  //      one (where rep A's value-set and rep B's value-set don't
  //      overlap) gets promoted to the body of EVERY colliding rep —
  //      so the user can read each rep's label and immediately see
  //      the differentiator.
  //
  // Doesn't change the chain partition; just enriches labels.
  // ─────────────────────────────────────────────────────────
  {
    const idxFromCsId = (id) => {
      const m = /^s(\d+)$/.exec(id ?? '');
      return m ? Number(m[1]) : null;
    };
    const memberIdxsOf = (cs) => {
      if (Array.isArray(cs._underlyingIdxs) && cs._underlyingIdxs.length) {
        return cs._underlyingIdxs;
      }
      const i = idxFromCsId(cs.id);
      return i != null ? [i] : [];
    };
    // Strip step-id prefix, volatile annotations, and the next-action
    // line. What remains is the structural part of the label — if two
    // reps match on this, the user can't tell them apart visually
    // beyond the action.
    const bodyFingerprint = (label) => label
      .replace(/^\[s\d+\]\s*/, '')
      .split('\n')
      .filter((ln) => !/^V\*=|^fromBudget=|^fromBase=|^P_reach=|^visits=|^next:/.test(ln))
      .join('\n');
    // Per-state attribute extractors — return a stable comparable
    // value (number / string) so the "disjoint sets" check is just
    // a Set intersection.
    // Default extractor list. Ordered by typical "discrimination
    // utility": totalMods + prefixMods are the highest-signal axes;
    // fractured + bone are categorical and useful when the case
    // calls for them. `wishedCount` and `desecrated` were removed
    // (2026-05-09): wishedCount renders as range like `0–1` which
    // is confusing (the high-end value implies a final state) and
    // is largely redundant with totalMods minus irrelevant; desec
    // count rarely discriminates in practice. The user can re-add
    // them if a future scenario needs the breakdown.
    const attrExtractors = [
      { name: 'rarity', label: 'rarity', get: (s) => s.rarity ?? '-' },
      { name: 'tm', label: 'totalMods', get: (s) => s.totalMods ?? 0 },
      { name: 'prefixMods', label: 'prefix mods', get: (s) => s.prefixMods ?? 0 },
      {
        name: 'fractured',
        label: 'fractured',
        get: (s) => s.fracturedBit >= 0 ? 'wished'
                   : s.irrFractured ? 'irr' : '-',
      },
      {
        name: 'bone',
        label: 'bone',
        get: (s) => s.boneMod ? (s.boneRevealed ? 'rev' : 'unrev') : '-',
      },
    ];
    // Cap on the number of disc lines added per rep. The user's
    // direction (2026-05-09): "if a covering representation needs
    // many attrs, it's acceptable to split the partition rather
    // than emit a 5-line label." With the cap, brute-force picks
    // the best subset of size ≤ MAX, even if it doesn't fully
    // disambiguate; remaining ambiguity surfaces as a duplicate-
    // label warning. Keeps labels readable.
    const MAX_DISC_LINES = 2;
    // Returns the set of distinct values an attribute takes across the
    // rep's underlying member states. Used to decide if two reps are
    // "disjoint" on this attribute.
    const valueSetForRep = (cs, attr) => {
      const out = new Set();
      for (const idx of memberIdxsOf(cs)) {
        const s = states[idx];
        if (!s) continue;
        out.add(attr.get(s));
      }
      return out;
    };
    // Joint-disjoint discriminator selection (brute-force minimum
    // subset).
    //
    // The naive approach (pick attrs whose VALUE-SETS differ across
    // reps) lets overlapping ranges through: rep A with totalMods
    // {2,3,4} and rep B with {3,4,5} render as `2–4` vs `3–5` — two
    // distinct strings, but a concrete item with totalMods=4 fits
    // both labels and the user can't tell which rep it belongs to.
    //
    // Fix (per user direction 2026-05-09): require JOINT disjointness.
    // Build per-rep tuple sets `{(attr1_val, attr2_val, …) for each
    // member state}` and find the smallest attribute SUBSET such that
    // every pair of reps has empty tuple-set intersection. Each
    // concrete item then maps to exactly one rep's tuple — no
    // ambiguity. We still render each attr's value-set on its own
    // line (independent ranges read better than tuple lists), but
    // the SELECTION ensures the joint information is sufficient.
    //
    // Pure greedy fails when no single attr improves the score:
    // tm covers {2,3,4} vs {3,4,5} alone is overlapping, prefix is
    // also overlapping, but their JOINT (tm, prefix) tuples ARE
    // disjoint. Greedy stops too early. Brute-force enumerates all
    // 2^|attrs| subsets (typically 2^6 = 64) and picks the smallest
    // that achieves full pairwise disjointness — guaranteed minimum.
    const greedyDiscriminators = (reps) => {
      const renderForRep = (cs, attr) => fmtValueSet(valueSetForRep(cs, attr));
      const memberStatesOf = (cs) => memberIdxsOf(cs)
        .map((i) => states[i])
        .filter(Boolean);
      const tuplesForRep = (cs, attrs) => {
        const out = new Set();
        for (const s of memberStatesOf(cs)) {
          out.add(attrs.map((a) => JSON.stringify(a.get(s))).join('|'));
        }
        return out;
      };
      const disjointPairScore = (attrs) => {
        const tuples = reps.map((cs) => tuplesForRep(cs, attrs));
        let pairs = 0;
        for (let i = 0; i < tuples.length; i++) {
          for (let j = i + 1; j < tuples.length; j++) {
            let overlap = false;
            for (const v of tuples[i]) if (tuples[j].has(v)) { overlap = true; break; }
            if (!overlap) pairs += 1;
          }
        }
        return pairs;
      };
      const totalPairs = reps.length * (reps.length - 1) / 2;
      // Brute-force enumeration. attrExtractors.length ≤ 6 → 2^6 = 64
      // subsets, each O(reps × members) — trivially fast.
      const N = attrExtractors.length;
      const cap = Math.min(MAX_DISC_LINES, N);
      let chosen = null;
      // Iterate by subset SIZE (k = 1, …, cap) so we find the
      // minimum-size subset first. Capped at MAX_DISC_LINES so labels
      // never blow up to 5 disc lines.
      outer: for (let k = 1; k <= cap; k++) {
        for (let mask = 0; mask < (1 << N); mask++) {
          if (popcount(mask) !== k) continue;
          const subset = [];
          for (let b = 0; b < N; b++) if (mask & (1 << b)) subset.push(attrExtractors[b]);
          if (disjointPairScore(subset) === totalPairs) {
            chosen = subset;
            break outer;
          }
        }
      }
      // Fallback: no size-≤cap subset achieves full disjointness.
      // Pick the size-cap subset with the best disjoint-pair score
      // — labels stay short, residual ambiguity surfaces via the
      // duplicate-label warning.
      if (!chosen) {
        let bestScore = -1;
        for (let mask = 0; mask < (1 << N); mask++) {
          if (popcount(mask) > cap) continue;
          const subset = [];
          for (let b = 0; b < N; b++) if (mask & (1 << b)) subset.push(attrExtractors[b]);
          const score = disjointPairScore(subset);
          if (score > bestScore) {
            bestScore = score;
            chosen = subset;
          }
        }
      }
      if (!chosen) chosen = [];
      // Filter the chosen subset to attributes whose rendered value-
      // sets differ across reps. The brute-force picks for JOINT
      // disjointness — i.e. the (attr1, attr2, …) tuples partition
      // each rep's covered concrete states cleanly. But sometimes a
      // chosen attribute renders identically across all reps (e.g.
      // both reps cover prefix mods 0–3, just with different
      // (tm, prefix) joint distributions). Emitting that line adds
      // visual noise without helping the reader. Only show attrs
      // whose rendered range actually varies — the user accepts
      // residual range overlap (`tm=2–5` vs `tm=1–4` covers tm=4
      // for both) as the cost of a readable label.
      const visualAttrs = chosen.filter((attr) => {
        const renders = new Set(reps.map((cs) => renderForRep(cs, attr)));
        return renders.size > 1;
      });
      const emit = visualAttrs.length > 0 ? visualAttrs : chosen;
      return reps.map((cs) =>
        emit.map((attr) => ({
          attr,
          render: renderForRep(cs, attr),
        })),
      );
    };
    // Format a value-set for label inclusion. Single value renders
    // bare ("3"); two values render as "3,4"; broader sets render as
    // a range when numeric ("3–6"), else as "{a,b,c}".
    const fmtValueSet = (set) => {
      const arr = [...set];
      if (arr.length === 1) return String(arr[0]);
      if (arr.every((v) => typeof v === 'number')) {
        const sorted = [...arr].sort((a, b) => a - b);
        const min = sorted[0], max = sorted[sorted.length - 1];
        return min === max ? String(min) : `${min}–${max}`;
      }
      return `{${arr.sort().join(',')}}`;
    };
    // Insertion: drop a `· <attr label>=<value>` line into the body,
    // before the volatile-annotation block (V*, fromBudget, …) so the
    // line stays grouped with the structural body.
    const insertDisambiguator = (cs, line) => {
      const stepIdMatch = /^(\[s\d+\])\s*/.exec(cs.label);
      const stepIdPrefix = stepIdMatch ? stepIdMatch[1] : '';
      const body = stepIdMatch ? cs.label.slice(stepIdMatch[0].length) : cs.label;
      const lines = body.split('\n');
      const insertAt = lines.findIndex((ln) =>
        /^V\*=|^fromBudget=|^fromBase=|^P_reach=|^visits=|^next:/.test(ln));
      if (insertAt >= 0) lines.splice(insertAt, 0, line);
      else lines.push(line);
      const joined = lines.join('\n');
      cs.label = stepIdPrefix
        ? (joined.startsWith('\n') ? `${stepIdPrefix}${joined}` : `${stepIdPrefix} ${joined}`)
        : joined;
    };
    // Single pass: detect body collisions, then for each colliding
    // group run the greedy set-cover to produce the smallest set of
    // disambiguators that makes every rep's body distinct.
    const byBody = new Map();
    for (const cs of chainStates) {
      const fp = bodyFingerprint(cs.label);
      const arr = byBody.get(fp) ?? [];
      arr.push(cs);
      byBody.set(fp, arr);
    }
    for (const reps of byBody.values()) {
      if (reps.length <= 1) continue;
      const perRep = greedyDiscriminators(reps);
      for (let i = 0; i < reps.length; i++) {
        const lines = perRep[i];
        if (!lines.length) continue;
        // Strip the natural `· ≥1 irrelevant` / `· N irrelevant
        // (either side)` summary lines when a totalMods disc line
        // is being added — they convey overlapping info and would
        // make the label redundant. The user's complaint
        // (2026-05-09): "≥1 irrelevant is on all 3 nodes; if it
        // doesn't discriminate, drop it."
        if (lines.some(({ attr }) => attr.name === 'tm')) {
          const cs = reps[i];
          const stepIdMatch = /^(\[s\d+\])\s*/.exec(cs.label);
          const stepIdPrefix = stepIdMatch ? stepIdMatch[1] : '';
          const body = stepIdMatch ? cs.label.slice(stepIdMatch[0].length) : cs.label;
          const filtered = body.split('\n').filter((ln) => !/^· irr: /.test(ln));
          const joined = filtered.join('\n');
          cs.label = stepIdPrefix
            ? (joined.startsWith('\n') ? `${stepIdPrefix}${joined}` : `${stepIdPrefix} ${joined}`)
            : joined;
        }
        for (const { attr, render } of lines) {
          insertDisambiguator(reps[i], `· ${attr.label}=${render}`);
        }
      }
    }
  }

  // Duplicate-label detector: distinct chain states should render
  // distinct labels. When two nodes share the same label modulo the
  // `[sN] ` step-id prefix, either (a) the BFS produced two indices
  // for genuinely-equivalent states (a dedupe bug — `stateKey`
  // should have collapsed them), or (b) the label rendering hides a
  // distinguishing field. Surface as a warning so debugging starts
  // with the offending node ids in hand.
  const labelGroups = new Map();
  for (const cs of chainStates) {
    // Strip the leading "[sN] " prefix so node IDs don't make every
    // label trivially unique.
    const stripped = cs.label.replace(/^\[s\d+\]\s*/, '');
    const arr = labelGroups.get(stripped) ?? [];
    arr.push(cs.id);
    labelGroups.set(stripped, arr);
  }
  const duplicateLabels = [];
  for (const [label, ids] of labelGroups) {
    if (ids.length > 1) duplicateLabels.push({ label, ids });
  }

  // Outgoing-probability completeness check. For every chain node
  // that has outgoing edges (i.e. isn't a terminal goal / brick /
  // buy_base), the probabilities along the chosen action's outcomes
  // should sum to 1.0. When they don't, an outcome was dropped —
  // either filtered out somewhere in the BFS (e.g. destination not
  // in `reachable`) or the action's `transitions` returned an
  // incomplete distribution. Surface as a warning so the user
  // doesn't see "annul 66%" without the complementary 33% sibling.
  const incompleteEdges = [];
  const outByFrom = new Map();
  for (const e of chainEdges) {
    const arr = outByFrom.get(e.from) ?? [];
    arr.push(e);
    outByFrom.set(e.from, arr);
  }
  for (const [from, edges] of outByFrom) {
    // Group by action label so a single node with multiple chosen
    // actions (shouldn't happen under a deterministic policy, but
    // safe-guard) gets per-action totals.
    const byAction = new Map();
    for (const e of edges) {
      const action = (e.label ?? '').split('\n')[0];
      const arr = byAction.get(action) ?? [];
      arr.push(e);
      byAction.set(action, arr);
    }
    for (const [action, es] of byAction) {
      const total = es.reduce((s, e) => s + (e.prob ?? 0), 0);
      if (Math.abs(total - 1.0) > 1e-6) {
        incompleteEdges.push({
          from,
          action,
          total,
          missing: 1 - total,
          edges: es.map((e) => ({ to: e.to, prob: e.prob })),
        });
      }
    }
  }

  // Sub-graph (loop) detection. Implementation lives in
  // engine/mdp/chain-loops.js — a self-contained pure function over
  // the post-collapse chain. Spec: docs/chain-rendering.md §7.
  // Singleton self-loops count; the title is the orb action ids on
  // intra-SCC edges (no static bundle map). Threshold is E[visits] ≥ 3.
  const loops = detectLoops({ states: chainStates, edges: chainEdges });

  return {
    states: chainStates,
    edges: chainEdges,
    start: `s${startIdx}`,
    goals: chainStates.filter((c) => c.kind === 'goal').map((c) => c.id),
    // Strongly-connected components of size ≥ 2 in the chain edge
    // graph — "inner loops" the policy traverses repeatedly. Each
    // entry: { nodes: [stateId...], dominantActions: [actionId...],
    // totalVisits: number }. Empty when the chain has no cycles.
    loops,
    // No-restart-formula decomposition exposed for UI:
    // itemValue(start, B) = pSuccessStart · B + bExpectedStart, so the
    // home view can compute itemValue at any candidate budget without
    // re-solving and surface a "increase budget to ≥ X to make crafting
    // profitable" hint.
    pSuccessStart: pStart,
    bExpectedStart: bStart,
    breakevenBudgetEx,
    // actionId → display name (e.g. apply_bone → "Preserved Rib").
    // Surfaced so per-action UI can show the same friendly name the
    // engine baked into edge labels.
    actionDisplayMap,
    // Set when raw pSuccess(start) exceeded 1.0 + 1e-6 (engine bug
    // — outcome mass over 1). The reported pSuccessStart is clamped
    // to 1 above; this field carries the raw value so the UI can
    // warn the user.
    pSuccessOverflow,
    // Diagnostic: groups of chain nodes whose labels collide
    // (excluding the step-id prefix). Each entry is
    // { label, ids: [stepId...] }. Empty array means every node
    // is visually distinct.
    duplicateLabels,
    collapsedNotice,
    // Diagnostic: chain nodes whose outgoing edges' probabilities
    // don't sum to 1.0. Each entry is `{ from, action, total,
    // missing, edges }`. Empty array means every action's outcomes
    // are accounted for.
    incompleteEdges,
    diagnostics,
  };
}
