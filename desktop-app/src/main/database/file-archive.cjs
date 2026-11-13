'use strict';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS file_archive (
    resource_type TEXT NOT NULL CHECK(resource_type IN ('document','workbook_import')),
    resource_id TEXT NOT NULL,
    archived_at TEXT NOT NULL,
    archived_by TEXT NOT NULL,
    PRIMARY KEY(resource_type, resource_id)
  );
  CREATE INDEX IF NOT EXISTS file_archive_archived_idx ON file_archive(archived_at DESC);
`;

function migrate(database) {
  database.exec(SCHEMA);
}

function normalizeTargets(input) {
  if (!Array.isArray(input) || input.length === 0 || input.length > 100) throw new Error('اختر ملفًا واحدًا على الأقل، وبحد أقصى 100 ملف في العملية.');
  const unique = new Map();
  for (const target of input) {
    const type = target?.resourceType;
    const id = String(target?.resourceId ?? '').trim();
    if (!['document', 'workbook_import'].includes(type) || !id || id.length > 100) throw new Error('توجد بيانات ملف غير صالحة في الطلب.');
    unique.set(`${type}:${id}`, { resourceType: type, resourceId: id });
  }
  return [...unique.values()];
}

function archive(database, input, actor = 'local-user') {
  const targets = normalizeTargets(input);
  const now = new Date().toISOString();
  const save = database.transaction(() => {
    for (const target of targets) {
      const exists = target.resourceType === 'document'
        ? database.prepare('SELECT id FROM document_records WHERE id=?').get(target.resourceId)
        : database.prepare('SELECT id FROM workbook_import_batches WHERE id=?').get(Number(target.resourceId));
      if (!exists) throw new Error(`الملف ${target.resourceId} لم يعد موجودًا.`);
      database.prepare(`INSERT INTO file_archive(resource_type,resource_id,archived_at,archived_by)
        VALUES(?,?,?,?) ON CONFLICT(resource_type,resource_id) DO NOTHING`)
        .run(target.resourceType, target.resourceId, now, String(actor).slice(0, 120));
    }
  });
  save();
  return { archived: targets.length };
}

function restore(database, input) {
  const targets = normalizeTargets(input);
  const remove = database.transaction(() => {
    let restored = 0;
    for (const target of targets) {
      restored += database.prepare('DELETE FROM file_archive WHERE resource_type=? AND resource_id=?')
        .run(target.resourceType, target.resourceId).changes;
    }
    return restored;
  });
  return { restored: remove() };
}

module.exports = { SCHEMA, migrate, archive, restore, normalizeTargets };
