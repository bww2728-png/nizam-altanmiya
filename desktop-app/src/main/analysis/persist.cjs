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

const FIELD_BY_KEY = new Map(INPUT_FIELDS.map((field) => [field.key, field]));
const COLUMN_ENTRIES = Object.entries(DIRECTORATE_COLUMNS);

/** Directories beyond this count are refused loudly rather than truncated. */
const ANALYSIS_ROW_CAP = 50000;

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
    if (key === 'reviewerDecision') continue; // decided in the review screen, not on import
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
    database.prepare(`UPDATE directorates SET ${assignments.join(', ')} WHERE id = ?`).run(...updateParams, existing.id);
    saveProvenance(database, existing.id, record, rawValues, sources, meta);
    return { id: existing.id, created: false };
  }

  const insertColumns = [...columns, 'source_file', 'source_sheet', 'source_row'];
  const insertParams = [...params, meta.fileName ?? null, meta.sheetName ?? null, record.rowNumber ?? null];
  const placeholders = insertColumns.map(() => '?').join(', ');
  const info = database
    .prepare(`INSERT INTO directorates (${insertColumns.join(', ')}) VALUES (${placeholders})`)
    .run(...insertParams);
  const id = Number(info.lastInsertRowid);
  saveProvenance(database, id, record, rawValues, sources, meta);
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
      if (key === 'reviewerDecision') continue;
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

/** All stored directorates, joined with their main indicator inputs. */
function listDirectorates(database, filter = {}) {
  const governorate = filter.governorate ? String(filter.governorate).trim() : null;
  const search = filter.search ? String(filter.search).trim() : null;
  const limit = Math.min(5000, Math.max(1, Number(filter.limit) || 2000));
  const clauses = [];
  const params = [];
  if (governorate) { clauses.push('governorate = ?'); params.push(governorate); }
  if (search) { clauses.push('district LIKE ?'); params.push(`%${search}%`); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  params.push(limit);
  return database.prepare(`SELECT * FROM directorates ${where} ORDER BY governorate, district LIMIT ?`).all(...params);
}

function countDirectorates(database) {
  return database.prepare('SELECT COUNT(*) AS count FROM directorates').get().count;
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
    values,
    rawValues,
    sources: {},
    warnings: [],
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
  const governorate = filter.governorate ? String(filter.governorate).trim() : null;
  const clauses = [];
  const params = [];
  if (governorate) { clauses.push('governorate = ?'); params.push(governorate); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = database
    .prepare(`SELECT * FROM directorates ${where} ORDER BY governorate, district LIMIT ${ANALYSIS_ROW_CAP + 1}`)
    .all(...params);
  if (rows.length > ANALYSIS_ROW_CAP) {
    throw new Error(`عدد المديريات يتجاوز الحد الآمن للتحليل (${ANALYSIS_ROW_CAP}). جزّئ البيانات أو صفِّ حسب المحافظة قبل التحليل.`);
  }
  return rows.map(rowFromDirectorate);
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

module.exports = {
  upsertDirectorate,
  upsertDirectorates,
  listDirectorates,
  countDirectorates,
  loadAnalysisRows,
  rowFromDirectorate,
  saveRun,
  getRun,
  getLatestRun,
  listRuns,
  logAccess,
  listAccess,
  getWeights,
  setWeights,
  listWeights,
  getSetting,
  setSetting,
  toColumnValue,
  DECISION_FIELD,
};
