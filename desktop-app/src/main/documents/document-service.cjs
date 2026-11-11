'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
const unzipper = require('unzipper');
const { SaxesParser } = require('saxes');

const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 24 * 1024 * 1024;
const MAX_ELEMENTS = 50000;
const MAX_ELEMENT_CHARS = 200000;
const PROCESS_TIMEOUT_MS = 120000;
const WORKER_ENV_KEYS = Object.freeze([
  'PATH', 'HOME', 'USERPROFILE', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'LOCALAPPDATA',
  'HF_HOME', 'HUGGINGFACE_HUB_CACHE', 'TRANSFORMERS_CACHE',
  'PADDLEOCR_DETECTION_MODEL_DIR', 'PADDLEOCR_RECOGNITION_MODEL_DIR', 'OMP_NUM_THREADS',
]);
const MIME_TYPES = Object.freeze({
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
});

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS document_records (
    id TEXT PRIMARY KEY,
    source_id INTEGER NOT NULL REFERENCES data_sources(id),
    file_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    file_size INTEGER NOT NULL CHECK(file_size > 0),
    sha256 TEXT NOT NULL,
    original_content BLOB NOT NULL,
    status TEXT NOT NULL DEFAULT 'staged' CHECK(status IN ('staged','processing','extracted','review','failed')),
    engine_name TEXT,
    engine_version TEXT,
    processing_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(sha256)
  );
  CREATE INDEX IF NOT EXISTS document_records_created_idx ON document_records(created_at DESC);
  CREATE TABLE IF NOT EXISTS document_processing_runs (
    id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES document_records(id) ON DELETE CASCADE,
    engine_name TEXT NOT NULL,
    engine_version TEXT,
    status TEXT NOT NULL CHECK(status IN ('running','completed','failed','unavailable')),
    warning_json TEXT NOT NULL DEFAULT '[]',
    error_text TEXT,
    started_at TEXT NOT NULL,
    completed_at TEXT
  );
  CREATE INDEX IF NOT EXISTS document_processing_runs_doc_idx ON document_processing_runs(document_id, started_at DESC);
  CREATE TABLE IF NOT EXISTS document_artifacts (
    id INTEGER PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES document_records(id) ON DELETE CASCADE,
    artifact_type TEXT NOT NULL CHECK(artifact_type IN ('structured-json','markdown','ocr-json')),
    content TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(document_id, artifact_type)
  );
  CREATE TABLE IF NOT EXISTS document_elements (
    id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES document_records(id) ON DELETE CASCADE,
    sequence_number INTEGER NOT NULL,
    element_type TEXT NOT NULL,
    heading TEXT,
    content TEXT NOT NULL,
    search_text TEXT NOT NULL,
    page_number INTEGER,
    position_json TEXT,
    confidence REAL,
    source_json TEXT NOT NULL DEFAULT '{}',
    UNIQUE(document_id, sequence_number)
  );
  CREATE INDEX IF NOT EXISTS document_elements_page_idx ON document_elements(document_id, page_number, sequence_number);
  CREATE TABLE IF NOT EXISTS document_ragflow_references (
    id INTEGER PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES document_records(id) ON DELETE CASCADE,
    dataset_id TEXT NOT NULL,
    ragflow_document_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('uploaded','processing','indexed','failed')),
    updated_at TEXT NOT NULL,
    UNIQUE(document_id, dataset_id),
    UNIQUE(dataset_id, ragflow_document_id)
  );
  CREATE INDEX IF NOT EXISTS document_ragflow_refs_status_idx ON document_ragflow_references(status, updated_at);
`;

function migrate(database) {
  database.exec(SCHEMA);
}

async function inspectFile(filePath, fileSystem = fs) {
  const resolved = path.resolve(filePath);
  const stat = fileSystem.statSync(resolved);
  if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_FILE_BYTES) {
    throw new Error('حجم الملف غير صالح؛ الحد الأقصى لمعالجة الوثائق 50 ميغابايت.');
  }
  const extension = path.extname(resolved).toLowerCase();
  const mimeType = MIME_TYPES[extension];
  if (!mimeType) throw new Error('نوع الملف غير مدعوم في مركز الوثائق.');
  const handle = fileSystem.openSync(resolved, 'r');
  const header = Buffer.alloc(16);
  try { fileSystem.readSync(handle, header, 0, header.length, 0); } finally { fileSystem.closeSync(handle); }
  const valid = extension === '.pdf' ? header.subarray(0, 5).toString('ascii') === '%PDF-'
    : extension === '.png' ? header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : extension === '.jpg' || extension === '.jpeg' ? header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff
        : extension === '.tif' || extension === '.tiff' ? ['II*\\0', 'MM\\0*'].some((signature) => header.subarray(0, 4).toString('binary') === signature)
          : header[0] === 0x50 && header[1] === 0x4b;
  if (!valid) throw new Error('محتوى الملف لا يطابق نوعه الفعلي؛ لم يُحفظ.');
  if (extension === '.docx') await inspectDocxPackage(resolved);
  return { filePath: resolved, extension, mimeType, size: stat.size };
}

async function inspectDocxPackage(filePath) {
  let archive;
  try { archive = await unzipper.Open.file(filePath); }
  catch { throw new Error('حزمة Word تالفة أو غير قابلة للقراءة.'); }
  if (archive.files.length < 3 || archive.files.length > 10000) throw new Error('عدد عناصر ملف Word يتجاوز الحد الآمن.');
  const required = new Set(['[Content_Types].xml', 'word/document.xml']);
  let totalUncompressed = 0;
  for (const entry of archive.files) {
    const name = String(entry.path ?? '');
    const segments = name.split(/[\\/]/);
    if (!name || name.startsWith('/') || /^[A-Za-z]:/.test(name) || segments.includes('..') || name.includes(String.fromCharCode(0))) {
      throw new Error('يحتوي ملف Word على مسار داخلي غير آمن.');
    }
    if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0 || entry.uncompressedSize > 128 * 1024 * 1024) {
      throw new Error('عنصر داخل ملف Word يتجاوز حد الحجم بعد فك الضغط.');
    }
    if (!Number.isSafeInteger(entry.compressedSize) || entry.compressedSize < 0) throw new Error('بيانات ضغط غير صالحة داخل ملف Word.');
    totalUncompressed += entry.uncompressedSize;
    if (totalUncompressed > 256 * 1024 * 1024) throw new Error('الحجم الإجمالي لملف Word بعد فك الضغط يتجاوز الحد الآمن.');
    if (entry.uncompressedSize > 0 && (entry.compressedSize === 0 || entry.uncompressedSize / entry.compressedSize > 300)) {
      throw new Error('نسبة ضغط مفرطة داخل ملف Word.');
    }
    required.delete(name);
  }
  if (required.size) throw new Error('ملف Word يفتقد أجزاء المستند الأساسية.');
}

async function stageFile(database, filePath) {
  const inspected = await inspectFile(filePath);
  const content = fs.readFileSync(inspected.filePath);
  if (content.length !== inspected.size) throw new Error('تغير حجم الملف أثناء قراءته؛ أُوقفت العملية.');
  const sha256 = crypto.createHash('sha256').update(content).digest('hex');
  const existing = database.prepare('SELECT id,file_name,status,sha256 FROM document_records WHERE sha256=?').get(sha256);
  if (existing) return { ...existing, duplicate: true };
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const save = database.transaction(() => {
    const source = database.prepare(`INSERT INTO data_sources
      (source_type,document_title,file_name,mime_type,content_sha256,file_size,received_at,notes)
      VALUES('document',?,?,?,?,?,?,?)`).run(path.basename(inspected.filePath), path.basename(inspected.filePath), inspected.mimeType, sha256, content.length, now, 'نسخة أصلية محفوظة داخل قاعدة البيانات المحلية المشفرة.');
    database.prepare(`INSERT INTO document_records
      (id,source_id,file_name,mime_type,file_size,sha256,original_content,status,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,'staged',?,?)`)
      .run(id, Number(source.lastInsertRowid), path.basename(inspected.filePath), inspected.mimeType, content.length, sha256, content, now, now);
  });
  save();
  return { id, file_name: path.basename(inspected.filePath), status: 'staged', sha256, duplicate: false };
}

function listDocuments(database, request = {}) {
  const limit = Math.max(1, Math.min(100, Math.trunc(Number(request.limit) || 30)));
  const offset = Math.max(0, Math.trunc(Number(request.offset) || 0));
  const rows = database.prepare(`SELECT id,file_name,mime_type,file_size,sha256,status,engine_name,engine_version,processing_error,created_at,updated_at
    FROM document_records ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(limit, offset);
  const total = database.prepare('SELECT COUNT(*) AS total FROM document_records').get().total;
  return { rows, total, offset, limit, hasNext: offset + rows.length < total };
}

function getDocument(database, id) {
  const document = database.prepare(`SELECT id,source_id,file_name,mime_type,file_size,sha256,status,engine_name,engine_version,processing_error,created_at,updated_at
    FROM document_records WHERE id=?`).get(String(id));
  if (!document) throw new Error('الوثيقة غير موجودة.');
  const artifacts = database.prepare('SELECT artifact_type,content,created_at FROM document_artifacts WHERE document_id=? ORDER BY artifact_type').all(document.id);
  const elements = database.prepare(`SELECT id,sequence_number,element_type,heading,content,page_number,position_json,confidence,source_json
    FROM document_elements WHERE document_id=? ORDER BY sequence_number LIMIT 1000`).all(document.id);
  const ragflowReferences = listRagflowReferences(database, document.id);
  return { document, artifacts, elements, ragflowReferences };
}

function readOriginal(database, id) {
  const row = database.prepare('SELECT id,file_name,mime_type,sha256,original_content FROM document_records WHERE id=?').get(String(id));
  if (!row) throw new Error('الوثيقة غير موجودة.');
  return { id: row.id, file_name: row.file_name, mime_type: row.mime_type, sha256: row.sha256, content: Buffer.from(row.original_content) };
}

function saveRagflowReference(database, documentId, datasetId, ragflowDocumentId, status) {
  if (!['uploaded', 'processing', 'indexed', 'failed'].includes(status)) throw new Error('حالة فهرسة غير صالحة.');
  const now = new Date().toISOString();
  database.prepare(`INSERT INTO document_ragflow_references(document_id,dataset_id,ragflow_document_id,status,updated_at)
    VALUES(?,?,?,?,?) ON CONFLICT(document_id,dataset_id) DO UPDATE SET ragflow_document_id=excluded.ragflow_document_id,status=excluded.status,updated_at=excluded.updated_at`)
    .run(String(documentId), String(datasetId), String(ragflowDocumentId), status, now);
  return { documentId: String(documentId), datasetId: String(datasetId), ragflowDocumentId: String(ragflowDocumentId), status, updatedAt: now };
}

function listRagflowReferences(database, documentId) {
  return database.prepare('SELECT dataset_id,ragflow_document_id,status,updated_at FROM document_ragflow_references WHERE document_id=? ORDER BY updated_at DESC')
    .all(String(documentId));
}

function normalizeSearchText(value) {
  return String(value ?? '').normalize('NFKC').replace(/[\\u064B-\\u065F\\u0670\\u06D6-\\u06ED]/g, '')
    .replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/\\s+/g, ' ').trim().toLowerCase();
}

function searchDocuments(database, request = {}) {
  const query = normalizeSearchText(request.query);
  if (query.length < 2 || query.length > 250) throw new Error('اكتب عبارة بحث من حرفين إلى 250 حرفًا.');
  const limit = Math.max(1, Math.min(50, Math.trunc(Number(request.limit) || 20)));
  const rows = database.prepare(`SELECT e.id AS element_id,e.document_id,d.file_name,d.sha256,e.element_type,e.heading,e.content,e.page_number,e.position_json,e.confidence,e.source_json
    FROM document_elements e JOIN document_records d ON d.id=e.document_id
    WHERE instr(e.search_text,?)>0
    ORDER BY d.created_at DESC,e.sequence_number LIMIT ?`).all(query, limit);
  return { query, mode: 'literal-local', rows };
}

function normalizeExtraction(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('أعاد محرك الوثائق نتيجة غير صالحة.');
  const engine = payload.engine && typeof payload.engine === 'object' ? payload.engine : {};
  const elements = Array.isArray(payload.elements) ? payload.elements : [];
  if (elements.length > MAX_ELEMENTS) throw new Error('تجاوز عدد عناصر الوثيقة الحد المسموح به.');
  const cleanedElements = elements.map((element, index) => {
    const content = String(element?.content ?? '').slice(0, MAX_ELEMENT_CHARS);
    const heading = element?.heading == null ? null : String(element.heading).slice(0, 500);
    const confidence = Number(element?.confidence);
    return {
      id: crypto.randomUUID(),
      sequence_number: index,
      element_type: String(element?.type ?? 'text').slice(0, 40),
      heading,
      content,
      search_text: normalizeSearchText(`${heading ?? ''} ${content}`),
      page_number: Number.isInteger(element?.page_number) && element.page_number > 0 ? element.page_number : null,
      position_json: element?.position && typeof element.position === 'object' ? JSON.stringify(element.position).slice(0, 2000) : null,
      confidence: Number.isFinite(confidence) && confidence >= 0 && confidence <= 1 ? confidence : null,
      source_json: JSON.stringify(element?.source && typeof element.source === 'object' ? element.source : {}).slice(0, 4000),
    };
  }).filter((element) => element.content || element.heading);
  const artifacts = {
    'structured-json': JSON.stringify(payload.structured ?? { elements: payload.elements ?? [] }),
    markdown: typeof payload.markdown === 'string' ? payload.markdown : '',
  };
  if (typeof payload.ocr_json === 'string') artifacts['ocr-json'] = payload.ocr_json;
  if (Object.values(artifacts).some((content) => Buffer.byteLength(content, 'utf8') > MAX_OUTPUT_BYTES)) {
    throw new Error('تجاوز حجم ناتج الاستخراج الحد المسموح به.');
  }
  return { engine_name: String(engine.name ?? 'unknown').slice(0, 100), engine_version: String(engine.version ?? '').slice(0, 100), warnings: Array.isArray(payload.warnings) ? payload.warnings.slice(0, 100) : [], elements: cleanedElements, artifacts };
}

function persistExtraction(database, documentId, payload) {
  const extraction = normalizeExtraction(payload);
  const now = new Date().toISOString();
  const runId = crypto.randomUUID();
  const persist = database.transaction(() => {
    const document = database.prepare('SELECT id FROM document_records WHERE id=?').get(String(documentId));
    if (!document) throw new Error('الوثيقة غير موجودة.');
    database.prepare('DELETE FROM document_elements WHERE document_id=?').run(document.id);
    database.prepare('DELETE FROM document_artifacts WHERE document_id=?').run(document.id);
    const elementInsert = database.prepare(`INSERT INTO document_elements
      (id,document_id,sequence_number,element_type,heading,content,search_text,page_number,position_json,confidence,source_json)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`);
    for (const element of extraction.elements) elementInsert.run(element.id, document.id, element.sequence_number, element.element_type,
      element.heading, element.content, element.search_text, element.page_number, element.position_json, element.confidence, element.source_json);
    const artifactInsert = database.prepare('INSERT INTO document_artifacts(document_id,artifact_type,content,created_at) VALUES(?,?,?,?)');
    for (const [artifactType, content] of Object.entries(extraction.artifacts)) artifactInsert.run(document.id, artifactType, content, now);
    database.prepare(`INSERT INTO document_processing_runs(id,document_id,engine_name,engine_version,status,warning_json,started_at,completed_at)
      VALUES(?,?,?,?,?,?,?,?)`).run(runId, document.id, extraction.engine_name, extraction.engine_version, 'completed', JSON.stringify(extraction.warnings), now, now);
    database.prepare(`UPDATE document_records SET status='review',engine_name=?,engine_version=?,processing_error=NULL,updated_at=? WHERE id=?`)
      .run(extraction.engine_name, extraction.engine_version, now, document.id);
  });
  persist();
  return { runId, status: 'review', engine: { name: extraction.engine_name, version: extraction.engine_version }, elementCount: extraction.elements.length, warnings: extraction.warnings };
}

function markProcessingStarted(database, documentId) {
  const now = new Date().toISOString();
  const result = database.prepare(`UPDATE document_records SET status='processing',processing_error=NULL,updated_at=? WHERE id=?`)
    .run(now,String(documentId));
  if (result.changes !== 1) throw new Error('الوثيقة غير موجودة لبدء معالجتها.');
  return { documentId: String(documentId), status: 'processing', updatedAt: now };
}

function markProcessingUnavailable(database, documentId, engineName, message) {
  return markProcessingFailure(database, documentId, engineName, message, 'unavailable');
}

function markProcessingFailure(database, documentId, engineName, message, status = 'failed') {
  if (!['failed', 'unavailable'].includes(status)) throw new Error('حالة معالجة غير صالحة.');
  const now = new Date().toISOString();
  database.prepare(`INSERT INTO document_processing_runs(id,document_id,engine_name,status,error_text,started_at,completed_at)
    VALUES(?,?,?,?,?,?,?)`).run(crypto.randomUUID(), String(documentId), engineName, status, String(message).slice(0, 2000), now, now);
  database.prepare(`UPDATE document_records SET status=?,processing_error=?,updated_at=? WHERE id=?`)
    .run(status === 'failed' ? 'failed' : 'staged', String(message).slice(0, 2000), now, String(documentId));
  return { status, message };
}

function workerScriptPath(options = {}) {
  if (options.resourcesPath) return path.join(options.resourcesPath, 'document-worker', 'worker.py');
  return path.resolve(__dirname, '../../../services/document_worker/worker.py');
}

function workerEnvironment(source = process.env) {
  const environment = Object.fromEntries(WORKER_ENV_KEYS.filter((key) => typeof source[key] === 'string').map((key) => [key, source[key]]));
  environment.HF_HUB_OFFLINE = '1';
  environment.TRANSFORMERS_OFFLINE = '1';
  environment.PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK = 'True';
  environment.PYTHONNOUSERSITE = '1';
  return environment;
}

function extractDocxXml(xml, fileName) {
  const elements = [];
  let paragraph = '';
  let inParagraph = false;
  let inText = false;
  const parser = new SaxesParser({ xmlns: true });
  parser.on('opentag', (tag) => {
    if (tag.uri !== 'http://schemas.openxmlformats.org/wordprocessingml/2006/main') return;
    if (tag.local === 'p') {
      inParagraph = true;
      paragraph = '';
    } else if (inParagraph && tag.local === 't') inText = true;
    else if (inParagraph && tag.local === 'tab') paragraph += '\\t';
    else if (inParagraph && (tag.local === 'br' || tag.local === 'cr')) paragraph += '\\n';
  });
  parser.on('text', (value) => { if (inText) paragraph += value; });
  parser.on('closetag', (tag) => {
    if (tag.uri !== 'http://schemas.openxmlformats.org/wordprocessingml/2006/main') return;
    if (tag.local === 't') inText = false;
    else if (tag.local === 'p') {
      const content = paragraph.trim();
      if (content) {
        if (elements.length >= MAX_ELEMENTS) throw new Error('تجاوز عدد فقرات Word الحد المسموح به.');
        elements.push({ type: 'paragraph', content, source: { file_name: fileName } });
      }
      paragraph = '';
      inParagraph = false;
    }
  });
  parser.write(xml).close();
  if (!elements.length) throw new Error('لم يُعثر على نص قابل للاستخراج في ملف Word.');
  const markdown = elements.map((element) => element.content).join('\\n\\n');
  return {
    engine: { name: 'Local DOCX parser', version: '1' },
    structured: { elements },
    markdown,
    elements,
    warnings: ['استُخرج نص Word محليًا؛ راجع القيم والسياق قبل استخدامها.'],
  };
}

async function extractDocxFile(filePath) {
  const archive = await unzipper.Open.file(filePath);
  const entry = archive.files.find((item) => item.path === 'word/document.xml');
  if (!entry) throw new Error('ملف Word لا يحتوي محتوى المستند الأساسي.');
  if (entry.uncompressedSize > MAX_OUTPUT_BYTES) throw new Error('محتوى ملف Word يتجاوز حد الاستخراج الآمن.');
  const xml = (await entry.buffer()).toString('utf8');
  return extractDocxXml(xml, path.basename(filePath));
}

function workerStartError(error) {
  if (error.code === 'ENOENT') return new Error('محرك معالجة هذا النوع غير مثبت أو غير مهيأ على الجهاز. بقي الملف الأصلي محفوظًا، ويمكن استخدام استخراج Word المحلي دون تثبيت Python.');
  return new Error(`تعذر تشغيل محرك الوثائق: ${error.message}`);
}

function workerExitError(code, stderr) {
  if (code === 9009) return new Error('محرك معالجة PDF أو الصور غير مثبت أو غير مهيأ على Windows (9009). بقي الملف الأصلي محفوظًا.');
  return new Error((stderr.trim() || `انتهت عملية محرك الوثائق بالرمز ${code}.`).slice(0, 2000));
}

function runWorker(filePath, options = {}) {
  if (path.extname(filePath).toLowerCase() === '.docx') return extractDocxFile(filePath);

  const python = options.python ?? process.env.DOCUMENT_WORKER_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
  const script = workerScriptPath(options);
  if (!fs.existsSync(script)) return Promise.reject(new Error('ملفات محرك الوثائق غير موجودة في حزمة التطبيق.'));
  return new Promise((resolve, reject) => {
    const child = spawn(python, [script], {
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: workerEnvironment(),
    });
    let stdout = '';
    let stderr = '';
    const stdoutDecoder = new StringDecoder('utf8');
    let outputBytes = 0;
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(result);
    };
    const timer = setTimeout(() => { child.kill(); finish(new Error('انتهت مهلة معالجة الوثيقة؛ بقي الأصل محفوظًا للمراجعة.')); }, PROCESS_TIMEOUT_MS);
    child.stdout.on('data', (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        child.kill();
        finish(new Error('تجاوز محرك الوثائق حد حجم المخرجات.'));
        return;
      }
      stdout += stdoutDecoder.write(chunk);
    });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString('utf8')).slice(-8000); });
    child.on('error', (error) => finish(workerStartError(error)));
    child.stdin.on('error', (error) => finish(new Error(`تعذر إرسال مهمة إلى محرك الوثائق: ${error.message}`)));
    child.on('close', (code) => {
      if (settled) return;
      stdout += stdoutDecoder.end();
      if (code !== 0) return finish(workerExitError(code, stderr));
      try { finish(null, JSON.parse(stdout)); }
      catch { finish(new Error('لم يُرجع محرك الوثائق JSON صالحًا.')); }
    });
    child.stdin.end(JSON.stringify({ file_path: filePath, offline: true, max_file_bytes: MAX_FILE_BYTES }));
  });
}

module.exports = {
  MAX_FILE_BYTES, MIME_TYPES, SCHEMA, checksum: () => crypto.createHash('sha256').update(SCHEMA).digest('hex'), inspectFile, migrate, stageFile, listDocuments, getDocument, readOriginal,
  saveRagflowReference, listRagflowReferences, searchDocuments, normalizeSearchText, normalizeExtraction, persistExtraction,
  markProcessingStarted, markProcessingUnavailable, markProcessingFailure, workerEnvironment, workerScriptPath, extractDocxXml, workerExitError, runWorker,
};
