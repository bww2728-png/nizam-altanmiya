/* Smoke test: verify native + heavy deps load inside the Electron runtime. */
const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

const outFile = path.join(__dirname, 'smoke-result.json');

async function run() {
  const result = { electron: process.versions.electron, node: process.versions.node, modules: {} };
  try {
    const Database = require('better-sqlite3-multiple-ciphers');
    const db = new Database(':memory:');
    db.pragma("cipher = 'sqlcipher'");
    db.pragma("key = 'smoke-test-passphrase'");
    db.exec('CREATE TABLE t(x INTEGER); INSERT INTO t VALUES (7)');
    result.modules.sqlite = db.prepare('SELECT x FROM t').get().x;
    db.close();
  } catch (error) {
    result.modules.sqlite = 'FAIL: ' + error.message;
  }
  try {
    const { createCanvas } = require('@napi-rs/canvas');
    const canvas = createCanvas(8, 8);
    canvas.getContext('2d').fillRect(0, 0, 8, 8);
    result.modules.canvas = canvas.toBuffer('image/png').length > 0;
  } catch (error) {
    result.modules.canvas = 'FAIL: ' + error.message;
  }
  try {
    require('exceljs');
    require('mammoth');
    result.modules.office = true;
  } catch (error) {
    result.modules.office = 'FAIL: ' + error.message;
  }
  try {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    result.modules.pdfjs = typeof pdfjs.getDocument === 'function';
  } catch (error) {
    result.modules.pdfjs = 'FAIL: ' + error.message;
  }
  try {
    const tesseract = require('tesseract.js');
    const lang = require('@tesseract.js-data/ara');
    result.modules.tesseract = { createWorker: typeof tesseract.createWorker, langPath: Boolean(lang.langPath) };
  } catch (error) {
    result.modules.tesseract = 'FAIL: ' + error.message;
  }
  result.modules.store = null;
  try {
    const { openEncryptedStore, loadOrCreateStoreKey } = require(path.join(__dirname, '..', 'src', 'main', 'store.cjs'));
    const tmp = path.join(app.getPath('temp'), `smoke-${Date.now()}.db`);
    const keyFile = path.join(app.getPath('temp'), `smoke-${Date.now()}.key`);
    // Exercises the shipped flow: key generated once, then reused to reopen the same file.
    const generated = loadOrCreateStoreKey(keyFile);
    const store = openEncryptedStore(tmp, generated);
    store.exec('CREATE TABLE z(v TEXT)');
    store.prepare('INSERT INTO z VALUES (?)').run('ok');
    store.close();
    const reopened = openEncryptedStore(tmp, loadOrCreateStoreKey(keyFile));
    result.modules.store = { value: reopened.prepare('SELECT v FROM z').get().v, keyStable: loadOrCreateStoreKey(keyFile) === generated };
    reopened.close();
    fs.rmSync(tmp, { force: true });
    fs.rmSync(keyFile, { force: true });
  } catch (error) {
    result.modules.store = 'FAIL: ' + error.message;
  }
  fs.writeFileSync(outFile, JSON.stringify(result, null, 2), 'utf8');
  app.exit(0);
}

app.whenReady().then(run).catch((error) => {
  fs.writeFileSync(outFile, JSON.stringify({ fatal: error.message, stack: error.stack }, null, 2), 'utf8');
  app.exit(1);
});
