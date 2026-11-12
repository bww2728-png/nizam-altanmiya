'use strict';

// Unified development model v2: additive, idempotent schema hardening.
// No DROP TABLE / DROP COLUMN / row deletion happens here: only new tables,
// new columns, indexes, triggers, guarded backfills and quality evidence.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const migrationIntegrity = require('./migration-integrity.cjs');

const VERSION = 2;
const CODE = 'unified-development-model-v2';
const SQL_FILE = path.join(__dirname, 'unified-development-model-v2.sql');

// v1 already stores its seed-policy migration as version 2 inside
// development_model_migrations, so this migration claims a reserved offset
// version in the same log table (no new log table is introduced).
const LOG_TABLE = 'development_model_migrations';
const LOG_VERSION = 2000 + VERSION;

// Governance columns for the canonical field dictionary (architecture-v1.sql).
const FIELD_DEFINITION_COLUMNS = [
  ['semantic_domain_code', 'TEXT'],
  ['value_min', 'REAL'],
  ['value_max', 'REAL'],
  ['decimal_scale', 'INTEGER'],
  ['is_derived', 'INTEGER NOT NULL DEFAULT 0'],
  ['is_direct_entry', 'INTEGER NOT NULL DEFAULT 1'],
  ['is_required', 'INTEGER NOT NULL DEFAULT 0'],
  ['is_repeatable', 'INTEGER NOT NULL DEFAULT 0'],
  ['is_sensitive', 'INTEGER NOT NULL DEFAULT 0'],
  ['valid_from', 'TEXT'],
  ['valid_to', 'TEXT'],
  ['definition_source', 'TEXT'],
  ['change_reason', 'TEXT'],
  ['specification_version', 'INTEGER NOT NULL DEFAULT 1']
];

// Every monetary column that exists in the v1 DDL. Each one gains an exact
// integer minor-unit mirror; the original REAL column stays authoritative.
// project_beneficiary_targets and indicator_* tables hold no monetary column in
// the v1 DDL, therefore no minor column is invented for them.
const MONEY_COLUMNS = [
  ['budget_lines', ['approved_amount', 'revised_amount', 'actual_amount']],
  ['revenue_transactions', ['assessed_amount', 'collected_amount', 'remitted_amount']],
  ['expenditure_transactions', ['paid_amount']]
];

// Logical uniqueness tuple for measurements (NULL-safe by design).
const OBSERVATION_LOGICAL_EXPRESSIONS = [
  'field_definition_id',
  'IFNULL(geo_unit_id,0)',
  'IFNULL(entity_id,0)',
  'IFNULL(period_id,0)',
  'observation_role',
  'dimension_signature',
  'IFNULL(source_id,0)'
];
const OBSERVATION_INDEX_NAMES = Object.freeze({
  unique: 'idx_observations_logical_unique',
  nonUnique: 'idx_observations_logical',
  source: 'idx_observations_source'
});

const SECTOR_TRIGGER_DDL = `
  CREATE TRIGGER IF NOT EXISTS sector_no_self_parent_insert
  BEFORE INSERT ON sectors
  WHEN NEW.parent_sector_id = NEW.sector_id
  BEGIN
    SELECT RAISE(ABORT,'sector hierarchy cycle');
  END;

  CREATE TRIGGER IF NOT EXISTS sector_no_cycle_update
  BEFORE UPDATE OF parent_sector_id ON sectors
  WHEN NEW.parent_sector_id IS NOT NULL
  BEGIN
    SELECT CASE WHEN NEW.parent_sector_id = NEW.sector_id OR EXISTS(
      WITH RECURSIVE ancestors(id) AS (
        SELECT NEW.parent_sector_id
        UNION ALL
        SELECT sector.parent_sector_id FROM sectors sector
          JOIN ancestors ancestor ON sector.sector_id = ancestor.id
          WHERE sector.parent_sector_id IS NOT NULL
      )
      SELECT 1 FROM ancestors WHERE id = NEW.sector_id
    ) THEN RAISE(ABORT,'sector hierarchy cycle') END;
  END;
`;

function checksums() {
  const definition = {
    CODE,
    FIELD_DEFINITION_COLUMNS,
    MONEY_COLUMNS,
    OBSERVATION_LOGICAL_EXPRESSIONS,
    OBSERVATION_INDEX_NAMES,
    SECTOR_TRIGGER_DDL
  };
  return migrationIntegrity.migrationChecksums({ text: fs.readFileSync(SQL_FILE, 'utf8'), definition: JSON.stringify(definition) });
}
function checksum() {
  return checksums().canonical;
}

function tableExists(db, table) {
  return Boolean(db.prepare("SELECT 1 AS hit FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

function tableColumns(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
}

function requireTable(db, table) {
  if (!tableExists(db, table)) {
    throw new Error(`ترحيل النموذج الموحد v2 يتطلب الجدول ${table}؛ طبّق ترحيل المعمارية أولاً.`);
  }
}

function addFieldDefinitionColumns(db) {
  requireTable(db, 'field_definitions');
  const present = tableColumns(db, 'field_definitions');
  for (const [name, declaration] of FIELD_DEFINITION_COLUMNS) {
    if (present.has(name)) continue;
    db.exec(`ALTER TABLE field_definitions ADD COLUMN ${name} ${declaration}`);
    present.add(name);
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_field_definitions_domain ON field_definitions(semantic_domain_code, field_code)');
}

function minorFactorSql(table, present) {
  // Exact per-row factor from the currency registry; unknown currency falls
  // back to 2 minor digits. CASE keeps the scale integral (no float pow()).
  const lookup = present.has('currency_code')
    ? `(SELECT currency.minor_unit FROM currencies currency WHERE upper(trim(currency.currency_code)) = upper(trim(${table}.currency_code)))`
    : 'NULL';
  return `(CASE coalesce(${lookup},2) WHEN 0 THEN 1 WHEN 1 THEN 10 WHEN 2 THEN 100 WHEN 3 THEN 1000 ELSE 10000 END)`;
}

function addMoneyMinorColumns(db) {
  const added = [];
  for (const [table, columns] of MONEY_COLUMNS) {
    if (!tableExists(db, table)) continue;
    const present = tableColumns(db, table);
    for (const column of columns) {
      if (!present.has(column)) continue;
      const target = `${column}_minor`;
      if (present.has(target)) continue;
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${target} INTEGER CHECK (${target} IS NULL OR ${target} >= 0)`);
      present.add(target);
      added.push(`${table}.${target}`);
    }
  }
  return added;
}

function normaliseBlankCurrencyCodes(db) {
  const normalised = [];
  for (const [table] of MONEY_COLUMNS) {
    if (!tableExists(db, table)) continue;
    if (!tableColumns(db, table).has('currency_code')) continue;
    const result = db.prepare(`UPDATE ${table} SET currency_code='YER' WHERE currency_code IS NULL OR trim(currency_code)=''`).run();
    if (result.changes > 0) normalised.push(`${table}:${result.changes}`);
  }
  return normalised;
}

function backfillMinorUnits(db) {
  const counts = [];
  for (const [table, columns] of MONEY_COLUMNS) {
    if (!tableExists(db, table)) continue;
    const present = tableColumns(db, table);
    const factor = minorFactorSql(table, present);
    for (const column of columns) {
      const target = `${column}_minor`;
      if (!present.has(column) || !present.has(target)) continue;
      db.prepare(`UPDATE ${table}
        SET ${target} = CAST(ROUND(${column} * ${factor}) AS INTEGER)
        WHERE ${target} IS NULL AND ${column} IS NOT NULL`).run();
      const populated = db.prepare(`SELECT COUNT(*) AS total FROM ${table} WHERE ${target} IS NOT NULL`).get().total;
      counts.push(`${table}.${target}=${populated}`);
    }
  }
  return counts;
}

function backfillSemanticDomains(db) {
  // Verified exact match only: field -> subdomain group -> domain group.
  const matchSource = `FROM field_group_fields link
      JOIN field_groups subgroup ON subgroup.group_id = link.group_id AND subgroup.group_level = 'subdomain'
      JOIN field_groups domain ON domain.group_id = subgroup.parent_group_id AND domain.group_level = 'domain'
      WHERE link.field_definition_id = field_definitions.field_definition_id`;
  db.prepare(`UPDATE field_definitions
    SET semantic_domain_code = (SELECT domain.group_code ${matchSource} ORDER BY link.is_primary DESC, link.sort_order, link.group_id LIMIT 1)
    WHERE semantic_domain_code IS NULL
      AND EXISTS (SELECT 1 ${matchSource})`).run();
  const total = db.prepare('SELECT COUNT(*) AS total FROM field_definitions').get().total;
  const matched = db.prepare('SELECT COUNT(*) AS total FROM field_definitions WHERE semantic_domain_code IS NOT NULL').get().total;
  return { total, matched, unmatched: total - matched };
}

function recordQualityIssue(db, options) {
  const { issueCode, severity, description, now } = options;
  const columns = tableColumns(db, 'data_quality_issues');
  // The physical table in existing stores carries the legacy canonical-data
  // shape (message/status NOT NULL) plus architecture compat columns.
  const descriptionColumn = columns.has('issue_description') ? 'issue_description' : 'message';
  const statusColumn = columns.has('quality_status') ? 'quality_status' : 'status';
  const existing = db.prepare(`SELECT 1 AS hit FROM data_quality_issues
    WHERE issue_code=? AND ${descriptionColumn}=? AND ${statusColumn}='open' LIMIT 1`).get(issueCode, description);
  if (existing) return false;
  const targets = ['issue_code', 'severity', descriptionColumn, 'created_at'];
  const values = [issueCode, severity, description, now];
  if (descriptionColumn !== 'message' && columns.has('message')) { targets.push('message'); values.push(description); }
  if (statusColumn !== 'status' && columns.has('status')) { targets.push('status'); values.push('open'); }
  if (columns.has('quality_status')) { targets.push('quality_status'); values.push('open'); }
  if (columns.has('detected_by_rule')) { targets.push('detected_by_rule'); values.push(CODE); }
  db.prepare(`INSERT INTO data_quality_issues(${targets.join(',')}) VALUES(${targets.map(() => '?').join(',')})`).run(...values);
  return true;
}

function detectUnknownCurrencies(db, now) {
  if (!tableExists(db, 'data_quality_issues')) return [];
  const unknown = new Set();
  for (const [table] of MONEY_COLUMNS) {
    if (!tableExists(db, table)) continue;
    if (!tableColumns(db, table).has('currency_code')) continue;
    const rows = db.prepare(`SELECT DISTINCT trim(currency_code) AS currency_code FROM ${table}
      WHERE currency_code IS NOT NULL AND trim(currency_code) <> ''
        AND upper(trim(currency_code)) NOT IN (SELECT upper(currency_code) FROM currencies)`).all();
    for (const row of rows) unknown.add(row.currency_code);
  }
  const recorded = [];
  for (const currencyCode of [...unknown].sort()) {
    const description = `unknown_currency_code: '${currencyCode}' used by money rows but absent from currencies registry`;
    if (recordQualityIssue(db, { issueCode: 'unknown_currency_code', severity: 'high', description, now })) {
      recorded.push(currencyCode);
    }
  }
  return recorded;
}

function detectDuplicateObservations(db, now) {
  const expressions = OBSERVATION_LOGICAL_EXPRESSIONS;
  const groupBy = expressions.join(', ');
  const aliased = expressions
    .map((expression, index) => `${expression} AS tuple_${index}`)
    .join(', ');
  const duplicates = db.prepare(`SELECT ${aliased}, COUNT(*) AS duplicate_count
    FROM observations GROUP BY ${groupBy} HAVING COUNT(*) > 1
    ORDER BY duplicate_count DESC, tuple_0`).all();
  const tupleIndex = OBSERVATION_LOGICAL_EXPRESSIONS.map((_, index) => `tuple_${index}`);  const tupleLabels = [
    'field_definition_id',
    'geo_unit_id',
    'entity_id',
    'period_id',
    'observation_role',
    'dimension_signature',
    'source_id'
  ];
  const recorded = [];
  for (const duplicate of duplicates) {
    const tupleText = tupleLabels
      .map((label, index) => `${label}=${duplicate[tupleIndex[index]] ?? ''}`)
      .join(';');
    const description = `duplicate_observation_key: ${tupleText};duplicate_count=${duplicate.duplicate_count}`;
    if (recordQualityIssue(db, {
      issueCode: 'duplicate_observation_key',
      severity: 'high',
      description,
      now
    })) {
      recorded.push(description);
    }
  }
  return { duplicates, recorded };
}

function ensureObservationIndexes(db, duplicateCount) {
  const tuple = OBSERVATION_LOGICAL_EXPRESSIONS.join(', ');
  if (duplicateCount === 0) {
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ${OBSERVATION_INDEX_NAMES.unique} ON observations(${tuple})`);
  } else {
    db.exec(`CREATE INDEX IF NOT EXISTS ${OBSERVATION_INDEX_NAMES.nonUnique} ON observations(${tuple})`);
  }
  db.exec(`CREATE INDEX IF NOT EXISTS ${OBSERVATION_INDEX_NAMES.source} ON observations(source_id)`);
}

function ensureSectorTriggers(db) {
  // architecture.cjs adds parent_sector_id; skip cleanly when it is absent.
  if (!tableExists(db, 'sectors')) return false;
  if (!tableColumns(db, 'sectors').has('parent_sector_id')) return false;
  db.exec(SECTOR_TRIGGER_DDL);
  return true;
}

function ensureLogTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS ${LOG_TABLE}(version INTEGER PRIMARY KEY,migration_code TEXT NOT NULL UNIQUE,checksum TEXT NOT NULL,applied_at TEXT NOT NULL,success INTEGER NOT NULL CHECK(success IN (0,1)),details TEXT)`);
}

function verifyDatabase(db) {
  const foreignKeys = db.prepare('PRAGMA foreign_key_check').all();
  if (foreignKeys.length) {
    throw new Error(`مخالفة مفاتيح خارجية في ترحيل النموذج الموحد v2: ${JSON.stringify(foreignKeys.slice(0, 8))}`);
  }
  const integrity = db.prepare('PRAGMA integrity_check').all();
  if (!integrity.length || String(Object.values(integrity[0])[0]).toLowerCase() !== 'ok') {
    throw new Error(`فشل فحص سلامة قاعدة البيانات بعد ترحيل النموذج الموحد v2: ${JSON.stringify(integrity.slice(0, 4))}`);
  }
}

function migrate(db) {
  ensureLogTable(db);

  const sourceChecksums = checksums();
  const hash = sourceChecksums.canonical;
  const previous = db.prepare(`SELECT * FROM ${LOG_TABLE} WHERE version=?`).get(LOG_VERSION);
  if (previous?.success === 1) {
    migrationIntegrity.verifyAppliedMigration(db, { table: LOG_TABLE, version: LOG_VERSION, recorded: previous.checksum, checksums: sourceChecksums, label: CODE });
    // Keep late-added compat columns protected even on a re-run.
    if (tableExists(db, 'sectors')) db.transaction(() => ensureSectorTriggers(db)).exclusive();
    return { version: VERSION, alreadyApplied: true };
  }
  if (previous) db.prepare(`DELETE FROM ${LOG_TABLE} WHERE version=? AND success=0`).run(LOG_VERSION);

  const now = new Date().toISOString();
  try {
    let details = '';
    db.transaction(() => {
      db.exec(fs.readFileSync(SQL_FILE, 'utf8'));
      addFieldDefinitionColumns(db);
      const addedMoneyColumns = addMoneyMinorColumns(db);
      const normalised = normaliseBlankCurrencyCodes(db);
      const minorCounts = backfillMinorUnits(db);
      const domains = backfillSemanticDomains(db);
      const unknownCurrencies = detectUnknownCurrencies(db, now);
      const duplicateReport = detectDuplicateObservations(db, now);
      ensureObservationIndexes(db, duplicateReport.duplicates.length);
      const sectorTriggers = ensureSectorTriggers(db);

      verifyDatabase(db);

      details = [
        `أعمدة العملة الدقيقة المضافة: ${addedMoneyColumns.length ? addedMoneyColumns.join(',') : 'لا شيء (موجودة)'}`,
        `تصحيح رموز العملة الفارغة: ${normalised.length ? normalised.join(',') : 'لا شيء'}`,
        `أعمدة الحقول المحسّنة: ${FIELD_DEFINITION_COLUMNS.length}`,
        `تعبئة الفئات النقدية الدقيقة: ${minorCounts.length ? minorCounts.join(',') : 'لا شيء'}`,
        `الدومين الدلالي: مطابق=${domains.matched} غير مطابق=${domains.unmatched} من ${domains.total}`,
        `عملات غير معروفة: ${unknownCurrencies.length ? unknownCurrencies.join(',') : 'لا شيء'}`,
        `مجموعات القياسات المكررة: ${duplicateReport.duplicates.length}`,
        duplicateReport.duplicates.length
          ? `فهرس القياسات غير الفريد: ${OBSERVATION_INDEX_NAMES.nonUnique}`
          : `فهرس القياسات الفريد: ${OBSERVATION_INDEX_NAMES.unique}`,
        `مشغلات هرمية القطاعات: ${sectorTriggers ? 'مفعلة' : 'مؤجلة (عمود parent_sector_id غير موجود)'}`
      ].join(' | ');

      db.prepare(`INSERT OR REPLACE INTO ${LOG_TABLE}(version,migration_code,checksum,applied_at,success,details)
        VALUES(?,?,?,?,1,?)`).run(LOG_VERSION, CODE, hash, now, details.slice(0, 4000));
    }).exclusive();
    return { version: VERSION, alreadyApplied: false, details };
  } catch (error) {
    try {
      db.prepare(`INSERT OR REPLACE INTO ${LOG_TABLE}(version,migration_code,checksum,applied_at,success,details)
        VALUES(?,?,?,?,0,?)`).run(LOG_VERSION, CODE, hash, new Date().toISOString(), String(error.message).slice(0, 4000));
    } catch (logError) {
      throw new Error(`${error.message} | تعذر تسجيل فشل الترحيل: ${logError.message}`);
    }
    throw error;
  }
}

module.exports = {
  migrate,
  checksum,
  VERSION,
  CODE,
  SQL_FILE,
  FIELD_DEFINITION_COLUMNS,
  MONEY_COLUMNS,
  OBSERVATION_LOGICAL_EXPRESSIONS
};
