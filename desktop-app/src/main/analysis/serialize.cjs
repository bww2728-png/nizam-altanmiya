'use strict';

/**
 * Converts the engine result into a structured-clone-safe payload.
 *
 * `analyze()` returns Maps keyed by row objects (gaps, sensitivity) which cannot
 * cross the Electron IPC boundary. Rather than weakening the engine, the
 * renderer gets an explicit indexed shape: rows keep their order, and every
 * relation is expressed as a row index.
 */

function rowKey(row, index) {
  return `${row.governorate ?? ''}|${row.districtName ?? ''}|${index}`;
}

function plainRow(row, index) {
  return {
    index,
    key: rowKey(row, index),
    id: row.id ?? null,
    dbId: row.dbId ?? null,
    rowNumber: row.rowNumber ?? null,
    districtName: row.districtName ?? '',
    governorate: row.governorate ?? '',
    values: row.values ?? {},
    rawValues: row.rawValues ?? {},
    warnings: row.warnings ?? [],
    indicators: row.indicators ?? {},
    completeness: {
      present: row.completeness?.present ?? 0,
      total: row.completeness?.total ?? 0,
      ratio: row.completeness?.ratio ?? 0,
      missingLabels: row.completeness?.missingLabels ?? [],
      missingText: row.completeness?.missingText ?? '',
      waiting: Boolean(row.completeness?.waiting),
    },
    replica: row.replica ?? null,
    calibrated: row.calibrated ?? null,
    project: row.project ?? null,
    confidence: row.confidence ?? null,
    boundary: row.boundary ?? [],
    sensitivity: row.sensitivity ?? null,
  };
}

function indexMap(rows) {
  const map = new Map();
  rows.forEach((row, index) => map.set(row, index));
  return map;
}

function serializeAnalysis(analysis) {
  const rows = analysis.rows ?? [];
  const positions = indexMap(rows);

  const indexesOf = (list) => (list ?? []).map((row) => positions.get(row)).filter((index) => index !== undefined);

  const weightPerRow = [];
  for (const [row, entry] of analysis.sensitivity?.weight?.perRow ?? []) {
    const index = positions.get(row);
    if (index === undefined) continue;
    weightPerRow.push({ index, ...entry });
  }

  const gapPerRow = [];
  for (const [row, issues] of analysis.gaps?.recordIssues ?? []) {
    const index = positions.get(row);
    if (index === undefined) continue;
    gapPerRow.push({ index, districtName: row.districtName, issues });
  }

  const replica = analysis.ranking?.replica ?? {};
  const calibrated = analysis.ranking?.calibrated ?? {};

  return {
    meta: analysis.meta ?? {},
    summary: analysis.summary ?? {},
    rows: rows.map(plainRow),
    ranking: {
      replica: {
        ranked: indexesOf(replica.ranked),
        waiting: indexesOf(replica.waiting),
        waitingOrder: replica.waitingOrder ?? [],
      },
      calibrated: {
        ranked: indexesOf(calibrated.ranked),
        blocked: indexesOf(calibrated.blocked),
        blockedReasons: calibrated.blockedReasons ?? [],
      },
      comparison: analysis.ranking?.comparison ?? null,
    },
    sensitivity: {
      weight: {
        scenarios: (analysis.sensitivity?.weight?.scenarios ?? []).map((scenario) => ({
          id: scenario.id, label: scenario.label, indicator: scenario.indicator ?? null,
        })),
        fragility: analysis.sensitivity?.weight?.fragility ?? null,
        perRow: weightPerRow,
      },
      sample: analysis.sensitivity?.sample ?? null,
    },
    gaps: {
      summary: analysis.gaps?.summary ?? {},
      severityLabels: analysis.gaps?.severityLabels ?? {},
      perRow: gapPerRow,
      crossIssues: analysis.gaps?.crossIssues ?? [],
    },
    stats: analysis.stats ?? {},
  };
}

module.exports = { serializeAnalysis };