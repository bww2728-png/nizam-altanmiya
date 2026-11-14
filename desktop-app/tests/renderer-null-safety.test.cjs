'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

/**
 * A render-time dereference of state that is still `null` throws inside React's
 * commit phase, unmounts the root, and leaves the window blank: the app ships no
 * error boundary on purpose, so nothing catches it. That is how 0.6.24 shipped:
 * `latestDraftSignatureRef.current = buildDraftSignature()` ran during the very
 * first render of the central manual-entry page, `definition` was still `null`,
 * and `buildRecordPayload()` reached `definition.fields` before the form
 * definition had been fetched. Every other check stayed green because the crash
 * only happens in the packaged renderer at runtime.
 *
 * The two assertions below are deliberately about the shape of the source: they
 * are cheap, they run in CI, and they fail the moment that class of bug returns.
 */

const PAGE = path.resolve(__dirname, '..', 'src', 'renderer', 'pages', 'DataEntry.jsx');

function pageSource() {
  return fs.readFileSync(PAGE, 'utf8');
}

test('a nullable form definition is never dereferenced for its fields', () => {
  const source = pageSource();
  const offenders = [];
  const pattern = /(^|[^?\w$.])definition\.fields/gm;
  for (const match of source.matchAll(pattern)) {
    const line = source.slice(0, match.index).split('\n').length;
    offenders.push(`line ${line}: definition.fields`);
  }
  assert.deepStrictEqual(offenders, [], `use definition?.fields because the definition is null until the catalogue loads:\n${offenders.join('\n')}`);
});

test('the draft signature computed during render is guarded by the definition', () => {
  const source = pageSource();
  const assignment = source.match(/^[ \t]*latestDraftSignatureRef\.current[ \t]*=[ \t]*(.+)$/m);
  assert.ok(assignment, 'DataEntry.jsx should still track the latest draft signature');
  const expression = assignment[1].trim();
  assert.match(expression, /definition\s*\?/, `render-time signature must be conditional, found: ${expression}`);
});

test('the draft signature is still rebuilt when a definition is present', () => {
  const source = pageSource();
  assert.match(source, /definition\s*\?\s*buildDraftSignature\(\)/, 'guarded branch must call buildDraftSignature()');
  assert.match(source, /const buildDraftSignature = \(payload = buildRecordPayload\(\)\)/, 'buildDraftSignature keeps its default payload');
});
