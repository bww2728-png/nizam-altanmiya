'use strict';

/**
 * Bridge between the two data paths that 0.3.0 kept apart.
 *
 * Path A (import → review → `data_values`) and path B (template/manual →
 * `directorates`) never met, so 40 000 approved values could sit in the store
 * while the analysis screen insisted there was no data. This module is the
 * missing join: approved values are mapped back to template keys and written as
 * a directorate, with the originating `data_values.id` recorded on the
 * provenance row (`directorate_sources.data_value_id`) so a value can always be
 * traced to the exact approved record it came from.
 */

const { INPUT_FIELDS, FIELD_BY_KEY } = require('./schema.cjs');
const { matchHeader } = require('./mapping.cjs');
const { parseFieldValue } = require('./parse.cjs');
const persist = require('./persist.cjs');

const TEMPLATE_KEYS = new Set(INPUT_FIELDS.map((field) => field.key));

/**
 * Approved values grouped by directorate, with how many of them can actually be
 * mapped onto the template. This is what the UI lists before a bridge run.
 */
function listCandidates(database) {
  const groups = database.prepare(`
    SELECT governorate, district, field_name, value_text
    FROM data_values
    WHERE governorate <> '' AND district <> ''
  `).all();

  const byKey = new Map();
  for (const row of groups) {
    const key = `${row.governorate}|${row.district}`;
    let entry = byKey.get(key);
    if (!entry) {
      entry = { governorate: row.governorate, district: row.district, total: 0, mapped: 0, fields: new Set(), unknown: new Set() };
      byKey.set(key, entry);
    }
    entry.total += 1;
    const match = matchHeader(row.field_name);
    if (match.key && TEMPLATE_KEYS.has(match.key)) {
      entry.mapped += 1;
      entry.fields.add(match.key);
    } else {
      entry.unknown.add(String(row.field_name ?? '').slice(0, 80));
    }
  }

  const existing = new Map(
    database.prepare('SELECT id, governorate, district FROM directorates').all()
      .map((record) => [`${record.governorate}|${record.district}`, record.id]),
  );

  return [...byKey.values()]
    .map((entry) => ({
      governorate: entry.governorate,
      district: entry.district,
      key: `${entry.governorate}|${entry.district}`,
      totalValues: entry.total,
      mappedFields: entry.fields.size,
      unmappedFields: [...entry.unknown].slice(0, 8),
      directorateId: existing.get(`${entry.governorate}|${entry.district}`) ?? null,
    }))
    .filter((entry) => entry.mappedFields > 0)
    .sort((left, right) => right.mappedFields - left.mappedFields || left.district.localeCompare(right.district, 'ar'));
}

/**
 * Map one approved `data_values` set onto template values.
 *
 * The first approved value per field wins: `data_values` is unique on
 * (geo, record, field), so a later row for the same field can only come from a
 * different record, which is a different directorate-level statement.
 */
function collectValues(database, governorate, district) {
  const rows = database.prepare(`
    SELECT id, field_name, value_text
    FROM data_values
    WHERE governorate = ? AND district = ?
    ORDER BY id
  `).all(governorate, district);

  const values = {};
  const rawValues = {};
  const valueIds = {};
  const issues = [];
  const unmapped = [];

  for (const row of rows) {
    const match = matchHeader(row.field_name);
    if (!match.key || !TEMPLATE_KEYS.has(match.key)) {
      unmapped.push(String(row.field_name ?? '').slice(0, 120));
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(values, match.key)) continue;
    const field = FIELD_BY_KEY[match.key];
    if (field.key === 'districtName' || field.key === 'governorate') continue;
    const parsed = parseFieldValue(row.value_text, field);
    if (parsed.state === 'invalid') {
      issues.push({ key: match.key, header: field.header, raw: row.value_text, code: `invalid-${field.type}` });
      continue;
    }
    if (parsed.state === 'empty') continue;
    values[match.key] = parsed.value;
    rawValues[match.key] = String(row.value_text ?? '');
    valueIds[match.key] = row.id;
    for (const warning of parsed.warnings) {
      issues.push({ key: match.key, header: field.header, raw: row.value_text, code: warning.code });
    }
  }

  return { values, rawValues, valueIds, issues, unmapped };
}

/**
 * Write one directorate from approved values.
 *
 * @returns {{key:string, directorateId:number|null, created:boolean, mapped:number, skipped:boolean, reason?:string, issues:Array}}
 */
function bridgeOne(database, governorate, district) {
  const key = `${governorate}|${district}`;
  const collected = collectValues(database, governorate, district);
  const mapped = Object.keys(collected.values).filter((fieldKey) => fieldKey !== 'districtName' && fieldKey !== 'governorate');
  if (!mapped.length) {
    return { key, directorateId: null, created: false, mapped: 0, skipped: true, reason: 'no-mapped-fields', issues: collected.issues };
  }

  const write = database.transaction(() => {
    const saved = persist.saveManualDirectorate(database, {
      districtName: district,
      governorate,
      values: collected.values,
    });
    const updateSource = database.prepare(`
      UPDATE directorate_sources SET data_value_id = ?
      WHERE directorate_id = ? AND field_key = ?
    `);
    for (const [fieldKey, valueId] of Object.entries(collected.valueIds)) {
      if (fieldKey === 'districtName' || fieldKey === 'governorate') continue;
      updateSource.run(valueId, saved.id, fieldKey);
    }
    persist.logAccess(database, {
      action: saved.created ? 'bridge-create' : 'bridge-update',
      entity: 'directorates',
      entityId: saved.id,
      fields: String(mapped.length),
      detail: `${key};unmapped=${collected.unmapped.length}`,
    });
    return saved;
  });

  const saved = write();
  return {
    key,
    directorateId: saved.id,
    created: saved.created,
    mapped: mapped.length,
    skipped: false,
    issues: collected.issues,
  };
}

/**
 * Bridge every candidate (or an explicit subset).
 *
 * A row that fails validation is reported and skipped; it never aborts the run,
 * because one bad district must not block the other 332.
 */
function bridgeAll(database, options = {}) {
  const only = Array.isArray(options.keys) && options.keys.length ? new Set(options.keys) : null;
  const candidates = listCandidates(database).filter((entry) => !only || only.has(entry.key));
  const results = [];
  for (const candidate of candidates) {
    try {
      results.push(bridgeOne(database, candidate.governorate, candidate.district));
    } catch (error) {
      results.push({
        key: candidate.key,
        directorateId: null,
        created: false,
        mapped: 0,
        skipped: true,
        reason: error.message,
        issues: [],
      });
    }
  }
  return {
    total: results.length,
    created: results.filter((entry) => entry.created).length,
    updated: results.filter((entry) => !entry.created && !entry.skipped).length,
    skipped: results.filter((entry) => entry.skipped).length,
    fields: results.reduce((sum, entry) => sum + entry.mapped, 0),
    results: results.filter((entry) => entry.skipped).slice(0, 50),
  };
}

module.exports = { listCandidates, collectValues, bridgeOne, bridgeAll };