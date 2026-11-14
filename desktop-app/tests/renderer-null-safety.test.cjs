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

test('manual-entry rendering never dereferences unavailable field definitions', () => {
  const source = pageSource();
  const offenders = [];
  const pattern = /(^|[^?\w$.])definition\.fields/gm;
  for (const match of source.matchAll(pattern)) {
    const line = source.slice(0, match.index).split('\n').length;
    offenders.push(`line ${line}: definition.fields`);
  }
  assert.deepStrictEqual(offenders, [], `field access must tolerate an unavailable definition:\n${offenders.join('\n')}`);
  assert.match(source, /definition\?\.fields/);
});

test('draft autosave waits for loaded definitions and encrypted storage', () => {
  const source = pageSource();
  assert.match(source, /if \(!catalog \|\| !hasDraftChanges \|\| !draftAvailable\) return undefined;/);
  assert.match(source, /window\.localApp\.manualEntryDraft\.save\(snapshot\)/);
});

test('draft snapshots retain the current workflow and entered data', () => {
  const source = pageSource();
  assert.match(source, /const makeDraftSnapshot = useCallback\(\(\) => \(\{[^}]*selectedGeoUnitId[^}]*stepIndex[^}]*valuesByForm[^}]*dimensionsByForm[^}]*editing/s);
  assert.match(source, /window\.localApp\.manualEntryDraft\.save\(snapshot\)/);
});
