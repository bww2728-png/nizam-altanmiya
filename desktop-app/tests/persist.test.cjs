'use strict';

/**
 * Round-trip proof: workbook -> database -> engine -> export.
 *
 * The point of this test is that persistence must not change a single number.
 * If a value is lost or coerced on the way into SQLite, the composites in the
 * database run would drift from the workbook run and this test fails.
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
const { analyze } = require('../src/main/analysis/engine.cjs');
const { serializeAnalysis } = require('../src/main/analysis/serialize.cjs');
const { buildAnalysisWorkbook } = require('../src/main/analysis/exporter.cjs');
const { renderReportHtml } = require('../src/main/analysis/pdf.cjs');
const { validateWeights, defaultWeights } = require('../src/main/analysis/composite.cjs');
const { quarantineLegacyDatabase } = require('../src/main/store.cjs');

const FIXTURE = path.join(__dirname, 'fixtures', 'template-v3.3.xlsx');

function openTestDatabase() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ldi-persist-'));
  const filePath = path.join(directory, 'test.db');
  const database = new Database(filePath, { timeout: 5000 });
  database.pragma("cipher = 'sqlcipher'");
  database.pragma("key = 'test-key-round-trip'");
  database.pragma('foreign_keys = ON');
  database.prepare('SELECT count(*) AS count FROM sqlite_master').get();
  migrate(database);
  return { database, directory, filePath };
}

test('workbook values survive the database round trip unchanged', async () => {
  const { database, directory } = openTestDatabase();
  try {
    const read = await readDirectorateWorkbook(FIXTURE);
    const counts = persist.upsertDirectorates(database, read);

    assert.equal(counts.total, 3);
    assert.equal(counts.created, 3);
    assert.equal(persist.countDirectorates(database), 3);

    const rows = persist.loadAnalysisRows(database);
    assert.equal(rows.length, 3);
    const shaar = rows.find((row) => row.districtName === 'مديرية الشعر');
    assert.equal(shaar.governorate, 'إب');
    assert.equal(shaar.values.population, 43739);
    assert.ok(Math.abs(shaar.values.waterCoverage - 0.197) < 1e-12);
    assert.equal(shaar.values.frontLine, null, 'an empty cell must stay null after storage');

    // Provenance is preserved: the cell address of the population value.
    const source = database.prepare(`
      SELECT s.value_text, s.source_location
      FROM directorate_sources s JOIN directorates d ON d.id = s.directorate_id
      WHERE d.district = ? AND s.field_key = 'population'
    `).get('مديرية الشعر');
    assert.equal(source.source_location, 'C3');

    // Re-importing the same file updates instead of duplicating.
    const again = persist.upsertDirectorates(database, read);
    assert.equal(again.created, 0);
    assert.equal(again.updated, 3);
    assert.equal(persist.countDirectorates(database), 3);
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('a run saved from the database reproduces the workbook composites', async () => {
  const { database, directory } = openTestDatabase();
  try {
    const read = await readDirectorateWorkbook(FIXTURE);
    persist.upsertDirectorates(database, read);

    const fromFile = analyze(read.rows, { kThreshold: 4, deprivationLine: 0.6 });
    const fromDatabase = analyze(persist.loadAnalysisRows(database), { kThreshold: 4, deprivationLine: 0.6 });

    const byName = new Map(fromDatabase.rows.map((row) => [row.districtName, row]));
    for (const row of fromFile.rows) {
      const stored = byName.get(row.districtName);
      assert.ok(stored, `missing ${row.districtName}`);
      assert.ok(Math.abs(stored.replica.composite - row.replica.composite) < 1e-12, `replica drift for ${row.districtName}`);
      assert.equal(stored.completeness.ratio, row.completeness.ratio);
      assert.equal(stored.project.label, row.project.label);
      if (row.calibrated.composite === null) assert.equal(stored.calibrated.composite, null);
      else assert.ok(Math.abs(stored.calibrated.composite - row.calibrated.composite) < 1e-12, `calibrated drift for ${row.districtName}`);
    }

    const saved = persist.saveRun(database, fromDatabase, { templateFile: FIXTURE, templateSheet: read.sheetName });
    assert.equal(saved.results, 3);

    const latest = persist.getLatestRun(database);
    assert.ok(latest);
    assert.equal(latest.results.length, 3);
    assert.equal(latest.run.rowCount, 3);
    assert.equal(latest.run.kThreshold, 4);
    assert.equal(latest.run.weights.waterDeficit, 0.15);

    const shaar = latest.results.find((result) => result.districtName === 'مديرية الشعر');
    assert.ok(Math.abs(shaar.replica.composite - 0.2) < 1e-12);
    assert.equal(shaar.indicators.waterDeficit, 80.3);
    assert.equal(shaar.confidenceLevel, 'preliminary');
    assert.ok(Array.isArray(shaar.gaps));

    // The audit trail records the import and the run.
    const audit = persist.listAccess(database, 20);
    assert.ok(audit.some((entry) => entry.action === 'import'));
    assert.ok(audit.some((entry) => entry.action === 'analysis-run'));
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('weights are versioned and only one row stays active', () => {
  const { database, directory } = openTestDatabase();
  try {
    assert.equal(persist.getWeights(database), null);
    const first = persist.setWeights(database, { waterDeficit: 0.5 }, 'أول تجربة');
    assert.equal(first.active, undefined);
    persist.setWeights(database, { waterDeficit: 0.6 }, 'ثاني تجربة');
    const active = persist.getWeights(database);
    assert.equal(active.weights.waterDeficit, 0.6);
    const history = persist.listWeights(database);
    assert.equal(history.length, 2);
    assert.equal(history.filter((row) => row.active).length, 1);
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('serialized analysis crosses the IPC boundary as plain data', async () => {
  const read = await readDirectorateWorkbook(FIXTURE);
  const analysis = analyze(read.rows);
  const payload = serializeAnalysis(analysis);

  // Structured-clone simulation: JSON must round-trip and Maps must be gone.
  const clone = JSON.parse(JSON.stringify(payload));
  assert.equal(clone.rows.length, 3);
  assert.equal(clone.ranking.replica.ranked.length, 0);
  assert.equal(clone.ranking.replica.waiting.length, 3);
  assert.equal(clone.gaps.perRow.length, 3);
  assert.ok(clone.summary.rows === 3);
  assert.equal(typeof clone.rows[0].completeness.ratio, 'number');
  assert.ok(Array.isArray(clone.sensitivity.weight.perRow));
});

test('the Excel export contains the data sheet, the analysis sheets and the methodology', async () => {
  const ExcelJS = require('exceljs');
  const read = await readDirectorateWorkbook(FIXTURE);
  const analysis = analyze(read.rows);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ldi-xlsx-'));
  const filePath = path.join(directory, 'out.xlsx');
  try {
    const workbook = await buildAnalysisWorkbook(analysis, { audit: [] });
    await workbook.xlsx.writeFile(filePath);

    const reopened = new ExcelJS.Workbook();
    await reopened.xlsx.readFile(filePath);
    const names = reopened.worksheets.map((sheet) => sheet.name);
    for (const expected of [
      'قاعدة البيانات الشاملة',
      'الترتيب والأولويات',
      'قيم شاذة',
      'فجوات البيانات',
      'استقرار الترتيب',
      'المنهجية والأوزان',
      'بيانات الإصدار',
      'سجل التدقيق',
    ]) {
      assert.ok(names.includes(expected), `missing sheet: ${expected}`);
    }
    assert.equal(names.length, 8, 'the export carries exactly eight sheets');

    const data = reopened.getWorksheet('قاعدة البيانات الشاملة');
    assert.equal(data.getRow(1).getCell(1).value, 'اسم المديرية');
    assert.equal(data.getRow(2).getCell(1).value, 'مديرية الشعر');
    // AZ (52) is the priority index; BG (59) keeps the weighted composite so the
    // two paths can be compared without leaving the sheet.
    assert.equal(data.getRow(1).getCell(52).value, 'مؤشر الأولوية');
    assert.equal(data.getRow(1).getCell(59).value, 'المؤشر المرجّح المباشر');
    assert.ok(Math.abs(data.getRow(2).getCell(59).value - 0.2) < 1e-12);

    // Official wording: the export never names its input workbook.
    const headerRow = data.getRow(1);
    for (let column = 1; column <= headerRow.cellCount; column += 1) {
      const header = String(headerRow.getCell(column).value ?? '');
      assert.ok(!header.includes('القالب'), `header leaks the input workbook name: ${header}`);
      assert.ok(!header.includes('مطابقة'), `header leaks the legacy wording: ${header}`);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('the audit sheet blanks file identities but keeps numeric entity ids', async () => {
  const read = await readDirectorateWorkbook(FIXTURE);
  const analysis = analyze(read.rows);
  const workbook = await buildAnalysisWorkbook(analysis, {
    audit: [
      { id: 1, action: 'excel-scan', entity: 'workbook', entity_id: 'C:\\data\\القالب المحدث.xlsx', detail: '', created_at: 't' },
      { id: 2, action: 'excel-import', entity: 'directorates', entity_id: 'القالب المحدث.xlsx', detail: '', created_at: 't' },
      { id: 3, action: 'edit', entity: 'directorates', entity_id: '7', detail: '', created_at: 't' },
    ],
  });

  const sheet = workbook.getWorksheet('سجل التدقيق');
  // Column 4 is «المعرّف» (entity_id); data starts at row 2.
  assert.equal(sheet.getRow(2).getCell(4).value, '—', 'a workbook path is blanked');
  assert.equal(sheet.getRow(3).getCell(4).value, '—', 'an import entity_id that is a file name is blanked');
  assert.equal(String(sheet.getRow(4).getCell(4).value), '7', 'a numeric entity id is kept');
});

test('renderer indicator metadata matches the engine schema', async () => {
  const { INDICATORS_META } = await import('../src/renderer/lib/indicatorsMeta.mjs');
  const { INDICATORS } = require('../src/main/analysis/schema.cjs');

  assert.equal(INDICATORS_META.length, INDICATORS.length);
  INDICATORS.forEach((indicator, index) => {
    assert.equal(INDICATORS_META[index].code, indicator.code, `code drift at ${index}`);
    assert.equal(INDICATORS_META[index].excel, indicator.excel, `column drift for ${indicator.code}`);
    assert.equal(INDICATORS_META[index].header, indicator.header, `header drift for ${indicator.code}`);
    assert.equal(INDICATORS_META[index].direction, indicator.direction, `direction drift for ${indicator.code}`);
  });
});

test('the PDF report HTML is RTL, complete and escapes user text', async () => {
  const read = await readDirectorateWorkbook(FIXTURE);
  const analysis = analyze(read.rows);
  const html = renderReportHtml(analysis);

  assert.match(html, /dir="rtl"/);
  assert.match(html, /تقرير تحليل وترتيب أولويات التنمية/);
  assert.match(html, /مديرية الشعر/);
  assert.match(html, /حرمان حاد|محجوبة/);
  assert.ok(!html.includes('<script'), 'no script tags in the generated report');
  assert.match(html, /Content-Security-Policy/, 'the report must carry a CSP');
  assert.ok(!html.includes('القالب'), 'the report must not name its input workbook');
  assert.match(html, /مقارنة المسارين/, 'the two analytical paths must be shown side by side');
  assert.match(html, /خط الحرمان/, 'the methodology section must state the deprivation line');
});

test('a saved run preserves the blocked verdict and the missing-field list', async () => {
  const { database, directory } = openTestDatabase();
  try {
    const read = await readDirectorateWorkbook(FIXTURE);
    persist.upsertDirectorates(database, read);
    const analysis = analyze(persist.loadAnalysisRows(database), { kThreshold: 4, deprivationLine: 0.6 });
    const saved = persist.saveRun(database, analysis, { mode: 'both' });

    const latest = persist.getLatestRun(database);
    assert.equal(persist.getRun(database, saved.runId).results.length, analysis.rows.length, 'runId points at the committed run');
    const inMemoryBlocked = analysis.rows.filter((row) => row.calibrated.blocked).length;
    const storedBlocked = latest.results.filter((result) => result.calibrated.blocked);

    assert.equal(storedBlocked.length, inMemoryBlocked);
    assert.ok(storedBlocked.length >= 1, 'the fixture contains at least one blocked directorate');
    for (const result of storedBlocked) {
      assert.ok(result.calibrated.blockReason, 'a blocked row must carry its reason');
      assert.ok(Array.isArray(result.missingLabels), 'missing-field list must round-trip as an array');
      assert.equal(result.calibrated.composite, null, 'a blocked row has no composite');
    }
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('a run that fails halfway leaves no orphan header or partial results', () => {
  const { database, directory } = openTestDatabase();
  try {
    const base = {
      governorate: 'إب', indicators: {}, completeness: { ratio: 1, missingLabels: [] },
      replica: {}, calibrated: {}, project: {}, confidence: {},
    };
    const broken = { ...base, districtName: 'مديرية تالفة', values: {} };
    // A field value better-sqlite3 cannot bind forces the second INSERT to throw.
    broken.districtName = { toString: () => { throw new Error('bind failure'); } };
    const analysis = {
      meta: { weights: {} }, summary: {}, rows: [{ ...base, districtName: 'مديرية سليمة' }, broken],
      gaps: { recordIssues: new Map() },
    };

    assert.throws(() => persist.saveRun(database, analysis, {}));
    assert.equal(database.prepare('SELECT COUNT(*) AS c FROM analysis_runs').get().c, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS c FROM analysis_results').get().c, 0);
    assert.equal(database.prepare("SELECT COUNT(*) AS c FROM access_log WHERE action = 'analysis-run'").get().c, 0);
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('duplicate directorates inside one file are detected, not merged silently', () => {
  const { database, directory } = openTestDatabase();
  try {
    const read = {
      fileName: 'dup.xlsx',
      sheetName: 'S',
      rows: [
        { rowNumber: 2, districtName: 'مديرية أ', governorate: 'إب', values: { districtName: 'مديرية أ', governorate: 'إب', population: 100 }, rawValues: {}, sources: {} },
        { rowNumber: 3, districtName: 'مديرية أ', governorate: 'إب', values: { districtName: 'مديرية أ', governorate: 'إب', population: 200 }, rawValues: {}, sources: {} },
      ],
    };
    const result = persist.upsertDirectorates(database, read);
    assert.equal(result.total, 2);
    assert.equal(result.created, 1);
    assert.equal(result.updated, 1);
    assert.equal(result.duplicates.length, 1);
    assert.equal(result.duplicates[0].district, 'مديرية أ');
    assert.equal(result.duplicates[0].firstRow, 2);
    assert.equal(result.duplicates[0].repeatedRow, 3);
    assert.equal(persist.countDirectorates(database), 1);
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('an absent field never wipes stored data, an explicit null does', () => {
  const { database, directory } = openTestDatabase();
  try {
    const identity = { districtName: 'مديرية ب', governorate: 'إب' };
    persist.upsertDirectorates(database, {
      fileName: 'a', sheetName: 'S',
      rows: [{ rowNumber: 2, districtName: 'مديرية ب', governorate: 'إب', values: { ...identity, population: 500 }, rawValues: {}, sources: {} }],
    });
    // Second import omits `population` entirely: it must survive untouched.
    persist.upsertDirectorates(database, {
      fileName: 'b', sheetName: 'S',
      rows: [{ rowNumber: 2, districtName: 'مديرية ب', governorate: 'إب', values: { ...identity, migrants: 7 }, rawValues: {}, sources: {} }],
    });
    let row = database.prepare('SELECT population, migrants FROM directorates WHERE district = ?').get('مديرية ب');
    assert.equal(row.population, 500, 'an omitted column must not be cleared');
    assert.equal(row.migrants, 7);

    // An explicit null is an instruction to clear the column.
    persist.upsertDirectorates(database, {
      fileName: 'c', sheetName: 'S',
      rows: [{ rowNumber: 2, districtName: 'مديرية ب', governorate: 'إب', values: { ...identity, population: null }, rawValues: {}, sources: {} }],
    });
    row = database.prepare('SELECT population FROM directorates WHERE district = ?').get('مديرية ب');
    assert.equal(row.population, null, 'an explicit null must clear the column');
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('an empty database yields no analysis rows rather than the first page', () => {
  const { database, directory } = openTestDatabase();
  try {
    assert.deepEqual(persist.loadAnalysisRows(database), []);
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('quarantine moves the SQLite sidecar files with the database', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ldi-quarantine-'));
  try {
    const dbFile = path.join(directory, 'development-data.db');
    fs.writeFileSync(dbFile, 'x');
    fs.writeFileSync(`${dbFile}-journal`, 'journal');
    fs.writeFileSync(`${dbFile}-wal`, 'wal');
    fs.writeFileSync(`${dbFile}-shm`, 'shm');

    const moved = quarantineLegacyDatabase(dbFile);
    assert.ok(moved && fs.existsSync(moved));
    assert.ok(fs.existsSync(`${moved}-journal`), 'journal must follow the database');
    assert.ok(fs.existsSync(`${moved}-wal`), 'wal must follow the database');
    assert.ok(fs.existsSync(`${moved}-shm`), 'shm must follow the database');
    assert.ok(!fs.existsSync(dbFile), 'the original path must be free for the new store');
    assert.ok(!fs.existsSync(`${dbFile}-journal`), 'no orphaned sidecar may remain');
    assert.equal(quarantineLegacyDatabase(dbFile), null, 'quarantine of a missing file is a no-op');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('a weight vector that overshoots unity by 4e-4 is rejected', () => {
  const weights = defaultWeights();
  assert.equal(validateWeights(weights).valid, true);
  const drifted = { ...defaultWeights() };
  drifted.waterDeficit = Number(drifted.waterDeficit) + 0.0004;
  const check = validateWeights(drifted);
  assert.equal(check.valid, false);
  assert.ok(check.errors.some((message) => message.includes('مجموع الأوزان')));
});

test('migration adds the new result columns to an older database and is idempotent', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ldi-migrate-'));
  const filePath = path.join(directory, 'old.db');
  const database = new Database(filePath, { timeout: 5000 });
  try {
    database.pragma("cipher = 'sqlcipher'");
    database.pragma("key = 'test-key-migrate'");
    database.prepare('SELECT count(*) AS count FROM sqlite_master').get();
    // Reproduce the pre-migration shape: no blocked/block_reason/missing_json.
    database.exec(`
      CREATE TABLE analysis_results (
        id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL, directorate_id INTEGER, district TEXT NOT NULL,
        governorate TEXT, indicators_json TEXT NOT NULL, completeness REAL, replica_composite REAL,
        replica_rank INTEGER, calibrated_composite REAL, calibrated_rank INTEGER, degraded_count INTEGER,
        severe INTEGER NOT NULL DEFAULT 0, weight_coverage REAL, sensitivity_json TEXT, project_type TEXT,
        confidence_text TEXT, confidence_level TEXT, gaps_json TEXT
      );
    `);
    database.prepare('INSERT INTO analysis_results (run_id, district, indicators_json, severe) VALUES (?, ?, ?, ?)')
      .run(1, 'مديرية قديمة', '{}', 0);

    migrate(database);
    migrate(database); // must be safe twice

    const columns = new Set(database.prepare('PRAGMA table_info(analysis_results)').all().map((column) => column.name));
    assert.ok(columns.has('blocked'));
    assert.ok(columns.has('block_reason'));
    assert.ok(columns.has('missing_json'));
    const row = database.prepare('SELECT blocked, block_reason, missing_json FROM analysis_results WHERE district = ?').get('مديرية قديمة');
    assert.equal(row.blocked, 0, 'existing rows default to not blocked');
    assert.equal(row.block_reason, null);
    assert.equal(row.missing_json, null);
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('the same district name in two governorates is not a duplicate', () => {
  const { database, directory } = openTestDatabase();
  try {
    const result = persist.upsertDirectorates(database, {
      fileName: 'two-gov.xlsx',
      sheetName: 'S',
      rows: [
        { rowNumber: 2, districtName: 'مديرية أ', governorate: 'إب', values: { districtName: 'مديرية أ', governorate: 'إب' }, rawValues: {}, sources: {} },
        { rowNumber: 3, districtName: 'مديرية أ', governorate: 'تعز', values: { districtName: 'مديرية أ', governorate: 'تعز' }, rawValues: {}, sources: {} },
      ],
    });
    assert.equal(result.duplicates.length, 0, 'a different governorate is a different directorate');
    assert.equal(persist.countDirectorates(database), 2);
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('a failed sidecar move rolls the quarantine back', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ldi-quarantine-rollback-'));
  const dbFile = path.join(directory, 'development-data.db');
  const original = fs.renameSync;
  try {
    fs.writeFileSync(dbFile, 'x');
    fs.writeFileSync(`${dbFile}-journal`, 'journal');
    fs.renameSync = (from, to) => {
      if (String(to).endsWith('-journal')) throw new Error('simulated EBUSY');
      return original(from, to);
    };
    assert.throws(() => quarantineLegacyDatabase(dbFile), /تعذّر نقل/);
  } finally {
    fs.renameSync = original;
  }
  try {
    assert.ok(fs.existsSync(dbFile), 'the original database must be restored');
    assert.ok(fs.existsSync(`${dbFile}-journal`), 'the sidecar must be restored');
    const leftovers = fs.readdirSync(directory).filter((name) => name.includes('legacy-passphrase'));
    assert.deepEqual(leftovers, [], 'no half-moved quarantine file may remain');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});