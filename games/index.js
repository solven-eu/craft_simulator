// Registry of supported games. Each entry lazy-loads its data module
// so we don't pay for games the user hasn't selected.

export const games = {
  poe2: {
    id: 'poe2',
    label: 'Path of Exile 2',
    load: () => import('./poe2/index.js'),
  },
  // poe1: { id: 'poe1', label: 'Path of Exile', load: () => import('./poe1/index.js') },
  // d4:   { id: 'd4',   label: 'Diablo 4',       load: () => import('./d4/index.js') },
};
