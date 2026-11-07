'use strict';

const { MANDATORY_FIELDS, BOUNDARY_MARGINS, INDICATORS } = require('./schema.cjs');
const { roundHalfAway, formatFixed, formatPercent } = require('./parse.cjs');

/**
 * Columns BD, BF, BH — data-quality gates.
 *
 * BD counts *present* values, which the audit shows is not the same as
 * *correct* values (gap #5). We keep the original semantics so the numbers stay
 * identical to the workbook, and expose correctness separately in gaps.cjs.
 */

function isPresent(field, value) {
  // COUNT() in Excel only counts numeric cells for these eleven columns.
  if (field.key === 'frontLine' || field.key === 'projectStatus') {
    return value !== null && value !== undefined && String(value).trim() !== '';
  }
  return typeof value === 'number' && Number.isFinite(value);
}

function completeness(record) {
  const missing = [];
  let present = 0;
  for (const field of MANDATORY_FIELDS) {
    if (isPresent(field, record[field.key])) present += 1;
    else missing.push(field);
  }
  return {
    present,
    total: MANDATORY_FIELDS.length,
    ratio: roundHalfAway(present / MANDATORY_FIELDS.length, 3),
    missing,
    missingLabels: missing.map((field) => field.label),
    /** Column BF text, byte-compatible with the workbook. */
    missingText: missing.length ? missing.map((field) => field.label).join('، ') : 'مكتملة',
    /** Column BH semantics: only incomplete rows enter the waiting queue. */
    waiting: present < MANDATORY_FIELDS.length,
  };
}

/**
 * Column BB — confidence & sensitivity.
 * @param {object} input
 * @param {string} input.projectType column BA text
 * @param {{ratio:number, missingText:string}} input.completeness
 * @param {Record<string, number|null>} input.indicators
 * @param {number|null} input.composite column AZ value
 */
function confidence({ projectType, completeness: completenessResult, indicators, composite }) {
  const compositeText = composite === null || composite === undefined ? '—' : formatFixed(composite, 3);
  const blocked = typeof projectType === 'string' && projectType.includes('ناقصة');

  if (blocked) {
    return { icon: '⛔', level: 'blocked', text: `⛔ محجوبة | ناقص: ${completenessResult.missingText} | المركب ${compositeText}` };
  }

  if (completenessResult.ratio < 1) {
    return {
      icon: '⚠️', level: 'preliminary',
      text: `⚠️ مبدئية | اكتمال ${formatPercent(completenessResult.ratio)} | ناقص: ${completenessResult.missingText} | المركب ${compositeText}`,
    };
  }

  if (isBoundary(indicators)) {
    return { icon: '⚠️', level: 'boundary', text: `⚠️ حدّية | المركب ${compositeText}` };
  }

  return { icon: '✅', level: 'confirmed', text: `✅ مؤكدة | المركب ${compositeText}` };
}

/**
 * Columns BB's sensitivity band: a decision that sits within the margin of a
 * launch threshold must be reviewed manually.
 */
function isBoundary(indicators) {
  return INDICATORS.some((indicator) => {
    const margin = BOUNDARY_MARGINS[indicator.code];
    if (margin === undefined || !indicator.launch) return false;
    const value = indicators[indicator.code];
    if (typeof value !== 'number' || !Number.isFinite(value)) return false;
    return Math.abs(value - indicator.launch.value) <= margin;
  });
}

/** Detail for the UI: which thresholds are within their margin. */
function boundaryDetails(indicators) {
  return INDICATORS.filter((indicator) => {
    const margin = BOUNDARY_MARGINS[indicator.code];
    if (margin === undefined || !indicator.launch) return false;
    const value = indicators[indicator.code];
    return typeof value === 'number' && Number.isFinite(value) && Math.abs(value - indicator.launch.value) <= margin;
  }).map((indicator) => ({
    code: indicator.code,
    header: indicator.header,
    value: indicators[indicator.code],
    threshold: indicator.launch.value,
    margin: BOUNDARY_MARGINS[indicator.code],
  }));
}

module.exports = { completeness, confidence, isBoundary, boundaryDetails, isPresent };