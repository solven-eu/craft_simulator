# Craft Simulator

A pure-frontend, analytical crafting evaluator for ARPGs (Path of Exile 2
first; PoE 1, Diablo 4, … as future targets). Vue 3 + Pinia loaded via
importmap — no build step.

The tool answers questions like "what's the cheapest way to craft an item
matching this wishlist?" using **closed-form Markov-chain analytics** and
an **MDP optimal-policy solver** rather than Monte Carlo simulation —
deterministic results, no statistical noise.

## Live demo

- **Custom domain:** <https://www.solven.eu/craft_simulator/>
- **GitHub Pages mirror:** <https://solven-eu.github.io/craft_simulator/>

Both URLs serve the same artefact (the GitHub Pages URL typically
301-redirects to the custom domain). Use either for sharing or
bookmarking.

## Status

In active development. PoE 2 scenarios work end-to-end: define a
wishlist + target, click *Solve MDP*, get the optimal-policy chain
rendered as a Mermaid graph annotated with V\*, P_reach, item value,
budget breakeven, etc. Closed-form strategies (chaos-spam, exalt-annul-
cycle, fracture-anchor, recombinator) sit alongside the MDP for
side-by-side comparison.

## Running

```sh
python3 scripts/dev-server.py    # serves the project on localhost:8765
```

Then open http://localhost:8765 in a modern browser. No `npm install` is
required for runtime — only for tests.

```sh
npm test                         # 98 unit tests across engine + UI helpers
```

## Deploying to GitHub Pages

The project is pure-frontend (importmap + ES modules; no build step),
so it deploys to GitHub Pages directly from the repo as-is. A workflow
in `.github/workflows/pages.yml` runs the test suite then publishes
the whole repo on every push to `master`.

**One-time manual setup** (after pushing the repo):

1. Open the repo on GitHub → **Settings → Pages**.
2. Under **Build and deployment → Source**, select **GitHub Actions**
   (not "Deploy from a branch").
3. Push to `master`. The workflow will run; the Pages URL appears in
   the Actions tab once the deploy step succeeds (typically
   `https://<your-user>.github.io/<repo-name>/`).

The workflow's `concurrency: pages` group serializes deploys, and
the test job is a hard prerequisite for the deploy job — failing
tests block the publish.

A `.nojekyll` file at the repo root disables GitHub Pages's default
Jekyll preprocessing (which would otherwise strip files / dirs whose
names start with `_`).

## Licensing

This project is licensed under **Creative Commons Attribution-
NonCommercial-ShareAlike 4.0 International** (CC BY-NC-SA 4.0).

- **You can**: share, adapt, fork, redistribute the code and data.
- **You must**: attribute the project (link back here is fine), keep
  derivatives under the same license.
- **You cannot**: use this for primarily commercial purposes (selling
  the tool, embedding in a paid service, etc.).

Full license text: `LICENSE` in this repo, or
<https://creativecommons.org/licenses/by-nc-sa/4.0/>.

### Why this license

Two reasons:

1. **Non-commercial** is in line with this being a fan tool, not a
   product. The disclaimer view in the app makes the same point: this
   project is not affiliated with or endorsed by Grinding Gear Games.
2. **Share-alike is required** by the upstream data we depend on:

### Upstream data attribution

Game data ingested by this project comes from sources licensed under
**CC BY-NC-SA 3.0** (full list and per-source notes in
[`docs/sources.md`](docs/sources.md)):

- [poe2db.tw](https://poe2db.tw/) — modifier tables, orb rules, omen
  catalog, currency descriptions, recombinator rules.
- [Krakenbul's WEIGHTS + ILVLS sheet](https://docs.google.com/spreadsheets/d/1QSAu0A-ZKcHFlQ5QCcUJSMb0ebXq1nxpGRUVgHXVjW8/edit) — per-base mod
  spawn weights and ilvl gating.
- [poe2db.tw — Economy tables](https://poe2db.tw/Economy_Currency) — currency
  rates, snapshotted via `scripts/update-poe2-rates.sh`.

The upstream CC BY-NC-SA 3.0 chain is what locks this project into
SA + NC; CC BY-NC-SA 4.0 is one-way upgrade-compatible with 3.0, so
this license satisfies the inheritance requirement.

## Contributing

Pull requests welcome under the same CC BY-NC-SA 4.0 terms. Ground
rules in [`CLAUDE.md`](CLAUDE.md):

- Every bug fix gets a regression test first (lax TDD).
- Game-rule constants default to canonical PoE2 values; override
  in tests, not in defaults.
- Trust user domain knowledge when it contradicts code — verify the
  game rule, update both code and tests.

## Roadmap

See [`ROADMAP.md`](ROADMAP.md). Current shipped: MDP-α (single-mod
generic engine), MDP-β (omens), MDP-γ (tier-aware via
pTierAcceptable), MDP-δ (desecration: bone-trick + reveal +
multi-bone + omen variants), MDP-ε (essences), MDP-η (chaos), Divine
Bench tab, recipe DSL.
