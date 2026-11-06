'use strict';

const { INDICATORS, CALIBRATION } = require('./schema.cjs');
const { needScores } = require('./indicators.cjs');

const EPSILON = 1e-12;

function defaultWeights() {
  return Object.fromEntries(INDICATORS.map((indicator) => [indicator.code, indicator.weight]));
}

function sumWeights(weights) {
  return INDICATORS.reduce((total, indicator) => total + (Number(weights[indicator.code]) || 0), 0);
}

/**
 * Validates an operator-editable weight vector.
 * Weights must be non-negative and sum to 1 (tolerance 1e-6).
 */
function validateWeights(weights) {
  const errors = [];
  for (const indicator of INDICATORS) {
    const value = Number(weights[indicator.code]);
    if (!Number.isFinite(value)) errors.push(`الوزن غير رقمي: ${indicator.header}`);
    else if (value < 0) errors.push(`الوزن سالب: ${indicator.header}`);
    else if (value > 1) errors.push(`الوزن أكبر من 1: ${indicator.header}`);
  }
  const total = sumWeights(weights);
  if (Math.abs(total - 1) > 1e-6) errors.push(`مجموع الأوزان ${total.toFixed(6)} ولا يساوي 1.`);
  return { valid: errors.length === 0, errors, total };
}

/** Per-indicator min/max/count over the sample, mirroring MIN/MAX/COUNT over AN3:AY1002. */
function sampleStats(rows) {
  const stats = {};
  for (const indicator of INDICATORS) {
    let min = Infinity;
    let max = -Infinity;
    let count = 0;
    for (const row of rows) {
      const value = row.indicators?.[indicator.code] ?? row[indicator.code];
      if (typeof value !== 'number' || !Number.isFinite(value)) continue;
      count += 1;
      if (value < min) min = value;
      if (value > max) max = value;
    }
    stats[indicator.code] = count === 0 ? { min: null, max: null, count: 0 } : { min, max, count };
  }
  return stats;
}

/**
 * Mode A — "محاكاة القالب": a byte-faithful reproduction of column AZ.
 *
 * Faithful means faithful *including the defect*: an empty indicator enters the
 * sum as zero, i.e. as "no need". The returned `emptyAsZero` flag makes that
 * visible in the UI instead of hiding it.
 */
function replicaComposite(rows, options = {}) {
  const weights = options.weights ? { ...options.weights } : defaultWeights();
  const stats = options.stats || sampleStats(rows);
  const results = [];

  for (const row of rows) {
    const values = row.indicators;
    let numericCount = 0;
    let composite = 0;
    let emptyAsZero = 0;
    const contributions = {};

    for (const indicator of INDICATORS) {
      const value = values[indicator.code];
      const weight = Number(weights[indicator.code]) || 0;
      const stat = stats[indicator.code];

      // A missing value contributes zero to the sum, exactly like the workbook.
      // This is the documented defect: zero is the *best* possible score in both
      // directions, so missing data silently improves the result.
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        emptyAsZero += 1;
        contributions[indicator.code] = {
          normalized: 0, contribution: 0,
          reason: stat.count === 0 ? 'column-empty-as-zero' : 'empty-as-zero',
        };
        continue;
      }
      if (stat.count === 0) {
        contributions[indicator.code] = { normalized: 0, contribution: 0, reason: 'column-empty' };
        continue;
      }
      numericCount += 1;
      let normalized;
      if (stat.max === stat.min) normalized = 0.5;
      else if (indicator.direction === 'needUp') normalized = (value - stat.min) / (stat.max - stat.min);
      else normalized = (stat.max - value) / (stat.max - stat.min);
      if (!Number.isFinite(normalized)) normalized = 0;
      const contribution = normalized * weight;
      composite += contribution;
      contributions[indicator.code] = { normalized, contribution, reason: 'ok' };
    }

    results.push({
      composite: numericCount === 0 ? null : composite,
      contributions,
      numericCount,
      emptyAsZero,
      /** True when the value is computed from an incomplete record — the audit's gap #1. */
      flagged: emptyAsZero > 0,
      stats,
    });
  }
  return { results, stats, weights };
}

/**
 * Mode B — "المعايرة العلمية".
 *
 * Three documented departures from column AZ, each answering a gap in the audit:
 *  1. weight renormalisation over available indicators (an absent dimension
 *     neither rewards nor punishes);
 *  2. absolute anchors instead of sample Min–Max (stable across time);
 *  3. a deprivation count k with a severe-deprivation tier (Alkire–Foster),
 *     so a single collapse cannot be compensated by good averages.
 */
function calibratedComposite(rows, options = {}) {
  const weights = options.weights ? { ...options.weights } : defaultWeights();
  const deprivationLine = options.deprivationLine ?? CALIBRATION.deprivationLine;
  const kThreshold = options.kThreshold ?? CALIBRATION.kThreshold;
  const minCoverage = options.minWeightCoverage ?? CALIBRATION.minWeightCoverage;
  const results = [];

  for (const row of rows) {
    const scores = needScores(row.indicators);
    let available = 0;
    let weightSum = 0;
    let weighted = 0;
    let degraded = 0;
    const contributions = {};

    for (const indicator of INDICATORS) {
      const score = scores[indicator.code];
      const weight = Number(weights[indicator.code]) || 0;
      if (score === null) {
        contributions[indicator.code] = { score: null, weight, contribution: 0, degraded: false, reason: 'missing' };
        continue;
      }
      available += 1;
      weightSum += weight;
      weighted += score * weight;
      const isDegraded = score >= deprivationLine;
      if (isDegraded) degraded += 1;
      contributions[indicator.code] = {
        score,
        weight,
        contribution: score * weight,
        degraded: isDegraded,
        reason: isDegraded ? 'degraded' : 'ok',
      };
    }

    const weightCoverage = weightSum;
    const blocked = available === 0 || weightCoverage < minCoverage - EPSILON;
    const composite = blocked ? null : weighted / weightSum;
    const severe = available > 0 && degraded >= kThreshold && available >= kThreshold;

    results.push({
      composite,
      scores,
      contributions,
      available,
      weightCoverage,
      degradedCount: degraded,
      severe,
      tier: severe ? CALIBRATION.severeTierLabel : null,
      blocked,
      blockReason: available === 0 ? 'no-data' : blocked ? 'insufficient-weight-coverage' : null,
    });
  }
  return { results, weights, deprivationLine, kThreshold, minCoverage };
}

module.exports = {
  defaultWeights,
  sumWeights,
  validateWeights,
  sampleStats,
  replicaComposite,
  calibratedComposite,
};