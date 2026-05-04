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
