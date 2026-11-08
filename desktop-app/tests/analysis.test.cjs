'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { computeIndicators, recommendProjectType, needScore } = require('../src/main/analysis/indicators.cjs');
const { replicaComposite, calibratedComposite, defaultWeights, validateWeights } = require('../src/main/analysis/composite.cjs');
const { completeness, confidence } = require('../src/main/analysis/columns.cjs');
const { parseNumber, parseRatio, parseBoolean, parseText, formatFixed, formatPercent } = require('../src/main/analysis/parse.cjs');

/**
 * The three real directorates stored in «القالب المحدث.xlsx»
 * sheet «قاعدة البيانات الشاملة», rows 3, 4 and 5.
 *
 * Every expectation below was read from the workbook's own cached values, so
 * these tests are an equivalence proof, not an opinion.
 */
const records = [
  {
    districtName: 'مديرية الشعر', governorate: 'إب', districtNature: 'جبلية',
    population: 43739, migrants: 13122, densityPerKm2: 377, schools: 40, govFacilities: 11,
    waterCoverage: 0.197, pavedRoads: 0.8, revenue: 75643312, livestockHeads: 17365,
    unemployment: 0.175, associations: 1, povertyRatio: 0.35, ruralPopulation: 40689,
    geographicDispersion: 'جبلية',
  },
  {
    districtName: 'مديرية أزال', governorate: 'أمانة العاصمة', districtNature: 'جبلية',
    population: 304247, densityPerKm2: 20697, schools: 28, enrolledStudents: 27986,
    govFacilities: 6, revenue: 165600286, povertyRatio: 0.34, geographicDispersion: 'جبلية',
  },
  {
    districtName: 'مديرية بيت الفقيه', governorate: 'الحديدة', districtNature: 'ساحلية',
    population: 440970, densityPerKm2: 288, govFacilities: 40, waterCoverage: 0.47,
    revenue: 58364301, associations: 5, vulnerableGroups: 0.35, ruralPopulation: 352776,
    geographicDispersion: 'ساحلية',
  },
];

function analyze(row) {
  const indicators = computeIndicators(row);
  const completenessResult = completeness(row);
  const project = recommendProjectType(indicators, row, row);
  return { row, indicators, completeness: completenessResult, project };
}

test('indicator formulas reproduce the workbook values for row 3 (مديرية الشعر)', () => {
  const indicators = computeIndicators(records[0]);
  assert.equal(indicators.waterDeficit, 80.3);
  assert.equal(indicators.roadsDeficit, 20);
  assert.ok(Math.abs(indicators.revenuePerCapita - 1729.4248153821532) < 1e-9);
  assert.ok(Math.abs(indicators.populationPerFacility - 3976.2727272727275) < 1e-9);
  assert.ok(Math.abs(indicators.schoolsPer10k - 9.145156496490547) < 1e-9);
  assert.ok(Math.abs(indicators.associationsPer10k - 0.22862891241226366) < 1e-12);
  // Indicators whose inputs are empty must stay null, never 0.
  for (const code of ['frontLineRisk', 'agriPerCapita', 'valueChainsScore', 'fiscalGap', 'stalledProject', 'aidPerCapita']) {
    assert.equal(indicators[code], null, `${code} must be null when its inputs are empty`);
  }
});

test('completeness reproduces column BD/BF exactly', () => {
  const [sh, azal, faqih] = records.map((row) => completeness(row));
  assert.equal(sh.ratio, 0.538);
  assert.equal(sh.present, 7);
  assert.equal(sh.missingText, 'زراعة، سلاسل، تكلفة، مساعدات، نار، حالة مشروع');
  assert.equal(sh.waiting, true);

  assert.equal(azal.ratio, 0.308);
  assert.equal(azal.present, 4);
  assert.equal(azal.missingText, 'مياه، طرق، زراعة، سلاسل، تكلفة، جمعيات، مساعدات، نار، حالة مشروع');

  assert.equal(faqih.ratio, 0.385);
  assert.equal(faqih.present, 5);
  assert.equal(faqih.missingText, 'طرق، مدارس، زراعة، سلاسل، تكلفة، مساعدات، نار، حالة مشروع');
});

test('project-type ladder reproduces column BA exactly', () => {
  assert.equal(analyze(records[0]).project.label, '🚰 مشروع مياه');
  assert.equal(analyze(records[1]).project.label, '⏳ بيانات ناقصة: المياه');
  assert.equal(analyze(records[2]).project.label, '🚰 مشروع مياه');
});

test('replica composite reproduces column AZ for all three rows', () => {
  const analysed = records.map(analyze);
  const { results } = replicaComposite(analysed);

  assert.ok(Math.abs(results[0].composite - 0.2) < 1e-12, `row3 AZ=${results[0].composite}`);
  assert.ok(Math.abs(results[1].composite - 0.29646838351672766) < 1e-9, `row4 AZ=${results[1].composite}`);
  assert.ok(Math.abs(results[2].composite - 0.19508183587563138) < 1e-9, `row5 AZ=${results[2].composite}`);

  // The AQ column has a single numeric value, so MAX=MIN -> neutral 0.5.
  assert.equal(results[0].contributions.roadsDeficit.normalized, 0.5);
  // Six empty indicators entered the sum as zero: the documented defect.
  assert.equal(results[0].emptyAsZero, 6);
  assert.equal(results[0].flagged, true);
});

test('confidence text reproduces column BB exactly', () => {
  const analysed = records.map(analyze);
  const { results } = replicaComposite(analysed);

  assert.equal(
    confidence({
      projectType: analysed[0].project.label,
      completeness: analysed[0].completeness,
      indicators: analysed[0].indicators,
      composite: results[0].composite,
    }).text,
    '⚠️ مبدئية | اكتمال 54% | ناقص: زراعة، سلاسل، تكلفة، مساعدات، نار، حالة مشروع | المركب 0.200'
  );

  assert.equal(
    confidence({
      projectType: analysed[1].project.label,
      completeness: analysed[1].completeness,
      indicators: analysed[1].indicators,
      composite: results[1].composite,
    }).text,
    '⛔ محجوبة | ناقص: مياه، طرق، زراعة، سلاسل، تكلفة، جمعيات، مساعدات، نار، حالة مشروع | المركب 0.296'
  );

  assert.equal(
    confidence({
      projectType: analysed[2].project.label,
      completeness: analysed[2].completeness,
      indicators: analysed[2].indicators,
      composite: results[2].composite,
    }).text,
    '⚠️ مبدئية | اكتمال 39% | ناقص: طرق، مدارس، زراعة، سلاسل، تكلفة، مساعدات، نار، حالة مشروع | المركب 0.195'
  );
});

test('calibrated mode blocks judgement instead of inventing a number', () => {
  const analysed = records.map(analyze);
  const { results } = calibratedComposite(analysed);

  // الشعر has 63% of the total weight available: above the 60% gate, so it gets
  // a real calibrated score — and that score is far from the workbook's 0.200.
  assert.ok(!results[0].blocked);
  assert.ok(results[0].composite > 0.3, `calibrated=${results[0].composite}`);
  assert.ok(results[0].weightCoverage > 0.6 && results[0].weightCoverage < 1);

  // أزال (33%) and بيت الفقيه (43%) are below the gate: the honest answer is
  // "not enough evidence", not a composite built out of six zeros.
  assert.equal(results[1].blocked, true);
  assert.equal(results[1].blockReason, 'insufficient-weight-coverage');
  assert.equal(results[1].composite, null);
  assert.equal(results[2].blocked, true);
  assert.equal(results[2].composite, null);
});

test('need score uses fixed anchors and is independent of the sample', () => {
  assert.equal(needScore('waterDeficit', 0), 0);
  assert.equal(needScore('waterDeficit', 100), 1);
  assert.ok(Math.abs(needScore('waterDeficit', 80.3) - 0.803) < 1e-12);
  assert.equal(needScore('revenuePerCapita', 5000), 0);
  assert.equal(needScore('revenuePerCapita', 0), 1);
  assert.equal(needScore('schoolsPer10k', 10), 0);
  assert.equal(needScore('schoolsPer10k', 0), 1);
  // Out-of-range values are clamped, never extrapolated.
  assert.equal(needScore('schoolsPer10k', 25), 0);
  assert.equal(needScore('revenuePerCapita', 99999), 0);
});

test('weights must sum to one', () => {
  assert.equal(validateWeights(defaultWeights()).valid, true);
  const broken = { ...defaultWeights(), waterDeficit: 0.2 };
  const report = validateWeights(broken);
  assert.equal(report.valid, false);
  assert.match(report.errors.join(' '), /مجموع الأوزان/);
});

test('Arabic numbers, separators and percentages parse without losing zeros', () => {
  assert.deepEqual(parseNumber('٠'), { state: 'ok', value: 0, raw: '٠', warnings: [] });
  assert.equal(parseNumber('١٢٣٤٥').value, 12345);
  assert.equal(parseNumber('1,234.5').value, 1234.5);
  assert.equal(parseNumber('١٬٢٣٤').value, 1234);
  assert.equal(parseNumber('3,5').value, 3.5);
  assert.equal(parseNumber('—').state, 'empty');
  assert.equal(parseNumber('غير متوفر').state, 'empty');
  assert.equal(parseNumber('abc').state, 'invalid');
  assert.equal(parseNumber('').state, 'empty');

  // Ratio guard: "19.7" means 19.7%, i.e. 0.197 in the template's units.
  const converted = parseRatio('19.7');
  assert.ok(Math.abs(converted.value - 0.197) < 1e-12);
  assert.equal(converted.warnings[0].code, 'percent-converted');
  assert.ok(Math.abs(parseRatio('0.197').value - 0.197) < 1e-12);
  assert.ok(Math.abs(parseRatio('19.7%').value - 0.197) < 1e-12);
  assert.equal(parseRatio('197').state, 'invalid');

  assert.equal(parseBoolean('نعم').value, 1);
  assert.equal(parseBoolean('لا').value, 0);
  assert.equal(parseBoolean('maybe').state, 'invalid');
  assert.equal(parseText('  مديرية   الشعر ').value, 'مديرية الشعر');

  assert.equal(formatFixed(0.29646838351672766, 3), '0.296');
  assert.equal(formatPercent(0.538), '54%');
  assert.equal(formatPercent(0.385), '39%');
  assert.equal(formatFixed(null, 3), '—');
});

test('a ratio-out-of-range warning is counted once as a single invalid-value blocker', () => {
  const { analyzeGaps } = require('../src/main/analysis/gaps.cjs');
  const record = {
    id: 1,
    districtName: 'مديرية',
    governorate: 'إب',
    values: { districtName: 'مديرية', governorate: 'إب' },
    warnings: [{ key: 'pavedRoads', code: 'ratio-out-of-range', raw: '150', value: null }],
  };

  const { recordIssues, summary } = analyzeGaps([record]);
  const issues = recordIssues.get(record) ?? [];
  const invalid = issues.filter((issue) => issue.code === 'invalid-value');
  assert.equal(invalid.length, 1, 'one ratio-out-of-range warning yields exactly one invalid-value blocker');
  assert.ok(!issues.some((issue) => issue.code === 'missing-mandatory' && issue.field === 'pavedRoads'),
    'an unparsable cell is not reported a second time as missing');
  assert.ok(summary.blocker >= 1);
});

test('an invalid-number warning on a mandatory field replaces its missing-mandatory finding', () => {
  const { analyzeGaps } = require('../src/main/analysis/gaps.cjs');
  const record = {
    id: 1,
    districtName: 'مديرية',
    governorate: 'إب',
    values: { districtName: 'مديرية', governorate: 'إب', /* population deliberately absent */ },
    warnings: [{ key: 'population', code: 'invalid-number', raw: 'كثير', value: null }],
  };

  const { recordIssues } = analyzeGaps([record]);
  const issues = recordIssues.get(record) ?? [];
  assert.equal(issues.filter((issue) => issue.code === 'invalid-value' && issue.field === 'population').length, 1);
  assert.ok(!issues.some((issue) => issue.code === 'missing-mandatory' && issue.field === 'population'),
    'one bad cell yields one finding, not two');
});