// Concrete-item DSL — paste-able text representation of a rolled
// item (sibling of the recipe DSL in `engine/recipe-syntax.js`).
//
// While recipe DSL describes a TARGET (wishlist + thresholds),
// concrete-item DSL describes a RESULT — a specific Rare with each
// affix at a specific tier and value. Used to round-trip a sampled
// trajectory's final state from the Plan view's "🎲 Simulate"
// button INTO the Divine Bench so the user can ask "given this
// concrete item, P(improve after N divines)?"
//
// Format:
//
//   # Comments. End-of-line `#` stripped (except inside quoted names).
//
//   type: Bow                          # display name
//   base: BOW                          # canonical base id
//   ilvl: 84                           # item level
//   rarity: rare                       # normal | magic | rare
//
//   # Affix lines:
//   #   <P|S> T<tier> =<value> [<vmin>..<vmax>] "<name>" [flags]
//   # where:
//   #   T<tier>           concrete tier the mod rolled at (1 = best)
//   #   =<value>          the actual rolled value (number)
//   #   [<vmin>..<vmax>]  OPTIONAL — the tier's value range (used by
//   #                     the Divine Bench paste handler to populate
//   #                     P(divine improves) probabilities)
//   #   flags             space-separated subset of: frac
//
//   S T1 =9 [8..12] "#% Surpassing chance to fire an additional Arrow" frac
//   P T3 =50 [40..60] "# to maximum Life"

/**
 * Serialize a concrete-item snapshot into the DSL.
 *
 * @param {object} item — concrete item shape:
 *   {
 *     itemType?, base?, itemLevel?, rarity,
 *     affixes: [{ side: 'P'|'S', tier, value, vmin?, vmax?, name, fractured? }]
 *   }
 */
export function serializeConcreteItem(item) {
  const lines = ['# Concrete item (sampled trajectory output)'];
  if (item.itemType)              lines.push(`type: ${item.itemType}`);
  if (item.base)                  lines.push(`base: ${item.base}`);
  if (Number.isFinite(item.itemLevel)) lines.push(`ilvl: ${item.itemLevel}`);
  if (item.rarity)                lines.push(`rarity: ${item.rarity}`);
  // Optional resource ledger metadata for the Plan-view scenario UI.
  // Lines are header-style (`key: value`) so the parser ignores them
  // gracefully when round-tripping into the Divine Bench (which
  // doesn't need the ledger).
  if (Number.isFinite(item.totalEx))     lines.push(`total_ex: ${Math.round(item.totalEx)}`);
  if (Number.isFinite(item.totalSec))    lines.push(`total_sec: ${Math.round(item.totalSec)}`);
  if (Number.isFinite(item.buyBaseEvents)) lines.push(`buy_base_events: ${item.buyBaseEvents}`);
  if (item.orbCounts && Object.keys(item.orbCounts).length) {
    const parts = Object.entries(item.orbCounts)
      .sort(([, a], [, b]) => b - a)
      .map(([k, v]) => `${k}=${v}`);
    lines.push(`orbs: ${parts.join(' ')}`);
  }
  lines.push('');
  lines.push('# Affixes:');
  for (const a of (item.affixes ?? [])) {
    const side = a.side === 'PREFIX' ? 'P' : a.side === 'SUFFIX' ? 'S' : a.side;
    const tier = `T${a.tier}`;
    const value = `=${a.value}`;
    const range = (Number.isFinite(a.vmin) && Number.isFinite(a.vmax))
      ? ` [${a.vmin}..${a.vmax}]` : '';
    const flags = [];
    if (a.fractured) flags.push('frac');
    const flagStr = flags.length ? ` ${flags.join(' ')}` : '';
    lines.push(`${side} ${tier} ${value}${range} "${a.name}"${flagStr}`);
  }
  return lines.join('\n');
}

/**
 * Parse a concrete-item DSL string.
 *
 * @returns { ok, item, warnings, errors }
 */
export function parseConcreteItem(text) {
  const errors = [];
  const warnings = [];
  const item = { affixes: [] };
  if (typeof text !== 'string') {
    return { ok: false, errors: ['parseConcreteItem: expected string input'] };
  }
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = stripComment(lines[i]).trim();
    if (!raw) continue;
    // Affix-line attempt first (matches richer patterns; some tokens
    // contain `:`).
    const affixMatch = raw.match(
      /^([PS])\s+T(\d+)\s+=(\S+)(?:\s+\[(\S+?)\.\.(\S+?)\])?\s+"([^"]+)"(?:\s+(.+))?$/);
    if (affixMatch) {
      const [, side, tierStr, valueStr, vminStr, vmaxStr, name, flagsStr] = affixMatch;
      const flags = (flagsStr ?? '').toLowerCase().split(/\s+/).filter(Boolean);
      const tier = parseInt(tierStr, 10);
      const value = parseFloat(valueStr);
      if (!Number.isFinite(tier) || !Number.isFinite(value)) {
        errors.push(`line ${i + 1}: invalid tier or value in "${raw}"`);
        continue;
      }
      const entry = {
        side: side === 'P' ? 'PREFIX' : 'SUFFIX',
        tier, value, name,
        fractured: flags.includes('frac'),
      };
      if (vminStr != null && vmaxStr != null) {
        entry.vmin = parseFloat(vminStr);
        entry.vmax = parseFloat(vmaxStr);
        if (!Number.isFinite(entry.vmin) || !Number.isFinite(entry.vmax)) {
          warnings.push(`line ${i + 1}: range "${vminStr}..${vmaxStr}" not numeric — dropping`);
          delete entry.vmin; delete entry.vmax;
        }
      }
      item.affixes.push(entry);
      continue;
    }
    // Header line.
    const headerMatch = raw.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.+)$/);
    if (headerMatch) {
      const [, kRaw, vRaw] = headerMatch;
      const k = kRaw.toLowerCase();
      const v = vRaw.trim();
      switch (k) {
        case 'type':   item.itemType = v; break;
        case 'base':   item.base = v; break;
        case 'ilvl':   item.itemLevel = parseInt(v, 10); break;
        case 'rarity': item.rarity = v.toLowerCase(); break;
        case 'total_ex':       item.totalEx = parseFloat(v); break;
        case 'total_sec':      item.totalSec = parseFloat(v); break;
        case 'buy_base_events': item.buyBaseEvents = parseInt(v, 10); break;
        case 'orbs': {
          const counts = {};
          for (const tok of v.split(/\s+/).filter(Boolean)) {
            const m = tok.match(/^([A-Za-z_]+)=(\d+)$/);
            if (m) counts[m[1]] = parseInt(m[2], 10);
          }
          item.orbCounts = counts;
          break;
        }
        default:
          warnings.push(`line ${i + 1}: unknown key "${kRaw}" — ignored`);
      }
      continue;
    }
    warnings.push(`line ${i + 1}: unrecognised line "${raw}" — ignored`);
  }
  if (errors.length) return { ok: false, errors, warnings };
  return { ok: true, item, warnings };
}

function stripComment(line) {
  let inQuote = false, out = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQuote = !inQuote;
    if (c === '#' && !inQuote) break;
    out += c;
  }
  return out;
}
