/*
 * Verifies the packaged app.asar actually loads and runs its heavy dependency:
 * ExcelJS (workbook read/write) plus the new Excel-only import path.
 * Usage: electron.exe tools/asar-check.cjs "<path to app.asar>"
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app } = require('electron');

const asar = process.argv[2] || process.argv[process.argv.length - 1];
const outFile = path.join(__dirname, 'asar-result.json');

async function run() {
  const result = { asar };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'asar-check-'));
  const reqFromAsar = (rel) => require(path.join(asar, rel));

  try {
    const ExcelJS = reqFromAsar('node_modules/exceljs');
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('test');
    sheet.addRow(['اسم المديرية', 'عدد السكان']);
    sheet.addRow(['مديرية الشعر', 43739]);
    const filePath = path.join(tmp, 'sample.xlsx');
    await workbook.xlsx.writeFile(filePath);
    const readBack = new ExcelJS.Workbook();
    await readBack.xlsx.readFile(filePath);
    result.exceljs = {
      rows: readBack.worksheets[0].rowCount,
      firstCell: String(readBack.worksheets[0].getRow(2).getCell(1).value || ''),
    };
  } catch (error) {
    result.exceljs = 'FAIL ' + error.message;
  }

  try {
    const { readDirectorateWorkbook } = reqFromAsar('src/main/analysis/template-reader.cjs');
    const workbook = new (reqFromAsar('node_modules/exceljs').Workbook)();
    const sheet = workbook.addWorksheet('قاعدة البيانات الشاملة');
    sheet.addRow(['عنوان']);
    sheet.addRow(['اسم المديرية', 'طبيعة المديرية', 'عدد السكان', 'عدد المغتربين', 'المحافظة']);
    sheet.addRow(['مديرية الشعر', 'جبلية', 43739, 13122, 'إب']);
    const filePath = path.join(tmp, 'template.xlsx');
    await workbook.xlsx.writeFile(filePath);
    const read = await readDirectorateWorkbook(filePath);
    result.templateReader = { sheetName: read.sheetName, rows: read.totalRows, matched: read.matched.length };
  } catch (error) {
    result.templateReader = 'FAIL ' + error.message;
  }

  result.passed =
    typeof result.exceljs === 'object' &&
    result.exceljs.rows >= 2 &&
    typeof result.templateReader === 'object' &&
    result.templateReader.rows >= 1;

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
