'use strict';

/**
 * The five workbook sheets, rebuilt as data the interface can render.
 *
 * «قاعدة البيانات الشاملة», «المؤشرات الـ 12», «ترتيب الأولويات»,
 * «اللوحة التفاعلية» and «📇 بطاقة مديرية» are all derived from the same 39
 * input columns. The workbook derived them with 34k formulas; the application
 * derives them with the engine, from the stored data only — the workbook's own
 * computed columns are ignored on import so the two can never disagree.
 *
 * Every payload here is computed from one `analyze()` pass over the stored
 * directorates, so the dashboard, the indicators page and the ranking page can
 * never show numbers from different states of the data.
 */

const { analyze } = require('./engine.cjs');
const persist = require('./persist.cjs');
const { INDICATORS, MANDATORY_FIELDS, INPUT_FIELDS, FIELD_BY_KEY } = require('./schema.cjs');
const { anomalyKeys } = require('./import-plan.cjs');

/** A record is rankable when it is complete and free of implausible values. */
function rankableVerdict(row) {
  const mandatory = MANDATORY_FIELDS.filter((field) => row.values?.[field.key] === undefined || row.values?.[field.key] === null);
  const anomalous = anomalyKeys(row.values);
  return {
    complete: mandatory.length === 0,
    anomalous: anomalous.length > 0,
    missingLabels: mandatory.map((field) => field.label),
    anomalyKeys: anomalous,
  };
}

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function labelOf(key) {
  return FIELD_BY_KEY[key]?.header ?? key;
}

function buildDashboard(analysis) {
  const rows = analysis.rows ?? [];
  const governorates = new Map();
  const projectTypes = new Map();
  let population = 0;
  let compositeSum = 0;
  let compositeCount = 0;
  let completeCount = 0;
  let anomalyCount = 0;
  let missingCriticalCount = 0;
  let completeBucketCount = 0;
  let partialBucketCount = 0;

  for (const row of rows) {
    const verdict = rankableVerdict(row);
    if (verdict.complete) completeCount += 1;
    if (!verdict.complete) missingCriticalCount += 1;

    // CR-6 invariant: the completeness buckets are mutually exclusive and
    // "anomaly" takes precedence over "complete". A row that is both complete
    // and anomalous is therefore counted once — as an anomaly — so the three
    // buckets always partition the directorates without overlap or gaps.
    if (verdict.anomalous) anomalyCount += 1;
    else if (verdict.complete) completeBucketCount += 1;
    else partialBucketCount += 1;

    const numericPopulation = Number(row.values?.population);
    if (Number.isFinite(numericPopulation)) population += numericPopulation;

    const composite = row.calibrated?.composite;
    if (Number.isFinite(composite) && verdict.complete && !verdict.anomalous) {
      compositeSum += composite;
      compositeCount += 1;
    }

    const key = String(row.governorate ?? '').trim() || 'غير محددة';
    const entry = governorates.get(key) ?? { name: key, count: 0, population: 0, compositeSum: 0, compositeCount: 0, complete: 0 };
    entry.count += 1;
    if (Number.isFinite(numericPopulation)) entry.population += numericPopulation;
    if (verdict.complete) entry.complete += 1;
    if (Number.isFinite(composite) && verdict.complete && !verdict.anomalous) {
      entry.compositeSum += composite;
      entry.compositeCount += 1;
    }
    governorates.set(key, entry);

    const projectLabel = row.project?.label ?? 'غير محدد';
    projectTypes.set(projectLabel, (projectTypes.get(projectLabel) ?? 0) + 1);
  }

  const buckets = [
    { key: 'complete', label: 'مكتملة', count: completeBucketCount },
    { key: 'partial', label: 'ناقصة جزئيًا', count: partialBucketCount },
    { key: 'anomaly', label: 'شاذة', count: anomalyCount },
  ];

  // Invariant strategy: THROW (not clamp). Because the buckets are built as a
  // true partition, their sum must equal the directorate count; if it ever does
  // not, that is an internal bug and is surfaced loudly instead of being hidden.
  const bucketTotal = buckets.reduce((sum, bucket) => sum + bucket.count, 0);
  if (bucketTotal !== rows.length) {
    throw new Error(
      `completeness buckets must partition directorates: sum=${bucketTotal} total=${rows.length} `
      + `(complete=${completeBucketCount} partial=${partialBucketCount} anomaly=${anomalyCount})`,
    );
  }

  const needs = rows
    .map((row) => ({ row, verdict: rankableVerdict(row) }))
    .filter((entry) => entry.verdict.complete && !entry.verdict.anomalous && Number.isFinite(entry.row.calibrated?.composite))
    .sort((a, b) => (b.row.calibrated.composite ?? 0) - (a.row.calibrated.composite ?? 0))
    .slice(0, 10)
    .map(({ row }, index) => ({
      rank: index + 1,
      directorateId: row.dbId ?? null,
      districtName: row.districtName,
      governorate: row.governorate,
      composite: round(row.calibrated?.composite ?? 0, 4),
      projectType: row.project?.label ?? '',
      population: Number.isFinite(Number(row.values?.population)) ? Number(row.values.population) : null,
    }));

  const indicatorsCoverage = INDICATORS.map((indicator) => {
    const present = rows.filter((row) => Number.isFinite(row.indicators?.[indicator.code])).length;
    return { code: indicator.code, header: indicator.header, unit: indicator.unit, present, total: rows.length };
  }).sort((a, b) => a.present - b.present);

  return {
    totals: {
      directorates: rows.length,
      complete: completeCount,
      incomplete: missingCriticalCount,
      anomalies: anomalyCount,
      governorates: governorates.size,
      population: round(population, 0),
      averageComposite: compositeCount ? round(compositeSum / compositeCount, 4) : null,
      ranked: compositeCount,
    },
    completenessBuckets: buckets,
    governorates: [...governorates.values()]
      .map((entry) => ({
        name: entry.name,
        count: entry.count,
        complete: entry.complete,
        population: round(entry.population, 0),
        averageComposite: entry.compositeCount ? round(entry.compositeSum / entry.compositeCount, 4) : null,
      }))
      .sort((a, b) => b.count - a.count),
    projectTypes: [...projectTypes.entries()].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count),
    needs,
    indicatorsCoverage,
    quality: analysis.gaps?.summary ?? null,
    meta: analysis.meta ?? null,
  };
}

function buildIndicators(analysis) {
  const rows = analysis.rows ?? [];
  const stats = {};
  for (const indicator of INDICATORS) {
    const values = rows.map((row) => row.indicators?.[indicator.code]).filter((value) => Number.isFinite(value));
    stats[indicator.code] = {
      count: values.length,
      missing: rows.length - values.length,
      min: values.length ? round(Math.min(...values), 4) : null,
      max: values.length ? round(Math.max(...values), 4) : null,
      average: values.length ? round(values.reduce((sum, value) => sum + value, 0) / values.length, 4) : null,
    };
  }

  return {
    registry: INDICATORS.map((indicator) => ({
      code: indicator.code,
      header: indicator.header,
      excel: indicator.excel,
      unit: indicator.unit,
      direction: indicator.direction,
      formula: indicator.formula ?? null,
    })),
    stats,
    rows: rows.map((row) => ({
      directorateId: row.dbId ?? null,
      districtName: row.districtName,
      governorate: row.governorate,
      values: row.indicators ?? {},
      scores: row.calibrated?.scores ?? {},
      contributions: row.calibrated?.contributions ?? {},
      composite: Number.isFinite(row.calibrated?.composite) ? round(row.calibrated.composite, 4) : null,
      completeness: row.completeness ?? null,
      verdict: rankableVerdict(row),
    })),
  };
}

function buildRanking(analysis, options = {}) {
  const rows = analysis.rows ?? [];
  const mode = options.mode === 'replica' ? 'replica' : 'calibrated';
  const entries = rows.map((row) => ({ row, verdict: rankableVerdict(row) }));
  const ranked = entries
    .filter((entry) => entry.verdict.complete && !entry.verdict.anomalous)
    .filter((entry) => Number.isFinite(entry.row.calibrated?.composite))
    .sort((a, b) => (mode === 'replica'
      ? (b.row.replica?.composite ?? 0) - (a.row.replica?.composite ?? 0)
      : (b.row.calibrated?.composite ?? 0) - (a.row.calibrated?.composite ?? 0)))
    .map((entry, index) => ({
      rank: index + 1,
      directorateId: entry.row.dbId ?? null,
      districtName: entry.row.districtName,
      governorate: entry.row.governorate,
      composite: round((mode === 'replica' ? entry.row.replica?.composite : entry.row.calibrated?.composite) ?? 0, 4),
      replicaComposite: Number.isFinite(entry.row.replica?.composite) ? round(entry.row.replica.composite, 4) : null,
      projectType: entry.row.project?.label ?? '',
      decision: entry.row.values?.reviewerDecision ?? '',
      confidence: entry.row.confidence?.text ?? '',
      sensitivity: entry.row.sensitivity?.weight ?? null,
      population: Number.isFinite(Number(entry.row.values?.population)) ? Number(entry.row.values.population) : null,
    }));

  const waiting = entries
    .filter((entry) => !entry.verdict.complete)
    .map((entry) => ({
      directorateId: entry.row.dbId ?? null,
      districtName: entry.row.districtName,
      governorate: entry.row.governorate,
      completeness: entry.row.completeness ?? null,
      missingLabels: entry.verdict.missingLabels,
    }))
    .sort((a, b) => (b.completeness?.ratio ?? 0) - (a.completeness?.ratio ?? 0));

  const anomalies = entries
    .filter((entry) => entry.verdict.anomalous)
    .map((entry) => ({
      directorateId: entry.row.dbId ?? null,
      districtName: entry.row.districtName,
      governorate: entry.row.governorate,
      keys: entry.verdict.anomalyKeys,
      labels: entry.verdict.anomalyKeys.map(labelOf),
      values: Object.fromEntries(entry.verdict.anomalyKeys.map((key) => [key, entry.row.values?.[key] ?? null])),
    }));

  return {
    mode,
    rule: 'يُرتب المكتمل فقط؛ وتُستبعد الصفوف ذات القيم الشاذة حتى تُصحّح',
    excluded: { waiting: waiting.length, anomalies: anomalies.length },
    ranked,
    waiting,
    anomalies,
    meta: analysis.summary ?? null,
    calibration: options.calibration ?? null,
  };
}

/**
 * One pass over the database produces all three sheets.
 *
 * @param {object} database better-sqlite3 handle
 * @param {{mode?:'calibrated'|'replica', transformRows?:(rows:Array)=>Array}} [options]
 */
function buildSheets(database, options = {}) {
  let rows = persist.loadAnalysisRows(database, {});
  // The shared access profile strips protected keys before the engine runs, so a
  // masked value is reported as missing instead of being computed behind the
  // operator's back.
  if (typeof options.transformRows === 'function') rows = options.transformRows(rows);
  const calibration = persist.getLastCalibration(database) ?? {};
  const analysis = analyze(rows, {
    weights: options.weights ?? calibration.weights ?? persist.getWeights(database)?.weights ?? undefined,
    kThreshold: options.kThreshold ?? calibration.kThreshold ?? undefined,
    deprivationLine: options.deprivationLine ?? calibration.deprivationLine ?? undefined,
  });
  return {
    analysis,
    dashboard: buildDashboard(analysis),
    indicators: buildIndicators(analysis),
    ranking: buildRanking(analysis, {
      mode: options.mode,
      calibration: {
        kThreshold: calibration.kThreshold ?? null,
        deprivationLine: calibration.deprivationLine ?? null,
        weights: calibration.weights ?? null,
      },
    }),
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { buildSheets, buildDashboard, buildIndicators, buildRanking, rankableVerdict };
