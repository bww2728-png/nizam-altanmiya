const { app, BrowserWindow, dialog, ipcMain, Menu, net, session } = require('electron');
const { installOfflineNetworkGuards, installOfflineSessionGuard } = require('./offline-policy.cjs');
installOfflineNetworkGuards({ electronNet: net });
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  openEncryptedStore,
  loadOrCreateStoreKey,
  classifyStore,
  findLegacyBackups,
  quarantineLegacyDatabase,
  backupStore,
  copyStoreKey,
  restoreBackupBundle,
  listBackups,
} = require('./store.cjs');
const security = require('./security.cjs');
const { analyze } = require('./analysis/engine.cjs');
const { readDirectorateWorkbook } = require('./analysis/template-reader.cjs');
const canonicalData = require('./analysis/canonical-data.cjs');
const { mappingTable } = require('./analysis/mapping.cjs');
const { defaultWeights, validateWeights } = require('./analysis/composite.cjs');
const persist = require('./analysis/persist.cjs');
const { serializeAnalysis } = require('./analysis/serialize.cjs');
const { exportAnalysisWorkbook } = require('./analysis/exporter.cjs');
const { exportAnalysisPdf, exportDatabaseReportPdf, exportIndicatorsReportPdf } = require('./analysis/pdf.cjs');
const { INPUT_FIELDS } = require('./analysis/schema.cjs');
const { DIRECTORATE_COLUMNS } = require('./analysis/store-schema.cjs');
const { buildImportPlan, summarizePlan, applyImportPlan } = require('./analysis/import-plan.cjs');
const { buildSheets, buildRanking } = require('./analysis/sheets.cjs');
const { inspectXlsxPackage } = require('./analysis/xlsx-preflight.cjs');

let mainWindow;
let database;
/** Workbook read and turned into a plan, but not yet applied to the database. */
let pendingPlan = null;
/** Last analysis held in memory so exports never recompute silently. */
let lastAnalysis = null;
/** Cached sheet payloads: recomputed after any write that can change a number. */
let sheetsCache = null;
/** Identifier written into every read-audit row for this unlocked session. */
let sessionId = crypto.randomUUID();
/** Canonical path of the last workbook the main process returned from a file dialog. */
let dialogSelectedPath = null;

const COLUMN_BY_KEY = DIRECTORATE_COLUMNS;

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

/** Drop the cached sheet payloads after any write that can change a number. */
function invalidateSheets() {
  sheetsCache = null;
  lastAnalysis = null;
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

/**
 * Re-derive the analysis from protected-stripped rows so a shared export cannot
 * leak restricted values through derived fields (indicators, project label,
 * composites). Stripping the keys first makes every row equally "missing" them,
 * so nothing distinguishes an empty protected cell from a filled one.
 */
function analyzeShared(database, source) {
  const calibration = persist.getLastCalibration(database) ?? {};
  const rows = security.maskInputRows(source?.rows ?? [], 'shared');
  return analyze(rows, {
    weights: calibration.weights ?? persist.getWeights(database)?.weights ?? undefined,
    kThreshold: calibration.kThreshold ?? undefined,
    deprivationLine: calibration.deprivationLine ?? undefined,
  });
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
  // Inspect ZIP central-directory metadata before ExcelJS loads any workbook
  // XML or inflates entries. This rejects corrupt and decompression-bomb-like
  // packages while keeping extraction entirely in memory/local parsing.
  inspectXlsxPackage(filePath);
  return filePath;
}

/** Push a progress line to the window that started the operation. Never throws. */
function sendImportProgress(sender, payload) {
  try {
    if (!sender || sender.isDestroyed()) return;
    sender.send('import:progress', payload);
  } catch {
    /* progress is advisory: a closed window must never fail the import */
  }
}

/** Canonical form of a path, or null when the file cannot be resolved. */
function safeRealpath(filePath) {
  try {
    return fs.realpathSync(String(filePath));
  } catch {
    return null;
  }
}

/** Windows paths compare case-insensitively. */
function comparePath(value) {
  const text = String(value);
  return process.platform === 'win32' ? text.toLowerCase() : text;
}

/** True when `candidate` is `root` itself or lives below it. */
function isInsideRoot(candidate, root) {
  const target = comparePath(candidate);
  const base = comparePath(root);
  return target === base || target.startsWith(base.endsWith(path.sep) ? base : `${base}${path.sep}`);
}

/**
 * Prove a template path is inside a trusted root before anything opens it.
 *
 * `realpathSync` collapses `..` and symbolic links first, so a path that merely
 * looks like it lives under the data directory cannot be used to reach a file
 * elsewhere. The only trusted roots are the application's own userData
 * directory and the exact path the main process returned from the open dialog.
 */
function assertAllowedTemplatePath(filePath) {
  const resolved = safeRealpath(filePath);
  if (!resolved) throw new Error('تعذّر الوصول إلى ملف القالب في المسار المحدد.');
  const userDataRoot = safeRealpath(app.getPath('userData')) ?? path.resolve(app.getPath('userData'));
  const allowed = isInsideRoot(resolved, userDataRoot)
    || (dialogSelectedPath ? comparePath(resolved) === comparePath(dialogSelectedPath) : false);
  if (!allowed) {
    throw new Error('مسار الملف غير مسموح. اختر ملف القالب من نافذة الاختيار التي يفتحها التطبيق.');
  }
  return resolved;
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

// ---- Offline runtime policy -------------------------------------------------
// The installed application must remain usable without network access.
// Updates are distributed as administrator-provided local installer packages.
const { offlineUpdateStatus } = require('./offline-policy.cjs');

/**
 * The application window.
 *
 * DevTools and the default menu are disabled in a packaged build: the renderer
 * can reach every channel through `window.localApp`, so leaving them available
 * would turn the app into a full data reader for anyone at the keyboard.
 */
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 980,
    minWidth: 1060,
    minHeight: 720,
    backgroundColor: '#0b1322',
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
    // Compare origins, not raw prefixes: `http://127.0.0.1:5173@evil.com/`
    // starts with the dev URL but the browser resolves it to evil.com.
    let allowedOrigin = null;
    try { allowedOrigin = devServerURL ? new URL(devServerURL).origin : null; } catch { allowedOrigin = null; }
    let targetOrigin = null;
    try { targetOrigin = new URL(url).origin; } catch { targetOrigin = null; }
    if (!allowedOrigin || targetOrigin !== allowedOrigin) event.preventDefault();
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
        try { backup = backupStore(filePath, { keyPath }); } catch { /* the move below still protects the user */ }
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
    pendingPlan = null;
    invalidateSheets();
    return { success: true };
  });

  function createConsistentBackup(db) {
    // SQLCipher's backup API rejects a plain target database created by the
    // default backup helper. Flush WAL first, then copy the encrypted database,
    // any remaining sidecars and its companion key as a single bundle. The
    // synchronous copy runs on the main-process event loop, so no IPC write can
    // interleave between checkpoint and file copies.
    const checkpointRows = db.pragma('wal_checkpoint(TRUNCATE)');
    const checkpoint = Array.isArray(checkpointRows) ? checkpointRows[0] : checkpointRows;
    if (checkpoint && Number(checkpoint.busy ?? 0) > 0) {
      throw new Error('تعذّر أخذ لقطة متسقة لقاعدة البيانات؛ توجد عملية قراءة تمنع إتمام WAL checkpoint. أعد المحاولة بعد انتهاء القراءة.');
    }

    const target = backupStore(getDatabasePath(), { keyPath: getStoreKeyPath() });
    if (!target) throw new Error('تعذّر إنشاء النسخة الاحتياطية لأن ملف قاعدة البيانات غير موجود.');

    const key = fs.readFileSync(target + '.key', 'utf8').trim();
    const verdict = classifyStore(target, key);
    if (!verdict.ok) {
      for (const suffix of ['', '.key', '-wal', '-shm', '-journal']) {
        try { fs.rmSync(target + suffix, { force: true }); } catch { /* best effort cleanup */ }
      }
      throw new Error('أُنشئت ملفات النسخة لكن فشل التحقق من قابليتها للفتح؛ أزيلت النسخة غير الموثوقة. السبب: ' + verdict.reason);
    }
    return target;
  }

  ipcMain.handle('db:backup', async () => {
    const db = requireDatabase();
    if (currentProfile() !== 'owner') throw new Error('إنشاء نسخة كاملة من قاعدة البيانات يتطلب وضع المالك؛ فقد تتضمن النسخة حقولًا مقيّدة.');
    const target = await createConsistentBackup(db);
    persist.logAccess(db, { action: 'store-backup', entity: 'store', entityId: target });
    auditRead('db:backup', { entity: 'store', entityId: target });
    return { filePath: target, backups: listBackups(getDatabasePath()).length };
  });

  ipcMain.handle('db:restore', async () => {
    requireDatabase();
    if (currentProfile() !== 'owner') throw new Error('استعادة قاعدة البيانات تتطلب وضع المالك.');
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: 'اختر النسخة الاحتياطية المراد استعادتها',
      properties: ['openFile'],
      filters: [{ name: 'نسخ قاعدة البيانات الاحتياطية', extensions: ['bak'] }],
    });
    if (canceled || !filePaths.length) return { canceled: true };

    // Keep the selected path itself so restoreBackupBundle can reject a symlink
    // with lstat instead of silently following it to another file.
    const selected = path.resolve(filePaths[0]);
    const databasePath = getDatabasePath();
    const keyPath = getStoreKeyPath();
    let safetyBackup = null;

    if (database) safetyBackup = await createConsistentBackup(database);
    else if (fs.existsSync(databasePath)) safetyBackup = backupStore(databasePath, { keyPath });

    if (database) database.close();
    database = undefined;
    pendingPlan = null;
    invalidateSheets();

    try {
      const restored = restoreBackupBundle(selected, databasePath, keyPath);
      database = openDatabase();
      sessionId = crypto.randomUUID();
      auditRead('db:restore', { entity: 'store', entityId: selected, result: 'ok', detail: 'safetyBackup=' + Boolean(safetyBackup) });
      return { canceled: false, restored: true, safetyBackup, filePath: restored.restoredPath };
    } catch (error) {
      // Restore the safety snapshot even if the file swap succeeded but opening
      // the replacement store failed during schema migration or initialization.
      try {
        if (!database && safetyBackup && fs.existsSync(safetyBackup) && fs.existsSync(safetyBackup + '.key')) {
          restoreBackupBundle(safetyBackup, databasePath, keyPath);
        }
        if (!database && fs.existsSync(databasePath) && fs.existsSync(keyPath)) {
          database = openDatabase();
          sessionId = crypto.randomUUID();
        }
      } catch (recoveryError) {
        throw new Error(error.message + ' تعذّر فتح النسخة المستعادة؛ كما تعذّر إكمال الاسترجاع التلقائي لنسخة الأمان: ' + recoveryError.message);
      }
      throw error;
    }
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








  // ---- Excel import: scan -> plan -> apply ---------------------------------
  // The workbook is the only entry point: it is read and turned into an explicit
  // plan first, so nothing reaches the database before a human has seen what the
  // plan intends to do with each row.
  ipcMain.handle('import:scan', async (event, request = {}) => {
    let filePath = request.filePath;
    if (!filePath) {
      sendImportProgress(event.sender, { phase: 'dialog', message: 'جارٍ فتح نافذة اختيار الملف...' });
      const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
        title: 'اختر ملف Excel المراد فحصه وحفظه للمراجعة',
        properties: ['openFile'],
        filters: [{ name: 'ملفات Excel', extensions: ['xlsx', 'xlsm'] }],
      });
      if (canceled || !filePaths.length) return { canceled: true };
      filePath = filePaths[0];
      // The dialog is the trust boundary: this exact path is the one exception to
      // the userData allowlist below.
      dialogSelectedPath = safeRealpath(filePath) ?? filePath;
    }
    filePath = assertAllowedTemplatePath(assertTemplatePath(filePath));
    sendImportProgress(event.sender, { phase: 'reading', message: 'جارٍ قراءة الملف...' });
    const db = requireDatabase();
    let read;
    let directorateReadError = null;
    try {
      read = await readDirectorateWorkbook(filePath);
    } catch (error) {
      // A workbook can contain projects, sector datasets or source registers
      // without a directorate table. It still belongs in the durable review
      // inbox; it simply must not be coerced into a directorate record.
      directorateReadError = String(error?.message ?? 'لم يُكتشف جدول مديريات.');
      read = {
        fileName: path.basename(filePath),
        sheetName: null,
        rows: [],
        warnings: [{ row: null, code: 'no-directorate-table', message: directorateReadError }],
      };
    }
    sendImportProgress(event.sender, { phase: 'staging', message: 'جارٍ حفظ الملف الأصلي وجميع الأوراق والخلايا والصور القابلة للاستخراج في منطقة مراجعة محلية مشفّرة...' });
    const staging = await canonicalData.stageWorkbook(db, filePath, read.workbook ?? null);
    if (Object.prototype.hasOwnProperty.call(read, 'workbook')) delete read.workbook;
    sendImportProgress(event.sender, { phase: 'plan', message: `حُفظت ${staging.sheetCount} ورقة في منطقة الاستقبال؛ جارٍ إعداد خطة المديريات إن وُجدت...` });
    const plan = buildImportPlan(db, read, { fileName: read.fileName, sheetName: read.sheetName });
    pendingPlan = { filePath, read, plan, staging };
    persist.logAccess(db, {
      action: 'excel-scan',
      entity: 'workbook',
      entityId: filePath,
      detail: `batch=${staging.batchId};sheets=${staging.sheetCount};rows=${staging.rowCount};cells=${staging.cellCount};directorateRows=${plan.totalRows}`,
    });
    auditRead('import:scan', { entity: 'workbook', entityId: filePath, rowCount: staging.rowCount, detail: `batch=${staging.batchId}` });
    sendImportProgress(event.sender, { phase: 'done', message: directorateReadError
      ? 'حُفظ الملف للمراجعة؛ لم يُكتشف جدول مديريات قابل للاستيراد المباشر.'
      : `الخطة جاهزة: ${plan.totalRows} صف مديريات، وحُفظت بنية الملف كاملةً في المراجعة.` });
    return {
      canceled: false,
      filePath,
      ...security.redactPlanSummary(summarizePlan(plan), currentProfile()),
      staging,
      stagingOnly: Boolean(directorateReadError),
      stagingMessage: directorateReadError,
    };
  });

  ipcMain.handle('import:plan', () => {
    if (!pendingPlan) throw new Error('لم يُقرأ أي ملف بعد. اختر ملف القالب أولًا.');
    auditRead('import:plan', { entity: 'workbook', entityId: pendingPlan.filePath, rowCount: pendingPlan.plan.totalRows });
    return security.redactPlanSummary(summarizePlan(pendingPlan.plan, 5000), currentProfile());
  });

  ipcMain.handle('import:history', (_event, request = {}) => {
    const db = requireDatabase();
    const history = canonicalData.listWorkbookImports(db, request.limit ?? 30);
    auditRead('import:history', { entity: 'workbook_import_batches', rowCount: history.length });
    return history;
  });

  ipcMain.handle('import:sheet-preview', (_event, request = {}) => {
    if (currentProfile() !== 'owner') {
      return { restricted: true, message: 'عرض القيم الخام متاح في وضع المالك فقط؛ وضع المشاركة لا يكشف بيانات ملفات غير مصنفة.' };
    }
    const db = requireDatabase();
    const preview = canonicalData.readWorkbookSheetPreview(db, request.batchId, request.sheetId, request.limit ?? 20);
    auditRead('import:sheet-preview', { entity: 'workbook_import_sheet', entityId: preview.sheet.id, rowCount: preview.rows.length });
    return preview;
  });

  ipcMain.handle('projects:list', (_event, request = {}) => {
    if (currentProfile() !== 'owner') {
      return { restricted: true, message: 'سجل المشاريع والتكاليف والمصادر متاح في وضع المالك فقط.' };
    }
    const db = requireDatabase();
    const result = canonicalData.listCanonicalProjects(db, request);
    auditRead('projects:list', {
      entity: 'projects',
      rowCount: result.rows.length,
      detail: 'offset=' + result.offset + ';limit=' + result.limit + ';search=' + String(request.search ?? '').slice(0, 80),
    });
    return result;
  });

  ipcMain.handle('projects:get', (_event, projectId) => {
    if (currentProfile() !== 'owner') throw new Error('تفاصيل المشروع المالية والمصدرية متاحة في وضع المالك فقط.');
    const db = requireDatabase();
    const result = canonicalData.getCanonicalProject(db, projectId);
    auditRead('projects:get', {
      entity: 'projects',
      entityId: result.project.id,
      rowCount: result.funding.length,
      detail: 'funding=' + result.funding.length + ';issues=' + result.issues.length,
    });
    return result;
  });

  ipcMain.handle('projects:references', () => {
    if (currentProfile() !== 'owner') throw new Error('مراجع المشاريع متاحة في وضع المالك فقط.');
    return canonicalData.listCanonicalReferences(requireDatabase());
  });

  ipcMain.handle('observations:list', (_event, request = {}) => {
    if (currentProfile() !== 'owner') return { restricted: true, message: 'سجل القياسات المعيارية متاح في وضع المالك فقط.' };
    const result = canonicalData.listIndicatorObservations(requireDatabase(),request);
    auditRead('observations:list',{ entity:'indicator_observations',rowCount:result.rows.length,detail:'offset='+result.offset+';limit='+result.limit });
    return result;
  });

  ipcMain.handle('observations:save', (_event, request = {}) => {
    if (currentProfile() !== 'owner') throw new Error('إدخال قياسات المؤشرات يتطلب وضع المالك.');
    const result = canonicalData.saveIndicatorObservation(requireDatabase(),request);
    auditRead('observations:save',{ entity:'indicator_observations',entityId:result.id,result:result.action });
    return result;
  });

  ipcMain.handle('quality:list', (_event, request = {}) => {
    if (currentProfile() !== 'owner') return { restricted: true, message: 'سجل جودة البيانات متاح في وضع المالك فقط.' };
    const result = canonicalData.listDataQualityIssues(requireDatabase(),request);
    auditRead('quality:list',{ entity:'data_quality_issues',rowCount:result.rows.length,detail:'status='+String(request.status ?? 'open') });
    return result;
  });

  ipcMain.handle('quality:resolve', (_event, request = {}) => {
    if (currentProfile() !== 'owner') throw new Error('تسوية ملاحظات الجودة تتطلب وضع المالك.');
    const result = canonicalData.resolveDataQualityIssue(requireDatabase(),request.issueId,request.resolution);
    auditRead('quality:resolve',{ entity:'data_quality_issues',entityId:result.id,result:'resolved' });
    return result;
  });

  ipcMain.handle('projects:save', (_event, request = {}) => {
    if (currentProfile() !== 'owner') throw new Error('إنشاء أو تعديل المشاريع يتطلب وضع المالك.');
    const db = requireDatabase();
    const result = canonicalData.saveCanonicalProject(db, request);
    invalidateSheets();
    auditRead('projects:save', { entity: 'projects', entityId: result.id, result: result.action });
    return result;
  });

  ipcMain.handle('projects:add-funding', (_event, request = {}) => {
    if (currentProfile() !== 'owner') throw new Error('إضافة التمويل تتطلب وضع المالك.');
    const db = requireDatabase();
    const result = canonicalData.addProjectFunding(db, request.projectId, request);
    auditRead('projects:add-funding', { entity: 'project_funding', entityId: result.id, result: 'created', detail: 'project=' + result.projectId });
    return result;
  });

  ipcMain.handle('projects:resolve-quality', (_event, request = {}) => {
    if (currentProfile() !== 'owner') throw new Error('تسوية ملاحظات الجودة تتطلب وضع المالك.');
    const db = requireDatabase();
    const result = canonicalData.resolveProjectQualityIssue(db, request.projectId, request.issueId, request.resolution);
    auditRead('projects:resolve-quality', { entity: 'data_quality_issues', entityId: result.issueId, result: 'resolved', detail: 'project=' + result.projectId });
    return result;
  });

  ipcMain.handle('projects:add-attachment', async (_event, projectId) => {
    if (currentProfile() !== 'owner') throw new Error('إرفاق الملفات يتطلب وضع المالك.');
    const db = requireDatabase();
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: 'اختر مرفقًا للمشروع',
      properties: ['openFile'],
      filters: [{ name: 'صور أو مستندات', extensions: ['pdf', 'png', 'jpg', 'jpeg', 'webp'] }],
    });
    if (canceled || !filePaths.length) return { canceled: true };
    const selected = path.resolve(filePaths[0]);
    const stats = fs.lstatSync(selected);
    if (!stats.isFile() || stats.isSymbolicLink()) throw new Error('المرفق المحدد ليس ملفًا عاديًا.');
    if (stats.size <= 0 || stats.size > canonicalData.LIMITS.mediaItemBytes) throw new Error('حجم المرفق يجب أن يكون بين بايت واحد و20 ميغابايت.');
    const content = fs.readFileSync(selected);
    const result = canonicalData.addProjectAttachment(db, projectId, { originalName: path.basename(selected), content });
    auditRead('projects:add-attachment', { entity: 'managed_attachments', entityId: result.id, result: 'created', detail: 'project=' + result.projectId });
    return { canceled: false, ...result };
  });

  ipcMain.handle('projects:export-attachment', async (_event, request = {}) => {
    if (currentProfile() !== 'owner') throw new Error('تصدير المرفقات يتطلب وضع المالك.');
    const attachment = canonicalData.getProjectAttachment(requireDatabase(),request.projectId,request.attachmentId);
    const extension = String(attachment.extension ?? '').replace(/^\./,'').toLowerCase();
    if (!['pdf','png','jpg','jpeg','webp'].includes(extension)) throw new Error('امتداد المرفق المحفوظ غير مدعوم للتصدير.');
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: 'حفظ نسخة من المرفق',
      defaultPath: attachment.original_name,
      filters: [{ name: 'مرفق محفوظ', extensions: [extension] }],
    });
    if (canceled || !filePath) return { canceled: true };
    const target = path.resolve(filePath);
    try {
      const stats = fs.lstatSync(target);
      if (stats.isSymbolicLink() || stats.isDirectory()) throw new Error('مسار التصدير يجب أن يكون ملفًا عاديًا.');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await fs.promises.writeFile(target,attachment.content,{ mode: 0o600 });
    auditRead('projects:export-attachment',{ entity:'managed_attachments',entityId:attachment.id,result:'exported',detail:'project='+request.projectId+';sha256='+attachment.sha256 });
    return { canceled:false,filePath:target,originalName:attachment.original_name,sizeBytes:attachment.size_bytes };
  });

  ipcMain.handle('import:regions', (_event, request = {}) => {
    if (currentProfile() !== 'owner') {
      return { restricted: true, message: 'مراجعة وربط الجداول غير المصنفة متاحان في وضع المالك فقط.' };
    }
    const db = requireDatabase();
    const result = canonicalData.listWorkbookImportRegions(db, request.batchId);
    auditRead('import:regions', { entity: 'workbook_import_regions', rowCount: result.regions.length, detail: 'batch=' + result.batch.id });
    return result;
  });

  ipcMain.handle('import:region-preview', (_event, request = {}) => {
    if (currentProfile() !== 'owner') {
      return { restricted: true, message: 'عرض الصفوف الخام متاح في وضع المالك فقط.' };
    }
    const db = requireDatabase();
    const result = canonicalData.readWorkbookImportRegion(
      db, request.batchId, request.regionId, request.offset ?? 0, request.limit ?? 30
    );
    auditRead('import:region-preview', {
      entity: 'workbook_import_region', entityId: result.regionId,
      rowCount: result.rows.length, detail: 'batch=' + result.batchId + ';offset=' + result.offset,
    });
    return result;
  });

  ipcMain.handle('import:promote-projects', (_event, request = {}) => {
    if (currentProfile() !== 'owner') throw new Error('اعتماد المشاريع يتطلب وضع المالك.');
    const db = requireDatabase();
    const result = canonicalData.promoteProjectRegion(db, request);
    invalidateSheets();
    auditRead('import:promote-projects', {
      entity: 'projects', rowCount: result.applied.length,
      result: result.refused.length ? 'partial' : 'ok',
      detail: 'batch=' + request.batchId + ';region=' + request.regionId + ';refused=' + result.refused.length,
    });
    return result;
  });

  ipcMain.handle('import:promote-indicators', (_event, request = {}) => {
    if (currentProfile() !== 'owner') throw new Error('اعتماد المؤشرات يتطلب وضع المالك.');
    const db = requireDatabase();
    const result = canonicalData.promoteIndicatorRegion(db, request);
    invalidateSheets();
    auditRead('import:promote-indicators', {
      entity: 'indicator_observations', rowCount: result.applied.length,
      result: result.refused.length ? 'partial' : 'ok',
      detail: 'batch=' + request.batchId + ';region=' + request.regionId + ';refused=' + result.refused.length,
    });
    return result;
  });

  ipcMain.handle('import:apply', (event, request = {}) => {
    const db = requireDatabase();
    if (!pendingPlan) throw new Error('لا توجد خطة استيراد جاهزة. اختر ملف القالب أولًا.');
    const total = pendingPlan.plan.rows?.length ?? 0;
    // The whole apply is a single database transaction, so the main process
    // cannot interleave messages between individual rows; the progress line
    // marks the start and end of that transaction instead of faking per-row
    // ticks that would only be delivered after it finished anyway.
    sendImportProgress(event.sender, { phase: 'apply', current: 0, total, message: `جارٍ تطبيق الخطة على ${total} صفًا...` });
    const result = pendingPlan.plan.rows?.length
      ? applyImportPlan(db, pendingPlan.plan, { decisions: request.decisions, force: request.force })
      : { applied: 0, created: 0, updated: 0, refused: [], skipped: [], total: 0 };
    const stagingCompletion = canonicalData.completeWorkbookImport(db, pendingPlan.staging.batchId, result);
    invalidateSheets();
    auditRead('import:apply', {
      entity: 'directorates',
      entityId: pendingPlan.filePath,
      rowCount: result.applied,
      result: result.refused.length ? 'partial' : 'ok',
      detail: `created=${result.created};updated=${result.updated};refused=${result.refused.length};skipped=${result.skipped.length}`,
    });
    sendImportProgress(event.sender, {
      phase: 'done',
      current: result.applied,
      total,
      message: `اكتمل الاستيراد: ${result.created} إضافة، ${result.updated} تحديث، ${result.refused.length} محجوب.`,
    });
    return {
      ...result,
      fileName: pendingPlan.plan.fileName,
      sheetName: pendingPlan.plan.sheetName,
      stagingStatus: stagingCompletion.status,
    };
  });

  // ---- The five workbook sheets, rendered from stored data ------------------
  // One engine pass, cached per access profile: the dashboard and the indicators
  // do not depend on the ranking mode, so `mode` is not part of the cache key and
  // switching it only rebuilds the ranking.
  function sheetPayloads(mode = 'calibrated') {
    const profile = currentProfile();
    if (!sheetsCache || sheetsCache.profile !== profile) {
      // `maskInputRows` strips the protected keys from `values`, `rawValues` and
      // `sources`, and drops the parse `warnings` that carry a protected raw
      // value. The previous ad-hoc transform removed only `values` keys, so the
      // cached `analysis` (and anything spread from it) still carried protected
      // raw text. Only applied under `shared`, matching `analyzeShared`.
      const transformRows = profile === 'shared'
        ? (rows) => security.maskInputRows(rows, 'shared')
        : null;
      // The sheets never render the sensitivity study: the engine pass behind them
      // runs without it so opening a sheet does not pay for an unused analysis.
      const payload = buildSheets(requireDatabase(), { transformRows, mode: 'calibrated', sensitivity: false });
      sheetsCache = { profile, payload, rankings: { calibrated: payload.ranking } };
    }
    if (!sheetsCache.rankings[mode]) {
      sheetsCache.rankings[mode] = buildRanking(sheetsCache.payload.analysis, {
        mode,
        calibration: sheetsCache.payload.ranking?.calibration ?? null,
      });
    }
    return { ...sheetsCache.payload, ranking: sheetsCache.rankings[mode] };
  }

  ipcMain.handle('sheet:dashboard', () => {
    const payload = sheetPayloads();
    auditRead('sheet:dashboard', { entity: 'directorates', rowCount: payload.dashboard.totals.directorates });
    return { ...payload.dashboard, generatedAt: payload.generatedAt, profile: currentProfile() };
  });

  ipcMain.handle('sheet:indicators', () => {
    const payload = sheetPayloads();
    auditRead('sheet:indicators', { entity: 'directorates', rowCount: payload.indicators.rows.length });
    return payload.indicators;
  });

  ipcMain.handle('sheet:ranking', (_event, request = {}) => {
    const mode = request.mode === 'replica' ? 'replica' : 'calibrated';
    const payload = sheetPayloads(mode);
    auditRead('sheet:ranking', {
      entity: 'directorates',
      rowCount: payload.ranking.ranked.length,
      detail: `mode=${mode};waiting=${payload.ranking.excluded.waiting};anomalies=${payload.ranking.excluded.anomalies}`,
    });
    return payload.ranking;
  });

  ipcMain.handle('analysis:run', (_event, request = {}) => {
    const db = requireDatabase();
    validateCalibration(request.kThreshold, request.deprivationLine);
    const rows = persist.loadAnalysisRows(db, request.filter ?? {});
    if (!rows.length) throw new Error('لا توجد مديريات في قاعدة البيانات. استورد ملف «القالب المحدث» أولًا.');
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
      templateFile: pendingPlan?.plan?.fileName ?? analysis.meta?.template?.fileName ?? null,
      templateSheet: pendingPlan?.plan?.sheetName ?? analysis.meta?.template?.sheet ?? null,
      mode: 'both',
    });
    // A new run makes every cached sheet number stale. Invalidated before the
    // fresh analysis is stored in memory, because the cache reset also drops
    // `lastAnalysis` (which exports read).
    invalidateSheets();
    lastAnalysis = analysis;
    const profile = security.getAccessProfile(db);
    // Under `shared`, the IPC reply must not carry indicators, the project label,
    // completeness or the composites: every one is derived from a protected
    // value. Re-deriving from protected-stripped rows makes the two profiles see
    // the same report instead of masking a finished result.
    const visible = profile === 'shared' ? analyzeShared(db, analysis) : analysis;
    auditRead('analysis:run', {
      entity: 'analysis_runs',
      entityId: saved?.runId ?? null,
      rowCount: analysis.rows?.length ?? 0,
      result: profile === 'shared' ? 'masked' : 'ok',
    });
    // Compact payload: per-row `values`/`rawValues` stay in the main process and
    // are fetched on demand by `analysis:row-detail`. At 20k rows that is the
    // difference between ~190 MB and a few MB per run.
    return { analysis: serializeAnalysis(visible, { compact: true }), runId: saved?.runId ?? null };
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
    // Indicators and sensitivity are derived from the protected values, so under
    // `shared` they are withheld alongside the values themselves; warnings that
    // name a protected field are dropped too.
    const shared = profile === 'shared';
    return {
      index,
      values: masked.row.values ?? {},
      rawValues: masked.row.rawValues ?? {},
      warnings: security.redactWarnings(row.warnings ?? [], profile),
      indicators: shared ? {} : (row.indicators ?? {}),
      sensitivity: shared ? null : (row.sensitivity ?? null),
      masked: masked.masked,
    };
  });

  ipcMain.handle('analysis:latest', () => {
    const db = requireDatabase();
    auditRead('analysis:latest', { entity: 'analysis_runs' });
    return security.maskStoredRun(persist.getLatestRun(db), currentProfile());
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
    invalidateSheets();
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
    // Belt and braces: `maskRecord` already filters the stored `import_warnings`
    // column, but a warning carries the rejected raw text, so the array is
    // re-filtered here in case the row is built from any other source.
    row.warnings = security.redactWarnings(row.warnings ?? [], profile);
    auditRead('analysis:directorate:get-provenance', { entity: 'directorate_sources', entityId: id, rowCount: Object.keys(row.sources ?? {}).length });
    const sourceRows = db.prepare('SELECT field_key, value_text, source_file, source_location, data_value_id, captured_at FROM directorate_sources WHERE directorate_id = ?').all(Number(id));
    // `value_text` is the raw cell text behind a field. The record above is already
    // masked under the shared profile, so the provenance rows must be redacted on
    // the same keys or the masked value would simply leak through this channel.
    // The source file and location stay: they carry no field value.
    const sources = profile === 'shared'
      ? sourceRows.map((source) => (security.isProtected(source.field_key, profile) ? { ...source, value_text: null } : source))
      : sourceRows;
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
    // Any manual change invalidates the in-memory run used by exports and the
    // cached sheet numbers.
    invalidateSheets();
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
    invalidateSheets();
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
    invalidateSheets();
    auditRead('analysis:directorate:restore', { entity: 'directorate_versions', entityId: versionId, detail: `directorate=${restored.id}` });
    return restored;
  });

  // ---- OCR removed ---------------------------------------------------------
  // Scanning was removed from the product on the user's request: the workbook is
  // the only entry path. The `ocr_drafts` and `ocr_field_confidence` tables are
  // kept in the schema (never dropping an existing table) but nothing writes to
  // them any more, and no channel exposes them.

  // ---- Exports ------------------------------------------------------------
  ipcMain.handle('analysis:export-excel', async () => {
    const db = requireDatabase();
    const profile = security.getAccessProfile(db);
    const source = lastAnalysis ?? rebuildAnalysis(db);
    const analysis = profile === 'shared' ? analyzeShared(db, source) : source;
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

  ipcMain.handle('analysis:export-filtered-pdf', async (_event, request = {}) => {
    const db = requireDatabase();
    const profile = security.getAccessProfile(db);
    const input = request && typeof request === 'object' ? request : {};
    if (!['database', 'indicators'].includes(input.type)) throw new Error('نوع التقرير المطلوب غير صالح.');
    const filters = input.filters && typeof input.filters === 'object' ? input.filters : {};
    const search = typeof filters.search === 'string' ? filters.search.trim().slice(0, 200) : '';
    const governorate = typeof filters.governorate === 'string' ? filters.governorate.trim().slice(0, 120) : '';
    const allColumns = filters.allColumns === true;
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: 'تصدير التقرير المخصص',
      defaultPath: `تقرير-${input.type === 'indicators' ? 'المؤشرات' : 'قاعدة-البيانات'}-${new Date().toISOString().slice(0, 10)}.pdf`,
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (canceled || !filePath) return { canceled: true };

    let result;
    if (input.type === 'database') {
      const rows = persist.listDirectorates(db, { search, governorate, limit: 3000 });
      const masked = maskDbRows(rows, profile);
      const defaultKeys = new Set([
        'districtName', 'governorate', 'population', 'waterCoverage', 'pavedRoads',
        'revenue', 'schools', 'govFacilities', 'valueChains', 'projectCost', 'projectStatus',
      ]);
      const fields = INPUT_FIELDS.filter((field) => allColumns || defaultKeys.has(field.key));
      result = await exportDatabaseReportPdf({ BrowserWindow }, filePath, {
        rows: masked.rows,
        columns: fields.map((field) => ({ key: field.key, header: field.header, type: field.type, dbColumn: COLUMN_BY_KEY[field.key] })),
        filters: { search, governorate, allColumns },
      });
      auditRead('analysis:export-filtered-pdf', {
        entity: 'directorates', rowCount: rows.length, fields: masked.masked.join(','),
        result: masked.masked.length ? 'masked' : 'ok', detail: 'type=database',
      });
    } else if (input.type === 'indicators') {
      const view = ['values', 'scores', 'contributions'].includes(input.view) ? input.view : 'values';
      const payload = sheetPayloads().indicators;
      const rows = payload.rows.filter((row) => (!governorate || row.governorate === governorate)
        && (!search || `${row.districtName} ${row.governorate}`.includes(search)));
      result = await exportIndicatorsReportPdf({ BrowserWindow }, filePath, {
        rows, registry: payload.registry, filters: { search, governorate }, view,
      });
      auditRead('analysis:export-filtered-pdf', {
        entity: 'directorates', rowCount: rows.length, result: profile === 'shared' ? 'masked' : 'ok',
        detail: `type=indicators;view=${view}`,
      });
    } else {
      throw new Error('نوع التقرير المطلوب غير صالح.');
    }
    persist.logAccess(db, {
      action: 'export-pdf', entity: 'file', entityId: filePath,
      detail: `profile=${profile};type=${input.type};search=${Boolean(search)};governorate=${Boolean(governorate)}`,
    });
    return { canceled: false, ...result };
  });

  ipcMain.handle('analysis:export-pdf', async () => {

    const db = requireDatabase();
    const profile = security.getAccessProfile(db);
    const source = lastAnalysis ?? rebuildAnalysis(db);
    const analysis = profile === 'shared' ? analyzeShared(db, source) : source;
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

  // ---- Offline update policy ----------------------------------------------
  // These compatibility channels never access the network or install software.
  // Administrators distribute signed/verified installer packages separately.
  ipcMain.handle('update:status', () => offlineUpdateStatus(app.getVersion()));
  ipcMain.handle('update:check', async () => offlineUpdateStatus(app.getVersion()));
  ipcMain.handle('update:install', () => false);

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
    installOfflineSessionGuard(session.defaultSession);
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
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });