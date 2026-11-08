'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const ExcelJS = require('exceljs');
const Database = require('better-sqlite3-multiple-ciphers');

const { migrate } = require('../src/main/analysis/store-schema.cjs');
const canonical = require('../src/main/analysis/canonical-data.cjs');

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/pXcAAAAASUVORK5CYII=',
  'base64'
);

function openDatabase() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

test('canonical model migrations are additive and idempotent', () => {
  const db = openDatabase();
  try {
    canonical.migrateCanonicalData(db);
    canonical.migrateCanonicalData(db);
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
    for (const name of [
      'geographic_units', 'sectors', 'data_sources', 'data_field_definitions',
      'data_field_aliases', 'entity_records', 'entity_field_values',
      'indicator_definitions', 'indicator_observations', 'projects',
      'project_funding', 'managed_attachments', 'data_quality_issues',
      'workbook_import_batches', 'workbook_import_sheets',
      'workbook_import_regions', 'workbook_import_rows', 'workbook_import_media',
      'directorates', 'analysis_runs'
    ]) assert.ok(tables.has(name), 'missing table ' + name);

    const fieldCount = db.prepare("SELECT COUNT(*) AS n FROM data_field_definitions WHERE entity_type='directorate'").get().n;
    assert.ok(fieldCount >= 39);
    const populationFieldId = db.prepare("SELECT id FROM data_field_definitions WHERE entity_type='directorate' AND field_key='population'").get().id;
    assert.ok(db.prepare("SELECT 1 FROM data_field_aliases WHERE field_definition_id=? AND normalized_alias=?").get(populationFieldId, 'اجمالي السكان'));
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM indicator_definitions').get().n, 12);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM directorates').get().n, 0);
  } finally {
    db.close();
  }
});

test('workbook staging preserves every scanned sheet, cell provenance, hidden rows, formulas, merges, images and original file', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ldi-canonical-stage-'));
  const filePath = path.join(directory, 'بيانات-مختلطة.xlsx');
  const db = openDatabase();
  try {
    const workbook = new ExcelJS.Workbook();

    const districts = workbook.addWorksheet('المديريات');
    districts.mergeCells('A1:C1');
    districts.getCell('A1').value = 'بيانات المديريات';
    districts.getRow(2).values = ['اسم المديرية', 'المحافظة', 'عدد السكان', 'نتيجة محسوبة'];
    districts.getRow(3).values = ['بني الحارث', 'أمانة العاصمة', 150000];
    districts.getCell('D3').value = { formula: 'C3*2', result: 300000 };
    districts.getCell('C3').note = 'المصدر: تقدير محلي';
    districts.getRow(4).values = ['همدان', 'صنعاء', 70000, 140000];
    districts.getRow(4).hidden = true;
    const imageId = workbook.addImage({ buffer: ONE_PIXEL_PNG, extension: 'png' });
    districts.addImage(imageId, 'F2:G4');

    const projects = workbook.addWorksheet('المشاريع');
    projects.getRow(1).values = ['تكلفة المشروع', 'حالة المشروع', 'عدد المدارس'];
    projects.getRow(2).values = ['تأهيل شبكة مياه', 'قيد التنفيذ', 25000000];
    projects.getRow(3).values = ['إنشاء مدرسة', 'مقترح', 48000000];

    const sources = workbook.addWorksheet('مصادر البيانات');
    sources.state = 'hidden';
    sources.getRow(1).values = ['الجهة', 'تاريخ البيانات'];
    sources.getRow(2).values = ['مكتب التخطيط', '2026'];

    await workbook.xlsx.writeFile(filePath);
    const originalBytes = fs.readFileSync(filePath);
    const expectedSha = crypto.createHash('sha256').update(originalBytes).digest('hex');

    // Use the same read-after-write path as the production importer.
    const parsedWorkbook = new ExcelJS.Workbook();
    await parsedWorkbook.xlsx.readFile(filePath);
    // A damaged Excel date serial must be captured as an issue, not crash the batch.
    parsedWorkbook.getWorksheet('المشاريع').getCell('D4').value = new Date(Number.NaN);
    const staged = await canonical.stageWorkbook(db, filePath, parsedWorkbook);
    assert.equal(staged.status, 'staged');
    assert.equal(staged.sheetCount, 3);
    assert.equal(staged.mediaCount, 1);
    assert.equal(staged.sha256, expectedSha);
    assert.equal(staged.sheets.length, 3);
    assert.deepEqual(staged.sheets.map(sheet => sheet.name), ['المديريات', 'المشاريع', 'مصادر البيانات']);

    const batch = db.prepare('SELECT * FROM workbook_import_batches WHERE id = ?').get(staged.batchId);
    assert.equal(batch.status, 'staged');
    assert.deepEqual(batch.original_file, originalBytes);
    assert.equal(batch.sha256, expectedSha);

    const storedSheets = db.prepare('SELECT * FROM workbook_import_sheets WHERE batch_id = ? ORDER BY sheet_index').all(staged.batchId);
    assert.equal(storedSheets.length, 3);
    assert.equal(storedSheets[2].state, 'hidden');

    const directorateSheet = storedSheets[0];
    assert.ok(JSON.parse(directorateSheet.merged_ranges_json).includes('A1:C1'));
    assert.ok(directorateSheet.formula_count >= 1);
    assert.equal(directorateSheet.hidden_row_count, 1);

    const regions = db.prepare('SELECT * FROM workbook_import_regions WHERE batch_id = ?').all(staged.batchId);
    assert.ok(regions.some(region => region.candidate_type === 'directorate-candidate'));
    assert.ok(regions.some(region => region.candidate_type === 'unclassified'));

    const storedRows = db.prepare('SELECT * FROM workbook_import_rows WHERE batch_id = ? ORDER BY sheet_id, row_number').all(staged.batchId);
    assert.ok(storedRows.length >= 7);
    const formulaRow = storedRows.find(row => row.sheet_id === directorateSheet.id && row.row_number === 3);
    const formulaCells = JSON.parse(formulaRow.cells_json);
    const formulaCell = formulaCells.find(cell => cell.address === 'D3');
    assert.equal(formulaCell.formula, 'C3*2');
    assert.equal(formulaCell.cachedResult, 300000);
    assert.equal(formulaCells.find(cell => cell.address === 'C3').note, 'المصدر: تقدير محلي');
    const hiddenRow = storedRows.find(row => row.sheet_id === directorateSheet.id && row.row_number === 4);
    assert.equal(hiddenRow.is_hidden, 1);
    const projectSheet = storedSheets[1];
    const invalidDateRow = storedRows.find(row => row.sheet_id === projectSheet.id && row.row_number === 4);
    const invalidDateCell = JSON.parse(invalidDateRow.cells_json).find(cell => cell.address === 'D4');
    assert.equal(invalidDateCell.rawValue.type, 'invalid-date');

    const media = db.prepare('SELECT * FROM workbook_import_media WHERE batch_id = ?').all(staged.batchId);
    assert.equal(media.length, 1);
    assert.equal(media[0].extraction_status, 'stored');
    assert.deepEqual(media[0].content, ONE_PIXEL_PNG);
    assert.equal(media[0].sha256, crypto.createHash('sha256').update(ONE_PIXEL_PNG).digest('hex'));

    // Staging alone must never create approved directorate or project entities.
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM directorates').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM projects').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM entity_records').get().n, 0);

    canonical.completeWorkbookImport(db, staged.batchId, { applied: 0, created: 0, updated: 0, refused: [], skipped: [] });
    assert.equal(db.prepare('SELECT status FROM workbook_import_batches WHERE id = ?').get(staged.batchId).status, 'reviewed-without-directorate-write');
    assert.equal(canonical.listWorkbookImports(db, 10)[0].id, staged.batchId);
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('staging rejects empty files before creating a batch', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ldi-canonical-empty-'));
  const filePath = path.join(directory, 'empty.xlsx');
  fs.writeFileSync(filePath, '');
  const db = openDatabase();
  try {
    await assert.rejects(canonical.stageWorkbook(db, filePath), /فارغ/);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM workbook_import_batches').get().n, 0);
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
