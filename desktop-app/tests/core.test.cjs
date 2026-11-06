const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const ExcelJS = require('exceljs');
const JSZip = require('jszip');
const { extractExcel, extractFile, extractPdf } = require('../src/main/importers.cjs');
const { openEncryptedStore, loadOrCreateStoreKey } = require('../src/main/store.cjs');
const { saveImportBatch, updateReviewItem, resolveReviewItems } = require('../src/main/repository.cjs');

function withTemporaryDirectory(callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'local-development-intelligence-'));
  const cleanup = () => fs.rmSync(directory, { recursive: true, force: true });
  try {
    const result = callback(directory);
    if (result && typeof result.then === 'function') return result.finally(cleanup);
    cleanup();
    return result;
  } catch (error) {
    cleanup();
    throw error;
  }
}

async function createSampleWorkbook(filePath) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('البيانات');
  sheet.addRow(['التجمع', 'عدد السكان', 'ملاحظة']);
  sheet.addRow(['قرية الاختبار', 0, 'تم التحقق']);
  sheet.addRow(['قرية أخرى', 27, null]);
  await workbook.xlsx.writeFile(filePath);
}

// Simulates workbooks written by generators such as openpyxl, which emit namespace prefixes
// instead of the canonical ones: <ns0:Relationships>, <ct:Types>, <ns0:Properties>, and
// ns0/ns2 in place of cp/dcterms inside docProps/core.xml.
async function rewriteWorkbookWithGeneratedPrefixes(filePath) {
  const archive = await JSZip.loadAsync(fs.readFileSync(filePath));
  const patch = async (name, transform) => {
    const text = await archive.files[name].async('string');
    archive.file(name, transform(text));
  };
  const relationshipsUri = 'http://schemas.openxmlformats.org/package/2006/relationships';
  const prefixRelationships = (xml) =>
    xml
      .replace('<Relationships ', `<ns0:Relationships xmlns:ns0="${relationshipsUri}" `)
      .replace('</Relationships>', '</ns0:Relationships>')
      .replaceAll('<Relationship ', '<ns0:Relationship ')
      .replaceAll('</Relationship>', '</ns0:Relationship>');

  await patch('_rels/.rels', prefixRelationships);
  await patch('xl/_rels/workbook.xml.rels', prefixRelationships);
  await patch('[Content_Types].xml', (xml) =>
    xml
      .replace('<Types ', '<ct:Types xmlns:ct="http://schemas.openxmlformats.org/package/2006/content-types" ')
      .replace('</Types>', '</ct:Types>')
      .replaceAll('<Default ', '<ct:Default ')
      .replaceAll('<Override ', '<ct:Override ')
  );
  await patch('docProps/app.xml', (xml) =>
    xml
      .replace('<Properties ', '<ns0:Properties xmlns:ns0="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" ')
      .replace('</Properties>', '</ns0:Properties>')
      .replaceAll('<Company>', '<ns0:Company>')
      .replaceAll('</Company>', '</ns0:Company>')
  );
  await patch('docProps/core.xml', (xml) =>
    xml
      .replaceAll('<cp:', '<ns0:')
      .replaceAll('</cp:', '</ns0:')
      .replaceAll('<dcterms:', '<ns2:')
      .replaceAll('</dcterms:', '</ns2:')
      .replace(
        '<ns0:coreProperties ',
        '<ns0:coreProperties xmlns:ns0="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:ns2="http://purl.org/dc/terms/" '
      )
  );
  fs.writeFileSync(filePath, await archive.generateAsync({ type: 'nodebuffer' }));
}

async function createSampleDocx(filePath) {
  const archive = new JSZip();
  archive.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  archive.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  archive.file('word/document.xml', '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>عدد السكان: 42</w:t></w:r></w:p><w:sectPr/></w:body></w:document>');
  fs.writeFileSync(filePath, await archive.generateAsync({ type: 'nodebuffer' }));
}

function createTextPdf(filePath, text) {
  const content = `BT /F1 18 Tf 48 740 Td (${text.replace(/[()\\\\]/g, '\\\\$&')}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(content)} >>\\nstream\\n${content}\\nendstream`,
  ];
  let pdf = '%PDF-1.4\\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\\n${object}\\nendobj\\n`;
  });
  const crossReferenceOffset = Buffer.byteLength(pdf);
  pdf += `xref\\n0 ${objects.length + 1}\\n0000000000 65535 f \\n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \\n`).join('')}trailer\\n<< /Size ${objects.length + 1} /Root 1 0 R >>\\nstartxref\\n${crossReferenceOffset}\\n%%EOF`;
  fs.writeFileSync(filePath, pdf.replaceAll('\\n', String.fromCharCode(10)));
}

test('encrypted store persists data and rejects an incorrect key', () => {
  withTemporaryDirectory((directory) => {
    const databasePath = path.join(directory, 'secure.db');
    const database = openEncryptedStore(databasePath, 'correct-local-passphrase');
    database.prepare('INSERT INTO import_batches(file_name,file_type,file_size,created_at) VALUES(?,?,?,?)').run('test.xlsx', 'xlsx', 10, '2026-01-01T00:00:00.000Z');
    database.close();
    const reopened = openEncryptedStore(databasePath, 'correct-local-passphrase');
    assert.equal(reopened.prepare('SELECT COUNT(*) AS count FROM import_batches').get().count, 1);
    reopened.close();
    assert.throws(() => openEncryptedStore(databasePath, 'incorrect-local-passphrase'), /تعذر فتح قاعدة البيانات/);
    assert.notEqual(fs.readFileSync(databasePath).subarray(0, 16).toString(), 'SQLite format 3\u0000');
  });
});

test('generated store key is created once, reused, and opens the same database', () => {
  withTemporaryDirectory((directory) => {
    const keyPath = path.join(directory, 'store.key');
    const databasePath = path.join(directory, 'development-data.db');

    const generated = loadOrCreateStoreKey(keyPath);
    assert.match(generated, /^[0-9a-f]{64}$/);
    // Re-opening must return the very same key, otherwise the encrypted file becomes unreadable.
    assert.equal(loadOrCreateStoreKey(keyPath), generated);

    const database = openEncryptedStore(databasePath, generated);
    database.prepare('INSERT INTO import_batches(file_name,file_type,file_size,created_at) VALUES(?,?,?,?)').run('auto.xlsx', 'xlsx', 10, '2026-01-01T00:00:00.000Z');
    database.close();

    const reopened = openEncryptedStore(databasePath, loadOrCreateStoreKey(keyPath));
    assert.equal(reopened.prepare('SELECT COUNT(*) AS count FROM import_batches').get().count, 1);
    reopened.close();
    // The file must stay opaque on disk, i.e. still encrypted by SQLCipher.
    assert.notEqual(fs.readFileSync(databasePath).subarray(0, 16).toString(), 'SQLite format 3\u0000');
  });
});

test('review accepts only complete geographic keys and retains field source', () => {
  withTemporaryDirectory((directory) => {
    const database = openEncryptedStore(path.join(directory, 'review.db'), 'review-local-passphrase');
    const batchId = saveImportBatch(database, {
      fileName: 'field.xlsx', fileType: 'xlsx', fileSize: 100, warnings: [],
      items: [
        { fieldName: 'عدد السكان', value: '0', sourceLocation: 'ورقة «البيانات»، الخلية B2', confidence: 1 },
        { fieldName: 'عدد السكان', value: '12', sourceLocation: 'ورقة «البيانات»، الخلية B3', confidence: 1 },
      ],
    }, '2026-01-01T00:00:00.000Z');
    const items = database.prepare('SELECT * FROM review_items WHERE batch_id=? ORDER BY id').all(batchId);
    updateReviewItem(database, { id: items[0].id, fieldName: 'عدد السكان', value: '0', proposedType: 'تجمع سكاني', governorate: 'المحافظة', district: 'المديرية', subdistrict: 'العزلة', settlement: 'القرية', recordId: 'population' });
    updateReviewItem(database, { id: items[1].id, fieldName: 'عدد السكان', value: '12', proposedType: 'تجمع سكاني', governorate: 'المحافظة', district: 'المديرية', subdistrict: 'العزلة', settlement: 'القرية', recordId: 'population' });
    const incomplete = resolveReviewItems(database, { action: 'accept', ids: [items[0].id] });
    assert.deepEqual(incomplete, { accepted: 1, rejected: 0, conflicts: 0, ignored: 0 });
    const conflict = resolveReviewItems(database, { action: 'accept', ids: [items[1].id] });
    assert.equal(conflict.conflicts, 1);
    const accepted = database.prepare('SELECT value_text,source_file,source_location FROM data_values').get();
    assert.deepEqual(accepted, { value_text: '0', source_file: 'field.xlsx', source_location: 'ورقة «البيانات»، الخلية B2' });
    const replaced = resolveReviewItems(database, { action: 'replace', ids: [items[1].id] });
    assert.equal(replaced.accepted, 1);
    assert.equal(database.prepare('SELECT value_text FROM data_values').get().value_text, '12');
    database.close();
  });
});

test('review blocks missing geography and preserves draft for correction', () => {
  withTemporaryDirectory((directory) => {
    const database = openEncryptedStore(path.join(directory, 'incomplete.db'), 'incomplete-local-passphrase');
    const batchId = saveImportBatch(database, { fileName: 'a.xlsx', fileType: 'xlsx', fileSize: 10, items: [{ fieldName: 'حقل', value: 'قيمة', sourceLocation: 'A1', confidence: 1 }] });
    const item = database.prepare('SELECT id FROM review_items WHERE batch_id=?').get(batchId);
    const result = resolveReviewItems(database, { action: 'accept', ids: [item.id] });
    assert.equal(result.ignored, 1);
    assert.equal(database.prepare('SELECT status FROM review_items WHERE id=?').get(item.id).status, 'pending');
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM data_values').get().count, 0);
    assert.throws(() => updateReviewItem(database, { id: item.id, fieldName: 'a'.repeat(301), value: 'قيمة' }), /أطول من المسموح/);
    database.close();
  });
});

test('Excel extraction preserves zero values and exact worksheet cell references', async () => {
  await withTemporaryDirectory(async (directory) => {
    const workbookPath = path.join(directory, 'sample.xlsx');
    await createSampleWorkbook(workbookPath);
    const result = await extractExcel(workbookPath);
    assert.equal(result.pages, 1);
    assert.equal(result.truncated, false);
    assert.ok(result.items.some((item) => item.fieldName === 'عدد السكان' && item.value === '0' && item.sourceLocation.includes('B2')));
    assert.ok(result.items.some((item) => item.fieldName === 'التجمع' && item.value === 'قرية الاختبار' && item.sourceLocation.includes('A2')));
  });
});

test('Excel extraction recovers workbooks whose package parts use generated namespace prefixes', async () => {
  await withTemporaryDirectory(async (directory) => {
    const workbookPath = path.join(directory, 'prefixed.xlsx');
    await createSampleWorkbook(workbookPath);
    await rewriteWorkbookWithGeneratedPrefixes(workbookPath);

    let rejected = false;
    try {
      await new ExcelJS.Workbook().xlsx.readFile(workbookPath);
    } catch {
      rejected = true;
    }
    assert.equal(rejected, true, 'fixture must still reproduce the ExcelJS prefix limitation');

    const result = await extractExcel(workbookPath);
    assert.equal(result.pages, 1);
    assert.equal(result.truncated, false);
    assert.ok(result.items.some((item) => item.value === '0' && item.sourceLocation.includes('B2')));
    assert.ok(result.items.some((item) => item.value === '27'));
  });
});

test('PDF text extraction retains page and line provenance without network OCR', async () => {
  await withTemporaryDirectory(async (directory) => {
    const pdfPath = path.join(directory, 'text.pdf');
    createTextPdf(pdfPath, 'District: Example');
    const result = await extractPdf(pdfPath);
    assert.equal(result.pages, 1);
    assert.equal(result.items[0].fieldName, 'District');
    assert.equal(result.items[0].value, 'Example');
    assert.equal(result.items[0].sourceLocation, 'PDF، الصفحة 1، السطر 1');
    assert.equal(result.items[0].recordId, 'pdf:1:1');
    assert.deepEqual(result.warnings, []);
  });
});

test('Word extraction keeps field values and line locations for review', async () => {
  await withTemporaryDirectory(async (directory) => {
    const wordPath = path.join(directory, 'field.docx');
    await createSampleDocx(wordPath);
    const result = await extractFile(wordPath);
    assert.equal(result.fileType, 'docx');
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].fieldName, 'عدد السكان');
    assert.equal(result.items[0].value, '42');
    assert.equal(result.items[0].sourceLocation, 'مستند Word، السطر 1');
    assert.equal(result.items[0].proposedType, 'مستند Word');
  });
});

test('file importer rejects unsupported and empty files', async () => {
  await withTemporaryDirectory(async (directory) => {
    const empty = path.join(directory, 'empty.docx');
    fs.writeFileSync(empty, '');
    await assert.rejects(extractFile(empty), /فارغ أو غير صالح/);
    const unsupported = path.join(directory, 'legacy.xls');
    fs.writeFileSync(unsupported, 'data');
    await assert.rejects(extractFile(unsupported), /الامتدادات المدعومة/);
  });
});
