'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const Database = require('better-sqlite3-multiple-ciphers');
const fileArchive = require('../src/main/database/file-archive.cjs');

function makeDatabase() {
  const database = new Database(':memory:');
  database.exec(`
    CREATE TABLE document_records (id TEXT PRIMARY KEY);
    CREATE TABLE workbook_import_batches (id INTEGER PRIMARY KEY);
    INSERT INTO document_records (id) VALUES ('document-1');
    INSERT INTO workbook_import_batches (id) VALUES (1);
  `);
  fileArchive.migrate(database);
  return database;
}

test('file archives are recoverable and do not delete their source records', () => {
  const database = makeDatabase();
  try {
    const targets = [
      { resourceType: 'document', resourceId: 'document-1' },
      { resourceType: 'workbook_import', resourceId: 1 },
    ];
    assert.deepEqual(fileArchive.archive(database, targets, 'owner'), { archived: 2 });
    assert.equal(database.prepare('SELECT COUNT(*) AS total FROM document_records').get().total, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS total FROM workbook_import_batches').get().total, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS total FROM file_archive').get().total, 2);
    assert.deepEqual(fileArchive.restore(database, targets), { restored: 2 });
    assert.equal(database.prepare('SELECT COUNT(*) AS total FROM file_archive').get().total, 0);
  } finally {
    database.close();
  }
});

test('file archives roll back as a unit when one selected file no longer exists', () => {
  const database = makeDatabase();
  try {
    assert.throws(() => fileArchive.archive(database, [
      { resourceType: 'document', resourceId: 'document-1' },
      { resourceType: 'workbook_import', resourceId: 99 },
    ], 'owner'), /لم يعد موجودًا/);
    assert.equal(database.prepare('SELECT COUNT(*) AS total FROM file_archive').get().total, 0);
  } finally {
    database.close();
  }
});
