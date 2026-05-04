// Exalt + Annul cycle strategy (and its Greater / Perfect variants).
//
// State = (subsetMask, t) where subsetMask is a bitmask of which wishlist
// entries are currently on the item, and t is the total mod count.
// Constraints: popcount(mask) ≤ t ≤ maxFilled.
//
// Action determined by t:
//   - t < maxFilled: EXALT (adds one random mod from pool excluding mods on
//     item; t → t+1).
//   - t = maxFilled: ANNUL (removes one random mod uniformly; t → t-1).
//
// Goal: every required-entry bit set AND popcount(mask) ≥ requiredHits.
//
// Greater / Perfect Exalt are coarse approximations: each wished weight
// is scaled by `qBoost` (Greater = 1.6, Perfect = 2.8). Real variants
// integrate over per-tier weights — punted until tier-aware analytics.
//
// Bricked / near-trap detection + V* / H* annotations are factored into
// `markov-analysis.js` and shared with chaos-spam. Time-weighted unified
// cost (1 ex = 1 / timeWeightExPerSec sec) flows from ctx into the V*
// solve so the near-trap threshold mixes wall-clock with currency cost.

import { transitionMatrix, expectedHittingTime, solveLinear } from '../evaluator.js';
import { orbCostEx } from '../strategy-utils.js';
import {
  analyzeAbsorbingMC, makeCollapsedAccumulator, appendCollapsedSinks,
  annotateLabelFn,
} from './markov-analysis.js';

const popcount = (n) => {
  let c = 0;
  while (n) { c += n & 1; n >>>= 1; }
  return c;
};

export function makeExaltAnnulCycle({ id, label, exaltOrbId, qBoost, variantNote }) {
  return function (ctx) {
    const required = ctx.requiredHits;
    const maxFilled = ctx.maxFilled;
    const N = ctx.wishlist.length;

    if (required > maxFilled) {
      return { id, label, available: false, notes: `requiredHits (${required}) exceeds maxFilled (${maxFilled})` };
    }
    if (N > 8) {
      return {
        id, label, available: false,
        notes: `wishlist of ${N} entries exceeds the bitmask limit (8). Reduce wishlist size for exact same-mod-exclusion analytics.`,
      };
    }

    const wkeys   = ctx.wishlist.map((w) => w.key);
    const wIsReq  = ctx.wishlist.map((w) => !!w.required);
    const cp      = ctx.conditionalPool;
    const wWeight = wkeys.map((k) => cp.find((m) => m.key === k)?.weight ?? 0);
    const totalW  = cp.reduce((s, m) => s + (m.weight ?? 0), 0);
    const wishedW = wWeight.reduce((s, x) => s + x, 0);
    const irrelevantW = Math.max(0, totalW - wishedW);
    const reqMask = wIsReq.reduce((m, isReq, i) => isReq ? (m | (1 << i)) : m, 0);
    const R = wIsReq.filter(Boolean).length;

    const boost = qBoost ?? 1;
    const wWeightBoosted = wWeight.map((w) => w * boost);
    const wishedWBoosted = wWeightBoosted.reduce((s, x) => s + x, 0);
    const totalWBoosted = wishedWBoosted + irrelevantW;

    const startR = Math.min(ctx.startingR ?? 0, R);
    const startWS = Math.min(ctx.startingWSoft ?? 0, N - R);
    const startT = ctx.startingCounts.prefixes + ctx.startingCounts.suffixes;

    let startMask = 0;
    let placedR = 0, placedW = 0;
    for (let i = 0; i < N && (placedR < startR || placedW < startWS); i++) {
      if (wIsReq[i] && placedR < startR) { startMask |= (1 << i); placedR++; }
      else if (!wIsReq[i] && placedW < startWS) { startMask |= (1 << i); placedW++; }
    }

    const goalCheck = (s) => ((s.mask & reqMask) === reqMask) && (popcount(s.mask) >= required);
    const startState = { mask: startMask, t: startT };
    if (goalCheck(startState)) {
      return {
        id, label, available: true,
        p: 1, expectedAttempts: 0, expectedCostEx: 0, expectedTimeSec: 0,
        notes: 'starting item already satisfies requirement',
      };
    }

    const exaltCost = orbCostEx(exaltOrbId, ctx);
    const annulCost = orbCostEx('annulment', ctx);
    const missing = [];
    if (!Number.isFinite(exaltCost)) missing.push(exaltOrbId);
    if (!Number.isFinite(annulCost)) missing.push('annulment');
    if (missing.length) return { id, label, available: false, notes: `missing rate(s): ${missing.join(', ')}` };
    if (wishedWBoosted <= 0) {
      return { id, label, available: false, notes: 'no wished mass in eligible pool' };
    }

    // State space + transitions.
    const states = [];
    const idxOf = new Map();
    const stateKey = (mask, t) => `${mask}:${t}`;
    const enqueue = (mask, t) => {
      if (popcount(mask) > t) return -1;
      if (t > maxFilled) return -1;
      const key = stateKey(mask, t);
      let id2 = idxOf.get(key);
      if (id2 === undefined) {
        id2 = states.length;
        idxOf.set(key, id2);
        states.push({ mask, t });
      }
      return id2;
    };
    enqueue(startMask, startT);

    const onItemWeight = (mask) => {
      let s = 0;
      for (let i = 0; i < N; i++) if (mask & (1 << i)) s += wWeightBoosted[i];
      return s;
    };
    const transitionsFor = (mask, t) => {
      const out = new Map();
      const accumulate = (nextMask, nextT, prob) => {
        if (prob <= 0) return;
        const idx = enqueue(nextMask, nextT);
        if (idx < 0) return;
        out.set(idx, (out.get(idx) ?? 0) + prob);
      };
      if (t < maxFilled) {
        const pool = totalWBoosted - onItemWeight(mask);
        if (pool > 0) {
          for (let i = 0; i < N; i++) {
            if (mask & (1 << i)) continue;
            const p = wWeightBoosted[i] / pool;
            if (p > 0) accumulate(mask | (1 << i), t + 1, p);
          }
          if (irrelevantW > 0) accumulate(mask, t + 1, irrelevantW / pool);
        }
      } else {
        const irrCount = t - popcount(mask);
        if (t > 0) {
          for (let i = 0; i < N; i++) {
            if (!(mask & (1 << i))) continue;
            accumulate(mask & ~(1 << i), t - 1, 1 / t);
          }
          if (irrCount > 0) accumulate(mask, t - 1, irrCount / t);
        }
      }
      // Normalize transition shape to `{ to, weight }` so the shared
      // analysis helper consumes both strategies uniformly.
      return [...out].map(([to, weight]) => ({ to, weight }));
    };

    const expanded = [];
    while (expanded.length < states.length) {
      const i = expanded.length;
      const { mask, t } = states[i];
      const sObj = states[i];
      if (goalCheck(sObj)) {
        expanded.push([{ to: i, weight: 1 }]);
      } else {
        expanded.push(transitionsFor(mask, t));
      }
    }
    const startStateIdx = idxOf.get(stateKey(startMask, startT));

    // Per-step ex cost + wall-clock seconds — used by the shared analysis
    // helper to compute V* (unified) including time weighting.
    const tEx  = ctx.orbs[exaltOrbId]?.timeSeconds ?? 2;
    const tAnn = ctx.orbs.annulment?.timeSeconds  ?? 2;
    const perStepCostEx  = (i) => states[i].t < maxFilled ? exaltCost : annulCost;
    const perStepTimeSec = (i) => states[i].t < maxFilled ? tEx       : tAnn;
    const timeWeightExPerSec = Number.isFinite(ctx.timeWeightExPerSec)
      ? ctx.timeWeightExPerSec : 0;

    // Reset cost: when the user restarts they pay basePrice + procurement
    // time — both folded into the unified cost via the same weight.
    const restartCostEx  = Number.isFinite(ctx.basePriceEx) ? ctx.basePriceEx : NaN;
    const restartTimeSec = 0;

    const analysis = analyzeAbsorbingMC({
      states, expanded, goalCheck, startStateIdx,
      perStepCostEx, perStepTimeSec, timeWeightExPerSec,
      restartCostEx, restartTimeSec,
    });
    const {
      isBricked, isNearTrap, isCollapsed,
      vPerState, hPerState, vCostPerState,
      brickedCluster, nearTrapCluster,
      nearTrapCutoff,
    } = analysis;

    if (vCostPerState.size === 0) {
      return { id, label, available: false, notes: 'Markov system singular' };
    }
    const expectedCostEx = vCostPerState.get(startStateIdx) ?? NaN;
    const expectedAttempts = hPerState.get(startStateIdx) ?? NaN;
    const expectedTimeSec = expectedAttempts * ((tEx + tAnn) / 2);

    // ----- Chain emission (per-cluster sinks + V*/H* annotations).
    const exaltAction = exaltOrbId === 'exaltedPerfect' ? '✯ Perfect Exalt'
                      : exaltOrbId === 'exaltedGreater' ? '✧ Greater Exalt'
                      : '✦ Exalt';
    const annulAction = '✂ Annul';
    const shortName = (key) => {
      const [side, rest] = key.split(/:(.+)/);
      const tag = side === 'PREFIX' ? 'P' : side === 'SUFFIX' ? 'S' : '';
      const trim = (rest ?? '').replace(/[#%,]/g, '').replace(/\s+/g, ' ').trim();
      return `${tag}:${trim.slice(0, 24)}`;
    };
    const stateLabel = (mask, t) => {
      const onBits = [];
      for (let i = 0; i < N; i++) if (mask & (1 << i)) onBits.push(i);
      const irr = t - onBits.length;
      const lines = [];
      for (const i of onBits) {
        const tag = wIsReq[i] ? '★' : '·';
        lines.push(`${tag} ${shortName(wkeys[i])}`);
      }
      if (irr > 0) lines.push(`+ ${irr} irrelevant`);
      if (!lines.length) lines.push('(empty)');
      return lines.join('\n');
    };
    const annotateLabel = annotateLabelFn(hPerState, vPerState);

    const chainStates = [];
    const chainEdges = [];
    chainStates.push({
      id: 'base',
      label: `Starting Rare\n${stateLabel(startMask, startT)}`,
      kind: 'start',
    });
    chainEdges.push({ from: 'base', to: `s${startStateIdx}`, label: 'starting state', kind: 'orb' });
    states.forEach((s, i) => {
      if (isCollapsed(i)) return;
      const isGoal = goalCheck(s);
      const baseLabel = isGoal ? `${stateLabel(s.mask, s.t)}\n✓` : stateLabel(s.mask, s.t);
      chainStates.push({
        id: `s${i}`,
        label: annotateLabel(i, baseLabel),
        kind: isGoal ? 'goal' : 'transient',
        meta: {
          mask: s.mask, t: s.t,
          action: s.t < maxFilled ? 'exalt' : 'annul',
          hStar: hPerState.get(i) ?? null,
          vStar: vPerState.get(i) ?? null,
        },
      });
    });
    const fmtP = (p) => p < 0.001 ? p.toExponential(1) : p.toFixed(3);
    const score = (mask) => {
      let r = 0, w = 0;
      for (let k = 0; k < N; k++) if (mask & (1 << k)) (wIsReq[k] ? r++ : w++);
      return r * 100 + (r + w);
    };
    const sinkAcc = makeCollapsedAccumulator({
      isBricked, isNearTrap, brickedCluster, nearTrapCluster,
    });
    states.forEach((s, i) => {
      if (isCollapsed(i)) return;
      if (goalCheck(s)) return;
      const action = s.t < maxFilled ? exaltAction : annulAction;
      for (const tr of expanded[i]) {
        const j = tr.to;
        if (sinkAcc.accumulate(i, j, tr.weight)) continue;
        const target = states[j];
        const noOp = i === j ? ' (no-op)' : '';
        const reachGoal = goalCheck(target);
        const ds = score(target.mask) - score(s.mask);
        let kind = 'internal';
        if (reachGoal)    kind = 'success';
        else if (ds > 0)  kind = 'improving';
        else if (ds < 0)  kind = 'fail';
        chainEdges.push({
          from: `s${i}`, to: `s${j}`,
          label: `${action}\np=${fmtP(tr.weight)}${noOp}`,
          kind,
        });
      }
    });
    appendCollapsedSinks({
      chainStates, chainEdges,
      bricked: sinkAcc.bricked,
      nearTrap: sinkAcc.nearTrap,
      nearTrapCutoff,
    });

    const baselinePool = totalWBoosted - onItemWeight(startMask);
    const wishlistInfo = ctx.wishlist.map((wEntry, i) => ({
      name: wEntry.key,
      type: wEntry.type,
      required: !!wEntry.required,
      tier: wEntry.minTier,
      weight: wWeight[i],
      perOrbProb: baselinePool > 0 && !(startMask & (1 << i))
        ? wWeightBoosted[i] / baselinePool : 0,
    }));
    const requiredWeight = wWeight.reduce((s, w, i) => s + (wIsReq[i] ? w : 0), 0);

    const chain = {
      states: chainStates,
      edges: chainEdges,
      start: 'base',
      goals: chainStates.filter((s) => s.kind === 'goal').map((s) => s.id),
      glossary: [
        { sym: 'r', desc: `required mods on item (R = ${R} required entries)` },
        { sym: 'w', desc: `soft-wished mods on item (Wmax = ${N - R} non-required entries)` },
        { sym: 'i', desc: 'irrelevant mods on item (i = t − r − w)' },
        { sym: 't', desc: `total mods on item (cap = maxFilled = ${maxFilled})` },
        { sym: 'goal', desc: `every required entry on item AND total wishlist count ≥ ${required}` },
        { sym: 'state', desc: `bitmask over the ${N} wishlist entries (× t) — same-mod exclusion is tracked exactly per state` },
        { sym: `${exaltAction}`, desc: `applied while t < ${maxFilled}: adds 1 random mod from pool excluding mods on item, t→t+1` },
        { sym: 'Annul', desc: `applied while t = ${maxFilled}: removes 1 random mod uniformly, t→t−1` },
        { sym: 'V*', desc: `expected unified cost-to-goal (ex + ${timeWeightExPerSec} ex/sec × wall-clock)` },
        { sym: 'p_add baseline', desc: `from start state: irrelevant ${(irrelevantW / Math.max(1, baselinePool) * 100).toFixed(2)}%, wished ${((wishedWBoosted - onItemWeight(startMask)) / Math.max(1, baselinePool) * 100).toFixed(2)}%` },
      ],
      wishlistInfo,
      poolStats: {
        totalWeight: totalW,
        wishedWeight: wishedW,
        requiredWeight,
      },
    };

    return {
      id, label, available: true,
      p: expectedAttempts > 0 ? 1 / expectedAttempts : 0,
      expectedAttempts,
      expectedCostEx,
      expectedTimeSec,
      notes: `bitmask Markov over ${N} wished entries × t (${states.length} reachable states); ${exaltOrbId} when t<${maxFilled}, annul when t=${maxFilled}; same-mod exclusion tracked exactly${variantNote ? '; ' + variantNote : ''}`,
      description:
        `Cycle: while the item has fewer than ${maxFilled} mods, apply ` +
        `${ctx.orbs[exaltOrbId]?.name ?? exaltOrbId} (adds one random mod from ` +
        `the pool excluding mods already on the item — so a wished mod that ` +
        `landed earlier is correctly excluded from later draws, ` +
        (qBoost > 1 ? `with ~${qBoost.toFixed(1)}× tier-bias scaling on wished weights` : 'uniform tier distribution') +
        `). When the item is full, apply Orb of Annulment to free a slot, ` +
        `then keep exalting. State is a bitmask over the ${N} wishlist ` +
        `entries × the current total mod count, so per-state add ` +
        `probabilities reflect which specific wished mods are excluded. ` +
        `Bricked + near-trap subgraphs are collapsed into per-cluster sinks; ` +
        `the near-trap threshold uses unified V* (ex + time-weighted).`,
      chain,
    };
  };
}

export const exaltAnnulCycle = makeExaltAnnulCycle({
  id: 'exalt-annul-cycle',
  label: 'Exalt + Annul cycle (baseline)',
  exaltOrbId: 'exalted',
  qBoost: 1.0,
});

export const greaterExaltAnnulCycle = makeExaltAnnulCycle({
  id: 'greater-exalt-annul-cycle',
  label: 'Greater Exalt + Annul cycle',
  exaltOrbId: 'exaltedGreater',
  qBoost: 1.6,
  variantNote: 'top-3-tiers bias (~1.6× wished rate, approximate)',
});

export const perfectExaltAnnulCycle = makeExaltAnnulCycle({
  id: 'perfect-exalt-annul-cycle',
  label: 'Perfect Exalt + Annul cycle',
  exaltOrbId: 'exaltedPerfect',
  qBoost: 2.8,
  variantNote: 'top-2-tiers bias (~2.8× wished rate, approximate)',
});
