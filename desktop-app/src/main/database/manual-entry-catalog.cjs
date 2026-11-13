'use strict';

const crypto = require('node:crypto');

const CATALOG_VERSION = 6;
const CATALOG_CODE = '2026-11-12-manual-entry-domain-catalog-v6';
const CATALOG_SOURCE = 'المواصفة الوظيفية المقدمة في تكليف 12 نوفمبر 2026؛ تحتاج تعريفات ومصادر رسمية';

const DOMAINS = [
  ['administrative-geography', 'البيانات الإدارية والجغرافية', [
    ['administrative-units', 'الوحدات الإدارية'],
    ['representation-and-constituencies', 'التقسيم والتمثيل الإداري والانتخابي'],
    ['current-directorate-compatibility', 'سجل المديرية الحالي — نموذج توافق محدود', 'legacy_directorate_v1'],
  ]],
  ['population-households', 'السكان والأسر والتركيبة الديموغرافية', [
    ['population', 'السكان'], ['age-groups', 'الفئات العمرية'], ['households-and-housing', 'الأسر والمساكن'],
  ]],
  ['poverty-livelihoods', 'الفقر ومستويات المعيشة والاقتصاد الأسري', [
    ['poverty', 'الفقر'], ['social-and-occupational-groups', 'الشرائح الاجتماعية والمهنية'],
    ['income-and-livelihoods', 'الدخل والمعيشة'], ['assets-and-ownership', 'الملكية والأصول'],
  ]],
  ['target-groups-protection', 'الفئات المستهدفة والإعاقة والنزوح والحماية الاجتماعية', [
    ['persons-with-disabilities', 'الأشخاص ذوو الإعاقة'], ['displacement', 'النزوح'], ['assistance-and-social-protection', 'المساعدات والحماية الاجتماعية'],
  ]],
  ['natural-resources-environment', 'الموارد الطبيعية والبيئة والمناخ', [
    ['terrain', 'التضاريس'], ['climate', 'المناخ'], ['soil-and-land', 'التربة والأراضي'],
    ['water-resources', 'الموارد المائية'], ['vegetation', 'الغطاء النباتي'], ['wildlife-and-marine-life', 'الحياة البرية والبحرية'],
    ['environmental-degradation', 'التدهور البيئي'],
  ]],
  ['society-culture-heritage', 'المجتمع والثقافة والموروث والشخصيات الاجتماعية', [
    ['social-structure', 'التركيبة الاجتماعية'], ['customs-and-traditions', 'العادات والتقاليد'],
    ['cultural-heritage', 'الموروث الثقافي'], ['social-influencers', 'الشخصيات الاجتماعية والنافذة'],
  ]],
  ['local-governance-institutions', 'الإدارة المحلية والحوكمة والمؤسسات والمجتمع المدني', [
    ['local-representation', 'التمثيل المحلي'], ['executive-administration', 'الإدارات والأجهزة التنفيذية'],
    ['community-institutions', 'المؤسسات والمرافق المجتمعية'], ['associations-and-cooperatives', 'الجمعيات والمنظمات والتعاونيات'],
    ['partners-and-actors', 'الفاعلون والشركاء'], ['community-priorities', 'الأولويات المجتمعية'],
  ]],
  ['education-literacy', 'التعليم ومحو الأمية', [
    ['kindergartens', 'رياض الأطفال'], ['schools-and-facilities', 'المدارس والمنشآت'], ['enrollment-and-students', 'الطلاب والالتحاق'],
    ['dropout', 'التسرب'], ['education-workforce', 'الكادر التعليمي والإداري'], ['education-specializations', 'التخصصات'], ['literacy', 'محو الأمية'],
  ]],
  ['health-population-services', 'الصحة والسكان والخدمات الصحية', [
    ['health-facilities', 'المرافق'], ['health-coverage', 'التغطية'], ['diseases', 'الأمراض'],
    ['maternal-child-and-immunization', 'الوفيات والأمومة والطفولة والتحصين'], ['health-workforce', 'الكادر الصحي'],
  ]],
  ['culture-youth-sports', 'الثقافة والشباب والرياضة', [
    ['culture-youth-and-sports-facilities', 'المكتبات والمتاحف والمراكز الشبابية والمنشآت والأنشطة الرياضية'],
  ]],
  ['infrastructure-basic-services', 'البنية التحتية والخدمات الأساسية', [
    ['water-supply', 'المياه'], ['sanitation-environmental-health', 'الصرف الصحي وصحة البيئة'], ['electricity-and-energy', 'الكهرباء والطاقة'],
    ['roads', 'الطرق'], ['telecommunications', 'الاتصالات'],
  ]],
  ['agriculture-irrigation-livestock-fisheries', 'الزراعة والري والثروة الحيوانية والسمكية', [
    ['water-harvesting-and-irrigation', 'حصاد المياه والري'], ['agricultural-land-and-holdings', 'الأراضي الزراعية والحيازات'],
    ['livestock', 'الثروة الحيوانية'], ['poultry', 'الدواجن'], ['beekeeping-and-honey', 'النحل والعسل'], ['crops', 'المحاصيل'],
    ['plants-and-plant-products', 'النباتات والمنتجات النباتية'], ['agricultural-services', 'الخدمات الزراعية'],
    ['product-marketing', 'تسويق المنتجات'], ['fisheries-and-fishing', 'الثروة السمكية والصيد'], ['fishing-facilities', 'منشآت الصيد'],
  ]],
  ['industry-private-sector-tourism', 'الصناعة والقطاع الخاص والأنشطة الاقتصادية والسياحة', [
    ['industry', 'الصناعة'], ['commercial-and-service-establishments', 'المنشآت المهنية والتجارية والخدمية'], ['tourism', 'السياحة'],
  ]],
  ['projects-finance-revenues', 'المشاريع والتمويل والموازنات والإيرادات', [
    ['projects', 'المشاريع', 'project_v1'], ['project-funding', 'تمويل المشاريع', 'project_funding_v1'],
    ['budgets-and-expenses', 'الموازنات والنفقات'], ['revenues', 'الإيرادات والإيرادات حسب الجهة'],
  ]],
  ['development-indicators', 'المؤشرات التنموية والقياس والمقارنات', [
    ['indicator-definitions', 'تعريف المؤشر'], ['indicator-results', 'النتائج', 'indicator_observation_v1'],
    ['targets', 'المستهدفات'], ['indicator-themes', 'المحاور'],
  ]],
  ['development-analysis-priorities', 'التحليل التنموي والقضايا والأولويات', [
    ['swot', 'تحليل SWOT'], ['pestle', 'تحليل PESTLE'], ['development-issues', 'القضايا التنموية'],
    ['comparisons', 'المقارنات'], ['prioritization', 'تحديد الأولويات'],
  ]],
  ['strategic-planning', 'التخطيط الاستراتيجي والبرامج والمشاريع', [
    ['objectives-and-outcomes', 'الأهداف والنتائج'], ['programs-and-initiatives', 'البرامج والمبادرات'], ['monitoring', 'المتابعة'],
  ]],
  ['crosscutting-documentation-quality', 'الحقول المشتركة والتوثيق والتتبع وجودة البيانات', [
    ['identifiers-and-classifications', 'المعرفات والتصنيفات المشتركة'], ['record-properties', 'خصائص السجلات'],
    ['measurement-properties', 'خصائص القياس والوحدات'], ['source-and-provenance', 'المصدر وسلسلة التتبع'],
    ['data-quality', 'جودة البيانات'], ['entry-and-approval', 'إدارة الإدخال والمراجعة والاعتماد'],
    ['system-completeness', 'متابعة اكتمال النظام'], ['value-states', 'حالات القيم المفقودة والصفر الفعلي'],
  ]],
];

const FIELD_CANDIDATE_LINKS = Object.freeze({
  'administrative-geography.administrative-units': ['geography.administrative'],
  'administrative-geography.representation-and-constituencies': ['geography.boundaries', 'governance.local_government'],
  'population-households.population': ['population.population'],
  'population-households.age-groups': ['population.population'],
  'population-households.households-and-housing': ['population.households'],
  'poverty-livelihoods.poverty': ['poverty.poverty'],
  'poverty-livelihoods.social-and-occupational-groups': ['poverty.livelihoods'],
  'poverty-livelihoods.income-and-livelihoods': ['poverty.livelihoods'],
  'poverty-livelihoods.assets-and-ownership': ['poverty.assets'],
  'target-groups-protection.persons-with-disabilities': ['protection.disability'],
  'target-groups-protection.displacement': ['protection.displacement'],
  'target-groups-protection.assistance-and-social-protection': ['protection.assistance'],
  'natural-resources-environment.terrain': ['environment.terrain'],
  'natural-resources-environment.climate': ['environment.climate'],
  'natural-resources-environment.soil-and-land': ['environment.soil_land'],
  'natural-resources-environment.water-resources': ['environment.water'],
  'natural-resources-environment.vegetation': ['environment.biodiversity'],
  'natural-resources-environment.wildlife-and-marine-life': ['environment.biodiversity'],
  'natural-resources-environment.environmental-degradation': ['environment.degradation'],
  'society-culture-heritage.social-structure': ['society_culture.cohesion'],
  'society-culture-heritage.customs-and-traditions': ['society_culture.customs'],
  'society-culture-heritage.cultural-heritage': ['society_culture.heritage'],
  'society-culture-heritage.social-influencers': ['society_culture.figures'],
  'local-governance-institutions.local-representation': ['governance.local_government'],
  'local-governance-institutions.executive-administration': ['governance.executive'],
  'local-governance-institutions.community-institutions': ['governance.institutions'],
  'local-governance-institutions.associations-and-cooperatives': ['governance.organizations'],
  'local-governance-institutions.partners-and-actors': ['governance.partners'],
  'education-literacy.kindergartens': ['education.kindergarten'],
  'education-literacy.schools-and-facilities': ['education.schools'],
  'education-literacy.enrollment-and-students': ['education.enrollment'],
  'education-literacy.dropout': ['education.enrollment'],
  'education-literacy.education-workforce': ['education.staff'],
  'education-literacy.education-specializations': ['education.staff'],
  'education-literacy.literacy': ['education.literacy'],
  'health-population-services.health-facilities': ['health.facilities'],
  'health-population-services.health-coverage': ['health.coverage'],
  'health-population-services.diseases': ['health.diseases'],
  'health-population-services.maternal-child-and-immunization': ['health.maternal_child'],
  'health-population-services.health-workforce': ['health.workforce'],
  'culture-youth-sports.culture-youth-and-sports-facilities': ['youth_sports.culture', 'youth_sports.sports'],
  'infrastructure-basic-services.water-supply': ['infrastructure.water'],
  'infrastructure-basic-services.sanitation-environmental-health': ['infrastructure.sanitation'],
  'infrastructure-basic-services.electricity-and-energy': ['infrastructure.energy'],
  'infrastructure-basic-services.roads': ['infrastructure.roads'],
  'infrastructure-basic-services.telecommunications': ['infrastructure.telecom'],
  'agriculture-irrigation-livestock-fisheries.water-harvesting-and-irrigation': ['agriculture.irrigation'],
  'agriculture-irrigation-livestock-fisheries.agricultural-land-and-holdings': ['agriculture.land'],
  'agriculture-irrigation-livestock-fisheries.livestock': ['agriculture.livestock'],
  'agriculture-irrigation-livestock-fisheries.poultry': ['agriculture.livestock'],
  'agriculture-irrigation-livestock-fisheries.beekeeping-and-honey': ['agriculture.livestock'],
  'agriculture-irrigation-livestock-fisheries.crops': ['agriculture.crops'],
  'agriculture-irrigation-livestock-fisheries.agricultural-services': ['agriculture.markets'],
  'agriculture-irrigation-livestock-fisheries.product-marketing': ['agriculture.markets'],
  'agriculture-irrigation-livestock-fisheries.fisheries-and-fishing': ['agriculture.fisheries'],
  'industry-private-sector-tourism.industry': ['economy.industry'],
  'industry-private-sector-tourism.commercial-and-service-establishments': ['economy.establishments'],
  'industry-private-sector-tourism.tourism': ['economy.tourism'],
  'projects-finance-revenues.projects': ['finance.projects'],
  'projects-finance-revenues.project-funding': ['finance.projects'],
  'projects-finance-revenues.budgets-and-expenses': ['finance.budgets'],
  'projects-finance-revenues.revenues': ['finance.revenues'],
  'development-indicators.indicator-definitions': ['indicators.definitions'],
  'development-indicators.indicator-results': ['indicators.targets'],
  'development-indicators.targets': ['indicators.targets'],
  'development-analysis-priorities.swot': ['analysis.swot'],
  'development-analysis-priorities.pestle': ['analysis.pestle'],
  'development-analysis-priorities.development-issues': ['analysis.issues'],
  'development-analysis-priorities.comparisons': ['analysis.comparisons'],
  'development-analysis-priorities.prioritization': ['analysis.priorities'],
  'strategic-planning.objectives-and-outcomes': ['planning.objectives'],
  'strategic-planning.programs-and-initiatives': ['planning.programs'],
  'strategic-planning.monitoring': ['planning.monitoring'],
  'crosscutting-documentation-quality.identifiers-and-classifications': ['metadata.identifiers'],
  'crosscutting-documentation-quality.source-and-provenance': ['metadata.source'],
  'crosscutting-documentation-quality.data-quality': ['metadata.quality'],
  'crosscutting-documentation-quality.entry-and-approval': ['metadata.quality'],
});

const FIELD_CANDIDATE_FIELD_FILTERS = Object.freeze({
  'population-households.age-groups': { population: ['population.age_sex'] },
  'poverty-livelihoods.social-and-occupational-groups': { livelihoods: ['livelihood.group_size','livelihood.occupation','livelihood.social_group'] },
  'poverty-livelihoods.income-and-livelihoods': { livelihoods: ['household.expenditure','household.income','household.inputs','household.outputs'] },
  'natural-resources-environment.vegetation': { biodiversity: ['environment.plants.economic','environment.plants.shrubs','environment.plants.trees'] },
  'natural-resources-environment.wildlife-and-marine-life': { biodiversity: ['environment.marine.species','environment.marine.stock','environment.wildlife.animals','environment.wildlife.birds'] },
  'education-literacy.enrollment-and-students': { enrollment: ['directorate.enrolledStudents','education.enrollment.rate','education.population_school_age'] },
  'education-literacy.dropout': { enrollment: ['education.dropout.count','education.dropout.rate'] },
  'education-literacy.education-workforce': { staff: ['education.staff.deputies','education.staff.principals','education.staff.qualification','education.staff.teachers'] },
  'education-literacy.education-specializations': { staff: ['education.staff.specialty'] },
  'agriculture-irrigation-livestock-fisheries.livestock': { livestock: ['agriculture.livestock.breeders','agriculture.livestock.disease','agriculture.livestock.infection','agriculture.livestock.species','directorate.livestockHeads'] },
  'agriculture-irrigation-livestock-fisheries.poultry': { livestock: ['agriculture.poultry.farms'] },
  'agriculture-irrigation-livestock-fisheries.beekeeping-and-honey': { livestock: ['agriculture.honey.hives','agriculture.honey.price','agriculture.honey.production'] },
  'agriculture-irrigation-livestock-fisheries.agricultural-services': { markets: ['agriculture.service.beneficiaries','agriculture.service.centers'] },
  'agriculture-irrigation-livestock-fisheries.product-marketing': { markets: ['agriculture.marketing.cold_storage','agriculture.marketing.product','agriculture.marketing.quantity'] },
  'projects-finance-revenues.project-funding': { projects: ['directorate.projectCost','projects.authority_contribution','projects.community_contribution','projects.completion'] },
  'development-indicators.indicator-results': { targets: ['indicator.value'] },
  'development-indicators.targets': { targets: ['indicator.baseline','indicator.benchmark','indicator.rank','indicator.target','indicator.target_year'] },
  'crosscutting-documentation-quality.data-quality': { quality: ['metadata.completeness','metadata.quality_note','metadata.quality_status','metadata.review','metadata.verification'] },
  'crosscutting-documentation-quality.entry-and-approval': { quality: ['metadata.approved_at','metadata.approved_by','metadata.created_at','metadata.created_by','metadata.updated_at','metadata.updated_by'] },
});

const FIELD_CANDIDATE_VERSION = 7;
const FIELD_CANDIDATE_CODE = '2026-11-12-manual-entry-field-candidates-v7';
const FIELD_CANDIDATE_NOTE = 'اقتراح ربط من قاموس النموذج الموحد الحالي؛ يحتاج مراجعة دلالية واعتماد مصدر ووحدة ونطاق قبل إتاحته للإدخال.';
const COLLECTION_FORM_VERSION = 8;
const COLLECTION_FORM_CODE = '2026-11-13-manual-entry-primary-collection-v8';
const EDUCATION_ENTITY_VERSION = 9;
const EDUCATION_ENTITY_CODE = '2026-11-13-education-facility-entity-type-v9';
const RAW_COLLECTION_VERSION = 11;
const RAW_COLLECTION_CODE = '2026-11-14-requirement-raw-collection-v11';
const COLLECTION_FORM_REFERENCE = {
  code: 'user-development-data-spec-v1',
  title: 'مواصفة البيانات التنموية المقدمة من المستخدم',
  issuer: 'المستخدم',
  version: '1',
};
const COLLECTION_FORMS = [
  {
    code: 'population_age_sex_collection_v1',
    name: 'جمع أولي لقياس السكان حسب العمر والجنس',
    description: 'سجل قياس خام لمتغير عدد السكان حسب بعدي الجنس والفئة العمرية. النموذج متاح لجمع البيانات ولا يعتمد منهجية المسح أو النتيجة التحليلية.',
    groupCode: 'population-households.age-groups',
    section: { code: 'population_observation', name: 'قياس السكان' },
    dataStructureType: 'observation_record',
    sourceClause: 'المجال 2، السكان، والفئات العمرية',
    fields: [
      { code: 'population.age_sex', required: true, storage: 'measurement', min: 0, unit: 'person', unitStatus: 'specified', dimensions: ['sex', 'age_group'] },
    ],
  },
  {
    code: 'education_school_collection_v1',
    name: 'جمع أولي لبيانات المدرسة والمنشأة التعليمية',
    description: 'سجل وصفي/عددي لكل مدرسة أو روضة على حدة. الأنواع والوحدات وقواعد القياس قابلة للمراجعة ولا تجعل السجل معتمداً تحليلياً.',
    groupCode: 'education-literacy.schools-and-facilities',
    section: { code: 'school_identity', name: 'تعريف المدرسة ومواصفاتها المرصودة' },
    dataStructureType: 'entity_record',
    sourceClause: 'المجال 8، رياض الأطفال والمدارس والمنشآت',
    fields: [
      { code: 'education.school.name', required: true, storage: 'record_value', definitionStatus: 'initial', unitStatus: 'not_applicable' },
      { code: 'education.school.type', required: true, storage: 'reference_value', referenceSet: 'education_school_kind_v1', definitionStatus: 'initial', unitStatus: 'not_applicable' },
      { code: 'education.school.gender_reported', label: 'جنس المدرسة كما ورد في المصدر', dataType: 'text', semanticType: 'attribute', storage: 'record_value', definitionStatus: 'needs_review', unitStatus: 'not_applicable', notes: 'يُحفظ التصنيف النصي كما ورد؛ لا تُفرض قائمة بنين/بنات/مختلط قبل اعتمادها.' },
      { code: 'education.school.building_type_reported', label: 'نوع المبنى المدرسي كما ورد في المصدر', dataType: 'text', semanticType: 'attribute', storage: 'record_value', definitionStatus: 'needs_review', unitStatus: 'not_applicable' },
      { code: 'education.school.condition_reported', label: 'حالة المبنى المدرسي كما وردت في المصدر', dataType: 'long_text', semanticType: 'narrative', storage: 'narrative', definitionStatus: 'needs_review', unitStatus: 'not_applicable' },
      { code: 'education.school.classrooms', required: false, storage: 'measurement', min: 0, unit: 'count', unitStatus: 'specified' },
      { code: 'education.school.sections', required: false, storage: 'measurement', min: 0, unit: 'count', unitStatus: 'specified' },
    ],
  },
];
const COLLECTION_FORM_DDL = `
  CREATE TABLE IF NOT EXISTS manual_entry_reference_documents (
    reference_document_id INTEGER PRIMARY KEY,
    reference_code TEXT NOT NULL,
    version_number TEXT NOT NULL,
    title TEXT NOT NULL,
    issuing_authority TEXT,
    document_uri TEXT,
    content_sha256 TEXT,
    reference_status TEXT NOT NULL CHECK(reference_status IN ('provided_unverified','reviewed','approved','retired')),
    created_at TEXT NOT NULL,
    UNIQUE(reference_code,version_number)
  );
  CREATE TABLE IF NOT EXISTS manual_entry_methodologies (
    methodology_id INTEGER PRIMARY KEY,
    methodology_code TEXT NOT NULL,
    version_number INTEGER NOT NULL,
    name_ar TEXT NOT NULL,
    definition_text TEXT,
    formula_text TEXT,
    numerator_definition TEXT,
    denominator_definition TEXT,
    unit_code TEXT,
    methodology_status TEXT NOT NULL CHECK(methodology_status IN ('not_defined','draft','in_review','approved','retired')),
    source_reference_document_id INTEGER REFERENCES manual_entry_reference_documents(reference_document_id),
    effective_from TEXT,
    effective_to TEXT,
    change_reason TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(methodology_code,version_number),
    CHECK(effective_from IS NULL OR effective_to IS NULL OR effective_to >= effective_from)
  );
  CREATE TABLE IF NOT EXISTS manual_entry_form_governance (
    form_version_id INTEGER PRIMARY KEY REFERENCES form_versions(form_version_id) ON DELETE CASCADE,
    collection_mode TEXT NOT NULL CHECK(collection_mode IN ('primary_collection','standard_collection')),
    definition_status TEXT NOT NULL CHECK(definition_status IN ('provisional','in_review','approved','retired')),
    methodology_status TEXT NOT NULL CHECK(methodology_status IN ('not_defined','in_review','approved','not_required')),
    reference_status TEXT NOT NULL CHECK(reference_status IN ('user_specification_only','in_review','approved')),
    analysis_eligible INTEGER NOT NULL DEFAULT 0 CHECK(analysis_eligible IN (0,1)),
    notes TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS manual_entry_form_field_governance (
    form_field_id INTEGER PRIMARY KEY REFERENCES form_fields(form_field_id) ON DELETE CASCADE,
    definition_status TEXT NOT NULL CHECK(definition_status IN ('initial','needs_review','approved','retired')),
    unit_status TEXT NOT NULL CHECK(unit_status IN ('specified','needs_review','not_applicable')),
    methodology_status TEXT NOT NULL CHECK(methodology_status IN ('not_defined','in_review','approved','not_required')),
    analysis_eligible INTEGER NOT NULL DEFAULT 0 CHECK(analysis_eligible IN (0,1)),
    notes TEXT,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS manual_entry_form_field_dimensions (
    form_field_id INTEGER NOT NULL REFERENCES form_fields(form_field_id) ON DELETE CASCADE,
    dimension_id INTEGER NOT NULL REFERENCES dimension_definitions(dimension_id),
    is_required INTEGER NOT NULL DEFAULT 0 CHECK(is_required IN (0,1)),
    sort_order INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(form_field_id,dimension_id)
  );
  CREATE TABLE IF NOT EXISTS manual_entry_form_references (
    form_version_id INTEGER NOT NULL REFERENCES form_versions(form_version_id) ON DELETE CASCADE,
    form_field_id INTEGER REFERENCES form_fields(form_field_id) ON DELETE CASCADE,
    reference_document_id INTEGER NOT NULL REFERENCES manual_entry_reference_documents(reference_document_id),
    source_clause TEXT NOT NULL,
    PRIMARY KEY(form_version_id,form_field_id,reference_document_id)
  );
  CREATE TABLE IF NOT EXISTS manual_entry_form_methodologies (
    form_version_id INTEGER NOT NULL REFERENCES form_versions(form_version_id) ON DELETE CASCADE,
    form_field_id INTEGER REFERENCES form_fields(form_field_id) ON DELETE CASCADE,
    methodology_id INTEGER NOT NULL REFERENCES manual_entry_methodologies(methodology_id),
    PRIMARY KEY(form_version_id,form_field_id,methodology_id)
  );
`;
const FIELD_CANDIDATE_DDL = `
  CREATE TABLE IF NOT EXISTS manual_entry_group_field_candidates (
    group_id INTEGER NOT NULL REFERENCES manual_entry_groups(group_id),
    field_definition_id INTEGER NOT NULL REFERENCES field_definitions(field_definition_id),
    source_group_code TEXT NOT NULL REFERENCES field_groups(group_code),
    mapping_state TEXT NOT NULL CHECK(mapping_state = 'needs_domain_review'),
    mapping_note TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY(group_id,field_definition_id,source_group_code)
  );
  CREATE INDEX IF NOT EXISTS idx_manual_entry_field_candidates_group ON manual_entry_group_field_candidates(group_id,field_definition_id);
`;

const DDL = `
  CREATE TABLE IF NOT EXISTS manual_entry_domains (
    domain_id INTEGER PRIMARY KEY,
    domain_code TEXT NOT NULL UNIQUE,
    name_ar TEXT NOT NULL,
    sort_order INTEGER NOT NULL,
    source_note TEXT NOT NULL,
    definition_state TEXT NOT NULL CHECK(definition_state IN ('catalogued_needs_definition','partially_mapped')),
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS manual_entry_groups (
    group_id INTEGER PRIMARY KEY,
    domain_id INTEGER NOT NULL REFERENCES manual_entry_domains(domain_id),
    group_code TEXT NOT NULL UNIQUE,
    name_ar TEXT NOT NULL,
    sort_order INTEGER NOT NULL,
    source_note TEXT NOT NULL,
    definition_state TEXT NOT NULL CHECK(definition_state IN ('needs_semantic_definition','partial_form_available')),
    updated_at TEXT NOT NULL,
    UNIQUE(domain_id,sort_order)
  );
  CREATE TABLE IF NOT EXISTS manual_entry_group_forms (
    group_id INTEGER NOT NULL REFERENCES manual_entry_groups(group_id),
    form_code TEXT NOT NULL REFERENCES form_definitions(form_code),
    coverage_note TEXT NOT NULL,
    PRIMARY KEY(group_id,form_code)
  );
  CREATE INDEX IF NOT EXISTS idx_manual_entry_groups_domain ON manual_entry_groups(domain_id,sort_order);
`;

function checksum() {
  return crypto.createHash('sha256').update(DDL).update(JSON.stringify(DOMAINS)).update(CATALOG_SOURCE).digest('hex');
}

function migrate(db) {
  const expectedChecksum = checksum();
  const existing = db.prepare('SELECT * FROM schema_migrations WHERE version=?').get(CATALOG_VERSION);
  if (existing?.success === 1) {
    if (existing.checksum !== expectedChecksum || existing.migration_code !== CATALOG_CODE) {
      throw new Error('عُدّل كتالوج مجالات الإدخال بعد تطبيق إصداره؛ أضف ترحيلاً جديداً بدلاً من تغيير التعريف المنشور.');
    }
    return { version: CATALOG_VERSION, alreadyApplied: true, fieldCandidates: migrateFieldCandidates(db), collectionForms: migrateCollectionForms(db), educationEntityType: migrateEducationEntityType(db), rawCollectionForms: migrateRawCollectionForms(db) };
  }
  if (existing) db.prepare('DELETE FROM schema_migrations WHERE version=? AND success=0').run(CATALOG_VERSION);

  const now = new Date().toISOString();
  const startedAt = Date.now();
  try {
    db.transaction(() => {
      db.exec(DDL);
      const insertDomain = db.prepare(`INSERT INTO manual_entry_domains(domain_code,name_ar,sort_order,source_note,definition_state,updated_at)
        VALUES(?,?,?,?,?,?)`);
      const insertGroup = db.prepare(`INSERT INTO manual_entry_groups(domain_id,group_code,name_ar,sort_order,source_note,definition_state,updated_at)
        VALUES(?,?,?,?,?,?,?)`);
      const insertForm = db.prepare(`INSERT INTO manual_entry_group_forms(group_id,form_code,coverage_note) VALUES(?,?,?)`);
      DOMAINS.forEach(([domainCode,name,groups],domainIndex) => {
        const hasMappedGroup = groups.some(([, , formCode]) => Boolean(formCode));
        insertDomain.run(domainCode,name,domainIndex + 1,CATALOG_SOURCE,hasMappedGroup ? 'partially_mapped' : 'catalogued_needs_definition',now);
        const domainId = db.prepare('SELECT domain_id FROM manual_entry_domains WHERE domain_code=?').get(domainCode).domain_id;
        groups.forEach(([groupCode,groupName,formCode],groupIndex) => {
          insertGroup.run(domainId,`${domainCode}.${groupCode}`,groupName,groupIndex + 1,CATALOG_SOURCE,
            formCode ? 'partial_form_available' : 'needs_semantic_definition',now);
          if (formCode) {
            const groupId = db.prepare('SELECT group_id FROM manual_entry_groups WHERE group_code=?').get(`${domainCode}.${groupCode}`).group_id;
            const form = db.prepare('SELECT form_code FROM form_definitions WHERE form_code=? AND is_active=1').get(formCode);
            if (!form) throw new Error(`تعذر ربط نموذج الإدخال المنشور: ${formCode}`);
            insertForm.run(groupId,formCode,'النموذج يتيح إدخال جزء من موضوع المجموعة؛ لا يعني اكتمال عناصر قاموس المجال أو اعتمادها منهجياً.');
          }
        });
      });
      db.prepare(`INSERT INTO schema_migrations(version,migration_code,migration_name,checksum,applied_at,execution_ms,success,details)
        VALUES(?,?,?,?,?,?,1,?)`).run(CATALOG_VERSION,CATALOG_CODE,'تصنيف مجالات ومجموعات الإدخال اليدوي',expectedChecksum,now,Date.now()-startedAt,
          'كتالوج تصنيفي أولي من التكليف؛ المجموعات غير المربوطة بنموذج منشور لا تتيح الإدخال حتى اعتماد تعريفاتها.');
    })();
  } catch (error) {
    db.prepare(`INSERT OR REPLACE INTO schema_migrations(version,migration_code,migration_name,checksum,applied_at,execution_ms,success,details)
      VALUES(?,?,?,?,?,?,0,?)`).run(CATALOG_VERSION,CATALOG_CODE,'تصنيف مجالات ومجموعات الإدخال اليدوي',expectedChecksum,
        new Date().toISOString(),Date.now()-startedAt,String(error.message).slice(0,4000));
    throw error;
  }
  const fieldCandidates = migrateFieldCandidates(db);
  const collectionForms = migrateCollectionForms(db);
  const educationEntityType = migrateEducationEntityType(db);
  const rawCollectionForms = migrateRawCollectionForms(db);
  return { version: CATALOG_VERSION, alreadyApplied: false, fieldCandidates, collectionForms, educationEntityType, rawCollectionForms };
}

function fieldCandidateChecksum() {
  return crypto.createHash('sha256').update(FIELD_CANDIDATE_DDL).update(JSON.stringify({ links: FIELD_CANDIDATE_LINKS, filters: FIELD_CANDIDATE_FIELD_FILTERS })).update(FIELD_CANDIDATE_NOTE).digest('hex');
}

function migrateFieldCandidates(db) {
  const expectedChecksum = fieldCandidateChecksum();
  const existing = db.prepare('SELECT * FROM schema_migrations WHERE version=?').get(FIELD_CANDIDATE_VERSION);
  if (existing?.success === 1) {
    if (existing.checksum !== expectedChecksum || existing.migration_code !== FIELD_CANDIDATE_CODE) {
      throw new Error('عُدّلت روابط الحقول المرشحة بعد تطبيقها؛ أضف ترحيلاً جديداً بدلاً من تغيير التعريف المنشور.');
    }
    return { version: FIELD_CANDIDATE_VERSION, alreadyApplied: true };
  }
  if (existing) db.prepare('DELETE FROM schema_migrations WHERE version=? AND success=0').run(FIELD_CANDIDATE_VERSION);

  const now = new Date().toISOString();
  const startedAt = Date.now();
  try {
    db.transaction(() => {
      db.exec(FIELD_CANDIDATE_DDL);
      const groups = new Map(db.prepare('SELECT group_id,group_code FROM manual_entry_groups').all().map(row => [row.group_code,row.group_id]));
      const sourceGroups = new Set(db.prepare("SELECT group_code FROM field_groups WHERE group_level='subdomain'").all().map(row => row.group_code));
      const fieldsBySource = db.prepare(`SELECT field.field_definition_id,field.field_code
        FROM field_group_fields link JOIN field_definitions field USING(field_definition_id)
        WHERE link.group_id=(SELECT group_id FROM field_groups WHERE group_code=? AND group_level='subdomain')
        ORDER BY link.sort_order,field.field_code`);
      const insert = db.prepare(`INSERT OR IGNORE INTO manual_entry_group_field_candidates
        (group_id,field_definition_id,source_group_code,mapping_state,mapping_note,created_at)
        VALUES(?,?,?,'needs_domain_review',?,?)`);
      let candidateCount = 0;
      for (const [targetGroupCode,sourceGroupCodes] of Object.entries(FIELD_CANDIDATE_LINKS)) {
        const targetGroupId = groups.get(targetGroupCode);
        if (!targetGroupId) throw new Error(`مجموعة قاموس الإدخال غير موجودة: ${targetGroupCode}`);
        for (const sourceGroupCode of sourceGroupCodes) {
          if (!sourceGroups.has(sourceGroupCode)) throw new Error(`مجموعة قاموس الحقول غير موجودة: ${sourceGroupCode}`);
          const sourceFields = fieldsBySource.all(sourceGroupCode);
          const requiredCodes = FIELD_CANDIDATE_FIELD_FILTERS[targetGroupCode]?.[sourceGroupCode.split('.').at(-1)];
          let eligibleFields = sourceFields;
          if (requiredCodes) {
            const fieldsByCode = new Map(sourceFields.map(field => [field.field_code,field]));
            const missingCodes = requiredCodes.filter(code => !fieldsByCode.has(code));
            if (missingCodes.length) throw new Error(`تعريفات الحقول المرشحة غير موجودة للمجموعة ${targetGroupCode}: ${missingCodes.join(', ')}`);
            eligibleFields = requiredCodes.map(code => fieldsByCode.get(code));
          }
          for (const field of eligibleFields) {
            candidateCount += insert.run(targetGroupId,field.field_definition_id,sourceGroupCode,FIELD_CANDIDATE_NOTE,now).changes;
          }
        }
      }
      db.prepare(`INSERT INTO schema_migrations(version,migration_code,migration_name,checksum,applied_at,execution_ms,success,details)
        VALUES(?,?,?,?,?,?,1,?)`).run(FIELD_CANDIDATE_VERSION,FIELD_CANDIDATE_CODE,'ربط الحقول الموجودة بمجموعات الإدخال كمرشحات غير منشورة',expectedChecksum,now,
          Date.now()-startedAt,`أُضيف ${candidateCount} ربطاً مرشحاً؛ لا يتيح هذا الترحيل نموذجاً أو اعتماداً تلقائياً.`);
    })();
  } catch (error) {
    db.prepare(`INSERT OR REPLACE INTO schema_migrations(version,migration_code,migration_name,checksum,applied_at,execution_ms,success,details)
      VALUES(?,?,?,?,?,?,0,?)`).run(FIELD_CANDIDATE_VERSION,FIELD_CANDIDATE_CODE,'ربط الحقول الموجودة بمجموعات الإدخال كمرشحات غير منشورة',expectedChecksum,
        new Date().toISOString(),Date.now()-startedAt,String(error.message).slice(0,4000));
    throw error;
  }
  return { version: FIELD_CANDIDATE_VERSION, alreadyApplied: false,
    count: db.prepare('SELECT COUNT(*) AS count FROM manual_entry_group_field_candidates').get().count };
}

function collectionFormChecksum() {
  return crypto.createHash('sha256').update(COLLECTION_FORM_DDL).update(JSON.stringify({ COLLECTION_FORMS, COLLECTION_FORM_REFERENCE })).digest('hex');
}

function migrateCollectionForms(db) {
  const expectedChecksum = collectionFormChecksum();
  const existing = db.prepare('SELECT * FROM schema_migrations WHERE version=?').get(COLLECTION_FORM_VERSION);
  if (existing?.success === 1) {
    if (existing.checksum !== expectedChecksum || existing.migration_code !== COLLECTION_FORM_CODE) {
      throw new Error('عُدّلت تعريفات نماذج الجمع الأولي بعد تطبيقها؛ أضف ترحيلاً جديداً بدلاً من تغيير الإصدار المنشور.');
    }
    return { version: COLLECTION_FORM_VERSION, alreadyApplied: true,
      forms: db.prepare('SELECT COUNT(*) AS count FROM manual_entry_form_governance WHERE collection_mode=\'primary_collection\'').get().count };
  }
  if (existing) db.prepare('DELETE FROM schema_migrations WHERE version=? AND success=0').run(COLLECTION_FORM_VERSION);

  const now = new Date().toISOString();
  const startedAt = Date.now();
  try {
    db.transaction(() => {
      db.exec(COLLECTION_FORM_DDL);
      db.prepare(`INSERT OR IGNORE INTO manual_entry_reference_documents
        (reference_code,version_number,title,issuing_authority,reference_status,created_at) VALUES(?,?,?,?,?,?)`)
        .run(COLLECTION_FORM_REFERENCE.code,COLLECTION_FORM_REFERENCE.version,COLLECTION_FORM_REFERENCE.title,
          COLLECTION_FORM_REFERENCE.issuer,'provided_unverified',now);
      const referenceId = db.prepare('SELECT reference_document_id FROM manual_entry_reference_documents WHERE reference_code=? AND version_number=?')
        .get(COLLECTION_FORM_REFERENCE.code,COLLECTION_FORM_REFERENCE.version).reference_document_id;
      db.prepare(`INSERT OR IGNORE INTO measurement_units(unit_code,name_ar,unit_category,created_at) VALUES('person','نسمة','count',?)`).run(now);
      db.prepare(`INSERT OR IGNORE INTO measurement_units(unit_code,name_ar,unit_category,created_at) VALUES('count','عدد','count',?)`).run(now);
      const insertReferenceSet = db.prepare(`INSERT OR IGNORE INTO reference_sets(set_code,name_ar,is_hierarchical,is_active,created_at,updated_at)
        VALUES('education_school_kind_v1','نوع المنشأة التعليمية',0,1,?,?)`);
      insertReferenceSet.run(now,now);
      const schoolReferenceSetId = db.prepare('SELECT reference_set_id FROM reference_sets WHERE set_code=\'education_school_kind_v1\'').get().reference_set_id;
      const insertReferenceValue = db.prepare(`INSERT OR IGNORE INTO reference_values(reference_set_id,value_code,label_ar,sort_order,is_active,created_at)
        VALUES(?,?,?,?,1,?)`);
      insertReferenceValue.run(schoolReferenceSetId,'school','مدرسة',1,now);
      insertReferenceValue.run(schoolReferenceSetId,'kindergarten','روضة أطفال',2,now);
      const insertForm = db.prepare(`INSERT OR IGNORE INTO form_definitions(form_code,name_ar,description,data_structure_type,is_active,created_at,updated_at)
        VALUES(?,?,?,?,1,?,?)`);
      const selectForm = db.prepare('SELECT form_id FROM form_definitions WHERE form_code=?');
      const insertVersion = db.prepare(`INSERT OR IGNORE INTO form_versions(form_id,version_number,version_label,status,definition_hash,change_summary,created_at,published_at)
        VALUES(?,1,'جمع أولي v1','published',?,?,?,?)`);
      const selectVersion = db.prepare('SELECT form_version_id FROM form_versions WHERE form_id=? AND version_number=1');
      const insertSection = db.prepare(`INSERT OR IGNORE INTO form_sections(form_version_id,section_code,name_ar,section_type,sort_order,is_repeatable,is_required,created_at)
        VALUES(?,?,?,'data',1,0,1,?)`);
      const insertFieldDefinition = db.prepare(`INSERT OR IGNORE INTO field_definitions
        (field_code,canonical_name_ar,description,semantic_type,data_type,default_unit_id,reference_set_id,is_active,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)`);
      const insertField = db.prepare(`INSERT OR IGNORE INTO form_fields
        (form_version_id,section_id,field_definition_id,field_code,label_ar,data_type_override,storage_class,is_required,allow_null,
         is_repeatable,is_derived,is_importable,min_value,max_value,unit_id,reference_set_id,validation_rules_json,sort_order,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,0,0,1,?,?,?,?,'{}',?,?)`);
      const insertFieldGovernance = db.prepare(`INSERT OR IGNORE INTO manual_entry_form_field_governance
        (form_field_id,definition_status,unit_status,methodology_status,analysis_eligible,notes,updated_at)
        VALUES(?,?,?,?,0,?,?)`);
      const insertFieldDimension = db.prepare(`INSERT OR IGNORE INTO manual_entry_form_field_dimensions
        (form_field_id,dimension_id,is_required,sort_order)
        SELECT ?,dimension_id,1,? FROM dimension_definitions WHERE dimension_code=?`);
      const insertFormGovernance = db.prepare(`INSERT OR IGNORE INTO manual_entry_form_governance
        (form_version_id,collection_mode,definition_status,methodology_status,reference_status,analysis_eligible,notes,updated_at)
        VALUES(?,'primary_collection','provisional','not_defined','user_specification_only',0,?,?)`);
      const insertFormReference = db.prepare(`INSERT OR IGNORE INTO manual_entry_form_references
        (form_version_id,form_field_id,reference_document_id,source_clause) VALUES(?,?,?,?)`);
      const insertGroupForm = db.prepare(`INSERT OR IGNORE INTO manual_entry_group_forms(group_id,form_code,coverage_note) VALUES(?,?,?)`);
      for (const form of COLLECTION_FORMS) {
        const formHash = crypto.createHash('sha256').update(JSON.stringify(form)).digest('hex');
        insertForm.run(form.code,form.name,form.description,form.dataStructureType,now,now);
        const formId = selectForm.get(form.code).form_id;
        insertVersion.run(formId,formHash,'نموذج جمع أولي من المواصفة المتاحة؛ لا يعتمد منهجية أو نتيجة تحليلية.',now,now);
        const formVersionId = selectVersion.get(formId).form_version_id;
        insertSection.run(formVersionId,form.section.code,form.section.name,now);
        const sectionId = db.prepare('SELECT section_id FROM form_sections WHERE form_version_id=? AND section_code=?').get(formVersionId,form.section.code).section_id;
        insertFormGovernance.run(formVersionId,`إتاحة الجمع الأولي فقط استناداً إلى: ${form.sourceClause}. لا توجد منهجية أو مرجعية خارج مواصفة المستخدم؛ لا يدخل النموذج التحليل الرسمي.` ,now);
        const group = db.prepare('SELECT group_id FROM manual_entry_groups WHERE group_code=?').get(form.groupCode);
        if (!group) throw new Error(`مجموعة نموذج الجمع الأولي غير موجودة: ${form.groupCode}`);
        insertGroupForm.run(group.group_id,form.code,'نموذج جمع أولي لحقول موصوفة؛ لا يغطي كل عناصر المجموعة ولا يؤهل القيم للتحليل الرسمي.');
        db.prepare('UPDATE manual_entry_groups SET definition_state=\'partial_form_available\',updated_at=? WHERE group_id=?').run(now,group.group_id);
        db.prepare('UPDATE manual_entry_domains SET definition_state=\'partially_mapped\',updated_at=? WHERE domain_id=(SELECT domain_id FROM manual_entry_groups WHERE group_id=?)').run(now,group.group_id);
        const getUnitId = db.prepare('SELECT unit_id FROM measurement_units WHERE unit_code=? AND is_active=1');
        const getReferenceSetId = db.prepare('SELECT reference_set_id FROM reference_sets WHERE set_code=? AND is_active=1');
        for (const [index,field] of form.fields.entries()) {
          const existingDefinition = db.prepare('SELECT field_definition_id,data_type,semantic_type,default_unit_id,reference_set_id FROM field_definitions WHERE field_code=?').get(field.code);
          const dataType = field.dataType ?? existingDefinition?.data_type ?? (field.storage === 'measurement' ? 'integer' : field.storage === 'narrative' ? 'long_text' : field.storage === 'reference_value' ? 'reference' : 'text');
          const semanticType = field.semanticType ?? existingDefinition?.semantic_type ?? (field.storage === 'measurement' ? 'measurement' : field.storage === 'narrative' ? 'narrative' : field.storage === 'reference_value' ? 'classification' : 'attribute');
          const unitId = field.unit ? getUnitId.get(field.unit)?.unit_id ?? null : existingDefinition?.default_unit_id ?? null;
          if (field.unit && !unitId) throw new Error(`وحدة الحقل غير موجودة: ${field.unit}`);
          const referenceSetId = field.referenceSet ? getReferenceSetId.get(field.referenceSet)?.reference_set_id ?? null : existingDefinition?.reference_set_id ?? null;
          if (field.referenceSet && !referenceSetId) throw new Error(`قائمة مرجعية غير موجودة: ${field.referenceSet}`);
          insertFieldDefinition.run(field.code,field.label ?? existingDefinition?.canonical_name_ar ?? field.code,field.notes ?? null,semanticType,dataType,unitId,referenceSetId,1,now,now);
          const fieldDefinition = db.prepare('SELECT field_definition_id FROM field_definitions WHERE field_code=?').get(field.code);
          const definitionId = fieldDefinition.field_definition_id;
          insertField.run(formVersionId,sectionId,definitionId,field.code,field.label ?? field.code,field.dataType ?? null,field.storage,field.required ? 1 : 0,
            field.required ? 0 : 1,field.min ?? null,field.max ?? null,unitId,referenceSetId,index + 1,now);
          const formFieldId = db.prepare('SELECT form_field_id FROM form_fields WHERE form_version_id=? AND field_code=?').get(formVersionId,field.code).form_field_id;
          const definitionStatus = field.definitionStatus ?? 'initial';
          const unitStatus = field.unitStatus ?? (field.unit ? 'specified' : 'not_applicable');
          insertFieldGovernance.run(formFieldId,definitionStatus,unitStatus,'not_defined',field.notes ?? null,now);
          insertFormReference.run(formVersionId,formFieldId,referenceId,form.sourceClause);
          if (field.dimensions) {
            for (const [dimensionIndex,dimensionCode] of field.dimensions.entries()) {
              const dimension = db.prepare('SELECT dimension_id FROM dimension_definitions WHERE dimension_code=? AND is_active=1').get(dimensionCode);
              if (!dimension) throw new Error(`بُعد غير موجود للنموذج ${form.code}: ${dimensionCode}`);
              insertFieldDimension.run(formFieldId,dimensionIndex,dimensionCode);
            }
          }
        }
        insertFormReference.run(formVersionId,null,referenceId,form.sourceClause);
      }
      db.prepare(`INSERT INTO schema_migrations(version,migration_code,migration_name,checksum,applied_at,execution_ms,success,details)
        VALUES(?,?,?,?,?,?,1,?)`).run(COLLECTION_FORM_VERSION,COLLECTION_FORM_CODE,'نماذج جمع أولي وحوكمة المنهجيات والمراجع',expectedChecksum,now,
          Date.now()-startedAt,`نُشرت ${COLLECTION_FORMS.length} نماذج لجمع أولي فقط؛ لم تُعتمد منهجية ولم تُفعّل أي صلاحية تحليلية.`);
    })();
  } catch (error) {
    db.prepare(`INSERT OR REPLACE INTO schema_migrations(version,migration_code,migration_name,checksum,applied_at,execution_ms,success,details)
      VALUES(?,?,?,?,?,?,0,?)`).run(COLLECTION_FORM_VERSION,COLLECTION_FORM_CODE,'نماذج جمع أولي وحوكمة المنهجيات والمراجع',expectedChecksum,
        new Date().toISOString(),Date.now()-startedAt,String(error.message).slice(0,4000));
    throw error;
  }
  return { version: COLLECTION_FORM_VERSION, alreadyApplied: false, forms: COLLECTION_FORMS.length };
}

function educationEntityChecksum() {
  return crypto.createHash('sha256').update(EDUCATION_ENTITY_CODE).update('education_facility|منشأة تعليمية').digest('hex');
}

function migrateEducationEntityType(db) {
  const expectedChecksum = educationEntityChecksum();
  const existing = db.prepare('SELECT * FROM schema_migrations WHERE version=?').get(EDUCATION_ENTITY_VERSION);
  if (existing?.success === 1) {
    if (existing.checksum !== expectedChecksum || existing.migration_code !== EDUCATION_ENTITY_CODE) {
      throw new Error('تعريف نوع المنشأة التعليمية تغيّر بعد تطبيق ترحيله؛ أضف ترحيلاً جديداً بدلاً من تعديل النسخة المنشورة.');
    }
    return { version: EDUCATION_ENTITY_VERSION, alreadyApplied: true };
  }
  if (existing) db.prepare('DELETE FROM schema_migrations WHERE version=? AND success=0').run(EDUCATION_ENTITY_VERSION);
  const now = new Date().toISOString();
  const startedAt = Date.now();
  try {
    db.transaction(() => {
      db.prepare(`INSERT OR IGNORE INTO entity_types(entity_type_code,name_ar,description,is_active,created_at)
        VALUES('education_facility','منشأة تعليمية','نوع جامع للمدرسة وروضة الأطفال في سجل الكيانات.',1,?)`).run(now);
      db.prepare(`INSERT INTO schema_migrations(version,migration_code,migration_name,checksum,applied_at,execution_ms,success,details)
        VALUES(?,?,?,?,?,?,1,?)`).run(EDUCATION_ENTITY_VERSION,EDUCATION_ENTITY_CODE,'إضافة نوع كيان للمنشآت التعليمية',expectedChecksum,now,
          Date.now()-startedAt,'أُضيف نوع كيان جامع للمدارس ورياض الأطفال دون تعديل الجداول أو البيانات السابقة.');
    })();
  } catch (error) {
    db.prepare(`INSERT OR REPLACE INTO schema_migrations(version,migration_code,migration_name,checksum,applied_at,execution_ms,success,details)
      VALUES(?,?,?,?,?,?,0,?)`).run(EDUCATION_ENTITY_VERSION,EDUCATION_ENTITY_CODE,'إضافة نوع كيان للمنشآت التعليمية',expectedChecksum,
        new Date().toISOString(),Date.now()-startedAt,String(error.message).slice(0,4000));
    throw error;
  }
  return { version: EDUCATION_ENTITY_VERSION, alreadyApplied: false };
}

function rawCollectionChecksum() {
  const register = require('../../../scripts/manual-entry-requirement-register.cjs');
  return crypto.createHash('sha256').update(RAW_COLLECTION_CODE).update(register.SPECIFICATION_VERSION)
    .update(JSON.stringify(register.SPECIFICATION_ITEMS)).update('raw_collection_schema_v2|unclassified_raw_capture|long_text|analysis_ineligible').digest('hex');
}

function migrateRawCollectionForms(db) {
  const register = require('../../../scripts/manual-entry-requirement-register.cjs');
  const expectedChecksum = rawCollectionChecksum();
  const existing = db.prepare('SELECT * FROM schema_migrations WHERE version=?').get(RAW_COLLECTION_VERSION);
  if (existing?.success === 1) {
    if (existing.checksum !== expectedChecksum || existing.migration_code !== RAW_COLLECTION_CODE) {
      throw new Error('تغيّرت مواصفة نماذج الجمع الخام بعد تطبيق الترحيل؛ أضف إصداراً جديداً بدلاً من تعديل الإصدار المنشور.');
    }
    return { version: RAW_COLLECTION_VERSION, alreadyApplied: true,
      forms: db.prepare("SELECT COUNT(*) AS count FROM manual_entry_form_governance WHERE collection_mode='primary_collection' AND notes LIKE 'التقاط خام%' ").get().count,
      items: db.prepare('SELECT COUNT(*) AS count FROM manual_entry_requirement_items').get().count };
  }
  if (existing) db.prepare('DELETE FROM schema_migrations WHERE version=? AND success=0').run(RAW_COLLECTION_VERSION);
  const now = new Date().toISOString();
  const startedAt = Date.now();
  try {
    db.transaction(() => {
      db.exec(`CREATE TABLE IF NOT EXISTS manual_entry_requirement_items (
        requirement_item_id INTEGER PRIMARY KEY,
        item_code TEXT NOT NULL UNIQUE,
        group_id INTEGER NOT NULL REFERENCES manual_entry_groups(group_id),
        item_order INTEGER NOT NULL,
        requirement_text TEXT NOT NULL,
        semantic_class TEXT NOT NULL,
        classification_state TEXT NOT NULL CHECK(classification_state IN ('implemented_shared_capability','needs_item_level_classification')),
        field_definition_id INTEGER UNIQUE REFERENCES field_definitions(field_definition_id),
        specification_version TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(group_id,item_order)
      );
      CREATE INDEX IF NOT EXISTS idx_manual_entry_requirement_group ON manual_entry_requirement_items(group_id,item_order);
      `);
      const referenceId = db.prepare('SELECT reference_document_id FROM manual_entry_reference_documents WHERE reference_code=? AND version_number=?')
        .get(COLLECTION_FORM_REFERENCE.code,COLLECTION_FORM_REFERENCE.version)?.reference_document_id;
      if (!referenceId) throw new Error('مرجع مواصفة المستخدم غير مسجل.');
      const groups = new Map(db.prepare('SELECT group_id,group_code,name_ar FROM manual_entry_groups').all().map(group => [group.group_code,group]));
      const insertRequirement = db.prepare(`INSERT INTO manual_entry_requirement_items
        (item_code,group_id,item_order,requirement_text,semantic_class,classification_state,field_definition_id,specification_version,created_at)
        VALUES(?,?,?,?,?,?,?,?,?)`);
      const insertForm = db.prepare(`INSERT OR IGNORE INTO form_definitions(form_code,name_ar,description,data_structure_type,is_active,created_at,updated_at)
        VALUES(?,?,?,'raw_requirement_collection',1,?,?)`);
      const selectForm = db.prepare('SELECT form_id FROM form_definitions WHERE form_code=?');
      const insertVersion = db.prepare(`INSERT OR IGNORE INTO form_versions(form_id,version_number,version_label,status,definition_hash,change_summary,created_at,published_at)
        VALUES(?,1,'جمع خام غير مصنف v1','published',?,?,?,?)`);
      const selectVersion = db.prepare('SELECT form_version_id FROM form_versions WHERE form_id=? AND version_number=1');
      const insertSection = db.prepare(`INSERT OR IGNORE INTO form_sections(form_version_id,section_code,name_ar,section_type,sort_order,is_repeatable,is_required,created_at)
        VALUES(?,'raw_requirements','عناصر المواصفة كما وردت','data',1,0,0,?)`);
      const insertFieldDefinition = db.prepare(`INSERT OR IGNORE INTO field_definitions
        (field_code,canonical_name_ar,description,semantic_type,data_type,default_unit_id,reference_set_id,is_active,created_at,updated_at)
        VALUES(?,?,?,'raw_capture_prompt','long_text',NULL,NULL,1,?,?)`);
      const insertField = db.prepare(`INSERT OR IGNORE INTO form_fields
        (form_version_id,section_id,field_definition_id,field_code,label_ar,data_type_override,storage_class,is_required,allow_null,
         is_repeatable,is_derived,is_importable,sort_order,created_at)
        VALUES(?,?,?,?,?,'long_text','record_value',0,1,0,0,1,?,?)`);
      const insertFieldGovernance = db.prepare(`INSERT OR IGNORE INTO manual_entry_form_field_governance
        (form_field_id,definition_status,unit_status,methodology_status,analysis_eligible,notes,updated_at)
        VALUES(?,'needs_review','not_applicable','not_defined',0,?,?)`);
      const insertFormGovernance = db.prepare(`INSERT OR IGNORE INTO manual_entry_form_governance
        (form_version_id,collection_mode,definition_status,methodology_status,reference_status,analysis_eligible,notes,updated_at)
        VALUES(?,'primary_collection','provisional','not_defined','user_specification_only',0,?,?)`);
      const insertGroupForm = db.prepare(`INSERT OR IGNORE INTO manual_entry_group_forms(group_id,form_code,coverage_note) VALUES(?,?,?)`);
      const insertReference = db.prepare(`INSERT OR IGNORE INTO manual_entry_form_references
        (form_version_id,form_field_id,reference_document_id,source_clause) VALUES(?,?,?,?)`);
      let formCount = 0;
      let fieldCount = 0;
      for (const [groupCode,items] of Object.entries(register.SPECIFICATION_ITEMS)) {
        const group = groups.get(groupCode);
        if (!group) throw new Error(`مجموعة المواصفة غير موجودة لإنشاء الجمع الخام: ${groupCode}`);
        const sharedCapability = groupCode === 'crosscutting-documentation-quality.value-states';
        const formCode = `raw_collection_v1_${groupCode}`;
        let formVersionId = null;
        let sectionId = null;
        if (!sharedCapability) {
          const form = { code:formCode,groupCode,items };
          const formHash = crypto.createHash('sha256').update(JSON.stringify(form)).digest('hex');
          insertForm.run(formCode,`جمع خام أولي — ${group.name_ar}`,
            `تسجيل أولي حرفي لعناصر مواصفة المستخدم للمراجعة اللاحقة. هذه حقول نصية عامة وليست تعريفات دلالية معتمدة، ولا وحدات أو أبعاد أو منهجية تحليلية.`,now,now);
          const formId = selectForm.get(formCode).form_id;
          insertVersion.run(formId,formHash,'جمع خام أولي فقط؛ الحقول غير مصنفة دلالياً ولا تؤهل للتحليل الرسمي.',now,now);
          formVersionId = selectVersion.get(formId).form_version_id;
          insertSection.run(formVersionId,now);
          sectionId = db.prepare("SELECT section_id FROM form_sections WHERE form_version_id=? AND section_code='raw_requirements'").get(formVersionId).section_id;
          insertFormGovernance.run(formVersionId,'التقاط خام لعناصر المواصفة كما هي؛ النوع النصي وسيلة جمع فقط وليس تعريفاً دلالياً. لا توجد وحدة أو أبعاد أو مصدر رسمي معتمد أو منهجية؛ لا يدخل النموذج التحليل الرسمي.',now);
          insertGroupForm.run(group.group_id,formCode,'نموذج آلي لالتقاط عناصر المواصفة نصياً كبيانات خام غير مصنفة؛ لا يمثل اعتماد الحقول أو اكتمال المجموعة ولا يتيح التحليل الرسمي.');
          formCount += 1;
        }
        for (const [index,item] of items.entries()) {
          const itemCode = `${groupCode}.${String(index + 1).padStart(3,'0')}`;
          const semanticClass = sharedCapability ? 'shared_capability' : 'unclassified_raw_capture';
          const classificationState = sharedCapability ? 'implemented_shared_capability' : 'needs_item_level_classification';
        if (sharedCapability) {
          insertRequirement.run(itemCode,group.group_id,index + 1,item,semanticClass,classificationState,null,
            register.SPECIFICATION_VERSION,now);
          continue;
        }
        const fieldCode = `raw_requirement.${groupCode}.${String(index + 1).padStart(3,'0')}`;
        const description = `حقل التقاط خام لبند مواصفة؛ لا يعرّف المعنى أو النوع الدلالي أو الوحدة أو الأبعاد أو المصدر أو المنهجية. البند: ${item}`;
        insertFieldDefinition.run(fieldCode,item,description,now,now);
        const fieldDefinitionId = db.prepare('SELECT field_definition_id FROM field_definitions WHERE field_code=?').get(fieldCode).field_definition_id;
        insertField.run(formVersionId,sectionId,fieldDefinitionId,fieldCode,item,index + 1,now);
        const formFieldId = db.prepare('SELECT form_field_id FROM form_fields WHERE form_version_id=? AND field_code=?').get(formVersionId,fieldCode).form_field_id;
        insertFieldGovernance.run(formFieldId,'التقاط نصي مؤقت؛ يلزم تصنيف دلالي ومراجعة مستقلة.',now);
        insertReference.run(formVersionId,formFieldId,referenceId,item);
        insertRequirement.run(itemCode,group.group_id,index + 1,item,semanticClass,classificationState,fieldDefinitionId,
          register.SPECIFICATION_VERSION,now);
        fieldCount += 1;
        }
      }
      db.prepare(`INSERT INTO schema_migrations(version,migration_code,migration_name,checksum,applied_at,execution_ms,success,details)
        VALUES(?,?,?,?,?,?,1,?)`).run(RAW_COLLECTION_VERSION,RAW_COLLECTION_CODE,'نماذج الجمع الخام الديناميكية لعناصر المواصفة',expectedChecksum,now,
          Date.now()-startedAt,`أُنشئ ${formCount} نموذجاً آلياً و${fieldCount} حقل التقاط خام، مع تسجيل كل عناصر المواصفة؛ لا تأهيل تحليلي.`);
    })();
  } catch (error) {
    db.prepare(`INSERT OR REPLACE INTO schema_migrations(version,migration_code,migration_name,checksum,applied_at,execution_ms,success,details)
      VALUES(?,?,?,?,?,?,0,?)`).run(RAW_COLLECTION_VERSION,RAW_COLLECTION_CODE,'نماذج الجمع الخام الديناميكية لعناصر المواصفة',expectedChecksum,
        new Date().toISOString(),Date.now()-startedAt,String(error.message).slice(0,4000));
    throw error;
  }
  return { version:RAW_COLLECTION_VERSION,alreadyApplied:false,
    forms:db.prepare("SELECT COUNT(*) AS count FROM manual_entry_form_governance WHERE collection_mode='primary_collection' AND notes LIKE 'التقاط خام%' ").get().count,
    items:db.prepare('SELECT COUNT(*) AS count FROM manual_entry_requirement_items').get().count };
}

function listCatalog(db) {


  const rows = db.prepare(`SELECT d.domain_id,d.domain_code,d.name_ar AS domain_name_ar,d.sort_order AS domain_order,d.definition_state AS domain_state,
      g.group_id,g.group_code,g.name_ar AS group_name_ar,g.sort_order AS group_order,g.definition_state AS group_state,
      f.form_code,f.name_ar AS form_name_ar,v.form_version_id,v.status AS form_status,
      governance.collection_mode,governance.analysis_eligible
    FROM manual_entry_domains d
    LEFT JOIN manual_entry_groups g ON g.domain_id=d.domain_id
    LEFT JOIN manual_entry_group_forms gf ON gf.group_id=g.group_id
    LEFT JOIN form_definitions f ON f.form_code=gf.form_code AND f.is_active=1
    LEFT JOIN form_versions v ON v.form_id=f.form_id AND v.version_number=(SELECT MAX(v2.version_number) FROM form_versions v2 WHERE v2.form_id=f.form_id)
    LEFT JOIN manual_entry_form_governance governance ON governance.form_version_id=v.form_version_id
    ORDER BY d.sort_order,g.sort_order,f.form_code`).all();
  const domains = [];
  const byCode = new Map();
  for (const row of rows) {
    let domain = byCode.get(row.domain_code);
    if (!domain) {
      domain = { code: row.domain_code, name: row.domain_name_ar, order: row.domain_order, definitionState: row.domain_state, groups: [] };
      byCode.set(row.domain_code, domain);
      domains.push(domain);
    }
    if (!row.group_code) continue;
    let group = domain.groups.at(-1);
    if (!group || group.code !== row.group_code) {
      group = { id: row.group_id, code: row.group_code, name: row.group_name_ar, order: row.group_order, definitionState: row.group_state,
        fieldCoverageState: 'no_existing_field_mapping', forms: [], fields: [], publishedFields: [] };
      domain.groups.push(group);
    }
    if (row.form_code && row.form_version_id && row.form_status === 'published') {
      group.forms.push({ code: row.form_code, name: row.form_name_ar, versionId: row.form_version_id,
        rawCaptureOnly: row.form_code.startsWith('raw_collection_v1_'), collectionMode: row.collection_mode,
        analysisEligible: row.analysis_eligible == null ? 1 : row.analysis_eligible });
    }
  }
  const candidateRows = db.prepare(`SELECT group_catalog.group_code AS target_group_code,field.field_code,field.canonical_name_ar,
      field.semantic_type,field.data_type,unit.name_ar AS unit_name_ar,candidate.source_group_code,candidate.mapping_state,candidate.mapping_note
    FROM manual_entry_group_field_candidates candidate
    JOIN manual_entry_groups group_catalog ON group_catalog.group_id=candidate.group_id
    JOIN field_definitions field ON field.field_definition_id=candidate.field_definition_id
    LEFT JOIN measurement_units unit ON unit.unit_id=field.default_unit_id
    ORDER BY group_catalog.group_code,field.field_code,candidate.source_group_code`).all();
  const groupByCode = new Map(domains.flatMap(domain => domain.groups).map(group => [group.code,group]));
  for (const row of candidateRows) {
    const group = groupByCode.get(row.target_group_code);
    group.fieldCoverageState = 'needs_domain_review';
    let field = group.fields.find(item => item.code === row.field_code);
    if (!field) {
      field = { code: row.field_code, name: row.canonical_name_ar, semanticType: row.semantic_type, dataType: row.data_type,
        unit: row.unit_name_ar, mappingState: row.mapping_state, sourceGroupCodes: [] };
      group.fields.push(field);
    }
    if (!field.sourceGroupCodes.includes(row.source_group_code)) field.sourceGroupCodes.push(row.source_group_code);
  }
  const publishedFieldRows = db.prepare(`SELECT group_catalog.group_code AS target_group_code,form.form_code,field.field_code,
      field.canonical_name_ar,field.semantic_type,field.data_type,unit.name_ar AS unit_name_ar
    FROM manual_entry_group_forms mapping
    JOIN manual_entry_groups group_catalog ON group_catalog.group_id=mapping.group_id
    JOIN form_definitions form ON form.form_code=mapping.form_code AND form.is_active=1 AND form.form_code NOT LIKE 'raw_collection_v1_%'
    JOIN form_versions version ON version.form_id=form.form_id AND version.status='published'
    JOIN form_fields form_field ON form_field.form_version_id=version.form_version_id
    JOIN field_definitions field ON field.field_definition_id=form_field.field_definition_id
    LEFT JOIN measurement_units unit ON unit.unit_id=coalesce(form_field.unit_id,field.default_unit_id)
    ORDER BY group_catalog.group_code,form.form_code,field.field_code`).all();
  for (const row of publishedFieldRows) {
    const group = groupByCode.get(row.target_group_code);
    if (group.fieldCoverageState === 'no_existing_field_mapping') group.fieldCoverageState = 'published_fields_available';
    if (!group.publishedFields.some(field => field.code === row.field_code)) {
      group.publishedFields.push({ code: row.field_code, name: row.canonical_name_ar, semanticType: row.semantic_type,
        dataType: row.data_type, unit: row.unit_name_ar, formCodes: [] });
    }
    const field = group.publishedFields.find(item => item.code === row.field_code);
    if (!field.formCodes.includes(row.form_code)) field.formCodes.push(row.form_code);
  }
  const rawRequirements = db.prepare(`SELECT requirement.group_id,requirement.item_code,requirement.requirement_text,field.field_code
    FROM manual_entry_requirement_items requirement LEFT JOIN field_definitions field USING(field_definition_id)
    ORDER BY requirement.group_id,requirement.item_order`).all();
  const requirementsByGroup = new Map();
  for (const item of rawRequirements) {
    const items = requirementsByGroup.get(item.group_id) ?? [];
    items.push({ code:item.item_code,text:item.requirement_text,fieldCode:item.field_code });
    requirementsByGroup.set(item.group_id,items);
  }
  const requirementCounts = new Map(db.prepare(`SELECT group_id,COUNT(*) AS count,
      SUM(CASE WHEN field_definition_id IS NOT NULL THEN 1 ELSE 0 END) AS raw_capture_fields
    FROM manual_entry_requirement_items GROUP BY group_id`).all().map(row => [row.group_id,row]));
  for (const group of domains.flatMap(domain => domain.groups)) {
    const counts = requirementCounts.get(group.id);
    group.requirementItemCount = counts?.count ?? 0;
    group.rawCaptureFieldCount = counts?.raw_capture_fields ?? 0;
    group.rawRequirements = requirementsByGroup.get(group.id) ?? [];
    group.rawCaptureAvailable = group.forms.some(form => form.rawCaptureOnly);
  }
  return { version: CATALOG_VERSION, sourceNote: CATALOG_SOURCE, domains, fieldMappingNote: FIELD_CANDIDATE_NOTE };
}

module.exports = { CATALOG_VERSION, CATALOG_CODE, FIELD_CANDIDATE_VERSION, FIELD_CANDIDATE_LINKS, RAW_COLLECTION_VERSION, RAW_COLLECTION_CODE, DOMAINS, migrate, listCatalog };
