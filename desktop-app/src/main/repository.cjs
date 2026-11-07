const MAX_REVIEW_BATCH = 5000;

function normalizeText(value, label, maxLength = 300) {
  const normalized = String(value ?? '').trim();
  if (normalized.length > maxLength) throw new Error(`الحقل ${label} أطول من المسموح.`);
  return normalized;
}

function saveImportBatch(database, extracted, createdAt = new Date().toISOString()) {
  const insertBatch = database.prepare('INSERT INTO import_batches(file_name,file_type,file_size,item_count,status,warnings_json,created_at) VALUES(?,?,?,?,?,?,?)');
  const insertItem = database.prepare('INSERT INTO review_items(batch_id,field_name,value_text,proposed_type,record_id,source_location,confidence,created_at) VALUES(?,?,?,?,?,?,?,?)');
  const batchId = database.transaction(() => {
    const result = insertBatch.run(extracted.fileName, extracted.fileType, extracted.fileSize, extracted.items.length, 'review', JSON.stringify(extracted.warnings || []), createdAt);
    const id = Number(result.lastInsertRowid);
    for (const item of extracted.items) insertItem.run(id, item.fieldName, item.value, item.proposedType || '', item.recordId || '', item.sourceLocation, item.confidence, createdAt);
    return id;
  })();
  return batchId;
}

/**
 * Update one review item.
 *
 * 0.3.0 ran a conditional UPDATE and returned `{success:false}` for an accepted
 * or rejected row, which the screen ignored — so the user saw "saved" while
 * nothing changed. Now every outcome returns an explicit message, and editing an
 * already-accepted row also updates the approved `data_values` row it produced,
 * so the two views cannot drift apart.
 */
function updateReviewItem(database, item) {
  const fields = {
    fieldName: normalizeText(item.fieldName, 'اسم الحقل'),
    value: normalizeText(item.value, 'القيمة', 10000),
    proposedType: normalizeText(item.proposedType, 'نوع السجل', 100),
    governorate: normalizeText(item.governorate, 'المحافظة', 120),
    district: normalizeText(item.district, 'المديرية', 120),
    subdistrict: normalizeText(item.subdistrict, 'العزلة', 120),
    settlement: normalizeText(item.settlement, 'التجمع/القرية', 160),
    recordId: normalizeText(item.recordId, 'معرّف السجل', 160),
  };
  const id = Number(item.id);
  if (!Number.isSafeInteger(id) || id <= 0) return { success: false, message: 'معرّف السجل غير صالح.' };

  return database.transaction(() => {
    const existing = database.prepare('SELECT * FROM review_items WHERE id = ?').get(id);
    if (!existing) return { success: false, message: 'السجل غير موجود في قاعدة البيانات.' };

    database.prepare(`UPDATE review_items SET field_name=?,value_text=?,proposed_type=?,governorate=?,district=?,subdistrict=?,settlement=?,record_id=? WHERE id=?`)
      .run(fields.fieldName, fields.value, fields.proposedType || 'غير محدد', fields.governorate, fields.district, fields.subdistrict, fields.settlement, fields.recordId, id);

    if (existing.status === 'accepted') {
      // The approved value is what the analysis sees; keep it in step with the
      // correction the reviewer just made.
      const synced = database.prepare(`
        UPDATE data_values SET field_name = ?, value_text = ?, source_location = ?
        WHERE governorate = ? AND district = ? AND subdistrict = ? AND settlement = ?
          AND record_type = ? AND record_id = ? AND field_name = ?
      `).run(
        fields.fieldName, fields.value, existing.source_location,
        existing.governorate, existing.district, existing.subdistrict, existing.settlement,
        existing.proposed_type || 'غير محدد', existing.record_id, existing.field_name,
      );
      return {
        success: true,
        synced: synced.changes,
        message: 'حُفظ التعديل وحدّث القيمة المعتمدة المرتبطة به.',
      };
    }
    if (existing.status === 'rejected') {
      return { success: true, synced: 0, message: 'السجل مرفوض؛ حُفظ النص المصحّح دون اعتماده.' };
    }
    return { success: true, synced: 0, message: 'حُفظت تعديلات المراجعة محليًا.' };
  })();
}

function resolveReviewItems(database, request) {
  const action = ['accept', 'replace', 'reject'].includes(request.action) ? request.action : null;
  const ids = [...new Set((Array.isArray(request.ids) ? request.ids : []).map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))].slice(0, MAX_REVIEW_BATCH);
  if (!action || !ids.length) throw new Error('حدد إجراءً وسجلًا واحدًا على الأقل.');
  const getItem = database.prepare('SELECT r.*, b.file_name FROM review_items r JOIN import_batches b ON b.id=r.batch_id WHERE r.id=? AND r.status IN (\'pending\',\'conflict\')');
  const normalInsert = database.prepare('INSERT OR IGNORE INTO data_values(governorate,district,subdistrict,settlement,record_type,record_id,field_name,value_text,source_item_id,source_file,source_location,imported_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)');
  const replaceValue = database.prepare('INSERT INTO data_values(governorate,district,subdistrict,settlement,record_type,record_id,field_name,value_text,source_item_id,source_file,source_location,imported_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(governorate,district,subdistrict,settlement,record_type,record_id,field_name) DO UPDATE SET value_text=excluded.value_text,source_item_id=excluded.source_item_id,source_file=excluded.source_file,source_location=excluded.source_location,imported_at=excluded.imported_at');
  const markItem = database.prepare('UPDATE review_items SET status=?,reviewed_at=? WHERE id=?');
  const refreshBatchStatus = database.prepare("UPDATE import_batches SET status=CASE WHEN EXISTS (SELECT 1 FROM review_items WHERE batch_id=? AND status IN ('pending','conflict')) THEN 'review' ELSE 'completed' END WHERE id=?");
  const now = new Date().toISOString();
  return database.transaction(() => {
    const result = { accepted: 0, rejected: 0, conflicts: 0, ignored: 0 };
    const affectedBatches = new Set();
    for (const id of ids) {
      const item = getItem.get(id);
      if (!item) { result.ignored += 1; continue; }
      affectedBatches.add(item.batch_id);
      if (action === 'reject') {
        markItem.run('rejected', now, id);
        result.rejected += 1;
        continue;
      }
      const geographicKey = [item.governorate, item.district, item.subdistrict, item.settlement];
      if (geographicKey.some((value) => !value.trim()) || !item.field_name.trim() || !item.value_text.trim()) {
        result.ignored += 1;
        continue;
      }
      const values = [...geographicKey, item.proposed_type || 'غير محدد', item.record_id, item.field_name, item.value_text, id, item.file_name, item.source_location, now];
      if (action === 'replace') {
        replaceValue.run(...values);
        markItem.run('accepted', now, id);
        result.accepted += 1;
      } else {
        const insertResult = normalInsert.run(...values);
        if (insertResult.changes) {
          markItem.run('accepted', now, id);
          result.accepted += 1;
        } else {
          markItem.run('conflict', now, id);
          result.conflicts += 1;
        }
      }
    }
    for (const batchId of affectedBatches) refreshBatchStatus.run(batchId, batchId);
    return result;
  })();
}

module.exports = { saveImportBatch, updateReviewItem, resolveReviewItems };
