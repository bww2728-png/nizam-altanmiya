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

function applyWithAllEligibleReviewed(database, plan, request = {}) {
  const decisions = {};
  for (const row of plan.rows ?? []) {
    if (row.status !== 'blocked' && row.action !== 'unchanged' && row.action !== 'duplicate') {
      decisions[row.rowNumber] = 'apply';
    }
  }
  return applyImportPlan(database, plan, { ...request, decisions: { ...decisions, ...(request.decisions ?? {}) } });
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

test('an unparsable cell blocks the row and needs force plus an explicit decision', () => {
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

    // `force` alone is no longer enough: a blocked row also needs an explicit
    // per-row `apply` decision, so the operator's intent is unambiguous.
    const forcedOnly = applyImportPlan(database, plan, { force: true });
    assert.equal(forcedOnly.appliedRows.length, 0);
    assert.equal(forcedOnly.created, 0);
    assert.equal(forcedOnly.skipped.length, 1);
    assert.equal(persist.countDirectorates(database), 0, 'force without a decision must not write');

    const forcedRun = applyImportPlan(database, plan, { force: true, decisions: { 2: 'apply' } });
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

test('applyImportPlan collapses in-file duplicates and skips unchanged rows', () => {
  const { database, directory } = openTestDatabase();
  try {
    insertStored(database, 'مديرية محفوظة', 'إب');
    const plan = buildImportPlan(database, readOf([
      rowOf(2, completeValues({ districtName: 'مديرية مكررة', governorate: 'إب' })),
      rowOf(3, completeValues({ districtName: 'مديرية مكررة', governorate: 'إب', schools: 41 })),
      rowOf(4, completeValues({ districtName: 'مديرية محفوظة', governorate: 'إب' })),
    ]), { fileName: FILE_NAME });

    const result = applyWithAllEligibleReviewed(database, plan);

    assert.equal(result.applied, 1, 'only the first non-duplicate, non-unchanged row is written');
    assert.equal(result.created, 1);
    assert.equal(result.duplicates.length, 1, 'the later duplicate is reported, never written');
    assert.equal(result.duplicates[0].rowNumber, 3);
    assert.equal(result.unchanged, 1);
    assert.equal(persist.countDirectorates(database), 2, 'stored row plus the new one, no duplicate');
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('a row without an identity can never be written, even with force and a decision', () => {
  const { database, directory } = openTestDatabase();
  try {
    const plan = buildImportPlan(database, readOf([
      rowOf(2, completeValues({ districtName: '', governorate: '' })),
    ]), { fileName: FILE_NAME });
    const row = plan.rows[0];

    assert.equal(row.status, 'blocked');
    assert.equal(row.action, 'blocked');
    assert.ok(row.issues.some((issue) => issue.code === 'missing-identity' && issue.severity === 'blocker'));

    const result = applyImportPlan(database, plan, { force: true, decisions: { 2: 'apply' } });
    assert.equal(result.applied, 0);
    assert.equal(result.created, 0);
    assert.equal(result.skipped.length, 1);
    assert.equal(persist.countDirectorates(database), 0);
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('the anomaly threshold is exclusive at 1e7 and currency fields are exempt', () => {
  assert.deepEqual(anomalyKeys({ schools: 1e7 }), []);
  assert.deepEqual(anomalyKeys({ schools: 1e7 + 1 }), ['schools']);
  assert.deepEqual(anomalyKeys({ revenue: 9e9, projectCost: 4e9 }), []);
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

    const result = applyWithAllEligibleReviewed(database, plan);

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

test('applyImportPlan stores the parser warnings on each written row', () => {
  const { database, directory } = openTestDatabase();
  try {
    const plan = buildImportPlan(database, readOf([
      rowOf(2, completeValues({ districtName: 'مديرية بتحذير', governorate: 'إب' }), {
        warnings: [{ key: 'schools', code: 'placeholder', raw: 'لا يوجد', value: null }],
      }),
    ]), { fileName: FILE_NAME });

    const result = applyWithAllEligibleReviewed(database, plan);
    assert.equal(result.applied, 1);

    const stored = database
      .prepare('SELECT import_warnings FROM directorates WHERE district = ?')
      .get('مديرية بتحذير');
    // The raw parser warnings are stored verbatim: the quality report (gaps)
    // reads this column with the parser's own field names.
    assert.deepEqual(JSON.parse(stored.import_warnings), [
      { key: 'schools', code: 'placeholder', raw: 'لا يوجد', value: null },
    ]);

    const listed = persist.loadAnalysisRows(database).find((row) => row.districtName === 'مديرية بتحذير');
    assert.deepEqual(listed.warnings, [
      { key: 'schools', code: 'placeholder', raw: 'لا يوجد', value: null },
    ], 'loadAnalysisRows surfaces the stored warnings');
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('an explicit zero in the file is a change over a stored empty cell, not an unchanged skip', () => {
  const { database, directory } = openTestDatabase();
  try {
    // The stored row has no schools value (NULL), the file carries an explicit 0.
    insertStored(database, 'مديرية صفرية', 'إب', { schools: null });
    const plan = buildImportPlan(database, readOf([
      rowOf(2, completeValues({ districtName: 'مديرية صفرية', governorate: 'إب', schools: 0 })),
    ]), { fileName: FILE_NAME });

    const row = plan.rows[0];
    assert.equal(row.action, 'update', 'NULL -> 0 is an update, not unchanged');
    assert.ok(row.changes.some((change) => change.key === 'schools'));

    const result = applyWithAllEligibleReviewed(database, plan);
    assert.equal(result.updated, 1);
    assert.equal(result.unchanged, 0);

    const stored = database.prepare('SELECT schools FROM directorates WHERE district = ?').get('مديرية صفرية');
    assert.equal(stored.schools, 0, 'the explicit zero must reach the database');
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('a plan is rejected when the database changes after review', () => {
  const { database, directory } = openTestDatabase();
  try {
    const stored = insertStored(database, 'مديرية متزامنة', 'إب', { schools: 40 });
    const plan = buildImportPlan(database, readOf([
      rowOf(2, completeValues({ districtName: 'مديرية متزامنة', governorate: 'إب', schools: 41 })),
    ]), { fileName: FILE_NAME });
    assert.equal(plan.rows[0].action, 'update');

    // Simulate a manual correction or another trusted writer after the reviewer
    // inspected the plan but before they pressed Apply.
    persist.upsertDirectorate(database, {
      districtName: 'مديرية متزامنة',
      governorate: 'إب',
      values: completeValues({ districtName: 'مديرية متزامنة', governorate: 'إب', schools: 55 }),
      rawValues: {},
      sources: {},
    }, { fileName: 'manual-entry', sheetName: null });

    assert.throws(
      () => applyWithAllEligibleReviewed(database, plan),
      /تغيرت البيانات المعتمدة بعد فحص الملف/
    );
    const current = database.prepare('SELECT schools FROM directorates WHERE id = ?').get(stored.id);
    assert.equal(current.schools, 55, 'the new manual value must never be overwritten by the stale plan');
    assert.equal(persist.countDirectorates(database), 1);
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('hidden rows and cached-formula values require manual review and are not bulk-approved', () => {
  const { database, directory } = openTestDatabase();
  try {
    const plan = buildImportPlan(database, readOf([
      rowOf(7, completeValues(), {
        warnings: [
          { key: null, code: 'hidden-row', raw: '', value: null },
          { key: 'population', code: 'formula-cell', raw: '=1000*40', value: 43739 },
        ],
      }),
    ]), { fileName: FILE_NAME });

    const row = plan.rows[0];
    assert.equal(row.status, 'review');
    for (const code of ['hidden-row', 'formula-cell']) {
      const issue = row.issues.find((item) => item.code === code);
      assert.ok(issue, `missing review issue ${code}`);
      assert.equal(issue.severity, 'warning');
    }

    const result = applyImportPlan(database, plan);
    assert.equal(result.applied, 0);
    assert.equal(result.created, 0);
    assert.equal(result.skipped.length, 1);
    assert.equal(persist.countDirectorates(database), 0);
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('unreviewed create/update rows are skipped and only explicit approvals are written', () => {
  const { database, directory } = openTestDatabase();
  try {
    const plan = buildImportPlan(database, readOf([
      rowOf(2, completeValues({ districtName: 'مديرية معتمدة', governorate: 'صنعاء' })),
      rowOf(3, completeValues({ districtName: 'مديرية غير مراجعة', governorate: 'تعز' })),
    ]), { fileName: FILE_NAME });

    const result = applyImportPlan(database, plan, { decisions: { 2: 'apply' } });

    assert.equal(result.applied, 1);
    assert.equal(result.created, 1);
    assert.equal(result.skipped.length, 1);
    assert.equal(result.skipped[0].rowNumber, 3);
    assert.match(result.skipped[0].reason, /اعتماد صريح/);
    assert.equal(database.prepare('SELECT COUNT(*) AS c FROM directorates WHERE district = ?').get('مديرية معتمدة').c, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS c FROM directorates WHERE district = ?').get('مديرية غير مراجعة').c, 0);
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

    const result = applyImportPlan(database, plan, { decisions: { 2: 'skip', 3: 'apply' } });

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

test('CR-1 a missing governorate or district is blocked as missing-identity and never a create', () => {
  const { database, directory } = openTestDatabase();
  try {
    const plan = buildImportPlan(database, readOf([
      rowOf(2, completeValues({ governorate: '' })),
      rowOf(3, completeValues({ districtName: '' })),
    ]), { fileName: FILE_NAME });

    for (const row of plan.rows) {
      assert.equal(row.status, 'blocked');
      assert.equal(row.action, 'blocked');
      assert.notEqual(row.action, 'create');

      const issue = row.issues.find((entry) => entry.code === 'missing-identity');
      assert.ok(issue, 'the missing half of the identity must be reported');
      assert.equal(issue.severity, 'blocker');
      assert.equal(issue.reason, `حقل الهوية مفقود: ${issue.header}`);
    }

    assert.equal(plan.scope.blocked, 2);
    assert.equal(plan.scope.create, 0, 'a row without an identity is never counted as a create');

    const summary = summarizePlan(plan);
    assert.equal(summary.scope.create, 0, 'the summary scope must not count a create either');
    assert.equal(summary.scope.blocked, 2);
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('CR-2 unchanged rows are not written, not counted as updates, and counted as unchanged', () => {
  const { database, directory } = openTestDatabase();
  try {
    const unchangedRecord = insertStored(database, 'مديرية ثابتة', 'إب');
    const updatedRecord = insertStored(database, 'مديرية متغيرة', 'تعز');

    const plan = buildImportPlan(database, readOf([
      rowOf(2, completeValues({ districtName: 'مديرية ثابتة', governorate: 'إب' })),
      rowOf(3, completeValues({ districtName: 'مديرية متغيرة', governorate: 'تعز', schools: 99 })),
    ]), { fileName: FILE_NAME });

    assert.equal(plan.rows[0].action, 'unchanged');
    assert.equal(plan.rows[1].action, 'update');
    assert.equal(plan.scope.unchanged, 1);
    assert.equal(plan.scope.update, 1);

    const result = applyWithAllEligibleReviewed(database, plan);
    assert.equal(result.unchanged, 1, 'the identical row is reported as unchanged');
    assert.equal(result.updated, 1, 'only the real update is counted as updated');
    assert.equal(result.created, 0);
    assert.equal(result.applied, 1);
    assert.equal(result.appliedRows.length, 1);
    assert.equal(result.appliedRows[0].directorateId, updatedRecord.id);
    assert.equal(persist.countDirectorates(database), 2, 'the unchanged row is never re-inserted');

    const kept = database.prepare('SELECT schools FROM directorates WHERE id = ?').get(unchangedRecord.id);
    assert.equal(kept.schools, 40, 'the stored value of an unchanged row is untouched');
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('CR-4 applyImportPlan writes exactly one excel-import audit row per transaction', () => {
  const { database, directory } = openTestDatabase();
  try {
    const countLogs = () => database.prepare("SELECT COUNT(*) AS c FROM access_log WHERE action = 'excel-import'").get().c;
    const before = countLogs();

    const plan = buildImportPlan(database, readOf([
      rowOf(2, completeValues({ districtName: 'مديرية مدققة', governorate: 'صنعاء' })),
    ]), { fileName: FILE_NAME });
    const result = applyWithAllEligibleReviewed(database, plan);

    assert.equal(result.created, 1);
    assert.equal(countLogs(), before + 1, 'exactly one excel-import audit row per apply');

    const entry = database.prepare("SELECT * FROM access_log WHERE action = 'excel-import' ORDER BY id DESC LIMIT 1").get();
    assert.equal(entry.entity, 'directorates');
    assert.equal(entry.entity_id, FILE_NAME);
    assert.match(entry.detail, /created=1;updated=0/);
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('CR-4 a mid-apply failure rolls back both the data and its audit entry', () => {
  const { database, directory } = openTestDatabase();
  const originalUpsert = persist.upsertDirectorate;
  const countLogs = () => database.prepare("SELECT COUNT(*) AS c FROM access_log WHERE action = 'excel-import'").get().c;
  const before = countLogs();
  try {
    const plan = buildImportPlan(database, readOf([
      rowOf(2, completeValues({ districtName: 'مديرية أولى', governorate: 'صنعاء' })),
      rowOf(3, completeValues({ districtName: 'مديرية ثانية', governorate: 'تعز' })),
    ]), { fileName: FILE_NAME });

    // `applyImportPlan` requires persist at call time, so patching the cached
    // module injects a failure on the second write without touching the source.
    let calls = 0;
    persist.upsertDirectorate = (...args) => {
      calls += 1;
      if (calls === 2) throw new Error('injected failure');
      return originalUpsert(...args);
    };

    assert.throws(() => applyWithAllEligibleReviewed(database, plan), /injected failure/);
    assert.equal(persist.countDirectorates(database), 0, 'the first insert rolls back with the failure');
    assert.equal(countLogs(), before, 'no audit entry may survive a rolled-back import');
  } finally {
    persist.upsertDirectorate = originalUpsert;
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('CR-5 only the first of several intra-file duplicates is applied and created once', () => {
  const { database, directory } = openTestDatabase();
  try {
    const plan = buildImportPlan(database, readOf([
      rowOf(2, completeValues({ districtName: 'مديرية مكررة', governorate: 'إب' })),
      rowOf(3, completeValues({ districtName: 'مديرية مكررة', governorate: 'إب', schools: 41 })),
      rowOf(4, completeValues({ districtName: 'مديرية مكررة', governorate: 'إب', schools: 42 })),
    ]), { fileName: FILE_NAME });

    assert.equal(plan.rows[0].action, 'create');
    assert.equal(plan.rows[1].action, 'duplicate');
    assert.equal(plan.rows[2].action, 'duplicate');
    assert.equal(plan.scope.duplicate, 2);
    assert.equal(plan.scope.create, 1);

    const result = applyWithAllEligibleReviewed(database, plan);
    assert.equal(result.created, 1, 'the duplicate identity is created exactly once');
    assert.equal(result.applied, 1);
    assert.equal(result.duplicates.length, 2);
    assert.deepEqual(result.duplicates.map((entry) => entry.rowNumber), [3, 4]);
    assert.equal(result.duplicates[0].duplicateOf, 2);
    assert.equal(persist.countDirectorates(database), 1);

    const stored = database.prepare('SELECT schools FROM directorates WHERE district = ?').get('مديرية مكررة');
    assert.equal(stored.schools, 40, 'the first occurrence wins, not the last');
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
