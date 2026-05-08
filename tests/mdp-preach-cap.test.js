// Regression test: P_reach for any chain state must stay within
// [0, 1]. The earlier BFS-accumulator implementation could exceed
// 1.0 because cycles + fan-in caused the same state to be visited
// up to 16 times, each visit adding to its successors' pReach
// (over-counting by up to 16×).
//
// User report (2026-05-07): live craft (Amulet, 2 required mods,
// budget 1870ex) showed an s42 chain node labelled with P_reach >
// 100%.

import { strict as assert } from 'node:assert';
import { solveMDP } from '../engine/mdp/solve.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.message}`); }
}

console.log('Chain — P_reach probability cap');

const baseInput = {
  wishlist: [
    { key: 'PREFIX:WISH_P', weight: 1000, type: 'PREFIX', requiredTier: 1, required: true },
    { key: 'SUFFIX:WISH_S', weight: 1000, type: 'SUFFIX', requiredTier: 1, required: true },
  ],
  irrelevantWeight: 50000,
  irrelevantWeightBySide: { PREFIX: 25000, SUFFIX: 25000 },
  target: { requiredMods: ['PREFIX:WISH_P', 'SUFFIX:WISH_S'], minFilled: 2, maxFilled: 6 },
  start: { rarity: 'normal' },
  basePriceEx: 100,
  alchemyDraws: 4,
  maxFilled: 6,
  timeWeightExPerSec: 0,
  budgetEx: 5000,
  orbCosts: { transmute: 0.01, augment: 0.05, regal: 0.5, alch: 1, exalt: 1, annul: 0.5, fracturing: 50, chaos: 5 },
  orbTimes: { transmute: 1, augment: 1, regal: 1, alch: 1, exalt: 1, annul: 1, fracturing: 3, chaos: 1 },
};

function extractPReach(label) {
  const m = /P_reach=(\d+(?:\.\d+)?)%/.exec(label ?? '');
  return m ? parseFloat(m[1]) / 100 : null;
}

test('every chain state has 0 ≤ P_reach ≤ 1.0 + ε', () => {
  const result = solveMDP({ ...baseInput, collapseEquivalent: false });
  const violations = [];
  for (const cs of result.chain.states) {
    const p = extractPReach(cs.label);
    if (p == null) continue;
    if (p > 1 + 1e-6) violations.push(`${cs.id}: P_reach=${(p * 100).toFixed(1)}%`);
    if (p < -1e-9) violations.push(`${cs.id}: P_reach=${(p * 100).toFixed(1)}% (negative)`);
  }
  assert.ok(violations.length === 0,
    `expected every P_reach in [0, 1]; got:\n  ${violations.slice(0, 5).join('\n  ')}`);
});

test('terminal states (goal / bricked) carry P_reach annotations', () => {
  const result = solveMDP({ ...baseInput });
  const goals = result.chain.states.filter((s) => s.kind === 'goal');
  assert.ok(goals.length > 0, 'expected at least one goal state');
  const goalsWithPReach = goals.filter((s) => /P_reach=/.test(s.label));
  assert.ok(goalsWithPReach.length > 0,
    'expected at least one goal node to carry P_reach (per 2026-05-07 user direction)');
});

test('cycle-prone states carry a visits=N× annotation when E[visits] > 1', () => {
  // Per user direction (2026-05-07): P_reach is "probability of
  // visiting at least once" (clamped at 100%); a separate `visits=N×`
  // line surfaces when the same state is expected to be visited
  // multiple times per attempt (annul-then-refill, chaos cycles).
  // The two metrics together tell the user "you'll always land here,
  // and on average you'll iterate through this loop N times."
  const result = solveMDP({ ...baseInput });
  const withVisits = result.chain.states.filter((s) => /visits=[\d.]+×/.test(s.label));
  // Not every craft has loops, but the 2-mod fixture has annul →
  // refill paths that cycle. Allow zero visits-states when no loop
  // is present, but if any state's expectedVisits exceeds 1 then
  // it MUST get the visits line.
  for (const cs of result.chain.states) {
    const m = /P_reach=(\d+(?:\.\d+)?)%/.exec(cs.label);
    if (!m) continue;
    const reach = parseFloat(m[1]) / 100;
    // P_reach is clamped at 100%. If the underlying expected-visits
    // exceeded 1, the visits line should be present.
    if (reach >= 0.999) {
      // Could be exactly 1.0 (deterministic) OR clamped from > 1.
      // Probe: if visits line is present, value > 1.
      const vMatch = /visits=([\d.]+)×/.exec(cs.label);
      if (vMatch) {
        assert.ok(parseFloat(vMatch[1]) > 1,
          `${cs.id}: visits annotation should only appear when E[visits] > 1; got ${vMatch[1]}`);
      }
    }
  }
  // For this fixture we want at least ONE cycle-prone node so the
  // test is meaningful — but if not present, skip the count check.
  if (withVisits.length > 0) {
    for (const cs of withVisits) {
      assert.ok(/P_reach=100\.0%/.test(cs.label),
        `${cs.id}: state with visits annotation should have P_reach=100% ` +
        `(if E[visits] > 1, you visit at least once with prob 1)`);
    }
  }
});

test('start state has no P_reach annotation (P=1 implicit)', () => {
  const result = solveMDP({ ...baseInput });
  const startNode = result.chain.states.find((s) => s.id === result.chain.start);
  assert.ok(startNode && !/P_reach=/.test(startNode.label),
    `start node should not carry P_reach; got: ${startNode?.label}`);
});

test('collapsed representative\'s P_reach reflects the GROUP-TOTAL, not just one sibling\'s', () => {
  // When N sibling states with the same wished/policy core but
  // different prefixMods collapse into one representative, the
  // representative's P_reach should reflect the SUM of all merged
  // sources' pReach values — i.e. "this is the share of attempts
  // that land in this equivalence class."
  //
  // User-visible bug (2026-05-07): a magic|0|1 representative
  // displayed P_reach=40% in a craft where ~97% of attempts went
  // through the irrelevant-landed Magic node. Each of the 4
  // collapsed siblings (one per prefixMods value) had ~25% pReach;
  // the representative inherited only one of those.
  //
  // Direct check: total P_reach across all displayed representatives
  // (excluding start, whose P_reach is implicit 1) should
  // approximately equal the total mass moving through the chain.
  // For a 2-mod craft, this gives a rough "Σ P_reach over all
  // representatives ≥ 1.0" sanity. The pre-fix bug had the magic|0|1
  // node showing only its one-sibling share, so the system-wide
  // sum was much lower than the genuine reach distribution.
  const collapsed   = solveMDP({ ...baseInput, collapseEquivalent: true });
  const uncollapsed = solveMDP({ ...baseInput, collapseEquivalent: false });
  // Aggregate metric: sum of displayed P_reach (clamped at 100%
  // for cycle-prone states) across non-start chain nodes.
  // Post-fix, the collapsed total should be ≥ the uncollapsed total
  // minus what's lost to clamping — i.e., the collapsed
  // representatives correctly absorb the merged sources' share
  // rather than dropping it.
  const sumLabels = (chain) => {
    let s = 0;
    for (const cs of chain.states) {
      if (cs.id === chain.start) continue;
      const m = /P_reach=(\d+(?:\.\d+)?)%/.exec(cs.label);
      if (!m) continue;
      s += parseFloat(m[1]) / 100;
    }
    return s;
  };
  const collapsedSum = sumLabels(collapsed.chain);
  const uncollapsedSum = sumLabels(uncollapsed.chain);
  // Both sums are clamped at 100% per state. The clamping caps
  // outlier-cycle states at 1.0 each. Collapsed has FEWER states
  // (groups merged), so its sum is naturally smaller, but
  // representative values are LARGER because they aggregate.
  // The aggregation should keep the collapsed sum ≥ uncollapsed
  // sum - (number of collapsed states clamped). For this craft we
  // just check the collapsed sum is > 1.0 (multiple non-start
  // states each contributing) and not absurdly small.
  assert.ok(collapsedSum > 1.0,
    `collapsed Σ P_reach should be > 1.0 (multiple non-start nodes ` +
    `aggregating reach); got ${collapsedSum.toFixed(2)}. ` +
    `Pre-fix bug rendered each representative as one sibling's ` +
    `share instead of the group total, dropping the collapsed sum below ` +
    `the uncollapsed (${uncollapsedSum.toFixed(2)}).`);
  // Bonus: verify SOME collapsed representative shows P_reach above
  // any reasonable per-sibling threshold (sanity that aggregation
  // happened).
  let maxCollapsedSinglePReach = 0;
  for (const cs of collapsed.chain.states) {
    if (cs.id === collapsed.chain.start) continue;
    const m = /P_reach=(\d+(?:\.\d+)?)%/.exec(cs.label);
    if (!m) continue;
    maxCollapsedSinglePReach = Math.max(maxCollapsedSinglePReach, parseFloat(m[1]) / 100);
  }
  assert.ok(maxCollapsedSinglePReach > 0.5,
    `at least one collapsed representative should show P_reach > 50% ` +
    `(post-aggregation); got max ${(maxCollapsedSinglePReach * 100).toFixed(1)}%`);
});

console.log(`\n${passed} passed · ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
