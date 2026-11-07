'use strict';

const { CALIBRATION } = require('./schema.cjs');

/**
 * Deterministic ranking.
 *
 * The workbook ranks with LARGE + INDEX/MATCH over a tie-break key
 * (BE + ROW()/1e8), which makes the order stable but arbitrary in case of a
 * tie. We keep determinism and make it explicable: ties are broken by the
 * higher availability of evidence, then alphabetically by district name, so the
 * same data always yields the same order on every machine.
 */

function compareText(a, b) {
  return String(a ?? '').localeCompare(String(b ?? ''), 'ar');
}

/**
 * Mode A ranking — only fully complete records are ranked, mirroring BE/BD.
 * Incomplete records go to the waiting queue with their completeness.
 */
function rankReplica(rows) {
  const eligible = [];
  const waiting = [];

  for (const row of rows) {
    const complete = row.completeness?.ratio === 1;
    const value = row.replica?.composite;
    if (complete && typeof value === 'number' && Number.isFinite(value)) eligible.push(row);
    else waiting.push(row);
  }

  eligible.sort((a, b) => {
    const delta = b.replica.composite - a.replica.composite;
    if (Math.abs(delta) > 1e-12) return delta;
    return compareText(a.districtName, b.districtName);
  });

  eligible.forEach((row, index) => { row.replica.rank = index + 1; });
  for (const row of waiting) row.replica.rank = null;

  waiting.sort((a, b) => {
    const delta = (b.completeness?.ratio ?? 0) - (a.completeness?.ratio ?? 0);
    if (Math.abs(delta) > 1e-12) return delta;
    return compareText(a.districtName, b.districtName);
  });

  return {
    ranked: eligible,
    waiting,
    waitingOrder: waiting.map((row, index) => ({ rank: index + 1, districtName: row.districtName, completeness: row.completeness?.ratio ?? 0 })),
  };
}

/**
 * Mode B ranking — severe deprivation takes precedence over the composite.
 *
 * This is the Alkire–Foster idea applied to prioritisation: a directorate that
 * is degraded in four or more dimensions cannot be pushed down the list by a
 * good average in the others.
 */
function rankCalibrated(rows) {
  const eligible = [];
  const blocked = [];

  for (const row of rows) {
    const value = row.calibrated?.composite;
    if (row.calibrated?.blocked || typeof value !== 'number' || !Number.isFinite(value)) blocked.push(row);
    else eligible.push(row);
  }

  eligible.sort((a, b) => {
    const severeDelta = Number(Boolean(b.calibrated.severe)) - Number(Boolean(a.calibrated.severe));
    if (severeDelta !== 0) return severeDelta;
    const delta = b.calibrated.composite - a.calibrated.composite;
    if (Math.abs(delta) > 1e-12) return delta;
    const degradedDelta = b.calibrated.degradedCount - a.calibrated.degradedCount;
    if (degradedDelta !== 0) return degradedDelta;
    return compareText(a.districtName, b.districtName);
  });

  eligible.forEach((row, index) => { row.calibrated.rank = index + 1; });
  for (const row of blocked) row.calibrated.rank = null;

  return {
    ranked: eligible,
    blocked,
    blockedReasons: blocked.map((row) => ({
      districtName: row.districtName,
      reason: row.calibrated?.blockReason ?? 'unknown',
      weightCoverage: row.calibrated?.weightCoverage ?? 0,
    })),
  };
}

/** Direction of agreement between the two modes across the whole sample. */
function compareRanks(rows, options = {}) {
  const comparable = rows.filter((row) => row.replica?.rank && row.calibrated?.rank);
  const pairs = comparable.map((row, index) => ({
    index,
    districtName: row.districtName,
    governorate: row.governorate ?? '',
    replicaRank: row.replica.rank,
    calibratedRank: row.calibrated.rank,
    delta: row.replica.rank - row.calibrated.rank,
  }));
  const changed = pairs.filter((pair) => pair.delta !== 0);
  const maxShift = pairs.reduce((max, pair) => Math.max(max, Math.abs(pair.delta)), 0);
  return { pairs, changed, maxShift, comparable: comparable.length, kThreshold: options.kThreshold ?? CALIBRATION.kThreshold };
}

module.exports = { rankReplica, rankCalibrated, compareRanks, compareText };