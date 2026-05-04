import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.js';
import { router } from './router.js';
import { useCraftStore } from './stores/craft.js';
import { writeURLState, debounce } from './lib/urlState.js';

const pinia = createPinia();
createApp(App)
  .use(pinia)
  .use(router)
  .mount('#app');

// URL-state push: any change to the craft store gets serialised back into
// the URL (debounced so typing in inputs doesn't thrash history).
const craft = useCraftStore();
const push = debounce(() => writeURLState(craft.$state), 200);
craft.$subscribe((_mutation, state) => {
  push();
  // Snapshot current state for the immediate-write closure.
  void state;
});
// Push once at boot so the URL reflects defaults if it was empty.
writeURLState(craft.$state);

// External URL changes — e.g. the user pastes a different shareable link
// into the address bar — fire `hashchange`. Programmatic replaceState (our
// own debounced write above) does NOT, so this listener only triggers on
// real navigation. Reload when the encoded `s=` payload differs so the
// store re-hydrates cleanly from the new URL state.
const extractStateParam = (h) => {
  const m = /[?&]s=([^&]+)/.exec(h || '');
  return m ? m[1] : null;
};
let lastStateParam = extractStateParam(window.location.hash);
window.addEventListener('hashchange', () => {
  const cur = extractStateParam(window.location.hash);
  if (cur !== lastStateParam) {
    lastStateParam = cur;
    window.location.reload();
  }
});
