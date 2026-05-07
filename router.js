import { createRouter, createWebHashHistory } from 'vue-router';
import Home from './views/Home.js';
import About from './views/About.js';
import Disclaimer from './views/Disclaimer.js';
import DivineBench from './views/DivineBench.js';
import MdpEmbed from './views/MdpEmbed.js';

export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    // Default to PoE2 — the active game today.
    { path: '/', redirect: '/poe2' },
    { path: '/:game', name: 'home', component: Home, props: true },
    { path: '/:game/about', name: 'about', component: About, props: true },
    { path: '/:game/disclaimer', name: 'disclaimer', component: Disclaimer, props: true },
    // Divine Bench — closed-form value-roll bench, separate from
    // the strategy MDP / wishlist-shape crafting tab.
    { path: '/:game/divine-bench', name: 'divine-bench', component: DivineBench, props: true },
    // Headless MDP-graph view — auto-solves from the URL `?s=` craft
    // state and renders just the Mermaid chain. iframe-friendly,
    // F5-friendly. Mirrors the planner's `?s=` codec.
    { path: '/:game/mdp-embed', name: 'mdp-embed', component: MdpEmbed, props: true },
    // Catch-all → PoE2 home (so a stale link without a game segment works).
    { path: '/:pathMatch(.*)*', redirect: '/poe2' },
  ],
});
