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
