'use strict';

/**
 * Contract tests for the import plan: classification, anomalies, duplicates,
 * the update diff, decisions, the stale contract and the summary shape.
 *
 * The plan is the reviewable contract between a workbook read and the database,
 * so these tests build synthetic `read` objects (no Excel fixture, no network)
 * and assert only on the plan's documented, serialisable shape.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3-multiple-ciphers');

const { migrate } = require('../src/main/analysis/store-schema.cjs');
const persist = require('../src/main/analysis/persist.cjs');
const { MANDATORY_FIELDS } = require('../src/main/analysis/schema.cjs');
const {
  buildImportPlan,
  summarizePlan,
  applyImportPlan,
  anomalyKeys,
  CODE_LABELS,
} = require('../src/main/analysis/import-plan.cjs');

const FILE_NAME = 'book.xlsx';
const SHEET_NAME = 'قاعدة البيانات الشاملة';

function openTestDatabase() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ldi-import-plan-'));
  const filePath = path.join(directory, 'test.db');
  const database = new Database(filePath, { timeout: 5000 });
  database.pragma("cipher = 'sqlcipher'");
  database.pragma("key = 'test-key-import-plan'");
  database.pragma('foreign_keys = ON');
  database.prepare('SELECT count(*) AS count FROM sqlite_master').get();
  migrate(database);
  return { database, directory, filePath };
}

/** Values with all 13 mandatory fields present, so a row starts out `ready`. */
function completeValues(overrides = {}) {
  return {
    districtName: 'مديرية ألف',
    governorate: 'إب',
    population: 43739,
    waterCoverage: 0.197,
    pavedRoads: 0.8,
    revenue: 75643312,
    govFacilities: 11,
    schools: 40,
    agriProduction: 320,
    valueChains: 3,
    projectCost: 1500000000,
    associations: 2,
    goodsTons: 45,
    frontLine: false,
    projectStatus: 'جاري',
    ...overrides,
  };
}

function rowOf(rowNumber, values, extra = {}) {
  return {
    rowNumber,
    values,
    rawValues: {},
    sources: {},
    warnings: [],
    ...extra,
  };
}

function readOf(rows, extra = {}) {
  return {
    fileName: FILE_NAME,
    sheetName: SHEET_NAME,
    headerRow: 2,
    rows,
    matched: [{ key: 'districtName' }, { key: 'governorate' }],
    unmatched: [],
    duplicates: [],
    missingInputs: [],
    warnings: [],
    ...extra,
  };
}

function insertStored(database, districtName, governorate, overrides = {}, fileName = FILE_NAME) {
  return persist.upsertDirectorate(database, {
    districtName,
    governorate,
    values: completeValues({ districtName, governorate, ...overrides }),
    rawValues: {},
    sources: {},
  }, { fileName, sheetName: SHEET_NAME });
}

test('a complete row plans as a ready create and bumps the create/ready scope', () => {
  const { database, directory } = openTestDatabase();
  try {
    const plan = buildImportPlan(database, readOf([rowOf(2, completeValues())]), { fileName: FILE_NAME });
    const row = plan.rows[0];

    assert.equal(row.status, 'ready');
    assert.equal(row.action, 'create');
    assert.equal(row.duplicateOf, null);
    assert.deepEqual(row.issues, []);
    assert.deepEqual(row.anomalyKeys, []);
    assert.deepEqual(row.changes, []);
    assert.equal(row.completeness.present, MANDATORY_FIELDS.length);
    assert.equal(row.completeness.total, MANDATORY_FIELDS.length);
    assert.equal(row.completeness.ratio, 1);

    assert.equal(plan.scope.create, 1);
    assert.equal(plan.scope.ready, 1);
    assert.equal(plan.scope.review, 0);
    assert.equal(plan.scope.blocked, 0);
    assert.equal(plan.scope.update, 0);
    assert.equal(plan.scope.incomplete, 0);
    assert.equal(plan.fileName, FILE_NAME);
    assert.equal(plan.totalRows, 1);
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('a missing mandatory field yields a review row carrying a missing-mandatory issue', () => {
  const { database, directory } = openTestDatabase();
  try {
    const values = completeValues({ waterCoverage: undefined });
    const plan = buildImportPlan(database, readOf([rowOf(5, values)]), { fileName: FILE_NAME });
    const row = plan.rows[0];

    assert.equal(row.status, 'review');
    assert.equal(row.action, 'create');
    assert.equal(row.completeness.present, MANDATORY_FIELDS.length - 1);
    assert.equal(row.completeness.ratio, (MANDATORY_FIELDS.length - 1) / MANDATORY_FIELDS.length);
    assert.deepEqual(row.completeness.missing, ['waterCoverage']);
    assert.ok(row.completeness.missingLabels.includes('مياه'));

    const issue = row.issues.find((entry) => entry.key === 'waterCoverage');
    assert.ok(issue, 'the missing mandatory field must be reported');
    assert.equal(issue.code, 'missing-mandatory');
    assert.equal(issue.severity, 'warning');
    assert.equal(issue.column, 'L');

    assert.equal(plan.scope.review, 1);
    assert.equal(plan.scope.incomplete, 1);
    assert.equal(plan.scope.ready, 0);
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('an unparsable cell blocks the row and is refused unless forced', () => {
  const { database, directory } = openTestDatabase();
  try {
    const values = completeValues({ schools: undefined });
    const read = readOf([
      rowOf(2, values, { warnings: [{ key: 'schools', code: 'invalid-number', raw: 'غير رقم', value: null }] }),
    ]);
    const plan = buildImportPlan(database, read, { fileName: FILE_NAME });
    const row = plan.rows[0];

    assert.equal(row.status, 'blocked');
    const blocker = row.issues.find((issue) => issue.key === 'schools' && issue.code === 'invalid-number');
    assert.ok(blocker, 'the parser warning must be promoted to an issue');
    assert.equal(blocker.severity, 'blocker');
    assert.equal(blocker.reason, CODE_LABELS['invalid-number']);
    // No duplicate missing-mandatory issue for a key already reported as unparsable.
    assert.equal(row.issues.filter((issue) => issue.code === 'missing-mandatory').length, 0);
    assert.equal(plan.scope.blocked, 1);

    const refusedRun = applyImportPlan(database, plan);
    assert.equal(refusedRun.appliedRows.length, 0);
    assert.equal(refusedRun.created, 0);
    assert.equal(refusedRun.applied, 0);
    assert.equal(refusedRun.refused.length, 1);
    assert.equal(refusedRun.refused[0].rowNumber, 2);
    assert.ok(refusedRun.refused[0].blockers.length >= 1, 'the refusal must name the blockers');
    assert.equal(persist.countDirectorates(database), 0, 'a blocked row must not be written');

    const forcedRun = applyImportPlan(database, plan, { force: true });
    assert.equal(forcedRun.appliedRows.length, 1);
    assert.equal(forcedRun.created, 1);
    assert.equal(forcedRun.refused.length, 0);
    assert.equal(persist.countDirectorates(database), 1);
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('implausible counts are anomalies while currency magnitudes are not', () => {
  const { database, directory } = openTestDatabase();
  try {
    const counts = anomalyKeys({ schools: 250000000 });
    assert.deepEqual(counts, ['schools']);

    const plan = buildImportPlan(database, readOf([
      rowOf(2, completeValues({ districtName: 'مديرية رقمية', schools: 250000000 })),
      rowOf(3, completeValues({ districtName: 'مديرية إيرادات', governorate: 'تعز', revenue: 900000000, projectCost: 4000000000 })),
    ]), { fileName: FILE_NAME });

    const anomalousRow = plan.rows.find((row) => row.rowNumber === 2);
    assert.deepEqual(anomalousRow.anomalyKeys, ['schools']);
    assert.equal(anomalousRow.status, 'review');
    const anomalyIssue = anomalousRow.issues.find((issue) => issue.code === 'anomaly');
    assert.ok(anomalyIssue, 'an anomaly must be surfaced as an issue');

    const currencyRow = plan.rows.find((row) => row.rowNumber === 3);
    assert.deepEqual(currencyRow.anomalyKeys, [], 'currency columns are exempt from the magnitude net');
    assert.ok(!currencyRow.anomalyKeys.includes('revenue'));
    assert.ok(!currencyRow.anomalyKeys.includes('projectCost'));
    assert.equal(currencyRow.status, 'ready');

    assert.equal(plan.scope.anomaly, 1, 'only the anomalous row is counted');
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('a duplicate governorate|district in one file is flagged on the later row only', () => {
  const { database, directory } = openTestDatabase();
  try {
    const plan = buildImportPlan(database, readOf([
      rowOf(2, completeValues({ districtName: 'مديرية مكررة', governorate: 'إب' })),
      rowOf(3, completeValues({ districtName: 'مديرية مكررة', governorate: 'إب', schools: 41 })),
      rowOf(4, completeValues({ districtName: 'مديرية مكررة', governorate: 'تعز' })),
    ]), { fileName: FILE_NAME });

    const first = plan.rows.find((row) => row.rowNumber === 2);
    const second = plan.rows.find((row) => row.rowNumber === 3);
    const otherGovernorate = plan.rows.find((row) => row.rowNumber === 4);

    assert.equal(first.duplicateOf, null);
    assert.equal(second.duplicateOf, 2);
    const duplicate = second.issues.find((issue) => issue.code === 'duplicate-in-file');
    assert.ok(duplicate, 'the second row must carry the duplicate issue');
    assert.equal(duplicate.severity, 'warning');
    assert.equal(second.status, 'review');

    // The same name in a different governorate is a different directorate.
    assert.equal(otherGovernorate.duplicateOf, null);
    assert.equal(otherGovernorate.issues.some((issue) => issue.code === 'duplicate-in-file'), false);
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('a re-import against a stored directorate plans an update with a field-by-field diff', () => {
  const { database, directory } = openTestDatabase();
  try {
    const stored = insertStored(database, 'مديرية محفوظة', 'إب');
    const changed = completeValues({ districtName: 'مديرية محفوظة', governorate: 'إب', schools: 41 });
    const plan = buildImportPlan(database, readOf([rowOf(7, changed)]), { fileName: FILE_NAME });
    const row = plan.rows[0];

    assert.equal(row.action, 'update');
    assert.equal(row.directorateId, stored.id);
    assert.equal(row.changes.length, 1, 'only the one differing field is a change');
    assert.equal(row.changes[0].key, 'schools');
    assert.equal(row.changes[0].before, 40);
    assert.equal(row.changes[0].after, 41);
    assert.equal(plan.scope.update, 1);
    assert.equal(plan.scope.create, 0);

    // An identical re-import is `unchanged`, not a no-op update.
    const same = buildImportPlan(database, readOf([
      rowOf(7, completeValues({ districtName: 'مديرية محفوظة', governorate: 'إب' })),
    ]), { fileName: FILE_NAME });
    assert.equal(same.rows[0].action, 'unchanged');
    assert.deepEqual(same.rows[0].changes, []);
    assert.equal(same.scope.unchanged, 1);
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('applyImportPlan writes the created/updated counts and returns every applied row', () => {
  const { database, directory } = openTestDatabase();
  try {
    const stored = insertStored(database, 'مديرية محفوظة', 'إب');
    const plan = buildImportPlan(database, readOf([
      rowOf(2, completeValues({ districtName: 'مديرية جديدة', governorate: 'صنعاء' })),
      rowOf(3, completeValues({ districtName: 'مديرية محفوظة', governorate: 'إب', schools: 45 })),
    ]), { fileName: FILE_NAME });

    const result = applyImportPlan(database, plan);

    assert.equal(result.fileName, FILE_NAME);
    assert.equal(result.total, 2);
    assert.equal(result.created, 1);
    assert.equal(result.updated, 1);
    assert.equal(result.applied, 2);
    assert.equal(result.appliedRows.length, 2);
    assert.deepEqual(result.refused, []);
    assert.deepEqual(result.skipped, []);

    const createdIds = result.appliedRows.filter((row) => row.created).map((row) => row.directorateId);
    const updatedIds = result.appliedRows.filter((row) => !row.created).map((row) => row.directorateId);
    assert.equal(createdIds.length, 1);
    assert.deepEqual(updatedIds, [stored.id]);
    assert.equal(persist.countDirectorates(database), 2);

    const updated = database.prepare('SELECT schools FROM directorates WHERE id = ?').get(stored.id);
    assert.equal(updated.schools, 45, 'the newer value must win on update');
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('a skip decision leaves the row out of the write and is reported', () => {
  const { database, directory } = openTestDatabase();
  try {
    const plan = buildImportPlan(database, readOf([
      rowOf(2, completeValues({ districtName: 'مديرية متخطاة', governorate: 'صنعاء' })),
      rowOf(3, completeValues({ districtName: 'مديرية مكتوبة', governorate: 'تعز' })),
    ]), { fileName: FILE_NAME });

    const result = applyImportPlan(database, plan, { decisions: { 2: 'skip' } });

    assert.equal(result.skipped.length, 1);
    assert.equal(result.skipped[0].rowNumber, 2);
    assert.equal(result.appliedRows.length, 1);
    assert.equal(result.applied, 1);
    assert.equal(result.created, 1);
    assert.equal(persist.countDirectorates(database), 1);
    assert.equal(
      database.prepare('SELECT COUNT(*) AS c FROM directorates WHERE district = ?').get('مديرية متخطاة').c,
      0,
      'a skipped row must not be written',
    );

    const audit = database.prepare("SELECT detail FROM access_log WHERE action = 'excel-import' ORDER BY id DESC LIMIT 1").get();
    assert.ok(audit, 'the import must append an audit entry');
    assert.match(audit.detail, /skipped=1/);
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('stale rows of the same file are surfaced in the plan and the summary', () => {
  const { database, directory } = openTestDatabase();
  try {
    const staleRecord = insertStored(database, 'مديرية قديمة', 'إب');
    const otherFile = insertStored(database, 'مديرية ملف آخر', 'صنعاء', {}, 'other.xlsx');

    const plan = buildImportPlan(database, readOf([
      rowOf(2, completeValues({ districtName: 'مديرية جديدة', governorate: 'إب' })),
    ]), { fileName: FILE_NAME });

    assert.ok(Array.isArray(plan.stale), 'the plan must expose stale records');
    assert.equal(plan.stale.length, 1);
    assert.equal(plan.stale[0].id, staleRecord.id);
    assert.equal(plan.stale[0].governorate, 'إب');
    assert.equal(plan.stale[0].district, 'مديرية قديمة');
    assert.ok(!plan.stale.some((entry) => entry.id === otherFile.id), 'a different source file is not stale');
    assert.equal(plan.scope.stale, 1);

    const summary = summarizePlan(plan);
    assert.ok(Array.isArray(summary.stale), 'the summary must carry stale too');
    assert.equal(summary.stale.length, 1);
    assert.equal(summary.stale[0].id, staleRecord.id);
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('summarizePlan exposes the banner and preview shape', () => {
  const { database, directory } = openTestDatabase();
  try {
    const plan = buildImportPlan(database, readOf([
      rowOf(2, completeValues()),
      rowOf(3, completeValues({ districtName: 'مديرية ناقصة', waterCoverage: undefined })),
    ]), { fileName: FILE_NAME });

    const summary = summarizePlan(plan);

    assert.equal(summary.fileName, FILE_NAME);
    assert.equal(summary.sheetName, SHEET_NAME);
    assert.equal(summary.headerRow, 2);
    assert.equal(summary.matchedCount, 2);
    assert.equal(summary.totalRows, 2);
    assert.deepEqual(summary.scope, plan.scope);
    assert.ok(Array.isArray(summary.changedFields));
    assert.equal(summary.preview.length, 2);

    assert.equal(summary.preview[0].rowNumber, 2);
    assert.equal(summary.preview[0].status, 'ready');
    assert.ok(Array.isArray(summary.preview[0].issues));
    assert.ok(Array.isArray(summary.preview[0].changes));
    assert.equal(summary.preview[0].completeness.present, MANDATORY_FIELDS.length);

    assert.equal(summary.preview[1].status, 'review');
    assert.equal(summary.preview[1].completeness.present, MANDATORY_FIELDS.length - 1);
    assert.ok(summary.preview[1].issues.some((issue) => issue.code === 'missing-mandatory'));
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
