'use strict';

const { INDICATORS, INDICATOR_BY_CODE } = require('./schema.cjs');

/**
 * The twelve indicators, transcribed from columns AN..AY.
 *
 * Contract: a value is either a finite number or `null`. `null` means "the
 * workbook cell is empty" — never zero. Zero stays zero. That distinction is
 * the whole point of the guard chain, and it is the first thing the audit
 * proves the workbook itself gets wrong downstream (empty contributes 0 to AZ).
 */

function num(record, key) {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function ratio(numerator, denominator) {
  if (numerator === null || denominator === null) return null;
  return denominator > 0 ? numerator / denominator : 0;
}

/**
 * @param {Record<string, number|null>} record parsed canonical values
 * @returns {Record<string, number|null>} the twelve indicator values
 */
function computeIndicators(record) {
  const population = num(record, 'population');
  const facilities = num(record, 'govFacilities');
  const schools = num(record, 'schools');
  const water = num(record, 'waterCoverage');
  const paved = num(record, 'pavedRoads');
  const revenue = num(record, 'revenue');
  const agri = num(record, 'agriProduction');
  const chains = num(record, 'valueChains');
  const associations = num(record, 'associations');
  const goods = num(record, 'goodsTons');
  const cost = num(record, 'projectCost');
  const frontLine = num(record, 'frontLine');
  const projectStatus = record.projectStatus;

  const result = {
    waterDeficit: water === null ? null : 100 - water * 100,
    frontLineRisk: frontLine === null ? null : (frontLine === 1 ? 1 : 0),
    revenuePerCapita: ratio(revenue, population),
    roadsDeficit: paved === null ? null : 100 - paved * 100,
    populationPerFacility: ratio(population, facilities),
    schoolsPer10k: population === null || schools === null ? null : (population > 0 ? (schools / population) * 10000 : 0),
    agriPerCapita: population === null || agri === null ? null : (population > 0 ? (agri / population) * 1000 : 0),
    valueChainsScore: chains === null ? null : chains * 1,
    fiscalGap: cost === null || revenue === null ? null : (cost - revenue * 0.1) / 1e9,
    associationsPer10k: population === null || associations === null ? null : (population > 0 ? (associations / population) * 10000 : 0),
    stalledProject: projectStatus === null || projectStatus === undefined ? null : (projectStatus === 'متعثر' ? 1 : 0),
    aidPerCapita: population === null || goods === null ? null : (population > 0 ? (goods * 1000) / population : 0),
  };

  return result;
}

/** Number of indicators that carry a numeric value for this record. */
function availableCount(indicatorValues) {
  return INDICATORS.reduce((count, indicator) => count + (indicatorValues[indicator.code] === null ? 0 : 1), 0);
}

/**
 * Absolute need score on a fixed 0..1 scale.
 *
 * need = (value - good) / (bad - good), clamped.
 * The scale does not depend on the sample, so adding or removing a directorate
 * never changes another directorate's score. That is the fix for the Min–Max
 * instability documented as gap #3 in the audit.
 */
function needScore(code, value) {
  const indicator = INDICATOR_BY_CODE[code];
  if (!indicator) throw new Error(`مؤشر غير معروف: ${code}`);
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return null;
  const { good, bad } = indicator.anchors;
  if (bad === good) return 0.5;
  const raw = (Number(value) - good) / (bad - good);
  return Math.min(1, Math.max(0, raw));
}

function needScores(indicatorValues) {
  const scores = {};
  for (const indicator of INDICATORS) scores[indicator.code] = needScore(indicator.code, indicatorValues[indicator.code]);
  return scores;
}

/**
 * Column BA: the project-type ladder, evaluated in the workbook's exact order.
 * Divergence from Excel is deliberate and narrow: an indicator that exists but
 * cannot be interpreted counts as missing instead of silently becoming zero.
 */
function recommendProjectType(indicatorValues, record, fields = {}) {
  const v = indicatorValues;
  const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);
  const isEmpty = (value) => value === null || value === undefined || value === '';

  if (isEmpty(record.districtName) && isEmpty(fields.districtName)) return { label: '', reason: 'no-name' };
  if (isEmpty(fields.waterCoverage)) return { label: '⏳ بيانات ناقصة: المياه', reason: 'water-missing' };
  if (isNumber(v.waterDeficit) && v.waterDeficit >= 50) return { label: '🚰 مشروع مياه', reason: 'water-crisis' };
  if (isEmpty(fields.frontLine)) return { label: '⏳ بيانات ناقصة: النار', reason: 'frontline-missing' };
  if (v.frontLineRisk === 1) return { label: '🛡️ مشروع إنساني', reason: 'frontline' };
  if (isEmpty(fields.pavedRoads)) return { label: '⏳ بيانات ناقصة: الطرق', reason: 'roads-missing' };
  if (isNumber(v.roadsDeficit) && v.roadsDeficit >= 50) return { label: '🛣️ مشروع طرق', reason: 'roads-crisis' };
  if (isEmpty(fields.population) || isEmpty(fields.govFacilities)) return { label: '⏳ بيانات ناقصة: الصحة', reason: 'health-missing' };
  if (isNumber(v.populationPerFacility) && v.populationPerFacility >= 40000) return { label: '🏥 مشروع صحي', reason: 'health-crisis' };
  if (isEmpty(fields.population) || isEmpty(fields.schools)) return { label: '⏳ بيانات ناقصة: التعليم', reason: 'education-missing' };
  if (isNumber(v.schoolsPer10k) && v.schoolsPer10k < 5) return { label: '🏫 مشروع تعليم', reason: 'education-crisis' };
  if (isEmpty(fields.population) || isEmpty(fields.revenue)) return { label: '⏳ بيانات ناقصة: الإنتاج', reason: 'economy-missing' };
  if (isNumber(v.revenuePerCapita) && v.revenuePerCapita < 3000) return { label: '💼 مشروع إنتاجي', reason: 'economy-crisis' };
  if (isEmpty(fields.projectStatus)) return { label: '⏳ بيانات ناقصة: التعثر', reason: 'stalled-missing' };
  if (v.stalledProject === 1) return { label: '🔧 إعادة تأهيل', reason: 'stalled' };
  return { label: '🔧 مشروع متعدد', reason: 'fallback' };
}

module.exports = {
  computeIndicators,
  availableCount,
  needScore,
  needScores,
  recommendProjectType,
};