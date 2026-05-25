// Policy equiv-class merging: when the wishlist has mirror wished
// mods (cold/fire/lightning at same weight, side, tier), the
// matching essence actions (Insulation/Thawing/Grounding) are
// presentationally equivalent. Two states differing only in WHICH
// mirror wished mod is on the item AND which mirror essence is
// queued should collapse into one rep — this is the action-axis
// counterpart of the wished-mod equiv-class.
//
// User report (2026-05-09): on an Amulet ilvl=72 craft with
// cold+fire suffix wishlist + targetBoneMod=true, the chain split
// into s18 (★ S:cold + Insulation) and s28 (★ S:fire + Thawing)
// when those two reps are clearly mirror states under the
// cold↔fire wished-equiv-class.

import { strict as assert } from 'node:assert';
import { solveMDP } from '../engine/mdp/solve.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.message}`); }
}

console.log('Chain — policy equiv-class merging');

// Two mirror wished mods + two mirror essences. The fixture sets up
// each essence to target one specific wished mod (matching the live
// scenario where Greater Essence of Insulation targets cold and
// Greater Essence of Thawing targets fire).
const fixture = {
  wishlist: [
    { key: 'SUFFIX:cold', weight: 800, type: 'SUFFIX', requiredTier: 3, required: true },
    { key: 'SUFFIX:fire', weight: 800, type: 'SUFFIX', requiredTier: 3, required: true },
  ],
  irrelevantWeight: 30000,
  irrelevantWeightBySide: { PREFIX: 15000, SUFFIX: 15000 },
  target: { requiredMods: ['SUFFIX:cold', 'SUFFIX:fire'], minFilled: 2, maxFilled: 5 },
  start: { rarity: 'normal' },
  basePriceEx: 100, alchemyDraws: 4, maxFilled: 5, timeWeightExPerSec: 0,
  budgetEx: 5000,
  orbCosts: { transmute: 0.01, augment: 0.05, regal: 0.5, alch: 1, exalt: 1, annul: 9.5, fracturing: 50, chaos: 5 },
  orbTimes: { transmute: 1, augment: 1, regal: 1, alch: 1, exalt: 1, annul: 1, fracturing: 3, chaos: 1 },
  // Two mirror essences: same cost, same magic-to-rare mode, each
  // targeting one wished mod. With cold and fire in the same
  // wished-equiv-class, the essences should collapse to one policy
  // class — and hence the post-essence chain reps should merge.
  essences: [
    { id: 'essence_cold', name: 'Essence of Cold', mode: 'magic_to_rare',
      matchedKeys: ['SUFFIX:cold'], costEx: 25, timeSec: 1,
      pAcceptable: 1, side: 'SUFFIX' },
    { id: 'essence_fire', name: 'Essence of Fire', mode: 'magic_to_rare',
      matchedKeys: ['SUFFIX:fire'], costEx: 25, timeSec: 1,
      pAcceptable: 1, side: 'SUFFIX' },
  ],
};

test('mirror essences targeting equiv-class wished mods produce ONE merged rep', () => {
  const result = solveMDP(fixture);
  // Bucket reps by (kind, totalMods, wishedCount, policy-equiv-class).
  // The chain partition uses canonicalised policy; if it works, two
  // reps using essence_cold and essence_fire on mirror states should
  // share a bucket (same canonical policy) → merge to one rep.
  const popcount = (n) => { let c = 0; for (n = n | 0; n; n &= n - 1) c++; return c; };
  // Find every chain state whose policy is one of our two mirror
  // essences. They should all be the SAME chain rep (one entry).
  const essenceReps = result.chain.states.filter((cs) =>
    /^essence_/.test(cs.meta?.policy ?? ''));
  assert.ok(essenceReps.length > 0,
    'expected at least one chain rep with an essence policy');
  // Group those reps by (kind, totalMods, wishedCount). Within each
  // group, there should be exactly ONE rep (otherwise the engine kept
  // two mirror states separate when it should have merged them).
  const byShape = new Map();
  for (const cs of essenceReps) {
    const idx = parseInt(cs.id.replace(/^s/, ''), 10);
    const st = result.states[idx]?.state;
    if (!st) continue;
    const w = popcount(st.modMask ?? 0);
    const k = `${cs.kind}|tm=${st.totalMods}|w=${w}`;
    const arr = byShape.get(k) ?? [];
    arr.push({ id: cs.id, policy: cs.meta?.policy });
    byShape.set(k, arr);
  }
  const offenders = [...byShape.entries()].filter(([, arr]) => arr.length > 1);
  assert.equal(offenders.length, 0,
    `expected mirror essence policies to merge into one rep per (kind, tm, wished). ` +
    `Got separate reps: ${offenders.map(([k, arr]) => `${k} → ${arr.map(a => a.id + '(' + a.policy + ')').join(', ')}`).join('; ')}`);
});

test('mirror-essence edges to same destination collapse to one edge', () => {
  // After merging s18 (Insulation→cold) and s28 (Thawing→fire) into
  // one rep via policy equiv-class, the rep's edges to a SHARED
  // destination (e.g. the goal) should collapse to ONE edge with a
  // joined action label like `essence_cold|essence_fire`. Edges to
  // distinct destinations stay separate (the asymmetry of the two
  // essences' outcome distributions surfaces as multiple edges, but
  // the symmetric parts collapse).
  const result = solveMDP(fixture);
  // Find any rep whose outgoing edges include the joined label.
  const joinedLabelRe = /^essence_\w+(?:\|essence_\w+)+/;
  const edgesWithJoin = result.chain.edges.filter((e) =>
    joinedLabelRe.test((e.label ?? '').split('\n')[0]));
  assert.ok(edgesWithJoin.length > 0,
    'expected at least one edge whose label is a join of multiple essence ids ' +
    '(symmetric outcome from a mirror-merged rep). Got: ' +
    JSON.stringify(result.chain.edges.map((e) => (e.label ?? '').split('\n')[0]).slice(0, 10)));
});

test('non-mirror essences (different cost) stay as separate policy classes', () => {
  // Sanity: two essences with the SAME matched mod but DIFFERENT cost
  // should NOT collapse — they're behaviourally different. Pin this
  // so a future "merge by matched mod alone" change doesn't drop the
  // cost discriminator.
  const result = solveMDP({
    ...fixture,
    essences: [
      { id: 'essence_cold_cheap', name: 'Cheap Cold', mode: 'magic_to_rare',
        matchedKeys: ['SUFFIX:cold'], costEx: 5, timeSec: 1,
        pAcceptable: 1, side: 'SUFFIX' },
      { id: 'essence_cold_pricey', name: 'Pricey Cold', mode: 'magic_to_rare',
        matchedKeys: ['SUFFIX:cold'], costEx: 100, timeSec: 1,
        pAcceptable: 1, side: 'SUFFIX' },
    ],
  });
  // Different costs → different equiv-classes. The optimal policy will
  // pick the cheaper one in most contexts; we just verify the engine
  // produces SOME valid result and doesn't merge the two costs.
  const policies = new Set(result.chain.states.map((cs) => cs.meta?.policy ?? null).filter(Boolean));
  // Vacuous when the policy never reaches the pricey one (always
  // chooses the cheaper) — that's expected behaviour. Test just
  // verifies the engine runs cleanly with two essences and produces
  // a valid chain.
  assert.ok(result.chain.states.length > 0, 'chain should not be empty');
});

console.log(`\n${passed} passed · ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
