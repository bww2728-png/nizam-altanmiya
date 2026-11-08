'use strict';

/**
 * End-to-end tests across the Excel-only path: real workbook -> plan -> stored
 * directorates -> the five sheets.
 *
 * The unit-level contracts live in `import-plan.test.cjs` and `sheets.test.cjs`;
 * this file only proves that the pieces agree with each other on a real import,
 * which is where "the dashboard shows numbers from another state of the data"
 * bugs would appear.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { openEncryptedStore } = require('../src/main/store.cjs');
const { buildImportPlan, applyImportPlan } = require('../src/main/analysis/import-plan.cjs');
const { buildSheets } = require('../src/main/analysis/sheets.cjs');
const { readDirectorateWorkbook } = require('../src/main/analysis/template-reader.cjs');

const FIXTURE = path.join(__dirname, 'fixtures', 'template-v3.3.xlsx');

function withDatabase(callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ldi-integration-'));
  const database = openEncryptedStore(path.join(directory, 'integration.db'), `integration-key-${Date.now()}`);
  try {
    return callback(database);
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

/** Every one of the 13 mandatory fields, so a row can be judged complete. */
function completeValues(overrides = {}) {
  return {
    districtName: 'مديرية الشعر',
    governorate: 'إب',
    districtNature: 'جبلية',
    population: 43739,
    migrants: 13122,
    densityPerKm2: 377,
    waterCoverage: 0.197,
    pavedRoads: 0.8,
    revenue: 75643312,
    govFacilities: 11,
    schools: 40,
    agriProduction: 1200,
    valueChains: 3,
    projectCost: 165000000,
    associations: 1,
    goodsTons: 240,
    frontLine: false,
    projectStatus: 'قيد التنفيذ',
    ...overrides,
  };
}

/** Minimal `read` shape that `readDirectorateWorkbook` returns. */
function readOf(rows, extra = {}) {
  return {
    fileName: 'القالب المحدث.xlsx',
    sheetName: 'قاعدة البيانات الشاملة',
    headerRow: 2,
    rows,
    matched: [],
    unmatched: [],
    missingInputs: [],
    duplicates: [],
    warnings: [],
    ...extra,
  };
}

function rowOf(rowNumber, values) {
  return { rowNumber, values, rawValues: {}, sources: {}, warnings: [] };
}

test('the reference workbook survives the full round trip: read, plan, apply, sheets', async () => {
  const read = await readDirectorateWorkbook(FIXTURE);
  assert.equal(read.totalRows, 3);
  assert.equal(read.missingInputs.length, 0, 'every input column of the schema must be matched');

  withDatabase((database) => {
    const plan = buildImportPlan(database, read);
    assert.equal(plan.totalRows, 3);
    assert.equal(plan.matched.length, read.matched.length);

    const applied = applyImportPlan(database, plan);
    assert.equal(applied.created + applied.updated + applied.refused.length + applied.skipped.length, 3);

    const stored = database.prepare('SELECT COUNT(*) AS count FROM directorates').get().count;
    assert.equal(stored, applied.created + applied.updated);

    // A second pass over the same file must not create anything.
    const secondPlan = buildImportPlan(database, read);
    assert.equal(secondPlan.scope.create, 0);
    assert.ok(secondPlan.rows.every((row) => row.action !== 'create'));

    const sheets = buildSheets(database, {});
    assert.equal(sheets.dashboard.totals.directorates, stored);
    assert.equal(sheets.indicators.rows.length, stored);
    assert.equal(sheets.ranking.ranked.length + sheets.ranking.waiting.length + sheets.ranking.anomalies.length, stored);
  });
});

test('an import is immediately visible in the sheets with the same totals', () => {
  withDatabase((database) => {
    const plan = buildImportPlan(database, readOf([
      rowOf(3, completeValues()),
      rowOf(4, completeValues({
        districtName: 'مديرية أزال',
        governorate: 'أمانة العاصمة',
        population: 120000,
        schools: 90,
        revenue: 165000000,
      })),
    ]));
    const applied = applyImportPlan(database, plan);
    assert.equal(applied.created, 2);

    const sheets = buildSheets(database, {});
    assert.equal(sheets.dashboard.totals.directorates, 2);
    assert.equal(sheets.dashboard.totals.governorates, 2);
    assert.equal(sheets.dashboard.totals.population, 43739 + 120000);
    assert.equal(sheets.dashboard.totals.complete, 2);
    assert.equal(sheets.indicators.registry.length, 12);
    for (const indicator of sheets.indicators.registry) {
      assert.ok(sheets.indicators.stats[indicator.code], `stats must exist for ${indicator.code}`);
    }
    assert.equal(sheets.ranking.ranked.length, 2);
    assert.ok(sheets.ranking.ranked[0].composite >= sheets.ranking.ranked[1].composite);
  });
});

test('a stored anomaly leaves the ranking until the cell is corrected and re-imported', () => {
  withDatabase((database) => {
    applyImportPlan(database, buildImportPlan(database, readOf([
      rowOf(3, completeValues({ schools: 75643312 })),
      rowOf(4, completeValues({ districtName: 'مديرية أزال', governorate: 'أمانة العاصمة' })),
    ])));

    const before = buildSheets(database, {}).ranking;
    assert.equal(before.ranked.length, 1);
    assert.equal(before.anomalies.length, 1);
    assert.deepEqual(before.anomalies[0].keys, ['schools']);

    // Correcting the cell and re-importing clears the anomaly without any flag.
    applyImportPlan(database, buildImportPlan(database, readOf([
      rowOf(3, completeValues({ schools: 40 })),
      rowOf(4, completeValues({ districtName: 'مديرية أزال', governorate: 'أمانة العاصمة' })),
    ])));
    const after = buildSheets(database, {}).ranking;
    assert.equal(after.ranked.length, 2);
    assert.equal(after.anomalies.length, 0);
  });
});