'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3-multiple-ciphers');
const { migrate } = require('../src/main/analysis/store-schema.cjs');
const { INPUT_FIELDS } = require('../src/main/analysis/schema.cjs');
const persist = require('../src/main/analysis/persist.cjs');
const { mappingTable } = require('../src/main/analysis/mapping.cjs');
const { exportFilteredCsv } = require('../src/main/analysis/report-exporter.cjs');

function makeDatabase() {
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  migrate(database);
  return database;
}

function completeValues(districtName, overrides = {}) {
  const values = { districtName, governorate: 'إب' };
  for (const field of INPUT_FIELDS) {
    if (field.key === 'districtName' || field.key === 'governorate') continue;
    if (field.type === 'number' || field.type === 'ratio') values[field.key] = field.type === 'ratio' ? 0.5 : 10;
    else if (field.type === 'boolean') values[field.key] = true;
    else values[field.key] = 'قيمة';
  }
  return { ...values, ...overrides };
}

function addDynamicField(database, key, label, sensitivity = 'public') {
  const now = new Date().toISOString();
  database.prepare(`INSERT INTO data_field_definitions
    (entity_type,field_key,label_ar,data_type,sensitivity,field_class,temporal_behavior,validation_json,description,created_at,updated_at)
    VALUES('directorate',?,?,'number',?,'temporal_measure','periodic','{}','حقل تجريبي للاختبار',?,?)`)
    .run(key,label,sensitivity,now,now);
  const formVersionId = database.prepare("SELECT version.form_version_id FROM form_versions version JOIN form_definitions form USING(form_id) WHERE form.form_code='legacy_directorate_v1' ORDER BY version.version_number DESC LIMIT 1").get().form_version_id;
  const sectionId = database.prepare("SELECT section_id FROM form_sections WHERE form_version_id=? AND section_type='record' ORDER BY sort_order LIMIT 1").get(formVersionId).section_id;
  const fieldCode = `directorate.${key}`;
  database.prepare(`INSERT INTO field_definitions(field_code,canonical_name_ar,description,semantic_type,data_type,is_active,created_at,updated_at)
    VALUES(?,?,'حقل تجريبي للاختبار','measurement','decimal',1,?,?)`).run(fieldCode,label,now,now);
  const fieldDefinitionId = database.prepare('SELECT field_definition_id FROM field_definitions WHERE field_code=?').get(fieldCode).field_definition_id;
  database.prepare(`INSERT INTO form_fields(form_version_id,section_id,field_definition_id,field_code,label_ar,data_type_override,storage_class,axis_role,is_required,allow_null,is_importable,sort_order,created_at)
    VALUES(?,?,?,?,?,'decimal','measurement','column',0,1,1,100,?)`).run(formVersionId,sectionId,fieldDefinitionId,fieldCode,label,now);
  return Number(database.prepare('SELECT form_field_id FROM form_fields WHERE form_version_id=? AND field_code=?').get(formVersionId,fieldCode).form_field_id);
}

function setDynamicValue(database, recordId, fieldId, periodKey, value) {
  const now = new Date().toISOString();
  const year = Number(periodKey);
  database.prepare(`INSERT OR IGNORE INTO periods(period_code,period_type,calendar_type,label_ar,year_gregorian,created_at)
    VALUES(?,'annual','gregorian',?,?,?)`).run(periodKey,periodKey,year,now);
  const periodId = database.prepare("SELECT period_id FROM periods WHERE period_code=? AND calendar_type='gregorian'").get(periodKey).period_id;
  const fieldDefinitionId = database.prepare('SELECT field_definition_id FROM form_fields WHERE form_field_id=?').get(fieldId).field_definition_id;
  database.prepare(`INSERT INTO observations(form_record_id,form_field_id,field_definition_id,period_id,value_integer,value_state,observation_role,quality_status,created_by,created_at,updated_at)
    VALUES(?,?,?,?,?,'known','observed','unverified','test',?,?)`).run(recordId,fieldId,fieldDefinitionId,periodId,value,now,now);
}

test('dynamic report filters use the selected period and honor missing-value semantics', () => {
  const database = makeDatabase();
  try {
    const first = persist.upsertDirectorate(database,{ governorate:'إب',districtName:'مديرية أ',values:completeValues('مديرية أ') });
    const second = persist.upsertDirectorate(database,{ governorate:'إب',districtName:'مديرية ب',values:completeValues('مديرية ب',{ population:undefined }) });
    const fieldId = addDynamicField(database,'health_centres','عدد المراكز الصحية');
    const firstRecord = database.prepare("SELECT form_record_id FROM form_record_legacy_links WHERE legacy_entity_type='directorate' AND legacy_entity_id=?").get(first.id).form_record_id;
    const secondRecord = database.prepare("SELECT form_record_id FROM form_record_legacy_links WHERE legacy_entity_type='directorate' AND legacy_entity_id=?").get(second.id).form_record_id;
    setDynamicValue(database,firstRecord,fieldId,'2025',12);
    setDynamicValue(database,secondRecord,fieldId,'2026',4);

    const catalogue = mappingTable(database);
    const field = catalogue.find(item => item.key === 'health_centres');
    assert.equal(field.type,'number');
    assert.equal(field.filterable,true);
    assert.equal(field.exportable,true);
    const options = {
      dynamicFields: new Map(catalogue.map(item => [item.key,{ key:item.key,type:item.type }])),
      allowedKeys: new Set(catalogue.filter(item => item.filterable).map(item => item.key)),
    };
    const selectedPeriod = { periodKey:'2025',criteria:[{ key:'health_centres',operator:'range',min:'10',max:'15' }] };
    assert.equal(persist.countDirectorates(database,selectedPeriod,options),1);
    assert.equal(persist.listDirectorates(database,{ ...selectedPeriod,limit:20 },options)[0].id,first.id);

    const missingAtPeriod = { periodKey:'2025',criteria:[{ key:'__missingField',values:['health_centres'] }] };
    assert.equal(persist.countDirectorates(database,missingAtPeriod,options),1);
    assert.equal(persist.listDirectorates(database,{ ...missingAtPeriod,limit:20 },options)[0].id,second.id);

    const completeness = { criteria:[{ key:'__completeness',min:'100',max:'' }] };
    assert.equal(persist.countDirectorates(database,completeness,options),1);
  } finally {
    database.close();
  }
});

test('CSV report exports all supplied matches, preserves Arabic, and neutralizes formula text', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),'ldi-report-csv-'));
  const filePath = path.join(directory,'report.csv');
  try {
    const result = await exportFilteredCsv(filePath,{
      title:'تقرير تجريبي',generatedAt:'2026-01-02T03:04:05.000Z',
      filters:{ logic:'and',periodKey:'2025',labels:['المحافظة يساوي إب'] },
      summary:{ total:2,items:[{ label:'نتائج مطابقة',value:2 }] },
      columns:[{ key:'district',header:'المديرية' },{ key:'note',header:'ملاحظة' }],
      rows:[{ district:'مديرية أ',note:'=1+1' },{ district:'مديرية ب',note:'-صيغة' }],
    });
    const content = fs.readFileSync(filePath,'utf8');
    assert.equal(result.rowCount,2);
    assert.ok(content.startsWith('\uFEFF'));
    assert.match(content,/مديرية أ/);
    assert.match(content,/الفترة المرجعية/);
    assert.match(content,/2025/);
    assert.match(content,/"'=1\+1"/);
    assert.match(content,/"'-صيغة"/);
  } finally {
    fs.rmSync(directory,{ recursive:true,force:true });
  }
});
