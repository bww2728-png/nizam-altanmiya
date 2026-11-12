const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3-multiple-ciphers');
const { openOrConvertStore, loadOrCreateStoreKey } = require('../src/main/store.cjs');

const SQLITE_HEADER = 'SQLite format 3\u0000';
/** The production entry point logs to the console by default; tests stay quiet. */
const silentLog = { info() {} };

function withTemporaryDirectory(callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'local-development-intelligence-'));
  const cleanup = () => fs.rmSync(directory, { recursive: true, force: true });
  try {
    const result = callback(directory);
    if (result && typeof result.then === 'function') return result.finally(cleanup);
    cleanup();
    return result;
  } catch (error) {
    cleanup();
    throw error;
  }
}

test('the production store is a plaintext SQLite file that persists data without a key', () => {
  withTemporaryDirectory((directory) => {
    const databasePath = path.join(directory, 'development-data.db');
    const keyPath = path.join(directory, 'store.key');

    const opened = openOrConvertStore(databasePath, { keyPath, log: silentLog });
    try {
      assert.equal(opened.converted, false);
      assert.equal(opened.wasEncrypted, false);
      opened.database.prepare('INSERT INTO import_batches(file_name,file_type,file_size,created_at) VALUES(?,?,?,?)')
        .run('test.xlsx', 'xlsx', 10, '2026-01-01T00:00:00.000Z');
    } finally {
      opened.database.close();
    }

    // On disk it is a plain SQLite database: no cipher, no key file beside it.
    assert.equal(fs.readFileSync(databasePath).subarray(0, 16).toString('latin1'), SQLITE_HEADER);
    assert.equal(fs.existsSync(keyPath), false, 'a plaintext store must not create a store.key');

    // Any SQLite tool can open it, with no key at all.
    const reopened = new Database(databasePath);
    try {
      assert.equal(reopened.prepare('SELECT COUNT(*) AS count FROM import_batches').get().count, 1);
    } finally {
      reopened.close();
    }
  });
});

test('loadOrCreateStoreKey reads an existing legacy key but never generates one', () => {
  withTemporaryDirectory((directory) => {
    const keyPath = path.join(directory, 'store.key');

    // A brand-new store needs no key: nothing is written and null is returned.
    assert.equal(loadOrCreateStoreKey(keyPath), null);
    assert.equal(fs.existsSync(keyPath), false, 'a new database must not be given a generated key');

    // An existing legacy key is still read back unchanged, for conversion or restore.
    const key = 'a'.repeat(64);
    fs.writeFileSync(keyPath, key + '\n', { mode: 0o600 });
    assert.equal(loadOrCreateStoreKey(keyPath), key);

    // A malformed key is an error, never silently replaced.
    fs.writeFileSync(keyPath, 'not-a-valid-key');
    assert.throws(() => loadOrCreateStoreKey(keyPath), /تالف/);
  });
});

/* ------------------------------------------------------------------ IPC level
 * `registerHandlers` is the only place that decides what the store is and what
 * happens to an unreadable file, so those two decisions are exercised here
 * through the real handlers. Electron is replaced by a stub whose `whenReady`
 * runs the startup callback synchronously, which makes every channel available
 * as soon as the module is loaded — the same registration the packaged app uses.
 * Loading main.cjs also installs the offline network guards for this test
 * process, exactly as the app does at startup; these tests use no network.
 */
const Module = require('node:module');

function createElectronStub(userDataPath, handlers) {
  const noop = () => {};
  class BrowserWindowStub {
    constructor() {
      this.webContents = {
        setWindowOpenHandler: noop,
        on: noop,
        send: noop,
        isDestroyed: () => false,
        openDevTools: noop,
        closeDevTools: noop,
      };
    }
    once() {}
    loadFile() {}
    loadURL() {}
    show() {}
    focus() {}
    restore() {}
    isMinimized() { return false; }
    isDestroyed() { return false; }
    static getAllWindows() { return []; }
  }
  return {
    app: {
      getPath: () => userDataPath,
      isPackaged: false,
      requestSingleInstanceLock: () => true,
      whenReady: () => ({ then: (callback) => { callback(); return { catch() {} }; }, catch() {} }),
      on: noop,
      quit: noop,
    },
    BrowserWindow: BrowserWindowStub,
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    Menu: { setApplicationMenu: noop },
    net: { fetch: async () => { throw new Error('network access is not available in tests'); }, request: noop },
    safeStorage: { isEncryptionAvailable: () => false, decryptString: () => '' },
    session: { defaultSession: {} },
  };
}

/** Load main.cjs against `userDataPath` and return its IPC handlers. */
function loadMainHandlers(userDataPath) {
  const handlers = new Map();
  const electron = createElectronStub(userDataPath, handlers);
  const mainPath = require.resolve('../src/main/main.cjs');
  const originalLoad = Module._load;
  Module._load = function patched(request, parent, isMain) {
    if (request === 'electron') return electron;
    if (request === 'electron-updater') {
      // A packaged-only dependency: keep the updater out of the load path.
      const error = new Error('electron-updater is not installed in the test environment');
      error.code = 'MODULE_NOT_FOUND';
      throw error;
    }
    return originalLoad.apply(this, arguments);
  };
  try {
    delete require.cache[mainPath];
    require(mainPath);
  } finally {
    Module._load = originalLoad;
  }
  return handlers;
}

/** A valid SQLite database that is not ours: another application's file. */
function writeForeignDatabase(filePath) {
  const foreign = new Database(filePath);
  try {
    foreign.exec('CREATE TABLE notes(id INTEGER PRIMARY KEY, body TEXT)');
    foreign.prepare('INSERT INTO notes(body) VALUES(?)').run('belongs to another application');
  } finally {
    foreign.close();
  }
}

test('db:open refuses an unrecognised file instead of replacing it with an empty store', () => {
  withTemporaryDirectory((directory) => {
    const databasePath = path.join(directory, 'development-data.db');
    writeForeignDatabase(databasePath);
    const before = fs.readFileSync(databasePath);
    const handlers = loadMainHandlers(directory);
    const open = handlers.get('db:open');
    assert.equal(typeof open, 'function', 'db:open must be registered');

    assert.throws(() => open(), (error) => {
      assert.ok(error.message.includes(databasePath), 'الخطأ يجب أن يذكر مسار الملف كاملًا');
      assert.match(error.message, /ليس قاعدة بيانات معروفة لهذا التطبيق/);
      assert.match(error.message, /انقل الملف يدويًا/);
      assert.match(error.message, /لم يُعدّل التطبيق الملف/);
      return true;
    }, 'a foreign file must fail db:open explicitly');

    // Nothing was modified, replaced, staged beside it or quarantined: the file
    // is byte-identical and still the other application's database.
    assert.deepEqual(fs.readFileSync(databasePath), before);
    assert.deepEqual(fs.readdirSync(directory), ['development-data.db'], 'no staged or quarantined file may appear');
    const reopened = new Database(databasePath);
    try {
      assert.equal(reopened.prepare('SELECT COUNT(*) AS count FROM notes').get().count, 1);
    } finally {
      reopened.close();
    }
  });
});

test('app:status reports neither plaintext nor encrypted for a foreign file', () => {
  withTemporaryDirectory((directory) => {
    writeForeignDatabase(path.join(directory, 'development-data.db'));
    const status = loadMainHandlers(directory).get('app:status')();
    assert.equal(status.hasDatabase, true);
    assert.equal(status.unlocked, false);
    assert.equal(status.plaintext, false, 'a foreign file is not our plaintext store');
    assert.equal(status.encrypted, false, 'a foreign file must not be advertised as encrypted');
  });
});

test('app:status reports neither plaintext nor encrypted for a corrupt store', () => {
  withTemporaryDirectory((directory) => {
    const databasePath = path.join(directory, 'development-data.db');
    const keyPath = path.join(directory, 'store.key');
    const created = openOrConvertStore(databasePath, { keyPath, log: silentLog });
    created.database.close();
    // Truncating a real store keeps its header but destroys the b-tree, which is
    // exactly the "malformed" case classifyStore must not call encrypted.
    fs.truncateSync(databasePath, 1024);

    const handlers = loadMainHandlers(directory);
    const status = handlers.get('app:status')();
    assert.equal(status.hasDatabase, true);
    assert.equal(status.plaintext, false);
    assert.equal(status.encrypted, false, 'a corrupt file must not be advertised as encrypted');

    assert.throws(() => handlers.get('db:open')(), /تالفة/);
  });
});

test('app:status reports a plaintext store as plaintext and not encrypted', () => {
  withTemporaryDirectory((directory) => {
    const databasePath = path.join(directory, 'development-data.db');
    const keyPath = path.join(directory, 'store.key');
    const created = openOrConvertStore(databasePath, { keyPath, log: silentLog });
    created.database.close();

    const status = loadMainHandlers(directory).get('app:status')();
    assert.equal(status.hasDatabase, true);
    assert.equal(status.plaintext, true);
    assert.equal(status.encrypted, false);
    assert.equal(status.hasKey, false, 'a plaintext store keeps no legacy key');
  });
});
