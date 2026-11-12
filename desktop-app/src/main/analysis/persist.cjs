'use strict';

/**
 * Persistence layer for the analysis engine.
 *
 * The database is the single source of truth: the workbook is only ever read,
 * never written. Every value that reaches `directorates` keeps its provenance in
 * `directorate_sources` (source file, cell address, raw text), and every run is
 * stored with the weights that produced it, so a result can always be explained
 * or replayed months later.
 */

const { DIRECTORATE_COLUMNS } = require('./store-schema.cjs');
const { INPUT_FIELDS, DECISION_FIELD } = require('./schema.cjs');
const canonicalData = require('./canonical-data.cjs');
const { parseFieldValue } = require('./parse.cjs');
const { buildDirectorateWhere } = require('./report-filters.cjs');

const FIELD_BY_KEY = new Map(INPUT_FIELDS.map((field) => [field.key, field]));
const COLUMN_ENTRIES = Object.entries(DIRECTORATE_COLUMNS);
const CANONICAL_DIRECTORATE_CTES = `WITH ranked_directorate_records AS (
  SELECT record.form_record_id,record.geo_unit_id,record.record_status,record.created_at,record.updated_at,link.legacy_entity_id,
    ROW_NUMBER() OVER(PARTITION BY link.legacy_entity_id ORDER BY coalesce(record.approved_at,record.updated_at) DESC,record.form_record_id DESC) AS rank_number
  FROM form_records record
  JOIN form_versions version USING(form_version_id)
  JOIN form_definitions form USING(form_id)
  JOIN form_record_legacy_links link ON link.form_record_id=record.form_record_id AND link.legacy_entity_type='directorate'
  WHERE form.form_code='legacy_directorate_v1' AND record.record_status='approved'
), entity_records AS (
  SELECT record.form_record_id AS id,'directorate' AS entity_type,record.geo_unit_id AS geographic_unit_id,
    'legacy-directorate:' || record.legacy_entity_id AS external_key,record.record_status AS status,record.created_at,record.updated_at
  FROM ranked_directorate_records record WHERE record.rank_number=1
), data_field_definitions AS (
  SELECT definition.field_definition_id AS id,'directorate' AS entity_type,substr(field.field_code,13) AS field_key,
    CASE WHEN coalesce(field.data_type_override,definition.data_type) IN ('integer','decimal') THEN 'number'
      WHEN coalesce(field.data_type_override,definition.data_type)='boolean' THEN 'boolean'
      ELSE coalesce(field.data_type_override,definition.data_type) END AS data_type
  FROM form_fields field JOIN field_definitions definition USING(field_definition_id)
  JOIN form_versions version USING(form_version_id) JOIN form_definitions form USING(form_id)
  WHERE form.form_code='legacy_directorate_v1'
), entity_field_values AS (
  SELECT value.form_record_id AS record_id,field.field_definition_id,
    coalesce(CAST(period.year_gregorian AS TEXT),period.period_code,'') AS period_key,
    value.value_text,NULL AS value_number,value.value_boolean,value.value_date,value.value_state
  FROM record_field_values value JOIN form_fields field USING(form_field_id)
  JOIN form_records record USING(form_record_id) LEFT JOIN periods period USING(period_id)
  UNION ALL
  SELECT observation.form_record_id AS record_id,observation.field_definition_id,
    coalesce(CAST(period.year_gregorian AS TEXT),period.period_code,'') AS period_key,
    observation.value_text,coalesce(observation.value_integer,observation.value_real) AS value_number,NULL AS value_boolean,NULL AS value_date,observation.value_state
  FROM observations observation JOIN form_fields field USING(form_field_id)
  JOIN form_records record USING(form_record_id) LEFT JOIN periods period ON period.period_id=observation.period_id
)`;

/** Provenance label for every value typed on the manual-entry screen. */
const MANUAL_SOURCE = 'إدخال يدوي';

/** Directories beyond this count are refused loudly rather than truncated. */
const ANALYSIS_ROW_CAP = 50000;

/** Setting key that remembers the calibration used by the last successful run. */
const CALIBRATION_KEY = 'analysis.lastCalibration';

/** How many point-in-time snapshots to keep per directorate. */
const VERSION_KEEP = 20;

function nowIso() {
  return new Date().toISOString();
}

/**
 * The identity of a directorate, derived the same way in every code path:
 * identity, duplicate detection and run matching must never disagree.
 */
function identityOf(record) {
  const governorate = String(record.governorate ?? record.values?.governorate ?? '').trim();
  const district = String(record.districtName ?? record.values?.districtName ?? '').trim();
  return { governorate, district, key: `${governorate}|${district}` };
}

/** Normalise a canonical value for its database column. */
function toColumnValue(key, value) {
  const field = FIELD_BY_KEY.get(key);
  if (value === null || value === undefined || value === '') return null;
  if (field && field.type === 'number') {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  }
  if (field && field.type === 'ratio') {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  }
  if (field && field.type === 'boolean') {
    if (value === true || value === 1 || value === '1' || value === 'نعم') return 1;
    if (value === false || value === 0 || value === '0' || value === 'لا') return 0;
    return null;
  }
  return String(value);
}

/**
 * Compare a canonical next value with the raw value currently stored in the
 * column. SQLite hands back `null` for an empty cell while `toColumnValue`
 * normalises the same state to `null` too, so both sides are compared after the
 * same normalisation. Numbers are compared numerically (a REAL round trip must
 * not look like an edit), everything else as text.
 */
function sameStoredValue(nextValue, storedValue) {
  const next = nextValue === undefined ? null : nextValue;
  const stored = storedValue === undefined ? null : storedValue;
  if (next === stored) return true;
  if (next === null || stored === null) return false;
  if (typeof next === 'number' && typeof stored === 'number') return next === stored;
  return String(next) === String(stored);
}

function safeJson(value, fallback = null) {
  if (value === undefined) return fallback;
  try {
    return JSON.stringify(value);
  } catch {
    return fallback;
  }
}

/**
 * Insert or update one directorate and its provenance rows.
 *
 * A key that is absent (`undefined`) leaves the column untouched on update and
 * stores NULL on insert; an explicit `null` clears the column. This distinction
 * matters when a partial file is imported: an absent column must not wipe a
 * value that a previous, fuller import already stored.
 *
 * @returns {{ id:number, created:boolean }}
 */
function upsertDirectorate(database, record, meta = {}) {
  const values = record.values ?? {};
  const rawValues = record.rawValues ?? {};
  const sources = record.sources ?? {};
  const identity = identityOf(record);
  const governorate = identity.governorate;
  const district = identity.district;
  if (!district) throw new Error('لا يمكن تخزين مديرية بلا اسم.');

  const columns = ['governorate', 'district'];
  const params = [governorate, district];
  for (const [key, column] of COLUMN_ENTRIES) {
    if (column === 'governorate' || column === 'district') continue;
    // The decision column is normally written from the review screen, but a
    // template import may carry it; it is only ever stored when the source file
    // actually provided a value.
    if (key === 'reviewerDecision' && values[key] === undefined) continue;
    if (values[key] === undefined) continue; // absent field: do not overwrite existing data
    columns.push(column);
    params.push(toColumnValue(key, values[key]));
  }
  columns.push('updated_at');
  params.push(nowIso());

  const existing = database
    .prepare('SELECT id FROM directorates WHERE governorate = ? AND district = ?')
    .get(governorate, district);

  if (existing) {
    // Assign every present data column plus the audit metadata, but never the identity.
    const assignments = [];
    const updateParams = [];
    columns.forEach((column, index) => {
      if (column === 'governorate' || column === 'district') return;
      assignments.push(`${column} = ?`);
      updateParams.push(params[index]);
    });
    if (meta.fileName !== undefined) { assignments.push('source_file = ?'); updateParams.push(meta.fileName ?? null); }
    if (meta.sheetName !== undefined) { assignments.push('source_sheet = ?'); updateParams.push(meta.sheetName ?? null); }
    if (record.rowNumber !== undefined && record.rowNumber !== null) { assignments.push('source_row = ?'); updateParams.push(record.rowNumber); }
    if (meta.warnings !== undefined) { assignments.push('import_warnings = ?'); updateParams.push(safeJson(meta.warnings, '[]')); }
    database.prepare(`UPDATE directorates SET ${assignments.join(', ')} WHERE id = ?`).run(...updateParams, existing.id);
    saveProvenance(database, existing.id, record, rawValues, sources, meta);
    canonicalData.syncLegacyDirectorate(database, existing.id);
    if (!meta.skipNormalizedRecordSync) require('../database/architecture.cjs').syncLegacyDirectorateRecord(database,existing.id);
    return { id: existing.id, created: false };
  }

  const insertColumns = [...columns, 'source_file', 'source_sheet', 'source_row', 'import_warnings'];
  const insertParams = [...params, meta.fileName ?? null, meta.sheetName ?? null, record.rowNumber ?? null, safeJson(meta.warnings ?? [], '[]')];
  const placeholders = insertColumns.map(() => '?').join(', ');
  const info = database
    .prepare(`INSERT INTO directorates (${insertColumns.join(', ')}) VALUES (${placeholders})`)
    .run(...insertParams);
  const id = Number(info.lastInsertRowid);
  saveProvenance(database, id, record, rawValues, sources, meta);
  canonicalData.syncLegacyDirectorate(database,id);
  if (!meta.skipNormalizedRecordSync) require('../database/architecture.cjs').syncLegacyDirectorateRecord(database,id);
  return { id, created: true };
}

function saveProvenance(database, directorateId, record, rawValues, sources, meta) {
  const statement = database.prepare(`
    INSERT INTO directorate_sources (directorate_id, field_key, value_text, source_file, source_location, captured_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(directorate_id, field_key) DO UPDATE SET
      value_text = excluded.value_text,
      source_file = excluded.source_file,
      source_location = excluded.source_location,
      captured_at = excluded.captured_at
  `);
  const captured = nowIso();
  const run = database.transaction((entries) => {
    for (const [key] of entries) {
      // Provenance follows the same rule as the value itself: a field that was
      // not applied must not overwrite the source record of a stored value.
      if (record.values?.[key] === undefined) continue;
      const location = sources[key] ?? null;
      const text = rawValues[key] ?? null;
      if (location === null && text === null) continue;
      statement.run(directorateId, key, text, meta.fileName ?? null, location, captured);
    }
  });
  run(COLUMN_ENTRIES);
}

/**
 * Persist a whole workbook read into the database.
 *
 * Duplicate `governorate|district` rows inside the same file are reported, not
 * silently merged: the last row wins (standard upsert semantics) and the caller
 * is told which rows collapsed so the operator can fix the source.
 *
 * Directorates already stored for this same file but absent from the new read
 * are returned as `stale` — they are not deleted, but the caller must surface
 * them because the workbook is meant to be the source of truth.
 *
 * @param {object} database better-sqlite3 handle
 * @param {{rows:Array, fileName?:string, sheetName?:string}} read result of readDirectorateWorkbook
 * @returns {{created:number, updated:number, total:number, duplicates:Array, stale:Array}}
 */
function upsertDirectorates(database, read) {
  const meta = { fileName: read.fileName ?? null, sheetName: read.sheetName ?? null };
  const rows = read.rows ?? [];
  let created = 0;
  let updated = 0;

  const seen = new Map();
  const duplicates = [];
  for (const row of rows) {
    const identity = identityOf(row);
    if (seen.has(identity.key)) {
      duplicates.push({
        governorate: identity.governorate,
        district: identity.district,
        firstRow: seen.get(identity.key),
        repeatedRow: row.rowNumber ?? null,
      });
    } else {
      seen.set(identity.key, row.rowNumber ?? null);
    }
  }

  const presentKeys = new Set(seen.keys());
  const stale = meta.fileName
    ? database.prepare('SELECT id, governorate, district FROM directorates WHERE source_file = ?').all(meta.fileName)
      .filter((record) => !presentKeys.has(`${String(record.governorate).trim()}|${String(record.district).trim()}`))
      .map((record) => ({ id: record.id, governorate: record.governorate, district: record.district }))
    : [];

  const run = database.transaction((items) => {
    for (const row of items) {
      const result = upsertDirectorate(database, row, meta);
      if (result.created) created += 1;
      else updated += 1;
    }
    database.prepare(
      'INSERT INTO access_log (action, entity, entity_id, fields, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('import', 'directorates', meta.fileName ?? '', String(items.length), `created=${created};updated=${updated};duplicates=${duplicates.length};stale=${stale.length}`, nowIso());
  });
  run(rows);

  return { created, updated, total: rows.length, duplicates, stale };
}

function canonicalDirectorateRows(database, filter = {}, limit = 50000, options = {}) {
  const bounded = Math.min(50000,Math.max(1,Number(limit) || 50000));
  const offset = Math.max(0,Math.min(1000000,Number(filter.offset) || 0));
  const { clauses, params } = buildDirectorateWhere(filter, options);
  const sortKey = String(filter.sortKey ?? '');
  const sortField = INPUT_FIELDS.find((field) => field.key === sortKey) ?? (DECISION_FIELD.key === sortKey ? DECISION_FIELD : null);
  const periodKey = typeof filter.periodKey === 'string' ? filter.periodKey.trim().slice(0,80) : '';
  let orderBy = 'governorate.name,unit.name';
  if (sortField) {
    orderBy = `(SELECT CASE sd.data_type WHEN 'number' THEN sv.value_number WHEN 'boolean' THEN sv.value_boolean ELSE coalesce(sv.value_text,sv.value_date) END FROM entity_field_values sv JOIN data_field_definitions sd ON sd.id=sv.field_definition_id WHERE sv.record_id=er.id AND sv.period_key=? AND sd.entity_type='directorate' AND sd.field_key=? LIMIT 1) ${filter.sortDirection === 'desc' ? 'DESC' : 'ASC'},governorate.name,unit.name`;
    params.push(periodKey,sortKey);
  } else if (sortKey && options.allowedKeys?.has(sortKey)) {
    orderBy = `(SELECT CASE sv.data_type WHEN 'number' THEN sv.value_number WHEN 'boolean' THEN sv.value_boolean ELSE sv.value_text END FROM entity_field_values sv JOIN data_field_definitions sd ON sd.id=sv.field_definition_id WHERE sv.record_id=er.id AND sv.period_key=? AND sd.entity_type='directorate' AND sd.field_key=? LIMIT 1) ${filter.sortDirection === 'desc' ? 'DESC' : 'ASC'},governorate.name,unit.name`;
    params.push(periodKey,sortKey);
  } else if (['updated_at','created_at'].includes(sortKey)) orderBy = `er.${sortKey} ${filter.sortDirection === 'asc' ? 'ASC' : 'DESC'},governorate.name,unit.name`;
  params.push(bounded,offset);
  const records = database.prepare(`${CANONICAL_DIRECTORATE_CTES} SELECT er.id AS entity_id,er.external_key,er.created_at,er.updated_at,unit.name AS district,governorate.name AS governorate FROM entity_records er JOIN geographic_units unit ON unit.geo_unit_id=er.geographic_unit_id LEFT JOIN geographic_units governorate ON governorate.geo_unit_id=unit.parent_geo_unit_id LEFT JOIN directorates legacy ON legacy.id=CAST(substr(er.external_key,20) AS INTEGER) WHERE ${clauses.join(' AND ')} ORDER BY ${orderBy} LIMIT ? OFFSET ?`).all(...params);
  if (!records.length) return [];
  const parsed = records.map(record => ({
    ...record,
    id: Number(String(record.external_key ?? '').match(/^legacy-directorate:(\d+)$/)?.[1]),
  })).filter(record => Number.isSafeInteger(record.id) && record.id > 0);
  if (!parsed.length) return [];
  const ids = parsed.map(record => record.entity_id);
  const placeholders = ids.map(() => '?').join(',');
  const values = database.prepare(`${CANONICAL_DIRECTORATE_CTES} SELECT value.record_id,definition.field_key,definition.data_type,value.value_text,value.value_number,value.value_boolean,value.value_state FROM entity_field_values value JOIN data_field_definitions definition ON definition.id=value.field_definition_id WHERE definition.entity_type='directorate' AND value.record_id IN (${placeholders}) AND value.period_key=?`).all(...ids,periodKey);
  const valuesByRecord = new Map(parsed.map(record => [record.entity_id,{}]));
  for (const value of values) {
    if (value.value_state === 'unknown') continue;
    const stored = value.data_type === 'number' ? value.value_number
      : value.data_type === 'boolean' ? value.value_boolean
        : value.value_text;
    valuesByRecord.get(value.record_id)[value.field_key] = stored;
  }
  const legacyIds = parsed.map(record => record.id);
  const legacyPlaceholders = legacyIds.map(() => '?').join(',');
  const metadata = database.prepare(`SELECT id,source_file,source_sheet,source_row,import_warnings FROM directorates WHERE id IN (${legacyPlaceholders})`).all(...legacyIds);
  const metaById = new Map(metadata.map(record => [record.id,record]));
  return parsed.map(record => {
    const legacy = metaById.get(record.id) ?? {};
    const output = {
      id: record.id,governorate: record.governorate ?? '',district: record.district,
      source_file: legacy.source_file ?? null,source_sheet: legacy.source_sheet ?? null,
      source_row: legacy.source_row ?? null,import_warnings: legacy.import_warnings ?? '[]',
      created_at: record.created_at,updated_at: record.updated_at,
    };
    const valuesForRecord = valuesByRecord.get(record.entity_id) ?? {};
    for (const [key,column] of COLUMN_ENTRIES) output[column] = valuesForRecord[key] ?? null;
    for (const [key,value] of Object.entries(valuesForRecord)) output[key] = value;
    output.district = record.district;
    output.governorate = record.governorate ?? '';
    return output;
  });
}

function listDirectorateFilterOptions(database, key, options = {}) {
  const allowedKeys = options.allowedKeys instanceof Set ? options.allowedKeys : new Set([...INPUT_FIELDS,DECISION_FIELD].map((field) => field.key));
  if (key === '__governorate') return database.prepare("SELECT name AS value FROM geographic_units WHERE unit_type='governorate' ORDER BY name COLLATE NOCASE LIMIT 200").all().map((row) => row.value);
  if (key === '__district') return database.prepare("SELECT name AS value FROM geographic_units WHERE unit_type='district' ORDER BY name COLLATE NOCASE LIMIT 5000").all().map((row) => row.value);
  if (key === '__sourceFile' || key === '__sourceSheet') {
    const column = key === '__sourceFile' ? 'source_file' : 'source_sheet';
    return database.prepare(`SELECT DISTINCT ${column} AS value FROM directorates WHERE ${column} IS NOT NULL AND TRIM(${column})<>'' ORDER BY ${column} COLLATE NOCASE LIMIT 200`).all().map((row) => row.value);
  }
  if (!allowedKeys.has(key)) return [];
  const field = [...INPUT_FIELDS,DECISION_FIELD].find((item) => item.key === key) ?? options.dynamicFields?.get(key);
  if (!field || field.type !== 'text') return [];
  return database.prepare(`${CANONICAL_DIRECTORATE_CTES} SELECT DISTINCT value.value_text AS value FROM entity_field_values value JOIN data_field_definitions definition ON definition.id=value.field_definition_id WHERE definition.entity_type='directorate' AND definition.field_key=? AND value.value_state<>'unknown' AND value.value_text IS NOT NULL AND TRIM(value.value_text)<>'' ORDER BY value.value_text COLLATE NOCASE LIMIT 200`).all(key).map((row) => row.value);
}

function listDirectorates(database, filter = {}, options = {}) {
  const limit = Math.min(50000,Math.max(1,Number(filter.limit) || 2000));
  return canonicalDirectorateRows(database,filter,limit,options);
}

function countDirectorates(database, filter = {}, options = {}) {
  const { clauses, params } = buildDirectorateWhere(filter, options);
  return database.prepare(`${CANONICAL_DIRECTORATE_CTES} SELECT COUNT(DISTINCT er.id) AS count FROM entity_records er JOIN geographic_units unit ON unit.geo_unit_id=er.geographic_unit_id LEFT JOIN geographic_units governorate ON governorate.geo_unit_id=unit.parent_geo_unit_id LEFT JOIN directorates legacy ON legacy.id=CAST(substr(er.external_key,20) AS INTEGER) WHERE ${clauses.join(' AND ')}`).get(...params).count;
}

/** Convert a stored directorate row back into the engine's input shape. */
function rowFromDirectorate(record) {
  const values = {};
  const rawValues = {};
  for (const [key, column] of COLUMN_ENTRIES) {
    const value = record[column];
    values[key] = value === undefined ? null : value;
    rawValues[key] = value === undefined || value === null ? '' : String(value);
  }
  values.districtName = record.district;
  values.governorate = record.governorate;
  return {
    id: `db:${record.id}`,
    dbId: record.id,
    rowNumber: record.source_row ?? null,
    districtName: record.district,
    governorate: record.governorate,
    // Provenance travels with the row so the directorate card can show where a
    // record came from without a second query.
    sourceFile: record.source_file ?? null,
    sourceSheet: record.source_sheet ?? null,
    createdAt: record.created_at ?? null,
    updatedAt: record.updated_at ?? null,
    values,
    rawValues,
    sources: {},
    warnings: parseJson(record.import_warnings, []),
  };
}

/**
 * Load every stored directorate as engine input rows.
 *
 * Analysis must see the whole population, not the first page of the browse
 * table, so this uses its own query with a generous safety cap (50 000) instead
 * of the 2 000-row paging limit used for the UI list.
 */
function loadAnalysisRows(database, filter = {}) {
  const total = Number(countDirectorates(database));
  if (total > ANALYSIS_ROW_CAP) {
    throw new Error(`عدد المديريات يتجاوز الحد الآمن للتحليل (${ANALYSIS_ROW_CAP}). جزّئ البيانات أو صفِّ حسب المحافظة قبل التحليل.`);
  }
  return canonicalDirectorateRows(database,filter,ANALYSIS_ROW_CAP).map(rowFromDirectorate);
}

/**
 * Persist a full analysis run and all of its per-directorate results.
 *
 * @param {object} database
 * @param {object} analysis output of engine.analyze
 * @param {{templateFile?:string, templateSheet?:string, mode?:string}} meta
 * @returns {{runId:number, results:number}}
 */
function saveRun(database, analysis, meta = {}) {
  const createdAt = nowIso();
  const rows = analysis.rows ?? [];

  const idByKey = new Map();
  for (const record of database.prepare('SELECT id, governorate, district FROM directorates').all()) {
    idByKey.set(`${String(record.governorate).trim()}|${String(record.district).trim()}`, record.id);
  }

  const write = database.transaction(() => {
    // The run header, every result row and the audit entry share one transaction:
    // a failure anywhere leaves no half-recorded run behind.
    const runInfo = database.prepare(`
      INSERT INTO analysis_runs (mode, weights_json, k_threshold, deprivation_line, row_count, summary_json, template_file, template_sheet, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      meta.mode ?? 'both',
      safeJson(analysis.meta?.weights, '{}'),
      analysis.meta?.kThreshold ?? null,
      analysis.meta?.deprivationLine ?? null,
      rows.length,
      safeJson(analysis.summary),
      meta.templateFile ?? analysis.meta?.template?.fileName ?? null,
      meta.templateSheet ?? analysis.meta?.template?.sheet ?? null,
      createdAt,
    );
    const runId = Number(runInfo.lastInsertRowid);

    const insert = database.prepare(`
      INSERT INTO analysis_results (
        run_id, directorate_id, district, governorate, indicators_json, completeness,
        replica_composite, replica_rank, calibrated_composite, calibrated_rank,
        degraded_count, severe, blocked, block_reason, weight_coverage, missing_json,
        sensitivity_json, project_type, confidence_text, confidence_level, gaps_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const row of rows) {
      const key = identityOf(row).key;
      insert.run(
        runId,
        idByKey.get(key) ?? null,
        row.districtName,
        row.governorate ?? '',
        safeJson(row.indicators, '{}'),
        row.completeness?.ratio ?? null,
        row.replica?.composite ?? null,
        row.replica?.rank ?? null,
        row.calibrated?.composite ?? null,
        row.calibrated?.rank ?? null,
        row.calibrated?.degradedCount ?? null,
        row.calibrated?.severe ? 1 : 0,
        row.calibrated?.blocked ? 1 : 0,
        row.calibrated?.blockReason ?? null,
        row.calibrated?.weightCoverage ?? null,
        safeJson(row.completeness?.missingLabels ?? [], '[]'),
        safeJson(row.sensitivity, null),
        row.project?.label ?? null,
        row.confidence?.text ?? null,
        row.confidence?.level ?? null,
        safeJson(analysis.gaps?.recordIssues?.get(row) ?? [], '[]'),
      );
    }

    database.prepare('INSERT INTO access_log (action, entity, entity_id, fields, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('analysis-run', 'analysis_runs', String(runId), String(rows.length), `mode=${meta.mode ?? 'both'}`, createdAt);

    // Remember the calibration of the run that was actually persisted. Exports
    // rebuilt after a restart then reproduce exactly what the user saw instead of
    // silently falling back to defaults.
    setSetting(database, CALIBRATION_KEY, safeJson({
      kThreshold: analysis.meta?.kThreshold ?? null,
      deprivationLine: analysis.meta?.deprivationLine ?? null,
      weights: analysis.meta?.weights ?? null,
      savedAt: createdAt,
    }, '{}'));

    return runId;
  });

  const runId = write();
  return { runId, results: rows.length };
}

function getRun(database, runId) {
  const run = database.prepare('SELECT * FROM analysis_runs WHERE id = ?').get(runId);
  if (!run) return null;
  const results = database.prepare(`
    SELECT r.*, d.source_file
    FROM analysis_results r
    LEFT JOIN directorates d ON d.id = r.directorate_id
    WHERE r.run_id = ?
    ORDER BY CASE WHEN r.calibrated_rank IS NULL THEN 1 ELSE 0 END, r.calibrated_rank, r.district
  `).all(runId);
  return { run: hydrateRun(run), results: results.map(hydrateResult) };
}

function getLatestRun(database) {
  const latest = database.prepare('SELECT id FROM analysis_runs ORDER BY id DESC LIMIT 1').get();
  return latest ? getRun(database, latest.id) : null;
}

function listRuns(database, limit = 50) {
  return database.prepare('SELECT id, mode, k_threshold, deprivation_line, row_count, created_at FROM analysis_runs ORDER BY id DESC LIMIT ?')
    .all(Math.min(500, Math.max(1, Number(limit) || 50)));
}

function hydrateRun(run) {
  return {
    id: run.id,
    mode: run.mode,
    weights: parseJson(run.weights_json, {}),
    kThreshold: run.k_threshold,
    deprivationLine: run.deprivation_line,
    rowCount: run.row_count,
    summary: parseJson(run.summary_json, null),
    templateFile: run.template_file,
    templateSheet: run.template_sheet,
    createdAt: run.created_at,
  };
}

function hydrateResult(result) {
  return {
    id: result.id,
    directorateId: result.directorate_id,
    districtName: result.district,
    governorate: result.governorate,
    indicators: parseJson(result.indicators_json, {}),
    // Note: the persisted, hydrated shape is intentionally lighter than the live
    // engine row. `completeness` is the stored ratio (a number) and the missing
    // fields are stored as labels, not the engine's { ratio, missingLabels, ... } object.
    completeness: result.completeness,
    replica: { composite: result.replica_composite, rank: result.replica_rank },
    calibrated: {
      composite: result.calibrated_composite,
      rank: result.calibrated_rank,
      degradedCount: result.degraded_count,
      severe: Boolean(result.severe),
      blocked: Boolean(result.blocked),
      blockReason: result.block_reason ?? null,
      weightCoverage: result.weight_coverage,
    },
    missingLabels: parseJson(result.missing_json, []),
    sensitivity: parseJson(result.sensitivity_json, null),
    projectType: result.project_type,
    confidenceText: result.confidence_text,
    confidenceLevel: result.confidence_level,
    gaps: parseJson(result.gaps_json, []),
    sourceFile: result.source_file,
  };
}

function parseJson(text, fallback) {
  if (text === null || text === undefined || text === '') return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/** Append one audit-trail entry. Never throws on a bad payload. */
function logAccess(database, entry) {
  try {
    database.prepare('INSERT INTO access_log (action, entity, entity_id, fields, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(
        String(entry.action ?? 'unknown'),
        entry.entity ?? null,
        entry.entityId === undefined ? null : String(entry.entityId),
        entry.fields ?? null,
        entry.detail ?? null,
        entry.createdAt ?? nowIso(),
      );
    return true;
  } catch {
    return false;
  }
}

function listAccess(database, limit = 200) {
  return database.prepare('SELECT * FROM access_log ORDER BY id DESC LIMIT ?')
    .all(Math.min(2000, Math.max(1, Number(limit) || 200)));
}

/**
 * Append one read-audit entry: which channel returned which entity/fields to
 * which session, and whether anything was masked or denied. Never throws.
 */
function logRead(database, entry = {}) {
  try {
    database.prepare(`
      INSERT INTO audit_reads (session_id, channel, entity, entity_id, fields, result, row_count, detail, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      entry.sessionId === undefined ? null : String(entry.sessionId),
      String(entry.channel ?? 'unknown'),
      entry.entity ?? null,
      entry.entityId === undefined || entry.entityId === null ? null : String(entry.entityId),
      entry.fields === undefined || entry.fields === null ? null : String(entry.fields),
      String(entry.result ?? 'ok'),
      Number.isFinite(Number(entry.rowCount)) ? Number(entry.rowCount) : null,
      entry.detail ?? null,
      entry.createdAt ?? nowIso(),
    );
    return true;
  } catch {
    return false;
  }
}

function listReads(database, limit = 200) {
  return database.prepare('SELECT * FROM audit_reads ORDER BY id DESC LIMIT ?')
    .all(Math.min(2000, Math.max(1, Number(limit) || 200)));
}

/**
 * Store a full point-in-time copy of one directorate (row + provenance) before
 * it is mutated. Old snapshots beyond VERSION_KEEP are pruned per directorate so
 * the trail cannot grow without bound.
 *
 * @returns {number|null} snapshot id
 */
function snapshotDirectorate(database, directorateId, action) {
  const numeric = toPositiveId(directorateId);
  const record = database.prepare('SELECT * FROM directorates WHERE id = ?').get(numeric);
  if (!record) return null;
  const sources = database.prepare(`
    SELECT field_key, value_text, source_file, source_location, data_value_id
    FROM directorate_sources WHERE directorate_id = ?
  `).all(numeric);
  const payload = JSON.stringify({ record, sources });
  const info = database.prepare(
    'INSERT INTO directorate_versions (directorate_id, action, payload_json, created_at) VALUES (?, ?, ?, ?)'
  ).run(numeric, String(action ?? 'snapshot'), payload, nowIso());
  try {
    database.prepare(`
      DELETE FROM directorate_versions
      WHERE directorate_id = ? AND id NOT IN (
        SELECT id FROM directorate_versions WHERE directorate_id = ? ORDER BY id DESC LIMIT ?
      )
    `).run(numeric, numeric, VERSION_KEEP);
  } catch { /* pruning is best effort */ }
  return Number(info.lastInsertRowid);
}

function listVersions(database, directorateId, limit = 50) {
  const numeric = toPositiveId(directorateId);
  return database.prepare(`
    SELECT id, directorate_id, action, created_at,
           json_extract(payload_json, '$.record.district') AS district,
           json_extract(payload_json, '$.record.governorate') AS governorate
    FROM directorate_versions WHERE directorate_id = ? ORDER BY id DESC LIMIT ?
  `).all(numeric, Math.min(200, Math.max(1, Number(limit) || 50)));
}

/**
 * Restore one directorate from a stored snapshot. The current state is itself
 * snapshotted first, so a restore is undoable.
 *
 * @returns {{ id:number, restored:number, snapshotId:number|null }}
 */
function restoreDirectorateVersion(database, versionId) {
  const numeric = toPositiveId(versionId);
  const version = database.prepare('SELECT * FROM directorate_versions WHERE id = ?').get(numeric);
  if (!version) throw new Error('اللقطة المطلوبة غير موجودة.');
  const payload = parseJson(version.payload_json, null);
  if (!payload?.record) throw new Error('اللقطة تالفة ولا يمكن استعادتها.');
  const record = payload.record;
  const sources = Array.isArray(payload.sources) ? payload.sources : [];

  const write = database.transaction(() => {
    const before = snapshotDirectorate(database, record.id, 'snapshot-before-restore');
    const columns = Object.keys(record).filter((column) => column !== 'id');
    if (!columns.length) throw new Error('اللقطة لا تحتوي أعمدة قابلة للاستعادة.');
    const values = columns.map((column) => record[column]);
    const exists = database.prepare('SELECT 1 AS ok FROM directorates WHERE id = ?').get(record.id);
    if (exists) {
      const assignments = columns.map((column) => `${column} = ?`).join(', ');
      database.prepare(`UPDATE directorates SET ${assignments} WHERE id = ?`).run(...values, record.id);
    } else {
      // The snapshot may be of a deleted row: recreate it with its original id so
      // historical results that reference it stay attached.
      const placeholders = ['?', ...columns.map(() => '?')].join(', ');
      database.prepare(`INSERT INTO directorates (id, ${columns.join(', ')}) VALUES (${placeholders})`).run(record.id, ...values);
    }

    database.prepare('DELETE FROM directorate_sources WHERE directorate_id = ?').run(record.id);
    const insert = database.prepare(`
      INSERT INTO directorate_sources (directorate_id, field_key, value_text, source_file, source_location, data_value_id, captured_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const source of sources) {
      insert.run(record.id, source.field_key, source.value_text ?? null, source.source_file ?? null, source.source_location ?? null, source.data_value_id ?? null, nowIso());
    }
    canonicalData.syncLegacyDirectorate(database,record.id,{ force: true });
    require('../database/architecture.cjs').syncLegacyDirectorateRecord(database,record.id);

    logAccess(database, {
      action: 'directorate-restore',
      entity: 'directorates',
      entityId: record.id,
      detail: `version=${numeric}`,
    });
    return { id: record.id, restored: record.id, snapshotId: before };
  });

  return write();
}

/** Persist the calibration that produced the latest accepted run. */
function setLastCalibration(database, calibration = {}) {
  setSetting(database, CALIBRATION_KEY, safeJson({
    kThreshold: calibration.kThreshold ?? null,
    deprivationLine: calibration.deprivationLine ?? null,
    weights: calibration.weights ?? null,
    savedAt: nowIso(),
  }, '{}'));
}

function getLastCalibration(database) {
  return parseJson(getSetting(database, CALIBRATION_KEY, null), null);
}

// OCR persistence was removed with the OCR feature. The ocr_drafts and
// ocr_field_confidence tables stay in the schema (an existing table is never
// dropped) but nothing reads or writes them.

function getWeights(database) {
  const active = database.prepare('SELECT * FROM analysis_weights WHERE active = 1 ORDER BY id DESC LIMIT 1').get();
  if (!active) return null;
  return { id: active.id, name: active.name, weights: parseJson(active.weights_json, {}), note: active.note, createdAt: active.created_at };
}

function setWeights(database, weights, note = null, name = 'default') {
  const write = database.transaction(() => {
    database.prepare('UPDATE analysis_weights SET active = 0 WHERE active = 1').run();
    database.prepare('INSERT INTO analysis_weights (name, weights_json, note, created_at, active) VALUES (?, ?, ?, ?, 1)')
      .run(name, safeJson(weights, '{}'), note, nowIso());
  });
  write();
  return getWeights(database);
}

function listWeights(database, limit = 50) {
  return database.prepare('SELECT * FROM analysis_weights ORDER BY id DESC LIMIT ?')
    .all(Math.min(500, Math.max(1, Number(limit) || 50)))
    .map((row) => ({ id: row.id, name: row.name, weights: parseJson(row.weights_json, {}), note: row.note, createdAt: row.created_at, active: Boolean(row.active) }));
}

function getSetting(database, key, fallback = null) {
  const row = database.prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function setSetting(database, key, value) {
  database.prepare(`
    INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, value === null || value === undefined ? null : String(value), nowIso());
}

/**
 * Accept only a real positive numeric id. `Number(true) === 1` would otherwise
 * let an IPC caller delete the first directorate by sending a boolean.
 */
function toPositiveId(value) {
  const invalid = new Error('معرّف المديرية غير صالح.');
  if (typeof value !== 'number' && typeof value !== 'string') throw invalid;
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric <= 0) throw invalid;
  return numeric;
}

/**
 * Read one directorate by its database id.
 * @throws when the id is not a positive integer or the record is missing.
 */
function getDirectorate(database, id) {
  const numeric = toPositiveId(id);
  const record = database.prepare('SELECT * FROM directorates WHERE id = ?').get(numeric);
  if (!record) throw new Error('المديرية المطلوبة غير موجودة.');
  return record;
}

/**
 * Coerce the manual-entry payload with the same parser used by the workbook
 * reader, so a value typed by hand and the same value imported from Excel are
 * stored identically (ratios 0..1, booleans 0|1, Arabic digits, percent signs).
 *
 * Empty inputs map to `null` (an explicit "clear"), and absent keys are omitted
 * so a future partial update cannot wipe untouched columns.
 *
 * @returns {{clean:object, rawValues:object, issues:Array}}
 */
function normalizeManualValues(values = {}) {
  const clean = {};
  const rawValues = {};
  const issues = [];

  for (const field of INPUT_FIELDS) {
    if (field.key === 'districtName' || field.key === 'governorate') continue;
    if (!Object.prototype.hasOwnProperty.call(values, field.key)) continue;

    const raw = values[field.key];
    const blank = raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '');
    if (blank) {
      clean[field.key] = null;
      rawValues[field.key] = null;
      continue;
    }

    const parsed = parseFieldValue(raw, field);
    if (parsed.state === 'invalid') {
      issues.push({ key: field.key, header: field.header, raw: String(raw) });
      continue;
    }
    if (field.type === 'text' && parsed.state === 'ok' && parsed.value.length > 2000) {
      issues.push({ key: field.key, header: field.header, raw: 'نص أطول من الحد المسموح (2000 حرف)' });
      continue;
    }
    clean[field.key] = parsed.state === 'ok' ? parsed.value : null;
    rawValues[field.key] = typeof raw === 'string' ? raw.trim() : String(raw);
  }

  // The decision column (BC) is not part of INPUT_FIELDS but is a real column
  // the review screen and the manual form both write.
  if (Object.prototype.hasOwnProperty.call(values, DECISION_FIELD.key)) {
    const raw = values[DECISION_FIELD.key];
    const text = raw === null || raw === undefined ? '' : String(raw).trim();
    if (!text) {
      clean[DECISION_FIELD.key] = null;
      rawValues[DECISION_FIELD.key] = null;
    } else if (DECISION_FIELD.allowed.includes(text)) {
      clean[DECISION_FIELD.key] = text;
      rawValues[DECISION_FIELD.key] = text;
    } else {
      issues.push({ key: DECISION_FIELD.key, header: DECISION_FIELD.header, raw: text });
    }
  }

  return { clean, rawValues, issues };
}

/**
 * Create or update one directorate from the manual-entry screen.
 *
 * The identity is `(governorate, district)` exactly as everywhere else, so a
 * rename that collides with a stored record is refused instead of silently
 * merging two directorates.
 *
 * @param {object} database
 * @param {{id?:number, districtName:string, governorate?:string, values?:object}} request
 * @returns {{id:number, created:boolean}}
 */
function saveManualDirectorate(database, request = {}) {
  const rawId = request.id;
  const id = rawId === undefined || rawId === null || rawId === '' ? null : toPositiveId(rawId);

  const district = String(request.districtName ?? '').trim();
  const governorate = String(request.governorate ?? '').trim();
  if (!district) throw new Error('اسم المديرية مطلوب.');
  if (district.length > 200) throw new Error('اسم المديرية أطول من الحد المسموح (200 حرف).');
  if (governorate.length > 200) throw new Error('اسم المحافظة أطول من الحد المسموح (200 حرف).');

  const { clean, rawValues, issues } = normalizeManualValues(request.values ?? {});
  if (issues.length) {
    throw new Error(`قيم غير صالحة: ${issues.map((issue) => `«${issue.header}» (${issue.raw})`).join('، ')}`);
  }

  const write = database.transaction(() => {
    const timestamp = nowIso();
    let targetId = id;
    let created = false;
    let identityChanged = false;
    /** Pre-save row, used to tell which fields the operator really changed. */
    let storedRecord = null;

    if (targetId === null) {
      const clash = database
        .prepare('SELECT id FROM directorates WHERE governorate = ? AND district = ?')
        .get(governorate, district);
      if (clash) {
        throw new Error(`توجد مديرية مسجّلة بالاسم «${district}» في «${governorate || 'بلا محافظة'}». عدّلها بدل إضافتها مجددًا.`);
      }
    } else {
      storedRecord = getDirectorate(database, targetId);
      const existing = storedRecord;
      identityChanged = existing.governorate !== governorate || existing.district !== district;
      const clash = database
        .prepare('SELECT id FROM directorates WHERE governorate = ? AND district = ? AND id <> ?')
        .get(governorate, district, targetId);
      if (clash) throw new Error(`توجد مديرية أخرى بالاسم «${district}» في «${governorate || 'بلا محافظة'}».`);
    }

    const columns = [];
    const params = [];
    for (const [key, column] of COLUMN_ENTRIES) {
      if (column === 'governorate' || column === 'district') continue;
      if (!Object.prototype.hasOwnProperty.call(clean, key)) continue;
      columns.push(column);
      params.push(toColumnValue(key, clean[key]));
    }

    // A warning is cleared only for a field whose stored value actually changed
    // in this save. The Correction screen posts the whole form, so `clean` holds
    // every key; treating all of them as authoritative would erase the import
    // blocker (invalid raw text + reason) of every field the operator never
    // touched. The record was read before the UPDATE, so this compares against
    // the pre-save state. A brand new row starts with no warnings at all.
    let refreshedWarnings = '[]';
    if (targetId !== null && storedRecord) {
      const columnByKey = new Map(COLUMN_ENTRIES);
      const dirtyKeys = new Set();
      for (const key of Object.keys(clean)) {
        const column = columnByKey.get(key);
        if (!column) continue;
        if (!sameStoredValue(toColumnValue(key, clean[key]), storedRecord[column])) dirtyKeys.add(key);
      }
      const storedWarnings = parseJson(storedRecord.import_warnings, []);
      const kept = Array.isArray(storedWarnings)
        ? storedWarnings.filter((warning) => !warning || !dirtyKeys.has(warning.key))
        : [];
      refreshedWarnings = safeJson(kept, '[]');
    }

    if (targetId === null) {
      const insertColumns = ['governorate', 'district', ...columns, 'source_file', 'source_sheet', 'source_row', 'import_warnings', 'updated_at'];
      const insertParams = [governorate, district, ...params, MANUAL_SOURCE, MANUAL_SOURCE, null, refreshedWarnings, timestamp];
      const placeholders = insertColumns.map(() => '?').join(', ');
      const info = database
        .prepare(`INSERT INTO directorates (${insertColumns.join(', ')}) VALUES (${placeholders})`)
        .run(...insertParams);
      targetId = Number(info.lastInsertRowid);
      created = true;
    } else {
      // Keep an undo point before the row changes.
      snapshotDirectorate(database, targetId, 'snapshot-before-update');
      const assignments = ['governorate = ?', 'district = ?', ...columns.map((column) => `${column} = ?`), 'import_warnings = ?', 'updated_at = ?'];
      const updateParams = [governorate, district, ...params, refreshedWarnings, timestamp];
      if (identityChanged) {
        // A renamed record no longer mirrors the workbook row it came from, so
        // it must stop advertising that file as its source. Otherwise a later
        // template re-import would recreate the old identity as a second row.
        assignments.push('source_file = ?', 'source_sheet = ?', 'source_row = ?');
        updateParams.push(MANUAL_SOURCE, MANUAL_SOURCE, null);
      }
      database
        .prepare(`UPDATE directorates SET ${assignments.join(', ')} WHERE id = ?`)
        .run(...updateParams, targetId);
    }

    // Keep provenance truthful: a cleared field loses its old source row, while a
    // stored value keeps the text the operator actually typed.
    const upsertSource = database.prepare(`
      INSERT INTO directorate_sources (directorate_id, field_key, value_text, source_file, source_location, captured_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(directorate_id, field_key) DO UPDATE SET
        value_text = excluded.value_text,
        source_file = excluded.source_file,
        source_location = excluded.source_location,
        captured_at = excluded.captured_at
    `);
    const clearSource = database.prepare('DELETE FROM directorate_sources WHERE directorate_id = ? AND field_key = ?');
    for (const [key] of COLUMN_ENTRIES) {
      if (!Object.prototype.hasOwnProperty.call(clean, key)) continue;
      if (clean[key] === null) {
        clearSource.run(targetId, key);
        continue;
      }
      upsertSource.run(targetId, key, rawValues[key] ?? null, MANUAL_SOURCE, null, timestamp);
    }

    if (identityChanged) {
      // The identity is not part of `clean`, so refresh its provenance explicitly.
      upsertSource.run(targetId, 'districtName', district, MANUAL_SOURCE, null, timestamp);
      upsertSource.run(targetId, 'governorate', governorate, MANUAL_SOURCE, null, timestamp);
    }

    database
      .prepare('INSERT INTO access_log (action, entity, entity_id, fields, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(
        created ? 'manual-create' : 'manual-update',
        'directorates',
        String(targetId),
        String(columns.length),
        `district=${district};governorate=${governorate}`,
        timestamp,
      );

    canonicalData.syncLegacyDirectorate(database,targetId);
    require('../database/architecture.cjs').syncLegacyDirectorateRecord(database,targetId);
    return { id: targetId, created };
  });

  return write();
}

/**
 * Hard-delete one directorate and its provenance rows.
 * Historical analysis runs keep their own snapshot, so past reports stay valid.
 */
function deleteDirectorate(database, id) {
  const numeric = toPositiveId(id);

  const write = database.transaction(() => {
    const record = database
      .prepare('SELECT id, governorate, district FROM directorates WHERE id = ?')
      .get(numeric);
    if (!record) throw new Error('المديرية المطلوبة غير موجودة.');

    // Keep the row recoverable: deleting is a deliberate act, but not an
    // irreversible one.
    snapshotDirectorate(database, numeric, 'snapshot-before-delete');
    require('../database/record-service.cjs').archiveLinkedDirectorate(database,numeric,'manual-delete',nowIso());

    // SQLite may reuse a deleted rowid. Detach historical results first so a new
    // directorate that later gets the same id cannot inherit an old report.
    database.prepare('UPDATE analysis_results SET directorate_id = NULL WHERE directorate_id = ?').run(numeric);
    database.prepare('DELETE FROM directorate_sources WHERE directorate_id = ?').run(numeric);
    database.prepare('DELETE FROM directorates WHERE id = ?').run(numeric);
    canonicalData.retireLegacyDirectorate(database,numeric);
    database
      .prepare('INSERT INTO access_log (action, entity, entity_id, fields, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('manual-delete', 'directorates', String(numeric), '', `district=${record.district};governorate=${record.governorate}`, nowIso());

    return { id: numeric, district: record.district, governorate: record.governorate };
  });

  return write();
}

module.exports = {
  getDirectorate,
  saveManualDirectorate,
  deleteDirectorate,
  normalizeManualValues,
  MANUAL_SOURCE,
  upsertDirectorate,
  upsertDirectorates,
  listDirectorates,
  listDirectorateFilterOptions,
  countDirectorates,
  loadAnalysisRows,
  rowFromDirectorate,
  saveRun,
  getRun,
  getLatestRun,
  listRuns,
  logAccess,
  listAccess,
  logRead,
  listReads,
  snapshotDirectorate,
  listVersions,
  restoreDirectorateVersion,
  setLastCalibration,
  getLastCalibration,
  CALIBRATION_KEY,
  VERSION_KEEP,
  getWeights,
  setWeights,
  listWeights,
  getSetting,
  setSetting,
  toColumnValue,
  DECISION_FIELD,
};
