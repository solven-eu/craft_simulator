// PoE2 essences — targeted crafting items.
//
// Catalog source: https://poe2db.tw/us/Essence
// Local cache:    data/poe2/essences.csv (78 essences, 5 tiers)
//
// Loaded lazily at runtime from the CSV. Fields per row:
//   name, tier, target_affix, side, guarantee, notes
//
// `side` is currently UNKNOWN for all rows — poe2db's index page doesn't
// expose prefix vs suffix. Resolve by cross-referencing target_affix against
// the Krakenbul mods sheet (data/poe2/mods.json) once the affix-side mapping
// is implemented. Per-essence prices are also TODO (see docs/sources.md).

let essencesPromise = null;

function parseCSV(text) {
  // Minimal CSV parser handling quoted fields with embedded commas.
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (c === '\r') { /* ignore */ }
      else field += c;
    }
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [header, ...data] = rows.filter((r) => r.length > 1 || r[0]);
  return data.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

export function loadEssences() {
  if (!essencesPromise) {
    essencesPromise = fetch(new URL('../../data/poe2/essences.csv', import.meta.url))
      .then((r) => {
        if (!r.ok) throw new Error(`Failed to load essences.csv (${r.status})`);
        return r.text();
      })
      .then(parseCSV);
  }
  return essencesPromise;
}

/** Synchronous accessor — empty until `loadEssences()` resolves. */
export const essences = [];
