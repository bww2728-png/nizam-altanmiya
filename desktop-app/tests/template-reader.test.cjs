'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const ExcelJS = require('exceljs');
const { readDirectorateWorkbook } = require('../src/main/analysis/template-reader.cjs');

async function makeWorkbook(target) {
  const workbook = new ExcelJS.Workbook();

  const main = workbook.addWorksheet('البيانات الأساسية');
  main.mergeCells('A1:J1');
  main.getCell('A1').value = 'البيانات الأساسية للمديريات';
  // Deliberately sparse columns: actualColumnCount is not the highest column index.
  for (const [cell, value] of [
    ['A2', 'اسم المديرية'],
    ['E2', 'المحافظة'],
    ['H2', 'عدد السكان'],
    ['J2', 'عدد المدارس'],
    ['A3', 'مديرية أولى'],
    ['E3', 'إب'],
    ['H3', { formula: '10000 * 2', result: 20000 }],
    ['J3', 12],
    ['A30', 'مديرية ثانية'],
    ['E30', 'تعز'],
    ['H30', 35000],
    ['J30', 18],
    // An additional table header in the same worksheet; it must be inventoried
    // but not accidentally interpreted as a data record of the first table.
    ['A60', 'اسم المديرية'],
    ['E60', 'المحافظة'],
    ['H60', 'عدد السكان'],
    ['J60', 'عدد المدارس'],
    ['A61', 'مديرية من جدول ثانٍ'],
    ['E61', 'صنعاء'],
    ['H61', 41000],
    ['J61', 22],
  ]) main.getCell(cell).value = value;

  main.getRow(40).hidden = true;
  for (const [cell, value] of [
    ['A40', 'مديرية مخفية'],
    ['E40', 'ذمار'],
    ['H40', 12000],
    ['J40', 9],
  ]) main.getCell(cell).value = value;

  const imageId = workbook.addImage({
    base64: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jzBYAAAAASUVORK5CYII=',
    extension: 'png',
  });
  main.addImage(imageId, { tl: { col: 12, row: 0 }, ext: { width: 8, height: 8 } });

  const water = workbook.addWorksheet('المياه');
  for (const [cell, value] of [
    ['A1', 'اسم المديرية'],
    ['C1', 'المحافظة'],
    ['D1', 'نسبة تغطية المياه'],
    ['A2', 'مديرية أولى'],
    ['C2', 'إب'],
    ['D2', 0.7],
  ]) water.getCell(cell).value = value;

  water.addTable({
    name: 'WaterObservations',
    ref: 'F1',
    headerRow: true,
    totalsRow: false,
    style: { theme: 'TableStyleMedium2', showRowStripes: true },
    columns: [
      { name: 'المديرية' },
      { name: 'المحافظة' },
      { name: 'نسبة تغطية المياه' },
    ],
    rows: [['مديرية أولى', 'إب', 0.7]],
  });

  const hidden = workbook.addWorksheet('أرشيف مخفي');
  hidden.state = 'hidden';
  for (const [cell, value] of [
    ['A1', 'اسم المديرية'],
    ['B1', 'المحافظة'],
    ['C1', 'عدد السكان'],
    ['A2', 'مديرية مخفية'],
    ['B2', 'إب'],
    ['C2', 9000],
  ]) hidden.getCell(cell).value = value;

  const summary = workbook.addWorksheet('ملخص');
  summary.getCell('A1').value = 'ملخص عام';
  summary.getCell('A2').value = 'لا توجد سجلات خام هنا';

  await workbook.xlsx.writeFile(target);
}

test('reader inventories all sheets and does not silently import hidden/additional table regions', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ldi-workbook-inventory-'));
  const filePath = path.join(directory, 'multi-sheet.xlsx');
  try {
    await makeWorkbook(filePath);
    const read = await readDirectorateWorkbook(filePath);

    assert.equal(read.sheetName, 'البيانات الأساسية');
    assert.deepEqual(read.rows.map((row) => row.rowNumber), [3, 30, 40]);
    assert.equal(read.totalRows, 3, 'sparse row gaps must not stop reading, hidden rows are surfaced for review, and the second table must not be mixed in');
    assert.equal(read.workbookInventory.sheetCount, 4);
    assert.equal(read.workbookInventory.hiddenSheetCount, 1);
    assert.equal(read.workbookInventory.visibleSheetCount, 3);

    const base = read.workbookInventory.sheets.find((sheet) => sheet.name === 'البيانات الأساسية');
    const water = read.workbookInventory.sheets.find((sheet) => sheet.name === 'المياه');
    const hidden = read.workbookInventory.sheets.find((sheet) => sheet.name === 'أرشيف مخفي');

    assert.equal(base.selected, true);
    assert.equal(base.headerCandidates.length, 2);
    assert.deepEqual(base.headerCandidates.map((item) => item.headerRow), [2, 60]);
    assert.equal(base.columnCount, 10);
    assert.equal(base.imageCount, 1);
    assert.equal(base.anchoredImageCount, 1);
    assert.equal(read.workbookInventory.workbookImageAssetCount, 1);
    assert.equal(read.workbookInventory.unanchoredImageAssetCount, 0);
    assert.equal(base.formulaCount, 1);
    assert.ok(base.mergedRangeCount >= 1);
    assert.ok(base.hiddenRowCount >= 1);
    assert.ok(read.rows.find((row) => row.rowNumber === 3).warnings.some((warning) => warning.code === 'formula-cell'));
    assert.ok(read.rows.find((row) => row.rowNumber === 40).warnings.some((warning) => warning.code === 'hidden-row'));

    assert.equal(water.headerCandidates.length, 1);
    assert.equal(water.selected, false);
    assert.equal(water.tableCount, 1, 'Excel table objects must be inventoried separately from detected header regions');
    assert.equal(hidden.hidden, true);
    assert.equal(hidden.headerCandidates.length, 1);

    assert.ok(read.warnings.some((warning) => warning.code === 'unimported-data-sheets'));
    assert.ok(read.warnings.some((warning) => warning.code === 'hidden-data-sheets'));
    assert.ok(read.warnings.some((warning) => warning.code === 'unimported-table-regions'));
    assert.ok(read.warnings.some((warning) => warning.code === 'embedded-images-detected'));
    assert.ok(read.warnings.some((warning) => warning.code === 'formula-cells-detected'));
    assert.ok(read.warnings.some((warning) => warning.code === 'merged-cells-detected'));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('hidden worksheets are never selected for import without explicit visibility', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ldi-hidden-sheet-'));
  const filePath = path.join(directory, 'hidden-only.xlsx');
  try {
    const workbook = new ExcelJS.Workbook();
    const hidden = workbook.addWorksheet('بيانات مخفية');
    hidden.state = 'veryHidden';
    hidden.getCell('A1').value = 'اسم المديرية';
    hidden.getCell('B1').value = 'المحافظة';
    hidden.getCell('A2').value = 'مديرية مخفية';
    hidden.getCell('B2').value = 'إب';
    await workbook.xlsx.writeFile(filePath);

    await assert.rejects(
      () => readDirectorateWorkbook(filePath),
      /أوراق مخفية/
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});


test('a stronger header later in the sheet is selected without truncating its rows at an earlier candidate', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ldi-late-header-'));
  const filePath = path.join(directory, 'late-header.xlsx');
  try {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('ورقة غير مرتبة');
    for (const [cell, value] of [
      // Weak candidate near the top.
      ['A2', 'اسم المديرية'],
      ['E2', 'المحافظة'],
      ['A3', 'مديرية قديمة'],
      ['E3', 'إب'],
      // Stronger candidate much later.
      ['A60', 'اسم المديرية'],
      ['E60', 'المحافظة'],
      ['H60', 'عدد السكان'],
      ['J60', 'عدد المدارس'],
      ['A61', 'مديرية مختارة'],
      ['E61', 'تعز'],
      ['H61', 32000],
      ['J61', 16],
    ]) sheet.getCell(cell).value = value;
    await workbook.xlsx.writeFile(filePath);

    const read = await readDirectorateWorkbook(filePath);

    assert.equal(read.headerRow, 60);
    assert.deepEqual(read.rows.map((row) => row.rowNumber), [61]);
    assert.equal(read.totalRows, 1);
    assert.ok(read.warnings.some((warning) => warning.code === 'unimported-table-regions'));
    assert.match(
      read.warnings.find((warning) => warning.code === 'unimported-table-regions').message,
      /2/
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
