'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(ROOT, 'src/main/main.cjs'), 'utf8');
const preload = fs.readFileSync(path.join(ROOT, 'src/main/preload.cjs'), 'utf8');
const ui = fs.readFileSync(path.join(ROOT, 'src/renderer/pages/Import.jsx'), 'utf8');
const shell = fs.readFileSync(path.join(ROOT, 'src/renderer/components/AppShell.jsx'), 'utf8');
const app = fs.readFileSync(path.join(ROOT, 'src/renderer/App.jsx'), 'utf8');
const projects = fs.readFileSync(path.join(ROOT, 'src/renderer/pages/Projects.jsx'), 'utf8');

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
  assert.match(main, /pendingPlan\.plan\.rows\?\.length\s*\?/);
});

test('renderer bridge exposes import history and owner-only staged sheet previews', () => {
  assert.match(preload, /importHistory: \(request\) => ipcRenderer\.invoke\('import:history', request\)/);
  assert.match(preload, /importSheetPreview: \(request\) => ipcRenderer\.invoke\('import:sheet-preview', request\)/);
  assert.match(main, /currentProfile\(\) !== 'owner'/);
  assert.match(main, /canonicalData\.readWorkbookSheetPreview/);
  assert.match(ui, /function ImportHistory/);
  assert.match(ui, /function DurableStaging/);
  assert.match(ui, /importSheetPreview/);
  assert.match(ui, /عرض عينة/);
  assert.match(ui, /plan\.stagingOnly \|\| plan\.totalRows === 0/);
  assert.match(ui, /disabled=\{busy \|\| plan\.stagingOnly \|\| plan\.totalRows === 0\}/);
});

test('intake user-facing text no longer requires the ministry template', () => {
  assert.match(ui, /يحفظ الملف الأصلي ويفهرس محتواه/);
  assert.match(ui, /تُفهرس جميع الأوراق الظاهرة والمخفية/);
  assert.match(ui, /الاستيراد المباشر الحالي يقتصر على جدول المديريات المعروف/);
  assert.doesNotMatch(ui, /اختر ملف «القالب المحدث»/);
});


test('staged project regions are owner-gated, paged and promoted only through explicit approval', () => {
  assert.match(main, /ipcMain\.handle\('import:regions'/);
  assert.match(main, /ipcMain\.handle\('import:region-preview'/);
  assert.match(main, /ipcMain\.handle\('import:promote-projects'/);
  assert.match(main, /currentProfile\(\) !== 'owner'/);
  assert.match(main, /canonicalData\.listWorkbookImportRegions/);
  assert.match(main, /canonicalData\.readWorkbookImportRegion/);
  assert.match(main, /canonicalData\.promoteProjectRegion/);
  assert.match(preload, /importRegions: \(request\) => ipcRenderer\.invoke\('import:regions', request\)/);
  assert.match(preload, /importRegionPreview: \(request\) => ipcRenderer\.invoke\('import:region-preview', request\)/);
  assert.match(preload, /promoteProjects: \(request\) => ipcRenderer\.invoke\('import:promote-projects', request\)/);
  assert.match(ui, /function ProjectRegionReview/);
  assert.match(ui, /candidateType === 'project-candidate'/);
  assert.match(ui, /اعتماد المشاريع المحددة في قاعدة البيانات/);
  assert.match(ui, /approvedRows/);
  assert.match(ui, /checked=\{Boolean\(selectedRows\[row\.rowNumber\]\)\}/);
});



test('full database backups and restore are blocked in shared mode at IPC and UI layers', () => {
  const backupStart = main.indexOf("ipcMain.handle('db:backup'");
  const restoreStart = main.indexOf("ipcMain.handle('db:restore'");
  assert.ok(backupStart >= 0 && restoreStart > backupStart);
  const backupHandler = main.slice(backupStart, main.indexOf("ipcMain.handle('db:restore'", backupStart));
  const restoreHandler = main.slice(restoreStart, main.indexOf("ipcMain.handle('db:backups'", restoreStart));
  assert.match(backupHandler, /currentProfile\(\) !== 'owner'/);
  assert.match(restoreHandler, /currentProfile\(\) !== 'owner'/);
  assert.match(shell, /profile !== 'shared'/);
  assert.match(shell, /aria-label="إنشاء نسخة احتياطية الآن"/);
  assert.match(shell, /aria-label="استعادة نسخة احتياطية"/);
});



test('canonical project register is routed, paged, owner-gated and displays provenance', () => {
  assert.match(main, /ipcMain\.handle\('projects:list'/);
  assert.match(main, /ipcMain\.handle\('projects:get'/);
  assert.match(main, /canonicalData\.listCanonicalProjects/);
  assert.match(main, /canonicalData\.getCanonicalProject/);
  assert.match(preload, /canonicalProjects: \(request\) => ipcRenderer\.invoke\('projects:list', request\)/);
  assert.match(preload, /canonicalProject: \(projectId\) => ipcRenderer\.invoke\('projects:get', projectId\)/);
  assert.match(app, /case 'projects'/);
  assert.match(app, /<Projects notify=\{notify\} refreshKey=\{refreshKey\} \/>/);
  assert.match(shell, /id: 'projects', label: 'سجل المشاريع'/);
  assert.match(projects, /window\.localApp\.canonicalProjects/);
  assert.match(projects, /window\.localApp\.canonicalProject/);
  assert.match(projects, /مصدر البيانات/);
  assert.match(projects, /التحرير اليدوي وسير اعتماد التعديلات لم يُفعّلا بعد/);
});

