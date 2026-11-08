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

/**
 * Canonical calibrated order: severe deprivation first, then the composite, then
 * the degraded-dimension count, then the district name — identical to the engine
 * (ranking.cjs). The interface, the Excel ranking sheet and the PDF must all use
 * this so «الحرمان الحاد يتصدّر مهما كان المتوسط» holds everywhere.
 */
function compareCalibratedRows(a, b) {
  const severeDelta = Number(Boolean(b.calibrated?.severe)) - Number(Boolean(a.calibrated?.severe));
  if (severeDelta !== 0) return severeDelta;
  const compositeDelta = (b.calibrated?.composite ?? 0) - (a.calibrated?.composite ?? 0);
  if (Math.abs(compositeDelta) > 1e-12) return compositeDelta;
  const degradedDelta = (b.calibrated?.degradedCount ?? 0) - (a.calibrated?.degradedCount ?? 0);
  if (degradedDelta !== 0) return degradedDelta;
  return String(a.districtName ?? '').localeCompare(String(b.districtName ?? ''), 'ar');
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
    .sort((a, b) => compareCalibratedRows(a.row, b.row))
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
      weight: indicator.weight,
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
      replicaComposite: Number.isFinite(row.replica?.composite) ? round(row.replica.composite, 4) : null,
      calibratedRank: Number.isInteger(row.calibrated?.rank) ? row.calibrated.rank : null,
      replicaRank: Number.isInteger(row.replica?.rank) ? row.replica.rank : null,
      degradedCount: Number.isFinite(row.calibrated?.degradedCount) ? row.calibrated.degradedCount : null,
      weightCoverage: Number.isFinite(row.calibrated?.weightCoverage) ? round(row.calibrated.weightCoverage, 4) : null,
      severe: row.calibrated?.severe === true,
      blocked: row.calibrated?.blocked === true,
      confidenceLevel: row.confidence?.level ?? null,
      fragile: row.sensitivity?.fragile ?? null,
      maxRankShift: row.sensitivity?.rankRange ?? null,
      completeness: row.completeness ?? null,
      verdict: rankableVerdict(row),
    })),
  };
}

/**
 * The single source of truth for "this row belongs in the calibrated ranking":
 * complete, free of anomalies, and backed by a finite calibrated composite. A
 * blocked row is complete but not computable (its composite is null), so the
 * finite check already excludes it. The interface, the Excel ranking sheet and
 * the PDF all delegate here so they can never disagree about who is rankable.
 */
function isRankableCalibrated(row) {
  const verdict = rankableVerdict(row);
  return verdict.complete && !verdict.anomalous && Number.isFinite(row.calibrated?.composite);
}

function buildRanking(analysis, options = {}) {
  const rows = analysis.rows ?? [];
  const mode = options.mode === 'replica' ? 'replica' : 'calibrated';
  const valueOf = (row) => (mode === 'replica' ? row.replica?.composite : row.calibrated?.composite);
  const entries = rows.map((row) => ({ row, verdict: rankableVerdict(row) }));
  const rankedEntries = entries
    .filter((entry) => entry.verdict.complete && !entry.verdict.anomalous && Number.isFinite(valueOf(entry.row)))
    .sort((a, b) => (mode === 'replica'
      ? ((b.row.replica?.composite ?? 0) - (a.row.replica?.composite ?? 0))
        || String(a.row.districtName ?? '').localeCompare(String(b.row.districtName ?? ''), 'ar')
      : compareCalibratedRows(a.row, b.row)));

  // The page shows «مؤهلة» (ranked.length) next to «مرشحون في آخر تشغيل»
  // (meta.calibratedRanked). Deriving the counts below from the very lists built
  // here keeps the two in lock-step, so an anomalous/partial row can never
  // inflate the visible totals the operator is reading.
  const severeCount = rankedEntries.filter((entry) => entry.row.calibrated?.severe === true).length;

  const ranked = rankedEntries.map((entry, index) => ({
    rank: index + 1,
    directorateId: entry.row.dbId ?? null,
    districtName: entry.row.districtName,
    governorate: entry.row.governorate,
    composite: round(valueOf(entry.row) ?? 0, 4),
    replicaComposite: Number.isFinite(entry.row.replica?.composite) ? round(entry.row.replica.composite, 4) : null,
    projectType: entry.row.project?.label ?? '',
    decision: entry.row.values?.reviewerDecision ?? '',
    confidence: entry.row.confidence?.text ?? '',
    sensitivity: entry.row.sensitivity?.weight ?? null,
    population: Number.isFinite(Number(entry.row.values?.population)) ? Number(entry.row.values.population) : null,
  }));

  const waiting = entries
    .filter((entry) => !entry.verdict.complete && !entry.verdict.anomalous)
    .map((entry) => ({
      directorateId: entry.row.dbId ?? null,
      districtName: entry.row.districtName,
      governorate: entry.row.governorate,
      completeness: entry.row.completeness ?? null,
      missingLabels: entry.verdict.missingLabels,
    }))
    .sort((a, b) => (b.completeness?.ratio ?? 0) - (a.completeness?.ratio ?? 0)
      || String(a.districtName ?? '').localeCompare(String(b.districtName ?? ''), 'ar'));

  const blocked = entries
    .filter((entry) => entry.verdict.complete && !entry.verdict.anomalous
      && !Number.isFinite(valueOf(entry.row)) && entry.row.calibrated?.blocked === true)
    .map((entry) => ({
      directorateId: entry.row.dbId ?? null,
      districtName: entry.row.districtName,
      governorate: entry.row.governorate,
      completeness: entry.row.completeness ?? null,
      reason: entry.row.calibrated?.blockReason ?? null,
    }));

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

  // The four lists must be a true partition: every stored directorate is either
  // anomalous, waiting on a mandatory field, blocked (complete but with no
  // computable composite), or ranked. Since every indicator is derived from
  // mandatory fields only, a complete non-anomalous row always has a composite;
  // if that ever stops holding, surface it loudly instead of dropping the row
  // from every list (the same invariant strategy buildDashboard uses).
  const bucketTotal = ranked.length + waiting.length + blocked.length + anomalies.length;
  if (bucketTotal !== rows.length) {
    throw new Error(
      `ranking buckets must partition directorates: sum=${bucketTotal} total=${rows.length} `
      + `(ranked=${ranked.length} waiting=${waiting.length} blocked=${blocked.length} anomalies=${anomalies.length})`,
    );
  }

  return {
    mode,
    rule: 'يُرتب المكتمل فقط؛ وتُستبعد الصفوف ذات القيم الشاذة حتى تُصحّح',
    excluded: { waiting: waiting.length, blocked: blocked.length, anomalies: anomalies.length },
    ranked,
    waiting,
    blocked,
    anomalies,
    // Reflect the buckets actually built here, not the engine's raw counts, so
    // «مؤهلة» (ranked.length) and «مرشحون في آخر تشغيل» (meta.calibratedRanked)
    // cannot diverge for the same dataset.
    meta: analysis.summary
      ? { ...analysis.summary, calibratedRanked: ranked.length, calibratedBlocked: blocked.length, severeCount }
      : null,
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
    // Forwarded so a caller can skip the expensive sensitivity pass; absent or
    // true keeps the engine's default behaviour unchanged.
    sensitivity: options.sensitivity === false ? false : undefined,
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

module.exports = { buildSheets, buildDashboard, buildIndicators, buildRanking, rankableVerdict, isRankableCalibrated, compareCalibratedRows };
