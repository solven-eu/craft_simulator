# Project conventions

## Lax TDD: every bug gets a regression test

Whenever we encounter a bug, the workflow is:

1. **Reproduce the bug as a failing unit test first.** The test goes in
   `tests/<scenario>.test.js` (run via `npm test`, which globs
   `tests/*.test.js`). Pin the exact behaviour you observe, with
   inputs minimal enough to fit in a few lines.

2. **Fix the code so the test passes.** No fix without the failing test
   first.

3. **If you can't reproduce the bug as a test, say so.** Don't claim a
   speculative fix without evidence — either find a test that pins the
   misbehaviour, or revert the change. Speculative "defensive" edits
   without test backing erode trust in the engine's correctness.

The "lax" part: not every change needs a test (UI tweaks, refactors
under existing test coverage, doc changes). But every bug fix does.

## Transformations on labeled values need numerical tests

When code transforms a value that's surfaced to the user (chain
labels, annotations, summaries — anything the user reads as a
number), add a regression test that pins the transformation's
output, not just "the transformation runs without error."

Examples of transformations that need pinned numerical tests:
- **State-merging operations** (e.g. equivalence-class collapse):
  pin that the merged value reflects the aggregation rule (sum,
  min, max, mean) rather than inheriting one source's value.
- **Probability re-normalisation**: pin that the post-transform
  total stays within the expected bound (≤ 1.0 for probabilities,
  no negatives, etc.).
- **Display clamping** (e.g. capping P_reach at 100%): pin that
  the truncation marker fires when the value exceeds the cap, AND
  the underlying value isn't lost by the clamp.
- **Per-side / per-tier / per-mod redistribution**: pin a known
  input → known output mapping for at least one canonical case.

A "smoke test" that checks the function runs without throwing is
NOT sufficient for transformations — those bugs (label inherits
wrong value, sums to >100%, drops mass) only surface as numerical
mismatches. The bug only became visible when a user spotted a
label looking wrong; a numerical test would have caught it on the
PR that introduced the regression.

Concretely: if you write code that does `merged.value = source.value`,
ask "could this `=` be wrong (sum-vs-pick-one, average-vs-sum, etc.)?"
and add a test pinning the choice. If you write code that does
`Math.min(1, p)` or `Math.max(0, x)`, ask "could the underlying
value differ from the displayed value?" and pin both.

## Testable contract

The engine layer follows an "input → output" architecture so tests can
pin behaviour without coupling to UI / store / URL state:

- `engine/mdp/solve.js` — `solveMDP(input)` is pure. Same input ⇒ same
  output. Test scenarios live in `tests/mdp-<scenario>.test.js` and
  describe the problem fully (wishlist, target, rates, base price).

- Each unit test is self-contained: explicit rates, explicit fracture
  rule, explicit `timeWeightExPerSec`. No reliance on store defaults.

- When inputs span game rules (e.g. `minModsToFracture`), the test
  passes the value explicitly so the test stays valid even if the
  default changes.

## Default values should reflect the game

Game-rule constants (`minModsToFracture`, `alchemyDraws`, `maxFilled`)
default to their canonical PoE2 values. Tests can override but
shouldn't have to. If you change a default to fix a test, you're
working backwards.

## When in doubt about user intent

If a user statement contradicts existing code (e.g. "fracture needs ≥3
mods" vs `orbs.js` saying ≥4), trust the user's domain knowledge —
they're the PoE2 expert. Update both the code and any tests to match,
and document the canonical value in one place (typically the game
catalog file).

## Ask for missing data, don't work around it

When a UI element or computation depends on data that isn't in our
sources, **surface the gap and ask the user to provide it** instead
of:

- silently omitting the affordance (hides the feature without
  explanation),
- substituting a heuristic that *might* be right (looks correct, is
  unverifiable, erodes trust),
- showing the affordance for every row indiscriminately because we
  can't tell which row should have it (worse than no signal).

Concretely: list the missing entries (which families / tiers / bases),
state what fields are needed and where they live in the PoE2 source
(usually a poe2db page), and let the user decide whether to provide
the data, write a scraper, or accept the gap explicitly.

The same rule applies to *unverified* data: if a derivation could be
right but we haven't verified the assumption (e.g. "essence display
range matches base mod tier range exactly"), say so, ask for
confirmation, then implement — don't ship the assumption silently.
