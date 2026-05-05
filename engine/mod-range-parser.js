// Mod-range parser — extracts numeric (min, max) pairs from PoE2's
// display strings such as "+(30—39) to maximum Life" or
// "(15—22)% increased Movement Speed". The Krakenbul / poe2db data
// stores tier value-ranges as text strings, so we need a parser to
// pipe them into the Divine Bench (which works on numeric ranges).
//
// Patterns covered:
//   "+(30—39) to maximum Life"          → { vmin: 30, vmax: 39 }
//   "(15—22)% increased Movement Speed" → { vmin: 15, vmax: 22 }
//   "Adds (5—8) to (12—16) Fire Damage" → { vmin: 5, vmax: 16 }   (span)
//   "+5 to maximum Life"                → { vmin: 5, vmax: 5 }    (single)
//   "(0.5—1.5)% chance to ..."          → { vmin: 0.5, vmax: 1.5 }
//
// PoE2 uses the EM-DASH (—, U+2014) by convention; we also accept
// the regular hyphen (-) for hand-typed strings. Returns null when
// no numeric range can be extracted.

const RANGE_RE = /\(?\s*([+-]?\d+(?:\.\d+)?)\s*[—-]\s*([+-]?\d+(?:\.\d+)?)\s*\)?/g;
const SINGLE_RE = /[+-]?\d+(?:\.\d+)?/;

/**
 * Parse the first numeric range (or single value) found in `text`.
 * For mods carrying multiple ranges (e.g. "Adds X to Y damage"),
 * return the span from the lowest min to the highest max — that's
 * the right reading for "what value can this mod take overall."
 */
export function parseModRange(text) {
  if (typeof text !== 'string' || !text) return null;
  const ranges = [];
  let m;
  // Reset regex state (`g` flag persists).
  RANGE_RE.lastIndex = 0;
  while ((m = RANGE_RE.exec(text)) !== null) {
    const a = parseFloat(m[1]);
    const b = parseFloat(m[2]);
    if (Number.isFinite(a) && Number.isFinite(b)) {
      ranges.push([Math.min(a, b), Math.max(a, b)]);
    }
  }
  if (ranges.length === 0) {
    // Fallback: single number with no range.
    const sm = text.match(SINGLE_RE);
    if (sm) {
      const v = parseFloat(sm[0]);
      if (Number.isFinite(v)) return { vmin: v, vmax: v };
    }
    return null;
  }
  // Multi-range: span from lowest min to highest max.
  const lo = Math.min(...ranges.map((r) => r[0]));
  const hi = Math.max(...ranges.map((r) => r[1]));
  return { vmin: lo, vmax: hi };
}

/**
 * Pick a uniform-random concrete value within a parsed range.
 * Pure helper for the trajectory-sampler concrete-item builder.
 */
export function rollValue({ vmin, vmax }, rng = Math.random) {
  if (!Number.isFinite(vmin) || !Number.isFinite(vmax)) return null;
  if (vmin === vmax) return vmin;
  // Round to integer if both endpoints are integers (typical PoE2
  // case). Otherwise return the float.
  const v = vmin + (vmax - vmin) * rng();
  if (Number.isInteger(vmin) && Number.isInteger(vmax)) return Math.round(v);
  return Math.round(v * 100) / 100; // 2dp
}
