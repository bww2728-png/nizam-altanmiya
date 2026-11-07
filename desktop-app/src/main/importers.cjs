const fs = require('node:fs/promises');
const path = require('node:path');
const ExcelJS = require('exceljs');
const mammoth = require('mammoth');
const ocr = require('./ocr-pipeline.cjs');

const MAX_FILE_BYTES = 40 * 1024 * 1024;
const MAX_ITEMS = 50000;
const SUPPORTED_EXTENSIONS = new Set(['.xlsx', '.pdf', '.docx']);
/** Image formats accepted by the manual-entry OCR reader. */
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tif', '.tiff']);

/** A stuck WASM worker must fail the IPC call instead of hanging the UI forever. */
const OCR_TIMEOUT_MS = 120000;

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function cleanText(value) {
  return String(value ?? '').replace(/\u0000/g, '').trim();
}

function cellText(value) {
  if (value == null) return '';
  if (typeof value === 'object') {
    if (Array.isArray(value.richText)) return value.richText.map((part) => part.text ?? '').join('').trim();
    if (value.text) return cleanText(value.text);
    if (value.result !== undefined) return cleanText(value.result);
    if (value.hyperlink) return cleanText(value.text || value.hyperlink);
    return '';
  }
  return cleanText(value);
}

function toReviewCandidate({ field, value, location, confidence = 1, proposedType = '', recordId = '' }) {
  const label = cleanText(field) || 'نص غير مصنف';
  const text = cleanText(value);
  if (!text) return null;
  return {
    fieldName: label.slice(0, 300),
    value: text.slice(0, 10000),
    sourceLocation: cleanText(location).slice(0, 500),
    confidence,
    proposedType: cleanText(proposedType).slice(0, 100),
    recordId: cleanText(recordId).slice(0, 160),
  };
}

// Some real-world workbooks (produced by openpyxl and other third-party converters) declare the
// package parts with generated namespace prefixes, for example <ns0:Relationships> or
// <ns0:Properties>. ExcelJS matches those parts by literal tag name, so such files fail with
// "Unexpected xml node in parseOpen" or crash while reading docProps/app.xml.
// Renaming every prefix to the canonical one ExcelJS expects keeps each part semantically
// identical, because the mapping is driven by the namespace URI, never by the prefix itself.
const CANONICAL_NAMESPACES = new Map([
  ['http://schemas.openxmlformats.org/package/2006/relationships', ''],
  ['http://schemas.openxmlformats.org/package/2006/content-types', ''],
  ['http://schemas.openxmlformats.org/spreadsheetml/2006/main', ''],
  ['http://schemas.openxmlformats.org/officeDocument/2006/extended-properties', ''],
  ['http://schemas.openxmlformats.org/package/2006/metadata/core-properties', 'cp'],
  ['http://purl.org/dc/elements/1.1/', 'dc'],
  ['http://purl.org/dc/terms/', 'dcterms'],
  ['http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes', 'vt'],
  ['http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'r'],
  ['http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing', 'xdr'],
  ['http://schemas.openxmlformats.org/drawingml/2006/main', 'a'],
  ['http://schemas.openxmlformats.org/drawingml/2006/chart', 'c'],
  ['http://schemas.openxmlformats.org/markup-compatibility/2006', 'mc'],
]);

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function canonicalizeXmlPart(xml) {
  const declarations = [...xml.matchAll(/xmlns:([A-Za-z_][\w.-]*)\s*=\s*"([^"]*)"/g)].map((match) => ({
    prefix: match[1],
    uri: match[2],
  }));
  if (!declarations.length) return xml;

  const renames = new Map();
  const missing = new Map();
  for (const { prefix, uri } of declarations) {
    if (!CANONICAL_NAMESPACES.has(uri)) continue;
    const canonical = CANONICAL_NAMESPACES.get(uri);
    if (canonical === prefix) continue;
    renames.set(prefix, canonical);
    if (canonical && !declarations.some((item) => item.prefix === canonical && item.uri === uri)) {
      missing.set(canonical, uri);
    }
  }
  if (!renames.size) return xml;

  let output = xml;
  for (const [prefix, canonical] of renames) {
    const escaped = escapeRegExp(prefix);
    output = output.replace(new RegExp(`<(/?)${escaped}:`, 'g'), `<$1${canonical ? `${canonical}:` : ''}`);
    if (canonical) {
      output = output.replace(new RegExp(`(\\s)${escaped}:([\\w.-]+\\s*=)`, 'g'), `$1${canonical}:$2`);
    }
  }
  if (missing.size) {
    const attributes = [...missing].map(([prefix, uri]) => `xmlns:${prefix}="${uri}"`).join(' ');
    output = output.replace(/<([A-Za-z_][\w.:-]*)(\s|>)/, (match, tag, separator) => `<${tag} ${attributes}${separator}`);
  }
  return output;
}

async function loadWorkbook(filePath) {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.readFile(filePath);
    return workbook;
  } catch (error) {
    if (!/Unexpected xml node|Cannot read properties of undefined/i.test(String(error && error.message))) throw error;
    const JSZip = require('jszip');
    const archive = await JSZip.loadAsync(await fs.readFile(filePath));
    let patched = false;
    for (const name of Object.keys(archive.files)) {
      if (!/\.(xml|rels)$/i.test(name)) continue;
      const original = await archive.files[name].async('string');
      const fixed = canonicalizeXmlPart(original);
      if (fixed !== original) {
        archive.file(name, fixed);
        patched = true;
      }
    }
    if (!patched) throw error;
    const retry = new ExcelJS.Workbook();
    await retry.xlsx.load(await archive.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
    return retry;
  }
}

async function extractExcel(filePath) {
  const workbook = await loadWorkbook(filePath);
  const items = [];
  const sheets = [];
  workbook.eachSheet((worksheet) => {
    sheets.push(worksheet.name);
    const headers = new Map();
    worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (items.length >= MAX_ITEMS) return;
      row.eachCell({ includeEmpty: false }, (cell, columnNumber) => {
        const text = cellText(cell.value);
        if (!text) return;
        if (rowNumber === 1) {
          headers.set(columnNumber, text);
          return;
        }
        const previousHeader = headers.get(columnNumber);
        const firstRowLabel = rowNumber === 2 && columnNumber === 1 && !previousHeader;
        if (firstRowLabel) {
          headers.set(columnNumber, text);
          return;
        }
        if (items.length >= MAX_ITEMS) return;
        const candidate = toReviewCandidate({
          field: previousHeader || `عمود ${columnNumber}`,
          value: text,
          location: `ورقة «${worksheet.name}»، الخلية ${cell.address}`,
          proposedType: worksheet.name,
          recordId: `${worksheet.name}:${rowNumber}`,
        });
        if (candidate) items.push(candidate);
      });
    });
  });
  return { items, pages: sheets.length, truncated: items.length >= MAX_ITEMS };
}

async function extractWord(filePath) {
  const result = await mammoth.extractRawText({ path: filePath });
  const lines = result.value.split(/\r?\n/).map(cleanText).filter(Boolean);
  const items = lines.slice(0, MAX_ITEMS).map((line, index) => {
    const splitAt = line.search(/[:：\t]/);
    const field = splitAt > 0 && splitAt < 240 ? line.slice(0, splitAt).trim() : `سطر ${index + 1}`;
    const value = splitAt > 0 && splitAt < 240 ? line.slice(splitAt + 1).trim() : line;
    return toReviewCandidate({ field, value, location: `مستند Word، السطر ${index + 1}`, confidence: 0.8, proposedType: 'مستند Word', recordId: `word:${index + 1}` });
  }).filter(Boolean);
  return { items, pages: null, truncated: lines.length > MAX_ITEMS, warnings: result.messages.map((message) => message.message).slice(0, 10) };
}

async function getPdfModule() {
  return import('pdfjs-dist/legacy/build/pdf.mjs');
}

/** Render a PDF page near 300 DPI, but never above the pipeline's edge cap. */
function pdfRenderScale(viewport) {
  const longest = Math.max(viewport.width, viewport.height);
  const target = ocr.MAX_EDGE;
  return Math.min(4.2, Math.max(1, target / Math.max(1, longest)));
}

async function ocrPdfPage(page, pdfjs, fn) {
  const { createCanvas } = require('@napi-rs/canvas');
  const initialViewport = page.getViewport({ scale: 1 });
  const scale = pdfRenderScale(initialViewport);
  const viewport = page.getViewport({ scale });
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
  const prepared = await ocr.preprocessImage(canvas.toBuffer('image/png'));
  const recognition = await withTimeout(
    ocr.recognizeBuffer(prepared.buffer, { psm: ocr.PSM.SINGLE_BLOCK, onProgress: fn, allowRotation: false }),
    OCR_TIMEOUT_MS,
    'تجاوز التعرف الضوئي المهلة الزمنية. جرّب صورة أوضح أو أصغر.',
  );
  return {
    text: cleanText(recognition.text),
    confidence: recognition.confidence,
    lines: recognition.lines,
    prepared,
  };
}

function pdfTextLines(items) {
  const lines = [];
  let activeLine;
  for (const item of items) {
    const text = cleanText(item.str);
    if (!text) continue;
    const y = Number.isFinite(item.transform?.[5]) ? item.transform[5] : null;
    if (!activeLine || (y !== null && activeLine.y !== null && Math.abs(y - activeLine.y) > 3)) {
      if (activeLine) lines.push(activeLine.text);
      activeLine = { y, text };
    } else {
      activeLine.text = `${activeLine.text} ${text}`.trim();
    }
    if (item.hasEOL) {
      lines.push(activeLine.text);
      activeLine = undefined;
    }
  }
  if (activeLine) lines.push(activeLine.text);
  return lines;
}

async function extractPdf(filePath) {
  const pdfjs = await getPdfModule();
  const pdfjsRoot = path.resolve(path.dirname(require.resolve('pdfjs-dist/legacy/build/pdf.mjs')), '../..');
  // pdf.js in Node passes these values straight to fs.readFile, so they must be plain
  // filesystem paths (with a trailing slash), not file:// URLs.
  const assetDir = (name) => path.join(pdfjsRoot, name).replaceAll(path.sep, '/') + '/';
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(await fs.readFile(filePath)),
    useSystemFonts: true,
    standardFontDataUrl: assetDir('standard_fonts'),
    cMapUrl: assetDir('cmaps'),
    cMapPacked: true,
  });
  const document = await loadingTask.promise;
  const items = [];
  let recognizedPages = 0;
  try {
    const pageLimit = Math.min(document.numPages, 250);
    for (let pageNumber = 1; pageNumber <= pageLimit && items.length < MAX_ITEMS; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const textContent = await page.getTextContent();
      let lines = pdfTextLines(textContent.items);
      let confidence = 0.95;
      if (!ocr.textLayerIsUsable(lines.join('\n'))) {
        const recognition = await ocrPdfPage(page, pdfjs, null);
        lines = recognition.text.split(/\r?\n/).map(cleanText).filter(Boolean);
        confidence = recognition.confidence;
        recognizedPages += 1;
      }
      lines.forEach((line, lineIndex) => {
        if (items.length >= MAX_ITEMS) return;
        const splitAt = line.search(/[:：\t]/);
        const field = splitAt > 0 && splitAt < 240 ? line.slice(0, splitAt).trim() : `نص الصفحة ${pageNumber}، سطر ${lineIndex + 1}`;
        const value = splitAt > 0 && splitAt < 240 ? line.slice(splitAt + 1).trim() : line;
        const candidate = toReviewCandidate({ field, value, location: `PDF، الصفحة ${pageNumber}، السطر ${lineIndex + 1}`, confidence, proposedType: 'مستند PDF', recordId: `pdf:${pageNumber}:${lineIndex + 1}` });
        if (candidate) items.push(candidate);
      });
    }
    return {
      items,
      pages: document.numPages,
      truncated: document.numPages > 250 || items.length >= MAX_ITEMS,
      warnings: recognizedPages ? [`تم استخدام OCR العربي محليًا في ${recognizedPages} صفحة؛ راجع كل نتيجة قبل اعتمادها.`] : [],
    };
  } finally {
    await ocr.disposeWorker();
    await loadingTask.destroy();
  }
}

/**
 * OCR for a single image file. Used by the manual-entry screen, where the user
 * photographs or scans a paper form and then reviews every recognised value.
 */
async function extractImageText(filePath, options = {}) {
  const buffer = await fs.readFile(filePath);
  const prepared = await ocr.preprocessImage(buffer);
  const recognition = await withTimeout(
    ocr.recognizeBuffer(prepared.buffer, {
      psm: ocr.PSM.SINGLE_BLOCK,
      onProgress: options.onProgress,
      signal: options.signal,
    }),
    OCR_TIMEOUT_MS,
    'تجاوز التعرف الضوئي المهلة الزمنية. جرّب صورة أوضح أو أصغر.',
  );
  const warnings = ['تم استخدام OCR العربي محليًا؛ راجع كل قيمة قبل الحفظ.'];
  if (recognition.confidence < ocr.REVIEW_CONFIDENCE) {
    warnings.push(`ثقة القراءة منخفضة (${Math.round(recognition.confidence * 100)}%)؛ راجع الصورة والقيم يدويًا.`);
  }
  if (Math.abs(prepared.angle) >= 1) {
    warnings.push(`صُحّح ميل الصفحة بمقدار ${prepared.angle.toFixed(1)} درجة.`);
  }
  if (recognition.rotation) warnings.push(`أُعيد تدوير الصورة ${recognition.rotation} درجة لتحسين القراءة.`);
  return {
    text: cleanText(recognition.text),
    confidence: recognition.confidence,
    lines: recognition.lines.map((line) => ({
      text: line.text,
      confidence: line.confidence,
      page: 1,
      bbox: line.bbox ?? null,
    })),
    pages: 1,
    warnings,
    preprocessing: {
      angle: prepared.angle,
      rotation: recognition.rotation ?? 0,
      upscale: Math.round(prepared.upscale * 100) / 100,
      contrast: prepared.contrast,
      width: prepared.width,
      height: prepared.height,
    },
  };
}

/**
 * Raw OCR/text-layer reading of a PDF for the manual-entry screen. Unlike
 * `extractPdf` it keeps whole lines instead of splitting them into review
 * candidates, because the entry parser needs the original "label: value" shape.
 */
async function extractPdfRawText(filePath, options = {}) {
  const pdfjs = await getPdfModule();
  const pdfjsRoot = path.resolve(path.dirname(require.resolve('pdfjs-dist/legacy/build/pdf.mjs')), '../..');
  const assetDir = (name) => path.join(pdfjsRoot, name).replaceAll(path.sep, '/') + '/';
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(await fs.readFile(filePath)),
    useSystemFonts: true,
    standardFontDataUrl: assetDir('standard_fonts'),
    cMapUrl: assetDir('cmaps'),
    cMapPacked: true,
  });
  let document;
  try {
    document = await loadingTask.promise;
  } catch (error) {
    try { await loadingTask.destroy(); } catch { /* best effort */ }
    throw error;
  }
  const chunks = [];
  const confidences = [];
  const lineRecords = [];
  let recognizedPages = 0;
  let garbledPages = 0;
  try {
    const pageLimit = Math.min(document.numPages, 100);
    for (let pageNumber = 1; pageNumber <= pageLimit; pageNumber += 1) {
      if (options.signal?.aborted) throw new Error('أُلغي التعرف الضوئي.');
      if (options.onProgress) {
        options.onProgress({ status: 'reading-page', page: pageNumber, pages: pageLimit, progress: (pageNumber - 1) / pageLimit });
      }
      const page = await document.getPage(pageNumber);
      const textContent = await page.getTextContent();
      let lines = pdfTextLines(textContent.items);
      let pageConfidence = 0.95;
      const layerText = lines.join('\n');
      if (!ocr.textLayerIsUsable(layerText)) {
        if (layerText.trim()) garbledPages += 1;
        const recognition = await ocrPdfPage(page, pdfjs, options.onProgress);
        lines = recognition.text.split(/\r?\n/).map(cleanText).filter(Boolean);
        pageConfidence = recognition.confidence;
        for (const line of recognition.lines) {
          lineRecords.push({ text: line.text, confidence: line.confidence, page: pageNumber, bbox: line.bbox ?? null });
        }
        recognizedPages += 1;
      } else {
        for (const line of lines) {
          // A usable text layer still gets a confidence: it is not OCR, but it is
          // the only signal we have for "trust this line more than a guess".
          lineRecords.push({ text: line, confidence: 0.95, page: pageNumber });
        }
      }
      if (lines.length) chunks.push(lines.join('\n'));
      confidences.push(pageConfidence);
    }
    const warnings = [];
    if (recognizedPages) warnings.push(`تم استخدام OCR العربي محليًا في ${recognizedPages} صفحة؛ راجع كل نتيجة قبل الاعتماد.`);
    if (garbledPages) {
      warnings.push(`طبقة النص في ${garbledPages} صفحة كانت تالفة الترميز، فأُعيد قراءتها بالتصوير الضوئي بدلًا من تمريرها كما هي.`);
    }
    const pagesRead = Math.min(document.numPages, pageLimit);
    if (document.numPages > pagesRead) {
      warnings.push(`قُرئت أول ${pagesRead} صفحة من ${document.numPages}؛ أكمل البيانات من الصفحات المتبقية يدويًا.`);
    }
    return {
      text: chunks.join('\n'),
      confidence: confidences.length ? Math.min(...confidences) : 0,
      lines: lineRecords,
      pages: document.numPages,
      pagesRead,
      truncated: document.numPages > pagesRead,
      warnings,
    };
  } finally {
    await loadingTask.destroy();
  }
}

/**
 * Text/OCR reader shared by the manual-entry screen. Accepts images and PDFs,
 * enforces the same local size limits as the generic importer, and never writes
 * anything: recognition is only a proposal the user must review.
 */
async function extractEntryText(filePath, options = {}) {
  const resolvedPath = path.resolve(filePath);
  const extension = path.extname(resolvedPath).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(extension) && extension !== '.pdf') {
    throw new Error('الإدخال بالـOCR يدعم الصور (PNG/JPG/WEBP/BMP/TIFF) وملفات PDF فقط.');
  }
  const stats = await fs.stat(resolvedPath);
  if (!stats.isFile() || stats.size === 0) throw new Error('الملف فارغ أو غير صالح.');
  if (stats.size > MAX_FILE_BYTES) throw new Error('حجم الملف يتجاوز الحد المحلي البالغ 40 ميغابايت.');
  let result;
  try {
    result = extension === '.pdf'
      ? await extractPdfRawText(resolvedPath, options)
      : await extractImageText(resolvedPath, options);
  } catch (error) {
    // A failed read must not leave a half-initialised worker holding a thread.
    await ocr.disposeWorker();
    throw error;
  }
  return {
    fileName: path.basename(resolvedPath),
    fileType: extension.slice(1),
    fileSize: stats.size,
    extractedAt: new Date().toISOString(),
    ...result,
  };
}

async function extractFile(filePath) {
  const resolvedPath = path.resolve(filePath);
  const extension = path.extname(resolvedPath).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(extension)) throw new Error('الامتدادات المدعومة: XLSX وPDF وDOCX فقط.');
  const stats = await fs.stat(resolvedPath);
  if (!stats.isFile() || stats.size === 0) throw new Error('الملف فارغ أو غير صالح.');
  if (stats.size > MAX_FILE_BYTES) throw new Error('حجم الملف يتجاوز الحد المحلي البالغ 40 ميغابايت.');
  let result;
  if (extension === '.xlsx') result = await extractExcel(resolvedPath);
  else if (extension === '.docx') result = await extractWord(resolvedPath);
  else result = await extractPdf(resolvedPath);
  return {
    fileName: path.basename(resolvedPath),
    fileType: extension.slice(1),
    fileSize: stats.size,
    extractedAt: new Date().toISOString(),
    ...result,
  };
}

module.exports = { extractFile, extractExcel, extractWord, extractPdf, extractEntryText, MAX_ITEMS, MAX_FILE_BYTES, IMAGE_EXTENSIONS };
