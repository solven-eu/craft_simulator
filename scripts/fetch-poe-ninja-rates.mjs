// Scrape PoE2 currency / consumable prices from poe.ninja using Playwright.
//
// poe.ninja sits behind Cloudflare; a real browser is needed so the user can
// solve any "verify you're human" challenge interactively. This script
// launches Chromium with `headless: false`, navigates to each category, waits
// for the user to clear CF if it shows, then scrapes the price table.
//
// Setup (one-off):
//   npm install
//   npm run rates:install   # downloads the chromium binary playwright uses
//
// Run:
//   npm run rates                          # all categories
//   npm run rates -- omen abyssal-bones    # specific ones
//
// Output: data/poe2/rates/<category>.csv with columns name,value_raw.
// `value_raw` preserves both halves of poe.ninja's exchange (e.g. "187 ↔ 1.0"
// or "1.0 ↔ 2.8") — a follow-up step normalises to ex/unit.

import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const OUT  = join(ROOT, 'data', 'poe2', 'rates');

// Categories mirror poe.ninja's URL structure for the Vaal league.
// `?value=chaos` forces chaos-orb display so rates are at a comfortable
// intermediate magnitude (neither sub-1 ex nor thousands).
const CATEGORIES = {
  'currency':        'https://poe.ninja/poe2/economy/vaal/currency?value=chaos',
  'abyssal-bones':   'https://poe.ninja/poe2/economy/vaal/abyssal-bones?value=chaos',
  'breach-catalyst': 'https://poe.ninja/poe2/economy/vaal/breach-catalyst?value=chaos',
  // 'essence' (singular) redirects/triggers a navigation race; the canonical
  // sidebar URL is the plural form.
  'essence':         'https://poe.ninja/poe2/economy/vaal/essences?value=chaos',
  'omens':           'https://poe.ninja/poe2/economy/vaal/omens?value=chaos',
};

/** Display unit baked into the URLs above; downstream conversion uses this. */
const DISPLAY_UNIT = 'chaos';

const args = process.argv.slice(2);
const targets = args.length ? args : Object.keys(CATEGORIES);
const unknown = targets.filter((t) => !(t in CATEGORIES));
if (unknown.length) {
  console.error(`Unknown categories: ${unknown.join(', ')}`);
  console.error(`Known: ${Object.keys(CATEGORIES).sort().join(', ')}`);
  process.exit(2);
}

await mkdir(OUT, { recursive: true });

function csvEscape(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

async function pressEnter(prompt) {
  process.stdout.write(prompt);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await new Promise((resolve) => rl.question('', resolve));
  rl.close();
}

/**
 * Dismiss poe.ninja's cookie-consent banner by clicking "Do not consent"
 * (the exact button name surfaced by `playwright codegen`). Returns true
 * if a click was made.
 */
async function dismissCookieConsent(page) {
  try {
    const btn = page.getByRole('button', { name: 'Do not consent' });
    if (await btn.isVisible({ timeout: 2000 })) {
      console.log("    dismissing cookie banner: 'Do not consent'");
      await btn.click({ timeout: 3000 });
      await page.waitForTimeout(700);
      return true;
    }
  } catch { /* not visible / not present */ }
  return false;
}

async function scrapeCategory(page, url) {
  console.log(`  → ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  // Let CMP / banners mount, then dismiss them BEFORE waiting for the table.
  await page.waitForTimeout(1500);
  const dismissed = await dismissCookieConsent(page);
  if (!dismissed) console.log('    no cookie banner detected (or already cleared)');
  console.log('    If a Cloudflare challenge appears, solve it in the browser.');
  console.log('    Waiting for the price table to render (up to 5 min)…');
  try {
    await page.waitForSelector('text=Value', { timeout: 300_000 });
  } catch {
    console.log('    !! Timeout waiting for the table. Skipping.');
    return [];
  }
  // Let React finish populating rows.
  await page.waitForTimeout(1500);

  // Try modern aria roles first, then fall back to plain table markup.
  let rows = await page.$$('div[role="row"]');
  if (!rows.length) rows = await page.$$('tr');
  const out = [];
  for (const row of rows) {
    let cells = await row.$$('div[role="cell"]');
    if (!cells.length) cells = await row.$$('td');
    if (cells.length < 2) continue;
    const name = (await cells[0].innerText()).trim().split('\n')[0];
    if (!name || name.toLowerCase() === 'name') continue;
    const valueRaw = (await cells[1].innerText()).trim().replace(/\n+/g, ' ');
    out.push({ name, value_raw: valueRaw });
  }
  return out;
}

console.log(`Targets: ${targets.join(', ')}`);
const browser = await chromium.launch({ headless: false });
const ctx = await browser.newContext({
  viewport: { width: 1400, height: 900 },
  userAgent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0 Safari/537.36',
});
let page = await ctx.newPage();

// `--keep-open` keeps the browser around for debugging selectors; default
// closes it as soon as scraping finishes (so this is automation-friendly).
const keepOpen = targets.includes('--keep-open');
const realTargets = targets.filter((t) => t !== '--keep-open');

const failures = [];
try {
  for (const cat of realTargets) {
    console.log(`\n=== ${cat} ===`);
    let rows = [];
    try {
      rows = await scrapeCategory(page, CATEGORIES[cat]);
    } catch (err) {
      console.log(`    !! scrape failed: ${err.message?.split('\n')[0] ?? err}`);
      failures.push(cat);
      // Best-effort recovery: open a fresh page so the next category starts clean.
      try { await page.close(); } catch {}
      page = await ctx.newPage();
      continue;
    }
    const outPath = join(OUT, `${cat}.csv`);
    const csv = [
      `name,value_raw,display_unit`,
      ...rows.map((r) => `${csvEscape(r.name)},${csvEscape(r.value_raw)},${DISPLAY_UNIT}`),
    ].join('\n') + '\n';
    await writeFile(outPath, csv, 'utf-8');
    const rel = outPath.slice(ROOT.length + 1);
    console.log(`    wrote ${rows.length} rows → ${rel}`);
  }
  if (failures.length) {
    console.log(`\n!! ${failures.length} categor(ies) failed: ${failures.join(', ')}`);
    console.log('   Retry just these with: npm run rates -- ' + failures.join(' '));
  }
} finally {
  if (keepOpen) await pressEnter('\nPress Enter to close the browser…');
  await browser.close();
}
