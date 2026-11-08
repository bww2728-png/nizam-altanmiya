const { app, BrowserWindow, dialog, ipcMain, Menu } = require('electron');
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
const { exportAnalysisPdf } = require('./analysis/pdf.cjs');
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
    pendingPlan = null;
    invalidateSheets();
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








  // ---- Excel import: scan -> plan -> apply ---------------------------------
  // The workbook is the only entry point: it is read and turned into an explicit
  // plan first, so nothing reaches the database before a human has seen what the
  // plan intends to do with each row.
  ipcMain.handle('import:scan', async (event, request = {}) => {
    let filePath = request.filePath;
    if (!filePath) {
      sendImportProgress(event.sender, { phase: 'dialog', message: 'جارٍ فتح نافذة اختيار الملف...' });
      const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
        title: 'اختر ملف «القالب المحدث» (قاعدة البيانات الشاملة)',
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