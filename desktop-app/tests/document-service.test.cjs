'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3-multiple-ciphers');
const documents = require('../src/main/documents/document-service.cjs');

function makeDatabase() {
  const database = new Database(':memory:');
  database.exec(`CREATE TABLE data_sources (
    id INTEGER PRIMARY KEY,
    source_type TEXT NOT NULL,
    document_title TEXT,
    file_name TEXT,
    mime_type TEXT,
    content_sha256 TEXT,
    file_size INTEGER,
    received_at TEXT,
    notes TEXT
  )`);
  documents.migrate(database);
  return database;
}

test('document library retains the original, deduplicates it, and stores review-only extraction', async () => {
  const database = makeDatabase();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'document-service-'));
  const filePath = path.join(directory, 'report.pdf');
  const original = Buffer.from('%PDF-1.7\noriginal bytes');
  fs.writeFileSync(filePath, original);

  try {
    const staged = await documents.stageFile(database, filePath);
    const duplicate = await documents.stageFile(database, filePath);
    assert.equal(staged.duplicate, false);
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.id, staged.id);

    const extraction = documents.persistExtraction(database, staged.id, {
      engine: { name: 'Test extractor', version: '1.0' },
      elements: [{ type: 'paragraph', content: 'معوقات مشروع المياه', page_number: 2, source: { file_name: 'report.pdf' } }],
      structured: { elements: [{ type: 'paragraph' }] },
      markdown: 'معوقات مشروع المياه',
      warnings: ['نتيجة مستخرجة للمراجعة'],
    });
    const saved = documents.readOriginal(database, staged.id);
    const selected = documents.getDocument(database, staged.id);
    const search = documents.searchDocuments(database, { query: 'مشروع المياه' });

    assert.equal(extraction.status, 'review');
    assert.deepEqual(saved.content, original);
    assert.equal(saved.sha256, staged.sha256);
    assert.equal(selected.document.status, 'review');
    assert.equal(selected.artifacts.find(item => item.artifact_type === 'markdown').content, 'معوقات مشروع المياه');
    assert.equal(search.rows.length, 1);
    assert.equal(search.rows[0].page_number, 2);
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('document worker receives only required environment variables and always runs offline', () => {
  const environment = documents.workerEnvironment({
    PATH: '/usr/bin',
    HOME: '/home/user',
    PADDLEOCR_DETECTION_MODEL_DIR: '/models/detector',
    API_TOKEN: 'must-not-leak',
    HF_HUB_OFFLINE: '0',
  });

  assert.equal(environment.PATH, '/usr/bin');
  assert.equal(environment.PADDLEOCR_DETECTION_MODEL_DIR, '/models/detector');
  assert.equal(environment.HF_HUB_OFFLINE, '1');
  assert.equal(environment.TRANSFORMERS_OFFLINE, '1');
  assert.equal(environment.PYTHONNOUSERSITE, '1');
  assert.equal(environment.API_TOKEN, undefined);
});

test('document staging rejects unsupported extensions and mismatched file signatures', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'document-preflight-'));
  const unsupportedPath = path.join(directory, 'report.xlsx');
  const invalidPdfPath = path.join(directory, 'report.pdf');
  fs.writeFileSync(unsupportedPath, 'not a document');
  fs.writeFileSync(invalidPdfPath, 'not a PDF');

  try {
    await assert.rejects(documents.inspectFile(unsupportedPath), /غير مدعوم/);
    await assert.rejects(documents.inspectFile(invalidPdfPath), /لا يطابق نوعه الفعلي/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
