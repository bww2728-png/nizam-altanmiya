'use strict';

/**
 * Plaintext store contract.
 *
 * The product no longer encrypts the store: `development-data.db` is an ordinary
 * SQLite file that any tool can open with no key. `store.key` survives only as
 * legacy material, used to convert an old encrypted store once and to restore an
 * old encrypted backup. These tests prove the new promises:
 *
 *   1. a new store is plaintext on disk and needs no key;
 *   2. no key is ever generated for a new database;
 *   3. an encrypted store is converted in place, with a verified encrypted
 *      backup kept beside the file;
 *   4. conversion happens exactly once;
 *   5. an encrypted store without its key is refused and left byte-identical;
 *   6. plaintext backup/restore round-trips through a keyless file;
 *   7. a legacy encrypted bundle is still restorable;
 *   8. classifyStore tells the two modes apart;
 *   9. the converted store passes the shared strong verification helper, and
 *      that helper rejects a wrong expectation;
 *  10. an interrupted conversion is repaired from its marker: crash with a valid
 *      staging file, crash with only the kept encrypted original, and crash with
 *      nothing recoverable (never an empty database);
 *  11. a failed conversion puts the encrypted original back and deletes the
 *      copied key material;
 *  12. reopening a converted store adds no backup, no sidecar and no leftover;
 *  13. a marker may not point outside the store directory, and neither a stale
 *      rollback group nor a staging copy is ever silently discarded while the
 *      live store is absent — no empty database is created over recoverable data;
 *  14. a plaintext live store guarded by a marker is opened only after the strong
 *      verification, so an unverified copy left by a locked rollback is refused at
 *      the next start, and a failed conversion never claims the encrypted original
 *      is back at the live path when it is not;
 *  15. a kept encrypted original (`<store>.encrypted-*.bak`) with no live store is
 *      named in the refusal, while a successful conversion — which keeps such a
 *      file beside a usable live store — never trips that guard.
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3-multiple-ciphers');

const {
  openStore,
  openEncryptedStore,
  openOrConvertStore,
  exportStoreAsPlaintext,
  loadOrCreateStoreKey,
  classifyStore,
  verifyStoreIdentity,
  backupPlaintextStore,
  restorePlaintextBundle,
  restoreBackupBundle,
  copyStoreKey,
  listBackups,
} = require('../src/main/store.cjs');

const SQLITE_HEADER = 'SQLite format 3\u0000';
/** The production entry point logs to the console by default; tests stay quiet. */
const silentLog = { info() {} };
/** Name of the marker a crash-safe conversion writes before it swaps files. */
const MARKER_SUFFIX = '.plaintext-conversion.json';

function withTemporaryDirectory(callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ldi-plaintext-store-'));
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

function readHeader(filePath) {
  return fs.readFileSync(filePath).subarray(0, 16).toString('latin1');
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function listFiles(directory) {
  return fs.readdirSync(directory).sort();
}

/** Table list and row count per table, through whatever connection is handed in. */
function snapshotShape(database) {
  const tables = database
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((row) => row.name);
  const counts = {};
  for (const name of tables) {
    const identifier = '"' + String(name).replaceAll('"', '""') + '"';
    counts[name] = Number(database.prepare(`SELECT count(*) AS count FROM ${identifier}`).get().count);
  }
  return { tables, counts };
}

/** Open a legacy encrypted store read-only with its key. */
function openEncryptedReadonly(filePath, key) {
  const database = new Database(filePath, { readonly: true, timeout: 5000 });
  database.pragma("cipher = 'sqlcipher'");
  database.pragma(`key = '${String(key).replaceAll("'", "''")}'`);
  return database;
}

/**
 * Create a legacy encrypted store, exactly as an earlier build of the app did:
 * `openEncryptedStore` plus a valid 64-hex `store.key` beside it.
 */
function createEncryptedStore(directory, { name = 'development-data.db', key = 'a'.repeat(64) } = {}) {
  const databasePath = path.join(directory, name);
  const keyPath = path.join(directory, 'store.key');
  const database = openEncryptedStore(databasePath, key);
  database.prepare('INSERT INTO import_batches(file_name,file_type,file_size,created_at) VALUES(?,?,?,?)')
    .run('legacy.xlsx', 'xlsx', 128, '2026-01-01T00:00:00.000Z');
  database.prepare('INSERT INTO directorates(district,governorate,population,updated_at) VALUES(?,?,?,?)')
    .run('مديرية الشعر', 'إب', 43739, '2026-01-01T00:00:00.000Z');
  database.close();
  fs.writeFileSync(keyPath, key + '\n', { mode: 0o600 });
  return { databasePath, keyPath, key };
}

test('a brand-new store created through the production entry point is plaintext on disk', () => {
  withTemporaryDirectory((directory) => {
    const databasePath = path.join(directory, 'development-data.db');
    const keyPath = path.join(directory, 'store.key');

    const opened = openOrConvertStore(databasePath, { keyPath, log: silentLog });
    try {
      assert.equal(opened.converted, false);
      assert.equal(opened.wasEncrypted, false);
      // The first 16 bytes are the SQLite magic string: this is a plain file.
      assert.equal(readHeader(databasePath), SQLITE_HEADER);
      opened.database.prepare('INSERT INTO import_batches(file_name,file_type,file_size,created_at) VALUES(?,?,?,?)')
        .run('new.xlsx', 'xlsx', 10, '2026-01-01T00:00:00.000Z');
    } finally {
      opened.database.close();
    }

    // No key file may appear next to a plaintext store.
    assert.equal(fs.existsSync(keyPath), false, 'a plaintext store must not create a store.key');

    // It opens with a brand-new, keyless connection.
    const plain = new Database(databasePath);
    try {
      assert.equal(plain.prepare('SELECT COUNT(*) AS count FROM import_batches').get().count, 1);
    } finally {
      plain.close();
    }
  });
});

test('loadOrCreateStoreKey never generates or writes a key for a new database', () => {
  withTemporaryDirectory((directory) => {
    const keyPath = path.join(directory, 'store.key');
    assert.equal(loadOrCreateStoreKey(keyPath), null);
    assert.equal(loadOrCreateStoreKey(keyPath, { databaseExists: false }), null);
    assert.equal(fs.existsSync(keyPath), false, 'no key file may be written');
    assert.deepEqual(listFiles(directory), [], 'nothing else may be written either');
  });
});

test('an encrypted store is converted in place to plaintext, keeping a verified encrypted backup', () => {
  withTemporaryDirectory((directory) => {
    const { databasePath, keyPath, key } = createEncryptedStore(directory);

    // Capture the source shape through its key, before conversion.
    const source = openEncryptedReadonly(databasePath, key);
    let before;
    try {
      before = snapshotShape(source);
    } finally {
      source.close();
    }

    const opened = openOrConvertStore(databasePath, { keyPath, log: silentLog });
    try {
      assert.equal(opened.converted, true, 'the first open must report a conversion');
      assert.equal(opened.wasEncrypted, true);
      assert.ok(opened.backupPath, 'a recoverable backup path must be returned');

      // The live file is now plaintext, with the same tables and rows.
      assert.equal(readHeader(databasePath), SQLITE_HEADER);
      const after = snapshotShape(opened.database);
      assert.deepEqual(after.tables, before.tables, 'the table list must be identical');
      assert.deepEqual(after.counts, before.counts, 'every table must keep its row count');
      assert.equal(
        opened.database.prepare('SELECT population FROM directorates WHERE district=?').get('مديرية الشعر').population,
        43739,
      );
      const integrity = opened.database.pragma('integrity_check');
      assert.equal(integrity.length, 1);
      assert.equal(Object.values(integrity[0])[0], 'ok');
      assert.deepEqual(opened.database.pragma('foreign_key_check'), []);
    } finally {
      opened.database.close();
    }

    // A keyless connection reads the converted file.
    const plain = new Database(databasePath);
    try {
      assert.equal(plain.prepare('SELECT COUNT(*) AS count FROM import_batches').get().count, 1);
    } finally {
      plain.close();
    }

    // The encrypted original is kept beside the file, with its key, and still opens.
    const kept = listFiles(directory)
      .filter((name) => name.startsWith('development-data.db.encrypted-') && name.endsWith('.bak'));
    assert.equal(kept.length, 1, 'exactly one encrypted original must be kept');
    const keptPath = path.join(directory, kept[0]);
    assert.equal(fs.existsSync(keptPath + '.key'), true, 'the encrypted original keeps its key');
    assert.equal(readHeader(keptPath) === SQLITE_HEADER, false, 'the kept original must stay encrypted');
    const recovered = openEncryptedReadonly(keptPath, key);
    try {
      assert.deepEqual(snapshotShape(recovered).tables, before.tables, 'the kept original is intact');
      assert.equal(
        recovered.prepare('SELECT population FROM directorates WHERE district=?').get('مديرية الشعر').population,
        43739,
      );
    } finally {
      recovered.close();
    }
  });
});

test('opening a converted store again does not convert or back up a second time', () => {
  withTemporaryDirectory((directory) => {
    const { databasePath, keyPath } = createEncryptedStore(directory);

    const first = openOrConvertStore(databasePath, { keyPath, log: silentLog });
    first.database.close();
    assert.equal(listBackups(databasePath).length, 1, 'the one-time conversion takes exactly one backup');
    const filesAfterFirst = listFiles(directory);

    const second = openOrConvertStore(databasePath, { keyPath, log: silentLog });
    try {
      assert.equal(second.converted, false);
      assert.equal(second.wasEncrypted, false);
      assert.equal(second.backupPath, null);
      assert.equal(second.database.prepare('SELECT COUNT(*) AS count FROM import_batches').get().count, 1);
    } finally {
      second.database.close();
    }

    assert.equal(listBackups(databasePath).length, 1, 'no second backup may be created');
    assert.deepEqual(listFiles(directory), filesAfterFirst, 'a plaintext reopen adds no file at all');
  });
});

test('an encrypted store whose key file is missing is refused and left byte-identical', () => {
  withTemporaryDirectory((directory) => {
    const databasePath = path.join(directory, 'development-data.db');
    const keyPath = path.join(directory, 'store.key');
    const key = 'b'.repeat(64);

    const database = openEncryptedStore(databasePath, key);
    database.prepare('INSERT INTO import_batches(file_name,file_type,file_size,created_at) VALUES(?,?,?,?)')
      .run('locked.xlsx', 'xlsx', 10, '2026-01-01T00:00:00.000Z');
    database.close();
    // The key file is deliberately NOT created.

    const beforeHash = sha256(databasePath);
    const beforeFiles = listFiles(directory);
    assert.equal(fs.existsSync(keyPath), false);

    assert.throws(() => openOrConvertStore(databasePath, { keyPath, log: silentLog }), /مشفّرة/);

    assert.equal(sha256(databasePath), beforeHash, 'the encrypted file must stay byte-identical');
    assert.equal(fs.existsSync(keyPath), false, 'no key file may be created');
    assert.deepEqual(listFiles(directory), beforeFiles, 'no extra file may be created');
  });
});

test('the plaintext backup helper round-trips through a keyless restore', () => {
  withTemporaryDirectory((directory) => {
    const databasePath = path.join(directory, 'development-data.db');

    const opened = openStore(databasePath);
    opened.prepare('INSERT INTO import_batches(file_name,file_type,file_size,created_at) VALUES(?,?,?,?)')
      .run('keep.xlsx', 'xlsx', 10, '2026-01-01T00:00:00.000Z');
    opened.close();

    const backup = backupPlaintextStore(databasePath);
    assert.ok(backup, 'a backup path must be returned');
    assert.equal(readHeader(backup), SQLITE_HEADER, 'the backup is plaintext');
    assert.equal(fs.existsSync(backup + '.key'), false, 'a plaintext backup carries no key');

    // The backup opens without any key.
    const check = new Database(backup, { readonly: true });
    try {
      assert.equal(check.prepare('SELECT COUNT(*) AS count FROM import_batches').get().count, 1);
    } finally {
      check.close();
    }

    // Change the live store, then restore the backup over it.
    const live = openStore(databasePath);
    live.prepare('INSERT INTO import_batches(file_name,file_type,file_size,created_at) VALUES(?,?,?,?)')
      .run('extra.xlsx', 'xlsx', 10, '2026-01-02T00:00:00.000Z');
    live.close();

    const restored = restorePlaintextBundle(backup, databasePath);
    assert.equal(restored.restoredPath, databasePath);

    const after = new Database(databasePath, { readonly: true });
    try {
      assert.equal(after.prepare('SELECT COUNT(*) AS count FROM import_batches').get().count, 1, 'the restore returns the backed-up state');
      assert.equal(after.prepare('SELECT file_name FROM import_batches').get().file_name, 'keep.xlsx');
    } finally {
      after.close();
    }
  });
});

test('a legacy encrypted backup bundle is still restorable through the legacy restore', () => {
  withTemporaryDirectory((directory) => {
    const livePath = path.join(directory, 'development-data.db');
    const liveKeyPath = path.join(directory, 'store.key');
    const backupPath = path.join(directory, 'development-data.db.2026-11-08.bak');
    const liveKey = 'c'.repeat(64);
    const backupKey = 'd'.repeat(64);

    const live = openEncryptedStore(livePath, liveKey);
    live.prepare('INSERT INTO import_batches(file_name,file_type,file_size,created_at) VALUES(?,?,?,?)')
      .run('live.xlsx', 'xlsx', 10, '2026-01-01T00:00:00.000Z');
    live.close();
    fs.writeFileSync(liveKeyPath, liveKey, { mode: 0o600 });

    const backup = openEncryptedStore(backupPath, backupKey);
    backup.prepare('INSERT INTO import_batches(file_name,file_type,file_size,created_at) VALUES(?,?,?,?)')
      .run('from-backup.xlsx', 'xlsx', 10, '2026-01-01T00:00:00.000Z');
    backup.close();
    const sourceKeyPath = path.join(directory, 'source.key');
    fs.writeFileSync(sourceKeyPath, backupKey, { mode: 0o600 });
    copyStoreKey(sourceKeyPath, backupPath + '.key');

    const restored = restoreBackupBundle(backupPath, livePath, liveKeyPath);
    assert.equal(restored.restoredPath, livePath);
    assert.equal(fs.readFileSync(liveKeyPath, 'utf8').trim(), backupKey, 'the restored bundle brings its own key');

    const opened = openEncryptedStore(livePath, backupKey);
    try {
      assert.equal(opened.prepare('SELECT file_name FROM import_batches').get().file_name, 'from-backup.xlsx');
    } finally {
      opened.close();
    }
  });
});

test('classifyStore tells a plaintext store apart from an encrypted one', () => {
  withTemporaryDirectory((directory) => {
    const plainPath = path.join(directory, 'plain.db');
    const plain = openStore(plainPath);
    plain.close();
    const plainVerdict = classifyStore(plainPath, null);
    assert.equal(plainVerdict.ok, true);
    assert.equal(plainVerdict.reason, 'plaintext');

    const encryptedPath = path.join(directory, 'encrypted.db');
    const key = 'e'.repeat(64);
    const encrypted = openEncryptedStore(encryptedPath, key);
    encrypted.close();

    const keyless = classifyStore(encryptedPath, null);
    assert.equal(keyless.ok, false);
    assert.equal(keyless.reason, 'encrypted');

    const keyed = classifyStore(encryptedPath, key);
    assert.equal(keyed.ok, true);
    assert.equal(keyed.reason, 'readable');
  });
});

test('exportStoreAsPlaintext writes a verified copy without touching the encrypted source', () => {
  withTemporaryDirectory((directory) => {
    const { databasePath, keyPath } = createEncryptedStore(directory);
    const sourceHash = sha256(databasePath);

    const result = exportStoreAsPlaintext(databasePath, { keyPath });
    assert.equal(readHeader(result.outputPath), SQLITE_HEADER, 'the exported file is plaintext');
    assert.ok(result.tables.includes('directorates') && result.tables.includes('import_batches'));
    assert.ok(result.rows >= 2);

    const plain = new Database(result.outputPath, { readonly: true });
    try {
      assert.equal(
        plain.prepare('SELECT population FROM directorates WHERE district=?').get('مديرية الشعر').population,
        43739,
      );
    } finally {
      plain.close();
    }

    assert.equal(sha256(databasePath), sourceHash, 'the source is only read, never changed');
    assert.equal(classifyStore(databasePath, null).reason, 'encrypted', 'the source stays encrypted');
  });
});

// ---------------------------------------------------------------------------
// Defect 1 / defect 3 — crash-safety, marker recovery and the shared strong
// verification helper.
// ---------------------------------------------------------------------------

/** The shape of an encrypted store, read through its legacy key. */
function encryptedShape(databasePath, key) {
  const database = openEncryptedReadonly(databasePath, key);
  try {
    return snapshotShape(database);
  } finally {
    database.close();
  }
}

/** The { tables, counts, rows } expectation a conversion marker records. */
function expectationOf(shape) {
  return {
    tables: shape.tables,
    counts: shape.counts,
    rows: Object.values(shape.counts).reduce((total, count) => total + count, 0),
  };
}

/** Write the same marker the production swap writes, then return its path. */
function writeCrashMarker(databasePath, { stagingPath, keptEncryptedPath, keyPath, expected }) {
  const markerPath = databasePath + MARKER_SUFFIX;
  fs.writeFileSync(markerPath, JSON.stringify({
    stagingPath,
    keptEncryptedPath,
    keyPath,
    targetPath: databasePath,
    createdAt: new Date().toISOString(),
    expected,
  }, null, 2));
  return markerPath;
}

/** SQLite sidecar files, which a plaintext store must never leave behind. */
function sidecars(directory) {
  return listFiles(directory).filter((name) => /-(wal|shm|journal)$/.test(name));
}

test('the converted store passes the shared strong verification helper', () => {
  withTemporaryDirectory((directory) => {
    const { databasePath, keyPath, key } = createEncryptedStore(directory);
    const before = encryptedShape(databasePath, key);
    const expected = { tables: before.tables, counts: before.counts };

    const opened = openOrConvertStore(databasePath, { keyPath, log: silentLog });
    try {
      const identity = verifyStoreIdentity(databasePath, null, expected, {
        requirePlaintext: true,
        label: 'اختبار',
      });
      assert.deepEqual(identity.tables, before.tables);
      assert.deepEqual(identity.counts, before.counts);
      assert.equal(identity.rows >= 2, true);
      assert.equal(Array.isArray(identity.sql) && identity.sql.length > 0, true, 'the sqlite_master SQL set is part of the identity');

      // The helper must not be vacuous: a wrong expectation has to be rejected.
      assert.throws(
        () => verifyStoreIdentity(databasePath, null, { tables: before.tables, counts: { ...before.counts, directorates: 999 } }, { requirePlaintext: true, label: 'اختبار' }),
        /عدد صفوف الجدول/,
      );
      // A plain SQLite file that is not ours must be refused as well.
      const foreignPath = path.join(directory, 'foreign.db');
      const foreign = new Database(foreignPath);
      foreign.exec('CREATE TABLE other(id INTEGER PRIMARY KEY)');
      foreign.close();
      assert.throws(
        () => verifyStoreIdentity(foreignPath, null, null, { requirePlaintext: true, label: 'اختبار' }),
        /لا يحتوي جداول النظام/,
      );
    } finally {
      opened.database.close();
    }
  });
});

test('crash mid-swap with a valid staging file is repaired from the marker', () => {
  withTemporaryDirectory((directory) => {
    const { databasePath, keyPath, key } = createEncryptedStore(directory);
    const before = encryptedShape(databasePath, key);

    // Stage exactly what the production conversion stages, then simulate the
    // crash: the marker is written and the live file is gone mid-swap.
    const staged = exportStoreAsPlaintext(databasePath, { keyPath });
    const keptEncrypted = `${databasePath}.encrypted-crash.bak`;
    fs.copyFileSync(databasePath, keptEncrypted);
    const markerPath = writeCrashMarker(databasePath, {
      stagingPath: staged.outputPath,
      keptEncryptedPath: keptEncrypted,
      keyPath,
      expected: expectationOf(before),
    });
    fs.rmSync(databasePath);
    assert.equal(fs.existsSync(databasePath), false, 'the crash left no live store');

    const opened = openOrConvertStore(databasePath, { keyPath, log: silentLog });
    try {
      assert.equal(opened.converted, false, 'recovery is not a conversion');
      assert.equal(opened.recoveredFrom, 'plaintext-staging');
      assert.equal(readHeader(databasePath), SQLITE_HEADER);
      assert.ok(fs.statSync(databasePath).size > 0, 'never an empty store');
      const after = snapshotShape(opened.database);
      assert.deepEqual(after.tables, before.tables);
      assert.deepEqual(after.counts, before.counts, 'every row survives the recovered swap');
      verifyStoreIdentity(databasePath, null, { tables: before.tables, counts: before.counts }, {
        requirePlaintext: true,
        label: 'اختبار',
      });
    } finally {
      opened.database.close();
    }

    assert.equal(fs.existsSync(markerPath), false, 'the marker is consumed by recovery');
    assert.equal(fs.existsSync(staged.outputPath), false, 'the staging file moved into place');
    assert.equal(fs.existsSync(keptEncrypted), true, 'the kept encrypted original stays for the user');
    assert.deepEqual(sidecars(directory), [], 'no sidecar file may be left behind');
  });
});

test('crash mid-swap with no staging restores the kept encrypted original and converts once', () => {
  withTemporaryDirectory((directory) => {
    const { databasePath, keyPath, key } = createEncryptedStore(directory);
    const before = encryptedShape(databasePath, key);

    const keptEncrypted = `${databasePath}.encrypted-crash.bak`;
    fs.copyFileSync(databasePath, keptEncrypted);
    copyStoreKey(keyPath, keptEncrypted + '.key');
    const markerPath = writeCrashMarker(databasePath, {
      stagingPath: `${databasePath}.plaintext-missing.db`,
      keptEncryptedPath: keptEncrypted,
      keyPath,
      expected: expectationOf(before),
    });
    fs.rmSync(databasePath);

    const opened = openOrConvertStore(databasePath, { keyPath, log: silentLog });
    try {
      assert.equal(opened.recoveredFrom, 'encrypted-backup');
      assert.equal(opened.converted, true, 'the restored encrypted store is converted once');
      assert.equal(opened.wasEncrypted, true);
      assert.equal(readHeader(databasePath), SQLITE_HEADER);
      assert.ok(fs.statSync(databasePath).size > 0, 'never an empty store');
      const after = snapshotShape(opened.database);
      assert.deepEqual(after.tables, before.tables);
      assert.deepEqual(after.counts, before.counts, 'every row survives the restored backup');
      verifyStoreIdentity(databasePath, null, { tables: before.tables, counts: before.counts }, {
        requirePlaintext: true,
        label: 'اختبار',
      });
    } finally {
      opened.database.close();
    }

    assert.equal(fs.existsSync(markerPath), false, 'the marker is consumed');
    assert.equal(fs.existsSync(keptEncrypted), false, 'the kept copy moved back to the live path');
    assert.equal(fs.existsSync(keptEncrypted + '.key'), false, 'its copied key goes with it');
    const kept = listFiles(directory)
      .filter((name) => name.startsWith('development-data.db.encrypted-') && name.endsWith('.bak'));
    assert.equal(kept.length, 1, 'the re-conversion keeps exactly one encrypted original');
    assert.deepEqual(sidecars(directory), []);
  });
});

test('an unrecoverable interrupted swap never bootstraps an empty database', () => {
  withTemporaryDirectory((directory) => {
    const databasePath = path.join(directory, 'development-data.db');
    const keyPath = path.join(directory, 'store.key');

    // Nothing live, no staging, no kept encrypted original: refuse, explicitly.
    const markerPath = writeCrashMarker(databasePath, {
      stagingPath: `${databasePath}.plaintext-gone.db`,
      keptEncryptedPath: `${databasePath}.encrypted-gone.bak`,
      keyPath,
      expected: { tables: ['import_batches', 'directorates'], counts: { import_batches: 1, directorates: 1 }, rows: 2 },
    });
    assert.throws(
      () => openOrConvertStore(databasePath, { keyPath, log: silentLog }),
      /انقطع تحويل سابق/,
    );
    assert.equal(fs.existsSync(databasePath), false, 'no empty database may be created');
    assert.equal(fs.existsSync(markerPath), true, 'the marker is kept so a human can act');

    // A marker that cannot be parsed is the same refusal, not a silent reset.
    fs.writeFileSync(markerPath, '{ this is not json');
    assert.throws(
      () => openOrConvertStore(databasePath, { keyPath, log: silentLog }),
      /علامة التحويل/,
    );
    assert.equal(fs.existsSync(databasePath), false, 'still no empty database');
  });
});

test('a failed conversion restores the encrypted original and deletes the copied key', () => {
  withTemporaryDirectory((directory) => {
    const { databasePath, keyPath, key } = createEncryptedStore(directory);
    const before = encryptedShape(databasePath, key);
    const markerPath = databasePath + MARKER_SUFFIX;

    // Deterministic fault injection: the single swap rename throws, exactly like
    // a crash between "live file removed" and "plaintext in place".
    const originalRename = fs.renameSync;
    let injected = false;
    fs.renameSync = function patchedRename(from, to) {
      if (!injected && String(to) === databasePath && String(from).includes('.plaintext-')) {
        injected = true;
        throw new Error('simulated crash during the swap');
      }
      return originalRename.call(fs, from, to);
    };
    try {
      assert.throws(
        () => openOrConvertStore(databasePath, { keyPath, log: silentLog }),
        /فشل تحويل قاعدة البيانات المشفّرة/,
      );
    } finally {
      fs.renameSync = originalRename;
    }

    assert.equal(injected, true, 'the injection must have hit the swap');
    assert.equal(fs.existsSync(databasePath), true, 'the encrypted original is back at the live path');
    assert.equal(classifyStore(databasePath, key).ok, true, 'and it still opens with its key');
    const restored = openEncryptedReadonly(databasePath, key);
    try {
      assert.deepEqual(snapshotShape(restored).counts, before.counts, 'no row is lost');
    } finally {
      restored.close();
    }

    assert.equal(fs.existsSync(markerPath), false, 'the marker goes once the live path holds a valid store');
    assert.deepEqual(
      listFiles(directory).filter((name) => name.endsWith('.key')),
      ['store.key'],
      'the copied key must be deleted when the conversion fails',
    );
    assert.deepEqual(
      listFiles(directory).filter((name) => name.includes('.plaintext-')),
      [],
      'no staging leftover may survive',
    );

    // A later open converts normally, once.
    const opened = openOrConvertStore(databasePath, { keyPath, log: silentLog });
    try {
      assert.equal(opened.converted, true);
      assert.equal(readHeader(databasePath), SQLITE_HEADER);
      assert.deepEqual(snapshotShape(opened.database).counts, before.counts);
    } finally {
      opened.database.close();
    }
  });
});

test('reopening a converted store adds no backup, no sidecar and no leftover', () => {
  withTemporaryDirectory((directory) => {
    const { databasePath, keyPath } = createEncryptedStore(directory);

    const first = openOrConvertStore(databasePath, { keyPath, log: silentLog });
    first.database.close();
    const backupsAfterFirst = listBackups(databasePath).length;
    const filesAfterFirst = listFiles(directory);
    assert.equal(backupsAfterFirst, 1, 'the conversion takes exactly one backup');

    const second = openOrConvertStore(databasePath, { keyPath, log: silentLog });
    try {
      assert.equal(second.converted, false);
      assert.equal(second.wasEncrypted, false);
      assert.equal(second.recoveredFrom, null);
      assert.equal(second.backupPath, null);
      assert.equal(second.database.prepare('SELECT COUNT(*) AS count FROM import_batches').get().count, 1);
    } finally {
      second.database.close();
    }

    assert.equal(listBackups(databasePath).length, backupsAfterFirst, 'no second backup may be created');
    assert.deepEqual(listFiles(directory), filesAfterFirst, 'a plaintext reopen adds no file at all');
    assert.deepEqual(sidecars(directory), [], 'no SQLite sidecar may linger beside a plaintext store');
    assert.deepEqual(
      listFiles(directory).filter((name) => name.includes('.plaintext-') || name.includes('.restore-') || name.includes('.rollback-')),
      [],
      'no staging, restore or rollback leftover may remain',
    );
  });
});

// ---------------------------------------------------------------------------
// Defect 2 / defect 3 / defect 4 — leftovers are never silently discarded, a
// marker may not point outside the store directory, and a failure before the
// swap leaves the live encrypted store byte-identical.
// ---------------------------------------------------------------------------

test('a stale marker beside a valid store is dropped without converting or resetting', () => {
  withTemporaryDirectory((directory) => {
    const databasePath = path.join(directory, 'development-data.db');
    const keyPath = path.join(directory, 'store.key');

    // A valid plaintext store is already in place.
    const created = openStore(databasePath);
    created.prepare('INSERT INTO import_batches(file_name,file_type,file_size,created_at) VALUES(?,?,?,?)')
      .run('live.xlsx', 'xlsx', 10, '2026-01-01T00:00:00.000Z');
    created.close();
    const liveHash = sha256(databasePath);

    // A stale marker from an unfinished earlier conversion, plus its staging copy.
    // Its expectation is the real, full fingerprint the production marker records
    // (every table with its row count), because recovery now applies the strong
    // verification to a plaintext live store.
    const liveShape = (() => {
      const reader = new Database(databasePath, { readonly: true });
      try {
        return snapshotShape(reader);
      } finally {
        reader.close();
      }
    })();
    const staleStaging = `${databasePath}.plaintext-stale.db`;
    fs.copyFileSync(databasePath, staleStaging);
    const markerPath = writeCrashMarker(databasePath, {
      stagingPath: staleStaging,
      keptEncryptedPath: `${databasePath}.encrypted-stale.bak`,
      keyPath,
      expected: expectationOf(liveShape),
    });

    const opened = openOrConvertStore(databasePath, { keyPath, log: silentLog });
    try {
      assert.equal(opened.converted, false, 'a valid live store is never converted');
      assert.equal(opened.wasEncrypted, false);
      assert.equal(opened.recoveredFrom, null, 'recovery (a) keeps the live store and reports no recovery');
      assert.equal(opened.database.prepare('SELECT COUNT(*) AS count FROM import_batches').get().count, 1);
      assert.equal(sha256(databasePath), liveHash, 'the live store is not rewritten by the stale marker');
    } finally {
      opened.database.close();
    }

    assert.equal(fs.existsSync(markerPath), false, 'the stale marker is consumed');
    assert.equal(fs.existsSync(staleStaging), false, 'the staging leftover is removed');
    assert.equal(fs.existsSync(databasePath), true, 'the live store stays');
    assert.ok(fs.statSync(databasePath).size > 0, 'never an empty database');
  });
});

test('rollback leftovers with no live store are refused instead of bootstrapping an empty database', () => {
  withTemporaryDirectory((directory) => {
    const databasePath = path.join(directory, 'development-data.db');
    const keyPath = path.join(directory, 'store.key');

    // Simulate a failed restore whose rollbackMoves swallowed its errors: the
    // only local copy of the data is a `.rollback-*` group (plus a stray staged
    // `.plaintext-*` copy). There is no live database at all.
    const rollbackCopy = `${databasePath}.rollback-4242-abcdef`;
    const seeded = openStore(rollbackCopy);
    seeded.prepare('INSERT INTO import_batches(file_name,file_type,file_size,created_at) VALUES(?,?,?,?)')
      .run('rollback.xlsx', 'xlsx', 10, '2026-01-01T00:00:00.000Z');
    seeded.close();
    const rollbackHash = sha256(rollbackCopy);

    const staleStaging = `${databasePath}.plaintext-9999.db`;
    fs.copyFileSync(rollbackCopy, staleStaging);
    const staleStagingHash = sha256(staleStaging);

    let message = '';
    assert.throws(
      () => openOrConvertStore(databasePath, { keyPath, log: silentLog }),
      (error) => { message = error.message; return true; },
    );

    assert.equal(fs.existsSync(databasePath), false, 'no empty database may be created');
    assert.equal(fs.existsSync(rollbackCopy), true, 'the rollback copy must survive');
    assert.equal(sha256(rollbackCopy), rollbackHash, 'the rollback copy must be untouched');
    assert.equal(fs.existsSync(staleStaging), true, 'the staged copy must survive');
    assert.equal(sha256(staleStaging), staleStagingHash, 'the staged copy must be untouched');
    assert.equal(fs.existsSync(keyPath), false, 'no key file may appear');
    assert.match(message, /قاعدة بيانات فارغة/, 'the refusal must be explicit about not creating an empty database');
    assert.ok(message.includes(rollbackCopy), 'the message must name the rollback artifact path');
    assert.ok(message.includes(staleStaging), 'the message must name the staged artifact path');
    assert.match(message, /[\u0600-\u06FF]/, 'the refusal must be Arabic');
  });
});

test('a conversion marker naming a path outside the store directory is refused and deletes nothing', () => {
  withTemporaryDirectory((directory) => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ldi-plaintext-outside-'));
    try {
      const databasePath = path.join(directory, 'development-data.db');
      const keyPath = path.join(directory, 'store.key');
      const outsideVictim = path.join(outside, 'precious.txt');
      fs.writeFileSync(outsideVictim, 'do-not-delete');
      const expected = { tables: ['directorates', 'import_batches'], counts: { directorates: 0, import_batches: 0 }, rows: 0 };

      // A hand-edited marker whose stagingPath escapes the store directory.
      let markerPath = writeCrashMarker(databasePath, {
        stagingPath: outsideVictim,
        keptEncryptedPath: `${databasePath}.encrypted-x.bak`,
        keyPath,
        expected,
      });
      let message = '';
      assert.throws(
        () => openOrConvertStore(databasePath, { keyPath, log: silentLog }),
        (error) => { message = error.message; return true; },
      );
      assert.match(message, /مسارات غير آمنة/, 'the refusal must say the marker paths are unsafe');
      assert.match(message, /[\u0600-\u06FF]/, 'the refusal must be Arabic');
      assert.equal(fs.existsSync(outsideVictim), true, 'the outside file must survive');
      assert.equal(fs.readFileSync(outsideVictim, 'utf8'), 'do-not-delete', 'and keep its bytes');
      assert.equal(fs.existsSync(markerPath), true, 'the suspicious marker is kept so a human can act');
      assert.equal(fs.existsSync(databasePath), false, 'no database may be created');

      // A marker whose keptEncryptedPath escapes the directory is refused too.
      markerPath = writeCrashMarker(databasePath, {
        stagingPath: `${databasePath}.plaintext-ok.db`,
        keptEncryptedPath: outsideVictim,
        keyPath,
        expected,
      });
      assert.throws(() => openOrConvertStore(databasePath, { keyPath, log: silentLog }), /مسارات غير آمنة/);
      assert.equal(fs.existsSync(outsideVictim), true, 'still not deleted');

      // ... and so is a marker whose targetPath is a different file.
      fs.writeFileSync(markerPath, JSON.stringify({
        stagingPath: `${databasePath}.plaintext-ok.db`,
        keptEncryptedPath: `${databasePath}.encrypted-ok.bak`,
        keyPath,
        targetPath: outsideVictim,
        createdAt: new Date().toISOString(),
        expected,
      }, null, 2));
      assert.throws(() => openOrConvertStore(databasePath, { keyPath, log: silentLog }), /مسارات غير آمنة/);
      assert.equal(fs.existsSync(outsideVictim), true, 'the outside file survives every variant');
      assert.equal(fs.existsSync(databasePath), false, 'still no database');
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

test('a failure before the swap leaves the live encrypted store byte-identical and no staging behind', () => {
  withTemporaryDirectory((directory) => {
    const { databasePath, keyPath, key } = createEncryptedStore(directory);
    const before = encryptedShape(databasePath, key);
    const liveHash = sha256(databasePath);
    const markerPath = databasePath + MARKER_SUFFIX;

    // Deterministic fault injection: keeping the encrypted copy fails (disk full
    // or EPERM from antivirus) AFTER writing a truncated copy — and strictly
    // BEFORE the live file is touched.
    const originalCopy = fs.copyFileSync;
    let injected = false;
    fs.copyFileSync = function patchedCopy(from, to, ...rest) {
      if (!injected && String(to).startsWith(databasePath + '.encrypted-')) {
        injected = true;
        fs.writeFileSync(String(to), 'truncated-copy');
        throw new Error('simulated EPERM while keeping the encrypted copy');
      }
      return originalCopy.call(fs, from, to, ...rest);
    };
    let message = '';
    try {
      assert.throws(
        () => openOrConvertStore(databasePath, { keyPath, log: silentLog }),
        (error) => { message = error.message; return true; },
      );
    } finally {
      fs.copyFileSync = originalCopy;
    }

    assert.equal(injected, true, 'the injection must have hit the kept encrypted copy');
    assert.equal(sha256(databasePath), liveHash, 'the live encrypted store must be byte-identical');
    assert.equal(readHeader(databasePath) === SQLITE_HEADER, false, 'it must still be encrypted');
    assert.equal(classifyStore(databasePath, key).ok, true, 'and still openable with its key');
    const reopened = openEncryptedReadonly(databasePath, key);
    try {
      assert.deepEqual(snapshotShape(reopened).counts, before.counts, 'no row is lost');
    } finally {
      reopened.close();
    }

    assert.deepEqual(
      listFiles(directory).filter((name) => name.includes('.plaintext-')),
      [],
      'no staging plaintext file may remain',
    );
    assert.deepEqual(
      listFiles(directory).filter((name) => name.includes('.encrypted-')),
      [],
      'a truncated kept copy must not be left looking like a recovery source',
    );
    assert.deepEqual(listFiles(directory).filter((name) => name.endsWith('.key')), ['store.key']);
    assert.equal(fs.existsSync(markerPath), false, 'the marker goes once the live path holds a valid store');

    // Truthful, Arabic, and it names the restored live path.
    assert.match(message, /فشل تحويل قاعدة البيانات المشفّرة/);
    assert.match(message, /[\u0600-\u06FF]/);
    assert.ok(message.includes(databasePath), 'the message must name the actual live path');
  });
});

test('a marker write failure (EEXIST) is reported in Arabic and leaves no plaintext copy behind', () => {
  withTemporaryDirectory((directory) => {
    const { databasePath, keyPath, key } = createEncryptedStore(directory);
    const liveHash = sha256(databasePath);
    const markerPath = databasePath + MARKER_SUFFIX;

    // Simulate "the marker already exists / is held by another process": the 'wx'
    // write fails with EEXIST, before anything is copied or swapped.
    const originalWrite = fs.writeFileSync;
    let injected = false;
    fs.writeFileSync = function patchedWrite(file, ...rest) {
      if (!injected && String(file) === markerPath) {
        injected = true;
        const error = new Error('EEXIST: file already exists, open ...');
        error.code = 'EEXIST';
        throw error;
      }
      return originalWrite.call(fs, file, ...rest);
    };
    let message = '';
    try {
      assert.throws(
        () => openOrConvertStore(databasePath, { keyPath, log: silentLog }),
        (error) => { message = error.message; return true; },
      );
    } finally {
      fs.writeFileSync = originalWrite;
    }

    assert.equal(injected, true, 'the injection must have hit the marker write');
    assert.equal(sha256(databasePath), liveHash, 'the live encrypted store is untouched');
    assert.equal(classifyStore(databasePath, key).ok, true, 'and still openable with its key');
    assert.deepEqual(
      listFiles(directory).filter((name) => name.includes('.plaintext-')),
      [],
      'the staged plaintext copy must never survive a throw',
    );
    assert.equal(fs.existsSync(markerPath), false, 'no marker may be left behind');
    assert.match(message, /علامة التحويل/, 'the error must name the marker file');
    assert.match(message, /[\u0600-\u06FF]/, 'the error must be Arabic');
    assert.match(message, /تحويل سابق/, 'and must explain that a previous conversion may still be pending');
  });
});

// ---------------------------------------------------------------------------
// Residual defect 1 — a failed conversion whose rollback is blocked by a file
// lock must never claim a restore, and the next start must refuse the
// unverified plaintext file instead of opening it silently.
// ---------------------------------------------------------------------------

test('a post-swap verification failure with a locked rollback never claims a restored original and is refused at the next start', () => {
  withTemporaryDirectory((directory) => {
    const { databasePath, keyPath, key } = createEncryptedStore(directory);
    const markerPath = databasePath + MARKER_SUFFIX;

    // The trap: a plaintext database that has our marker tables but the wrong
    // content. It passes the WEAK classification (header + markers) and fails only
    // the strong verification — exactly the file that must never be blessed.
    const decoyPath = `${databasePath}.decoy.db`;
    const decoy = openStore(decoyPath);
    decoy.close();
    assert.deepEqual(classifyStore(decoyPath, null), { ok: true, reason: 'plaintext' }, 'the decoy must pass the weak verdict');

    const originalRename = fs.renameSync;
    const originalRm = fs.rmSync;
    let swapped = false;
    // Plant the decoy as the "verified" staging file at the moment of the swap, so
    // the post-swap strong verification fails for a real content reason.
    fs.renameSync = function patchedRename(from, to) {
      if (String(to) === databasePath && String(from).includes('.plaintext-')) {
        fs.copyFileSync(decoyPath, String(from));
        swapped = true;
      }
      return originalRename.call(fs, from, to);
    };
    // ... and make the rollback unable to delete the bad plaintext, like a Windows
    // antivirus/indexer lock. Everything else is untouched.
    fs.rmSync = function patchedRm(file, ...rest) {
      if (swapped && typeof file === 'string' && path.resolve(file) === path.resolve(databasePath)) {
        const error = new Error('EPERM: operation not permitted, unlink ...');
        error.code = 'EPERM';
        throw error;
      }
      return originalRm.call(fs, file, ...rest);
    };
    let message = '';
    try {
      assert.throws(
        () => openOrConvertStore(databasePath, { keyPath, log: silentLog }),
        (error) => { message = error.message; return true; },
      );
    } finally {
      fs.renameSync = originalRename;
      fs.rmSync = originalRm;
    }

    assert.equal(swapped, true, 'the injection must have reached the swap');
    const keptNames = listFiles(directory)
      .filter((name) => name.startsWith('development-data.db.encrypted-') && name.endsWith('.bak'));
    assert.equal(keptNames.length, 1, 'the encrypted original must be kept');
    const keptPath = path.join(directory, keptNames[0]);

    // (i) The message must not claim the encrypted original is at the live path.
    assert.match(message, /فشل تحويل قاعدة البيانات المشفّرة/, 'the failure must be reported');
    assert.match(message, /[\u0600-\u06FF]/, 'the failure must be Arabic');
    assert.doesNotMatch(message, /سليم في مكانه/, 'a locked unverified file must never be called a restored original');
    assert.ok(message.includes(keptPath), 'the message must name the kept encrypted original instead');
    assert.match(message, /لا تعتمد عليه/, 'and must say the file at the live path is not trustworthy');

    assert.equal(fs.existsSync(keptPath), true, '(iii) the kept encrypted original is still present');
    assert.equal(fs.existsSync(keptPath + '.key'), true, 'and so is its copied key');
    assert.equal(classifyStore(keptPath, key).ok, true, 'and it still opens with the key');
    assert.equal(fs.existsSync(markerPath), true, 'the marker stays for the next start');
    // The bad plaintext is exactly what is sitting at the live path now.
    assert.equal(classifyStore(databasePath, key).reason, 'plaintext', 'the locked bad copy is still at the live path');
    const liveHash = sha256(databasePath);

    // (ii) A second start must refuse that unverified store, not open it.
    let secondMessage = '';
    assert.throws(
      () => openOrConvertStore(databasePath, { keyPath, log: silentLog }),
      (error) => { secondMessage = error.message; return true; },
    );
    assert.match(secondMessage, /انقطع تحويل سابق/, 'the refusal must be the documented recovery refusal');
    assert.match(secondMessage, /لا يطابق ما وعدت به علامة التحويل/, 'and must name the content mismatch');
    assert.match(secondMessage, /[\u0600-\u06FF]/, 'the refusal must be Arabic');
    assert.equal(sha256(databasePath), liveHash, 'nothing at the live path may be rewritten');
    assert.equal(fs.existsSync(keptPath), true, 'the kept encrypted original survives every refusal');
    assert.equal(fs.existsSync(markerPath), true, 'the marker survives too, so a human can act');
  });
});

test('a marker without an expected fingerprint falls back to the weaker classification', () => {
  withTemporaryDirectory((directory) => {
    const databasePath = path.join(directory, 'development-data.db');
    const keyPath = path.join(directory, 'store.key');

    const created = openStore(databasePath);
    created.prepare('INSERT INTO import_batches(file_name,file_type,file_size,created_at) VALUES(?,?,?,?)')
      .run('live.xlsx', 'xlsx', 10, '2026-01-01T00:00:00.000Z');
    created.close();

    // A marker from an earlier build: no `expected` fingerprint at all, so the
    // strong verification has nothing to compare against and the weaker
    // classification is the only answer available.
    const markerPath = databasePath + MARKER_SUFFIX;
    fs.writeFileSync(markerPath, JSON.stringify({
      stagingPath: `${databasePath}.plaintext-old.db`,
      keptEncryptedPath: `${databasePath}.encrypted-old.bak`,
      keyPath,
      targetPath: databasePath,
      createdAt: new Date().toISOString(),
    }, null, 2));

    const opened = openOrConvertStore(databasePath, { keyPath, log: silentLog });
    try {
      assert.equal(opened.converted, false);
      assert.equal(opened.recoveredFrom, null);
      assert.equal(opened.database.prepare('SELECT COUNT(*) AS count FROM import_batches').get().count, 1);
    } finally {
      opened.database.close();
    }
    assert.equal(fs.existsSync(markerPath), false, 'the stale marker is consumed');
  });
});

// ---------------------------------------------------------------------------
// Residual defect 2 — a kept encrypted original is recoverable data, so it must
// block the empty-database bootstrap; a successful conversion must not.
// ---------------------------------------------------------------------------

test('a kept encrypted original with no live store is named in the refusal instead of bootstrapping an empty database', () => {
  withTemporaryDirectory((directory) => {
    const { databasePath, keyPath, key } = createEncryptedStore(directory);
    const keptPath = `${databasePath}.encrypted-2026-01-01T00-00-00-000Z.bak`;
    fs.copyFileSync(databasePath, keptPath);
    copyStoreKey(keyPath, keptPath + '.key');

    // The user deletes the live store (and the legacy key file) by hand: only the
    // kept encrypted original and its copied key remain.
    fs.rmSync(databasePath);
    fs.rmSync(keyPath);
    assert.equal(fs.existsSync(databasePath), false);

    let message = '';
    assert.throws(
      () => openOrConvertStore(databasePath, { keyPath, log: silentLog }),
      (error) => { message = error.message; return true; },
    );

    assert.equal(fs.existsSync(databasePath), false, 'the live path must stay absent — no empty database');
    assert.match(message, /قاعدة بيانات فارغة/, 'the refusal must be explicit about not creating an empty database');
    assert.match(message, /[\u0600-\u06FF]/, 'the refusal must be Arabic');
    assert.ok(message.includes(keptPath), 'the message must name the kept encrypted original');
    assert.ok(message.includes(keptPath + '.key'), 'and its copied key');
    assert.match(message, /انسخ/, 'and must say how to put it back');
    assert.equal(fs.existsSync(keptPath), true, 'the recoverable copy survives the refusal');
    assert.equal(fs.existsSync(keptPath + '.key'), true, 'and so does its key');
    assert.equal(classifyStore(keptPath, key).ok, true, 'it is a usable encrypted store');

    // A genuine fresh install in its own empty folder still bootstraps: no kept
    // copy means no false positive.
    const freshDirectory = path.join(directory, 'fresh');
    fs.mkdirSync(freshDirectory);
    const freshPath = path.join(freshDirectory, 'development-data.db');
    const fresh = openOrConvertStore(freshPath, { keyPath: path.join(freshDirectory, 'store.key'), log: silentLog });
    try {
      assert.equal(fresh.converted, false);
      assert.equal(fresh.wasEncrypted, false);
      assert.ok(fs.statSync(freshPath).size > 0, 'a fresh install still creates its store');
    } finally {
      fresh.database.close();
    }
  });
});

test('kept encrypted originals left by a successful conversion never trip the leftover guard', () => {
  withTemporaryDirectory((directory) => {
    const { databasePath, keyPath } = createEncryptedStore(directory);

    const first = openOrConvertStore(databasePath, { keyPath, log: silentLog });
    first.database.close();

    const kept = listFiles(directory)
      .filter((name) => name.startsWith('development-data.db.encrypted-') && name.endsWith('.bak'));
    assert.equal(kept.length, 1, 'the conversion keeps one encrypted original beside the live store');

    // Ordering check: the leftover scan only runs while the live store is missing
    // or empty, so a usable live store plus a kept original opens normally.
    const second = openOrConvertStore(databasePath, { keyPath, log: silentLog });
    try {
      assert.equal(second.converted, false, 'no refusal and no second conversion');
      assert.equal(second.wasEncrypted, false);
      assert.equal(second.recoveredFrom, null);
      assert.equal(second.database.prepare('SELECT COUNT(*) AS count FROM import_batches').get().count, 1);
    } finally {
      second.database.close();
    }
    assert.equal(fs.existsSync(path.join(directory, kept[0])), true, 'the kept original is untouched by the reopen');
  });
});

