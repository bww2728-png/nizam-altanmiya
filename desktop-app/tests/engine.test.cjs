'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { analyze } = require('../src/main/analysis/engine.cjs');
const { defaultWeights } = require('../src/main/analysis/composite.cjs');
const { SEVERITY } = require('../src/main/analysis/gaps.cjs');

/** The three real rows of «القالب المحدث.xlsx» again, now through the engine. */
const templateRows = [
  {
    id: 1, districtName: 'مديرية الشعر', governorate: 'إب',
    values: {
      districtName: 'مديرية الشعر', governorate: 'إب', population: 43739, schools: 40, govFacilities: 11,
      waterCoverage: 0.197, pavedRoads: 0.8, revenue: 75643312, associations: 1,
    },
    warnings: [],
  },
  {
    id: 2, districtName: 'مديرية أزال', governorate: 'أمانة العاصمة',
    values: { districtName: 'مديرية أزال', governorate: 'أمانة العاصمة', population: 304247, schools: 28, govFacilities: 6, revenue: 165600286 },
    warnings: [],
  },
  {
    id: 3, districtName: 'مديرية بيت الفقيه', governorate: 'الحديدة',
    values: { districtName: 'مديرية بيت الفقيه', governorate: 'الحديدة', population: 440970, govFacilities: 40, waterCoverage: 0.47, revenue: 58364301, associations: 5 },
    warnings: [],
  },
];

function makeComplete(overrides = {}) {
  const values = {
    population: 100000, waterCoverage: 0.6, pavedRoads: 0.6, revenue: 500000000,
    govFacilities: 10, schools: 30, agriProduction: 300, valueChains: 4,
    projectCost: 2000000000, associations: 2, goodsTons: 50, frontLine: 0,
    projectStatus: 'جاري', ...overrides,
  };
  return {
    id: overrides.id ?? Math.random(),
    districtName: overrides.districtName ?? 'مديرية اختبار',
    governorate: overrides.governorate ?? 'صنعاء',
    values,
    warnings: overrides.warnings ?? [],
  };
}

test('engine reproduces the workbook and reports what it cannot rank', () => {
  const result = analyze(templateRows);

  assert.equal(result.summary.rows, 3);
  assert.equal(result.summary.complete, 0);
  assert.equal(result.summary.waiting, 3);
  assert.equal(result.summary.replicaRanked, 0, 'no row has BD=100%, exactly like the workbook');
  assert.equal(result.summary.calibratedRanked, 1, 'only الشعر passes the 60% weight-coverage gate');

  const shaar = result.rows[0];
  assert.ok(Math.abs(shaar.replica.composite - 0.2) < 1e-12);
  assert.equal(shaar.replica.missingContributedZero, 6);
  assert.equal(shaar.confidence.level, 'preliminary');
  assert.equal(shaar.project.label, '🚰 مشروع مياه');

  const azal = result.rows[1];
  assert.equal(azal.calibrated.blocked, true);
  assert.equal(azal.calibrated.blockReason, 'insufficient-weight-coverage');
  assert.equal(azal.confidence.level, 'blocked');
});

test('engine ranks complete rows and flags severe deprivation before the average', () => {
  const severe = makeComplete({
    districtName: 'مديرية منهارة', population: 500000, waterCoverage: 0.05, pavedRoads: 0.05,
    govFacilities: 2, schools: 2, revenue: 1000, agriProduction: 0, valueChains: 0,
    projectCost: 5000000000, associations: 0, goodsTons: 0, frontLine: 1, projectStatus: 'متعثر',
  });
  const healthy = makeComplete({
    districtName: 'مديرية مكتفية', population: 50000, waterCoverage: 0.95, pavedRoads: 0.95,
    govFacilities: 5, schools: 60, revenue: 500000000, agriProduction: 200, valueChains: 10,
    projectCost: 1000000000, associations: 5, goodsTons: 100, frontLine: 0, projectStatus: 'جاري',
  });
  const middle = makeComplete({ districtName: 'مديرية وسطى' });

  const result = analyze([severe, healthy, middle]);
  assert.equal(result.summary.complete, 3);
  assert.equal(result.summary.calibratedRanked, 3);
  assert.equal(result.summary.replicaRanked, 3);

  const ranked = [...result.rows].sort((a, b) => a.calibrated.rank - b.calibrated.rank);
  assert.equal(ranked[0].districtName, 'مديرية منهارة');
  assert.equal(ranked[0].calibrated.severe, true);
  assert.ok(ranked[0].calibrated.degradedCount >= 4);
  assert.equal(ranked[0].calibrated.tier, 'حرمان حاد');
  assert.equal(ranked.at(-1).districtName, 'مديرية مكتفية');
});

test('gaps separate blockers from warnings', () => {
  const result = analyze(templateRows);
  assert.ok(result.gaps.summary.blocker >= 1);
  assert.ok(result.gaps.summary.byCode['missing-mandatory'] >= 1);
  assert.equal(result.gaps.severityLabels.blocker, SEVERITY.blocker);

  const azalIssues = result.gaps.recordIssues.get(result.rows[1]) ?? [];
  assert.ok(azalIssues.some((item) => item.code === 'missing-mandatory' && item.field === 'waterCoverage'));
});

test('gaps detect contradictory road shares and duplicate districts', () => {
  const contradictory = makeComplete({
    districtName: 'مديرية متناقضة',
    pavedRoads: 0.7, unpavedRoads: 0.5, cutRoads: 0.2,
  });
  const duplicate = makeComplete({ districtName: 'مديرية متناقضة' });

  const result = analyze([contradictory, duplicate]);
  assert.ok(result.gaps.crossIssues.some((item) => item.code === 'duplicate-district'));

  const issues = result.gaps.recordIssues.get(result.rows[0]) ?? [];
  assert.ok(issues.some((item) => item.code === 'roads-shares-exceed'));
});

test('sensitivity reports how far a rank moves when weights shift by 20%', () => {
  const rows = [0.2, 0.4, 0.6, 0.8, 0.95].map((water, index) => makeComplete({
    districtName: `مديرية ${index + 1}`,
    waterCoverage: water,
    population: 60000 + index * 10000,
  }));

  const result = analyze(rows);
  assert.equal(result.sensitivity.weight.fragility.rankedCount, 5);
  assert.ok(result.sensitivity.weight.scenarios.length >= 15);
  assert.equal(result.sensitivity.sample.droppedCount, 5);
  for (const row of result.rows) {
    assert.ok(row.sensitivity);
    assert.ok(row.sensitivity.maxRank >= row.sensitivity.minRank);
  }
});

test('sample sensitivity proves Min–Max instability with a real number', () => {
  const rows = [
    makeComplete({ districtName: 'أ', waterCoverage: 0.3 }),
    makeComplete({ districtName: 'ب', waterCoverage: 0.5 }),
    makeComplete({ districtName: 'ج', waterCoverage: 0.9 }),
  ];
  const result = analyze(rows);
  // Dropping the extreme directorate rescales Min–Max for the others, therefore
  // at least one rank must move. The audit claims instability; here it is measured.
  assert.ok(result.sensitivity.sample.maxShift > 0, 'Min–Max must be sensitive to the sample');
});

test('engine refuses weights that do not sum to one', () => {
  const weights = { ...defaultWeights(), waterDeficit: 0.3 };
  assert.throws(() => analyze(templateRows, { weights }), /أوزان غير صالحة/);
});