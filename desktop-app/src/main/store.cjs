const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3-multiple-ciphers');

// The app does not ask the user for a passphrase any more. A 256-bit key is generated once,
// stored beside the user data (mode 0600) and reused, so the database file stays encrypted
// at rest without any step the user has to remember.
function loadOrCreateStoreKey(keyPath) {
  try {
    const existing = fs.readFileSync(keyPath, 'utf8').trim();
    if (/^[0-9a-f]{64}$/i.test(existing)) return existing;
  } catch {
    // First run: the key file does not exist yet.
  }
  const key = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(path.dirname(keyPath), { recursive: true });
  fs.writeFileSync(keyPath, key, { encoding: 'utf8', mode: 0o600 });
  return key;
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
    return database;
  } catch (error) {
    database.close();
    if (/not a database|file is not a database|malformed|encrypted|SQLITE_NOTADB/i.test(error.message)) {
      throw new Error('تعذر فتح قاعدة البيانات. قد تكون كلمة المرور غير صحيحة أو الملف تالفًا.');
    }
    throw error;
  }
}

module.exports = { openEncryptedStore, loadOrCreateStoreKey };
