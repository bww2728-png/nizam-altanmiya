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
  return Number(database.prepare(`INSERT INTO data_field_definitions
    (entity_type,field_key,label_ar,data_type,sensitivity,field_class,temporal_behavior,validation_json,description,created_at,updated_at)
    VALUES('directorate',?,?,'number',?,'temporal_measure','periodic','{}','حقل تجريبي للاختبار',?,?)`)
    .run(key,label,sensitivity,now,now).lastInsertRowid);
}

function setDynamicValue(database, recordId, fieldId, periodKey, value) {
  const now = new Date().toISOString();
  database.prepare(`INSERT INTO entity_field_values
    (record_id,field_definition_id,period_key,value_number,value_state,created_at,updated_at)
    VALUES(?,?,?,?, 'known',?,?)`).run(recordId,fieldId,periodKey,value,now,now);
}

test('dynamic report filters use the selected period and honor missing-value semantics', () => {
  const database = makeDatabase();
  try {
    const first = persist.upsertDirectorate(database,{ governorate:'إب',districtName:'مديرية أ',values:completeValues('مديرية أ') });
    const second = persist.upsertDirectorate(database,{ governorate:'إب',districtName:'مديرية ب',values:completeValues('مديرية ب',{ population:undefined }) });
    const fieldId = addDynamicField(database,'health_centres','عدد المراكز الصحية');
    const firstRecord = database.prepare("SELECT id FROM entity_records WHERE external_key=?").get(`legacy-directorate:${first.id}`).id;
    const secondRecord = database.prepare("SELECT id FROM entity_records WHERE external_key=?").get(`legacy-directorate:${second.id}`).id;
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
