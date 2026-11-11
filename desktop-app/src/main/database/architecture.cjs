'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { INPUT_FIELDS, DECISION_FIELD, DIRECTORATE_FIELD_CLASS_BY_KEY } = require('../analysis/schema.cjs');

const VERSION = 4;
const CODE = '2026-11-11-domain-record-backfill-v4';
const SCHEMA_FILE = path.join(__dirname, 'architecture-v1.sql');
const SCHEMA_SQL = fs.readFileSync(SCHEMA_FILE, 'utf8');
const TABLE_COLUMNS = {
  sectors: [['sector_id','INTEGER'],['parent_sector_id','INTEGER'],['sector_code','TEXT'],['name_en','TEXT'],['sort_order','INTEGER NOT NULL DEFAULT 0'],['is_active','INTEGER NOT NULL DEFAULT 1'],['updated_at','TEXT']],
  geographic_units: [['geo_unit_id','INTEGER'],['geo_unit_type_id','INTEGER'],['parent_geo_unit_id','INTEGER'],['name_ar','TEXT'],['name_en','TEXT'],['valid_from','TEXT'],['valid_to','TEXT'],['is_active','INTEGER NOT NULL DEFAULT 1'],['source_id','INTEGER']],
  data_sources: [['source_id','INTEGER'],['source_code','TEXT'],['organization_name','TEXT'],['reference_period_id','INTEGER'],['storage_path','TEXT'],['entered_by','TEXT'],['metadata_json','TEXT'],['content_sha256','TEXT'],['file_size_bytes','INTEGER']],
  projects: [['project_id','INTEGER'],['entity_id','INTEGER'],['project_code','TEXT'],['project_name','TEXT'],['project_type_id','INTEGER'],['ownership_type_id','INTEGER'],['project_status_id','INTEGER'],['geo_unit_id','INTEGER']],
  import_batches: [['batch_id','INTEGER'],['batch_uuid','TEXT'],['source_id','INTEGER'],['batch_status','TEXT'],['parser_version','TEXT'],['mapping_version','TEXT'],['created_by','TEXT'],['started_at','TEXT'],['completed_at','TEXT'],['total_sheets','INTEGER NOT NULL DEFAULT 0'],['total_regions','INTEGER NOT NULL DEFAULT 0'],['total_rows','INTEGER NOT NULL DEFAULT 0'],['accepted_rows','INTEGER NOT NULL DEFAULT 0'],['rejected_rows','INTEGER NOT NULL DEFAULT 0'],['warning_rows','INTEGER NOT NULL DEFAULT 0'],['blocked_rows','INTEGER NOT NULL DEFAULT 0'],['idempotency_key','TEXT'],['failure_reason','TEXT'],['metadata_json','TEXT']],
  data_quality_issues: [['quality_issue_id','INTEGER'],['form_record_id','INTEGER'],['observation_id','INTEGER'],['record_field_value_id','INTEGER'],['field_definition_id','INTEGER'],['issue_code','TEXT'],['severity','TEXT'],['issue_description','TEXT'],['detected_by_rule','TEXT'],['quality_status',"TEXT NOT NULL DEFAULT 'open'"],['resolution_note','TEXT'],['resolved_by','TEXT']],
  import_field_mappings: [['target_entity_type','TEXT'],['target_field_code','TEXT']],
};
const UNIT_CODES = Object.freeze({
  'نسمة':'person','مدرسة':'school','طالب':'student','منشأة':'facility','كسر 0-1 (تغطية)':'fraction',
  'كسر 0-1':'fraction','نسمة/كم2':'density','كم':'km','ريال':'yer','طن':'tonne','رأس':'head',
  'سلسلة':'chain','جمعية':'association','نعم/لا':'boolean','مديرية':'directorate',
});
const FIELD_META = new Map([...INPUT_FIELDS, DECISION_FIELD].map(field => [field.key, field]));

function normalize(value) {
  return String(value ?? '').normalize('NFKD').replace(/[\u064B-\u065F\u0670\u06D6-\u06ED]/g, '')
    .replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ').toLowerCase();
}
function tableExists(db, table) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}
function columns(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
}
function addColumns(db) {
  for (const [table, definitions] of Object.entries(TABLE_COLUMNS)) {
    if (!tableExists(db, table)) continue;
    const present = columns(db, table);
    for (const [name, declaration] of definitions) {
      if (present.has(name)) continue;
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${declaration}`);
      present.add(name);
    }
  }
}
function ensureCompatKeys(db) {
  db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS sectors_sector_id_unique ON sectors(sector_id);
      CREATE UNIQUE INDEX IF NOT EXISTS sectors_sector_code_unique ON sectors(sector_code) WHERE sector_code IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS geo_unit_id_unique ON geographic_units(geo_unit_id);
      CREATE UNIQUE INDEX IF NOT EXISTS source_id_unique ON data_sources(source_id);
      CREATE UNIQUE INDEX IF NOT EXISTS project_id_unique ON projects(project_id);
      CREATE UNIQUE INDEX IF NOT EXISTS import_batch_id_unique ON import_batches(batch_id);
      CREATE UNIQUE INDEX IF NOT EXISTS import_batch_uuid_unique ON import_batches(batch_uuid) WHERE batch_uuid IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS import_batch_idempotency_unique ON import_batches(idempotency_key) WHERE idempotency_key IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS quality_issue_id_unique ON data_quality_issues(quality_issue_id) WHERE quality_issue_id IS NOT NULL;
      UPDATE sectors SET sector_id=id,sector_code=coalesce(sector_code,code),is_active=active,updated_at=coalesce(updated_at,created_at);
      UPDATE geographic_units SET geo_unit_id=id,parent_geo_unit_id=parent_id,name_ar=name,is_active=coalesce(is_active,1),updated_at=coalesce(updated_at,created_at);
      UPDATE data_sources SET source_id=id,organization_name=coalesce(organization_name,organization),file_size_bytes=coalesce(file_size_bytes,file_size);
      UPDATE projects SET project_id=id,project_code=coalesce(project_code,code),project_name=coalesce(project_name,name),geo_unit_id=coalesce(geo_unit_id,geographic_unit_id);
      UPDATE data_quality_issues SET quality_issue_id=id,issue_code=coalesce(issue_code,'legacy_quality_issue'),severity=coalesce(severity,'info'),
        issue_description=coalesce(issue_description,message),quality_status=coalesce(quality_status,status),resolution_note=coalesce(resolution_note,resolution);
      CREATE TRIGGER IF NOT EXISTS audit_events_no_update BEFORE UPDATE ON audit_events BEGIN SELECT RAISE(ABORT,'audit_events is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS audit_events_no_delete BEFORE DELETE ON audit_events BEGIN SELECT RAISE(ABORT,'audit_events is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS geo_no_self_parent_insert BEFORE INSERT ON geographic_units WHEN NEW.parent_geo_unit_id=NEW.geo_unit_id
        BEGIN SELECT RAISE(ABORT,'geographic unit cannot parent itself'); END;
      CREATE TRIGGER IF NOT EXISTS geo_no_cycle_update BEFORE UPDATE OF parent_geo_unit_id ON geographic_units WHEN NEW.parent_geo_unit_id IS NOT NULL BEGIN
        SELECT CASE WHEN NEW.parent_geo_unit_id=NEW.geo_unit_id OR EXISTS(
          WITH RECURSIVE ancestors(id) AS (SELECT NEW.parent_geo_unit_id UNION ALL
          SELECT g.parent_geo_unit_id FROM geographic_units g JOIN ancestors a ON g.geo_unit_id=a.id WHERE g.parent_geo_unit_id IS NOT NULL)
          SELECT 1 FROM ancestors WHERE id=NEW.geo_unit_id
        ) THEN RAISE(ABORT,'geographic hierarchy cycle') END;
      END;
      CREATE TRIGGER IF NOT EXISTS observation_dimension_valid_insert BEFORE INSERT ON observation_dimensions BEGIN
        SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM dimension_values v WHERE v.dimension_value_id=NEW.dimension_value_id AND v.dimension_id=NEW.dimension_id)
          THEN RAISE(ABORT,'dimension value belongs to another dimension') END;
      END;
      CREATE TRIGGER IF NOT EXISTS observation_dimension_valid_update BEFORE UPDATE OF dimension_id,dimension_value_id ON observation_dimensions BEGIN
        SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM dimension_values v WHERE v.dimension_value_id=NEW.dimension_value_id AND v.dimension_id=NEW.dimension_id)
          THEN RAISE(ABORT,'dimension value belongs to another dimension') END;
      END;
    `);
    const importColumns = columns(db,'import_batches');
    if (importColumns.has('id') && importColumns.has('status')) {
      db.prepare('UPDATE import_batches SET batch_id=id,batch_status=coalesce(batch_status,status)').run();
    }
    if (importColumns.has('batch_id') && importColumns.has('batch_status')) {
      db.prepare("UPDATE import_batches SET batch_uuid=coalesce(batch_uuid,'legacy-batch-' || batch_id),source_id=coalesce(source_id,(SELECT source_id FROM data_sources ORDER BY source_id LIMIT 1)) WHERE batch_id IS NOT NULL").run();
    }
}
function seedTypesAndUnits(db, now) {
  const types = [['governorate','محافظة',1],['directorate','مديرية',2],['district','عزلة',3],['uzla','عزلة',3],['settlement','تجمع',4],['village','قرية',5],['locality','محلة',6]];
  const addType = db.prepare('INSERT OR IGNORE INTO geo_unit_types(type_code,name_ar,level_order,created_at) VALUES(?,?,?,?)');
  types.forEach(row => addType.run(...row,now));
  const ids = new Map(db.prepare('SELECT geo_unit_type_id,type_code FROM geo_unit_types').all().map(row => [row.type_code,row.geo_unit_type_id]));
  for (const [child,parent] of [['directorate','governorate'],['district','directorate'],['uzla','directorate'],['settlement','uzla'],['village','settlement'],['locality','village']]) {
    db.prepare('UPDATE geo_unit_types SET parent_type_id=? WHERE type_code=? AND parent_type_id IS NULL').run(ids.get(parent),child);
  }
  for (const [legacy,canonical] of [['governorate','governorate'],['district','directorate'],['directorate','directorate']]) {
    db.prepare('UPDATE geographic_units SET geo_unit_type_id=? WHERE unit_type=? AND geo_unit_type_id IS NULL').run(ids.get(canonical),legacy);
  }
  db.prepare('UPDATE geographic_units SET parent_geo_unit_id=parent_id WHERE parent_id IS NOT NULL AND parent_geo_unit_id IS NULL').run();
  const units = [['person','نسمة','people'],['school','مدرسة','count'],['student','طالب','people'],['facility','منشأة','count'],['fraction','نسبة','ratio'],['density','نسمة/كم2','density'],['km','كيلومتر','length'],['yer','ريال يمني','currency'],['tonne','طن','mass'],['head','رأس','count'],['chain','سلسلة','count'],['association','جمعية','count'],['none','بلا وحدة','dimensionless']];
  const addUnit = db.prepare('INSERT OR IGNORE INTO measurement_units(unit_code,name_ar,unit_category,created_at) VALUES(?,?,?,?)');
  units.forEach(row => addUnit.run(...row,now));
}
function seedForms(db, now) {
  const groups = [[1,4,'البيانات الجغرافية والإدارية'],[5,9,'السكان والخصائص الاجتماعية'],[10,10,'التحليل الرباعي'],[11,20,'الموارد الطبيعية والمياه والمناخ والتنوع الحيوي'],[21,26,'المصفوفات والتقييمات والتصنيفات الاجتماعية والاقتصادية'],[27,35,'العادات والموروث والنزوح والإعاقة والفئات الاجتماعية'],[36,47,'السلطة المحلية والبناء المؤسسي والجمعيات والشركاء'],[48,58,'التعليم والمدارس والالتحاق والأمية والكادر التعليمي'],[59,63,'الصحة والمرافق الصحية والأمراض والخدمات'],[64,65,'الثقافة والرياضة'],[66,73,'المياه والصرف الصحي والطاقة والطرق والاتصالات'],[74,84,'الزراعة والثروة الحيوانية والنحل والمنتجات والصيد البحري'],[85,92,'المنشآت والاقتصاد والنشاط المهني والسياحة والتجارة'],[93,96,'المالية والموارد المحلية والإنفاق والتحصيل'],[97,102,'القيم المرجعية والمستهدفات والمؤشرات المرجعية'],[103,105,'التحديات التنموية والأولويات والأهداف والبرامج والخطط']];
  const sectorFor = number => {
    const [start,end] = groups.find(([first,last]) => number >= first && number <= last);
    return db.prepare('SELECT sector_id FROM sectors WHERE sector_code=?').get(`form-range-${start}-${end}`).sector_id;
  };
  const addSector = db.prepare("INSERT OR IGNORE INTO sectors(code,name_ar,description,created_at,active,sector_id,sector_code,is_active,updated_at) VALUES(?,?,?, ?,1,NULL,NULL,1,?)");
  for (const [start,end,label] of groups) {
    addSector.run(`form-range-${start}-${end}`,label,'نطاق تصنيف النماذج؛ لا يمثل توصيفاً لحقولها.',now,now);
    db.prepare('UPDATE sectors SET sector_id=id,sector_code=code,updated_at=coalesce(updated_at,created_at) WHERE code=?').run(`form-range-${start}-${end}`);
  }
  const addForm = db.prepare("INSERT OR IGNORE INTO form_definitions(form_code,name_ar,sector_id,description,data_structure_type,is_active,created_at,updated_at) VALUES(?,?,?,'لم يتوفر تعريف المصدر الأصلي؛ لم يُخترع اسم أو حقل.','unresolved_definition',0,?,?)");
  const addVersion = db.prepare("INSERT OR IGNORE INTO form_versions(form_id,version_number,version_label,status,definition_hash,change_summary,created_at) VALUES(?,1,'غير متاح','draft',?,'يلزم مصدر موثوق لتعريف النموذج وأقسامه وحقوله.',?)");
  for (let number=1; number<=105; number++) {
    const code = `form_${String(number).padStart(3,'0')}`;
    addForm.run(code,`تعريف غير محسوم للنموذج ${String(number).padStart(3,'0')}`,sectorFor(number),now,now);
    const formId = db.prepare('SELECT form_id FROM form_definitions WHERE form_code=?').get(code).form_id;
    addVersion.run(formId,crypto.createHash('sha256').update(`${code}:unresolved`).digest('hex'),now);
  }
  const addLegacy = db.prepare("INSERT OR IGNORE INTO form_definitions(form_code,name_ar,description,data_structure_type,is_active,created_at,updated_at) VALUES('legacy_directorate_v1','حقول المديرية الحالية','مخطط توافق مبني على schema.cjs الحالي.','flat_table',1,?,?)");
  addLegacy.run(now,now);
  const formId = db.prepare("SELECT form_id FROM form_definitions WHERE form_code='legacy_directorate_v1'").get().form_id;
  const definitionHash = crypto.createHash('sha256').update([...INPUT_FIELDS,DECISION_FIELD].map(field => `${field.key}:${field.type}`).join('|')).digest('hex');
  db.prepare("INSERT OR IGNORE INTO form_versions(form_id,version_number,version_label,status,definition_hash,change_summary,created_at,published_at) VALUES(?,1,'التوافق الأولي','published',?,'مستمد من تعريفات الحقول الحالية.',?,?)").run(formId,definitionHash,now,now);
  const versionId = db.prepare('SELECT form_version_id FROM form_versions WHERE form_id=? AND version_number=1').get(formId).form_version_id;
  db.prepare("INSERT OR IGNORE INTO form_sections(form_version_id,section_code,name_ar,section_type,sort_order,is_required,created_at) VALUES(?,'directorate','بيانات المديرية','record',0,1,?)").run(versionId,now);
  const sectionId = db.prepare("SELECT section_id FROM form_sections WHERE form_version_id=? AND section_code='directorate'").get(versionId).section_id;
  const addUnit = db.prepare('INSERT OR IGNORE INTO measurement_units(unit_code,name_ar,unit_category,created_at) VALUES(?,?,?,?)');
  const addDefinition = db.prepare('INSERT OR IGNORE INTO field_definitions(field_code,canonical_name_ar,description,semantic_type,data_type,default_unit_id,is_active,created_at,updated_at) VALUES(?,?,?,?,?,?,1,?,?)');
  const addField = db.prepare(`INSERT OR IGNORE INTO form_fields(form_version_id,section_id,field_definition_id,field_code,source_column_index,source_column_letter,source_header_text,header_path_json,label_ar,data_type_override,storage_class,axis_role,is_required,allow_null,is_importable,sort_order,min_value,max_value,validation_rules_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const [index,field] of [...INPUT_FIELDS,DECISION_FIELD].entries()) {
    const classification = DIRECTORATE_FIELD_CLASS_BY_KEY[field.key] ?? 'attribute';
    const dataType = field.type === 'ratio' || field.type === 'number' ? 'decimal' : field.type === 'boolean' ? 'boolean' : 'text';
    const unitCode = UNIT_CODES[field.unit] ?? (field.type === 'ratio' ? 'fraction' : null);
    const unitId = unitCode ? db.prepare('SELECT unit_id FROM measurement_units WHERE unit_code=?').get(unitCode)?.unit_id : null;
    if (field.unit && !unitCode) addUnit.run(`legacy-${field.key}`,field.unit,'legacy',now);
    const finalUnitId = unitId ?? (field.unit && !unitCode ? db.prepare('SELECT unit_id FROM measurement_units WHERE unit_code=?').get(`legacy-${field.key}`).unit_id : null);
    const fieldCode = `directorate.${field.key}`;
    const semanticType = ['identity','review_decision'].includes(classification) ? classification : ['number','ratio'].includes(field.type) ? 'measurement' : 'attribute';
    addDefinition.run(fieldCode,field.header,classification,semanticType,dataType,finalUnitId,now,now);
    const definitionId = db.prepare('SELECT field_definition_id FROM field_definitions WHERE field_code=?').get(fieldCode).field_definition_id;
    const columnIndex = columnIndexOf(field.column ?? `A`);
    const minimum = field.positive ? Number.EPSILON : field.type === 'ratio' ? 0 : null;
    const maximum = field.type === 'ratio' ? 1 : null;
    const validationRules = field.allowed ? JSON.stringify({ allowedValues:field.allowed }) : null;
    addField.run(versionId,sectionId,definitionId,fieldCode,columnIndex,field.column ?? null,field.header,JSON.stringify([field.header]),field.header,dataType,
      ['number','ratio'].includes(field.type) ? 'measurement' : 'record_value','column',field.role === 'identity' ? 1 : 0,field.role === 'identity' ? 0 : 1,1,index,minimum,maximum,validationRules,now);
    db.prepare('UPDATE form_fields SET min_value=?,max_value=?,validation_rules_json=? WHERE form_version_id=? AND field_code=?')
      .run(minimum,maximum,validationRules,versionId,fieldCode);
  }
}
function ensureDomainForm(db, now, formCode, name, fields) {
  const definitionHash = crypto.createHash('sha256').update(JSON.stringify(fields)).digest('hex');
  db.prepare(`INSERT OR IGNORE INTO form_definitions(form_code,name_ar,description,data_structure_type,is_active,created_at,updated_at)
    VALUES(?,?,?,'flat_table',1,?,?)`).run(formCode,name,`تعريف معياري مستمد من حقول نطاق ${name} الحالية دون إضافة معادلات أو بيانات.`,now,now);
  const formId = db.prepare('SELECT form_id FROM form_definitions WHERE form_code=?').get(formCode).form_id;
  db.prepare(`INSERT OR IGNORE INTO form_versions(form_id,version_number,version_label,status,definition_hash,change_summary,created_at,published_at)
    VALUES(?,1,'التوافق الأولي','published',?,'تعريف مبني على حقول النطاق القائمة.',?,?)`).run(formId,definitionHash,now,now);
  const versionId = db.prepare('SELECT form_version_id FROM form_versions WHERE form_id=? AND version_number=1').get(formId).form_version_id;
  db.prepare(`INSERT OR IGNORE INTO form_sections(form_version_id,section_code,name_ar,section_type,sort_order,is_required,created_at)
    VALUES(?,'main',?,'record',0,1,?)`).run(versionId,name,now);
  const sectionId = db.prepare("SELECT section_id FROM form_sections WHERE form_version_id=? AND section_code='main'").get(versionId).section_id;
  const addDefinition = db.prepare(`INSERT OR IGNORE INTO field_definitions(field_code,canonical_name_ar,description,semantic_type,data_type,is_active,created_at,updated_at)
    VALUES(?,?,?,'attribute',?,1,?,?)`);
  const addField = db.prepare(`INSERT OR IGNORE INTO form_fields(form_version_id,section_id,field_definition_id,field_code,label_ar,data_type_override,
    storage_class,axis_role,is_required,allow_null,is_importable,sort_order,created_at) VALUES(?,?,?,?,?,?,?,'column',0,1,1,?,?)`);
  for (const [sortOrder,field] of fields.entries()) {
    const fieldCode = `${formCode}.${field.code}`;
    const storageClass = field.type === 'decimal' || field.type === 'integer' ? 'measurement' : 'record_value';
    addDefinition.run(fieldCode,field.label,`نقل مباشر من الحقل الحالي ${field.code}.`,field.type,now,now);
    const definitionId = db.prepare('SELECT field_definition_id FROM field_definitions WHERE field_code=?').get(fieldCode).field_definition_id;
    addField.run(versionId,sectionId,definitionId,field.code,field.label,field.type,storageClass,sortOrder,now);
  }
  return versionId;
}

function sourceForDomainRecord(db, sourceId, sourceType, description, now) {
  if (sourceId != null) {
    const source = db.prepare('SELECT id,source_id FROM data_sources WHERE id=? OR source_id=? ORDER BY id LIMIT 1').get(sourceId,sourceId);
    if (source) {
      if (source.source_id == null) db.prepare('UPDATE data_sources SET source_id=id WHERE id=?').run(source.id);
      return Number(source.source_id ?? source.id);
    }
  }
  const created = db.prepare(`INSERT INTO data_sources(source_type,document_title,received_at,notes) VALUES(?,?,?,?)`)
    .run(sourceType,description,now,description);
  const id = Number(created.lastInsertRowid);
  db.prepare('UPDATE data_sources SET source_id=id WHERE id=?').run(id);
  return id;
}

function storeMigratedDomainValue(db, recordId, formVersionId, field, value, sourceId, sourceLocator, now) {
  if (value === null || value === undefined || value === '') return;
  const definition = db.prepare(`SELECT ff.form_field_id,ff.field_definition_id,ff.storage_class,ff.unit_id
    FROM form_fields ff WHERE ff.form_version_id=? AND ff.field_code=?`).get(formVersionId,field.code);
  if (!definition) throw new Error(`تعريف الحقل المعياري مفقود: ${field.code}`);
  let targetId;
  let targetType;
  let normalized;
  if (definition.storage_class === 'measurement') {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new Error(`قيمة قياس المصدر غير رقمية: ${field.code}`);
    const result = db.prepare(`INSERT INTO observations(form_record_id,form_field_id,field_definition_id,unit_id,value_integer,value_real,value_state,
      observation_role,quality_status,source_id,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,'known','observed','unverified',?,'legacy-migration',?,?)`)
      .run(recordId,definition.form_field_id,definition.field_definition_id,definition.unit_id,Number.isInteger(number)?number:null,
        Number.isInteger(number)?null:number,sourceId,now,now);
    targetId = Number(result.lastInsertRowid);
    targetType = 'observation_id';
    normalized = String(number);
  } else {
    const stored = field.type === 'date'
      ? { text:null,date:String(value),boolean:null }
      : field.type === 'boolean'
        ? { text:null,date:null,boolean:Number(value) ? 1 : 0 }
        : { text:String(value),date:null,boolean:null };
    const result = db.prepare(`INSERT INTO record_field_values(form_record_id,form_field_id,value_text,value_boolean,value_date,value_state,raw_value_text,normalized_value_text,created_at,updated_at)
      VALUES(?,?,?,?,?,'known',?,?,?,?)`).run(recordId,definition.form_field_id,stored.text,stored.boolean,stored.date,String(value),String(value),now,now);
    targetId = Number(result.lastInsertRowid);
    targetType = 'record_field_value_id';
    normalized = String(value);
  }
  db.prepare(`INSERT INTO value_provenance(${targetType},source_id,provenance_type,original_value_text,normalized_value_text,source_locator,created_at)
    VALUES(?,?,'legacy_domain_migration',?,?,?,?)`).run(targetId,sourceId,String(value),normalized,sourceLocator,now);
}

function completeMigrationSnapshot(db, recordId) {
  const record = db.prepare('SELECT form_record_id,record_code,record_label,record_status,geo_unit_id,created_at,updated_at FROM form_records WHERE form_record_id=?').get(recordId);
  const fieldValues = db.prepare(`SELECT ff.field_code,v.item_ordinal,v.value_text,v.value_boolean,v.value_date,v.value_reference_id,v.value_entity_id,v.value_state
    FROM record_field_values v JOIN form_fields ff USING(form_field_id) WHERE v.form_record_id=? ORDER BY ff.sort_order,v.item_ordinal`).all(recordId);
  const observations = db.prepare(`SELECT ff.field_code,o.period_id,o.unit_id,o.value_integer,o.value_real,o.value_text,o.value_state,o.observation_role,o.quality_status
    FROM observations o JOIN form_fields ff USING(form_field_id) WHERE o.form_record_id=? ORDER BY ff.sort_order,o.observation_id`).all(recordId);
  db.prepare('UPDATE record_revisions SET after_snapshot_json=? WHERE form_record_id=? AND revision_number=1')
    .run(JSON.stringify({ record,fieldValues,observations }),recordId);
}

function syncCanonicalGeographicUnit(db, legacyUnitId, now = new Date().toISOString(), visited = new Set()) {
  const id = Number(legacyUnitId);
  if (!Number.isSafeInteger(id) || id <= 0 || visited.has(id)) return null;
  visited.add(id);
  const unit = db.prepare('SELECT id,parent_id,unit_type,name,normalized_name FROM geographic_units WHERE id=?').get(id);
  if (!unit) return null;
  const typeCode = ({ district:'directorate',directorate:'directorate',governorate:'governorate',uzla:'uzla',settlement:'settlement',village:'village',locality:'locality' })[unit.unit_type];
  const type = typeCode ? db.prepare('SELECT geo_unit_type_id FROM geo_unit_types WHERE type_code=?').get(typeCode) : null;
  const parentGeoId = unit.parent_id == null ? null : syncCanonicalGeographicUnit(db,unit.parent_id,now,visited);
  db.prepare(`UPDATE geographic_units SET geo_unit_id=coalesce(geo_unit_id,id),geo_unit_type_id=coalesce(?,geo_unit_type_id),
    parent_geo_unit_id=CASE WHEN parent_id IS NULL THEN NULL WHEN ? IS NOT NULL THEN ? ELSE parent_geo_unit_id END,
    name_ar=name,normalized_name=coalesce(normalized_name,name),is_active=coalesce(is_active,1),updated_at=? WHERE id=?`)
    .run(type?.geo_unit_type_id ?? null,parentGeoId,parentGeoId,now,id);
  return db.prepare('SELECT geo_unit_id FROM geographic_units WHERE id=?').get(id)?.geo_unit_id ?? null;
}

function syncDomainRecordValues(db, { recordId, formVersionId, fields, values, sourceId, sourceTable, sourceIdValue, sourceLocation = null, geoUnitId = null, parentRecordId = null, label = null, now, isNew = false }) {
  const snapshot = () => {
    const record = db.prepare('SELECT form_record_id,form_version_id,parent_record_id,geo_unit_id,period_id,record_code,record_label,record_status,revision_number,created_at,updated_at FROM form_records WHERE form_record_id=?').get(recordId);
    const fieldValues = db.prepare(`SELECT ff.field_code,v.item_ordinal,v.value_text,v.value_boolean,v.value_date,v.value_reference_id,v.value_entity_id,v.value_state
      FROM record_field_values v JOIN form_fields ff USING(form_field_id) WHERE v.form_record_id=?`).all(recordId);
    const observations = db.prepare(`SELECT ff.field_code,o.period_id,o.unit_id,o.value_integer,o.value_real,o.value_text,o.value_state,o.source_id
      FROM observations o JOIN form_fields ff USING(form_field_id) WHERE o.form_record_id=?`).all(recordId);
    return { record,fieldValues,observations };
  };
  const before = snapshot();
  let changed = before.record.geo_unit_id !== geoUnitId || before.record.parent_record_id !== parentRecordId || before.record.record_label !== label;
  for (const field of fields) {
    const definition = db.prepare('SELECT form_field_id,field_definition_id,storage_class,unit_id FROM form_fields WHERE form_version_id=? AND field_code=?').get(formVersionId,field.code);
    if (!definition) throw new Error(`تعريف الحقل المعياري مفقود: ${field.code}`);
    const value = values[field.code] ?? null;
    const raw = value === null ? null : String(value);
    const locator = sourceLocation === 'إدخال يدوي' ? sourceLocation : sourceLocation ? `${sourceLocation}:${sourceTable}:${sourceIdValue}:${field.code}` : `${sourceTable}:${sourceIdValue}:${field.code}`;
    const state = raw === null || raw === '' ? 'unknown' : 'known';
    if (definition.storage_class === 'measurement') {
      const number = state === 'known' ? Number(value) : null;
      if (number !== null && !Number.isFinite(number)) throw new Error(`قيمة قياس المصدر غير رقمية: ${field.code}`);
      const integerValue = number !== null && Number.isInteger(number) ? number : null;
      const realValue = number !== null && !Number.isInteger(number) ? number : null;
      const existing = db.prepare('SELECT observation_id,value_integer,value_real,value_text,value_state FROM observations WHERE form_record_id=? AND form_field_id=? ORDER BY observation_id DESC LIMIT 1').get(recordId,definition.form_field_id);
      if (existing && existing.value_integer === integerValue && existing.value_real === realValue && existing.value_text === null && existing.value_state === state) continue;
      if (!existing && state === 'unknown') continue;
      let observationId;
      if (existing) {
        observationId = Number(existing.observation_id);
        db.prepare('UPDATE observations SET field_definition_id=?,geo_unit_id=?,unit_id=?,value_integer=?,value_real=?,value_text=NULL,value_state=?,source_id=?,updated_at=? WHERE observation_id=?')
          .run(definition.field_definition_id,geoUnitId,definition.unit_id,integerValue,realValue,state,sourceId,now,observationId);
      } else {
        observationId = Number(db.prepare(`INSERT INTO observations(form_record_id,form_field_id,field_definition_id,geo_unit_id,unit_id,value_integer,value_real,value_text,value_state,observation_role,quality_status,source_id,created_by,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,NULL,?,'observed','unverified',?,'legacy-sync',?,?)`).run(recordId,definition.form_field_id,definition.field_definition_id,geoUnitId,definition.unit_id,integerValue,realValue,state,sourceId,now,now).lastInsertRowid);
      }
      db.prepare(`INSERT INTO value_provenance(observation_id,source_id,provenance_type,original_value_text,normalized_value_text,source_locator,created_at)
        VALUES(?,?,'legacy_domain_sync',?,?,?,?)`).run(observationId,sourceId,raw,number === null ? null : String(number),locator,now);
      changed = true;
    } else {
      const existing = db.prepare('SELECT record_field_value_id,value_text,value_boolean,value_date,value_reference_id,value_entity_id,value_state FROM record_field_values WHERE form_record_id=? AND form_field_id=? AND item_ordinal=1').get(recordId,definition.form_field_id);
      const booleanValue = field.type === 'boolean' && state === 'known' ? (['1','true','yes','نعم'].includes(raw.toLowerCase()) ? 1 : 0) : null;
      const dateValue = field.type === 'date' && state === 'known' ? raw : null;
      const textValue = state === 'known' && booleanValue === null && dateValue === null ? raw : null;
      if (existing && existing.value_text === textValue && existing.value_boolean === booleanValue && existing.value_date === dateValue && existing.value_reference_id === null && existing.value_entity_id === null && existing.value_state === state) continue;
      if (!existing && state === 'unknown') continue;
      let valueId;
      if (existing) {
        valueId = Number(existing.record_field_value_id);
        db.prepare('UPDATE record_field_values SET value_text=?,value_boolean=?,value_date=?,value_reference_id=NULL,value_entity_id=NULL,value_state=?,raw_value_text=?,normalized_value_text=?,updated_at=? WHERE record_field_value_id=?')
          .run(textValue,booleanValue,dateValue,state,raw,raw,now,valueId);
      } else {
        valueId = Number(db.prepare(`INSERT INTO record_field_values(form_record_id,form_field_id,item_ordinal,value_text,value_boolean,value_date,value_state,raw_value_text,normalized_value_text,created_at,updated_at)
          VALUES(?,?,1,?,?,?,?,?,?,?,?)`).run(recordId,definition.form_field_id,textValue,booleanValue,dateValue,state,raw,raw,now,now).lastInsertRowid);
      }
      db.prepare(`INSERT INTO value_provenance(record_field_value_id,source_id,provenance_type,original_value_text,normalized_value_text,source_locator,created_at)
        VALUES(?,?,'legacy_domain_sync',?,?,?,?)`).run(valueId,sourceId,raw,raw,locator,now);
      changed = true;
    }
  }
  if (isNew) {
    db.prepare('UPDATE form_records SET geo_unit_id=?,parent_record_id=?,record_label=?,updated_at=? WHERE form_record_id=?').run(geoUnitId,parentRecordId,label,now,recordId);
    completeMigrationSnapshot(db,recordId);
    return true;
  }
  if (!changed) return false;
  const revisionNumber = Number(before.record.revision_number) + 1;
  db.prepare('UPDATE form_records SET geo_unit_id=?,parent_record_id=?,record_label=?,revision_number=?,updated_at=? WHERE form_record_id=?')
    .run(geoUnitId,parentRecordId,label,revisionNumber,now,recordId);
  const after = snapshot();
  db.prepare(`INSERT INTO record_revisions(form_record_id,revision_number,action_type,before_snapshot_json,after_snapshot_json,change_reason,changed_by,source_id,created_at)
    VALUES(?,?,'legacy_domain_sync',?,?,'مزامنة تعديل النطاق من جدول التوافق.','legacy-sync',?,?)`)
    .run(recordId,revisionNumber,JSON.stringify(before),JSON.stringify(after),sourceId,now);
  db.prepare(`INSERT INTO audit_events(event_code,resource_type,resource_id,action_type,old_value_json,new_value_json,performed_by,performed_at,details)
    VALUES('legacy_domain_sync','form_record',?,'update',?,?,'legacy-sync',?,?)`)
    .run(String(recordId),JSON.stringify(before),JSON.stringify(after),now,`${sourceTable}:${sourceIdValue}`);
  return true;
}

function syncLegacyDirectorateRecord(db, directorateId, now = new Date().toISOString()) {
  const legacyId = Number(directorateId);
  const row = db.prepare('SELECT * FROM directorates WHERE id=?').get(legacyId);
  if (!row) return null;
  let recordIds = db.prepare("SELECT link.form_record_id FROM form_record_legacy_links link JOIN form_records record USING(form_record_id) WHERE link.legacy_entity_type='directorate' AND link.legacy_entity_id=? AND record.record_status IN ('approved','archived') ORDER BY link.form_record_id").all(legacyId).map(item => Number(item.form_record_id));
  if (!recordIds.length) {
    const logged = db.prepare("SELECT target_id FROM application_migration_log WHERE migration_code='legacy-directorate-v1' AND source_table='directorates' AND source_id=? AND status='migrated'").get(String(legacyId));
    if (logged) recordIds = [Number(logged.target_id)];
  }
  if (!recordIds.length) {
    backfillLegacy(db,now,legacyId);
    recordIds = db.prepare("SELECT form_record_id FROM form_record_legacy_links WHERE legacy_entity_type='directorate' AND legacy_entity_id=? ORDER BY form_record_id").all(legacyId).map(item => Number(item.form_record_id));
  }
  if (!recordIds.length) return null;
  const fieldRows = [...INPUT_FIELDS,DECISION_FIELD].map(field => ({
    field,
    definition: db.prepare("SELECT ff.form_field_id,ff.field_definition_id,ff.storage_class,ff.unit_id FROM form_fields ff JOIN form_versions fv USING(form_version_id) JOIN form_definitions fd USING(form_id) WHERE fd.form_code='legacy_directorate_v1' AND ff.field_code=? ORDER BY fv.version_number DESC LIMIT 1").get(`directorate.${field.key}`),
  }));
  const sources = new Map(db.prepare('SELECT field_key,value_text,source_file,source_location FROM directorate_sources WHERE directorate_id=?').all(legacyId).map(item => [item.field_key,item]));
  const defaultSource = sourceForLegacy(db,row.source_file,now);
  let geoUnitId = null;
  const geoType = db.prepare("SELECT geo_unit_type_id FROM geo_unit_types WHERE type_code='directorate'").get()?.geo_unit_type_id;
  const governorateType = db.prepare("SELECT geo_unit_type_id FROM geo_unit_types WHERE type_code='governorate'").get()?.geo_unit_type_id;
  const parent = row.governorate ? db.prepare('SELECT geo_unit_id FROM geographic_units WHERE geo_unit_type_id=? AND normalized_name=? AND parent_geo_unit_id IS NULL LIMIT 1').get(governorateType,normalize(row.governorate)) : null;
  if (row.district && geoType) geoUnitId = db.prepare('SELECT geo_unit_id FROM geographic_units WHERE geo_unit_type_id=? AND IFNULL(parent_geo_unit_id,0)=IFNULL(?,0) AND normalized_name=? LIMIT 1').get(geoType,parent?.geo_unit_id ?? null,normalize(row.district))?.geo_unit_id ?? null;
  const readSnapshot = recordId => ({
    record: db.prepare('SELECT form_record_id,record_code,record_label,record_status,revision_number,geo_unit_id,created_at,updated_at FROM form_records WHERE form_record_id=?').get(recordId),
    values: db.prepare(`SELECT ff.field_code,v.item_ordinal,v.value_text,v.value_boolean,v.value_date,v.value_reference_id,v.value_entity_id,v.value_state
      FROM record_field_values v JOIN form_fields ff USING(form_field_id) WHERE v.form_record_id=?
      UNION ALL SELECT ff.field_code,1,o.value_integer,o.value_real,o.value_text,NULL,NULL,o.value_state FROM observations o JOIN form_fields ff USING(form_field_id) WHERE o.form_record_id=?`).all(recordId,recordId),
  });
  const changes = [];
  for (const recordId of recordIds) {
    const before = readSnapshot(recordId);
    let changed = false;
    for (const {field,definition} of fieldRows) {
      if (!definition) continue;
      const column = ({districtName:'district',lostOpportunityType:'lost_opportunity'})[field.key] ?? field.key.replace(/[A-Z]/g,char => `_${char.toLowerCase()}`);
      const value = field.key === 'districtName' ? row.district : field.key === 'governorate' ? row.governorate : row[column];
      const source = sources.get(field.key);
      const raw = value == null ? null : String(value);
      const sourceId = sourceForLegacy(db,source?.source_file,now) ?? defaultSource;
      const locator = source?.source_location ?? (row.source_sheet && row.source_row ? `${row.source_sheet}!row-${row.source_row}:${field.key}` : null);
      if (definition.storage_class === 'measurement') {
        const number = value == null || value === '' ? null : Number(value);
        if (number !== null && !Number.isFinite(number)) continue;
        const state = number === null ? 'unknown' : 'known';
        const existing = db.prepare('SELECT observation_id,value_integer,value_real,value_state,source_id FROM observations WHERE form_record_id=? AND form_field_id=? ORDER BY observation_id DESC LIMIT 1').get(recordId,definition.form_field_id);
        const integerValue = number !== null && Number.isInteger(number) ? number : null;
        const realValue = number !== null && !Number.isInteger(number) ? number : null;
        const differs = !existing || existing.value_integer !== integerValue || existing.value_real !== realValue || existing.value_state !== state || existing.source_id !== sourceId;
        if (!differs) continue;
        let targetId;
        if (existing) {
          targetId = Number(existing.observation_id);
          db.prepare('UPDATE observations SET geo_unit_id=?,unit_id=?,value_integer=?,value_real=?,value_text=NULL,value_state=?,source_id=?,updated_at=? WHERE observation_id=?')
            .run(geoUnitId,definition.unit_id,integerValue,realValue,state,sourceId,now,targetId);
        } else {
          targetId = Number(db.prepare(`INSERT INTO observations(form_record_id,form_field_id,field_definition_id,geo_unit_id,unit_id,value_integer,value_real,value_state,observation_role,quality_status,source_id,created_by,created_at,updated_at)
            VALUES(?,?,?,?,?,?,?,?,'observed','unverified',?,'legacy-sync',?,?)`).run(recordId,definition.form_field_id,definition.field_definition_id,geoUnitId,definition.unit_id,integerValue,realValue,state,sourceId,now,now).lastInsertRowid);
        }
        db.prepare(`INSERT INTO value_provenance(observation_id,source_id,provenance_type,original_value_text,normalized_value_text,source_locator,created_at)
          VALUES(?,?,'legacy_sync',?,?,?,?)`).run(targetId,sourceId,raw,number === null ? null : String(number),locator,now);
      } else {
        const existing = db.prepare('SELECT record_field_value_id,value_text,value_boolean,value_date,value_state FROM record_field_values WHERE form_record_id=? AND form_field_id=? AND item_ordinal=1').get(recordId,definition.form_field_id);
        const boolValue = field.type === 'boolean' && value != null && value !== '' ? (Number(value) ? 1 : 0) : null;
        const textValue = value == null || value === '' || boolValue !== null ? null : String(value);
        const dateValue = field.type === 'date' && value != null ? String(value) : null;
        const state = value == null || value === '' ? 'unknown' : 'known';
        if (existing && existing.value_text === textValue && existing.value_boolean === boolValue && existing.value_date === dateValue && existing.value_state === state) continue;
        let targetId;
        if (existing) {
          targetId = Number(existing.record_field_value_id);
          db.prepare('UPDATE record_field_values SET value_text=?,value_boolean=?,value_date=?,value_reference_id=NULL,value_entity_id=NULL,value_state=?,raw_value_text=?,normalized_value_text=?,updated_at=? WHERE record_field_value_id=?')
            .run(textValue,boolValue,dateValue,state,raw,raw,now,targetId);
        } else {
          targetId = Number(db.prepare(`INSERT INTO record_field_values(form_record_id,form_field_id,item_ordinal,value_text,value_boolean,value_date,value_state,raw_value_text,normalized_value_text,created_at,updated_at)
            VALUES(?,?,1,?,?,?,?,?,?,?,?)`).run(recordId,definition.form_field_id,textValue,boolValue,dateValue,state,raw,raw,now,now).lastInsertRowid);
        }
        db.prepare(`INSERT INTO value_provenance(record_field_value_id,source_id,provenance_type,original_value_text,normalized_value_text,source_locator,created_at)
          VALUES(?,?,'legacy_sync',?,?,?,?)`).run(targetId,sourceId,raw,raw,locator,now);
      }
      changed = true;
    }
    if (!before.record) continue;
    if (before.record.geo_unit_id !== geoUnitId || before.record.record_label !== row.district || before.record.record_status !== 'approved') changed = true;
    if (!changed) continue;
    const nextRevision = Number(before.record.revision_number) + 1;
    db.prepare("UPDATE form_records SET geo_unit_id=?,record_label=?,record_status='approved',revision_number=?,updated_at=? WHERE form_record_id=?")
      .run(geoUnitId,row.district,nextRevision,now,recordId);
    const after = readSnapshot(recordId);
    db.prepare(`INSERT INTO record_revisions(form_record_id,revision_number,action_type,before_snapshot_json,after_snapshot_json,change_reason,changed_by,created_at)
      VALUES(?,?,'legacy_compatibility_sync',?,?,?,'legacy-sync',?)`).run(recordId,nextRevision,JSON.stringify(before),JSON.stringify(after),'تحديث المعياري من عملية توافق قديمة.',now);
    db.prepare(`INSERT INTO audit_events(event_code,resource_type,resource_id,action_type,old_value_json,new_value_json,performed_by,performed_at,details)
      VALUES('legacy_compatibility_sync','form_record',?,'update',?,?,'legacy-sync',?,?)`)
      .run(String(recordId),JSON.stringify(before),JSON.stringify(after),now,`legacy_directorate_id=${legacyId}`);
    changes.push(recordId);
  }
  if (!db.prepare("SELECT 1 FROM form_record_legacy_links WHERE form_record_id=? AND legacy_entity_type='directorate'").get(recordIds[0])) {
    db.prepare("INSERT OR IGNORE INTO form_record_legacy_links(form_record_id,legacy_entity_type,legacy_entity_id,linked_at) VALUES(?,'directorate',?,?)").run(recordIds[0],legacyId,now);
  }
  return { legacyId,recordIds,updatedRecordIds:changes };
}

function createMigratedRecord(db, { formVersionId, recordCode, label, geoUnitId, status, sourceId, sourceTable, sourceIdValue, details, now }) {
  const existing = db.prepare('SELECT form_record_id FROM form_records WHERE record_code=?').get(recordCode);
  if (existing) return Number(existing.form_record_id);
  const created = db.prepare(`INSERT INTO form_records(form_version_id,geo_unit_id,record_code,record_key,record_label,record_status,revision_number,notes,created_by,approved_by,created_at,updated_at,approved_at)
    VALUES(?,?,?,?,?,'approved',1,?,'legacy-migration','legacy-migration',?,?,?)`).run(formVersionId,geoUnitId,recordCode,recordCode,label,`${details}; source_id=${sourceId ?? ''}`,now,now,now);
  const recordId = Number(created.lastInsertRowid);
  db.prepare(`INSERT INTO record_revisions(form_record_id,revision_number,action_type,after_snapshot_json,change_reason,changed_by,source_id,created_at)
    VALUES(?,1,'legacy_domain_migration',?,'لا تتوفر حالة مراجعة تاريخية مستقلة في مصدر النطاق.','legacy-migration',?,?)`).run(recordId,JSON.stringify({ sourceTable,sourceId:sourceIdValue,status,sourceId }),sourceId,now);
  db.prepare(`INSERT OR IGNORE INTO application_migration_log(migration_code,source_table,source_id,target_table,target_id,status,details,created_at)
    VALUES('domain-records-v1',?,?,'form_records',?,'migrated',?,?)`).run(sourceTable,String(sourceIdValue),String(recordId),`${details}; source_id=${sourceId ?? ''}; source_status=${status ?? ''}`,now);
  return recordId;
}

function migrateDomainHistory(db, recordId, versions, fallbackSourceId, sourceType, sourceDescription) {
  let revisionNumber = 1;
  const appendRevision = db.prepare(`INSERT INTO record_revisions(form_record_id,revision_number,action_type,after_snapshot_json,change_reason,changed_by,source_id,created_at)
    VALUES(?,?,?,?,?,'legacy-migration',?,?)`);
  for (const version of versions) {
    revisionNumber += 1;
    const sourceId = version.source_id == null ? fallbackSourceId : sourceForDomainRecord(db,version.source_id,sourceType,sourceDescription,version.created_at);
    appendRevision.run(recordId,revisionNumber,`legacy_${version.action}`,version.payload_json,
      'سجل تاريخي من سجل إصدارات النطاق؛ لم يُنشئ حالة مراجعة لم تكن موجودة بالمصدر.',sourceId,version.created_at);
  }
  db.prepare('UPDATE form_records SET revision_number=? WHERE form_record_id=?').run(revisionNumber,recordId);
}

function backfillDomainRecords(db, now, filters = {}) {
  const projectFields = [
    { code:'projectCode',label:'رمز المشروع',type:'text' },{ code:'projectName',label:'اسم المشروع',type:'text' },
    { code:'description',label:'وصف المشروع',type:'long_text' },{ code:'projectStatus',label:'حالة المشروع',type:'text' },
    { code:'estimatedCost',label:'التكلفة التقديرية',type:'decimal' },{ code:'actualCost',label:'التكلفة الفعلية',type:'decimal' },
    { code:'currencyCode',label:'رمز العملة',type:'text' },{ code:'startDate',label:'تاريخ البداية',type:'date' },
    { code:'endDate',label:'تاريخ النهاية',type:'date' },{ code:'sectorCode',label:'رمز القطاع',type:'text' },
  ];
  const fundingFields = [
    { code:'partnerName',label:'جهة التمويل',type:'text' },{ code:'amount',label:'مبلغ التمويل',type:'decimal' },
    { code:'currencyCode',label:'رمز العملة',type:'text' },{ code:'fundingDate',label:'تاريخ التمويل',type:'date' },
  ];
  const indicatorFields = [
    { code:'indicatorCode',label:'رمز المؤشر',type:'text' },{ code:'indicatorLabel',label:'اسم المؤشر',type:'text' },
    { code:'periodKey',label:'الفترة',type:'text' },{ code:'valueNumber',label:'القيمة الرقمية',type:'decimal' },
    { code:'valueText',label:'القيمة النصية',type:'text' },{ code:'valueState',label:'حالة القيمة',type:'text' },
  ];
  const projectVersion = ensureDomainForm(db,now,'project_v1','سجل المشروع',projectFields);
  const fundingVersion = ensureDomainForm(db,now,'project_funding_v1','مصدر تمويل المشروع',fundingFields);
  const indicatorVersion = ensureDomainForm(db,now,'indicator_observation_v1','ملاحظة مؤشر',indicatorFields);
  if (tableExists(db,'projects')) {
    const projectIds = filters.projectIds;
    const projects = projectIds === undefined
      ? db.prepare('SELECT * FROM projects ORDER BY id').all()
      : Array.isArray(projectIds) && projectIds.length
        ? db.prepare(`SELECT * FROM projects WHERE id IN (${projectIds.map(() => '?').join(',')}) ORDER BY id`).all(...projectIds)
        : [];
    for (const project of projects) {
      const log = db.prepare("SELECT target_id FROM application_migration_log WHERE migration_code='domain-records-v1' AND source_table='projects' AND source_id=? AND status='migrated'").get(String(project.id));
      const isNew = !log;
      const geoUnitId = project.geographic_unit_id == null ? null : syncCanonicalGeographicUnit(db,project.geographic_unit_id,project.updated_at ?? now);
      const sectorCode = project.sector_id == null ? null : db.prepare('SELECT code FROM sectors WHERE id=?').get(project.sector_id)?.code ?? null;
      const sourceId = sourceForDomainRecord(db,project.source_id,'legacy-project','مصدر مستنتج من سجل مشروع قائم.',project.created_at ?? now);
      const recordId = isNew ? createMigratedRecord(db,{ formVersionId:projectVersion,recordCode:`legacy-project:${project.id}`,label:project.name,geoUnitId,
        status:project.status,sourceId,sourceTable:'projects',sourceIdValue:project.id,
        details:`legacy_project_id=${project.id}; geographic_unit_id=${project.geographic_unit_id ?? ''}; sector_id=${project.sector_id ?? ''}; لم يتوفر مسار مراجعة تاريخي.`,now:project.created_at ?? now }) : Number(log.target_id);
      db.prepare("INSERT OR IGNORE INTO form_record_legacy_links(form_record_id,legacy_entity_type,legacy_entity_id,linked_at) VALUES(?,'project',?,?)").run(recordId,project.id,now);
      const values = { projectCode:project.code,projectName:project.name,description:project.description,projectStatus:project.status,
        estimatedCost:project.estimated_cost,actualCost:project.actual_cost,currencyCode:project.currency_code,startDate:project.start_date,
        endDate:project.end_date,sectorCode };
      syncDomainRecordValues(db,{ recordId,formVersionId:projectVersion,fields:projectFields,values,sourceId,sourceTable:'projects',sourceIdValue:project.id,
        geoUnitId,label:project.name,now:project.updated_at ?? now,isNew });
      if (isNew) migrateDomainHistory(db,recordId,db.prepare('SELECT action,payload_json,source_id,created_at FROM project_versions WHERE project_id=? ORDER BY id').all(project.id),
        sourceId,'legacy-project-version','مصدر إصدار تاريخي لمشروع قائم.',now);
      for (const funding of db.prepare('SELECT * FROM project_funding WHERE project_id=? ORDER BY id').all(project.id)) {
        const fundingLog = db.prepare("SELECT target_id FROM application_migration_log WHERE migration_code='domain-records-v1' AND source_table='project_funding' AND source_id=? AND status='migrated'").get(String(funding.id));
        const isFundingNew = !fundingLog;
        const fundingSourceId = sourceForDomainRecord(db,funding.source_id,'legacy-project-funding','مصدر مستنتج من سجل تمويل قائم.',funding.created_at ?? now);
        const fundingRecordId = isFundingNew ? createMigratedRecord(db,{ formVersionId:fundingVersion,recordCode:`legacy-project-funding:${funding.id}`,label:funding.partner_name,
          geoUnitId, status:project.status,sourceId:fundingSourceId,sourceTable:'project_funding',sourceIdValue:funding.id,
          details:`legacy_project_id=${project.id}; legacy_funding_id=${funding.id}; لا تتوفر حالة مراجعة تاريخية مستقلة.`,now:funding.created_at ?? now }) : Number(fundingLog.target_id);
        db.prepare('UPDATE form_records SET parent_record_id=? WHERE form_record_id=?').run(recordId,fundingRecordId);
        db.prepare("INSERT OR IGNORE INTO form_record_legacy_links(form_record_id,legacy_entity_type,legacy_entity_id,linked_at) VALUES(?,'project_funding',?,?)").run(fundingRecordId,funding.id,now);
        const values = { partnerName:funding.partner_name,amount:funding.amount,currencyCode:funding.currency_code,fundingDate:funding.funding_date };
        syncDomainRecordValues(db,{ recordId:fundingRecordId,formVersionId:fundingVersion,fields:fundingFields,values,sourceId:fundingSourceId,sourceTable:'project_funding',sourceIdValue:funding.id,
          geoUnitId,parentRecordId:recordId,label:funding.partner_name,now:funding.created_at ?? now,isNew:isFundingNew });
      }
    }
  }
  if (tableExists(db,'indicator_observations')) {
    const observationIds = filters.indicatorObservationIds;
    const observations = observationIds === undefined
      ? db.prepare('SELECT * FROM indicator_observations ORDER BY id').all()
      : Array.isArray(observationIds) && observationIds.length
        ? db.prepare(`SELECT * FROM indicator_observations WHERE id IN (${observationIds.map(() => '?').join(',')}) ORDER BY id`).all(...observationIds)
        : [];
    for (const observation of observations) {
      const log = db.prepare("SELECT target_id FROM application_migration_log WHERE migration_code='domain-records-v1' AND source_table='indicator_observations' AND source_id=? AND status='migrated'").get(String(observation.id));
      const isNew = !log;
      const indicator = db.prepare('SELECT code,label_ar FROM indicator_definitions WHERE id=?').get(observation.indicator_id);
      const geoUnitId = syncCanonicalGeographicUnit(db,observation.geographic_unit_id,observation.updated_at ?? now);
      if (!indicator || !geoUnitId) throw new Error(`قياس المؤشر ${observation.id} يفتقد تعريف المؤشر أو مرجع المديرية.`);
      const sourceId = sourceForDomainRecord(db,observation.source_id,'legacy-indicator-observation','مصدر مستنتج من قياس مؤشر قائم.',observation.created_at ?? now);
      const recordId = isNew ? createMigratedRecord(db,{ formVersionId:indicatorVersion,recordCode:`legacy-indicator-observation:${observation.id}`,
        label:`${indicator.label_ar} — ${observation.period_key}`,geoUnitId,status:observation.value_state,sourceId,
        sourceTable:'indicator_observations',sourceIdValue:observation.id,
        details:`legacy_observation_id=${observation.id}; indicator_id=${observation.indicator_id}; period_key=${observation.period_key}; لا تتوفر حالة مراجعة تاريخية مستقلة.`,now:observation.created_at ?? now }) : Number(log.target_id);
      db.prepare("INSERT OR IGNORE INTO form_record_legacy_links(form_record_id,legacy_entity_type,legacy_entity_id,linked_at) VALUES(?,'indicator_observation',?,?)").run(recordId,observation.id,now);
      const values = { indicatorCode:indicator.code,indicatorLabel:indicator.label_ar,periodKey:observation.period_key,
        valueNumber:observation.value_number,valueText:observation.value_text,valueState:observation.value_state };
      syncDomainRecordValues(db,{ recordId,formVersionId:indicatorVersion,fields:indicatorFields,values,sourceId,sourceTable:'indicator_observations',sourceIdValue:observation.id,
        sourceLocation:observation.source_location,geoUnitId,label:`${indicator.label_ar} — ${observation.period_key}`,now:observation.updated_at ?? now,isNew });
      if (isNew) migrateDomainHistory(db,recordId,db.prepare('SELECT action,payload_json,source_id,created_at FROM indicator_observation_versions WHERE observation_id=? ORDER BY id').all(observation.id),
        sourceId,'legacy-indicator-version','مصدر إصدار تاريخي لقياس مؤشر قائم.',now);
    }
  }
}

function syncDomainRecords(db, filters = {}) {
  const normalizeIds = value => {
    if (!Array.isArray(value)) return undefined;
    const ids = [...new Set(value.map(Number).filter(id => Number.isSafeInteger(id) && id > 0))].slice(0,500);
    return ids;
  };
  const selected = {};
  if (Object.hasOwn(filters,'projectIds')) selected.projectIds = normalizeIds(filters.projectIds) ?? [];
  if (Object.hasOwn(filters,'indicatorObservationIds')) selected.indicatorObservationIds = normalizeIds(filters.indicatorObservationIds) ?? [];
  const now = new Date().toISOString();
  return db.transaction(() => {
    backfillDomainRecords(db,now,selected);
    return { syncedProjects:selected.projectIds?.length ?? 0,syncedIndicatorObservations:selected.indicatorObservationIds?.length ?? 0 };
  })();
}

function columnIndexOf(letters) {
  let value = 0;
  for (const letter of String(letters)) value = value * 26 + letter.charCodeAt(0)-64;
  return value;
}
function sourceForLegacy(db, file, now) {
  if (!file) {
    const title = 'سجل سابق بلا ملف مصدر';
    const source = db.prepare("SELECT source_id,id FROM data_sources WHERE source_type='legacy_compatibility' AND document_title=? ORDER BY id DESC LIMIT 1").get(title);
    if (source) {
      if (source.source_id == null) db.prepare('UPDATE data_sources SET source_id=id WHERE id=?').run(source.id);
      return Number(source.source_id ?? source.id);
    }
    return sourceForDomainRecord(db,null,'legacy_compatibility',title,now);
  }
  let source = db.prepare('SELECT source_id,id FROM data_sources WHERE file_name=? ORDER BY id DESC LIMIT 1').get(file);
  if (source) {
    if (source.source_id == null) db.prepare('UPDATE data_sources SET source_id=id WHERE id=?').run(source.id);
    return Number(source.source_id ?? source.id);
  }
  if (!source) {
    const insert = db.prepare("INSERT INTO data_sources(source_type,file_name,document_title,received_at,notes,source_id) VALUES('legacy_import',?,?,?,'مصدر مستنتج من سجل سابق؛ لا يتوفر الملف الخام هنا.',NULL)");
    const result = insert.run(file,file,now);
    const id = Number(result.lastInsertRowid);
    db.prepare('UPDATE data_sources SET source_id=id WHERE id=?').run(id);
    source = { source_id:id };
  }
  return source.source_id;
}
function backfillLegacy(db, now) {
  if (!tableExists(db,'directorates')) return;
  const formVersionId = db.prepare("SELECT fv.form_version_id FROM form_versions fv JOIN form_definitions f USING(form_id) WHERE f.form_code='legacy_directorate_v1' AND fv.version_number=1").get()?.form_version_id;
  if (!formVersionId) return;
  const insertGeo = db.prepare('INSERT OR IGNORE INTO geographic_units(parent_id,unit_type,official_code,name,normalized_name,created_at,updated_at,geo_unit_id,geo_unit_type_id,parent_geo_unit_id,name_ar,is_active) VALUES(?,?,?,?,?,?,?,?,?,?,?,1)');
  const getType = db.prepare('SELECT geo_unit_type_id FROM geo_unit_types WHERE type_code=?');
  const getGeo = db.prepare('SELECT geo_unit_id FROM geographic_units WHERE geo_unit_type_id=? AND IFNULL(parent_geo_unit_id,0)=IFNULL(?,0) AND normalized_name=? LIMIT 2');
  const insertRecord = db.prepare(`INSERT OR IGNORE INTO form_records(form_version_id,geo_unit_id,record_code,record_key,record_label,record_status,revision_number,created_by,created_at,updated_at)
    VALUES(?,?,?,?,?,'approved',1,'legacy-migration',?,?)`);
  const logMigration = db.prepare("INSERT OR IGNORE INTO application_migration_log(migration_code,source_table,source_id,target_table,target_id,status,details,created_at) VALUES('legacy-directorate-v1','directorates',?,'form_records',?,'migrated',?,?)");
  const fields = [...INPUT_FIELDS,DECISION_FIELD];
  const fieldLookup = db.prepare('SELECT ff.form_field_id,ff.field_definition_id,ff.storage_class,ff.unit_id FROM form_fields ff WHERE ff.form_version_id=? AND ff.field_code=?');
  const provenance = db.prepare(`INSERT INTO value_provenance(record_field_value_id,observation_id,source_id,provenance_type,original_value_text,normalized_value_text,source_locator,created_at)
    VALUES(?,?,?,?,?,?,?,?)`);
  for (const row of db.prepare('SELECT * FROM directorates ORDER BY id').all()) {
    const migration = db.prepare("SELECT target_id FROM application_migration_log WHERE migration_code='legacy-directorate-v1' AND source_table='directorates' AND source_id=? AND status='migrated'").get(String(row.id));
    if (migration) { syncLegacyDirectorateRecord(db,row.id,now); continue; }
    const governorate = String(row.governorate ?? '').trim();
    const district = String(row.district ?? '').trim();
    let parentId = null;
    let geoId = null;
    const govType = getType.get('governorate').geo_unit_type_id;
    const dirType = getType.get('directorate').geo_unit_type_id;
    if (governorate) {
      let matches = getGeo.all(govType,null,normalize(governorate));
      if (matches.length === 0) {
        const result = insertGeo.run(null,'governorate',null,governorate,normalize(governorate),row.updated_at ?? now,row.updated_at ?? now,null,govType,null,governorate);
        const id = Number(result.lastInsertRowid);
        db.prepare('UPDATE geographic_units SET geo_unit_id=id WHERE id=?').run(id);
        parentId = id;
      } else if (matches.length === 1) parentId = matches[0].geo_unit_id;
    }
    if (district && parentId !== null) {
      const matches = getGeo.all(dirType,parentId,normalize(district));
      if (matches.length === 1) geoId = matches[0].geo_unit_id;
      else if (!matches.length) {
        const result = insertGeo.run(parentId,'directorate',null,district,normalize(district),row.updated_at ?? now,row.updated_at ?? now,null,dirType,parentId,district);
        geoId = Number(result.lastInsertRowid);
        db.prepare('UPDATE geographic_units SET geo_unit_id=id WHERE id=?').run(geoId);
      }
    }
    const recordResult = insertRecord.run(formVersionId,geoId,`legacy-directorate:${row.id}`,`legacy-directorate:${row.id}`,district,row.updated_at ?? now,row.updated_at ?? now);
    const recordId = Number(recordResult.lastInsertRowid || db.prepare('SELECT form_record_id FROM form_records WHERE record_code=?').get(`legacy-directorate:${row.id}`).form_record_id);
    logMigration.run(String(row.id),String(recordId),geoId === null ? 'القيم محفوظة؛ الربط الجغرافي غير محسوم من الاسم وحده.' : `geo_unit_id=${geoId}`,now);
    db.prepare("INSERT OR IGNORE INTO form_record_legacy_links(form_record_id,legacy_entity_type,legacy_entity_id,linked_at) VALUES(?,'directorate',?,?)").run(recordId,row.id,now);
    const sourceFields = db.prepare('SELECT field_key,value_text,source_file,source_location FROM directorate_sources WHERE directorate_id=?').all(row.id);
    const sourceByField = new Map(sourceFields.map(item => [item.field_key,item]));
    const defaultSourceId = sourceForLegacy(db,row.source_file,now);
    for (const field of fields) {
      const column = ({districtName:'district',lostOpportunityType:'lost_opportunity'})[field.key] ?? field.key.replace(/[A-Z]/g,char => `_${char.toLowerCase()}`);
      const value = field.key === 'districtName' ? row.district : field.key === 'governorate' ? row.governorate : row[column];
      if (value === null || value === undefined || value === '') continue;
      const definition = fieldLookup.get(formVersionId,`directorate.${field.key}`);
      if (!definition) continue;
      const source = sourceByField.get(field.key);
      const sourceId = sourceForLegacy(db,source?.source_file,now) ?? defaultSourceId;
      const typedValue = field.type === 'boolean' ? (Number(value) ? 1 : 0) : value;
      let targetId;
      if (definition.storage_class === 'measurement') {
        const number = Number(typedValue);
        if (!Number.isFinite(number)) continue;
        const isInteger = Number.isInteger(number);
        const result = db.prepare(`INSERT INTO observations(form_record_id,form_field_id,field_definition_id,geo_unit_id,unit_id,value_integer,value_real,value_state,observation_role,quality_status,source_id,created_by,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,'known','observed','unverified',?,'legacy-migration',?,?)`).run(recordId,definition.form_field_id,definition.field_definition_id,geoId,definition.unit_id,isInteger?number:null,isInteger?null:number,sourceId,row.updated_at ?? now,row.updated_at ?? now);
        targetId = Number(result.lastInsertRowid);
        if (sourceId) provenance.run(null,targetId,sourceId,'legacy_migration',source?.value_text ?? String(value),String(number),source?.source_location ?? null,now);
      } else {
        const isBoolean = field.type === 'boolean';
        const result = db.prepare(`INSERT INTO record_field_values(form_record_id,form_field_id,value_text,value_boolean,value_state,raw_value_text,normalized_value_text,created_at,updated_at)
          VALUES(?,?,?,?, 'known',?,?,?,?)`).run(recordId,definition.form_field_id,isBoolean?null:String(value),isBoolean?typedValue:null,source?.value_text ?? String(value),isBoolean?String(typedValue):String(value),row.updated_at ?? now,row.updated_at ?? now);
        targetId = Number(result.lastInsertRowid);
        if (sourceId) provenance.run(targetId,null,sourceId,'legacy_migration',source?.value_text ?? String(value),isBoolean?String(typedValue):String(value),source?.source_location ?? null,now);
      }
    }
    db.prepare(`INSERT INTO record_revisions(form_record_id,revision_number,action_type,after_snapshot_json,change_reason,changed_by,created_at)
      VALUES(?,1,'legacy_migration',?,'ترحيل إضافي من سجل المديريات القديم.','system',?)`).run(recordId,JSON.stringify({id:row.id,district:row.district,governorate:row.governorate}),now);
  }
}
function recordImportMappingDecisions(db,workbookBatchId,legacyRegionId,targetEntityType,columnMap,actor,now = new Date().toISOString()) {
  const batchId = Number(workbookBatchId), regionId = Number(legacyRegionId);
  if (!Number.isSafeInteger(batchId) || batchId <= 0 || !Number.isSafeInteger(regionId) || regionId <= 0) throw new Error('معرّف دفعة أو منطقة الاستيراد غير صالح.');
  if (!['project','indicator_observation'].includes(targetEntityType)) throw new Error('نوع الكيان المستهدف غير مدعوم لتثبيت المطابقة.');
  if (!columnMap || typeof columnMap !== 'object' || Array.isArray(columnMap) || !Object.keys(columnMap).length || Object.keys(columnMap).length > 40) throw new Error('خريطة المطابقة المعتمدة فارغة أو غير صالحة.');
  const decidedBy = typeof actor === 'string' ? actor.slice(0,120) : null;
  let normalizedBatch = db.prepare('SELECT batch_id FROM import_batches WHERE idempotency_key=?').get(`workbook-import:${batchId}`);
  if (!normalizedBatch) {
    mirrorWorkbookImport(db,batchId);
    normalizedBatch = db.prepare('SELECT batch_id FROM import_batches WHERE idempotency_key=?').get(`workbook-import:${batchId}`);
  }
  let mappingRegion = db.prepare(`SELECT region.import_region_id FROM import_regions region
    JOIN import_sheets sheet USING(import_sheet_id) WHERE sheet.batch_id=? AND region.region_code=?`).get(normalizedBatch?.batch_id,`legacy-region-${regionId}`);
  if (!mappingRegion) {
    const legacy = db.prepare('SELECT region.region_index,sheet.sheet_index FROM workbook_import_regions region JOIN workbook_import_sheets sheet ON sheet.id=region.sheet_id WHERE region.id=? AND region.batch_id=?').get(regionId,batchId);
    if (legacy) mappingRegion = db.prepare(`SELECT region.import_region_id FROM import_regions region JOIN import_sheets sheet USING(import_sheet_id)
      WHERE sheet.batch_id=? AND region.region_code=?`).get(normalizedBatch?.batch_id,`sheet-${legacy.sheet_index}-region-${legacy.region_index}`);
  }
  if (!mappingRegion) throw new Error('تعذر العثور على المنطقة المعيارية المرتبطة بقرار المطابقة.');
  const entries = Object.entries(columnMap).map(([fieldCode,sourceColumn]) => {
    const column = Number(sourceColumn);
    if (fieldCode.length > 80 || !/^[a-z][a-z0-9_]*$/i.test(fieldCode) || !Number.isSafeInteger(column) || column < 1 || column > 400) throw new Error('حقل أو رقم عمود غير صالح في قرار المطابقة.');
    return { fieldCode, column };
  });
  if (new Set(entries.map(item => item.column)).size !== entries.length) throw new Error('لا يمكن اعتماد العمود نفسه لأكثر من حقل.');
  const selected = new Map(entries.map(item => [item.column,item.fieldCode]));
  const mappings = db.prepare('SELECT mapping_id,source_column_index FROM import_field_mappings WHERE import_region_id=?').all(mappingRegion.import_region_id);
  if (!mappings.length) throw new Error('لا توجد عناوين أعمدة محفوظة لاعتماد مطابقتها.');
  for (const { column } of entries) {
    if (!mappings.some(mapping => Number(mapping.source_column_index) === column)) throw new Error(`العمود ${column} غير موجود في مطابقة المنطقة المعيارية.`);
  }
  const update = db.prepare(`UPDATE import_field_mappings SET form_field_id=NULL,target_entity_type=?,target_field_code=?,mapping_method=?,mapping_status=?,decided_by=?,decided_at=? WHERE mapping_id=?`);
  for (const mapping of mappings) {
    const fieldCode = selected.get(Number(mapping.source_column_index)) ?? null;
    update.run(targetEntityType,fieldCode,fieldCode?'user_confirmed':'user_unmapped',fieldCode?'approved':'unmatched',decidedBy,now,mapping.mapping_id);
  }
  db.prepare("UPDATE import_regions SET match_status='approved' WHERE import_region_id=?").run(mappingRegion.import_region_id);
  db.prepare(`INSERT INTO audit_events(event_code,resource_type,resource_id,action_type,new_value_json,performed_by,performed_at,details)
    VALUES('import_mapping_decided','import_region',?,'approve',?,?,?,?)`).run(String(mappingRegion.import_region_id),JSON.stringify({ targetEntityType,columnMap }),decidedBy,now,`legacy_batch=${batchId};legacy_region=${regionId}`);
  return { importRegionId:mappingRegion.import_region_id,decidedColumns:entries.length };
}
function syncWorkbookImportStatus(db, workbookBatchId) {
  const workbookBatch = db.prepare('SELECT status,result_json,updated_at FROM workbook_import_batches WHERE id=?').get(Number(workbookBatchId));
  if (!workbookBatch) throw new Error('دفعة الاستقبال المطلوبة غير موجودة.');
  const key = `workbook-import:${Number(workbookBatchId)}`;
  const batch = db.prepare('SELECT batch_id FROM import_batches WHERE idempotency_key=?').get(key);
  if (!batch) return null;
  const result = (() => { try { return JSON.parse(workbookBatch.result_json ?? '{}'); } catch { return {}; } })();
  const directorate = result.directorateImport ?? {};
  const projectPromotions = Array.isArray(result.projectPromotions) ? result.projectPromotions : [];
  const indicatorPromotions = Array.isArray(result.indicatorPromotions) ? result.indicatorPromotions : [];
  const acceptedRows = Number(directorate.applied ?? 0)
    + projectPromotions.reduce((count,item) => count + (Array.isArray(item.applied) ? item.applied.length : 0),0)
    + indicatorPromotions.reduce((count,item) => count + (Array.isArray(item.applied) ? item.applied.length : 0),0);
  const rejectedRows = Number(directorate.refused?.length ?? 0)
    + projectPromotions.reduce((count,item) => count + (Array.isArray(item.refused) ? item.refused.length : 0),0)
    + indicatorPromotions.reduce((count,item) => count + (Array.isArray(item.refused) ? item.refused.length : 0),0);
  const skippedRows = Number(directorate.skipped ?? 0)
    + projectPromotions.reduce((count,item) => count + Number(item.skipped ?? 0),0)
    + indicatorPromotions.reduce((count,item) => count + Number(item.skipped ?? 0),0);
  const partial = rejectedRows > 0 || /partially/i.test(workbookBatch.status ?? '')
    || projectPromotions.some(item => /partially/i.test(item.status ?? ''))
    || indicatorPromotions.some(item => /partially/i.test(item.status ?? ''));
  const completed = acceptedRows > 0 && !/review-required/i.test(workbookBatch.status ?? '')
    && /applied|promoted/i.test(workbookBatch.status ?? '');
  const now = workbookBatch.updated_at ?? new Date().toISOString();
  if (Number(directorate.applied ?? 0) > 0) {
    const regions = db.prepare("SELECT region.import_region_id FROM import_regions region JOIN import_sheets sheet USING(import_sheet_id) WHERE sheet.batch_id=? AND region.form_version_id IS NOT NULL AND region.match_status='suggested'").all(batch.batch_id);
    const approveMappings = db.prepare(`UPDATE import_field_mappings SET mapping_status='approved',mapping_method='accepted_import_plan',
      decided_by=coalesce(decided_by,'local-user'),decided_at=? WHERE import_region_id=? AND form_field_id IS NOT NULL AND mapping_status='suggested'`);
    const approveRegion = db.prepare("UPDATE import_regions SET match_status='approved' WHERE import_region_id=? AND match_status='suggested'");
    for (const region of regions) {
      approveMappings.run(now,region.import_region_id);
      approveRegion.run(region.import_region_id);
    }
  }
  const status = completed ? (partial ? 'partially_approved' : 'approved') : 'ready_for_review';
  db.prepare(`UPDATE import_batches SET batch_status=?,accepted_rows=?,rejected_rows=?,blocked_rows=?,
    warning_rows=?,completed_at=CASE WHEN ? THEN coalesce(completed_at,?) ELSE completed_at END,
    metadata_json=json_set(coalesce(metadata_json,'{}'),'$.workbookStatus',?,'$.workbookResult',json(?)) WHERE batch_id=?`)
    .run(status,acceptedRows,rejectedRows,rejectedRows,skippedRows,completed ? 1 : 0,now,workbookBatch.status,JSON.stringify(result),batch.batch_id);
  return { batchId:batch.batch_id,status,acceptedRows,rejectedRows };
}
function mirrorWorkbookImport(db, workbookBatchId) {
  const id = Number(workbookBatchId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('معرّف دفعة ملف العمل غير صالح.');
  const previous = db.prepare('SELECT batch_id FROM import_batches WHERE idempotency_key=?').get(`workbook-import:${id}`);
  if (previous) return syncWorkbookImportStatus(db,id);
  const sourceBatch = db.prepare('SELECT * FROM workbook_import_batches WHERE id=?').get(id);
  if (!sourceBatch) throw new Error('دفعة ملف العمل المطلوبة غير موجودة.');
  const now = sourceBatch.created_at ?? new Date().toISOString();
  const source = sourceBatch.source_id == null ? null : db.prepare('SELECT id,source_id FROM data_sources WHERE id=?').get(sourceBatch.source_id);
  if (!source) throw new Error('مصدر ملف العمل غير موجود في كتالوج المصادر.');
  const normalizedSourceId = Number(source.source_id ?? source.id);
  if (source.source_id == null) db.prepare('UPDATE data_sources SET source_id=id WHERE id=?').run(source.id);

  const mirror = db.transaction(() => {
    const existing = db.prepare('SELECT batch_id FROM import_batches WHERE idempotency_key=?').get(`workbook-import:${id}`);
    if (existing) return existing.batch_id;
    const sheets = db.prepare('SELECT * FROM workbook_import_sheets WHERE batch_id=? ORDER BY sheet_index').all(id);
    const regions = db.prepare('SELECT * FROM workbook_import_regions WHERE batch_id=? ORDER BY sheet_id,region_index').all(id);
    const rows = db.prepare('SELECT * FROM workbook_import_rows WHERE batch_id=? ORDER BY sheet_id,row_number').all(id);
    const sourceRowsByKey = new Map(rows.map(row => [`${row.sheet_id}:${row.row_number}`,row]));
    const sheetsById = new Map(sheets.map(sheet => [Number(sheet.id),sheet]));
    const totalRows = rows.length;
    const totalCells = rows.reduce((total,row) => total + Number(row.cell_count ?? 0),0);
    const batchColumns = columns(db,'import_batches');
    const batchIdExpression = batchColumns.has('id') ? 'coalesce(batch_id,id)' : 'batch_id';
    const batchId = Number(db.prepare(`SELECT coalesce(max(${batchIdExpression}),0)+1 AS next_id FROM import_batches`).get().next_id);
    const batchValues = new Map([
      ['id',batchId],['batch_id',batchId],['file_name',sourceBatch.file_name],
      ['file_type',sourceBatch.file_name.toLowerCase().endsWith('.xlsm') ? 'xlsm' : 'xlsx'],
      ['file_size',sourceBatch.file_size],['item_count',totalRows],['status','review'],['warnings_json','[]'],
      ['batch_uuid',crypto.randomUUID()],['source_id',normalizedSourceId],['batch_status','ready_for_review'],
      ['parser_version','exceljs-local-v1'],['created_by','local-user'],['created_at',now],['started_at',now],
      ['total_sheets',sheets.length],['total_regions',regions.length],['total_rows',totalRows],
      ['idempotency_key',`workbook-import:${id}`],
      ['metadata_json',JSON.stringify({ workbookBatchId:id,sha256:sourceBatch.sha256,cellCount:totalCells,mediaCount:sourceBatch.media_count,originalFileStored:true })],
    ]);
    const batchEntries = [...batchValues].filter(([column]) => batchColumns.has(column));
    const batchInsert = db.prepare(`INSERT INTO import_batches(${batchEntries.map(([column]) => column).join(',')}) VALUES(${batchEntries.map(() => '?').join(',')})`);
    batchInsert.run(...batchEntries.map(([,value]) => value));
    const sheetIds = new Map();
    const addSheet = db.prepare(`INSERT INTO import_sheets(batch_id,sheet_index,sheet_name,sheet_state,max_row,max_column,is_hidden,merged_ranges_json,header_rows_json,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`);
    for (const sheet of sheets) {
      const created = addSheet.run(batchId,sheet.sheet_index,sheet.name,sheet.state,sheet.max_row,sheet.max_column,
        sheet.state === 'visible' ? 0 : 1,sheet.merged_ranges_json,JSON.stringify([]),now);
      sheetIds.set(Number(sheet.id),Number(created.lastInsertRowid));
    }
    const directorateVersionId = db.prepare(`SELECT version.form_version_id FROM form_versions version
      JOIN form_definitions definition USING(form_id) WHERE definition.form_code='legacy_directorate_v1'
      AND version.version_number=1`).get()?.form_version_id ?? null;
    const regionIds = new Map();
    const addRegion = db.prepare(`INSERT INTO import_regions(import_sheet_id,region_code,start_row,start_column,end_row,end_column,
      header_start_row,header_end_row,form_version_id,match_status,match_confidence,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);
    const regionMeta = [];
    for (const region of regions) {
      const sheet = sheets.find(item => Number(item.id) === Number(region.sheet_id));
      if (!sheet) throw new Error('منطقة استقبال تشير إلى ورقة غير موجودة.');
      const mapping = (() => { try { return JSON.parse(region.mapping_json ?? '{}'); } catch { return {}; } })();
      const isDirectorate = region.candidate_type === 'directorate-candidate' && directorateVersionId !== null;
      const legacyRegionCode = `legacy-region-${region.id}`;
      const created = addRegion.run(sheetIds.get(Number(sheet.id)),legacyRegionCode,
        Math.max(1,Number(region.header_row)),1,Math.max(Number(region.header_row),Number(region.last_data_row)),Math.max(1,Number(sheet.max_column ?? 1)),
        region.header_row,region.header_row,isDirectorate ? directorateVersionId : null,
        isDirectorate ? 'suggested' : 'unmatched',Number(region.confidence ?? 0),now);
      const normalizedRegionId = Number(created.lastInsertRowid);
      regionIds.set(Number(region.id),normalizedRegionId);
      regionMeta.push({ source:region,normalizedId:normalizedRegionId,sheet,mapping });
    }
    const updateHeaders = db.prepare('UPDATE import_sheets SET header_rows_json=? WHERE import_sheet_id=?');
    for (const sheet of sheets) {
      const headerRows = [...new Set(regionMeta.filter(item => Number(item.source.sheet_id) === Number(sheet.id)).map(item => Number(item.source.header_row)))].sort((a,b) => a-b);
      updateHeaders.run(JSON.stringify(headerRows),sheetIds.get(Number(sheet.id)));
    }
    const rowAssignments = new Map();
    const bySheetRows = new Map();
    for (const row of rows) {
      const list = bySheetRows.get(Number(row.sheet_id)) ?? [];
      list.push(Number(row.row_number)); bySheetRows.set(Number(row.sheet_id),list);
    }
    const addRegionFallback = db.prepare(`INSERT INTO import_regions(import_sheet_id,region_code,start_row,start_column,end_row,end_column,
      form_version_id,match_status,match_confidence,created_at) VALUES(?,?,?,1,?,?,NULL,'unmatched',0,?)`);
    for (const sheet of sheets) {
      const sheetRegions = regionMeta.filter(item => Number(item.source.sheet_id) === Number(sheet.id));
      const occupied = new Set();
      for (const item of sheetRegions) {
        const start = Number(item.source.header_row);
        const end = Math.max(start,Number(item.source.last_data_row));
        for (let rowNumber=start;rowNumber<=end;rowNumber++) occupied.add(rowNumber);
      }
      const uncovered = (bySheetRows.get(Number(sheet.id)) ?? []).filter(rowNumber => !occupied.has(rowNumber));
      const runs = [];
      for (const rowNumber of uncovered) {
        const last = runs.at(-1);
        if (last && rowNumber === last.end + 1) last.end = rowNumber;
        else runs.push({ start:rowNumber,end:rowNumber });
      }
      for (const [index,run] of runs.entries()) {
        const created = addRegionFallback.run(sheetIds.get(Number(sheet.id)),`sheet-${sheet.sheet_index}-unclassified-${index+1}`,
          run.start,run.end,Math.max(1,Number(sheet.max_column ?? 1)),now);
        const normalizedId = Number(created.lastInsertRowid);
        for (let rowNumber=run.start;rowNumber<=run.end;rowNumber++) rowAssignments.set(`${sheet.id}:${rowNumber}`,normalizedId);
      }
      for (const item of sheetRegions) {
        const start = Number(item.source.header_row);
        const end = Math.max(start,Number(item.source.last_data_row));
        for (let rowNumber=start;rowNumber<=end;rowNumber++) rowAssignments.set(`${sheet.id}:${rowNumber}`,item.normalizedId);
      }
    }
    const addRow = db.prepare(`INSERT INTO import_rows(import_region_id,source_row_number,row_fingerprint,row_status,is_hidden,has_formula,is_truncated,created_at)
      VALUES(?,?,?,'unprocessed',?,?,?,?)`);
    const addCell = db.prepare(`INSERT INTO import_cells(import_row_id,column_index,column_letter,cell_address,source_header_text,raw_value_text,raw_value_type,
      formula_text,cached_value_text,number_format,is_merged,merged_range,is_hidden_column,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,0,NULL,0,?)`);
    const addMapping = db.prepare(`INSERT INTO import_field_mappings(import_region_id,source_column_index,source_header_text,normalized_source_header,
      form_field_id,mapping_method,confidence,mapping_status,decided_by,decided_at,created_at)
      VALUES(?,?,?,?,?,?,?,'suggested',NULL,NULL,?)`);
    const headerRows = new Map();
    for (const item of regionMeta) {
      const header = sourceRowsByKey.get(`${item.source.sheet_id}:${item.source.header_row}`);
      const headerCells = header ? (() => { try { return JSON.parse(header.cells_json); } catch { return []; } })() : [];
      const matchedByColumn = new Map((item.mapping.matched ?? []).map(entry => [Number(entry.column),entry]));
      const unmatchedByColumn = new Map((item.mapping.unmatched ?? []).map(entry => [Number(entry.column),entry]));
      const headers = new Map(headerCells.map(cell => [Number(cell.column),String(cell.text ?? '').trim()]));
      headerRows.set(item.normalizedId,headers);
      for (const [column,headerText] of headers) {
        if (!headerText) continue;
        const match = matchedByColumn.get(column);
        const field = match && item.source.candidate_type === 'directorate-candidate'
          ? db.prepare('SELECT form_field_id FROM form_fields WHERE form_version_id=? AND field_code=?').get(directorateVersionId,`directorate.${match.key}`)
          : null;
        addMapping.run(item.normalizedId,column,headerText,normalize(headerText),field?.form_field_id ?? null,
          match?.method ?? 'unmatched',match ? Number(match.score ?? 0) : Number(unmatchedByColumn.get(column)?.score ?? 0),now);
      }
    }
    for (const row of rows) {
      const regionId = rowAssignments.get(`${row.sheet_id}:${row.row_number}`);
      if (!regionId) throw new Error(`تعذر إسناد صف الاستقبال ${row.row_number} إلى منطقة مراجعة.`);
      const created = addRow.run(regionId,row.row_number,row.content_sha256,row.is_hidden,row.has_formula,
        Number(sheetsById.get(Number(row.sheet_id))?.truncated ?? 0),now);
      const importRowId = Number(created.lastInsertRowid);
      let cells = [];
      try { cells = JSON.parse(row.cells_json); } catch { throw new Error('بيانات خلايا الاستقبال غير صالحة للترحيل.'); }
      const headers = headerRows.get(regionId);
      for (const cell of cells) {
        const columnIndex = Number(cell.column);
        const rawValue = cell.rawValue;
        const valueText = cell.text == null ? null : String(cell.text);
        const rawType = rawValue === null ? 'null' : Array.isArray(rawValue) ? 'array' : typeof rawValue;
        const formula = cell.formula == null ? null : String(cell.formula);
        const cached = cell.cachedResult == null ? null : typeof cell.cachedResult === 'object' ? JSON.stringify(cell.cachedResult) : String(cell.cachedResult);
        const letter = String(cell.address ?? '').match(/^[A-Z]+/)?.[0] ?? null;
        const headerCell = headers?.get(columnIndex) ?? null;
        addCell.run(importRowId,columnIndex,letter,String(cell.address ?? ''),headerCell,valueText,rawType,formula,cached,null,now);
      }
    }
    db.prepare(`INSERT INTO audit_events(event_code,resource_type,resource_id,action_type,new_value_json,performed_by,performed_at,details)
      VALUES('workbook_import_mirrored','import_batch',?,'stage',?,'local-user',?,?)`)
      .run(String(batchId),JSON.stringify({ workbookBatchId:id,sheets:sheets.length,regions:regions.length,rows:totalRows,cells:totalCells }),now,`idempotency=workbook-import:${id}`);
    return batchId;
  });
  mirror();
  return syncWorkbookImportStatus(db,id);
}
function checksum() {
  return crypto.createHash('sha256').update(SCHEMA_SQL + JSON.stringify(TABLE_COLUMNS)).digest('hex');
}
function migrateV4(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY,migration_code TEXT NOT NULL UNIQUE,migration_name TEXT NOT NULL,checksum TEXT NOT NULL,applied_at TEXT NOT NULL,execution_ms INTEGER,success INTEGER NOT NULL CHECK(success IN (0,1)),details TEXT)`);
  const sourceChecksum = checksum();
  const existing = db.prepare('SELECT * FROM schema_migrations WHERE version=?').get(VERSION);
  if (existing?.success === 1) {
    if (existing.checksum !== sourceChecksum) throw new Error(`ترحيل ${CODE} عُدّل بعد تطبيقه. أنشئ إصدار ترحيل جديداً.`);
    db.transaction(() => {
      const now = new Date().toISOString();
      backfillLegacy(db,now);
      backfillDomainRecords(db,now);
    })();
    return { version:VERSION,alreadyApplied:true };
  }
  if (existing) db.prepare('DELETE FROM schema_migrations WHERE version=? AND success=0').run(VERSION);
  const start = Date.now();
  try {
    db.transaction(() => {
      addColumns(db);
      db.exec(SCHEMA_SQL);
      ensureCompatKeys(db);
      const now = new Date().toISOString();
      seedTypesAndUnits(db,now);
      seedForms(db,now);
      backfillLegacy(db,now);
      backfillDomainRecords(db,now);
      const foreignKeys = db.prepare('PRAGMA foreign_key_check').all();
      if (foreignKeys.length) throw new Error(`مخالفة مفتاح خارجي بعد الترحيل: ${JSON.stringify(foreignKeys.slice(0,8))}`);
      db.prepare('INSERT INTO schema_migrations(version,migration_code,migration_name,checksum,applied_at,execution_ms,success,details) VALUES(?,?,?,?,?,?,1,?)')
        .run(VERSION,CODE,'المعمارية المركزية للنماذج والسجلات والمصادر',sourceChecksum,now,Date.now()-start,'ترحيل إضافي؛ لم تحذف الجداول القديمة أو تعدل تعريفات المؤشرات.');
    })();
    return { version:VERSION,alreadyApplied:false };
  } catch (error) {
    db.prepare('INSERT OR REPLACE INTO schema_migrations(version,migration_code,migration_name,checksum,applied_at,execution_ms,success,details) VALUES(?,?,?,?,?,?,0,?)')
      .run(VERSION,CODE,'المعمارية المركزية للنماذج والسجلات والمصادر',sourceChecksum,new Date().toISOString(),Date.now()-start,String(error.message).slice(0,4000));
    throw error;
  }
}

function migrateV5(db) {
  const migrationVersion = 5;
  const migrationCode = '2026-11-11-remove-unresolved-placeholder-forms-v5';
  const cleanupPolicy = 'unresolved-only;retain-records-imports-profiles-sections-fields-rows;retain-referenced-sectors';
  const migrationChecksum = crypto.createHash('sha256').update(checksum() + migrationCode + cleanupPolicy).digest('hex');
  const existing = db.prepare('SELECT * FROM schema_migrations WHERE version=?').get(migrationVersion);
  if (existing?.success === 1) {
    if (existing.checksum !== migrationChecksum) throw new Error(`ترحيل ${migrationCode} عُدّل بعد تطبيقه. أنشئ إصدار ترحيل جديداً.`);
    return { version:migrationVersion,alreadyApplied:true };
  }
  if (existing) db.prepare('DELETE FROM schema_migrations WHERE version=? AND success=0').run(migrationVersion);
  const startedAt = Date.now();
  const now = new Date().toISOString();
  try {
    db.transaction(() => {
      const candidates = db.prepare(`SELECT definition.form_id FROM form_definitions definition
        WHERE definition.form_code GLOB 'form_[0-9][0-9][0-9]'
          AND definition.description='لم يتوفر تعريف المصدر الأصلي؛ لم يُخترع اسم أو حقل.'
          AND definition.data_structure_type='unresolved_definition'
          AND definition.is_active=0
          AND NOT EXISTS (
            SELECT 1 FROM form_versions version WHERE version.form_id=definition.form_id AND (
              EXISTS (SELECT 1 FROM form_records record WHERE record.form_version_id=version.form_version_id)
              OR EXISTS (SELECT 1 FROM import_regions region WHERE region.form_version_id=version.form_version_id)
              OR EXISTS (SELECT 1 FROM import_profiles profile WHERE profile.form_version_id=version.form_version_id)
              OR EXISTS (SELECT 1 FROM form_sections section WHERE section.form_version_id=version.form_version_id)
              OR EXISTS (SELECT 1 FROM form_fields field WHERE field.form_version_id=version.form_version_id)
              OR EXISTS (SELECT 1 FROM form_row_definitions row_definition WHERE row_definition.form_version_id=version.form_version_id)
            )
          )`).all();
      const deleteVersions = db.prepare('DELETE FROM form_versions WHERE form_id=?');
      const deleteForm = db.prepare('DELETE FROM form_definitions WHERE form_id=?');
      for (const candidate of candidates) {
        deleteVersions.run(candidate.form_id);
        deleteForm.run(candidate.form_id);
      }
      const sectorReferences = [
        ['form_definitions','sector_id'],['observations','sector_id'],['development_issues','sector_id'],['plan_priorities','sector_id'],
        ['strategic_objectives','sector_id'],['development_programs','sector_id']
      ].filter(([table]) => tableExists(db,table));
      const sectorUsage = sectorReferences.map(([table,column]) => `AND NOT EXISTS (SELECT 1 FROM ${table} reference WHERE reference.${column}=sectors.sector_id)`).join(' ');
      db.prepare(`DELETE FROM sectors WHERE code GLOB 'form-range-*-*'
        AND description='نطاق تصنيف النماذج؛ لا يمثل توصيفاً لحقولها.' ${sectorUsage}`).run();
      const foreignKeys = db.prepare('PRAGMA foreign_key_check').all();
      if (foreignKeys.length) throw new Error(`مخالفة مفتاح خارجي بعد ترحيل تنظيف النماذج: ${JSON.stringify(foreignKeys.slice(0,8))}`);
      db.prepare('INSERT INTO schema_migrations(version,migration_code,migration_name,checksum,applied_at,execution_ms,success,details) VALUES(?,?,?,?,?,?,1,?)')
        .run(migrationVersion,migrationCode,'إزالة النماذج الفارغة غير الموثقة مع إبقاء أي تعريف مستخدم أو مرتبط',migrationChecksum,now,Date.now()-startedAt,`حُذفت ${candidates.length} تعريفات فارغة غير مرتبطة.`);
    })();
    return { version:migrationVersion,alreadyApplied:false };
  } catch (error) {
    db.prepare('INSERT OR REPLACE INTO schema_migrations(version,migration_code,migration_name,checksum,applied_at,execution_ms,success,details) VALUES(?,?,?,?,?,?,0,?)')
      .run(migrationVersion,migrationCode,'إزالة النماذج الفارغة غير الموثقة مع إبقاء أي تعريف مستخدم أو مرتبط',migrationChecksum,new Date().toISOString(),Date.now()-startedAt,String(error.message).slice(0,4000));
    throw error;
  }
}
function migrate(db) {
  migrateV4(db);
  return migrateV5(db);
}

module.exports = { migrate, checksum, normalize, mirrorWorkbookImport, syncWorkbookImportStatus, recordImportMappingDecisions, syncLegacyDirectorateRecord, syncDomainRecords, VERSION:5, CODE:'2026-11-11-remove-unresolved-placeholder-forms-v5', SCHEMA_FILE, UNIT_CODES };
