const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3-multiple-ciphers');
const { migrate } = require('./analysis/store-schema.cjs');

/** Sidecar files SQLite writes next to a database file. */
const SIDECAR_SUFFIXES = ['-journal', '-wal', '-shm'];

// The app does not ask the user for a passphrase any more. A 256-bit key is generated once,
// stored beside the user data (mode 0600) and reused, so the database file stays encrypted
// at rest without any step the user has to remember.
//
// `store.key` is the *only* way back into the store. If it disappears while a database
// exists, generating a new key would make the existing file unreadable and the open path
// would treat it as foreign and quarantine it — i.e. the user would silently get an empty
// database. Callers therefore pass `databaseExists` so this function can refuse instead.
function loadOrCreateStoreKey(keyPath, options = {}) {
  const databaseExists = Boolean(options.databaseExists);
  let existing = null;
  try {
    existing = fs.readFileSync(keyPath, 'utf8').trim();
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw new Error('تعذر قراءة مفتاح التخزين (store.key). تحقق من صلاحيات المجلد قبل إعادة المحاولة.');
    }
  }
  if (existing !== null) {
    if (/^[0-9a-f]{64}$/i.test(existing)) return existing;
    // Never regenerate over an existing key: the database it protects would become
    // unreadable forever. This is a human-intervention case, not a first run.
    throw new Error(
      'ملف مفتاح التخزين (store.key) موجود لكن محتواه تالف. لا يعيد التطبيق توليده تلقائيًا حتى لا يُفقد الوصول إلى قاعدة البيانات. استعد نسخة سليمة من نسخة احتياطية، أو انقل ملفات قاعدة البيانات إلى مجلد آخر لبدء قاعدة جديدة.'
    );
  }
  if (databaseExists) {
    throw new Error(
      'قاعدة البيانات موجودة لكن ملف المفتاح (store.key) مفقود. لن ينشئ التطبيق مفتاحًا جديدًا لأنه سيجعل بياناتك غير قابلة للقراءة. استعد store.key من النسخة الاحتياطية في مجلد backups، أو انقل قاعدة البيانات إلى مجلد آخر لبدء قاعدة جديدة.'
    );
  }
  const key = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(path.dirname(keyPath), { recursive: true });
  fs.writeFileSync(keyPath, key, { encoding: 'utf8', mode: 0o600 });
  return key;
}

/**
 * Copy a store (plus its sidecars) into `<dir>/backups/` before a risky step such
 * as a migration or a quarantine decision. Returns the backup path, or null when
 * there was nothing to copy.
 *
 * Backups are pruned to the newest `keep` files so the folder cannot grow without
 * bound; pruning only ever removes files this function created.
 */
/**
 * Copy a validated encryption key beside a backup using private file permissions.
 * A database backup without this key is not a recoverable backup.
 */
function copyStoreKey(keyPath, targetPath) {
  const stat = fs.lstatSync(keyPath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('ملف مفتاح التخزين ليس ملفًا عاديًا آمنًا.');
  }
  const key = fs.readFileSync(keyPath, 'utf8').trim();
  if (!/^[0-9a-f]{64}$/i.test(key)) {
    throw new Error('مفتاح التخزين غير صالح؛ أُوقفت عملية النسخ الاحتياطي لحماية قابلية الاستعادة.');
  }
  fs.mkdirSync(path.dirname(targetPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(targetPath, key + '\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  if (process.platform !== 'win32') fs.chmodSync(targetPath, 0o600);
  return targetPath;
}

/**
 * Copy a complete encrypted store (database, sidecars and encryption key) into
 * the backups folder. When keyPath is supplied, failure to copy the key or any
 * existing sidecar aborts the backup and removes the partial files.
 *
 * Backups are pruned as complete bundles: database, key and SQLite sidecars.
 */
function backupStore(filePath, options = {}) {
  if (!fs.existsSync(filePath)) return null;
  const keyPath = options.keyPath ? path.resolve(options.keyPath) : null;
  if (keyPath && !fs.existsSync(keyPath)) {
    throw new Error('تعذّر إنشاء نسخة قابلة للاستعادة: مفتاح التخزين store.key غير موجود.');
  }

  const keep = Math.max(1, Number(options.keep) || 10);
  const directory = path.join(path.dirname(filePath), 'backups');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(directory, 0o700);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = path.join(directory, path.basename(filePath) + '.' + stamp + '.bak');
  const created = [];

  try {
    fs.copyFileSync(filePath, base);
    created.push(base);
    if (process.platform !== 'win32') fs.chmodSync(base, 0o600);

    for (const suffix of SIDECAR_SUFFIXES) {
      const source = filePath + suffix;
      if (!fs.existsSync(source)) continue;
      const target = base + suffix;
      fs.copyFileSync(source, target);
      created.push(target);
      if (process.platform !== 'win32') fs.chmodSync(target, 0o600);
    }

    if (keyPath) {
      const target = base + '.key';
      copyStoreKey(keyPath, target);
      created.push(target);
    }
  } catch (error) {
    for (const target of created) {
      try { fs.rmSync(target, { force: true }); } catch { /* best effort cleanup */ }
    }
    throw new Error('فشل إنشاء نسخة احتياطية مكتملة؛ أزيلت الملفات الجزئية: ' + error.message);
  }

  const prefix = path.basename(filePath) + '.';
  const stale = fs.readdirSync(directory)
    .filter((name) => name.startsWith(prefix) && name.endsWith('.bak'))
    .sort()
    .reverse()
    .slice(keep);
  for (const name of stale) {
    const oldBase = path.join(directory, name);
    for (const suffix of ['', '.key', ...SIDECAR_SUFFIXES]) {
      try { fs.rmSync(oldBase + suffix, { force: true }); } catch { /* best effort */ }
    }
  }
  return base;
}

/** Newest backups for a store path, newest first. */
function listBackups(filePath) {
  const directory = path.join(path.dirname(filePath), 'backups');
  const prefix = `${path.basename(filePath)}.`;
  try {
    return fs.readdirSync(directory)
      .filter((name) => name.startsWith(prefix) && name.endsWith('.bak'))
      .sort()
      .reverse()
      .map((name) => path.join(directory, name));
  } catch {
    return [];
  }
}

function openEncryptedStore(filePath, passphrase) {
  const database = new Database(filePath, { timeout: 5000 });
  try {
    database.pragma("cipher = 'sqlcipher'");
    database.pragma(`key = '${String(passphrase).replaceAll("'", "''")}'`);
    database.pragma('foreign_keys = ON');
    database.pragma('busy_timeout = 5000');
    database.prepare('SELECT count(*) AS count FROM sqlite_master').get();
    database.exec(`
      CREATE TABLE IF NOT EXISTS import_batches (
        id INTEGER PRIMARY KEY,
        file_name TEXT NOT NULL,
        file_type TEXT NOT NULL,
        file_size INTEGER NOT NULL,
        item_count INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'review',
        warnings_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS review_items (
        id INTEGER PRIMARY KEY,
        batch_id INTEGER NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
        field_name TEXT NOT NULL,
        value_text TEXT NOT NULL,
        proposed_type TEXT NOT NULL DEFAULT 'غير محدد',
        governorate TEXT NOT NULL DEFAULT '',
        district TEXT NOT NULL DEFAULT '',
        subdistrict TEXT NOT NULL DEFAULT '',
        settlement TEXT NOT NULL DEFAULT '',
        record_id TEXT NOT NULL DEFAULT '',
        source_location TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL,
        reviewed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS review_items_status_idx ON review_items(status, batch_id);
      CREATE TABLE IF NOT EXISTS data_values (
        id INTEGER PRIMARY KEY,
        governorate TEXT NOT NULL,
        district TEXT NOT NULL,
        subdistrict TEXT NOT NULL,
        settlement TEXT NOT NULL,
        record_type TEXT NOT NULL,
        record_id TEXT NOT NULL,
        field_name TEXT NOT NULL,
        value_text TEXT NOT NULL,
        source_item_id INTEGER NOT NULL REFERENCES review_items(id),
        source_file TEXT NOT NULL,
        source_location TEXT NOT NULL,
        imported_at TEXT NOT NULL,
        UNIQUE(governorate, district, subdistrict, settlement, record_type, record_id, field_name)
      );
      CREATE INDEX IF NOT EXISTS data_values_geo_idx ON data_values(governorate, district, subdistrict, settlement);
    `);
    // Analysis-layer tables (directorates, runs, results, audit log, settings).
    migrate(database);
    return database;
  } catch (error) {
    database.close();
    if (/not a database|file is not a database|malformed|encrypted|SQLITE_NOTADB/i.test(error.message)) {
      throw new Error('تعذر فتح قاعدة البيانات. قد تكون كلمة المرور غير صحيحة أو الملف تالفًا.');
    }
    throw error;
  }
}

/**
 * Probe `filePath` with `key` and say *why* it failed, so a busy file is never
 * mistaken for a foreign one (which would trigger a destructive quarantine).
 *
 * @returns {{ ok:boolean, reason:'readable'|'busy'|'corrupt'|'foreign'|'unknown', error?:Error }}
 */
function classifyStore(filePath, key) {
  let probe;
  try {
    probe = new Database(filePath, { readonly: true, timeout: 2000 });
    probe.pragma("cipher = 'sqlcipher'");
    probe.pragma(`key = '${String(key).replaceAll("'", "''")}'`);
    const tables = probe.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
    probe.close();
    const known = tables.some((table) => table.name === 'import_batches' || table.name === 'directorates');
    return known ? { ok: true, reason: 'readable' } : { ok: false, reason: 'foreign' };
  } catch (error) {
    try { if (probe) probe.close(); } catch { /* already closed */ }
    const message = String(error?.message ?? '');
    if (/busy|locked/i.test(message)) return { ok: false, reason: 'busy', error };
    // A malformed/corrupt file is *ours* and must never be swapped for an empty
    // store inside the same folder: the user needs a restore, not a reset.
    if (/malformed|corrupt|SQLITE_CORRUPT/i.test(message)) return { ok: false, reason: 'corrupt', error };
    if (/not a database|file is not a database|encrypted|SQLITE_NOTADB/i.test(message)) {
      return { ok: false, reason: 'foreign', error };
    }
    return { ok: false, reason: 'unknown', error };
  }
}

/**
 * True when `filePath` can be read with `key` and looks like one of our databases.
 * Never throws — a foreign or passphrase-only file simply returns false.
 */
function canOpenWithKey(filePath, key) {
  return classifyStore(filePath, key).ok;
}

/** Existing quarantine backups for a database path, newest first. */
function findLegacyBackups(filePath) {
  const directory = path.dirname(filePath);
  const prefix = `${path.basename(filePath)}.legacy-passphrase-`;
  try {
    return fs.readdirSync(directory)
      .filter((name) => name.startsWith(prefix) && name.endsWith('.db'))
      .map((name) => path.join(directory, name))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

/**
 * Move an unreadable (legacy passphrase) database aside so the app can start a
 * clean encrypted store without ever deleting the user's file.
 *
 * SQLite keeps its write-ahead and journal state in sidecar files next to the
 * database (`-journal`, `-wal`, `-shm`). They must move with it: leaving them
 * behind corrupts the quarantined copy and can confuse the new store. If any
 * step fails, the move is rolled back so the original path is never left half
 * used.
 *
 * @returns {string|null} the backup path, or null when there was nothing to move
 */
function quarantineLegacyDatabase(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let target = `${filePath}.legacy-passphrase-${stamp}.db`;
  let counter = 1;
  while (fs.existsSync(target) || SIDECAR_SUFFIXES.some((suffix) => fs.existsSync(`${target}${suffix}`))) {
    target = `${filePath}.legacy-passphrase-${stamp}-${counter}.db`;
    counter += 1;
  }

  const movedSidecars = [];
  try {
    fs.renameSync(filePath, target);
    for (const suffix of SIDECAR_SUFFIXES) {
      const sidecar = `${filePath}${suffix}`;
      if (fs.existsSync(sidecar)) {
        fs.renameSync(sidecar, `${target}${suffix}`);
        movedSidecars.push(suffix);
      }
    }
    return target;
  } catch (error) {
    // Roll back so the original path keeps a consistent database plus sidecars.
    for (const suffix of movedSidecars) {
      try { fs.renameSync(`${target}${suffix}`, `${filePath}${suffix}`); } catch { /* best effort */ }
    }
    if (fs.existsSync(target)) {
      try { fs.renameSync(target, filePath); } catch { /* best effort */ }
    }
    throw new Error(`تعذّر نقل قاعدة البيانات القديمة إلى نسخة احتياطية: ${error.message}`);
  }
}

module.exports = {
  openEncryptedStore,
  loadOrCreateStoreKey,
  canOpenWithKey,
  classifyStore,
  backupStore,
  copyStoreKey,
  listBackups,
  findLegacyBackups,
  quarantineLegacyDatabase,
};
