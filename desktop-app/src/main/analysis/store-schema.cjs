'use strict';

const canonicalData = require('./canonical-data.cjs');
const dataArchitecture = require('../database/architecture.cjs');

/**
 * Database schema for the analysis layer.
 *
 * The user's requirement was explicit: the database must follow the *input*
 * columns of «قاعدة البيانات الشاملة» in «القالب المحدث». So `directorates`
 * carries one typed column per template input (A..AM) plus the decision column
 * (BC), and a child table keeps per-value provenance so the audit trail the
 * application promises is not lost when values move from text to numbers.
 */

/** canonical field key -> database column */
const DIRECTORATE_COLUMNS = {
  districtName: 'district',
  districtNature: 'nature',
  population: 'population',
  migrants: 'migrants',
  governorate: 'governorate',
  densityPerKm2: 'density_per_km2',
  expectedBeneficiaries: 'expected_beneficiaries',
  schools: 'schools',
  enrolledStudents: 'enrolled_students',
  govFacilities: 'gov_facilities',
  privateFacilities: 'private_facilities',
  waterCoverage: 'water_coverage',
  pavedRoads: 'paved_roads',
  unpavedRoads: 'unpaved_roads',
  cutRoads: 'cut_roads',
  serviceDistanceKm: 'service_distance_km',
  revenue: 'revenue',
  agriProduction: 'agri_production',
  livestockHeads: 'livestock_heads',
  valueChains: 'value_chains',
  inactiveValueChains: 'inactive_value_chains',
  unemployment: 'unemployment',
  lostOpportunityType: 'lost_opportunity',
  associations: 'associations',
  goodsTons: 'goods_tons',
  frontLine: 'front_line',
  povertyRatio: 'poverty_ratio',
  vulnerableGroups: 'vulnerable_groups',
  serviceGapType: 'service_gap_type',
  ruralPopulation: 'rural_population',
  geographicDispersion: 'geographic_dispersion',
  projectCost: 'project_cost',
  projectStatus: 'project_status',
  partnerIntegration: 'partner_integration',
  communityParticipation: 'community_participation',
  sustainabilityCriteria: 'sustainability_criteria',
  projectContinuity: 'project_continuity',
  needAlignment: 'need_alignment',
  nationalAlignment: 'national_alignment',
  reviewerDecision: 'reviewer_decision',
};

const SQL = `
  CREATE TABLE IF NOT EXISTS directorates (
    id INTEGER PRIMARY KEY,
    governorate TEXT NOT NULL DEFAULT '',
    district TEXT NOT NULL,
    nature TEXT,
    population REAL,
    migrants REAL,
    density_per_km2 REAL,
    expected_beneficiaries REAL,
    schools REAL,
    enrolled_students REAL,
    gov_facilities REAL,
    private_facilities REAL,
    water_coverage REAL,
    paved_roads REAL,
    unpaved_roads REAL,
    cut_roads REAL,
    service_distance_km REAL,
    revenue REAL,
    agri_production REAL,
    livestock_heads REAL,
    value_chains REAL,
    inactive_value_chains REAL,
    unemployment REAL,
    lost_opportunity TEXT,
    associations REAL,
    goods_tons REAL,
    front_line INTEGER,
    poverty_ratio REAL,
    vulnerable_groups REAL,
    service_gap_type TEXT,
    rural_population REAL,
    geographic_dispersion TEXT,
    project_cost REAL,
    project_status TEXT,
    partner_integration TEXT,
    community_participation TEXT,
    sustainability_criteria TEXT,
    project_continuity TEXT,
    need_alignment TEXT,
    national_alignment TEXT,
    reviewer_decision TEXT,
    source_file TEXT,
    source_sheet TEXT,
    source_row INTEGER,
    updated_at TEXT NOT NULL,
    UNIQUE(governorate, district)
  );
  CREATE INDEX IF NOT EXISTS directorates_name_idx ON directorates(district);
  CREATE INDEX IF NOT EXISTS directorates_gov_idx ON directorates(governorate);

  CREATE TABLE IF NOT EXISTS directorate_sources (
    id INTEGER PRIMARY KEY,
    directorate_id INTEGER NOT NULL REFERENCES directorates(id) ON DELETE CASCADE,
    field_key TEXT NOT NULL,
    value_text TEXT,
    source_file TEXT,
    source_location TEXT,
    data_value_id INTEGER,
    captured_at TEXT NOT NULL,
    UNIQUE(directorate_id, field_key)
  );

  CREATE TABLE IF NOT EXISTS field_map (
    id INTEGER PRIMARY KEY,
    source_label TEXT NOT NULL,
    normalized TEXT NOT NULL UNIQUE,
    field_key TEXT NOT NULL,
    method TEXT,
    confidence REAL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS analysis_weights (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL DEFAULT 'default',
    weights_json TEXT NOT NULL,
    note TEXT,
    created_at TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS analysis_runs (
    id INTEGER PRIMARY KEY,
    mode TEXT NOT NULL,
    weights_json TEXT NOT NULL,
    k_threshold INTEGER,
    deprivation_line REAL,
    row_count INTEGER NOT NULL DEFAULT 0,
    summary_json TEXT,
    template_file TEXT,
    template_sheet TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS analysis_results (
    id INTEGER PRIMARY KEY,
    run_id INTEGER NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
    directorate_id INTEGER,
    district TEXT NOT NULL,
    governorate TEXT,
    indicators_json TEXT NOT NULL,
    completeness REAL,
    replica_composite REAL,
    replica_rank INTEGER,
    calibrated_composite REAL,
    calibrated_rank INTEGER,
    degraded_count INTEGER,
    severe INTEGER NOT NULL DEFAULT 0,
    blocked INTEGER NOT NULL DEFAULT 0,
    block_reason TEXT,
    weight_coverage REAL,
    missing_json TEXT,
    sensitivity_json TEXT,
    project_type TEXT,
    confidence_text TEXT,
    confidence_level TEXT,
    gaps_json TEXT
  );
  CREATE INDEX IF NOT EXISTS analysis_results_run_idx ON analysis_results(run_id, calibrated_rank);

  CREATE TABLE IF NOT EXISTS access_log (
    id INTEGER PRIMARY KEY,
    action TEXT NOT NULL,
    entity TEXT,
    entity_id TEXT,
    fields TEXT,
    detail TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS access_log_time_idx ON access_log(created_at);

  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at TEXT NOT NULL
  );

  /*
   * Read-level audit trail.
   *
   * The access_log table only records writes and exports; the audit requirement is that
   * *reads* of restricted/sensitive values are attributable too. This table is
   * append-only by convention: nothing in the application updates or deletes a
   * row, and each row stores the channel, the entity, the field keys that were
   * actually returned and the session that asked for them.
   */
  CREATE TABLE IF NOT EXISTS audit_reads (
    id INTEGER PRIMARY KEY,
    session_id TEXT,
    channel TEXT NOT NULL,
    entity TEXT,
    entity_id TEXT,
    fields TEXT,
    result TEXT NOT NULL DEFAULT 'ok',
    row_count INTEGER,
    detail TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS audit_reads_time_idx ON audit_reads(created_at);

  /*
   * Point-in-time snapshots of a directorate, written *before* an update or a
   * delete. This is what makes undo possible without a second copy of the whole
   * database; the newest snapshot per directorate is enough to restore it.
   */
  CREATE TABLE IF NOT EXISTS directorate_versions (
    id INTEGER PRIMARY KEY,
    directorate_id INTEGER NOT NULL,
    action TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS directorate_versions_dir_idx ON directorate_versions(directorate_id, id);

  /*
   * OCR drafts.
   *
   * Recognition never writes straight into directorates: the raw text and the
   * per-field proposals live here until a human accepts them. Keeping the draft
   * (and its engine confidence) separate is what makes "no silent bad value"
   * enforceable and reviewable after the fact.
   */
  CREATE TABLE IF NOT EXISTS ocr_drafts (
    id INTEGER PRIMARY KEY,
    file_name TEXT,
    file_type TEXT,
    file_size INTEGER,
    text TEXT,
    confidence REAL,
    fields_json TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'draft',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS ocr_field_confidence (
    id INTEGER PRIMARY KEY,
    draft_id INTEGER NOT NULL REFERENCES ocr_drafts(id) ON DELETE CASCADE,
    field_key TEXT NOT NULL,
    header TEXT,
    raw_text TEXT,
    parsed_value TEXT,
    engine_confidence REAL,
    header_score REAL,
    decision TEXT NOT NULL DEFAULT 'pending',
    reviewed_value TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(draft_id, field_key)
  );
  CREATE INDEX IF NOT EXISTS ocr_field_confidence_draft_idx ON ocr_field_confidence(draft_id);
`;

/** Columns added after the first release; applied idempotently on every open. */
const RESULT_COLUMN_MIGRATIONS = [
  { name: 'blocked', ddl: "ALTER TABLE analysis_results ADD COLUMN blocked INTEGER NOT NULL DEFAULT 0" },
  { name: 'block_reason', ddl: 'ALTER TABLE analysis_results ADD COLUMN block_reason TEXT' },
  { name: 'missing_json', ddl: 'ALTER TABLE analysis_results ADD COLUMN missing_json TEXT' },
];

/**
 * Columns added on `directorates` after 0.3.0. `import_warnings` keeps the
 * per-value conversion warnings (percent converted, thousands separated, ...)
 * so the gap layer can see them after a restart instead of losing them with the
 * import response.
 */
const DIRECTORATE_COLUMN_MIGRATIONS = [
  { name: 'import_warnings', ddl: 'ALTER TABLE directorates ADD COLUMN import_warnings TEXT' },
];

/**
 * Indexes that match the queries actually issued by the app. They are created
 * only when the owning table exists, so a partially created store never makes
 * the open path fail.
 */
const EXTRA_INDEXES = [
  { table: 'directorates', ddl: 'CREATE INDEX IF NOT EXISTS directorates_source_idx ON directorates(source_file)' },
  { table: 'review_items', ddl: 'CREATE INDEX IF NOT EXISTS review_items_status_id_idx ON review_items(status, id)' },
  { table: 'data_values', ddl: 'CREATE INDEX IF NOT EXISTS data_values_imported_idx ON data_values(imported_at)' },
];

function tableColumns(database, table) {
  try {
    return new Set(database.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
  } catch {
    return new Set();
  }
}

function tableExists(database, table) {
  return Boolean(database.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function applyColumnMigrations(database, table, migrations) {
  const existing = tableColumns(database, table);
  if (!existing.size) return;
  for (const column of migrations) {
    if (existing.has(column.name)) continue;
    try {
      database.exec(column.ddl);
    } catch (error) {
      // A concurrent runner may have added it first; that is the only benign failure.
      if (/duplicate column name/i.test(String(error.message))) continue;
      throw new Error(`فشل ترحيل العمود ${column.name} في ${table}: ${error.message}`);
    }
  }
}

/** Idempotent migration; safe to run on every open. */
function migrate(database) {
  // Schema creation errors are real and must surface unchanged.
  database.exec(SQL);
  applyColumnMigrations(database, 'analysis_results', RESULT_COLUMN_MIGRATIONS);
  applyColumnMigrations(database, 'directorates', DIRECTORATE_COLUMN_MIGRATIONS);
  // Additive normalized model + raw workbook staging; never drops legacy tables.
  canonicalData.migrateCanonicalData(database);
  dataArchitecture.migrate(database);
  for (const index of EXTRA_INDEXES) {
    if (!tableExists(database, index.table)) continue;
    database.exec(index.ddl);
  }
  return true;
}

module.exports = {
  migrate,
  DIRECTORATE_COLUMNS,
  SCHEMA_SQL: SQL,
  RESULT_COLUMN_MIGRATIONS,
  DIRECTORATE_COLUMN_MIGRATIONS,
  EXTRA_INDEXES,
};