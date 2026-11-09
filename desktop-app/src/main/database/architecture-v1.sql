CREATE TABLE IF NOT EXISTS geo_unit_types (
  geo_unit_type_id INTEGER PRIMARY KEY,
  type_code TEXT NOT NULL UNIQUE,
  name_ar TEXT NOT NULL,
  name_en TEXT,
  parent_type_id INTEGER REFERENCES geo_unit_types(geo_unit_type_id),
  level_order INTEGER NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS geographic_unit_aliases (
  alias_id INTEGER PRIMARY KEY,
  geo_unit_id INTEGER NOT NULL REFERENCES geographic_units(geo_unit_id),
  alias_text TEXT NOT NULL,
  normalized_alias TEXT NOT NULL,
  locale TEXT NOT NULL DEFAULT 'ar',
  alias_type TEXT,
  is_approved INTEGER NOT NULL DEFAULT 0 CHECK(is_approved IN (0,1)),
  source_id INTEGER REFERENCES data_sources(source_id),
  created_at TEXT NOT NULL,
  UNIQUE(geo_unit_id, normalized_alias, locale)
);
CREATE TABLE IF NOT EXISTS periods (
  period_id INTEGER PRIMARY KEY,
  period_code TEXT NOT NULL,
  period_type TEXT NOT NULL,
  calendar_type TEXT NOT NULL,
  label_ar TEXT NOT NULL,
  label_en TEXT,
  year_gregorian INTEGER,
  year_hijri INTEGER,
  month_number INTEGER,
  quarter_number INTEGER,
  start_date TEXT,
  end_date TEXT,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0,1)),
  created_at TEXT NOT NULL,
  CHECK(start_date IS NULL OR end_date IS NULL OR end_date >= start_date),
  UNIQUE(period_code, calendar_type)
);
CREATE TABLE IF NOT EXISTS measurement_units (
  unit_id INTEGER PRIMARY KEY,
  unit_code TEXT NOT NULL UNIQUE,
  name_ar TEXT NOT NULL,
  name_en TEXT,
  symbol TEXT,
  unit_category TEXT NOT NULL,
  base_unit_id INTEGER REFERENCES measurement_units(unit_id),
  conversion_factor REAL,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0,1)),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reference_sets (
  reference_set_id INTEGER PRIMARY KEY,
  set_code TEXT NOT NULL UNIQUE,
  name_ar TEXT NOT NULL,
  name_en TEXT,
  description TEXT,
  is_hierarchical INTEGER NOT NULL DEFAULT 0 CHECK(is_hierarchical IN (0,1)),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reference_values (
  reference_value_id INTEGER PRIMARY KEY,
  reference_set_id INTEGER NOT NULL REFERENCES reference_sets(reference_set_id),
  parent_value_id INTEGER REFERENCES reference_values(reference_value_id),
  value_code TEXT NOT NULL,
  label_ar TEXT NOT NULL,
  label_en TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0,1)),
  valid_from TEXT,
  valid_to TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(reference_set_id, value_code),
  CHECK(valid_from IS NULL OR valid_to IS NULL OR valid_to >= valid_from)
);
CREATE TABLE IF NOT EXISTS dimension_definitions (
  dimension_id INTEGER PRIMARY KEY,
  dimension_code TEXT NOT NULL UNIQUE,
  name_ar TEXT NOT NULL,
  name_en TEXT,
  description TEXT,
  dimension_type TEXT NOT NULL,
  reference_set_id INTEGER REFERENCES reference_sets(reference_set_id),
  is_required INTEGER NOT NULL DEFAULT 0 CHECK(is_required IN (0,1)),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0,1)),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS dimension_values (
  dimension_value_id INTEGER PRIMARY KEY,
  dimension_id INTEGER NOT NULL REFERENCES dimension_definitions(dimension_id),
  parent_value_id INTEGER REFERENCES dimension_values(dimension_value_id),
  value_code TEXT NOT NULL,
  label_ar TEXT NOT NULL,
  label_en TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0,1)),
  created_at TEXT NOT NULL,
  UNIQUE(dimension_id, value_code)
);
CREATE TABLE IF NOT EXISTS form_definitions (
  form_id INTEGER PRIMARY KEY,
  form_code TEXT NOT NULL UNIQUE,
  name_ar TEXT NOT NULL,
  name_en TEXT,
  sector_id INTEGER REFERENCES sectors(sector_id),
  description TEXT,
  data_structure_type TEXT NOT NULL,
  default_geo_level_id INTEGER REFERENCES geo_unit_types(geo_unit_type_id),
  default_period_type TEXT,
  source_workbook_name TEXT,
  source_sheet_name TEXT,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS form_versions (
  form_version_id INTEGER PRIMARY KEY,
  form_id INTEGER NOT NULL REFERENCES form_definitions(form_id),
  version_number INTEGER NOT NULL,
  version_label TEXT,
  status TEXT NOT NULL,
  effective_from TEXT,
  effective_to TEXT,
  definition_hash TEXT NOT NULL,
  change_summary TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  published_at TEXT,
  UNIQUE(form_id, version_number),
  CHECK(effective_from IS NULL OR effective_to IS NULL OR effective_to >= effective_from)
);
CREATE TABLE IF NOT EXISTS form_sections (
  section_id INTEGER PRIMARY KEY,
  form_version_id INTEGER NOT NULL REFERENCES form_versions(form_version_id),
  parent_section_id INTEGER REFERENCES form_sections(section_id),
  section_code TEXT NOT NULL,
  name_ar TEXT NOT NULL,
  name_en TEXT,
  section_type TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_repeatable INTEGER NOT NULL DEFAULT 0 CHECK(is_repeatable IN (0,1)),
  is_required INTEGER NOT NULL DEFAULT 0 CHECK(is_required IN (0,1)),
  source_header_rows_json TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(form_version_id, section_code)
);
CREATE TABLE IF NOT EXISTS field_definitions (
  field_definition_id INTEGER PRIMARY KEY,
  field_code TEXT NOT NULL UNIQUE,
  canonical_name_ar TEXT NOT NULL,
  canonical_name_en TEXT,
  description TEXT,
  semantic_type TEXT NOT NULL,
  data_type TEXT NOT NULL CHECK(data_type IN ('text','long_text','integer','decimal','boolean','date','datetime','reference','entity_reference')),
  default_unit_id INTEGER REFERENCES measurement_units(unit_id),
  default_dimension_id INTEGER REFERENCES dimension_definitions(dimension_id),
  reference_set_id INTEGER REFERENCES reference_sets(reference_set_id),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS form_fields (
  form_field_id INTEGER PRIMARY KEY,
  form_version_id INTEGER NOT NULL REFERENCES form_versions(form_version_id),
  section_id INTEGER REFERENCES form_sections(section_id),
  field_definition_id INTEGER REFERENCES field_definitions(field_definition_id),
  field_code TEXT NOT NULL,
  source_column_index INTEGER,
  source_column_letter TEXT,
  source_header_text TEXT,
  header_path_json TEXT,
  label_ar TEXT NOT NULL,
  label_en TEXT,
  data_type_override TEXT,
  storage_class TEXT NOT NULL CHECK(storage_class IN ('record_value','measurement','entity_link','dimension','narrative','reference_value','ignored_derived')),
  axis_role TEXT NOT NULL DEFAULT 'column',
  is_required INTEGER NOT NULL DEFAULT 0 CHECK(is_required IN (0,1)),
  allow_null INTEGER NOT NULL DEFAULT 1 CHECK(allow_null IN (0,1)),
  is_repeatable INTEGER NOT NULL DEFAULT 0 CHECK(is_repeatable IN (0,1)),
  is_derived INTEGER NOT NULL DEFAULT 0 CHECK(is_derived IN (0,1)),
  is_importable INTEGER NOT NULL DEFAULT 1 CHECK(is_importable IN (0,1)),
  min_value REAL,
  max_value REAL,
  decimal_precision INTEGER,
  unit_id INTEGER REFERENCES measurement_units(unit_id),
  reference_set_id INTEGER REFERENCES reference_sets(reference_set_id),
  validation_rules_json TEXT,
  default_value TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE(form_version_id, field_code),
  CHECK(min_value IS NULL OR max_value IS NULL OR max_value >= min_value)
);
CREATE TABLE IF NOT EXISTS form_field_aliases (
  field_alias_id INTEGER PRIMARY KEY,
  form_field_id INTEGER NOT NULL REFERENCES form_fields(form_field_id),
  alias_text TEXT NOT NULL,
  normalized_alias TEXT NOT NULL,
  locale TEXT NOT NULL DEFAULT 'ar',
  match_method TEXT,
  confidence REAL CHECK(confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  is_approved INTEGER NOT NULL DEFAULT 0 CHECK(is_approved IN (0,1)),
  created_at TEXT NOT NULL,
  UNIQUE(form_field_id, normalized_alias, locale)
);
CREATE TABLE IF NOT EXISTS form_row_definitions (
  row_definition_id INTEGER PRIMARY KEY,
  form_version_id INTEGER NOT NULL REFERENCES form_versions(form_version_id),
  section_id INTEGER REFERENCES form_sections(section_id),
  parent_row_id INTEGER REFERENCES form_row_definitions(row_definition_id),
  row_code TEXT NOT NULL,
  source_row_index INTEGER,
  label_ar TEXT NOT NULL,
  row_type TEXT NOT NULL,
  dimension_id INTEGER REFERENCES dimension_definitions(dimension_id),
  dimension_value_id INTEGER REFERENCES dimension_values(dimension_value_id),
  is_total_row INTEGER NOT NULL DEFAULT 0 CHECK(is_total_row IN (0,1)),
  is_formula_row INTEGER NOT NULL DEFAULT 0 CHECK(is_formula_row IN (0,1)),
  is_input_row INTEGER NOT NULL DEFAULT 1 CHECK(is_input_row IN (0,1)),
  sort_order INTEGER NOT NULL DEFAULT 0,
  UNIQUE(form_version_id, row_code)
);
CREATE TABLE IF NOT EXISTS entity_types (
  entity_type_id INTEGER PRIMARY KEY,
  entity_type_code TEXT NOT NULL UNIQUE,
  name_ar TEXT NOT NULL,
  name_en TEXT,
  description TEXT,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0,1)),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS entities (
  entity_id INTEGER PRIMARY KEY,
  entity_type_id INTEGER NOT NULL REFERENCES entity_types(entity_type_id),
  geo_unit_id INTEGER REFERENCES geographic_units(geo_unit_id),
  canonical_code TEXT,
  name_ar TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  name_en TEXT,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  valid_from TEXT,
  valid_to TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK(valid_from IS NULL OR valid_to IS NULL OR valid_to >= valid_from)
);
CREATE TABLE IF NOT EXISTS entity_identifiers (
  entity_identifier_id INTEGER PRIMARY KEY,
  entity_id INTEGER NOT NULL REFERENCES entities(entity_id),
  identifier_type TEXT NOT NULL,
  identifier_value TEXT NOT NULL,
  issuing_authority TEXT,
  valid_from TEXT,
  valid_to TEXT,
  source_id INTEGER REFERENCES data_sources(source_id),
  created_at TEXT NOT NULL,
  UNIQUE(entity_id, identifier_type, identifier_value)
);
CREATE TABLE IF NOT EXISTS entity_relationships (
  relationship_id INTEGER PRIMARY KEY,
  from_entity_id INTEGER NOT NULL REFERENCES entities(entity_id),
  to_entity_id INTEGER NOT NULL REFERENCES entities(entity_id),
  relationship_type TEXT NOT NULL,
  valid_from TEXT,
  valid_to TEXT,
  source_id INTEGER REFERENCES data_sources(source_id),
  notes TEXT,
  created_at TEXT NOT NULL,
  CHECK(from_entity_id <> to_entity_id)
);
CREATE TABLE IF NOT EXISTS schools (
  entity_id INTEGER PRIMARY KEY REFERENCES entities(entity_id),
  school_code TEXT,
  school_type_id INTEGER REFERENCES reference_values(reference_value_id),
  gender_mode_id INTEGER REFERENCES reference_values(reference_value_id),
  education_level_id INTEGER REFERENCES reference_values(reference_value_id),
  ownership_type_id INTEGER REFERENCES reference_values(reference_value_id),
  building_type_id INTEGER REFERENCES reference_values(reference_value_id),
  building_condition_id INTEGER REFERENCES reference_values(reference_value_id),
  established_date TEXT,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS health_facilities (
  entity_id INTEGER PRIMARY KEY REFERENCES entities(entity_id),
  facility_code TEXT,
  facility_type_id INTEGER REFERENCES reference_values(reference_value_id),
  ownership_type_id INTEGER REFERENCES reference_values(reference_value_id),
  service_level_id INTEGER REFERENCES reference_values(reference_value_id),
  established_date TEXT,
  operational_status_id INTEGER REFERENCES reference_values(reference_value_id),
  bed_capacity INTEGER CHECK(bed_capacity IS NULL OR bed_capacity >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS water_assets (
  entity_id INTEGER PRIMARY KEY REFERENCES entities(entity_id),
  asset_code TEXT,
  asset_type_id INTEGER REFERENCES reference_values(reference_value_id),
  ownership_type_id INTEGER REFERENCES reference_values(reference_value_id),
  capacity_value REAL CHECK(capacity_value IS NULL OR capacity_value >= 0),
  capacity_unit_id INTEGER REFERENCES measurement_units(unit_id),
  operational_status_id INTEGER REFERENCES reference_values(reference_value_id),
  established_date TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS road_segments (
  road_segment_id INTEGER PRIMARY KEY,
  entity_id INTEGER REFERENCES entities(entity_id),
  road_code TEXT,
  start_geo_unit_id INTEGER REFERENCES geographic_units(geo_unit_id),
  end_geo_unit_id INTEGER REFERENCES geographic_units(geo_unit_id),
  surface_type_id INTEGER REFERENCES reference_values(reference_value_id),
  road_class_id INTEGER REFERENCES reference_values(reference_value_id),
  condition_id INTEGER REFERENCES reference_values(reference_value_id),
  length_km REAL CHECK(length_km IS NULL OR length_km >= 0),
  beneficiary_population INTEGER CHECK(beneficiary_population IS NULL OR beneficiary_population >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS organizations (
  entity_id INTEGER PRIMARY KEY REFERENCES entities(entity_id),
  organization_type_id INTEGER REFERENCES reference_values(reference_value_id),
  registration_code TEXT,
  established_date TEXT,
  legal_status_id INTEGER REFERENCES reference_values(reference_value_id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS import_batches (
  batch_id INTEGER PRIMARY KEY,
  batch_uuid TEXT NOT NULL UNIQUE,
  source_id INTEGER NOT NULL REFERENCES data_sources(source_id),
  batch_status TEXT NOT NULL CHECK(batch_status IN ('uploaded','extracting','extracted','mapping','validating','ready_for_review','partially_approved','approved','rejected','failed','cancelled')),
  parser_version TEXT,
  mapping_version TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  total_sheets INTEGER NOT NULL DEFAULT 0,
  total_regions INTEGER NOT NULL DEFAULT 0,
  total_rows INTEGER NOT NULL DEFAULT 0,
  accepted_rows INTEGER NOT NULL DEFAULT 0,
  rejected_rows INTEGER NOT NULL DEFAULT 0,
  warning_rows INTEGER NOT NULL DEFAULT 0,
  blocked_rows INTEGER NOT NULL DEFAULT 0,
  idempotency_key TEXT UNIQUE,
  failure_reason TEXT,
  metadata_json TEXT
);
CREATE TABLE IF NOT EXISTS form_records (
  form_record_id INTEGER PRIMARY KEY,
  form_version_id INTEGER NOT NULL REFERENCES form_versions(form_version_id),
  parent_record_id INTEGER REFERENCES form_records(form_record_id),
  entity_id INTEGER REFERENCES entities(entity_id),
  geo_unit_id INTEGER REFERENCES geographic_units(geo_unit_id),
  period_id INTEGER REFERENCES periods(period_id),
  record_code TEXT,
  record_key TEXT,
  record_label TEXT,
  record_status TEXT NOT NULL DEFAULT 'draft' CHECK(record_status IN ('draft','pending_review','approved','rejected','superseded','archived')),
  revision_number INTEGER NOT NULL DEFAULT 1,
  source_batch_id INTEGER REFERENCES import_batches(batch_id),
  source_import_row_id INTEGER,
  notes TEXT,
  created_by TEXT,
  submitted_by TEXT,
  reviewed_by TEXT,
  approved_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  submitted_at TEXT,
  approved_at TEXT,
  supersedes_record_id INTEGER REFERENCES form_records(form_record_id)
);
CREATE TABLE IF NOT EXISTS import_sheets (
  import_sheet_id INTEGER PRIMARY KEY,
  batch_id INTEGER NOT NULL REFERENCES import_batches(batch_id),
  sheet_index INTEGER NOT NULL,
  sheet_name TEXT NOT NULL,
  sheet_state TEXT NOT NULL,
  max_row INTEGER,
  max_column INTEGER,
  is_hidden INTEGER NOT NULL DEFAULT 0 CHECK(is_hidden IN (0,1)),
  merged_ranges_json TEXT,
  header_rows_json TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(batch_id, sheet_index)
);
CREATE TABLE IF NOT EXISTS import_regions (
  import_region_id INTEGER PRIMARY KEY,
  import_sheet_id INTEGER NOT NULL REFERENCES import_sheets(import_sheet_id),
  region_code TEXT NOT NULL,
  start_row INTEGER NOT NULL,
  start_column INTEGER NOT NULL,
  end_row INTEGER NOT NULL,
  end_column INTEGER NOT NULL,
  header_start_row INTEGER,
  header_end_row INTEGER,
  form_version_id INTEGER REFERENCES form_versions(form_version_id),
  match_status TEXT NOT NULL DEFAULT 'unmatched',
  match_confidence REAL CHECK(match_confidence IS NULL OR (match_confidence >= 0 AND match_confidence <= 1)),
  created_at TEXT NOT NULL,
  CHECK(start_row > 0 AND start_column > 0 AND end_row >= start_row AND end_column >= start_column)
);
CREATE TABLE IF NOT EXISTS import_rows (
  import_row_id INTEGER PRIMARY KEY,
  import_region_id INTEGER NOT NULL REFERENCES import_regions(import_region_id),
  source_row_number INTEGER NOT NULL,
  row_fingerprint TEXT,
  row_status TEXT NOT NULL DEFAULT 'unprocessed',
  is_hidden INTEGER NOT NULL DEFAULT 0 CHECK(is_hidden IN (0,1)),
  has_formula INTEGER NOT NULL DEFAULT 0 CHECK(has_formula IN (0,1)),
  is_truncated INTEGER NOT NULL DEFAULT 0 CHECK(is_truncated IN (0,1)),
  created_at TEXT NOT NULL,
  UNIQUE(import_region_id, source_row_number)
);
CREATE TABLE IF NOT EXISTS import_cells (
  import_cell_id INTEGER PRIMARY KEY,
  import_row_id INTEGER NOT NULL REFERENCES import_rows(import_row_id),
  column_index INTEGER NOT NULL,
  column_letter TEXT,
  cell_address TEXT NOT NULL,
  source_header_text TEXT,
  raw_value_text TEXT,
  raw_value_type TEXT,
  formula_text TEXT,
  cached_value_text TEXT,
  number_format TEXT,
  is_merged INTEGER NOT NULL DEFAULT 0 CHECK(is_merged IN (0,1)),
  merged_range TEXT,
  is_hidden_column INTEGER NOT NULL DEFAULT 0 CHECK(is_hidden_column IN (0,1)),
  created_at TEXT NOT NULL,
  UNIQUE(import_row_id, column_index)
);
CREATE TABLE IF NOT EXISTS import_field_mappings (
  mapping_id INTEGER PRIMARY KEY,
  import_region_id INTEGER NOT NULL REFERENCES import_regions(import_region_id),
  source_column_index INTEGER NOT NULL,
  source_header_text TEXT,
  normalized_source_header TEXT,
  form_field_id INTEGER REFERENCES form_fields(form_field_id),
  mapping_method TEXT NOT NULL,
  confidence REAL CHECK(confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  mapping_status TEXT NOT NULL,
  decided_by TEXT,
  decided_at TEXT,
  mapping_profile_code TEXT,
  target_entity_type TEXT,
  target_field_code TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(import_region_id, source_column_index)
);
CREATE TABLE IF NOT EXISTS import_validation_issues (
  validation_issue_id INTEGER PRIMARY KEY,
  batch_id INTEGER NOT NULL REFERENCES import_batches(batch_id),
  import_row_id INTEGER REFERENCES import_rows(import_row_id),
  import_cell_id INTEGER REFERENCES import_cells(import_cell_id),
  form_field_id INTEGER REFERENCES form_fields(form_field_id),
  issue_code TEXT NOT NULL,
  severity TEXT NOT NULL,
  message_ar TEXT NOT NULL,
  raw_value TEXT,
  normalized_value TEXT,
  is_resolved INTEGER NOT NULL DEFAULT 0 CHECK(is_resolved IN (0,1)),
  resolution_note TEXT,
  resolved_by TEXT,
  resolved_at TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS import_row_decisions (
  row_decision_id INTEGER PRIMARY KEY,
  import_row_id INTEGER NOT NULL REFERENCES import_rows(import_row_id),
  decision TEXT NOT NULL,
  decision_reason TEXT,
  decided_by TEXT,
  decided_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS import_promotions (
  promotion_id INTEGER PRIMARY KEY,
  import_row_id INTEGER NOT NULL REFERENCES import_rows(import_row_id),
  form_record_id INTEGER NOT NULL REFERENCES form_records(form_record_id),
  promoted_by TEXT,
  promoted_at TEXT NOT NULL,
  promotion_status TEXT NOT NULL,
  notes TEXT,
  UNIQUE(import_row_id, form_record_id)
);
CREATE TABLE IF NOT EXISTS normalized_import_promotions (
  normalized_promotion_id INTEGER PRIMARY KEY,
  import_row_id INTEGER NOT NULL REFERENCES import_rows(import_row_id),
  target_entity_type TEXT NOT NULL,
  target_entity_id INTEGER NOT NULL,
  form_record_id INTEGER REFERENCES form_records(form_record_id),
  source_location TEXT,
  mapping_json TEXT NOT NULL,
  mapped_values_json TEXT NOT NULL,
  promotion_status TEXT NOT NULL,
  promoted_by TEXT,
  promoted_at TEXT NOT NULL,
  UNIQUE(import_row_id,target_entity_type)
);
CREATE TABLE IF NOT EXISTS import_profiles (
  import_profile_id INTEGER PRIMARY KEY,
  profile_code TEXT NOT NULL UNIQUE,
  profile_name TEXT NOT NULL,
  form_version_id INTEGER REFERENCES form_versions(form_version_id),
  source_signature TEXT,
  mapping_rules_json TEXT NOT NULL,
  profile_version INTEGER NOT NULL DEFAULT 1,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0,1)),
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS record_field_values (
  record_field_value_id INTEGER PRIMARY KEY,
  form_record_id INTEGER NOT NULL REFERENCES form_records(form_record_id),
  form_field_id INTEGER NOT NULL REFERENCES form_fields(form_field_id),
  item_ordinal INTEGER NOT NULL DEFAULT 1,
  value_text TEXT,
  value_boolean INTEGER CHECK(value_boolean IS NULL OR value_boolean IN (0,1)),
  value_date TEXT,
  value_reference_id INTEGER REFERENCES reference_values(reference_value_id),
  value_entity_id INTEGER REFERENCES entities(entity_id),
  value_state TEXT NOT NULL DEFAULT 'known' CHECK(value_state IN ('known','zero','not_available','unknown','not_applicable','not_collected','not_verified')),
  raw_value_text TEXT,
  normalized_value_text TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(form_record_id, form_field_id, item_ordinal),
  CHECK(value_state NOT IN ('not_available','unknown','not_applicable','not_collected','not_verified') OR (value_text IS NULL AND value_boolean IS NULL AND value_date IS NULL AND value_reference_id IS NULL AND value_entity_id IS NULL)),
  CHECK(value_state NOT IN ('known','zero') OR ((value_text IS NOT NULL)+(value_boolean IS NOT NULL)+(value_date IS NOT NULL)+(value_reference_id IS NOT NULL)+(value_entity_id IS NOT NULL)=1))
);
CREATE TABLE IF NOT EXISTS observations (
  observation_id INTEGER PRIMARY KEY,
  form_record_id INTEGER REFERENCES form_records(form_record_id),
  form_field_id INTEGER REFERENCES form_fields(form_field_id),
  field_definition_id INTEGER NOT NULL REFERENCES field_definitions(field_definition_id),
  geo_unit_id INTEGER REFERENCES geographic_units(geo_unit_id),
  entity_id INTEGER REFERENCES entities(entity_id),
  sector_id INTEGER REFERENCES sectors(sector_id),
  period_id INTEGER REFERENCES periods(period_id),
  unit_id INTEGER REFERENCES measurement_units(unit_id),
  value_integer INTEGER,
  value_real REAL,
  value_text TEXT,
  value_state TEXT NOT NULL DEFAULT 'known' CHECK(value_state IN ('known','zero','not_available','unknown','not_applicable','not_collected','not_verified')),
  observation_role TEXT NOT NULL DEFAULT 'observed',
  quality_status TEXT NOT NULL DEFAULT 'unverified',
  dimension_signature TEXT NOT NULL DEFAULT '',
  source_id INTEGER REFERENCES data_sources(source_id),
  notes TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK(value_state NOT IN ('known','zero') OR ((value_integer IS NOT NULL)+(value_real IS NOT NULL)+(value_text IS NOT NULL)=1)),
  CHECK(value_state NOT IN ('not_available','unknown','not_applicable','not_collected','not_verified') OR (value_integer IS NULL AND value_real IS NULL AND value_text IS NULL)),
  CHECK(value_state <> 'zero' OR coalesce(value_integer, value_real) = 0)
);
CREATE TABLE IF NOT EXISTS observation_dimensions (
  observation_dimension_id INTEGER PRIMARY KEY,
  observation_id INTEGER NOT NULL REFERENCES observations(observation_id),
  dimension_id INTEGER NOT NULL REFERENCES dimension_definitions(dimension_id),
  dimension_value_id INTEGER NOT NULL REFERENCES dimension_values(dimension_value_id),
  created_at TEXT NOT NULL,
  UNIQUE(observation_id, dimension_id)
);
CREATE TABLE IF NOT EXISTS value_provenance (
  provenance_id INTEGER PRIMARY KEY,
  record_field_value_id INTEGER REFERENCES record_field_values(record_field_value_id),
  observation_id INTEGER REFERENCES observations(observation_id),
  source_id INTEGER NOT NULL REFERENCES data_sources(source_id),
  import_row_id INTEGER REFERENCES import_rows(import_row_id),
  import_cell_id INTEGER REFERENCES import_cells(import_cell_id),
  provenance_type TEXT NOT NULL,
  original_value_text TEXT,
  normalized_value_text TEXT,
  transform_rule_code TEXT,
  transform_rule_version TEXT,
  source_locator TEXT,
  entered_by TEXT,
  created_at TEXT NOT NULL,
  notes TEXT,
  CHECK((record_field_value_id IS NOT NULL AND observation_id IS NULL) OR (record_field_value_id IS NULL AND observation_id IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS record_revisions (
  record_revision_id INTEGER PRIMARY KEY,
  form_record_id INTEGER NOT NULL REFERENCES form_records(form_record_id),
  revision_number INTEGER NOT NULL,
  action_type TEXT NOT NULL,
  before_snapshot_json TEXT,
  after_snapshot_json TEXT,
  change_reason TEXT,
  changed_by TEXT,
  source_id INTEGER REFERENCES data_sources(source_id),
  created_at TEXT NOT NULL,
  UNIQUE(form_record_id, revision_number)
);
CREATE TABLE IF NOT EXISTS form_record_legacy_links (
  form_record_id INTEGER NOT NULL REFERENCES form_records(form_record_id),
  legacy_entity_type TEXT NOT NULL,
  legacy_entity_id INTEGER NOT NULL,
  linked_at TEXT NOT NULL,
  PRIMARY KEY(form_record_id,legacy_entity_type),
  UNIQUE(legacy_entity_type,legacy_entity_id,form_record_id)
);
CREATE TABLE IF NOT EXISTS record_reviews (
  review_id INTEGER PRIMARY KEY,
  form_record_id INTEGER NOT NULL REFERENCES form_records(form_record_id),
  review_stage TEXT NOT NULL,
  decision TEXT NOT NULL,
  reviewer_id TEXT,
  decision_reason TEXT,
  reviewed_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_events (
  audit_event_id INTEGER PRIMARY KEY,
  event_code TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  action_type TEXT NOT NULL,
  old_value_json TEXT,
  new_value_json TEXT,
  performed_by TEXT,
  session_id TEXT,
  performed_at TEXT NOT NULL,
  details TEXT
);
CREATE TABLE IF NOT EXISTS data_quality_issues (
  quality_issue_id INTEGER PRIMARY KEY,
  form_record_id INTEGER REFERENCES form_records(form_record_id),
  observation_id INTEGER REFERENCES observations(observation_id),
  record_field_value_id INTEGER REFERENCES record_field_values(record_field_value_id),
  field_definition_id INTEGER REFERENCES field_definitions(field_definition_id),
  issue_code TEXT NOT NULL,
  severity TEXT NOT NULL,
  issue_description TEXT NOT NULL,
  detected_by_rule TEXT,
  quality_status TEXT NOT NULL DEFAULT 'open',
  resolution_note TEXT,
  resolved_by TEXT,
  resolved_at TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS development_issues (
  issue_id INTEGER PRIMARY KEY,
  form_record_id INTEGER REFERENCES form_records(form_record_id),
  geo_unit_id INTEGER REFERENCES geographic_units(geo_unit_id),
  sector_id INTEGER REFERENCES sectors(sector_id),
  issue_code TEXT,
  issue_title TEXT NOT NULL,
  issue_description TEXT,
  general_challenge TEXT,
  population_share REAL,
  evidence_notes TEXT,
  source_id INTEGER REFERENCES data_sources(source_id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS development_plans (
  plan_id INTEGER PRIMARY KEY,
  geo_unit_id INTEGER REFERENCES geographic_units(geo_unit_id),
  period_id INTEGER REFERENCES periods(period_id),
  plan_code TEXT UNIQUE,
  plan_name TEXT NOT NULL,
  general_goal TEXT,
  plan_status TEXT NOT NULL DEFAULT 'draft',
  source_id INTEGER REFERENCES data_sources(source_id),
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS plan_priorities (
  priority_id INTEGER PRIMARY KEY,
  plan_id INTEGER NOT NULL REFERENCES development_plans(plan_id),
  priority_rank INTEGER,
  axis_name TEXT,
  sector_id INTEGER REFERENCES sectors(sector_id),
  objective_text TEXT,
  sub_program_text TEXT,
  program_text TEXT,
  target_value REAL,
  target_unit_id INTEGER REFERENCES measurement_units(unit_id),
  target_period_id INTEGER REFERENCES periods(period_id),
  source_record_id INTEGER REFERENCES form_records(form_record_id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS issue_plan_links (
  issue_plan_link_id INTEGER PRIMARY KEY,
  issue_id INTEGER NOT NULL REFERENCES development_issues(issue_id),
  priority_id INTEGER NOT NULL REFERENCES plan_priorities(priority_id),
  relationship_type TEXT NOT NULL,
  notes TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(issue_id, priority_id, relationship_type)
);
CREATE TABLE IF NOT EXISTS application_migration_log (
  migration_log_id INTEGER PRIMARY KEY,
  migration_code TEXT NOT NULL,
  source_table TEXT NOT NULL,
  source_id TEXT NOT NULL,
  target_table TEXT,
  target_id TEXT,
  status TEXT NOT NULL,
  details TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(migration_code, source_table, source_id)
);
CREATE INDEX IF NOT EXISTS idx_geo_parent_type ON geographic_units(parent_geo_unit_id, geo_unit_type_id);
CREATE INDEX IF NOT EXISTS idx_geo_normalized_name ON geographic_units(normalized_name);
CREATE UNIQUE INDEX IF NOT EXISTS idx_geo_official_code_type ON geographic_units(geo_unit_type_id, official_code) WHERE official_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_form_versions_form ON form_versions(form_id, version_number);
CREATE INDEX IF NOT EXISTS idx_form_fields_version_section ON form_fields(form_version_id, section_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_entities_type_geo ON entities(entity_type_id, geo_unit_id);
CREATE INDEX IF NOT EXISTS idx_entities_normalized_name ON entities(normalized_name);
CREATE UNIQUE INDEX IF NOT EXISTS idx_entities_canonical_code ON entities(entity_type_id, canonical_code) WHERE canonical_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_records_form_geo_period ON form_records(form_version_id, geo_unit_id, period_id);
CREATE INDEX IF NOT EXISTS idx_observations_geo_period ON observations(geo_unit_id, period_id);
CREATE INDEX IF NOT EXISTS idx_observations_field_period ON observations(field_definition_id, period_id);
CREATE INDEX IF NOT EXISTS idx_observations_entity ON observations(entity_id);
CREATE INDEX IF NOT EXISTS idx_observation_dimensions_value ON observation_dimensions(dimension_id, dimension_value_id);
CREATE INDEX IF NOT EXISTS idx_sources_hash ON data_sources(content_sha256);
CREATE INDEX IF NOT EXISTS idx_import_batch_status ON import_batches(batch_status, created_at);
CREATE INDEX IF NOT EXISTS idx_import_rows_region ON import_rows(import_region_id, source_row_number);
CREATE INDEX IF NOT EXISTS idx_import_issues_batch ON import_validation_issues(batch_id, severity, is_resolved);
CREATE INDEX IF NOT EXISTS idx_provenance_source ON value_provenance(source_id);
CREATE INDEX IF NOT EXISTS idx_record_revisions ON record_revisions(form_record_id, revision_number);
CREATE INDEX IF NOT EXISTS idx_quality_status_v2 ON data_quality_issues(quality_status, severity);
CREATE INDEX IF NOT EXISTS idx_geo_alias_lookup ON geographic_unit_aliases(normalized_alias, is_approved);
