// Shared key-formation helpers for the craft-store split. Kept in
// its own module so each extracted action/getter file can import
// `wlKey` without depending on craft.js.

export const wlKey = (type, name) => `${type}:${name}`;
