'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const ExcelJS = require('exceljs');
const Database = require('better-sqlite3-multiple-ciphers');
const { migrate } = require('../src/main/analysis/store-schema.cjs');
const dataArchitecture = require('../src/main/database/architecture.cjs');
const browser = require('../src/main/database/database-browser-service.cjs');
const manualEntryCatalog = require('../src/main/database/manual-entry-catalog.cjs');
const recordService = require('../src/main/database/record-service.cjs');
const manualEntryWorkflow = require('../src/main/database/manual-entry-workflow.cjs');
const { exportFilteredWorkbook } = require('../src/main/analysis/report-exporter.cjs');
const { DATASETS } = require('../src/main/database/domain-registry.cjs');

function openDatabase() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function addDirectorate(db, district = 'اختبار', governorate = 'تعز') {
  const now = '2026-01-01T00:00:00.000Z';
  const governorateTypeId = db.prepare("SELECT geo_unit_type_id FROM geo_unit_types WHERE type_code='governorate'").get().geo_unit_type_id;
  const directorateTypeId = db.prepare("SELECT geo_unit_type_id FROM geo_unit_types WHERE type_code='directorate'").get().geo_unit_type_id;
  const parent = db.prepare(`INSERT INTO geographic_units(unit_type,name,normalized_name,created_at,updated_at,name_ar,is_active,geo_unit_type_id)
    VALUES('governorate',?,?,?,?,?,1,?)`).run(governorate, governorate.toLowerCase(), now, now, governorate, governorateTypeId);
  db.prepare('UPDATE geographic_units SET geo_unit_id=id WHERE id=?').run(parent.lastInsertRowid);
  const unit = db.prepare(`INSERT INTO geographic_units(parent_id,unit_type,name,normalized_name,created_at,updated_at,name_ar,is_active,geo_unit_type_id,parent_geo_unit_id)
    VALUES(?,'district',?,?,?,?,?,1,?,?)`).run(parent.lastInsertRowid, district, district.toLowerCase(), now, now, district, directorateTypeId, parent.lastInsertRowid);
  db.prepare('UPDATE geographic_units SET geo_unit_id=id WHERE id=?').run(unit.lastInsertRowid);
  return Number(unit.lastInsertRowid);
}

test('database browser mirrors catalog order and reports linked, empty and unlinked groups', () => {
  const db = openDatabase();
  try {
    const catalog = manualEntryCatalog.listCatalog(db);
    const overview = browser.getOverview(db);
    assert.deepEqual(overview.domains.map(domain => domain.code), catalog.domains.map(domain => domain.code));
    assert.deepEqual(overview.domains.flatMap(domain => domain.groups.map(group => group.code)),
      catalog.domains.flatMap(domain => domain.groups.map(group => group.code)));
    assert.equal(overview.totals.domains, 18);
    assert.equal(overview.totals.groups, 86);
    assert.ok(overview.domains.flatMap(domain => domain.groups).some(group => group.state === 'empty'));
    assert.ok(overview.domains.flatMap(domain => domain.groups).some(group => group.state === 'unlinked'));
    assert.ok(overview.operational.length > 0);
    assert.ok(overview.unclassified.datasets.length > 0);
  } finally {
    db.close();
  }
});

test('explicit catalog crosswalk uses registered datasets at most once and leaves uncertain data unclassified', () => {
  const db = openDatabase();
  try {
    const overview = browser.getOverview(db);
    const groupCodes = new Set(overview.domains.flatMap(domain => domain.groups.map(group => group.code)));
    for (const groupCode of Object.keys(browser.GROUP_DATASETS)) assert.ok(groupCodes.has(groupCode), `unknown catalog group ${groupCode}`);
    const assigned = Object.values(browser.GROUP_DATASETS).flat();
    assert.equal(new Set(assigned).size, assigned.length);
    for (const datasetKey of assigned) assert.ok(DATASETS[datasetKey], `unknown typed dataset ${datasetKey}`);
    const unclassified = new Set(overview.unclassified.datasets.map(dataset => dataset.key));
    assert.ok(unclassified.has('naturalResourceSites'));
    assert.ok(unclassified.has('landUseRecords'));
    assert.ok(overview.domains.flatMap(domain => domain.groups).every(group => group.datasets.every(dataset => DATASETS[dataset.key])));
  } finally {
    db.close();
  }
});

test('group and operational reads are paged, provenance-labeled and reject unapproved identifiers', () => {
  const db = openDatabase();
  try {
    const source = db.prepare("INSERT INTO data_sources(source_type,document_title,received_at) VALUES('manual_entry','اختبار مستعرض','2026-01-01T00:00:00.000Z')").run();
    const operational = browser.listOperationalTable(db, { table: 'data_sources', limit: 500, search: 'اختبار' });
    assert.equal(operational.limit, 200);
    assert.equal(operational.total, 1);
    assert.equal(operational.rows[0].source_type, 'manual_entry');
    assert.throws(() => browser.listOperationalTable(db, { table: 'data_sources; DROP TABLE data_sources' }), /غير متاح/);
    assert.throws(() => browser.listUnclassifiedDataset(db, { dataset: 'projects' }), /غير مصنفة/);

    const catalog = manualEntryCatalog.listCatalog(db);
    const overview = browser.getOverview(db);
    const geoUnitId = addDirectorate(db);
    const firstGroup = catalog.domains[0].groups[0];
    assert.throws(() => browser.listGroup(db, { groupCode: firstGroup.code, sourceKey: `form:${firstGroup.forms[0].versionId}`, limit: 1 }), /اختر المديرية/);
    const result = browser.listGroup(db, { groupCode: firstGroup.code, sourceKey: `form:${firstGroup.forms[0].versionId}`, geoUnitId, limit: 1 });
    assert.equal(result.limit, 1);
    assert.equal(result.source.type, 'form');
    assert.equal(result.total, 0);
    const datasetGroup = overview.domains.flatMap(domain => domain.groups).find(group => group.sources.some(item => item.type === 'dataset'));
    const datasetSource = datasetGroup.sources.find(item => item.type === 'dataset');
    const blockedDataset = browser.listGroup(db, { groupCode: datasetGroup.code, sourceKey: datasetSource.key, geoUnitId });
    assert.equal(blockedDataset.requiresApproval, true);
    assert.equal(blockedDataset.total, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM data_sources').get().count, 1);
    assert.throws(() => browser.listGroup(db, { groupCode: firstGroup.code, sourceKey: 'table:users' }), /غير مربوط/);
  } finally {
    db.close();
  }
});

test('central group records expose real values and retain a path to the authoritative record provenance', () => {
  const db = openDatabase();
  try {
    const catalog = manualEntryCatalog.listCatalog(db);
    const group = catalog.domains.flatMap(domain => domain.groups).find(item => item.code === 'administrative-geography.current-directorate-compatibility');
    const form = group.forms.find(item => item.code === 'legacy_directorate_v1');
    assert.ok(form?.versionId);
    const geoUnitId = addDirectorate(db, 'المعافر', 'تعز');
    const created = recordService.saveRecord(db, {
      formVersionId: form.versionId,
      geoUnitId,
      periodYear: '2025',
      actor: 'browser-test',
      values: {
        'directorate.districtName': { value: 'المعافر' },
        'directorate.governorate': { value: 'تعز' },
        'directorate.population': { value: '5000' },
      },
      valueSources: { 'directorate.population': 'استمارة اختبار، الخلية C3' },
    });
    const request = { groupCode: group.code, sourceKey: `form:${form.versionId}`, geoUnitId, limit: 10 };
    assert.equal(browser.listGroup(db, request).total, 0);
    recordService.submitForReview(db, created.formRecordId, 'browser-reviewer');
    recordService.decideRecord(db, created.formRecordId, { decision: 'approve', actor: 'browser-reviewer' });
    const result = browser.listGroup(db, request);
    assert.equal(result.total, 1);
    assert.equal(result.rows[0].form_record_id, created.formRecordId);
    assert.equal(result.rows[0]['value:directorate.population'], '5000');
    assert.equal(result.rows[0]._sourceType, 'إدخال يدوي موثق');
    assert.ok(result.fields.some(field => field.name === 'value:directorate.population'));
    assert.equal(browser.listUnclassifiedTable(db, { table: 'directorates' }).total, 0);
  } finally {
    db.close();
  }
});

test('manual entry is approved, reread from its directorate, and exported with the same filter', async t => {
  const db = openDatabase();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),'ldi-approved-database-export-'));
  t.after(() => {
    db.close();
    fs.rmSync(directory,{ recursive:true,force:true });
  });
  const catalog = manualEntryCatalog.listCatalog(db);
  const group = catalog.domains.flatMap(domain => domain.groups).find(item => item.code === 'administrative-geography.current-directorate-compatibility');
  const form = group.forms.find(item => item.code === 'legacy_directorate_v1');
  const created = manualEntryWorkflow.saveWorkspace(db,{
    district:'المعافر',governorate:'تعز',periodYear:'2025',actor:'integration-test',sourceNote:'استمارة اختبار، الصفحة 1',
    forms:[{ formVersionId:form.versionId,values:{
      'directorate.districtName':{ value:'المعافر' },
      'directorate.governorate':{ value:'تعز' },
      'directorate.population':{ value:'5000' },
    } }],
  });
  assert.equal(created.duplicate,false);
  assert.ok(created.geoUnitId > 0);
  const savedRecord = created.records[0];
  const request = { groupCode:group.code,sourceKey:`form:${form.versionId}`,geoUnitId:created.geoUnitId,periodId:null,limit:20,search:'5000' };
  assert.equal(browser.listGroup(db,request).total,0);
  assert.equal(recordService.getRecord(db,savedRecord.formRecordId).record.geo_unit_id,created.geoUnitId);
  recordService.submitForReview(db,savedRecord.formRecordId,'integration-reviewer');
  recordService.decideRecord(db,savedRecord.formRecordId,{ decision:'approve',actor:'integration-reviewer' });
  const readback = browser.listGroup(db,request);
  assert.equal(readback.total,1);
  assert.equal(readback.rows[0].form_record_id,savedRecord.formRecordId);
  assert.equal(readback.rows[0]['value:directorate.population'],'5000');
  assert.equal(readback.rows[0]._sourceType,'إدخال يدوي موثق');
  assert.equal(readback.rows[0].geo_unit_id,created.geoUnitId);

  const filePath = path.join(directory,'approved-directorate.xlsx');
  await exportFilteredWorkbook(filePath,{
    title:'المديرية المعتمدة',generatedAt:'2026-01-01T00:00:00.000Z',
    columns:readback.fields.map(field => ({ key:field.name,header:field.name })),rows:readback.rows,
    filters:{ labels:['المديرية: المعافر','الفترة: 2025','المجموعة: المديريات'] },summary:{ total:readback.total },
  });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const exportedRows = workbook.getWorksheet('النتائج المطابقة');
  const populationColumn = readback.fields.findIndex(field => field.name === 'value:directorate.population') + 1;
  assert.equal(exportedRows.getCell(2,populationColumn).value,'5000');
  const summary = workbook.getWorksheet('ملخص التقرير');
  assert.ok(summary.getColumn(2).values.includes('المديرية: المعافر'));
});

test('all physical tables are explicitly cataloged, safely browsed, or count-only', () => {
  const db = openDatabase();
  try {
    const overview = browser.getOverview(db);
    const physicalTables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(row => row.name);
    const datasetTables = new Set(Object.values(DATASETS).map(dataset => dataset.table));
    const operationalTables = new Set(overview.operational.map(item => item.table));
    const unclassifiedTables = new Map(overview.unclassified.tables.map(item => [item.table, item]));
    for (const table of physicalTables) {
      assert.ok(datasetTables.has(table) || operationalTables.has(table) || unclassifiedTables.has(table), `unclassified physical table ${table}`);
    }
    assert.ok(physicalTables.length > 100);
    assert.equal(unclassifiedTables.size, overview.unclassified.tables.length);
    assert.ok(overview.unclassified.tables.every(item => item.classification !== 'unregistered'));
    assert.equal(unclassifiedTables.get('app_settings').classification, 'count_only_sensitive');
    assert.equal(unclassifiedTables.get('app_settings').browseable, false);
    assert.equal(unclassifiedTables.get('project_versions').classification, 'count_only_sensitive');
    assert.equal(unclassifiedTables.get('data_values').classification, 'legacy_unmapped');
    assert.equal(unclassifiedTables.get('data_values').browseable, true);
    assert.ok(overview.operational.length > 100);
    for (const table of overview.operational) {
      if (!table.browseable) continue;
      const result = browser.listOperationalTable(db, { table: table.table, limit: 1 });
      const actualColumns = new Set(db.prepare(`PRAGMA table_info("${table.table}")`).all().map(column => column.name));
      assert.ok(result.fields.length, `missing approved display columns for ${table.table}`);
      for (const field of result.fields) assert.ok(actualColumns.has(field.name), `${table.table}.${field.name} is missing`);
      const blobColumns = new Set(db.prepare(`PRAGMA table_info("${table.table}")`).all()
        .filter(column => /BLOB/i.test(column.type)).map(column => column.name));
      assert.ok(result.fields.every(field => !blobColumns.has(field.name)), `binary field exposed from ${table.table}`);
    }
  } finally {
    db.close();
  }
});

test('unmapped legacy data can be browsed while sensitive settings and snapshots remain count-only', () => {
  const db = openDatabase();
  try {
    const batch = db.prepare(`INSERT INTO import_batches(file_name,file_type,file_size,created_at) VALUES('old.xlsx','xlsx',12,'2026-01-01')`).run();
    const sourceItem = db.prepare(`INSERT INTO review_items(batch_id,field_name,value_text,source_location,created_at)
      VALUES(?,?,?,?,?)`).run(batch.lastInsertRowid, 'population', '1234', 'ورقة 1!C3', '2026-01-01');
    db.prepare(`INSERT INTO data_values(governorate,district,subdistrict,settlement,record_type,record_id,field_name,value_text,source_item_id,source_file,source_location,imported_at)
      VALUES('تعز','المعافر','','','district','D-1','population','1234',?,'old.xlsx','ورقة 1!C3','2026-01-01')`).run(sourceItem.lastInsertRowid);
    const legacy = browser.listUnclassifiedTable(db, { table: 'data_values', limit: 10 });
    assert.equal(legacy.total, 1);
    assert.equal(legacy.rows[0].value_text, '1234');
    assert.equal(legacy.rows[0]._sourceType, 'ملف مصدر مسجل');
    assert.throws(() => browser.listUnclassifiedTable(db, { table: 'app_settings' }), /غير متاح/);
    assert.throws(() => browser.listUnclassifiedTable(db, { table: 'project_versions' }), /غير متاح/);
    assert.throws(() => browser.listOperationalTable(db, { table: 'app_settings' }), /غير متاح/);
  } finally {
    db.close();
  }
});

test('legacy rows already linked to canonical records are not repeated in the unclassified list', () => {
  const db = openDatabase();
  try {
    const now = '2026-01-01T00:00:00.000Z';
    const linkedProject = db.prepare(`INSERT INTO projects(code,name,status,created_at,updated_at) VALUES('P-LINKED','مشروع مرتبط','draft',?,?)`).run(now, now);
    dataArchitecture.migrate(db);
    db.prepare(`INSERT INTO projects(code,name,status,created_at,updated_at) VALUES('P-OLD','مشروع غير مرتبط','draft',?,?)`).run(now, now);
    const legacy = browser.listUnclassifiedTable(db, { table: 'projects', limit: 10 });
    assert.equal(legacy.total, 1);
    assert.equal(legacy.rows[0].code, 'P-OLD');
    assert.notEqual(legacy.rows[0].id, linkedProject.lastInsertRowid);
    assert.throws(() => browser.listUnclassifiedTable(db, { table: 'audit_events' }), /غير متاح/);
  } finally {
    db.close();
  }
});
