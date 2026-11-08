'use strict';

const { INDICATORS } = require('./schema.cjs');

const SHARED_HIDDEN_INDICATORS = new Set(['frontLineRisk', 'revenuePerCapita', 'fiscalGap']);
const PRIORITY_FIELDS = new Set(['composite', 'rank', 'replicaComposite', 'calibratedRank', 'replicaRank', 'degradedCount', 'weightCoverage', 'severe', 'blocked', 'confidenceLevel', 'fragile', 'maxRankShift']);

function finiteOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function metricValue(row, code, view) {
  if (view === 'scores') return finiteOrNull(row.scores?.[code]);
  if (view === 'contributions') {
    const contribution = row.contributions?.[code];
    return finiteOrNull(contribution && typeof contribution === 'object' ? contribution.contribution : contribution);
  }
  return finiteOrNull(row.values?.[code]);
}

function fieldValue(row, field, mode, view) {
  if (field === 'metric') return metricValue(row, row.__conditionCode, view);
  if (field === 'composite') return finiteOrNull(mode === 'replica' ? row.replicaComposite : row.composite);
  if (field === 'rank') return finiteOrNull(mode === 'replica' ? row.replicaRank : row.calibratedRank);
  if (field === 'complete') return row.verdict?.complete === true;
  if (field === 'anomalous') return row.verdict?.anomalous === true;
  if (field === 'fragile' || field === 'maxRankShift') return row[field] ?? null;
  return row[field] ?? null;
}

function matches(condition, row, mode, view) {
  const { field, code, operator, value, min, max, exclude } = condition;
  const resolvedField = field === 'metric' ? 'metric' : field;
  const probe = field === 'metric' ? { ...row, __conditionCode: code } : row;
  const actual = fieldValue(probe, resolvedField, mode, view);
  let result;
  if (operator === 'empty') result = actual === null || actual === undefined;
  else if (operator === 'present') result = actual !== null && actual !== undefined;
  else if (operator === 'equals') result = actual === value;
  else if (operator === 'boolean') result = actual === (value === 'true');
  else {
    const lower = min === '' || min === null || min === undefined ? null : Number(min);
    const upper = max === '' || max === null || max === undefined ? null : Number(max);
    const number = typeof actual === 'boolean' ? Number(actual) : Number(actual);
    const divisor = field === 'weightCoverage' ? 100 : 1;
    const resultMin = lower === null ? null : lower / divisor;
    const resultMax = upper === null ? null : upper / divisor;
    result = actual !== null && actual !== undefined && Number.isFinite(number)
      && (resultMin === null || (Number.isFinite(resultMin) && number >= resultMin))
      && (resultMax === null || (Number.isFinite(resultMax) && number <= resultMax));
  }
  return exclude === true ? !result : result;
}

function statsFor(rows, registry, view) {
  const stats = {};
  for (const indicator of registry) {
    const values = rows.map((row) => metricValue(row, indicator.code, view)).filter(Number.isFinite);
    stats[indicator.code] = {
      count: values.length,
      missing: rows.length - values.length,
      min: values.length ? Math.min(...values) : null,
      max: values.length ? Math.max(...values) : null,
      average: values.length ? values.reduce((sum, number) => sum + number, 0) / values.length : null,
    };
  }
  return stats;
}

function filterIndicatorReport(payload, request = {}, profile = 'owner') {
  const mode = request.mode === 'replica' ? 'replica' : 'calibrated';
  const view = ['values', 'scores', 'contributions'].includes(request.view) ? request.view : 'values';
  const registry = (payload.registry ?? []).filter((indicator) => profile !== 'shared' || !SHARED_HIDDEN_INDICATORS.has(indicator.code));
  const allowedIndicators = new Set(registry.map((indicator) => indicator.code));
  const rawCriteria = (Array.isArray(request.criteria) ? request.criteria : []).slice(0, 64);
  const criteria = rawCriteria.filter((condition) => {
    if (condition?.field === 'metric') return allowedIndicators.has(condition.code);
    if (condition?.field === 'complete') return profile !== 'shared';
    if (condition?.field === 'anomalous') return true;
    if (['fragile', 'maxRankShift'].includes(condition?.field)) return profile !== 'shared' && mode === 'calibrated';
    if (PRIORITY_FIELDS.has(condition?.field)) return profile !== 'shared';
    return false;
  });
  const sourceRows = (payload.rows ?? []).map((row) => {
    if (profile !== 'shared') return row;
    const values = Object.fromEntries(Object.entries(row.values ?? {}).filter(([code]) => allowedIndicators.has(code)));
    const scores = Object.fromEntries(Object.entries(row.scores ?? {}).filter(([code]) => allowedIndicators.has(code)));
    return {
      ...row,
      values,
      scores,
      contributions: {},
      composite: null,
      replicaComposite: null,
      calibratedRank: null,
      replicaRank: null,
      degradedCount: null,
      weightCoverage: null,
      severe: null,
      blocked: null,
      confidenceLevel: null,
      fragile: null,
      maxRankShift: null,
      completeness: null,
      verdict: {
        complete: null,
        anomalous: Boolean(row.verdict?.anomalous),
        missingLabels: null,
        anomalyKeys: row.verdict?.anomalyKeys ?? [],
      },
    };
  });
  const matched = sourceRows.filter((row) => {
    if (!criteria.length) return true;
    const outcomes = criteria.map((condition) => matches(condition, row, mode, view));
    return request.logic === 'or' ? outcomes.some(Boolean) : outcomes.every(Boolean);
  });
  const sort = typeof request.sort === 'string' ? request.sort : 'rank';
  const direction = request.direction === 'asc' ? 1 : -1;
  if (sort === 'rank' || sort === 'composite') {
    const rankKey = mode === 'replica' ? 'replicaRank' : 'calibratedRank';
    const scoreKey = mode === 'replica' ? 'replicaComposite' : 'composite';
    matched.sort((left, right) => direction * ((left[rankKey] ?? Number.MAX_SAFE_INTEGER) - (right[rankKey] ?? Number.MAX_SAFE_INTEGER))
      || direction * ((right[scoreKey] ?? -Infinity) - (left[scoreKey] ?? -Infinity)));
  } else if (allowedIndicators.has(sort)) {
    matched.sort((left, right) => direction * ((metricValue(left, sort, view) ?? (direction > 0 ? Infinity : -Infinity))
      - (metricValue(right, sort, view) ?? (direction > 0 ? Infinity : -Infinity))));
  }
  return {
    registry,
    stats: statsFor(matched, registry, view),
    rows: matched,
    total: matched.length,
    filters: { criteria, logic: request.logic === 'or' ? 'or' : 'and', mode, view, sort, direction: request.direction === 'asc' ? 'asc' : 'desc' },
    summary: {
      total: matched.length,
      complete: profile === 'shared' ? null : matched.filter((row) => row.verdict?.complete).length,
      anomalous: matched.filter((row) => row.verdict?.anomalous).length,
      rankable: profile === 'shared' ? null : matched.filter((row) => Number.isFinite(mode === 'replica' ? row.replicaComposite : row.composite)).length,
      averageComposite: profile === 'shared' || !matched.some((row) => Number.isFinite(mode === 'replica' ? row.replicaComposite : row.composite))
        ? null
        : matched.reduce((sum, row) => sum + (mode === 'replica' ? row.replicaComposite : row.composite ?? 0), 0)
          / matched.filter((row) => Number.isFinite(mode === 'replica' ? row.replicaComposite : row.composite)).length,
    },
  };
}

module.exports = { filterIndicatorReport, metricValue, statsFor, SHARED_HIDDEN_INDICATORS };
