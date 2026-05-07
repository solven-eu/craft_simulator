// Saved-crafts persistence — localStorage-backed snapshots of the
// craft state. Spreadable into the Pinia `actions:` block; `this`
// binds to the store instance.
//
// Each entry shape:
//   { id, name, savedAt, snapshot: {<SHAREABLE_FIELDS subset>} }
//
// SHAREABLE_FIELDS is a closure variable injected at module-load time
// via `bindSharedFields(SHAREABLE_FIELDS)` so each action method can
// reference it without an extra arg in every call.

import { SHAREABLE_FIELDS } from '../../lib/urlState.js';

/**
 * Read the persisted savedCrafts array from localStorage. Used in
 * the store's state initialiser. Returns [] on any failure.
 */
export function loadInitialSavedCrafts() {
  try {
    const raw = typeof window !== 'undefined'
      ? window.localStorage?.getItem('savedCrafts') : null;
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

function buildSnapshot(s) {
  const snapshot = {};
  for (const f of SHAREABLE_FIELDS) {
    if (f in s.$state) snapshot[f] = JSON.parse(JSON.stringify(s.$state[f]));
  }
  return snapshot;
}

export const savedCraftActions = {
  /**
   * Snapshot the current craft and prepend it to the savedCrafts
   * list. Auto-names with itemType + base + ilvl when no name given.
   */
  saveCurrentCraft(name) {
    const auto = `${this.itemType ?? 'craft'}`
      + `${this.base && this.base !== this.itemType ? ` (${this.base})` : ''}`
      + ` · ilvl ${this.itemLevel}`;
    const entry = {
      id: `c${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      name: (name && name.trim()) || auto,
      savedAt: new Date().toISOString(),
      snapshot: buildSnapshot(this),
    };
    this.savedCrafts = [entry, ...this.savedCrafts];
    this._persistSavedCrafts();
    return entry;
  },

  /**
   * Restore a previously-saved snapshot by id. Wipes the current
   * craft state for every shareable field except gameId. Returns
   * false when no entry matches.
   */
  loadSavedCraft(id) {
    const entry = this.savedCrafts.find((c) => c.id === id);
    if (!entry) return false;
    for (const [k, v] of Object.entries(entry.snapshot)) {
      if (k === 'gameId') continue;
      this[k] = JSON.parse(JSON.stringify(v));
    }
    this.strategiesResults = null;
    this._syncTargetConstraints?.();
    return true;
  },

  deleteSavedCraft(id) {
    this.savedCrafts = this.savedCrafts.filter((c) => c.id !== id);
    this._persistSavedCrafts();
  },

  /**
   * Replace an existing entry's snapshot with the current state,
   * keeping the entry's id and name. Used by the "overwrite" button.
   */
  overwriteSavedCraft(id) {
    const entry = this.savedCrafts.find((c) => c.id === id);
    if (!entry) return false;
    entry.snapshot = buildSnapshot(this);
    entry.savedAt = new Date().toISOString();
    this._persistSavedCrafts();
    return true;
  },

  renameSavedCraft(id, name) {
    const entry = this.savedCrafts.find((c) => c.id === id);
    if (!entry) return;
    entry.name = name;
    this._persistSavedCrafts();
  },

  _persistSavedCrafts() {
    try {
      if (typeof window !== 'undefined') {
        window.localStorage?.setItem('savedCrafts', JSON.stringify(this.savedCrafts));
      }
    } catch { /* quota / disabled storage — best-effort */ }
  },
};
