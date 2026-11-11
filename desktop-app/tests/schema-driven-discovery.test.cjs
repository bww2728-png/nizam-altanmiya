'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3-multiple-ciphers');
const { migrate } = require('../src/main/analysis/store-schema.cjs');
const documents = require('../src/main/documents/document-service.cjs');
const discovery = require('../src/main/documents/schema-driven-discovery.cjs');
const records = require('../src/main/database/record-service.cjs');

function makeDatabase() {
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  migrate(database);
  return database;
}

test('schema-driven discovery creates evidence-linked review candidates without changing official records', async () => {
  const database = makeDatabase();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),'ldi-field-discovery-'));
  const filePath = path.join(directory,'evidence.pdf');
  fs.writeFileSync(filePath,Buffer.from('%PDF-1.7\nfield evidence'));
  try {
    const staged = await documents.stageFile(database,filePath);
    documents.persistExtraction(database,staged.id,{
      engine:{ name:'test-extractor',version:'1' },
      elements:[{ type:'paragraph',content:'population: 12345',page_number:2 }],
      markdown:'population: 12345',
    });
    const result = await discovery.discoverFields(database,{ documentId:staged.id });
    const candidates = discovery.listCandidates(database,staged.id);
    const candidate = candidates.rows.find(row => row.field_key === 'population' && row.review_status === 'pending');
    assert.ok(candidate);
    assert.equal(candidate.raw_value,'12345');
    assert.equal(candidate.source_document_id,staged.id);
    assert.equal(candidate.source_file_name,'evidence.pdf');
    assert.equal(candidate.page_number,2);
    assert.equal(result.evidenceCount,1);
    assert.ok(result.noEvidenceCount > 0);

    assert.throws(() => discovery.reviewCandidate(database,{ candidateId:candidate.id,status:'reviewed',value:'12000' }),/سبب/);
    const review = discovery.reviewCandidate(database,{ candidateId:candidate.id,status:'reviewed',value:'12000',note:'تأكيد بعد مقارنة المصدر' });
    assert.equal(review.officialDataChanged,false);
    assert.ok(review.reviewedAt);
    assert.equal(discovery.listCandidates(database,staged.id).rows.find(row => row.id === candidate.id).reviewedValue.value,'12000');
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM directorates').get().count,0);
    assert.throws(() => discovery.reviewCandidate(database,{ candidateId:candidate.id,status:'rejected',note:'مراجعة ثانية' }),/سابقًا/);
  } finally {
    database.close();
    fs.rmSync(directory,{ recursive:true,force:true });
  }
});

test('reviewed document candidates create a linked standard record awaiting approval', async () => {
  const database = makeDatabase();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),'ldi-candidate-promotion-'));
  const filePath = path.join(directory,'evidence.pdf');
  fs.writeFileSync(filePath,Buffer.from('%PDF-1.7\nfield evidence'));
  try {
    const staged = await documents.stageFile(database,filePath);
    documents.persistExtraction(database,staged.id,{
      engine:{ name:'test-extractor',version:'1' },
      elements:[{ type:'paragraph',content:'اسم المديرية: مديرية الاختبار\nالمحافظة: صنعاء\nعدد السكان: 12345',page_number:2 }],
      markdown:'اسم المديرية: مديرية الاختبار\nالمحافظة: صنعاء\nعدد السكان: 12345',
    });
    await discovery.discoverFields(database,{ documentId:staged.id });
    const candidates = discovery.listCandidates(database,staged.id).rows.filter(row => ['directorate.districtName','directorate.governorate','directorate.population'].includes(row.field_code) && row.review_status === 'pending');
    const candidate = candidates.find(row => row.field_code === 'directorate.population');
    assert.ok(candidate);
    for (const item of candidates) discovery.reviewCandidate(database,{ candidateId:item.id,status:'reviewed',value:item.raw_value,note:'تمت المقارنة مع الصفحة الأصلية',reviewedBy:'owner-test' });
    const form = records.listForms(database).find(row => row.form_code === 'legacy_directorate_v1' && row.version_status === 'published');
    assert.ok(form);
    assert.throws(() => discovery.promoteReviewedCandidates(database,{
      documentId:staged.id,formVersionId:form.form_version_id,candidateIds:[candidate.id],
      fieldMappings:{ [candidate.id]:candidate.field_code },periodYear:2025,
    },{ actor:'owner-test' }),/اسم المديرية/);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM form_records').get().count,0);

    const result = discovery.promoteReviewedCandidates(database,{
      documentId:staged.id,
      formVersionId:form.form_version_id,
      candidateIds:candidates.map(item => item.id),
      fieldMappings:Object.fromEntries(candidates.map(item => [item.id,item.field_code])),
      recordLabel:'بيانات المديرية من الوثيقة',
      periodYear:2025,
    },{ actor:'owner-test' });
    assert.equal(result.status,'pending_review');
    assert.equal(result.fieldCount,3);
    const saved = records.getRecord(database,result.formRecordId);
    assert.equal(saved.record.record_status,'pending_review');
    assert.equal(saved.values['directorate.population'].value,'12345');
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM form_records WHERE record_status='approved'").get().count,0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM document_candidate_promotions WHERE form_record_id=?').get(result.formRecordId).count,3);
    const provenance = database.prepare(`SELECT p.provenance_type,p.source_locator,s.id AS data_source_id
      FROM value_provenance p LEFT JOIN record_field_values v USING(record_field_value_id) LEFT JOIN observations o USING(observation_id)
      JOIN form_fields ff ON ff.form_field_id=coalesce(v.form_field_id,o.form_field_id)
      JOIN data_sources s ON s.source_id=p.source_id
      WHERE coalesce(v.form_record_id,o.form_record_id)=? AND ff.field_code='directorate.population'`).get(result.formRecordId);
    assert.equal(provenance.provenance_type,'document_extraction');
    assert.equal(JSON.parse(provenance.source_locator).candidateId,candidate.id);
    assert.equal(discovery.listCandidates(database,staged.id).rows.find(row => row.id === candidate.id).promoted_form_record_id,result.formRecordId);
    assert.throws(() => discovery.promoteReviewedCandidates(database,{
      documentId:staged.id,formVersionId:form.form_version_id,candidateIds:candidates.map(item => item.id),
      fieldMappings:Object.fromEntries(candidates.map(item => [item.id,item.field_code])),
    },{ actor:'owner-test' }),/لا يمكن ترحيل/);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM form_records').get().count,1);
  } finally {
    database.close();
    fs.rmSync(directory,{ recursive:true,force:true });
  }
});
