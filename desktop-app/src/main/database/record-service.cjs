'use strict';

const crypto = require('node:crypto');
const { normalize } = require('./architecture.cjs');

const VALUE_STATES = new Set(['known','zero','not_available','unknown','not_applicable','not_collected','not_verified']);
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
    f.sector_id,s.name_ar AS sector_name_ar,fv.form_version_id,fv.version_number,fv.version_label,fv.status AS version_status
    FROM form_definitions f LEFT JOIN sectors s ON s.sector_id=f.sector_id
    LEFT JOIN form_versions fv ON fv.form_id=f.form_id AND fv.version_number=(SELECT MAX(v.version_number) FROM form_versions v WHERE v.form_id=f.form_id)
    ORDER BY coalesce(s.sort_order,0),f.form_code`).all();
}
function getFormDefinition(db, formVersionId) {
  const id = Number(formVersionId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('إصدار النموذج غير صالح.');
  const version = db.prepare(`SELECT fv.*,fv.status AS version_status,f.form_code,f.name_ar,f.name_en,f.sector_id,f.description AS form_description,
    f.data_structure_type,f.default_geo_level_id FROM form_versions fv JOIN form_definitions f USING(form_id) WHERE fv.form_version_id=?`).get(id);
  if (!version) throw new Error('إصدار النموذج غير موجود.');
  const sections = db.prepare('SELECT * FROM form_sections WHERE form_version_id=? ORDER BY sort_order,section_id').all(id);
  const fields = db.prepare(`SELECT ff.*,fd.canonical_name_ar,fd.canonical_name_en,fd.semantic_type,fd.data_type,
    fd.default_unit_id,mu.name_ar AS unit_name_ar,rs.set_code AS reference_set_code
    FROM form_fields ff LEFT JOIN field_definitions fd USING(field_definition_id)
    LEFT JOIN measurement_units mu ON mu.unit_id=coalesce(ff.unit_id,fd.default_unit_id)
    LEFT JOIN reference_sets rs ON rs.reference_set_id=coalesce(ff.reference_set_id,fd.reference_set_id)
    WHERE ff.form_version_id=? ORDER BY ff.section_id,ff.sort_order,ff.form_field_id`).all(id);
  const rows = db.prepare('SELECT * FROM form_row_definitions WHERE form_version_id=? ORDER BY sort_order,row_definition_id').all(id);
  return { ...version, sections, fields, rows };
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
function saveRecord(db, request = {}) {
  const versionId = Number(request.formVersionId);
  const definition = getFormDefinition(db,versionId);
  if (definition.version_status !== 'published') throw new Error('لا يمكن إدخال بيانات إلى إصدار نموذج غير منشور.');
  const geoUnitId = resolveGeo(db,request.geoUnitId);
  const values = request.values && typeof request.values === 'object' && !Array.isArray(request.values) ? request.values : {};
  const fields = new Map(definition.fields.map(field => [field.field_code,field]));
  const unknown = Object.keys(values).filter(code => !fields.has(code));
  if (unknown.length) throw new Error(`حقول غير معرّفة في إصدار النموذج: ${unknown.slice(0,4).join('، ')}`);
  const parsed = [];
  for (const [fieldCode,input] of Object.entries(values)) {
    const field = fields.get(fieldCode);
    if (!field.is_importable || field.is_derived || field.storage_class === 'ignored_derived') throw new Error(`الحقل «${field.label_ar}» غير قابل للإدخال المباشر.`);
    parsed.push({ field, value:parseValue(field,input) });
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
    if (parsed.some(item => item.field.storage_class === 'measurement' && ['known','zero'].includes(item.value.state))
      && !request.periodId && !request.periodYear) throw new Error('حدّد الفترة المرجعية للقياسات قبل حفظ السجل.');
    const periodId = resolvePeriod(db,request.periodId,request.periodYear);
    const sourceId = addManualSource(db,actor,now);
    const before = previous ? recordSnapshot(db,previous.form_record_id) : null;
    let recordId = previous?.form_record_id;
    if (!previous) {
      const result = db.prepare(`INSERT INTO form_records(form_version_id,entity_id,geo_unit_id,period_id,record_code,record_key,record_label,record_status,revision_number,notes,created_by,created_at,updated_at)
        VALUES(?,NULL,?,?,?,?,?,'draft',1,?,?,?,?)`).run(versionId,geoUnitId,periodId,request.recordCode ?? null,request.recordKey ?? null,
          request.recordLabel ?? null,request.notes ?? null,actor,now,now);
      recordId = Number(result.lastInsertRowid);
    } else {
      db.prepare(`UPDATE form_records SET geo_unit_id=?,period_id=?,record_label=?,notes=?,revision_number=revision_number+1,updated_at=? WHERE form_record_id=?`)
        .run(geoUnitId,periodId,request.recordLabel ?? previous.record_label,request.notes ?? previous.notes,now,recordId);
    }
    for (const item of parsed) storeFieldValue(db,recordId,item.field,item.value,sourceId,actor,now);
    const after = recordSnapshot(db,recordId);
    const revision = db.prepare('SELECT revision_number FROM form_records WHERE form_record_id=?').get(recordId).revision_number;
    db.prepare(`INSERT INTO record_revisions(form_record_id,revision_number,action_type,before_snapshot_json,after_snapshot_json,change_reason,changed_by,source_id,created_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(recordId,revision,previous?'manual_update':'manual_create',before?JSON.stringify(before):null,JSON.stringify(after),request.changeReason ?? null,actor,sourceId,now);
    audit(db,{code:'form_record',resourceType:'form_record',resourceId:recordId,action:previous?'update':'create',before,after,actor,details:`source_id=${sourceId}`});
    return { formRecordId:recordId,revisionNumber:revision,sourceId,status:previous?.record_status ?? 'draft' };
  })();
}
function storeFieldValue(db,recordId,field,parsed,sourceId,actor,now) {
  if (field.storage_class === 'measurement') {
    if (!field.field_definition_id) throw new Error(`حقل القياس «${field.label_ar}» لا يرتبط بتعريف دلالي.`);
    const valueInteger = parsed.state === 'known' || parsed.state === 'zero' ? (Number.isInteger(parsed.value) ? parsed.value : null) : null;
    const valueReal = parsed.state === 'known' || parsed.state === 'zero' ? (!Number.isInteger(parsed.value) ? parsed.value : null) : null;
    const record = db.prepare('SELECT geo_unit_id,period_id FROM form_records WHERE form_record_id=?').get(recordId);
    const existing = db.prepare('SELECT observation_id FROM observations WHERE form_record_id=? AND form_field_id=? ORDER BY observation_id DESC LIMIT 1').get(recordId,field.form_field_id);
    let observationId;
    if (existing) {
      observationId = existing.observation_id;
      db.prepare(`UPDATE observations SET field_definition_id=?,geo_unit_id=?,period_id=?,unit_id=?,value_integer=?,value_real=?,value_text=NULL,
        value_state=?,source_id=?,updated_at=? WHERE observation_id=?`).run(field.field_definition_id,record.geo_unit_id,record.period_id,field.unit_id,
        valueInteger,valueReal,parsed.state,sourceId,now,observationId);
    } else {
      observationId = Number(db.prepare(`INSERT INTO observations(form_record_id,form_field_id,field_definition_id,geo_unit_id,period_id,unit_id,value_integer,value_real,value_text,value_state,observation_role,quality_status,dimension_signature,source_id,created_by,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?, 'observed','unverified','',?,?,?,?)`).run(recordId,field.form_field_id,field.field_definition_id,
          record.geo_unit_id,record.period_id,field.unit_id,valueInteger,valueReal,null,parsed.state,sourceId,actor,now,now).lastInsertRowid);
    }
    db.prepare(`INSERT INTO value_provenance(observation_id,source_id,provenance_type,original_value_text,normalized_value_text,entered_by,created_at)
      VALUES(?,?,?,?,?,?,?)`).run(observationId,sourceId,parsed.explicitDelete?'explicit_deletion':'manual_entry',parsed.raw,parsed.value == null ? null : String(parsed.value),actor,now);
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
  db.prepare(`INSERT INTO value_provenance(record_field_value_id,source_id,provenance_type,original_value_text,normalized_value_text,entered_by,created_at)
    VALUES(?,?,?,?,?,?,?)`).run(valueId,sourceId,parsed.explicitDelete?'explicit_deletion':'manual_entry',parsed.raw,parsed.value == null ? null : String(parsed.value),actor,now);
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
  const result = persist.upsertDirectorate(db,identity,{ fileName:`إدخال مركزي #${recordId}`,sheetName:form.form_code,warnings:[],actor });
  db.prepare("INSERT OR IGNORE INTO form_record_legacy_links(form_record_id,legacy_entity_type,legacy_entity_id,linked_at) VALUES(?,'directorate',?,?)")
    .run(recordId,result.id,now);
  return result;
}
function recordSnapshot(db,recordId) {
  const record = db.prepare('SELECT * FROM form_records WHERE form_record_id=?').get(recordId);
  const values = db.prepare(`SELECT ff.field_code,rfv.item_ordinal,rfv.value_text,rfv.value_boolean,rfv.value_date,rfv.value_reference_id,rfv.value_entity_id,rfv.value_state
    FROM record_field_values rfv JOIN form_fields ff USING(form_field_id) WHERE rfv.form_record_id=?
    UNION ALL
    SELECT ff.field_code,1,o.value_integer,o.value_real,o.value_text,NULL,NULL,o.value_state
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
  const stored = db.prepare(`SELECT ff.field_code,v.value_text,v.value_boolean,v.value_date,v.value_reference_id,v.value_entity_id,v.value_state
    FROM record_field_values v JOIN form_fields ff USING(form_field_id) WHERE v.form_record_id=?`).all(id);
  for (const row of stored) {
    const value = row.value_boolean == null ? row.value_text ?? row.value_date ?? row.value_reference_id ?? row.value_entity_id : String(row.value_boolean);
    values[row.field_code] = { value: value == null ? '' : String(value),state:row.value_state };
  }
  const observations = db.prepare(`SELECT ff.field_code,o.value_integer,o.value_real,o.value_text,o.value_state FROM observations o
    JOIN form_fields ff USING(form_field_id) WHERE o.form_record_id=?`).all(id);
  for (const row of observations) {
    const value = row.value_integer ?? row.value_real ?? row.value_text;
    values[row.field_code] = { value:value == null ? '' : String(value),state:row.value_state };
  }
  return { record,values };
}
function listRecords(db, request = {}) {
  const formId = Number(request.formVersionId);
  const limit = Math.min(200,Math.max(1,Number(request.limit)||50));
  const offset = Math.max(0,Math.min(1000000,Number(request.offset)||0));
  const search = String(request.search ?? '').trim().slice(0,120);
  const status = ['draft','pending_review','approved','rejected','superseded','archived'].includes(request.status) ? request.status : null;
  const conditions = [];
  const params = [];
  if (Number.isSafeInteger(formId) && formId > 0) { conditions.push('r.form_version_id=?'); params.push(formId); }
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
    (SELECT COUNT(*) FROM record_field_values v WHERE v.form_record_id=r.form_record_id)+(SELECT COUNT(*) FROM observations o WHERE o.form_record_id=r.form_record_id) AS value_count
    ${from} ${where} ORDER BY r.updated_at DESC,r.form_record_id DESC LIMIT ? OFFSET ?`).all(...params,limit,offset);
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
    const legacySync = request.decision === 'approve' ? syncApprovedDirectorate(db,id,actor,now) : null;
    const revision = previous.revision_number + 1;
    const before = recordSnapshot(db,id);
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

module.exports = { parseLocalizedNumber, parseValue, listForms, getFormDefinition, saveRecord, getRecord, listRecords, submitForReview, decideRecord, listGeoUnits, listPeriods };
