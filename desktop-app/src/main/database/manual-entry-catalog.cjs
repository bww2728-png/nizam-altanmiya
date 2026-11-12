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
    return { version: CATALOG_VERSION, alreadyApplied: true, fieldCandidates: migrateFieldCandidates(db) };
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
  return { version: CATALOG_VERSION, alreadyApplied: false, fieldCandidates };
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

function listCatalog(db) {
  const rows = db.prepare(`SELECT d.domain_id,d.domain_code,d.name_ar AS domain_name_ar,d.sort_order AS domain_order,d.definition_state AS domain_state,
      g.group_id,g.group_code,g.name_ar AS group_name_ar,g.sort_order AS group_order,g.definition_state AS group_state,
      f.form_code,f.name_ar AS form_name_ar,v.form_version_id,v.status AS form_status
    FROM manual_entry_domains d
    LEFT JOIN manual_entry_groups g ON g.domain_id=d.domain_id
    LEFT JOIN manual_entry_group_forms gf ON gf.group_id=g.group_id
    LEFT JOIN form_definitions f ON f.form_code=gf.form_code AND f.is_active=1
    LEFT JOIN form_versions v ON v.form_id=f.form_id AND v.version_number=(SELECT MAX(v2.version_number) FROM form_versions v2 WHERE v2.form_id=f.form_id)
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
      group.forms.push({ code: row.form_code, name: row.form_name_ar, versionId: row.form_version_id });
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
    JOIN form_definitions form ON form.form_code=mapping.form_code AND form.is_active=1
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
  return { version: CATALOG_VERSION, sourceNote: CATALOG_SOURCE, domains, fieldMappingNote: FIELD_CANDIDATE_NOTE };
}

module.exports = { CATALOG_VERSION, CATALOG_CODE, FIELD_CANDIDATE_VERSION, FIELD_CANDIDATE_LINKS, DOMAINS, migrate, listCatalog };
