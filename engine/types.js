// Game-agnostic core types. Pure JSDoc — no runtime cost.

/**
 * @typedef {Object} ItemState
 * @property {string} baseType        Item base (e.g. "Heavy Belt").
 * @property {number} itemLevel       Restricts which outcomes are available.
 * @property {string[]} tags          Free-form tags ("magic", "rare", "corrupted", ...).
 * @property {Mod[]} mods             Current explicit/implicit modifiers.
 * @property {Object} [extra]         Game-specific extension bag.
 */

/**
 * @typedef {Object} Mod
 * @property {string} id
 * @property {"prefix"|"suffix"|"implicit"|"enchant"|"corruption"} kind
 * @property {string} family          Exclusion group (only one mod per family).
 * @property {Object} [values]        Rolled values, if any.
 * @property {number} [tier]
 */

/**
 * @typedef {Object} Outcome
 * @property {number} weight                       Relative probability weight.
 * @property {(state: ItemState) => ItemState} apply  Pure transition (returns new state).
 * @property {string} [label]
 */

/**
 * @typedef {Object} Action
 * Represents an orb / operation that can be applied to an item.
 * @property {string} id
 * @property {string} name
 * @property {number} cost                              Cost in the action's own currency unit.
 * @property {string} currency                          e.g. "chaos", "exalt", "transmute".
 * @property {(state: ItemState) => boolean} canApply   Preconditions (rarity, ilvl, tags, ...).
 * @property {(state: ItemState) => Outcome[]} outcomes Context-dependent weighted outcomes.
 */

/**
 * @typedef {Object} Goal
 * @property {(state: ItemState) => boolean} isSatisfied
 * @property {string} [label]
 */

export {};
