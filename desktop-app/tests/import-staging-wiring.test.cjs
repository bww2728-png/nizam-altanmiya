'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(ROOT, 'src/main/main.cjs'), 'utf8');
const preload = fs.readFileSync(path.join(ROOT, 'src/main/preload.cjs'), 'utf8');
const ui = fs.readFileSync(path.join(ROOT, 'src/renderer/pages/Import.jsx'), 'utf8');

test('main process durably stages a workbook before constructing the directorate review plan', () => {
  const scanStart = main.indexOf("ipcMain.handle('import:scan'");
  const applyPlan = main.indexOf('const plan = buildImportPlan', scanStart);
  const stage = main.indexOf('canonicalData.stageWorkbook', scanStart);
  assert.ok(scanStart >= 0 && stage > scanStart && applyPlan > stage);
  assert.match(main, /pendingPlan = \{ filePath, read, plan, staging \}/);
  assert.match(main, /canonicalData\.completeWorkbookImport/);
  assert.match(main, /ipcMain\.handle\('import:history'/);
});

test('workbooks without a directorate table are retained as unapproved review batches', () => {
  assert.match(main, /no-directorate-table/);
  assert.match(main, /rows: \[\]/);
  assert.match(main, /stagingOnly: Boolean\(directorateReadError\)/);
  assert.match(main, /if \(pendingPlan\.plan\.rows\?\.length\)/);
});

test('renderer bridge exposes a bounded workbook intake history query', () => {
  assert.match(preload, /importHistory: \(request\) => ipcRenderer\.invoke\('import:history', request\)/);
  assert.match(ui, /function ImportHistory/);
  assert.match(ui, /function DurableStaging/);
  assert.match(ui, /plan\.stagingOnly \|\| plan\.totalRows === 0/);
  assert.match(ui, /disabled=\{busy \|\| plan\.stagingOnly \|\| plan\.totalRows === 0\}/);
});

test('intake user-facing text no longer requires the ministry template', () => {
  assert.match(ui, /يحفظ الملف الأصلي ويفهرس محتواه/);
  assert.match(ui, /تُفهرس جميع الأوراق الظاهرة والمخفية/);
  assert.match(ui, /الاستيراد المباشر الحالي يقتصر على جدول المديريات المعروف/);
  assert.doesNotMatch(ui, /اختر ملف «القالب المحدث»/);
});
