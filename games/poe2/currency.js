// PoE2 currency catalog and conversion rates.
//
// Conversion rates fluctuate with the game economy and must be refreshed
// periodically. Source: https://poe2db.tw/Economy_Currency
// (server-rendered tables, scraped via scripts/update-poe2-rates.sh; the
// output lands in data/poe2/rates.csv and is hot-loaded at runtime).
//
// Internal model: every currency declares its rate in **Exalted Orbs**
// (the universal small-denomination unit). All cost arithmetic happens in
// exalted; conversion to Divine for display is `cost / divinePerExalted`.
//
// Defaults below are seeded from a Vaal-league snapshot (2026-04-29) so the
// catalog renders before rates.csv resolves; the loader overwrites them
// when the live snapshot is present. Users can override at runtime; their
// overrides are persisted in localStorage by the store.

/**
 * @typedef {Object} Currency
 * @property {string} id
 * @property {string} name
 * @property {string} short
 * @property {number} exaltedPer       Value of 1 unit in Exalted Orbs.
 * @property {boolean} [reference]     True for the two reference currencies.
 * @property {'orb'|'catalyst'|'essence'|'jeweller'|'desecrated'|'omen'|'other'} [kind]
 *           Categorisation matching the poe2db Economy_* table grouping.
 *           Drives the rates-panel section the entry appears in.
 * @property {string[]} [appliesToItemClasses]
 *           If set, restricts UI visibility to items of these classes (e.g.
 *           Abyssal Bones for Armour only show on Armour bases).
 * @property {number} [maxIlvl]
 *           If set, the consumable can only be applied to items with
 *           `ilvl ≤ maxIlvl` (e.g. Gnawed-tier desecrations, capped at 64).
 */

/** @type {Record<string, Currency>} */
export const currencies = {
  // ── Reference currencies ───────────────────────────────────────────
  exalted:    { id: 'exalted',    name: 'Exalted Orb',          short: 'ex',    exaltedPer: 1,    reference: true, kind: 'orb' },
  divine:     { id: 'divine',     name: 'Divine Orb',           short: 'div',   exaltedPer: 187,  reference: true, kind: 'orb' },

  // ── Orbs (rarity / mod manipulation) ─────────────────────────────
  // Transmute / Augment / Regal are typically cheap (vendor or trade
  // floor). Defaults are placeholders so the MDP can model the
  // trans-aug-regal path; users seed real rates via the rates panel.
  transmute:  { id: 'transmute',  name: 'Orb of Transmutation', short: 'tra',   exaltedPer: 0.001, kind: 'orb' },
  augment:    { id: 'augment',    name: 'Orb of Augmentation',  short: 'aug',   exaltedPer: 0.002, kind: 'orb' },
  alchemy:    { id: 'alchemy',    name: 'Orb of Alchemy',       short: 'alch',  exaltedPer: 0.01,  kind: 'orb' },
  regal:      { id: 'regal',      name: 'Regal Orb',            short: 'rg',    exaltedPer: 0.05,  kind: 'orb' },
  fracturing:    { id: 'fracturing',    name: 'Fracturing Orb',           short: 'fr',  exaltedPer: 10000, kind: 'orb' },
  vaalCultivation:{id: 'vaalCultivation',name: 'Vaal Cultivation Orb',    short: 'vc',  exaltedPer: 424,   kind: 'orb' },
  chaosPerfect:  { id: 'chaosPerfect',  name: 'Perfect Chaos Orb',        short: 'pc',  exaltedPer: 239,   kind: 'orb' },
  extraction:    { id: 'extraction',    name: 'Orb of Extraction',        short: 'ext', exaltedPer: 101,   kind: 'orb' },
  architect:     { id: 'architect',     name: "Architect's Orb",          short: 'arc', exaltedPer: 82,    kind: 'orb' },
  regalGreater:  { id: 'regalGreater',  name: 'Greater Regal Orb',        short: 'grg', exaltedPer: 36,    kind: 'orb' },
  exaltedPerfect:{ id: 'exaltedPerfect',name: 'Perfect Exalted Orb',      short: 'pex', exaltedPer: 24,    kind: 'orb' },
  chaosGreater:  { id: 'chaosGreater',  name: 'Greater Chaos Orb',        short: 'gc',  exaltedPer: 18,    kind: 'orb' },
  annulment:     { id: 'annulment',     name: 'Orb of Annulment',         short: 'ann', exaltedPer: 9.5,   kind: 'orb' },
  regalPerfect:  { id: 'regalPerfect',  name: 'Perfect Regal Orb',        short: 'prg', exaltedPer: 8.6,   kind: 'orb' },
  chaos:         { id: 'chaos',         name: 'Chaos Orb',                short: 'c',   exaltedPer: 6.3,   kind: 'orb' },
  vaal:          { id: 'vaal',          name: 'Vaal Orb',                 short: 'vl',  exaltedPer: 4.4,   kind: 'orb' },
  augmentPerfect:{ id: 'augmentPerfect',name: 'Perfect Orb of Augmentation', short: 'pau', exaltedPer: 4.0, kind: 'orb' },
  // Greater/Perfect Augmentation and Transmutation — defaults are
  // placeholder seeds; the live UI loads real rates via
  // `data/poe2/rates.csv`. Without these entries the engine couldn't
  // see Greater Augment / Perfect Transmute prices even when rates.csv
  // had them, so the MDP silently excluded those actions.
  augmentGreater:{ id: 'augmentGreater',name: 'Greater Orb of Augmentation', short: 'gau', exaltedPer: 0.05, kind: 'orb' },
  transmuteGreater:{ id: 'transmuteGreater',name: 'Greater Orb of Transmutation', short: 'gtr', exaltedPer: 0.03, kind: 'orb' },
  transmutePerfect:{ id: 'transmutePerfect',name: 'Perfect Orb of Transmutation', short: 'ptr', exaltedPer: 3.0, kind: 'orb' },
  exaltedGreater:{ id: 'exaltedGreater',name: 'Greater Exalted Orb',      short: 'gex', exaltedPer: 3.4,   kind: 'orb' },
  chance:        { id: 'chance',        name: 'Orb of Chance',            short: 'chc', exaltedPer: 3.3,   kind: 'orb' },

  // ── Jeweller's orbs (socket / link manipulation) ──────────────────
  artificer:       { id: 'artificer',       name: "Artificer's Orb",         short: 'art', exaltedPer: 4.7, kind: 'jeweller' },
  jewellerLesser:  { id: 'jewellerLesser',  name: "Lesser Jeweller's Orb",   short: 'lj',  exaltedPer: 3.7, kind: 'jeweller' },
  jewellerGreater: { id: 'jewellerGreater', name: "Greater Jeweller's Orb",  short: 'gj',  exaltedPer: 2.9, kind: 'jeweller' },
  jewellerPerfect: { id: 'jewellerPerfect', name: "Perfect Jeweller's Orb",  short: 'pj',  exaltedPer: 12,  kind: 'jeweller' },

  // ── Desecration consumables (Bones / Skulls / Soul Cores / Gazes) ─
  // Item-class restrictions match the poe2db data.
  // ilvl bounds: Gnawed-tier capped at 64; Ancient-tier needs min mod level 40 (free at any ilvl).
  ancientCollarbone:   { id: 'ancientCollarbone',   name: 'Ancient Collarbone',   short: 'acoll', exaltedPer: 147,    kind: 'desecrated', appliesToItemClasses: ['Amulet', 'Ring', 'Belt'] },
  preservedCollarbone: { id: 'preservedCollarbone', name: 'Preserved Collarbone', short: 'pcoll', exaltedPer: 1.8,    kind: 'desecrated', appliesToItemClasses: ['Amulet', 'Ring', 'Belt'] },
  gnawedCollarbone:    { id: 'gnawedCollarbone',    name: 'Gnawed Collarbone',    short: 'gcoll', exaltedPer: 0.139,  kind: 'desecrated', appliesToItemClasses: ['Amulet', 'Ring', 'Belt'], maxIlvl: 64 },
  ancientJawbone:      { id: 'ancientJawbone',      name: 'Ancient Jawbone',      short: 'ajaw',  exaltedPer: 100,    kind: 'desecrated', appliesToItemClasses: ['Weapon', 'Quiver'] },
  preservedJawbone:    { id: 'preservedJawbone',    name: 'Preserved Jawbone',    short: 'pjaw',  exaltedPer: 0.357,  kind: 'desecrated', appliesToItemClasses: ['Weapon', 'Quiver'] },
  gnawedJawbone:       { id: 'gnawedJawbone',       name: 'Gnawed Jawbone',       short: 'gjaw',  exaltedPer: 0.139,  kind: 'desecrated', appliesToItemClasses: ['Weapon', 'Quiver'], maxIlvl: 64 },
  ancientRib:          { id: 'ancientRib',          name: 'Ancient Rib',          short: 'arib',  exaltedPer: 34,     kind: 'desecrated', appliesToItemClasses: ['Body Armour', 'Boots', 'Gloves', 'Helmet'] },
  preservedRib:        { id: 'preservedRib',        name: 'Preserved Rib',        short: 'prib',  exaltedPer: 0.357,  kind: 'desecrated', appliesToItemClasses: ['Body Armour', 'Boots', 'Gloves', 'Helmet'] },
  gnawedRib:           { id: 'gnawedRib',           name: 'Gnawed Rib',           short: 'grib',  exaltedPer: 1.5,    kind: 'desecrated', appliesToItemClasses: ['Body Armour', 'Boots', 'Gloves', 'Helmet'], maxIlvl: 64 },
  preservedCranium:    { id: 'preservedCranium',    name: 'Preserved Cranium',    short: 'pcra',  exaltedPer: 3.6,    kind: 'desecrated', appliesToItemClasses: ['Jewel'] },
  // Gazes are *socket runes*, not crafting consumables — they fill a
  // socket on the finished item but do not modify affixes. Tagging
  // `kind: 'rune'` (not in CURRENCY_KINDS) keeps them out of the
  // crafting rates panel, mirroring how Jeweller's Orbs are muted.
  // Kulemak's Invitation, by contrast, is a real desecration consumable
  // (boss-mod target) and stays under `kind: 'desecrated'`.
  tecrodsGaze:         { id: 'tecrodsGaze',         name: "Tecrod's Gaze",        short: 'tgaze', exaltedPer: 146,    kind: 'rune' },
  kurgalsGaze:         { id: 'kurgalsGaze',         name: "Kurgal's Gaze",        short: 'kgaze', exaltedPer: 3.5,    kind: 'rune' },
  amanamusGaze:        { id: 'amanamusGaze',        name: "Amanamu's Gaze",       short: 'agaze', exaltedPer: 2.6,    kind: 'rune' },
  ulamansGaze:         { id: 'ulamansGaze',         name: "Ulaman's Gaze",        short: 'ugaze', exaltedPer: 2.0,    kind: 'rune' },
  kulemaksInvitation:  { id: 'kulemaksInvitation',  name: "Kulemak's Invitation", short: 'kulinv',exaltedPer: 5.8,    kind: 'desecrated' },
};

/**
 * Display order and labels for the rates-panel sections. Mirrors the
 * categorisation used by poe2db's Economy_* tables so users see a familiar
 * grouping.
 */
// Note: `jeweller` (Jeweller's Orbs / Artificer) is intentionally omitted —
// those orbs manage sockets/links, not mods, so they're irrelevant to the
// crafting cost analytics this tool produces. Currencies of `kind: 'jeweller'`
// remain in the catalog but no section renders them in the rates panel.
export const CURRENCY_KINDS = [
  { id: 'orb',        label: 'Orbs (rarity & mod)', appliesAlways: true,  poedbEconomy: 'Currency' },
  { id: 'catalyst',   label: 'Catalysts',            appliesAlways: false, poedbEconomy: 'Catalyst' },
  { id: 'essence',    label: 'Essences',             appliesAlways: false, poedbEconomy: 'Essences' },
  { id: 'desecrated', label: 'Desecration (Bones / Skulls / Gazes)', appliesAlways: false, poedbEconomy: 'Soul_Cores' },
  { id: 'omen',       label: 'Omens',                appliesAlways: false, poedbEconomy: 'Omen' },
  { id: 'other',      label: 'Other',                appliesAlways: true,  poedbEconomy: null },
];

/**
 * Convert `amount` of `fromId` into `toId`, using a rate table.
 * Returns NaN if either rate is missing.
 */
export function convert(amount, fromId, toId, table = currencies) {
  const f = table[fromId], t = table[toId];
  if (!f || !t) throw new Error(`unknown currency: ${fromId} or ${toId}`);
  if (!Number.isFinite(f.exaltedPer) || !Number.isFinite(t.exaltedPer)) return NaN;
  return (amount * f.exaltedPer) / t.exaltedPer;
}

/** Snapshot metadata for "rates last refreshed from poe2db on …". */
export const ratesSeed = {
  source: 'https://poe2db.tw/Economy_Currency',
  league: 'Vaal',
  capturedAt: '2026-04-29',
  note: 'Seed values; the loader overwrites these from data/poe2/rates.csv when it resolves.',
};
