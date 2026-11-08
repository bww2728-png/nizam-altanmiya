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
      'indicator_definitions', 'indicator_observations', 'indicator_observation_versions', 'projects', 'project_versions',
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

test('canonical migration rolls back all schema and backfill changes when existing geography violates uniqueness', () => {
  const db = new Database(':memory:');
  try {
    db.exec("CREATE TABLE geographic_units (id INTEGER PRIMARY KEY,parent_id INTEGER,unit_type TEXT NOT NULL,official_code TEXT,name TEXT NOT NULL,normalized_name TEXT NOT NULL,valid_from TEXT,valid_to TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)");
    db.prepare("INSERT INTO geographic_units (unit_type,name,normalized_name,created_at,updated_at) VALUES ('governorate','صنعاء','صنعاء','2026-01-01','2026-01-01')").run();
    db.prepare("INSERT INTO geographic_units (unit_type,name,normalized_name,created_at,updated_at) VALUES ('governorate','صنعاء','صنعاء','2026-01-01','2026-01-01')").run();

    assert.throws(() => canonical.migrateCanonicalData(db));
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM geographic_units").get().n, 2);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='data_field_definitions'").get().n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='index' AND name='geographic_units_parent_idx'").get().n, 0);
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
    assert.ok(regions.some(region => region.sheet_id === storedSheets[1].id && region.candidate_type === 'unclassified'), 'a project-cost/status table without project identity remains review-only and unclassified');

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

    // Preserve directorate intake results when a project region from the same
    // workbook is reviewed and promoted later.
    canonical.completeWorkbookImport(db, staged.batchId, {
      applied: 20, created: 20, updated: 0, refused: [], skipped: [],
    });

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

    const registry = canonical.listCanonicalProjects(db, { search: 'تأهيل شبكة', limit: 10 });
    assert.equal(registry.total, 1);
    assert.equal(registry.rows.length, 1);
    assert.equal(registry.rows[0].name, 'تأهيل شبكة مياه');
    assert.equal(registry.rows[0].fundingCount, 1);
    assert.equal(registry.rows[0].openQualityIssues, 2);

    const projectDetails = canonical.getCanonicalProject(db, project.id);
    assert.equal(projectDetails.project.name, 'تأهيل شبكة مياه');
    assert.equal(projectDetails.funding.length, 1);
    assert.equal(projectDetails.funding[0].currency_code, 'USD');
    assert.match(projectDetails.provenance.source_location, /المشاريع!row-2/);
    assert.equal(projectDetails.issues.length, 2);
    const resolvedIssue = canonical.resolveProjectQualityIssue(db, project.id, projectDetails.issues[0].id, 'تم التحقق من المصدر وتصحيح السجل.');
    assert.equal(resolvedIssue.status, 'resolved');
    assert.throws(() => canonical.resolveProjectQualityIssue(db, project.id, projectDetails.issues[0].id, 'محاولة تسوية ثانية'), /سبق تسويتها/);
    assert.throws(() => canonical.resolveProjectQualityIssue(db, project.id + 1, projectDetails.issues[1].id, 'مرجع مشروع خاطئ'), /لا ترتبط بهذا المشروع/);
    const resolvedDetails = canonical.getCanonicalProject(db, project.id);
    assert.equal(resolvedDetails.issues.find(issue => issue.id === resolvedIssue.issueId).resolution, 'تم التحقق من المصدر وتصحيح السجل.');
    assert.equal(canonical.listCanonicalProjects(db, { search: 'تأهيل شبكة', limit: 10 }).rows[0].openQualityIssues, 1);
    assert.throws(() => canonical.getCanonicalProject(db, 0), /معرّف المشروع غير صالح/);

    const promotion = db.prepare('SELECT * FROM workbook_import_promotions').get();
    assert.equal(promotion.entity_type, 'project');
    assert.match(promotion.source_location, /المشاريع!row-2/);
    assert.deepEqual(JSON.parse(promotion.mapping_json), columnMap);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM data_quality_issues WHERE issue_code LIKE 'unmatched-project-%'").get().n, 2);
    assert.equal(canonical.readWorkbookImportRegion(db, staged.batchId, region.id).rows.find(row => row.rowNumber === 2).promoted, true);
    let batchResult = JSON.parse(db.prepare('SELECT result_json FROM workbook_import_batches WHERE id = ?').get(staged.batchId).result_json);
    assert.equal(batchResult.directorateImport.applied, 20);
    assert.equal(batchResult.projectPromotions.length, 1);
    assert.equal(db.prepare('SELECT status FROM workbook_import_batches WHERE id = ?').get(staged.batchId).status, 'directorates-and-projects-partially-applied');

    // A later directorate completion must not erase the project import record.
    canonical.completeWorkbookImport(db, staged.batchId, {
      applied: 20, created: 20, updated: 0, refused: [], skipped: [],
    });
    batchResult = JSON.parse(db.prepare('SELECT result_json FROM workbook_import_batches WHERE id = ?').get(staged.batchId).result_json);
    assert.equal(batchResult.projectPromotions.length, 1);
    assert.equal(batchResult.projectPromotions[0].applied.length, 1);

    const repeated = canonical.promoteProjectRegion(db, {
      batchId: staged.batchId, regionId: region.id, columnMap, approvedRows: [2],
    });
    assert.equal(repeated.applied.length, 0);
    assert.match(repeated.refused[0].reason, /سبق اعتماده/);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM projects').get().n, 1);
    batchResult = JSON.parse(db.prepare('SELECT result_json FROM workbook_import_batches WHERE id = ?').get(staged.batchId).result_json);
    assert.equal(batchResult.directorateImport.applied, 20);
    assert.equal(batchResult.projectPromotions.length, 2);
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


test('indicator regions promote only explicitly approved unique measurements with directorate, period and provenance checks', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ldi-indicator-promotion-'));
  const filePath = path.join(directory, 'indicators.xlsx');
  const db = openDatabase();
  try {
    const directorate = db.prepare('INSERT INTO directorates (governorate,district,updated_at) VALUES (?,?,?)').run('صنعاء','بني الحارث','2026-01-01');
    canonical.syncLegacyDirectorate(db, Number(directorate.lastInsertRowid));
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('المؤشرات');
    sheet.getRow(1).values = ['اسم المؤشر','المحافظة','المديرية','الفترة','القيمة','الوحدة'];
    sheet.getRow(2).values = ['عجز المياه %','صنعاء','بني الحارث','2025',17,'%'];
    sheet.getRow(3).values = ['عجز المياه %','صنعاء','بني الحارث','2025',18,'%'];
    await workbook.xlsx.writeFile(filePath);

    const staged = await canonical.stageWorkbook(db,filePath);
    const { regions } = canonical.listWorkbookImportRegions(db,staged.batchId);
    const region = regions.find(item => item.candidateType === 'indicator-candidate');
    assert.ok(region);
    const result = canonical.promoteIndicatorRegion(db,{
      batchId: staged.batchId,
      regionId: region.id,
      columnMap: { indicator:1,governorate:2,district:3,period_key:4,value:5,unit:6 },
      approvedRows: [2,3],
    });
    assert.equal(result.applied.length,1);
    assert.equal(result.refused.length,1);
    assert.match(result.refused[0].reason,/مكررة/);
    const observation = db.prepare('SELECT o.value_number,o.period_key,o.source_location,s.file_name,u.name AS district FROM indicator_observations o JOIN data_sources s ON s.id=o.source_id JOIN geographic_units u ON u.id=o.geographic_unit_id').get();
    assert.equal(observation.value_number,17);
    assert.equal(observation.period_key,'2025');
    assert.equal(observation.source_location,'المؤشرات!row-2');
    assert.equal(observation.file_name,'indicators.xlsx');
    assert.equal(observation.district,'بني الحارث');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM workbook_import_promotions WHERE entity_type=?').get('indicator_observation').n,1);
  } finally {
    db.close();
    fs.rmSync(directory,{recursive:true,force:true});
  }
});

test('manual canonical project edits validate values, preserve linked funding and retain prior versions', () => {
  const db = openDatabase();
  try {
    const geo = db.prepare("INSERT INTO geographic_units (unit_type,name,normalized_name,created_at,updated_at) VALUES ('district','المعافر','المعافر','2026-01-01','2026-01-01')").run();
    const sector = db.prepare("INSERT INTO sectors (code,name_ar,created_at) VALUES ('water','المياه','2026-01-01')").run();
    const created = canonical.saveCanonicalProject(db, {
      name: 'تأهيل شبكة مياه', code: 'P-100', status: 'مقترح', estimated_cost: '١٬٢٥٠',
      currency_code: 'YER', start_date: '2026-01-01', end_date: '2026-12-31',
      geographic_unit_id: String(geo.lastInsertRowid), sector_id: String(sector.lastInsertRowid),
    });
    assert.equal(created.action, 'created');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM project_versions WHERE project_id=?').get(created.id).n, 1);
    db.prepare('INSERT INTO project_funding (project_id,partner_name,amount,currency_code,created_at) VALUES (?,?,?,?,?)')
      .run(created.id, 'شريك محلي', 500, 'USD', '2026-01-01');
    assert.throws(() => canonical.addProjectFunding(db, created.id, { partner_name: 'دون عملة', amount: 10 }), /رمز عملة/);
    canonical.addProjectFunding(db, created.id, { partner_name: 'جهة مانحة', amount: '١٬٢٥٠', currency_code: 'USD', funding_date: '2026-06-01' });
    const attachmentContent = Buffer.from('%PDF-1.7\nfixture');
    const attachment = canonical.addProjectAttachment(db, created.id, { originalName: 'قرار التمويل.pdf', content: attachmentContent });
    assert.equal(attachment.mimeType, 'application/pdf');
    assert.throws(() => canonical.addProjectAttachment(db, created.id, { originalName: 'duplicate.pdf', content: attachmentContent }), /مرتبط بالمشروع مسبقًا/);
    assert.throws(() => canonical.addProjectAttachment(db, created.id, { originalName: 'bad.pdf', content: Buffer.from('not pdf') }), /نوع المرفق غير مدعوم/);

    const updated = canonical.saveCanonicalProject(db, { id: created.id, name: 'تأهيل شبكة مياه - محدث', code: 'P-100', status: 'قيد التنفيذ', estimated_cost: 1500, currency_code: 'YER' });
    assert.equal(updated.action, 'updated');
    const detail = canonical.getCanonicalProject(db, created.id);
    assert.equal(detail.project.name, 'تأهيل شبكة مياه - محدث');
    assert.equal(detail.project.estimated_cost, 1500);
    assert.equal(detail.funding.length, 2);
    assert.equal(detail.attachments.length, 1);
    assert.equal(detail.attachments[0].id, attachment.id);
    assert.ok(Buffer.from(db.prepare('SELECT content FROM managed_attachments WHERE id=?').get(attachment.id).content).equals(attachmentContent));
    assert.ok(canonical.getProjectAttachment(db,created.id,attachment.id).content.equals(attachmentContent));
    assert.throws(() => canonical.getProjectAttachment(db,created.id+1,attachment.id),/غير موجود لهذا المشروع/);
    db.prepare('UPDATE managed_attachments SET content=? WHERE id=?').run(Buffer.from('%PDF-9.9\nfixture'),attachment.id);
    assert.throws(() => canonical.getProjectAttachment(db,created.id,attachment.id),/بصمة المرفق/);
    assert.equal(detail.versions.length, 4);
    assert.equal(JSON.parse(db.prepare("SELECT payload_json FROM project_versions WHERE action='manual-update'").get().payload_json).name, 'تأهيل شبكة مياه');
    assert.equal(canonical.listCanonicalReferences(db).sectors.length, 1);
    assert.throws(() => canonical.saveCanonicalProject(db, { name: 'بلا عملة', estimated_cost: 10 }), /رمز عملة/);
    assert.throws(() => canonical.saveCanonicalProject(db, { id: created.id, name: 'تاريخ غير متسق', start_date: '2026-12-01', end_date: '2026-01-01' }), /تاريخ البداية/);
  } finally {
    db.close();
  }
});

test('region classification separates directorate project-cost attributes from project and indicator tables', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ldi-region-classes-'));
  const filePath = path.join(directory, 'mixed-regions.xlsx');
  const db = openDatabase();
  try {
    const workbook = new ExcelJS.Workbook();
    const directorates = workbook.addWorksheet('المديريات');
    directorates.getRow(1).values = ['اسم المديرية', 'المحافظة', 'تكلفة المشروع', 'عدد السكان'];
    directorates.getRow(2).values = ['مديرية تجريبية', 'تعز', '500000', '25000'];

    const projects = workbook.addWorksheet('المشاريع');
    projects.getRow(1).values = ['اسم المشروع', 'رمز المشروع', 'التكلفة التقديرية', 'العملة'];
    projects.getRow(2).values = ['تأهيل مدرسة', 'P-100', '15000', 'USD'];

    const indicators = workbook.addWorksheet('المؤشرات');
    indicators.getRow(1).values = ['اسم المؤشر', 'الفترة', 'القيمة', 'وحدة القياس'];
    indicators.getRow(2).values = ['نسبة تغطية المياه', '2026-Q1', '72', '%'];

    await workbook.xlsx.writeFile(filePath);
    const staged = await canonical.stageWorkbook(db, filePath);
    const { regions } = canonical.listWorkbookImportRegions(db, staged.batchId);
    const bySheet = Object.fromEntries(regions.map(region => [region.sheetName, region.candidateType]));

    assert.equal(bySheet['المديريات'], 'directorate-candidate',
      'a directorate attribute named project cost must not classify the whole table as projects');
    assert.equal(bySheet['المشاريع'], 'project-candidate');
    assert.equal(bySheet['المؤشرات'], 'indicator-candidate');
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('manual indicator observations validate references, preserve prior versions and remain paged', () => {
  const db = openDatabase();
  try {
    const now = '2026-01-01';
    const governorate = db.prepare("INSERT INTO geographic_units (unit_type,name,normalized_name,created_at,updated_at) VALUES ('governorate','صنعاء','صنعاء',?,?)").run(now,now);
    const district = db.prepare("INSERT INTO geographic_units (parent_id,unit_type,name,normalized_name,created_at,updated_at) VALUES (?,'district','بني الحارث','بني الحارث',?,?)").run(governorate.lastInsertRowid,now,now);
    const indicator = db.prepare("SELECT id FROM indicator_definitions WHERE unit='%' ORDER BY id LIMIT 1").get();
    const created = canonical.saveIndicatorObservation(db,{ indicator_id:indicator.id,geographic_unit_id:district.lastInsertRowid,period_key:'2025',value_number:'٧٢٫٥' });
    assert.equal(created.action,'created');
    assert.throws(() => canonical.saveIndicatorObservation(db,{ indicator_id:indicator.id,geographic_unit_id:district.lastInsertRowid,period_key:'2025',value_number:80 }),/قياس آخر/);
    assert.throws(() => canonical.saveIndicatorObservation(db,{ indicator_id:indicator.id,geographic_unit_id:district.lastInsertRowid,period_key:'2026',value_number:101 }),/تتجاوز 100/);
    const updated = canonical.saveIndicatorObservation(db,{ id:created.id,indicator_id:indicator.id,geographic_unit_id:district.lastInsertRowid,period_key:'2025',value_number:80 });
    assert.equal(updated.action,'updated');
    assert.equal(db.prepare('SELECT value_number FROM indicator_observations WHERE id=?').get(created.id).value_number,80);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM indicator_observation_versions WHERE observation_id=?').get(created.id).n,1);
    assert.equal(JSON.parse(db.prepare('SELECT payload_json FROM indicator_observation_versions WHERE observation_id=?').get(created.id).payload_json).value_number,72.5);
    const listed = canonical.listIndicatorObservations(db,{ search:'بني الحارث',limit:10 });
    assert.equal(listed.total,1);
    assert.equal(listed.rows[0].version_count,1);
    assert.equal(listed.rows[0].source_location,'إدخال يدوي');

    const issue = db.prepare("INSERT INTO data_quality_issues (severity,issue_code,message,status,created_at) VALUES ('warning','manual-review','تحقق من الفترة المرجعية','open',?)").run(now);
    assert.equal(canonical.listDataQualityIssues(db,{ status:'open' }).total,1);
    assert.equal(canonical.resolveDataQualityIssue(db,issue.lastInsertRowid,'تمت مراجعة المصدر والفترة.').status,'resolved');
    assert.equal(canonical.listDataQualityIssues(db,{ status:'resolved' }).rows[0].resolution,'تمت مراجعة المصدر والفترة.');
    assert.throws(() => canonical.resolveDataQualityIssue(db,issue.lastInsertRowid,'تسوية ثانية'),/سبق تسويتها/);
  } finally {
    db.close();
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
