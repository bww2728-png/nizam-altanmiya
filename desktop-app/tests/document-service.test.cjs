'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const test = require('node:test');
const Database = require('better-sqlite3-multiple-ciphers');
const ExcelJS = require('exceljs');
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

function zipFiles(files) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameBytes = Buffer.from(name);
    const data = Buffer.from(content);
    const compressed = zlib.deflateRawSync(data);
    const checksum = zlib.crc32(data);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(8, 8);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(nameBytes.length, 26);
    localParts.push(localHeader, nameBytes, compressed);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(nameBytes.length, 28);
    centralHeader.writeUInt32LE(localOffset, 42);
    centralParts.push(centralHeader, nameBytes);
    localOffset += localHeader.length + nameBytes.length + compressed.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0);
  endRecord.writeUInt16LE(Object.keys(files).length, 8);
  endRecord.writeUInt16LE(Object.keys(files).length, 10);
  endRecord.writeUInt32LE(centralDirectory.length, 12);
  endRecord.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, centralDirectory, endRecord]);
}

test('DOCX extraction runs locally without a Python installation', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'document-docx-'));
  const filePath = path.join(directory, 'report.docx');
  const xml = '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>اسم المديرية: الحديدة &amp; صنعاء</w:t></w:r></w:p><w:p><w:r><w:t>عدد السكان: ١٢٣٤</w:t></w:r></w:p></w:body></w:document>';
  fs.writeFileSync(filePath, zipFiles({
    '[Content_Types].xml': '<Types/>',
    '_rels/.rels': '<Relationships/>',
    'word/document.xml': xml,
  }));
  try {
    await documents.inspectFile(filePath);
    const result = await documents.runWorker(filePath, { python: 'python-command-that-is-not-installed' });
    assert.equal(result.engine.name, 'Local DOCX parser');
    assert.deepEqual(result.elements.map(element => element.content), ['اسم المديرية: الحديدة & صنعاء', 'عدد السكان: ١٢٣٤']);
    assert.equal(result.elements[0].source.file_name, 'report.docx');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Excel workbooks are scanned locally into row evidence with sheet and cell references', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'document-xlsx-'));
  const filePath = path.join(directory, 'population.xlsx');
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('السكان');
  worksheet.addRow(['عدد السكان', 'السنة']);
  worksheet.addRow(['١٢٬٣٤٥', 2025]);
  await workbook.xlsx.writeFile(filePath);
  try {
    const inspected = await documents.inspectFile(filePath);
    assert.equal(inspected.extension, '.xlsx');
    const result = await documents.runWorker(filePath, { python: 'python-command-that-is-not-installed' });
    assert.equal(result.engine.name, 'Local ExcelJS parser');
    assert.match(result.elements[0].content, /عدد السكان: ١٢٬٣٤٥/);
    assert.equal(result.elements[0].source.sheet_name, 'السكان');
    assert.equal(result.elements[0].source.row_number, 2);
    assert.equal(result.elements[0].source.cells[0].address, 'A2');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('document center maps reviewed candidates through protected IPC without exposing service credentials', () => {
  const interfaceSource = fs.readFileSync(path.join(__dirname, '../src/renderer/pages/DocumentCenter.jsx'), 'utf8');
  const preloadSource = fs.readFileSync(path.join(__dirname, '../src/main/preload.cjs'), 'utf8');
  const mainSource = fs.readFileSync(path.join(__dirname, '../src/main/main.cjs'), 'utf8');
  assert.doesNotMatch(interfaceSource, /RAGFlow|API key|مفتاح API|Bearer API|معرّف مجموعة/);
  assert.match(interfaceSource, /promoteDocumentFieldCandidates/);
  assert.match(interfaceSource, /لا تصبح القيم رسمية حتى يعتمدها المراجع/);
  assert.match(preloadSource, /promoteDocumentFieldCandidates: \(request\) => ipcRenderer\.invoke\('documents:field-candidates:promote', request\)/);
  assert.match(mainSource, /ipcMain\.handle\('documents:field-candidates:promote'[\s\S]*currentProfile\(\) !== 'owner'/);
  assert.doesNotMatch(preloadSource, /saveRagflowConfig|ragflow:save-config/);
});

test('Windows worker command-not-found errors explain the missing local engine', () => {
  assert.match(documents.workerExitError(9009, '').message, /محرك معالجة PDF أو الصور.*9009/);
  assert.match(documents.workerExitError(1, 'ModuleNotFoundError').message, /ModuleNotFoundError/);
});

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
  const unsupportedPath = path.join(directory, 'report.xls');
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
