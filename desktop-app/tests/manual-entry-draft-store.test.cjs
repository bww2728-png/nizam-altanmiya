'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createManualEntryDraftStore } = require('../src/main/database/manual-entry-draft-store.cjs');

function createSafeStorage(available = true) {
  return {
    isEncryptionAvailable: () => available,
    getSelectedStorageBackend: () => 'os_crypt',
    encryptString: value => Buffer.from(`test-cipher:${Buffer.from(value, 'utf8').toString('base64')}`),
    decryptString: value => {
      const serialized = value.toString('utf8');
      if (!serialized.startsWith('test-cipher:')) throw new Error('invalid ciphertext');
      return Buffer.from(serialized.slice('test-cipher:'.length), 'base64').toString('utf8');
    },
  };
}

test('manual-entry draft is atomically stored, restored and cleared through the safe-storage contract', t => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-draft-'));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  const store = createManualEntryDraftStore({ safeStorage: createSafeStorage(), userDataPath });
  const draft = { geoUnitId: 41, stepIndex: 3, valuesByForm: { 12: { population: { value: '100' } } }, skippedGroups: {} };
  assert.equal(store.load().draft, null);
  assert.equal(store.save(draft).saved, true);
  const savedFile = fs.readFileSync(path.join(userDataPath, 'manual-entry-draft.enc'));
  assert.ok(!savedFile.includes(Buffer.from('population')));
  const restartedStore = createManualEntryDraftStore({ safeStorage: createSafeStorage(), userDataPath });
  assert.deepEqual(restartedStore.load().draft, draft);
  assert.equal(restartedStore.clear().cleared, true);
  assert.equal(store.load().draft, null);
});

test('manual-entry draft refuses plaintext fallback when operating-system encryption is unavailable', t => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-draft-no-crypto-'));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  const store = createManualEntryDraftStore({ safeStorage: createSafeStorage(false), userDataPath });
  assert.throws(() => store.save({ valuesByForm: { 1: { field: { value: 'private' } } } }), /التخزين الآمن/);
  assert.equal(fs.existsSync(path.join(userDataPath, 'manual-entry-draft.enc')), false);
});
