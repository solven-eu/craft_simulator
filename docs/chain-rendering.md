# Chain rendering — design spec

Status: **draft / pinning expectations** (2026-05-09).

This document captures what the chain (graph) rendering should achieve, the trade-offs we keep tripping on, and a set of concrete worked examples that the implementation must satisfy. Implementation lives in `engine/mdp/chain.js`. When the implementation and this document disagree, this document is the source of truth — fix the code (or, if the spec is wrong, edit this document first and then the code).

---

## 1. Goals

### G1. Few nodes per next-action

Two states with the same optimal next action are presentationally interchangeable: the user reads "the policy says X here" and doesn't need to scrutinise side-allocation, exact totalMods, or wished-mod identity if those fields don't affect downstream behaviour. The chain should NOT have 5 nodes labelled `next: exalt` when 1 covers them all — that fragments the graph and obscures the "phases" of the craft.

### G2. Each item maps to exactly one node

A user looking at a concrete in-progress item must be able to point at a single node and say "I am here." Two nodes whose label envelopes overlap (e.g. `tm=2–4` vs `tm=3–5` — an item with tm=4 fits both) violate this. This is the **hard semantic invariant**: every reachable engine state belongs to exactly one rep, and the rep's visible label must, by inspection alone, identify the rep that covers it.

### G3. Label is the simplest covering description

Within a node, the label should describe the SET of underlying states that node covers — without losing useful "shared property" information. If every member has `🔒 S:cold`, say so (it's a property of the entire group, useful for the reader to see at a glance even though it's redundant for *distinguishing*). If members differ on totalMods, the label should make that clear (range, or single value if all members agree).

### G4. Useful redundancy is allowed

Tension with G3: minimising label length is NOT the goal. A property that's **shared by every member of a node and useful as a quick discard signal** belongs in the label. Example: a goal node should still display `★ S:cold | S:fire` even though "I'm at goal" is technically implied by the kind=goal styling — the wished mod identity helps the reader confirm they're looking at the right craft.

### G5. The disambiguator is informative, not punitive

When a node-set needs disambiguating, the disambiguator lines added to labels should help the reader differentiate. If two nodes have similar bodies but differ on `totalMods`, showing `tm=3` vs `tm=4` is clean. Showing `tm=2–4` vs `tm=3–5` (overlapping ranges) is *worse than nothing* because the reader can't decide. Either the engine's partition is too coarse (split it further) or the disambiguator is the wrong attribute (pick another).

---

## 2. Anti-goals (things we explicitly DON'T want)

- **A1.** A 5-row label with independent attribute breakdowns. Even when needed for joint-disjointness, it's unreadable.
- **A2.** Many nodes with identical "next:" actions and labels that differ only at `· totalMods=N` — that's a partition leak, not a presentation problem. If two nodes truly need to be distinct, the body should TELL ME why.
- **A3.** Hidden distinguishers: two nodes that look the same but differ on attributes the label doesn't show. The user can't tell them apart.
- **A4.** "Smart" inference: trying to guess what the reader wants by hiding information when it "doesn't help." If a property is true of the node, show it.

---

## 3. The fundamental trade-off

The user describes it well:

> "Should we merge by commonality or split to express distinction?"

Two extremes:

- **Aggressive merge (one node per `(kind, policy)`)**: minimum nodes, but each node covers many concrete states with wildly varying attributes. The label becomes either useless ("any state where exalt is the optimal action") or overly verbose ("any state where exalt is optimal AND tm in {1,2,3,4} AND prefix in {0,1,2,3} AND fractured ∈ …").

- **Aggressive split (one node per fully-distinct attribute tuple)**: each node covers exactly one underlying state shape. Labels are crisp single values. But the chain explodes in node count, hiding the policy structure.

The right answer is somewhere in between, and is **per-attribute**:

| Attribute              | Default in partition? | Why |
|------------------------|-----------------------|-----|
| `kind`                 | yes                   | goal vs transient is fundamentally different. |
| `policy` (next action) | yes                   | the whole point of the chain is showing what action the policy picks. |
| `fractured`            | yes                   | irreversible; mixing fractured/unfractured loses behavioural info. |
| `totalMods`            | **YES** (current)     | the value-iteration policy depends on it; a "tm=2" rep where exalt is optimal is a different beast from "tm=4" where exalt is also optimal (different success/brick odds, different downstream chain). User wants each item to map to exactly one node — bucketed totalMods leaks ambiguity (item with tm=4 fits both `tm=2–4` and `tm=3–5` rep labels). |
| `prefixMods`           | no                    | side-allocation is presentationally interchangeable; engine policy almost never differs by prefix vs suffix split for symmetric wishlists. Goes to the disambiguator if needed. |
| `wished count`         | no                    | redundant with totalMods + irrelevant breakdown; rarely useful as a discriminator. |
| `bone`                 | no                    | rare in practice; goes to disambiguator. |
| `desecrated count`     | no                    | rare; goes to disambiguator. |

Default partition: **`(kind, policy, fractured, totalMods)`**.

---

## 4. Label structure (per node)

Order of lines (top-to-bottom):

1. **Step id** `[sN]` — debugging only, omittable via `showStepIds`.
2. **Wished mods present** — one line per wished bit, prefixed `★` (required) or `·` (desired). Example: `★ S:cold | S:fire`. Mods in the same wished-equiv-class collapse to a single line (`S:cold | S:fire` rather than two separate `★` lines).
3. **Fracture marker** — `🔒 S:cold` (which mod is fractured) or `💀 irr-fractured` (an irrelevant slot is locked).
4. **Bone marker** — `🦴 unrevealed bone-mod` or `✓ bone revealed`.
5. **Desecrated count** — `🦴 desecrated×N` when the state has any desecrated provenance.
6. **Irrelevant slots** — per-side breakdown when uniform across the group (`· P: 1 irrelevant`, `· S: 2 irrelevant`); folded to `· N irrelevant (either side)` when the group merges different per-side splits. **Stripped** when a `totalMods=…` disc line is added (totalMods + wished implies irr count).
7. **Disambiguator lines** — `· totalMods=N`, `· fractured=irr`, etc. Inserted only when the body would otherwise collide with another rep's body.
8. **V\*, fromBudget, fromBase** — value annotations, sorted in this order.
9. **P_reach, visits** — visit-count annotations.
10. **Next action** — `next: <actionId>`. Always last (omitted for goal/brick).

---

## 5. Disambiguator pass

When two reps have identical body fingerprints (lines 1–6 above, ignoring step id and value annotations), the disambiguator pass kicks in.

**Selection rule** (proposed, current implementation matches):

1. Compute, per rep, the value-set of each candidate attribute across the rep's underlying member states.
2. Brute-force the smallest attribute SUBSET (cap at 2) such that the JOINT tuples (a tuple per member state, one entry per chosen attribute) are pairwise disjoint across reps.
3. From that subset, EMIT only attributes whose rendered values actually differ across reps. Attributes that participate in the joint-disjoint cover but render identically (e.g. all reps cover `prefix=0–3`) are dropped from the label — they're noise.
4. If brute-force can't find a subset that fully discriminates within the cap of 2, accept residual ambiguity and emit the best partial cover. The duplicate-label warning surfaces what's left.

**Cap rationale**: 2 disc lines per rep is the readability ceiling. Beyond that, the user cannot mentally combine independent value-sets back into joint distributions; the label becomes adversarial. If the disambiguator wants to emit 3+ attrs, the right move is to refine the partition (split the group into more reps) — see G2.

---

## 6. Worked examples

These are the cases the implementation must handle correctly. Each example specifies:

- A scenario (input setup or chain pattern).
- The expected node count + labels.
- A note on why this is the right outcome.

### E1. Symmetric wished mods, side allocation differs

**Scenario**: Cold + fire suffix wishes (same weight, same required tier). Two states: 1 wished cold + 1 irr suffix, vs 1 wished fire + 1 irr suffix. Both have policy=exalt.

**Expected**: 1 rep. Label:
```
★ S:cold | S:fire
· S: 1 irrelevant
next: exalt
```

**Why**: cold and fire are in the same wished-equiv-class; `S:cold | S:fire` is shared placeholder text. Side allocation is identical.

### E2. Same policy, different totalMods

**Scenario**: 1-irrelevant magic at tm=1 chooses augment, but a different state with tm=2 (also magic) under the same policy=augment exists.

**Expected**: 2 reps (separate nodes by totalMods).

```
[A] · 1 irrelevant
    next: augment
[B] · totalMods=2
    next: augment
```

**Why** (G2): each item with a given totalMods must map to one node. `tm=1` and `tm=2` are different cases. The body shows the per-side breakdown when uniform; the disambiguator is unnecessary because the partition already split them.

### E3. Same body, different policy, no concrete-item ambiguity

**Scenario**: two reps both render with the body `· ≥1 irrelevant` (varying members within each), one's policy is `annul`, the other `chaos`. Their underlying states partition cleanly on totalMods.

**Expected**: 2 reps with disambiguator.

```
[A] · ≥1 irrelevant
    · totalMods=2–4
    next: annul
[B] · ≥1 irrelevant
    · totalMods=3–5
    next: chaos
```

**STILL WRONG** under G2: an item with tm=3 fits both labels. Resolution: refine the partition by adding `totalMods` exact, producing one rep per totalMods value (already the default). After refinement:

```
[A2] · 2 irrelevant   next: annul
[A3] · 3 irrelevant   next: annul
[A4] · 4 irrelevant   next: annul
[B3] · 3 irrelevant   next: chaos
[B4] · 4 irrelevant   next: chaos
[B5] · 5 irrelevant   next: chaos
```

The body `· N irrelevant` already includes totalMods info via the count, so no `totalMods=…` disc line is needed.

### E4. Two start-shaped states (rarity differs)

**Scenario**: the start state (Normal, tm=0) and a post-annul-spam state (Rare, tm=0) both have empty mod lists. Different policies (start chooses transmute; the Rare-with-zero-mods chooses ...something).

**Expected**: 2 reps. Bodies are both `(empty)` initially → collision → disambiguator picks `rarity`.

```
[s0]  (empty)
      · rarity=normal
      next: transmute
[s103] (empty)
       · rarity=rare
       next: exalt
```

**Why**: the natural label `(empty)` doesn't expose rarity. `rarity` is the right disambiguator because (a) it's a single value per rep (not a range), (b) it cleanly separates the two reps.

### E5. Goal nodes with different fractured states

**Scenario**: two goal nodes, one with cold fractured, one with fire fractured.

**Expected**: 2 reps.

```
[gc] ★ S:cold | S:fire
     🔒 S:cold
[gf] ★ S:cold | S:fire
     🔒 S:cold | S:fire    (or `🔒 S:fire`, depending on equiv-class rendering)
```

**Why**: the fracture line is part of the natural label. Different fractured bits → different fracture lines → no body collision. (The wished-equiv-class machinery should keep the `🔒` line distinguishable when the two fractured mods are NOT in the same equiv class — i.e. asymmetric wishlist. For symmetric wishes they'd render identically and need the `· fractured=…` disambiguator.)

### E6. The "ideal merge" case

**Scenario**: 3 transient reps, all with body `★ S:cold | S:fire` + `· ≥1 irrelevant`. They differ only in policy (one annul, one chaos, one exalt) AND have UNIFORM totalMods within each rep but different across reps (annul: tm=5, chaos: tm=4, exalt: tm=3).

**Expected**: 3 reps, no disambiguator needed because the IRR LINE captures the totalMods difference (tm=3 + wished=2 → ≥1 irrelevant; the rewriter picks per-side counts).

```
[A] ★ S:cold | S:fire
    · S: 3 irrelevant
    next: annul
[B] ★ S:cold | S:fire
    · S: 2 irrelevant
    next: chaos
[C] ★ S:cold | S:fire
    · S: 1 irrelevant
    next: exalt
```

The irrelevant counts naturally differ → bodies are distinct → no `· totalMods=…` line needed.

### E7. Useful shared-property visibility

**Scenario**: 3 reps, all with `🔒 S:cold` (cold fractured), differing in policy. The fracture marker is shared but useful (the reader sees "ok, this whole region of the chain is post-fracture, makes sense").

**Expected**: keep `🔒 S:cold` on each label even though it's redundant for distinguishing.

```
[A] ★ S:cold | S:fire
    🔒 S:cold
    · 1 irrelevant
    next: annul
[B] ★ S:cold | S:fire
    🔒 S:cold
    · 2 irrelevant
    next: exalt
…
```

**Why** (G4): the fracture marker is a quick discard signal — the reader can scan for it to identify post-fracture phases of the craft. Hiding it because "it doesn't help discriminate within this group" would lose that signal.

---

## 7. Sub-graphs / loop detection

A *sub-graph* (or *loop*) is a region of the chain where the policy
spends a meaningful fraction of its time before progressing. Visually,
the renderer should box this region (Mermaid subgraph / Cytoscape
compound) so the chain reads as `phase 1 → loop A → phase 2 → goal`
instead of an undifferentiated edge soup.

### 7.1 Definition: what counts as a loop?

The defining property is **stationary behaviour**: starting from any
member of the set, the policy has a high probability of *staying inside
the set* before exiting. The number of nodes is not the criterion.

- A **single node with a self-loop** (e.g. chaos spam where chaos
  re-rolls the same item shape) IS a loop. The user spends many orbs
  inside this single node before something escapes.
- A **two-node oscillation** (exalt to fill → annul to undo) IS a loop.
- A **larger cycle** (regal → exalt → annul → regal → …) IS a loop.

The previous "drop singleton SCCs" rule (in `engine/mdp/chain.js` as of
2026-05-09) is **wrong** by this definition and needs to go: a chaos-
spam state self-looping at p=0.85 has E[visits per attempt] ≈ 6.7,
which is the kind of stationary behaviour the visual cluster should
surface.

### 7.2 Threshold: when is a loop "real"?

Use the engine's `expectedVisits` (now correctly accounting for self-
loops, see the 2026-05-09 fix). A reasonable threshold is **E[visits]
≥ ~3**: roughly "the user enters this region at least three times in
expectation per attempt." Two-pass through is borderline — could be
incidental traffic. Three-plus suggests real stationary behaviour
worth boxing.

For multi-node sub-graphs, sum `expectedVisits` over the member
states (a single attempt visits various members of the loop, total
visits = expected loop "iterations" × loop size). The threshold
applies to the sum.

### 7.3 No hardcoded action bundles

The current implementation groups actions into *bundles* (`exalt+annul`,
`chaos`, `regal`, …) so that an `exalt → annul → exalt → …` SCC gets
boxed as one "exalt+annul phase." This is **the wrong layer** for that
grouping:

- Bundling is opinionated — adding orbs requires updating a static map.
- It hides bugs: if `exalt+annul` doesn't emerge naturally as a single
  high-traffic SCC on a simple craft, the engine has a problem; the
  bundle map papers over it.
- It bakes in an assumption that may not hold per-game (PoE1 vs PoE2
  vs D4) or per-scenario.

The right approach: **let bundles emerge from the SCC structure
itself**. If exalt and annul states are tightly connected (high
transition probability between them, both with high `expectedVisits`),
they'll land in the same SCC. The renderer titles the box from the
*observed* dominant actions, not from a static map.

If the engine on a simple test fixture doesn't produce `exalt+annul`
as one SCC when the user expects it, the fix is to investigate the
engine — not to add a manual override.

### 7.4 Ordering: partition first, then loop detection

There are two possible orderings:

1. **Loops before partition (collapse)**. Detect cycles on the raw
   reachable graph, then box them, THEN merge equivalent nodes.
   - Problem: collapsing nodes within a box requires keeping the box
     coherent — if two members merge, the box shrinks; if a member
     merges with something outside, the box breaks. Cumbersome.
   - Worse: cross-box merges (a transient state pre-loop turns out to
     be equivalent to a transient state post-loop) become very hard
     to handle without redrawing the whole structure.

2. **Loops after partition (collapse)**. Run the engine partition +
   collapse first, then run SCC detection on the resulting reduced
   graph.
   - Possible concern: "what if two states that *should* have been
     kept in different boxes get merged?" This concern doesn't apply
     because the MDP is **memoryless** — we don't care how we got to
     a state, only what state we're in. Two states with identical
     attributes ARE the same state, regardless of whether one
     appeared before and one after a "phase transition" in the
     reader's mental model. The collapse is correct; the post-
     collapse SCC then captures stationary behaviour over the
     correct (merged) state space.
   - Concretely: the SCC algorithm just needs to walk the post-
     collapse `chain.states` + `chain.edges`. No special handling.

**Conclusion**: partition first, sub-graph detection after. Implement
loop detection as a pure post-pass on the collapsed chain.

### 7.5 Naming convention

The box title is the list of **orbs (action ids) involved in the SCC's
intra-component edges**, joined by `+` in descending order of
transition-probability mass. The name is purely descriptive — what
the user sees is what the algorithm observed:

- A single-node self-loop on `chaos` → title: `chaos`.
- A two-node cycle alternating exalt → annul → exalt → … → title:
  `exalt+annul` (assuming exalt mass > annul mass).
- A fracture-roulette where fracturing repeatedly fails and you annul
  to retry → title: `fracturing+annul`.

Variants (e.g. `exalt_perfect`, `regal_dextral`) are kept distinct in
the title — the reader can see "this loop uses Perfect Exalts, not
plain Exalts." If two variants are common, both appear:
`exalt_perfect+exalt_greater`.

There is no global static "bundle map" mapping `exalt`+`annul` →
`exalt+annul`. The grouping is just the by-product of "which actions
have non-trivial intra-SCC edge mass." If an SCC genuinely uses three
orbs, the title shows three.

### 7.6 Implementation status (as of 2026-05-09)

- [x] SCC via iterative Tarjan, on post-collapse chain.
- [ ] **Drop the singleton-SCC filter** — single-node self-loops with
      high `expectedVisits` should be boxed.
- [ ] **Drop the hardcoded action bundle map** — let bundles emerge.
      The "title" of a box should be the dominant action(s) computed
      from intra-SCC edge probability mass.
- [ ] **Tune the visit threshold** — currently `totalVisits < 1`,
      should be more like `≥ 3` for "this is genuinely stationary."
- [ ] **Verify ordering** — confirm we're running SCC strictly after
      collapse + partition refinement (currently yes, but we should
      pin this with a test).

---

## 8. Alternative: locality-aware (bottom-up) merging

**Status: design under exploration, not implemented.**

The current strategy (§3) starts top-down: pick a global partition key
`(kind, policy, fractured, totalMods)`, group every chain state by
that key, then disambiguate. This has a known weakness — two states
that share `(kind, policy, fractured, totalMods)` but appear in
unrelated parts of the chain end up in the same node, even though
the user's mental model treats them as distinct phases of the craft.
The labelling problem (§5) is partly a symptom of this: when distant
states get merged, the rep's label has to summarise wildly different
contexts, and that summary is rarely clean.

### 8.1 The proposal

Start with no merges. Walk the chain bottom-up — for each parent
state `A` whose policy fans out to children `B`, `C`, `D` under a
single action `α`:

- If two of those children share the same next-action (e.g. `B` and
  `C` both have policy `β`), they are *locality-merge candidates*.
- Try merging `B` and `C` into one rep. Check that the resulting
  label is still semantically clean (every concrete item that fits
  the merged rep's label fits exactly one rep — same G2 invariant
  as the global approach).
- If clean: commit the merge, and the merged rep becomes a new
  child of `A`. Recurse upward / outward.

This is essentially **bisimulation refinement from the leaves** —
classical MDP equivalence applied locally, where the equivalence
predicate is "same successor distribution under the same action."

### 8.2 Why this might produce nicer labels

When `B` and `C` are siblings under `A`, they share the same upstream
context. They reached this point via the same parent action with
different probabilistic outcomes, so their state attributes typically
differ only in one or two dimensions (the dimensions the parent
action affects). Their covering label captures *that specific
variation* and nothing else — far less awkward than summarising
states that converged from unrelated paths.

Concrete intuition: if `A` is "magic with 1 affix" and applies
augment, the children `B`, `C` are "magic with 1 wished + 1 irr",
"magic with 2 wished", "magic with 0 wished + 2 irr". If two of them
have the same next-action, they differ only in *which side picked
up the new affix*, not in totalMods or fracture state. The merge
label is naturally clean: `· N affixes` with the side detail elided.

### 8.3 Where the bottom-up approach is hard

- **Cycles**. The chain has loops (chaos-spam, exalt+annul). Bottom-up
  walk needs a topological order; cycles break that. Fix: treat
  loops as atomic (per §7) before running the locality merge, so the
  walk operates on the loop-condensed DAG.

- **Non-sibling locality**. Sometimes states that *should* merge
  aren't siblings under one parent — they have multiple distinct
  entry points. Pure sibling-merge misses these. Extension: after
  one bottom-up pass, run a second pass merging states that have
  *equivalent forward behaviour* (same outgoing distribution) even
  when entry points differ. This is full bisimulation, just costlier.

- **Stopping criterion**. When do we stop merging? A pure greedy
  "merge whenever labels stay clean" can over-collapse if the
  cleanliness check is loose. Need a sharp definition of "clean
  label" — likely the same G2 invariant: each concrete state maps
  to exactly one rep label. Once a candidate merge would violate
  G2 (overlapping labels), reject the merge.

- **Rendering implications**. If two states A→B and A→C merge into
  A→{B,C}, the edges from A to the merged rep need to combine
  probability mass. Standard, already handled by the existing
  collapse pipeline — but the merge order matters when probability
  re-normalisation is involved.

### 8.4 How this compares to the current top-down approach

| Property                            | Top-down (current)          | Bottom-up (proposed)            |
|-------------------------------------|-----------------------------|---------------------------------|
| Initial state                        | Maximally merged             | Maximally split                 |
| Merge criterion                      | Same partition key           | Same next-action AND siblings   |
| Risk                                 | Distant states co-merged     | Misses non-local equivalences   |
| Labelling difficulty                 | High — wide context spread   | Lower — narrow context spread   |
| Worst-case node count                | Few                          | Many                            |
| Best-case node count                 | Few                          | Few (after recursion completes) |
| Implementation effort                | Done                         | Significant refactor            |

### 8.5 Path forward

This isn't an immediate change — it's a design alternative we'd
adopt if the top-down labelling problem keeps biting us. Concrete
trigger: if after partition refinement (§5) we still get reps whose
labels are awkward summaries of unrelated contexts, we accept that
the global partition is the wrong starting point and rebuild
bottom-up.

For now: keep §3's top-down partition + §5 disambiguator + §7 loop
detection as the implementation. Treat §8 as a documented escape
hatch.

---

## 9. Open questions / ambiguities

These cases the spec doesn't yet fully nail. Suggestions welcome.

- **Q1.** When goal nodes differ only in attributes that aren't naturally surfaced (e.g. one goal has an irrFractured slot, the other doesn't, but neither has a fracture marker on a wished bit), how should the label show this? Currently we'd add `· fractured=irr` vs `· fractured=-`. Reads OK?

- **Q2.** Should "near-trap" (policy=buy_base) nodes get the same label treatment as transient nodes, or are they enough of a different beast that they should always be visually marked separately (no disambiguator, just a banner like `⛔ restart preferred`)?

- **Q3.** When a single rep covers many member states with widely varying `prefixMods` (e.g. {0,1,2,3,4}), is it useful to show `prefix mods varies` somewhere, or is silence preferred?

- **Q4.** Should bone-mod presence/state ALWAYS be on the label (G4 shared-property argument) or only when it discriminates? Currently it goes to the disambiguator only — but a chain with bones in play might benefit from bones being visible everywhere they exist.

- **Q5.** *(resolved)* Sub-graph naming: list the orbs (action ids) actually involved in the SCC's intra-component edges, joined by `+` in descending probability-mass order. So a cycle dominated by `exalt → annul → exalt` reads `exalt+annul`; a chaos self-loop reads `chaos`; a fracture-roulette reads `fracturing+annul` (or whatever the observed pattern is). No interpretation, no static bundling — just "which orbs power this loop." See §7.3 / §7.6.
