'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3-multiple-ciphers');

const storeSchema = require('../src/main/analysis/store-schema.cjs');
const domain = require('../src/main/database/domain-service.cjs');
const registry = require('../src/main/database/domain-registry.cjs');
const developmentModelV2 = require('../src/main/database/unified-development-model-v2.cjs');
const finance = require('../src/main/database/finance-service.cjs');

const NOW = new Date().toISOString();

function freshStore() {
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  storeSchema.migrate(database);
  return database;
}

function seedMoneyParents(database) {
  database.prepare("INSERT INTO periods(period_id,period_code,period_type,calendar_type,label_ar,created_at) VALUES(1,'2026','annual','gregorian','2026',?)").run(NOW);
  database.prepare("INSERT INTO financial_accounts(account_id,account_code,account_name_ar,account_type,created_at,updated_at) VALUES(1,'ACC-1','account','expenditure',?,?)").run(NOW, NOW);
  database.prepare("INSERT INTO budget_headers(budget_id,period_id,budget_code,budget_name,currency_code,created_at,updated_at) VALUES(1,1,'BUD-1','budget one','YER',?,?)").run(NOW, NOW);
  database.prepare("INSERT INTO budget_headers(budget_id,period_id,budget_code,budget_name,currency_code,created_at,updated_at) VALUES(2,1,'BUD-2','budget two','KWD',?,?)").run(NOW, NOW);
  database.prepare("INSERT INTO currencies(currency_code,name_ar,name_en,minor_unit,is_active,created_at) VALUES('KWD','dinar','Kuwaiti Dinar',3,1,?)").run(NOW);
}

function seedBudgetLines(database) {
  const insert = database.prepare(`INSERT INTO budget_lines(budget_line_id,budget_id,account_id,approved_amount,revised_amount,actual_amount,currency_code,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?)`);
  insert.run(1, 1, 1, 1234.56, 1000, 0.05, 'YER', NOW, NOW);
  insert.run(2, 2, 1, 10.005, null, null, 'KWD', NOW, NOW);
  insert.run(3, 2, 1, 7.5, null, null, 'ZZZ', NOW, NOW);
  insert.run(4, 2, 1, 2.25, null, null, '', NOW, NOW);
}

/** Force the v2 money backfill to run again over the current rows. */
function rerunModelV2(database) {
  database.prepare('UPDATE budget_lines SET approved_amount_minor=NULL, revised_amount_minor=NULL, actual_amount_minor=NULL').run();
  database.prepare('DELETE FROM development_model_migrations WHERE version=?').run(2002);
  developmentModelV2.migrate(database);
}

test('the unified registry covers every layer and every dataset is reachable', () => {
  const database = freshStore();
  try {
    const keys = Object.keys(registry.DATASETS);
    assert.equal(keys.length, 45);
    const datasets = domain.listDatasets(database);
    assert.equal(datasets.length, keys.length);
    for (const dataset of datasets) {
      assert.equal(dataset.available, true, `${dataset.key} is not reachable`);
      assert.ok(String(dataset.labelAr).trim().length > 0, `${dataset.key} has no Arabic label`);
    }
    for (const key of ['developmentIssues', 'developmentPlans', 'planPriorities', 'issuePlanLinks']) {
      assert.ok(keys.includes(key), `${key} missing from the registry`);
    }
    const layers = new Set(datasets.map((dataset) => dataset.layer));
    assert.deepEqual([...layers].sort(), ['analysis', 'dictionary', 'finance', 'indicators', 'planning', 'records']);
    assert.equal(datasets.find((dataset) => dataset.key === 'developmentIssues').layer, 'analysis');
    assert.equal(datasets.find((dataset) => dataset.key === 'developmentPlans').layer, 'planning');
  } finally {
    database.close();
  }
});

test('the dataset browser contract keeps its documented shape', () => {
  const database = freshStore();
  try {
    const described = domain.describe(database, 'developmentIssues');
    for (const field of ['key', 'labelAr', 'layer', 'table', 'pk', 'primaryKey', 'autoPk', 'fields', 'missingColumns']) {
      assert.ok(Object.hasOwn(described, field), `describe is missing ${field}`);
    }
    assert.equal(described.key, 'developmentIssues');
    assert.equal(described.autoPk, true);

    const listed = domain.list(database, { dataset: 'developmentIssues', limit: 5, offset: 0 });
    assert.deepEqual(Object.keys(listed).sort(), ['fields', 'labels', 'rows', 'total']);
    assert.ok(Array.isArray(listed.rows));

    const summary = domain.summary(database);
    assert.deepEqual(Object.keys(summary).sort(), ['layers', 'totals']);
    assert.ok(Array.isArray(domain.options(database, 'sector')));
  } finally {
    database.close();
  }
});

test('a missing value is never stored as a zero value', () => {
  const database = freshStore();
  try {
    const fieldDefinitionId = Number(database.prepare('SELECT field_definition_id FROM field_definitions LIMIT 1').get().field_definition_id);
    let signature = 0;
    const insert = database.prepare(`INSERT INTO observations(field_definition_id,value_integer,value_real,value_text,value_state,dimension_signature,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?)`);
    const add = (integer, real, state) => insert.run(fieldDefinitionId, integer, real, null, state, `case-${signature += 1}`, NOW, NOW);

    assert.doesNotThrow(() => add(0, null, 'zero'));
    assert.doesNotThrow(() => add(null, 3.5, 'known'));
    assert.doesNotThrow(() => add(null, null, 'not_collected'));
    assert.doesNotThrow(() => add(null, null, 'not_verified'));

    assert.throws(() => add(5, null, 'zero'), /CHECK/);
    assert.throws(() => add(5, null, 'unknown'), /CHECK/);
    assert.throws(() => add(null, null, 'known'), /CHECK/);
    assert.throws(() => add(1, 2, 'known'), /CHECK/);
    assert.throws(() => add(null, null, 'assumed'), /CHECK/);
  } finally {
    database.close();
  }
});

test('all seven value states are distinct in storage and are named in manual entry', () => {
  const database = freshStore();
  try {
    const fieldDefinitionId = Number(database.prepare('SELECT field_definition_id FROM field_definitions LIMIT 1').get().field_definition_id);
    const states = ['known','zero','not_available','unknown','not_applicable','not_collected','not_verified'];
    const insert = database.prepare(`INSERT INTO observations(field_definition_id,value_integer,value_real,value_text,value_state,dimension_signature,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?)`);
    for (const [index, state] of states.entries()) {
      const number = state === 'known' ? 5 : state === 'zero' ? 0 : null;
      insert.run(fieldDefinitionId, number, null, null, state, `value-state-${index}`, NOW, NOW);
    }
    const storedStates = database.prepare('SELECT value_state FROM observations WHERE dimension_signature LIKE ? ORDER BY observation_id').all('value-state-%').map(row => row.value_state);
    assert.deepEqual(storedStates, states);
    assert.throws(() => insert.run(fieldDefinitionId, null, null, null, 'missing', 'value-state-invalid', NOW, NOW), /CHECK/);

    const renderer = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'pages', 'DataEntry.jsx'), 'utf8');
    for (const state of states) assert.match(renderer, new RegExp(`${state}:`));
  } finally {
    database.close();
  }
});

test('money keeps exact minor units for known, unknown and blank currencies', () => {
  const database = freshStore();
  try {
    seedMoneyParents(database);
    seedBudgetLines(database);
    rerunModelV2(database);

    const rows = database.prepare('SELECT budget_line_id, approved_amount, revised_amount, actual_amount, currency_code, approved_amount_minor, revised_amount_minor, actual_amount_minor FROM budget_lines ORDER BY budget_line_id').all();
    assert.equal(rows[0].approved_amount_minor, 123456);
    assert.equal(rows[0].revised_amount_minor, 100000);
    assert.equal(rows[0].actual_amount_minor, 5);
    assert.equal(rows[1].approved_amount_minor, 10005);
    assert.equal(rows[2].approved_amount_minor, 750);
    assert.equal(rows[3].approved_amount_minor, 225);
    assert.equal(rows[3].currency_code, 'YER');

    assert.equal(rows[0].approved_amount, 1234.56);
    assert.equal(rows[1].approved_amount, 10.005);

    assert.equal(database.pragma('foreign_key_check').length, 0);
    const integrityReport = database.pragma('integrity_check');
    assert.equal(String(Object.values(integrityReport[0])[0]).toLowerCase(), 'ok');
  } finally {
    database.close();
  }
});

test('finance reporting exposes minor-unit aware totals without faking counts as money', () => {
  const database = freshStore();
  try {
    seedMoneyParents(database);
    seedBudgetLines(database);
    rerunModelV2(database);

    const variance = finance.budgetVariance(database, { budgetId: 1 });
    assert.equal(variance.minorUnit, 2);
    assert.deepEqual(Object.keys(variance.totals.formatted).sort(), ['actual', 'approved', 'revised', 'variance']);
    assert.equal(variance.totals.approvedMinor, 123456);
    assert.equal(variance.totals.actualMinor, 5);
    assert.equal(variance.lines.length, 1);

    const control = finance.commitmentControl(database, {});
    assert.ok(Object.hasOwn(control, 'minorUnit'));
    for (const field of ['budget', 'currencyCode', 'lines', 'minorUnit', 'totals', 'excludedLines', 'notes']) {
      assert.ok(Object.hasOwn(variance, field), `budgetVariance is missing ${field}`);
    }
    assert.ok(Object.hasOwn(finance.overview(database), 'totalsByCurrency'));
    assert.ok(Array.isArray(finance.currencySummary(database, {}).currencies));
  } finally {
    database.close();
  }
});

test('every channel the preload exposes has exactly one main-process handler', () => {
  const preload = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'preload.cjs'), 'utf8');
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.cjs'), 'utf8');
  const exposed = [...preload.matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map((match) => match[1]);
  const handled = [...main.matchAll(/ipcMain\.handle\('([^']+)'/g)].map((match) => match[1]);

  assert.ok(exposed.length >= 41, `only ${exposed.length} channels are exposed`);
  assert.equal(new Set(exposed).size, exposed.length, 'a channel is exposed twice');
  assert.equal(new Set(handled).size, handled.length, 'a channel is handled twice');

  const known = new Set(handled);
  const missing = exposed.filter((channel) => !known.has(channel));
  assert.deepEqual(missing, []);
  for (const channel of ['unified:list', 'unified:save', 'development:overview', 'planning:overview', 'finance:overview', 'indicator-catalog:list']) {
    assert.ok(known.has(channel), `${channel} has no handler`);
  }
});