-- Additive unified domain model. Existing tables and records remain authoritative.
CREATE TABLE IF NOT EXISTS field_groups (
  group_id INTEGER PRIMARY KEY,
  group_code TEXT NOT NULL UNIQUE,
  parent_group_id INTEGER REFERENCES field_groups(group_id),
  group_level TEXT NOT NULL CHECK(group_level IN ('domain','subdomain','category')),
  name_ar TEXT NOT NULL,
  name_en TEXT,
  description TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_field_groups_parent_order ON field_groups(parent_group_id,sort_order,group_id);

CREATE TABLE IF NOT EXISTS field_group_fields (
  group_id INTEGER NOT NULL REFERENCES field_groups(group_id) ON DELETE CASCADE,
  field_definition_id INTEGER NOT NULL REFERENCES field_definitions(field_definition_id),
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_primary INTEGER NOT NULL DEFAULT 1 CHECK(is_primary IN (0,1)),
  created_at TEXT NOT NULL,
  PRIMARY KEY(group_id,field_definition_id)
);
CREATE INDEX IF NOT EXISTS idx_field_group_fields_field ON field_group_fields(field_definition_id,group_id);

CREATE TABLE IF NOT EXISTS field_definition_aliases (
  alias_id INTEGER PRIMARY KEY,
  field_definition_id INTEGER NOT NULL REFERENCES field_definitions(field_definition_id) ON DELETE CASCADE,
  alias_text TEXT NOT NULL,
  normalized_alias TEXT NOT NULL,
  locale TEXT NOT NULL DEFAULT 'ar',
  is_approved INTEGER NOT NULL DEFAULT 0 CHECK(is_approved IN (0,1)),
  match_method TEXT NOT NULL DEFAULT 'curated',
  confidence REAL NOT NULL DEFAULT 1 CHECK(confidence>=0 AND confidence<=1),
  source_id INTEGER REFERENCES data_sources(source_id),
  created_at TEXT NOT NULL,
  UNIQUE(field_definition_id,normalized_alias,locale)
);
CREATE INDEX IF NOT EXISTS idx_field_aliases_lookup ON field_definition_aliases(normalized_alias,locale,is_approved);

CREATE TABLE IF NOT EXISTS field_dimension_rules (
  field_dimension_rule_id INTEGER PRIMARY KEY,
  field_definition_id INTEGER NOT NULL REFERENCES field_definitions(field_definition_id) ON DELETE CASCADE,
  dimension_id INTEGER NOT NULL REFERENCES dimension_definitions(dimension_id),
  dimension_value_id INTEGER REFERENCES dimension_values(dimension_value_id),
  axis_role TEXT NOT NULL DEFAULT 'breakdown',
  is_required INTEGER NOT NULL DEFAULT 0 CHECK(is_required IN (0,1)),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE(field_definition_id,dimension_id,dimension_value_id,axis_role)
);
CREATE INDEX IF NOT EXISTS idx_field_dimension_rules_field ON field_dimension_rules(field_definition_id,sort_order);

CREATE TABLE IF NOT EXISTS facility_services (
  facility_service_id INTEGER PRIMARY KEY,
  facility_entity_id INTEGER NOT NULL REFERENCES entities(entity_id) ON DELETE CASCADE,
  service_type_id INTEGER NOT NULL REFERENCES reference_values(reference_value_id),
  period_id INTEGER REFERENCES periods(period_id),
  service_status_id INTEGER REFERENCES reference_values(reference_value_id),
  capacity_value REAL CHECK(capacity_value IS NULL OR capacity_value>=0),
  capacity_unit_id INTEGER REFERENCES measurement_units(unit_id),
  beneficiaries_count INTEGER CHECK(beneficiaries_count IS NULL OR beneficiaries_count>=0),
  source_id INTEGER REFERENCES data_sources(source_id),
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_facility_services_entity_period ON facility_services(facility_entity_id,period_id);

CREATE TABLE IF NOT EXISTS staffing_observations (
  staffing_observation_id INTEGER PRIMARY KEY,
  organization_entity_id INTEGER NOT NULL REFERENCES entities(entity_id),
  workplace_entity_id INTEGER REFERENCES entities(entity_id),
  geo_unit_id INTEGER REFERENCES geographic_units(geo_unit_id),
  period_id INTEGER NOT NULL REFERENCES periods(period_id),
  staff_category_id INTEGER REFERENCES reference_values(reference_value_id),
  employment_type_id INTEGER REFERENCES reference_values(reference_value_id),
  sex_value_id INTEGER REFERENCES dimension_values(dimension_value_id),
  education_value_id INTEGER REFERENCES dimension_values(dimension_value_id),
  specialty_id INTEGER REFERENCES reference_values(reference_value_id),
  headcount INTEGER NOT NULL CHECK(headcount>=0),
  required_headcount INTEGER CHECK(required_headcount IS NULL OR required_headcount>=0),
  source_id INTEGER REFERENCES data_sources(source_id),
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_staffing_org_period ON staffing_observations(organization_entity_id,period_id);

CREATE TABLE IF NOT EXISTS natural_resource_sites (
  entity_id INTEGER PRIMARY KEY REFERENCES entities(entity_id) ON DELETE CASCADE,
  resource_type_id INTEGER NOT NULL REFERENCES reference_values(reference_value_id),
  area_value REAL CHECK(area_value IS NULL OR area_value>=0),
  area_unit_id INTEGER REFERENCES measurement_units(unit_id),
  capacity_value REAL CHECK(capacity_value IS NULL OR capacity_value>=0),
  capacity_unit_id INTEGER REFERENCES measurement_units(unit_id),
  condition_id INTEGER REFERENCES reference_values(reference_value_id),
  use_type_id INTEGER REFERENCES reference_values(reference_value_id),
  source_id INTEGER REFERENCES data_sources(source_id),
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS land_use_records (
  land_use_record_id INTEGER PRIMARY KEY,
  geo_unit_id INTEGER NOT NULL REFERENCES geographic_units(geo_unit_id),
  period_id INTEGER NOT NULL REFERENCES periods(period_id),
  land_use_type_id INTEGER NOT NULL REFERENCES reference_values(reference_value_id),
  ownership_type_id INTEGER REFERENCES reference_values(reference_value_id),
  soil_type_id INTEGER REFERENCES reference_values(reference_value_id),
  area_value REAL NOT NULL CHECK(area_value>=0),
  area_unit_id INTEGER NOT NULL REFERENCES measurement_units(unit_id),
  irrigated INTEGER CHECK(irrigated IS NULL OR irrigated IN (0,1)),
  irrigation_source_id INTEGER REFERENCES reference_values(reference_value_id),
  source_id INTEGER REFERENCES data_sources(source_id),
  notes TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(geo_unit_id,period_id,land_use_type_id,ownership_type_id,soil_type_id)
);
CREATE INDEX IF NOT EXISTS idx_land_use_geo_period ON land_use_records(geo_unit_id,period_id);

CREATE TABLE IF NOT EXISTS agricultural_production_records (
  production_record_id INTEGER PRIMARY KEY,
  geo_unit_id INTEGER NOT NULL REFERENCES geographic_units(geo_unit_id),
  producer_entity_id INTEGER REFERENCES entities(entity_id),
  period_id INTEGER NOT NULL REFERENCES periods(period_id),
  crop_type_id INTEGER NOT NULL REFERENCES reference_values(reference_value_id),
  crop_category_id INTEGER REFERENCES reference_values(reference_value_id),
  cultivated_area REAL CHECK(cultivated_area IS NULL OR cultivated_area>=0),
  area_unit_id INTEGER REFERENCES measurement_units(unit_id),
  production_quantity REAL CHECK(production_quantity IS NULL OR production_quantity>=0),
  production_unit_id INTEGER REFERENCES measurement_units(unit_id),
  yield_value REAL CHECK(yield_value IS NULL OR yield_value>=0),
  yield_unit_id INTEGER REFERENCES measurement_units(unit_id),
  irrigation_source_id INTEGER REFERENCES reference_values(reference_value_id),
  sales_quantity REAL CHECK(sales_quantity IS NULL OR sales_quantity>=0),
  sales_value REAL CHECK(sales_value IS NULL OR sales_value>=0),
  currency_code TEXT,
  source_id INTEGER REFERENCES data_sources(source_id),
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agri_production_geo_period ON agricultural_production_records(geo_unit_id,period_id,crop_type_id);

CREATE TABLE IF NOT EXISTS livestock_production_records (
  livestock_record_id INTEGER PRIMARY KEY,
  geo_unit_id INTEGER NOT NULL REFERENCES geographic_units(geo_unit_id),
  producer_entity_id INTEGER REFERENCES entities(entity_id),
  period_id INTEGER NOT NULL REFERENCES periods(period_id),
  species_id INTEGER NOT NULL REFERENCES reference_values(reference_value_id),
  animal_count INTEGER CHECK(animal_count IS NULL OR animal_count>=0),
  producer_count INTEGER CHECK(producer_count IS NULL OR producer_count>=0),
  average_holding REAL CHECK(average_holding IS NULL OR average_holding>=0),
  disease_id INTEGER REFERENCES reference_values(reference_value_id),
  infected_count INTEGER CHECK(infected_count IS NULL OR infected_count>=0),
  deaths_count INTEGER CHECK(deaths_count IS NULL OR deaths_count>=0),
  treatment_type_id INTEGER REFERENCES reference_values(reference_value_id),
  source_id INTEGER REFERENCES data_sources(source_id),
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_livestock_geo_period ON livestock_production_records(geo_unit_id,period_id,species_id);

CREATE TABLE IF NOT EXISTS fisheries_production_records (
  fishery_record_id INTEGER PRIMARY KEY,
  geo_unit_id INTEGER NOT NULL REFERENCES geographic_units(geo_unit_id),
  operator_entity_id INTEGER REFERENCES entities(entity_id),
  period_id INTEGER NOT NULL REFERENCES periods(period_id),
  fishery_zone_id INTEGER REFERENCES reference_values(reference_value_id),
  vessel_type_id INTEGER REFERENCES reference_values(reference_value_id),
  vessel_count INTEGER CHECK(vessel_count IS NULL OR vessel_count>=0),
  fisher_count INTEGER CHECK(fisher_count IS NULL OR fisher_count>=0),
  production_quantity REAL CHECK(production_quantity IS NULL OR production_quantity>=0),
  production_unit_id INTEGER REFERENCES measurement_units(unit_id),
  export_quantity REAL CHECK(export_quantity IS NULL OR export_quantity>=0),
  source_id INTEGER REFERENCES data_sources(source_id),
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fishery_geo_period ON fisheries_production_records(geo_unit_id,period_id);

CREATE TABLE IF NOT EXISTS economic_establishments (
  entity_id INTEGER PRIMARY KEY REFERENCES entities(entity_id) ON DELETE CASCADE,
  activity_type_id INTEGER NOT NULL REFERENCES reference_values(reference_value_id),
  establishment_size_id INTEGER REFERENCES reference_values(reference_value_id),
  ownership_type_id INTEGER REFERENCES reference_values(reference_value_id),
  employee_count INTEGER CHECK(employee_count IS NULL OR employee_count>=0),
  female_employee_count INTEGER CHECK(female_employee_count IS NULL OR female_employee_count>=0),
  annual_production_quantity REAL CHECK(annual_production_quantity IS NULL OR annual_production_quantity>=0),
  annual_production_unit_id INTEGER REFERENCES measurement_units(unit_id),
  annual_production_value REAL CHECK(annual_production_value IS NULL OR annual_production_value>=0),
  currency_code TEXT,
  raw_material_type_id INTEGER REFERENCES reference_values(reference_value_id),
  raw_material_origin_id INTEGER REFERENCES reference_values(reference_value_id),
  source_id INTEGER REFERENCES data_sources(source_id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tourism_site_profiles (
  entity_id INTEGER PRIMARY KEY REFERENCES entities(entity_id) ON DELETE CASCADE,
  tourism_type_id INTEGER REFERENCES reference_values(reference_value_id),
  accessibility_id INTEGER REFERENCES reference_values(reference_value_id),
  visitor_services_description TEXT,
  source_id INTEGER REFERENCES data_sources(source_id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cultural_heritage_profiles (
  entity_id INTEGER PRIMARY KEY REFERENCES entities(entity_id) ON DELETE CASCADE,
  heritage_type_id INTEGER NOT NULL REFERENCES reference_values(reference_value_id),
  practice_season TEXT,
  current_condition_id INTEGER REFERENCES reference_values(reference_value_id),
  description TEXT,
  preservation_measures TEXT,
  source_id INTEGER REFERENCES data_sources(source_id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS education_enrollment_records (
  enrollment_record_id INTEGER PRIMARY KEY,
  geo_unit_id INTEGER NOT NULL REFERENCES geographic_units(geo_unit_id),
  facility_entity_id INTEGER REFERENCES entities(entity_id),
  period_id INTEGER NOT NULL REFERENCES periods(period_id),
  education_level_id INTEGER NOT NULL REFERENCES reference_values(reference_value_id),
  grade_id INTEGER REFERENCES reference_values(reference_value_id),
  sex_value_id INTEGER REFERENCES dimension_values(dimension_value_id),
  age_group_value_id INTEGER REFERENCES dimension_values(dimension_value_id),
  target_count INTEGER CHECK(target_count IS NULL OR target_count>=0),
  enrolled_count INTEGER CHECK(enrolled_count IS NULL OR enrolled_count>=0),
  dropout_count INTEGER CHECK(dropout_count IS NULL OR dropout_count>=0),
  teacher_count INTEGER CHECK(teacher_count IS NULL OR teacher_count>=0),
  source_id INTEGER REFERENCES data_sources(source_id),
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_education_enrollment_geo_period ON education_enrollment_records(geo_unit_id,period_id,education_level_id);

CREATE TABLE IF NOT EXISTS health_service_records (
  health_service_record_id INTEGER PRIMARY KEY,
  geo_unit_id INTEGER NOT NULL REFERENCES geographic_units(geo_unit_id),
  facility_entity_id INTEGER REFERENCES entities(entity_id),
  period_id INTEGER NOT NULL REFERENCES periods(period_id),
  service_type_id INTEGER REFERENCES reference_values(reference_value_id),
  disease_id INTEGER REFERENCES reference_values(reference_value_id),
  sex_value_id INTEGER REFERENCES dimension_values(dimension_value_id),
  age_group_value_id INTEGER REFERENCES dimension_values(dimension_value_id),
  target_count INTEGER CHECK(target_count IS NULL OR target_count>=0),
  served_count INTEGER CHECK(served_count IS NULL OR served_count>=0),
  case_count INTEGER CHECK(case_count IS NULL OR case_count>=0),
  death_count INTEGER CHECK(death_count IS NULL OR death_count>=0),
  source_id INTEGER REFERENCES data_sources(source_id),
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_health_service_geo_period ON health_service_records(geo_unit_id,period_id);

CREATE TABLE IF NOT EXISTS household_welfare_records (
  welfare_record_id INTEGER PRIMARY KEY,
  geo_unit_id INTEGER NOT NULL REFERENCES geographic_units(geo_unit_id),
  period_id INTEGER NOT NULL REFERENCES periods(period_id),
  poverty_line_type_id INTEGER REFERENCES reference_values(reference_value_id),
  welfare_category_id INTEGER REFERENCES reference_values(reference_value_id),
  household_count INTEGER CHECK(household_count IS NULL OR household_count>=0),
  poor_household_count INTEGER CHECK(poor_household_count IS NULL OR poor_household_count>=0),
  income_value REAL CHECK(income_value IS NULL OR income_value>=0),
  expenditure_value REAL CHECK(expenditure_value IS NULL OR expenditure_value>=0),
  currency_code TEXT,
  source_id INTEGER REFERENCES data_sources(source_id),
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_welfare_geo_period ON household_welfare_records(geo_unit_id,period_id);

CREATE TABLE IF NOT EXISTS social_protection_records (
  protection_record_id INTEGER PRIMARY KEY,
  geo_unit_id INTEGER NOT NULL REFERENCES geographic_units(geo_unit_id),
  period_id INTEGER NOT NULL REFERENCES periods(period_id),
  beneficiary_group_id INTEGER REFERENCES reference_values(reference_value_id),
  implementing_entity_id INTEGER REFERENCES entities(entity_id),
  eligible_count INTEGER CHECK(eligible_count IS NULL OR eligible_count>=0),
  beneficiary_count INTEGER CHECK(beneficiary_count IS NULL OR beneficiary_count>=0),
  amount_paid REAL CHECK(amount_paid IS NULL OR amount_paid>=0),
  currency_code TEXT,
  payment_cycle_id INTEGER REFERENCES reference_values(reference_value_id),
  source_id INTEGER REFERENCES data_sources(source_id),
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_social_protection_geo_period ON social_protection_records(geo_unit_id,period_id);

CREATE TABLE IF NOT EXISTS financial_accounts (
  account_id INTEGER PRIMARY KEY,
  account_code TEXT NOT NULL UNIQUE,
  account_name_ar TEXT NOT NULL,
  account_type TEXT NOT NULL CHECK(account_type IN ('revenue','expenditure','transfer','asset','liability','funding')),
  parent_account_id INTEGER REFERENCES financial_accounts(account_id),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS budget_headers (
  budget_id INTEGER PRIMARY KEY,
  geo_unit_id INTEGER REFERENCES geographic_units(geo_unit_id),
  period_id INTEGER NOT NULL REFERENCES periods(period_id),
  budget_code TEXT NOT NULL UNIQUE,
  budget_name TEXT NOT NULL,
  budget_status TEXT NOT NULL DEFAULT 'draft',
  currency_code TEXT NOT NULL,
  approved_at TEXT,
  source_id INTEGER REFERENCES data_sources(source_id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS budget_lines (
  budget_line_id INTEGER PRIMARY KEY,
  budget_id INTEGER NOT NULL REFERENCES budget_headers(budget_id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL REFERENCES financial_accounts(account_id),
  sector_id INTEGER REFERENCES sectors(sector_id),
  approved_amount REAL NOT NULL DEFAULT 0 CHECK(approved_amount>=0),
  revised_amount REAL CHECK(revised_amount IS NULL OR revised_amount>=0),
  actual_amount REAL CHECK(actual_amount IS NULL OR actual_amount>=0),
  currency_code TEXT NOT NULL,
  source_id INTEGER REFERENCES data_sources(source_id),
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(budget_id,account_id,sector_id)
);
CREATE INDEX IF NOT EXISTS idx_budget_lines_account ON budget_lines(account_id,budget_id);

CREATE TABLE IF NOT EXISTS revenue_transactions (
  revenue_transaction_id INTEGER PRIMARY KEY,
  geo_unit_id INTEGER NOT NULL REFERENCES geographic_units(geo_unit_id),
  period_id INTEGER NOT NULL REFERENCES periods(period_id),
  account_id INTEGER NOT NULL REFERENCES financial_accounts(account_id),
  collecting_entity_id INTEGER REFERENCES entities(entity_id),
  assessed_amount REAL CHECK(assessed_amount IS NULL OR assessed_amount>=0),
  collected_amount REAL NOT NULL CHECK(collected_amount>=0),
  remitted_amount REAL CHECK(remitted_amount IS NULL OR remitted_amount>=0),
  currency_code TEXT NOT NULL,
  transaction_date TEXT,
  source_id INTEGER REFERENCES data_sources(source_id),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_revenue_geo_period ON revenue_transactions(geo_unit_id,period_id,account_id);

CREATE TABLE IF NOT EXISTS expenditure_transactions (
  expenditure_transaction_id INTEGER PRIMARY KEY,
  geo_unit_id INTEGER NOT NULL REFERENCES geographic_units(geo_unit_id),
  period_id INTEGER NOT NULL REFERENCES periods(period_id),
  account_id INTEGER NOT NULL REFERENCES financial_accounts(account_id),
  project_id INTEGER REFERENCES projects(id),
  paid_amount REAL NOT NULL CHECK(paid_amount>=0),
  currency_code TEXT NOT NULL,
  transaction_date TEXT,
  expenditure_status TEXT,
  source_id INTEGER REFERENCES data_sources(source_id),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_expenditure_geo_period ON expenditure_transactions(geo_unit_id,period_id,account_id);

CREATE TABLE IF NOT EXISTS swot_pestle_analyses (
  analysis_id INTEGER PRIMARY KEY,
  geo_unit_id INTEGER NOT NULL REFERENCES geographic_units(geo_unit_id),
  period_id INTEGER REFERENCES periods(period_id),
  analysis_type TEXT NOT NULL CHECK(analysis_type IN ('swot','pestle')),
  factor_type TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  evidence_summary TEXT,
  impact_direction TEXT,
  impact_severity REAL CHECK(impact_severity IS NULL OR impact_severity>=0),
  time_horizon TEXT,
  response_strategy TEXT,
  source_id INTEGER REFERENCES data_sources(source_id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_context_analysis_geo ON swot_pestle_analyses(geo_unit_id,analysis_type,period_id);

CREATE TABLE IF NOT EXISTS development_issue_factors (
  issue_factor_id INTEGER PRIMARY KEY,
  issue_id INTEGER NOT NULL REFERENCES development_issues(issue_id) ON DELETE CASCADE,
  factor_type TEXT NOT NULL CHECK(factor_type IN ('direct_cause','root_cause','effect','constraint','opportunity','risk')),
  description TEXT NOT NULL,
  severity REAL CHECK(severity IS NULL OR severity>=0),
  source_id INTEGER REFERENCES data_sources(source_id),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_issue_factors_issue ON development_issue_factors(issue_id,factor_type);

CREATE TABLE IF NOT EXISTS development_issue_evidence (
  issue_evidence_id INTEGER PRIMARY KEY,
  issue_id INTEGER NOT NULL REFERENCES development_issues(issue_id) ON DELETE CASCADE,
  source_id INTEGER REFERENCES data_sources(source_id),
  evidence_type TEXT NOT NULL,
  description TEXT,
  geo_unit_id INTEGER REFERENCES geographic_units(geo_unit_id),
  period_id INTEGER REFERENCES periods(period_id),
  source_locator TEXT,
  confidence REAL CHECK(confidence IS NULL OR (confidence>=0 AND confidence<=1)),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_issue_evidence_issue ON development_issue_evidence(issue_id);

CREATE TABLE IF NOT EXISTS priority_criteria (
  criterion_id INTEGER PRIMARY KEY,
  criterion_code TEXT NOT NULL UNIQUE,
  name_ar TEXT NOT NULL,
  description TEXT,
  default_weight REAL NOT NULL CHECK(default_weight>=0),
  direction TEXT NOT NULL DEFAULT 'higher_is_higher',
  scale_min REAL,
  scale_max REAL,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK(scale_min IS NULL OR scale_max IS NULL OR scale_max>scale_min)
);

CREATE TABLE IF NOT EXISTS issue_priority_assessments (
  assessment_id INTEGER PRIMARY KEY,
  issue_id INTEGER NOT NULL REFERENCES development_issues(issue_id) ON DELETE CASCADE,
  criterion_id INTEGER NOT NULL REFERENCES priority_criteria(criterion_id),
  period_id INTEGER REFERENCES periods(period_id),
  raw_score REAL NOT NULL,
  normalized_score REAL,
  applied_weight REAL NOT NULL CHECK(applied_weight>=0),
  weighted_score REAL NOT NULL,
  rationale TEXT,
  source_id INTEGER REFERENCES data_sources(source_id),
  assessed_by TEXT,
  assessed_at TEXT NOT NULL,
  UNIQUE(issue_id,criterion_id,period_id)
);
CREATE INDEX IF NOT EXISTS idx_priority_assessments_issue ON issue_priority_assessments(issue_id,period_id);

CREATE TABLE IF NOT EXISTS strategic_objectives (
  objective_id INTEGER PRIMARY KEY,
  plan_id INTEGER REFERENCES development_plans(plan_id) ON DELETE CASCADE,
  parent_objective_id INTEGER REFERENCES strategic_objectives(objective_id),
  objective_code TEXT NOT NULL UNIQUE,
  objective_level TEXT NOT NULL CHECK(objective_level IN ('strategic','general','specific','operational')),
  title TEXT NOT NULL,
  description TEXT,
  sector_id INTEGER REFERENCES sectors(sector_id),
  baseline_value REAL,
  target_value REAL,
  target_unit_id INTEGER REFERENCES measurement_units(unit_id),
  target_period_id INTEGER REFERENCES periods(period_id),
  responsible_entity_id INTEGER REFERENCES entities(entity_id),
  source_id INTEGER REFERENCES data_sources(source_id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_objectives_plan_parent ON strategic_objectives(plan_id,parent_objective_id);

CREATE TABLE IF NOT EXISTS development_programs (
  program_id INTEGER PRIMARY KEY,
  plan_id INTEGER REFERENCES development_plans(plan_id) ON DELETE CASCADE,
  objective_id INTEGER REFERENCES strategic_objectives(objective_id),
  parent_program_id INTEGER REFERENCES development_programs(program_id),
  program_code TEXT NOT NULL UNIQUE,
  program_name TEXT NOT NULL,
  program_description TEXT,
  sector_id INTEGER REFERENCES sectors(sector_id),
  start_period_id INTEGER REFERENCES periods(period_id),
  end_period_id INTEGER REFERENCES periods(period_id),
  program_status TEXT NOT NULL DEFAULT 'draft',
  source_id INTEGER REFERENCES data_sources(source_id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_programs_objective ON development_programs(objective_id,sector_id);

CREATE TABLE IF NOT EXISTS program_projects (
  program_id INTEGER NOT NULL REFERENCES development_programs(program_id) ON DELETE CASCADE,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  relationship_type TEXT NOT NULL DEFAULT 'implements',
  created_at TEXT NOT NULL,
  PRIMARY KEY(program_id,project_id,relationship_type)
);

CREATE TABLE IF NOT EXISTS project_activities (
  activity_id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  parent_activity_id INTEGER REFERENCES project_activities(activity_id),
  activity_code TEXT,
  activity_name TEXT NOT NULL,
  description TEXT,
  start_date TEXT,
  end_date TEXT,
  responsible_entity_id INTEGER REFERENCES entities(entity_id),
  activity_status TEXT NOT NULL DEFAULT 'planned',
  progress_ratio REAL CHECK(progress_ratio IS NULL OR (progress_ratio>=0 AND progress_ratio<=1)),
  source_id INTEGER REFERENCES data_sources(source_id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK(start_date IS NULL OR end_date IS NULL OR end_date>=start_date)
);
CREATE INDEX IF NOT EXISTS idx_project_activities_project ON project_activities(project_id,parent_activity_id);

CREATE TABLE IF NOT EXISTS project_milestones (
  milestone_id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  milestone_name TEXT NOT NULL,
  due_date TEXT,
  achieved_date TEXT,
  milestone_status TEXT NOT NULL DEFAULT 'planned',
  evidence_source_id INTEGER REFERENCES data_sources(source_id),
  notes TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_project_milestones_project ON project_milestones(project_id,due_date);

CREATE TABLE IF NOT EXISTS project_geographic_units (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  geo_unit_id INTEGER NOT NULL REFERENCES geographic_units(geo_unit_id),
  role TEXT NOT NULL DEFAULT 'beneficiary_area',
  created_at TEXT NOT NULL,
  PRIMARY KEY(project_id,geo_unit_id,role)
);

CREATE TABLE IF NOT EXISTS project_beneficiary_targets (
  beneficiary_target_id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  beneficiary_group_id INTEGER REFERENCES reference_values(reference_value_id),
  geo_unit_id INTEGER REFERENCES geographic_units(geo_unit_id),
  target_count INTEGER CHECK(target_count IS NULL OR target_count>=0),
  actual_count INTEGER CHECK(actual_count IS NULL OR actual_count>=0),
  period_id INTEGER REFERENCES periods(period_id),
  source_id INTEGER REFERENCES data_sources(source_id),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_project_beneficiaries_project ON project_beneficiary_targets(project_id,period_id);

CREATE TABLE IF NOT EXISTS indicator_definition_versions (
  indicator_version_id INTEGER PRIMARY KEY,
  indicator_id INTEGER NOT NULL REFERENCES indicator_definitions(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  definition_json TEXT NOT NULL,
  methodology TEXT,
  formula_version TEXT,
  effective_from TEXT,
  effective_to TEXT,
  change_reason TEXT,
  approved_by TEXT,
  approved_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(indicator_id,version_number),
  CHECK(effective_from IS NULL OR effective_to IS NULL OR effective_to>=effective_from)
);
CREATE TABLE IF NOT EXISTS indicator_components (
  component_id INTEGER PRIMARY KEY,
  indicator_version_id INTEGER NOT NULL REFERENCES indicator_definition_versions(indicator_version_id) ON DELETE CASCADE,
  component_code TEXT NOT NULL,
  component_role TEXT NOT NULL CHECK(component_role IN ('numerator','denominator','input','weight','threshold','formula_constant')),
  field_definition_id INTEGER REFERENCES field_definitions(field_definition_id),
  source_indicator_id INTEGER REFERENCES indicator_definitions(id),
  expression TEXT,
  unit_id INTEGER REFERENCES measurement_units(unit_id),
  is_required INTEGER NOT NULL DEFAULT 1 CHECK(is_required IN (0,1)),
  sort_order INTEGER NOT NULL DEFAULT 0,
  UNIQUE(indicator_version_id,component_code)
);
CREATE TABLE IF NOT EXISTS indicator_weight_profiles (
  weight_profile_id INTEGER PRIMARY KEY,
  profile_code TEXT NOT NULL UNIQUE,
  profile_name TEXT NOT NULL,
  description TEXT,
  methodology TEXT,
  is_active INTEGER NOT NULL DEFAULT 0 CHECK(is_active IN (0,1)),
  created_by TEXT,
  approved_by TEXT,
  approved_at TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS indicator_weights (
  indicator_weight_id INTEGER PRIMARY KEY,
  weight_profile_id INTEGER NOT NULL REFERENCES indicator_weight_profiles(weight_profile_id) ON DELETE CASCADE,
  indicator_id INTEGER NOT NULL REFERENCES indicator_definitions(id),
  weight_value REAL NOT NULL CHECK(weight_value>=0),
  rationale TEXT,
  source_id INTEGER REFERENCES data_sources(source_id),
  UNIQUE(weight_profile_id,indicator_id)
);
CREATE TABLE IF NOT EXISTS indicator_targets (
  indicator_target_id INTEGER PRIMARY KEY,
  indicator_id INTEGER NOT NULL REFERENCES indicator_definitions(id),
  geo_unit_id INTEGER REFERENCES geographic_units(geo_unit_id),
  period_id INTEGER NOT NULL REFERENCES periods(period_id),
  target_value REAL NOT NULL,
  unit_id INTEGER REFERENCES measurement_units(unit_id),
  target_type TEXT NOT NULL DEFAULT 'official',
  source_id INTEGER REFERENCES data_sources(source_id),
  notes TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(indicator_id,geo_unit_id,period_id,target_type)
);
CREATE TABLE IF NOT EXISTS indicator_benchmarks (
  benchmark_id INTEGER PRIMARY KEY,
  indicator_id INTEGER NOT NULL REFERENCES indicator_definitions(id),
  geography_type_id INTEGER REFERENCES geo_unit_types(geo_unit_type_id),
  benchmark_type TEXT NOT NULL,
  value_number REAL NOT NULL,
  unit_id INTEGER REFERENCES measurement_units(unit_id),
  valid_from TEXT,
  valid_to TEXT,
  source_id INTEGER REFERENCES data_sources(source_id),
  rationale TEXT,
  created_at TEXT NOT NULL,
  CHECK(valid_from IS NULL OR valid_to IS NULL OR valid_to>=valid_from)
);
CREATE TABLE IF NOT EXISTS indicator_calculation_runs (
  calculation_run_id INTEGER PRIMARY KEY,
  weight_profile_id INTEGER REFERENCES indicator_weight_profiles(weight_profile_id),
  period_id INTEGER REFERENCES periods(period_id),
  run_mode TEXT NOT NULL,
  algorithm_version TEXT NOT NULL,
  input_snapshot_hash TEXT NOT NULL,
  parameters_json TEXT NOT NULL,
  started_by TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  run_status TEXT NOT NULL DEFAULT 'running',
  failure_reason TEXT
);
CREATE TABLE IF NOT EXISTS indicator_calculation_results (
  calculation_result_id INTEGER PRIMARY KEY,
  calculation_run_id INTEGER NOT NULL REFERENCES indicator_calculation_runs(calculation_run_id) ON DELETE CASCADE,
  indicator_id INTEGER REFERENCES indicator_definitions(id),
  geo_unit_id INTEGER NOT NULL REFERENCES geographic_units(geo_unit_id),
  raw_value REAL,
  normalized_value REAL,
  weighted_value REAL,
  composite_score REAL,
  rank_value INTEGER,
  confidence_level TEXT,
  coverage_ratio REAL CHECK(coverage_ratio IS NULL OR (coverage_ratio>=0 AND coverage_ratio<=1)),
  missing_inputs_json TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(calculation_run_id,indicator_id,geo_unit_id)
);
CREATE INDEX IF NOT EXISTS idx_indicator_calculation_rank ON indicator_calculation_results(calculation_run_id,rank_value);

CREATE TABLE IF NOT EXISTS indicator_result_inputs (
  result_input_id INTEGER PRIMARY KEY,
  calculation_result_id INTEGER NOT NULL REFERENCES indicator_calculation_results(calculation_result_id) ON DELETE CASCADE,
  observation_id INTEGER REFERENCES observations(observation_id),
  source_indicator_result_id INTEGER REFERENCES indicator_calculation_results(calculation_result_id),
  input_role TEXT NOT NULL,
  input_value REAL,
  input_state TEXT NOT NULL,
  transformation_json TEXT,
  source_id INTEGER REFERENCES data_sources(source_id),
  source_locator TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_indicator_result_inputs_result ON indicator_result_inputs(calculation_result_id);


-- Enforce the declared domain -> subdomain -> category hierarchy.
CREATE TRIGGER IF NOT EXISTS field_groups_parent_level_insert
BEFORE INSERT ON field_groups
BEGIN
  SELECT CASE
    WHEN NEW.group_level='domain' AND NEW.parent_group_id IS NOT NULL
      THEN RAISE(ABORT,'domain group cannot have a parent')
    WHEN NEW.group_level<>'domain' AND NEW.parent_group_id IS NULL
      THEN RAISE(ABORT,'subdomain/category group requires a parent')
    WHEN NEW.group_level='subdomain' AND NOT EXISTS(
      SELECT 1 FROM field_groups p WHERE p.group_id=NEW.parent_group_id AND p.group_level='domain'
    ) THEN RAISE(ABORT,'subdomain parent must be a domain')
    WHEN NEW.group_level='category' AND NOT EXISTS(
      SELECT 1 FROM field_groups p WHERE p.group_id=NEW.parent_group_id AND p.group_level='subdomain'
    ) THEN RAISE(ABORT,'category parent must be a subdomain')
  END;
END;

CREATE TRIGGER IF NOT EXISTS field_groups_parent_level_update
BEFORE UPDATE OF parent_group_id,group_level ON field_groups
BEGIN
  SELECT CASE
    WHEN NEW.group_level='domain' AND NEW.parent_group_id IS NOT NULL
      THEN RAISE(ABORT,'domain group cannot have a parent')
    WHEN NEW.group_level<>'domain' AND NEW.parent_group_id IS NULL
      THEN RAISE(ABORT,'subdomain/category group requires a parent')
    WHEN NEW.group_level='subdomain' AND NOT EXISTS(
      SELECT 1 FROM field_groups p WHERE p.group_id=NEW.parent_group_id AND p.group_level='domain'
    ) THEN RAISE(ABORT,'subdomain parent must be a domain')
    WHEN NEW.group_level='category' AND NOT EXISTS(
      SELECT 1 FROM field_groups p WHERE p.group_id=NEW.parent_group_id AND p.group_level='subdomain'
    ) THEN RAISE(ABORT,'category parent must be a subdomain')
  END;
  SELECT CASE WHEN NEW.parent_group_id=NEW.group_id OR EXISTS(
    WITH RECURSIVE ancestors(id) AS (
      SELECT NEW.parent_group_id
      UNION ALL
      SELECT g.parent_group_id FROM field_groups g JOIN ancestors a ON g.group_id=a.id
      WHERE g.parent_group_id IS NOT NULL
    )
    SELECT 1 FROM ancestors WHERE id=NEW.group_id
  ) THEN RAISE(ABORT,'field group hierarchy cycle') END;
END;

CREATE TRIGGER IF NOT EXISTS field_dimension_rule_value_insert
BEFORE INSERT ON field_dimension_rules
WHEN NEW.dimension_value_id IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS(
    SELECT 1 FROM dimension_values v
    WHERE v.dimension_value_id=NEW.dimension_value_id AND v.dimension_id=NEW.dimension_id
  ) THEN RAISE(ABORT,'field dimension value belongs to another dimension') END;
END;

CREATE TRIGGER IF NOT EXISTS field_dimension_rule_value_update
BEFORE UPDATE OF dimension_id,dimension_value_id ON field_dimension_rules
WHEN NEW.dimension_value_id IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS(
    SELECT 1 FROM dimension_values v
    WHERE v.dimension_value_id=NEW.dimension_value_id AND v.dimension_id=NEW.dimension_id
  ) THEN RAISE(ABORT,'field dimension value belongs to another dimension') END;
END;

CREATE TRIGGER IF NOT EXISTS education_enrollment_dimension_check_insert
BEFORE INSERT ON education_enrollment_records
BEGIN
  SELECT CASE WHEN NEW.sex_value_id IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM dimension_values v JOIN dimension_definitions d USING(dimension_id)
    WHERE v.dimension_value_id=NEW.sex_value_id AND d.dimension_code='sex'
  ) THEN RAISE(ABORT,'education enrollment sex value must belong to sex dimension') END;
  SELECT CASE WHEN NEW.age_group_value_id IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM dimension_values v JOIN dimension_definitions d USING(dimension_id)
    WHERE v.dimension_value_id=NEW.age_group_value_id AND d.dimension_code='age_group'
  ) THEN RAISE(ABORT,'education enrollment age value must belong to age_group dimension') END;
END;

CREATE TRIGGER IF NOT EXISTS health_service_dimension_check_insert
BEFORE INSERT ON health_service_records
BEGIN
  SELECT CASE WHEN NEW.sex_value_id IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM dimension_values v JOIN dimension_definitions d USING(dimension_id)
    WHERE v.dimension_value_id=NEW.sex_value_id AND d.dimension_code='sex'
  ) THEN RAISE(ABORT,'health service sex value must belong to sex dimension') END;
  SELECT CASE WHEN NEW.age_group_value_id IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM dimension_values v JOIN dimension_definitions d USING(dimension_id)
    WHERE v.dimension_value_id=NEW.age_group_value_id AND d.dimension_code='age_group'
  ) THEN RAISE(ABORT,'health service age value must belong to age_group dimension') END;
END;
