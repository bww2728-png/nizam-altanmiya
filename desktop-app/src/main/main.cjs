const { app, BrowserWindow, dialog, ipcMain, Menu, net, safeStorage, session } = require('electron');
const { installOfflineNetworkGuards, installOfflineSessionGuard, isAllowedUpdateRequest, isAllowedRagflowRequest } = require('./offline-policy.cjs');
installOfflineNetworkGuards({ electronNet: net, allowedNetworkRequest: (request, init) => isAllowedUpdateRequest(request) || isAllowedRagflowRequest(request, init) });
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
const dataArchitecture = require('./database/architecture.cjs');
const manualEntryCatalog = require('./database/manual-entry-catalog.cjs');
const documentService = require('./documents/document-service.cjs');
const schemaDrivenDiscovery = require('./documents/schema-driven-discovery.cjs');
const { RagflowAdapter } = require('./documents/ragflow-adapter.cjs');
const recordService = require('./database/record-service.cjs');
const { mappingTable } = require('./analysis/mapping.cjs');
const { defaultWeights, validateWeights } = require('./analysis/composite.cjs');
const persist = require('./analysis/persist.cjs');
const { serializeAnalysis } = require('./analysis/serialize.cjs');
const { exportAnalysisWorkbook } = require('./analysis/exporter.cjs');
const { exportFilteredWorkbook, exportFilteredCsv } = require('./analysis/report-exporter.cjs');
const { filterIndicatorReport } = require('./analysis/report-query.cjs');
const { exportAnalysisPdf, exportDatabaseReportPdf, exportIndicatorsReportPdf } = require('./analysis/pdf.cjs');
const { INPUT_FIELDS, DECISION_FIELD, MANDATORY_FIELDS } = require('./analysis/schema.cjs');
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
let autoUpdater = null;
let activeDocumentQueue = Promise.resolve();
const activeDocumentJobs = new Map();
let drainingDocumentTasks = false;
let lastUpdateStatus = { state: 'idle' };
const UPDATE_CHECK_DELAY_MS = 8_000;
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1_000;
/**
 * A failed check retries on its own, without an attempt counter. A failed
 * transfer waits longer because every attempt starts the installer again.
 */
const UPDATE_RETRY_DELAY_MS = 15 * 60 * 1_000;
const UPDATE_DOWNLOAD_RETRY_DELAY_MS = 60 * 60 * 1_000;
try { ({ autoUpdater } = require('electron-updater')); } catch { autoUpdater = null; }

const COLUMN_BY_KEY = DIRECTORATE_COLUMNS;

function getDatabasePath() {
  return path.join(app.getPath('userData'), 'development-data.db');
}

function getStoreKeyPath() {
  return path.join(app.getPath('userData'), 'store.key');
}

function getRagflowConfigPath() {
  return path.join(app.getPath('userData'), 'ragflow-credentials.bin');
}

function readRagflowConfig() {
  const configPath = getRagflowConfigPath();
  if (!safeStorage.isEncryptionAvailable() || !fs.existsSync(configPath)) return { apiKey: '', datasetIds: [] };
  try {
    const stat = fs.lstatSync(configPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024) return { apiKey: '', datasetIds: [] };
    const payload = JSON.parse(safeStorage.decryptString(fs.readFileSync(configPath)));
    return {
      apiKey: typeof payload.apiKey === 'string' ? payload.apiKey.slice(0, 1000) : '',
      datasetIds: Array.isArray(payload.datasetIds) ? payload.datasetIds.filter((value) => /^[a-f0-9]{32}$/i.test(value)).slice(0, 20) : [],
    };
  } catch {
    return { apiKey: '', datasetIds: [] };
  }
}

function getRagflowAdapter() {
  const config = readRagflowConfig();
  return new RagflowAdapter({ apiKey: config.apiKey, datasetIds: config.datasetIds, fetch: (url, init) => net.fetch(url, init) });
}

function processDocument(databaseStore, documentId) {
  const original = documentService.readOriginal(databaseStore, documentId);
  const temporaryDirectory = fs.mkdtempSync(path.join(app.getPath('temp'), 'ldi-document-'));
  const temporaryFile = path.join(temporaryDirectory, `${crypto.randomUUID()}${path.extname(original.file_name).toLowerCase()}`);
  try {
    if (process.platform !== 'win32') fs.chmodSync(temporaryDirectory, 0o700);
    fs.writeFileSync(temporaryFile, original.content, { flag: 'wx', mode: 0o600 });
    return documentService.runWorker(temporaryFile, app.isPackaged ? { resourcesPath: process.resourcesPath } : {})
      .then(async (payload) => {
        const extracted = documentService.persistExtraction(databaseStore,original.id,payload);
        let discovery = null;
        let discoveryError = null;
        let ragflowIndex = null;
        let ragflowError = null;
        const adapter = getRagflowAdapter();
        let health = null;
        let retrieve;
        try {
          health = await adapter.health();
        } catch (error) {
          ragflowError = String(error?.message ?? error).slice(0,500);
        }
        if (health?.configured && health?.available) {
          try {
            const references = documentService.listRagflowReferences(databaseStore,original.id);
            ragflowIndex = await adapter.indexDocument(original,{
              references,
              onReference: (reference) => documentService.saveRagflowReference(databaseStore,original.id,reference.dataset_id,reference.ragflow_document_id,reference.status),
            });
            retrieve = (request) => adapter.retrieve(request);
          } catch (error) {
            ragflowError = String(error?.message ?? error).slice(0,500);
          }
        } else if (!ragflowError) {
          ragflowError = health?.error ?? health?.message ?? 'خدمة RAGFlow المحلية غير متاحة.';
        }
        try {
          discovery = await schemaDrivenDiscovery.discoverFields(databaseStore,{ documentId: original.id },{ retrieve });
        } catch (error) {
          discoveryError = String(error?.message ?? error).slice(0, 500);
        }
        auditRead('documents:extract',{ entity:'document_records',entityId:original.id,result:extracted.status,detail:`engine=${extracted.engine.name};elements=${extracted.elementCount};fieldCandidates=${discovery?.evidenceCount ?? 0}` });
        return { ...extracted,discovery,discoveryError,ragflowIndex,ragflowError };
      })
      .catch((error) => {
        const message = String(error?.message ?? error).slice(0, 2000);
        documentService.markProcessingFailure(databaseStore,original.id,'document-worker',message,/not found|not installed|غير موجود|غير مثبت|غير متاح/i.test(message) ? 'unavailable' : 'failed');
        auditRead('documents:extract', { entity: 'document_records', entityId: original.id, result: 'failed' });
        throw new Error(message);
      })
      .finally(() => {
        try { fs.rmSync(temporaryDirectory,{ recursive: true,force: true }); } catch {}
      });
  } catch (error) {
    try { fs.rmSync(temporaryDirectory,{ recursive: true,force: true }); } catch {}
    throw error;
  }
}

function enqueueDocumentProcessing(documentId) {
  const key = String(documentId);
  if (activeDocumentJobs.has(key)) return activeDocumentJobs.get(key);
  const store = requireDatabase();
  documentService.markProcessingStarted(store,key);
  const task = activeDocumentQueue.catch(() => {}).then(() => processDocument(store,key));
  activeDocumentQueue = task.catch(() => {});
  activeDocumentJobs.set(key,task);
  task.then(() => activeDocumentJobs.delete(key),() => activeDocumentJobs.delete(key));
  return task;
}

function hasActiveDocumentJobs() {
  return activeDocumentJobs.size > 0;
}


function hasUsableDatabase() {
  const filePath = getDatabasePath();
  return fs.existsSync(filePath) && fs.statSync(filePath).size > 0;
}

function openDatabase() {
  const filePath = getDatabasePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const keyPath = getStoreKeyPath();
  const key = loadOrCreateStoreKey(keyPath, { databaseExists: hasUsableDatabase() });
  return openEncryptedStore(filePath, key, { keyPath });
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
function maskDbRows(rows, profile, database = null) {
  const catalogue = database ? mappingTable(database) : [];
  const columnsByKey = { ...COLUMN_BY_KEY, ...Object.fromEntries(catalogue.map((field) => [field.key, field.dbColumn ?? field.key])) };
  const dynamicRestricted = profile === 'shared'
    ? catalogue.filter((field) => field.sensitivity !== 'public' && !security.isProtected(field.key, profile))
    : [];
  const maskedKeys = new Set();
  const output = rows.map((row) => {
    const result = security.maskRecord(row, profile, columnsByKey);
    result.masked.forEach((key) => maskedKeys.add(key));
    for (const field of dynamicRestricted) {
      if (field.dbColumn in result.record && result.record[field.dbColumn] !== null) {
        result.record[field.dbColumn] = null;
        maskedKeys.add(field.key);
      }
    }
    return result.record;
  });
  return { rows: output, masked: [...maskedKeys] };
}

function directorateQueryOptions(database, profile) {
  const catalogue = mappingTable(database);
  const dynamicFields = new Map(catalogue.map((field) => [field.key, { key: field.key, type: field.type }]));
  const allowedKeys = new Set(catalogue.filter((field) => field.filterable && !security.isProtected(field.key, profile)
    && (profile !== 'shared' || field.sensitivity === 'public')).map((field) => field.key));
  const allowedMandatoryKeys = new Set(MANDATORY_FIELDS.map((field) => field.key).filter((key) => allowedKeys.has(key)));
  return { allowedKeys, allowedMandatoryKeys, dynamicFields, profile };
}

function sanitizeReportFilters(input = {}, profile = 'owner') {
  const request = input && typeof input === 'object' ? input : {};
  const criteria = (Array.isArray(request.criteria) ? request.criteria : []).slice(0, 64).map((item) => ({
    key: typeof item?.key === 'string' ? item.key.slice(0, 80) : '',
    operator: typeof item?.operator === 'string' ? item.operator.slice(0, 16) : '',
    min: item?.min === null || item?.min === undefined ? '' : String(item.min).slice(0, 32),
    max: item?.max === null || item?.max === undefined ? '' : String(item.max).slice(0, 32),
    value: typeof item?.value === 'string' ? item.value.slice(0, 120) : '',
    values: (Array.isArray(item?.values) ? item.values : []).slice(0, 100).map((value) => String(value).slice(0, 120))
      .filter((value) => profile !== 'shared' || !security.isProtected(value, profile)),
    exclude: item?.exclude === true,
    missing: item?.missing === 'include' ? 'include' : 'exclude',
  })).filter((item) => profile !== 'shared' || (!security.isProtected(item.key, profile) && item.key !== '__qualityLevel'));
  return {
    search: typeof request.search === 'string' ? request.search.trim().slice(0, 120) : '',
    governorates: [...new Set((Array.isArray(request.governorates) ? request.governorates : []).map((value) => String(value).trim().slice(0, 120)).filter(Boolean))].slice(0, 100),
    periodKey: typeof request.periodKey === 'string' ? request.periodKey.trim().slice(0, 80) : '',
    logic: request.logic === 'or' ? 'or' : 'and',
    criteria,
    sortKey: typeof request.sortKey === 'string' ? request.sortKey.slice(0, 80) : '',
    sortDirection: request.sortDirection === 'asc' ? 'asc' : 'desc',
  };
}

function reportFilterLabels(filters, catalogue) {
  const labels = new Map([...INPUT_FIELDS, DECISION_FIELD].map((field) => [field.key, field.header]));
  for (const field of catalogue) labels.set(field.key, field.header);
  return filters.criteria.map((condition) => {
    const name = labels.get(condition.key) ?? ({
      __district: 'المديرية', __completeness: 'اكتمال الحقول الإلزامية', __missingField: 'الحقول الناقصة',
      __qualityLevel: 'تحذيرات الاستيراد', __sourceFile: 'ملف المصدر', __sourceSheet: 'ورقة المصدر',
      __sourceRow: 'رقم صف المصدر', __createdAt: 'تاريخ الاستيراد', __updatedAt: 'آخر تحديث',
    })[condition.key] ?? condition.key;
    const range = [condition.min !== '' ? `من ${condition.min}` : '', condition.max !== '' ? `إلى ${condition.max}` : ''].filter(Boolean).join(' ');
    const values = condition.values.length ? condition.values.join('، ') : condition.value;
    const operation = condition.operator === 'empty' ? 'فارغ'
      : condition.operator === 'present' ? 'متوفر'
        : condition.operator === 'contains' ? 'يحتوي على'
          : condition.operator === 'in' ? 'يساوي إحدى'
            : condition.operator === 'not-in' ? 'لا يساوي' : '';
    return `${condition.exclude ? 'NOT ' : ''}${name} ${operation} ${range || values}`.trim();
  });
}

function indicatorReportFilterLabels(report) {
  const priorityLabels = {
    composite: 'درجة الاحتياج المركبة', rank: 'الترتيب', degradedCount: 'الأبعاد المتدهورة',
    weightCoverage: 'تغطية الأوزان %', severe: 'الحرمان الحاد', blocked: 'الحجب عن الترتيب',
    complete: 'اكتمال البيانات', anomalous: 'وجود قيمة شاذة', confidenceLevel: 'تصنيف الثقة',
    fragile: 'قرار هش بسبب الأوزان', maxRankShift: 'مدى تغيّر الرتبة بين الأوزان',
  };
  const indicators = new Map(report.registry.map((indicator) => [indicator.code, indicator.header]));
  return report.filters.criteria.map((condition) => {
    const name = condition.field === 'metric' ? indicators.get(condition.code) ?? condition.code : priorityLabels[condition.field] ?? condition.field;
    const range = [condition.min !== '' ? `من ${condition.min}` : '', condition.max !== '' ? `إلى ${condition.max}` : ''].filter(Boolean).join(' ');
    const value = condition.value === 'true' ? 'نعم' : condition.value === 'false' ? 'لا' : condition.value;
    const operation = condition.operator === 'empty' ? 'فارغ'
      : condition.operator === 'present' ? 'متوفر'
        : condition.operator === 'equals' || condition.operator === 'boolean' ? 'يساوي'
          : condition.operator === 'range' ? '' : condition.operator;
    return `${condition.exclude ? 'NOT ' : ''}${name} ${operation} ${range || value}`.trim();
  });
}

function metricReportValue(row, code, view) {
  const value = view === 'scores' ? row.scores?.[code]
    : view === 'contributions' ? row.contributions?.[code]?.contribution ?? row.contributions?.[code]
      : row.values?.[code];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function directorateReportSummary(rows, selectedFields) {
  const governorates = new Map();
  let population = 0;
  let populationCount = 0;
  for (const row of rows) {
    const name = String(row.governorate ?? 'غير محددة').trim() || 'غير محددة';
    governorates.set(name, (governorates.get(name) ?? 0) + 1);
    if (selectedFields.has('population') && Number.isFinite(Number(row[DIRECTORATE_COLUMNS.population]))) {
      population += Number(row[DIRECTORATE_COLUMNS.population]);
      populationCount += 1;
    }
  }
  return {
    governorates: [...governorates.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count).slice(0, 15),
    population: populationCount ? population : null,
  };
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
  if (!fs.existsSync(filePath)) throw new Error('ملف Excel غير موجود في المسار المحدد.');
  const stat = fs.statSync(filePath);
  if (!stat.isFile() || stat.size === 0) throw new Error('ملف Excel فارغ أو ليس ملفًا صالحًا.');
  if (stat.size > TEMPLATE_MAX_BYTES) throw new Error('حجم ملف Excel يتجاوز الحد الآمن (200 ميجابايت).');
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
  if (!resolved) throw new Error('تعذّر الوصول إلى ملف Excel في المسار المحدد.');
  const userDataRoot = safeRealpath(app.getPath('userData')) ?? path.resolve(app.getPath('userData'));
  const allowed = isInsideRoot(resolved, userDataRoot)
    || (dialogSelectedPath ? comparePath(resolved) === comparePath(dialogSelectedPath) : false);
  if (!allowed) {
    throw new Error('مسار الملف غير مسموح. اختر ملف Excel من نافذة الاختيار التي يفتحها التطبيق.');
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

/** Timers owned by the updater so they can be cleared on quit. */
const updateTimers = { initial: null, interval: null, retry: null };
/** Set on quit so a late error event cannot arm a new retry. */
let updateStopped = false;

/**
 * Merge a status patch and forward it when the window can still receive it.
 *
 * Once an update is downloaded the ready state is sticky: a later poll or a
 * transient network error must not hide the restart action in the banner.
 */
function pushUpdateStatus(next) {
  if (lastUpdateStatus.state === 'downloaded' && next.state && next.state !== 'downloaded') {
    const superseded = next.version && next.version !== lastUpdateStatus.version;
    if (!superseded) return;
  }
  lastUpdateStatus = { ...lastUpdateStatus, ...next };
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send('update:status', lastUpdateStatus);
  }
}

function setupAutoUpdate() {
  if (!app.isPackaged || process.platform !== 'win32' || !autoUpdater) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;
  // Never fetch an installer over the web-installer path; only the packaged
  // NSIS update is allowed, and an older version may never replace a newer one.
  autoUpdater.disableWebInstaller = true;
  autoUpdater.allowDowngrade = false;
  // The release asset must arrive as one continuous stream. A differential update
  // asks for every changed block in its own ranged request (electron-updater
  // disables multi-range for GitHub, DifferentialDownloader.js:182), and on a
  // high-latency link each request costs seconds, so the transfer never finishes.
  autoUpdater.disableDifferentialDownload = true;

  autoUpdater.on('checking-for-update', () => pushUpdateStatus({ state: 'checking' }));
  autoUpdater.on('update-available', info => {
    clearUpdateRetry();
    pushUpdateStatus({ state: 'available', version: info?.version });
  });
  autoUpdater.on('update-not-available', () => {
    clearUpdateRetry();
    pushUpdateStatus({ state: 'not-available' });
  });
  autoUpdater.on('download-progress', progress => pushUpdateStatus({ state: 'downloading', percent: Math.round(progress?.percent ?? 0) }));
  autoUpdater.on('update-downloaded', info => {
    clearUpdateRetry();
    pushUpdateStatus({ state: 'downloaded', version: info?.version });
  });
  autoUpdater.on('error', error => {
    // Read the phase before recording the failure: the message alone does not say
    // whether the check, the transfer or the install is what failed.
    const failedPhase = lastUpdateStatus.state;
    const failedWhileChecking = !['available', 'downloading', 'downloaded'].includes(failedPhase);
    // A failure in the ready phase means the install itself failed. Keeping the
    // sticky 'downloaded' state would swallow the message, keep offering a restart
    // that cannot succeed and block every later check, so the ready state is
    // dropped before the error is published and the retry is armed.
    if (failedPhase === 'downloaded') lastUpdateStatus = { state: 'error' };
    pushUpdateStatus({ state: 'error', phase: failedPhase, message: String(error?.message ?? error).slice(0, 300) });
    // The phase alone decides the delay; there is no attempt counter, so a machine
    // that cannot reach the channel keeps retrying on its own until it succeeds.
    scheduleUpdateRetry(failedWhileChecking ? UPDATE_RETRY_DELAY_MS : UPDATE_DOWNLOAD_RETRY_DELAY_MS);
  });

  // Every check keeps a catch: a machine with no connection must not surface an
  // unhandled rejection, and a failed check is already reported by the error event.
  // The transfer runs as its own promise inside that result, so it needs the same
  // guard: a rejection nobody awaits would reach the process-level handler.
  // Once a build is downloaded the poll stops so the ready state stays put.
  const checkForUpdates = () => {
    if (lastUpdateStatus.state === 'downloaded') return;
    autoUpdater.checkForUpdates().then(
      result => { result?.downloadPromise?.catch?.(() => {}); },
      () => {},
    );
  };

  // Automatic retry: armed by a failure, cleared by any success. Do not wait for
  // the six-hour poll to notice that a flaky link recovered.
  function scheduleUpdateRetry(delay) {
    if (updateStopped || updateTimers.retry) return;
    updateTimers.retry = setTimeout(() => {
      updateTimers.retry = null;
      if (updateStopped) return;
      // A manual check may have recovered meanwhile. Only a live transfer or an
      // installer already waiting for a restart makes a re-check pointless; any
      // other state is safe to retry, so a failure can never stall the updater.
      const state = lastUpdateStatus.state;
      if (state === 'downloading' || state === 'downloaded') return;
      checkForUpdates();
    }, delay);
    if (updateTimers.retry.unref) updateTimers.retry.unref();
  }

  function clearUpdateRetry() {
    if (!updateTimers.retry) return;
    clearTimeout(updateTimers.retry);
    updateTimers.retry = null;
  }

  updateTimers.initial = setTimeout(checkForUpdates, UPDATE_CHECK_DELAY_MS);
  updateTimers.interval = setInterval(checkForUpdates, UPDATE_CHECK_INTERVAL_MS);
  // Never keep the process alive just for the update poll.
  if (updateTimers.initial.unref) updateTimers.initial.unref();
  if (updateTimers.interval.unref) updateTimers.interval.unref();
}

/** Clear the updater timers on quit so nothing fires during teardown. */
function stopAutoUpdate() {
  updateStopped = true;
  if (updateTimers.initial) clearTimeout(updateTimers.initial);
  if (updateTimers.interval) clearInterval(updateTimers.interval);
  if (updateTimers.retry) clearTimeout(updateTimers.retry);
  updateTimers.initial = null;
  updateTimers.interval = null;
  updateTimers.retry = null;
}

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

  ipcMain.handle('documents:stage', async () => {
    if (currentProfile() !== 'owner') throw new Error('إدارة الوثائق تتطلب وضع المالك.');
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'إضافة وثيقة إلى المكتبة المحلية',
      properties: ['openFile'],
      filters: [{ name: 'PDF وWord وصور', extensions: ['pdf', 'docx', 'png', 'jpg', 'jpeg', 'tif', 'tiff'] }],
    });
    if (result.canceled || !result.filePaths?.[0]) return { canceled: true };
    const staged = await documentService.stageFile(requireDatabase(), result.filePaths[0]);
    if (!staged.duplicate) {
      enqueueDocumentProcessing(staged.id).catch(() => {});
      staged.status = 'processing';
    }
    auditRead('documents:stage', { entity: 'document_records', entityId: staged.id, result: staged.duplicate ? 'duplicate' : 'staged' });
    return staged;
  });

  ipcMain.handle('documents:list', (_event, request = {}) => {
    if (currentProfile() !== 'owner') return { restricted: true, rows: [], total: 0 };
    const result = documentService.listDocuments(requireDatabase(), request);
    auditRead('documents:list', { entity: 'document_records', rowCount: result.rows.length, detail: `offset=${result.offset};limit=${result.limit}` });
    return result;
  });

  ipcMain.handle('documents:get', (_event, documentId) => {
    if (currentProfile() !== 'owner') throw new Error('استعراض محتوى الوثائق يتطلب وضع المالك.');
    const result = documentService.getDocument(requireDatabase(), documentId);
    auditRead('documents:get', { entity: 'document_records', entityId: result.document.id, rowCount: result.elements.length });
    return result;
  });

  ipcMain.handle('documents:extract', async (_event, documentId) => {
    if (currentProfile() !== 'owner') throw new Error('استخراج الوثائق يتطلب وضع المالك.');
    return enqueueDocumentProcessing(documentId);
  });

  ipcMain.handle('documents:field-candidates', (_event, documentId) => {
    if (currentProfile() !== 'owner') return { restricted: true, run: null, rows: [] };
    const result = schemaDrivenDiscovery.listCandidates(requireDatabase(),String(documentId));
    auditRead('documents:field-candidates', { entity: 'document_field_candidates', entityId: String(documentId), rowCount: result.rows.length });
    return result;
  });

  ipcMain.handle('documents:field-candidate:review', (_event, request = {}) => {
    if (currentProfile() !== 'owner') throw new Error('مراجعة القيم المرشحة تتطلب وضع المالك.');
    const result = schemaDrivenDiscovery.reviewCandidate(requireDatabase(),{ ...request,reviewedBy:sessionId });
    auditRead('documents:field-candidate:review', { entity: 'document_field_candidates', entityId: result.candidateId, result: result.status, detail: 'officialDataChanged=false' });
    return result;
  });

  ipcMain.handle('documents:field-candidates:promote', (_event, request = {}) => {
    if (currentProfile() !== 'owner') throw new Error('ترحيل القيم المراجَعة يتطلب وضع المالك.');
    const result = schemaDrivenDiscovery.promoteReviewedCandidates(requireDatabase(),request,{ actor:sessionId });
    invalidateSheets();
    auditRead('documents:field-candidates:promote', {
      entity:'form_records',entityId:result.formRecordId,result:result.status,
      detail:`document=${String(request.documentId ?? '').slice(0,80)};candidates=${result.candidateIds.length};fields=${result.fieldCount}`,
    });
    return result;
  });

  ipcMain.handle('documents:search-local', (_event, request = {}) => {
    if (currentProfile() !== 'owner') return { restricted: true, rows: [] };
    const result = documentService.searchDocuments(requireDatabase(), request);
    auditRead('documents:search-local', { entity: 'document_elements', rowCount: result.rows.length, detail: `queryLength=${result.query.length}` });
    return result;
  });

  ipcMain.handle('documents:index-ragflow', async (_event, documentId) => {
    if (currentProfile() !== 'owner') throw new Error('فهرسة الوثائق تتطلب وضع المالك.');
    const db = requireDatabase();
    const adapter = getRagflowAdapter();
    const health = await adapter.health();
    if (!health.configured || !health.available) throw new Error(health.error || 'خدمة RAGFlow المحلية غير جاهزة أو غير مهيأة.');
    const document = documentService.readOriginal(db, documentId);
    const references = documentService.listRagflowReferences(db, documentId);
    const result = await adapter.indexDocument(document, {
      references,
      onReference: (reference) => documentService.saveRagflowReference(db, document.id, reference.dataset_id, reference.ragflow_document_id, reference.status),
    });
    auditRead('documents:index-ragflow', { entity: 'document_records', entityId: document.id, result: 'queued', detail: `datasets=${result.results.length}` });
    return result;
  });

  ipcMain.handle('documents:sync-index-status', async (_event, documentId) => {
    if (currentProfile() !== 'owner') throw new Error('فحص الفهرسة يتطلب وضع المالك.');
    const db = requireDatabase();
    const adapter = getRagflowAdapter();
    const references = documentService.listRagflowReferences(db, documentId);
    const results = [];
    for (const reference of references) {
      try {
        const status = await adapter.documentStatus(reference.dataset_id, reference.ragflow_document_id);
        results.push(documentService.saveRagflowReference(db, documentId, status.datasetId, status.documentId, status.status));
      } catch (error) {
        results.push({ dataset_id: reference.dataset_id, status: reference.status, error: String(error?.message ?? error).slice(0, 300) });
      }
    }
    return { results };
  });

  ipcMain.handle('ragflow:status', async () => {
    if (currentProfile() !== 'owner') return { restricted: true };
    return getRagflowAdapter().health();
  });

  ipcMain.handle('ragflow:search', async (_event, request = {}) => {
    if (currentProfile() !== 'owner') return { restricted: true, rows: [] };
    const result = await getRagflowAdapter().retrieve(request);
    auditRead('ragflow:search', { entity: 'ragflow_chunks', rowCount: result.rows.length, detail: `queryLength=${result.question.length}` });
    return result;
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

  ipcMain.handle('db:lock', async () => {
    if (activeDocumentJobs.size) await Promise.allSettled([...activeDocumentJobs.values()]);
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
    const normalizedImport = dataArchitecture.mirrorWorkbookImport(db, staging.batchId);
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
      normalizedImport,
      stagingOnly: Boolean(directorateReadError),
      stagingMessage: directorateReadError,
    };
  });

  ipcMain.handle('import:plan', () => {
    if (!pendingPlan) throw new Error('لم يُقرأ أي ملف بعد. اختر ملفًا لبناء خطة الاستيراد.');
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

  ipcMain.handle('data:entry-catalog', () => {
    if (currentProfile() !== 'owner') throw new Error('كتالوج مجالات الإدخال متاح في وضع المالك فقط.');
    const catalog = manualEntryCatalog.listCatalog(requireDatabase());
    auditRead('data:entry-catalog', { entity: 'manual_entry_domains', rowCount: catalog.domains.length, detail: `version=${catalog.version}` });
    return catalog;
  });

  ipcMain.handle('data:forms', () => {
    if (currentProfile() !== 'owner') throw new Error('كتالوج النماذج متاح في وضع المالك فقط.');
    const rows = recordService.listForms(requireDatabase());
    auditRead('data:forms', { entity: 'form_definitions', rowCount: rows.length });
    return rows;
  });

  ipcMain.handle('data:form-definition', (_event, formVersionId) => {
    if (currentProfile() !== 'owner') throw new Error('تعريفات النماذج متاحة في وضع المالك فقط.');
    return recordService.getFormDefinition(requireDatabase(), formVersionId);
  });

  ipcMain.handle('data:record:get', (_event, recordId) => {
    if (currentProfile() !== 'owner') throw new Error('عرض السجل يتطلب وضع المالك.');
    return recordService.getRecord(requireDatabase(),recordId);
  });

  ipcMain.handle('data:records:list', (_event, request = {}) => {
    if (currentProfile() !== 'owner') return { restricted: true, rows: [], total: 0 };
    const result = recordService.listRecords(requireDatabase(), request);
    auditRead('data:records:list', { entity: 'form_records', rowCount: result.rows.length, detail: 'offset=' + result.offset + ';limit=' + result.limit });
    return result;
  });

  ipcMain.handle('data:record:save', (_event, request = {}) => {
    if (currentProfile() !== 'owner') throw new Error('إدخال البيانات يتطلب وضع المالك.');
    const result = recordService.saveRecord(requireDatabase(), { ...request, actor: sessionId });
    invalidateSheets();
    return result;
  });

  ipcMain.handle('data:record:review', (_event, request = {}) => {
    if (currentProfile() !== 'owner') throw new Error('مراجعة البيانات واعتمادها يتطلبان وضع المالك.');
    const result = request.decision === 'submit'
      ? recordService.submitForReview(requireDatabase(), request.formRecordId, sessionId)
      : recordService.decideRecord(requireDatabase(), request.formRecordId, { ...request, actor: sessionId });
    if (['approve','reopen'].includes(request.decision)) invalidateSheets();
    return result;
  });

  ipcMain.handle('data:geography:list', (_event, search = '') => {
    if (currentProfile() !== 'owner') return { restricted: true, rows: [] };
    return { rows: recordService.listGeoUnits(requireDatabase(), search) };
  });

  ipcMain.handle('data:periods:list', () => {
    if (currentProfile() !== 'owner') return { restricted: true, rows: [] };
    return { rows: recordService.listPeriods(requireDatabase()) };
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

  ipcMain.handle('sources:list', (_event, request = {}) => {
    if (currentProfile() !== 'owner') return { restricted: true, rows: [], total: 0 };
    const result = canonicalData.listDataSources(requireDatabase(),request);
    auditRead('sources:list',{ entity:'data_sources',rowCount:result.rows.length,detail:'offset='+result.offset+';limit='+result.limit });
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
    dataArchitecture.syncWorkbookImportStatus(db, request.batchId);
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
    dataArchitecture.syncWorkbookImportStatus(db, request.batchId);
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
    if (!pendingPlan) throw new Error('لا توجد خطة استيراد جاهزة. اختر ملفًا وأعد فحصه.');
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
    dataArchitecture.syncWorkbookImportStatus(db, pendingPlan.staging.batchId);
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

  function makeIndicatorReport(request = {}, profile = currentProfile()) {
    const criteria = Array.isArray(request.criteria) ? request.criteria : [];
    const requiresSensitivity = profile !== 'shared' && criteria.some((condition) => ['fragile', 'maxRankShift'].includes(condition?.field));
    let payload = sheetPayloads(request.mode === 'replica' ? 'replica' : 'calibrated');
    if (requiresSensitivity && !payload.analysis.rows?.some((row) => row.sensitivity)) {
      const transformRows = profile === 'shared' ? (rows) => security.maskInputRows(rows, 'shared') : null;
      const enriched = buildSheets(requireDatabase(), { transformRows, mode: 'calibrated', sensitivity: true });
      sheetsCache = { profile, payload: enriched, rankings: { calibrated: enriched.ranking } };
      payload = sheetPayloads(request.mode === 'replica' ? 'replica' : 'calibrated');
    }
    return filterIndicatorReport(payload.indicators, request, profile);
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

  ipcMain.handle('sheet:indicator-report', (_event, request = {}) => {
    const profile = currentProfile();
    const report = makeIndicatorReport(request, profile);
    auditRead('sheet:indicator-report', {
      entity: 'directorates', rowCount: report.total, result: profile === 'shared' ? 'masked' : 'ok',
      detail: `criteria=${report.filters.criteria.length};mode=${report.filters.mode};view=${report.filters.view}`,
    });
    return report;
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
    if (!rows.length) throw new Error('لا توجد مديريات في قاعدة البيانات. أدخل البيانات يدويًا أو استورد ملفًا صالحًا.');
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

  ipcMain.handle('analysis:fields', () => mappingTable(requireDatabase()));

  ipcMain.handle('analysis:directorates', (_event, request = {}) => {
    const db = requireDatabase();
    const profile = security.getAccessProfile(db);
    const queryOptions = directorateQueryOptions(db, profile);
    const rows = persist.listDirectorates(db, request, queryOptions);
    const masked = maskDbRows(rows, profile, db);
    const total = persist.countDirectorates(db, request, queryOptions);
    auditRead('analysis:directorates', {
      entity: 'directorates',
      rowCount: rows.length,
      fields: masked.masked.join(','),
      result: masked.masked.length ? 'masked' : 'ok',
      detail: `filtered=${request.criteria?.length ?? 0}`,
    });
    return { total, rows: masked.rows, masked: masked.masked };
  });

  ipcMain.handle('analysis:directorates:filter-options', (_event, request = []) => {
    const db = requireDatabase();
    const profile = security.getAccessProfile(db);
    const queryOptions = directorateQueryOptions(db, profile);
    const options = {};
    for (const key of [...new Set((Array.isArray(request) ? request : []).map(String))].slice(0, 64)) {
      if (key.startsWith('__') || queryOptions.allowedKeys.has(key)) {
        options[key] = persist.listDirectorateFilterOptions(db, key, queryOptions);
      }
    }
    auditRead('analysis:directorates:filter-options', { entity: 'directorates', rowCount: Object.keys(options).length });
    return options;
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

  async function exportFilteredReport(request = {}, format = 'pdf') {
    const db = requireDatabase();
    const profile = security.getAccessProfile(db);
    const input = request && typeof request === 'object' ? request : {};
    if (!['database', 'indicators'].includes(input.type)) throw new Error('نوع التقرير المطلوب غير صالح.');
    const rowLimit = format === 'pdf' ? 3000 : 50000;
    const extension = format === 'pdf' ? 'pdf' : format === 'csv' ? 'csv' : 'xlsx';
    const filtersInput = input.filters && typeof input.filters === 'object' ? input.filters : {};
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: 'تصدير التقرير المخصص',
      defaultPath: `تقرير-${input.type === 'indicators' ? 'المؤشرات' : 'قاعدة-البيانات'}-${new Date().toISOString().slice(0, 10)}.${extension}`,
      filters: [{ name: format === 'pdf' ? 'PDF' : format === 'csv' ? 'CSV UTF-8' : 'Excel', extensions: [extension] }],
    });
    if (canceled || !filePath) return { canceled: true };

    let result;
    let rowCount;
    let maskedFields = [];
    let labels = [];
    if (input.type === 'database') {
      const filters = sanitizeReportFilters(filtersInput, profile);
      const options = directorateQueryOptions(db, profile);
      rowCount = persist.countDirectorates(db, filters, options);
      if (rowCount > rowLimit) throw new Error(`عدد النتائج (${rowCount.toLocaleString('ar')}) يتجاوز حد ${format === 'pdf' ? 'PDF' : 'Excel'} الآمن (${rowLimit.toLocaleString('ar')}). أضف فلاتر لتقليل النتائج.`);
      const rows = persist.listDirectorates(db, { ...filters, limit: rowLimit }, options);
      const masked = maskDbRows(rows, profile, db);
      maskedFields = masked.masked;
      const catalogue = mappingTable(db);
      const allowedFields = catalogue.filter((field) => !security.isProtected(field.key, profile)
        && (profile !== 'shared' || field.sensitivity === 'public') && field.exportable !== false);
      const allowedKeys = new Set(allowedFields.map((field) => field.key));
      const requestedKeys = Array.isArray(input.columns)
        ? input.columns.map(String).slice(0, catalogue.length)
        : ['districtName', 'governorate', 'population', 'waterCoverage', 'pavedRoads', 'schools', 'projectStatus'];
      const selectedKeys = [...new Set(requestedKeys)].filter((key) => allowedKeys.has(key));
      for (const identityKey of ['districtName', 'governorate']) {
        if (!selectedKeys.includes(identityKey) && allowedKeys.has(identityKey)) selectedKeys.unshift(identityKey);
      }
      const fields = allowedFields.filter((field) => selectedKeys.includes(field.key));
      const columns = fields.map((field) => ({ key: field.key, header: field.header, type: field.type, dbColumn: field.dbColumn ?? field.key }));
      const reportRows = masked.rows.map((row) => ({
        ...row,
        ...Object.fromEntries(columns.map((column) => [column.key, row[column.dbColumn]])),
      }));
      labels = reportFilterLabels(filters, catalogue);
      const reportFilters = { search: filters.search, governorates: filters.governorates, periodKey: filters.periodKey, logic: filters.logic, criteria: labels, labels };
      const summary = directorateReportSummary(reportRows, new Set(fields.map((field) => field.key)));
      const report = {
        title: 'تقرير قاعدة البيانات الشاملة',
        generatedAt: new Date().toISOString(),
        rows: reportRows,
        columns,
        filters: reportFilters,
        summary: { ...summary, total: rowCount },
        total: rowCount,
      };
      result = format === 'pdf'
        ? await exportDatabaseReportPdf({ BrowserWindow }, filePath, report)
        : format === 'csv' ? await exportFilteredCsv(filePath, report) : await exportFilteredWorkbook(filePath, report);
      auditRead(`analysis:export-filtered-${format}`, {
        entity: 'directorates', rowCount, fields: maskedFields.join(','),
        result: maskedFields.length ? 'masked' : 'ok', detail: 'type=database',
      });
    } else {
      const report = makeIndicatorReport(filtersInput, profile);
      rowCount = report.total;
      if (rowCount > rowLimit) throw new Error(`عدد النتائج (${rowCount.toLocaleString('ar')}) يتجاوز حد ${format === 'pdf' ? 'PDF' : 'Excel'} الآمن (${rowLimit.toLocaleString('ar')}). أضف شروطًا لتقليل النتائج.`);
      const columnsRequest = input.columns && typeof input.columns === 'object' ? input.columns : {};
      const selectedCodes = Array.isArray(columnsRequest.indicators) ? columnsRequest.indicators.map(String) : report.registry.map((item) => item.code);
      const registry = report.registry.filter((indicator) => selectedCodes.includes(indicator.code));
      const includePriority = profile !== 'shared' && columnsRequest.includePriority !== false;
      const mode = report.filters.mode;
      const view = report.filters.view;
      const rankKey = mode === 'replica' ? 'replicaRank' : 'calibratedRank';
      const scoreKey = mode === 'replica' ? 'replicaComposite' : 'composite';
      const indicatorColumns = registry.map((indicator) => ({ key: indicator.code, header: indicator.header, width: 20 }));
      const reportColumns = [
        { key: 'districtName', header: 'المديرية', width: 24 },
        { key: 'governorate', header: 'المحافظة', width: 18 },
        ...(includePriority ? [
          { key: 'reportRank', header: 'الرتبة', width: 12 },
          { key: 'reportComposite', header: 'درجة المسار', width: 16 },
        ] : []),
        ...indicatorColumns,
      ];
      const reportRows = report.rows.map((row) => ({
        ...row,
        reportRank: row[rankKey] ?? null,
        reportComposite: row[scoreKey] ?? null,
        ...Object.fromEntries(registry.map((indicator) => [indicator.code, metricReportValue(row, indicator.code, view)])),
      }));
      labels = indicatorReportFilterLabels(report);
      const reportFilters = { ...report.filters, criteria: labels, labels };
      const exportReport = {
        title: 'تقرير مؤشرات التنمية',
        generatedAt: new Date().toISOString(),
        rows: reportRows,
        columns: reportColumns,
        filters: reportFilters,
        summary: {
          ...report.summary,
          ...(includePriority ? {} : { rankable: null, complete: null, averageComposite: null }),
          items: [
            { label: 'نتائج مطابقة', value: rowCount },
            { label: 'قيم شاذة', value: report.summary.anomalous },
            ...(includePriority ? [
              { label: 'قابلة للترتيب', value: report.summary.rankable },
              { label: 'متوسط درجة المسار', value: report.summary.averageComposite },
            ] : []),
          ],
        },
      };
      result = format === 'pdf'
        ? await exportIndicatorsReportPdf({ BrowserWindow }, filePath, {
          rows: reportRows,
          registry,
          filters: reportFilters,
          view,
          mode,
          total: rowCount,
          summary: exportReport.summary,
          includePriority,
        })
        : format === 'csv' ? await exportFilteredCsv(filePath, exportReport) : await exportFilteredWorkbook(filePath, exportReport);
      auditRead(`analysis:export-filtered-${format}`, {
        entity: 'directorates', rowCount, result: profile === 'shared' ? 'masked' : 'ok',
        detail: `type=indicators;view=${view};mode=${mode}`,
      });
    }
    persist.logAccess(db, {
      action: format === 'pdf' ? 'export-pdf' : 'export-excel', entity: 'file', entityId: filePath,
      detail: `profile=${profile};type=${input.type};rows=${rowCount};criteria=${labels.length}`,
    });
    return { canceled: false, ...result };
  }

  ipcMain.handle('analysis:export-filtered-pdf', (_event, request = {}) => exportFilteredReport(request, 'pdf'));
  ipcMain.handle('analysis:export-filtered-excel', (_event, request = {}) => exportFilteredReport(request, 'excel'));
  ipcMain.handle('analysis:export-filtered-csv', (_event, request = {}) => exportFilteredReport(request, 'csv'));

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

  ipcMain.handle('update:status', () => ({ ...lastUpdateStatus, currentVersion: app.getVersion() }));
  ipcMain.handle('update:check', async () => {
    if (!app.isPackaged || process.platform !== 'win32' || !autoUpdater) return { ...lastUpdateStatus, currentVersion: app.getVersion() };
    // A downloaded build is already waiting for a restart; a manual check must not
    // replace that state with a fresh cycle.
    if (lastUpdateStatus.state === 'downloaded') return { ...lastUpdateStatus, currentVersion: app.getVersion() };
    try {
      const result = await autoUpdater.checkForUpdates();
      // The download runs as its own promise; a rejection nobody awaits would
      // reach the process-level handler, while the error event reports it anyway.
      result?.downloadPromise?.catch?.(() => {});
    } catch (error) {
      // Set the phase explicitly: the merge in pushUpdateStatus would otherwise
      // keep a stale phase and the banner would name the wrong operation.
      pushUpdateStatus({ state: 'error', phase: lastUpdateStatus.state, message: String(error?.message ?? error).slice(0, 300) });
    }
    return { ...lastUpdateStatus, currentVersion: app.getVersion() };
  });
  ipcMain.handle('update:install', () => {
    if (!autoUpdater || lastUpdateStatus.state !== 'downloaded') return false;
    setImmediate(() => autoUpdater.quitAndInstall());
    return true;
  });

}

/** Re-run the analysis from the database when nothing is cached in memory. */
function rebuildAnalysis(database) {
  const rows = persist.loadAnalysisRows(database, {});
  if (!rows.length) throw new Error('لا توجد مديريات في قاعدة البيانات. أدخل البيانات يدويًا أو استورد ملفًا صالحًا.');
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
    installOfflineSessionGuard(session.defaultSession, { allowMainRequest: (details) => isAllowedRagflowRequest(details) });
    // A packaged build has no menu: the default menu exposes DevTools and file
    // dialogs that bypass the field policy.
    if (app.isPackaged) Menu.setApplicationMenu(null);
    registerHandlers();
    createWindow();
    setupAutoUpdate();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });
}

app.on('before-quit', (event) => {
  stopAutoUpdate();
  if (activeDocumentJobs.size && !drainingDocumentTasks) {
    event.preventDefault();
    drainingDocumentTasks = true;
    Promise.allSettled([...activeDocumentJobs.values()]).finally(() => {
      drainingDocumentTasks = false;
      app.quit();
    });
    return;
  }
  if (database) database.close();
  database = undefined;
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });