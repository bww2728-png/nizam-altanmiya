'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3-multiple-ciphers');

const integrity = require('../src/main/database/migration-integrity.cjs');
const storeSchema = require('../src/main/analysis/store-schema.cjs');

/*
 * Digests recorded inside the user's live store by the packaged installer whose
 * git checkout used CRLF line endings. Opening that store with an LF build used
 * to abort every open with «تم تعديل الترحيل بعد تطبيقه», which locked the
 * application out of its own database. These constants pin the exact values that
 * were observed in the field so the regression can never return silently.
 */
const LEGACY = {
  architectureV4: '14899aaddc8d9d96609f58f16e38608e987a5b43239becb1de597ca94a334024',
  architectureV5: '5dbf745116cf35e413f0851d3d12eb8f8686863a21dd279f4236a1e1652dbd7f',
  modelV1: '44d805896c86f44b0712de40ce5aba34883dbcda39431a8fd89df016ccff0795',
  modelSeedPolicyV2: 'ba48ee4ece0b994a0ffec77715abefdc19b659891c8d6391431044cbcc637026',
};

/** Load the migration modules while forcing every `.sql` read to CRLF or LF. */
function loadChecksums(forceCrlf) {
  const realRead = fs.readFileSync;
  if (forceCrlf) {
    fs.readFileSync = function patched(target, options) {
      const value = realRead.call(fs, target, options);
      if (typeof target === 'string' && target.endsWith('.sql') && typeof value === 'string') {
        return value.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
      }
      return value;
    };
  }
  try {
    const root = path.join(__dirname, '..', 'src', 'main');
    for (const key of Object.keys(require.cache)) if (key.startsWith(root)) delete require.cache[key];
    return {
      architecture: require('../src/main/database/architecture.cjs').checksum(),
      model: require('../src/main/database/unified-development-model.cjs').checksum(),
      modelV2: require('../src/main/database/unified-development-model-v2.cjs').checksum(),
      store: require('../src/main/analysis/store-schema.cjs').checksum(),
    };
  } finally {
    fs.readFileSync = realRead;
  }
}

function freshStore() {
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  storeSchema.migrate(database);
  return database;
}

/** Reproduce the state the packaged CRLF installer left behind. */
function markStoreAsLegacyInstaller(database) {
  database.prepare('UPDATE schema_migrations SET checksum=? WHERE version=4').run(LEGACY.architectureV4);
  database.prepare('UPDATE schema_migrations SET checksum=? WHERE version=5').run(LEGACY.architectureV5);
  database.prepare('UPDATE development_model_migrations SET checksum=? WHERE version=1').run(LEGACY.modelV1);
  database.prepare('UPDATE development_model_migrations SET checksum=? WHERE version=2').run(LEGACY.modelSeedPolicyV2);
  database.prepare('DELETE FROM store_schema_migrations WHERE version=? AND migration_code=?')
    .run(storeSchema.MIGRATION_VERSION, storeSchema.MIGRATION_CODE);
}

test('migration checksums do not depend on the line endings of the checkout', () => {
  const lf = loadChecksums(false);
  const crlf = loadChecksums(true);
  assert.deepEqual(crlf, lf);
  for (const value of Object.values(lf)) assert.match(value, /^[a-f0-9]{64}$/);
});

test('checksum candidates expose a canonical digest plus the CRLF variant', () => {
  const lfDocument = 'CREATE TABLE a(x);\nCREATE TABLE b(y);\n';
  const fromLf = integrity.migrationChecksums({ text: lfDocument, definition: '{"a":1}', suffix: 'composite' });
  const fromCrlf = integrity.migrationChecksums({ text: lfDocument.replace(/\n/g, '\r\n'), definition: '{"a":1}', suffix: 'composite' });

  assert.equal(fromLf.canonical, fromCrlf.canonical);
  assert.equal(fromLf.lineEndingVariant, fromCrlf.lineEndingVariant);
  assert.notEqual(fromLf.canonical, fromLf.lineEndingVariant);
  assert.equal(integrity.classifyRecordedChecksum(fromLf.canonical, fromLf), 'verified');
  assert.equal(integrity.classifyRecordedChecksum(fromLf.lineEndingVariant, fromLf), 'line-ending-variant');
  assert.equal(integrity.classifyRecordedChecksum('0'.repeat(64), fromLf), 'drift');
  assert.equal(integrity.classifyRecordedChecksum(fromLf.canonical.toUpperCase(), fromLf), 'drift');
  assert.equal(integrity.canonicalText('\uFEFFa\r\nb\rc'), 'a\nb\nc');
});

test('a store written by the CRLF installer upgrades instead of locking the app out', () => {
  const database = freshStore();
  try {
    markStoreAsLegacyInstaller(database);
    assert.equal(storeSchema.needsMigration(database), true);

    const result = storeSchema.migrate(database);
    assert.equal(result.version, storeSchema.MIGRATION_VERSION);

    const architectureV4 = database.prepare('SELECT checksum, details FROM schema_migrations WHERE version=4').get();
    assert.equal(architectureV4.checksum, LEGACY.architectureV4);
    assert.match(String(architectureV4.details), /checksum-line-ending-variant: applied=14899aaddc8d9d96/);

    const architectureV5 = database.prepare('SELECT checksum, details FROM schema_migrations WHERE version=5').get();
    assert.equal(architectureV5.checksum, LEGACY.architectureV5);
    assert.match(String(architectureV5.details), /checksum-line-ending-variant/);

    const modelV1 = database.prepare('SELECT checksum, details FROM development_model_migrations WHERE version=1').get();
    assert.equal(modelV1.checksum, LEGACY.modelV1);
    assert.match(String(modelV1.details), /checksum-line-ending-variant: applied=44d805896c86f44b/);

    const seedPolicy = database.prepare('SELECT checksum, details FROM development_model_migrations WHERE version=2').get();
    assert.equal(seedPolicy.checksum, LEGACY.modelSeedPolicyV2);
    assert.match(String(seedPolicy.details), /checksum-line-ending-variant: applied=ba48ee4ece0b994a/);

    const storeRow = database.prepare('SELECT success, checksum FROM store_schema_migrations WHERE version=? AND migration_code=?')
      .get(storeSchema.MIGRATION_VERSION, storeSchema.MIGRATION_CODE);
    assert.equal(Number(storeRow.success), 1);
    assert.equal(storeRow.checksum, storeSchema.checksum());

    assert.equal(database.pragma('foreign_key_check').length, 0);
    const integrityReport = database.pragma('integrity_check');
    assert.equal(String(Object.values(integrityReport[0])[0]).toLowerCase(), 'ok');

    const second = storeSchema.migrate(database);
    assert.equal(second.alreadyApplied, true);
    const afterSecond = database.prepare('SELECT details FROM schema_migrations WHERE version=4').get();
    assert.equal(String(afterSecond.details).split('checksum-line-ending-variant').length - 1, 1);
  } finally {
    database.close();
  }
});

test('an unexplained checksum difference is reported instead of blocking the open', () => {
  const database = freshStore();
  try {
    const unexplained = 'f'.repeat(64);
    database.prepare('UPDATE schema_migrations SET checksum=? WHERE version=4').run(unexplained);
    database.prepare('DELETE FROM store_schema_migrations WHERE version=? AND migration_code=?')
      .run(storeSchema.MIGRATION_VERSION, storeSchema.MIGRATION_CODE);

    storeSchema.migrate(database);

    const row = database.prepare('SELECT checksum, details FROM schema_migrations WHERE version=4').get();
    assert.equal(row.checksum, unexplained);
    assert.match(String(row.details), /checksum-drift: applied=f{64}/);
  } finally {
    database.close();
  }
});

test('a previously failed migration row does not block the next attempt', () => {
  const database = freshStore();
  try {
    database.prepare(`INSERT OR REPLACE INTO store_schema_migrations(version,migration_code,checksum,applied_at,execution_ms,success,details)
      VALUES(?,?,?,?,?,0,?)`).run(storeSchema.MIGRATION_VERSION, storeSchema.MIGRATION_CODE, 'a'.repeat(64), new Date().toISOString(), 1, 'failed');
    assert.equal(storeSchema.needsMigration(database), true);

    assert.doesNotThrow(() => storeSchema.migrate(database));

    const row = database.prepare('SELECT success FROM store_schema_migrations WHERE version=?').get(storeSchema.MIGRATION_VERSION);
    assert.equal(Number(row.success), 1);
    assert.equal(storeSchema.needsMigration(database), false);
  } finally {
    database.close();
  }
});

test('the store schema migration keeps a single version and code identity', () => {
  assert.equal(storeSchema.MIGRATION_VERSION, 5);
  assert.equal(storeSchema.MIGRATION_CODE, 'unified-store-schema-v5');
  const database = freshStore();
  try {
    const rows = database.prepare('SELECT version, migration_code FROM store_schema_migrations').all();
    assert.deepEqual(rows, [{ version: storeSchema.MIGRATION_VERSION, migration_code: storeSchema.MIGRATION_CODE }]);
  } finally {
    database.close();
  }
});