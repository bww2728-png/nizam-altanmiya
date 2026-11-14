'use strict';

const manualEntryCatalog = require('./manual-entry-catalog.cjs');
const recordService = require('./record-service.cjs');
const { normalize } = require('./architecture.cjs');

function listWorkspaceCatalog(db) {
  const catalog = manualEntryCatalog.listCatalog(db);
  const domains = catalog.domains.map(domain => ({
    ...domain,
    groups: domain.groups.map(group => ({
      ...group,
      forms: group.forms.map(form => ({
        ...form,
        definition: form.versionId ? recordService.getFormDefinition(db, form.versionId) : null,
      })),
    })),
  }));
  return { ...catalog, domains };
}

function findExistingDirectorate(db, district, governorate) {
  const districtName = normalize(district);
  const governorateName = normalize(governorate);
  const rows = db.prepare(`SELECT coalesce(district.geo_unit_id,district.id) AS geoUnitId,coalesce(district.name_ar,district.name) AS districtName,
      coalesce(governorate.name_ar,governorate.name) AS governorateName
    FROM geographic_units district
    LEFT JOIN geographic_units governorate ON governorate.id=district.parent_id
    WHERE district.unit_type IN ('district','directorate')
      AND district.normalized_name=?
      AND coalesce(governorate.normalized_name,'')=? AND coalesce(district.is_active,1)=1
    LIMIT 2`).all(districtName, governorateName);
  if (rows.length > 1) throw new Error('اسم المديرية يطابق أكثر من موقع جغرافي؛ صحّح المرجع قبل الحفظ.');
  return rows[0] ?? null;
}

function findDirectorateByGeoUnitId(db, geoUnitId) {
  const id = Number(geoUnitId);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return db.prepare(`SELECT unit.geo_unit_id AS geoUnitId,unit.name_ar AS districtName,parent.name_ar AS governorateName
    FROM geographic_units unit JOIN geo_unit_types type ON type.geo_unit_type_id=unit.geo_unit_type_id
    LEFT JOIN geographic_units parent ON parent.geo_unit_id=unit.parent_geo_unit_id
    WHERE unit.geo_unit_id=? AND type.type_code='directorate' AND unit.is_active=1`).get(id) ?? null;
}

function ensureDirectorateGeography(db, district, governorate, now) {
  const governorateName = normalize(governorate);
  const districtName = normalize(district);
  const governorateType = db.prepare("SELECT geo_unit_type_id FROM geo_unit_types WHERE type_code='governorate'").get();
  const directorateType = db.prepare("SELECT geo_unit_type_id FROM geo_unit_types WHERE type_code='directorate'").get();
  if (!governorateType || !directorateType) throw new Error('تعريف مستويات المحافظة والمديرية غير مهيأ في القاموس الجغرافي.');

  db.prepare(`INSERT OR IGNORE INTO geographic_units(unit_type,name,normalized_name,created_at,updated_at)
    VALUES('governorate',?,?,?,?)`).run(governorate, governorateName, now, now);
  const parents = db.prepare(`SELECT id,coalesce(geo_unit_id,id) AS geoUnitId FROM geographic_units WHERE unit_type='governorate' AND parent_id IS NULL AND normalized_name=? LIMIT 2`).all(governorateName);
  if (parents.length > 1) throw new Error('اسم المحافظة يطابق أكثر من مرجع جغرافي؛ صحّح المرجع قبل الحفظ.');
  const parent = parents[0];
  if (!parent) throw new Error('تعذر إنشاء مرجع المحافظة.');
  db.prepare(`UPDATE geographic_units SET geo_unit_id=coalesce(geo_unit_id,id),geo_unit_type_id=coalesce(geo_unit_type_id,?),parent_geo_unit_id=NULL,name_ar=coalesce(name_ar,name),is_active=1,updated_at=? WHERE id=?`)
    .run(governorateType.geo_unit_type_id, now, parent.id);

  const matches = db.prepare(`SELECT id,coalesce(geo_unit_id,id) AS geoUnitId FROM geographic_units WHERE unit_type IN ('district','directorate')
    AND IFNULL(parent_id,0)=? AND normalized_name=? AND coalesce(is_active,1)=1 LIMIT 2`).all(parent.id, districtName);
  if (matches.length > 1) throw new Error('اسم المديرية يطابق أكثر من مرجع داخل المحافظة؛ صحّح المرجع قبل الحفظ.');
  if (matches.length === 1) {
    return { duplicate: true, existingGeoUnitId: Number(matches[0].geoUnitId), governorateId: Number(parent.geoUnitId) };
  }

  const inserted = db.prepare(`INSERT INTO geographic_units(parent_id,unit_type,name,normalized_name,created_at,updated_at)
    VALUES(?,'district',?,?,?,?)`).run(parent.id, district, districtName, now, now);
  const id = Number(inserted.lastInsertRowid);
  db.prepare(`UPDATE geographic_units SET geo_unit_id=coalesce(geo_unit_id,id),geo_unit_type_id=coalesce(geo_unit_type_id,?),parent_geo_unit_id=?,name_ar=coalesce(name_ar,name),is_active=1,updated_at=? WHERE id=?`)
    .run(directorateType.geo_unit_type_id, parent.geoUnitId, now, id);
  return { duplicate: false, geoUnitId: Number(db.prepare('SELECT geo_unit_id FROM geographic_units WHERE id=?').get(id).geo_unit_id), governorateId: Number(parent.geoUnitId) };
}

function nonEmptyValues(values) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) return false;
  return Object.values(values).some(input => input && typeof input === 'object'
    ? input.state || (input.value !== null && input.value !== undefined && input.value !== '')
    : input !== null && input !== undefined && input !== '');
}

function saveWorkspace(db, request = {}) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('صيغة الحفظ غير صحيحة.');
  const district = String(request.district ?? '').trim().slice(0, 160);
  const governorate = String(request.governorate ?? '').trim().slice(0, 160);
  if (!district || !governorate) throw new Error('اسم المديرية والمحافظة مطلوبان قبل الحفظ.');
  const selectedGeoUnitId = request.geoUnitId == null || request.geoUnitId === '' ? null : Number(request.geoUnitId);
  const selectedDirectorate = selectedGeoUnitId == null ? null : findDirectorateByGeoUnitId(db, selectedGeoUnitId);
  if (selectedGeoUnitId != null && !selectedDirectorate) throw new Error('المديرية المختارة غير موجودة أو غير نشطة.');
  if (selectedDirectorate && (normalize(selectedDirectorate.districtName) !== normalize(district)
    || normalize(selectedDirectorate.governorateName) !== normalize(governorate))) {
    throw new Error('بيانات المديرية المختارة لا تطابق الاسم والمحافظة المحددين.');
  }
  const sourceNote = String(request.sourceNote ?? '').trim().slice(0, 1000);
  const entries = Array.isArray(request.forms) ? request.forms : [];
  if (entries.length > 100) throw new Error('عدد النماذج المرسلة يتجاوز الحد المسموح.');

  const catalog = manualEntryCatalog.listCatalog(db);
  const allowedForms = new Map(catalog.domains.flatMap(domain => domain.groups.flatMap(group => group.forms.map(form => [Number(form.versionId), { ...form, groupName: group.name }]))));
  const allowedGroupCodes = new Set(catalog.domains.flatMap(domain => domain.groups.map(group => group.code)));
  const skippedGroups = (Array.isArray(request.skippedGroups) ? request.skippedGroups : []).slice(0, 100).map(item => {
    const groupCode = String(item?.groupCode ?? '').trim();
    const reason = String(item?.reason ?? '').trim().slice(0, 500);
    if (!allowedGroupCodes.has(groupCode) || !reason) throw new Error('سبب تجاوز إحدى المجموعات غير صحيح أو غير مكتمل.');
    return { groupCode, reason };
  });
  const submitted = new Set();
  const normalizedForms = [];
  for (const entry of entries) {
    const versionId = Number(entry?.formVersionId);
    if (!Number.isSafeInteger(versionId) || versionId <= 0 || !allowedForms.has(versionId)) throw new Error('أحد النماذج المرسلة غير موجود في كتالوج الإدخال المعتمد.');
    if (submitted.has(versionId)) throw new Error('تكرر إرسال النموذج نفسه أكثر من مرة.');
    submitted.add(versionId);
    const form = allowedForms.get(versionId);
    const definition = recordService.getFormDefinition(db, versionId);
    if (definition.version_status !== 'published') throw new Error('لا يمكن الحفظ في نموذج غير منشور أو متوقف.');
    const values = entry.values && typeof entry.values === 'object' && !Array.isArray(entry.values) ? entry.values : {};
    if (Object.keys(values).length > 200) throw new Error('عدد الحقول في أحد النماذج يتجاوز الحد المسموح.');
    const codes = new Set(definition.fields.map(field => field.field_code));
    if (Object.keys(values).some(code => !codes.has(code))) throw new Error('تحتوي المسودة على حقل غير موجود في تعريف النموذج.');
    if (nonEmptyValues(values)) normalizedForms.push({ entry, form, definition });
  }

  const directorateForm = normalizedForms.find(item => item.definition.form_code === 'legacy_directorate_v1');
  if (!selectedDirectorate && !directorateForm) throw new Error('تعريف المديرية مطلوب قبل حفظ البيانات.');
  if (directorateForm) {
    const identityValues = directorateForm.entry.values;
    const districtValue = String(identityValues['directorate.districtName']?.value ?? identityValues['directorate.districtName'] ?? '').trim();
    const governorateValue = String(identityValues['directorate.governorate']?.value ?? identityValues['directorate.governorate'] ?? '').trim();
    if (normalize(districtValue) !== normalize(district) || normalize(governorateValue) !== normalize(governorate)) {
      throw new Error('يجب أن تطابق أسماء المديرية والمحافظة أعلى الصفحة بيانات نموذج المديرية.');
    }
  }

  const now = new Date().toISOString();
  try {
    return db.transaction(() => {
      let geography;
      if (selectedDirectorate) {
        geography = { duplicate: false, geoUnitId: Number(selectedDirectorate.geoUnitId) };
      } else {
        const existing = findExistingDirectorate(db, district, governorate);
        if (existing) return { duplicate: true, existingGeoUnitId: Number(existing.geoUnitId), districtName: existing.districtName, governorateName: existing.governorateName };
        geography = ensureDirectorateGeography(db, district, governorate, now);
        if (geography.duplicate) return { duplicate: true, existingGeoUnitId: geography.existingGeoUnitId, districtName: district, governorateName: governorate };
      }
      const records = [];
      for (const { entry, form, definition } of normalizedForms) {
        const values = { ...entry.values };
        if (definition.form_code === 'legacy_directorate_v1') {
          values['directorate.districtName'] = { value: district, state: 'known' };
          values['directorate.governorate'] = { value: governorate, state: 'known' };
        }
        const valueSources = sourceNote
          ? Object.fromEntries(Object.keys(values).map(fieldCode => [fieldCode, sourceNote]))
          : entry.valueSources ?? {};
        const saved = recordService.saveRecord(db, {
          actor: String(request.actor ?? 'manual-entry').slice(0, 120),
          formVersionId: definition.form_version_id,
          geoUnitId: geography.geoUnitId,
          periodYear: request.periodYear ?? null,
          recordLabel: `${district} — ${form.groupName}`,
          notes: sourceNote || null,
          values,
          dimensionValues: entry.dimensionValues ?? {},
          valueSources,
          parentRecordId: entry.parentRecordId ?? null,
        });
        records.push({ formRecordId: saved.formRecordId, formCode: definition.form_code, groupName: form.groupName, status: saved.status });
      }
      db.prepare(`INSERT INTO audit_events(event_code,resource_type,resource_id,action_type,new_value_json,performed_by,session_id,performed_at,details)
        VALUES('manual_directorate_create','geographic_unit',?,'create',?,?,?,?,?)`)
        .run(String(geography.geoUnitId), JSON.stringify({ district, governorate, formRecordIds: records.map(record => record.formRecordId), skippedGroups }),
          String(request.actor ?? 'manual-entry').slice(0, 120), request.sessionId ?? null, now, `حفظ موحد لسجل المديرية و${records.length} نموذج بيانات أولي؛ مجموعات متجاوزة=${skippedGroups.length}.`);
      return { duplicate: false, district, governorate, geoUnitId: geography.geoUnitId, records, skippedGroups };
    })();
  } catch (error) {
    if (String(error?.message ?? '').includes('UNIQUE constraint failed: geographic_units')) {
      const existing = findExistingDirectorate(db, district, governorate);
      if (existing) return { duplicate: true, existingGeoUnitId: Number(existing.geoUnitId), districtName: existing.districtName, governorateName: existing.governorateName };
    }
    throw error;
  }
}

module.exports = { listWorkspaceCatalog, findExistingDirectorate, findDirectorateByGeoUnitId, ensureDirectorateGeography, saveWorkspace };
