// Headless render-check via Playwright. Loads the running dev server, walks
// the planner with a Boots-INT base + a wished mod, and dumps anything that
// looks like raw HTML, an unrendered Vue interpolation, or a stray JS
// fragment leaking into user-visible text.

import { chromium } from 'playwright';

const URL = 'http://localhost:8765/#/poe2';

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 1100 } });
const page = await ctx.newPage();

// Surface page errors / console issues.
const consoleMessages = [];
page.on('console', (msg) => {
  if (msg.type() === 'error' || msg.type() === 'warning') {
    consoleMessages.push(`[${msg.type()}] ${msg.text()}`);
  }
});
page.on('pageerror', (err) => consoleMessages.push(`[pageerror] ${err.message}`));

await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);

console.log('=== Console / errors ===');
console.log(consoleMessages.length ? consoleMessages.join('\n') : '(none)');

// Pick a base + ilvl by simulating the cascade.
const itemTypeSelect = await page.$('select');
if (itemTypeSelect) {
  await itemTypeSelect.selectOption({ label: 'Boots' });
  await page.waitForTimeout(400);
  // Pick a spec
  const selects = await page.$$('select');
  for (const s of selects) {
    const html = await s.innerHTML();
    if (html.includes('INT')) {
      await s.selectOption({ label: 'INT' });
      await page.waitForTimeout(400);
      break;
    }
  }
}

await page.waitForTimeout(1500);

// Open every collapsible section so we surface deeper content too.
await page.evaluate(() => {
  document.querySelectorAll('details').forEach((d) => { d.open = true; });
});
await page.waitForTimeout(800);

// Click the first "+ wish" button so we exercise the wished/target paths.
const firstWish = await page.$('button.link:has-text("+ wish")');
if (firstWish) {
  await firstWish.click();
  await page.waitForTimeout(300);
  // Click the first tier-pick button in the expanded picker.
  const firstTier = await page.$('button.tier-btn:not(:disabled)');
  if (firstTier) { await firstTier.click(); await page.waitForTimeout(500); }
}

// Capture a screenshot for human review.
await page.screenshot({ path: '/tmp/visual-check.png', fullPage: true });
console.log('\n=== Screenshot saved to /tmp/visual-check.png ===');

// Pull every visible text node and search for tell-tale leakage.
const fullText = await page.evaluate(() => document.body.innerText);
const suspicious = [];
const PATTERNS = [
  { pattern: /<[a-z][^>]*>/i,                      label: 'HTML tag in text' },
  { pattern: /\{\{[^}]+\}\}/,                       label: 'unrendered Vue interpolation' },
  { pattern: /\bfunction\s*\(/,                    label: 'function literal' },
  { pattern: /=>\s*\{/,                            label: 'arrow function literal' },
  { pattern: /\bdata-tag=/,                        label: 'attribute syntax in text' },
  { pattern: /class=["']/,                         label: 'class attr in text' },
  { pattern: /loading="lazy"/,                     label: 'lazy-loaded img leak' },
  { pattern: /href=/i,                             label: 'href attribute in text' },
  { pattern: /\\n|\\u00/,                          label: 'escape sequence' },
];

const lines = fullText.split(/\n+/);
for (const line of lines) {
  for (const { pattern, label } of PATTERNS) {
    if (pattern.test(line)) {
      suspicious.push({ label, line: line.trim().slice(0, 200) });
      break;
    }
  }
}

console.log(`\n=== Suspicious text fragments (${suspicious.length}) ===`);
for (const s of suspicious.slice(0, 40)) {
  console.log(`[${s.label}]\n  ${s.line}`);
}
if (suspicious.length > 40) console.log(`...and ${suspicious.length - 40} more.`);

await browser.close();
