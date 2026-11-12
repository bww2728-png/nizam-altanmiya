const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3-multiple-ciphers');
const { migrate, needsMigration } = require('./analysis/store-schema.cjs');

/** Sidecar files SQLite writes next to a database file. */
const SIDECAR_SUFFIXES = ['-journal', '-wal', '-shm'];

/** The 16-byte magic that starts every plain SQLite database file. */
const SQLITE_HEADER = 'SQLite format 3\u0000';

/** Marker written before a plaintext swap and removed only after it is verified. */
const CONVERSION_MARKER_SUFFIX = '.plaintext-conversion.json';

/** How many kept encrypted originals may survive beside a live database. */
const KEPT_ENCRYPTED_BACKUPS = 2;

// ---------------------------------------------------------------------------
// Storage policy: the database file is a PLAIN SQLite database.
//
// MECHANISM — how an encrypted store becomes plaintext
//   1. `exportStoreAsPlaintext` makes an OS-streamed copy of the file
//      (fs.copyFileSync) and decrypts the COPY in place with the driver's
//      documented `PRAGMA rekey = ''` (after `PRAGMA cipher` + `PRAGMA key`).
//      In the bundled sqlite3mc that pragma takes the decrypt branch and, since
//      a SQLCipher database always has a non-zero reserved area, decrypts by
//      REBUILDING the database VACUUM-style (sqlite3mcRunVacuumForRekey): it
//      builds a temporary database on disk and copies the pages back. Memory is
//      therefore bounded and independent of file size (page cache ~2 MB; the
//      rebuild's temporary database lives on disk) — which is the property that
//      matters, described accurately here. Measured ONCE during this change on a
//      152,678,400-byte store: peak RSS delta ~2.1 MB, against ~173 MB for the
//      former `serialize()` full image. Proven by a scratch experiment: header
//      before = ciphertext, after = 'SQLite format 3\0', and the file reopens
//      with no key at all. The plaintext result is then checked by the shared
//      strong verification (verifyStoreIdentity) before anything is installed.
//      TRANSIENT DISK COST: approximately 4x the database size is occupied in
//      the data directory at peak (staging copy, kept encrypted original,
//      backups/ copy and the rebuild's spill file) plus about 1x in the system
//      temp directory; an operator short on space must plan for it.
//   2. `convertEncryptedStoreInPlace` swaps it in with a marker-based protocol.
//      `<target>.plaintext-conversion.json` (written with flag 'wx') records the
//      staging path, the kept-encrypted path, the key path, the target path and
//      the verified expectations. The original is COPIED, never moved, to
//      `<target>.encrypted-<stamp>.bak` with its sidecars and key; then the live
//      file is removed and the verified plaintext is renamed into place — one
//      rename, whose gap is covered by the marker. The marker is deleted only
//      after the installed store passes the same strong verification.
//   3. `openOrConvertStore` recovers from an interrupted swap at startup. With
//      the marker present it either (a) keeps a live store that classifies as
//      plaintext/readable and drops the stale marker and staging file — a
//      plaintext live store must first pass the strong verification against
//      `marker.expected` when the marker recorded that fingerprint — (b)
//      finishes the swap from a verified staging file, (c) restores the kept
//      encrypted backup (with its key) and converts once, or (d) refuses with an
//      explicit error naming every path. It never bootstraps an empty database
//      while recoverable data exists — a kept encrypted original counts as
//      recoverable data even without a marker (see findRecoverableLeftovers).
//
// RETENTION — at most the newest two `<target>.encrypted-*.bak` bundles are
// kept. Older bundles are pruned at the end of a conversion and at startup, and
// a stale bundle's copied `.key` is always deleted together with it.
//
// HONEST SECURITY TRADE-OFF — the store is NOT encrypted. Any SQLite tool, or
// any process running as the user, can read every record. It is protected by the
// operating-system account and by file permissions, not by a cipher. The
// "access profile" masking in the UI is display/export masking only: it is NOT
// access control. In exchange the store is always recoverable (a lost or corrupt
// key can no longer orphan the data) and it can be inspected with standard
// tooling. `store.key` is legacy material: it is only READ, and only to convert
// a database an earlier build encrypted (see openOrConvertStore) or to verify
// and restore an old encrypted backup bundle. A brand-new store never generates
// a key; the dependency `better-sqlite3-multiple-ciphers` stays for exactly
// those legacy files: they must remain openable, verifiable and restorable.
// ---------------------------------------------------------------------------

/** The marker tables of our schema, used to tell our database from a foreign file. */
const STORE_MARKER_TABLES = ['import_batches', 'directorates'];

/**
 * Read and validate a legacy `store.key` file.
 *
 * A key that cannot be read or does not look like a key stops the caller: the
 * encrypted database it protects would otherwise become unreadable for good.
 */
function readStoreKey(keyPath) {
  let key;
  try {
    key = fs.readFileSync(keyPath, 'utf8').trim();
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`ملف مفتاح التخزين «${keyPath}» غير موجود؛ لا يمكن تحويل قاعدة بيانات مشفّرة بدونه.`);
    }
    throw new Error('تعذر قراءة مفتاح التخزين (store.key). تحقق من صلاحيات المجلد قبل إعادة المحاولة.');
  }
  if (!/^[0-9a-f]{64}$/i.test(key)) {
    throw new Error('ملف مفتاح التخزين (store.key) موجود لكن محتواه تالف، ولا يمكن تحويل قاعدة البيانات أو استعادتها بدونه.');
  }
  return key;
}

/**
 * Return the key that protects an EXISTING legacy encrypted store, or null.
 *
 * The name is historical: this function never generates a key any more. The
 * store is plaintext, so a new database needs none, and writing a fresh
 * `store.key` would only create a file that protects nothing. `null` therefore
 * means "there is no key here — proceed in plaintext mode". A key file that
 * exists but is malformed is still an error: silently ignoring it would make a
 * genuinely encrypted database unreadable.
 */
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
      'قاعدة البيانات موجودة لكن ملف المفتاح (store.key) مفقود. إن كانت مشفّرة فلا سبيل لفتحها بدونه: استعد store.key من النسخة الاحتياطية في مجلد backups، أو انقل قاعدة البيانات إلى مجلد آخر لبدء قاعدة جديدة.'
    );
  }
  return null;
}

/**
 * Copy a validated legacy encryption key beside a backup using private file
 * permissions. Only the legacy encrypted path needs this: a backup made from a
 * plaintext store is already self-contained and recoverable without any key.
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

/** Keep only the newest `keep` complete bundles for a store path; never touches foreign files. */
function pruneBackups(directory, prefix, keep) {
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
}

/** Delete a file when it exists; never throws — cleanup must not mask the real error. */
function removeQuietly(filePath) {
  try { fs.rmSync(filePath, { force: true }); } catch { /* best effort cleanup */ }
}

/**
 * Retention for the kept encrypted originals: keep at most `keep` newest
 * `<target>.encrypted-*.bak` bundles beside the live database.
 *
 * The newest bundle is never deleted, and a bundle's copied `.key` is always
 * deleted together with it so encrypted material is never orphaned. Every pruned
 * path is logged.
 *
 * @returns {string[]} the paths that were pruned
 */
function pruneEncryptedOriginals(target, keep = KEPT_ENCRYPTED_BACKUPS, log) {
  const directory = path.dirname(target);
  const prefix = path.basename(target) + '.encrypted-';
  let names;
  try {
    names = fs.readdirSync(directory);
  } catch {
    return [];
  }
  // Names carry an ISO timestamp (with ':' and '.' normalised to '-'), so a
  // lexicographic sort is chronological.
  const stale = names
    .filter((name) => name.startsWith(prefix) && name.endsWith('.bak'))
    .sort()
    .reverse()
    .slice(Math.max(1, Number(keep) || KEPT_ENCRYPTED_BACKUPS));
  const pruned = [];
  for (const name of stale) {
    const base = path.join(directory, name);
    for (const suffix of ['', '.key', ...SIDECAR_SUFFIXES]) {
      const candidate = base + suffix;
      if (!fs.existsSync(candidate)) continue;
      removeQuietly(candidate);
      if (!fs.existsSync(candidate)) {
        pruned.push(candidate);
        log?.info?.(`[store] حُذفت نسخة مشفّرة قديمة «${candidate}» (تُحفظ أحدث نسختين فقط).`);
      }
    }
  }
  return pruned;
}

/**
 * True when the live path currently holds a store that classifies as ok.
 *
 * Used to decide whether conversion leftovers may be pruned: while the live
 * store is missing or unverifiable, a leftover may be the only local copy of
 * the user's data.
 */
function liveStoreIsUsable(target, key = null) {
  try {
    if (!fs.existsSync(target) || fs.statSync(target).size === 0) return false;
    return classifyStore(target, key).ok === true;
  } catch {
    return false;
  }
}

/**
 * Leftover files that prove an earlier conversion or restore did not finish:
 * `<store>.rollback-*`, `<store>.restore-*`, `<store>.plaintext-*` and the kept
 * encrypted original `<store>.encrypted-*` (with its `.key` and sidecars), plus
 * the same three families for the key path. The kept encrypted original counts
 * because it is a COMPLETE copy of the user's data: when the live store was
 * deleted by hand, bootstrapping an empty database beside a restorable encrypted
 * backup would break the "never an empty database while recoverable data exists"
 * guarantee. A genuine fresh install has no such files and still bootstraps.
 *
 * The marker itself is never reported (it is not a leftover). Never throws: an
 * unreadable directory simply yields nothing.
 *
 * @returns {string[]} absolute artifact paths, sorted
 */
function findRecoverableLeftovers(target, keyPath) {
  const directory = path.dirname(target);
  const storeBase = path.basename(target);
  const bases = new Set([storeBase]);
  if (keyPath) bases.add(path.basename(keyPath));
  // Kept encrypted originals belong to the STORE basename only; applying the
  // prefix to the key basename would only ever match foreign files.
  const prefixes = [`${storeBase}.encrypted-`];
  for (const base of bases) {
    prefixes.push(`${base}.rollback-`, `${base}.restore-`, `${base}.plaintext-`);
  }
  let names;
  try {
    names = fs.readdirSync(directory);
  } catch {
    return [];
  }
  const markerResolved = path.resolve(conversionMarkerPath(target));
  const found = [];
  for (const name of names) {
    if (!prefixes.some((prefix) => name.startsWith(prefix))) continue;
    const candidate = path.resolve(path.join(directory, name));
    if (candidate === markerResolved) continue;
    found.push(candidate);
  }
  return found.sort();
}

/**
 * Explicit refusal used when the live store is gone but recovery artifacts
 * remain: never bootstrap an empty database over data the user can still save.
 *
 * The options are ordered by how complete the surviving copy is. A kept
 * encrypted original (`<store>.encrypted-*.bak`) holds every row, so when one is
 * present the message names the newest bundle — with its key — and says exactly
 * how to put it back; the app then converts it automatically on the next start.
 */
function emptyStoreWithLeftoversError(target, keyPath, leftovers) {
  const keyHint = keyPath ? ` أو ملفه «${keyPath}»` : '';
  const storeBase = path.basename(target);
  const keptEncrypted = leftovers.filter(
    (leftover) => path.basename(leftover).startsWith(storeBase + '.encrypted-') && leftover.endsWith('.bak'),
  );
  // Names carry an ISO timestamp, so a lexicographic sort is chronological.
  const newestEncrypted = keptEncrypted.length ? keptEncrypted[keptEncrypted.length - 1] : null;
  const options = [];
  if (newestEncrypted) {
    const copiedKey = newestEncrypted + '.key';
    const keyText = fs.existsSync(copiedKey)
      ? `مع مفتاحها «${copiedKey}»`
      : `مع ملف المفتاح${keyPath ? ` «${keyPath}»` : ' (store.key)'}`;
    options.push(
      'انسخ النسخة المشفّرة المحفوظة «' + newestEncrypted + '» إلى «' + target + '» ' + keyText
      + ' ثم أعِد تشغيل التطبيق ليعيد تحويلها إلى صيغة عادية — هذه النسخة تحتوي بياناتك كاملة'
    );
  }
  options.push(
    'إن كانت إحدى بقايا .rollback- هي قاعدة بياناتك، أعِد تسميتها إلى «' + target + '»' + keyHint,
    'أو استعد أحدث نسخة احتياطية من مجلد backups إلى «' + target + '»',
    'أو انقل هذه الملفات إلى مجلد آخر إن لم تكن بحاجتها ثم أعِد تشغيل التطبيق'
  );
  const digits = ['١', '٢', '٣', '٤'];
  return new Error(
    'لا توجد قاعدة بيانات حيّة في «' + target + '» بينما توجد ملفات بقايا من عملية تحويل أو استعادة سابقة؛ '
    + 'لم يُنشئ التطبيق قاعدة بيانات فارغة حتى لا يُفقد شيء. الملفات الموجودة فعليًا:\n'
    + leftovers.map((leftover) => `- «${leftover}»`).join('\n')
    + '\nالخيارات: ' + options.map((text, index) => `(${digits[index]}) ${text}`).join('، ') + '.'
  );
}

/**
 * Remove files an interrupted conversion or restore left behind:
 * `<target>.plaintext-*`, `<target>.restore-*`, `<target>.rollback-*` (and
 * the same patterns for the key file path).
 *
 * A file referenced by a live conversion marker, and the marker itself, are
 * never touched: recovery still needs them.
 *
 * A `<base>.rollback-*` group is a SPECIAL case: restorePlaintextBundle and
 * restoreBackupBundle move the live files into one, and their `rollbackMoves`
 * swallows errors, so such a group can be the ONLY local copy of the database
 * and its key. It is therefore pruned only while the live store exists AND
 * verifies (classifyStore(...).ok), never while the live store is missing,
 * empty or unreadable — otherwise a failed restore would be silently advertised
 * as an empty database at the next start.
 *
 * @returns {string[]} the paths that were pruned
 */
function pruneConversionLeftovers(target, keyPath, log, key = null) {
  const marker = readConversionMarker(target);
  const protectedPaths = new Set();
  if (marker) {
    for (const value of [marker.stagingPath, marker.keptEncryptedPath, marker.keyPath, marker.targetPath]) {
      if (typeof value === 'string' && value) protectedPaths.add(path.resolve(value));
    }
  }
  const markerPath = path.resolve(conversionMarkerPath(target));
  const isProtected = (candidate) => {
    const resolved = path.resolve(candidate);
    if (resolved === markerPath) return true;
    for (const known of protectedPaths) {
      if (resolved === known || resolved.startsWith(known)) return true;
    }
    return false;
  };

  const directory = path.dirname(target);
  const bases = new Set([path.basename(target)]);
  if (keyPath) bases.add(path.basename(keyPath));
  const reusablePatterns = [];
  const rollbackPatterns = [];
  for (const base of bases) {
    reusablePatterns.push(`${base}.plaintext-`, `${base}.restore-`);
    rollbackPatterns.push(`${base}.rollback-`);
  }
  const liveUsable = liveStoreIsUsable(target, key);

  let names;
  try {
    names = fs.readdirSync(directory);
  } catch {
    return [];
  }
  const pruned = [];
  for (const name of names) {
    const isRollback = rollbackPatterns.some((pattern) => name.startsWith(pattern));
    if (!isRollback && !reusablePatterns.some((pattern) => name.startsWith(pattern))) continue;
    if (isRollback && !liveUsable) continue;
    const candidate = path.resolve(path.join(directory, name));
    if (isProtected(candidate)) continue;
    removeQuietly(candidate);
    if (!fs.existsSync(candidate)) {
      pruned.push(candidate);
      log?.info?.(`[store] حُذف ملف مؤقت باقٍ من تحويل سابق: «${candidate}».`);
    }
  }
  return pruned;
}

/**
 * Copy a complete encrypted store (database, sidecars and encryption key) into
 * the backups folder. keyPath is mandatory: failure to copy the key or any
 * existing sidecar aborts the backup and removes the partial files.
 *
 * Backups are pruned as complete bundles: database, key and SQLite sidecars.
 */
function backupStore(filePath, options = {}) {
  if (!fs.existsSync(filePath)) return null;
  if (!options.keyPath) {
    throw new Error('تعذّر إنشاء نسخة احتياطية آمنة: يجب توفير مفتاح التخزين store.key مع قاعدة البيانات.');
  }
  const keyPath = path.resolve(options.keyPath);
  if (!fs.existsSync(keyPath)) {
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
    if (typeof options.verify === 'function' && options.verify(base) !== true) {
      throw new Error('تعذر التحقق من النسخة الاحتياطية باستخدام مفتاحها.');
    }
  } catch (error) {
    for (const target of created) {
      try { fs.rmSync(target, { force: true }); } catch { /* best effort cleanup */ }
    }
    throw new Error('فشل إنشاء نسخة احتياطية مكتملة؛ أزيلت الملفات الجزئية: ' + error.message);
  }

  const prefix = path.basename(filePath) + '.';
  pruneBackups(directory, prefix, keep);
  return base;
}

/**
 * Copy a complete PLAINTEXT store (database plus any SQLite sidecars) into the
 * backups folder. No key is copied and none is required: the copy must be
 * readable by any SQLite tool, which is the whole point of the plaintext mode.
 *
 * Verification defaults to proving the copy still classifies as our plaintext
 * store; a caller may pass `verify(candidatePath)` to demand more. A failed
 * verification removes the partial files and throws.
 */
function backupPlaintextStore(filePath, options = {}) {
  if (!fs.existsSync(filePath)) return null;
  const keep = Math.max(1, Number(options.keep) || 10);
  const directory = path.join(path.dirname(filePath), 'backups');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(directory, 0o700);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = path.join(directory, path.basename(filePath) + '.' + stamp + '.bak');
  const created = [];
  const verify = typeof options.verify === 'function'
    ? options.verify
    : (candidatePath) => classifyStore(candidatePath, null).reason === 'plaintext';

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

    if (verify(base) !== true) {
      throw new Error('النسخة الاحتياطية لا تُفتح بلا مفتاح بصيغة SQLite عادية.');
    }
  } catch (error) {
    for (const target of created) {
      try { fs.rmSync(target, { force: true }); } catch { /* best effort cleanup */ }
    }
    throw new Error('فشل إنشاء نسخة احتياطية مكتملة؛ أزيلت الملفات الجزئية: ' + error.message);
  }

  pruneBackups(directory, path.basename(filePath) + '.', keep);
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


/**
 * Restore one self-contained encrypted backup bundle (<file>.bak + <file>.bak.key).
 * The source is validated before current files move, and the candidate is
 * verified with the SAME strong check as the conversion path
 * (verifyStoreIdentity: header kind, integrity_check, foreign_key_check, table
 * list, per-table row counts, sqlite_master SQL set) before the swap and again
 * on the installed store. Same-directory staging and a rollback set prevent a
 * failed swap from leaving a database without its key.
 */
function restoreBackupBundle(backupPath, databasePath, keyPath) {
  const source = path.resolve(backupPath);
  const target = path.resolve(databasePath);
  const targetKey = path.resolve(keyPath);
  if (source === target) throw new Error('لا يمكن استعادة قاعدة البيانات من المسار نفسه.');
  const sourceKey = source + '.key';

  const regularFile = (filePath, label) => {
    let stat;
    try { stat = fs.lstatSync(filePath); } catch {
      throw new Error(label + ' غير موجود.');
    }
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(label + ' يجب أن يكون ملفًا عاديًا وليس رابطًا رمزيًا.');
  };
  regularFile(source, 'ملف النسخة الاحتياطية');
  regularFile(sourceKey, 'مفتاح النسخة الاحتياطية (.key)');
  for (const suffix of SIDECAR_SUFFIXES) {
    if (fs.existsSync(source + suffix)) regularFile(source + suffix, 'ملف جانبي للنسخة الاحتياطية');
  }

  const key = fs.readFileSync(sourceKey, 'utf8').trim();
  if (!/^[0-9a-f]{64}$/i.test(key)) throw new Error('مفتاح النسخة الاحتياطية تالف أو غير صالح.');
  // The label keeps the historical wording: an invalid bundle must be rejected
  // before anything moves.
  const reference = verifyStoreIdentity(source, key, null, { label: 'تعذّر التحقق من النسخة الاحتياطية' });

  const directory = path.dirname(target);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const token = process.pid + '-' + crypto.randomBytes(6).toString('hex');
  const staged = target + '.restore-' + token + '.tmp';
  const stagedKey = targetKey + '.restore-' + token + '.tmp';
  const rollback = target + '.rollback-' + token;
  const rollbackKey = targetKey + '.rollback-' + token;
  const suffixes = SIDECAR_SUFFIXES;
  const movedOld = [];
  const installed = [];

  const remove = (filePath) => {
    try { fs.rmSync(filePath, { force: true }); } catch { /* best effort cleanup */ }
  };
  const moveIfPresent = (from, to, bucket) => {
    if (!fs.existsSync(from)) return;
    fs.renameSync(from, to);
    bucket.push({ from, to });
  };
  const rollbackMoves = (bucket) => {
    for (const item of [...bucket].reverse()) {
      try {
        if (fs.existsSync(item.to)) fs.renameSync(item.to, item.from);
      } catch { /* retain the original location whenever the filesystem permits */ }
    }
  };

  try {
    fs.copyFileSync(source, staged, fs.constants.COPYFILE_EXCL);
    if (process.platform !== 'win32') fs.chmodSync(staged, 0o600);
    for (const suffix of suffixes) {
      if (fs.existsSync(source + suffix)) {
        fs.copyFileSync(source + suffix, staged + suffix, fs.constants.COPYFILE_EXCL);
        if (process.platform !== 'win32') fs.chmodSync(staged + suffix, 0o600);
      }
    }
    copyStoreKey(sourceKey, stagedKey);
    // Same strong verification as the conversion path, on the candidate.
    verifyStoreIdentity(staged, key, reference, { label: 'التحقق من النسخة المرحلية قبل الاستبدال' });

    // Preserve the live database, its WAL/journal files and key as one rollback set.
    moveIfPresent(target, rollback, movedOld);
    for (const suffix of suffixes) moveIfPresent(target + suffix, rollback + suffix, movedOld);
    moveIfPresent(targetKey, rollbackKey, movedOld);

    moveIfPresent(staged, target, installed);
    for (const suffix of suffixes) moveIfPresent(staged + suffix, target + suffix, installed);
    moveIfPresent(stagedKey, targetKey, installed);

    // ... and on the installed store.
    verifyStoreIdentity(target, key, reference, { label: 'التحقق من القاعدة بعد الاستعادة' });

    // The caller creates a recoverable safety backup before invoking this function.
    for (const item of movedOld) remove(item.to);
    return { restoredPath: target, keyPath: targetKey, backupPath: source };
  } catch (error) {
    for (const item of [...installed].reverse()) remove(item.to);
    rollbackMoves(movedOld);
    throw new Error('فشلت الاستعادة وأُعيدت ملفات قاعدة البيانات السابقة إن أمكن: ' + error.message);
  } finally {
    remove(staged);
    remove(stagedKey);
    for (const suffix of suffixes) remove(staged + suffix);
  }
}

/**
 * Restore a PLAINTEXT bundle (a `.bak` with no `.bak.key` beside it).
 *
 * Copy, verify, then swap — the same staged pattern as restoreBackupBundle, minus
 * the key: a plaintext database needs none, and any legacy `store.key` already on
 * disk is deliberately left alone because an older encrypted bundle may still
 * need it. The candidate and the installed store both pass the shared strong
 * verification (verifyStoreIdentity), exactly like the conversion path.
 */
function restorePlaintextBundle(backupPath, databasePath) {
  const source = path.resolve(backupPath);
  const target = path.resolve(databasePath);
  if (source === target) throw new Error('لا يمكن استعادة قاعدة البيانات من المسار نفسه.');

  const regularFile = (filePath, label) => {
    let stat;
    try { stat = fs.lstatSync(filePath); } catch {
      throw new Error(label + ' غير موجود.');
    }
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(label + ' يجب أن يكون ملفًا عاديًا وليس رابطًا رمزيًا.');
  };
  regularFile(source, 'ملف النسخة الاحتياطية');
  for (const suffix of SIDECAR_SUFFIXES) {
    if (fs.existsSync(source + suffix)) regularFile(source + suffix, 'ملف جانبي للنسخة الاحتياطية');
  }

  const sourceHeader = readFileHeader(source);
  if (sourceHeader !== SQLITE_HEADER) {
    throw new Error('تعذّر التحقق من النسخة الاحتياطية العادية: الملف ليس قاعدة بيانات SQLite عادية (ترويسة غير مطابقة)؛ لم يتم تغيير قاعدة البيانات الحالية.');
  }
  const reference = verifyStoreIdentity(source, null, null, { label: 'التحقق من النسخة الاحتياطية العادية' });

  const directory = path.dirname(target);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const token = process.pid + '-' + crypto.randomBytes(6).toString('hex');
  const staged = target + '.restore-' + token + '.tmp';
  const rollback = target + '.rollback-' + token;
  const suffixes = SIDECAR_SUFFIXES;
  const movedOld = [];
  const installed = [];

  const remove = (filePath) => {
    try { fs.rmSync(filePath, { force: true }); } catch { /* best effort cleanup */ }
  };
  const moveIfPresent = (from, to, bucket) => {
    if (!fs.existsSync(from)) return;
    fs.renameSync(from, to);
    bucket.push({ from, to });
  };
  const rollbackMoves = (bucket) => {
    for (const item of [...bucket].reverse()) {
      try {
        if (fs.existsSync(item.to)) fs.renameSync(item.to, item.from);
      } catch { /* retain the original location whenever the filesystem permits */ }
    }
  };

  try {
    fs.copyFileSync(source, staged, fs.constants.COPYFILE_EXCL);
    if (process.platform !== 'win32') fs.chmodSync(staged, 0o600);
    for (const suffix of suffixes) {
      if (fs.existsSync(source + suffix)) {
        fs.copyFileSync(source + suffix, staged + suffix, fs.constants.COPYFILE_EXCL);
        if (process.platform !== 'win32') fs.chmodSync(staged + suffix, 0o600);
      }
    }
    // Same strong verification as the conversion path, on the candidate.
    verifyStoreIdentity(staged, null, reference, {
      requirePlaintext: true,
      label: 'التحقق من النسخة المرحلية قبل الاستبدال',
    });

    // Preserve the live database and its sidecars as one rollback set. The key
    // file is untouched: it belongs to the legacy encrypted mode.
    moveIfPresent(target, rollback, movedOld);
    for (const suffix of suffixes) moveIfPresent(target + suffix, rollback + suffix, movedOld);

    moveIfPresent(staged, target, installed);
    for (const suffix of suffixes) moveIfPresent(staged + suffix, target + suffix, installed);

    // ... and on the installed store.
    verifyStoreIdentity(target, null, reference, {
      requirePlaintext: true,
      label: 'التحقق من القاعدة بعد الاستعادة',
    });

    // The caller creates a recoverable safety backup before invoking this function.
    for (const item of movedOld) remove(item.to);
    return { restoredPath: target, backupPath: source };
  } catch (error) {
    for (const item of [...installed].reverse()) remove(item.to);
    rollbackMoves(movedOld);
    throw new Error('فشلت الاستعادة وأُعيدت ملفات قاعدة البيانات السابقة إن أمكن: ' + error.message);
  } finally {
    remove(staged);
    for (const suffix of suffixes) remove(staged + suffix);
  }
}

function openEncryptedStore(filePath, passphrase, options = {}) {
  // The passphrase reaches a `PRAGMA key` statement, and this function is
  // exported, so it is validated before any connection or pragma exists. A key
  // in this product is always a 64-character hex string.
  const passphraseText = passphrase == null ? '' : String(passphrase);
  if (!/^[0-9a-f]{64}$/i.test(passphraseText)) {
    throw new Error('مفتاح التشفير غير صالح: يجب أن يكون 64 حرفًا سادس عشريًا (0-9، a-f)، ولا يُمرَّر أي نص آخر إلى قاعدة البيانات. لم يُفتح أي ملف.');
  }
  const existedBeforeOpen = fs.existsSync(filePath);
  const database = new Database(filePath, { timeout: 5000 });
  try {
    database.pragma("cipher = 'sqlcipher'");
    database.pragma(`key = '${passphraseText}'`);
    database.pragma('foreign_keys = ON');
    database.pragma('busy_timeout = 5000');
    database.prepare('SELECT count(*) AS count FROM sqlite_master').get();
    if (existedBeforeOpen && needsMigration(database)) {
      if (!options.keyPath) throw new Error('يلزم مفتاح قاعدة البيانات لإنشاء نسخة احتياطية قبل الترحيل.');
      const integrity = database.pragma('integrity_check');
      if (integrity.length !== 1 || Object.values(integrity[0])[0] !== 'ok') {
        throw new Error('قاعدة البيانات غير سليمة؛ أُوقف الترحيل قبل أي تعديل.');
      }
      const journalMode = String(database.pragma('journal_mode', { simple: true })).toLowerCase();
      if (journalMode === 'wal') {
        const checkpoint = database.pragma('wal_checkpoint(FULL)')[0];
        if (!checkpoint || Number(checkpoint.busy) !== 0) throw new Error('تعذر مزامنة سجل WAL بأمان قبل الترحيل.');
      }
      const backupPath = backupStore(filePath, {
        keyPath: options.keyPath,
        verify: (candidatePath) => {
          if (!classifyStore(candidatePath, passphraseText).ok) return false;
          const backup = new Database(candidatePath, { readonly: true, timeout: 5000 });
          try {
            backup.pragma("cipher = 'sqlcipher'");
            backup.pragma(`key = '${passphraseText}'`);
            const backupIntegrity = backup.pragma('integrity_check');
            return backupIntegrity.length === 1 && Object.values(backupIntegrity[0])[0] === 'ok';
          } finally {
            backup.close();
          }
        },
      });
      if (!backupPath) throw new Error('تعذر التحقق من النسخة المشفرة قبل الترحيل؛ لم تُعدّل قاعدة البيانات.');
    }
    migrate(database, {
      beforeApply: () => {
        if (!existedBeforeOpen || !options.keyPath) return;
        if (!classifyStore(filePath, passphraseText).ok) throw new Error('تعذر إعادة التحقق من قاعدة البيانات قبل الترحيل.');
      },
    });
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
 * Open a PLAIN SQLite database with the session pragmas the application relies
 * on: the same foreign-key enforcement, busy timeout and pre-migration checks as
 * openEncryptedStore, minus the cipher and the key.
 *
 * An existing store that needs a migration is copied into `backups/` first
 * (plaintext, no key required), so a failed migration never costs data.
 */
function openStore(filePath, options = {}) {
  const existedBeforeOpen = fs.existsSync(filePath);
  const sizeBeforeOpen = existedBeforeOpen ? fs.statSync(filePath).size : 0;
  const database = new Database(filePath, { timeout: 5000 });
  try {
    database.pragma('foreign_keys = ON');
    database.pragma('busy_timeout = 5000');
    database.prepare('SELECT count(*) AS count FROM sqlite_master').get();
    if (existedBeforeOpen && needsMigration(database)) {
      const integrity = database.pragma('integrity_check');
      if (integrity.length !== 1 || Object.values(integrity[0])[0] !== 'ok') {
        throw new Error('قاعدة البيانات غير سليمة؛ أُوقف الترحيل قبل أي تعديل.');
      }
      const journalMode = String(database.pragma('journal_mode', { simple: true })).toLowerCase();
      if (journalMode === 'wal') {
        const checkpoint = database.pragma('wal_checkpoint(FULL)')[0];
        if (!checkpoint || Number(checkpoint.busy) !== 0) throw new Error('تعذر مزامنة سجل WAL بأمان قبل الترحيل.');
      }
      if (options.backup !== false && sizeBeforeOpen > 0) {
        const backupPath = backupPlaintextStore(filePath, { keep: options.keep });
        if (!backupPath) throw new Error('تعذر إنشاء نسخة احتياطية قبل الترحيل؛ لم تُعدّل قاعدة البيانات.');
      }
    }
    migrate(database, {});
    return database;
  } catch (error) {
    database.close();
    if (/not a database|file is not a database|malformed|encrypted|SQLITE_NOTADB/i.test(error.message)) {
      throw new Error('تعذر فتح قاعدة البيانات: الملف ليس قاعدة بيانات SQLite عادية أو أنه تالف.');
    }
    throw error;
  }
}

/** Row count of one table, with the identifier quoted safely. */
function rowCount(database, table) {
  const identifier = '"' + String(table).replaceAll('"', '""') + '"';
  return Number(database.prepare(`SELECT count(*) AS count FROM ${identifier}`).get().count);
}

/** Our schema's own tables, excluding SQLite internals, in a stable order. */
function storeTables(database) {
  return database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((row) => row.name);
}

/**
 * Read the table list of a file through a fresh connection, optionally with a
 * SQLCipher key. Never throws: a wrong or missing key is reported, not raised.
 */
function probeTables(filePath, key) {
  let probe = null;
  try {
    probe = new Database(filePath, { readonly: true, timeout: 2000 });
    if (key) {
      probe.pragma("cipher = 'sqlcipher'");
      probe.pragma(`key = '${String(key).replaceAll("'", "''")}'`);
    }
    const tables = probe.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
    probe.close();
    probe = null;
    return { ok: true, tables };
  } catch (error) {
    try { if (probe) probe.close(); } catch { /* already closed */ }
    return { ok: false, error };
  }
}

/** True when a table list carries our own schema markers. */
function looksLikeStore(tables) {
  return tables.some((table) => STORE_MARKER_TABLES.includes(table.name));
}

/**
 * Turn a probe failure into a verdict. A malformed/corrupt file is *ours* and
 * must never be swapped for an empty store inside the same folder: the user
 * needs a restore, not a reset.
 */
function probeFailureReason(error, keyProvided) {
  const message = String(error?.message ?? '');
  if (/busy|locked/i.test(message)) return 'busy';
  if (/malformed|corrupt|SQLITE_CORRUPT/i.test(message)) return 'corrupt';
  if (/not a database|file is not a database|encrypted|SQLITE_NOTADB/i.test(message)) {
    // With a key in hand an unreadable file is foreign (or the key is wrong);
    // without one it is simply still encrypted.
    return keyProvided ? 'foreign' : 'encrypted';
  }
  return 'unknown';
}

/**
 * Probe `filePath` and say what it is — and *why* it failed when it fails — so a
 * busy file is never mistaken for a foreign one (which would trigger a
 * destructive quarantine).
 *
 * The plaintext probe comes first because plaintext is the normal case now and
 * needs no key at all; only a file that cannot be read that way falls through to
 * the keyed probe, which keeps working for legacy encrypted stores.
 *
 * @returns {{ ok:boolean, reason:'plaintext'|'readable'|'busy'|'corrupt'|'foreign'|'encrypted'|'unknown', error?:Error }}
 */
function classifyStore(filePath, key) {
  const plain = probeTables(filePath, null);
  if (plain.ok) {
    return looksLikeStore(plain.tables)
      ? { ok: true, reason: 'plaintext' }
      : { ok: false, reason: 'foreign' };
  }
  const plainReason = probeFailureReason(plain.error, false);
  // Busy or damaged is decided by the file itself: no key can change either
  // answer, and guessing here would be destructive.
  if (plainReason === 'busy' || plainReason === 'corrupt') {
    return { ok: false, reason: plainReason, error: plain.error };
  }
  if (key) {
    const keyed = probeTables(filePath, key);
    if (keyed.ok) {
      return looksLikeStore(keyed.tables)
        ? { ok: true, reason: 'readable' }
        : { ok: false, reason: 'foreign' };
    }
    return { ok: false, reason: probeFailureReason(keyed.error, true), error: keyed.error };
  }
  return { ok: false, reason: plainReason, error: plain.error };
}

/**
 * True when `filePath` can be read with `key` and looks like one of our databases.
 * Never throws — a foreign or passphrase-only file simply returns false.
 */
function canOpenWithKey(filePath, key) {
  return classifyStore(filePath, key).ok;
}

// ---------------------------------------------------------------------------
// Strong verification, shared by every call site that copies or swaps a store.
// ---------------------------------------------------------------------------

/** Read just the 16 header bytes; never loads the whole file. */
function readFileHeader(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(16);
    const read = fs.readSync(fd, buffer, 0, 16, 0);
    return buffer.subarray(0, read).toString('latin1');
  } finally {
    fs.closeSync(fd);
  }
}

/** Sorted `<type> <name> <sql>` texts of sqlite_master: the schema fingerprint. */
function sqliteMasterTexts(database) {
  return database
    .prepare('SELECT type, name, sql FROM sqlite_master ORDER BY type, name')
    .all()
    .map((row) => `${row.type} ${row.name} ${row.sql ?? ''}`)
    .sort();
}

/**
 * Capture the strong identity of a database: since our schema marks the file
 * (see STORE_MARKER_TABLES), the table list, the per-table row counts and the
 * sorted sqlite_master SQL texts together prove "same content", not merely
 * "a readable SQLite file". integrity_check runs first: a damaged database is
 * never used as a reference and never installed.
 *
 * Throws an Arabic error when the file cannot be read or is not sound.
 */
function inspectStore(filePath, key) {
  const database = new Database(filePath, { readonly: true, timeout: 5000 });
  try {
    if (key) {
      database.pragma("cipher = 'sqlcipher'");
      database.pragma(`key = '${String(key).replaceAll("'", "''")}'`);
    }
    const integrity = database.pragma('integrity_check');
    if (integrity.length !== 1 || Object.values(integrity[0])[0] !== 'ok') {
      throw new Error(`فحص السلامة (integrity_check) لم ينجح في «${filePath}».`);
    }
    const tables = storeTables(database);
    const counts = {};
    for (const name of tables) counts[name] = rowCount(database, name);
    return {
      tables,
      counts,
      rows: Object.values(counts).reduce((total, count) => total + count, 0),
      sql: sqliteMasterTexts(database),
    };
  } finally {
    database.close();
  }
}

/** Refuse a candidate that does not carry our schema markers at all. */
function assertStoreTables(tables, label, filePath) {
  if (!tables.some((name) => STORE_MARKER_TABLES.includes(name))) {
    throw new Error(`${label}: الملف «${filePath}» لا يحتوي جداول النظام (${STORE_MARKER_TABLES.join('، ')})؛ ليس قاعدة بيانات هذا التطبيق.`);
  }
}

/**
 * Compare a candidate against a captured identity. The sqlite_master SQL set is
 * compared too, so a copy that merely happens to have the same row counts cannot
 * pass. When the expectation carries no sql set (for example the recovery marker)
 * that comparison is skipped.
 */
function assertSameIdentity(expected, actual, label, filePath) {
  const sameTables = expected.tables.length === actual.tables.length
    && expected.tables.every((name, index) => name === actual.tables[index]);
  if (!sameTables) {
    throw new Error(`${label}: قائمة الجداول في «${filePath}» لا تطابق الأصل (${expected.tables.join('، ')} ← ${actual.tables.join('، ')}).`);
  }
  for (const name of expected.tables) {
    if (actual.counts[name] !== expected.counts[name]) {
      throw new Error(`${label}: عدد صفوف الجدول «${name}» في «${filePath}» (${actual.counts[name]}) لا يطابق الأصل (${expected.counts[name]}).`);
    }
  }
  if (Array.isArray(expected.sql)) {
    const sameSql = expected.sql.length === actual.sql.length
      && expected.sql.every((text, index) => text === actual.sql[index]);
    if (!sameSql) {
      throw new Error(`${label}: نصوص SQL في sqlite_master داخل «${filePath}» لا تطابق الأصل.`);
    }
  }
}

/**
 * THE shared strong verification: header (for plaintext candidates),
 * integrity_check, foreign_key_check, table list, per-table row counts and the
 * sqlite_master SQL set — applied identically to the exported candidate, to a
 * restore candidate before the swap and to the installed store after it, so the
 * call sites cannot drift apart.
 *
 * @returns the captured identity of the verified file
 */
function verifyStoreIdentity(filePath, key, expected, options = {}) {
  const label = options.label ?? 'التحقق من قاعدة البيانات';
  if (options.requirePlaintext) {
    const header = readFileHeader(filePath);
    if (header !== SQLITE_HEADER) {
      throw new Error(`${label}: الملف «${filePath}» ليس قاعدة بيانات SQLite عادية (ترويسة غير مطابقة).`);
    }
  }
  const actual = (() => {
    try {
      return inspectStore(filePath, key);
    } catch (error) {
      throw new Error(`${label}: تعذّر فحص «${filePath}» (${error.message}).`);
    }
  })();
  assertStoreTables(actual.tables, label, filePath);
  try {
    const database = new Database(filePath, { readonly: true, timeout: 5000 });
    try {
      if (key) {
        database.pragma("cipher = 'sqlcipher'");
        database.pragma(`key = '${String(key).replaceAll("'", "''")}'`);
      }
      const foreignKeys = database.pragma('foreign_key_check');
      if (foreignKeys.length) {
        throw new Error(`${label}: مخالفة مفتاح خارجي (foreign_key_check) في «${filePath}».`);
      }
    } finally {
      database.close();
    }
  } catch (error) {
    throw error instanceof Error && String(error.message).startsWith(label)
      ? error
      : new Error(`${label}: تعذّر فحص «${filePath}» (${error.message}).`);
  }
  if (expected) assertSameIdentity(expected, actual, label, filePath);
  return actual;
}

// ---------------------------------------------------------------------------
// Interrupted-swap marker.
// ---------------------------------------------------------------------------

/** Path of the marker that guards one plaintext swap. */
function conversionMarkerPath(target) {
  return target + CONVERSION_MARKER_SUFFIX;
}

/**
 * Write the conversion marker. Flag 'wx' makes an existing marker an error: two
 * conversions must never run over the same store.
 */
function writeConversionMarker(target, data) {
  const markerPath = conversionMarkerPath(target);
  fs.writeFileSync(markerPath, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  return markerPath;
}

/**
 * Read the conversion marker, or null when there is none. A marker that exists
 * but cannot be understood is itself a recovery state: the caller must refuse
 * (never bootstrap an empty database) and point the user at the files.
 *
 * The marker is TRUSTED input for rename/delete calls, so a hand-edited one
 * must not be able to point recovery at an arbitrary file. Every path it names
 * is validated before it is returned: all three file paths must resolve inside
 * the store directory, the staging basename must start with the store basename,
 * and targetPath must equal the target. A marker that fails any check is
 * refused with an Arabic error and nothing on disk is touched.
 */
function readConversionMarker(target) {
  const markerPath = conversionMarkerPath(target);
  if (!fs.existsSync(markerPath)) return null;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  } catch (error) {
    throw new Error(`ملف علامة التحويل «${markerPath}» تالف ولا يمكن قراءته (${error.message}). `
      + `لم يُفتح أي ملف تلقائيًا. الخيارات: راجع الملفات «${target}.plaintext-*» و«${target}.encrypted-*.bak» يدويًا ثم احذف علامة التحويل، أو استعد النسخة الاحتياطية من مجلد backups.`);
  }
  const required = ['stagingPath', 'keptEncryptedPath', 'keyPath', 'targetPath'];
  for (const field of required) {
    if (typeof parsed?.[field] !== 'string' || !parsed[field]) {
      throw new Error(`ملف علامة التحويل «${markerPath}» ناقص الحقل «${field}»؛ لم يُفتح أي ملف تلقائيًا. `
        + `راجع «${target}.plaintext-*» و«${target}.encrypted-*.bak» يدويًا، أو استعد النسخة الاحتياطية من مجلد backups، ثم احذف علامة التحويل.`);
    }
  }

  // Path validation: nothing the marker names may escape the store directory.
  const resolvedTarget = path.resolve(target);
  const directory = path.dirname(resolvedTarget);
  const baseName = path.basename(resolvedTarget);
  const insideDirectory = (candidate) => {
    const relative = path.relative(directory, path.resolve(candidate));
    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
  };
  const problems = [];
  if (path.resolve(String(parsed.targetPath)) !== resolvedTarget) {
    problems.push(`الحقل targetPath «${parsed.targetPath}» لا يساوي مسار قاعدة البيانات «${resolvedTarget}»`);
  }
  if (!insideDirectory(parsed.stagingPath) || !path.basename(path.resolve(String(parsed.stagingPath))).startsWith(baseName)) {
    problems.push(`الحقل stagingPath «${parsed.stagingPath}» خارج مجلد قاعدة البيانات أو لا يخصّها`);
  }
  if (!insideDirectory(parsed.keptEncryptedPath)) {
    problems.push(`الحقل keptEncryptedPath «${parsed.keptEncryptedPath}» خارج مجلد قاعدة البيانات`);
  }
  if (!insideDirectory(parsed.keyPath)) {
    problems.push(`الحقل keyPath «${parsed.keyPath}» خارج مجلد قاعدة البيانات`);
  }
  if (problems.length) {
    throw new Error(`ملف علامة التحويل «${markerPath}» يشير إلى مسارات غير آمنة؛ لم يُحذف ولم يُعدّل أي ملف: ${problems.join('، ')}. `
      + `لم يُنشئ التطبيق قاعدة بيانات فارغة. الخيارات: تحقق من هذه الملفات يدويًا ثم احذف علامة التحويل، أو استعد النسخة الاحتياطية من مجلد backups.`);
  }
  return { ...parsed, markerPath };
}

/**
 * Write a plaintext copy of an encrypted store. Nothing is swapped or deleted:
 * the source file is only ever read, and the copy lands beside it as
 * `<file>.plaintext-<stamp>.db`.
 *
 * Mechanism — bounded memory, OS-streamed, verified:
 *   1. `fs.copyFileSync` makes an OS-level streaming copy of the database (and
 *      of any SQLite sidecar, so the copy is complete and consistent);
 *   2. the copy is opened with `PRAGMA cipher='sqlcipher'` + `PRAGMA key` and
 *      decrypted IN PLACE with `PRAGMA rekey = ''`, the form documented by the
 *      driver (node_modules/better-sqlite3-multiple-ciphers/README.md,
 *      "Encryption"). The pragma takes the decrypt branch; because a SQLCipher
 *      database always has a non-zero reserved area, sqlite3mc performs the
 *      decrypt as a VACUUM-style rebuild (sqlite3mcRunVacuumForRekey) through a
 *      temporary database on disk and then copies the pages back — NOT a
 *      page-by-page in-place rewrite. Memory is bounded and independent of the
 *      file size (page cache ~2 MB; the rebuild's temporary database is on
 *      disk). `db.rekey(Buffer.alloc(0))` is the equivalent API and also works,
 *      while `db.rekey('')` throws "Expected the key to be a Buffer".
 *
 * The former implementation called `database.serialize()`, which materialises
 * the whole image in memory: measured ONCE during this change on a
 * 152,678,400-byte store the peak RSS delta was ~173 MB. The copy+rekey form
 * needed ~2 MB for the same file.
 *
 * Verification after the decrypt is the shared strong check
 * (verifyStoreIdentity): 16-byte header read through fs.readSync,
 * integrity_check, foreign_key_check, identical table list, identical per-table
 * row counts and an identical sorted sqlite_master SQL set.
 *
 * Transient disk cost: approximately 4x the database size in the data directory
 * plus about 1x in the system temp directory (the rebuild's temporary database).
 *
 * @returns {{ outputPath:string, tables:string[], rows:number, bytes:number, durationMs:number, identity:object }}
 */
function exportStoreAsPlaintext(filePath, options = {}) {
  const source = path.resolve(String(filePath));
  if (!fs.existsSync(source)) {
    throw new Error(`لا توجد قاعدة بيانات للتحويل في المسار «${source}».`);
  }
  const keyPath = options.keyPath ? path.resolve(String(options.keyPath)) : null;
  if (!keyPath || !fs.existsSync(keyPath)) {
    throw new Error('يلزم ملف المفتاح (store.key) لتحويل قاعدة البيانات المشفّرة إلى صيغة SQLite عادية. لم يُعدّل أي ملف.');
  }
  const key = readStoreKey(keyPath);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outputPath = `${source}.plaintext-${stamp}.db`;
  const outputSidecars = SIDECAR_SUFFIXES.map((suffix) => outputPath + suffix);
  if (fs.existsSync(outputPath) || outputSidecars.some((candidate) => fs.existsSync(candidate))) {
    throw new Error(`يوجد ملف بالاسم «${outputPath}» مسبقًا؛ لم يُعدّل أي ملف.`);
  }

  const startedAt = Date.now();
  // The reference identity comes from the encrypted source itself, so a
  // wrong-content copy can never pass verification.
  const reference = verifyStoreIdentity(source, key, null, { label: 'التحقق من القاعدة المشفّرة قبل التحويل' });

  try {
    fs.copyFileSync(source, outputPath, fs.constants.COPYFILE_EXCL);
    if (process.platform !== 'win32') fs.chmodSync(outputPath, 0o600);
    for (const suffix of SIDECAR_SUFFIXES) {
      const sidecar = source + suffix;
      if (!fs.existsSync(sidecar)) continue;
      fs.copyFileSync(sidecar, outputPath + suffix, fs.constants.COPYFILE_EXCL);
      if (process.platform !== 'win32') fs.chmodSync(outputPath + suffix, 0o600);
    }

    const database = new Database(outputPath, { timeout: 5000 });
    try {
      database.pragma("cipher = 'sqlcipher'");
      database.pragma(`key = '${String(key).replaceAll("'", "''")}'`);
      // Force the codec to be applied and the copy to be readable first.
      database.prepare('SELECT count(*) AS count FROM sqlite_master').get();
      if (fs.existsSync(outputPath + '-wal')) {
        const checkpoint = database.pragma('wal_checkpoint(TRUNCATE)')[0];
        if (!checkpoint || Number(checkpoint.busy) !== 0) {
          throw new Error('تعذّر دمج سجل WAL في النسخة المرحلية قبل فك التشفير.');
        }
      }
      database.pragma('journal_mode = DELETE');
      database.pragma("rekey = ''");
    } finally {
      try { database.close(); } catch { /* already closed */ }
    }
    // The copy is plain SQLite now; no sidecar may survive beside it. The strong
    // verification below proves the main file alone carries every row.
    for (const sidecar of outputSidecars) removeQuietly(sidecar);
  } catch (error) {
    removeQuietly(outputPath);
    for (const sidecar of outputSidecars) removeQuietly(sidecar);
    throw new Error('تعذّر تحويل قاعدة البيانات إلى صيغة SQLite عادية؛ لم تُعدّل قاعدة البيانات الأصلية. السبب: ' + error.message);
  }

  let identity;
  try {
    identity = verifyStoreIdentity(outputPath, null, reference, {
      requirePlaintext: true,
      label: 'التحقق من النسخة العادية',
    });
  } catch (error) {
    removeQuietly(outputPath);
    for (const sidecar of outputSidecars) removeQuietly(sidecar);
    throw new Error('فشل التحقق من النسخة العادية؛ أُزيل الملف الناتج ولم تُعدّل قاعدة البيانات الأصلية. السبب: ' + error.message);
  }

  return {
    outputPath,
    tables: identity.tables,
    rows: identity.rows,
    bytes: fs.statSync(outputPath).size,
    durationMs: Date.now() - startedAt,
    identity,
  };
}

/**
 * Convert an encrypted store in place, crash-safely.
 *
 * Protocol (the marker covers the one unavoidable gap):
 *   1. a complete encrypted backup is written to `backups/` first;
 *   2. the verified plaintext copy is staged beside the store;
 *   3. the marker `<target>.plaintext-conversion.json` is written with flag 'wx'
 *      and records staging, kept-encrypted, key and target paths plus the
 *      expected table list, per-table counts and total rows;
 *   4. the original is COPIED (never moved) to `<target>.encrypted-<stamp>.bak`
 *      with its sidecars and key, so the live path keeps a valid store as long
 *      as possible;
 *   5. the live file is removed and the staging file is renamed into place — one
 *      rename whose success is tracked by `swapped`; a crash here is repaired at
 *      the next start by the marker (see recoverInterruptedConversion);
 *   6. the installed store is verified with the shared strong check
 *      (verifyStoreIdentity) before the marker is deleted, then stale kept
 *      encrypted originals are pruned.
 *
 * Rollback is keyed on `swapped`, never on an assumption about which step failed:
 *   - before the swap the live path still holds the untouched encrypted original,
 *     so nothing at the live path is deleted or renamed;
 *   - after the swap the half-installed plaintext is dropped and the kept
 *     encrypted copy is put back;
 *   - the live path is then re-verified: `restored` is true only when
 *     classifyStore(...).reason === 'readable', i.e. the encrypted original is
 *     genuinely back and opens with its key — never merely because a file with a
 *     valid header exists at the live path;
 *   - the copied key (and any partial kept copy) is deleted whenever the rollback
 *     did not leave a usable matching database beside it;
 *   - the thrown message names only paths that actually exist.
 */
/**
 * Compose the truthful Arabic message for a failed conversion.
 *
 * It lists ONLY paths that actually exist, in order of preference: the live path
 * when the encrypted original was genuinely put back, the kept encrypted
 * original (with its key), the `backups/` copy (with its key). It must never tell
 * the user their data is somewhere it is not — in particular `restored` must only
 * be true when the live path really holds the readable encrypted original, so a
 * leftover plaintext file that merely passes the weak classification is reported
 * as unverified instead of being blessed.
 */
function conversionFailureMessage({ cause, restored, target, keptEncrypted, keyPath, backupPath, markerPath }) {
  if (restored) {
    return `فشل تحويل قاعدة البيانات المشفّرة، والملف الأصلي المشفّر سليم في مكانه «${target}» ولم يُفقد شيء. السبب: ${cause.message}`;
  }
  const liveExists = fs.existsSync(target);
  const keptExists = fs.existsSync(keptEncrypted);
  const keptKeyExists = fs.existsSync(keptEncrypted + '.key');
  const backupExists = Boolean(backupPath) && fs.existsSync(backupPath);
  const backupKeyExists = backupExists && fs.existsSync(backupPath + '.key');
  const surviving = [];
  if (keptExists) {
    surviving.push(`- النسخة المشفّرة الأصلية: «${keptEncrypted}» (مفتاحها: «${keyPath}»، ونسخة مفتاحها بجانبها: ${keptKeyExists}).`);
  }
  if (backupExists) {
    surviving.push(`- النسخة الاحتياطية الكاملة: «${backupPath}»${backupKeyExists ? ` (مفتاحها: «${backupPath}.key»)` : ''}.`);
  }
  const lines = [
    'فشل تحويل قاعدة البيانات المشفّرة وتعذّرت إعادة الملف الأصلي إلى مكانه تلقائيًا.',
    surviving.length
      ? 'النسخ الموجودة فعليًا الآن:'
      : 'لا توجد نسخة محلية استطاع التطبيق تأكيد صلاحيتها؛ تحقق يدويًا قبل أي خطوة.',
    ...surviving,
  ];
  // Name the live path only with its real state: when a file is there it is a
  // leftover of the failed attempt (the encrypted original could not be put
  // back), never a copy the user may trust.
  if (liveExists) {
    lines.push(`- الملف الموجود في المسار الحيّ «${target}» باقٍ من المحاولة الفاشلة ولم يثبت أنه نسخة سليمة؛ لا تعتمد عليه.`);
  } else {
    lines.push(`- المسار الحيّ «${target}» لا يحتوي أي ملف الآن.`);
  }
  lines.push(`- مفتاح التخزين «${keyPath}» (${fs.existsSync(keyPath) ? 'موجود' : 'غير موجود'}).`);
  if (markerPath && fs.existsSync(markerPath)) {
    lines.push(`- علامة التحويل «${markerPath}» باقية حتى تُعالج الحالة.`);
  }
  const recovery = keptExists
    ? `الخيارات: احذف الملف غير الموثوق في المسار الحيّ إن وُجد، ثم انسخ الملف المشفّر «${keptEncrypted}» إلى «${target}» مع مفتاحه «${keyPath}» وأعِد التشغيل`
    : backupExists
      ? `الخيارات: استعد النسخة الاحتياطية «${backupPath}»${backupKeyExists ? ` مع مفتاحها «${backupPath}.key»` : ''} إلى «${target}» ثم أعِد التشغيل`
      : 'الخيارات: راجع الملفات يدويًا وتأكد من مكان آخر نسخة سليمة قبل أي خطوة';
  lines.push(`${recovery}.`);
  if (markerPath && fs.existsSync(markerPath)) {
    lines.push('أو شغّل التطبيق مرة أخرى ليُكمل الاستعادة تلقائيًا من علامة التحويل.');
  }
  lines.push(`السبب: ${cause.message}`);
  return lines.join('\n');
}

function convertEncryptedStoreInPlace(target, keyPath, key, log) {
  const backupPath = backupStore(target, { keyPath });
  if (!backupPath) {
    throw new Error(`تعذّر إنشاء نسخة احتياطية من «${target}» قبل التحويل؛ لم يُعدّل أي ملف.`);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const keptEncrypted = `${target}.encrypted-${stamp}.bak`;
  const keptEncryptedKey = keptEncrypted + '.key';
  const conversionMarker = conversionMarkerPath(target);
  let staging = null;
  let markerPath = null;
  let swapped = false;
  let database = null;
  let restored = false;

  try {
    // (export) The encryption backup is already in place (step 1 above); the
    // verified plaintext copy is staged here. exportStoreAsPlaintext cleans up
    // its own output when it fails, so no staging file survives it.
    const exported = exportStoreAsPlaintext(target, { keyPath });
    staging = exported.outputPath;

    // (marker) Written with flag 'wx' BEFORE anything is copied or swapped, so a
    // crash at any later step is repairable. An existing marker means another
    // instance or an unfinished earlier conversion: refuse, and never touch that
    // foreign marker — recovery still needs it.
    try {
      markerPath = writeConversionMarker(target, {
        stagingPath: staging,
        keptEncryptedPath: keptEncrypted,
        keyPath,
        targetPath: target,
        createdAt: new Date().toISOString(),
        expected: {
          tables: exported.identity.tables,
          counts: exported.identity.counts,
          rows: exported.rows,
        },
      });
    } catch (error) {
      if (error && error.code === 'EEXIST') {
        throw new Error(
          `ملف علامة التحويل «${conversionMarker}» موجود مسبقًا: يوجد تحويل سابق لم يكتمل أو نسخة أخرى من التطبيق تعمل الآن. `
          + `لم يُعدّل التطبيق قاعدة البيانات «${target}» ولم يستبدلها. `
          + `أغلق كل النسخ الأخرى من التطبيق، وتأكد من حالة الملفات السابقة («${target}.plaintext-*» و«${target}.encrypted-*.bak») ثم احذف ملف العلامة إن كانت العملية السابقة قد انتهت فعلًا. السبب: ${error.message}`
        );
      }
      // A non-EEXIST failure may have created a partial marker; remove it so a
      // later start does not treat it as a pending conversion.
      removeQuietly(conversionMarker);
      throw new Error(`تعذّر كتابة ملف علامة التحويل «${conversionMarker}»؛ لم يُعدّل التطبيق قاعدة البيانات. السبب: ${error.message}`);
    }

    // (copy) Copy, not move: the live path keeps a complete store until the
    // single rename at step 5.
    fs.copyFileSync(target, keptEncrypted, fs.constants.COPYFILE_EXCL);
    if (process.platform !== 'win32') fs.chmodSync(keptEncrypted, 0o600);
    for (const suffix of SIDECAR_SUFFIXES) {
      if (!fs.existsSync(target + suffix)) continue;
      fs.copyFileSync(target + suffix, keptEncrypted + suffix, fs.constants.COPYFILE_EXCL);
      if (process.platform !== 'win32') fs.chmodSync(keptEncrypted + suffix, 0o600);
    }
    copyStoreKey(keyPath, keptEncryptedKey);

    // (swap) Remove the live file, then install the verified plaintext. Only
    // AFTER the rename succeeds may a failure touch the live path.
    fs.rmSync(target, { force: true });
    for (const suffix of SIDECAR_SUFFIXES) removeQuietly(target + suffix);
    fs.renameSync(staging, target);
    swapped = true;
    for (const suffix of SIDECAR_SUFFIXES) {
      if (!fs.existsSync(staging + suffix)) continue;
      fs.renameSync(staging + suffix, target + suffix);
    }

    // (verify) Same strong verification as every other install point: a
    // wrong-content copy must never reach the live path or let the marker be
    // removed.
    verifyStoreIdentity(target, null, exported.identity, {
      requirePlaintext: true,
      label: 'التحقق من القاعدة العادية بعد التحويل',
    });

    database = openStore(target);
    removeQuietly(markerPath);
    pruneEncryptedOriginals(target, KEPT_ENCRYPTED_BACKUPS, log);
    log?.info?.(`[store] حُوّلت قاعدة بيانات مشفّرة إلى صيغة SQLite عادية (${exported.durationMs} ms). النسخة المشفّرة: «${keptEncrypted}»، النسخة الاحتياطية: «${backupPath}».`);
    return { database, converted: true, wasEncrypted: true, backupPath, recoveredFrom: null };
  } catch (error) {
    try { database?.close(); } catch { /* already closed */ }
    database = null;

    if (swapped) {
      // Only the post-swap branch may remove what is at the live path: it holds
      // the half-installed plaintext.
      removeQuietly(target);
      for (const suffix of SIDECAR_SUFFIXES) removeQuietly(target + suffix);
    }

    // Put the kept encrypted original back, but only when the live path is
    // EMPTY of it: a failure before the swap left the live encrypted file
    // untouched, and it must not be deleted or renamed in that case.
    if (!fs.existsSync(target) && fs.existsSync(keptEncrypted)) {
      try {
        fs.renameSync(keptEncrypted, target);
        for (const suffix of SIDECAR_SUFFIXES) {
          if (!fs.existsSync(keptEncrypted + suffix)) continue;
          try { fs.renameSync(keptEncrypted + suffix, target + suffix); } catch { /* sidecar best effort */ }
        }
      } catch { /* the kept copy stays where it is; the message below names it */ }
    }

    // The verdict comes from the file itself, never from a rename not throwing,
    // and never from the WEAK classification either: `ok` is true for any
    // plaintext file that merely has the right header and our marker tables, so a
    // bad plaintext copy that could not be deleted (antivirus/indexer lock) would
    // be reported as "the encrypted original is fine at the live path". Only
    // `readable` — the keyed classification of a genuine encrypted store of ours —
    // proves the encrypted original is really back.
    restored = fs.existsSync(target) && classifyStore(target, key).reason === 'readable';

    // A copied key must never outlive a usable matching database beside it, and a
    // partial kept copy must not be left looking like a recovery source.
    const keptUsable = fs.existsSync(keptEncrypted) && classifyStore(keptEncrypted, key).ok === true;
    if (!keptUsable) {
      removeQuietly(keptEncrypted);
      removeQuietly(keptEncryptedKey);
      for (const suffix of SIDECAR_SUFFIXES) removeQuietly(keptEncrypted + suffix);
    }

    // The marker stays unless the live path holds a valid store again: a later
    // start must be able to finish the recovery. A marker we did not write
    // (the EEXIST case above) is never touched.
    if (restored && markerPath) removeQuietly(markerPath);

    throw new Error(conversionFailureMessage({
      cause: error,
      restored,
      target,
      keptEncrypted,
      keyPath,
      backupPath,
      markerPath,
    }));
  } finally {
    // The staging file must never survive a throw. Once swapped it has already
    // been renamed onto the live path.
    if (!swapped && staging) {
      removeQuietly(staging);
      for (const suffix of SIDECAR_SUFFIXES) removeQuietly(staging + suffix);
    }
  }
}

/**
 * Repair an interrupted plaintext swap, driven by the conversion marker.
 *
 * States, in order (never creates an empty database):
 *   a) the live file exists and classifies as plaintext or readable with its key
 *      -> drop the stale marker and staging leftovers and open normally. A
 *      plaintext live file must ALSO pass the shared strong verification against
 *      `marker.expected` when the fingerprint is present, so an unverified copy
 *      left behind by a failed rollback is refused instead of opened;
 *   b) the live file is missing and a valid plaintext staging file exists
 *      -> finish the swap (rename staging into place), drop the marker;
 *   c) the live file is missing, no valid staging, but the kept encrypted backup
 *      exists (with a readable key) -> restore it to the live path, drop the
 *      marker, and let the caller convert once through the normal path;
 *   d) anything else -> throw an explicit error naming every path and the
 *      recovery options.
 *
 * @returns {string|null} what was recovered, for the returned object's `recoveredFrom`
 */
function recoverInterruptedConversion(target, key, marker, log) {
  const staging = path.resolve(marker.stagingPath);
  const kept = path.resolve(marker.keptEncryptedPath);
  const markerPath = marker.markerPath;
  const stagingPaths = [staging, ...SIDECAR_SUFFIXES.map((suffix) => staging + suffix)];
  const removeStaging = () => {
    for (const candidate of stagingPaths) removeQuietly(candidate);
  };
  const refuse = (detail) => new Error(
    'انقطع تحويل سابق إلى صيغة SQLite عادية وحالة الملفات تحتاج تدخلًا يدويًا؛ لم ينشئ التطبيق قاعدة بيانات فارغة.\n'
    + `- قاعدة البيانات الحالية: «${target}» (موجودة: ${fs.existsSync(target)}).\n`
    + `- النسخة المرحلية: «${staging}» (موجودة: ${fs.existsSync(staging)}).\n`
    + `- النسخة المشفّرة المحفوظة: «${kept}» (موجودة: ${fs.existsSync(kept)}).\n`
    + `- مفتاحها: «${marker.keyPath}» (موجود: ${fs.existsSync(path.resolve(String(marker.keyPath)))}).\n`
    + `- علامة التحويل: «${markerPath}».\n`
    + `التفصيل: ${detail}\n`
    + `الخيارات: (١) انسخ الملف المشفّر «${kept}» إلى «${target}» ثم احذف ملف العلامة وأعد التشغيل، `
    + `(٢) أو استعد نسخة من مجلد backups إلى «${target}» ثم احذف ملف العلامة، `
    + `(٣) أو احذف ملف العلامة يدويًا إن كانت قاعدة البيانات الحالية سليمة.`
  );

  const liveExists = fs.existsSync(target) && fs.statSync(target).size > 0;

  // (a) A live store that is still usable wins over any leftover. A file that
  // classifies as PLAINTEXT, however, is accepted only after the same strong
  // verification the swap itself demands, whenever the marker recorded an
  // `expected` fingerprint: a plaintext copy that survived a failed rollback (a
  // locked file could not be deleted) must never be opened silently just because
  // it has the right header and our table markers. Only a marker predating the
  // fingerprint falls back to the weaker classification.
  if (liveExists) {
    const verdict = classifyStore(target, key);
    if (verdict.ok) {
      if (verdict.reason === 'plaintext' && marker.expected) {
        try {
          verifyStoreIdentity(target, null, marker.expected, {
            requirePlaintext: true,
            label: 'التحقق من القاعدة العادية بعد انقطاع التحويل',
          });
        } catch (error) {
          // The marker stays: it is the evidence a human (or the manual path
          // below) needs, and nothing at the live path may be trusted as-is.
          throw refuse(`القاعدة الحالية عادية لكن محتواها لا يطابق ما وعدت به علامة التحويل، فلا يجوز فتحها كما هي. ${error.message}`);
        }
      }
      removeQuietly(markerPath);
      removeStaging();
      log?.info?.(`[store] حُذفت علامة تحويل قديمة وبقايا مرحلية بعد أن ثبت أن القاعدة الحالية في «${target}» سليمة.`);
      return null;
    }
    throw refuse(`القاعدة الحالية مصنّفة «${verdict.reason}» ولم تُفتح.`);
  }

  // (b) Finish the swap from a staging file that still verifies.
  if (fs.existsSync(staging)) {
    let stagingValid = true;
    let stagingError = '';
    try {
      verifyStoreIdentity(staging, null, marker.expected, {
        requirePlaintext: true,
        label: 'التحقق من النسخة المرحلية بعد انقطاع التحويل',
      });
    } catch (error) {
      stagingValid = false;
      stagingError = error.message;
    }
    if (stagingValid) {
      fs.renameSync(staging, target);
      for (const suffix of SIDECAR_SUFFIXES) {
        if (!fs.existsSync(staging + suffix)) continue;
        try { fs.renameSync(staging + suffix, target + suffix); } catch { /* sidecar best effort */ }
      }
      removeQuietly(markerPath);
      log?.info?.(`[store] أُكمل تحويل كان منقطعًا: نُقلت النسخة العادية المرحلية إلى «${target}».`);
      return 'plaintext-staging';
    }
    if (!fs.existsSync(kept)) throw refuse(`فشل التحقق من النسخة المرحلية: ${stagingError}`);
    removeStaging();
  }

  // (c) No staging: put the kept encrypted backup back and convert once.
  if (fs.existsSync(kept)) {
    const markerKeyPath = path.resolve(String(marker.keyPath));
    if (!fs.existsSync(markerKeyPath)) {
      throw refuse('النسخة المشفّرة المحفوظة موجودة لكن ملف مفتاحها مفقود، فلا يمكن فتحها ولا تحويلها.');
    }
    const markerKey = readStoreKey(markerKeyPath);
    if (!classifyStore(kept, markerKey).ok) {
      throw refuse('النسخة المشفّرة المحفوظة لا تُفتح بمفتاحها، فلا يمكن استعادتها تلقائيًا.');
    }
    fs.renameSync(kept, target);
    for (const suffix of SIDECAR_SUFFIXES) {
      if (!fs.existsSync(kept + suffix)) continue;
      try { fs.renameSync(kept + suffix, target + suffix); } catch { /* sidecar best effort */ }
    }
    removeQuietly(kept + '.key');
    removeQuietly(markerPath);
    removeStaging();
    log?.info?.(`[store] استُعيدت النسخة المشفّرة المحفوظة إلى «${target}» بعد انقطاع التحويل؛ سيُعاد التحويل مرة واحدة.`);
    return 'encrypted-backup';
  }

  // (d) Nothing usable anywhere: never bootstrap an empty database.
  throw refuse('لا توجد قاعدة بيانات حيّة ولا نسخة مرحلية صالحة ولا نسخة مشفّرة محفوظة.');
}

/**
 * The single production entry point for the store.
 *
 * Plaintext is the only mode. An encrypted store left by an earlier build is
 * converted once, at first open, with a verifiable backup and a marker-guarded
 * swap (see convertEncryptedStoreInPlace); nothing is destroyed and the
 * encrypted original keeps its key beside it. An interrupted swap is repaired
 * from the marker before anything else happens (see
 * recoverInterruptedConversion), and stale leftovers are pruned. When the live
 * store is missing but recovery artifacts exist — including a kept encrypted
 * original `<store>.encrypted-*.bak`, which holds every row — the call is refused
 * instead of bootstrapping an empty database (see findRecoverableLeftovers). The
 * leftover scan only runs while the live store is missing or empty, so a
 * successful conversion, which leaves up to two kept encrypted originals beside a
 * usable live store, never trips it.
 *
 * @returns {{ database:import('better-sqlite3-multiple-ciphers').Database, converted:boolean, wasEncrypted:boolean, backupPath:string|null, recoveredFrom:string|null }}
 */
function openOrConvertStore(filePath, options = {}) {
  const target = path.resolve(String(filePath));
  let keyPath = options.keyPath ? path.resolve(String(options.keyPath)) : null;
  const convert = options.convert !== false;
  const log = options.log ?? console;
  fs.mkdirSync(path.dirname(target), { recursive: true });

  // An interrupted swap is repaired first: the marker names every file involved.
  const marker = readConversionMarker(target);
  if (marker && !keyPath) keyPath = path.resolve(String(marker.keyPath));
  const keyFileExists = Boolean(keyPath) && fs.existsSync(keyPath);
  const key = keyFileExists ? readStoreKey(keyPath) : null;
  let recoveredFrom = null;
  if (marker) recoveredFrom = recoverInterruptedConversion(target, key, marker, log);

  const liveMissingOrEmpty = !fs.existsSync(target) || fs.statSync(target).size === 0;

  // No live store: a leftover artifact may be the ONLY local copy of the data
  // (a `.rollback-*` set written by a failed restore, a staged `.plaintext-*`
  // copy, a `.restore-*` file, or a kept encrypted original
  // `<store>.encrypted-*.bak` left by a conversion). Refuse to bootstrap an
  // empty database while any of them exists — the documented guarantee is that
  // an empty database is never created while recoverable data exists. A
  // brand-new install has no artifacts and still bootstraps below.
  //
  // Ordering is deliberate: recovery from the marker ran first, and this guard
  // runs only while the live store is missing or empty. A successful conversion
  // leaves a usable live store (plus kept encrypted originals), so the guard is
  // never even consulted there.
  if (liveMissingOrEmpty) {
    const leftovers = findRecoverableLeftovers(target, keyPath);
    if (leftovers.length) throw emptyStoreWithLeftoversError(target, keyPath, leftovers);
  }

  // Stale conversion/restore leftovers are pruned, but never anything a live
  // marker still references — and never a `.rollback-*` group while the live
  // store is missing or does not verify (that group may hold the only copy).
  pruneConversionLeftovers(target, keyPath, log, key);
  pruneEncryptedOriginals(target, KEPT_ENCRYPTED_BACKUPS, log);

  if (liveMissingOrEmpty) {
    // Brand-new store: bootstrap it in plaintext. No store.key is created,
    // because there is nothing to encrypt. (Recovery and the leftover guard
    // above already proved that no kept copy of the data exists.)
    const database = openStore(target, { backup: false });
    log?.info?.(`[store] قاعدة بيانات عادية جديدة في «${target}» (بلا تشفير).`);
    return { database, converted: false, wasEncrypted: false, backupPath: null, recoveredFrom };
  }

  const verdict = classifyStore(target, key);

  if (verdict.reason === 'plaintext') {
    return { database: openStore(target), converted: false, wasEncrypted: false, backupPath: null, recoveredFrom };
  }
  if (verdict.reason !== 'readable') {
    if (verdict.reason === 'busy') {
      throw new Error(`قاعدة البيانات «${target}» مفتوحة في نافذة أخرى من التطبيق. أغلق النسخة الأخرى ثم أعد المحاولة.`);
    }
    if (verdict.reason === 'corrupt') {
      throw new Error(`قاعدة البيانات «${target}» تالفة ولم يُعدّل التطبيق أي شيء. استعد أحدث نسخة احتياطية من مجلد backups أو انقل الملف يدويًا إلى مجلد آخر.`);
    }
    if (verdict.reason === 'encrypted' || verdict.reason === 'unknown') {
      throw new Error(`قاعدة البيانات «${target}» مشفّرة، ويلزم ملف المفتاح (store.key) لتحويلها إلى صيغة SQLite عادية. لم يُعدّل التطبيق أي ملف. `
        + 'استعد store.key من النسخة الاحتياطية ثم أعد المحاولة.');
    }
    throw new Error(`تعذّر فتح قاعدة البيانات «${target}»: المفتاح الموجود${keyPath ? ` في «${keyPath}»` : ''} لا يفتحها. لم يُعدّل التطبيق أي ملف.`);
  }
  if (!convert) {
    throw new Error(`قاعدة البيانات «${target}» مشفّرة والتحويل التلقائي معطّل؛ لم يُعدّل أي ملف.`);
  }
  const converted = convertEncryptedStoreInPlace(target, keyPath, key, log);
  return { ...converted, recoveredFrom };
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
  openStore,
  openOrConvertStore,
  exportStoreAsPlaintext,
  loadOrCreateStoreKey,
  canOpenWithKey,
  classifyStore,
  verifyStoreIdentity,
  backupStore,
  backupPlaintextStore,
  copyStoreKey,
  restoreBackupBundle,
  restorePlaintextBundle,
  listBackups,
  findLegacyBackups,
  quarantineLegacyDatabase,
};
