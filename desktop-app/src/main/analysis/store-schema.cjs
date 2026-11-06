'use strict';

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
`;

/** Columns added after the first release; applied idempotently on every open. */
const RESULT_COLUMN_MIGRATIONS = [
  { name: 'blocked', ddl: "ALTER TABLE analysis_results ADD COLUMN blocked INTEGER NOT NULL DEFAULT 0" },
  { name: 'block_reason', ddl: 'ALTER TABLE analysis_results ADD COLUMN block_reason TEXT' },
  { name: 'missing_json', ddl: 'ALTER TABLE analysis_results ADD COLUMN missing_json TEXT' },
];

/** Idempotent migration; safe to run on every open. */
function migrate(database) {
  // Schema creation errors are real and must surface unchanged.
  database.exec(SQL);
  const existing = new Set(
    database.prepare('PRAGMA table_info(analysis_results)').all().map((column) => column.name)
  );
  for (const column of RESULT_COLUMN_MIGRATIONS) {
    if (existing.has(column.name)) continue;
    try {
      database.exec(column.ddl);
    } catch (error) {
      // A concurrent runner may have added it first; that is the only benign failure.
      if (/duplicate column name/i.test(String(error.message))) continue;
      throw new Error(`فشل ترحيل العمود ${column.name} في analysis_results: ${error.message}`);
    }
  }
  return true;
}

module.exports = { migrate, DIRECTORATE_COLUMNS, SCHEMA_SQL: SQL, RESULT_COLUMN_MIGRATIONS };