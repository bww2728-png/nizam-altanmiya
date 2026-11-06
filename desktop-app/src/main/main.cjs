const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const ExcelJS = require('exceljs');
const { openEncryptedStore, loadOrCreateStoreKey, classifyStore, findLegacyBackups, quarantineLegacyDatabase } = require('./store.cjs');
const { extractFile } = require('./importers.cjs');
const { saveImportBatch, updateReviewItem, resolveReviewItems } = require('./repository.cjs');
const { analyze } = require('./analysis/engine.cjs');
const { readDirectorateWorkbook } = require('./analysis/template-reader.cjs');
const { mappingTable } = require('./analysis/mapping.cjs');
const { defaultWeights, validateWeights } = require('./analysis/composite.cjs');
const persist = require('./analysis/persist.cjs');
const { serializeAnalysis } = require('./analysis/serialize.cjs');
const { exportAnalysisWorkbook } = require('./analysis/exporter.cjs');
const { exportAnalysisPdf } = require('./analysis/pdf.cjs');

let mainWindow;
let database;
/** Workbook read but not yet committed to the database. */
let pendingTemplate = null;
/** Last analysis held in memory so exports never recompute silently. */
let lastAnalysis = null;

function getDatabasePath() {
  return path.join(app.getPath('userData'), 'development-data.db');
}

function getStoreKeyPath() {
  return path.join(app.getPath('userData'), 'store.key');
}

function hasUsableDatabase() {
  const filePath = getDatabasePath();
  return fs.existsSync(filePath) && fs.statSync(filePath).size > 0;
}

function openDatabase() {
  const filePath = getDatabasePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  return openEncryptedStore(filePath, loadOrCreateStoreKey(getStoreKeyPath()));
}

function requireDatabase() {
  if (!database) throw new Error('افتح قاعدة البيانات المحلية أولًا.');
  return database;
}

function sendProgress(message) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('import:progress', message);
}

const TEMPLATE_MAX_BYTES = 200 * 1024 * 1024;

/** Reject a template path that is not a readable Excel workbook before opening it. */
function assertTemplatePath(filePath) {
  const extension = path.extname(String(filePath)).toLowerCase();
  if (extension !== '.xlsx' && extension !== '.xlsm') {
    throw new Error('صيغة الملف غير مدعومة. اختر ملف Excel بصيغة xlsx أو xlsm.');
  }
  if (!fs.existsSync(filePath)) throw new Error('ملف القالب غير موجود في المسار المحدد.');
  const stat = fs.statSync(filePath);
  if (!stat.isFile() || stat.size === 0) throw new Error('ملف القالب فارغ أو ليس ملفًا صالحًا.');
  if (stat.size > TEMPLATE_MAX_BYTES) throw new Error('حجم ملف القالب يتجاوز الحد الآمن (200 ميجابايت).');
  return filePath;
}

/** Validate the calibration thresholds coming from the renderer. */
function validateCalibration(kThreshold, deprivationLine) {
  if (kThreshold !== undefined && kThreshold !== null) {
    const value = Number(kThreshold);
    if (!Number.isInteger(value) || value < 1 || value > 12) {
      throw new Error('عتبة الانحدار (k) يجب أن تكون عددًا صحيحًا بين 1 و12.');
    }
  }
  if (deprivationLine !== undefined && deprivationLine !== null) {
    const value = Number(deprivationLine);
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new Error('خط الحرمان يجب أن يكون رقمًا بين 0 و1.');
    }
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 980,
    minWidth: 1060,
    minHeight: 720,
    backgroundColor: '#f3f6f8',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  // Only honour a dev server when running from source; a packaged build always loads its own files.
  const devServerURL = app.isPackaged
    ? null
    : process.env.VITE_DEV_SERVER_URL || process.argv.find((argument) => argument.startsWith('--dev-server='))?.slice('--dev-server='.length);
  if (devServerURL) mainWindow.loadURL(devServerURL);
  else mainWindow.loadFile(path.join(__dirname, '../../dist/index.html'));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!devServerURL || !url.startsWith(devServerURL)) event.preventDefault();
  });
}

function registerHandlers() {
  ipcMain.handle('app:status', () => ({
    unlocked: Boolean(database),
    hasDatabase: hasUsableDatabase(),
    hasKey: fs.existsSync(getStoreKeyPath()),
  }));
  ipcMain.handle('db:open', () => {
    if (database) return { success: true, quarantined: null, recoveredFrom: null };
    // A database created by the earlier passphrase-protected build cannot be read with the
    // generated key. Instead of failing, keep the user's file: build the replacement at a
    // temporary path first (so a broken key or disk never leaves the user with nothing),
    // then move the legacy file aside and promote the new store into place.
    const filePath = getDatabasePath();
    const keyPath = getStoreKeyPath();
    const hadUsable = hasUsableDatabase();
    let quarantined = null;

    if (hadUsable) {
      const key = loadOrCreateStoreKey(keyPath);
      const verdict = classifyStore(filePath, key);
      if (verdict.reason === 'busy') {
        throw new Error('قاعدة البيانات مفتوحة في نافذة أخرى من التطبيق. أغلق النسخة الأخرى ثم أعد المحاولة.');
      }
      if (verdict.reason === 'unknown') {
        throw new Error(`تعذّر فحص قاعدة البيانات الموجودة، ولم تُعدّل أي بيانات. ${verdict.error?.message ?? ''}`.trim());
      }
      if (verdict.reason === 'foreign') {
        let stagedPath = `${filePath}.staged-${Date.now()}`;
        try {
          const staged = openEncryptedStore(stagedPath, key);
          staged.close();
          quarantined = quarantineLegacyDatabase(filePath);
          fs.renameSync(stagedPath, filePath);
          stagedPath = null;
        } catch (error) {
          if (stagedPath) { try { fs.rmSync(stagedPath, { force: true }); } catch { /* best effort */ } }
          if (quarantined) {
            throw new Error(`تعذّر تجهيز قاعدة البيانات الجديدة. لم تُحذف بياناتك؛ نُقلت إلى «${quarantined}». أعد المحاولة أو استعد النسخة يدويًا.`);
          }
          throw error;
        }
      }
    }

    database = openDatabase();
    // When no usable store existed but a previous quarantine backup does, tell the
    // user where their old data went instead of silently starting empty.
    const recoveredFrom = !hadUsable && !quarantined ? findLegacyBackups(filePath)[0] ?? null : null;
    return { success: true, quarantined, recoveredFrom };
  });
  ipcMain.handle('db:lock', () => {
    if (database) database.close();
    database = undefined;
    // Anything cached from the unlocked session must not survive the lock.
    pendingTemplate = null;
    lastAnalysis = null;
    return { success: true };
  });

  ipcMain.handle('data:overview', () => {
    const db = requireDatabase();
    return {
      records: db.prepare('SELECT COUNT(DISTINCT governorate || char(31) || district || char(31) || subdistrict || char(31) || settlement || char(31) || record_type || char(31) || record_id) AS count FROM data_values').get().count,
      values: db.prepare('SELECT COUNT(*) AS count FROM data_values').get().count,
      pending: db.prepare("SELECT COUNT(*) AS count FROM review_items WHERE status = 'pending'").get().count,
      conflicts: db.prepare("SELECT COUNT(*) AS count FROM review_items WHERE status = 'conflict'").get().count,
      batches: db.prepare('SELECT COUNT(*) AS count FROM import_batches').get().count,
      recent: db.prepare('SELECT id, file_name, file_type, item_count, status, created_at FROM import_batches ORDER BY id DESC LIMIT 6').all(),
    };
  });
  ipcMain.handle('data:imports', () => requireDatabase().prepare('SELECT id, file_name, file_type, file_size, item_count, status, warnings_json, created_at FROM import_batches ORDER BY id DESC LIMIT 100').all());
  ipcMain.handle('data:values', () => requireDatabase().prepare('SELECT id, governorate, district, subdistrict, settlement, record_type, record_id, field_name, value_text, source_file, source_location, imported_at FROM data_values ORDER BY imported_at DESC LIMIT 1000').all());
  ipcMain.handle('review:list', (_event, filters = {}) => {
    const status = ['pending', 'accepted', 'rejected', 'conflict'].includes(filters.status) ? filters.status : 'pending';
    const batchId = Number.isInteger(Number(filters.batchId)) && Number(filters.batchId) > 0 ? Number(filters.batchId) : null;
    const limit = Math.min(500, Math.max(1, Number(filters.limit) || 200));
    const db = requireDatabase();
    const rows = batchId
      ? db.prepare('SELECT r.*, b.file_name FROM review_items r JOIN import_batches b ON b.id=r.batch_id WHERE r.status=? AND r.batch_id=? ORDER BY r.id LIMIT ?').all(status, batchId, limit)
      : db.prepare('SELECT r.*, b.file_name FROM review_items r JOIN import_batches b ON b.id=r.batch_id WHERE r.status=? ORDER BY r.id DESC LIMIT ?').all(status, limit);
    return rows;
  });

  ipcMain.handle('import:select-and-extract', async () => {
    const db = requireDatabase();
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: 'اختر ملفًا محليًا للاستيراد',
      properties: ['openFile'],
      filters: [{ name: 'ملفات البيانات', extensions: ['xlsx', 'pdf', 'docx'] }],
    });
    if (canceled || !filePaths.length) return { canceled: true };
    sendProgress({ stage: 'extracting', message: 'جارٍ استخراج النصوص محليًا…' });
    try {
      const extracted = await extractFile(filePaths[0]);
      if (!extracted.items.length) throw new Error('لم يُعثر على قيم قابلة للعرض للمراجعة في هذا الملف.');
      const batchId = saveImportBatch(db, extracted);
      return { canceled: false, batchId, fileName: extracted.fileName, itemCount: extracted.items.length, pages: extracted.pages, truncated: extracted.truncated, warnings: extracted.warnings || [] };
    } finally {
      sendProgress({ stage: 'done', message: '' });
    }
  });

  ipcMain.handle('review:update', (_event, item) => updateReviewItem(requireDatabase(), item));

  ipcMain.handle('review:resolve', (_event, request) => resolveReviewItems(requireDatabase(), request));

  ipcMain.handle('analysis:read-template', async (_event, request = {}) => {
    let filePath = request.filePath;
    if (!filePath) {
      const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
        title: 'اختر ملف «القالب المحدث» (قاعدة البيانات الشاملة)',
        properties: ['openFile'],
        filters: [{ name: 'ملفات Excel', extensions: ['xlsx', 'xlsm'] }],
      });
      if (canceled || !filePaths.length) return { canceled: true };
      filePath = filePaths[0];
    }
    filePath = assertTemplatePath(filePath);
    const read = await readDirectorateWorkbook(filePath);
    pendingTemplate = { filePath, read };
    lastAnalysis = null;
    persist.logAccess(requireDatabase(), { action: 'template-read', entity: 'workbook', entityId: filePath, detail: `rows=${read.totalRows};sheet=${read.sheetName}` });
    return {
      canceled: false,
      filePath,
      fileName: read.fileName,
      sheetName: read.sheetName,
      headerRow: read.headerRow,
      totalRows: read.totalRows,
      matchedCount: read.matched.length,
      missingInputs: read.missingInputs,
      duplicates: read.duplicates,
      warnings: read.warnings,
      preview: read.rows.slice(0, 12).map((row) => ({
        districtName: row.districtName,
        governorate: row.governorate,
        rowNumber: row.rowNumber,
      })),
    };
  });

  ipcMain.handle('analysis:commit-template', () => {
    const db = requireDatabase();
    if (!pendingTemplate) throw new Error('لم يُقرأ أي ملف بعد. اختر ملف القالب أولًا.');
    const counts = persist.upsertDirectorates(db, pendingTemplate.read);
    lastAnalysis = null;
    return { ...counts, fileName: pendingTemplate.read.fileName, sheetName: pendingTemplate.read.sheetName };
  });

  ipcMain.handle('analysis:run', (_event, request = {}) => {
    const db = requireDatabase();
    validateCalibration(request.kThreshold, request.deprivationLine);
    const rows = persist.loadAnalysisRows(db, request.filter ?? {});
    if (!rows.length) throw new Error('لا توجد مديريات في قاعدة البيانات. استورد ملف القالب أولًا.');
    if (request.weights) {
      const check = validateWeights(request.weights);
      if (!check.valid) throw new Error(`أوزان غير صالحة: ${check.errors.join(' ')}`);
    }
    const storedWeights = persist.getWeights(db)?.weights;
    const analysis = analyze(rows, {
      weights: request.weights ?? storedWeights ?? undefined,
      kThreshold: request.kThreshold,
      deprivationLine: request.deprivationLine,
    });
    // Only a successfully persisted run may become the exportable "last analysis",
    // so exports never silently carry a run that was never written to the store.
    const saved = request.save === false ? null : persist.saveRun(db, analysis, {
      templateFile: pendingTemplate?.read?.fileName ?? analysis.meta?.template?.fileName ?? null,
      templateSheet: pendingTemplate?.read?.sheetName ?? analysis.meta?.template?.sheet ?? null,
      mode: 'both',
    });
    lastAnalysis = analysis;
    return { analysis: serializeAnalysis(analysis), runId: saved?.runId ?? null };
  });

  ipcMain.handle('analysis:latest', () => {
    const db = requireDatabase();
    return persist.getLatestRun(db);
  });

  ipcMain.handle('analysis:runs', () => persist.listRuns(requireDatabase(), 50));

  ipcMain.handle('analysis:weights:get', () => {
    const db = requireDatabase();
    const active = persist.getWeights(db);
    return { active, defaults: defaultWeights(), history: persist.listWeights(db, 30) };
  });

  ipcMain.handle('analysis:weights:set', (_event, request = {}) => {
    const db = requireDatabase();
    const weights = request.weights ?? {};
    const check = validateWeights(weights);
    if (!check.valid) throw new Error(`أوزان غير صالحة: ${check.errors.join(' ')}`);
    const saved = persist.setWeights(db, weights, request.note ?? null, request.name ?? 'default');
    lastAnalysis = null;
    persist.logAccess(db, { action: 'weights-update', entity: 'analysis_weights', entityId: saved?.id ?? '', detail: request.note ?? '' });
    return saved;
  });

  ipcMain.handle('analysis:audit', (_event, request = {}) => persist.listAccess(requireDatabase(), request.limit ?? 200));

  ipcMain.handle('analysis:fields', () => mappingTable());

  ipcMain.handle('analysis:directorates', (_event, request = {}) => {
    const db = requireDatabase();
    return { total: persist.countDirectorates(db), rows: persist.listDirectorates(db, request) };
  });

  ipcMain.handle('analysis:export-excel', async () => {
    const db = requireDatabase();
    const analysis = lastAnalysis ?? rebuildAnalysis(db);
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: 'تصدير نتائج التحليل',
      defaultPath: `تحليل-التنمية-${new Date().toISOString().slice(0, 10)}.xlsx`,
      filters: [{ name: 'Excel', extensions: ['xlsx'] }],
    });
    if (canceled || !filePath) return { canceled: true };
    await exportAnalysisWorkbook(filePath, analysis, { audit: persist.listAccess(db, 500) });
    persist.logAccess(db, { action: 'export-excel', entity: 'file', entityId: filePath });
    return { canceled: false, filePath };
  });

  ipcMain.handle('analysis:export-pdf', async () => {
    const db = requireDatabase();
    const analysis = lastAnalysis ?? rebuildAnalysis(db);
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: 'تصدير التقرير',
      defaultPath: `تقرير-التنمية-${new Date().toISOString().slice(0, 10)}.pdf`,
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (canceled || !filePath) return { canceled: true };
    const result = await exportAnalysisPdf({ BrowserWindow }, filePath, analysis, { audit: persist.listAccess(db, 100) });
    persist.logAccess(db, { action: 'export-pdf', entity: 'file', entityId: filePath });
    return { canceled: false, ...result };
  });

  ipcMain.handle('data:export', async () => {
    const db = requireDatabase();
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: 'تصدير السجلات المعتمدة',
      defaultPath: 'بيانات-التنمية-المحلية.xlsx',
      filters: [{ name: 'Excel', extensions: ['xlsx'] }],
    });
    if (canceled || !filePath) return { canceled: true };
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'نظام التنمية المحلية';
    workbook.created = new Date();
    const sheet = workbook.addWorksheet('القيم المعتمدة', { views: [{ state: 'frozen', ySplit: 1, rightToLeft: true }] });
    sheet.columns = [
      { header: 'المحافظة', key: 'governorate', width: 20 }, { header: 'المديرية', key: 'district', width: 20 },
      { header: 'العزلة', key: 'subdistrict', width: 20 }, { header: 'التجمع/القرية', key: 'settlement', width: 24 },
      { header: 'نوع السجل', key: 'record_type', width: 18 }, { header: 'معرّف السجل', key: 'record_id', width: 18 },
      { header: 'الحقل', key: 'field_name', width: 32 }, { header: 'القيمة', key: 'value_text', width: 40 },
      { header: 'ملف المصدر', key: 'source_file', width: 34 }, { header: 'موضع المصدر', key: 'source_location', width: 42 },
      { header: 'تاريخ الاعتماد', key: 'imported_at', width: 26 },
    ];
    sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF18324B' } };
    sheet.addRows(db.prepare('SELECT governorate,district,subdistrict,settlement,record_type,record_id,field_name,value_text,source_file,source_location,imported_at FROM data_values ORDER BY governorate,district,subdistrict,settlement,record_type,record_id,field_name').all());
    await workbook.xlsx.writeFile(filePath);
    return { canceled: false, filePath };
  });
}

/** Re-run the analysis from the database when nothing is cached in memory. */
function rebuildAnalysis(database) {
  const rows = persist.loadAnalysisRows(database, {});
  if (!rows.length) throw new Error('لا توجد مديريات في قاعدة البيانات. استورد ملف القالب أولًا.');
  const analysis = analyze(rows, { weights: persist.getWeights(database)?.weights ?? undefined });
  lastAnalysis = analysis;
  return analysis;
}

// A second instance would probe the same database file concurrently and could
// misinterpret a busy file, so only one window is allowed to own the store.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    registerHandlers();
    createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });
}

app.on('before-quit', () => {
  if (database) database.close();
  database = undefined;
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
