'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MAX_DRAFT_BYTES = 4 * 1024 * 1024;

function createManualEntryDraftStore({ safeStorage, userDataPath, fileSystem = fs, pathModule = path }) {
  const filePath = pathModule.join(userDataPath, 'manual-entry-draft.enc');

  function encryptionAvailable() {
    if (!safeStorage?.isEncryptionAvailable?.()) return false;
    if (safeStorage.getSelectedStorageBackend?.() === 'basic_text') return false;
    return true;
  }

  function save(draft) {
    if (!encryptionAvailable()) throw new Error('التخزين الآمن المحلي للمسودة غير متاح على هذا الجهاز. أبقِ التطبيق مفتوحاً واحفظ البيانات في قاعدة النظام قبل إغلاقه.');
    const serialized = JSON.stringify({ version: 1, savedAt: new Date().toISOString(), draft });
    if (Buffer.byteLength(serialized, 'utf8') > MAX_DRAFT_BYTES) throw new Error('حجم المسودة أكبر من الحد الآمن المسموح به.');
    fileSystem.mkdirSync(userDataPath, { recursive: true });
    const encrypted = safeStorage.encryptString(serialized);
    const temporaryPath = `${filePath}.${process.pid}.tmp`;
    fileSystem.writeFileSync(temporaryPath, encrypted, { mode: 0o600 });
    fileSystem.renameSync(temporaryPath, filePath);
    return { saved: true, savedAt: JSON.parse(serialized).savedAt };
  }

  function load() {
    if (!fileSystem.existsSync(filePath)) return { available: encryptionAvailable(), draft: null };
    if (!encryptionAvailable()) throw new Error('المسودة المحفوظة موجودة لكن خدمة فك تشفيرها غير متاحة؛ لم تُحذف أو تُعدّل.');
    try {
      const envelope = JSON.parse(safeStorage.decryptString(fileSystem.readFileSync(filePath)));
      if (envelope?.version !== 1 || !envelope.draft || typeof envelope.draft !== 'object' || Array.isArray(envelope.draft)) {
        throw new Error('صيغة المسودة غير صالحة.');
      }
      return { available: true, draft: envelope.draft, savedAt: envelope.savedAt ?? null };
    } catch (error) {
      throw new Error(`تعذرت قراءة المسودة المحفوظة بأمان: ${String(error?.message ?? error).slice(0, 180)}`);
    }
  }

  function clear() {
    fileSystem.rmSync(filePath, { force: true });
    return { cleared: true };
  }

  return { encryptionAvailable, save, load, clear };
}

module.exports = { createManualEntryDraftStore, MAX_DRAFT_BYTES };
