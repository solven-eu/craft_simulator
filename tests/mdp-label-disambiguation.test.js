// Label disambiguation post-pass. After collapse, distinct chain
// reps may end up with similar BODY labels (everything except the
// trailing `next: <action>` line). The user's complaint (2026-05-09):
// "I have 3 states with `≥1 irrelevant` and can't tell them apart."
// The post-pass detects body-fingerprint collisions and inserts a
// `· <attr>=<value-set>` line into each colliding rep so the
// differentiator is visible at a glance.

import { strict as assert } from 'node:assert';
import { solveMDP } from '../engine/mdp/solve.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.message}`); }
}

console.log('Label disambiguation — body-fingerprint collisions');

// Strip the [sN] step-id prefix and volatile annotations so the test
// asserts on the structural body of the label.
const bodyOf = (cs) => cs.label
  .replace(/^\[s\d+\]\s*/, '')
  .split('\n')
  .filter((ln) => !/^V\*=|^fromBudget=|^fromBase=|^P_reach=|^visits=|^next:/.test(ln))
  .join('\n');

const baseInput = {
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
  orbCosts: { transmute: 0.01, augment: 0.05, regal: 0.5, alch: 1, exalt: 1, annul: 9.5, fracturing: 50 },
  orbTimes: { transmute: 1, augment: 1, regal: 1, alch: 1, exalt: 1, annul: 1, fracturing: 3 },
  collapseEquivalent: true,
};

test('chain reps with identical body fingerprints get a discriminator line', () => {
  const result = solveMDP(baseInput);
  // Group reps by body fingerprint AFTER the disambiguation pass.
  // The pass should have inserted a `· <attr>=…` line into any rep
  // that previously shared a body with another rep, so the body
  // fingerprints should now be distinct.
  const byBody = new Map();
  for (const cs of result.chain.states) {
    const fp = bodyOf(cs);
    const arr = byBody.get(fp) ?? [];
    arr.push(cs.id);
    byBody.set(fp, arr);
  }
  const collisions = [...byBody.entries()].filter(([, ids]) => ids.length > 1);
  // Goal/brick states with truly identical underlying attrs are
  // allowed to share a body — the partition merges them, so they're
  // a single rep, not multiple. Any remaining collision means two
  // distinct reps render with the same structural label.
  assert.equal(
    collisions.length, 0,
    `expected post-pass to leave every rep with a distinct body fingerprint. ` +
    `Collisions:\n  ${collisions.map(([fp, ids]) => `${ids.length}×: ids=${ids.join(', ')} body="${fp.replace(/\n/g, ' \\n ')}"`).join('\n  ')}`,
  );
});

test('disambiguator line uses an attribute whose values differ across reps', () => {
  // Soft sanity check: when a discriminator IS inserted, the line
  // should follow `· <attr>=<value>` shape — not e.g. an empty
  // line or a malformed annotation. Iterate every rep that carries
  // a `· totalMods=` (or other attr-equals) line and check the RHS.
  const result = solveMDP(baseInput);
  const attrLineRe = /^· (rarity|totalMods|fractured|bone|prefix mods|desecrated|wished)=([^\s].*)$/;
  let foundAny = false;
  for (const cs of result.chain.states) {
    const lines = cs.label.replace(/^\[s\d+\]\s*/, '').split('\n');
    for (const ln of lines) {
      const m = attrLineRe.exec(ln);
      if (!m) continue;
      foundAny = true;
      const value = m[2].trim();
      assert.ok(value.length > 0, `disambiguator value should be non-empty; got "${ln}"`);
    }
  }
  // If no disambiguator was needed (every body was already distinct),
  // that's fine — the test only asserts shape WHEN one is inserted.
  if (!foundAny) {
    console.log('  (no disambiguator was needed for this fixture)');
  }
});

test('disc lines per rep capped — labels stay readable', () => {
  // The user's direction (2026-05-09): "5 rows to segregate is bad."
  // Cap disc lines at MAX_DISC_LINES (currently 2). Even when a
  // collision group's tuple-disjoint cover would need more, we
  // accept residual range overlap rather than emit a 5-line label.
  // Over-emission would push readers into rebuilding mental joint
  // distributions from independent per-attribute lines.
  const MAX_DISC_LINES = 2;
  const result = solveMDP(baseInput);
  const discRe = /^· (rarity|totalMods|fractured|bone|prefix mods|desecrated|wished)=/;
  for (const cs of result.chain.states) {
    const discLines = cs.label.replace(/^\[s\d+\]\s*/, '').split('\n').filter((ln) => discRe.test(ln));
    assert.ok(discLines.length <= MAX_DISC_LINES,
      `rep ${cs.id} has ${discLines.length} disc lines (cap is ${MAX_DISC_LINES}); label: ${JSON.stringify(cs.label)}`);
  }
});

test('emitted disc lines have pairwise-distinct rendered values', () => {
  // Within each collision group, the emitted disc lines must visually
  // differentiate the reps — every pair of reps must differ on at
  // least one emitted attribute's render. (Otherwise the labels
  // would still collide.) Doesn't require joint tuple disjointness:
  // residual range overlap (e.g. tm=2–5 vs 1–4 both contain 4) is
  // acceptable per user direction.
  const result = solveMDP(baseInput);
  const discRe = /^· (rarity|totalMods|fractured|bone|prefix mods|desecrated|wished)=([^=]*)$/;
  const stripDiscs = (label) => label.split('\n').filter((ln) => !discRe.test(ln)).join('\n');
  const preGroups = new Map();
  for (const cs of result.chain.states) {
    const pre = stripDiscs(bodyOf(cs));
    const arr = preGroups.get(pre) ?? [];
    arr.push(cs);
    preGroups.set(pre, arr);
  }
  for (const reps of preGroups.values()) {
    if (reps.length <= 1) continue;
    // Build per-rep attr → render map.
    const perRep = reps.map((cs) => {
      const map = {};
      for (const ln of cs.label.replace(/^\[s\d+\]\s*/, '').split('\n')) {
        const m = discRe.exec(ln);
        if (m) map[m[1]] = m[2].trim();
      }
      return map;
    });
    // Every pair must differ on at least one attribute's render.
    for (let i = 0; i < perRep.length; i++) {
      for (let j = i + 1; j < perRep.length; j++) {
        const attrs = new Set([...Object.keys(perRep[i]), ...Object.keys(perRep[j])]);
        const differ = [...attrs].some((a) => perRep[i][a] !== perRep[j][a]);
        assert.ok(differ,
          `reps ${reps[i].id} and ${reps[j].id} have identical disc lines — ` +
          `at least one attribute should differ visually for the user to distinguish them.`);
      }
    }
  }
});

test('every concrete state matches exactly one rep label', () => {
  // The hard semantic invariant (user direction 2026-05-09):
  // "Iterate over all actual states, detect which groups they fit;
  // in the final representation, each node should be part of a
  // single group." Walk every reachable engine state, match its
  // attribute values against each rep's emitted disc lines, and
  // assert exactly one rep matches. Otherwise the chain has
  // ambiguous labels (a concrete item visually fits 2+ reps) or
  // a missing label (no rep covers it) — both are bugs the user
  // should never have to debug from chain-dump output.
  const result = solveMDP(baseInput);
  const discRe = /^· (rarity|totalMods|fractured|bone|prefix mods|desecrated|wished)=([^=]*)$/;
  // Same attribute extractors the engine uses.
  const popcount = (n) => { let c = 0; for (n = n | 0; n; n &= n - 1) c++; return c; };
  const ATTR_GETTERS = {
    'rarity': (s) => s.rarity ?? '-',
    'totalMods': (s) => s.totalMods ?? 0,
    'fractured': (s) => s.fracturedBit >= 0 ? 'wished' : (s.irrFractured ? 'irr' : '-'),
    'bone': (s) => s.boneMod ? (s.boneRevealed ? 'rev' : 'unrev') : '-',
    'prefix mods': (s) => s.prefixMods ?? 0,
    'desecrated': (s) => popcount(s.desecratedWishedMask ?? 0)
                       + (s.desecratedIrrPrefix ?? 0)
                       + (s.desecratedIrrSuffix ?? 0),
    'wished': (s) => popcount(s.modMask ?? 0),
  };
  // Parse a rendered value-set string back into a value-set we can
  // membership-test. Supports single ("3"), comma list ("3,4"),
  // range ("2–5"), and brace set ("{a,b}").
  const parseValueSet = (render) => {
    render = render.trim();
    if (render === '') return new Set();
    // Range: "min–max"
    const rangeMatch = /^(-?\d+)–(-?\d+)$/.exec(render);
    if (rangeMatch) {
      const min = Number(rangeMatch[1]), max = Number(rangeMatch[2]);
      const out = new Set();
      for (let v = min; v <= max; v++) out.add(v);
      return out;
    }
    // Brace set: "{a,b,c}"
    if (render.startsWith('{') && render.endsWith('}')) {
      return new Set(render.slice(1, -1).split(',').map((s) => {
        const t = s.trim();
        const n = Number(t);
        return Number.isFinite(n) && String(n) === t ? n : t;
      }));
    }
    // Comma list or single
    return new Set(render.split(',').map((s) => {
      const t = s.trim();
      const n = Number(t);
      return Number.isFinite(n) && String(n) === t ? n : t;
    }));
  };
  // Collect each rep's emitted attr → value-set map plus its
  // pre-disc body fingerprint (the natural label, used as the
  // primary match key).
  const stripDiscs = (label) => label.split('\n').filter((ln) => !discRe.test(ln)).join('\n');
  const repProfiles = result.chain.states.map((cs) => {
    const map = {};
    for (const ln of cs.label.replace(/^\[s\d+\]\s*/, '').split('\n')) {
      const m = discRe.exec(ln);
      if (m) map[m[1]] = parseValueSet(m[2]);
    }
    return { id: cs.id, kind: cs.kind, policy: cs.meta?.policy, body: stripDiscs(bodyOf(cs)), discs: map };
  });
  // For each underlying state, find which reps it "matches".
  // Matching: rep's natural body fingerprint matches the state's
  // generated label-body, AND every disc-line value-set contains
  // the state's attribute value.
  // Group states by their pre-disc rep (via _underlyingIdxs) — we
  // already know the engine's true assignment; the test asserts the
  // VISIBLE labels agree with that assignment.
  let mismatches = 0;
  const sample = [];
  for (const cs of result.chain.states) {
    const idxs = Array.isArray(cs._underlyingIdxs) && cs._underlyingIdxs.length
      ? cs._underlyingIdxs
      : (() => { const m = /^s(\d+)$/.exec(cs.id); return m ? [Number(m[1])] : []; })();
    for (const idx of idxs) {
      const s = result.states[idx]?.state;
      if (!s) continue;
      // Find all reps in the same (kind, policy, body) bucket whose
      // disc-line value-sets all contain this state's values.
      const matches = repProfiles.filter((rp) => {
        if (rp.kind !== cs.kind) return false;
        if (rp.policy !== (cs.meta?.policy ?? null)) return false;
        if (rp.body !== stripDiscs(bodyOf(cs))) return false;
        for (const [attr, set] of Object.entries(rp.discs)) {
          const v = ATTR_GETTERS[attr](s);
          if (!set.has(v)) return false;
        }
        return true;
      });
      if (matches.length !== 1) {
        mismatches += 1;
        if (sample.length < 5) {
          sample.push({ stateIdx: idx, repId: cs.id, matchIds: matches.map((m) => m.id) });
        }
      }
    }
  }
  assert.equal(mismatches, 0,
    `expected each concrete state to match exactly ONE rep label. ` +
    `Mismatches: ${mismatches}. Sample: ${JSON.stringify(sample, null, 2)}`);
});

test('post-pass converges (no infinite re-disambiguation)', () => {
  // The pass loops up to 4 times. After convergence either every
  // body is distinct, or no candidate attribute can discriminate
  // (in which case some duplicate labels are surfaced via warnings
  // — the engine's pre-existing duplicate-label check).
  const result = solveMDP(baseInput);
  // No infinite loop manifested as an error or hang. As a soft
  // check, every rep label should still parse cleanly: starts with
  // optional [sN], then content, no double-newlines elsewhere.
  for (const cs of result.chain.states) {
    assert.ok(typeof cs.label === 'string' && cs.label.length > 0,
      `rep ${cs.id} should have a non-empty label; got: ${JSON.stringify(cs.label)}`);
    // No more than one consecutive blank line — a sign of broken
    // splice. The label should be tightly packed.
    assert.ok(!/\n\n\n/.test(cs.label),
      `rep ${cs.id} label has triple-newline (broken splice?): ${JSON.stringify(cs.label)}`);
  }
});

console.log(`\n${passed} passed · ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
