'use strict';

/**
 * Tests for the hardening wave: schema additions, read audit, undo snapshots,
 * the review→analysis bridge, the field-access policy and the OCR gates.
 *
 * These are deliberately behavioural: each test proves the user-visible promise
 * (a value can be undone, a read is attributable, a sensitive field is not
 * exported, an approved value reaches the analysis) rather than the shape of an
 * internal function.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3-multiple-ciphers');

const { migrate, DIRECTORATE_COLUMN_MIGRATIONS } = require('../src/main/analysis/store-schema.cjs');
const { openEncryptedStore } = require('../src/main/store.cjs');
const persist = require('../src/main/analysis/persist.cjs');
const bridge = require('../src/main/analysis/bridge.cjs');
const security = require('../src/main/security.cjs');
const { parseLabeledText, crossFieldWarnings } = require('../src/main/analysis/ocr-entry.cjs');
const { textLayerIsUsable, langPath } = require('../src/main/ocr-pipeline.cjs');
const { serializeAnalysis } = require('../src/main/analysis/serialize.cjs');

function openTestDatabase() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ldi-hardening-'));
  const filePath = path.join(directory, 'test.db');
  // Use the production open path so the review/import tables exist exactly as
  // they do in the application.
  const database = openEncryptedStore(filePath, 'test-key-hardening');
  return { database, directory, filePath };
}

function withDatabase(callback) {
  const context = openTestDatabase();
  try {
    return callback(context);
  } finally {
    context.database.close();
    fs.rmSync(context.directory, { recursive: true, force: true });
  }
}

function addDirectorate(database, overrides = {}) {
  const saved = persist.saveManualDirectorate(database, {
    districtName: 'مديرية الشعر',
    governorate: 'إب',
    values: {
      population: 43739,
      revenue: 75643312,
      povertyRatio: 0.55,
      projectCost: 250000000,
      frontLine: true,
      ...overrides,
    },
  });
  return saved.id;
}

test('migration adds the new tables and the warning column idempotently', () => withDatabase(({ database }) => {
  const tables = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
  for (const table of ['audit_reads', 'directorate_versions', 'ocr_drafts', 'ocr_field_confidence']) {
    assert.ok(tables.has(table), `missing table ${table}`);
  }
  const columns = new Set(database.prepare('PRAGMA table_info(directorates)').all().map((row) => row.name));
  for (const migration of DIRECTORATE_COLUMN_MIGRATIONS) {
    assert.ok(columns.has(migration.name), `missing column ${migration.name}`);
  }
  // Running the migration again must not throw.
  migrate(database);
  migrate(database);
}));

test('a read is recorded with its channel, entity and session', () => withDatabase(({ database }) => {
  persist.logRead(database, { sessionId: 'ses-1', channel: 'analysis:directorate:get', entity: 'directorates', entityId: 7, fields: 'revenue,povertyRatio', result: 'masked' });
  persist.logRead(database, { sessionId: 'ses-1', channel: 'data:export', entity: 'file', rowCount: 12 });
  const reads = persist.listReads(database, 10);
  assert.equal(reads.length, 2);
  assert.equal(reads[0].channel, 'data:export');
  assert.equal(reads[1].fields, 'revenue,povertyRatio');
  assert.equal(reads[1].session_id, 'ses-1');
}));

test('deleting a directorate is reversible through the snapshot', () => withDatabase(({ database }) => {
  const id = addDirectorate(database);
  persist.deleteDirectorate(database, id);
  assert.equal(persist.countDirectorates(database), 0);

  const [version] = persist.listVersions(database, id);
  assert.ok(version, 'a snapshot must exist after delete');
  assert.match(version.action, /before-delete/);

  persist.restoreDirectorateVersion(database, version.id);
  assert.equal(persist.countDirectorates(database), 1);
  const restored = persist.loadAnalysisRows(database)[0];
  assert.equal(restored.values.population, 43739);
}));

test('an edit is reversible to the previous value', () => withDatabase(({ database }) => {
  const id = addDirectorate(database);
  persist.saveManualDirectorate(database, { id, districtName: 'مديرية الشعر', governorate: 'إب', values: { population: 99999 } });
  assert.equal(persist.loadAnalysisRows(database)[0].values.population, 99999);

  const [version] = persist.listVersions(database, id);
  persist.restoreDirectorateVersion(database, version.id);
  assert.equal(persist.loadAnalysisRows(database)[0].values.population, 43739);
}));

test('the reviewer decision is stored, not dropped', () => withDatabase(({ database }) => {
  const id = addDirectorate(database);
  persist.saveManualDirectorate(database, {
    id,
    districtName: 'مديرية الشعر',
    governorate: 'إب',
    values: { reviewerDecision: 'معتمد' },
  });
  const record = persist.getDirectorate(database, id);
  assert.equal(record.reviewer_decision, 'معتمد');
  assert.throws(
    () => persist.saveManualDirectorate(database, { id, districtName: 'مديرية الشعر', governorate: 'إب', values: { reviewerDecision: 'قرار مخترع' } }),
    /قيم غير صالحة/,
  );
}));

test('shared profile masks restricted fields and the owner profile does not', () => withDatabase(({ database }) => {
  const id = addDirectorate(database);
  const record = persist.getDirectorate(database, id);
  const { DIRECTORATE_COLUMNS } = require('../src/main/analysis/store-schema.cjs');

  const asOwner = security.maskRecord(record, 'owner', DIRECTORATE_COLUMNS);
  assert.equal(asOwner.masked.length, 0);
  assert.equal(asOwner.record.revenue, 75643312);

  const asShared = security.maskRecord(record, 'shared', DIRECTORATE_COLUMNS);
  assert.ok(asShared.masked.includes('revenue'));
  assert.ok(asShared.masked.includes('povertyRatio'));
  assert.ok(asShared.masked.includes('frontLine'));
  assert.equal(asShared.record.revenue, null);
  assert.equal(asShared.record.population, 43739, 'public fields stay visible');
}));

test('the access profile persists and defaults to owner', () => withDatabase(({ database }) => {
  assert.equal(security.getAccessProfile(database), 'owner');
  assert.equal(security.setAccessProfile(database, 'shared'), 'shared');
  assert.equal(security.getAccessProfile(database), 'shared');
  assert.equal(security.setAccessProfile(database, 'anything-else'), 'owner');
}));

test('approved values reach the analysis through the bridge, with provenance', () => withDatabase(({ database }) => {
  const now = new Date().toISOString();
  const batch = database.prepare("INSERT INTO import_batches(file_name,file_type,file_size,item_count,status,warnings_json,created_at) VALUES(?,?,?,?,?,?,?)")
    .run('ministry.xlsx', 'xlsx', 10, 3, 'review', '[]', now);
  const batchId = Number(batch.lastInsertRowid);
  const insertItem = database.prepare("INSERT INTO review_items(batch_id,field_name,value_text,proposed_type,governorate,district,subdistrict,settlement,record_id,source_location,confidence,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)");
  const insertValue = database.prepare('INSERT INTO data_values(governorate,district,subdistrict,settlement,record_type,record_id,field_name,value_text,source_item_id,source_file,source_location,imported_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)');

  const rows = [
    ['عدد السكان', '43,739', 'population'],
    ['إيرادات المديرية', '75,643,312', 'revenue'],
    ['نسبة المياه %', '19.7', 'waterCoverage'],
  ];
  for (const [header, value] of rows) {
    const item = insertItem.run(batchId, header, value, 'مديرية', 'إب', 'مديرية الشعر', '', '', 'r1', 'A1', 1, 'accepted', now);
    insertValue.run('إب', 'مديرية الشعر', '', '', 'مديرية', 'r1', header, value, Number(item.lastInsertRowid), 'ministry.xlsx', 'A1', now);
  }

  const candidates = bridge.listCandidates(database);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].mappedFields, 3);
  assert.equal(candidates[0].directorateId, null);

  const result = bridge.bridgeAll(database);
  assert.equal(result.created, 1);
  assert.equal(result.fields, 3);

  const analysisRows = persist.loadAnalysisRows(database);
  assert.equal(analysisRows.length, 1);
  assert.equal(analysisRows[0].values.population, 43739);
  assert.equal(analysisRows[0].values.revenue, 75643312);
  assert.ok(Math.abs(analysisRows[0].values.waterCoverage - 0.197) < 1e-9);

  const sources = database.prepare("SELECT field_key, data_value_id FROM directorate_sources WHERE field_key IN ('population','revenue')").all();
  assert.equal(sources.length, 2);
  assert.ok(sources.every((source) => Number.isInteger(source.data_value_id) && source.data_value_id > 0), 'provenance must point at data_values.id');
}));

test('OCR proposals carry line confidence and force review when it is low', () => {
  const text = 'عدد السكان: 43739\nنسبة تغطية المياه: 19.7%';
  const result = parseLabeledText(text, { lineConfidence: [0.92, 0.4] });
  assert.equal(result.fields.population.value, 43739);
  assert.equal(result.fields.population.confidence, 0.92);
  assert.equal(result.fields.population.needsReview, false);
  assert.equal(result.fields.waterCoverage.confidence, 0.4);
  assert.equal(result.fields.waterCoverage.needsReview, true);
  assert.ok(result.fields.waterCoverage.reviewReasons.includes('low-ocr-confidence'));
  assert.ok(result.fields.waterCoverage.reviewReasons.includes('percent-converted'));
});

test('cross-field validation flags an impossible student count', () => {
  const result = parseLabeledText('عدد السكان: 1000\nعدد الملتحقين: 5000');
  const issues = crossFieldWarnings(result.fields);
  assert.ok(issues.some((issue) => issue.code === 'enrolled-exceeds-population'));
});

test('a garbled Arabic text layer is rejected instead of trusted', () => {
  assert.equal(textLayerIsUsable(''), false);
  assert.equal(textLayerIsUsable('1'), false);
  assert.equal(textLayerIsUsable('District: Example'), true);
  assert.equal(textLayerIsUsable('اسم المديرية: مديرية الشعر — عدد السكان: 43739'), true);
  // Arabic presentation forms are the signature of a broken ToUnicode map.
  assert.equal(textLayerIsUsable('ﺍﺳﻢ ﺍﻟﻤﺪﻳﺮﻳﺔ ﺩﺩﺩ ﺍﻟﺴﻜﺎﻥ ﻣﺪﻳﺮﻳﺔ ﺍﻟﺸﻌﺮ'), false);
});

test('the bundled OCR model points at the best integer variant', () => {
  const resolved = langPath();
  assert.match(resolved.replaceAll('\\', '/'), /4\.0\.0_best_int$/);
  assert.ok(fs.existsSync(path.join(resolved, 'ara.traineddata.gz')));
});

test('compact serialization drops per-row values but keeps the analysis usable', () => {
  const analysis = {
    rows: [{
      districtName: 'مديرية الشعر',
      governorate: 'إب',
      values: { population: 43739, revenue: 75643312, waterCoverage: 0.197 },
      rawValues: { population: '43739' },
      indicators: { waterDeficit: 80.3 },
      completeness: { present: 3, total: 13, ratio: 0.23, missingLabels: [] },
      sensitivity: { fragile: false },
    }],
    meta: {},
    summary: {},
    ranking: { replica: {}, calibrated: {} },
    sensitivity: { weight: { scenarios: [], perRow: [] }, sample: null },
    gaps: { summary: {}, perRow: [] },
    stats: {},
  };
  const compact = serializeAnalysis(analysis, { compact: true });
  assert.equal(compact.rows[0].values, undefined);
  assert.equal(compact.rows[0].rawValues, undefined);
  assert.deepEqual(compact.rows[0].restrictedPresent, ['revenue']);
  assert.equal(compact.rows[0].indicators.waterDeficit, 80.3);

  const full = serializeAnalysis(analysis);
  assert.equal(full.rows[0].values.population, 43739);
});