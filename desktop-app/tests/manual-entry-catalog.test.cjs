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

// openEncryptedStore validates its passphrase as 64 hex characters before the
// legacy cipher is set up, so every call here uses one shared valid key.
const TEST_STORE_KEY = 'd'.repeat(64);

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

test('manual-entry candidate dictionary links existing definitions without enabling unreviewed forms', () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  try {
    migrate(db);
    const catalog = manualEntryCatalog.listCatalog(db);
    const groups = catalog.domains.flatMap(domain => domain.groups);
    const candidateGroups = groups.filter(group => group.fields.length > 0);
    const candidateCount = db.prepare('SELECT COUNT(*) AS count FROM manual_entry_group_field_candidates').get().count;
    const candidateFieldCodes = new Set(groups.flatMap(group => group.fields.map(field => field.code)));
    const publishedFieldCodes = groups.flatMap(group => group.publishedFields.map(field => field.code));
    assert.equal(manualEntryCatalog.FIELD_CANDIDATE_VERSION, 7);
    assert.equal(candidateGroups.length, 77);
    assert.equal(candidateCount, 384);
    assert.equal(groups.filter(group => group.fieldCoverageState === 'needs_domain_review').length, 77);
    assert.equal(groups.filter(group => group.fieldCoverageState === 'no_existing_field_mapping').length, 8);
    const compatibilityGroup = groups.find(group => group.code === 'administrative-geography.current-directorate-compatibility');
    assert.equal(compatibilityGroup.fieldCoverageState, 'published_fields_available');
    assert.equal(compatibilityGroup.publishedFields.length, 40);
    assert.ok(groups.flatMap(group => group.fields).every(field => field.code && field.mappingState === 'needs_domain_review'));
    assert.equal(publishedFieldCodes.length, 60);
    assert.equal(new Set([...candidateFieldCodes,...publishedFieldCodes]).size, 423);
    assert.equal(groups.filter(group => group.forms.length > 0).length, 4);
    assert.ok(catalog.fieldMappingNote.includes('يحتاج مراجعة دلالية'));

    db.exec('DROP TABLE manual_entry_group_field_candidates');
    db.prepare('DELETE FROM schema_migrations WHERE version=?').run(manualEntryCatalog.FIELD_CANDIDATE_VERSION);
    const legacyMigration = manualEntryCatalog.migrate(db);
    assert.equal(legacyMigration.fieldCandidates.alreadyApplied, false);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM manual_entry_group_field_candidates').get().count, candidateCount);
    assert.equal(db.prepare('SELECT success FROM schema_migrations WHERE version=?').get(manualEntryCatalog.FIELD_CANDIDATE_VERSION).success, 1);
  } finally {
    db.close();
  }
});

test('manual-entry candidate migration reopens the current plaintext SQLite store without losing data or duplicating links', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),'ldi-entry-catalog-plaintext-'));
  const filePath = path.join(directory,'store.db');
  let db;
  try {
    db = new Database(filePath);
    db.pragma('foreign_keys = ON');
    migrate(db);
    db.prepare("INSERT INTO app_settings(key,value,updated_at) VALUES('candidate-migration-test','preserved','2026-11-12')").run();
    const linkCount = db.prepare('SELECT COUNT(*) AS count FROM manual_entry_group_field_candidates').get().count;
    db.close();

    db = new Database(filePath);
    db.pragma('foreign_keys = ON');
    migrate(db);
    assert.equal(db.prepare("SELECT value FROM app_settings WHERE key='candidate-migration-test'").get().value,'preserved');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM manual_entry_group_field_candidates').get().count,linkCount);
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
  } finally {
    db?.close();
    fs.rmSync(directory,{ recursive:true,force:true });
  }
});

test('manual-entry catalog migration reopens an encrypted store without losing existing data or duplicating rows', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),'ldi-entry-catalog-encrypted-'));
  const filePath = path.join(directory,'store.db');
  try {
    let db = openEncryptedStore(filePath,TEST_STORE_KEY);
    db.prepare("INSERT INTO app_settings(key,value,updated_at) VALUES('catalog-migration-test','preserved','2026-01-01')").run();
    db.close();
    db = openEncryptedStore(filePath,TEST_STORE_KEY);
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
  try {
    fs.writeFileSync(keyPath,TEST_STORE_KEY,{ mode:0o600 });
    let db = openEncryptedStore(storePath,TEST_STORE_KEY);
    db.prepare("INSERT INTO app_settings(key,value,updated_at) VALUES('manual-entry-restore','before','2026-11-12')").run();
    db.close();
    const backupPath = backupStore(storePath,{ keyPath });
    assert.ok(backupPath);
    db = openEncryptedStore(storePath,TEST_STORE_KEY);
    db.prepare("UPDATE app_settings SET value='after' WHERE key='manual-entry-restore'").run();
    db.close();

    restoreBackupBundle(backupPath,storePath,keyPath);
    db = openEncryptedStore(storePath,TEST_STORE_KEY);
    assert.equal(db.prepare("SELECT value FROM app_settings WHERE key='manual-entry-restore'").get().value,'before');
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM manual_entry_groups').get().count,
      manualEntryCatalog.DOMAINS.reduce((total, [, , groups]) => total + groups.length,0));
    db.close();
    db = openEncryptedStore(storePath,TEST_STORE_KEY);
    assert.equal(db.prepare("SELECT value FROM app_settings WHERE key='manual-entry-restore'").get().value,'before');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM manual_entry_groups').get().count,
      manualEntryCatalog.DOMAINS.reduce((total, [, , groups]) => total + groups.length,0));
    db.close();
  } finally {
    fs.rmSync(directory,{ recursive:true,force:true });
  }
});

test('manual-entry field register covers every existing definition and preserves review-only status', () => {
  const { buildManualEntryFieldRegister, renderCsv } = require('../scripts/manual-entry-field-register.cjs');
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  try {
    migrate(db);
    const rows = buildManualEntryFieldRegister(db);
    const codes = new Set(rows.map(row => row.code));
    const catalog = manualEntryCatalog.listCatalog(db);
    const allCatalogCodes = new Set(catalog.domains.flatMap(domain => domain.groups.flatMap(group =>
      [...group.fields,...group.publishedFields].map(field => field.code))));
    const definitionCount = db.prepare('SELECT COUNT(*) AS count FROM field_definitions').get().count;
    assert.equal(definitionCount, 423);
    assert.equal(rows.length, definitionCount);
    assert.deepEqual(codes, allCatalogCodes);
    assert.equal(rows.filter(row => row.entryState === 'published_form_field').length, 60);
    assert.equal(rows.filter(row => row.entryState === 'review_only_candidate').length, 363);
    assert.ok(rows.every(row => row.specificationMatch === 'not_verified_against_each_clause'));
    assert.ok(rows.every(row => row.sourceBasis === 'current_unified_field_catalog_and_published_forms'));
    assert.match(renderCsv(rows), /field_code.*specification_match.*source_basis/);
  } finally {
    db.close();
  }
});

test('manual-entry coverage export matches the complete synthetic 86-group catalog', () => {
  const { buildCoverageRows, renderCoverageCsv } = require('../scripts/manual-entry-coverage.cjs');
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  try {
    migrate(db);
    manualEntryCatalog.migrate(db);
    const rows = buildCoverageRows(db);
    assert.equal(rows.length, 86);
    assert.equal(rows.filter(row => row.formCodes.length > 0).length, 4);
    assert.equal(rows.reduce((total, row) => total + row.publishedFields.length, 0), 60);
    assert.equal(rows.reduce((total, row) => total + row.candidateFields.length, 0), 384);
    assert.equal(rows.filter(row => row.mappingState === 'لا يوجد تعريف حقل حالي مرتبط').length, 7);
    const valueStates = rows.find(row => row.groupCode === 'crosscutting-documentation-quality.value-states');
    assert.equal(valueStates.candidateFields.length, 0);
    assert.match(valueStates.mappingState, /دعم تخزين/);
    const documented = fs.readFileSync(path.join(__dirname, '../../docs/architecture/central-manual-entry-coverage.csv'), 'utf8');
    assert.equal(renderCoverageCsv(rows), documented);
  } finally {
    db.close();
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
