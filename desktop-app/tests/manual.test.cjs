'use strict';

/**
 * Manual data-entry contract: create / update / delete must store the same
 * typed values a workbook import would produce, keep provenance and the audit
 * trail truthful, and refuse anything that would corrupt the identity key.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3-multiple-ciphers');

const { migrate } = require('../src/main/analysis/store-schema.cjs');
const persist = require('../src/main/analysis/persist.cjs');
const { readDirectorateWorkbook } = require('../src/main/analysis/template-reader.cjs');

const FIXTURE = path.join(__dirname, 'fixtures', 'template-v3.3.xlsx');

function openTestDatabase() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ldi-manual-'));
  const filePath = path.join(directory, 'test.db');
  const database = new Database(filePath, { timeout: 5000 });
  database.pragma("cipher = 'sqlcipher'");
  database.pragma("key = 'test-key-manual-entry'");
  database.pragma('foreign_keys = ON');
  database.prepare('SELECT count(*) AS count FROM sqlite_master').get();
  migrate(database);
  return { database, directory };
}

function close(database, directory) {
  database.close();
  fs.rmSync(directory, { recursive: true, force: true });
}

test('manual create stores typed values, provenance and an audit entry', () => {
  const { database, directory } = openTestDatabase();
  try {
    const result = persist.saveManualDirectorate(database, {
      districtName: 'مديرية اختبار',
      governorate: 'إب',
      values: {
        districtNature: 'ريفية',
        population: '43,739',
        waterCoverage: '19.7%',
        povertyRatio: '55',
        frontLine: 'نعم',
      },
    });

    assert.equal(result.created, true);
    const row = persist.getDirectorate(database, result.id);
    assert.equal(row.district, 'مديرية اختبار');
    assert.equal(row.governorate, 'إب');
    assert.equal(row.nature, 'ريفية');
    assert.equal(row.population, 43739);
    assert.ok(Math.abs(row.water_coverage - 0.197) < 1e-12, 'percent input must be stored as a 0..1 ratio');
    assert.ok(Math.abs(row.poverty_ratio - 0.55) < 1e-12, 'a bare percentage above 1 must be converted');
    assert.equal(row.front_line, 1);
    assert.equal(row.source_file, persist.MANUAL_SOURCE);

    const source = database
      .prepare('SELECT value_text, source_file FROM directorate_sources WHERE directorate_id = ? AND field_key = ?')
      .get(result.id, 'waterCoverage');
    assert.equal(source.value_text, '19.7%');
    assert.equal(source.source_file, persist.MANUAL_SOURCE);

    const log = database.prepare("SELECT action, entity_id FROM access_log WHERE action = 'manual-create'").get();
    assert.ok(log, 'manual-create must be written to the access log');
    assert.equal(log.entity_id, String(result.id));

    const rows = persist.loadAnalysisRows(database);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].districtName, 'مديرية اختبار');
    assert.equal(rows[0].values.population, 43739);
  } finally {
    close(database, directory);
  }
});

test('manual update replaces provided values and clears an explicitly empty field', () => {
  const { database, directory } = openTestDatabase();
  try {
    const created = persist.saveManualDirectorate(database, {
      districtName: 'مديرية تحديث',
      governorate: 'تعز',
      values: { population: '1000', waterCoverage: '0.5', frontLine: 'نعم' },
    });

    const updated = persist.saveManualDirectorate(database, {
      id: created.id,
      districtName: 'مديرية تحديث',
      governorate: 'تعز',
      values: { population: '', waterCoverage: '0.8', frontLine: 'لا' },
    });

    assert.equal(updated.created, false);
    const row = persist.getDirectorate(database, created.id);
    assert.equal(row.population, null, 'an empty input must clear the stored value');
    assert.ok(Math.abs(row.water_coverage - 0.8) < 1e-12);
    assert.equal(row.front_line, 0);
    assert.equal(persist.countDirectorates(database), 1, 'updating must not create a second row');

    const clearedSource = database
      .prepare('SELECT 1 AS present FROM directorate_sources WHERE directorate_id = ? AND field_key = ?')
      .get(created.id, 'population');
    assert.equal(clearedSource, undefined, 'clearing a value must remove its stale provenance row');

    const log = database.prepare("SELECT action FROM access_log WHERE action = 'manual-update'").get();
    assert.ok(log);
  } finally {
    close(database, directory);
  }
});

test('manual entry refuses invalid types, empty identity and duplicates', () => {
  const { database, directory } = openTestDatabase();
  try {
    assert.throws(
      () => persist.saveManualDirectorate(database, { districtName: 'بلا محافظة', values: { waterCoverage: '150' } }),
      /قيم غير صالحة/,
      'a ratio above 100% must be rejected',
    );
    assert.throws(
      () => persist.saveManualDirectorate(database, { districtName: '   ' }),
      /اسم المديرية مطلوب/,
    );

    persist.saveManualDirectorate(database, { districtName: 'مكرّرة', governorate: 'صنعاء' });
    assert.throws(
      () => persist.saveManualDirectorate(database, { districtName: 'مكرّرة', governorate: 'صنعاء' }),
      /توجد مديرية مسجّلة/,
      'creating the same identity twice must be refused instead of merged',
    );

    const second = persist.saveManualDirectorate(database, { districtName: 'ثانية', governorate: 'صنعاء' });
    assert.throws(
      () => persist.saveManualDirectorate(database, { id: second.id, districtName: 'مكرّرة', governorate: 'صنعاء' }),
      /توجد مديرية أخرى/,
      'renaming onto an existing identity must be refused',
    );

    assert.equal(persist.countDirectorates(database), 2);
  } finally {
    close(database, directory);
  }
});

test('manual delete removes the record, its provenance and logs the action', () => {
  const { database, directory } = openTestDatabase();
  try {
    const created = persist.saveManualDirectorate(database, {
      districtName: 'للحذف',
      governorate: 'حجة',
      values: { population: '10' },
    });

    const removed = persist.deleteDirectorate(database, created.id);
    assert.equal(removed.district, 'للحذف');
    assert.equal(persist.countDirectorates(database), 0);

    const sources = database.prepare('SELECT COUNT(*) AS count FROM directorate_sources').get();
    assert.equal(sources.count, 0, 'provenance rows must be deleted with the directorate');
    const log = database.prepare("SELECT action FROM access_log WHERE action = 'manual-delete'").get();
    assert.ok(log);

    assert.throws(() => persist.deleteDirectorate(database, created.id), /غير موجودة/);
    assert.throws(() => persist.deleteDirectorate(database, 'abc'), /معرّف المديرية غير صالح/);
  } finally {
    close(database, directory);
  }
});

test('normalizeManualValues omits absent keys so partial updates stay safe', () => {
  const { clean, issues } = persist.normalizeManualValues({ population: 5 });
  assert.equal(clean.population, 5);
  assert.equal(Object.prototype.hasOwnProperty.call(clean, 'waterCoverage'), false);
  assert.equal(issues.length, 0);

  const invalid = persist.normalizeManualValues({ frontLine: 'ربما' });
  assert.equal(invalid.issues.length, 1);
  assert.equal(invalid.issues[0].key, 'frontLine');
});

test('re-importing the template does not erase a value entered manually', async () => {
  const { database, directory } = openTestDatabase();
  try {
    const first = await readDirectorateWorkbook(FIXTURE);
    persist.upsertDirectorates(database, first);
    const shaar = database.prepare("SELECT id FROM directorates WHERE district = 'مديرية الشعر'").get();

    persist.saveManualDirectorate(database, {
      id: shaar.id,
      districtName: 'مديرية الشعر',
      governorate: 'إب',
      values: { frontLine: 'نعم' },
    });

    const second = await readDirectorateWorkbook(FIXTURE);
    persist.upsertDirectorates(database, second);

    const row = persist.getDirectorate(database, shaar.id);
    assert.equal(row.front_line, 1, 'an empty Excel cell must not clear a manually stored value');
  } finally {
    close(database, directory);
  }
});

test('renaming detaches the record from the workbook and refreshes identity provenance', async () => {
  const { database, directory } = openTestDatabase();
  try {
    const read = await readDirectorateWorkbook(FIXTURE);
    persist.upsertDirectorates(database, read);
    const shaar = database.prepare("SELECT id FROM directorates WHERE district = 'مديرية الشعر'").get();
    assert.equal(persist.getDirectorate(database, shaar.id).source_file, 'template-v3.3.xlsx');

    persist.saveManualDirectorate(database, {
      id: shaar.id,
      districtName: 'مديرية الشعر الجديدة',
      governorate: 'إب',
    });

    const row = persist.getDirectorate(database, shaar.id);
    assert.equal(row.district, 'مديرية الشعر الجديدة');
    assert.equal(row.source_file, persist.MANUAL_SOURCE, 'a renamed record must no longer claim the workbook');
    assert.equal(row.source_sheet, persist.MANUAL_SOURCE);

    const provenance = database
      .prepare("SELECT value_text, source_file FROM directorate_sources WHERE directorate_id = ? AND field_key = 'districtName'")
      .get(shaar.id);
    assert.equal(provenance.value_text, 'مديرية الشعر الجديدة');
    assert.equal(provenance.source_file, persist.MANUAL_SOURCE);
  } finally {
    close(database, directory);
  }
});

test('deleting detaches historical analysis results so a reused id cannot inherit them', () => {
  const { database, directory } = openTestDatabase();
  try {
    const created = persist.saveManualDirectorate(database, { districtName: 'قبل الحذف', governorate: 'عدن' });
    const runId = Number(database
      .prepare("INSERT INTO analysis_runs (mode, weights_json, row_count, created_at) VALUES ('both', '{}', 1, ?)")
      .run(new Date().toISOString()).lastInsertRowid);
    database
      .prepare('INSERT INTO analysis_results (run_id, directorate_id, district, indicators_json) VALUES (?, ?, ?, ?)')
      .run(runId, created.id, 'قبل الحذف', '{}');

    persist.deleteDirectorate(database, created.id);

    const result = database.prepare('SELECT directorate_id FROM analysis_results WHERE run_id = ?').get(runId);
    assert.equal(result.directorate_id, null, 'historical results must not point at a reusable id');
  } finally {
    close(database, directory);
  }
});

test('ids are validated strictly, including booleans from a raw IPC caller', () => {
  const { database, directory } = openTestDatabase();
  try {
    assert.throws(() => persist.deleteDirectorate(database, true), /معرّف المديرية غير صالح/);
    assert.throws(() => persist.getDirectorate(database, false), /معرّف المديرية غير صالح/);
  } finally {
    close(database, directory);
  }
});