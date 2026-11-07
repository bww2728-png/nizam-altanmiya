const { app, BrowserWindow, dialog, ipcMain, Menu } = require('electron');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const ExcelJS = require('exceljs');
const {
  openEncryptedStore,
  loadOrCreateStoreKey,
  classifyStore,
  findLegacyBackups,
  quarantineLegacyDatabase,
  backupStore,
  listBackups,
} = require('./store.cjs');
const { extractFile, IMAGE_EXTENSIONS } = require('./importers.cjs');
const { saveImportBatch, updateReviewItem, resolveReviewItems } = require('./repository.cjs');
const security = require('./security.cjs');
const { analyze } = require('./analysis/engine.cjs');
const { readDirectorateWorkbook } = require('./analysis/template-reader.cjs');
const { mappingTable, matchHeader } = require('./analysis/mapping.cjs');
const { defaultWeights, validateWeights } = require('./analysis/composite.cjs');
const persist = require('./analysis/persist.cjs');
const bridge = require('./analysis/bridge.cjs');
const { serializeAnalysis } = require('./analysis/serialize.cjs');
const { exportAnalysisWorkbook } = require('./analysis/exporter.cjs');
const { exportAnalysisPdf } = require('./analysis/pdf.cjs');
const { recognizeEntryFile } = require('./analysis/ocr-entry.cjs');
const { DIRECTORATE_COLUMNS } = require('./analysis/store-schema.cjs');
const ocr = require('./ocr-pipeline.cjs');

let mainWindow;
let database;
/** Workbook read but not yet committed to the database. */
let pendingTemplate = null;
/** Last analysis held in memory so exports never recompute silently. */
let lastAnalysis = null;
/** Identifier written into every read-audit row for this unlocked session. */
let sessionId = crypto.randomUUID();
/** Set while an OCR read is running so it can be cancelled from the UI. */
let ocrCancelled = false;
let ocrRunning = false;

const COLUMN_BY_KEY = DIRECTORATE_COLUMNS;
const KEY_BY_COLUMN = Object.fromEntries(Object.entries(DIRECTORATE_COLUMNS).map(([key, column]) => [column, key]));

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
  return openEncryptedStore(filePath, loadOrCreateStoreKey(getStoreKeyPath(), { databaseExists: hasUsableDatabase() }));
}

function requireDatabase() {
  if (!database) throw new Error('افتح قاعدة البيانات المحلية أولًا.');
  return database;
}

function sendProgress(message) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('import:progress', message);
}

function sendOcrProgress(message) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('ocr:progress', message);
}

/** Append a read-audit row for the current session. Never throws. */
function auditRead(channel, entry = {}) {
  if (!database) return;
  persist.logRead(database, { sessionId, channel, ...entry });
}

function currentProfile() {
  return security.getAccessProfile(requireDatabase());
}

/** Mask DB rows (column-keyed) for the active access profile. */
function maskDbRows(rows, profile) {
  if (profile !== 'shared') return { rows, masked: [] };
  const maskedKeys = new Set();
  const output = rows.map((row) => {
    const result = security.maskRecord(row, profile, COLUMN_BY_KEY);
    result.masked.forEach((key) => maskedKeys.add(key));
    return result.record;
  });
  return { rows: output, masked: [...maskedKeys] };
}

/** Mask engine rows (values/rawValues) for the active access profile. */
function maskEngineRows(rows, profile) {
  if (profile !== 'shared') return { rows, masked: [] };
  const maskedKeys = new Set();
  const output = rows.map((row) => {
    const result = security.maskEngineRow(row, profile);
    result.masked.forEach((key) => maskedKeys.add(key));
    return result.row;
  });
  return { rows: output, masked: [...maskedKeys] };
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

/**
 * A small JPEG preview of the recognised image, so the reviewer can compare the
 * proposal with the page instead of trusting OCR blindly. PDF pages are not
 * previewed here: the entry screen reads them page by page and a single image
 * would misrepresent the source.
 */
async function previewDataUrl(filePath) {
  const extension = path.extname(String(filePath)).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(extension)) return null;
  try {
    const { createCanvas, loadImage } = require('@napi-rs/canvas');
    const image = await loadImage(filePath);
    const max = 1100;
    const scale = Math.min(1, max / Math.max(image.width, image.height));
    const width = Math.max(1, Math.round(image.width * scale));
    const height = Math.max(1, Math.round(image.height * scale));
    const canvas = createCanvas(width, height);
    canvas.getContext('2d').drawImage(image, 0, 0, width, height);
    return `data:image/jpeg;base64,${canvas.toBuffer('image/jpeg', 82).toString('base64')}`;
  } catch {
    return null;
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
      devTools: !app.isPackaged,
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

  if (app.isPackaged) {
    // The renderer can reach every channel through `window.localApp`; leaving
    // DevTools available in a packaged build turns that into a full data reader
    // for anyone at the keyboard.
    mainWindow.webContents.on('before-input-event', (event, input) => {
      const key = String(input.key ?? '').toLowerCase();
      const isDevTools = key === 'f12'
        || (input.control && input.shift && (key === 'i' || key === 'j' || key === 'c'));
      if (isDevTools) event.preventDefault();
    });
    mainWindow.webContents.on('devtools-opened', () => {
      mainWindow.webContents.closeDevTools();
    });
  }
}

function registerHandlers() {
  ipcMain.handle('app:status', () => {
    const profile = database ? security.getAccessProfile(database) : security.DEFAULT_PROFILE;
    return {
      unlocked: Boolean(database),
      hasDatabase: hasUsableDatabase(),
      hasKey: fs.existsSync(getStoreKeyPath()),
      accessProfile: profile,
      accessProfileLabel: security.PROFILE_LABELS[profile],
      // A pre-open count so the welcome screen can warn before the user clicks.
      backups: hasUsableDatabase() ? listBackups(getDatabasePath()).length : 0,
    };
  });

  ipcMain.handle('db:open', () => {
    if (database) return { success: true, quarantined: null, recoveredFrom: null, backup: null };
    // A database created by the earlier passphrase-protected build cannot be read with the
    // generated key. Instead of failing, keep the user's file: build the replacement at a
    // temporary path first (so a broken key or disk never leaves the user with nothing),
    // then move the legacy file aside and promote the new store into place.
    const filePath = getDatabasePath();
    const keyPath = getStoreKeyPath();
    const hadUsable = hasUsableDatabase();
    let quarantined = null;
    let backup = null;

    if (hadUsable) {
      const key = loadOrCreateStoreKey(keyPath, { databaseExists: true });
      const verdict = classifyStore(filePath, key);
      if (verdict.reason === 'busy') {
        throw new Error('قاعدة البيانات مفتوحة في نافذة أخرى من التطبيق. أغلق النسخة الأخرى ثم أعد المحاولة.');
      }
      if (verdict.reason === 'corrupt') {
        const newest = listBackups(filePath)[0];
        throw new Error(
          `قاعدة البيانات تالفة ولم يُعدّل التطبيق أي شيء. استعد أحدث نسخة احتياطية${newest ? ` من «${newest}»` : ' من مجلد backups'} أو انقل الملف يدويًا إلى مجلد آخر.`
        );
      }
      if (verdict.reason === 'unknown') {
        throw new Error(`تعذّر فحص قاعدة البيانات الموجودة، ولم تُعدّل أي بيانات. ${verdict.error?.message ?? ''}`.trim());
      }
      if (verdict.reason === 'foreign') {
        // Keep a byte-for-byte copy before touching anything: the "foreign"
        // verdict usually means a different key, not a worthless file.
        try { backup = backupStore(filePath); } catch { /* the move below still protects the user */ }
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
    sessionId = crypto.randomUUID();
    // When no usable store existed but a previous quarantine backup does, tell the
    // user where their old data went instead of silently starting empty.
    const recoveredFrom = !hadUsable && !quarantined ? findLegacyBackups(filePath)[0] ?? null : null;
    auditRead('db:open', { entity: 'store', result: 'ok', detail: `quarantined=${Boolean(quarantined)};backup=${Boolean(backup)}` });
    return { success: true, quarantined, recoveredFrom, backup };
  });

  ipcMain.handle('db:lock', () => {
    if (database) database.close();
    database = undefined;
    // Anything cached from the unlocked session must not survive the lock.
    pendingTemplate = null;
    lastAnalysis = null;
    ocrCancelled = false;
    ocrRunning = false;
    return { success: true };
  });

  ipcMain.handle('db:backup', async () => {
    const db = requireDatabase();
    const directory = path.join(app.getPath('userData'), 'backups');
    fs.mkdirSync(directory, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const target = path.join(directory, `development-data.db.${stamp}.bak`);
    await db.backup(target);
    persist.logAccess(db, { action: 'store-backup', entity: 'store', entityId: target });
    auditRead('db:backup', { entity: 'store', entityId: target });
    return { filePath: target, backups: listBackups(getDatabasePath()).length };
  });

  ipcMain.handle('db:backups', () => ({ backups: listBackups(getDatabasePath()) }));

  ipcMain.handle('security:profile:get', () => {
    const db = requireDatabase();
    const profile = security.getAccessProfile(db);
    return {
      profile,
      label: security.PROFILE_LABELS[profile],
      profiles: security.PROFILES.map((name) => ({ name, label: security.PROFILE_LABELS[name] })),
      protectedFields: security.PROTECTED_KEYS,
    };
  });

  ipcMain.handle('security:profile:set', (_event, request = {}) => {
    const db = requireDatabase();
    const next = security.setAccessProfile(db, request.profile);
    persist.logAccess(db, { action: 'access-profile', entity: 'app_settings', entityId: security.ACCESS_PROFILE_KEY, detail: next });
    auditRead('security:profile:set', { entity: 'app_settings', result: next, detail: 'profile-changed' });
    return { profile: next, label: security.PROFILE_LABELS[next] };
  });

  ipcMain.handle('data:overview', () => {
    const db = requireDatabase();
    const overview = {
      records: db.prepare('SELECT COUNT(DISTINCT governorate || char(31) || district || char(31) || subdistrict || char(31) || settlement || char(31) || record_type || char(31) || record_id) AS count FROM data_values').get().count,
      values: db.prepare('SELECT COUNT(*) AS count FROM data_values').get().count,
      pending: db.prepare("SELECT COUNT(*) AS count FROM review_items WHERE status = 'pending'").get().count,
      conflicts: db.prepare("SELECT COUNT(*) AS count FROM review_items WHERE status = 'conflict'").get().count,
      batches: db.prepare('SELECT COUNT(*) AS count FROM import_batches').get().count,
      recent: db.prepare('SELECT id, file_name, file_type, item_count, status, created_at FROM import_batches ORDER BY id DESC LIMIT 6').all(),
    };
    auditRead('data:overview', { entity: 'data_values', rowCount: overview.values });
    return overview;
  });

  ipcMain.handle('data:imports', () => {
    const rows = requireDatabase().prepare('SELECT id, file_name, file_type, file_size, item_count, status, warnings_json, created_at FROM import_batches ORDER BY id DESC LIMIT 100').all();
    auditRead('data:imports', { entity: 'import_batches', rowCount: rows.length, detail: rows.length >= 100 ? 'capped-100' : 'complete' });
    return rows;
  });

  ipcMain.handle('data:values', () => {
    const profile = currentProfile();
    const rows = requireDatabase().prepare('SELECT id, governorate, district, subdistrict, settlement, record_type, record_id, field_name, value_text, source_file, source_location, imported_at FROM data_values ORDER BY imported_at DESC LIMIT 1000').all();
    const filtered = profile === 'shared'
      ? rows.filter((row) => {
        const match = matchHeader(row.field_name);
        return !(match?.key && security.PROTECTED_KEYS.includes(match.key));
      })
      : rows;
    auditRead('data:values', {
      entity: 'data_values',
      rowCount: filtered.length,
      result: profile === 'shared' ? 'masked' : 'ok',
      detail: profile === 'shared' ? `hidden=${rows.length - filtered.length};capped-1000` : 'capped-1000',
    });
    return filtered;
  });

  ipcMain.handle('review:list', (_event, filters = {}) => {
    const status = ['pending', 'accepted', 'rejected', 'conflict'].includes(filters.status) ? filters.status : 'pending';
    const batchId = Number.isInteger(Number(filters.batchId)) && Number(filters.batchId) > 0 ? Number(filters.batchId) : null;
    const limit = Math.min(500, Math.max(1, Number(filters.limit) || 200));
    const db = requireDatabase();
    const rows = batchId
      ? db.prepare('SELECT r.*, b.file_name FROM review_items r JOIN import_batches b ON b.id=r.batch_id WHERE r.status=? AND r.batch_id=? ORDER BY r.id LIMIT ?').all(status, batchId, limit)
      : db.prepare('SELECT r.*, b.file_name FROM review_items r JOIN import_batches b ON b.id=r.batch_id WHERE r.status=? ORDER BY r.id DESC LIMIT ?').all(status, limit);
    auditRead('review:list', { entity: 'review_items', rowCount: rows.length, detail: `status=${status};batch=${batchId ?? 'all'};capped-${limit}` });
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
    sendProgress({ stage: 'extracting', message: 'جارٍ استخراج النصوص محليًا...' });
    try {
      const extracted = await extractFile(filePaths[0]);
      if (!extracted.items.length) throw new Error('لم يُعثر على قيم قابلة للعرض للمراجعة في هذا الملف.');
      const batchId = saveImportBatch(db, extracted);
      auditRead('import:select-and-extract', { entity: 'import_batches', entityId: batchId, rowCount: extracted.items.length });
      return { canceled: false, batchId, fileName: extracted.fileName, itemCount: extracted.items.length, pages: extracted.pages, truncated: extracted.truncated, warnings: extracted.warnings || [] };
    } finally {
      sendProgress({ stage: 'done', message: '' });
    }
  });

  ipcMain.handle('review:update', (_event, item) => {
    const result = updateReviewItem(requireDatabase(), item);
    auditRead('review:update', { entity: 'review_items', entityId: item?.id, result: result.success ? 'ok' : 'refused', detail: result.message ?? '' });
    return result;
  });

  ipcMain.handle('review:resolve', (_event, request) => {
    const result = resolveReviewItems(requireDatabase(), request);
    auditRead('review:resolve', {
      entity: 'review_items',
      rowCount: Array.isArray(request?.ids) ? request.ids.length : null,
      result: request?.action ?? 'unknown',
      detail: `accepted=${result.accepted};rejected=${result.rejected};conflicts=${result.conflicts};ignored=${result.ignored}`,
    });
    return result;
  });

  // ---- Review -> analysis bridge -------------------------------------------
  ipcMain.handle('bridge:candidates', () => {
    const db = requireDatabase();
    const candidates = bridge.listCandidates(db);
    auditRead('bridge:candidates', { entity: 'data_values', rowCount: candidates.length });
    return { candidates, total: candidates.length, pending: candidates.filter((entry) => !entry.directorateId).length };
  });

  ipcMain.handle('bridge:run', (_event, request = {}) => {
    const db = requireDatabase();
    const result = bridge.bridgeAll(db, { keys: request.keys });
    lastAnalysis = null;
    auditRead('bridge:run', { entity: 'directorates', rowCount: result.total, detail: `created=${result.created};updated=${result.updated};skipped=${result.skipped}` });
    return result;
  });

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
    auditRead('analysis:read-template', { entity: 'workbook', entityId: filePath, rowCount: read.totalRows });
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
    auditRead('analysis:commit-template', { entity: 'directorates', rowCount: counts.total, detail: `created=${counts.created};updated=${counts.updated}` });
    return { ...counts, fileName: pendingTemplate.read.fileName, sheetName: pendingTemplate.read.sheetName };
  });

  ipcMain.handle('analysis:run', (_event, request = {}) => {
    const db = requireDatabase();
    validateCalibration(request.kThreshold, request.deprivationLine);
    const rows = persist.loadAnalysisRows(db, request.filter ?? {});
    if (!rows.length) throw new Error('لا توجد مديريات في قاعدة البيانات. استورد ملف القالب أولًا أو رحّل القيم المعتمدة من شاشة المراجعة.');
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
    const profile = security.getAccessProfile(db);
    auditRead('analysis:run', {
      entity: 'analysis_runs',
      entityId: saved?.runId ?? null,
      rowCount: analysis.rows?.length ?? 0,
      result: profile === 'shared' ? 'masked' : 'ok',
    });
    // Compact payload: per-row `values`/`rawValues` stay in the main process and
    // are fetched on demand by `analysis:row-detail`. At 20k rows that is the
    // difference between ~190 MB and a few MB per run.
    return { analysis: serializeAnalysis(analysis, { compact: true }), runId: saved?.runId ?? null };
  });

  ipcMain.handle('analysis:row-detail', (_event, request = {}) => {
    if (!lastAnalysis) throw new Error('شغّل التحليل أولًا لعرض تفاصيل المديرية.');
    const index = Number(request.index);
    const row = (lastAnalysis.rows ?? [])[index];
    if (!row) throw new Error('الصف المطلوب غير موجود في آخر تحليل.');
    const profile = currentProfile();
    const masked = security.maskEngineRow(row, profile);
    auditRead('analysis:row-detail', {
      entity: 'directorates',
      entityId: row.dbId ?? null,
      fields: masked.masked.join(','),
      result: masked.masked.length ? 'masked' : 'ok',
    });
    return {
      index,
      values: masked.row.values ?? {},
      rawValues: masked.row.rawValues ?? {},
      warnings: row.warnings ?? [],
      indicators: row.indicators ?? {},
      sensitivity: row.sensitivity ?? null,
      masked: masked.masked,
    };
  });

  ipcMain.handle('analysis:latest', () => {
    const db = requireDatabase();
    auditRead('analysis:latest', { entity: 'analysis_runs' });
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

  ipcMain.handle('analysis:audit', (_event, request = {}) =>
    ({ writes: persist.listAccess(requireDatabase(), request.limit ?? 200), reads: persist.listReads(requireDatabase(), request.limit ?? 200) }));

  ipcMain.handle('analysis:fields', () => mappingTable());

  ipcMain.handle('analysis:directorates', (_event, request = {}) => {
    const db = requireDatabase();
    const profile = security.getAccessProfile(db);
    const rows = persist.listDirectorates(db, request);
    const masked = maskDbRows(rows, profile);
    auditRead('analysis:directorates', {
      entity: 'directorates',
      rowCount: rows.length,
      fields: masked.masked.join(','),
      result: masked.masked.length ? 'masked' : 'ok',
    });
    return { total: persist.countDirectorates(db), rows: masked.rows, masked: masked.masked };
  });

  ipcMain.handle('analysis:directorate:get', (_event, id) => {
    const db = requireDatabase();
    const profile = security.getAccessProfile(db);
    const record = persist.getDirectorate(db, id);
    const masked = security.maskRecord(record, profile, COLUMN_BY_KEY);
    auditRead('analysis:directorate:get', {
      entity: 'directorates',
      entityId: id,
      fields: masked.masked.join(','),
      result: masked.masked.length ? 'masked' : 'ok',
    });
    const row = persist.rowFromDirectorate(masked.record);
    auditRead('analysis:directorate:get-provenance', { entity: 'directorate_sources', entityId: id, rowCount: Object.keys(row.sources ?? {}).length });
    const sources = db.prepare('SELECT field_key, value_text, source_file, source_location, data_value_id, captured_at FROM directorate_sources WHERE directorate_id = ?').all(Number(id));
    return { ...row, masked: masked.masked, sources };
  });

  ipcMain.handle('analysis:directorate:save', (_event, request = {}) => {
    const db = requireDatabase();
    const profile = security.getAccessProfile(db);
    let payload = request;
    if (profile === 'shared') {
      // Under the shared profile the edit form receives masked (null) values for
      // protected fields. Saving that form must not wipe the stored values, so
      // protected keys are dropped from the write entirely: `undefined` means
      // "leave whatever is stored", which is exactly the intent here.
      const values = { ...(request.values ?? {}) };
      for (const key of security.PROTECTED_KEYS) delete values[key];
      payload = { ...request, values };
    }
    const saved = persist.saveManualDirectorate(db, payload);
    // Any manual change invalidates the in-memory run used by exports.
    lastAnalysis = null;
    auditRead('analysis:directorate:save', {
      entity: 'directorates',
      entityId: saved.id,
      result: saved.created ? 'created' : 'updated',
      detail: profile === 'shared' ? 'protected-fields-preserved' : '',
    });
    return saved;
  });

  ipcMain.handle('analysis:directorate:delete', (_event, id) => {
    const db = requireDatabase();
    const removed = persist.deleteDirectorate(db, id);
    lastAnalysis = null;
    auditRead('analysis:directorate:delete', { entity: 'directorates', entityId: id });
    return removed;
  });

  ipcMain.handle('analysis:directorate:history', (_event, id) => {
    const versions = persist.listVersions(requireDatabase(), id, 50);
    auditRead('analysis:directorate:history', { entity: 'directorate_versions', entityId: id, rowCount: versions.length });
    return versions;
  });

  ipcMain.handle('analysis:directorate:restore', (_event, versionId) => {
    const db = requireDatabase();
    const restored = persist.restoreDirectorateVersion(db, versionId);
    lastAnalysis = null;
    auditRead('analysis:directorate:restore', { entity: 'directorate_versions', entityId: versionId, detail: `directorate=${restored.id}` });
    return restored;
  });

  // ---- OCR ----------------------------------------------------------------
  ipcMain.handle('analysis:ocr-read', async () => {
    const db = requireDatabase();
    if (ocrRunning) throw new Error('هناك قراءة OCR جارية بالفعل. انتظر انتهاءها أو ألغِها.');
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: 'اختر صورة أو PDF لقراءتها بالـOCR',
      properties: ['openFile'],
      filters: [{ name: 'صور وPDF', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'tif', 'tiff', 'pdf'] }],
    });
    if (canceled || !filePaths.length) return { canceled: true };

    ocrRunning = true;
    ocrCancelled = false;
    sendOcrProgress({ stage: 'start', message: 'جارٍ تحضير الصفحة (رمادي، تباين، تصحيح ميل)...' });
    try {
      const signal = { get aborted() { return ocrCancelled; } };
      const recognized = await recognizeEntryFile(filePaths[0], {
        signal,
        onProgress: (message) => sendOcrProgress({ stage: 'ocr', ...message }),
      });
      if (ocrCancelled) throw new Error('أُلغي التعرف الضوئي بطلب منك.');

      const parsed = recognized.parsed ?? {};
      const draft = persist.saveOcrDraft(db, { ...recognized, parsed });
      const preview = await previewDataUrl(filePaths[0]);
      const text = String(recognized.text ?? '');
      const textLimit = 50000;
      persist.logAccess(db, {
        action: 'ocr-entry',
        entity: 'file',
        entityId: filePaths[0],
        detail: `fields=${Object.keys(parsed.fields ?? {}).length};draft=${draft.draftId}`,
      });
      auditRead('analysis:ocr-read', { entity: 'ocr_drafts', entityId: draft.draftId, rowCount: draft.fields });
      return {
        canceled: false,
        draftId: draft.draftId,
        fileName: recognized.fileName,
        fileType: recognized.fileType,
        fileSize: recognized.fileSize,
        confidence: recognized.confidence,
        pages: recognized.pages,
        pagesRead: recognized.pagesRead ?? recognized.pages,
        truncated: Boolean(recognized.truncated || parsed.truncated),
        warnings: recognized.warnings ?? [],
        preprocessing: recognized.preprocessing ?? null,
        preview,
        text: text.slice(0, textLimit),
        textTruncated: text.length > textLimit,
        parsed: {
          fields: parsed.fields ?? {},
          unmatched: parsed.unmatched ?? [],
          warnings: parsed.warnings ?? [],
          crossField: parsed.crossField ?? [],
          summary: parsed.summary ?? null,
        },
      };
    } finally {
      ocrRunning = false;
      sendOcrProgress({ stage: 'done', message: '' });
    }
  });

  ipcMain.handle('analysis:ocr-cancel', async () => {
    ocrCancelled = true;
    await ocr.cancelRecognition();
    auditRead('analysis:ocr-cancel', { entity: 'ocr_drafts', result: 'cancelled' });
    return { success: true };
  });

  ipcMain.handle('analysis:ocr-decision', (_event, request = {}) => {
    const result = persist.recordOcrDecision(requireDatabase(), request);
    auditRead('analysis:ocr-decision', { entity: 'ocr_field_confidence', entityId: request.draftId, result: request.decision, detail: request.fieldKey });
    return result;
  });

  ipcMain.handle('analysis:ocr-drafts', (_event, request = {}) => persist.listOcrDrafts(requireDatabase(), request.limit ?? 50));

  ipcMain.handle('analysis:ocr-draft', (_event, id) => persist.getOcrDraft(requireDatabase(), id));

  // ---- Exports ------------------------------------------------------------
  ipcMain.handle('analysis:export-excel', async () => {
    const db = requireDatabase();
    const profile = security.getAccessProfile(db);
    const source = lastAnalysis ?? rebuildAnalysis(db);
    const analysis = profile === 'shared' ? { ...source, rows: maskEngineRows(source.rows ?? [], profile).rows } : source;
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: 'تصدير نتائج التحليل',
      defaultPath: `تحليل-التنمية-${new Date().toISOString().slice(0, 10)}.xlsx`,
      filters: [{ name: 'Excel', extensions: ['xlsx'] }],
    });
    if (canceled || !filePath) return { canceled: true };
    await exportAnalysisWorkbook(filePath, analysis, {
      audit: persist.listAccess(db, 500),
      accessProfile: profile,
      protectedFields: security.protectedKeysForExport(profile),
    });
    persist.logAccess(db, { action: 'export-excel', entity: 'file', entityId: filePath, detail: `profile=${profile}` });
    auditRead('analysis:export-excel', { entity: 'file', entityId: filePath, result: profile === 'shared' ? 'masked' : 'ok' });
    return { canceled: false, filePath };
  });

  ipcMain.handle('analysis:export-pdf', async () => {
    const db = requireDatabase();
    const profile = security.getAccessProfile(db);
    const source = lastAnalysis ?? rebuildAnalysis(db);
    const analysis = profile === 'shared' ? { ...source, rows: maskEngineRows(source.rows ?? [], profile).rows } : source;
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: 'تصدير التقرير',
      defaultPath: `تقرير-التنمية-${new Date().toISOString().slice(0, 10)}.pdf`,
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (canceled || !filePath) return { canceled: true };
    const result = await exportAnalysisPdf({ BrowserWindow }, filePath, analysis, {
      audit: persist.listAccess(db, 100),
      accessProfile: profile,
    });
    persist.logAccess(db, { action: 'export-pdf', entity: 'file', entityId: filePath, detail: `profile=${profile}` });
    auditRead('analysis:export-pdf', { entity: 'file', entityId: filePath, result: profile === 'shared' ? 'masked' : 'ok' });
    return { canceled: false, ...result };
  });

  ipcMain.handle('data:export', async () => {
    const db = requireDatabase();
    const profile = security.getAccessProfile(db);
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
    let rows = db.prepare('SELECT governorate,district,subdistrict,settlement,record_type,record_id,field_name,value_text,source_file,source_location,imported_at FROM data_values ORDER BY governorate,district,subdistrict,settlement,record_type,record_id,field_name').all();
    let hiddenCount = 0;
    if (profile === 'shared') {
      rows = rows.filter((row) => {
        const match = matchHeader(row.field_name);
        const hidden = Boolean(match?.key && security.PROTECTED_KEYS.includes(match.key));
        if (hidden) hiddenCount += 1;
        return !hidden;
      });
      sheet.addRow(['— ملاحظة —', `وضع المشاركة: حُجبت ${hiddenCount} قيمة مقيّدة/حساسة من هذا الملف.`]);
    }
    sheet.addRows(rows);
    await workbook.xlsx.writeFile(filePath);
    persist.logAccess(db, { action: 'data-export', entity: 'file', entityId: filePath, detail: `profile=${profile};rows=${rows.length};hidden=${hiddenCount}` });
    auditRead('data:export', { entity: 'file', entityId: filePath, rowCount: rows.length, result: profile === 'shared' ? 'masked' : 'ok', detail: `hidden=${hiddenCount}` });
    return { canceled: false, filePath, hiddenCount };
  });
}

/** Re-run the analysis from the database when nothing is cached in memory. */
function rebuildAnalysis(database) {
  const rows = persist.loadAnalysisRows(database, {});
  if (!rows.length) throw new Error('لا توجد مديريات في قاعدة البيانات. استورد ملف القالب أولًا.');
  // Reproduce the calibration that produced the last persisted run instead of
  // silently falling back to defaults after a restart.
  const calibration = persist.getLastCalibration(database) ?? {};
  const analysis = analyze(rows, {
    weights: calibration.weights ?? persist.getWeights(database)?.weights ?? undefined,
    kThreshold: calibration.kThreshold ?? undefined,
    deprivationLine: calibration.deprivationLine ?? undefined,
  });
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
    // A packaged build has no menu: the default menu exposes DevTools and file
    // dialogs that bypass the field policy.
    if (app.isPackaged) Menu.setApplicationMenu(null);
    registerHandlers();
    createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });
}

app.on('before-quit', () => {
  if (database) database.close();
  database = undefined;
  ocr.disposeWorker().catch(() => {});
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });