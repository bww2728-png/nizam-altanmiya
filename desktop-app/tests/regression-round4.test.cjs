'use strict';

/**
 * Regression round 4 — high-risk behaviours that previously lacked coverage.
 *
 * Every case is pure: no database, no filesystem and no clock, so the suite is
 * fast and deterministic. The contracts exercised here are:
 *  - `redactWarnings` never passes an unparsable or non-array payload through;
 *  - `maskEngineRow` removes protected values and neutralises the derived state
 *    (indicators / calibrated / replica) under the shared profile;
 *  - `buildRanking` metadata is derived from the very lists it returns, so the
 *    visible counters cannot drift from the ranked list;
 *  - `compareCalibratedRows` follows the canonical severe-first order shared
 *    with `ranking.cjs` (severe, composite desc, degradedCount desc, Arabic name);
 *  - `buildRanking(..., { mode: 'replica' })` orders by the replica composite;
 *  - `saveManualDirectorate` refreshes only the warnings of the fields whose
 *    stored value really changed, and a brand-new manual row starts warning-free;
 *  - cross-record gap findings are folded into `summary.byCode` and the blockers;
 *  - `maskEngineRow` strips warning entries that name a protected key;
 *  - the waiting bucket breaks a completeness tie by the Arabic district name.
 *
 * The persistence case opens a throwaway SQLite file under the OS temp directory
 * and deletes it in `finally`, so the suite stays isolated and repeatable.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3-multiple-ciphers');

const { migrate } = require('../src/main/analysis/store-schema.cjs');
const persist = require('../src/main/analysis/persist.cjs');
const { analyzeGaps } = require('../src/main/analysis/gaps.cjs');
const security = require('../src/main/security.cjs');
const { INPUT_FIELDS } = require('../src/main/analysis/schema.cjs');
const { buildRanking, compareCalibratedRows } = require('../src/main/analysis/sheets.cjs');

/** One value per input column, typed exactly as schema.cjs declares it. */
function baseValues(overrides = {}) {
  const values = {};
  for (const field of INPUT_FIELDS) {
    if (field.type === 'number') values[field.key] = 10;
    else if (field.type === 'ratio') values[field.key] = 0.5;
    else if (field.type === 'boolean') values[field.key] = true;
    else values[field.key] = 'x';
  }
  values.districtName = 'مديرية اختبار';
  values.governorate = 'صنعاء';
  return { ...values, ...overrides };
}

/** A minimal engine-shaped row; only the fields buildRanking reads are set. */
function engineRow(overrides = {}) {
  const districtName = overrides.districtName ?? 'مديرية اختبار';
  return {
    dbId: overrides.dbId ?? null,
    districtName,
    governorate: overrides.governorate ?? 'إب',
    values: baseValues({ districtName, ...(overrides.values ?? {}) }),
    calibrated: overrides.calibrated ?? { composite: 0.5, severe: false, degradedCount: 0, blocked: false },
    replica: overrides.replica ?? { composite: 0.5 },
    completeness: overrides.completeness ?? { ratio: 1 },
    project: overrides.project ?? { label: 'مشروع تنموي' },
    confidence: overrides.confidence ?? { text: 'مؤكدة' },
    indicators: overrides.indicators ?? { waterDeficit: 50 },
    sensitivity: overrides.sensitivity ?? { weight: 0.5 },
  };
}

// ---------------------------------------------------------------------------
// 1) redactWarnings robustness
// ---------------------------------------------------------------------------

test('redactWarnings returns [] for malformed JSON and non-array input under shared', () => {
  // Malformed JSON must not fall through as a raw string or a partial array.
  assert.deepEqual(security.redactWarnings('{not valid json', 'shared'), []);
  assert.deepEqual(security.redactWarnings('', 'shared'), []);
  // Valid JSON that is not an array is still rejected.
  assert.deepEqual(security.redactWarnings('{"key":"revenue"}', 'shared'), []);
  // Non-array, non-string payloads are rejected too.
  assert.deepEqual(security.redactWarnings({ key: 'population' }, 'shared'), []);
  assert.deepEqual(security.redactWarnings(42, 'shared'), []);
  assert.deepEqual(security.redactWarnings(null, 'shared'), []);
  assert.deepEqual(security.redactWarnings(undefined, 'shared'), []);
});

test('redactWarnings drops protected keys, keeps public warnings and passes owner through', () => {
  const warnings = [
    { key: 'revenue', code: 'percent-converted', raw: '75643312%' },
    { key: 'frontLine', code: 'invalid-boolean', raw: 'نعم' },
    { key: 'reviewerDecision', code: 'invalid-decision', raw: 'معتمد' },
    { key: 'population', code: 'percent-converted', raw: '43739' },
    { key: 'schools', code: 'invalid-number', raw: '—' },
  ];
  // Confirm the fixture's protected keys really are protected.
  for (const key of ['revenue', 'frontLine', 'reviewerDecision']) {
    assert.ok(security.PROTECTED_KEYS.includes(key), `${key} must be protected`);
  }

  const filtered = security.redactWarnings(warnings, 'shared');
  assert.deepEqual(filtered.map((warning) => warning.key), ['population', 'schools']);
  // The raw text of a protected warning must be gone with the entry.
  assert.ok(!JSON.stringify(filtered).includes('75643312'));
  // The original array is never mutated.
  assert.equal(warnings.length, 5);

  // A JSON string of an array is parsed and filtered the same way.
  const fromJson = security.redactWarnings(JSON.stringify(warnings), 'shared');
  assert.deepEqual(fromJson.map((warning) => warning.key), ['population', 'schools']);

  // Owner keeps the payload by reference: redaction is a shared-only concern.
  assert.equal(security.redactWarnings(warnings, 'owner'), warnings);
  assert.equal(security.redactWarnings('{not valid json', 'owner'), '{not valid json');
});

// ---------------------------------------------------------------------------
// 2) maskEngineRow shared contract
// ---------------------------------------------------------------------------

function engineRowForMasking() {
  return {
    values: { population: 43739, revenue: 75643312, frontLine: true, reviewerDecision: 'معتمد' },
    rawValues: { population: '43739', revenue: '75643312', frontLine: 'نعم', reviewerDecision: 'معتمد' },
    sources: { population: 'C3', revenue: 'Q3' },
    indicators: { revenuePerCapita: 1280000, waterDeficit: 80.3 },
    calibrated: { composite: 0.72, rank: 1, severe: true, degradedCount: 4, blocked: false },
    replica: { composite: 0.63, rank: 2 },
    completeness: { present: 13, total: 13, ratio: 1, missing: [], missingLabels: [] },
    confidence: { text: 'مؤكدة', level: 'confirmed' },
  };
}

test('maskEngineRow removes protected values/rawValues/sources and nulls confidence under shared', () => {
  const row = engineRowForMasking();
  const shared = security.maskEngineRow(row, 'shared');

  assert.equal(shared.row.values.revenue, null);
  assert.equal(shared.row.values.frontLine, null);
  assert.equal(shared.row.values.reviewerDecision, null);
  assert.equal(shared.row.values.population, 43739, 'a public value survives');

  for (const key of ['revenue', 'frontLine', 'reviewerDecision']) {
    assert.ok(!(key in shared.row.rawValues), `${key} raw text must be removed outright`);
    assert.ok(!(key in shared.row.sources), `${key} provenance must be removed`);
  }
  assert.equal(shared.row.rawValues.population, '43739');
  assert.equal(shared.row.confidence, null, 'confidence is derived from protected values');

  for (const key of ['revenue', 'frontLine', 'reviewerDecision']) {
    assert.ok(shared.masked.includes(key), `${key} must be reported as masked`);
  }
  // The original is never mutated.
  assert.equal(row.values.revenue, 75643312);
  // Owner is a no-op by reference.
  const owner = security.maskEngineRow(row, 'owner');
  assert.equal(owner.row, row);
  assert.deepEqual(owner.masked, []);
});

test('maskEngineRow neutralises indicators, calibrated and replica under shared', () => {
  const row = engineRowForMasking();
  const shared = security.maskEngineRow(row, 'shared');

  // `indicators`, `calibrated` and `replica` are rebuilt from the protected
  // values; returning them would let a viewer recover the masked figures, so
  // the defensive contract withholds them.
  const indicators = shared.row.indicators;
  assert.ok(
    indicators === null || indicators === undefined || Object.keys(indicators).length === 0,
    'indicators must be empty/neutral under shared',
  );
  assert.equal(shared.row.calibrated, null, 'calibrated verdict is derived and must be withheld');
  assert.equal(shared.row.replica, null, 'replica verdict is derived and must be withheld');
});

// ---------------------------------------------------------------------------
// 3) buildRanking metadata consistency
// ---------------------------------------------------------------------------

function rankingFixture() {
  return {
    // The engine summary carries raw counts; buildRanking must override the
    // candidate / severe counters with values derived from its own lists.
    summary: { rows: 5, calibratedRanked: 999, calibratedBlocked: 999, severeCount: 999 },
    rows: [
      // complete + non-severe  -> ranked #2
      engineRow({
        dbId: 10,
        districtName: 'مديرية مكتملة',
        calibrated: { composite: 0.4, severe: false, degradedCount: 1, blocked: false },
        replica: { composite: 0.4 },
      }),
      // complete + severe      -> ranked #1 even with a lower composite
      engineRow({
        dbId: 11,
        districtName: 'مديرية حرمان',
        calibrated: { composite: 0.2, severe: true, degradedCount: 4, blocked: false },
        replica: { composite: 0.2 },
      }),
      // missing a mandatory field -> waiting
      engineRow({
        dbId: 12,
        districtName: 'مديرية ناقصة',
        values: { waterCoverage: undefined },
        completeness: { ratio: 0.5 },
        calibrated: { composite: null, severe: false, blocked: false },
        replica: { composite: 0.3 },
      }),
      // complete but no computable composite -> blocked
      engineRow({
        dbId: 13,
        districtName: 'مديرية محجوبة',
        calibrated: { composite: null, severe: false, blocked: true, blockReason: 'تغطية أوزان منخفضة' },
        replica: { composite: 0.1 },
      }),
      // complete + anomalous + severe -> excluded from ranked, so it must not
      // inflate meta.severeCount
      engineRow({
        dbId: 14,
        districtName: 'مديرية شاذة حادة',
        values: { population: 250000000 },
        calibrated: { composite: 0.9, severe: true, degradedCount: 2, blocked: false },
        replica: { composite: 0.9 },
      }),
    ],
  };
}

test('buildRanking meta mirrors the ranked list instead of the engine counters', () => {
  const analysis = rankingFixture();
  const data = buildRanking(analysis, {});

  // Four-way partition invariant.
  const total = data.ranked.length + data.waiting.length + data.blocked.length + data.anomalies.length;
  assert.equal(total, analysis.rows.length, 'ranked+waiting+blocked+anomalies must partition the rows');

  assert.equal(data.ranked.length, 2);
  assert.equal(data.waiting.length, 1);
  assert.equal(data.blocked.length, 1);
  assert.equal(data.anomalies.length, 1);

  // meta is rebuilt from the lists, not passed through from the engine.
  assert.equal(data.meta.calibratedRanked, data.ranked.length);
  assert.equal(data.meta.calibratedRanked, 2);
  assert.equal(data.meta.calibratedBlocked, data.blocked.length);
  // Only the ranked severe row counts; the anomalous severe row is excluded.
  assert.equal(data.meta.severeCount, 1);

  // Ranking order is severe-first.
  assert.deepEqual(data.ranked.map((entry) => entry.districtName), ['مديرية حرمان', 'مديرية مكتملة']);
  assert.deepEqual(data.ranked.map((entry) => entry.rank), [1, 2]);
});

// ---------------------------------------------------------------------------
// 4) compareCalibratedRows tie-break
// ---------------------------------------------------------------------------

test('compareCalibratedRows orders severe, composite, degradedCount, then Arabic name', () => {
  const severe = engineRow({ districtName: 'مديرية منهارة', calibrated: { composite: 0.1, severe: true, degradedCount: 0, blocked: false } });
  const stable = engineRow({ districtName: 'مديرية مستقرة', calibrated: { composite: 0.9, severe: false, degradedCount: 0, blocked: false } });
  assert.ok(compareCalibratedRows(severe, stable) < 0, 'severe deprivation precedes a higher composite');
  assert.ok(compareCalibratedRows(stable, severe) > 0);

  const high = engineRow({ districtName: 'أ', calibrated: { composite: 0.8, severe: false, degradedCount: 0, blocked: false } });
  const low = engineRow({ districtName: 'ب', calibrated: { composite: 0.5, severe: false, degradedCount: 0, blocked: false } });
  assert.ok(compareCalibratedRows(high, low) < 0, 'higher composite comes first');

  // Parity with ranking.cjs (the canonical order): at equal severe/composite the
  // row with MORE degraded dimensions leads, then the Arabic alphabetical
  // tie-break settles the rest.
  const moreDegraded = engineRow({ districtName: 'ب', calibrated: { composite: 0.5, severe: false, degradedCount: 3, blocked: false } });
  const fewerDegraded = engineRow({ districtName: 'أ', calibrated: { composite: 0.5, severe: false, degradedCount: 0, blocked: false } });
  const degradedOrder = [fewerDegraded, moreDegraded].sort(compareCalibratedRows);
  assert.deepEqual(degradedOrder.map((row) => row.districtName), ['ب', 'أ'], 'more degraded dimensions lead');

  const alef = engineRow({ districtName: 'ألف', calibrated: { composite: 0.5, severe: false, degradedCount: 1, blocked: false } });
  const baa = engineRow({ districtName: 'باء', calibrated: { composite: 0.5, severe: false, degradedCount: 1, blocked: false } });
  const nameOrder = [baa, alef].sort(compareCalibratedRows);
  assert.deepEqual(nameOrder.map((row) => row.districtName), ['ألف', 'باء'], 'ties fall back to the Arabic locale');
  assert.equal(compareCalibratedRows(alef, alef), 0, 'the comparator is reflexive');
});

// ---------------------------------------------------------------------------
// 5) buildRanking replica mode
// ---------------------------------------------------------------------------

test('buildRanking replica mode orders by the replica composite and ranks from 1', () => {
  const analysis = {
    summary: { rows: 3, calibratedRanked: 0 },
    rows: [
      // A high calibrated composite must be ignored in replica mode.
      engineRow({
        dbId: 21,
        districtName: 'مديرية ألف',
        calibrated: { composite: 0.9, severe: false, degradedCount: 0, blocked: false },
        replica: { composite: 0.2 },
      }),
      engineRow({ dbId: 22, districtName: 'مديرية باء', replica: { composite: 0.9 } }),
      engineRow({ dbId: 23, districtName: 'مديرية جيم', replica: { composite: 0.5 } }),
    ],
  };

  const data = buildRanking(analysis, { mode: 'replica' });
  assert.equal(data.mode, 'replica');
  assert.equal(data.ranked.length, 3);
  assert.deepEqual(data.ranked.map((entry) => entry.districtName), ['مديرية باء', 'مديرية جيم', 'مديرية ألف']);
  assert.deepEqual(data.ranked.map((entry) => entry.rank), [1, 2, 3]);
  assert.deepEqual(data.ranked.map((entry) => entry.composite), [0.9, 0.5, 0.2], 'the reported composite is the replica one');
  assert.equal(data.meta.calibratedRanked, data.ranked.length, 'meta still mirrors the list in replica mode');
});

// ---------------------------------------------------------------------------
// 6) saveManualDirectorate refreshes warnings selectively (HIGH-1)
// ---------------------------------------------------------------------------

/** A throwaway encrypted SQLite file; never touches the user's store. */
function openTestDatabase() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ldi-regression4-'));
  const filePath = path.join(directory, 'test.db');
  const database = new Database(filePath, { timeout: 5000 });
  database.pragma("cipher = 'sqlcipher'");
  database.pragma("key = 'test-key-regression-round4'");
  database.pragma('foreign_keys = ON');
  database.prepare('SELECT count(*) AS count FROM sqlite_master').get();
  migrate(database);
  return { database, directory, filePath };
}

test('saveManualDirectorate clears only the warning of the field whose stored value changed', () => {
  const { database, directory } = openTestDatabase();
  try {
    const districtName = 'مديرية تحذير';
    const governorate = 'إب';

    // The import left `population` unparsable (its column is therefore NULL) and
    // flagged `schools` as a placeholder even though a real number was stored.
    const stored = baseValues({ districtName, governorate, population: null, schools: 12 });
    const inserted = persist.upsertDirectorate(
      database,
      { districtName, governorate, values: stored, rawValues: {}, sources: {} },
      {
        fileName: 'book.xlsx',
        sheetName: 'قاعدة البيانات الشاملة',
        warnings: [
          { key: 'population', code: 'invalid-number', raw: 'غير رقم' },
          { key: 'schools', code: 'placeholder', raw: 'قريباً', value: 12 },
        ],
      },
    );

    const before = JSON.parse(persist.getDirectorate(database, inserted.id).import_warnings);
    assert.deepEqual(before.map((warning) => warning.key).sort(), ['population', 'schools']);

    // The Correction screen posts the whole form; only `population` was edited.
    const posted = baseValues({ districtName, governorate, population: 25000, schools: 12 });
    persist.saveManualDirectorate(database, {
      id: inserted.id, districtName, governorate, values: posted,
    });

    const record = persist.getDirectorate(database, inserted.id);
    assert.equal(record.population, 25000, 'the edited value is stored');

    const after = JSON.parse(record.import_warnings);
    assert.deepEqual(
      after.map((warning) => warning.key),
      ['schools'],
      'only the field whose stored value actually changed loses its warning',
    );
    assert.equal(after[0].code, 'placeholder');
    assert.equal(after[0].raw, 'قريباً', 'the surviving warning keeps its original reason');

    // A brand-new manual row must never inherit a warning.
    const freshName = 'مديرية جديدة';
    const fresh = persist.saveManualDirectorate(database, {
      districtName: freshName,
      governorate: 'تعز',
      values: baseValues({ districtName: freshName, governorate: 'تعز' }),
    });
    assert.equal(fresh.created, true);
    const freshRecord = persist.getDirectorate(database, fresh.id);
    assert.equal(freshRecord.import_warnings, '[]', 'a new row has no import warnings');
    assert.deepEqual(JSON.parse(freshRecord.import_warnings), []);

    // Error path: an unparsable manual value is refused before the row is touched,
    // so neither the stored number nor the surviving warning may change.
    assert.throws(
      () => persist.saveManualDirectorate(database, {
        id: inserted.id, districtName, governorate, values: { population: 'غير رقم' },
      }),
      /قيم غير صالحة/,
    );
    const untouched = persist.getDirectorate(database, inserted.id);
    assert.equal(untouched.population, 25000, 'a rejected save must not write anything');
    assert.deepEqual(JSON.parse(untouched.import_warnings).map((warning) => warning.key), ['schools']);
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 7) gaps: crossIssues folded into summary.byCode
// ---------------------------------------------------------------------------

/** A complete, plausible, warning-free record: no per-record finding fires. */
function completeValues(overrides = {}) {
  return {
    districtName: 'مديرية مكررة',
    governorate: 'إب',
    population: 10000,
    migrants: 500,
    densityPerKm2: 100,
    expectedBeneficiaries: 2000,
    schools: 20,
    enrolledStudents: 3000,
    govFacilities: 5,
    privateFacilities: 2,
    waterCoverage: 0.5,
    pavedRoads: 0.3,
    unpavedRoads: 0.1,
    cutRoads: 0.1,
    serviceDistanceKm: 10,
    revenue: 50000,
    agriProduction: 20,
    livestockHeads: 100,
    valueChains: 3,
    inactiveValueChains: 1,
    unemployment: 0.2,
    associations: 2,
    goodsTons: 50,
    frontLine: 'لا',
    povertyRatio: 0.4,
    vulnerableGroups: 0.3,
    ruralPopulation: 6000,
    projectCost: 1000000,
    projectStatus: 'مكتمل',
    ...overrides,
  };
}

test('a duplicate (governorate, district) pair reaches summary.byCode and the blocker count', () => {
  const records = [
    { id: 1, districtName: 'مديرية مكررة', governorate: 'إب', values: completeValues(), warnings: [] },
    { id: 2, districtName: 'مديرية مكررة', governorate: 'إب', values: completeValues(), warnings: [] },
  ];

  const { crossIssues, recordIssues, summary } = analyzeGaps(records);

  assert.equal(crossIssues.length, 1);
  assert.equal(crossIssues[0].code, 'duplicate-district');
  assert.equal(crossIssues[0].severity, 'blocker');
  assert.equal(recordIssues.size, 0, 'the fixture itself produces no per-record finding');

  // Cross-record codes must be tallied too, otherwise byCode would disagree with
  // the severity counters right below it.
  assert.equal(summary.byCode['duplicate-district'], 1);
  assert.equal(summary.blocker, 1, 'the cross blocker is counted as a blocker');
  assert.equal(summary.blocker, crossIssues.length);
  assert.equal(summary.total, 1);
});

test('the same district name in another governorate is not a gap issue', () => {
  const records = [
    { id: 1, districtName: 'مديرية مكررة', governorate: 'إب', values: completeValues(), warnings: [] },
    { id: 2, districtName: 'مديرية مكررة', governorate: 'تعز', values: completeValues({ governorate: 'تعز' }), warnings: [] },
  ];

  const { crossIssues, summary } = analyzeGaps(records);
  assert.deepEqual(crossIssues, []);
  assert.equal(summary.byCode['duplicate-district'], undefined);
  assert.equal(summary.blocker, 0);
});

// ---------------------------------------------------------------------------
// 8) exporter isRankableRow — not exported, documented as skipped
// ---------------------------------------------------------------------------

test('exporter isRankableRow mirrors the ranking predicate', {
  skip: 'isRankableRow is internal to src/main/analysis/exporter.cjs: module.exports = '
    + '{ buildAnalysisWorkbook, exportAnalysisWorkbook, templateLayout, num } (line 297), '
    + 'so it cannot be called from a test without editing src',
}, () => {});

// ---------------------------------------------------------------------------
// 9) maskEngineRow: warning entries naming a protected key
// ---------------------------------------------------------------------------

test('maskEngineRow drops warning entries that name a protected key', () => {
  const row = {
    ...engineRowForMasking(),
    warnings: [
      { key: 'revenue', code: 'invalid-number', raw: '75643312%' },
      { key: 'population', code: 'percent-converted', raw: '437%', value: 4.37 },
      // No `key` at all: filtering is by key, so an unkeyed entry survives.
      { code: 'unknown-shape', raw: '—' },
    ],
  };

  const shared = security.maskEngineRow(row, 'shared');
  assert.deepEqual(shared.row.warnings.map((warning) => warning.key), ['population', undefined]);
  assert.equal(shared.row.warnings.length, 2);
  assert.ok(
    !JSON.stringify(shared.row.warnings).includes('75643312'),
    'the protected raw text must not survive through the warnings array',
  );
  assert.equal(shared.row.warnings[0].value, 4.37, 'a public warning keeps its parsed value');
  assert.ok(shared.masked.includes('revenue'));

  // The input row is never mutated and the owner profile keeps every warning.
  assert.equal(row.warnings.length, 3);
  const owner = security.maskEngineRow(row, 'owner');
  assert.equal(owner.row.warnings.length, 3, 'owner still sees the protected warning');
});

// ---------------------------------------------------------------------------
// 10) waiting bucket tie-break
// ---------------------------------------------------------------------------

test('the waiting bucket breaks a completeness tie by the Arabic district name', () => {
  // Both rows miss the same mandatory field and carry the same stored ratio, so
  // only the Arabic name can order them. They are listed in reverse on purpose.
  const analysis = {
    summary: { rows: 2 },
    rows: [
      engineRow({
        dbId: 31,
        districtName: 'مديرية باء',
        values: { waterCoverage: null },
        completeness: { ratio: 0.923 },
        calibrated: { composite: null, severe: false, blocked: false },
      }),
      engineRow({
        dbId: 32,
        districtName: 'مديرية ألف',
        values: { waterCoverage: null },
        completeness: { ratio: 0.923 },
        calibrated: { composite: null, severe: false, blocked: false },
      }),
    ],
  };

  const data = buildRanking(analysis, {});
  assert.equal(data.waiting.length, 2);
  assert.equal(data.ranked.length, 0, 'an incomplete row is never ranked');
  assert.equal(data.blocked.length, 0);
  assert.equal(data.anomalies.length, 0, 'a missing mandatory field is a gap, not an anomaly');
  assert.equal(
    new Set(data.waiting.map((entry) => entry.completeness.ratio)).size,
    1,
    'the fixture really is a completeness tie',
  );

  assert.deepEqual(data.waiting.map((entry) => entry.districtName), ['مديرية ألف', 'مديرية باء']);
  assert.deepEqual(data.waiting.map((entry) => entry.directorateId), [32, 31]);
  assert.ok(data.waiting[0].missingLabels.includes('مياه'));

  const total = data.ranked.length + data.waiting.length + data.blocked.length + data.anomalies.length;
  assert.equal(total, analysis.rows.length, 'the four-way partition holds');
});