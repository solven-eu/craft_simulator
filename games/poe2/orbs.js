// PoE2 orb catalog — metadata for each crafting orb.
//
// Effects and outcome distributions live alongside the closed-form solver
// (engine/wishlist.js etc.) and reference these entries for cost/time data.
//
// Per-orb fields:
//   - id           stable identifier (matches `currency.id` for self-priced orbs)
//   - name         display label
//   - priceCurrency the unit `priceAmount` is expressed in (often the orb itself
//                  if it's also a tradable currency — its real cost is just its
//                  market value)
//   - priceAmount  typical buy/use cost in `priceCurrency`. For orbs that are
//                  themselves a tradable currency, this is 1.
//   - timeSeconds  wall-clock per application (clicks + animation + inventory).
//                  Estimate; user can override at runtime.
//   - effect       short human description (full effect lives in the action
//                  module that implements it)
//
// Default `timeSeconds` is 1 — the floor "at least 1s to glance at the
// outcome". Multi-step orbs (Vaal corruption animation, Fracturing's lock
// confirmation) get a slightly higher default. Users can override per-orb
// in the rates panel.

/** @type {Record<string, { id: string, name: string, priceCurrency: string, priceAmount: number, timeSeconds: number, effect: string }>} */
export const orbs = {
  transmute: { id: 'transmute', name: 'Orb of Transmutation',  priceCurrency: 'transmute', priceAmount: 1, timeSeconds: 1, effect: 'White → Magic (1–2 mods)' },
  augment:   { id: 'augment',   name: 'Orb of Augmentation',   priceCurrency: 'augment',   priceAmount: 1, timeSeconds: 1, effect: 'Magic with 1 mod → 2 mods' },
  alchemy:   { id: 'alchemy',   name: 'Orb of Alchemy',        priceCurrency: 'alchemy',   priceAmount: 1, timeSeconds: 1, effect: 'White → Rare (4 mods)' },
  regal:     { id: 'regal',     name: 'Regal Orb',             priceCurrency: 'regal',     priceAmount: 1, timeSeconds: 1, effect: 'Magic → Rare (adds 1 mod)' },
  chaos:     { id: 'chaos',     name: 'Chaos Orb',             priceCurrency: 'chaos',     priceAmount: 1, timeSeconds: 1, effect: 'Rare: remove a random mod, add a random mod' },
  exalted:   { id: 'exalted',   name: 'Exalted Orb',           priceCurrency: 'exalted',   priceAmount: 1, timeSeconds: 1, effect: 'Rare with <6 mods → adds 1 mod' },
  divine:    { id: 'divine',    name: 'Divine Orb',            priceCurrency: 'divine',    priceAmount: 1, timeSeconds: 1, effect: 'Re-roll values within their tier ranges' },
  annulment: { id: 'annulment', name: 'Orb of Annulment',      priceCurrency: 'annulment', priceAmount: 1, timeSeconds: 1, effect: 'Remove a random mod' },
  vaal:      { id: 'vaal',      name: 'Vaal Orb',              priceCurrency: 'vaal',      priceAmount: 1, timeSeconds: 3, effect: 'Corrupt: random outcome (mod added/removed/changed/unchanged)' },
  chance:    { id: 'chance',    name: 'Orb of Chance',         priceCurrency: 'chance',    priceAmount: 1, timeSeconds: 1, effect: 'White → random rarity (chance to become a Unique)' },
  fracturing: { id: 'fracturing', name: 'Fracturing Orb', priceCurrency: 'fracturing', priceAmount: 1, timeSeconds: 3, effect: 'Lock a random modifier on a Rare item with ≥4 mods' },
  // Greater / Perfect variants take the same wall-clock per use as their
  // base orb (the user clicks once, animation is identical), so their
  // `timeSeconds` is sourced from the base via `timeBaseOrb`. The Time-
  // rate UI hides the input on these and shows a synced badge.
  exaltedGreater:    { id: 'exaltedGreater',    name: 'Greater Exalted Orb',          priceCurrency: 'exaltedGreater',    priceAmount: 1, timeSeconds: 1, timeBaseOrb: 'exalted',   effect: 'Adds a random mod biased toward higher tiers (top 3)' },
  exaltedPerfect:    { id: 'exaltedPerfect',    name: 'Perfect Exalted Orb',          priceCurrency: 'exaltedPerfect',    priceAmount: 1, timeSeconds: 1, timeBaseOrb: 'exalted',   effect: 'Adds a random mod biased toward top tiers (top 1-2)' },
  chaosGreater:      { id: 'chaosGreater',      name: 'Greater Chaos Orb',            priceCurrency: 'chaosGreater',      priceAmount: 1, timeSeconds: 1, timeBaseOrb: 'chaos',     effect: 'Rare: remove a random mod, add a random mod biased toward higher tiers (top 3)' },
  chaosPerfect:      { id: 'chaosPerfect',      name: 'Perfect Chaos Orb',            priceCurrency: 'chaosPerfect',      priceAmount: 1, timeSeconds: 1, timeBaseOrb: 'chaos',     effect: 'Rare: remove a random mod, add a random mod biased toward top tiers (top 1-2)' },
  regalGreater:      { id: 'regalGreater',      name: 'Greater Regal Orb',            priceCurrency: 'regalGreater',      priceAmount: 1, timeSeconds: 1, timeBaseOrb: 'regal',     effect: 'Magic → Rare; new mod biased toward higher tiers (top 3)' },
  regalPerfect:      { id: 'regalPerfect',      name: 'Perfect Regal Orb',            priceCurrency: 'regalPerfect',      priceAmount: 1, timeSeconds: 1, timeBaseOrb: 'regal',     effect: 'Magic → Rare; new mod biased toward top tiers (top 1-2)' },
  augmentGreater:    { id: 'augmentGreater',    name: 'Greater Orb of Augmentation',  priceCurrency: 'augmentGreater',    priceAmount: 1, timeSeconds: 1, timeBaseOrb: 'augment',   effect: 'Magic with 1 mod → 2 mods; new mod biased toward higher tiers (top 3)' },
  augmentPerfect:    { id: 'augmentPerfect',    name: 'Perfect Orb of Augmentation',  priceCurrency: 'augmentPerfect',    priceAmount: 1, timeSeconds: 1, timeBaseOrb: 'augment',   effect: 'Magic with 1 mod → 2 mods; new mod biased toward top tiers (top 1-2)' },
  transmuteGreater:  { id: 'transmuteGreater',  name: 'Greater Orb of Transmutation', priceCurrency: 'transmuteGreater',  priceAmount: 1, timeSeconds: 1, timeBaseOrb: 'transmute', effect: 'White → Magic; new mod biased toward higher tiers (top 3)' },
  transmutePerfect:  { id: 'transmutePerfect',  name: 'Perfect Orb of Transmutation', priceCurrency: 'transmutePerfect',  priceAmount: 1, timeSeconds: 1, timeBaseOrb: 'transmute', effect: 'White → Magic; new mod biased toward top tiers (top 1-2)' },
  // Mirror of Kalandra omitted — duplicates an item, no impact on mod rolls.
};
