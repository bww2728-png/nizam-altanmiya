'use strict';

const { INDICATORS } = require('./schema.cjs');
const { defaultWeights, sumWeights, replicaComposite, calibratedComposite } = require('./composite.cjs');

/**
 * Sensitivity analysis — the missing element in the workbook (audit gap #1/#2).
 *
 * Two independent questions are answered:
 *  1. Weight sensitivity: if the experts disagree by 20% on any single weight,
 *     does the ranking change?
 *  2. Sample sensitivity (replica mode only): if one directorate is added or
 *     removed from the sheet, does the Min–Max scale move the others?
 *
 * A rank that survives every scenario is defensible. A rank that flips in most
 * scenarios must be flagged before a budget decision is attached to it.
 */

const PERTURBATION = 0.2;
/** Deleting one row at a time is O(n²); above this size we refuse rather than freeze. */
const SAMPLE_SENSITIVITY_MAX = 400;

function renormalize(weights) {
  const total = sumWeights(weights);
  if (total <= 0) return { ...weights };
  const result = {};
  for (const indicator of INDICATORS) result[indicator.code] = (Number(weights[indicator.code]) || 0) / total;
  return result;
}

/** Weighted ranking by composite alone, deterministic on ties. */
function rankByComposite(rows, getValue) {
  const scored = rows
    .map((row) => ({ row, value: getValue(row) }))
    .filter((entry) => typeof entry.value === 'number' && Number.isFinite(entry.value));
  scored.sort((a, b) => {
    const delta = b.value - a.value;
    if (Math.abs(delta) > 1e-12) return delta;
    const severeDelta = Number(Boolean(b.row.calibrated?.severe)) - Number(Boolean(a.row.calibrated?.severe));
    if (severeDelta !== 0) return severeDelta;
    return String(a.row.districtName ?? '').localeCompare(String(b.row.districtName ?? ''), 'ar');
  });
  const ranks = new Map();
  scored.forEach((entry, index) => ranks.set(entry.row, index + 1));
  return ranks;
}

function buildWeightScenarios(baseWeights) {
  const scenarios = [{ id: 'base', label: 'الأوزان المعتمدة', weights: { ...baseWeights } }];

  scenarios.push({
    id: 'uniform',
    label: 'أوزان متساوية (1/12 لكل مؤشر)',
    weights: renormalize(Object.fromEntries(INDICATORS.map((indicator) => [indicator.code, 1]))),
  });

  const byWeight = [...INDICATORS].sort((a, b) => b.weight - a.weight);
  const top3 = byWeight.slice(0, 3).map((indicator) => indicator.code);

  const raised = { ...baseWeights };
  const lowered = { ...baseWeights };
  for (const code of top3) {
    raised[code] = (Number(baseWeights[code]) || 0) * (1 + PERTURBATION);
    lowered[code] = (Number(baseWeights[code]) || 0) * (1 - PERTURBATION);
  }
  scenarios.push({ id: 'top3-up', label: 'أثقل ثلاثة مؤشرات +20%', weights: renormalize(raised) });
  scenarios.push({ id: 'top3-down', label: 'أثقل ثلاثة مؤشرات −20%', weights: renormalize(lowered) });

  for (const indicator of INDICATORS) {
    const weights = { ...baseWeights };
    weights[indicator.code] = (Number(baseWeights[indicator.code]) || 0) * (1 + PERTURBATION);
    scenarios.push({
      id: `up:${indicator.code}`,
      label: `${indicator.header} +20%`,
      weights: renormalize(weights),
      indicator: indicator.code,
    });
  }

  return scenarios;
}

/**
 * @param {Array} rows rows already analysed (carry `indicators` and `calibrated`)
 * @param {object} options { weights, mode: 'calibrated'|'replica', kThreshold }
 */
function analyzeSensitivity(rows, options = {}) {
  const mode = options.mode === 'replica' ? 'replica' : 'calibrated';
  const baseWeights = options.weights ? { ...options.weights } : defaultWeights();
  const scenarios = buildWeightScenarios(baseWeights);

  const ranksByScenario = new Map();
  for (const scenario of scenarios) {
    if (mode === 'replica') {
      const { results } = replicaComposite(rows, { weights: scenario.weights });
      rows.forEach((row, index) => { row.__scenarioComposite = results[index].composite; });
      ranksByScenario.set(scenario.id, rankByComposite(rows, (row) => row.__scenarioComposite));
    } else {
      const { results } = calibratedComposite(rows, { weights: scenario.weights, kThreshold: options.kThreshold });
      rows.forEach((row, index) => { row.__scenarioComposite = results[index].composite; });
      ranksByScenario.set(scenario.id, rankByComposite(rows, (row) => row.__scenarioComposite));
    }
  }
  for (const row of rows) delete row.__scenarioComposite;

  const perRow = new Map();
  for (const row of rows) {
    const ranks = [];
    for (const scenario of scenarios) {
      const rank = ranksByScenario.get(scenario.id)?.get(row);
      if (rank) ranks.push({ scenario: scenario.id, label: scenario.label, rank });
    }
    if (!ranks.length) {
      perRow.set(row, { minRank: null, maxRank: null, rankRange: null, distinctRanks: 0, fragile: false, scenarios: [] });
      continue;
    }
    const values = ranks.map((entry) => entry.rank);
    const minRank = Math.min(...values);
    const maxRank = Math.max(...values);
    const distinctRanks = new Set(values).size;
    perRow.set(row, {
      minRank, maxRank,
      rankRange: maxRank - minRank,
      distinctRanks,
      /** Fragile when a 20% weight change moves the rank by three places or more. */
      fragile: maxRank - minRank >= 3,
      worstCase: ranks.find((entry) => entry.rank === maxRank),
      bestCase: ranks.find((entry) => entry.rank === minRank),
      scenarios: ranks,
    });
  }

  const fragility = {
    mode,
    scenarioCount: scenarios.length,
    fragileCount: [...perRow.values()].filter((entry) => entry.fragile).length,
    rankedCount: [...perRow.values()].filter((entry) => entry.minRank !== null).length,
  };

  return { scenarios, perRow, fragility, sampleSensitivity: mode === 'replica' ? analyzeSampleSensitivity(rows, baseWeights) : null };
}

/**
 * Min–Max fragility: recompute the ranking while dropping one directorate at a
 * time and report how far each rank moves. This is the direct measurement of
 * audit gap #3 and needs no assumptions.
 */
function analyzeSampleSensitivity(rows, weights) {
  if (rows.length > SAMPLE_SENSITIVITY_MAX) {
    // Leave-one-out on a large population costs seconds per row; report the limit
    // explicitly instead of stalling the UI or shipping a misleading zero.
    return {
      droppedCount: rows.length,
      maxShift: 0,
      unstable: false,
      truncated: true,
      limit: SAMPLE_SENSITIVITY_MAX,
      note: `حساسية العيّنة لم تُحسب لأن عدد المديريات (${rows.length}) يتجاوز حد ${SAMPLE_SENSITIVITY_MAX}.`,
      detail: [],
    };
  }
  const base = replicaComposite(rows, { weights });
  rows.forEach((row, index) => { row.__base = base.results[index].composite; });
  const baseRanks = rankByComposite(rows, (row) => row.__base);

  const perRow = new Map(rows.map((row) => [row, []]));
  for (let dropped = 0; dropped < rows.length; dropped += 1) {
    const subset = rows.filter((_, index) => index !== dropped);
    const { results } = replicaComposite(subset, { weights });
    subset.forEach((row, index) => { row.__subset = results[index].composite; });
    const subsetRanks = rankByComposite(subset, (row) => row.__subset);
    for (const [row, rank] of subsetRanks) perRow.get(row)?.push(rank);
    for (const row of subset) delete row.__subset;
  }
  for (const row of rows) delete row.__base;

  const detail = [];
  rows.forEach((row, index) => {
    const rank = baseRanks.get(row) ?? null;
    const observed = perRow.get(row) ?? [];
    const minRank = observed.length ? Math.min(...observed) : null;
    const maxRank = observed.length ? Math.max(...observed) : null;
    detail.push({
      index,
      districtName: row.districtName,
      governorate: row.governorate ?? '',
      rank,
      minRank, maxRank,
      maxShift: minRank === null ? 0 : Math.max(Math.abs(minRank - rank), Math.abs(maxRank - rank)),
    });
  });

  const worst = detail.reduce((max, entry) => Math.max(max, entry.maxShift), 0);
  return {
    droppedCount: rows.length,
    maxShift: worst,
    unstable: worst > 0,
    truncated: false,
    limit: SAMPLE_SENSITIVITY_MAX,
    detail,
  };
}

module.exports = {
  analyzeSensitivity,
  analyzeSampleSensitivity,
  buildWeightScenarios,
  renormalize,
  PERTURBATION,
  SAMPLE_SENSITIVITY_MAX,
};