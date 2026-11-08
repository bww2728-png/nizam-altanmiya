'use strict';

/**
 * Data-access policy for the local store.
 *
 * The previous build *labelled* fields as `restricted`/`sensitive` in the
 * schema but never enforced the label: every value was returned by every IPC
 * channel and written into every export. Since the application has no user
 * accounts (by design, it is a single-operator desktop tool), a real
 * per-user permission model would be theatre. What is enforceable — and what
 * actually matters when the file or the exported report leaves this machine —
 * is a two-profile switch:
 *
 *   owner  : the person operating the machine; sees every field.
 *   shared : the machine/report is being used with someone else present or the
 *            export will be handed to a third party; restricted and sensitive
 *            values are masked in reads and omitted from exports, and every
 *            masked read is written to `audit_reads`.
 *
 * Masking is applied at the IPC boundary (never in SQL) so the stored data and
 * the analysis results remain complete and auditable.
 */

const { INPUT_FIELDS, MANDATORY_FIELDS, DECISION_FIELD } = require('./analysis/schema.cjs');
const columns = require('./analysis/columns.cjs');

const ACCESS_PROFILE_KEY = 'access.profile';
const PROFILES = ['owner', 'shared'];
const DEFAULT_PROFILE = 'owner';

/** Canonical keys whose sensitivity is not `public`, in schema order. */
const RESTRICTED_KEYS = INPUT_FIELDS.filter((field) => field.sensitivity === 'restricted').map((field) => field.key);
const SENSITIVE_KEYS = INPUT_FIELDS.filter((field) => field.sensitivity === 'sensitive').map((field) => field.key);
const PROTECTED_KEYS = [...RESTRICTED_KEYS, ...SENSITIVE_KEYS, DECISION_FIELD.key];
const PROTECTED_SET = new Set(PROTECTED_KEYS);

const PROFILE_LABELS = {
  owner: 'مالك الجهاز — كل الحقول مرئية',
  shared: 'وضع المشاركة — الحقول المقيّدة والحساسة محجوبة',
};

/** Normalise any input to a known profile name. */
function normalizeProfile(value) {
  const text = String(value ?? '').trim().toLowerCase();
  return PROFILES.includes(text) ? text : DEFAULT_PROFILE;
}

function getAccessProfile(database) {
  try {
    const row = database.prepare('SELECT value FROM app_settings WHERE key = ?').get(ACCESS_PROFILE_KEY);
    return normalizeProfile(row?.value);
  } catch {
    return DEFAULT_PROFILE;
  }
}

function setAccessProfile(database, profile) {
  const next = normalizeProfile(profile);
  database.prepare(`
    INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(ACCESS_PROFILE_KEY, next, new Date().toISOString());
  return next;
}

/** True when `key` must be masked under the given profile. */
function isProtected(key, profile) {
  return normalizeProfile(profile) === 'shared' && PROTECTED_SET.has(key);
}

/**
 * Mask protected values on a plain directorate record (column-keyed object).
 * Columns are the DB names, so the caller passes a key->column map or uses the
 * defaults derived from the schema.
 *
 * @returns {{ record:object, masked:string[] }}
 */
function maskRecord(record, profile, columnsByKey = null) {
  const masked = [];
  if (!record || normalizeProfile(profile) !== 'shared') return { record, masked };
  const output = { ...record };
  const mapping = columnsByKey ?? Object.fromEntries(INPUT_FIELDS.map((field) => [field.key, field.key]));
  for (const key of PROTECTED_KEYS) {
    const column = mapping[key] ?? key;
    if (!(column in output)) continue;
    if (output[column] === null || output[column] === undefined) continue;
    output[column] = null;
    masked.push(key);
  }
  // `import_warnings` is a JSON column that carries the rejected raw cell text
  // (`raw`) and the parsed value for every field. A warning about a protected
  // field would leak the very value that was just nulled, so the column is
  // filtered by key here — this is the same rule `maskInputRows` applies.
  if ('import_warnings' in output && output.import_warnings) {
    output.import_warnings = JSON.stringify(redactWarnings(output.import_warnings, profile));
  }
  return { record: output, masked };
}

/**
 * Drop every parse warning that names a protected field. A warning carries the
 * rejected raw text, so filtering by key is what stops the raw value leaking
 * through a channel that otherwise returns masked values.
 */
function redactWarnings(warnings, profile) {
  if (normalizeProfile(profile) !== 'shared') return warnings;
  let list = warnings;
  if (typeof list === 'string') {
    try { list = JSON.parse(list); } catch { return []; }
  }
  if (!Array.isArray(list)) return [];
  return list.filter((warning) => !PROTECTED_SET.has(warning?.key));
}

/**
 * Mask the `values`/`rawValues` payload of an engine-shaped row.
 *
 * The row's `completeness` and `confidence` are derived from the same values;
 * left untouched they would disclose which protected fields (revenue, front
 * line, ...) are empty, so both are recomputed over the visible fields.
 * @returns {{ row:object, masked:string[] }}
 */
function maskEngineRow(row, profile) {
  if (!row || normalizeProfile(profile) !== 'shared') return { row, masked: [] };
  const masked = [];
  const values = { ...(row.values ?? {}) };
  const rawValues = { ...(row.rawValues ?? {}) };
  const sources = { ...(row.sources ?? {}) };
  for (const key of PROTECTED_KEYS) {
    // Raw text and provenance are cleared unconditionally: a protected key may
    // hold a rejected raw string even when its parsed value is null, so gating
    // on the parsed value would leave that raw string exposed.
    delete rawValues[key];
    delete sources[key];
    if (values[key] === null || values[key] === undefined) continue;
    values[key] = null;
    masked.push(key);
  }
  const output = { ...row, values, rawValues, sources };
  // Derived state is computed from the protected values — indicators (revenue
  // per capita), the project classification, the calibrated/replica composites,
  // the boundary verdicts and the sensitivity study. The `analysis:row-detail`
  // channel already omits them on purpose, but clearing them on the returned row
  // means a future `{ ...masked.row }` spread cannot carry them past the IPC
  // boundary by accident.
  output.indicators = {};
  output.project = null;
  output.calibrated = null;
  output.replica = null;
  output.boundary = null;
  output.sensitivity = null;
  // `warnings` carries a protected key's rejected raw text, so filter by key too.
  output.warnings = Array.isArray(output.warnings) ? redactWarnings(output.warnings, 'shared') : output.warnings;
  if (row.completeness) {
    output.completeness = redactEngineCompleteness(row.completeness, values);
  }
  // `confidence` is derived from the indicators and the composite, which are
  // themselves derived from the protected values; it is withheld wholesale
  // rather than recomputed from a still-unmasked indicator map.
  if (row.confidence) output.confidence = null;
  return { row: output, masked };
}

/** Recompute an engine row's completeness over the non-protected mandatory fields. */
function redactEngineCompleteness(completeness, values) {
  const visible = MANDATORY_FIELDS.filter((field) => !PROTECTED_SET.has(field.key));
  const missing = visible.filter((field) => !columns.isPresent(field, values?.[field.key]));
  const present = visible.length - missing.length;
  const total = visible.length;
  return {
    present,
    total,
    ratio: total ? Math.round((present / total) * 1000) / 1000 : 0,
    missing,
    missingLabels: missing.map((field) => field.label),
    missingText: missing.length ? missing.map((field) => field.label).join('، ') : 'مكتملة',
    waiting: present < total,
  };
}

/** Field keys that must never appear in a third-party export under `shared`. */
function protectedKeysForExport(profile) {
  return normalizeProfile(profile) === 'shared' ? [...PROTECTED_KEYS] : [];
}

/**
 * Recompute a row's completeness over the visible mandatory fields only.
 *
 * `MANDATORY_FIELDS` includes protected keys (revenue is restricted, frontLine
 * is sensitive), so in `shared` mode both the missing-field list and the ratio
 * would otherwise disclose which restricted cells are empty. The counts are
 * rebuilt over the non-protected fields so they stay internally consistent.
 */
function redactCompleteness(completeness) {
  if (!completeness) return completeness;
  const visible = MANDATORY_FIELDS.filter((field) => !PROTECTED_SET.has(field.key));
  const missing = (completeness.missing ?? []).filter((key) => !PROTECTED_SET.has(key));
  const missingFields = visible.filter((field) => missing.includes(field.key));
  const total = visible.length;
  return {
    ...completeness,
    present: total - missingFields.length,
    total,
    ratio: total ? (total - missingFields.length) / total : 0,
    missing: missingFields.map((field) => field.key),
    missingLabels: missingFields.map((field) => field.label),
  };
}

/**
 * Strip protected fields from an import-plan summary before it crosses the IPC
 * boundary. The plan is read straight from a workbook, so its preview would
 * otherwise carry restricted values (budget, revenue, front line, decision) in
 * `shared` mode even though every other channel redacts them.
 *
 * The summary shape is `{ changedFields, missingInputs, preview: [{ completeness, anomalyKeys, issues, changes }] }`;
 * every per-field list is filtered by key, which also drops the `raw`/`before`/
 * `after` values the entries carry.
 */
function redactPlanSummary(summary, profile) {
  if (!summary || normalizeProfile(profile) !== 'shared') return summary;
  return {
    ...summary,
    changedFields: (summary.changedFields ?? []).filter((key) => !PROTECTED_SET.has(key)),
    missingInputs: (summary.missingInputs ?? []).filter((item) => !PROTECTED_SET.has(item?.key)),
    preview: (summary.preview ?? []).map((row) => ({
      ...row,
      completeness: redactCompleteness(row.completeness),
      anomalyKeys: (row.anomalyKeys ?? []).filter((key) => !PROTECTED_SET.has(key)),
      issues: (row.issues ?? []).filter((issue) => !PROTECTED_SET.has(issue.key)),
      changes: (row.changes ?? []).filter((change) => !PROTECTED_SET.has(change.key)),
    })),
  };
}

/**
 * Drop the protected fields from engine input rows before re-deriving a result.
 *
 * Masking a finished analysis is not enough: indicators (revenue per capita),
 * the project label and the composites are all derived from the protected values
 * and would let a third party reconstruct them. Removing the keys first makes
 * every row equally "missing" those fields, so the re-derived report cannot
 * distinguish an empty protected cell from a filled one.
 */
function maskInputRows(rows, profile) {
  if (normalizeProfile(profile) !== 'shared') return rows;
  return (rows ?? []).map((row) => {
    const values = { ...(row.values ?? {}) };
    const rawValues = { ...(row.rawValues ?? {}) };
    const sources = { ...(row.sources ?? {}) };
    for (const key of PROTECTED_KEYS) {
      delete values[key];
      delete rawValues[key];
      delete sources[key];
    }
    // A parse warning carries the rejected raw text, so one about a protected
    // field would leak the very value that was removed from `values`.
    const warnings = (row.warnings ?? []).filter((warning) => !PROTECTED_SET.has(warning.key));
    return { ...row, values, rawValues, sources, warnings };
  });
}

/**
 * Mask a stored run (persist.getLatestRun shape) for the `shared` profile. The
 * persisted rows carry indicators, project type, confidence and file provenance
 * derived from the protected values, so they are cleared wholesale; only the
 * identity and the completeness count remain.
 */
function maskStoredRun(payload, profile) {
  if (!payload || normalizeProfile(profile) !== 'shared') return payload;
  const results = (payload.results ?? []).map((result) => ({
    ...result,
    indicators: {},
    // `completeness` is the filled count over the 13 mandatory fields, three of
    // which are protected: keeping the ratio would let a viewer infer how many
    // restricted cells are populated. It is cleared with the rest of the
    // derived state.
    completeness: null,
    missingLabels: null,
    sensitivity: null,
    projectType: null,
    confidenceText: null,
    confidenceLevel: null,
    sourceFile: null,
    gaps: [],
    calibrated: result.calibrated
      ? {
        ...result.calibrated,
        composite: null,
        rank: null,
        degradedCount: null,
        severe: null,
        blocked: null,
        blockReason: null,
        weightCoverage: null,
      }
      : result.calibrated,
    replica: result.replica
      ? { ...result.replica, composite: null, rank: null }
      : result.replica,
  }));
  // The run summary aggregates the same derived values (average completeness,
  // severe count, gap codes) and the template path names the source workbook, so
  // both are dropped wholesale rather than partially filtered.
  const run = payload.run
    ? { ...payload.run, templateFile: null, summary: null }
    : payload.run;
  return { ...payload, run, results };
}

module.exports = {
  ACCESS_PROFILE_KEY,
  PROFILES,
  DEFAULT_PROFILE,
  PROFILE_LABELS,
  RESTRICTED_KEYS,
  SENSITIVE_KEYS,
  PROTECTED_KEYS,
  normalizeProfile,
  getAccessProfile,
  setAccessProfile,
  isProtected,
  maskRecord,
  redactWarnings,
  maskEngineRow,
  protectedKeysForExport,
  redactPlanSummary,
  maskInputRows,
  maskStoredRun,
};