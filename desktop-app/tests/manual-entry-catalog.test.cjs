'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3-multiple-ciphers');
const test = require('node:test');
const { migrate } = require('../src/main/analysis/store-schema.cjs');
const { openEncryptedStore, backupStore, restoreBackupBundle } = require('../src/main/store.cjs');
const manualEntryCatalog = require('../src/main/database/manual-entry-catalog.cjs');

test('manual-entry domain catalog is versioned, idempotent, and only exposes explicitly mapped published forms', () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  try {
    migrate(db);
    const catalog = manualEntryCatalog.listCatalog(db);
    assert.equal(catalog.domains.length, 18);
    assert.ok(catalog.domains.every(domain => domain.groups.length > 0));
    assert.ok(catalog.domains.every(domain => ['catalogued_needs_definition','partially_mapped'].includes(domain.definitionState)));
    assert.equal(catalog.domains.filter(domain => domain.definitionState === 'partially_mapped').length, 3);

    const groups = catalog.domains.flatMap(domain => domain.groups);
    assert.equal(groups.length, manualEntryCatalog.DOMAINS.reduce((total, [, , domainGroups]) => total + domainGroups.length, 0));
    assert.ok(groups.every(group => ['needs_semantic_definition','partial_form_available'].includes(group.definitionState)));

    const mappedGroups = groups.filter(group => group.forms.length > 0);
    assert.deepEqual(mappedGroups.map(group => group.forms.map(form => form.code)).flat().sort(), [
      'indicator_observation_v1', 'legacy_directorate_v1', 'project_funding_v1', 'project_v1',
    ]);
    assert.ok(mappedGroups.every(group => group.forms.every(form => form.versionId > 0)));

    const before = db.prepare('SELECT COUNT(*) AS count FROM manual_entry_groups').get().count;
    migrate(db);
    const after = db.prepare('SELECT COUNT(*) AS count FROM manual_entry_groups').get().count;
    assert.equal(after, before);
    const migration = db.prepare('SELECT migration_code,success FROM schema_migrations WHERE version=?').get(manualEntryCatalog.CATALOG_VERSION);
    assert.deepEqual(migration, { migration_code: manualEntryCatalog.CATALOG_CODE, success: 1 });
  } finally {
    db.close();
  }
});

test('manual-entry catalog migration reopens an encrypted store without losing existing data or duplicating rows', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),'ldi-entry-catalog-encrypted-'));
  const filePath = path.join(directory,'store.db');
  const key = 'test-only-encrypted-store-key';
  try {
    let db = openEncryptedStore(filePath,key);
    db.prepare("INSERT INTO app_settings(key,value,updated_at) VALUES('catalog-migration-test','preserved','2026-01-01')").run();
    db.close();
    db = openEncryptedStore(filePath,key);
    assert.equal(db.prepare("SELECT value FROM app_settings WHERE key='catalog-migration-test'").get().value,'preserved');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM manual_entry_domains').get().count,18);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM manual_entry_groups').get().count,
      manualEntryCatalog.DOMAINS.reduce((total, [, , groups]) => total + groups.length,0));
    assert.equal(db.prepare('SELECT success FROM schema_migrations WHERE version=?').get(manualEntryCatalog.CATALOG_VERSION).success,1);
    db.close();
  } finally {
    fs.rmSync(directory,{ recursive:true,force:true });
  }
});

test('a full encrypted store backup restores its key, schema, data and integrity after a failed-update simulation', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),'ldi-entry-restore-encrypted-'));
  const storePath = path.join(directory,'store.db');
  const keyPath = path.join(directory,'store.key');
  const key = 'f'.repeat(64);
  try {
    fs.writeFileSync(keyPath,key,{ mode:0o600 });
    let db = openEncryptedStore(storePath,key);
    db.prepare("INSERT INTO app_settings(key,value,updated_at) VALUES('manual-entry-restore','before','2026-11-12')").run();
    db.close();
    const backupPath = backupStore(storePath,{ keyPath });
    assert.ok(backupPath);
    db = openEncryptedStore(storePath,key);
    db.prepare("UPDATE app_settings SET value='after' WHERE key='manual-entry-restore'").run();
    db.close();

    restoreBackupBundle(backupPath,storePath,keyPath);
    db = openEncryptedStore(storePath,key);
    assert.equal(db.prepare("SELECT value FROM app_settings WHERE key='manual-entry-restore'").get().value,'before');
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM manual_entry_groups').get().count,
      manualEntryCatalog.DOMAINS.reduce((total, [, , groups]) => total + groups.length,0));
    db.close();
    db = openEncryptedStore(storePath,key);
    assert.equal(db.prepare("SELECT value FROM app_settings WHERE key='manual-entry-restore'").get().value,'before');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM manual_entry_groups').get().count,
      manualEntryCatalog.DOMAINS.reduce((total, [, , groups]) => total + groups.length,0));
    db.close();
  } finally {
    fs.rmSync(directory,{ recursive:true,force:true });
  }
});

test('manual-entry and comprehensive database share the same form and record lifecycle', () => {
  const app = fs.readFileSync(path.join(__dirname,'../src/renderer/App.jsx'),'utf8');
  const database = fs.readFileSync(path.join(__dirname,'../src/renderer/pages/Database.jsx'),'utf8');
  const entry = fs.readFileSync(path.join(__dirname,'../src/renderer/pages/DataEntry.jsx'),'utf8');
  const main = fs.readFileSync(path.join(__dirname,'../src/main/main.cjs'),'utf8');
  assert.match(app, /<DataEntry[^>]*onShowDatabase/);
  assert.match(app, /<Database[^>]*onDataChanged/);
  assert.match(database, /import DataEntry from '\.\/DataEntry\.jsx'/);
  assert.match(database, /<DataEntry[^>]*onDataChanged=\{onDataChanged\}/);
  assert.match(entry, /window\.localApp\.dataEntryCatalog\(\)/);
  assert.match(entry, /window\.localApp\.dataRecords\(/);
  assert.match(entry, /window\.localApp\.saveDataRecord\(/);
  assert.match(main, /if \(\['approve','reopen'\]\.includes\(request\.decision\)\) invalidateSheets\(\);/);
});
