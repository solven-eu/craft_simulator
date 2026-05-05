// Path of Exile 2 — game data entry point.

import { actions } from './actions.js';
import { orbs } from './orbs.js';
import { loadEssences } from './essences.js';
import { currencies, convert, CURRENCY_KINDS } from './currency.js';

let omensPromise = null;

function parseCSV(text) {
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

export function loadOmens() {
  if (!omensPromise) {
    omensPromise = fetch(new URL('../../data/poe2/omens.csv', import.meta.url))
      .then((r) => {
        if (!r.ok) throw new Error(`Failed to load omens.csv (${r.status})`);
        return r.text();
      })
      .then(parseCSV)
      .then((rows) => rows.map((r) => ({
        ...r,
        available: r.available !== 'false',
      })));
  }
  return omensPromise;
}

let essencePricesPromise = null;
export function loadEssencePrices() {
  if (!essencePricesPromise) {
    essencePricesPromise = fetch(new URL('../../data/poe2/essence_prices.csv', import.meta.url))
      .then((r) => {
        if (!r.ok) throw new Error(`Failed to load essence_prices.csv (${r.status})`);
        return r.text();
      })
      .then(parseCSV)
      .then((rows) => Object.fromEntries(
        rows.map((r) => [r.name, { priceEx: parseFloat(r.price_ex), source: r.source }]),
      ));
  }
  return essencePricesPromise;
}

let modsPromise = null;

/** Lazy-load the merged mod dataset produced by scripts/update-poe2-data.sh. */
export function loadMods() {
  if (!modsPromise) {
    modsPromise = fetch(new URL('../../data/poe2/mods.json', import.meta.url))
      .then((r) => {
        if (!r.ok) throw new Error(`Failed to load mods.json (${r.status})`);
        return r.json();
      });
  }
  return modsPromise;
}

let modTagsPromise = null;

/**
 * Lazy-load per-mod tag mappings produced by scripts/update-poe2-tags.sh.
 * Shape: { "BASE": { "<mod name>": [tag, …] } }. May be partially populated
 * — the scraper is best-effort.
 */
export function loadModTags() {
  if (!modTagsPromise) {
    modTagsPromise = fetch(new URL('../../data/poe2/mod_tags.json', import.meta.url))
      .then((r) => (r.ok ? r.json() : {}))
      .catch(() => ({}));
  }
  return modTagsPromise;
}

let modRangesPromise = null;

/**
 * Lazy-load per-(base, mod, tier) display strings with actual value ranges
 * preserved (e.g. "+(10—19) to maximum Life") — produced by
 * scripts/update-poe2-tags.sh.
 * Shape: { base: { mod_name: { tier_number_string: display_text } } }.
 */
export function loadModRanges() {
  if (!modRangesPromise) {
    modRangesPromise = fetch(new URL('../../data/poe2/mod_ranges.json', import.meta.url))
      .then((r) => (r.ok ? r.json() : {}))
      .catch(() => ({}));
  }
  return modRangesPromise;
}

let itemDescriptionsPromise = null;

/**
 * Lazy-load the orb/omen description+icon snapshot scraped from poe2db.
 * Returns a map keyed by the item's display name:
 *   { "Exalted Orb": { description, image_url, slug, kind, fetched_at } }
 */
export function loadItemDescriptions() {
  if (!itemDescriptionsPromise) {
    itemDescriptionsPromise = fetch(new URL('../../data/poe2/item_descriptions.csv', import.meta.url))
      .then((r) => (r.ok ? r.text() : ''))
      .then(parseCSV)
      .then((rows) => Object.fromEntries(rows.map((r) => [r.name, r])))
      .catch(() => ({}));
  }
  return itemDescriptionsPromise;
}

let ratesPromise = null;

/**
 * Lazy-load the currency-rate snapshot scraped from poe2db's Economy_* tables
 * by scripts/update-poe2-rates.sh. Each row is normalised to "ref_currency
 * per 1 unit of item" where ref_currency ∈ {divine, chaos, exalted}; we then
 * resolve every row to `exaltedPer` using the divine→exalted and chaos→exalted
 * ratios pulled from the table itself.
 *
 * Returns:
 *   {
 *     byName, bySlug:        per-row entries (see below)
 *     fetchedAt:             ISO string from any row (snapshot timestamp)
 *     region, league:        scrape provenance (`us` etc., league name if visible)
 *     ageDays:               whole days since fetchedAt; null if unknown
 *     staleness:             'fresh' (≤7d) | 'aging' (8–30d) | 'stale' (>30d) | 'unknown'
 *     exaltedPerDivine, exaltedPerChaos: cross-rates derived from the table
 *   }
 *
 * The resolver is conservative: if the divine→exalted row is missing the
 * caller falls back to whatever `currency.js` has hardcoded.
 */
export function loadRates() {
  if (!ratesPromise) {
    ratesPromise = fetch(new URL('../../data/poe2/rates.csv', import.meta.url))
      .then((r) => (r.ok ? r.text() : ''))
      .then(parseCSV)
      .then((rows) => {
        // The Currency table prices Divine in chaos and Chaos in divine —
        // pull both ratios so we can normalise everything to exalted.
        let divinePerExalted = null;  // ex per div... wait we want ex per div = 1/divinePerEx
        let exaltedPerDivine = null;
        let exaltedPerChaos = null;
        for (const r of rows) {
          if (r.slug === 'exalted' && r.ref_currency === 'divine') {
            // 1 exalted = X divine → 1 divine = 1/X exalted
            const x = parseFloat(r.price_per_unit);
            if (x > 0) exaltedPerDivine = 1 / x;
          }
          if (r.slug === 'divine' && r.ref_currency === 'chaos') {
            // 1 divine = X chaos. We need exaltedPerChaos via this + exaltedPerDivine.
            // Resolved in a second pass.
          }
          if (r.slug === 'chaos' && r.ref_currency === 'divine') {
            // 1 chaos = X divine
            const x = parseFloat(r.price_per_unit);
            if (x > 0 && exaltedPerDivine) exaltedPerChaos = x * exaltedPerDivine;
          }
        }
        // Second-pass resolve via divine row if chaos↔divine wasn't visible.
        if (exaltedPerChaos == null) {
          for (const r of rows) {
            if (r.slug === 'divine' && r.ref_currency === 'chaos') {
              const x = parseFloat(r.price_per_unit);
              if (x > 0 && exaltedPerDivine) exaltedPerChaos = exaltedPerDivine / x;
            }
          }
        }
        const refToExalted = {
          exalted: 1,
          divine: exaltedPerDivine,
          chaos: exaltedPerChaos,
        };
        // Round to 4 significant digits — same scale we use in the CSV
        // post-process. Defense-in-depth: callers loading older CSVs (or
        // any other rate source) shouldn't get spurious precision.
        const round4sig = (n) => Number.isFinite(n) && n !== 0 ? Number(n.toPrecision(4)) : n;
        const byName = {};
        const bySlug = {};
        let fetchedAt = '';
        let region = '';
        let league = '';
        for (const r of rows) {
          const ref = r.ref_currency;
          const price = round4sig(parseFloat(r.price_per_unit));
          const factor = refToExalted[ref];
          const exaltedPer = factor != null && Number.isFinite(price)
            ? round4sig(price * factor) : NaN;
          const entry = {
            name: r.name,
            slug: r.slug,
            kind: r.kind,
            refCurrency: ref,
            pricePerUnit: price,
            exaltedPer,
            trend7dPct: r.trend_7d_pct ? parseFloat(r.trend_7d_pct) : null,
            dailyVolume: r.daily_volume ? parseFloat(r.daily_volume) : null,
            imageUrl: r.image_url,
            fetchedAt: r.fetched_at,
          };
          byName[r.name] = entry;
          bySlug[r.slug] = entry;
          if (!fetchedAt) fetchedAt = r.fetched_at;
          if (!region && r.region) region = r.region;
          if (!league && r.league) league = r.league;
        }
        // Staleness windows reflect typical PoE2 economy drift: prices
        // jitter ±5% intraday, so a week-old snapshot is still mostly
        // correct (fresh). Past 30d we're likely into a different patch
        // / league phase; treat as stale and signal red.
        let ageDays = null;
        let ageHours = null;
        let staleness = 'unknown';
        if (fetchedAt) {
          const ms = Date.now() - new Date(fetchedAt).getTime();
          if (Number.isFinite(ms) && ms >= 0) {
            ageHours = Math.floor(ms / (1000 * 60 * 60));
            ageDays = Math.floor(ms / (1000 * 60 * 60 * 24));
            staleness = ageDays <= 7 ? 'fresh' : ageDays <= 30 ? 'aging' : 'stale';
          }
        }
        return { byName, bySlug, fetchedAt, region, league, ageDays, ageHours, staleness,
                 exaltedPerDivine, exaltedPerChaos };
      })
      .catch(() => ({ byName: {}, bySlug: {}, fetchedAt: '', region: '', league: '',
                      ageDays: null, ageHours: null, staleness: 'unknown',
                      exaltedPerDivine: null, exaltedPerChaos: null }));
  }
  return ratesPromise;
}

let extraModsPromise = null;

/**
 * Lazy-load per-base extra-bucket mods (desecrated, essence, corrupted).
 * Shape: { "BASE": { desecrated: [{text, tags, tier_name}], essence: [...], corrupted: [...] } }.
 */
export function loadExtraMods() {
  if (!extraModsPromise) {
    extraModsPromise = fetch(new URL('../../data/poe2/extra_mods.json', import.meta.url))
      .then((r) => (r.ok ? r.json() : {}))
      .catch(() => ({}));
  }
  return extraModsPromise;
}

// --- Per-base partition ----------------------------------------------------
// scripts/update-poe2-data.sh and update-poe2-tags.sh emit per-base files
// under data/poe2/by-base/ alongside the consolidated JSONs. Runtime callers
// can load just the active base on demand instead of paying ~2 MB of cold-
// start for a single craft.
//
// Shape on disk per base <slug>:
//   <slug>.mods.json    list of mod records (subset of mods.json)
//   <slug>.tags.json    map of mod_name -> [tags]
//   <slug>.ranges.json  map of mod_name -> { tier_str: display }
//   <slug>.extra.json   { desecrated: [...], essence: [...], corrupted: [...] }
//   index.json          { "BASE NAME": "slug" }
//
// Each loader is memoised per-base so repeated `loadBaseBundle("BOW")` from
// different callers reuses one fetch. Missing files resolve to empty values
// (some bases in the manifest don't have a poe2db scrape yet — see the
// weapon-base coverage gap that motivated this split).

let manifestPromise = null;
export function loadBaseManifest() {
  if (!manifestPromise) {
    manifestPromise = fetch(new URL('../../data/poe2/by-base/index.json', import.meta.url))
      .then((r) => (r.ok ? r.json() : {}))
      .catch(() => ({}));
  }
  return manifestPromise;
}

const baseBundleCache = new Map();   // slug -> Promise<{mods,tags,ranges,extra}>

function fetchJsonOr(url, fallback) {
  return fetch(url).then((r) => (r.ok ? r.json() : fallback)).catch(() => fallback);
}

/**
 * Fetch the four per-base files in parallel and return them merged. Pass the
 * canonical base name (matches the manifest key, e.g. "BOW", "BOOTS (DEX)").
 * Returns `{ mods, tags, ranges, extra }` with empty defaults when any file
 * is missing, so callers can unconditionally spread the result.
 */
export async function loadBaseBundle(base) {
  const manifest = await loadBaseManifest();
  const slug = manifest[base];
  if (!slug) return { mods: [], tags: {}, ranges: {}, extra: {} };
  if (baseBundleCache.has(slug)) return baseBundleCache.get(slug);
  const root = new URL('../../data/poe2/by-base/', import.meta.url);
  const promise = Promise.all([
    fetchJsonOr(new URL(`${slug}.mods.json`, root), []),
    fetchJsonOr(new URL(`${slug}.tags.json`, root), {}),
    fetchJsonOr(new URL(`${slug}.ranges.json`, root), {}),
    fetchJsonOr(new URL(`${slug}.extra.json`, root), {}),
  ]).then(([mods, tags, ranges, extra]) => ({ mods, tags, ranges, extra }));
  baseBundleCache.set(slug, promise);
  return promise;
}

export const game = {
  id: 'poe2',
  label: 'Path of Exile 2',
  /** Reference currencies for cost reporting. */
  referenceCurrencies: ['exalted', 'divine'],
  actions,
  orbs,
  currencies,
  CURRENCY_KINDS,
  convert,
  loadMods,
  loadModTags,
  loadModRanges,
  loadExtraMods,
  loadBaseManifest,
  loadBaseBundle,
  loadItemDescriptions,
  loadEssences,
  loadEssencePrices,
  loadOmens,
  loadRates,
};
