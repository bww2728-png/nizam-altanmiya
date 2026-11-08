'use strict';

/**
 * Tests for the hardening wave: schema additions, read audit, undo snapshots,
 * the field-access policy and the import plan.
 *
 * These are deliberately behavioural: each test proves the user-visible promise
 * (a value can be undone, a read is attributable, a sensitive field is not
 * exported, a bad workbook row never reaches the database) rather than the shape
 * of an internal function.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3-multiple-ciphers');

const { migrate, DIRECTORATE_COLUMN_MIGRATIONS } = require('../src/main/analysis/store-schema.cjs');
const { openEncryptedStore, backupStore, copyStoreKey, restoreBackupBundle, classifyStore, listBackups } = require('../src/main/store.cjs');
const persist = require('../src/main/analysis/persist.cjs');
const security = require('../src/main/security.cjs');
const { serializeAnalysis } = require('../src/main/analysis/serialize.cjs');


function openTestDatabase() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ldi-hardening-'));
  const filePath = path.join(directory, 'test.db');
  // Use the production open path so the review/import tables exist exactly as
  // they do in the application.
  const database = openEncryptedStore(filePath, 'test-key-hardening');
  return { database, directory, filePath };
}

function withDatabase(callback) {
  const context = openTestDatabase();
  try {
    return callback(context);
  } finally {
    context.database.close();
    fs.rmSync(context.directory, { recursive: true, force: true });
  }
}

function addDirectorate(database, overrides = {}) {
  const saved = persist.saveManualDirectorate(database, {
    districtName: 'مديرية الشعر',
    governorate: 'إب',
    values: {
      population: 43739,
      revenue: 75643312,
      povertyRatio: 0.55,
      projectCost: 250000000,
      frontLine: true,
      ...overrides,
    },
  });
  return saved.id;
}

test('migration adds the new tables and the warning column idempotently', () => withDatabase(({ database }) => {
  const tables = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
  for (const table of ['audit_reads', 'directorate_versions', 'ocr_drafts', 'ocr_field_confidence']) {
    assert.ok(tables.has(table), `missing table ${table}`);
  }
  const columns = new Set(database.prepare('PRAGMA table_info(directorates)').all().map((row) => row.name));
  for (const migration of DIRECTORATE_COLUMN_MIGRATIONS) {
    assert.ok(columns.has(migration.name), `missing column ${migration.name}`);
  }
  // Running the migration again must not throw.
  migrate(database);
  migrate(database);
}));

test('a read is recorded with its channel, entity and session', () => withDatabase(({ database }) => {
  persist.logRead(database, { sessionId: 'ses-1', channel: 'analysis:directorate:get', entity: 'directorates', entityId: 7, fields: 'revenue,povertyRatio', result: 'masked' });
  persist.logRead(database, { sessionId: 'ses-1', channel: 'data:export', entity: 'file', rowCount: 12 });
  const reads = persist.listReads(database, 10);
  assert.equal(reads.length, 2);
  assert.equal(reads[0].channel, 'data:export');
  assert.equal(reads[1].fields, 'revenue,povertyRatio');
  assert.equal(reads[1].session_id, 'ses-1');
}));

test('deleting a directorate is reversible through the snapshot', () => withDatabase(({ database }) => {
  const id = addDirectorate(database);
  persist.deleteDirectorate(database, id);
  assert.equal(persist.countDirectorates(database), 0);

  const [version] = persist.listVersions(database, id);
  assert.ok(version, 'a snapshot must exist after delete');
  assert.match(version.action, /before-delete/);

  persist.restoreDirectorateVersion(database, version.id);
  assert.equal(persist.countDirectorates(database), 1);
  const restored = persist.loadAnalysisRows(database)[0];
  assert.equal(restored.values.population, 43739);
}));

test('an edit is reversible to the previous value', () => withDatabase(({ database }) => {
  const id = addDirectorate(database);
  persist.saveManualDirectorate(database, { id, districtName: 'مديرية الشعر', governorate: 'إب', values: { population: 99999 } });
  assert.equal(persist.loadAnalysisRows(database)[0].values.population, 99999);

  const [version] = persist.listVersions(database, id);
  persist.restoreDirectorateVersion(database, version.id);
  assert.equal(persist.loadAnalysisRows(database)[0].values.population, 43739);
}));

test('the reviewer decision is stored, not dropped', () => withDatabase(({ database }) => {
  const id = addDirectorate(database);
  persist.saveManualDirectorate(database, {
    id,
    districtName: 'مديرية الشعر',
    governorate: 'إب',
    values: { reviewerDecision: 'معتمد' },
  });
  const record = persist.getDirectorate(database, id);
  assert.equal(record.reviewer_decision, 'معتمد');
  assert.throws(
    () => persist.saveManualDirectorate(database, { id, districtName: 'مديرية الشعر', governorate: 'إب', values: { reviewerDecision: 'قرار مخترع' } }),
    /قيم غير صالحة/,
  );
}));

test('shared profile masks restricted fields and the owner profile does not', () => withDatabase(({ database }) => {
  const id = addDirectorate(database);
  const record = persist.getDirectorate(database, id);
  const { DIRECTORATE_COLUMNS } = require('../src/main/analysis/store-schema.cjs');

  const asOwner = security.maskRecord(record, 'owner', DIRECTORATE_COLUMNS);
  assert.equal(asOwner.masked.length, 0);
  assert.equal(asOwner.record.revenue, 75643312);

  const asShared = security.maskRecord(record, 'shared', DIRECTORATE_COLUMNS);
  assert.ok(asShared.masked.includes('revenue'));
  assert.ok(asShared.masked.includes('povertyRatio'));
  assert.ok(asShared.masked.includes('frontLine'));
  assert.equal(asShared.record.revenue, null);
  assert.equal(asShared.record.population, 43739, 'public fields stay visible');
}));

test('the access profile persists and defaults to owner', () => withDatabase(({ database }) => {
  assert.equal(security.getAccessProfile(database), 'owner');
  assert.equal(security.setAccessProfile(database, 'shared'), 'shared');
  assert.equal(security.getAccessProfile(database), 'shared');
  assert.equal(security.setAccessProfile(database, 'anything-else'), 'owner');
}));

test('compact serialization drops per-row values but keeps the analysis usable', () => {
  const analysis = {
    rows: [{
      districtName: 'مديرية الشعر',
      governorate: 'إب',
      values: { population: 43739, revenue: 75643312, waterCoverage: 0.197 },
      rawValues: { population: '43739' },
      indicators: { waterDeficit: 80.3 },
      completeness: { present: 3, total: 13, ratio: 0.23, missingLabels: [] },
      sensitivity: { fragile: false },
    }],
    meta: {},
    summary: {},
    ranking: { replica: {}, calibrated: {} },
    sensitivity: { weight: { scenarios: [], perRow: [] }, sample: null },
    gaps: { summary: {}, perRow: [] },
    stats: {},
  };
  const compact = serializeAnalysis(analysis, { compact: true });
  assert.equal(compact.rows[0].values, undefined);
  assert.equal(compact.rows[0].rawValues, undefined);
  assert.deepEqual(compact.rows[0].restrictedPresent, ['revenue']);
  assert.equal(compact.rows[0].indicators.waterDeficit, 80.3);

  const full = serializeAnalysis(analysis);
  assert.equal(full.rows[0].values.population, 43739);
});

test('an encrypted-store backup includes its matching key and sidecars as one recoverable bundle', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ldi-backup-bundle-'));
  try {
    const databasePath = path.join(directory, 'development-data.db');
    const keyPath = path.join(directory, 'store.key');
    const key = 'a'.repeat(64);
    fs.writeFileSync(databasePath, 'encrypted-database-bytes');
    fs.writeFileSync(keyPath, key, { mode: 0o600 });
    fs.writeFileSync(databasePath + '-wal', 'wal-bytes');
    fs.writeFileSync(databasePath + '-shm', 'shm-bytes');

    const backup = backupStore(databasePath, { keyPath });
    assert.ok(backup);
    assert.equal(fs.readFileSync(backup, 'utf8'), 'encrypted-database-bytes');
    assert.equal(fs.readFileSync(backup + '.key', 'utf8').trim(), key);
    assert.equal(fs.readFileSync(backup + '-wal', 'utf8'), 'wal-bytes');
    assert.equal(fs.readFileSync(backup + '-shm', 'utf8'), 'shm-bytes');
    assert.deepEqual(listBackups(databasePath), [backup]);

    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(backup).mode & 0o077, 0);
      assert.equal(fs.statSync(backup + '.key').mode & 0o077, 0);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('a missing or malformed encryption key prevents creation of a misleading database-only backup', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ldi-backup-invalid-key-'));
  try {
    const databasePath = path.join(directory, 'development-data.db');
    const keyPath = path.join(directory, 'store.key');
    fs.writeFileSync(databasePath, 'encrypted-database-bytes');
    assert.throws(() => backupStore(databasePath), /يجب توفير مفتاح التخزين/);
    assert.throws(() => backupStore(databasePath, { keyPath }), /store.key غير موجود/);
    assert.equal(fs.existsSync(path.join(directory, 'backups')), false);

    fs.writeFileSync(keyPath, 'not-a-valid-key');
    assert.throws(() => backupStore(databasePath, { keyPath }), /مفتاح التخزين غير صالح/);
    assert.equal(listBackups(databasePath).length, 0);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('copyStoreKey writes only validated key material with private permissions', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ldi-copy-key-'));
  try {
    const keyPath = path.join(directory, 'store.key');
    const targetPath = path.join(directory, 'backup.key');
    fs.writeFileSync(keyPath, 'b'.repeat(64));
    copyStoreKey(keyPath, targetPath);
    assert.equal(fs.readFileSync(targetPath, 'utf8').trim(), 'b'.repeat(64));
    if (process.platform !== 'win32') assert.equal(fs.statSync(targetPath).mode & 0o077, 0);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});


test('restore swaps an encrypted database and its matching key as one verified bundle', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ldi-restore-bundle-'));
  const livePath = path.join(directory, 'development-data.db');
  const liveKeyPath = path.join(directory, 'store.key');
  const backupPath = path.join(directory, 'development-data.db.2026-11-08.bak');
  const liveKey = 'b'.repeat(64);
  const backupKey = 'a'.repeat(64);
  try {
    const live = openEncryptedStore(livePath, liveKey);
    live.exec("CREATE TABLE restore_marker (value TEXT NOT NULL); INSERT INTO restore_marker VALUES ('live-before-restore')");
    live.close();
    fs.writeFileSync(liveKeyPath, liveKey, { mode: 0o600 });

    const backup = openEncryptedStore(backupPath, backupKey);
    backup.exec("CREATE TABLE restore_marker (value TEXT NOT NULL); INSERT INTO restore_marker VALUES ('from-backup')");
    backup.close();
    const sourceKeyPath = path.join(directory, 'source.key');
    fs.writeFileSync(sourceKeyPath, backupKey, { mode: 0o600 });
    copyStoreKey(sourceKeyPath, backupPath + '.key');

    const restored = restoreBackupBundle(backupPath, livePath, liveKeyPath);
    assert.equal(restored.restoredPath, livePath);
    assert.equal(fs.readFileSync(liveKeyPath, 'utf8').trim(), backupKey);
    assert.equal(classifyStore(livePath, backupKey).ok, true);
    const opened = openEncryptedStore(livePath, backupKey);
    try {
      assert.equal(opened.prepare('SELECT value FROM restore_marker').get().value, 'from-backup');
    } finally {
      opened.close();
    }
    assert.equal(fs.readdirSync(directory).some((name) => name.includes('.rollback-')), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('invalid restore bundle is rejected before changing the live encrypted database', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ldi-restore-invalid-'));
  const livePath = path.join(directory, 'development-data.db');
  const liveKeyPath = path.join(directory, 'store.key');
  const backupPath = path.join(directory, 'bad-backup.bak');
  const liveKey = 'c'.repeat(64);
  try {
    const live = openEncryptedStore(livePath, liveKey);
    live.exec("CREATE TABLE restore_marker (value TEXT NOT NULL); INSERT INTO restore_marker VALUES ('preserve-me')");
    live.close();
    fs.writeFileSync(liveKeyPath, liveKey, { mode: 0o600 });
    fs.writeFileSync(backupPath, 'not-a-sqlcipher-database');
    fs.writeFileSync(backupPath + '.key', 'd'.repeat(64), { mode: 0o600 });

    assert.throws(() => restoreBackupBundle(backupPath, livePath, liveKeyPath), /تعذّر التحقق من النسخة الاحتياطية/);
    assert.equal(fs.readFileSync(liveKeyPath, 'utf8').trim(), liveKey);
    const opened = openEncryptedStore(livePath, liveKey);
    try {
      assert.equal(opened.prepare('SELECT value FROM restore_marker').get().value, 'preserve-me');
    } finally {
      opened.close();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

