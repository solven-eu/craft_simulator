import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ──────────────────────────────────────────────────────────────────
// Bidirectional sync between engine/mdp/actions.js and
// docs/actions-coverage.md. Adding a new MDP action without
// documenting it (or vice-versa) fails this test.
//
// Source-of-truth parsing:
//   - actions.js: keys directly under `ACTIONS = { ... }` (top-level
//     properties of the catalog object).
//   - actions-coverage.md: the bullets immediately under any heading
//     in the "Covered" section, which we recognise as
//     ``- `<key>` —`` lines.
//
// Skip-listed keys (intentional, document-only): none currently —
// dynamic essences are documented in a prose paragraph without a
// per-essence bullet, and `buy_base` is added imperatively after
// the `ACTIONS = { ... }` block (we account for both below).
// ──────────────────────────────────────────────────────────────────

const ACTIONS_SRC = readFileSync(join(ROOT, 'engine/mdp/actions.js'), 'utf8');
const DOC_SRC = readFileSync(join(ROOT, 'docs/actions-coverage.md'), 'utf8');

function parseActionKeys(src) {
  // Extract the body of `export const ACTIONS = { ... };` plus any
  // imperative `ACTIONS.<key> = …` assignments after the block close
  // (e.g. `buy_base` is appended this way).
  const blockMatch = src.match(/export const ACTIONS = \{([\s\S]*?)\n\};/);
  assert.ok(blockMatch, 'ACTIONS = { ... } block not found in actions.js');
  const blockBody = blockMatch[1];
  const keys = new Set();
  // Top-level keys: indented exactly 2 spaces, identifier, then a colon.
  // Nested object properties have 4+ space indentation, so this
  // heuristic excludes them. Skip lines whose colon is part of a
  // string literal or comment.
  for (const line of blockBody.split('\n')) {
    const m = line.match(/^ {2}([a-z_][a-z0-9_]*):\s/);
    if (m) keys.add(m[1]);
  }
  // Imperative appends: `ACTIONS.<key> = ...`.
  for (const m of src.matchAll(/^ACTIONS\.([a-z_][a-z0-9_]*)\s*=/gm)) {
    keys.add(m[1]);
  }
  return keys;
}

function parseDocKeys(doc) {
  // Pull bullets only from the "Covered" section (between the
  // `## Covered` heading and the next `## ` heading).
  const startIdx = doc.indexOf('\n## Covered');
  assert.ok(startIdx >= 0, '`## Covered` heading missing from actions-coverage.md');
  const after = doc.slice(startIdx);
  const endRel = after.indexOf('\n## ', 1);
  const section = endRel < 0 ? after : after.slice(0, endRel);
  const keys = new Set();
  for (const m of section.matchAll(/^- `([a-z_][a-z0-9_]*)`/gm)) {
    keys.add(m[1]);
  }
  return keys;
}

test('every ACTIONS key in actions.js is documented in actions-coverage.md', () => {
  const codeKeys = parseActionKeys(ACTIONS_SRC);
  const docKeys = parseDocKeys(DOC_SRC);
  const missing = [...codeKeys].filter((k) => !docKeys.has(k)).sort();
  assert.deepEqual(missing, [],
    `${missing.length} action(s) in engine/mdp/actions.js are NOT listed `
    + `under "## Covered" in docs/actions-coverage.md: ${missing.join(', ')}. `
    + `Add a bullet ` + '`- `<id>` — short description.`'
    + ` for each missing entry.`);
});

test('every documented action bullet has a matching ACTIONS key', () => {
  const codeKeys = parseActionKeys(ACTIONS_SRC);
  const docKeys = parseDocKeys(DOC_SRC);
  const stale = [...docKeys].filter((k) => !codeKeys.has(k)).sort();
  assert.deepEqual(stale, [],
    `${stale.length} bullet(s) in docs/actions-coverage.md reference `
    + `actions that no longer exist in engine/mdp/actions.js: ${stale.join(', ')}. `
    + `Remove the stale bullets or restore the actions.`);
});

test('the doc has both Covered and Not covered sections', () => {
  // Defensive: if a future edit accidentally drops one, the keys
  // parser silently returns an empty set and the test above passes
  // when nothing is exported. Pin the structure explicitly.
  assert.match(DOC_SRC, /\n## Covered\b/);
  assert.match(DOC_SRC, /\n## Not covered\b/);
});
