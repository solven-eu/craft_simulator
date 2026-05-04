// Recipe DSL — human-friendly syntax for declaring a desired item.
//
// Round-trip target: a single string carries enough state to
// reconstruct the wishlist + target-shape inputs the engine needs.
// Designed to be paste-able into chat or a forum post and re-imported
// into the UI without manual mapping.
//
// Format:
//
//   # Comments start with `#` and run to end-of-line.
//
//   # Header lines: `key: value`. Recognised keys:
//   type: Bow                          # item type (display name)
//   base: BOW                          # canonical base id (matches games/poe2 catalog)
//   ilvl: 84                           # item level (0..86)
//   budget_ex: 50000                   # total budget cap in exalted
//   filled: 1..6                       # min..max acceptable affix count on final item
//   required_hits: 1                   # min number of wished mods needed
//   time_weight_ex_per_sec: 0.1        # unifies time and currency
//
//   # Affix lines, one per wished/required modifier:
//   #   <P|S> [Tn+] "<mod name>" [flags]
//   # where:
//   #   P|S  side (Prefix / Suffix)
//   #   Tn+  minimum acceptable tier (lower n = better in PoE2). Optional.
//   #   "name" canonical mod-name string (matches mods.json `name` field).
//   #   flags space-separated subset of:
//   #     req     this affix is REQUIRED on the final item
//   #     frac    this affix should be FRACTURED on the final item
//
//   # Example:
//   S T1+ "#% Surpassing chance to fire an additional Arrow" req frac
//   P T3+ "# to maximum Life"
//
// Parser is lenient (extra whitespace OK, header keys case-insensitive,
// comments on header lines stripped). Serializer emits a canonical
// form so round-trips converge.

/**
 * Serialize a UI state snapshot into the recipe DSL.
 *
 * @param {object} state — the subset of `craft` store state needed to
 *   reconstruct the wishlist:
 *     { itemType, base, itemLevel, totalBudgetEx, minFilled,
 *       maxFilled, requiredHits, timeWeightExPerSec, targetEntries: [...] }
 * @returns {string}
 */
export function serializeRecipe(state) {
  const lines = ['# PoE2 Crafter recipe'];
  if (state.itemType)              lines.push(`type: ${state.itemType}`);
  if (state.base)                  lines.push(`base: ${state.base}`);
  if (Number.isFinite(state.itemLevel)) lines.push(`ilvl: ${state.itemLevel}`);
  if (Number.isFinite(state.totalBudgetEx)) lines.push(`budget_ex: ${state.totalBudgetEx}`);
  if (Number.isFinite(state.minFilled) || Number.isFinite(state.maxFilled)) {
    const lo = Number.isFinite(state.minFilled) ? state.minFilled : 0;
    const hi = Number.isFinite(state.maxFilled) ? state.maxFilled : 6;
    lines.push(`filled: ${lo}..${hi}`);
  }
  if (Number.isFinite(state.requiredHits)) lines.push(`required_hits: ${state.requiredHits}`);
  if (Number.isFinite(state.timeWeightExPerSec)) lines.push(`time_weight_ex_per_sec: ${state.timeWeightExPerSec}`);
  lines.push('');
  lines.push('# Affixes (P=Prefix, S=Suffix; Tn+ = min acceptable tier; flags: req frac)');
  for (const e of state.targetEntries ?? []) {
    if (e.kind !== 'mod') continue;
    const side = e.type === 'PREFIX' ? 'P' : 'S';
    const tier = (Number.isFinite(e.minTier) || Number.isFinite(e.requiredTier))
      ? `T${e.minTier ?? e.requiredTier}+ `
      : '';
    const flags = [];
    if (e.required) flags.push('req');
    if (e.fractured) flags.push('frac');
    const flagStr = flags.length ? ` ${flags.join(' ')}` : '';
    lines.push(`${side} ${tier}"${e.name}"${flagStr}`);
  }
  return lines.join('\n');
}

/**
 * Parse a recipe DSL string into a UI state snapshot.
 *
 * Returns `{ ok: true, state, warnings }` on success or
 * `{ ok: false, errors }` when parsing fails. State has the same
 * shape as the serializer's input (suitable for `craft.applyRecipe`).
 *
 * @param {string} text
 */
export function parseRecipe(text) {
  const errors = [];
  const warnings = [];
  const state = { targetEntries: [] };
  if (typeof text !== 'string') {
    return { ok: false, errors: ['parseRecipe: expected string input'] };
  }
  const lines = text.split(/\r?\n/);
  for (let lineNo = 0; lineNo < lines.length; lineNo++) {
    let line = lines[lineNo];
    // Strip end-of-line comments BUT preserve `#` inside quoted mod
    // names (PoE2 mod names start with `#` like "# to maximum Life").
    // Strategy: only strip comments not inside `"..."`.
    line = stripComment(line).trim();
    if (!line) continue;
    // Header: key: value
    const headerMatch = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.+)$/);
    // Affix line precedence: try the affix pattern first since it
    // also contains `:` in some flag forms.
    const affixMatch = line.match(/^([PS])\s+(?:T(\d+)\+\s+)?"([^"]+)"(?:\s+(.+))?$/);
    if (affixMatch) {
      const [, side, tierStr, name, flagsStr] = affixMatch;
      const flags = (flagsStr ?? '').toLowerCase().split(/\s+/).filter(Boolean);
      const entry = {
        kind: 'mod',
        type: side === 'P' ? 'PREFIX' : 'SUFFIX',
        name,
        required: flags.includes('req'),
        fractured: flags.includes('frac'),
      };
      if (tierStr) {
        const tier = parseInt(tierStr, 10);
        entry.minTier = tier;
        entry.requiredTier = tier;
      }
      state.targetEntries.push(entry);
      continue;
    }
    if (headerMatch) {
      const [, kRaw, vRaw] = headerMatch;
      const k = kRaw.toLowerCase();
      const v = vRaw.trim();
      switch (k) {
        case 'type': state.itemType = v; break;
        case 'base': state.base = v; break;
        case 'ilvl': state.itemLevel = parseIntStrict(v, lineNo, errors); break;
        case 'budget_ex': state.totalBudgetEx = parseFloatStrict(v, lineNo, errors); break;
        case 'filled': {
          const m = v.match(/^(\d+)\s*\.\.\s*(\d+)$/);
          if (!m) { errors.push(`line ${lineNo + 1}: filled expects "N..M"; got "${v}"`); break; }
          state.minFilled = parseInt(m[1], 10);
          state.maxFilled = parseInt(m[2], 10);
          break;
        }
        case 'required_hits': state.requiredHits = parseIntStrict(v, lineNo, errors); break;
        case 'time_weight_ex_per_sec': state.timeWeightExPerSec = parseFloatStrict(v, lineNo, errors); break;
        default:
          warnings.push(`line ${lineNo + 1}: unknown key "${kRaw}" — ignored`);
      }
      continue;
    }
    warnings.push(`line ${lineNo + 1}: unrecognised line "${line}" — ignored`);
  }
  if (errors.length) return { ok: false, errors, warnings };
  return { ok: true, state, warnings };
}

function stripComment(line) {
  let inQuote = false;
  let out = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQuote = !inQuote;
    if (c === '#' && !inQuote) break;
    out += c;
  }
  return out;
}

function parseIntStrict(v, lineNo, errors) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) errors.push(`line ${lineNo + 1}: expected integer, got "${v}"`);
  return n;
}

function parseFloatStrict(v, lineNo, errors) {
  const n = parseFloat(v);
  if (!Number.isFinite(n)) errors.push(`line ${lineNo + 1}: expected number, got "${v}"`);
  return n;
}
