'use strict';

/**
 * Contract tests for the derived sheets (dashboard, indicators, ranking) and for
 * the pure `rankableVerdict` rule that decides who may be ranked.
 *
 * Each test owns one temp encrypted database, builds values from
 * `schema.INPUT_FIELDS` by type (never from an Excel fixture) and asserts on
 * documented payload fields only. Where the engine may not publish a composite,
 * the test asserts the exclusion lists by directorateId instead.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3-multiple-ciphers');

const { migrate } = require('../src/main/analysis/store-schema.cjs');
const persist = require('../src/main/analysis/persist.cjs');
const { INPUT_FIELDS, MANDATORY_FIELDS, INDICATORS } = require('../src/main/analysis/schema.cjs');
const { buildSheets, rankableVerdict } = require('../src/main/analysis/sheets.cjs');

function openTestDatabase() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ldi-sheets-'));
  const filePath = path.join(directory, 'test.db');
  const database = new Database(filePath, { timeout: 5000 });
  database.pragma("cipher = 'sqlcipher'");
  database.pragma("key = 'test-key-sheets'");
  database.pragma('foreign_keys = ON');
  database.prepare('SELECT count(*) AS count FROM sqlite_master').get();
  migrate(database);
  return { database, directory, filePath };
}

/** One value per input column, typed exactly as schema.cjs declares it. */
function baseValues(overrides = {}) {
  const values = {};
  for (const field of INPUT_FIELDS) {
    if (field.type === 'number') values[field.key] = 10;
    else if (field.type === 'ratio') values[field.key] = 0.5;
    else if (field.type === 'boolean') values[field.key] = true;
    else values[field.key] = 'x';
  }
  values.districtName = 'مديرية اختبار';
  values.governorate = 'صنعاء';
  return { ...values, ...overrides };
}

function insertStored(database, districtName, governorate, overrides = {}) {
  return persist.upsertDirectorate(database, {
    districtName,
    governorate,
    values: baseValues({ districtName, governorate, ...overrides }),
    rawValues: {},
    sources: {},
  }, { fileName: 'book.xlsx', sheetName: 'قاعدة البيانات الشاملة' });
}

test('the dashboard counts every stored directorate and groups them by governorate', () => {
  const { database, directory } = openTestDatabase();
  try {
    insertStored(database, 'مديرية ألف', 'صنعاء');
    insertStored(database, 'مديرية باء', 'صنعاء');
    insertStored(database, 'مديرية جيم', 'إب');

    const sheets = buildSheets(database, {});
    const totals = sheets.dashboard.totals;

    assert.equal(totals.directorates, 3);
    assert.equal(totals.complete, 3);
    assert.equal(totals.incomplete, 0);
    assert.equal(totals.anomalies, 0);
    assert.equal(totals.governorates, 2);

    const sanaa = sheets.dashboard.governorates.find((entry) => entry.name === 'صنعاء');
    const ib = sheets.dashboard.governorates.find((entry) => entry.name === 'إب');
    assert.ok(sanaa && ib, 'both governorates must appear');
    assert.equal(sanaa.count, 2);
    assert.equal(sanaa.complete, 2);
    assert.equal(ib.count, 1);

    const completeBucket = sheets.dashboard.completenessBuckets.find((bucket) => bucket.key === 'complete');
    assert.equal(completeBucket.count, 3);
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('an incomplete directorate waits for completion and never reaches the ranked list', () => {
  const { database, directory } = openTestDatabase();
  try {
    const complete = insertStored(database, 'مديرية كاملة', 'صنعاء');
    const incomplete = insertStored(database, 'مديرية ناقصة', 'إب', { waterCoverage: undefined });

    const sheets = buildSheets(database, {});

    assert.ok(sheets.ranking.excluded.waiting >= 1);
    const waitingIds = sheets.ranking.waiting.map((entry) => entry.directorateId);
    assert.ok(waitingIds.includes(incomplete.id), 'the incomplete directorate must wait');
    assert.ok(!waitingIds.includes(complete.id), 'a complete directorate is not waiting');

    const waitingEntry = sheets.ranking.waiting.find((entry) => entry.directorateId === incomplete.id);
    assert.ok(waitingEntry.missingLabels.includes('مياه'), 'the missing header must be named');

    const rankedIds = sheets.ranking.ranked.map((entry) => entry.directorateId);
    assert.ok(!rankedIds.includes(incomplete.id), 'an incomplete directorate must never be ranked');
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('an anomalous directorate is counted and excluded instead of silently ranked', () => {
  const { database, directory } = openTestDatabase();
  try {
    insertStored(database, 'مديرية عادية', 'صنعاء');
    const anomaly = insertStored(database, 'مديرية شاذة', 'إب', { population: 250000000 });

    const sheets = buildSheets(database, {});

    assert.ok(sheets.dashboard.totals.anomalies >= 1);
    assert.equal(sheets.ranking.excluded.anomalies, sheets.ranking.anomalies.length);

    const anomalyEntry = sheets.ranking.anomalies.find((entry) => entry.directorateId === anomaly.id);
    assert.ok(anomalyEntry, 'the anomalous directorate must be listed');
    assert.ok(anomalyEntry.keys.includes('population'));

    const rankedIds = sheets.ranking.ranked.map((entry) => entry.directorateId);
    assert.ok(!rankedIds.includes(anomaly.id), 'an anomalous row must stay out of the ranking');
    const waitingIds = sheets.ranking.waiting.map((entry) => entry.directorateId);
    assert.ok(!waitingIds.includes(anomaly.id), 'an anomaly is complete, so it is not waiting on data');
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('the indicators payload covers every stored row and reports present vs missing', () => {
  const { database, directory } = openTestDatabase();
  try {
    insertStored(database, 'مديرية ألف', 'صنعاء');
    insertStored(database, 'مديرية باء', 'صنعاء');
    insertStored(database, 'مديرية جيم', 'إب');

    const sheets = buildSheets(database, {});

    assert.equal(sheets.indicators.registry.length, INDICATORS.length);
    assert.equal(sheets.indicators.rows.length, 3);
    assert.ok(sheets.indicators.rows.every((row) => Number.isInteger(row.directorateId)));

    for (const indicator of INDICATORS) {
      const stats = sheets.indicators.stats[indicator.code];
      assert.ok(stats, `missing stats for ${indicator.code}`);
      assert.equal(stats.count + stats.missing, sheets.indicators.rows.length);
      assert.equal(stats.missing, sheets.indicators.rows.length - stats.count);
    }

    // waterCoverage is present on every row, so its deficit indicator is too.
    assert.equal(sheets.indicators.stats.waterDeficit.count, 3);
    assert.equal(sheets.indicators.stats.waterDeficit.missing, 0);
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('rankableVerdict decides completeness and anomalies from the values alone', () => {
  const completeValues = baseValues();
  const complete = rankableVerdict({ values: completeValues });
  assert.equal(complete.complete, true);
  assert.equal(complete.anomalous, false);
  assert.deepEqual(complete.missingLabels, []);

  const missing = rankableVerdict({ values: baseValues({ waterCoverage: undefined }) });
  assert.equal(missing.complete, false);
  assert.ok(missing.missingLabels.includes('مياه'));

  const anomaly = rankableVerdict({ values: baseValues({ population: 200000000 }) });
  assert.equal(anomaly.anomalous, true);
  assert.deepEqual(anomaly.anomalyKeys, ['population']);
  assert.equal(anomaly.complete, true);

  const bigCurrency = rankableVerdict({ values: baseValues({ revenue: 900000000 }) });
  assert.equal(bigCurrency.anomalous, false, 'a large revenue is normal, not an anomaly');

  const empty = rankableVerdict({});
  assert.equal(empty.complete, false);
  assert.equal(empty.missingLabels.length, MANDATORY_FIELDS.length);
  assert.equal(empty.anomalous, false);
});

test('an empty database yields empty sheets instead of throwing', () => {
  const { database, directory } = openTestDatabase();
  try {
    const sheets = buildSheets(database, {});

    assert.equal(sheets.dashboard.totals.directorates, 0);
    assert.equal(sheets.indicators.rows.length, 0);
    assert.equal(sheets.ranking.ranked.length, 0);
    assert.equal(sheets.ranking.waiting.length, 0);
    assert.equal(sheets.ranking.anomalies.length, 0);
    assert.ok(sheets.indicators.registry.length === INDICATORS.length);
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
