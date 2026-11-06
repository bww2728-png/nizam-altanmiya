const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const ExcelJS = require('exceljs');
const { openEncryptedStore, loadOrCreateStoreKey } = require('./store.cjs');
const { extractFile } = require('./importers.cjs');
const { saveImportBatch, updateReviewItem, resolveReviewItems } = require('./repository.cjs');

let mainWindow;
let database;

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
    if (database) return { success: true };
    // A database created by the earlier passphrase-protected build cannot be read with the
    // generated key. Fail with an actionable message instead of a raw SQLCipher error.
    if (hasUsableDatabase() && !fs.existsSync(getStoreKeyPath())) {
      throw new Error(
        'قاعدة البيانات الموجودة مشفّرة بمفتاح قديم غير متاح على هذا الجهاز. انقل ملف development-data.db من مجلد بيانات التطبيق إلى مكان آخر ثم أعد المحاولة لبدء قاعدة جديدة.'
      );
    }
    database = openDatabase();
    return { success: true };
  });
  ipcMain.handle('db:lock', () => {
    if (database) database.close();
    database = undefined;
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

app.whenReady().then(() => {
  registerHandlers();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('before-quit', () => {
  if (database) database.close();
  database = undefined;
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
