'use strict';

/**
 * Contract tests for shared-mode redaction.
 *
 * `security.cjs` is the policy module; `main.cjs` (the Electron entry) applies
 * it at the IPC boundary. Because `main.cjs` requires `electron` it cannot be
 * imported from a test, so the one redaction expression used by the
 * `analysis:directorate:get` channel is replicated here verbatim and driven
 * against the real policy it calls.
 *
 * The contract:
 *  - under `shared`, a protected `directorate_sources` row has its `value_text`
 *    redacted to null while a public row keeps it;
 *  - under `owner`, every row is returned unchanged (same reference);
 *  - the protected set is exactly RESTRICTED_KEYS + SENSITIVE_KEYS + the
 *    decision field.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const security = require('../src/main/security.cjs');
const { DECISION_FIELD } = require('../src/main/analysis/schema.cjs');
const { DIRECTORATE_COLUMNS } = require('../src/main/analysis/store-schema.cjs');

/**
 * Exact expression from src/main/main.cjs (~:607-609, analysis:directorate:get):
 *
 *   const sources = profile === 'shared'
 *     ? sourceRows.map((source) => (security.isProtected(source.field_key, profile)
 *         ? { ...source, value_text: null } : source))
 *     : sourceRows;
 */
function redactSourceRows(sourceRows, profile) {
  return profile === 'shared'
    ? sourceRows.map((source) => (security.isProtected(source.field_key, profile) ? { ...source, value_text: null } : source))
    : sourceRows;
}

/** One public provenance row plus one per protected key. */
const SOURCE_ROWS = [
  { field_key: 'population', value_text: '43739', source_file: 'book.xlsx', source_location: 'C3', data_value_id: null, captured_at: 't' },
  ...security.PROTECTED_KEYS.map((key) => ({
    field_key: key,
    value_text: `value-of-${key}`,
    source_file: 'book.xlsx',
    source_location: 'X3',
    data_value_id: null,
    captured_at: 't',
  })),
];

test('the protected set is exactly the restricted, sensitive and decision keys', () => {
  for (const key of security.PROTECTED_KEYS) {
    assert.equal(security.isProtected(key, 'shared'), true, `${key} must be protected under shared`);
    assert.equal(security.isProtected(key, 'owner'), false, `${key} must be visible under owner`);
  }
  for (const key of security.RESTRICTED_KEYS) assert.ok(security.PROTECTED_KEYS.includes(key));
  for (const key of security.SENSITIVE_KEYS) assert.ok(security.PROTECTED_KEYS.includes(key));
  assert.ok(security.PROTECTED_KEYS.includes(DECISION_FIELD.key), 'the decision field is protected');
  assert.equal(security.isProtected('population', 'shared'), false);
  assert.equal(security.isProtected('schools', 'shared'), false);
  // An unknown profile falls back to owner and protects nothing.
  assert.equal(security.isProtected('revenue', 'garbage'), false);
});

test('shared mode redacts the value_text of every protected provenance row', () => {
  const redacted = redactSourceRows(SOURCE_ROWS, 'shared');
  const byKey = Object.fromEntries(redacted.map((entry) => [entry.field_key, entry]));

  assert.equal(byKey.population.value_text, '43739', 'a public field keeps its provenance text');
  for (const key of security.PROTECTED_KEYS) {
    assert.equal(byKey[key].value_text, null, `${key} value_text must be redacted under shared`);
  }

  // The source coordinates and file stay: they carry no field value.
  assert.equal(byKey.revenue.source_file, 'book.xlsx');
  assert.equal(byKey.revenue.source_location, 'X3');
  // The originals are never mutated in place.
  assert.equal(SOURCE_ROWS.find((entry) => entry.field_key === 'revenue').value_text, 'value-of-revenue');
});

test('owner mode returns the provenance rows untouched and by reference', () => {
  const visible = redactSourceRows(SOURCE_ROWS, 'owner');
  assert.equal(visible, SOURCE_ROWS, 'owner does not copy or filter the rows');
  assert.deepEqual(visible, SOURCE_ROWS);
});

test('maskRecord nulls protected DB columns under shared and is a no-op under owner', () => {
  const record = {
    district: 'مديرية',
    governorate: 'إب',
    population: 43739,
    revenue: 75643312,
    front_line: 0,
    reviewer_decision: 'معتمد',
  };

  const shared = security.maskRecord(record, 'shared', DIRECTORATE_COLUMNS);
  assert.equal(shared.record.revenue, null);
  assert.equal(shared.record.front_line, null);
  assert.equal(shared.record.reviewer_decision, null);
  assert.equal(shared.record.population, 43739, 'a public column is untouched');
  assert.ok(shared.masked.includes('revenue'));
  assert.ok(shared.masked.includes('frontLine'));
  assert.ok(shared.masked.includes('reviewerDecision'));

  const owner = security.maskRecord(record, 'owner', DIRECTORATE_COLUMNS);
  assert.deepEqual(owner.record, record);
  assert.deepEqual(owner.masked, []);
});

test('maskRecord filters import_warnings that carry a protected raw value', () => {
  const record = {
    district: 'مديرية',
    governorate: 'إب',
    population: 43739,
    revenue: 75643312,
    import_warnings: JSON.stringify([
      { key: 'revenue', code: 'percent-converted', raw: '75643312%', value: 75643312 },
      { key: 'population', code: 'percent-converted', raw: '43739', value: 43739 },
    ]),
  };

  const shared = security.maskRecord(record, 'shared', DIRECTORATE_COLUMNS);
  const warnings = JSON.parse(shared.record.import_warnings);
  assert.deepEqual(warnings.map((warning) => warning.key), ['population'], 'the protected raw text must not survive');
  assert.ok(!shared.record.import_warnings.includes('75643312'));

  const owner = security.maskRecord(record, 'owner', DIRECTORATE_COLUMNS);
  assert.equal(owner.record.import_warnings, record.import_warnings, 'owner keeps the stored warnings verbatim');
});

test('maskEngineRow nulls protected values and raw text only under shared', () => {
  const row = {
    values: { population: 43739, revenue: 75643312, frontLine: false, reviewerDecision: 'معتمد' },
    rawValues: { population: '43739', revenue: '75643312', frontLine: 'لا', reviewerDecision: 'معتمد' },
    sources: { population: 'C3', revenue: 'Q3' },
    confidence: { text: 'x' },
  };

  const shared = security.maskEngineRow(row, 'shared');
  assert.equal(shared.row.values.revenue, null);
  assert.equal(shared.row.values.frontLine, null);
  assert.equal(shared.row.values.reviewerDecision, null);
  assert.equal(shared.row.values.population, 43739);
  assert.ok(!('revenue' in shared.row.rawValues), 'the raw protected text is removed outright');
  assert.ok(!('revenue' in shared.row.sources));
  assert.equal(shared.row.confidence, null, 'confidence is derived from the protected values and is withheld');
  assert.ok(shared.masked.includes('revenue'));
  assert.ok(shared.masked.includes('frontLine'));

  // A protected field whose parsed value is null can still hold raw text; it must
  // not survive just because the value looks empty.
  const invalid = security.maskEngineRow({ values: { revenue: null }, rawValues: { revenue: '12%' } }, 'shared');
  assert.ok(!('revenue' in invalid.row.rawValues));

  const owner = security.maskEngineRow(row, 'owner');
  assert.equal(owner.row, row);
  assert.deepEqual(owner.masked, []);
});

test('protectedKeysForExport lists every protected key only under shared', () => {
  assert.deepEqual(security.protectedKeysForExport('shared').sort(), [...security.PROTECTED_KEYS].sort());
  assert.deepEqual(security.protectedKeysForExport('owner'), []);
  assert.deepEqual(security.protectedKeysForExport('garbage'), []);
});

test('redactPlanSummary drops protected fields from the preview under shared', () => {
  const summary = {
    fileName: 'book.xlsx',
    changedFields: ['population', 'revenue', 'frontLine'],
    preview: [
      {
        rowNumber: 3,
        districtName: 'مديرية',
        anomalyKeys: ['revenue', 'schools'],
        issues: [
          { key: 'population', code: 'missing-mandatory' },
          { key: 'frontLine', code: 'invalid-boolean' },
        ],
        changes: [
          { key: 'population', before: 1, after: 2 },
          { key: 'revenue', before: 100, after: 200 },
        ],
      },
    ],
  };

  const shared = security.redactPlanSummary(summary, 'shared');
  assert.deepEqual(shared.changedFields, ['population'], 'only public changed fields remain');
  const row = shared.preview[0];
  assert.equal(row.rowNumber, 3, 'identity is preserved');
  assert.deepEqual(row.anomalyKeys, ['schools']);
  assert.deepEqual(row.issues.map((issue) => issue.key), ['population']);
  assert.deepEqual(row.changes.map((change) => change.key), ['population']);
  // The original object is not mutated.
  assert.deepEqual(summary.changedFields, ['population', 'revenue', 'frontLine']);

  const owner = security.redactPlanSummary(summary, 'owner');
  assert.equal(owner, summary, 'owner returns the summary untouched (same reference)');
  assert.equal(security.redactPlanSummary(null, 'shared'), null);
});

test('redactPlanSummary hides protected mandatory fields in completeness and missingInputs', () => {
  const { MANDATORY_FIELDS } = require('../src/main/analysis/schema.cjs');
  const protectedMandatory = MANDATORY_FIELDS.filter((field) => security.PROTECTED_KEYS.includes(field.key));
  assert.ok(protectedMandatory.length > 0, 'the fixture assumes some mandatory fields are protected');

  const summary = {
    missingInputs: [
      { key: 'population', column: 'C', header: 'السكان' },
      { key: 'revenue', column: 'X', header: 'الإيراد' },
    ],
    preview: [{
      rowNumber: 3,
      districtName: 'مديرية',
      completeness: {
        present: 0,
        total: MANDATORY_FIELDS.length,
        ratio: 0,
        missing: MANDATORY_FIELDS.map((field) => field.key),
        missingLabels: MANDATORY_FIELDS.map((field) => field.label),
      },
      anomalyKeys: [],
      issues: [],
      changes: [],
    }],
  };

  const shared = security.redactPlanSummary(summary, 'shared');
  assert.deepEqual(shared.missingInputs.map((item) => item.key), ['population']);

  const completeness = shared.preview[0].completeness;
  const visible = MANDATORY_FIELDS.filter((field) => !security.PROTECTED_KEYS.includes(field.key));
  assert.equal(completeness.total, visible.length, 'the total only counts visible mandatory fields');
  assert.equal(completeness.missing.length, visible.length);
  for (const key of security.PROTECTED_KEYS) {
    assert.ok(!completeness.missing.includes(key), `${key} must not appear in missing`);
  }
  for (const field of protectedMandatory) {
    assert.ok(!completeness.missingLabels.includes(field.label), `${field.label} must not appear in missingLabels`);
  }
  // The ratio is recomputed over the visible fields, so it stays consistent.
  assert.equal(completeness.ratio, 0);
});

test('maskEngineRow redacts completeness and confidence over the visible fields', () => {
  const { MANDATORY_FIELDS } = require('../src/main/analysis/schema.cjs');
  const protectedMandatory = MANDATORY_FIELDS.filter((field) => security.PROTECTED_KEYS.includes(field.key));
  const publicMandatory = MANDATORY_FIELDS.filter((field) => !security.PROTECTED_KEYS.includes(field.key));
  assert.ok(protectedMandatory.length > 0);

  const values = {};
  for (const field of MANDATORY_FIELDS) values[field.key] = 5;
  values[protectedMandatory[0].key] = null; // e.g. revenue must not surface as missing
  values[publicMandatory[0].key] = null;    // e.g. population is visible

  const row = {
    values,
    rawValues: {},
    completeness: {
      present: MANDATORY_FIELDS.length - 2,
      total: MANDATORY_FIELDS.length,
      ratio: (MANDATORY_FIELDS.length - 2) / MANDATORY_FIELDS.length,
      missingLabels: [protectedMandatory[0].label, publicMandatory[0].label],
      missingText: `${protectedMandatory[0].label}، ${publicMandatory[0].label}`,
      waiting: true,
    },
    project: { label: 'ناقصة' },
    indicators: {},
    confidence: { text: 'مؤكدة', level: 'confirmed' },
    replica: { composite: 0.5 },
  };

  const shared = security.maskEngineRow(row, 'shared');
  const completeness = shared.row.completeness;
  const visibleCount = MANDATORY_FIELDS.length - protectedMandatory.length;
  assert.equal(completeness.total, visibleCount);
  assert.ok(!completeness.missing.some((field) => security.PROTECTED_KEYS.includes(field.key)));
  for (const field of protectedMandatory) {
    assert.ok(!completeness.missingLabels.includes(field.label), `${field.label} must not appear in missingLabels`);
    assert.ok(!completeness.missingText.includes(field.label), `${field.label} must not appear in missingText`);
  }
  // The confidence text is derived from the indicators/composite, so it is
  // withheld entirely rather than rebuilt from a partially visible state.
  assert.equal(shared.row.confidence, null);

  const owner = security.maskEngineRow(row, 'owner');
  assert.equal(owner.row, row, 'owner keeps the same row reference');
});

test('maskInputRows removes protected keys before the analysis is re-derived', () => {
  const row = {
    values: { population: 43739, revenue: 75643312, frontLine: 1, reviewerDecision: 'معتمد', districtName: 'مديرية' },
    rawValues: { population: '43739', revenue: '75643312', frontLine: 'نعم', reviewerDecision: 'معتمد' },
    sources: { population: 'C3', revenue: 'Q3' },
    warnings: [
      { key: 'revenue', code: 'invalid-number', raw: '75643312', value: null },
      { key: 'population', code: 'percent-converted', raw: '437.39', value: 43739 },
    ],
    districtName: 'مديرية',
  };

  const shared = security.maskInputRows([row], 'shared');
  const values = shared[0].values;
  for (const key of security.PROTECTED_KEYS) {
    assert.ok(!(key in values), `${key} must be removed so no indicator can be derived from it`);
    assert.ok(!(key in shared[0].rawValues));
    assert.ok(!(key in shared[0].sources));
  }
  assert.equal(values.population, 43739, 'public fields stay');
  assert.deepEqual(shared[0].warnings.map((warning) => warning.key), ['population'], 'a warning that carries a protected raw value is dropped');
  assert.equal(row.values.revenue, 75643312, 'the original row is not mutated');

  const owner = security.maskInputRows([row], 'owner');
  assert.equal(owner[0], row, 'owner returns the rows untouched');
});

test('maskStoredRun clears derived fields and file provenance under shared', () => {
  const payload = {
    run: { id: 1, templateFile: 'C:\\data\\القالب المحدث.xlsx', summary: {} },
    results: [{
      id: 1,
      districtName: 'مديرية',
      indicators: { revenuePerCapita: 1000 },
      completeness: 0.85,
      missingLabels: ['الإيرادات'],
      sensitivity: { weight: 0.5 },
      projectType: 'مشروع تنموي',
      confidenceText: 'مؤكدة',
      confidenceLevel: 'confirmed',
      sourceFile: 'القالب المحدث.xlsx',
      gaps: [{ code: 'x' }],
      calibrated: { composite: 0.7, rank: 1, severe: true, blocked: false, weightCoverage: 0.9, degradedCount: 2, blockReason: null },
      replica: { composite: 0.6, rank: 2 },
    }],
  };

  const shared = security.maskStoredRun(payload, 'shared');
  const result = shared.results[0];
  assert.deepEqual(result.indicators, {});
  assert.equal(result.completeness, null, 'the filled-count over protected fields is derived and must be cleared');
  assert.equal(result.missingLabels, null);
  assert.equal(result.sensitivity, null);
  assert.equal(result.projectType, null);
  assert.equal(result.confidenceText, null);
  assert.equal(result.confidenceLevel, null);
  assert.equal(result.sourceFile, null);
  assert.deepEqual(result.gaps, []);
  assert.equal(result.calibrated.composite, null);
  assert.equal(result.calibrated.rank, null);
  assert.equal(result.calibrated.severe, null);
  assert.equal(result.calibrated.blocked, null);
  assert.equal(result.calibrated.weightCoverage, null);
  assert.equal(result.calibrated.degradedCount, null);
  assert.equal(result.replica.composite, null);
  assert.equal(result.replica.rank, null);
  assert.equal(shared.run.templateFile, null);
  assert.equal(shared.run.summary, null, 'the run summary is derived from protected values');
  assert.equal(result.districtName, 'مديرية', 'the identity is preserved');

  const owner = security.maskStoredRun(payload, 'owner');
  assert.equal(owner, payload, 'owner returns the payload untouched');
});
