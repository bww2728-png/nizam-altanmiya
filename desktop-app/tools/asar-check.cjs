/*
 * Verifies the packaged app.asar actually loads and runs its heavy dependencies:
 * importers (Excel/PDF), tesseract.js OCR worker + Arabic language data inside asar.
 * Usage: electron.exe tools/asar-check.cjs "<path to app.asar>"
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app } = require('electron');

const asar = process.argv[2] || process.argv[process.argv.length - 1];
const outFile = path.join(__dirname, 'asar-result.json');

function makeTextPdf(filePath, text) {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    null,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const stream = `BT /F1 14 Tf 20 250 Td (${text}) Tj ET`;
  objects[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  fs.writeFileSync(filePath, pdf.replaceAll('\n', String.fromCharCode(10)));
}

async function run() {
  const result = { asar };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'asar-check-'));
  const reqFromAsar = (rel) => require(path.join(asar, rel));

  try {
    const importers = reqFromAsar('src/main/importers.cjs');
    result.importers = 'loaded';
    const pdfPath = path.join(tmp, 'sample.pdf');
    makeTextPdf(pdfPath, 'District: Example');
    const pdf = await importers.extractPdf(pdfPath);
    result.pdf = { items: pdf.items.length, pages: pdf.pages, first: pdf.items[0]?.value ?? null };
  } catch (error) {
    result.pdf = 'FAIL ' + error.message;
  }

  try {
    const { createCanvas } = reqFromAsar('node_modules/@napi-rs/canvas');
    const tesseract = reqFromAsar('node_modules/tesseract.js');
    const lang = reqFromAsar('node_modules/@tesseract.js-data/ara');
    const canvas = createCanvas(760, 220);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 760, 220);
    ctx.fillStyle = '#000000';
    ctx.font = 'bold 76px "Segoe UI", Tahoma, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('التنمية المحلية', 380, 110);
    const worker = await tesseract.createWorker('ara', 1, { langPath: lang.langPath, gzip: true, logger: () => {} });
    const recognition = await worker.recognize(canvas.toBuffer('image/png'));
    await worker.terminate();
    result.ocr = {
      text: String(recognition.data.text || '').replace(/\s+/g, ' ').trim().slice(0, 80),
      confidence: Math.round(recognition.data.confidence),
    };
  } catch (error) {
    result.ocr = 'FAIL ' + error.message;
  }

  result.passed =
    result.importers === 'loaded' &&
    typeof result.pdf === 'object' &&
    result.pdf.items > 0 &&
    typeof result.ocr === 'object' &&
    result.ocr.text.length > 0;

  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  fs.writeFileSync(outFile, JSON.stringify(result, null, 2), 'utf8');
  console.log(JSON.stringify(result, null, 2));
  app.exit(result.passed ? 0 : 1);
}

app.whenReady().then(run).catch((error) => {
  fs.writeFileSync(outFile, JSON.stringify({ fatal: error.message, stack: error.stack }, null, 2), 'utf8');
  app.exit(1);
});
