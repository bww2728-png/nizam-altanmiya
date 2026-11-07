const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { openEncryptedStore, loadOrCreateStoreKey } = require('../src/main/store.cjs');

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

test('encrypted store persists data and rejects an incorrect key', () => {
  withTemporaryDirectory((directory) => {
    const databasePath = path.join(directory, 'secure.db');
    const database = openEncryptedStore(databasePath, 'correct-local-passphrase');
    database.prepare('INSERT INTO import_batches(file_name,file_type,file_size,created_at) VALUES(?,?,?,?)').run('test.xlsx', 'xlsx', 10, '2026-01-01T00:00:00.000Z');
    database.close();
    const reopened = openEncryptedStore(databasePath, 'correct-local-passphrase');
    assert.equal(reopened.prepare('SELECT COUNT(*) AS count FROM import_batches').get().count, 1);
    reopened.close();
    assert.throws(() => openEncryptedStore(databasePath, 'incorrect-local-passphrase'), /تعذر فتح قاعدة البيانات/);
    assert.notEqual(fs.readFileSync(databasePath).subarray(0, 16).toString(), 'SQLite format 3\u0000');
  });
});

test('generated store key is created once, reused, and opens the same database', () => {
  withTemporaryDirectory((directory) => {
    const keyPath = path.join(directory, 'store.key');
    const databasePath = path.join(directory, 'development-data.db');

    const generated = loadOrCreateStoreKey(keyPath);
    assert.match(generated, /^[0-9a-f]{64}$/);
    // Re-opening must return the very same key, otherwise the encrypted file becomes unreadable.
    assert.equal(loadOrCreateStoreKey(keyPath), generated);

    const database = openEncryptedStore(databasePath, generated);
    database.prepare('INSERT INTO import_batches(file_name,file_type,file_size,created_at) VALUES(?,?,?,?)').run('auto.xlsx', 'xlsx', 10, '2026-01-01T00:00:00.000Z');
    database.close();

    const reopened = openEncryptedStore(databasePath, loadOrCreateStoreKey(keyPath));
    assert.equal(reopened.prepare('SELECT COUNT(*) AS count FROM import_batches').get().count, 1);
    reopened.close();
    // The file must stay opaque on disk, i.e. still encrypted by SQLCipher.
    assert.notEqual(fs.readFileSync(databasePath).subarray(0, 16).toString(), 'SQLite format 3\u0000');
  });
});
