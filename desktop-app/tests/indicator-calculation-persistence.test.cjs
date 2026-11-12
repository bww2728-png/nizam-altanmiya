'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const Database = require('better-sqlite3-multiple-ciphers');
const { MIGRATION_VERSION, migrate, needsMigration } = require('../src/main/analysis/store-schema.cjs');
const persist = require('../src/main/analysis/persist.cjs');
const { analyze } = require('../src/main/analysis/engine.cjs');
const security = require('../src/main/security.cjs');

function openDatabase() {
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  migrate(database);
  return database;
}

function addDirectorate(database) {
  return persist.saveManualDirectorate(database, {
    districtName: 'مديرية تتبع',
    governorate: 'إب',
    values: {
      population: '1000',
      waterCoverage: '0.2',
      pavedRoads: '0.4',
      revenue: '10000',
      schools: '10',
      govFacilities: '3',
      agriProduction: '200',
      valueChains: '2',
      projectCost: '100000',
      associations: '4',
      goodsTons: '25',
      frontLine: 'نعم',
      projectStatus: 'متوقف',
    },
  });
}

test('analysis runs persist reproducible indicator results and their canonical source inputs', () => {
  const database = openDatabase();
  try {
    const directorate = addDirectorate(database);
    const analysis = analyze(persist.loadAnalysisRows(database), {});
    const saved = persist.saveRun(database, analysis, { mode: 'both', filter: {} });

    assert.equal(saved.results, 1);
    assert.deepEqual(Object.keys(saved.calculationRunIds).sort(), ['calibrated', 'replica']);
    assert.match(saved.inputSnapshotHash, /^[a-f0-9]{64}$/);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM analysis_runs').get().count, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM indicator_calculation_runs').get().count, 2);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM indicator_calculation_results').get().count, 26);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM analysis_calculation_run_links').get().count, 2);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM analysis_calculation_result_links').get().count, 2);
    assert.ok(database.prepare('SELECT COUNT(*) AS count FROM indicator_result_inputs').get().count > 0);

    const restored = persist.getRun(database, saved.runId);
    assert.equal(restored.results[0].replica.composite, analysis.rows[0].replica.composite);
    assert.equal(restored.results[0].calibrated.composite, analysis.rows[0].calibrated.composite);
    assert.equal(restored.results[0].calculationLineage.calibrated.inputSnapshotHash, saved.inputSnapshotHash);
    assert.equal(restored.results[0].calculationLineage.calibrated.indicators.waterDeficit.rawValue, analysis.rows[0].indicators.waterDeficit);

    const detail = persist.getCalculationDetail(database, saved.runId, directorate.id, 'calibrated');
    assert.equal(detail.calculation.calculationRunId, saved.calculationRunIds.calibrated);
    assert.equal(Object.keys(detail.calculation.indicators).length, 12);
    const sourceInput = detail.calculation.indicators.waterDeficit.inputs[0];
    assert.equal(sourceInput.fieldCode, 'waterCoverage');
    assert.equal(sourceInput.value, 0.2);
    assert.equal(sourceInput.state, 'known');
    assert.ok(sourceInput.sourceId);
    assert.equal(sourceInput.transformation.formula, 'IF(L="", "", 100 - L*100)');
    assert.equal(sourceInput.transformation.formulaVersion, 'V3.3');
    assert.equal(database.pragma('foreign_key_check').length, 0);
  } finally {
    database.close();
  }
});

test('a missing approved canonical record aborts the legacy and canonical run together', () => {
  const database = openDatabase();
  try {
    const analysis = analyze([{
      id: 'unlinked',
      districtName: 'مديرية بلا سجل معياري',
      governorate: 'إب',
      values: { districtName: 'مديرية بلا سجل معياري', governorate: 'إب' },
    }], {});
    assert.throws(() => persist.saveRun(database, analysis, { mode: 'both', filter: {} }), /لا يوجد ربط متوافق/);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM analysis_runs').get().count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM indicator_calculation_runs').get().count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM analysis_results').get().count, 0);
  } finally {
    database.close();
  }
});

test('a v2 installation upgrades calculation lineage transactionally without losing history', () => {
  const database = openDatabase();
  try {
    database.prepare(`INSERT INTO analysis_runs(mode,k_threshold,deprivation_line,row_count,weights_json,created_at)
      VALUES('both',0.5,0.4,0,'{}','2026-01-01T00:00:00.000Z')`).run();
    database.prepare('DELETE FROM store_schema_migrations WHERE version=?').run(MIGRATION_VERSION);
    database.exec('DROP TABLE analysis_calculation_result_links; DROP TABLE analysis_calculation_run_links; DROP TABLE indicator_calculation_schema_migrations;');

    assert.equal(needsMigration(database), true);
    const upgraded = migrate(database);
    assert.equal(upgraded.version, MIGRATION_VERSION);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM analysis_runs').get().count, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM indicator_calculation_schema_migrations WHERE success=1').get().count, 1);
    assert.equal(needsMigration(database), false);
    assert.equal(database.pragma('foreign_key_check').length, 0);
  } finally {
    database.close();
  }
});

test('shared access masks canonical calculation inputs and lineage', () => {
  const payload = {
    results: [{
      indicators: { revenuePerCapita: 12 },
      calculationLineage: { calibrated: { indicators: { revenuePerCapita: { inputs: [{ value: 900 }] } } } },
      calibrated: { composite: 0.5 },
      replica: { composite: 0.4 },
    }],
  };
  const masked = security.maskStoredRun(payload, 'shared');
  assert.deepEqual(masked.results[0].indicators, {});
  assert.equal(masked.results[0].calculationLineage, null);
  assert.equal(masked.results[0].calibrated.composite, null);
  assert.equal(masked.results[0].replica.composite, null);
});
