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
      elements:[{ type:'paragraph',content:'population: ١٢٬٣٤٥',page_number:2 }],
      markdown:'population: ١٢٬٣٤٥',
    });
    const result = await discovery.discoverFields(database,{ documentId:staged.id });
    const registry = discovery.fieldRegistry(database);
    assert.equal(registry.length,67);
    assert.ok(registry.every(field => field.form_field && field.is_importable === 1 && !field.is_derived));
    assert.ok(registry.every(field => !field.form_code.startsWith('raw_collection_v1_')));
    assert.ok(registry.every(field => field.field_code !== 'directorate.reviewerDecision'));
    assert.ok(registry.find(field => field.field_code === 'education.school.type').referenceValues.length > 0);
    assert.deepEqual(registry.find(field => field.field_code === 'population.age_sex').dimensions.map(dimension => dimension.code),['sex','age_group']);
    const candidates = discovery.listCandidates(database,staged.id);
    const candidate = candidates.rows.find(row => row.field_key === 'population' && row.review_status === 'pending');
    assert.ok(candidate);
    assert.equal(candidate.raw_value,'١٢٬٣٤٥');
    assert.equal(candidate.suggested_value,'12345');
    assert.ok(candidate.confidence > 0.9);
    assert.ok(discovery.fieldRegistry(database).every(field => field.form_field));
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

test('field review groups repeated evidence once, keeps alternatives separate, and records a bundle', async () => {
  const database = makeDatabase();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),'ldi-field-review-group-'));
  const filePath = path.join(directory,'evidence.pdf');
  fs.writeFileSync(filePath,Buffer.from('%PDF-1.7\ngrouped field evidence'));
  try {
    const staged = await documents.stageFile(database,filePath);
    documents.persistExtraction(database,staged.id,{
      engine:{ name:'test-extractor',version:'1' },
      elements:[
        { type:'paragraph',content:'population: ١٢٬٣٤٥',page_number:2 },
        { type:'paragraph',content:'population: 12,345',page_number:2 },
        { type:'paragraph',content:'population: 20,000',page_number:2 },
        { type:'paragraph',content:'populaton: 50,000',page_number:3 },
      ],
      markdown:'population: ١٢٬٣٤٥\npopulation: 12,345\npopulation: 20,000\npopulaton: 50,000',
    });
    await discovery.discoverFields(database,{ documentId:staged.id });
    let fieldReview = discovery.listCandidates(database,staged.id);
    const record = fieldReview.records.find(item => item.key === `${staged.id}:page:2`);
    const fieldGroup = record.fields.find(item => item.fieldCode === 'directorate.population');
    assert.equal(fieldGroup.evidenceCount,3);
    assert.equal(fieldGroup.values.length,2);
    assert.equal(fieldGroup.values[0].evidenceCount,2);
    const nearHeading = fieldReview.rows.find(item => item.field_code === 'directorate.population' && item.retrieval_method === 'local-near-heading');
    assert.ok(nearHeading);
    assert.equal(nearHeading.validation_status,'needs-human-field-match-confirmation');
    assert.ok(nearHeading.confidence < 0.89);
    assert.equal(fieldReview.fields.length,67);
    const primaryCandidateId = fieldGroup.values[0].candidateIds[0];
    const result = discovery.reviewCandidateGroup(database,{
      documentId:staged.id,note:'تأكيد القيمة بعد مقارنة الأدلة الثلاثة',groups:[{
        status:'reviewed',candidateIds:fieldGroup.candidates.map(candidate => candidate.id),
        evidenceIds:fieldGroup.values[0].candidateIds,primaryCandidateId,value:fieldGroup.values[0].value,
      }],
    });
    assert.equal(result[0].updatedCount,3);
    fieldReview = discovery.listCandidates(database,staged.id);
    const reviewed = fieldReview.records.find(item => item.key === `${staged.id}:page:2`).fields.find(item => item.fieldCode === 'directorate.population');
    assert.equal(reviewed.status,'reviewed');
    assert.equal(reviewed.reviewedValue.primaryCandidateId,primaryCandidateId);
    assert.equal(reviewed.reviewedValue.evidenceBundleIds.length,2);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM directorates').get().count,0);
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
      elements:[
        { type:'paragraph',content:'اسم المديرية: مديرية الاختبار\nالمحافظة: صنعاء\nعدد السكان: 12345\nالسنة: ٢٠٢٥',page_number:2 },
        { type:'paragraph',content:'اسم المديرية: مديرية ثانية\nالمحافظة: عدن\nعدد السكان: 54321\nالسنة: ٢٠٢٤',page_number:3 },
      ],
      markdown:'اسم المديرية: مديرية الاختبار\nالمحافظة: صنعاء\nعدد السكان: 12345\nالسنة: ٢٠٢٥\nاسم المديرية: مديرية ثانية\nالمحافظة: عدن\nعدد السكان: 54321\nالسنة: ٢٠٢٤',
    });
    await discovery.discoverFields(database,{ documentId:staged.id });
    const fieldReview = discovery.listCandidates(database,staged.id);
    const candidates = fieldReview.rows.filter(row => ['directorate.districtName','directorate.governorate','directorate.population'].includes(row.field_code) && row.review_status === 'pending');
    assert.equal(fieldReview.contextSuggestions.global.periodConflict,true);
    assert.deepEqual(fieldReview.contextSuggestions.global.periodAlternatives,[2025,2024]);
    assert.equal(fieldReview.contextSuggestions.groups[`${staged.id}:page:2`].periodYear,2025);
    assert.equal(fieldReview.contextSuggestions.groups[`${staged.id}:page:3`].periodYear,2024);
    const firstRowCandidates = candidates.filter(row => row.page_number === 2);
    const secondRowCandidates = candidates.filter(row => row.page_number === 3);
    const candidate = firstRowCandidates.find(row => row.field_code === 'directorate.population');
    assert.equal(firstRowCandidates.length,3);
    assert.equal(secondRowCandidates.length,3);
    assert.ok(candidate);
    for (const item of candidates) discovery.reviewCandidate(database,{ candidateId:item.id,status:'reviewed',value:item.raw_value,note:'تمت المقارنة مع الصفحة الأصلية',reviewedBy:'owner-test' });
    const form = records.listForms(database).find(row => row.form_code === 'legacy_directorate_v1' && row.version_status === 'published');
    assert.ok(form);
    assert.throws(() => discovery.promoteReviewedCandidates(database,{
      documentId:staged.id,formVersionId:form.form_version_id,candidateIds:[candidate.id],
      fieldMappings:{ [candidate.id]:candidate.field_code },periodYear:2025,
    },{ actor:'owner-test' }),/حدّد المديرية/);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM form_records').get().count,0);
    assert.throws(() => discovery.promoteReviewedCandidates(database,{
      documentId:staged.id,formVersionId:form.form_version_id,candidateIds:firstRowCandidates.map(item => item.id),
      fieldMappings:{ ...Object.fromEntries(firstRowCandidates.map(item => [item.id,item.field_code])), [candidate.id]:'directorate.schools' },
      periodYear:2025,
    },{ actor:'owner-test' }),/مطابقة دلالية/);
    const rawForm = records.listForms(database).find(row => row.form_code.startsWith('raw_collection_v1_'));
    assert.ok(rawForm);
    assert.throws(() => discovery.promoteReviewedCandidates(database,{
      documentId:staged.id,formVersionId:rawForm.form_version_id,candidateIds:firstRowCandidates.map(item => item.id),
      fieldMappings:Object.fromEntries(firstRowCandidates.map(item => [item.id,item.field_code])),periodYear:2025,
    },{ actor:'owner-test' }),/التقاط خام/);
    database.prepare('UPDATE document_field_candidates SET page_number=3 WHERE id=?').run(candidate.id);
    assert.throws(() => discovery.promoteReviewedCandidates(database,{
      documentId:staged.id,formVersionId:form.form_version_id,candidateIds:firstRowCandidates.map(item => item.id),
      fieldMappings:Object.fromEntries(firstRowCandidates.map(item => [item.id,item.field_code])),periodYear:2025,
    },{ actor:'owner-test' }),/صفحة مصدر واحدة/);
    database.prepare('UPDATE document_field_candidates SET page_number=2 WHERE id=?').run(candidate.id);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM form_records').get().count,0);

    const firstRowMappings = Object.fromEntries(firstRowCandidates.map(item => [item.id,item.field_code]));
    const secondRowMappings = Object.fromEntries(secondRowCandidates.map(item => [item.id,item.field_code]));
    const candidateGroupsOriginal = [
      { candidateIds:firstRowCandidates.map(item => item.id),fieldMappings:firstRowMappings,recordLabel:'بيانات الصفحة الأولى',periodYear:2025 },
      { candidateIds:secondRowCandidates.map(item => item.id),fieldMappings:secondRowMappings,recordLabel:'بيانات الصفحة الثانية',periodYear:2024 },
    ];
    const geographic = require('../src/main/database/manual-entry-workflow.cjs');
    const firstGeoUnitId = geographic.ensureDirectorateGeography(database,'مديرية الاختبار','صنعاء','2026-01-01T00:00:00.000Z').geoUnitId;
    const secondGeoUnitId = geographic.ensureDirectorateGeography(database,'مديرية ثانية','عدن','2026-01-01T00:00:00.000Z').geoUnitId;
    const candidateGroups = [
      { ...candidateGroupsOriginal[0],geoUnitId:firstGeoUnitId },
      { ...candidateGroupsOriginal[1],geoUnitId:secondGeoUnitId },
    ];
    assert.throws(() => discovery.promoteReviewedCandidateGroups(database,{
      documentId:staged.id,formVersionId:form.form_version_id,candidateGroups:candidateGroupsOriginal,periodYear:2025,
    },{ actor:'owner-test' }),/حدّد المديرية/);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM form_records').get().count,0);
    assert.throws(() => discovery.promoteReviewedCandidateGroups(database,{
      documentId:staged.id,formVersionId:form.form_version_id,candidateGroups:[candidateGroups[0],{
        ...candidateGroups[1],fieldMappings:{ ...secondRowMappings,[secondRowCandidates.find(item => item.field_code === 'directorate.population').id]:'directorate.schools' },
      }],periodYear:2025,
    },{ actor:'owner-test' }),/مطابقة دلالية/);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM form_records').get().count,0);
    assert.throws(() => discovery.promoteReviewedCandidateGroups(database,{
      documentId:staged.id,formVersionId:form.form_version_id,candidateGroups:[candidateGroups[0],{ ...candidateGroups[1],periodYear:null }],periodYear:null,
    },{ actor:'owner-test' }),/الفترة المرجعية/);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM form_records').get().count,0);

    const result = discovery.promoteReviewedCandidateGroups(database,{
      documentId:staged.id,formVersionId:form.form_version_id,candidateGroups,recordLabel:'بيانات المديرية من الوثيقة',periodYear:2025,
    },{ actor:'owner-test' });
    assert.equal(result.recordCount,2);
    assert.equal(result.fieldCount,6);
    const firstRecord = result.records[0];
    const secondRecord = result.records[1];
    assert.equal(firstRecord.status,'pending_review');
    assert.equal(secondRecord.status,'pending_review');
    const firstSaved = records.getRecord(database,firstRecord.formRecordId);
    const secondSaved = records.getRecord(database,secondRecord.formRecordId);
    assert.equal(firstSaved.record.record_status,'pending_review');
    assert.equal(secondSaved.record.record_status,'pending_review');
    assert.equal(firstSaved.values['directorate.population'].value,'12345');
    assert.equal(secondSaved.values['directorate.population'].value,'54321');
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM form_records WHERE record_status='approved'").get().count,0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM document_candidate_promotions WHERE form_record_id=?').get(firstRecord.formRecordId).count,3);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM document_candidate_promotions WHERE form_record_id=?').get(secondRecord.formRecordId).count,3);
    const provenance = database.prepare(`SELECT p.provenance_type,p.source_locator,s.id AS data_source_id
      FROM value_provenance p LEFT JOIN record_field_values v USING(record_field_value_id) LEFT JOIN observations o USING(observation_id)
      JOIN form_fields ff ON ff.form_field_id=coalesce(v.form_field_id,o.form_field_id)
      JOIN data_sources s ON s.source_id=p.source_id
      WHERE coalesce(v.form_record_id,o.form_record_id)=? AND ff.field_code='directorate.population'`).get(firstRecord.formRecordId);
    assert.equal(provenance.provenance_type,'document_extraction');
    const sourceLocator = JSON.parse(provenance.source_locator);
    assert.equal(sourceLocator.candidateId,candidate.id);
    assert.equal(sourceLocator.rawValue,'12345');
    assert.equal(sourceLocator.sourceLocation.pageNumber,2);
    assert.equal(discovery.listCandidates(database,staged.id).rows.find(row => row.id === candidate.id).promoted_form_record_id,firstRecord.formRecordId);
    assert.throws(() => discovery.promoteReviewedCandidateGroups(database,{
      documentId:staged.id,formVersionId:form.form_version_id,candidateGroups,periodYear:2025,
    },{ actor:'owner-test' }),/لا يمكن ترحيل/);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM form_records').get().count,2);
  } finally {
    database.close();
    fs.rmSync(directory,{ recursive:true,force:true });
  }
});

test('reviewed candidates can be saved as drafts without submitting for central review', async () => {
  const database = makeDatabase();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),'ldi-candidate-draft-'));
  const filePath = path.join(directory,'draft.pdf');
  fs.writeFileSync(filePath,Buffer.from('%PDF-1.7\ndraft evidence'));
  try {
    const staged = await documents.stageFile(database,filePath);
    documents.persistExtraction(database,staged.id,{
      engine:{ name:'test-extractor',version:'1' },
      elements:[{ type:'paragraph',content:'اسم المديرية: مسودة الاختبار\nالمحافظة: صنعاء\nعدد السكان: 12345\nالسنة: 2025',page_number:1 }],
      markdown:'اسم المديرية: مسودة الاختبار\nالمحافظة: صنعاء\nعدد السكان: 12345\nالسنة: 2025',
    });
    await discovery.discoverFields(database,{ documentId:staged.id });
    const candidates = discovery.listCandidates(database,staged.id).rows.filter(candidate =>
      ['directorate.districtName','directorate.governorate','directorate.population'].includes(candidate.field_code) && candidate.review_status === 'pending');
    for (const candidate of candidates) discovery.reviewCandidate(database,{ candidateId:candidate.id,status:'reviewed',value:candidate.raw_value,note:'تم التحقق من بيانات المصدر' });
    const form = records.listForms(database).find(row => row.form_code === 'legacy_directorate_v1' && row.version_status === 'published');
    const geoUnitId = require('../src/main/database/manual-entry-workflow.cjs').ensureDirectorateGeography(database,'مسودة الاختبار','صنعاء','2026-01-01T00:00:00.000Z').geoUnitId;
    const result = discovery.promoteReviewedCandidateGroups(database,{
      documentId:staged.id,formVersionId:form.form_version_id,submitForReview:false,
      candidateGroups:[{
        candidateIds:candidates.map(candidate => candidate.id),
        fieldMappings:Object.fromEntries(candidates.map(candidate => [candidate.id,candidate.field_code])),periodYear:2025,geoUnitId,
      }],
    },{ actor:'owner-test' });
    assert.equal(result.records[0].status,'draft');
    assert.equal(records.getRecord(database,result.records[0].formRecordId).record.record_status,'draft');
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM form_records WHERE record_status='pending_review'").get().count,0);
  } finally {
    database.close();
    fs.rmSync(directory,{ recursive:true,force:true });
  }
});
