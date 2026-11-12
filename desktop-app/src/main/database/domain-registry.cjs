'use strict';

// ---------------------------------------------------------------------------
// Central registry of the unified development data model.
//
// Every dataset below maps one physical table to explicit, Arabic-labelled
// field metadata. This registry is the only source of table/column
// identifiers the domain service is allowed to interpolate into SQL, and the
// database schema stays authoritative: `describe()` merges this registry with
// PRAGMA table_info so a column can never be hidden from the UI.
//
// Field types:
//   text | long_text | integer | decimal | boolean | date | datetime |
//   reference | dimension | entity | geo | period | sector | unit | account |
//   currency
//
// Enumerations are copied verbatim from CHECK constraints in
// unified-development-model-v1.sql / architecture-v1.sql. Columns without a
// CHECK constraint deliberately carry no `enum` (only an explanatory note).
// ---------------------------------------------------------------------------

const LAYERS = Object.freeze([
  Object.freeze({ key: 'records', labelAr: 'سجلات البيانات القطاعية' }),
  Object.freeze({ key: 'analysis', labelAr: 'التحليل التنموي والقضايا' }),
  Object.freeze({ key: 'planning', labelAr: 'التخطيط الاستراتيجي والبرامج' }),
  Object.freeze({ key: 'finance', labelAr: 'المالية والموازنات' }),
  Object.freeze({ key: 'indicators', labelAr: 'المؤشرات والقياس' }),
  Object.freeze({ key: 'dictionary', labelAr: 'قاموس الحقول والأبعاد' })
]);

const LAYER_LABELS = Object.freeze(Object.fromEntries(LAYERS.map(layer => [layer.key, layer.labelAr])));

// ---------------------------------------------------------------------------
// Reference targets.
//
// `valueColumn` is the column the foreign keys actually point at (verified
// against the DDL). `fallbackValueColumns` cover the legacy/canonical aliases
// that architecture.cjs keeps in sync (geo_unit_id/id, sector_id/id, ...).
// `labelColumns` are tried left to right; the service falls back to the raw
// value as text when every label column is null.
// ---------------------------------------------------------------------------

const REFERENCE = Object.freeze({
  table: 'reference_values',
  valueColumn: 'reference_value_id',
  labelColumns: Object.freeze(['label_ar']),
  detailColumns: Object.freeze(['value_code'])
});

const ENTITY = Object.freeze({
  table: 'entities',
  valueColumn: 'entity_id',
  labelColumns: Object.freeze(['name_ar']),
  detailColumns: Object.freeze(['canonical_code'])
});

const GEO = Object.freeze({
  table: 'geographic_units',
  valueColumn: 'geo_unit_id',
  fallbackValueColumns: Object.freeze(['id']),
  labelColumns: Object.freeze(['name_ar', 'name']),
  detailColumns: Object.freeze(['official_code'])
});

const PERIOD = Object.freeze({
  table: 'periods',
  valueColumn: 'period_id',
  labelColumns: Object.freeze(['label_ar']),
  detailColumns: Object.freeze(['period_code'])
});

const SECTOR = Object.freeze({
  table: 'sectors',
  valueColumn: 'sector_id',
  fallbackValueColumns: Object.freeze(['id']),
  labelColumns: Object.freeze(['name_ar']),
  detailColumns: Object.freeze(['sector_code', 'code'])
});

const UNIT = Object.freeze({
  table: 'measurement_units',
  valueColumn: 'unit_id',
  labelColumns: Object.freeze(['name_ar']),
  detailColumns: Object.freeze(['unit_code'])
});

const ACCOUNT = Object.freeze({
  table: 'financial_accounts',
  valueColumn: 'account_id',
  labelColumns: Object.freeze(['account_name_ar']),
  detailColumns: Object.freeze(['account_code'])
});

// `currencies` is created by the parallel v2 migration; the service tolerates
// its absence and then only checks the code shape.
const CURRENCY = Object.freeze({
  table: 'currencies',
  valueColumn: 'currency_code',
  labelColumns: Object.freeze(['name_ar']),
  detailColumns: Object.freeze(['name_en']),
  minorUnitColumn: 'minor_unit'
});

const SOURCE = Object.freeze({
  table: 'data_sources',
  valueColumn: 'source_id',
  fallbackValueColumns: Object.freeze(['id']),
  labelColumns: Object.freeze(['document_title', 'file_name', 'source_code', 'organization_name']),
  detailColumns: Object.freeze(['source_type'])
});

// Dimension values always live in `dimension_values`; the sex/age breakdowns
// additionally pin `dimension_definitions.dimension_code`.
const DIMENSION = Object.freeze({
  table: 'dimension_values',
  valueColumn: 'dimension_value_id',
  labelColumns: Object.freeze(['label_ar']),
  detailColumns: Object.freeze(['value_code']),
  dimensionTable: 'dimension_definitions',
  dimensionIdColumn: 'dimension_id',
  dimensionCodeColumn: 'dimension_code'
});

const dimensionOf = code => Object.freeze({ ...DIMENSION, filter: Object.freeze({ dimensionCode: code }) });

const DIMENSION_SEX = dimensionOf('sex');
const DIMENSION_AGE_GROUP = dimensionOf('age_group');
const DIMENSION_EDUCATION = dimensionOf('education_level');

// Nested datasets (self/parent references and intra-model parents).
const refTo = (table, valueColumn, ...labelColumns) => Object.freeze({
  table,
  valueColumn,
  labelColumns: Object.freeze(labelColumns)
});

const ISSUE = refTo('development_issues', 'issue_id', 'issue_title');
const PLAN = refTo('development_plans', 'plan_id', 'plan_name');
const PROJECT = refTo('projects', 'id', 'name', 'project_name');
const CRITERION = refTo('priority_criteria', 'criterion_id', 'name_ar');
const BUDGET = refTo('budget_headers', 'budget_id', 'budget_name');
const OBJECTIVE = refTo('strategic_objectives', 'objective_id', 'title');
const PROGRAM = refTo('development_programs', 'program_id', 'program_name');
const ACTIVITY = refTo('project_activities', 'activity_id', 'activity_name');
const ACCOUNT_SELF = refTo('financial_accounts', 'account_id', 'account_name_ar');
const GROUP_SELF = refTo('field_groups', 'group_id', 'name_ar');
const FIELD_DEFINITION = refTo('field_definitions', 'field_definition_id', 'canonical_name_ar');
const INDICATOR = refTo('indicator_definitions', 'id', 'label_ar');
const INDICATOR_VERSION = refTo('indicator_definition_versions', 'indicator_version_id', 'change_reason', 'formula_version');
const DIMENSION_DEFINITION = refTo('dimension_definitions', 'dimension_id', 'name_ar');
const GEO_UNIT_TYPE = refTo('geo_unit_types', 'geo_unit_type_id', 'name_ar');

// ---------------------------------------------------------------------------
// Field helpers. `field()` keeps every declaration an explicit object literal
// while avoiding repeated boilerplate.
// ---------------------------------------------------------------------------

function field(name, labelAr, type, extra = {}) {
  return Object.freeze({ name, labelAr, type, ...extra });
}

const idField = (name, labelAr) => field(name, labelAr, 'integer', {
  note: 'المعرّف الأساسي؛ يُولّد تلقائياً عند الإدراج.'
});

const naturalKeyField = (name, labelAr, ref, note) => field(name, labelAr, 'entity', { required: true, ref, note });

const sourceField = () => field('source_id', 'المصدر', 'reference', { ref: SOURCE });

const notesField = () => field('notes', 'ملاحظات', 'long_text', { allowEmpty: true });

const countField = (name, labelAr, required = false) => field(name, labelAr, 'integer', { min: 0, required });

const amountField = (name, labelAr, required = false) => field(name, labelAr, 'decimal', { min: 0, required });

const currencyField = (required = false) => field('currency_code', 'رمز العملة', 'currency', {
  required,
  ref: CURRENCY,
  note: 'يُشتق عمود القيمة الدقيقة (minor units) تلقائياً عند وجوده.'
});

// ---------------------------------------------------------------------------
// Layer: records — sector observations captured against geography and period.
// ---------------------------------------------------------------------------

const RECORD_DATASETS = [
  {
    key: 'facilityServices',
    labelAr: 'خدمات المرافق',
    layer: 'records',
    table: 'facility_services',
    pk: 'facility_service_id',
    autoPk: true,
    description: 'الخدمات التي يقدمها مرفق أو منشأة مع طاقتها الاستيعابية وعدد المستفيدين.',
    fields: [
      idField('facility_service_id', 'معرّف خدمة المرفق'),
      field('facility_entity_id', 'المرفق', 'entity', { required: true, ref: ENTITY }),
      field('service_type_id', 'نوع الخدمة', 'reference', { required: true, ref: REFERENCE }),
      field('period_id', 'الفترة المرجعية', 'period', { ref: PERIOD }),
      field('service_status_id', 'حالة تقديم الخدمة', 'reference', { ref: REFERENCE }),
      amountField('capacity_value', 'الطاقة الاستيعابية'),
      field('capacity_unit_id', 'وحدة الطاقة الاستيعابية', 'unit', { ref: UNIT }),
      countField('beneficiaries_count', 'عدد المستفيدين'),
      sourceField(),
      notesField()
    ]
  },
  {
    key: 'staffingObservations',
    labelAr: 'ملاحظات الكادر الوظيفي',
    layer: 'records',
    table: 'staffing_observations',
    pk: 'staffing_observation_id',
    autoPk: true,
    description: 'أعداد العاملين في جهة أو مكان عمل حسب الفئة والتخصص والجنس والمؤهل.',
    fields: [
      idField('staffing_observation_id', 'معرّف ملاحظة الكادر'),
      field('organization_entity_id', 'الجهة المنظمة', 'entity', { required: true, ref: ENTITY }),
      field('workplace_entity_id', 'مكان العمل', 'entity', { ref: ENTITY }),
      field('geo_unit_id', 'الوحدة الجغرافية', 'geo', { ref: GEO }),
      field('period_id', 'الفترة المرجعية', 'period', { required: true, ref: PERIOD }),
      field('staff_category_id', 'فئة الكادر', 'reference', { ref: REFERENCE }),
      field('employment_type_id', 'نوع التوظيف', 'reference', { ref: REFERENCE }),
      field('sex_value_id', 'الجنس', 'dimension', { ref: DIMENSION_SEX }),
      field('education_value_id', 'المؤهل العلمي', 'dimension', { ref: DIMENSION_EDUCATION }),
      field('specialty_id', 'التخصص', 'reference', { ref: REFERENCE }),
      countField('headcount', 'عدد العاملين', true),
      countField('required_headcount', 'العدد اللازم من العاملين'),
      sourceField(),
      notesField()
    ]
  },
  {
    key: 'naturalResourceSites',
    labelAr: 'مواقع الموارد الطبيعية',
    layer: 'records',
    table: 'natural_resource_sites',
    pk: 'entity_id',
    autoPk: false,
    description: 'بيانات الموارد الطبيعية (مساحة وسعة وحالة واستخدام) لموقع مسجل ككيان.',
    fields: [
      naturalKeyField('entity_id', 'الموقع', ENTITY, 'المعرّف الأساسي: مرجع الكيان نفسه.'),
      field('resource_type_id', 'نوع المورد الطبيعي', 'reference', { required: true, ref: REFERENCE }),
      amountField('area_value', 'المساحة'),
      field('area_unit_id', 'وحدة المساحة', 'unit', { ref: UNIT }),
      amountField('capacity_value', 'السعة'),
      field('capacity_unit_id', 'وحدة السعة', 'unit', { ref: UNIT }),
      field('condition_id', 'الحالة الراهنة', 'reference', { ref: REFERENCE }),
      field('use_type_id', 'نوع الاستخدام', 'reference', { ref: REFERENCE }),
      sourceField(),
      notesField()
    ]
  },
  {
    key: 'landUseRecords',
    labelAr: 'سجلات استخدامات الأراضي',
    layer: 'records',
    table: 'land_use_records',
    pk: 'land_use_record_id',
    autoPk: true,
    description: 'مساحات استخدامات الأراضي في وحدة جغرافية وفترة حسب النوع والملكية والتربة.',
    fields: [
      idField('land_use_record_id', 'معرّف سجل استخدام الأرض'),
      field('geo_unit_id', 'الوحدة الجغرافية', 'geo', { required: true, ref: GEO }),
      field('period_id', 'الفترة المرجعية', 'period', { required: true, ref: PERIOD }),
      field('land_use_type_id', 'نوع استخدام الأرض', 'reference', { required: true, ref: REFERENCE }),
      field('ownership_type_id', 'نوع الملكية', 'reference', { ref: REFERENCE }),
      field('soil_type_id', 'نوع التربة', 'reference', { ref: REFERENCE }),
      amountField('area_value', 'المساحة', true),
      field('area_unit_id', 'وحدة المساحة', 'unit', { required: true, ref: UNIT }),
      field('irrigated', 'مروية', 'boolean'),
      field('irrigation_source_id', 'مصدر الري', 'reference', { ref: REFERENCE }),
      sourceField(),
      notesField()
    ]
  },
  {
    key: 'agriculturalProductionRecords',
    labelAr: 'سجلات الإنتاج الزراعي',
    layer: 'records',
    table: 'agricultural_production_records',
    pk: 'production_record_id',
    autoPk: true,
    description: 'إنتاج المحاصيل بحسب الوحدة الجغرافية والفترة: المساحة والكمية والإنتاجية والمبيعات.',
    fields: [
      idField('production_record_id', 'معرّف سجل الإنتاج'),
      field('geo_unit_id', 'الوحدة الجغرافية', 'geo', { required: true, ref: GEO }),
      field('producer_entity_id', 'المنتج', 'entity', { ref: ENTITY }),
      field('period_id', 'الفترة المرجعية', 'period', { required: true, ref: PERIOD }),
      field('crop_type_id', 'نوع المحصول', 'reference', { required: true, ref: REFERENCE }),
      field('crop_category_id', 'فئة المحصول', 'reference', { ref: REFERENCE }),
      amountField('cultivated_area', 'المساحة المزروعة'),
      field('area_unit_id', 'وحدة المساحة', 'unit', { ref: UNIT }),
      amountField('production_quantity', 'كمية الإنتاج'),
      field('production_unit_id', 'وحدة كمية الإنتاج', 'unit', { ref: UNIT }),
      amountField('yield_value', 'الإنتاجية'),
      field('yield_unit_id', 'وحدة الإنتاجية', 'unit', { ref: UNIT }),
      field('irrigation_source_id', 'مصدر الري', 'reference', { ref: REFERENCE }),
      amountField('sales_quantity', 'الكمية المباعة'),
      amountField('sales_value', 'قيمة المبيعات'),
      currencyField(),
      sourceField(),
      notesField()
    ]
  },
  {
    key: 'livestockProductionRecords',
    labelAr: 'سجلات الإنتاج الحيواني',
    layer: 'records',
    table: 'livestock_production_records',
    pk: 'livestock_record_id',
    autoPk: true,
    description: 'أعداد الثروة الحيوانية والمربين والإصابات والوفيات والنفوق حسب النوع والفترة.',
    fields: [
      idField('livestock_record_id', 'معرّف سجل الثروة الحيوانية'),
      field('geo_unit_id', 'الوحدة الجغرافية', 'geo', { required: true, ref: GEO }),
      field('producer_entity_id', 'المربي', 'entity', { ref: ENTITY }),
      field('period_id', 'الفترة المرجعية', 'period', { required: true, ref: PERIOD }),
      field('species_id', 'نوع الحيوان', 'reference', { required: true, ref: REFERENCE }),
      countField('animal_count', 'عدد الرؤوس'),
      countField('producer_count', 'عدد المربين'),
      amountField('average_holding', 'متوسط الحيازة'),
      field('disease_id', 'المرض الحيواني', 'reference', { ref: REFERENCE }),
      countField('infected_count', 'عدد الإصابات'),
      countField('deaths_count', 'عدد الوفيات'),
      field('treatment_type_id', 'نوع المعالجة', 'reference', { ref: REFERENCE }),
      sourceField(),
      notesField()
    ]
  },
  {
    key: 'fisheriesProductionRecords',
    labelAr: 'سجلات الإنتاج السمكي',
    layer: 'records',
    table: 'fisheries_production_records',
    pk: 'fishery_record_id',
    autoPk: true,
    description: 'الإنتاج السمكي وأعداد القوارب والصيادين وحجم التصدير في منطقة صيد وفترة.',
    fields: [
      idField('fishery_record_id', 'معرّف سجل الصيد'),
      field('geo_unit_id', 'الوحدة الجغرافية', 'geo', { required: true, ref: GEO }),
      field('operator_entity_id', 'المشغل', 'entity', { ref: ENTITY }),
      field('period_id', 'الفترة المرجعية', 'period', { required: true, ref: PERIOD }),
      field('fishery_zone_id', 'منطقة الصيد', 'reference', { ref: REFERENCE }),
      field('vessel_type_id', 'نوع قارب الصيد', 'reference', { ref: REFERENCE }),
      countField('vessel_count', 'عدد القوارب'),
      countField('fisher_count', 'عدد الصيادين'),
      amountField('production_quantity', 'كمية الإنتاج'),
      field('production_unit_id', 'وحدة كمية الإنتاج', 'unit', { ref: UNIT }),
      amountField('export_quantity', 'كمية التصدير'),
      sourceField(),
      notesField()
    ]
  },
  {
    key: 'economicEstablishments',
    labelAr: 'المنشآت الاقتصادية',
    layer: 'records',
    table: 'economic_establishments',
    pk: 'entity_id',
    autoPk: false,
    description: 'بيانات المنشأة الاقتصادية: النشاط والحجم والملكية والعاملون والإنتاج والمواد الخام.',
    fields: [
      naturalKeyField('entity_id', 'المنشأة', ENTITY, 'المعرّف الأساسي: مرجع الكيان نفسه.'),
      field('activity_type_id', 'النشاط الاقتصادي', 'reference', { required: true, ref: REFERENCE }),
      field('establishment_size_id', 'حجم المنشأة', 'reference', { ref: REFERENCE }),
      field('ownership_type_id', 'نوع الملكية', 'reference', { ref: REFERENCE }),
      countField('employee_count', 'عدد العاملين'),
      countField('female_employee_count', 'عدد العاملات'),
      amountField('annual_production_quantity', 'كمية الإنتاج السنوي'),
      field('annual_production_unit_id', 'وحدة الإنتاج السنوي', 'unit', { ref: UNIT }),
      amountField('annual_production_value', 'قيمة الإنتاج السنوي'),
      currencyField(),
      field('raw_material_type_id', 'نوع المادة الخام', 'reference', { ref: REFERENCE }),
      field('raw_material_origin_id', 'مصدر المادة الخام', 'reference', { ref: REFERENCE }),
      sourceField()
    ]
  },
  {
    key: 'tourismSiteProfiles',
    labelAr: 'ملفات المواقع السياحية',
    layer: 'records',
    table: 'tourism_site_profiles',
    pk: 'entity_id',
    autoPk: false,
    description: 'الملف التعريفي للموقع السياحي: النوع وإمكانية الوصول ووصف الخدمات المتاحة.',
    fields: [
      naturalKeyField('entity_id', 'الموقع السياحي', ENTITY, 'المعرّف الأساسي: مرجع الكيان نفسه.'),
      field('tourism_type_id', 'نوع السياحة', 'reference', { ref: REFERENCE }),
      field('accessibility_id', 'إمكانية الوصول', 'reference', { ref: REFERENCE }),
      field('visitor_services_description', 'وصف الخدمات المتاحة للزوار', 'long_text', { allowEmpty: true }),
      sourceField()
    ]
  },
  {
    key: 'culturalHeritageProfiles',
    labelAr: 'ملفات الموروث الثقافي',
    layer: 'records',
    table: 'cultural_heritage_profiles',
    pk: 'entity_id',
    autoPk: false,
    description: 'الملف التعريفي لعنصر الموروث الثقافي: النوع وموسم الممارسة والوضع وإجراءات الصون.',
    fields: [
      naturalKeyField('entity_id', 'عنصر الموروث', ENTITY, 'المعرّف الأساسي: مرجع الكيان نفسه.'),
      field('heritage_type_id', 'نوع الموروث', 'reference', { required: true, ref: REFERENCE }),
      field('practice_season', 'موسم الممارسة', 'text', { allowEmpty: true }),
      field('current_condition_id', 'الوضع الحالي', 'reference', { ref: REFERENCE }),
      field('description', 'وصف الموروث', 'long_text', { allowEmpty: true }),
      field('preservation_measures', 'إجراءات الصون', 'long_text', { allowEmpty: true }),
      sourceField()
    ]
  },
  {
    key: 'educationEnrollmentRecords',
    labelAr: 'سجلات الالتحاق بالتعليم',
    layer: 'records',
    table: 'education_enrollment_records',
    pk: 'enrollment_record_id',
    autoPk: true,
    description: 'أعداد المستهدفين والملتحقين والمتسربين والمعلمين حسب المستوى والصف والجنس والفئة العمرية.',
    fields: [
      idField('enrollment_record_id', 'معرّف سجل الالتحاق'),
      field('geo_unit_id', 'الوحدة الجغرافية', 'geo', { required: true, ref: GEO }),
      field('facility_entity_id', 'المرفق التعليمي', 'entity', { ref: ENTITY }),
      field('period_id', 'الفترة المرجعية', 'period', { required: true, ref: PERIOD }),
      field('education_level_id', 'المستوى التعليمي', 'reference', { required: true, ref: REFERENCE }),
      field('grade_id', 'الصف الدراسي', 'reference', { ref: REFERENCE }),
      field('sex_value_id', 'الجنس', 'dimension', { ref: DIMENSION_SEX }),
      field('age_group_value_id', 'الفئة العمرية', 'dimension', { ref: DIMENSION_AGE_GROUP }),
      countField('target_count', 'عدد المستهدفين'),
      countField('enrolled_count', 'عدد الملتحقين'),
      countField('dropout_count', 'عدد المتسربين'),
      countField('teacher_count', 'عدد المعلمين'),
      sourceField(),
      notesField()
    ]
  },
  {
    key: 'healthServiceRecords',
    labelAr: 'سجلات الخدمات الصحية',
    layer: 'records',
    table: 'health_service_records',
    pk: 'health_service_record_id',
    autoPk: true,
    description: 'الخدمات الصحية المقدمة والحالات والوفيات حسب المرفق والمرض والجنس والفئة العمرية.',
    fields: [
      idField('health_service_record_id', 'معرّف سجل الخدمة الصحية'),
      field('geo_unit_id', 'الوحدة الجغرافية', 'geo', { required: true, ref: GEO }),
      field('facility_entity_id', 'المرفق الصحي', 'entity', { ref: ENTITY }),
      field('period_id', 'الفترة المرجعية', 'period', { required: true, ref: PERIOD }),
      field('service_type_id', 'نوع الخدمة الصحية', 'reference', { ref: REFERENCE }),
      field('disease_id', 'المرض', 'reference', { ref: REFERENCE }),
      field('sex_value_id', 'الجنس', 'dimension', { ref: DIMENSION_SEX }),
      field('age_group_value_id', 'الفئة العمرية', 'dimension', { ref: DIMENSION_AGE_GROUP }),
      countField('target_count', 'عدد المستهدفين'),
      countField('served_count', 'عدد المستفيدين'),
      countField('case_count', 'عدد الحالات'),
      countField('death_count', 'عدد الوفيات'),
      sourceField(),
      notesField()
    ]
  },
  {
    key: 'householdWelfareRecords',
    labelAr: 'سجلات الرفاه الأسري',
    layer: 'records',
    table: 'household_welfare_records',
    pk: 'welfare_record_id',
    autoPk: true,
    description: 'أعداد الأسر والفقراء ومستوى الدخل والإنفاق مقارنة بخط الفقر في وحدة جغرافية وفترة.',
    fields: [
      idField('welfare_record_id', 'معرّف سجل الرفاه'),
      field('geo_unit_id', 'الوحدة الجغرافية', 'geo', { required: true, ref: GEO }),
      field('period_id', 'الفترة المرجعية', 'period', { required: true, ref: PERIOD }),
      field('poverty_line_type_id', 'نوع خط الفقر', 'reference', { ref: REFERENCE }),
      field('welfare_category_id', 'فئة الرفاه', 'reference', { ref: REFERENCE }),
      countField('household_count', 'عدد الأسر'),
      countField('poor_household_count', 'عدد الأسر الفقيرة'),
      amountField('income_value', 'قيمة الدخل'),
      amountField('expenditure_value', 'قيمة الإنفاق'),
      currencyField(),
      sourceField(),
      notesField()
    ]
  },
  {
    key: 'socialProtectionRecords',
    labelAr: 'سجلات الحماية الاجتماعية',
    layer: 'records',
    table: 'social_protection_records',
    pk: 'protection_record_id',
    autoPk: true,
    description: 'أعداد المستحقين والمستفيدين والمبالغ المنصرفة من برامج الحماية الاجتماعية ودورة الصرف.',
    fields: [
      idField('protection_record_id', 'معرّف سجل الحماية'),
      field('geo_unit_id', 'الوحدة الجغرافية', 'geo', { required: true, ref: GEO }),
      field('period_id', 'الفترة المرجعية', 'period', { required: true, ref: PERIOD }),
      field('beneficiary_group_id', 'فئة المستفيدين', 'reference', { ref: REFERENCE }),
      field('implementing_entity_id', 'الجهة المنفذة', 'entity', { ref: ENTITY }),
      countField('eligible_count', 'عدد المستحقين'),
      countField('beneficiary_count', 'عدد المستفيدين'),
      amountField('amount_paid', 'المبلغ المنصرف'),
      currencyField(),
      field('payment_cycle_id', 'دورة الصرف', 'reference', { ref: REFERENCE }),
      sourceField(),
      notesField()
    ]
  }
];

// ---------------------------------------------------------------------------
// Layer: analysis — SWOT/PESTLE, development issues, priorities.
// ---------------------------------------------------------------------------

const ANALYSIS_DATASETS = [
  {
    key: 'swotPestleAnalyses',
    labelAr: 'تحليلات SWOT وPESTLE',
    layer: 'analysis',
    table: 'swot_pestle_analyses',
    pk: 'analysis_id',
    autoPk: true,
    description: 'عوامل التحليل الرباعي SWOT أو البيئي PESTLE مع تقدير الأثر والاستجابة.',
    fields: [
      idField('analysis_id', 'معرّف التحليل'),
      field('geo_unit_id', 'الوحدة الجغرافية', 'geo', { required: true, ref: GEO }),
      field('period_id', 'الفترة المرجعية', 'period', { ref: PERIOD }),
      field('analysis_type', 'نوع التحليل', 'text', { required: true, enum: ['swot', 'pestle'] }),
      field('factor_type', 'نوع العامل', 'text', {
        required: true,
        note: 'بلا قيد CHECK في المخطط: strength/weakness/opportunity/threat لتحليل SWOT، وpolitical/economic/social/technological/legal/environmental لتحليل PESTLE.'
      }),
      field('title', 'العنوان', 'text', { required: true }),
      field('description', 'الوصف', 'long_text', { allowEmpty: true }),
      field('evidence_summary', 'ملخص الأدلة', 'long_text', { allowEmpty: true }),
      field('impact_direction', 'اتجاه الأثر', 'text', { allowEmpty: true }),
      field('impact_severity', 'شدة الأثر', 'decimal', { min: 0 }),
      field('time_horizon', 'المدى الزمني', 'text', { allowEmpty: true }),
      field('response_strategy', 'استراتيجية الاستجابة', 'long_text', { allowEmpty: true }),
      sourceField()
    ]
  },
  {
    key: 'developmentIssueFactors',
    labelAr: 'عوامل القضايا التنموية',
    layer: 'analysis',
    table: 'development_issue_factors',
    pk: 'issue_factor_id',
    autoPk: true,
    description: 'أسباب القضية التنموية وآثارها وقيودها وفرصها ومخاطرها مع درجة الشدة.',
    fields: [
      idField('issue_factor_id', 'معرّف عامل القضية'),
      field('issue_id', 'القضية التنموية', 'reference', { required: true, ref: ISSUE }),
      field('factor_type', 'نوع العامل', 'text', {
        required: true,
        enum: ['direct_cause', 'root_cause', 'effect', 'constraint', 'opportunity', 'risk']
      }),
      field('description', 'وصف العامل', 'long_text', { required: true }),
      field('severity', 'درجة الشدة', 'decimal', { min: 0 }),
      sourceField()
    ]
  },
  {
    key: 'developmentIssueEvidence',
    labelAr: 'أدلة القضايا التنموية',
    layer: 'analysis',
    table: 'development_issue_evidence',
    pk: 'issue_evidence_id',
    autoPk: true,
    description: 'الدليل الداعم للقضية التنموية مع جغرافيته وفترته ومصدره ودرجة ثقته.',
    fields: [
      idField('issue_evidence_id', 'معرّف الدليل'),
      field('issue_id', 'القضية التنموية', 'reference', { required: true, ref: ISSUE }),
      sourceField(),
      field('evidence_type', 'نوع الدليل', 'text', { required: true }),
      field('description', 'وصف الدليل', 'long_text', { allowEmpty: true }),
      field('geo_unit_id', 'الوحدة الجغرافية', 'geo', { ref: GEO }),
      field('period_id', 'الفترة المرجعية', 'period', { ref: PERIOD }),
      field('source_locator', 'موضع الدليل في المصدر', 'text', { allowEmpty: true }),
      field('confidence', 'درجة الثقة', 'decimal', { min: 0, max: 1 })
    ]
  },
  {
    key: 'priorityCriteria',
    labelAr: 'معايير الأولوية',
    layer: 'analysis',
    table: 'priority_criteria',
    pk: 'criterion_id',
    autoPk: true,
    description: 'معايير ترجيح أولويات القضايا بأوزانها الافتراضية واتجاهها ومقياسها.',
    fields: [
      idField('criterion_id', 'معرّف المعيار'),
      field('criterion_code', 'رمز المعيار', 'text', { required: true }),
      field('name_ar', 'اسم المعيار', 'text', { required: true }),
      field('description', 'وصف المعيار', 'long_text', { allowEmpty: true }),
      amountField('default_weight', 'الوزن الافتراضي', true),
      field('direction', 'اتجاه الترجيح', 'text', {
        required: false,
        note: 'القيمة الافتراضية higher_is_higher؛ لا يوجد قيد CHECK على القيم.'
      }),
      field('scale_min', 'الحد الأدنى للمقياس', 'decimal', { note: 'يجب أن يكون أصغر من الحد الأعلى عند تعبئتهما.' }),
      field('scale_max', 'الحد الأعلى للمقياس', 'decimal', { note: 'يجب أن يكون أكبر من الحد الأدنى عند تعبئتهما.' }),
      field('is_active', 'فعال', 'boolean', { required: false })
    ]
  },
  {
    key: 'issuePriorityAssessments',
    labelAr: 'تقييمات أولوية القضايا',
    layer: 'analysis',
    table: 'issue_priority_assessments',
    pk: 'assessment_id',
    autoPk: true,
    description: 'درجة القضية التنموية على معيار أولوية مع الوزن المطبق والدرجة المرجحة والمبرر.',
    fields: [
      idField('assessment_id', 'معرّف التقييم'),
      field('issue_id', 'القضية التنموية', 'reference', { required: true, ref: ISSUE }),
      field('criterion_id', 'معيار الأولوية', 'reference', { required: true, ref: CRITERION }),
      field('period_id', 'الفترة المرجعية', 'period', { ref: PERIOD }),
      field('raw_score', 'الدرجة الخام', 'decimal', { required: true }),
      field('normalized_score', 'الدرجة المعيارية', 'decimal'),
      amountField('applied_weight', 'الوزن المطبق', true),
      field('weighted_score', 'الدرجة المرجحة', 'decimal', { required: true }),
      field('rationale', 'مبرر التقييم', 'long_text', { allowEmpty: true }),
      sourceField(),
      field('assessed_by', 'المقيّم', 'text', { allowEmpty: true }),
      field('assessed_at', 'وقت التقييم', 'datetime', { required: true })
    ]
  }
];

// ---------------------------------------------------------------------------
// Layer: planning — objectives, programs, projects, activities, milestones.
// ---------------------------------------------------------------------------

const PLANNING_DATASETS = [
  {
    key: 'strategicObjectives',
    labelAr: 'الأهداف الاستراتيجية',
    layer: 'planning',
    table: 'strategic_objectives',
    pk: 'objective_id',
    autoPk: true,
    description: 'أهداف الخطة التنموية بمستوياتها وقيمها الأساسية والمستهدفة ووحداتها وفتراتها.',
    fields: [
      idField('objective_id', 'معرّف الهدف'),
      field('plan_id', 'الخطة التنموية', 'reference', { ref: PLAN }),
      field('parent_objective_id', 'الهدف الأعلى', 'reference', { ref: OBJECTIVE }),
      field('objective_code', 'رمز الهدف', 'text', { required: true }),
      field('objective_level', 'مستوى الهدف', 'text', { required: true, enum: ['strategic', 'general', 'specific', 'operational'] }),
      field('title', 'عنوان الهدف', 'text', { required: true }),
      field('description', 'وصف الهدف', 'long_text', { allowEmpty: true }),
      field('sector_id', 'القطاع', 'sector', { ref: SECTOR }),
      field('baseline_value', 'القيمة الأساسية', 'decimal'),
      field('target_value', 'القيمة المستهدفة', 'decimal'),
      field('target_unit_id', 'وحدة القيمة المستهدفة', 'unit', { ref: UNIT }),
      field('target_period_id', 'فترة الاستهداف', 'period', { ref: PERIOD }),
      field('responsible_entity_id', 'الجهة المسؤولة', 'entity', { ref: ENTITY }),
      sourceField()
    ]
  },
  {
    key: 'developmentPrograms',
    labelAr: 'البرامج التنموية',
    layer: 'planning',
    table: 'development_programs',
    pk: 'program_id',
    autoPk: true,
    description: 'البرامج التنموية وربطها بالهدف والقطاع وفترة البداية والنهاية والحالة.',
    fields: [
      idField('program_id', 'معرّف البرنامج'),
      field('plan_id', 'الخطة التنموية', 'reference', { ref: PLAN }),
      field('objective_id', 'الهدف الاستراتيجي', 'reference', { ref: OBJECTIVE }),
      field('parent_program_id', 'البرنامج الأعلى', 'reference', { ref: PROGRAM }),
      field('program_code', 'رمز البرنامج', 'text', { required: true }),
      field('program_name', 'اسم البرنامج', 'text', { required: true }),
      field('program_description', 'وصف البرنامج', 'long_text', { allowEmpty: true }),
      field('sector_id', 'القطاع', 'sector', { ref: SECTOR }),
      field('start_period_id', 'فترة البداية', 'period', { ref: PERIOD }),
      field('end_period_id', 'فترة النهاية', 'period', { ref: PERIOD }),
      field('program_status', 'حالة البرنامج', 'text', {
        required: false,
        note: 'القيمة الافتراضية draft؛ لا يوجد قيد CHECK على القيم.'
      }),
      sourceField()
    ]
  },
  {
    key: 'programProjects',
    labelAr: 'ربط البرامج بالمشاريع',
    layer: 'planning',
    table: 'program_projects',
    pk: 'program_id',
    primaryKey: ['program_id', 'project_id', 'relationship_type'],
    autoPk: false,
    description: 'جدول ربط: أي مشروع ينفذ أي برنامج وبأي نوع علاقة.',
    fields: [
      field('program_id', 'البرنامج', 'reference', { required: true, ref: PROGRAM }),
      field('project_id', 'المشروع', 'reference', { required: true, ref: PROJECT }),
      field('relationship_type', 'نوع العلاقة', 'text', {
        required: false,
        note: 'القيمة الافتراضية implements؛ لا يوجد قيد CHECK على القيم.'
      })
    ]
  },
  {
    key: 'projectActivities',
    labelAr: 'أنشطة المشاريع',
    layer: 'planning',
    table: 'project_activities',
    pk: 'activity_id',
    autoPk: true,
    description: 'أنشطة المشروع وتسلسلها الزمني والجهة المسؤولة عنها ونسبة إنجازها.',
    fields: [
      idField('activity_id', 'معرّف النشاط'),
      field('project_id', 'المشروع', 'reference', { required: true, ref: PROJECT }),
      field('parent_activity_id', 'النشاط الأعلى', 'reference', { ref: ACTIVITY }),
      field('activity_code', 'رمز النشاط', 'text', { allowEmpty: true }),
      field('activity_name', 'اسم النشاط', 'text', { required: true }),
      field('description', 'وصف النشاط', 'long_text', { allowEmpty: true }),
      field('start_date', 'تاريخ البداية', 'date'),
      field('end_date', 'تاريخ النهاية', 'date', { note: 'يجب ألا يسبق تاريخ البداية.' }),
      field('responsible_entity_id', 'الجهة المسؤولة', 'entity', { ref: ENTITY }),
      field('activity_status', 'حالة النشاط', 'text', {
        required: false,
        note: 'القيمة الافتراضية planned؛ لا يوجد قيد CHECK على القيم.'
      }),
      field('progress_ratio', 'نسبة الإنجاز', 'decimal', { min: 0, max: 1 }),
      sourceField()
    ]
  },
  {
    key: 'projectMilestones',
    labelAr: 'مراحل إنجاز المشاريع',
    layer: 'planning',
    table: 'project_milestones',
    pk: 'milestone_id',
    autoPk: true,
    description: 'المعالم الرئيسية للمشروع بتواريخها المستحقة والفعلية وحالتها ودليلها.',
    fields: [
      idField('milestone_id', 'معرّف المعلم'),
      field('project_id', 'المشروع', 'reference', { required: true, ref: PROJECT }),
      field('milestone_name', 'اسم المعلم', 'text', { required: true }),
      field('due_date', 'التاريخ المستحق', 'date'),
      field('achieved_date', 'تاريخ التحقق', 'date'),
      field('milestone_status', 'حالة المعلم', 'text', {
        required: false,
        note: 'القيمة الافتراضية planned؛ لا يوجد قيد CHECK على القيم.'
      }),
      field('evidence_source_id', 'مصدر الدليل', 'reference', { ref: SOURCE }),
      field('notes', 'ملاحظات', 'long_text', { allowEmpty: true })
    ]
  },
  {
    key: 'projectGeographicUnits',
    labelAr: 'التغطية الجغرافية للمشاريع',
    layer: 'planning',
    table: 'project_geographic_units',
    pk: 'project_id',
    primaryKey: ['project_id', 'geo_unit_id', 'role'],
    autoPk: false,
    description: 'جدول ربط: الوحدات الجغرافية التي يغطيها المشروع ودور كل وحدة فيه.',
    fields: [
      field('project_id', 'المشروع', 'reference', { required: true, ref: PROJECT }),
      field('geo_unit_id', 'الوحدة الجغرافية', 'geo', { required: true, ref: GEO }),
      field('role', 'دور الوحدة الجغرافية', 'text', {
        required: false,
        note: 'القيمة الافتراضية beneficiary_area؛ لا يوجد قيد CHECK على القيم.'
      })
    ]
  },
  {
    key: 'projectBeneficiaryTargets',
    labelAr: 'مستهدفات المستفيدين',
    layer: 'planning',
    table: 'project_beneficiary_targets',
    pk: 'beneficiary_target_id',
    autoPk: true,
    description: 'أعداد المستفيدين المستهدفين والفعليين للمشروع حسب الفئة والوحدة الجغرافية والفترة.',
    fields: [
      idField('beneficiary_target_id', 'معرّف مستهدف المستفيدين'),
      field('project_id', 'المشروع', 'reference', { required: true, ref: PROJECT }),
      field('beneficiary_group_id', 'فئة المستفيدين', 'reference', { ref: REFERENCE }),
      field('geo_unit_id', 'الوحدة الجغرافية', 'geo', { ref: GEO }),
      countField('target_count', 'العدد المستهدف'),
      countField('actual_count', 'العدد الفعلي'),
      field('period_id', 'الفترة المرجعية', 'period', { ref: PERIOD }),
      sourceField()
    ]
  }
];

// ---------------------------------------------------------------------------
// Layer: finance — chart of accounts, budgets, revenue and expenditure.
// ---------------------------------------------------------------------------

const FINANCE_DATASETS = [
  {
    key: 'financialAccounts',
    labelAr: 'دليل الحسابات المالية',
    layer: 'finance',
    table: 'financial_accounts',
    pk: 'account_id',
    autoPk: true,
    description: 'شجرة الحسابات المالية: الرمز والاسم والنوع والحساب الأعلى وحالة الفعالية.',
    fields: [
      idField('account_id', 'معرّف الحساب'),
      field('account_code', 'رمز الحساب', 'text', { required: true }),
      field('account_name_ar', 'اسم الحساب', 'text', { required: true }),
      field('account_type', 'نوع الحساب', 'text', {
        required: true,
        enum: ['revenue', 'expenditure', 'transfer', 'asset', 'liability', 'funding']
      }),
      field('parent_account_id', 'الحساب الأعلى', 'account', { ref: ACCOUNT_SELF }),
      field('is_active', 'فعال', 'boolean', { required: false })
    ]
  },
  {
    key: 'budgetHeaders',
    labelAr: 'رؤوس الموازنات',
    layer: 'finance',
    table: 'budget_headers',
    pk: 'budget_id',
    autoPk: true,
    description: 'الموازنة على مستوى الوحدة الجغرافية والفترة: الرمز والاسم والحالة والعملة والاعتماد.',
    fields: [
      idField('budget_id', 'معرّف الموازنة'),
      field('geo_unit_id', 'الوحدة الجغرافية', 'geo', { ref: GEO }),
      field('period_id', 'الفترة المرجعية', 'period', { required: true, ref: PERIOD }),
      field('budget_code', 'رمز الموازنة', 'text', { required: true }),
      field('budget_name', 'اسم الموازنة', 'text', { required: true }),
      field('budget_status', 'حالة الموازنة', 'text', {
        required: false,
        note: 'القيمة الافتراضية draft؛ لا يوجد قيد CHECK على القيم.'
      }),
      currencyField(true),
      field('approved_at', 'تاريخ الاعتماد', 'datetime'),
      sourceField()
    ]
  },
  {
    key: 'budgetLines',
    labelAr: 'بنود الموازنة',
    layer: 'finance',
    table: 'budget_lines',
    pk: 'budget_line_id',
    autoPk: true,
    description: 'بنود الموازنة حسب الحساب والقطاع: المبلغ المعتمد والمعدل والفعلي وعملته.',
    fields: [
      idField('budget_line_id', 'معرّف بند الموازنة'),
      field('budget_id', 'الموازنة', 'reference', { required: true, ref: BUDGET }),
      field('account_id', 'الحساب المالي', 'account', { required: true, ref: ACCOUNT }),
      field('sector_id', 'القطاع', 'sector', { ref: SECTOR }),
      amountField('approved_amount', 'المبلغ المعتمد', false),
      amountField('revised_amount', 'المبلغ المعدل'),
      amountField('actual_amount', 'المبلغ الفعلي'),
      currencyField(true),
      sourceField(),
      notesField()
    ]
  },
  {
    key: 'revenueTransactions',
    labelAr: 'حركات الإيرادات',
    layer: 'finance',
    table: 'revenue_transactions',
    pk: 'revenue_transaction_id',
    autoPk: true,
    description: 'الإيراد المحصل والربط والمورّد على مستوى الوحدة الجغرافية والفترة والحساب.',
    fields: [
      idField('revenue_transaction_id', 'معرّف حركة الإيراد'),
      field('geo_unit_id', 'الوحدة الجغرافية', 'geo', { required: true, ref: GEO }),
      field('period_id', 'الفترة المرجعية', 'period', { required: true, ref: PERIOD }),
      field('account_id', 'الحساب المالي', 'account', { required: true, ref: ACCOUNT }),
      field('collecting_entity_id', 'الجهة المحصلة', 'entity', { ref: ENTITY }),
      amountField('assessed_amount', 'قيمة الربط'),
      amountField('collected_amount', 'المبلغ المحصل', true),
      amountField('remitted_amount', 'المبلغ المورّد'),
      currencyField(true),
      field('transaction_date', 'تاريخ الحركة', 'date'),
      sourceField()
    ]
  },
  {
    key: 'expenditureTransactions',
    labelAr: 'حركات الإنفاق',
    layer: 'finance',
    table: 'expenditure_transactions',
    pk: 'expenditure_transaction_id',
    autoPk: true,
    description: 'المنصرف الفعلي على مستوى الوحدة الجغرافية والفترة والحساب والمشروع.',
    fields: [
      idField('expenditure_transaction_id', 'معرّف حركة الإنفاق'),
      field('geo_unit_id', 'الوحدة الجغرافية', 'geo', { required: true, ref: GEO }),
      field('period_id', 'الفترة المرجعية', 'period', { required: true, ref: PERIOD }),
      field('account_id', 'الحساب المالي', 'account', { required: true, ref: ACCOUNT }),
      field('project_id', 'المشروع', 'reference', { ref: PROJECT }),
      amountField('paid_amount', 'المبلغ المنصرف', true),
      currencyField(true),
      field('transaction_date', 'تاريخ الحركة', 'date'),
      field('expenditure_status', 'حالة الإنفاق', 'text', { allowEmpty: true }),
      sourceField()
    ]
  }
];

// ---------------------------------------------------------------------------
// Layer: indicators — versioned definitions, components, weights, targets.
// ---------------------------------------------------------------------------

const INDICATOR_DATASETS = [
  {
    key: 'indicatorDefinitionVersions',
    labelAr: 'إصدارات تعريف المؤشرات',
    layer: 'indicators',
    table: 'indicator_definition_versions',
    pk: 'indicator_version_id',
    autoPk: true,
    description: 'الإصدار المجمّد لتعريف المؤشر ومنهجيته وفترة سريانه وجهة اعتماده.',
    fields: [
      idField('indicator_version_id', 'معرّف إصدار المؤشر'),
      field('indicator_id', 'المؤشر', 'reference', { required: true, ref: INDICATOR }),
      field('version_number', 'رقم الإصدار', 'integer', { required: true, min: 1 }),
      field('definition_json', 'تعريف المؤشر (JSON)', 'long_text', { required: true }),
      field('methodology', 'المنهجية', 'long_text', { allowEmpty: true }),
      field('formula_version', 'إصدار المعادلة', 'text', { allowEmpty: true }),
      field('effective_from', 'ساري من', 'date'),
      field('effective_to', 'ساري إلى', 'date', { note: 'يجب ألا يسبق تاريخ السريان.' }),
      field('change_reason', 'سبب التغيير', 'long_text', { allowEmpty: true }),
      field('approved_by', 'المعتمد', 'text', { allowEmpty: true }),
      field('approved_at', 'تاريخ الاعتماد', 'datetime')
    ]
  },
  {
    key: 'indicatorComponents',
    labelAr: 'مكونات المؤشرات',
    layer: 'indicators',
    table: 'indicator_components',
    pk: 'component_id',
    autoPk: true,
    description: 'مكونات معادلة المؤشر وأدوارها (بسط، مقام، مدخل، وزن، حد، ثابت) وتعبيراتها.',
    fields: [
      idField('component_id', 'معرّف المكوّن'),
      field('indicator_version_id', 'إصدار المؤشر', 'reference', { required: true, ref: INDICATOR_VERSION }),
      field('component_code', 'رمز المكوّن', 'text', { required: true }),
      field('component_role', 'دور المكوّن', 'text', {
        required: true,
        enum: ['numerator', 'denominator', 'input', 'weight', 'threshold', 'formula_constant']
      }),
      field('field_definition_id', 'تعريف الحقل المرجعي', 'reference', { ref: FIELD_DEFINITION }),
      field('source_indicator_id', 'المؤشر المصدر', 'reference', { ref: INDICATOR }),
      field('expression', 'التعبير الحسابي', 'long_text', { allowEmpty: true }),
      field('unit_id', 'وحدة القياس', 'unit', { ref: UNIT }),
      field('is_required', 'إلزامي', 'boolean', { required: false }),
      field('sort_order', 'ترتيب العرض', 'integer', { min: 0 })
    ]
  },
  {
    key: 'indicatorWeightProfiles',
    labelAr: 'ملفات أوزان المؤشرات',
    layer: 'indicators',
    table: 'indicator_weight_profiles',
    pk: 'weight_profile_id',
    autoPk: true,
    description: 'ملف أوزان المؤشرات ومنهجيته وجهة اعتماده وحالة تفعيله.',
    fields: [
      idField('weight_profile_id', 'معرّف ملف الأوزان'),
      field('profile_code', 'رمز الملف', 'text', { required: true }),
      field('profile_name', 'اسم الملف', 'text', { required: true }),
      field('description', 'وصف الملف', 'long_text', { allowEmpty: true }),
      field('methodology', 'المنهجية', 'long_text', { allowEmpty: true }),
      field('is_active', 'فعال', 'boolean', { required: false }),
      field('created_by', 'المنشئ', 'text', { allowEmpty: true }),
      field('approved_by', 'المعتمد', 'text', { allowEmpty: true }),
      field('approved_at', 'تاريخ الاعتماد', 'datetime')
    ]
  },
  {
    key: 'indicatorWeights',
    labelAr: 'أوزان المؤشرات',
    layer: 'indicators',
    table: 'indicator_weights',
    pk: 'indicator_weight_id',
    autoPk: true,
    description: 'وزن مؤشر داخل ملف أوزان محدد مع مبرره ومصدره.',
    fields: [
      idField('indicator_weight_id', 'معرّف الوزن'),
      field('weight_profile_id', 'ملف الأوزان', 'reference', { required: true, ref: refTo('indicator_weight_profiles', 'weight_profile_id', 'profile_name') }),
      field('indicator_id', 'المؤشر', 'reference', { required: true, ref: INDICATOR }),
      amountField('weight_value', 'قيمة الوزن', true),
      field('rationale', 'مبرر الوزن', 'long_text', { allowEmpty: true }),
      sourceField()
    ]
  },
  {
    key: 'indicatorTargets',
    labelAr: 'مستهدفات المؤشرات',
    layer: 'indicators',
    table: 'indicator_targets',
    pk: 'indicator_target_id',
    autoPk: true,
    description: 'القيمة المستهدفة للمؤشر بوحدة جغرافية وفترة ونوع مستهدف.',
    fields: [
      idField('indicator_target_id', 'معرّف المستهدف'),
      field('indicator_id', 'المؤشر', 'reference', { required: true, ref: INDICATOR }),
      field('geo_unit_id', 'الوحدة الجغرافية', 'geo', { ref: GEO }),
      field('period_id', 'الفترة المرجعية', 'period', { required: true, ref: PERIOD }),
      field('target_value', 'القيمة المستهدفة', 'decimal', { required: true }),
      field('unit_id', 'وحدة القياس', 'unit', { ref: UNIT }),
      field('target_type', 'نوع المستهدف', 'text', {
        required: false,
        note: 'القيمة الافتراضية official؛ لا يوجد قيد CHECK على القيم.'
      }),
      sourceField(),
      notesField()
    ]
  },
  {
    key: 'indicatorBenchmarks',
    labelAr: 'قيم المؤشرات المرجعية',
    layer: 'indicators',
    table: 'indicator_benchmarks',
    pk: 'benchmark_id',
    autoPk: true,
    description: 'القيمة المرجعية للمؤشر حسب نوع الوحدة الجغرافية ونوع المرجع وفترة صلاحيته.',
    fields: [
      idField('benchmark_id', 'معرّف القيمة المرجعية'),
      field('indicator_id', 'المؤشر', 'reference', { required: true, ref: INDICATOR }),
      field('geography_type_id', 'نوع الوحدة الجغرافية', 'reference', { ref: GEO_UNIT_TYPE }),
      field('benchmark_type', 'نوع المرجع', 'text', { required: true }),
      field('value_number', 'القيمة المرجعية', 'decimal', { required: true }),
      field('unit_id', 'وحدة القياس', 'unit', { ref: UNIT }),
      field('valid_from', 'ساري من', 'date'),
      field('valid_to', 'ساري إلى', 'date', { note: 'يجب ألا يسبق تاريخ السريان.' }),
      sourceField(),
      field('rationale', 'مبرر القيمة المرجعية', 'long_text', { allowEmpty: true })
    ]
  }
];

// ---------------------------------------------------------------------------
// Layer: dictionary — semantic field groups, aliases and dimension rules.
// ---------------------------------------------------------------------------

const DICTIONARY_DATASETS = [
  {
    key: 'fieldGroups',
    labelAr: 'مجموعات الحقول الدلالية',
    layer: 'dictionary',
    table: 'field_groups',
    pk: 'group_id',
    autoPk: true,
    description: 'هرمية المجال ثم المجال الفرعي ثم الفئة التي تُصنّف الحقول الدلالية.',
    fields: [
      idField('group_id', 'معرّف المجموعة'),
      field('group_code', 'رمز المجموعة', 'text', { required: true }),
      field('parent_group_id', 'المجموعة الأعلى', 'reference', { ref: GROUP_SELF }),
      field('group_level', 'مستوى المجموعة', 'text', { required: true, enum: ['domain', 'subdomain', 'category'] }),
      field('name_ar', 'الاسم العربي', 'text', { required: true }),
      field('name_en', 'الاسم الإنجليزي', 'text', { allowEmpty: true }),
      field('description', 'الوصف', 'long_text', { allowEmpty: true }),
      field('sort_order', 'ترتيب العرض', 'integer', { min: 0 }),
      field('is_active', 'فعال', 'boolean', { required: false })
    ]
  },
  {
    key: 'fieldGroupFields',
    labelAr: 'حقول المجموعات الدلالية',
    layer: 'dictionary',
    table: 'field_group_fields',
    pk: 'group_id',
    primaryKey: ['group_id', 'field_definition_id'],
    autoPk: false,
    description: 'جدول ربط: أي تعريف حقل ينتمي إلى أي مجموعة دلالية وبأي ترتيب.',
    fields: [
      field('group_id', 'المجموعة الدلالية', 'reference', { required: true, ref: GROUP_SELF }),
      field('field_definition_id', 'تعريف الحقل', 'reference', { required: true, ref: FIELD_DEFINITION }),
      field('sort_order', 'ترتيب العرض', 'integer', { min: 0 }),
      field('is_primary', 'الانتماء الأساسي', 'boolean', { required: false })
    ]
  },
  {
    key: 'fieldDefinitionAliases',
    labelAr: 'أسماء الحقول البديلة',
    layer: 'dictionary',
    table: 'field_definition_aliases',
    pk: 'alias_id',
    autoPk: true,
    description: 'الأسماء البديلة المعتمدة لتعريف الحقل ولغتها وطريقة مطابقتها ودرجة ثقتها.',
    fields: [
      idField('alias_id', 'معرّف الاسم البديل'),
      field('field_definition_id', 'تعريف الحقل', 'reference', { required: true, ref: FIELD_DEFINITION }),
      field('alias_text', 'نص الاسم البديل', 'text', { required: true }),
      field('normalized_alias', 'الاسم البديل المطبع', 'text', { required: true }),
      field('locale', 'اللغة', 'text', { required: false, note: 'القيمة الافتراضية ar.' }),
      field('is_approved', 'معتمد', 'boolean', { required: false }),
      field('match_method', 'طريقة المطابقة', 'text', { required: false, note: 'القيمة الافتراضية curated.' }),
      field('confidence', 'درجة الثقة', 'decimal', { min: 0, max: 1, required: false }),
      sourceField()
    ]
  },
  {
    key: 'fieldDimensionRules',
    labelAr: 'قواعد أبعاد الحقول',
    layer: 'dictionary',
    table: 'field_dimension_rules',
    pk: 'field_dimension_rule_id',
    autoPk: true,
    description: 'قواعد ربط تعريف الحقل بأبعاد التحليل وقيمها ودور المحور وإلزاميته.',
    fields: [
      idField('field_dimension_rule_id', 'معرّف القاعدة'),
      field('field_definition_id', 'تعريف الحقل', 'reference', { required: true, ref: FIELD_DEFINITION }),
      field('dimension_id', 'البعد التحليلي', 'reference', { required: true, ref: DIMENSION_DEFINITION }),
      field('dimension_value_id', 'قيمة البعد', 'dimension', { ref: DIMENSION }),
      field('axis_role', 'دور المحور', 'text', { required: false, note: 'القيمة الافتراضية breakdown؛ لا يوجد قيد CHECK على القيم.' }),
      field('is_required', 'إلزامي', 'boolean', { required: false }),
      field('sort_order', 'ترتيب العرض', 'integer', { min: 0 })
    ]
  }
];

// ---------------------------------------------------------------------------
// Public registry.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Layer: governance — development issues, plans, plan priorities and their links.
// These tables predate the unified model (architecture-v1.sql) and are the
// authoritative record for the analysis -> planning chain; they are registered
// here so the single data-access layer also owns them.
// ---------------------------------------------------------------------------

const GOVERNANCE_DATASETS = [
  {
    key: 'developmentIssues',
    labelAr: 'القضايا التنموية',
    layer: 'analysis',
    table: 'development_issues',
    pk: 'issue_id',
    autoPk: true,
    description: 'القضايا التنموية المرتبطة بالموقع والقطاع، وتُبنى عليها الأسباب والأدلة والأولويات.',
    fields: [
      idField('issue_id', 'معرّف القضية'),
      field('form_record_id', 'سجل النموذج', 'reference', { ref: refTo('form_records', 'form_record_id', 'record_code') }),
      field('geo_unit_id', 'الوحدة الجغرافية', 'geo', { ref: GEO }),
      field('sector_id', 'القطاع', 'sector', { ref: SECTOR }),
      field('issue_code', 'رمز القضية', 'text' ),
      field('issue_title', 'عنوان القضية', 'text', { required: true }),
      field('issue_description', 'وصف القضية', 'long_text', { allowEmpty: true }),
      field('general_challenge', 'التحدي العام', 'long_text', { allowEmpty: true }),
      amountField('population_share', 'نسبة السكان المتأثرين'),
      field('evidence_notes', 'ملاحظات الأدلة', 'long_text', { allowEmpty: true }),
      sourceField(),
    ]
  },
  {
    key: 'developmentPlans',
    labelAr: 'خطط التنمية',
    layer: 'planning',
    table: 'development_plans',
    pk: 'plan_id',
    autoPk: true,
    description: 'خطط التنمية المحلية التي ترتبط بها الأهداف والبرامج والأولويات.',
    fields: [
      idField('plan_id', 'معرّف الخطة'),
      field('geo_unit_id', 'الوحدة الجغرافية', 'geo', { ref: GEO }),
      field('period_id', 'الفترة المرجعية', 'period', { ref: PERIOD }),
      field('plan_code', 'رمز الخطة', 'text'),
      field('plan_name', 'اسم الخطة', 'text', { required: true }),
      field('general_goal', 'الهدف العام', 'long_text', { allowEmpty: true }),
      field('plan_status', 'حالة الخطة', 'text', { enum: ['draft', 'approved', 'active', 'closed'], note: 'القيمة الافتراضية draft؛ لا يوجد قيد CHECK في المخطط.' }),
      sourceField(),
      field('created_by', 'منشئ الخطة', 'text'),
    ]
  },
  {
    key: 'planPriorities',
    labelAr: 'أولويات الخطة',
    layer: 'planning',
    table: 'plan_priorities',
    pk: 'priority_id',
    autoPk: true,
    description: 'بنود أولويات الخطة: المحور والهدف والمشروع الفرعي وقيمة الاستهداف.',
    fields: [
      idField('priority_id', 'معرّف الأولوية'),
      field('plan_id', 'الخطة', 'reference', { required: true, ref: PLAN }),
      countField('priority_rank', 'الترتيب'),
      field('axis_name', 'المحور', 'text'),
      field('sector_id', 'القطاع', 'sector', { ref: SECTOR }),
      field('objective_text', 'نص الهدف', 'long_text', { allowEmpty: true }),
      field('sub_program_text', 'البرنامج الفرعي', 'long_text', { allowEmpty: true }),
      field('program_text', 'البرنامج', 'long_text', { allowEmpty: true }),
      amountField('target_value', 'القيمة المستهدفة'),
      field('target_unit_id', 'وحدة القيمة المستهدفة', 'unit', { ref: UNIT }),
      field('target_period_id', 'فترة الاستهداف', 'period', { ref: PERIOD }),
      field('source_record_id', 'سجل المصدر', 'reference', { ref: refTo('form_records', 'form_record_id', 'record_code') }),
    ]
  },
  {
    key: 'issuePlanLinks',
    labelAr: 'ربط القضايا بالأولويات',
    layer: 'planning',
    table: 'issue_plan_links',
    pk: 'issue_plan_link_id',
    autoPk: true,
    description: 'العلاقة بين القضية التنموية وبند الأولوية في الخطة.',
    fields: [
      idField('issue_plan_link_id', 'معرّف الربط'),
      field('issue_id', 'القضية', 'reference', { required: true, ref: ISSUE }),
      field('priority_id', 'بند الأولوية', 'reference', { required: true, ref: refTo('plan_priorities', 'priority_id', 'axis_name') }),
      field('relationship_type', 'نوع العلاقة', 'text', { required: true }),
      notesField(),
    ]
  }
];

const DATASETS = Object.freeze(Object.fromEntries(
  [...RECORD_DATASETS, ...ANALYSIS_DATASETS, ...GOVERNANCE_DATASETS, ...PLANNING_DATASETS, ...FINANCE_DATASETS, ...INDICATOR_DATASETS, ...DICTIONARY_DATASETS]
    .map(dataset => {
      const primaryKey = Object.freeze(dataset.primaryKey ? [...dataset.primaryKey] : [dataset.pk]);
      return [dataset.key, Object.freeze({
        ...dataset,
        primaryKey,
        autoPk: dataset.autoPk !== false,
        hasValueState: dataset.fields.some(item => item.name === 'value_state')
      })];
    })
));

// Resolve a dataset by camelCase key or by physical table name.
const DATASET_INDEX = Object.freeze(Object.fromEntries(
  Object.values(DATASETS).flatMap(dataset => [[dataset.key, dataset], [dataset.table, dataset]])
));

const lookupRefs = Object.freeze({
  reference: REFERENCE,
  dimension: DIMENSION,
  entity: ENTITY,
  geo: GEO,
  period: PERIOD,
  sector: SECTOR,
  unit: UNIT,
  account: ACCOUNT,
  currency: CURRENCY
});

function getDataset(key) {
  const name = typeof key === 'string' ? key.trim() : '';
  const dataset = name ? DATASET_INDEX[name] : undefined;
  if (!dataset) throw new Error(`مجموعة البيانات غير معروفة: ${name || '(فارغ)'}`);
  return dataset;
}

module.exports = {
  DATASETS,
  LAYERS,
  LAYER_LABELS,
  lookupRefs,
  getDataset
};
