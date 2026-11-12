'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ExcelJS = require('exceljs');
const { INPUT_FIELDS, DECISION_FIELD, INDICATORS, DIRECTORATE_FIELD_CLASS_BY_KEY } = require('./schema.cjs');
const dataArchitecture = require('../database/architecture.cjs');

const LIMITS = Object.freeze({
  sheets: 200, rowsPerSheet: 5000, columnsPerSheet: 400,
  totalRows: 60000, totalCells: 500000, headerRows: 200,
  mediaCount: 1000, mediaItemBytes: 20 * 1024 * 1024,
  mediaTotalBytes: 60 * 1024 * 1024, originalFileBytes: 200 * 1024 * 1024
});

const TABLES = [
  "CREATE TABLE IF NOT EXISTS geographic_units (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES geographic_units(id), unit_type TEXT NOT NULL, official_code TEXT, name TEXT NOT NULL, normalized_name TEXT NOT NULL, valid_from TEXT, valid_to TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(unit_type, official_code))",
  "CREATE INDEX IF NOT EXISTS geographic_units_parent_idx ON geographic_units(parent_id, unit_type)",
  "CREATE UNIQUE INDEX IF NOT EXISTS geographic_units_name_parent_idx ON geographic_units(unit_type, IFNULL(parent_id,0), normalized_name)",
  "CREATE TABLE IF NOT EXISTS sectors (id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, name_ar TEXT NOT NULL, description TEXT, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS data_sources (id INTEGER PRIMARY KEY, source_type TEXT NOT NULL, organization TEXT, document_title TEXT, file_name TEXT, mime_type TEXT, content_sha256 TEXT, file_size INTEGER, reference_period TEXT, collected_at TEXT, received_at TEXT NOT NULL, notes TEXT)",
  "CREATE INDEX IF NOT EXISTS data_sources_hash_idx ON data_sources(content_sha256)",
  "CREATE TABLE IF NOT EXISTS data_field_definitions (id INTEGER PRIMARY KEY, entity_type TEXT NOT NULL, field_key TEXT NOT NULL, label_ar TEXT NOT NULL, data_type TEXT NOT NULL, unit TEXT, sensitivity TEXT NOT NULL DEFAULT 'public', required_for_identity INTEGER NOT NULL DEFAULT 0, field_class TEXT NOT NULL DEFAULT 'measure', temporal_behavior TEXT NOT NULL DEFAULT 'unspecified', validation_json TEXT NOT NULL DEFAULT '{}', description TEXT, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(entity_type, field_key))",
  "CREATE TABLE IF NOT EXISTS data_field_aliases (id INTEGER PRIMARY KEY, field_definition_id INTEGER NOT NULL REFERENCES data_field_definitions(id) ON DELETE CASCADE, alias TEXT NOT NULL, normalized_alias TEXT NOT NULL, locale TEXT NOT NULL DEFAULT 'ar', confidence REAL NOT NULL DEFAULT 1, approved INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, UNIQUE(field_definition_id, normalized_alias, locale))",
  "CREATE INDEX IF NOT EXISTS data_field_aliases_lookup_idx ON data_field_aliases(normalized_alias, approved)",
  "CREATE TABLE IF NOT EXISTS entity_records (id INTEGER PRIMARY KEY, entity_type TEXT NOT NULL, geographic_unit_id INTEGER REFERENCES geographic_units(id), sector_id INTEGER REFERENCES sectors(id), external_key TEXT, status TEXT NOT NULL DEFAULT 'draft', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
  "CREATE INDEX IF NOT EXISTS entity_records_geo_idx ON entity_records(geographic_unit_id, entity_type)",
  "CREATE UNIQUE INDEX IF NOT EXISTS entity_records_external_key_idx ON entity_records(entity_type, external_key) WHERE external_key IS NOT NULL",
  "CREATE TABLE IF NOT EXISTS entity_record_versions (id INTEGER PRIMARY KEY, record_id INTEGER NOT NULL REFERENCES entity_records(id), action TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL)",
  "CREATE INDEX IF NOT EXISTS entity_record_versions_record_idx ON entity_record_versions(record_id,id DESC)",
  "CREATE TABLE IF NOT EXISTS entity_field_values (id INTEGER PRIMARY KEY, record_id INTEGER NOT NULL REFERENCES entity_records(id) ON DELETE CASCADE, field_definition_id INTEGER NOT NULL REFERENCES data_field_definitions(id), period_key TEXT NOT NULL DEFAULT '', value_text TEXT, value_number REAL, value_date TEXT, value_boolean INTEGER, value_state TEXT NOT NULL DEFAULT 'known', valid_from TEXT, valid_to TEXT, source_id INTEGER REFERENCES data_sources(id), source_location TEXT, raw_value_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(record_id, field_definition_id, period_key))",
  "CREATE INDEX IF NOT EXISTS entity_field_values_field_idx ON entity_field_values(field_definition_id, period_key)",
  "CREATE TABLE IF NOT EXISTS indicator_definitions (id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, label_ar TEXT NOT NULL, sector_id INTEGER REFERENCES sectors(id), unit TEXT, direction TEXT, formula_json TEXT, methodology TEXT, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS indicator_observations (id INTEGER PRIMARY KEY, indicator_id INTEGER NOT NULL REFERENCES indicator_definitions(id), geographic_unit_id INTEGER NOT NULL REFERENCES geographic_units(id), period_key TEXT NOT NULL, period_start TEXT, period_end TEXT, value_number REAL, value_text TEXT, value_state TEXT NOT NULL DEFAULT 'known', source_id INTEGER REFERENCES data_sources(id), source_location TEXT, created_at TEXT NOT NULL, UNIQUE(indicator_id, geographic_unit_id, period_key))",
  "CREATE INDEX IF NOT EXISTS indicator_observations_period_idx ON indicator_observations(period_key, indicator_id)",
  "CREATE TABLE IF NOT EXISTS indicator_observation_versions (id INTEGER PRIMARY KEY, observation_id INTEGER NOT NULL REFERENCES indicator_observations(id) ON DELETE CASCADE, action TEXT NOT NULL, payload_json TEXT NOT NULL, source_id INTEGER REFERENCES data_sources(id), created_at TEXT NOT NULL)",
  "CREATE INDEX IF NOT EXISTS indicator_observation_versions_observation_idx ON indicator_observation_versions(observation_id,id DESC)",
  "CREATE TABLE IF NOT EXISTS projects (id INTEGER PRIMARY KEY, code TEXT UNIQUE, name TEXT NOT NULL, description TEXT, geographic_unit_id INTEGER REFERENCES geographic_units(id), sector_id INTEGER REFERENCES sectors(id), status TEXT NOT NULL DEFAULT 'draft', estimated_cost REAL, actual_cost REAL, currency_code TEXT, start_date TEXT, end_date TEXT, source_id INTEGER REFERENCES data_sources(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
  "CREATE INDEX IF NOT EXISTS projects_geo_sector_idx ON projects(geographic_unit_id, sector_id, status)",
  "CREATE TABLE IF NOT EXISTS project_versions (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, action TEXT NOT NULL, payload_json TEXT NOT NULL, source_id INTEGER REFERENCES data_sources(id), created_at TEXT NOT NULL)",
  "CREATE INDEX IF NOT EXISTS project_versions_project_idx ON project_versions(project_id, id DESC)",
  "CREATE TABLE IF NOT EXISTS project_funding (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, partner_name TEXT NOT NULL, amount REAL, currency_code TEXT, funding_date TEXT, source_id INTEGER REFERENCES data_sources(id), created_at TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS managed_attachments (id INTEGER PRIMARY KEY, entity_type TEXT NOT NULL, entity_id INTEGER, source_id INTEGER REFERENCES data_sources(id), original_name TEXT NOT NULL, mime_type TEXT, extension TEXT, size_bytes INTEGER NOT NULL, sha256 TEXT NOT NULL, content BLOB NOT NULL, source_location TEXT, classification TEXT NOT NULL DEFAULT 'unclassified', review_status TEXT NOT NULL DEFAULT 'unassigned', created_at TEXT NOT NULL)",
  "CREATE INDEX IF NOT EXISTS managed_attachments_entity_idx ON managed_attachments(entity_type, entity_id)",
  "CREATE TABLE IF NOT EXISTS data_quality_issues (id INTEGER PRIMARY KEY, batch_id INTEGER, sheet_id INTEGER, row_id INTEGER, record_id INTEGER REFERENCES entity_records(id), field_definition_id INTEGER REFERENCES data_field_definitions(id), severity TEXT NOT NULL, issue_code TEXT NOT NULL, message TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', resolution TEXT, created_at TEXT NOT NULL, resolved_at TEXT)",
  "CREATE INDEX IF NOT EXISTS data_quality_issues_status_idx ON data_quality_issues(status, severity)",
  "CREATE TABLE IF NOT EXISTS workbook_import_batches (id INTEGER PRIMARY KEY, source_id INTEGER REFERENCES data_sources(id), file_name TEXT NOT NULL, file_size INTEGER NOT NULL, sha256 TEXT NOT NULL, original_file BLOB NOT NULL, sheet_count INTEGER NOT NULL DEFAULT 0, row_count INTEGER NOT NULL DEFAULT 0, cell_count INTEGER NOT NULL DEFAULT 0, media_count INTEGER NOT NULL DEFAULT 0, media_stored_count INTEGER NOT NULL DEFAULT 0, truncated INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'staged', result_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
  "CREATE INDEX IF NOT EXISTS workbook_import_batches_created_idx ON workbook_import_batches(created_at DESC)",
  "CREATE TABLE IF NOT EXISTS workbook_import_sheets (id INTEGER PRIMARY KEY, batch_id INTEGER NOT NULL REFERENCES workbook_import_batches(id) ON DELETE CASCADE, worksheet_id INTEGER, sheet_index INTEGER NOT NULL, name TEXT NOT NULL, state TEXT NOT NULL, max_row INTEGER NOT NULL DEFAULT 0, max_column INTEGER NOT NULL DEFAULT 0, scanned_rows INTEGER NOT NULL DEFAULT 0, nonempty_row_count INTEGER NOT NULL DEFAULT 0, cell_count INTEGER NOT NULL DEFAULT 0, formula_count INTEGER NOT NULL DEFAULT 0, hidden_row_count INTEGER NOT NULL DEFAULT 0, merged_ranges_json TEXT NOT NULL DEFAULT '[]', tables_json TEXT NOT NULL DEFAULT '[]', image_count INTEGER NOT NULL DEFAULT 0, anchor_count INTEGER NOT NULL DEFAULT 0, truncated INTEGER NOT NULL DEFAULT 0, UNIQUE(batch_id, sheet_index))",
  "CREATE TABLE IF NOT EXISTS workbook_import_regions (id INTEGER PRIMARY KEY, batch_id INTEGER NOT NULL REFERENCES workbook_import_batches(id) ON DELETE CASCADE, sheet_id INTEGER NOT NULL REFERENCES workbook_import_sheets(id) ON DELETE CASCADE, region_index INTEGER NOT NULL, header_row INTEGER NOT NULL, first_data_row INTEGER NOT NULL, last_data_row INTEGER NOT NULL, candidate_type TEXT NOT NULL DEFAULT 'unclassified', match_count INTEGER NOT NULL DEFAULT 0, confidence REAL NOT NULL DEFAULT 0, mapping_json TEXT NOT NULL, review_status TEXT NOT NULL DEFAULT 'unmapped', UNIQUE(sheet_id, region_index))",
  "CREATE TABLE IF NOT EXISTS workbook_import_rows (id INTEGER PRIMARY KEY, batch_id INTEGER NOT NULL REFERENCES workbook_import_batches(id) ON DELETE CASCADE, sheet_id INTEGER NOT NULL REFERENCES workbook_import_sheets(id) ON DELETE CASCADE, row_number INTEGER NOT NULL, is_hidden INTEGER NOT NULL DEFAULT 0, cell_count INTEGER NOT NULL DEFAULT 0, has_formula INTEGER NOT NULL DEFAULT 0, cells_json TEXT NOT NULL, content_sha256 TEXT NOT NULL, UNIQUE(sheet_id, row_number))",
  "CREATE INDEX IF NOT EXISTS workbook_import_rows_batch_idx ON workbook_import_rows(batch_id, sheet_id, row_number)",
  "CREATE TABLE IF NOT EXISTS workbook_import_promotions (id INTEGER PRIMARY KEY, batch_id INTEGER NOT NULL REFERENCES workbook_import_batches(id) ON DELETE CASCADE, region_id INTEGER NOT NULL REFERENCES workbook_import_regions(id) ON DELETE CASCADE, row_id INTEGER NOT NULL REFERENCES workbook_import_rows(id) ON DELETE CASCADE, entity_type TEXT NOT NULL, target_id INTEGER NOT NULL, source_location TEXT NOT NULL, mapping_json TEXT NOT NULL, mapped_values_json TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(row_id))",
  "CREATE INDEX IF NOT EXISTS workbook_import_promotions_target_idx ON workbook_import_promotions(entity_type, target_id)",
  "CREATE TABLE IF NOT EXISTS workbook_import_media (id INTEGER PRIMARY KEY, batch_id INTEGER NOT NULL REFERENCES workbook_import_batches(id) ON DELETE CASCADE, sheet_id INTEGER REFERENCES workbook_import_sheets(id) ON DELETE SET NULL, media_index INTEGER NOT NULL, original_name TEXT NOT NULL, extension TEXT, mime_type TEXT, size_bytes INTEGER NOT NULL DEFAULT 0, sha256 TEXT, content BLOB, anchors_json TEXT NOT NULL DEFAULT '[]', extraction_status TEXT NOT NULL DEFAULT 'stored', UNIQUE(batch_id, media_index))"
];

function normalizeLabel(value) {
  return String(value ?? '').normalize('NFKD')
    .replace(/[\u064B-\u065F\u0670\u06D6-\u06ED]/g, '')
    .replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ').toLowerCase();
}
function json(value) { try { return JSON.stringify(value); } catch { return 'null'; } }
function safeDateValue(value) {
  if (!(value instanceof Date)) return value;
  return Number.isFinite(value.getTime()) ? value.toISOString() : { type: 'invalid-date', text: String(value) };
}
function plainText(value) {
  if (value == null) return '';
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : 'Invalid Date';
  if (['string','number','boolean'].includes(typeof value)) return String(value);
  if (Array.isArray(value.richText)) return value.richText.map(x => x.text ?? '').join('');
  if (value.text !== undefined) return String(value.text);
  if (value.result !== undefined) return plainText(value.result);
  if (value.hyperlink) return String(value.hyperlink);
  return '';
}
function snapshotCell(cell) {
  const value = cell.value;
  const formula = value && typeof value === 'object' ? value.formula ?? value.sharedFormula ?? null : null;
  const cached = value && typeof value === 'object' && Object.hasOwn(value, 'result') ? value.result : null;
  let note = null;
  try { note = typeof cell.note === 'string' ? cell.note : cell.note ? json(cell.note) : null; } catch {}
  return { address: cell.address, row: cell.row, column: cell.col, type: cell.type,
    text: plainText(value), formula, cachedResult: safeDateValue(cached), rawValue: safeDateValue(value), note };
}
function mediaBuffer(item) {
  if (Buffer.isBuffer(item?.buffer)) return item.buffer;
  if (item?.buffer instanceof Uint8Array) return Buffer.from(item.buffer);
  if (typeof item?.base64 === 'string') return Buffer.from(item.base64.includes(',') ? item.base64.split(',').pop() : item.base64, 'base64');
  return null;
}
function mimeFor(ext) {
  return ({png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',bmp:'image/bmp',tif:'image/tiff',tiff:'image/tiff',svg:'image/svg+xml',webp:'image/webp'})[String(ext ?? '').toLowerCase()] ?? 'application/octet-stream';
}
function anchorsFor(sheet, media) {
  let images = [];
  try { images = sheet.getImages?.() ?? []; } catch {}
  return images.map(image => {
    const r = image.range ?? {};
    const match = media.find(item => String(item.index) === String(image.imageId));
    return { imageId: String(image.imageId), mediaIndex: match?.index ?? null,
      range: { topRow: r.tl?.nativeRow ?? r.tl?.row ?? null, leftColumn: r.tl?.nativeCol ?? r.tl?.col ?? null,
        bottomRow: r.br?.nativeRow ?? r.br?.row ?? null, rightColumn: r.br?.nativeCol ?? r.br?.col ?? null } };
  });
}

function resolveLegacySource(database, sourceFile, now) {
  if (!sourceFile) return null;
  const existing = database.prepare('SELECT id FROM data_sources WHERE file_name=? ORDER BY id DESC LIMIT 1').get(sourceFile);
  if (existing) return existing.id;
  const created = database.prepare("INSERT INTO data_sources (source_type,document_title,file_name,received_at,notes) VALUES ('legacy-compatibility',?,?,?,'تم إنشاء مرجع توافق للبيانات الموجودة قبل نموذج المصادر المعياري')")
    .run(String(sourceFile).slice(0,240),String(sourceFile).slice(0,240),now);
  return Number(created.lastInsertRowid);
}

function syncLegacyDirectorate(database, id, options = {}) {
  const recordId = Number(id);
  if (!Number.isSafeInteger(recordId) || recordId <= 0) throw new Error('معرّف المديرية غير صالح للمزامنة المعيارية.');
  const record = database.prepare('SELECT * FROM directorates WHERE id=?').get(recordId);
  if (!record) return null;
  const now = new Date().toISOString();
  const { INPUT_FIELDS, DECISION_FIELD, DIRECTORATE_FIELD_CLASS_BY_KEY } = require('./schema.cjs');
  const fields = [...INPUT_FIELDS,DECISION_FIELD];
  const fieldRows = database.prepare("SELECT id,field_key,data_type FROM data_field_definitions WHERE entity_type='directorate' AND active=1").all();
  const fieldByKey = new Map(fieldRows.map(field => [field.field_key,field]));
  const aliases = Object.fromEntries(fields.map(field => [field.key,field]));
  const normalizedGovernorate = normalizeLabel(record.governorate);
  const normalizedDistrict = normalizeLabel(record.district);
  let governorateId = null;
  if (record.governorate) {
    database.prepare("INSERT OR IGNORE INTO geographic_units (unit_type,name,normalized_name,created_at,updated_at) VALUES ('governorate',?,?,?,?)")
      .run(record.governorate,normalizedGovernorate,now,now);
    governorateId = database.prepare("SELECT id FROM geographic_units WHERE unit_type='governorate' AND parent_id IS NULL AND normalized_name=?")
      .get(normalizedGovernorate)?.id ?? null;
  }
  database.prepare("INSERT OR IGNORE INTO geographic_units (parent_id,unit_type,name,normalized_name,created_at,updated_at) VALUES (?,'district',?,?,?,?)")
    .run(governorateId,record.district,normalizedDistrict,now,now);
  const geographicUnitId = database.prepare("SELECT id FROM geographic_units WHERE unit_type='district' AND IFNULL(parent_id,0)=IFNULL(?,0) AND normalized_name=?")
    .get(governorateId,normalizedDistrict)?.id;
  if (!geographicUnitId) throw new Error('تعذر ربط المديرية بالمرجع الجغرافي المعياري.');
  const syncGeographicUnit = database.prepare(`UPDATE geographic_units SET geo_unit_id=coalesce(geo_unit_id,id),
    geo_unit_type_id=coalesce(geo_unit_type_id,(SELECT geo_unit_type_id FROM geo_unit_types WHERE type_code=CASE unit_type WHEN 'district' THEN 'directorate' ELSE unit_type END)),
    parent_geo_unit_id=coalesce(parent_geo_unit_id,parent_id),name_ar=coalesce(name_ar,name) WHERE id=?`);
  if (governorateId !== null) syncGeographicUnit.run(governorateId);
  syncGeographicUnit.run(geographicUnitId);
  const externalKey = 'legacy-directorate:' + recordId;
  database.prepare("INSERT INTO entity_records (entity_type,geographic_unit_id,external_key,status,created_at,updated_at) VALUES ('directorate',?,?,'approved',?,?) ON CONFLICT(entity_type,external_key) WHERE external_key IS NOT NULL DO UPDATE SET geographic_unit_id=excluded.geographic_unit_id,status='approved',updated_at=excluded.updated_at")
    .run(geographicUnitId,externalKey,record.created_at ?? now,record.updated_at ?? now);
  const entityRecord = database.prepare("SELECT id FROM entity_records WHERE entity_type='directorate' AND external_key=?").get(externalKey);
  if (!entityRecord) throw new Error('تعذر إنشاء السجل المعياري للمديرية.');
  const sourceRows = database.prepare('SELECT field_key,value_text,source_file,source_location FROM directorate_sources WHERE directorate_id=?').all(recordId);
  const sourceByField = new Map(sourceRows.map(source => [source.field_key,source]));
  const defaultSource = resolveLegacySource(database,record.source_file,now);
  const staleGuard = options.force ? '' : ' WHERE excluded.updated_at>=entity_field_values.updated_at';
  const insertValue = database.prepare("INSERT INTO entity_field_values (record_id,field_definition_id,period_key,value_text,value_number,value_boolean,value_state,source_id,source_location,raw_value_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(record_id,field_definition_id,period_key) DO UPDATE SET value_text=excluded.value_text,value_number=excluded.value_number,value_boolean=excluded.value_boolean,value_state=excluded.value_state,source_id=excluded.source_id,source_location=excluded.source_location,raw_value_json=excluded.raw_value_json,updated_at=excluded.updated_at" + staleGuard);
  for (const [key,field] of Object.entries(aliases)) {
    const definition = fieldByKey.get(key);
    if (!definition) continue;
    const column = legacyDirectorateColumn(key);
    const value = key === 'districtName' ? record.district : key === 'governorate' ? record.governorate : record[column];
    const source = sourceByField.get(key);
    const sourceId = resolveLegacySource(database,source?.source_file,now) ?? defaultSource;
    const sourceLocation = source?.source_location ?? (record.source_sheet && record.source_row ? record.source_sheet + '!row-' + record.source_row + ':' + key : null);
    const dataType = definition.data_type;
    const valueText = value === null || value === undefined || dataType === 'number' || dataType === 'boolean' ? null : String(value);
    const valueNumber = value !== null && value !== undefined && dataType === 'number' && Number.isFinite(Number(value)) ? Number(value) : null;
    const valueBoolean = dataType === 'boolean' && value !== null && value !== undefined ? (Number(value) ? 1 : 0) : null;
    const temporal = DIRECTORATE_FIELD_CLASS_BY_KEY[key] === 'temporal_measure';
    const state = value === null || value === undefined ? 'unknown' : temporal ? 'period-unspecified' : 'known';
    const rawJson = value === null || value === undefined ? null : json({ value, unit: field.unit ?? null, legacyPeriod: temporal ? 'unspecified' : null });
    insertValue.run(entityRecord.id,definition.id,'',valueText,valueNumber,valueBoolean,state,
      sourceId,sourceLocation,rawJson,record.updated_at ?? now,record.updated_at ?? now);
  }
  return { recordId,entityRecordId:entityRecord.id,geographicUnitId };
}

function legacyDirectorateColumn(key) {
  const overrides = { districtName:'district',districtNature:'nature',lostOpportunityType:'lost_opportunity' };
  return overrides[key] ?? key.replace(/[A-Z]/g,letter => '_' + letter.toLowerCase());
}

function backfillLegacyDirectorates(database) {
  const table = database.prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='directorates'").get();
  if (!table) return 0;
  const ids = database.prepare('SELECT id FROM directorates ORDER BY id').all();
  for (const { id } of ids) syncLegacyDirectorate(database,id);
  return ids.length;
}

function retireLegacyDirectorate(database, id) {
  const recordId = Number(id);
  if (!Number.isSafeInteger(recordId) || recordId <= 0) throw new Error('معرّف المديرية غير صالح للأرشفة.');
  database.prepare("UPDATE entity_records SET status='deleted',updated_at=? WHERE entity_type='directorate' AND external_key=?")
    .run(new Date().toISOString(),'legacy-directorate:' + recordId);
}

function ensureColumn(database, table, name, definition) {
  const columns = database.prepare('PRAGMA table_info(' + table + ')').all().map(column => column.name);
  if (!columns.includes(name)) database.exec('ALTER TABLE ' + table + ' ADD COLUMN ' + name + ' ' + definition);
}

function applyCanonicalMigration(database) {
  database.exec(TABLES.join(';\n') + ';');
  ensureColumn(database,'data_field_definitions','field_class',"TEXT NOT NULL DEFAULT 'measure'");
  ensureColumn(database,'data_field_definitions','temporal_behavior',"TEXT NOT NULL DEFAULT 'unspecified'");
  ensureColumn(database,'data_field_definitions','validation_json',"TEXT NOT NULL DEFAULT '{}'");
  const now = new Date().toISOString();
  const fieldInsert = database.prepare("INSERT INTO data_field_definitions (entity_type,field_key,label_ar,data_type,unit,sensitivity,required_for_identity,field_class,temporal_behavior,validation_json,description,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(entity_type,field_key) DO UPDATE SET label_ar=excluded.label_ar,data_type=excluded.data_type,unit=excluded.unit,sensitivity=excluded.sensitivity,required_for_identity=excluded.required_for_identity,field_class=excluded.field_class,temporal_behavior=excluded.temporal_behavior,validation_json=excluded.validation_json,description=excluded.description,updated_at=excluded.updated_at");
  const aliasInsert = database.prepare("INSERT INTO data_field_aliases (field_definition_id,alias,normalized_alias,locale,confidence,approved,created_at) VALUES (?,?,?,'ar',1,1,?) ON CONFLICT(field_definition_id,normalized_alias,locale) DO NOTHING");
  // Reuse the exact Arabic aliases already accepted by the existing matcher.
  // Load lazily: mapping.cjs imports store-schema.cjs, so loading it only when
  // the migration executes avoids a module-initialization cycle.
  const { ALIASES } = require('./mapping.cjs');
  for (const field of [...INPUT_FIELDS, DECISION_FIELD]) {
    const classification = DIRECTORATE_FIELD_CLASS_BY_KEY[field.key] ?? 'measure';
    const temporalBehavior = classification === 'temporal_measure' ? 'period-required-but-legacy-unspecified' : 'not-temporal';
    const validation = {
      nonNegative: field.type === 'number' || field.type === 'ratio',
      minimum: field.type === 'ratio' ? 0 : (field.type === 'number' ? 0 : null),
      maximum: field.type === 'ratio' ? 1 : null,
      allowed: field.allowed ?? null,
    };
    const description = classification === 'project_summary'
      ? 'حقل تلخيصي على مستوى المديرية في القالب القديم؛ لا يمثل سجل مشروع مستقلًا.'
      : classification === 'temporal_measure'
        ? 'قياس قابل للتغير زمنيًا؛ القالب القديم لا يوفر فترة مرجعية، لذلك تبقى الفترة غير محددة حتى يراجعها المستخدم.'
        : null;
    fieldInsert.run('directorate',field.key,field.header,field.type === 'ratio' ? 'number' : field.type,
      field.unit ?? null,field.sensitivity ?? 'public',['districtName','governorate'].includes(field.key) ? 1 : 0,
      classification,temporalBehavior,json(validation),description,now,now);
    const id = database.prepare("SELECT id FROM data_field_definitions WHERE entity_type='directorate' AND field_key=?").get(field.key)?.id;
    if (id) {
      aliasInsert.run(id, field.header, normalizeLabel(field.header), now);
      for (const alias of ALIASES[field.key] ?? []) {
        aliasInsert.run(id, alias, normalizeLabel(alias), now);
      }
    }
  }
  const indicatorInsert = database.prepare("INSERT INTO indicator_definitions (code,label_ar,unit,direction,formula_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(code) DO NOTHING");
  for (const indicator of INDICATORS) {
    indicatorInsert.run(indicator.code, indicator.header, indicator.unit ?? null, indicator.direction ?? null,
      json({ formula: indicator.formula, weight: indicator.weight, benchmark: indicator.benchmark ?? null }), now, now);
  }
  backfillLegacyDirectorates(database);
  return true;
}

function checksum() {
  const { ALIASES } = require('./mapping.cjs');
  return crypto.createHash('sha256').update(JSON.stringify({ TABLES, INPUT_FIELDS, DECISION_FIELD, INDICATORS, DIRECTORATE_FIELD_CLASS_BY_KEY, ALIASES })).digest('hex');
}

function migrateCanonicalData(database) {
  return database.transaction(() => applyCanonicalMigration(database))();
}

async function stageWorkbook(database, filePath, workbookOption = null) {
  const stat = fs.statSync(filePath);
  if (!stat.isFile() || stat.size < 1) throw new Error('لا يمكن حفظ ملف استقبال فارغ.');
  if (stat.size > LIMITS.originalFileBytes) throw new Error('حجم الملف يتجاوز حد الحفظ المحلي البالغ 200 ميغابايت.');
  const original = fs.readFileSync(filePath);
  const sha = crypto.createHash('sha256').update(original).digest('hex');
  const workbook = workbookOption ?? new ExcelJS.Workbook();
  if (!workbookOption) await workbook.xlsx.load(original);
  const sheets = workbook.worksheets ?? [];
  if (!sheets.length) throw new Error('ملف Excel لا يحتوي أوراق عمل.');
  if (sheets.length > LIMITS.sheets) throw new Error('عدد الأوراق يتجاوز الحد الآمن: ' + LIMITS.sheets + '.');

  const { mapHeaderRow } = require('./mapping.cjs');
  const mediaAll = (workbook.model?.media ?? []).filter(item => item?.type === 'image' || item?.type === 'background');
  if (mediaAll.length > LIMITS.mediaCount) throw new Error('عدد الصور يتجاوز الحد الآمن: ' + LIMITS.mediaCount + '.');
  let totalRows = 0, totalCells = 0, formulaCount = 0, hiddenRowCount = 0, truncated = false;
  const inventory = [];

  for (let si = 0; si < sheets.length; si++) {
    const sheet = sheets[si];
    const maxRow = Number(sheet.rowCount ?? 0), maxColumn = Number(sheet.columnCount ?? 0);
    const rows = [], candidates = [];
    let cellsInSheet = 0, formulas = 0, hidden = 0, extraColumns = false;
    const rowLimit = Math.min(maxRow, LIMITS.rowsPerSheet);
    const colLimit = Math.min(maxColumn, LIMITS.columnsPerSheet);
    for (let rn = 1; rn <= rowLimit; rn++) {
      const row = sheet.getRow(rn), cells = [];
      row.eachCell({ includeEmpty: false }, cell => {
        if (cell.col > LIMITS.columnsPerSheet) { extraColumns = true; return; }
        cells.push(snapshotCell(cell));
      });
      if (!cells.length) continue;
      const hasFormula = cells.some(cell => Boolean(cell.formula));
      formulas += cells.filter(cell => Boolean(cell.formula)).length;
      cellsInSheet += cells.length; totalCells += cells.length; totalRows++;
      if (row.hidden) hidden++;
      rows.push({ rn, hidden: Boolean(row.hidden), cells, hasFormula });
      if (totalRows > LIMITS.totalRows || totalCells > LIMITS.totalCells) {
        throw new Error('تجاوز الملف حدود الاستقبال الآمن. لم تُحفظ دفعة جزئية ولم تُعدّل البيانات المعتمدة.');
      }
    }
    for (let rn = 1; rn <= Math.min(rowLimit, LIMITS.headerRows); rn++) {
      const labels = [];
      for (let col = 1; col <= colLimit; col++) labels.push(plainText(sheet.getRow(rn).getCell(col).value));
      const mapping = mapHeaderRow(labels);
      const nonemptyHeaders = labels.map(value => String(value ?? '').trim()).filter(Boolean);
      const normalizedHeaders = nonemptyHeaders.map(normalizeLabel);
      const distinctHeaders = new Set(normalizedHeaders);
      const hasDataBelow = [rn + 1, rn + 2, rn + 3].some((sampleRow) => {
        if (sampleRow > rowLimit) return false;
        let populated = 0;
        sheet.getRow(sampleRow).eachCell({ includeEmpty: false }, () => { populated += 1; });
        return populated >= 2;
      });
      // Keep non-ministry datasets discoverable without guessing their schema:
      // three or more distinct textual headers plus actual tabular data are a
      // review candidate, never an automatic import decision.
      const structuralHeaderHints = [
        'اسم المشروع','رمز المشروع','كود المشروع','تكلفه المشروع','التكلفه التقديريه','حاله المشروع',
        'تاريخ البدايه','تاريخ النهايه','جهة التمويل','مبلغ التمويل','اسم المؤشر','قيمه المؤشر',
        'فتره المؤشر','المحافظه','اسم المديريه','رقم المشروع','اسم الجهه','القطاع','التاريخ','القيمه',
      ].map(normalizeLabel);
      const structuralHintCount = normalizedHeaders.filter(header =>
        structuralHeaderHints.some(hint => header === hint || header.startsWith(hint + ' '))
      ).length;
      const genericHeaderCandidate = mapping.matched.length < 2
        && nonemptyHeaders.length >= 3
        && nonemptyHeaders.length <= 40
        && distinctHeaders.size >= 3
        && nonemptyHeaders.every(value => value.length <= 100)
        && structuralHintCount >= 2
        && hasDataBelow;
      if (mapping.matched.length < 2 && !genericHeaderCandidate) continue;
      const keys = mapping.matched.map(item => item.key);
      const normalizedText = normalizedHeaders.join(' ');
      const isDirectorate = keys.includes('districtName') && keys.includes('governorate');
      const hasAny = (hints) => hints.some(hint => normalizedText.includes(normalizeLabel(hint)));
      // A lone "project cost" field is common in a directorate profile and must
      // never turn the whole directorate table into a projects dataset. Require
      // project identity (name/code/number) plus supporting project columns, or
      // at least two distinct identity fields.
      const projectIdentityHints = ['اسم المشروع', 'رمز المشروع', 'كود المشروع', 'رقم المشروع'];
      const projectContextHints = ['حاله المشروع', 'وصف المشروع', 'تكلفه المشروع', 'التكلفه التقديريه', 'تكلفه تقديريه',
        'جهة التمويل', 'مبلغ التمويل', 'تاريخ البدايه', 'تاريخ النهايه'];
      const projectIdentityCount = projectIdentityHints.filter(hint => hasAny([hint])).length;
      const projectContextCount = projectContextHints.filter(hint => hasAny([hint])).length;
      const isProject = projectIdentityCount >= 2 || (projectIdentityCount >= 1 && projectContextCount >= 1);

      // Generic "value/period" labels are not enough to identify an indicator
      // table. Require an explicit indicator identity and at least one measure
      // context column, otherwise preserve the region as unclassified.
      const indicatorIdentityHints = ['اسم المؤشر', 'رمز المؤشر', 'كود المؤشر'];
      const indicatorContextHints = ['القيمه', 'الفتره', 'السنه', 'نتيجه المؤشر', 'وحده القياس', 'تاريخ القياس'];
      const indicatorIdentityCount = indicatorIdentityHints.filter(hint => hasAny([hint])).length;
      const indicatorContextCount = indicatorContextHints.filter(hint => hasAny([hint])).length;
      const isIndicator = indicatorIdentityCount >= 2 || (indicatorIdentityCount >= 1 && indicatorContextCount >= 1);

      // Explicit project/indicator identity wins over overlapping location fields.
      const candidateType = isProject ? 'project-candidate'
        : isIndicator ? 'indicator-candidate'
          : isDirectorate ? 'directorate-candidate'
            : 'unclassified';
      const confidence = mapping.matched.length
        ? mapping.matched.reduce((sum,item) => sum + Number(item.score ?? 0),0) / mapping.matched.length
        : Math.min(0.8, 0.35 + nonemptyHeaders.length / 100);
      candidates.push({ headerRow: rn, matched: mapping.matched, unmatched: mapping.unmatched,
        duplicates: mapping.duplicates, candidateType, confidence });
    }
    const regions = candidates.map((candidate, index) => ({ ...candidate, regionIndex: index + 1,
      firstDataRow: candidate.headerRow + 1,
      lastDataRow: candidates[index + 1] ? candidates[index + 1].headerRow - 1 : rowLimit }));
    const merges = sheet.model?.merges ?? sheet._merges ?? [];
    const merged = Array.isArray(merges) ? merges.map(String) : Object.keys(merges).map(String);
    const tables = Object.entries(sheet.tables ?? {}).map(([key,table]) => ({ name: table?.name ?? table?.model?.name ?? key, ref: table?.ref ?? table?.model?.ref ?? null }));
    const anchors = anchorsFor(sheet, mediaAll);
    const sheetTruncated = maxRow > LIMITS.rowsPerSheet || maxColumn > LIMITS.columnsPerSheet || extraColumns;
    truncated ||= sheetTruncated; formulaCount += formulas; hiddenRowCount += hidden;
    inventory.push({ sheet, si, maxRow, maxColumn, rowLimit, rows, regions, merged, tables, anchors,
      cellsInSheet, formulas, hidden, truncated: sheetTruncated });
  }

  const anchorIndex = new Map();
  for (const item of inventory) for (const a of item.anchors) if (a.mediaIndex !== null) {
    const list = anchorIndex.get(a.mediaIndex) ?? [];
    list.push({ sheetName: item.sheet.name, ...a }); anchorIndex.set(a.mediaIndex, list);
  }

  const now = new Date().toISOString();
  const write = database.transaction(() => {
    const batch = database.prepare("INSERT INTO workbook_import_batches (file_name,file_size,sha256,original_file,sheet_count,row_count,cell_count,media_count,truncated,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,'staged',?,?)")
      .run(path.basename(filePath), stat.size, sha, original, sheets.length, totalRows, totalCells, mediaAll.length, truncated ? 1 : 0, now, now);
    const batchId = Number(batch.lastInsertRowid);
    const source = database.prepare("INSERT INTO data_sources (source_type,document_title,file_name,mime_type,content_sha256,file_size,received_at,notes) VALUES ('excel-workbook',?,?,?, ?,?,?,?)")
      .run(path.basename(filePath), path.basename(filePath), path.extname(filePath).toLowerCase() === '.xlsm'
        ? 'application/vnd.ms-excel.sheet.macroEnabled.12' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        sha, stat.size, now, 'نسخة المصدر الأصلية محفوظة داخل قاعدة البيانات المحلية غير المشفّرة (ملف SQLite محلي).');
    database.prepare("UPDATE workbook_import_batches SET source_id=? WHERE id=?").run(Number(source.lastInsertRowid), batchId);

    const sheetIds = new Map();
    const addSheet = database.prepare("INSERT INTO workbook_import_sheets (batch_id,worksheet_id,sheet_index,name,state,max_row,max_column,scanned_rows,nonempty_row_count,cell_count,formula_count,hidden_row_count,merged_ranges_json,tables_json,image_count,anchor_count,truncated) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
    const addRegion = database.prepare("INSERT INTO workbook_import_regions (batch_id,sheet_id,region_index,header_row,first_data_row,last_data_row,candidate_type,match_count,confidence,mapping_json) VALUES (?,?,?,?,?,?,?,?,?,?)");
    const addRow = database.prepare("INSERT INTO workbook_import_rows (batch_id,sheet_id,row_number,is_hidden,cell_count,has_formula,cells_json,content_sha256) VALUES (?,?,?,?,?,?,?,?)");
    for (const item of inventory) {
      const r = addSheet.run(batchId, item.sheet.id, item.si + 1, item.sheet.name, item.sheet.state ?? 'visible',
        item.maxRow, item.maxColumn, item.rowLimit, item.rows.length, item.cellsInSheet, item.formulas, item.hidden,
        json(item.merged), json(item.tables), item.anchors.length, item.anchors.length, item.truncated ? 1 : 0);
      const sheetId = Number(r.lastInsertRowid); sheetIds.set(item.sheet.name, sheetId);
      for (const region of item.regions) addRegion.run(batchId, sheetId, region.regionIndex, region.headerRow,
        region.firstDataRow, Math.max(region.firstDataRow - 1, region.lastDataRow), region.candidateType,
        region.matched.length, region.confidence, json({ matched: region.matched, unmatched: region.unmatched, duplicates: region.duplicates }));
      for (const row of item.rows) {
        const data = json(row.cells);
        addRow.run(batchId, sheetId, row.rn, row.hidden ? 1 : 0, row.cells.length, row.hasFormula ? 1 : 0,
          data, crypto.createHash('sha256').update(data).digest('hex'));
      }
    }

    let mediaStored = 0, storedBytes = 0;
    const addMedia = database.prepare("INSERT INTO workbook_import_media (batch_id,sheet_id,media_index,original_name,extension,mime_type,size_bytes,sha256,content,anchors_json,extraction_status) VALUES (?,?,?,?,?,?,?,?,?,?,?)");
    mediaAll.forEach((item,index) => {
      const buffer = Buffer.isBuffer(item.buffer) ? item.buffer : item.buffer instanceof Uint8Array ? Buffer.from(item.buffer)
        : typeof item.base64 === 'string' ? Buffer.from(item.base64.includes(',') ? item.base64.split(',').pop() : item.base64,'base64') : null;
      const bytes = buffer?.length ?? 0;
      const anchors = anchorIndex.get(item.index) ?? [];
      const sheetId = anchors[0] ? sheetIds.get(anchors[0].sheetName) ?? null : null;
      let status = buffer ? 'stored' : 'bytes-unavailable', data = buffer;
      if (bytes > LIMITS.mediaItemBytes || storedBytes + bytes > LIMITS.mediaTotalBytes) { status = 'size-limit-exceeded'; data = null; }
      else if (buffer) { mediaStored++; storedBytes += bytes; }
      else data = null;
      const ext = String(item.extension ?? '').toLowerCase();
      addMedia.run(batchId, sheetId, Number(item.index ?? index), String(item.name ?? ('image-' + (index + 1))), ext,
        ({png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',bmp:'image/bmp',svg:'image/svg+xml',webp:'image/webp'})[ext] ?? 'application/octet-stream',
        bytes, data ? crypto.createHash('sha256').update(data).digest('hex') : null, data, json(anchors), status);
    });
    database.prepare("UPDATE workbook_import_batches SET media_stored_count=? WHERE id=?").run(mediaStored, batchId);
    return { batchId, mediaStored };
  });
  const saved = write();
  return {
    batchId: saved.batchId,
    fileName: path.basename(filePath),
    fileSize: stat.size,
    sha256: sha,
    sheetCount: sheets.length,
    rowCount: totalRows,
    cellCount: totalCells,
    formulaCount,
    hiddenRowCount,
    mediaCount: mediaAll.length,
    mediaStoredCount: saved.mediaStored,
    mediaUnanchoredCount: mediaAll.filter(item => !(anchorIndex.get(item.index)?.length)).length,
    truncated,
    status: 'staged',
    limits: LIMITS,
    sheets: database.prepare("SELECT id, sheet_index FROM workbook_import_sheets WHERE batch_id = ? ORDER BY sheet_index").all(saved.batchId).map((storedSheet, index) => ({
      id: storedSheet.id,
      index: storedSheet.sheet_index,
      ...(() => {
        const item = inventory[index];
        return {
      name: item.sheet.name,
      state: item.sheet.state ?? 'visible',
      rowCount: item.maxRow,
      columnCount: item.maxColumn,
      scannedRows: item.rowLimit,
      nonemptyRows: item.rows.length,
      cellCount: item.cellsInSheet,
      formulaCount: item.formulas,
      hiddenRowCount: item.hidden,
      imageCount: item.anchors.length,
      tableCount: item.tables.length,
      mergedRangeCount: item.merged.length,
      truncated: item.truncated,
      regions: item.regions.map(region => ({
        headerRow: region.headerRow,
        candidateType: region.candidateType,
        matchedCount: region.matched.length,
        confidence: region.confidence,
      })),
        };
      })(),
    })),
  };
}

function readWorkbookSheetPreview(database, batchId, sheetId, limit = 20) {
  const batch = Number(batchId);
  const sheet = Number(sheetId);
  const bounded = Math.min(30, Math.max(1, Number(limit) || 20));
  if (!Number.isSafeInteger(batch) || batch <= 0 || !Number.isSafeInteger(sheet) || sheet <= 0) {
    throw new Error('معرّف دفعة أو ورقة الاستيراد غير صالح.');
  }
  const metadata = database.prepare(
    'SELECT id, batch_id, sheet_index, name, state, nonempty_row_count FROM workbook_import_sheets WHERE id = ? AND batch_id = ?'
  ).get(sheet, batch);
  if (!metadata) throw new Error('الورقة المطلوبة لا تنتمي إلى دفعة الاستيراد المحددة.');
  const rows = database.prepare(
    'SELECT row_number, is_hidden, has_formula, cell_count, cells_json FROM workbook_import_rows WHERE batch_id = ? AND sheet_id = ? ORDER BY row_number LIMIT ?'
  ).all(batch, sheet, bounded).map(row => {
    const allCells = JSON.parse(row.cells_json);
    return {
      rowNumber: row.row_number,
      hidden: Boolean(row.is_hidden),
      hasFormula: Boolean(row.has_formula),
      cellCount: row.cell_count,
      cells: allCells.slice(0, 24),
      cellsTruncated: allCells.length > 24,
    };
  });
  return { batchId: batch, sheet: metadata, rows, limit: bounded, truncated: rows.length < metadata.nonempty_row_count };
}


function safeJsonParse(value, fallback = null) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function stagedHeaderCells(database, sheetId, headerRow) {
  const stored = database.prepare('SELECT cells_json FROM workbook_import_rows WHERE sheet_id = ? AND row_number = ?').get(sheetId, headerRow);
  if (!stored) return [];
  return safeJsonParse(stored.cells_json, []).map(cell => ({
    address: cell.address, column: Number(cell.column), label: String(cell.text ?? '').trim(), formula: cell.formula ?? null,
  })).filter(cell => cell.column > 0 && cell.label);
}

function listWorkbookImportRegions(database, batchId) {
  const id = Number(batchId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('معرّف دفعة الاستيراد غير صالح.');
  const batch = database.prepare('SELECT id,file_name,status,truncated,created_at FROM workbook_import_batches WHERE id = ?').get(id);
  if (!batch) throw new Error('دفعة الاستيراد المطلوبة غير موجودة.');
  const rows = database.prepare('SELECT r.id,r.sheet_id,r.region_index,r.header_row,r.first_data_row,r.last_data_row,r.candidate_type,r.match_count,r.confidence,r.mapping_json,r.review_status,s.name AS sheet_name,s.state AS sheet_state,s.truncated AS sheet_truncated FROM workbook_import_regions r JOIN workbook_import_sheets s ON s.id = r.sheet_id WHERE r.batch_id = ? ORDER BY s.sheet_index,r.region_index').all(id);
  return {
    batch,
    regions: rows.map(region => {
      const totalRows = database.prepare('SELECT COUNT(*) AS count FROM workbook_import_rows WHERE batch_id = ? AND sheet_id = ? AND row_number BETWEEN ? AND ?')
        .get(id, region.sheet_id, region.first_data_row, region.last_data_row).count;
      const promotedRows = database.prepare('SELECT COUNT(*) AS count FROM workbook_import_promotions WHERE region_id = ?').get(region.id).count;
      return {
        id: region.id, sheetId: region.sheet_id, sheetName: region.sheet_name, sheetState: region.sheet_state,
        sheetTruncated: Boolean(region.sheet_truncated), regionIndex: region.region_index,
        headerRow: region.header_row, firstDataRow: region.first_data_row, lastDataRow: region.last_data_row,
        candidateType: region.candidate_type, matchCount: region.match_count, confidence: Number(region.confidence ?? 0),
        reviewStatus: region.review_status, totalRows, promotedRows,
        headers: stagedHeaderCells(database, region.sheet_id, region.header_row),
      };
    }),
  };
}

function readWorkbookImportRegion(database, batchId, regionId, offset = 0, limit = 30) {
  const batch = Number(batchId), region = Number(regionId);
  const start = Math.max(0, Math.min(1000000, Number(offset) || 0));
  const bounded = Math.max(1, Math.min(100, Number(limit) || 30));
  if (!Number.isSafeInteger(batch) || batch <= 0 || !Number.isSafeInteger(region) || region <= 0) throw new Error('معرّف دفعة أو منطقة الاستيراد غير صالح.');
  const metadata = database.prepare('SELECT r.*,s.name AS sheet_name,s.state AS sheet_state,s.truncated AS sheet_truncated FROM workbook_import_regions r JOIN workbook_import_sheets s ON s.id = r.sheet_id WHERE r.id = ? AND r.batch_id = ?').get(region, batch);
  if (!metadata) throw new Error('منطقة البيانات لا تنتمي إلى دفعة الاستيراد المحددة.');
  const totalRows = database.prepare('SELECT COUNT(*) AS count FROM workbook_import_rows WHERE batch_id = ? AND sheet_id = ? AND row_number BETWEEN ? AND ?')
    .get(batch, metadata.sheet_id, metadata.first_data_row, metadata.last_data_row).count;
  const rows = database.prepare('SELECT id,row_number,is_hidden,has_formula,cell_count,cells_json FROM workbook_import_rows WHERE batch_id = ? AND sheet_id = ? AND row_number BETWEEN ? AND ? ORDER BY row_number LIMIT ? OFFSET ?')
    .all(batch, metadata.sheet_id, metadata.first_data_row, metadata.last_data_row, bounded, start);
  const promoted = new Set(database.prepare('SELECT row_id FROM workbook_import_promotions WHERE region_id = ?').all(region).map(row => row.row_id));
  return {
    batchId: batch, regionId: region,
    sheet: { id: metadata.sheet_id, name: metadata.sheet_name, state: metadata.sheet_state, truncated: Boolean(metadata.sheet_truncated) },
    headerRow: metadata.header_row, headers: stagedHeaderCells(database, metadata.sheet_id, metadata.header_row),
    totalRows, offset: start, limit: bounded, hasPrevious: start > 0, hasNext: start + rows.length < totalRows,
    rows: rows.map(row => ({
      id: row.id, rowNumber: row.row_number, hidden: Boolean(row.is_hidden), hasFormula: Boolean(row.has_formula),
      cellCount: row.cell_count, promoted: promoted.has(row.id),
      cells: safeJsonParse(row.cells_json, []).slice(0, 80).map(cell => ({
        address: cell.address, column: Number(cell.column), text: String(cell.text ?? ''),
        formula: cell.formula ?? null, cachedResult: cell.cachedResult ?? null, rawValue: cell.rawValue ?? null,
      })),
    })),
  };
}

const PROJECT_IMPORT_FIELDS = Object.freeze([
  { key: 'project_name', label: 'اسم المشروع', required: true },
  { key: 'project_code', label: 'رمز المشروع' },
  { key: 'description', label: 'وصف المشروع' },
  { key: 'status', label: 'حالة المشروع' },
  { key: 'estimated_cost', label: 'التكلفة التقديرية' },
  { key: 'actual_cost', label: 'التكلفة الفعلية' },
  { key: 'currency_code', label: 'رمز العملة (مثل USD)' },
  { key: 'start_date', label: 'تاريخ البداية' },
  { key: 'end_date', label: 'تاريخ النهاية' },
  { key: 'governorate', label: 'المحافظة (مرجعية)' },
  { key: 'district', label: 'المديرية (مرجعية)' },
  { key: 'sector', label: 'القطاع (مرجعي)' },
  { key: 'funding_partner', label: 'جهة التمويل' },
  { key: 'funding_amount', label: 'مبلغ التمويل' },
  { key: 'funding_currency', label: 'عملة التمويل' },
]);

function westernizeDigits(value) {
  return String(value ?? '')
    .replace(/[٠-٩]/g, digit => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)))
    .replace(/[۰-۹]/g, digit => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit)));
}

function parseProjectNumber(value, label) {
  const textValue = westernizeDigits(value).trim().replace(/[\u00a0\s]/g, '').replace(/\u066b/g, '.');
  if (!textValue) return { value: null, error: null };
  if (!/^[+-]?(?:\d+|\d{1,3}(?:[,٬]\d{3})+)(?:\.\d+)?$/.test(textValue)) return { value: null, error: 'قيمة ' + label + ' ليست رقمًا واضحًا.' };
  const number = Number(textValue.replace(/[,٬]/g, ''));
  if (!Number.isFinite(number) || number < 0) return { value: null, error: 'قيمة ' + label + ' يجب أن تكون رقمًا موجبًا أو صفرًا.' };
  return { value: number, error: null };
}

function parseProjectDate(value, label) {
  const textValue = westernizeDigits(value).trim();
  if (!textValue) return { value: null, error: null };
  const match = textValue.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:T.*)?$/);
  if (!match) return { value: null, error: 'صيغة ' + label + ' غير مدعومة؛ استخدم YYYY-MM-DD.' };
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return { value: null, error: 'تاريخ ' + label + ' غير صالح.' };
  return { value: year.toString().padStart(4, '0') + '-' + String(month).padStart(2, '0') + '-' + String(day).padStart(2, '0'), error: null };
}

/** Promote only explicitly approved, visible, non-formula rows into canonical projects. */
function promoteProjectRegion(database, request = {}) {
  const batchId = Number(request.batchId), regionId = Number(request.regionId);
  const approvedRows = Array.isArray(request.approvedRows) ? request.approvedRows : [];
  if (!Number.isSafeInteger(batchId) || batchId <= 0 || !Number.isSafeInteger(regionId) || regionId <= 0) throw new Error('معرّف دفعة أو منطقة الاستيراد غير صالح.');
  if (approvedRows.length < 1 || approvedRows.length > 500) throw new Error('اختر صفًا واحدًا على الأقل، وبحد أقصى 500 صف في العملية.');
  const normalizedRows = approvedRows.map(Number);
  if (normalizedRows.some(row => !Number.isSafeInteger(row) || row <= 0) || new Set(normalizedRows).size !== normalizedRows.length) throw new Error('قائمة الصفوف المعتمدة تحتوي أرقامًا غير صالحة أو مكررة.');

  const inputMap = request.columnMap && typeof request.columnMap === 'object' ? request.columnMap : {};
  const allowed = new Set(PROJECT_IMPORT_FIELDS.map(field => field.key));
  const columnMap = {};
  for (const [field, sourceColumn] of Object.entries(inputMap)) {
    if (!allowed.has(field)) throw new Error('حقل مشروع غير مدعوم في خريطة الاستيراد: ' + field);
    const column = Number(sourceColumn);
    if (!Number.isSafeInteger(column) || column < 1 || column > LIMITS.columnsPerSheet) throw new Error('رقم عمود غير صالح في خريطة الاستيراد.');
    columnMap[field] = column;
  }
  if (!columnMap.project_name) throw new Error('اربط عمود «اسم المشروع» قبل الاعتماد.');
  if (new Set(Object.values(columnMap)).size !== Object.values(columnMap).length) throw new Error('لا يمكن ربط العمود نفسه بأكثر من حقل.');

  const region = database.prepare('SELECT r.*,s.name AS sheet_name,s.state AS sheet_state,b.source_id,b.file_name FROM workbook_import_regions r JOIN workbook_import_sheets s ON s.id = r.sheet_id JOIN workbook_import_batches b ON b.id = r.batch_id WHERE r.id = ? AND r.batch_id = ?')
    .get(regionId, batchId);
  if (!region) throw new Error('منطقة البيانات لا تنتمي إلى دفعة الاستيراد المحددة.');
  if (region.candidate_type !== 'project-candidate') throw new Error('هذه المنطقة لم تُصنّف كجدول مشاريع؛ لا يمكن ترحيلها إلى كيان المشاريع دون تصنيف ومراجعة منفصلين.');
  if (region.sheet_state !== 'visible') throw new Error('لا يمكن اعتماد صفوف ورقة مخفية قبل إظهارها وفحصها يدويًا.');
  const headers = stagedHeaderCells(database, region.sheet_id, region.header_row);
  const headerColumns = new Set(headers.map(cell => cell.column));
  for (const column of Object.values(columnMap)) if (!headerColumns.has(column)) throw new Error('الخريطة تشير إلى عمود لا يحتوي عنوانًا في صف الرؤوس المحدد.');

  const placeholders = normalizedRows.map(() => '?').join(',');
  const requested = database.prepare('SELECT * FROM workbook_import_rows WHERE batch_id = ? AND sheet_id = ? AND row_number BETWEEN ? AND ? AND row_number IN (' + placeholders + ') ORDER BY row_number')
    .all(batchId, region.sheet_id, region.first_data_row, region.last_data_row, ...normalizedRows);
  if (requested.length !== normalizedRows.length) throw new Error('بعض الصفوف المختارة لا تنتمي إلى المنطقة أو تتجاوز حدود الفحص المحفوظة.');
  const batch = database.prepare('SELECT source_id FROM workbook_import_batches WHERE id = ?').get(batchId);
  const refused = [];
  const prepared = [];
  const seenCodes = new Set();
  const seenSourceNames = new Set();

  for (const row of requested) {
    const refuse = (reason) => refused.push({ rowNumber: row.row_number, reason });
    if (row.is_hidden) { refuse('صف مخفي؛ يلزم إظهاره ومراجعته قبل الاعتماد.'); continue; }
    if (row.has_formula) { refuse('يحتوي الصف على صيغة؛ لا تُعتمد نتائج الصيغ المخزنة تلقائيًا.'); continue; }
    const cells = safeJsonParse(row.cells_json, []);
    const byColumn = new Map(cells.map(cell => [Number(cell.column), cell]));
    const value = (field) => {
      const cell = byColumn.get(columnMap[field]);
      if (!cell) return '';
      if (cell.rawValue && typeof cell.rawValue === 'object' && cell.rawValue.type === 'invalid-date') return '[تاريخ غير صالح]';
      return String(cell.text ?? '').trim();
    };
    const values = {};
    for (const field of Object.keys(columnMap)) values[field] = value(field);
    const name = values.project_name ?? '';
    if (!name) { refuse('اسم المشروع فارغ.'); continue; }
    if (name.length > 240) { refuse('اسم المشروع يتجاوز 240 حرفًا.'); continue; }
    if ((values.project_code ?? '').length > 80) { refuse('رمز المشروع يتجاوز 80 حرفًا.'); continue; }
    if ((values.description ?? '').length > 4000) { refuse('وصف المشروع يتجاوز 4000 حرف.'); continue; }
    if ((values.status ?? '').length > 80) { refuse('حالة المشروع تتجاوز 80 حرفًا.'); continue; }
    const estimated = parseProjectNumber(values.estimated_cost, 'التكلفة التقديرية');
    const actual = parseProjectNumber(values.actual_cost, 'التكلفة الفعلية');
    const funding = parseProjectNumber(values.funding_amount, 'مبلغ التمويل');
    const start = parseProjectDate(values.start_date, 'تاريخ البداية');
    const end = parseProjectDate(values.end_date, 'تاريخ النهاية');
    const error = estimated.error ?? actual.error ?? funding.error ?? start.error ?? end.error;
    if (error) { refuse(error); continue; }
    if (start.value && end.value && start.value > end.value) { refuse('تاريخ البداية يأتي بعد تاريخ النهاية.'); continue; }
    const currency = (values.currency_code ?? '').trim().toUpperCase();
    const fundingCurrency = (values.funding_currency ?? currency).trim().toUpperCase();
    if (currency && !/^[A-Z]{3}$/.test(currency)) { refuse('رمز العملة يجب أن يتكون من ثلاثة أحرف لاتينية مثل USD.'); continue; }
    if (fundingCurrency && !/^[A-Z]{3}$/.test(fundingCurrency)) { refuse('رمز عملة التمويل يجب أن يتكون من ثلاثة أحرف لاتينية مثل USD.'); continue; }
    if ((estimated.value !== null || actual.value !== null) && !currency) { refuse('أدخل رمز عملة التكلفة؛ لا يفترض النظام عملة تلقائيًا.'); continue; }
    if (funding.value !== null && !(values.funding_partner ?? '').trim()) { refuse('تم إدخال مبلغ تمويل دون تحديد جهة التمويل.'); continue; }
    if (funding.value !== null && !fundingCurrency) { refuse('أدخل عملة مبلغ التمويل؛ لا تُفترض العملة من البلد.'); continue; }
    const code = (values.project_code ?? '').trim() || null;
    const sourceLocation = region.sheet_name + '!row-' + row.row_number;
    if (database.prepare('SELECT id FROM workbook_import_promotions WHERE row_id = ?').get(row.id)) { refuse('هذا الصف سبق اعتماده في قاعدة البيانات.'); continue; }
    if (code && (seenCodes.has(code) || database.prepare('SELECT id FROM projects WHERE code = ?').get(code))) { refuse('رمز المشروع موجود مسبقًا أو مكرر داخل الملف؛ يلزم حسم التعارض يدويًا.'); continue; }
    if (!code && batch.source_id && (seenSourceNames.has(name) || database.prepare('SELECT id FROM projects WHERE source_id = ? AND name = ?').get(batch.source_id, name))) { refuse('اسم المشروع نفسه سبق استيراده من هذا الملف أو تكرر داخله.'); continue; }
    if (code) seenCodes.add(code);
    else if (batch.source_id) seenSourceNames.add(name);

    let geographicUnitId = null;
    const district = (values.district ?? '').trim(), governorate = (values.governorate ?? '').trim();
    if (district) {
      const matches = database.prepare("SELECT child.id FROM geographic_units child LEFT JOIN geographic_units parent ON parent.id = child.parent_id WHERE child.unit_type IN ('district','directorate') AND child.normalized_name = ? AND (? = '' OR parent.normalized_name = ?) LIMIT 2")
        .all(normalizeLabel(district), governorate, normalizeLabel(governorate));
      if (matches.length === 1) geographicUnitId = matches[0].id;
    }
    let sectorId = null;
    const sector = (values.sector ?? '').trim();
    if (sector) {
      const matches = database.prepare('SELECT id FROM sectors WHERE name_ar = ? OR code = ? LIMIT 2').all(sector, sector);
      if (matches.length === 1) sectorId = matches[0].id;
    }
    prepared.push({
      rowId: row.id, rowNumber: row.row_number, name, code,
      description: values.description || null, status: values.status || 'draft',
      estimatedCost: estimated.value, actualCost: actual.value, currencyCode: currency || null,
      startDate: start.value, endDate: end.value, geographicUnitId, sectorId,
      fundingPartner: (values.funding_partner ?? '').trim(), fundingAmount: funding.value,
      fundingCurrency: fundingCurrency || null, values, sourceLocation, mapping: columnMap,
      district, sector,
    });
  }

  const now = new Date().toISOString();
  return database.transaction(() => {
    dataArchitecture.recordImportMappingDecisions(database,batchId,regionId,'project',columnMap,'local-user',now);
    const currentMapping = safeJsonParse(region.mapping_json, {});
    database.prepare('UPDATE workbook_import_regions SET mapping_json = ?, review_status = ? WHERE id = ?')
      .run(json({ ...currentMapping, approvedMapping: { entityType: 'project', columns: columnMap, approvedAt: now } }), 'mapped', regionId);
    const insertProject = database.prepare('INSERT INTO projects (code,name,description,geographic_unit_id,sector_id,status,estimated_cost,actual_cost,currency_code,start_date,end_date,source_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    const insertFunding = database.prepare('INSERT INTO project_funding (project_id,partner_name,amount,currency_code,funding_date,source_id,created_at) VALUES (?,?,?,?,?,?,?)');
    const insertPromotion = database.prepare("INSERT INTO workbook_import_promotions (batch_id,region_id,row_id,entity_type,target_id,source_location,mapping_json,mapped_values_json,created_at) VALUES (?,?,?,'project',?,?,?,?,?)");
    const insertIssue = database.prepare("INSERT INTO data_quality_issues (batch_id,sheet_id,row_id,severity,issue_code,message,status,created_at) VALUES (?,?,?,'warning',?,?,'open',?)");
    const applied = [];
    for (const item of prepared) {
      const created = insertProject.run(item.code,item.name,item.description,item.geographicUnitId,item.sectorId,item.status,
        item.estimatedCost,item.actualCost,item.currencyCode,item.startDate,item.endDate,batch.source_id,now,now);
      const projectId = Number(created.lastInsertRowid);
      if (item.fundingPartner && item.fundingAmount !== null) insertFunding.run(projectId,item.fundingPartner,item.fundingAmount,item.fundingCurrency,null,batch.source_id,now);
      insertPromotion.run(batchId,regionId,item.rowId,projectId,item.sourceLocation,json(item.mapping),json(item.values),now);
      if (item.district && !item.geographicUnitId) insertIssue.run(batchId,region.sheet_id,item.rowId,'unmatched-project-geography','تعذّر ربط المديرية «' + item.district + '» بمرجع جغرافي معتمد؛ حُفظ المشروع دون ربط جغرافي.',now);
      if (item.sector && !item.sectorId) insertIssue.run(batchId,region.sheet_id,item.rowId,'unmatched-project-sector','القطاع «' + item.sector + '» غير موجود في قاموس القطاعات؛ حُفظت قيمته في بيانات المصدر للمراجعة.',now);
      applied.push({ rowNumber: item.rowNumber, projectId });
    }
    dataArchitecture.syncDomainRecords(database,{ projectIds:applied.map(item => item.projectId) });
    const totalRegionRows = database.prepare('SELECT COUNT(*) AS count FROM workbook_import_rows WHERE batch_id = ? AND sheet_id = ? AND row_number BETWEEN ? AND ?')
      .get(batchId,region.sheet_id,region.first_data_row,region.last_data_row).count;
    const promotedCount = database.prepare('SELECT COUNT(*) AS count FROM workbook_import_promotions WHERE region_id = ?').get(regionId).count;
    const status = refused.length ? (applied.length ? 'projects-partially-promoted' : 'projects-review-required')
      : (promotedCount >= totalRegionRows ? 'projects-promoted' : 'projects-partially-promoted');
    database.prepare('UPDATE workbook_import_regions SET review_status = ? WHERE id = ?')
      .run(promotedCount >= totalRegionRows ? 'promoted' : (promotedCount > 0 ? 'partially-promoted' : 'mapped'), regionId);
    const previousBatch = database.prepare('SELECT result_json FROM workbook_import_batches WHERE id = ?').get(batchId);
    const previousResult = safeJsonParse(previousBatch?.result_json, {}) ?? {};
    const projectPromotion = {
      regionId,
      applied,
      refused,
      skipped: Math.max(0,totalRegionRows-normalizedRows.length),
      status,
      promotedAt: now,
    };
    const projectPromotions = Array.isArray(previousResult.projectPromotions) ? previousResult.projectPromotions : [];
    const combinedResult = { ...previousResult, projectPromotions: [...projectPromotions, projectPromotion] };
    const priorDirectorate = previousResult.directorateImport;
    const directoratesApplied = Number(priorDirectorate?.applied ?? 0);
    const directoratesPartial = Number(priorDirectorate?.refused?.length ?? 0) > 0
      || Number(priorDirectorate?.skipped?.length ?? 0) > 0;
    const batchStatus = directoratesApplied > 0
      ? (directoratesPartial || refused.length > 0 || normalizedRows.length < totalRegionRows
        ? 'directorates-and-projects-partially-applied' : 'directorates-and-projects-applied')
      : status;
    database.prepare('UPDATE workbook_import_batches SET status = ?,result_json = ?,updated_at = ? WHERE id = ?')
      .run(batchStatus,json(combinedResult),now,batchId);
    return { applied, refused, skipped: Math.max(0,totalRegionRows-normalizedRows.length), total: normalizedRows.length, status };
  })();
}


function exactIndicator(database, value) {
  const normalized = normalizeLabel(value);
  if (!normalized) return null;
  const matches = database.prepare('SELECT id,code,label_ar,unit FROM indicator_definitions WHERE active=1').all()
    .filter(item => normalizeLabel(item.code) === normalized || normalizeLabel(item.label_ar) === normalized);
  return matches.length === 1 ? matches[0] : null;
}

function exactGeographicMatch(database, districtValue, governorateValue) {
  const districtName = String(districtValue ?? '').trim();
  const governorateName = String(governorateValue ?? '').trim();
  if (!districtName) return null;
  const districts = database.prepare("SELECT unit.name AS district,governorate.name AS governorate FROM geographic_units unit LEFT JOIN geographic_units governorate ON governorate.id=unit.parent_id WHERE unit.unit_type='district'").all()
    .filter(item => normalizeLabel(item.district) === normalizeLabel(districtName)
      && (!governorateName || normalizeLabel(item.governorate) === normalizeLabel(governorateName)));
  return districts.length === 1 ? districts[0] : null;
}

function ensureGeographicUnit(database, matched) {
  const now = new Date().toISOString();
  let parentId = null;
  if (matched.governorate) {
    database.prepare("INSERT OR IGNORE INTO geographic_units (unit_type,name,normalized_name,created_at,updated_at) VALUES ('governorate',?,?,?,?)")
      .run(matched.governorate, normalizeLabel(matched.governorate), now, now);
    parentId = database.prepare("SELECT id FROM geographic_units WHERE unit_type='governorate' AND parent_id IS NULL AND normalized_name=?")
      .get(normalizeLabel(matched.governorate))?.id ?? null;
  }
  database.prepare("INSERT OR IGNORE INTO geographic_units (parent_id,unit_type,name,normalized_name,created_at,updated_at) VALUES (?,'district',?,?,?,?)")
    .run(parentId, matched.district, normalizeLabel(matched.district), now, now);
  return database.prepare("SELECT id FROM geographic_units WHERE unit_type='district' AND IFNULL(parent_id,0)=IFNULL(?,0) AND normalized_name=?")
    .get(parentId, normalizeLabel(matched.district))?.id ?? null;
}

function findGeographicUnit(database, matched) {
  let parentId = null;
  if (matched.governorate) {
    parentId = database.prepare("SELECT id FROM geographic_units WHERE unit_type='governorate' AND parent_id IS NULL AND normalized_name=?")
      .get(normalizeLabel(matched.governorate))?.id ?? null;
    if (!parentId) return null;
  }
  return database.prepare("SELECT id FROM geographic_units WHERE unit_type='district' AND IFNULL(parent_id,0)=IFNULL(?,0) AND normalized_name=?")
    .get(parentId, normalizeLabel(matched.district))?.id ?? null;
}

function promoteIndicatorRegion(database, request = {}) {
  const batchId = Number(request.batchId), regionId = Number(request.regionId);
  const approvedRows = Array.isArray(request.approvedRows) ? request.approvedRows : [];
  if (!Number.isSafeInteger(batchId) || batchId <= 0 || !Number.isSafeInteger(regionId) || regionId <= 0) throw new Error('معرّف دفعة أو منطقة الاستيراد غير صالح.');
  if (approvedRows.length < 1 || approvedRows.length > 500) throw new Error('اختر صفًا واحدًا على الأقل، وبحد أقصى 500 صف في العملية.');
  const rowNumbers = approvedRows.map(Number);
  if (rowNumbers.some(row => !Number.isSafeInteger(row) || row <= 0) || new Set(rowNumbers).size !== rowNumbers.length) throw new Error('قائمة الصفوف المعتمدة تحتوي أرقامًا غير صالحة أو مكررة.');
  const allowedFields = new Set(['indicator','governorate','district','period_key','value','unit']);
  const inputMap = request.columnMap && typeof request.columnMap === 'object' ? request.columnMap : {};
  const columnMap = {};
  for (const [field, sourceColumn] of Object.entries(inputMap)) {
    if (!allowedFields.has(field)) throw new Error('حقل مؤشر غير مدعوم في خريطة الاستيراد: ' + field);
    const column = Number(sourceColumn);
    if (!Number.isSafeInteger(column) || column < 1 || column > LIMITS.columnsPerSheet) throw new Error('رقم عمود غير صالح في خريطة الاستيراد.');
    columnMap[field] = column;
  }
  for (const field of ['indicator','district','period_key','value']) if (!columnMap[field]) throw new Error('اربط الحقول الإلزامية للمؤشر قبل الاعتماد: اسم المؤشر، المديرية، الفترة، والقيمة.');
  if (new Set(Object.values(columnMap)).size !== Object.values(columnMap).length) throw new Error('لا يمكن ربط العمود نفسه بأكثر من حقل.');
  const region = database.prepare('SELECT r.*,s.name AS sheet_name,s.sheet_index,s.state AS sheet_state,b.source_id FROM workbook_import_regions r JOIN workbook_import_sheets s ON s.id=r.sheet_id JOIN workbook_import_batches b ON b.id=r.batch_id WHERE r.id=? AND r.batch_id=?').get(regionId,batchId);
  if (!region) throw new Error('منطقة البيانات لا تنتمي إلى دفعة الاستيراد المحددة.');
  if (region.candidate_type !== 'indicator-candidate') throw new Error('المنطقة ليست مرشحة للمؤشرات.');
  if (region.sheet_state !== 'visible') throw new Error('لا يمكن اعتماد صفوف ورقة مخفية قبل إظهارها ومراجعتها.');
  const headerColumns = new Set(stagedHeaderCells(database,region.sheet_id,region.header_row).map(cell => cell.column));
  for (const column of Object.values(columnMap)) if (!headerColumns.has(column)) throw new Error('الخريطة تشير إلى عمود لا يحتوي عنوانًا في صف الرؤوس المحدد.');
  const placeholders = rowNumbers.map(() => '?').join(',');
  const rows = database.prepare('SELECT * FROM workbook_import_rows WHERE batch_id=? AND sheet_id=? AND row_number BETWEEN ? AND ? AND row_number IN (' + placeholders + ') ORDER BY row_number')
    .all(batchId,region.sheet_id,region.first_data_row,region.last_data_row,...rowNumbers);
  if (rows.length !== rowNumbers.length) throw new Error('بعض الصفوف المختارة لا تنتمي إلى المنطقة المحددة.');
  const prepared = [], refused = [], preparedKeys = new Set();
  for (const row of rows) {
    const refuse = reason => refused.push({ rowNumber: row.row_number, reason });
    if (row.is_hidden) { refuse('صف مخفي؛ يلزم مراجعته قبل الاعتماد.'); continue; }
    if (row.has_formula) { refuse('صف يتضمن صيغة؛ لا تُعتمد القيم المخزنة تلقائيًا.'); continue; }
    const cells = new Map(safeJsonParse(row.cells_json,[]).map(cell => [Number(cell.column),cell]));
    const value = field => String(cells.get(columnMap[field])?.text ?? '').trim();
    const indicator = exactIndicator(database,value('indicator'));
    if (!indicator) { refuse('لم يطابق اسم أو رمز المؤشر تعريفًا معتمدًا وحيدًا.'); continue; }
    const period = value('period_key');
    if (!period || period.length > 80) { refuse('الفترة مطلوبة وبحد أقصى 80 حرفًا.'); continue; }
    const parsed = parseProjectNumber(value('value'),'قيمة المؤشر');
    if (parsed.error || parsed.value === null) { refuse(parsed.error || 'قيمة المؤشر مطلوبة.'); continue; }
    const sourceUnit = value('unit');
    if (sourceUnit && indicator.unit && normalizeLabel(sourceUnit) !== normalizeLabel(indicator.unit)) { refuse('وحدة الملف لا تطابق وحدة المؤشر المعتمد؛ لم يُجر تحويل تلقائي.'); continue; }
    if (String(indicator.unit ?? '').includes('%') && parsed.value > 100) { refuse('قيمة النسبة المئوية تتجاوز 100.'); continue; }
    const geographic = exactGeographicMatch(database,value('district'),value('governorate'));
    if (!geographic) { refuse('تعذر ربط المديرية بمحافظة واحدة معتمدة بالاسم؛ يلزم حسم الهوية يدويًا.'); continue; }
    const geographicUnitId = findGeographicUnit(database,geographic);
    const observationKey = [indicator.id,normalizeLabel(geographic.governorate),normalizeLabel(geographic.district),period].join('|');
    if ((geographicUnitId && database.prepare('SELECT id FROM indicator_observations WHERE indicator_id=? AND geographic_unit_id=? AND period_key=?').get(indicator.id,geographicUnitId,period)) || preparedKeys.has(observationKey)) {
      refuse('توجد قيمة معتمدة أو مكررة للمؤشر والمديرية والفترة نفسها؛ راجع التعارض قبل الاعتماد.');
      continue;
    }
    if (database.prepare('SELECT id FROM workbook_import_promotions WHERE row_id=?').get(row.id)) { refuse('هذا الصف سبق اعتماده في كيان آخر.'); continue; }
    preparedKeys.add(observationKey);
    prepared.push({ rowId: row.id,rowNumber: row.row_number,indicator,geographic,geographicUnitId,period,value: parsed.value,sourceLocation: region.sheet_name + '!row-' + row.row_number,columnMap });
  }
  const now = new Date().toISOString();
  return database.transaction(() => {
    dataArchitecture.recordImportMappingDecisions(database,batchId,regionId,'indicator_observation',columnMap,'local-user',now);
    const insert = database.prepare('INSERT INTO indicator_observations (indicator_id,geographic_unit_id,period_key,value_number,value_state,source_id,source_location,created_at) VALUES (?,?,?,? ,\'known\',?,?,?)');
    const promotion = database.prepare("INSERT INTO workbook_import_promotions (batch_id,region_id,row_id,entity_type,target_id,source_location,mapping_json,mapped_values_json,created_at) VALUES (?,?,?,'indicator_observation',?,?,?,?,?)");
    const applied = [];
    for (const item of prepared) {
      const geographicUnitId = item.geographicUnitId ?? ensureGeographicUnit(database,item.geographic);
      if (!geographicUnitId) throw new Error('تعذر إنشاء المرجع الجغرافي المعياري داخل المعاملة.');
      const created = insert.run(item.indicator.id,geographicUnitId,item.period,item.value,region.source_id,item.sourceLocation,now);
      const observationId = Number(created.lastInsertRowid);
      promotion.run(batchId,regionId,item.rowId,observationId,item.sourceLocation,json(item.columnMap),json({ indicator: item.indicator.code,period: item.period,value: item.value }),now);
      applied.push({ rowNumber: item.rowNumber, observationId });
    }
    dataArchitecture.syncDomainRecords(database,{ indicatorObservationIds:applied.map(item => item.observationId) });
    const regionRows = database.prepare('SELECT COUNT(*) AS n FROM workbook_import_rows WHERE batch_id=? AND sheet_id=? AND row_number BETWEEN ? AND ?').get(batchId,region.sheet_id,region.first_data_row,region.last_data_row).n;
    const promotedCount = database.prepare('SELECT COUNT(*) AS n FROM workbook_import_promotions WHERE region_id=?').get(regionId).n;
    const status = refused.length ? (applied.length ? 'indicators-partially-promoted' : 'indicators-review-required')
      : (promotedCount >= regionRows ? 'indicators-promoted' : 'indicators-partially-promoted');
    database.prepare('UPDATE workbook_import_regions SET mapping_json=?,review_status=? WHERE id=?')
      .run(json({ ...safeJsonParse(region.mapping_json,{}),approvedMapping:{entityType:'indicator_observation',columns:columnMap,approvedAt:now} }),promotedCount >= regionRows ? 'promoted' : (promotedCount ? 'partially-promoted' : 'mapped'),regionId);
    const previous = safeJsonParse(database.prepare('SELECT result_json FROM workbook_import_batches WHERE id=?').get(batchId)?.result_json,{}) ?? {};
    const indicatorPromotions = Array.isArray(previous.indicatorPromotions) ? previous.indicatorPromotions : [];
    indicatorPromotions.push({ regionId,applied,refused,skipped:Math.max(0,regionRows-rowNumbers.length),status,promotedAt:now });
    database.prepare('UPDATE workbook_import_batches SET status=?,result_json=?,updated_at=? WHERE id=?')
      .run(status,json({ ...previous,indicatorPromotions }),now,batchId);
    return { applied,refused,skipped:Math.max(0,regionRows-rowNumbers.length),total:rowNumbers.length,status };
  })();
}

function listCanonicalReferences(database) {
  return {
    geographicUnits: database.prepare('SELECT id,unit_type,name,parent_id FROM geographic_units ORDER BY unit_type,name').all(),
    sectors: database.prepare("SELECT id,code,name_ar FROM sectors WHERE active=1 AND code NOT LIKE 'form-range-%' ORDER BY name_ar").all(),
    indicators: database.prepare('SELECT id,code,label_ar,unit,direction FROM indicator_definitions WHERE active=1 ORDER BY label_ar').all(),
  };
}

function listIndicatorObservations(database, request = {}) {
  const limit = Math.max(1, Math.min(100, Number(request.limit) || 30));
  const offset = Math.max(0, Math.min(1000000, Number(request.offset) || 0));
  const search = String(request.search ?? '').trim().slice(0, 120);
  const indicatorId = request.indicatorId == null || request.indicatorId === '' ? null : Number(request.indicatorId);
  const conditions = ['record.record_status=\'approved\''];
  const params = [];
  if (search) {
    conditions.push("(instr(lower(indicator.label_ar),lower(?))>0 OR instr(lower(geo.name),lower(?))>0 OR instr(lower(coalesce(governorate.name,'')),lower(?))>0 OR instr(lower(iv.period_key),lower(?))>0)");
    params.push(search,search,search,search);
  }
  if (indicatorId !== null) {
    if (!Number.isSafeInteger(indicatorId) || indicatorId <= 0) throw new Error('معرّف المؤشر غير صالح.');
    conditions.push('indicator.id=?');
    params.push(indicatorId);
  }
  const cte = `WITH indicator_values AS (
    SELECT record.form_record_id,record.geo_unit_id,record.record_status,
      MAX(CASE WHEN field.field_code='indicatorCode' THEN value.value_text END) AS indicator_code,
      MAX(CASE WHEN field.field_code='periodKey' THEN value.value_text END) AS period_key,
      MAX(CASE WHEN field.field_code='valueText' THEN value.value_text END) AS value_text,
      MAX(CASE WHEN field.field_code='valueState' THEN value.value_text END) AS value_state_text,
      MAX(CASE WHEN field.field_code='valueNumber' THEN observation.value_integer END) AS value_integer,
      MAX(CASE WHEN field.field_code='valueNumber' THEN observation.value_real END) AS value_real,
      MAX(CASE WHEN field.field_code='valueState' THEN value.value_text END) AS canonical_value_state,
      MAX(CASE WHEN field.field_code='valueNumber' THEN observation.source_id END) AS source_id,
      MAX(CASE WHEN field.field_code='valueNumber' THEN observation.observation_id END) AS value_observation_id
    FROM form_records record JOIN form_versions version USING(form_version_id) JOIN form_definitions form USING(form_id)
    JOIN form_fields field USING(form_version_id)
    LEFT JOIN record_field_values value ON value.form_record_id=record.form_record_id AND value.form_field_id=field.form_field_id
    LEFT JOIN observations observation ON observation.form_record_id=record.form_record_id AND observation.form_field_id=field.form_field_id
    WHERE form.form_code='indicator_observation_v1'
    GROUP BY record.form_record_id
  )`;
  const from = `FROM indicator_values iv JOIN form_records record USING(form_record_id)
    JOIN form_record_legacy_links link ON link.form_record_id=record.form_record_id AND link.legacy_entity_type='indicator_observation'
    JOIN indicator_definitions indicator ON indicator.code=iv.indicator_code
    JOIN geographic_units geo ON geo.geo_unit_id=record.geo_unit_id
    LEFT JOIN geographic_units governorate ON governorate.geo_unit_id=geo.parent_geo_unit_id
    LEFT JOIN data_sources source ON source.source_id=iv.source_id`;
  const where = `WHERE ${conditions.join(' AND ')}`;
  const total = database.prepare(`${cte} SELECT COUNT(*) AS count ${from} ${where}`).get(...params).count;
  const rows = database.prepare(`${cte} SELECT link.legacy_entity_id AS id,indicator.id AS indicator_id,geo.geo_unit_id AS geographic_unit_id,iv.period_key,
      coalesce(iv.value_integer,iv.value_real) AS value_number,iv.value_text,coalesce(iv.canonical_value_state,iv.value_state_text,'known') AS value_state,
      iv.source_id,(SELECT provenance.source_locator FROM value_provenance provenance WHERE provenance.observation_id=iv.value_observation_id ORDER BY provenance.provenance_id DESC LIMIT 1) AS source_location,
      record.created_at,indicator.code AS indicator_code,indicator.label_ar AS indicator_label,indicator.unit,geo.name AS district,governorate.name AS governorate,
      source.source_type,source.file_name AS source_file,source.document_title AS source_title,
      max(0,(SELECT COUNT(*) FROM record_revisions revision WHERE revision.form_record_id=record.form_record_id)-1) AS version_count
    ${from} ${where} ORDER BY record.updated_at DESC,record.form_record_id DESC LIMIT ? OFFSET ?`).all(...params,limit,offset);
  return { rows,total,limit,offset,hasPrevious:offset>0,hasNext:offset+rows.length<total };
}

function saveIndicatorObservation(database, request = {}) {
  const id = request.id == null || request.id === '' ? null : Number(request.id);
  if (id !== null && (!Number.isSafeInteger(id) || id <= 0)) throw new Error('معرّف القياس غير صالح.');
  const indicatorId = Number(request.indicator_id);
  const geographicUnitId = Number(request.geographic_unit_id);
  const period = String(request.period_key ?? '').trim();
  if (!Number.isSafeInteger(indicatorId) || indicatorId <= 0) throw new Error('اختر مؤشرًا معتمدًا.');
  if (!Number.isSafeInteger(geographicUnitId) || geographicUnitId <= 0) throw new Error('اختر مديرية معتمدة.');
  if (!period || period.length > 80) throw new Error('الفترة إلزامية وبحد أقصى 80 حرفًا.');
  const parsed = parseProjectNumber(request.value_number,'قيمة المؤشر');
  if (parsed.error || parsed.value === null) throw new Error(parsed.error ?? 'قيمة المؤشر إلزامية.');
  const now = new Date().toISOString();
  return database.transaction(() => {
    const indicator = database.prepare('SELECT id,label_ar,unit FROM indicator_definitions WHERE id=? AND active=1').get(indicatorId);
    if (!indicator) throw new Error('المؤشر غير موجود أو غير نشط.');
    if (indicator.unit === '%' && parsed.value > 100) throw new Error('قيمة النسبة المئوية تتجاوز 100.');
    const geographic = database.prepare("SELECT id FROM geographic_units WHERE id=? AND unit_type='district'").get(geographicUnitId);
    if (!geographic) throw new Error('يجب ربط القياس بمديرية معتمدة.');
    const previous = id ? database.prepare('SELECT * FROM indicator_observations WHERE id=?').get(id) : null;
    if (id && !previous) throw new Error('القياس المطلوب غير موجود.');
    const duplicate = database.prepare('SELECT id FROM indicator_observations WHERE indicator_id=? AND geographic_unit_id=? AND period_key=? AND id<>coalesce(?,0)')
      .get(indicatorId,geographicUnitId,period,id);
    if (duplicate) throw new Error('يوجد قياس آخر للمؤشر والمديرية والفترة نفسها.');
    const source = database.prepare("INSERT INTO data_sources (source_type,document_title,received_at,notes) VALUES ('manual-indicator-observation',?,?,?)")
      .run(id ? 'تعديل قياس مؤشر #' + id : 'إدخال يدوي لقياس مؤشر',now,id ? 'تعديل يدوي للقياس #' + id : 'إنشاء قياس مؤشر يدوي');
    const sourceId = Number(source.lastInsertRowid);
    let observationId = id;
    if (previous) {
      database.prepare('INSERT INTO indicator_observation_versions (observation_id,action,payload_json,source_id,created_at) VALUES (?,?,?,?,?)')
        .run(id,'manual-update',json(previous),sourceId,now);
      database.prepare('UPDATE indicator_observations SET indicator_id=?,geographic_unit_id=?,period_key=?,value_number=?,value_text=NULL,value_state=\'known\',source_id=?,source_location=? WHERE id=?')
        .run(indicatorId,geographicUnitId,period,parsed.value,sourceId,'إدخال يدوي',id);
    } else {
      const created = database.prepare('INSERT INTO indicator_observations (indicator_id,geographic_unit_id,period_key,value_number,value_state,source_id,source_location,created_at) VALUES (?,?,?,? ,\'known\',?,?,?)')
        .run(indicatorId,geographicUnitId,period,parsed.value,sourceId,'إدخال يدوي',now);
      observationId = Number(created.lastInsertRowid);
    }
    database.prepare('INSERT INTO access_log (action,entity,entity_id,fields,detail,created_at) VALUES (?,?,?,?,?,?)')
      .run(previous ? 'manual-update' : 'manual-create','indicator_observations',String(observationId),'indicator_id,geographic_unit_id,period_key,value_number','source=' + sourceId,now);
    dataArchitecture.syncDomainRecords(database,{ indicatorObservationIds:[observationId] });
    return { id:observationId,action:previous?'updated':'created',sourceId,updatedAt:now,unit:indicator.unit };
  })();
}

function listDataQualityIssues(database, request = {}) {
  const limit = Math.max(1,Math.min(100,Number(request.limit)||50));
  const offset = Math.max(0,Math.min(1000000,Number(request.offset)||0));
  const status = ['open','resolved','all'].includes(request.status) ? request.status : 'open';
  const severity = String(request.severity ?? '').trim();
  const conditions = [];
  const params = [];
  if (status !== 'all') { conditions.push('issue.status=?'); params.push(status); }
  if (severity) { conditions.push('issue.severity=?'); params.push(severity); }
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const from = `FROM data_quality_issues issue
    LEFT JOIN workbook_import_batches batch ON batch.id=issue.batch_id
    LEFT JOIN workbook_import_sheets sheet ON sheet.id=issue.sheet_id
    LEFT JOIN workbook_import_rows source_row ON source_row.id=issue.row_id
    LEFT JOIN workbook_import_promotions promotion ON promotion.row_id=issue.row_id
    LEFT JOIN projects project ON promotion.entity_type='project' AND project.id=promotion.target_id
    LEFT JOIN indicator_observations observation ON promotion.entity_type='indicator_observation' AND observation.id=promotion.target_id
    LEFT JOIN entity_records record ON record.id=issue.record_id
    LEFT JOIN data_field_definitions field ON field.id=issue.field_definition_id`;
  const total = database.prepare('SELECT COUNT(*) AS count ' + from + ' ' + where).get(...params).count;
  const rows = database.prepare(`SELECT issue.id,issue.batch_id,issue.sheet_id,issue.row_id,issue.record_id,issue.field_definition_id,
      issue.severity,issue.issue_code,issue.message,issue.status,issue.resolution,issue.created_at,issue.resolved_at,
      batch.file_name,sheet.name AS sheet_name,source_row.row_number,project.name AS project_name,
      observation.id AS observation_id,record.entity_type,record.external_key,field.label_ar AS field_label,
      promotion.entity_type AS promoted_entity_type,promotion.target_id
    ${from} ${where} ORDER BY CASE issue.status WHEN 'open' THEN 0 ELSE 1 END,issue.id DESC LIMIT ? OFFSET ?`).all(...params,limit,offset);
  return { rows,total,limit,offset,hasPrevious:offset>0,hasNext:offset+rows.length<total };
}

function resolveDataQualityIssue(database, issueId, resolution) {
  const id = Number(issueId);
  const note = String(resolution ?? '').trim();
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('معرّف ملاحظة الجودة غير صالح.');
  if (!note || note.length > 1000) throw new Error('سبب التسوية إلزامي وبحد أقصى 1000 حرف.');
  const now = new Date().toISOString();
  return database.transaction(() => {
    const issue = database.prepare('SELECT id,status FROM data_quality_issues WHERE id=?').get(id);
    if (!issue) throw new Error('ملاحظة الجودة غير موجودة.');
    if (issue.status !== 'open') throw new Error('ملاحظة الجودة ليست مفتوحة أو سبق تسويتها.');
    database.prepare("UPDATE data_quality_issues SET status='resolved',resolution=?,resolved_at=? WHERE id=? AND status='open'")
      .run(note,now,id);
    database.prepare('INSERT INTO access_log (action,entity,entity_id,fields,detail,created_at) VALUES (?,?,?,?,?,?)')
      .run('quality-resolved','data_quality_issues',String(id),'status,resolution','rationale-required',now);
    return { id,status:'resolved',resolvedAt:now };
  })();
}

function saveCanonicalProject(database, request = {}) {
  const id = request.id == null || request.id === '' ? null : Number(request.id);
  if (id !== null && (!Number.isSafeInteger(id) || id <= 0)) throw new Error('معرّف المشروع غير صالح.');
  const name = String(request.name ?? '').trim();
  const code = String(request.code ?? '').trim() || null;
  const description = String(request.description ?? '').trim() || null;
  const status = String(request.status ?? '').trim() || 'draft';
  if (!name || name.length > 240) throw new Error('اسم المشروع إلزامي وبحد أقصى 240 حرفًا.');
  if (code && code.length > 80) throw new Error('رمز المشروع يتجاوز 80 حرفًا.');
  if (description && description.length > 4000) throw new Error('وصف المشروع يتجاوز 4000 حرف.');
  if (status.length > 80) throw new Error('حالة المشروع تتجاوز 80 حرفًا.');
  const estimated = parseProjectNumber(request.estimated_cost, 'التكلفة التقديرية');
  const actual = parseProjectNumber(request.actual_cost, 'التكلفة الفعلية');
  const start = parseProjectDate(request.start_date, 'تاريخ البداية');
  const end = parseProjectDate(request.end_date, 'تاريخ النهاية');
  const validationError = estimated.error ?? actual.error ?? start.error ?? end.error;
  if (validationError) throw new Error(validationError);
  if (start.value && end.value && start.value > end.value) throw new Error('تاريخ البداية يأتي بعد تاريخ النهاية.');
  const currency = String(request.currency_code ?? '').trim().toUpperCase();
  if (currency && !/^[A-Z]{3}$/.test(currency)) throw new Error('رمز العملة يجب أن يتكون من ثلاثة أحرف لاتينية مثل USD.');
  if ((estimated.value !== null || actual.value !== null) && !currency) throw new Error('أدخل رمز عملة التكلفة؛ لا يفترض النظام عملة تلقائيًا.');
  const geographicUnitId = request.geographic_unit_id == null || request.geographic_unit_id === '' ? null : Number(request.geographic_unit_id);
  const sectorId = request.sector_id == null || request.sector_id === '' ? null : Number(request.sector_id);
  if (geographicUnitId !== null && (!Number.isSafeInteger(geographicUnitId) || !database.prepare('SELECT id FROM geographic_units WHERE id=?').get(geographicUnitId))) throw new Error('المرجع الجغرافي المحدد غير موجود.');
  if (sectorId !== null && (!Number.isSafeInteger(sectorId) || !database.prepare('SELECT id FROM sectors WHERE id=? AND active=1').get(sectorId))) throw new Error('القطاع المحدد غير موجود أو غير نشط.');
  const now = new Date().toISOString();
  return database.transaction(() => {
    const previous = id ? database.prepare('SELECT * FROM projects WHERE id=?').get(id) : null;
    if (id && !previous) throw new Error('المشروع المطلوب غير موجود.');
    if (code) {
      const duplicate = database.prepare('SELECT id FROM projects WHERE code=? AND id<>coalesce(?,0)').get(code, id);
      if (duplicate) throw new Error('رمز المشروع مستخدم في سجل آخر.');
    }
    const source = database.prepare("INSERT INTO data_sources (source_type,document_title,received_at,notes) VALUES ('manual','إدخال يدوي',?,?)")
      .run(now, id ? 'تعديل يدوي للمشروع #' + id : 'إنشاء يدوي لمشروع');
    const sourceId = Number(source.lastInsertRowid);
    const values = [code,name,description,geographicUnitId,sectorId,status,estimated.value,actual.value,currency || null,start.value,end.value,sourceId,now];
    let projectId = id;
    if (previous) {
      database.prepare('INSERT INTO project_versions (project_id,action,payload_json,source_id,created_at) VALUES (?,?,?,?,?)')
        .run(id,'manual-update',json(previous),sourceId,now);
      database.prepare('UPDATE projects SET code=?,name=?,description=?,geographic_unit_id=?,sector_id=?,status=?,estimated_cost=?,actual_cost=?,currency_code=?,start_date=?,end_date=?,source_id=?,updated_at=? WHERE id=?')
        .run(...values,id);
    } else {
      const created = database.prepare('INSERT INTO projects (code,name,description,geographic_unit_id,sector_id,status,estimated_cost,actual_cost,currency_code,start_date,end_date,source_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(...values.slice(0,12),now,now);
      projectId = Number(created.lastInsertRowid);
    }
    const current = database.prepare('SELECT * FROM projects WHERE id=?').get(projectId);
    if (!previous) database.prepare('INSERT INTO project_versions (project_id,action,payload_json,source_id,created_at) VALUES (?,?,?,?,?)')
      .run(projectId,'manual-create',json(current),sourceId,now);
    database.prepare('INSERT INTO access_log (action,entity,entity_id,fields,detail,created_at) VALUES (?,?,?,?,?,?)')
      .run(previous ? 'manual-update' : 'manual-create','projects',String(projectId),String(values.length),'source=' + sourceId,now);
    dataArchitecture.syncDomainRecords(database,{ projectIds:[projectId] });
    return { id: projectId, action: previous ? 'updated' : 'created', sourceId, updatedAt: now };
  })();
}

function resolveProjectQualityIssue(database, projectId, issueId, resolution) {
  const project = Number(projectId);
  const issue = Number(issueId);
  const note = String(resolution ?? '').trim();
  if (!Number.isSafeInteger(project) || project <= 0 || !Number.isSafeInteger(issue) || issue <= 0) throw new Error('معرّف المشروع أو الملاحظة غير صالح.');
  if (!note || note.length > 1000) throw new Error('سبب التسوية إلزامي وبحد أقصى 1000 حرف.');
  const now = new Date().toISOString();
  return database.transaction(() => {
    const record = database.prepare(`
      SELECT issue.id,issue.status FROM data_quality_issues issue
      JOIN workbook_import_promotions promotion ON promotion.row_id=issue.row_id
      WHERE issue.id=? AND promotion.entity_type='project' AND promotion.target_id=?
    `).get(issue,project);
    if (!record) throw new Error('ملاحظة الجودة لا ترتبط بهذا المشروع.');
    if (record.status !== 'open') throw new Error('ملاحظة الجودة ليست مفتوحة أو سبق تسويتها.');
    database.prepare("UPDATE data_quality_issues SET status='resolved',resolution=?,resolved_at=? WHERE id=? AND status='open'")
      .run(note,now,issue);
    database.prepare('INSERT INTO access_log (action,entity,entity_id,fields,detail,created_at) VALUES (?,?,?,?,?,?)')
      .run('quality-resolved','data_quality_issues',String(issue),'status,resolution','project=' + project,now);
    return { projectId: project, issueId: issue, status: 'resolved', resolvedAt: now };
  })();
}

function addProjectFunding(database, projectId, request = {}) {
  const id = Number(projectId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('معرّف المشروع غير صالح.');
  const partner = String(request.partner_name ?? '').trim();
  if (!partner || partner.length > 240) throw new Error('اسم جهة التمويل إلزامي وبحد أقصى 240 حرفًا.');
  const amount = parseProjectNumber(request.amount, 'مبلغ التمويل');
  const date = parseProjectDate(request.funding_date, 'تاريخ التمويل');
  if (amount.error || date.error) throw new Error(amount.error ?? date.error);
  const currency = String(request.currency_code ?? '').trim().toUpperCase();
  if (currency && !/^[A-Z]{3}$/.test(currency)) throw new Error('رمز العملة يجب أن يتكون من ثلاثة أحرف لاتينية مثل USD.');
  if (amount.value !== null && !currency) throw new Error('أدخل رمز عملة مبلغ التمويل.');
  const now = new Date().toISOString();
  return database.transaction(() => {
    const project = database.prepare('SELECT * FROM projects WHERE id=?').get(id);
    if (!project) throw new Error('المشروع المطلوب غير موجود.');
    const fundingBefore = database.prepare('SELECT * FROM project_funding WHERE project_id=? ORDER BY id').all(id);
    const source = database.prepare("INSERT INTO data_sources (source_type,document_title,file_name,mime_type,received_at,notes) VALUES ('manual-funding',?,?,?,?,?)")
      .run(partner, null, null, now, 'إضافة تمويل للمشروع #' + id);
    const sourceId = Number(source.lastInsertRowid);
    database.prepare('INSERT INTO project_versions (project_id,action,payload_json,source_id,created_at) VALUES (?,?,?,?,?)')
      .run(id,'funding-added',json({ project, funding: fundingBefore }),sourceId,now);
    const inserted = database.prepare('INSERT INTO project_funding (project_id,partner_name,amount,currency_code,funding_date,source_id,created_at) VALUES (?,?,?,?,?,?,?)')
      .run(id,partner,amount.value,currency || null,date.value,sourceId,now);
    database.prepare('UPDATE projects SET updated_at=?,source_id=? WHERE id=?').run(now,sourceId,id);
    database.prepare('INSERT INTO access_log (action,entity,entity_id,fields,detail,created_at) VALUES (?,?,?,?,?,?)')
      .run('funding-added','projects',String(id),'partner_name,amount,currency_code,funding_date','source=' + sourceId,now);
    dataArchitecture.syncDomainRecords(database,{ projectIds:[id] });
    return { id: Number(inserted.lastInsertRowid), sourceId, projectId: id, createdAt: now };
  })();
}

function addProjectAttachment(database, projectId, request = {}) {
  const id = Number(projectId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('معرّف المشروع غير صالح.');
  const content = request.content;
  if (!Buffer.isBuffer(content) || content.length === 0 || content.length > LIMITS.mediaItemBytes) throw new Error('حجم المرفق غير صالح أو يتجاوز الحد الآمن (20 ميغابايت).');
  const signatures = [
    { extension: '.pdf', mimeType: 'application/pdf', valid: content.subarray(0, 5).toString('ascii') === '%PDF-' },
    { extension: '.png', mimeType: 'image/png', valid: content.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) },
    { extension: '.jpg', mimeType: 'image/jpeg', valid: content.subarray(0, 3).equals(Buffer.from([255,216,255])) },
    { extension: '.webp', mimeType: 'image/webp', valid: content.subarray(0, 4).toString('ascii') === 'RIFF' && content.subarray(8, 12).toString('ascii') === 'WEBP' },
  ];
  const signature = signatures.find(item => item.valid);
  if (!signature || (request.mimeType && request.mimeType !== signature.mimeType)) throw new Error('نوع المرفق غير مدعوم أو لا يطابق محتواه. الأنواع المقبولة PDF وPNG وJPEG وWebP.');
  const originalName = String(request.originalName ?? '').split(/[\\/]/).pop().trim().slice(0, 240);
  if (!originalName) throw new Error('اسم المرفق غير صالح.');
  const hash = crypto.createHash('sha256').update(content).digest('hex');
  const now = new Date().toISOString();
  return database.transaction(() => {
    const project = database.prepare('SELECT * FROM projects WHERE id=?').get(id);
    if (!project) throw new Error('المشروع المطلوب غير موجود.');
    if (database.prepare("SELECT id FROM managed_attachments WHERE entity_type='project' AND entity_id=? AND sha256=?").get(id,hash)) throw new Error('هذا المرفق مرتبط بالمشروع مسبقًا.');
    const source = database.prepare("INSERT INTO data_sources (source_type,document_title,file_name,mime_type,content_sha256,file_size,received_at,notes) VALUES ('manual-attachment',?,?,?,?,?,?,?)")
      .run(originalName,originalName,signature.mimeType,hash,content.length,now,'مرفق للمشروع #' + id);
    const sourceId = Number(source.lastInsertRowid);
    const fundingBefore = database.prepare('SELECT * FROM project_funding WHERE project_id=? ORDER BY id').all(id);
    database.prepare('INSERT INTO project_versions (project_id,action,payload_json,source_id,created_at) VALUES (?,?,?,?,?)')
      .run(id,'attachment-added',json({ project, funding: fundingBefore }),sourceId,now);
    const result = database.prepare("INSERT INTO managed_attachments (entity_type,entity_id,source_id,original_name,mime_type,extension,size_bytes,sha256,content,classification,review_status,created_at) VALUES ('project',?,?,?,?,?,?,?,?,'unclassified','linked',?)")
      .run(id,sourceId,originalName,signature.mimeType,signature.extension,content.length,hash,content,now);
    database.prepare('UPDATE projects SET updated_at=?,source_id=? WHERE id=?').run(now,sourceId,id);
    database.prepare('INSERT INTO access_log (action,entity,entity_id,fields,detail,created_at) VALUES (?,?,?,?,?,?)')
      .run('attachment-added','projects',String(id),'attachment','sha256=' + hash,now);
    return { id: Number(result.lastInsertRowid), projectId: id, originalName, mimeType: signature.mimeType, extension: signature.extension, sizeBytes: content.length, sha256: hash, sourceId, createdAt: now };
  })();
}

function getProjectAttachment(database, projectId, attachmentId) {
  const project = Number(projectId), attachment = Number(attachmentId);
  if (!Number.isSafeInteger(project) || project <= 0 || !Number.isSafeInteger(attachment) || attachment <= 0) throw new Error('معرّف المشروع أو المرفق غير صالح.');
  const row = database.prepare("SELECT id,original_name,mime_type,extension,size_bytes,sha256,content FROM managed_attachments WHERE id=? AND entity_type='project' AND entity_id=?")
    .get(attachment,project);
  if (!row) throw new Error('المرفق غير موجود لهذا المشروع.');
  if (!Buffer.isBuffer(row.content) || row.content.length !== row.size_bytes) throw new Error('محتوى المرفق المحفوظ غير مكتمل.');
  const digest = crypto.createHash('sha256').update(row.content).digest('hex');
  if (digest !== row.sha256) throw new Error('بصمة المرفق المحفوظ لا تطابق محتواه.');
  return row;
}

function listCanonicalProjects(database, request = {}) {
  const limit = Math.max(1, Math.min(100, Number(request.limit) || 30));
  const offset = Math.max(0, Math.min(1000000, Number(request.offset) || 0));
  const search = String(request.search ?? '').trim().slice(0, 120);
  const status = String(request.status ?? '').trim().slice(0, 80);
  const conditions = ["p.record_status='approved'"];
  const params = [];
  if (search) {
    conditions.push("(instr(lower(coalesce(p.name,'')),lower(?))>0 OR instr(lower(coalesce(p.code,'')),lower(?))>0 OR instr(lower(coalesce(p.description,'')),lower(?))>0)");
    params.push(search,search,search);
  }
  if (status) {
    conditions.push('p.status=?');
    params.push(status);
  }
  const cte = `WITH project_values AS (
    SELECT record.form_record_id,record.record_status,record.created_at,record.updated_at,record.geo_unit_id,link.legacy_entity_id AS id,
      MAX(CASE WHEN field.field_code='projectCode' THEN value.value_text END) AS code,
      MAX(CASE WHEN field.field_code='projectName' THEN value.value_text END) AS name,
      MAX(CASE WHEN field.field_code='description' THEN value.value_text END) AS description,
      MAX(CASE WHEN field.field_code='projectStatus' THEN value.value_text END) AS status,
      MAX(CASE WHEN field.field_code='estimatedCost' THEN coalesce(observation.value_integer,observation.value_real) END) AS estimated_cost,
      MAX(CASE WHEN field.field_code='actualCost' THEN coalesce(observation.value_integer,observation.value_real) END) AS actual_cost,
      MAX(CASE WHEN field.field_code='currencyCode' THEN value.value_text END) AS currency_code,
      MAX(CASE WHEN field.field_code='startDate' THEN value.value_date END) AS start_date,
      MAX(CASE WHEN field.field_code='endDate' THEN value.value_date END) AS end_date,
      MAX(CASE WHEN field.field_code='sectorCode' THEN value.value_text END) AS sector_code
    FROM form_records record JOIN form_versions version USING(form_version_id) JOIN form_definitions form USING(form_id)
    JOIN form_record_legacy_links link ON link.form_record_id=record.form_record_id AND link.legacy_entity_type='project'
    JOIN form_fields field USING(form_version_id)
    LEFT JOIN record_field_values value ON value.form_record_id=record.form_record_id AND value.form_field_id=field.form_field_id
    LEFT JOIN observations observation ON observation.form_record_id=record.form_record_id AND observation.form_field_id=field.form_field_id
    WHERE form.form_code='project_v1'
    GROUP BY record.form_record_id
  )`;
  const from = `FROM project_values p
    LEFT JOIN geographic_units geo ON geo.geo_unit_id=p.geo_unit_id
    LEFT JOIN sectors sector ON sector.code=p.sector_code
    LEFT JOIN record_revisions revision ON revision.form_record_id=p.form_record_id AND revision.revision_number=(SELECT MAX(latest.revision_number) FROM record_revisions latest WHERE latest.form_record_id=p.form_record_id)
    LEFT JOIN data_sources source ON source.source_id=revision.source_id`;
  const where = `WHERE ${conditions.join(' AND ')}`;
  const total = database.prepare(`${cte} SELECT COUNT(*) AS count ${from} ${where}`).get(...params).count;
  const rows = database.prepare(`${cte} SELECT p.id,p.code,p.name,p.description,p.geo_unit_id AS geographic_unit_id,sector.id AS sector_id,p.status,p.estimated_cost,p.actual_cost,p.currency_code,
      p.start_date,p.end_date,p.created_at,p.updated_at,geo.name AS geographic_unit_name,geo.unit_type AS geographic_unit_type,sector.name_ar AS sector_name,
      source.file_name AS source_file,
      (SELECT COUNT(*) FROM form_record_legacy_links funding_link JOIN form_records funding_record USING(form_record_id)
        JOIN form_versions funding_version USING(form_version_id) JOIN form_definitions funding_form USING(form_id)
        WHERE funding_link.legacy_entity_type='project_funding' AND funding_record.parent_record_id=(SELECT form_record_id FROM project_values WHERE id=p.id)
          AND funding_form.form_code='project_funding_v1') AS funding_count,
      (SELECT COUNT(*) FROM workbook_import_promotions promotion JOIN workbook_import_rows source_row ON source_row.id=promotion.row_id
        JOIN data_quality_issues issue ON issue.row_id=source_row.id WHERE promotion.entity_type='project' AND promotion.target_id=p.id AND issue.status='open') AS open_quality_issues,
      (SELECT promotion.source_location FROM workbook_import_promotions promotion WHERE promotion.entity_type='project' AND promotion.target_id=p.id LIMIT 1) AS source_location,
      max(0,(SELECT COUNT(*) FROM record_revisions revision WHERE revision.form_record_id=p.form_record_id)-1) AS version_count
    ${from} ${where} ORDER BY p.updated_at DESC,p.id DESC LIMIT ? OFFSET ?`).all(...params,limit,offset);
  return {
    rows:rows.map(row => ({
      ...row,estimatedCost:row.estimated_cost,actualCost:row.actual_cost,currencyCode:row.currency_code,
      geographicUnitName:row.geographic_unit_name,geographicUnitType:row.geographic_unit_type,sectorName:row.sector_name,
      sourceFile:row.source_file,fundingCount:row.funding_count,openQualityIssues:row.open_quality_issues,sourceLocation:row.source_location,
    })),
    total,limit,offset,hasPrevious:offset>0,hasNext:offset+rows.length<total,
  };
}

function getCanonicalProject(database, projectId) {
  const id = Number(projectId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('معرّف المشروع غير صالح.');
  const project = database.prepare(`WITH project_values AS (
    SELECT record.form_record_id,record.record_status,record.created_at,record.updated_at,record.geo_unit_id,link.legacy_entity_id AS id,
      MAX(CASE WHEN field.field_code='projectCode' THEN value.value_text END) AS code,
      MAX(CASE WHEN field.field_code='projectName' THEN value.value_text END) AS name,
      MAX(CASE WHEN field.field_code='description' THEN value.value_text END) AS description,
      MAX(CASE WHEN field.field_code='projectStatus' THEN value.value_text END) AS status,
      MAX(CASE WHEN field.field_code='estimatedCost' THEN coalesce(observation.value_integer,observation.value_real) END) AS estimated_cost,
      MAX(CASE WHEN field.field_code='actualCost' THEN coalesce(observation.value_integer,observation.value_real) END) AS actual_cost,
      MAX(CASE WHEN field.field_code='currencyCode' THEN value.value_text END) AS currency_code,
      MAX(CASE WHEN field.field_code='startDate' THEN value.value_date END) AS start_date,
      MAX(CASE WHEN field.field_code='endDate' THEN value.value_date END) AS end_date,
      MAX(CASE WHEN field.field_code='sectorCode' THEN value.value_text END) AS sector_code
    FROM form_records record JOIN form_versions version USING(form_version_id) JOIN form_definitions form USING(form_id)
    JOIN form_record_legacy_links link ON link.form_record_id=record.form_record_id AND link.legacy_entity_type='project'
    JOIN form_fields field USING(form_version_id)
    LEFT JOIN record_field_values value ON value.form_record_id=record.form_record_id AND value.form_field_id=field.form_field_id
    LEFT JOIN observations observation ON observation.form_record_id=record.form_record_id AND observation.form_field_id=field.form_field_id
    WHERE form.form_code='project_v1'
    GROUP BY record.form_record_id
  )
  SELECT p.id,p.code,p.name,p.description,p.geo_unit_id AS geographic_unit_id,sector.id AS sector_id,p.status,p.estimated_cost,p.actual_cost,p.currency_code,
    p.start_date,p.end_date,p.created_at,p.updated_at,geo.name AS geographic_unit_name,geo.unit_type AS geographic_unit_type,sector.name_ar AS sector_name,
    source.file_name AS source_file,p.form_record_id
  FROM project_values p
  LEFT JOIN geographic_units geo ON geo.geo_unit_id=p.geo_unit_id
  LEFT JOIN sectors sector ON sector.code=p.sector_code
  LEFT JOIN record_revisions revision ON revision.form_record_id=p.form_record_id AND revision.revision_number=(SELECT MAX(latest.revision_number) FROM record_revisions latest WHERE latest.form_record_id=p.form_record_id)
  LEFT JOIN data_sources source ON source.source_id=revision.source_id
  WHERE p.id=? AND p.record_status='approved'`).get(id);
  if (!project) throw new Error('المشروع المطلوب غير موجود.');
  const funding = database.prepare(`WITH funding_values AS (
    SELECT record.form_record_id,link.legacy_entity_id AS id,record.created_at,
      MAX(CASE WHEN field.field_code='partnerName' THEN value.value_text END) AS partner_name,
      MAX(CASE WHEN field.field_code='amount' THEN coalesce(observation.value_integer,observation.value_real) END) AS amount,
      MAX(CASE WHEN field.field_code='currencyCode' THEN value.value_text END) AS currency_code,
      MAX(CASE WHEN field.field_code='fundingDate' THEN value.value_date END) AS funding_date
    FROM form_records record JOIN form_versions version USING(form_version_id) JOIN form_definitions form USING(form_id)
    JOIN form_record_legacy_links link ON link.form_record_id=record.form_record_id AND link.legacy_entity_type='project_funding'
    JOIN form_fields field USING(form_version_id)
    LEFT JOIN record_field_values value ON value.form_record_id=record.form_record_id AND value.form_field_id=field.form_field_id
    LEFT JOIN observations observation ON observation.form_record_id=record.form_record_id AND observation.form_field_id=field.form_field_id
    WHERE form.form_code='project_funding_v1' AND record.parent_record_id=?
    GROUP BY record.form_record_id
  ) SELECT id,partner_name,amount,currency_code,funding_date,created_at FROM funding_values ORDER BY id`).all(project.form_record_id);
  const provenance = database.prepare(`
    SELECT promotion.source_location,promotion.mapping_json,promotion.mapped_values_json,
      batch.file_name,batch.sha256,batch.created_at AS received_at
    FROM workbook_import_promotions promotion
    JOIN workbook_import_batches batch ON batch.id = promotion.batch_id
    WHERE promotion.entity_type = 'project' AND promotion.target_id = ?
    ORDER BY promotion.id DESC LIMIT 1
  `).get(id);
  const issues = database.prepare(`
    SELECT issue.id,issue.severity,issue.issue_code,issue.message,issue.status,issue.resolution,issue.resolved_at,issue.created_at
    FROM data_quality_issues issue
    JOIN workbook_import_promotions promotion ON promotion.row_id = issue.row_id
    WHERE promotion.entity_type = 'project' AND promotion.target_id = ?
    ORDER BY issue.id DESC
  `).all(id);
  const versions = database.prepare(`SELECT revision.record_revision_id AS id,revision.action_type AS action,revision.revision_number,revision.created_at,revision.source_id
    FROM record_revisions revision WHERE revision.form_record_id=? AND revision.action_type<>'legacy_domain_migration'
    UNION ALL
    SELECT revision.record_revision_id AS id,
      CASE WHEN revision.action_type='legacy_domain_migration' THEN 'funding-added' ELSE revision.action_type END AS action,
      revision.revision_number,revision.created_at,revision.source_id
    FROM record_revisions revision JOIN form_records funding_record ON funding_record.form_record_id=revision.form_record_id
    JOIN form_versions funding_version ON funding_version.form_version_id=funding_record.form_version_id
    JOIN form_definitions funding_form ON funding_form.form_id=funding_version.form_id
    WHERE funding_record.parent_record_id=? AND funding_form.form_code='project_funding_v1'
    ORDER BY created_at DESC,id DESC LIMIT 50`).all(project.form_record_id,project.form_record_id);
  const attachments = database.prepare('SELECT id,original_name,mime_type,extension,size_bytes,sha256,classification,review_status,created_at FROM managed_attachments WHERE entity_type=? AND entity_id=? ORDER BY id DESC').all('project',id);
  return { project, funding, attachments, provenance: provenance ?? null, issues, versions };
}

function completeWorkbookImport(database, batchId, result = {}) {
  const id = Number(batchId);
  if (!Number.isInteger(id) || id <= 0) throw new Error('معرّف دفعة الاستيراد غير صالح.');
  const applied = Number(result.applied ?? 0);
  const directorateStatus = applied > 0
    ? (Number(result.refused?.length ?? 0) || Number(result.skipped?.length ?? 0) ? 'directorates-partially-applied' : 'directorates-applied')
    : 'reviewed-without-directorate-write';
  const previousBatch = database.prepare('SELECT result_json FROM workbook_import_batches WHERE id = ?').get(id);
  const previousResult = safeJsonParse(previousBatch?.result_json, {}) ?? {};
  const projectPromotions = Array.isArray(previousResult.projectPromotions) ? previousResult.projectPromotions : [];
  const projectAttempted = projectPromotions.length > 0;
  const projectHadApplied = projectPromotions.some(item => Array.isArray(item.applied) && item.applied.length > 0);
  const projectPartial = projectPromotions.some(item =>
    (Array.isArray(item.refused) && item.refused.length > 0) || Number(item.skipped ?? 0) > 0
  );
  const status = applied > 0 && projectAttempted
    ? (!projectHadApplied
      ? 'directorates-applied-project-review-required'
      : (directorateStatus === 'directorates-partially-applied' || projectPartial
        ? 'directorates-and-projects-partially-applied' : 'directorates-and-projects-applied'))
    : projectAttempted && projectHadApplied
      ? 'projects-applied-without-directorate-write'
      : projectAttempted
        ? 'projects-review-required'
        : directorateStatus;
  const combinedResult = { ...previousResult, directorateImport: result };
  database.prepare("UPDATE workbook_import_batches SET status=?,result_json=?,updated_at=? WHERE id=?")
    .run(status, json(combinedResult), new Date().toISOString(), id);
  return { batchId: id, status };
}

function listDataSources(database, request = {}) {
  const limit = Math.min(100,Math.max(1,Number(request.limit)||30));
  const offset = Math.max(0,Math.min(1000000,Number(request.offset)||0));
  const search = String(request.search ?? '').trim().slice(0,120);
  const sourceColumns = new Set(database.prepare('PRAGMA table_info(data_sources)').all().map(column => column.name));
  const expression = names => {
    const present = names.filter(name => sourceColumns.has(name)).map(name => `source.${name}`);
    return present.length > 1 ? `coalesce(${present.join(',')})` : present[0] ?? 'NULL';
  };
  const sourceCode = expression(['source_code']);
  const organization = expression(['organization','organization_name']);
  const fileName = expression(['file_name']);
  const documentTitle = expression(['document_title']);
  const referencePeriod = expression(['reference_period']);
  const receivedAt = expression(['received_at']);
  const collectedAt = expression(['collected_at']);
  const notes = expression(['notes']);
  const sha256 = expression(['content_sha256']);
  const fileSize = expression(['file_size','file_size_bytes']);
  const params = [];
  const where = search ? `WHERE (instr(lower(coalesce(${sourceCode},'')),lower(?))>0 OR instr(lower(coalesce(${organization},'')),lower(?))>0
    OR instr(lower(coalesce(${fileName},'')),lower(?))>0 OR instr(lower(coalesce(${documentTitle},'')),lower(?))>0
    OR instr(lower(coalesce(${referencePeriod},'')),lower(?))>0 OR instr(lower(coalesce(${notes},'')),lower(?))>0)` : '';
  if (search) params.push(search,search,search,search,search,search);
  const total = database.prepare(`SELECT COUNT(*) AS count FROM data_sources source ${where}`).get(...params).count;
  const rows = database.prepare(`SELECT source.id,${sourceCode} AS source_code,source.source_type,${organization} AS organization,
    ${documentTitle} AS document_title,${fileName} AS file_name,${referencePeriod} AS reference_period,${receivedAt} AS received_at,
    ${collectedAt} AS collected_at,${notes} AS notes,${sha256} AS content_sha256,${fileSize} AS file_size
    FROM data_sources source ${where} ORDER BY source.id DESC LIMIT ? OFFSET ?`).all(...params,limit,offset);
  return { rows,total,limit,offset,hasPrevious:offset>0,hasNext:offset+rows.length<total };
}

function listWorkbookImports(database, limit = 30) {
  const bounded = Math.min(100, Math.max(1, Number(limit) || 30));
  return database.prepare("SELECT b.id,b.file_name,b.file_size,b.sha256,b.sheet_count,b.row_count,b.cell_count,b.media_count,b.media_stored_count,b.truncated,b.status,b.created_at,b.updated_at,(SELECT COUNT(*) FROM workbook_import_regions r WHERE r.batch_id=b.id) AS region_count,(SELECT COUNT(*) FROM workbook_import_rows w WHERE w.batch_id=b.id) AS stored_row_count FROM workbook_import_batches b ORDER BY b.id DESC LIMIT ?").all(bounded);
}

module.exports = { LIMITS, PROJECT_IMPORT_FIELDS, checksum, migrateCanonicalData, syncLegacyDirectorate, retireLegacyDirectorate, stageWorkbook, readWorkbookSheetPreview, listWorkbookImportRegions, readWorkbookImportRegion, promoteProjectRegion, promoteIndicatorRegion, listCanonicalReferences, listIndicatorObservations, saveIndicatorObservation, listDataQualityIssues, listDataSources, resolveDataQualityIssue, saveCanonicalProject, resolveProjectQualityIssue, addProjectFunding, addProjectAttachment, getProjectAttachment, listCanonicalProjects, getCanonicalProject, completeWorkbookImport, listWorkbookImports };
