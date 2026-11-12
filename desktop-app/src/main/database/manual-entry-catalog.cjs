'use strict';

const crypto = require('node:crypto');

const CATALOG_VERSION = 5;
const CATALOG_CODE = '2026-11-12-manual-entry-domain-catalog-v5';
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
    return { version: CATALOG_VERSION, alreadyApplied: true };
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
  return { version: CATALOG_VERSION, alreadyApplied: false };
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
      group = { id: row.group_id, code: row.group_code, name: row.group_name_ar, order: row.group_order, definitionState: row.group_state, forms: [] };
      domain.groups.push(group);
    }
    if (row.form_code && row.form_version_id && row.form_status === 'published') {
      group.forms.push({ code: row.form_code, name: row.form_name_ar, versionId: row.form_version_id });
    }
  }
  return { version: CATALOG_VERSION, sourceNote: CATALOG_SOURCE, domains };
}

module.exports = { CATALOG_VERSION, CATALOG_CODE, DOMAINS, migrate, listCatalog };
