'use strict';

const crypto = require('node:crypto');
const { normalize } = require('./architecture.cjs');

const VALUE_STATES = new Set(['known','zero','not_available','unknown','not_applicable','not_collected','not_verified']);
const EDUCATION_SYNC_VERSION = 10;
const EDUCATION_SYNC_CODE = '2026-11-13-approved-education-facility-sync-v10';
const DECIMAL_PATTERN = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

function parseLocalizedNumber(input) {
  let value = String(input ?? '').trim()
    .replace(/[٠-٩]/g,digit => String(digit.charCodeAt(0)-0x0660))
    .replace(/[۰-۹]/g,digit => String(digit.charCodeAt(0)-0x06f0))
    .replace(/[٬,\s]/g,'');
  value = value.replace(/٫/g,'.');
  const percent = value.endsWith('%');
  if (percent) value = value.slice(0,-1);
  if (!DECIMAL_PATTERN.test(value)) throw new Error('صيغة الرقم غير صحيحة.');
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error('القيمة الرقمية خارج النطاق.');
  return { value: percent ? number/100 : number, raw: String(input) };
}
function parseValue(field, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('صيغة القيمة غير صحيحة.');
  const explicitDelete = input.state === 'clear';
  const state = explicitDelete ? 'unknown' : input.state ?? (input.value === null || input.value === undefined || input.value === '' ? 'unknown' : 'known');
  if (!VALUE_STATES.has(state)) throw new Error('حالة القيمة غير معتمدة.');
  const dataType = field.data_type_override ?? field.data_type;
  if (explicitDelete) return { state,raw:null,value:null,kind:dataType,explicitDelete:true };
  if (state === 'zero' && !['integer','decimal'].includes(dataType)) throw new Error('حالة الصفر متاحة للحقول الرقمية فقط.');
  const value = input.value;
  let rules = {};
  try { rules = JSON.parse(field.validation_rules_json ?? '{}') ?? {}; } catch {}
  if (['known','zero'].includes(state) && Array.isArray(rules.allowedValues)
    && !rules.allowedValues.includes(String(value))) throw new Error('القيمة لا تنتمي إلى قائمة القيم المعتمدة لهذا الحقل.');
  if (!['known','zero'].includes(state)) return { state, raw: value == null ? null : String(value), value: null, kind: dataType };
  if (value === null || value === undefined || value === '') throw new Error('القيمة مطلوبة للحالة المحددة.');
  let parsed;
  if (dataType === 'integer' || dataType === 'decimal') {
    parsed = parseLocalizedNumber(value);
    if (dataType === 'integer' && !Number.isInteger(parsed.value)) throw new Error('هذا الحقل يقبل أعداداً صحيحة فقط.');
    if (state === 'zero' && parsed.value !== 0) throw new Error('حالة الصفر تتطلب قيمة تساوي صفراً.');
    const min = field.min_value;
    const max = field.max_value;
    if (min !== null && min !== undefined && parsed.value < min) throw new Error(`القيمة أقل من الحد الأدنى ${min}.`);
    if (max !== null && max !== undefined && parsed.value > max) throw new Error(`القيمة أكبر من الحد الأعلى ${max}.`);
    return { state, raw: parsed.raw, value: parsed.value, kind: dataType };
  }
  if (dataType === 'boolean') {
    const boolean = typeof value === 'boolean' ? value : ['1','true','نعم','yes'].includes(String(value).trim().toLowerCase());
    if (typeof value !== 'boolean' && !['0','1','true','false','نعم','لا','yes','no'].includes(String(value).trim().toLowerCase())) throw new Error('القيمة المنطقية يجب أن تكون نعم أو لا.');
    return { state, raw: String(value), value: boolean, kind: dataType };
  }
  if (dataType === 'date' || dataType === 'datetime') {
    const inputDate = String(value);
    if (dataType === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(inputDate)) throw new Error('التاريخ يجب أن يكون بصيغة YYYY-MM-DD.');
    const date = new Date(inputDate);
    if (!Number.isFinite(date.getTime()) || (dataType === 'date' && date.toISOString().slice(0,10) !== inputDate)) throw new Error('التاريخ غير صالح.');
    const normalized = dataType === 'date' ? date.toISOString().slice(0,10) : date.toISOString();
    return { state, raw: String(value), value: normalized, kind: dataType };
  }
  if (dataType === 'reference') {
    const id = Number(value);
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error('مرجع القيمة غير صالح.');
    return { state, raw: String(value), value: id, kind: dataType };
  }
  if (dataType === 'entity_reference') {
    const id = Number(value);
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error('معرّف الكيان غير صالح.');
    return { state, raw: String(value), value: id, kind: dataType };
  }
  return { state, raw: String(value), value: String(value), kind: dataType };
}
function resolveObservationDimensions(db,definition,provided,parsedValues) {
  const supplied = provided ?? {};
  if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied)) throw new Error('صيغة أبعاد القياس غير صحيحة.');
  const fields = new Map(definition.fields.map(field => [field.field_code,field]));
  const parsedMeasurementFields = new Set(parsedValues.filter(item => item.field.storage_class === 'measurement').map(item => item.field.field_code));
  for (const fieldCode of Object.keys(supplied)) {
    const field = fields.get(fieldCode);
    if (!field || field.storage_class !== 'measurement' || !field.dimensions.length || !parsedMeasurementFields.has(fieldCode)) {
      throw new Error(`أبعاد غير معرّفة أو دون قياس للحقل: ${fieldCode}`);
    }
  }
  const resolved = new Map();
  for (const item of parsedValues) {
    if (item.field.storage_class !== 'measurement' || !item.field.dimensions.length) continue;
    const values = supplied[item.field.field_code] ?? {};
    if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error(`صيغة الأبعاد غير صحيحة للحقل «${item.field.label_ar}».`);
    const allowedCodes = new Set(item.field.dimensions.map(dimension => dimension.code));
    for (const dimensionCode of Object.keys(values)) {
      if (!allowedCodes.has(dimensionCode)) throw new Error(`البعد «${dimensionCode}» غير مرتبط بالحقل «${item.field.label_ar}».`);
    }
    const dimensions = [];
    for (const dimension of item.field.dimensions) {
      const valueCode = values[dimension.code];
      if (valueCode == null || valueCode === '') {
        if (dimension.required) throw new Error(`اختر ${dimension.name} للحقل «${item.field.label_ar}».`);
        continue;
      }
      const selected = db.prepare(`SELECT definition.dimension_id,value.dimension_value_id,value.value_code,value.label_ar
        FROM dimension_definitions definition JOIN dimension_values value USING(dimension_id)
        WHERE definition.dimension_code=? AND definition.is_active=1 AND value.value_code=? AND value.is_active=1`).get(dimension.code,String(valueCode));
      if (!selected || selected.dimension_id !== dimension.id) throw new Error(`قيمة البعد «${dimension.name}» غير صالحة.`);
      dimensions.push({ dimensionId:selected.dimension_id,valueId:selected.dimension_value_id,dimensionCode:dimension.code,valueCode:selected.value_code,label:selected.label_ar });
    }
    resolved.set(item.field.field_code,dimensions);
  }
  return resolved;
}
function audit(db, event) {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO audit_events(event_code,resource_type,resource_id,action_type,old_value_json,new_value_json,performed_by,session_id,performed_at,details)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run(event.code,event.resourceType,String(event.resourceId),event.action,event.before == null ? null : JSON.stringify(event.before),
      event.after == null ? null : JSON.stringify(event.after),event.actor ?? null,event.sessionId ?? null,now,event.details ?? null);
}
function addManualSource(db, actor, now) {
  const code = `manual-${crypto.randomUUID()}`;
  const result = db.prepare("INSERT INTO data_sources(source_type,source_code,entered_by,received_at,notes) VALUES('manual_entry',?,?,?,'إدخال يدوي من نموذج قاعدة البيانات المركزية.')").run(code,actor ?? null,now);
  const sourceId = Number(result.lastInsertRowid);
  db.prepare('UPDATE data_sources SET source_id=id WHERE id=?').run(sourceId);
  return sourceId;
}
function listForms(db) {
  return db.prepare(`SELECT f.form_id,f.form_code,f.name_ar,f.name_en,f.description,f.data_structure_type,f.is_active,
    f.sector_id,s.name_ar AS sector_name_ar,fv.form_version_id,fv.version_number,fv.version_label,fv.status AS version_status,
    governance.collection_mode,governance.definition_status,governance.methodology_status,governance.reference_status,
    coalesce(governance.analysis_eligible,1) AS analysis_eligible,governance.notes AS governance_notes
    FROM form_definitions f LEFT JOIN sectors s ON s.sector_id=f.sector_id
    LEFT JOIN form_versions fv ON fv.form_id=f.form_id AND fv.version_number=(SELECT MAX(v.version_number) FROM form_versions v WHERE v.form_id=f.form_id)
    LEFT JOIN manual_entry_form_governance governance ON governance.form_version_id=fv.form_version_id
    ORDER BY coalesce(s.sort_order,0),f.form_code`).all();
}
function getFormDefinition(db, formVersionId) {
  const id = Number(formVersionId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('إصدار النموذج غير صالح.');
  const version = db.prepare(`SELECT fv.*,fv.status AS version_status,f.form_code,f.name_ar,f.name_en,f.sector_id,f.description AS form_description,
    f.data_structure_type,f.default_geo_level_id,governance.collection_mode,governance.definition_status,governance.methodology_status,
    governance.reference_status,coalesce(governance.analysis_eligible,1) AS analysis_eligible,governance.notes AS governance_notes
    FROM form_versions fv JOIN form_definitions f USING(form_id)
    LEFT JOIN manual_entry_form_governance governance ON governance.form_version_id=fv.form_version_id WHERE fv.form_version_id=?`).get(id);
  if (!version) throw new Error('إصدار النموذج غير موجود.');
  const sections = db.prepare('SELECT * FROM form_sections WHERE form_version_id=? ORDER BY sort_order,section_id').all(id);
  const fields = db.prepare(`SELECT ff.*,fd.canonical_name_ar,fd.canonical_name_en,fd.semantic_type,fd.data_type,
    fd.default_unit_id,mu.name_ar AS unit_name_ar,rs.reference_set_id,rs.set_code AS reference_set_code
    FROM form_fields ff LEFT JOIN field_definitions fd USING(field_definition_id)
    LEFT JOIN measurement_units mu ON mu.unit_id=coalesce(ff.unit_id,fd.default_unit_id)
    LEFT JOIN reference_sets rs ON rs.reference_set_id=coalesce(ff.reference_set_id,fd.reference_set_id)
    WHERE ff.form_version_id=? ORDER BY ff.section_id,ff.sort_order,ff.form_field_id`).all(id);
  const dimensions = db.prepare(`SELECT mapping.form_field_id,dimension.dimension_id,dimension.dimension_code,dimension.name_ar AS dimension_name_ar,
      mapping.is_required,value.dimension_value_id,value.value_code,value.label_ar AS value_label_ar
    FROM manual_entry_form_field_dimensions mapping
    JOIN dimension_definitions dimension ON dimension.dimension_id=mapping.dimension_id AND dimension.is_active=1
    LEFT JOIN dimension_values value ON value.dimension_id=dimension.dimension_id AND value.is_active=1
    JOIN form_fields field ON field.form_field_id=mapping.form_field_id
    WHERE field.form_version_id=? ORDER BY field.sort_order,mapping.sort_order,value.sort_order`).all(id);
  const fieldById = new Map(fields.map(field => [field.form_field_id,{ ...field,dimensions:[] }]));
  for (const row of dimensions) {
    const field = fieldById.get(row.form_field_id);
    let dimension = field.dimensions.find(item => item.code === row.dimension_code);
    if (!dimension) {
      dimension = { id:row.dimension_id,code:row.dimension_code,name:row.dimension_name_ar,required:Boolean(row.is_required),values:[] };
      field.dimensions.push(dimension);
    }
    if (row.dimension_value_id != null) dimension.values.push({ id:row.dimension_value_id,code:row.value_code,label:row.value_label_ar });
  }
  for (const field of fieldById.values()) {
    field.referenceValues = field.reference_set_id == null ? [] : db.prepare(`SELECT reference_value_id AS id,value_code AS code,label_ar AS label
      FROM reference_values WHERE reference_set_id=? AND is_active=1 ORDER BY sort_order,reference_value_id`).all(field.reference_set_id);
  }
  const rows = db.prepare('SELECT * FROM form_row_definitions WHERE form_version_id=? ORDER BY sort_order,row_definition_id').all(id);
  return { ...version, sections, fields:[...fieldById.values()], rows };
}
function resolveGeo(db, id) {
  if (id == null || id === '') return null;
  const number = Number(id);
  if (!Number.isSafeInteger(number) || number <= 0 || !db.prepare('SELECT 1 FROM geographic_units WHERE geo_unit_id=?').get(number)) throw new Error('الوحدة الجغرافية غير موجودة.');
  return number;
}
function resolvePeriod(db, id, requestedYear) {
  const yearText = requestedYear == null || requestedYear === '' ? null : String(requestedYear).trim();
  if (yearText !== null) {
    if (!/^\d{4}$/.test(yearText) || Number(yearText) < 1900 || Number(yearText) > 2200) throw new Error('السنة المرجعية يجب أن تكون بين 1900 و2200.');
    const year = Number(yearText);
    const start = `${year}-01-01`, end = `${year}-12-31`, code = `gregorian-year-${year}`;
    db.prepare(`INSERT OR IGNORE INTO periods(period_code,period_type,calendar_type,label_ar,year_gregorian,start_date,end_date,created_at)
      VALUES(?,'year','gregorian',?,?,?, ?,?)`).run(code,`السنة ${year}`,year,start,end,new Date().toISOString());
    return db.prepare('SELECT period_id FROM periods WHERE period_code=? AND calendar_type=\'gregorian\'').get(code).period_id;
  }
  if (id == null || id === '') return null;
  const number = Number(id);
  if (!Number.isSafeInteger(number) || number <= 0 || !db.prepare('SELECT 1 FROM periods WHERE period_id=?').get(number)) throw new Error('الفترة المرجعية غير موجودة.');
  return number;
}
function resolveApprovedProjectParent(db,parentRecordId) {
  const id = Number(parentRecordId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('اختر سجل المشروع المعتمد المرتبط بالتمويل.');
  const parent = db.prepare(`SELECT record.form_record_id,record.geo_unit_id,project.id AS project_id,project.name AS project_name
    FROM form_records record
    JOIN form_versions version ON version.form_version_id=record.form_version_id
    JOIN form_definitions form ON form.form_id=version.form_id
    JOIN form_record_legacy_links link ON link.form_record_id=record.form_record_id AND link.legacy_entity_type='project'
    JOIN projects project ON project.id=link.legacy_entity_id
    WHERE record.form_record_id=? AND record.record_status='approved' AND form.form_code='project_v1'`).get(id);
  if (!parent) throw new Error('سجل الأب غير موجود أو غير معتمد كمشروع.');
  return parent;
}
function saveRecord(db, request = {}) {
  const definition = getFormDefinition(db,request.formVersionId);
  const fields = new Map(definition.fields.map(field => [field.field_code,field]));
  let sourceContext = null;
  if (request.valueSources !== undefined) {
    if (!request.valueSources || typeof request.valueSources !== 'object' || Array.isArray(request.valueSources)) throw new Error('صيغة توثيق مصادر القيم غير صحيحة.');
    const suppliedValues = request.values && typeof request.values === 'object' && !Array.isArray(request.values) ? request.values : {};
    const sourceByField = {};
    for (const [fieldCode,locator] of Object.entries(request.valueSources)) {
      if (!fields.has(fieldCode)) throw new Error(`حقل مصدر غير معرّف في النموذج: ${fieldCode}`);
      if (!Object.hasOwn(suppliedValues,fieldCode)) throw new Error(`لا يمكن توثيق مصدر دون حفظ قيمة أو حالة لها: ${fieldCode}`);
      if (typeof locator !== 'string' || locator.length > 1000) throw new Error('مرجع مصدر القيمة يجب أن يكون نصاً لا يتجاوز 1000 حرف.');
      sourceByField[fieldCode] = { sourceLocator:locator.trim() || null };
    }
    sourceContext = { provenanceType:'manual_entry',sourceByField };
  }
  return saveRecordWithSource(db,request,sourceContext);
}
function saveRecordFromDocument(db, request = {}, sourceContext = {}) {
  const sourceByField = {};
  for (const [fieldCode,source] of Object.entries(sourceContext.sourceByField ?? {})) {
    const sourceRow = db.prepare('SELECT id,source_id FROM data_sources WHERE id=?').get(Number(source.dataSourceId));
    if (!sourceRow) throw new Error('مصدر الوثيقة غير موجود.');
    let sourceId = sourceRow.source_id;
    if (sourceId == null) {
      db.prepare('UPDATE data_sources SET source_id=id WHERE id=?').run(sourceRow.id);
      sourceId = sourceRow.id;
    }
    sourceByField[fieldCode] = { sourceId:Number(sourceId),sourceLocator:source.sourceLocator };
  }
  const primarySource = Object.values(sourceByField)[0];
  return saveRecordWithSource(db,request,{
    sourceId:primarySource?.sourceId,
    provenanceType:'document_extraction',
    sourceByField,
  });
}
function saveRecordWithSource(db, request, sourceContext) {
  const versionId = Number(request.formVersionId);
  const definition = getFormDefinition(db,versionId);
  if (definition.version_status !== 'published') throw new Error('لا يمكن إدخال بيانات إلى إصدار نموذج غير منشور.');
  const requestedGeoUnitId = resolveGeo(db,request.geoUnitId);
  const isProjectFunding = definition.form_code === 'project_funding_v1';
  if (!isProjectFunding && request.parentRecordId != null && request.parentRecordId !== '') throw new Error('لا يقبل هذا النموذج سجلاً أباً.');
  const values = request.values && typeof request.values === 'object' && !Array.isArray(request.values) ? request.values : {};
  const fields = new Map(definition.fields.map(field => [field.field_code,field]));
  const unknown = Object.keys(values).filter(code => !fields.has(code));
  if (unknown.length) throw new Error(`حقول غير معرّفة في إصدار النموذج: ${unknown.slice(0,4).join('، ')}`);
  const parsed = [];
  for (const [fieldCode,input] of Object.entries(values)) {
    const field = fields.get(fieldCode);
    if (!field.is_importable || field.is_derived || field.storage_class === 'ignored_derived') throw new Error(`الحقل «${field.label_ar}» غير قابل للإدخال المباشر.`);
    const parsedValue = parseValue(field,input);
    if (field.reference_set_id != null && ['known','zero'].includes(parsedValue.state)) {
      const referenceValueId = Number(parsedValue.value);
      if (!db.prepare('SELECT 1 FROM reference_values WHERE reference_value_id=? AND reference_set_id=? AND is_active=1').get(referenceValueId,field.reference_set_id)) {
        throw new Error(`قيمة التصنيف غير صالحة للحقل «${field.label_ar}».`);
      }
    }
    parsed.push({ field, value:parsedValue });
  }
  for (const field of definition.fields.filter(item => item.is_required)) {
    const supplied = parsed.find(item => item.field.form_field_id === field.form_field_id)?.value;
    if (!supplied || !['known','zero'].includes(supplied.state)) throw new Error(`الحقل «${field.label_ar}» مطلوب بقيمة معروفة.`);
  }
  const now = new Date().toISOString();
  return db.transaction(() => {
    const actor = typeof request.actor === 'string' ? request.actor.slice(0,120) : null;
    const previous = request.formRecordId ? db.prepare('SELECT * FROM form_records WHERE form_record_id=?').get(Number(request.formRecordId)) : null;
    if (request.formRecordId && !previous) throw new Error('السجل المطلوب تعديله غير موجود.');
    if (previous && !String(request.changeReason ?? '').trim()) throw new Error('سبب التعديل مطلوب لحفظ نسخة جديدة من السجل.');
    if (parsed.some(item => item.value.explicitDelete) && !String(request.changeReason ?? '').trim()) throw new Error('سبب الحذف الصريح مطلوب.');
    if (previous && previous.form_version_id !== versionId) throw new Error('لا يمكن تغيير إصدار النموذج المرتبط بسجل قائم.');
    if (previous && !['draft','rejected'].includes(previous.record_status)) throw new Error('لا يمكن تعديل سجل قيد المراجعة أو معتمد؛ أعده للمسودة أولاً.');
    let parentRecordId = null;
    let geoUnitId = requestedGeoUnitId;
    if (isProjectFunding) {
      parentRecordId = previous?.parent_record_id ?? request.parentRecordId;
      if (previous?.parent_record_id && request.parentRecordId != null
        && Number(request.parentRecordId) !== Number(previous.parent_record_id)) throw new Error('لا يمكن تغيير المشروع الأب لسجل تمويل قائم.');
      const parent = resolveApprovedProjectParent(db,parentRecordId);
      if (requestedGeoUnitId != null && Number(requestedGeoUnitId) !== Number(parent.geo_unit_id)) {
        throw new Error('موقع سجل التمويل يجب أن يطابق موقع المشروع الأب.');
      }
      geoUnitId = parent.geo_unit_id;
    }
    if (parsed.some(item => item.field.storage_class === 'measurement' && ['known','zero'].includes(item.value.state))
      && !request.periodId && !request.periodYear) throw new Error('حدّد الفترة المرجعية للقياسات قبل حفظ السجل.');
    const periodId = resolvePeriod(db,request.periodId,request.periodYear);
    const dimensionsByField = resolveObservationDimensions(db,definition,request.dimensionValues,parsed);
    const sourceId = sourceContext?.sourceId ?? addManualSource(db,actor,now);
    const before = previous ? recordSnapshot(db,previous.form_record_id) : null;
    let recordId = previous?.form_record_id;
    if (!previous) {
      const result = db.prepare(`INSERT INTO form_records(form_version_id,entity_id,geo_unit_id,period_id,parent_record_id,record_code,record_key,record_label,record_status,revision_number,notes,created_by,created_at,updated_at)
        VALUES(?,NULL,?,?,?,?,?,?,'draft',1,?,?,?,?)`).run(versionId,geoUnitId,periodId,parentRecordId,request.recordCode ?? null,request.recordKey ?? null,
          request.recordLabel ?? null,request.notes ?? null,actor,now,now);
      recordId = Number(result.lastInsertRowid);
    } else {
      db.prepare(`UPDATE form_records SET geo_unit_id=?,period_id=?,parent_record_id=?,record_label=?,notes=?,revision_number=revision_number+1,updated_at=? WHERE form_record_id=?`)
        .run(geoUnitId,periodId,parentRecordId,request.recordLabel ?? previous.record_label,request.notes ?? previous.notes,now,recordId);
    }
    for (const item of parsed) {
      const fieldSource = sourceContext?.sourceByField?.[item.field.field_code];
      storeFieldValue(db,recordId,item.field,item.value,fieldSource?.sourceId ?? sourceId,actor,now,
        sourceContext ? { provenanceType:sourceContext.provenanceType,sourceLocator:fieldSource?.sourceLocator ?? null } : null,
        dimensionsByField.get(item.field.field_code) ?? []);
    }
    const after = recordSnapshot(db,recordId);
    const revision = db.prepare('SELECT revision_number FROM form_records WHERE form_record_id=?').get(recordId).revision_number;
    db.prepare(`INSERT INTO record_revisions(form_record_id,revision_number,action_type,before_snapshot_json,after_snapshot_json,change_reason,changed_by,source_id,created_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(recordId,revision,previous?'manual_update':'manual_create',before?JSON.stringify(before):null,JSON.stringify(after),request.changeReason ?? null,actor,sourceId,now);
    audit(db,{code:'form_record',resourceType:'form_record',resourceId:recordId,action:previous?'update':'create',before,after,actor,details:`source_id=${sourceId}`});
    return { formRecordId:recordId,revisionNumber:revision,sourceId,status:previous?.record_status ?? 'draft' };
  })();
}
function storeFieldValue(db,recordId,field,parsed,sourceId,actor,now,sourceContext = null,dimensions = []) {
  if (field.storage_class === 'measurement') {
    if (!field.field_definition_id) throw new Error(`حقل القياس «${field.label_ar}» لا يرتبط بتعريف دلالي.`);
    const valueInteger = parsed.state === 'known' || parsed.state === 'zero' ? (Number.isInteger(parsed.value) ? parsed.value : null) : null;
    const valueReal = parsed.state === 'known' || parsed.state === 'zero' ? (!Number.isInteger(parsed.value) ? parsed.value : null) : null;
    const dimensionSignature = dimensions.map(dimension => `${dimension.dimensionCode}=${dimension.valueCode}`).sort().join('|');
    const record = db.prepare('SELECT geo_unit_id,period_id FROM form_records WHERE form_record_id=?').get(recordId);
    const existing = db.prepare('SELECT observation_id FROM observations WHERE form_record_id=? AND form_field_id=? ORDER BY observation_id DESC LIMIT 1').get(recordId,field.form_field_id);
    let observationId;
    if (existing) {
      observationId = existing.observation_id;
      db.prepare(`UPDATE observations SET field_definition_id=?,geo_unit_id=?,period_id=?,unit_id=?,value_integer=?,value_real=?,value_text=NULL,
        value_state=?,dimension_signature=?,source_id=?,updated_at=? WHERE observation_id=?`).run(field.field_definition_id,record.geo_unit_id,record.period_id,field.unit_id,
        valueInteger,valueReal,parsed.state,dimensionSignature,sourceId,now,observationId);
      db.prepare('DELETE FROM observation_dimensions WHERE observation_id=?').run(observationId);
    } else {
      observationId = Number(db.prepare(`INSERT INTO observations(form_record_id,form_field_id,field_definition_id,geo_unit_id,period_id,unit_id,value_integer,value_real,value_text,value_state,observation_role,quality_status,dimension_signature,source_id,created_by,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?, 'observed','unverified',?,?,?, ?,?)`).run(recordId,field.form_field_id,field.field_definition_id,
          record.geo_unit_id,record.period_id,field.unit_id,valueInteger,valueReal,null,parsed.state,dimensionSignature,sourceId,actor,now,now).lastInsertRowid);
    }
    const insertDimension = db.prepare('INSERT INTO observation_dimensions(observation_id,dimension_id,dimension_value_id,created_at) VALUES(?,?,?,?)');
    for (const dimension of dimensions) insertDimension.run(observationId,dimension.dimensionId,dimension.valueId,now);
    db.prepare(`INSERT INTO value_provenance(observation_id,source_id,provenance_type,original_value_text,normalized_value_text,source_locator,entered_by,created_at)
      VALUES(?,?,?,?,?,?,?,?)`).run(observationId,sourceId,sourceContext?.provenanceType ?? (parsed.explicitDelete?'explicit_deletion':'manual_entry'),parsed.raw,
      parsed.value == null ? null : String(parsed.value),sourceContext?.sourceLocator ?? null,actor,now);
    return;
  }
  const columns = { value_text:null,value_boolean:null,value_date:null,value_reference_id:null,value_entity_id:null };
  if (parsed.state === 'known' || parsed.state === 'zero') {
    if (parsed.kind === 'boolean') columns.value_boolean = parsed.value ? 1 : 0;
    else if (parsed.kind === 'date' || parsed.kind === 'datetime') columns.value_date = parsed.value;
    else if (parsed.kind === 'reference') columns.value_reference_id = parsed.value;
    else if (parsed.kind === 'entity_reference') columns.value_entity_id = parsed.value;
    else columns.value_text = parsed.value;
  }
  const existing = db.prepare('SELECT record_field_value_id FROM record_field_values WHERE form_record_id=? AND form_field_id=? AND item_ordinal=1').get(recordId,field.form_field_id);
  let valueId;
  if (existing) {
    valueId = existing.record_field_value_id;
    db.prepare(`UPDATE record_field_values SET value_text=?,value_boolean=?,value_date=?,value_reference_id=?,value_entity_id=?,value_state=?,raw_value_text=?,normalized_value_text=?,updated_at=? WHERE record_field_value_id=?`)
      .run(columns.value_text,columns.value_boolean,columns.value_date,columns.value_reference_id,columns.value_entity_id,parsed.state,parsed.raw,
        parsed.value == null ? null : String(parsed.value),now,valueId);
  } else {
    valueId = Number(db.prepare(`INSERT INTO record_field_values(form_record_id,form_field_id,item_ordinal,value_text,value_boolean,value_date,value_reference_id,value_entity_id,value_state,raw_value_text,normalized_value_text,created_at,updated_at)
      VALUES(?,?,1,?,?,?,?,?,?,?,?,?,?)`).run(recordId,field.form_field_id,columns.value_text,columns.value_boolean,columns.value_date,columns.value_reference_id,
        columns.value_entity_id,parsed.state,parsed.raw,parsed.value == null ? null : String(parsed.value),now,now).lastInsertRowid);
  }
  db.prepare(`INSERT INTO value_provenance(record_field_value_id,source_id,provenance_type,original_value_text,normalized_value_text,source_locator,entered_by,created_at)
    VALUES(?,?,?,?,?,?,?,?)`).run(valueId,sourceId,sourceContext?.provenanceType ?? (parsed.explicitDelete?'explicit_deletion':'manual_entry'),parsed.raw,
    parsed.value == null ? null : String(parsed.value),sourceContext?.sourceLocator ?? null,actor,now);
}
function syncApprovedEducationFacility(db,recordId,actor,now) {
  const record = db.prepare('SELECT form_record_id,form_version_id,geo_unit_id,entity_id FROM form_records WHERE form_record_id=?').get(recordId);
  const form = db.prepare('SELECT form.form_code FROM form_versions version JOIN form_definitions form USING(form_id) WHERE version.form_version_id=?').get(record.form_version_id);
  if (form?.form_code !== 'education_school_collection_v1') return null;
  const values = db.prepare(`SELECT field.field_code,value.value_text,value.value_reference_id,value.value_state
    FROM record_field_values value JOIN form_fields field USING(form_field_id) WHERE value.form_record_id=?`).all(recordId);
  const byCode = new Map(values.map(value => [value.field_code,value]));
  const nameValue = byCode.get('education.school.name');
  const typeValue = byCode.get('education.school.type');
  const name = String(nameValue?.value_text ?? '').trim();
  if (nameValue?.value_state !== 'known' || !name) throw new Error('اسم المنشأة التعليمية مطلوب قبل اعتماد سجلها.');
  if (typeValue?.value_state !== 'known' || typeValue.value_reference_id == null) throw new Error('نوع المنشأة التعليمية مطلوب قبل اعتماد سجلها.');
  const schoolType = db.prepare(`SELECT value.reference_value_id,value.value_code FROM reference_values value
    JOIN reference_sets reference USING(reference_set_id) WHERE value.reference_value_id=? AND reference.set_code='education_school_kind_v1' AND value.is_active=1`)
    .get(typeValue.value_reference_id);
  if (!schoolType || !['school','kindergarten'].includes(schoolType.value_code)) throw new Error('تصنيف المنشأة التعليمية لا يطابق قائمة المدرسة ورياض الأطفال.');
  const entityType = db.prepare("SELECT entity_type_id FROM entity_types WHERE entity_type_code='education_facility' AND is_active=1").get();
  if (!entityType) throw new Error('نوع كيان المنشأة التعليمية غير مهيأ في القاموس.');
  if (record.geo_unit_id != null && !db.prepare('SELECT 1 FROM geographic_units WHERE geo_unit_id=?').get(record.geo_unit_id)) {
    throw new Error('موقع المنشأة التعليمية غير مرتبط بالمرجع الجغرافي الموحد.');
  }
  let entityId = record.entity_id == null ? null : Number(record.entity_id);
  const previousEntity = entityId == null ? null : db.prepare('SELECT * FROM entities WHERE entity_id=?').get(entityId);
  const previousSchool = entityId == null ? null : db.prepare('SELECT * FROM schools WHERE entity_id=?').get(entityId);
  if (entityId != null && (!previousEntity || previousEntity.entity_type_id !== entityType.entity_type_id)) {
    throw new Error('رابط سجل المنشأة التعليمية يشير إلى كيان غير متوافق.');
  }
  if (previousEntity) {
    db.prepare('UPDATE entities SET geo_unit_id=?,name_ar=?,normalized_name=?,status=\'active\',updated_at=? WHERE entity_id=?')
      .run(record.geo_unit_id,name,normalize(name),now,entityId);
    db.prepare(`INSERT INTO schools(entity_id,school_type_id,is_active,created_at,updated_at) VALUES(?,?,1,?,?)
      ON CONFLICT(entity_id) DO UPDATE SET school_type_id=excluded.school_type_id,is_active=1,updated_at=excluded.updated_at`)
      .run(entityId,schoolType.reference_value_id,now,now);
  } else {
    entityId = Number(db.prepare(`INSERT INTO entities(entity_type_id,geo_unit_id,name_ar,normalized_name,status,created_at,updated_at)
      VALUES(?,?,?,?,'active',?,?)`).run(entityType.entity_type_id,record.geo_unit_id,name,normalize(name),now,now).lastInsertRowid);
    db.prepare('INSERT INTO schools(entity_id,school_type_id,created_at,updated_at) VALUES(?,?,?,?)')
      .run(entityId,schoolType.reference_value_id,now,now);
    db.prepare('UPDATE form_records SET entity_id=? WHERE form_record_id=?').run(entityId,recordId);
  }
  db.prepare('UPDATE observations SET entity_id=? WHERE form_record_id=?').run(entityId,recordId);
  const afterEntity = db.prepare('SELECT * FROM entities WHERE entity_id=?').get(entityId);
  const afterSchool = db.prepare('SELECT * FROM schools WHERE entity_id=?').get(entityId);
  audit(db,{ code:'education_facility_sync',resourceType:'entity',resourceId:entityId,action:previousEntity?'update':'create',
    before:previousEntity ? { entity:previousEntity,school:previousSchool } : null,after:{ entity:afterEntity,school:afterSchool },actor,
    details:`form_record=${recordId};reference_type=${schoolType.value_code}` });
  return { entityId,action:previousEntity?'updated':'created' };
}

function markEducationFacilityUnderReview(db,recordId,actor,now,reason) {
  const record = db.prepare('SELECT form_version_id,entity_id FROM form_records WHERE form_record_id=?').get(recordId);
  const form = db.prepare('SELECT form.form_code FROM form_versions version JOIN form_definitions form USING(form_id) WHERE version.form_version_id=?').get(record.form_version_id);
  if (form?.form_code !== 'education_school_collection_v1' || record.entity_id == null) return null;
  const entityId = Number(record.entity_id);
  const beforeEntity = db.prepare('SELECT * FROM entities WHERE entity_id=?').get(entityId);
  const beforeSchool = db.prepare('SELECT * FROM schools WHERE entity_id=?').get(entityId);
  if (!beforeEntity || !beforeSchool) throw new Error('تعذر إعادة فتح المنشأة التعليمية لأن ملف الكيان المرتبط غير مكتمل.');
  db.prepare("UPDATE entities SET status='under_review',updated_at=? WHERE entity_id=?").run(now,entityId);
  db.prepare('UPDATE schools SET is_active=0,updated_at=? WHERE entity_id=?').run(now,entityId);
  const afterEntity = db.prepare('SELECT * FROM entities WHERE entity_id=?').get(entityId);
  const afterSchool = db.prepare('SELECT * FROM schools WHERE entity_id=?').get(entityId);
  audit(db,{ code:'education_facility_sync',resourceType:'entity',resourceId:entityId,action:'reopen',before:{ entity:beforeEntity,school:beforeSchool },
    after:{ entity:afterEntity,school:afterSchool },actor,details:`form_record=${recordId};${String(reason ?? '').slice(0,300)}` });
  return { entityId,action:'under_review' };
}

function syncApprovedDirectorate(db,recordId,actor,now) {
  const record = db.prepare('SELECT form_record_id,form_version_id FROM form_records WHERE form_record_id=?').get(recordId);
  const form = db.prepare(`SELECT f.form_code FROM form_versions v JOIN form_definitions f USING(form_id) WHERE v.form_version_id=?`).get(record.form_version_id);
  if (form?.form_code !== 'legacy_directorate_v1') return null;
  const values = {},rawValues = {},sources = {};
  const scalarRows = db.prepare(`SELECT ff.field_code,v.record_field_value_id,v.value_text,v.value_boolean,v.value_date,v.value_reference_id,v.value_entity_id,v.value_state,v.raw_value_text,
    (SELECT provenance_type FROM value_provenance WHERE record_field_value_id=v.record_field_value_id ORDER BY provenance_id DESC LIMIT 1) AS latest_provenance
    FROM record_field_values v JOIN form_fields ff USING(form_field_id) WHERE v.form_record_id=?`).all(recordId);
  for (const row of scalarRows) {
    const key = row.field_code.replace(/^directorate\./,'');
    if (row.value_state !== 'known' && row.value_state !== 'zero' && row.latest_provenance !== 'explicit_deletion') continue;
    values[key] = row.value_boolean == null ? row.value_text ?? row.value_date ?? row.value_reference_id ?? row.value_entity_id : row.value_boolean;
    rawValues[key] = row.raw_value_text;
    sources[key] = `manual-form-record:${recordId}:${row.field_code}`;
  }
  const measurementRows = db.prepare(`SELECT ff.field_code,o.value_integer,o.value_real,o.value_text,o.value_state,o.observation_id,
    (SELECT provenance_type FROM value_provenance WHERE observation_id=o.observation_id ORDER BY provenance_id DESC LIMIT 1) AS latest_provenance
    FROM observations o JOIN form_fields ff USING(form_field_id) WHERE o.form_record_id=?`).all(recordId);
  for (const row of measurementRows) {
    const key = row.field_code.replace(/^directorate\./,'');
    if (row.value_state !== 'known' && row.value_state !== 'zero' && row.latest_provenance !== 'explicit_deletion') continue;
    const value = row.value_integer ?? row.value_real ?? row.value_text;
    values[key] = value;
    rawValues[key] = db.prepare('SELECT original_value_text FROM value_provenance WHERE observation_id=? ORDER BY provenance_id DESC LIMIT 1').get(row.observation_id)?.original_value_text ?? null;
    sources[key] = `manual-form-record:${recordId}:${row.field_code}`;
  }
  const persist = require('../analysis/persist.cjs');
  const identity = { districtName:values.districtName,governorate:values.governorate,values,rawValues,sources,rowNumber:recordId };
  const result = persist.upsertDirectorate(db,identity,{ fileName:`إدخال مركزي #${recordId}`,sheetName:form.form_code,warnings:[],actor,skipNormalizedRecordSync:true });
  const geography = db.prepare(`SELECT unit.geo_unit_id FROM geographic_units unit
    JOIN geo_unit_types unit_type ON unit_type.geo_unit_type_id=unit.geo_unit_type_id
    JOIN geographic_units parent ON parent.geo_unit_id=unit.parent_geo_unit_id
    JOIN geo_unit_types parent_type ON parent_type.geo_unit_type_id=parent.geo_unit_type_id
    WHERE unit_type.type_code='directorate' AND unit.normalized_name=? AND parent_type.type_code='governorate' AND parent.normalized_name=?`)
    .all(normalize(values.districtName),normalize(values.governorate));
  if (geography.length !== 1 || !geography[0].geo_unit_id) throw new Error('تعذر تحديد المديرية والمحافظة بصورة فريدة في المرجع الجغرافي المعياري.');
  const geoUnitId = geography[0].geo_unit_id;
  db.prepare('UPDATE form_records SET geo_unit_id=?,record_label=? WHERE form_record_id=?').run(geoUnitId,String(values.districtName),recordId);
  db.prepare('UPDATE observations SET geo_unit_id=? WHERE form_record_id=?').run(geoUnitId,recordId);
  db.prepare("INSERT OR IGNORE INTO form_record_legacy_links(form_record_id,legacy_entity_type,legacy_entity_id,linked_at) VALUES(?,'directorate',?,?)")
    .run(recordId,result.id,now);
  return result;
}
function syncApprovedProject(db,recordId,actor,now) {
  const record = db.prepare('SELECT form_record_id,form_version_id,geo_unit_id FROM form_records WHERE form_record_id=?').get(recordId);
  const form = db.prepare('SELECT f.form_code FROM form_versions v JOIN form_definitions f USING(form_id) WHERE v.form_version_id=?').get(record.form_version_id);
  if (form?.form_code !== 'project_v1') return null;
  const scalarRows = db.prepare(`SELECT field.field_code,value.value_text,value.value_date,value.value_state
    FROM record_field_values value JOIN form_fields field USING(form_field_id) WHERE value.form_record_id=?`).all(recordId);
  const values = Object.fromEntries(scalarRows.filter(row => ['known','zero'].includes(row.value_state))
    .map(row => [row.field_code,row.value_date ?? row.value_text]));
  const measurementRows = db.prepare(`SELECT field.field_code,observation.value_integer,observation.value_real,observation.value_state
    FROM observations observation JOIN form_fields field USING(form_field_id) WHERE observation.form_record_id=?`).all(recordId);
  for (const row of measurementRows) {
    if (['known','zero'].includes(row.value_state)) values[row.field_code] = row.value_integer ?? row.value_real;
  }
  const name = String(values.projectName ?? '').trim();
  if (!name) throw new Error('اسم المشروع مطلوب قبل اعتماد سجل المشروع.');
  const code = String(values.projectCode ?? '').trim() || null;
  const description = values.description ?? null;
  const status = String(values.projectStatus ?? '').trim() || 'draft';
  const estimatedCost = values.estimatedCost ?? null;
  const actualCost = values.actualCost ?? null;
  const currency = String(values.currencyCode ?? '').trim().toUpperCase() || null;
  if ((estimatedCost !== null || actualCost !== null) && !currency) throw new Error('أدخل رمز العملة قبل اعتماد تكاليف المشروع.');
  if (currency && !/^[A-Z]{3}$/.test(currency)) throw new Error('رمز العملة يجب أن يتكون من ثلاثة أحرف لاتينية مثل USD.');
  const startDate = values.startDate ?? null;
  const endDate = values.endDate ?? null;
  if (startDate && endDate && startDate > endDate) throw new Error('تاريخ البداية يأتي بعد تاريخ النهاية.');
  const geography = record.geo_unit_id == null ? null : db.prepare('SELECT id FROM geographic_units WHERE geo_unit_id=?').get(record.geo_unit_id);
  if (record.geo_unit_id != null && !geography) throw new Error('الموقع الجغرافي للمشروع غير مرتبط بالمرجع الموحد.');
  const sectorCode = String(values.sectorCode ?? '').trim() || null;
  const sector = sectorCode ? db.prepare('SELECT id FROM sectors WHERE code=? AND active=1').get(sectorCode) : null;
  if (sectorCode && !sector) throw new Error('قطاع المشروع غير موجود أو غير نشط.');
  const source = db.prepare(`SELECT revision.source_id FROM record_revisions revision WHERE revision.form_record_id=?
    ORDER BY revision.revision_number DESC LIMIT 1`).get(recordId);
  const sourceId = source?.source_id == null ? null : db.prepare('SELECT id FROM data_sources WHERE id=? OR source_id=? ORDER BY id LIMIT 1').get(source.source_id,source.source_id)?.id ?? null;
  const existingLink = db.prepare("SELECT legacy_entity_id FROM form_record_legacy_links WHERE form_record_id=? AND legacy_entity_type='project'").get(recordId);
  const projectId = existingLink ? Number(existingLink.legacy_entity_id) : null;
  if (code) {
    const duplicate = db.prepare('SELECT id FROM projects WHERE code=? AND id<>coalesce(?,0)').get(code,projectId);
    if (duplicate) throw new Error('رمز المشروع مستخدم في سجل آخر.');
  }
  const previous = projectId ? db.prepare('SELECT * FROM projects WHERE id=?').get(projectId) : null;
  if (projectId && !previous) throw new Error('رابط المشروع المعتمد يشير إلى سجل غير موجود.');
  const payload = { code,name,description,geographic_unit_id:geography?.id ?? null,sector_id:sector?.id ?? null,status,
    estimated_cost:estimatedCost,actual_cost:actualCost,currency_code:currency,start_date:startDate,end_date:endDate,source_id:sourceId };
  let linkedProjectId = projectId;
  if (previous) {
    db.prepare('INSERT INTO project_versions(project_id,action,payload_json,source_id,created_at) VALUES(?,?,?,?,?)')
      .run(projectId,'central-record-approval-update',JSON.stringify(previous),sourceId,now);
    db.prepare(`UPDATE projects SET code=?,name=?,description=?,geographic_unit_id=?,sector_id=?,status=?,estimated_cost=?,actual_cost=?,currency_code=?,
      start_date=?,end_date=?,source_id=?,updated_at=? WHERE id=?`)
      .run(code,name,description,payload.geographic_unit_id,payload.sector_id,status,estimatedCost,actualCost,currency,startDate,endDate,sourceId,now,projectId);
  } else {
    linkedProjectId = Number(db.prepare(`INSERT INTO projects(code,name,description,geographic_unit_id,sector_id,status,estimated_cost,actual_cost,currency_code,
      start_date,end_date,source_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(code,name,description,payload.geographic_unit_id,payload.sector_id,status,estimatedCost,actualCost,currency,startDate,endDate,sourceId,now,now).lastInsertRowid);
    db.prepare("INSERT INTO form_record_legacy_links(form_record_id,legacy_entity_type,legacy_entity_id,linked_at) VALUES(?,'project',?,?)")
      .run(recordId,linkedProjectId,now);
    db.prepare(`INSERT INTO project_versions(project_id,action,payload_json,source_id,created_at) VALUES(?,?,?,?,?)`)
      .run(linkedProjectId,'central-record-approval-create',JSON.stringify(payload),sourceId,now);
    db.prepare(`INSERT OR IGNORE INTO application_migration_log(migration_code,source_table,source_id,target_table,target_id,status,details,created_at)
      VALUES('domain-records-v1','projects',?,'form_records',?,'migrated','مرتبط بسجل المشروع المركزي المعتمد.',?)`)
      .run(String(linkedProjectId),String(recordId),now);
  }
  db.prepare('INSERT INTO access_log(action,entity,entity_id,fields,detail,created_at) VALUES(?,?,?,?,?,?)')
    .run(previous ? 'central-record-update' : 'central-record-create','projects',String(linkedProjectId),'project_v1','form_record=' + recordId,now);
  return { projectId:linkedProjectId,action:previous ? 'updated' : 'created' };
}
function syncApprovedProjectFunding(db,recordId,actor,now) {
  const record = db.prepare('SELECT form_record_id,form_version_id,parent_record_id,geo_unit_id FROM form_records WHERE form_record_id=?').get(recordId);
  const form = db.prepare('SELECT f.form_code FROM form_versions v JOIN form_definitions f USING(form_id) WHERE v.form_version_id=?').get(record.form_version_id);
  if (form?.form_code !== 'project_funding_v1') return null;
  const parent = resolveApprovedProjectParent(db,record.parent_record_id);
  const scalarRows = db.prepare(`SELECT field.field_code,value.value_text,value.value_date,value.value_state
    FROM record_field_values value JOIN form_fields field USING(form_field_id) WHERE value.form_record_id=?`).all(recordId);
  const values = Object.fromEntries(scalarRows.filter(row => ['known','zero'].includes(row.value_state))
    .map(row => [row.field_code,row.value_date ?? row.value_text]));
  const amountRow = db.prepare(`SELECT observation.value_integer,observation.value_real,observation.value_state
    FROM observations observation JOIN form_fields field USING(form_field_id)
    WHERE observation.form_record_id=? AND field.field_code='amount'`).get(recordId);
  const amount = amountRow && ['known','zero'].includes(amountRow.value_state)
    ? amountRow.value_integer ?? amountRow.value_real : null;
  const partner = String(values.partnerName ?? '').trim();
  if (!partner || partner.length > 240) throw new Error('اسم جهة التمويل مطلوب قبل اعتماد سجل التمويل.');
  const currency = String(values.currencyCode ?? '').trim().toUpperCase() || null;
  if (amount != null && !currency) throw new Error('أدخل رمز العملة قبل اعتماد مبلغ التمويل.');
  if (currency && !/^[A-Z]{3}$/.test(currency)) throw new Error('رمز عملة التمويل يجب أن يتكون من ثلاثة أحرف لاتينية.');
  const fundingDate = values.fundingDate ?? null;
  const link = db.prepare("SELECT legacy_entity_id FROM form_record_legacy_links WHERE form_record_id=? AND legacy_entity_type='project_funding'").get(recordId);
  const fundingId = link ? Number(link.legacy_entity_id) : null;
  const previous = fundingId ? db.prepare('SELECT * FROM project_funding WHERE id=?').get(fundingId) : null;
  if (fundingId && (!previous || Number(previous.project_id) !== Number(parent.project_id))) {
    throw new Error('رابط التمويل المعتمد لا يطابق المشروع الأب المحدد.');
  }
  const revision = db.prepare('SELECT source_id FROM record_revisions WHERE form_record_id=? ORDER BY revision_number DESC LIMIT 1').get(recordId);
  const sourceId = revision?.source_id == null ? null
    : db.prepare('SELECT id FROM data_sources WHERE id=? OR source_id=? ORDER BY id LIMIT 1').get(revision.source_id,revision.source_id)?.id ?? null;
  const project = db.prepare('SELECT * FROM projects WHERE id=?').get(parent.project_id);
  if (previous) {
    const fundingBefore = db.prepare('SELECT * FROM project_funding WHERE project_id=? ORDER BY id').all(parent.project_id);
    db.prepare('INSERT INTO project_versions(project_id,action,payload_json,source_id,created_at) VALUES(?,?,?,?,?)')
      .run(parent.project_id,'central-funding-approval-update',JSON.stringify({ project,funding:fundingBefore }),sourceId,now);
    db.prepare('UPDATE project_funding SET partner_name=?,amount=?,currency_code=?,funding_date=?,source_id=? WHERE id=?')
      .run(partner,amount,currency,fundingDate,sourceId,fundingId);
  } else {
    const inserted = db.prepare(`INSERT INTO project_funding(project_id,partner_name,amount,currency_code,funding_date,source_id,created_at)
      VALUES(?,?,?,?,?,?,?)`).run(parent.project_id,partner,amount,currency,fundingDate,sourceId,now);
    const createdId = Number(inserted.lastInsertRowid);
    db.prepare("INSERT INTO form_record_legacy_links(form_record_id,legacy_entity_type,legacy_entity_id,linked_at) VALUES(?,'project_funding',?,?)")
      .run(recordId,createdId,now);
    db.prepare(`INSERT OR IGNORE INTO application_migration_log(migration_code,source_table,source_id,target_table,target_id,status,details,created_at)
      VALUES('domain-records-v1','project_funding',?,'form_records',?,'migrated','مرتبط بسجل تمويل المشروع المركزي المعتمد.',?)`)
      .run(String(createdId),String(recordId),now);
  }
  db.prepare('UPDATE projects SET updated_at=?,source_id=? WHERE id=?').run(now,sourceId,parent.project_id);
  const linkedFundingId = fundingId ?? Number(db.prepare("SELECT legacy_entity_id FROM form_record_legacy_links WHERE form_record_id=? AND legacy_entity_type='project_funding'").get(recordId).legacy_entity_id);
  db.prepare('INSERT INTO access_log(action,entity,entity_id,fields,detail,created_at) VALUES(?,?,?,?,?,?)')
    .run(previous ? 'central-funding-update' : 'central-funding-create','project_funding',String(linkedFundingId),'project_id,partner_name,amount,currency_code,funding_date',
      `project=${parent.project_id};form_record=${recordId}`,now);
  return { fundingId:linkedFundingId,projectId:parent.project_id,action:previous ? 'updated' : 'created' };
}
function syncApprovedIndicatorObservation(db,recordId,actor,now) {
  const record = db.prepare('SELECT form_record_id,form_version_id,geo_unit_id FROM form_records WHERE form_record_id=?').get(recordId);
  const form = db.prepare('SELECT f.form_code FROM form_versions v JOIN form_definitions f USING(form_id) WHERE v.form_version_id=?').get(record.form_version_id);
  if (form?.form_code !== 'indicator_observation_v1') return null;
  const scalarRows = db.prepare(`SELECT field.field_code,value.value_text,value.value_state
    FROM record_field_values value JOIN form_fields field USING(form_field_id) WHERE value.form_record_id=?`).all(recordId);
  const values = Object.fromEntries(scalarRows.filter(row => ['known','zero'].includes(row.value_state)).map(row => [row.field_code,row.value_text]));
  const measurement = db.prepare(`SELECT observation.value_integer,observation.value_real,observation.value_state
    FROM observations observation JOIN form_fields field USING(form_field_id)
    WHERE observation.form_record_id=? AND field.field_code='valueNumber'`).get(recordId);
  const indicatorCode = String(values.indicatorCode ?? '').trim();
  const period = String(values.periodKey ?? '').trim();
  const state = String(values.valueState ?? measurement?.value_state ?? 'known').trim();
  if (!indicatorCode || !period || period.length > 80) throw new Error('رمز المؤشر والفترة مطلوبان قبل اعتماد القياس.');
  if (!['known','zero','not_available','unknown','not_applicable','not_collected','not_verified'].includes(state)) throw new Error('حالة قيمة المؤشر غير معتمدة.');
  const indicator = db.prepare('SELECT id,unit FROM indicator_definitions WHERE code=? AND active=1').get(indicatorCode);
  if (!indicator) throw new Error('رمز المؤشر لا يطابق تعريفاً نشطاً في القاموس.');
  const geographic = record.geo_unit_id == null ? null : db.prepare('SELECT id FROM geographic_units WHERE geo_unit_id=?').get(record.geo_unit_id);
  if (!geographic) throw new Error('الموقع الجغرافي للقياس غير محدد أو غير مرتبط بالمرجع الموحد.');
  const hasNumeric = measurement && ['known','zero'].includes(measurement.value_state);
  const number = hasNumeric ? measurement.value_integer ?? measurement.value_real : null;
  const text = values.valueText ?? null;
  if (state === 'known' && number == null && !text) throw new Error('قيمة المؤشر المعروفة تتطلب قيمة رقمية أو نصية.');
  if (!['known','zero'].includes(state) && (number != null || text)) throw new Error('القيمة المفقودة لا يجوز أن تحمل قيمة رقمية أو نصية فعلية.');
  if (state === 'zero' && number !== 0) throw new Error('حالة الصفر تتطلب قيمة رقمية تساوي صفراً.');
  if (indicator.unit === '%' && number != null && number > 100) throw new Error('قيمة النسبة المئوية تتجاوز 100.');
  const existingLink = db.prepare("SELECT legacy_entity_id FROM form_record_legacy_links WHERE form_record_id=? AND legacy_entity_type='indicator_observation'").get(recordId);
  const observationId = existingLink ? Number(existingLink.legacy_entity_id) : null;
  const previous = observationId ? db.prepare('SELECT * FROM indicator_observations WHERE id=?').get(observationId) : null;
  if (observationId && !previous) throw new Error('رابط قياس المؤشر يشير إلى سجل غير موجود.');
  const duplicate = db.prepare(`SELECT id FROM indicator_observations WHERE indicator_id=? AND geographic_unit_id=? AND period_key=? AND id<>coalesce(?,0)`)
    .get(indicator.id,geographic.id,period,observationId);
  if (duplicate) throw new Error('يوجد قياس آخر للمؤشر والموقع والفترة نفسها؛ راجع السجل الموجود قبل الاعتماد.');
  const revision = db.prepare('SELECT source_id FROM record_revisions WHERE form_record_id=? ORDER BY revision_number DESC LIMIT 1').get(recordId);
  const sourceId = revision?.source_id == null ? null : db.prepare('SELECT id FROM data_sources WHERE id=? OR source_id=? ORDER BY id LIMIT 1').get(revision.source_id,revision.source_id)?.id ?? null;
  const sourceLocation = `مركز الإدخال اليدوي:form-record-${recordId}`;
  if (previous) {
    db.prepare('INSERT INTO indicator_observation_versions(observation_id,action,payload_json,source_id,created_at) VALUES(?,?,?,?,?)')
      .run(observationId,'central-record-approval-update',JSON.stringify(previous),sourceId,now);
    db.prepare(`UPDATE indicator_observations SET indicator_id=?,geographic_unit_id=?,period_key=?,value_number=?,value_text=?,value_state=?,source_id=?,source_location=? WHERE id=?`)
      .run(indicator.id,geographic.id,period,number,text,state,sourceId,sourceLocation,observationId);
  } else {
    const created = db.prepare(`INSERT INTO indicator_observations(indicator_id,geographic_unit_id,period_key,value_number,value_text,value_state,source_id,source_location,created_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(indicator.id,geographic.id,period,number,text,state,sourceId,sourceLocation,now);
    const createdId = Number(created.lastInsertRowid);
    db.prepare("INSERT INTO form_record_legacy_links(form_record_id,legacy_entity_type,legacy_entity_id,linked_at) VALUES(?,'indicator_observation',?,?)")
      .run(recordId,createdId,now);
    db.prepare(`INSERT OR IGNORE INTO application_migration_log(migration_code,source_table,source_id,target_table,target_id,status,details,created_at)
      VALUES('domain-records-v1','indicator_observations',?,'form_records',?,'migrated','مرتبط بسجل قياس المؤشر المركزي المعتمد.',?)`)
      .run(String(createdId),String(recordId),now);
  }
  const linkedObservationId = observationId ?? Number(db.prepare("SELECT legacy_entity_id FROM form_record_legacy_links WHERE form_record_id=? AND legacy_entity_type='indicator_observation'").get(recordId).legacy_entity_id);
  db.prepare(`UPDATE value_provenance SET source_locator=? WHERE observation_id=?
    AND provenance_id=(SELECT MAX(latest.provenance_id) FROM value_provenance latest WHERE latest.observation_id=?)`)
    .run(sourceLocation,linkedObservationId,linkedObservationId);
  db.prepare('INSERT INTO access_log(action,entity,entity_id,fields,detail,created_at) VALUES(?,?,?,?,?,?)')
    .run(previous ? 'central-record-update' : 'central-record-create','indicator_observations',String(linkedObservationId),'indicatorCode,periodKey,valueNumber,valueText,valueState','form_record=' + recordId,now);
  return { observationId:linkedObservationId,action:previous ? 'updated' : 'created' };
}
function recordSnapshot(db,recordId) {
  const record = db.prepare('SELECT * FROM form_records WHERE form_record_id=?').get(recordId);
  const values = db.prepare(`SELECT ff.field_code,rfv.item_ordinal,rfv.value_text,rfv.value_boolean,rfv.value_date,rfv.value_reference_id,rfv.value_entity_id,rfv.value_state,NULL AS dimension_signature
    FROM record_field_values rfv JOIN form_fields ff USING(form_field_id) WHERE rfv.form_record_id=?
    UNION ALL
    SELECT ff.field_code,1,o.value_integer,o.value_real,o.value_text,NULL,NULL,o.value_state,o.dimension_signature
    FROM observations o JOIN form_fields ff USING(form_field_id) WHERE o.form_record_id=?`).all(recordId,recordId);
  return { record,values };
}
function getRecord(db,recordId) {
  const id = Number(recordId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('معرّف السجل غير صالح.');
  const record = db.prepare(`SELECT r.*,g.name_ar AS geo_name,p.label_ar AS period_label,p.year_gregorian AS period_year FROM form_records r
    LEFT JOIN geographic_units g ON g.geo_unit_id=r.geo_unit_id LEFT JOIN periods p ON p.period_id=r.period_id
    WHERE r.form_record_id=?`).get(id);
  if (!record) throw new Error('السجل غير موجود.');
  const values = {};
  const stored = db.prepare(`SELECT ff.field_code,v.record_field_value_id,v.value_text,v.value_boolean,v.value_date,v.value_reference_id,v.value_entity_id,v.value_state,
    provenance.source_id,provenance.source_locator,provenance.provenance_type,provenance.original_value_text,provenance.normalized_value_text,
    provenance.entered_by,provenance.created_at AS provenance_at,source.source_type,source.document_title,source.file_name,source.organization
    FROM record_field_values v JOIN form_fields ff USING(form_field_id)
    LEFT JOIN value_provenance provenance ON provenance.provenance_id=(SELECT MAX(latest.provenance_id) FROM value_provenance latest WHERE latest.record_field_value_id=v.record_field_value_id)
    LEFT JOIN data_sources source ON source.id=provenance.source_id WHERE v.form_record_id=?`).all(id);
  for (const row of stored) {
    const value = row.value_boolean == null ? row.value_text ?? row.value_date ?? row.value_reference_id ?? row.value_entity_id : String(row.value_boolean);
    values[row.field_code] = { value:value == null ? '' : String(value),state:row.value_state,sourceId:row.source_id,sourceLocator:row.source_locator,
      provenanceType:row.provenance_type,originalValue:row.original_value_text,normalizedValue:row.normalized_value_text,enteredBy:row.entered_by,
      provenanceAt:row.provenance_at,sourceType:row.source_type,documentTitle:row.document_title,fileName:row.file_name,organization:row.organization };
  }
  const observations = db.prepare(`SELECT ff.field_code,o.observation_id,o.value_integer,o.value_real,o.value_text,o.value_state,o.dimension_signature,
    provenance.source_id,provenance.source_locator,provenance.provenance_type,provenance.original_value_text,provenance.normalized_value_text,
    provenance.entered_by,provenance.created_at AS provenance_at,source.source_type,source.document_title,source.file_name,source.organization
    FROM observations o JOIN form_fields ff USING(form_field_id)
    LEFT JOIN value_provenance provenance ON provenance.provenance_id=(SELECT MAX(latest.provenance_id) FROM value_provenance latest WHERE latest.observation_id=o.observation_id)
    LEFT JOIN data_sources source ON source.id=provenance.source_id WHERE o.form_record_id=?`).all(id);
  const dimensionRows = db.prepare(`SELECT observation.observation_id,definition.dimension_code,value.value_code,value.label_ar
    FROM observations observation JOIN observation_dimensions mapping USING(observation_id)
    JOIN dimension_definitions definition USING(dimension_id) JOIN dimension_values value USING(dimension_value_id)
    WHERE observation.form_record_id=? ORDER BY definition.dimension_code`).all(id);
  const dimensionsByObservation = new Map();
  for (const row of dimensionRows) {
    const dimensions = dimensionsByObservation.get(row.observation_id) ?? {};
    dimensions[row.dimension_code] = { code:row.value_code,label:row.label_ar };
    dimensionsByObservation.set(row.observation_id,dimensions);
  }
  for (const row of observations) {
    const value = row.value_integer ?? row.value_real ?? row.value_text;
    values[row.field_code] = { value:value == null ? '' : String(value),state:row.value_state,sourceId:row.source_id,sourceLocator:row.source_locator,
      provenanceType:row.provenance_type,originalValue:row.original_value_text,normalizedValue:row.normalized_value_text,enteredBy:row.entered_by,
      provenanceAt:row.provenance_at,sourceType:row.source_type,documentTitle:row.document_title,fileName:row.file_name,organization:row.organization,
      dimensionSignature:row.dimension_signature,dimensions:dimensionsByObservation.get(row.observation_id) ?? {} };
  }
  return { record,values };
}
function getRecordOverview(db, request = {}) {
  const limit = Math.min(12,Math.max(1,Number(request.limit)||6));
  const statusCounts = Object.fromEntries(['draft','pending_review','approved','rejected','superseded','archived'].map(status => [status,0]));
  for (const row of db.prepare('SELECT record_status,COUNT(*) AS count FROM form_records GROUP BY record_status').all()) {
    if (Object.hasOwn(statusCounts,row.record_status)) statusCounts[row.record_status] = row.count;
  }
  const rows = db.prepare(`SELECT record.form_record_id,record.form_version_id,record.record_label,record.record_status,record.updated_at,
      form.form_code,form.name_ar AS form_name,geo.name_ar AS geo_name,period.label_ar AS period_label,
      (SELECT COUNT(*) FROM record_field_values value WHERE value.form_record_id=record.form_record_id)
        +(SELECT COUNT(*) FROM observations observation WHERE observation.form_record_id=record.form_record_id) AS value_count,
      (SELECT COUNT(*) FROM value_provenance provenance JOIN observations observation ON observation.observation_id=provenance.observation_id WHERE observation.form_record_id=record.form_record_id)
        +(SELECT COUNT(*) FROM value_provenance provenance JOIN record_field_values value ON value.record_field_value_id=provenance.record_field_value_id WHERE value.form_record_id=record.form_record_id) AS source_count
    FROM form_records record JOIN form_versions version USING(form_version_id) JOIN form_definitions form USING(form_id)
    LEFT JOIN geographic_units geo ON geo.geo_unit_id=record.geo_unit_id
    LEFT JOIN periods period ON period.period_id=record.period_id
    ORDER BY record.updated_at DESC,record.form_record_id DESC LIMIT ?`).all(limit);
  const formVersionCounts = Object.fromEntries(db.prepare(`SELECT record.form_version_id,form.form_code,COUNT(*) AS record_count,MAX(record.updated_at) AS latest_updated_at
    FROM form_records record JOIN form_versions version USING(form_version_id) JOIN form_definitions form USING(form_id)
    GROUP BY record.form_version_id,form.form_code`).all().map(row => [String(row.form_version_id),{
      formCode:row.form_code,recordCount:row.record_count,latestUpdatedAt:row.latest_updated_at,
    }]));
  const total = db.prepare('SELECT COUNT(*) AS count FROM form_records').get().count;
  return { total,statusCounts,formVersionCounts,latest:rows };
}
function listRecords(db, request = {}) {
  const formId = Number(request.formVersionId);
  const limit = Math.min(200,Math.max(1,Number(request.limit)||50));
  const offset = Math.max(0,Math.min(1000000,Number(request.offset)||0));
  const search = String(request.search ?? '').trim().slice(0,120);
  const status = ['draft','pending_review','approved','rejected','superseded','archived'].includes(request.status) ? request.status : null;
  const formRecordId = Number(request.formRecordId);
  const conditions = [];
  const params = [];
  if (Number.isSafeInteger(formId) && formId > 0) { conditions.push('r.form_version_id=?'); params.push(formId); }
  if (Number.isSafeInteger(formRecordId) && formRecordId > 0) { conditions.push('r.form_record_id=?'); params.push(formRecordId); }
  if (status) { conditions.push('r.record_status=?'); params.push(status); }
  if (search) {
    conditions.push("(instr(lower(coalesce(r.record_label,'')),lower(?))>0 OR instr(lower(coalesce(g.name_ar,'')),lower(?))>0 OR instr(lower(coalesce(p.label_ar,'')),lower(?))>0 OR instr(lower(f.form_code),lower(?))>0 OR instr(lower(f.name_ar),lower(?))>0)");
    params.push(search,search,search,search,search);
  }
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const from = `FROM form_records r JOIN form_versions version ON version.form_version_id=r.form_version_id
    JOIN form_definitions f ON f.form_id=version.form_id
    LEFT JOIN geographic_units g ON g.geo_unit_id=r.geo_unit_id LEFT JOIN periods p ON p.period_id=r.period_id`;
  const total = db.prepare(`SELECT COUNT(*) AS count ${from} ${where}`).get(...params).count;
  const rows = db.prepare(`SELECT r.form_record_id,r.form_version_id,r.geo_unit_id,g.name_ar AS geo_name,r.period_id,p.label_ar AS period_label,
    r.record_label,r.record_status,r.revision_number,r.created_at,r.updated_at,r.approved_at,f.form_code,f.name_ar AS form_name,
    (SELECT COUNT(*) FROM record_field_values v WHERE v.form_record_id=r.form_record_id)+(SELECT COUNT(*) FROM observations o WHERE o.form_record_id=r.form_record_id) AS value_count,
    (SELECT COUNT(*) FROM value_provenance provenance JOIN observations o ON o.observation_id=provenance.observation_id WHERE o.form_record_id=r.form_record_id)
      +(SELECT COUNT(*) FROM value_provenance provenance JOIN record_field_values v ON v.record_field_value_id=provenance.record_field_value_id WHERE v.form_record_id=r.form_record_id) AS source_count
    ${from} ${where} ORDER BY r.updated_at DESC,r.form_record_id DESC LIMIT ? OFFSET ?`).all(...params,limit,offset);
  return { rows,total,limit,offset,hasPrevious:offset>0,hasNext:offset+rows.length<total };
}
function listApprovedProjectParents(db,request = {}) {
  const limit = Math.min(200,Math.max(1,Number(request.limit)||50));
  const offset = Math.max(0,Math.min(1000000,Number(request.offset)||0));
  const search = String(request.search ?? '').trim().slice(0,120);
  const conditions = ["record.record_status='approved'","form.form_code='project_v1'"];
  const params = [];
  const parentRecordId = Number(request.parentRecordId);
  if (Number.isSafeInteger(parentRecordId) && parentRecordId > 0) {
    conditions.push('record.form_record_id=?');
    params.push(parentRecordId);
  }
  if (search) {
    conditions.push("(instr(lower(coalesce(project.name,'')),lower(?))>0 OR instr(lower(coalesce(project.code,'')),lower(?))>0)");
    params.push(search,search);
  }
  const from = `FROM form_records record
    JOIN form_versions version ON version.form_version_id=record.form_version_id
    JOIN form_definitions form ON form.form_id=version.form_id
    JOIN form_record_legacy_links link ON link.form_record_id=record.form_record_id AND link.legacy_entity_type='project'
    JOIN projects project ON project.id=link.legacy_entity_id
    LEFT JOIN geographic_units geo ON geo.geo_unit_id=record.geo_unit_id`;
  const where = `WHERE ${conditions.join(' AND ')}`;
  const total = db.prepare(`SELECT COUNT(*) AS count ${from} ${where}`).get(...params).count;
  const rows = db.prepare(`SELECT record.form_record_id AS formRecordId,record.geo_unit_id AS geoUnitId,
      project.id AS projectId,project.name,project.code,geo.name_ar AS geoName
    ${from} ${where} ORDER BY lower(project.name),project.id LIMIT ? OFFSET ?`).all(...params,limit,offset);
  return { rows,total,limit,offset,hasPrevious:offset>0,hasNext:offset+rows.length<total };
}
function submitForReview(db,recordId,actor) {
  return decideRecord(db,recordId,{decision:'submit',actor});
}
function decideRecord(db,recordId,request = {}) {
  const id = Number(recordId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('معرّف السجل غير صالح.');
  const decisions = { submit:'pending_review',approve:'approved',reject:'rejected',return:'draft',reopen:'draft' };
  if (!Object.hasOwn(decisions,request.decision)) throw new Error('قرار المراجعة غير معروف.');
  const now = new Date().toISOString();
  return db.transaction(() => {
    const previous = db.prepare('SELECT * FROM form_records WHERE form_record_id=?').get(id);
    if (!previous) throw new Error('السجل غير موجود.');
    if (request.decision === 'submit' && !['draft','rejected'].includes(previous.record_status)) throw new Error('لا يمكن إرسال هذا السجل للمراجعة من حالته الحالية.');
    if (['approve','reject','return'].includes(request.decision) && previous.record_status !== 'pending_review') throw new Error('يجب أن يكون السجل قيد المراجعة قبل اتخاذ القرار.');
    if (request.decision === 'reopen' && previous.record_status !== 'approved') throw new Error('يمكن إعادة فتح السجل المعتمد فقط.');
    if (['reject','return','reopen'].includes(request.decision) && !String(request.reason ?? '').trim()) throw new Error('سبب قرار المراجعة مطلوب.');
    if (request.decision === 'approve') {
      const blockers = db.prepare("SELECT COUNT(*) AS count FROM data_quality_issues WHERE form_record_id=? AND quality_status='open' AND severity IN ('error','blocking','critical')").get(id).count;
      if (blockers) throw new Error('لا يمكن اعتماد سجل لديه مشكلات جودة مانعة مفتوحة.');
    }
    const next = decisions[request.decision];
    const actor = typeof request.actor === 'string' ? request.actor.slice(0,120) : null;
    const before = recordSnapshot(db,id);
    if (request.decision === 'reopen') markEducationFacilityUnderReview(db,id,actor,now,request.reason);
    const legacySync = request.decision === 'approve'
      ? (syncApprovedEducationFacility(db,id,actor,now) ?? syncApprovedDirectorate(db,id,actor,now) ?? syncApprovedProject(db,id,actor,now)
        ?? syncApprovedProjectFunding(db,id,actor,now) ?? syncApprovedIndicatorObservation(db,id,actor,now))
      : null;
    const revision = previous.revision_number + 1;
    db.prepare(`UPDATE form_records SET record_status=?,revision_number=?,submitted_by=CASE WHEN ?='pending_review' THEN ? ELSE submitted_by END,
      reviewed_by=CASE WHEN ? IN ('approved','rejected','draft') THEN ? ELSE reviewed_by END,
      approved_by=CASE WHEN ?='reopen' THEN NULL WHEN ?='approved' THEN ? ELSE approved_by END,
      submitted_at=CASE WHEN ?='pending_review' THEN ? ELSE submitted_at END,
      approved_at=CASE WHEN ?='reopen' THEN NULL WHEN ?='approved' THEN ? ELSE approved_at END,updated_at=? WHERE form_record_id=?`)
      .run(next,revision,next,actor,next,actor,request.decision,request.decision,actor,next,now,request.decision,request.decision,now,now,id);
    const reviewDecision = request.decision === 'submit' ? 'submitted' : request.decision === 'return' ? 'returned' : request.decision === 'reopen' ? 'reopened' : request.decision;
    db.prepare('INSERT INTO record_reviews(form_record_id,review_stage,decision,reviewer_id,decision_reason,reviewed_at) VALUES(?,?,?,?,?,?)')
      .run(id,request.decision==='submit'?'submission':'review',reviewDecision,actor,request.reason ?? null,now);
    const after = recordSnapshot(db,id);
    db.prepare('INSERT INTO record_revisions(form_record_id,revision_number,action_type,before_snapshot_json,after_snapshot_json,change_reason,changed_by,created_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(id,revision,`review_${request.decision}`,JSON.stringify(before),JSON.stringify(after),request.reason ?? null,actor,now);
    audit(db,{code:'record_review',resourceType:'form_record',resourceId:id,action:request.decision,before,after,actor,details:request.reason ?? null});
    return { formRecordId:id,status:next,revisionNumber:revision };
  })();
}
function archiveLinkedDirectorate(db,legacyId,actor,now = new Date().toISOString()) {
  const linked = db.prepare("SELECT r.form_record_id,r.record_status,r.revision_number FROM form_record_legacy_links link JOIN form_records r USING(form_record_id) WHERE link.legacy_entity_type='directorate' AND link.legacy_entity_id=? AND r.record_status<>'archived' ORDER BY r.form_record_id").all(Number(legacyId));
  for (const record of linked) {
    const before = recordSnapshot(db,record.form_record_id);
    const revision = Number(record.revision_number) + 1;
    db.prepare("UPDATE form_records SET record_status='archived',revision_number=?,updated_at=? WHERE form_record_id=?")
      .run(revision,now,record.form_record_id);
    const after = recordSnapshot(db,record.form_record_id);
    db.prepare(`INSERT INTO record_revisions(form_record_id,revision_number,action_type,before_snapshot_json,after_snapshot_json,change_reason,changed_by,created_at)
      VALUES(?,?,'archive',?,?,? ,?,?)`).run(record.form_record_id,revision,JSON.stringify(before),JSON.stringify(after),'إزالة سجل التوافق مع إبقاء السجل المعياري محفوظاً.',actor,now);
    audit(db,{code:'form_record_archive',resourceType:'form_record',resourceId:record.form_record_id,action:'archive',before,after,actor,details:`legacy_directorate_id=${legacyId}`});
  }
  return linked.map(record => Number(record.form_record_id));
}
function listGeoUnits(db, search = '') {
  const term = String(search ?? '').trim().slice(0,100);
  return db.prepare(`SELECT g.geo_unit_id,g.geo_unit_type_id,t.type_code,t.name_ar AS type_name_ar,g.parent_geo_unit_id,p.name_ar AS parent_name_ar,
    g.name_ar,g.official_code,g.is_active FROM geographic_units g JOIN geo_unit_types t USING(geo_unit_type_id)
    LEFT JOIN geographic_units p ON p.geo_unit_id=g.parent_geo_unit_id
    WHERE (?='' OR g.normalized_name LIKE '%' || ? || '%') ORDER BY t.level_order,g.normalized_name LIMIT 500`).all(term ? normalize(term) : '',term ? normalize(term) : '');
}
function listPeriods(db) {
  return db.prepare('SELECT period_id,period_code,period_type,calendar_type,label_ar,label_en,start_date,end_date FROM periods WHERE is_active=1 ORDER BY coalesce(start_date,created_at) DESC LIMIT 300').all();
}

function migrateApprovedEducationFacilities(db) {
  const checksum = crypto.createHash('sha256').update(EDUCATION_SYNC_CODE).update('education_facility|schools|form_records.entity_id').digest('hex');
  const existing = db.prepare('SELECT * FROM schema_migrations WHERE version=?').get(EDUCATION_SYNC_VERSION);
  if (existing?.success === 1) {
    if (existing.checksum !== checksum || existing.migration_code !== EDUCATION_SYNC_CODE) {
      throw new Error('ترحيل ربط المنشآت التعليمية تغيّر بعد تطبيقه؛ أضف ترحيلاً جديداً بدلاً من تعديل النسخة المنشورة.');
    }
    return { version:EDUCATION_SYNC_VERSION,alreadyApplied:true };
  }
  if (existing) db.prepare('DELETE FROM schema_migrations WHERE version=? AND success=0').run(EDUCATION_SYNC_VERSION);
  const now = new Date().toISOString();
  const startedAt = Date.now();
  let linked = 0;
  const deferred = [];
  try {
    db.transaction(() => {
      const approved = db.prepare(`SELECT record.form_record_id FROM form_records record
        JOIN form_versions version USING(form_version_id) JOIN form_definitions form USING(form_id)
        WHERE form.form_code='education_school_collection_v1' AND record.record_status='approved' AND record.entity_id IS NULL
        ORDER BY record.form_record_id`).all();
      for (const row of approved) {
        try {
          db.transaction(() => syncApprovedEducationFacility(db,row.form_record_id,'migration',now))();
          linked += 1;
        } catch (error) {
          deferred.push(`${row.form_record_id}:${String(error.message).slice(0,180)}`);
        }
      }
      db.prepare(`INSERT INTO schema_migrations(version,migration_code,migration_name,checksum,applied_at,execution_ms,success,details)
        VALUES(?,?,?,?,?,?,1,?)`).run(EDUCATION_SYNC_VERSION,EDUCATION_SYNC_CODE,'ربط سجلات المدارس المعتمدة بالكيانات المركزية',checksum,now,
          Date.now()-startedAt,`linked=${linked};deferred=${deferred.length};${deferred.slice(0,20).join('|')}`);
    })();
  } catch (error) {
    db.prepare(`INSERT OR REPLACE INTO schema_migrations(version,migration_code,migration_name,checksum,applied_at,execution_ms,success,details)
      VALUES(?,?,?,?,?,?,0,?)`).run(EDUCATION_SYNC_VERSION,EDUCATION_SYNC_CODE,'ربط سجلات المدارس المعتمدة بالكيانات المركزية',checksum,
        new Date().toISOString(),Date.now()-startedAt,String(error.message).slice(0,4000));
    throw error;
  }
  return { version:EDUCATION_SYNC_VERSION,alreadyApplied:false,linked,deferred };
}

module.exports = { parseLocalizedNumber, parseValue, listForms, getFormDefinition, saveRecord, saveRecordFromDocument, getRecord, getRecordOverview, listRecords, listApprovedProjectParents, submitForReview, decideRecord, archiveLinkedDirectorate, listGeoUnits, listPeriods, migrateApprovedEducationFacilities };
