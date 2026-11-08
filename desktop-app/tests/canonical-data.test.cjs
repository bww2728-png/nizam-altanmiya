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
    assert.equal(staged.sheets[0].id, directorateSheet.id);
    const sheetPreview = canonical.readWorkbookSheetPreview(db, staged.batchId, directorateSheet.id, 1);
    assert.equal(sheetPreview.sheet.name, 'المديريات');
    assert.equal(sheetPreview.rows.length, 1);
    assert.equal(sheetPreview.truncated, true);
    assert.ok(sheetPreview.rows[0].cells.length <= 24);
    assert.throws(() => canonical.readWorkbookSheetPreview(db, staged.batchId, 999999), /لا تنتمي/);
    assert.ok(JSON.parse(directorateSheet.merged_ranges_json).includes('A1:C1'));
    assert.ok(directorateSheet.formula_count >= 1);
    assert.equal(directorateSheet.hidden_row_count, 1);

    const regions = db.prepare('SELECT * FROM workbook_import_regions WHERE batch_id = ?').all(staged.batchId);
    assert.ok(regions.some(region => region.candidate_type === 'directorate-candidate'));
    assert.ok(regions.some(region => region.candidate_type === 'project-candidate'));

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


test('project regions require explicit row approval and preserve project/funding provenance', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ldi-project-promotion-'));
  const filePath = path.join(directory, 'projects.xlsx');
  const db = openDatabase();
  try {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('المشاريع');
    sheet.getRow(1).values = [
      'اسم المشروع', 'رمز المشروع', 'التكلفة التقديرية', 'رمز العملة',
      'تاريخ البداية', 'تاريخ النهاية', 'جهة التمويل', 'مبلغ التمويل',
      'المحافظة', 'المديرية', 'القطاع', 'عملة التمويل',
    ];
    sheet.getRow(2).values = [
      'تأهيل شبكة مياه', 'PRJ-001', '١٬٢٥٠', 'YER',
      '2026-01-01', '2026-12-31', 'UNDP', '250',
      'تعز', 'المعافر', 'المياه', 'USD',
    ];
    sheet.getRow(3).values = [
      'إنشاء مدرسة', 'PRJ-002', 'تكلفة غير واضحة', 'YER',
      '2026-02-01', '2026-11-30', '', '',
      'تعز', 'المعافر', 'التعليم', '',
    ];
    sheet.getRow(4).values = [
      'مشروع مخفي', 'PRJ-003', '500', 'YER',
      '2026-03-01', '2026-10-30', '', '',
      'تعز', 'المعافر', 'المياه', '',
    ];
    sheet.getRow(4).hidden = true;
    sheet.getRow(5).values = [
      'مشروع بصيغة', 'PRJ-004', null, 'YER',
      '2026-04-01', '2026-10-30', '', '',
      'تعز', 'المعافر', 'المياه', '',
    ];
    sheet.getCell('C5').value = { formula: '100+200', result: 300 };
    sheet.getRow(6).values = [
      'مشروع برمز مكرر', 'PRJ-001', '900', 'YER',
      '2026-05-01', '2026-10-30', '', '',
      'تعز', 'المعافر', 'المياه', '',
    ];
    sheet.getRow(7).values = [
      'تكلفة بلا عملة', 'PRJ-005', '500', '',
      '2026-06-01', '2026-10-30', '', '',
      'تعز', 'المعافر', 'المياه', '',
    ];
    sheet.getRow(8).values = [
      'تمويل بلا عملة', 'PRJ-006', '', '',
      '2026-06-01', '2026-10-30', 'شريك محلي', '500',
      'تعز', 'المعافر', 'المياه', '',
    ];
    await workbook.xlsx.writeFile(filePath);

    const staged = await canonical.stageWorkbook(db, filePath);
    const catalog = canonical.listWorkbookImportRegions(db, staged.batchId);
    const [region] = catalog.regions.filter(item => item.candidateType === 'project-candidate');
    assert.ok(region, 'a project-like table with directorate columns must be classified as a project region');
    assert.equal(region.sheetName, 'المشاريع');
    assert.equal(region.totalRows, 7);

    const preview = canonical.readWorkbookImportRegion(db, staged.batchId, region.id, 0, 30);
    assert.equal(preview.rows.length, 7);
    assert.equal(preview.rows.find(row => row.rowNumber === 4).hidden, true);
    assert.equal(preview.rows.find(row => row.rowNumber === 5).hasFormula, true);

    const columnMap = {
      project_name: 1, project_code: 2, estimated_cost: 3, currency_code: 4,
      start_date: 5, end_date: 6, funding_partner: 7, funding_amount: 8,
      governorate: 9, district: 10, sector: 11, funding_currency: 12,
    };
    const approvedRows = [2, 3, 4, 5, 6, 7, 8];
    const result = canonical.promoteProjectRegion(db, {
      batchId: staged.batchId, regionId: region.id, columnMap, approvedRows,
    });

    assert.equal(result.applied.length, 1);
    assert.equal(result.refused.length, 6);
    assert.equal(result.applied[0].rowNumber, 2);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM projects').get().n, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM project_funding').get().n, 1);
    const project = db.prepare('SELECT * FROM projects').get();
    assert.equal(project.code, 'PRJ-001');
    assert.equal(project.estimated_cost, 1250);
    assert.equal(project.currency_code, 'YER');
    const funding = db.prepare('SELECT * FROM project_funding').get();
    assert.equal(funding.partner_name, 'UNDP');
    assert.equal(funding.amount, 250);
    assert.equal(funding.currency_code, 'USD');

    const promotion = db.prepare('SELECT * FROM workbook_import_promotions').get();
    assert.equal(promotion.entity_type, 'project');
    assert.match(promotion.source_location, /المشاريع!row-2/);
    assert.deepEqual(JSON.parse(promotion.mapping_json), columnMap);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM data_quality_issues WHERE issue_code LIKE 'unmatched-project-%'").get().n, 2);
    assert.equal(canonical.readWorkbookImportRegion(db, staged.batchId, region.id).rows.find(row => row.rowNumber === 2).promoted, true);

    const repeated = canonical.promoteProjectRegion(db, {
      batchId: staged.batchId, regionId: region.id, columnMap, approvedRows: [2],
    });
    assert.equal(repeated.applied.length, 0);
    assert.match(repeated.refused[0].reason, /سبق اعتماده/);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM projects').get().n, 1);
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('project promotion rejects ambiguous mappings and foreign batch/region pairs', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ldi-project-guards-'));
  const filePath = path.join(directory, 'projects.xlsx');
  const db = openDatabase();
  try {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('المشاريع');
    sheet.getRow(1).values = ['اسم المشروع', 'رمز المشروع', 'التكلفة التقديرية'];
    sheet.getRow(2).values = ['تأهيل طريق', 'P-1', '1000'];
    await workbook.xlsx.writeFile(filePath);
    const staged = await canonical.stageWorkbook(db, filePath);
    const region = canonical.listWorkbookImportRegions(db, staged.batchId).regions.find(item => item.candidateType === 'project-candidate');
    assert.ok(region);
    assert.throws(() => canonical.promoteProjectRegion(db, {
      batchId: staged.batchId, regionId: region.id,
      columnMap: { project_name: 1, project_code: 1 }, approvedRows: [2],
    }), /العمود نفسه/);
    assert.throws(() => canonical.promoteProjectRegion(db, {
      batchId: staged.batchId + 1, regionId: region.id,
      columnMap: { project_name: 1 }, approvedRows: [2],
    }), /لا تنتمي/);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM projects').get().n, 0);
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
