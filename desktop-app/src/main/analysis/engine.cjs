'use strict';

const { TEMPLATE, INDICATORS, CALIBRATION, MANDATORY_FIELDS } = require('./schema.cjs');
const { computeIndicators, recommendProjectType } = require('./indicators.cjs');
const { completeness, confidence, boundaryDetails } = require('./columns.cjs');
const {
  defaultWeights, validateWeights, replicaComposite, calibratedComposite,
} = require('./composite.cjs');
const { rankReplica, rankCalibrated, compareRanks } = require('./ranking.cjs');
const { analyzeSensitivity, analyzeSampleSensitivity } = require('./sensitivity.cjs');
const { analyzeGaps } = require('./gaps.cjs');

/**
 * The single entry point used by the IPC layer, the exporters and the tests.
 *
 * Input rows: { id, districtName, governorate, values, warnings, rawValues, sources }
 *   values     -> canonical keys with parsed numbers (null when empty)
 *   warnings   -> parse warnings [{ key, code, raw, value }]
 *
 * Output: a fully resolved analysis, ready to be persisted or rendered.
 */
function analyze(rows, options = {}) {
  const weights = options.weights ? { ...options.weights } : defaultWeights();
  const weightCheck = validateWeights(weights);
  if (!weightCheck.valid) {
    throw new Error(`أوزان غير صالحة: ${weightCheck.errors.join(' ')}`);
  }

  const kThreshold = options.kThreshold !== undefined && options.kThreshold !== null && Number.isFinite(Number(options.kThreshold))
    ? Number(options.kThreshold)
    : CALIBRATION.kThreshold;
  const deprivationLine = options.deprivationLine !== undefined && options.deprivationLine !== null && Number.isFinite(Number(options.deprivationLine))
    ? Number(options.deprivationLine)
    : CALIBRATION.deprivationLine;

  // 1. Indicators and completeness per row.
  const analysed = rows.map((row) => {
    const values = row.values ?? {};
    const indicators = computeIndicators(values);
    const completenessResult = completeness(values);
    return {
      ...row,
      districtName: row.districtName ?? values.districtName ?? '',
      governorate: row.governorate ?? values.governorate ?? '',
      values,
      indicators,
      completeness: completenessResult,
    };
  });

  // 2. Mode A — weighted composite (linear sum of the twelve dimensions).
  const replicaRun = replicaComposite(analysed, { weights });
  analysed.forEach((row, index) => {
    const result = replicaRun.results[index];
    row.replica = {
      composite: result.composite,
      contributions: result.contributions,
      numericCount: result.numericCount,
      missingContributedZero: result.emptyAsZero,
      flagged: result.flagged,
      rank: null,
    };
  });

  // 3. Mode B — calibrated composite with a deprivation count.
  const calibratedRun = calibratedComposite(analysed, { weights, kThreshold, deprivationLine });
  analysed.forEach((row, index) => {
    const result = calibratedRun.results[index];
    row.calibrated = {
      composite: result.composite,
      scores: result.scores,
      contributions: result.contributions,
      available: result.available,
      weightCoverage: result.weightCoverage,
      degradedCount: result.degradedCount,
      severe: result.severe,
      tier: result.tier,
      blocked: result.blocked,
      blockReason: result.blockReason,
      rank: null,
    };
  });

  // 4. Column BA (project type) + BB (confidence) — kept byte-identical to the workbook.
  for (const row of analysed) {
    row.project = recommendProjectType(row.indicators, row.values, row.values);
    row.boundary = boundaryDetails(row.indicators);
    row.confidence = confidence({
      projectType: row.project.label,
      completeness: row.completeness,
      indicators: row.indicators,
      composite: row.replica.composite,
    });
  }

  // 5. Rankings and the comparison between the two modes.
  const replicaRanking = rankReplica(analysed);
  const calibratedRanking = rankCalibrated(analysed);
  const comparison = compareRanks(analysed, { kThreshold });

  // 6. Sensitivity — weight perturbation for mode B, sample perturbation for mode A.
  const sensitivity = analyzeSensitivity(analysed, { weights, mode: 'calibrated', kThreshold });
  const sampleSensitivity = analyzeSampleSensitivity(analysed, weights);
  // `detail` is produced in row order, so match it by position. Matching by name
  // would attach one directorate's shift to a same-name district elsewhere.
  const sampleShiftByRow = new Map();
  sampleSensitivity.detail.forEach((item, index) => {
    const row = analysed[index];
    if (row) sampleShiftByRow.set(row, item.maxShift);
  });
  for (const row of analysed) {
    const entry = sensitivity.perRow.get(row);
    row.sensitivity = entry
      ? {
        minRank: entry.minRank, maxRank: entry.maxRank, rankRange: entry.rankRange,
        distinctRanks: entry.distinctRanks, fragile: entry.fragile, scenarios: entry.scenarios,
        sampleMaxShift: sampleShiftByRow.get(row) ?? 0,
      }
      : null;
  }

  // 7. Data gaps.
  const gaps = analyzeGaps(analysed);

  // 8. Summary.
  const complete = analysed.filter((row) => row.completeness.ratio === 1);
  const summary = {
    template: TEMPLATE,
    rows: analysed.length,
    complete: complete.length,
    waiting: analysed.length - complete.length,
    averageCompleteness: analysed.length
      ? analysed.reduce((sum, row) => sum + row.completeness.ratio, 0) / analysed.length
      : 0,
    replicaRanked: replicaRanking.ranked.length,
    calibratedRanked: calibratedRanking.ranked.length,
    calibratedBlocked: calibratedRanking.blocked.length,
    severeCount: analysed.filter((row) => row.calibrated.severe).length,
    fragileCount: analysed.filter((row) => row.sensitivity?.fragile).length,
    sampleSensitivityTruncated: Boolean(sampleSensitivity.truncated),
    averageWeightCoverage: analysed.length
      ? analysed.reduce((sum, row) => sum + (row.calibrated.weightCoverage ?? 0), 0) / analysed.length
      : 0,
    totalMandatoryFields: MANDATORY_FIELDS.length,
    indicatorsAvailable: INDICATORS.reduce((count, indicator) => count + (replicaRun.stats[indicator.code].count > 0 ? 1 : 0), 0),
    gaps: gaps.summary,
  };

  return {
    meta: {
      generatedAt: new Date().toISOString(),
      weights,
      weightCheck,
      kThreshold,
      deprivationLine,
      minWeightCoverage: CALIBRATION.minWeightCoverage,
      template: TEMPLATE,
      modes: {
        replica: 'المؤشر المرجّح: جمع خطي للأبعاد الموزونة (الفراغ = صفر)',
        calibrated: 'مؤشر الاحتياج المعاير: نقاط مرجعية ثابتة + تعداد الأبعاد المتدهورة',
      },
    },
    rows: analysed,
    summary,
    ranking: {
      replica: replicaRanking,
      calibrated: calibratedRanking,
      comparison,
    },
    sensitivity: { weight: sensitivity, sample: sampleSensitivity },
    gaps,
    stats: replicaRun.stats,
  };
}

module.exports = { analyze };