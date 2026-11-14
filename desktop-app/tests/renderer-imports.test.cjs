'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

/**
 * A missing helper import inside a renderer page is invisible to the test suite
 * and to the build: Vite bundles it happily, and the page then throws
 * `ReferenceError: fmtNumber is not defined` on first render, which unmounts the
 * React root and leaves the whole window blank (there is no error boundary by
 * design). That is exactly how the central manual-entry page shipped broken in
 * 0.6.19 through 0.6.21 while every other check stayed green, so the relationship
 * between `lib/format.js` exports and their importers is asserted here.
 */

const RENDERER_ROOT = path.resolve(__dirname, '..', 'src', 'renderer');
const FORMAT_MODULE = path.join(RENDERER_ROOT, 'lib', 'format.js');
const SOURCE_EXTENSIONS = /\.(jsx?|mjs)$/;

function walk(directory, found = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(full, found);
    else if (SOURCE_EXTENSIONS.test(entry.name)) found.push(full);
  }
  return found;
}

/** Names exported by lib/format.js, read from the module instead of duplicated. */
function formatExports() {
  const source = fs.readFileSync(FORMAT_MODULE, 'utf8');
  const names = new Set();
  for (const match of source.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) names.add(match[1]);
  for (const match of source.matchAll(/export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) names.add(match[1]);
  return [...names];
}

const HELPERS = formatExports();

function importsHelper(source, name) {
  const importPattern = new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*['"][^'"]*lib/format(?:\\.js)?['"]`, 's');
  if (importPattern.test(source)) return true;
  const namespacePattern = /import\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s*['"][^'"]*lib\/format(?:\.js)?['"]/;
  const namespace = source.match(namespacePattern);
  if (namespace) return new RegExp(`\\b${namespace[1]}\\.${name}\\b`).test(source);
  return false;
}

function declaresHelper(source, name) {
  return new RegExp(`(?:function\\s+${name}\\s*\\(|(?:const|let|var)\\s+${name}\\s*=)`, 'm').test(source);
}

test('the renderer module exports at least the formatter helpers it documents', () => {
  assert.ok(HELPERS.includes('fmtNumber'), 'lib/format.js must export fmtNumber');
  assert.ok(HELPERS.includes('errText'), 'lib/format.js must export errText');
});

test('every lib/format helper used by the renderer is imported or declared locally', () => {
  const problems = [];
  for (const file of walk(RENDERER_ROOT)) {
    const source = fs.readFileSync(file, 'utf8');
    for (const name of HELPERS) {
      // Only a call counts as a use; a mention inside a string or a JSX label does not.
      const used = new RegExp(`(^|[^.\\w$])${name}\\s*\\(`, 'm').test(source);
      if (!used) continue;
      if (importsHelper(source, name) || declaresHelper(source, name)) continue;
      if (path.resolve(file) === path.resolve(FORMAT_MODULE)) continue;
      problems.push(`${path.relative(RENDERER_ROOT, file)} uses ${name}() without importing it from lib/format.js`);
    }
  }
  assert.deepStrictEqual(problems, [], `missing renderer imports:\n${problems.join('\n')}`);
});

test('the central manual-entry page imports the helper it renders', () => {
  const page = path.join(RENDERER_ROOT, 'pages', 'DataEntry.jsx');
  const source = fs.readFileSync(page, 'utf8');
  assert.ok(/errText\s*\(/.test(source), 'DataEntry should still render user-facing errors');
  assert.ok(importsHelper(source, 'errText'), 'DataEntry.jsx must import errText from lib/format.js');
});
