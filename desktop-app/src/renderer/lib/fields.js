/**
 * Presentation grouping of the 39 workbook input columns.
 *
 * The catalogue itself (header, type, unit, mandatory flag, aliases) comes from
 * the main process through `fieldCatalogue()`, so field metadata has one source
 * of truth. This file only says which group a field is shown under, because that
 * is a layout decision, not a data one.
 */

export const FIELD_GROUPS = [
  {
    id: 'identity',
    title: 'الهوية الجغرافية',
    hint: 'اسم المديرية والمحافظة هما مفتاح المطابقة عند إعادة الاستيراد.',
    fields: ['districtName', 'governorate', 'districtNature', 'geographicDispersion'],
  },
  {
    id: 'people',
    title: 'السكان',
    hint: 'أساس كل المؤشرات النسبية (نصيب الفرد، سكان/منشأة، مدارس/10 آلاف).',
    fields: ['population', 'migrants', 'densityPerKm2', 'ruralPopulation', 'expectedBeneficiaries'],
  },
  {
    id: 'services',
    title: 'الخدمات التعليمية والصحية',
    hint: 'عدد المدارس والمنشآت يحدد مؤشري «مدارس/10 آلاف» و«سكان/منشأة».',
    fields: ['schools', 'enrolledStudents', 'govFacilities', 'privateFacilities', 'serviceDistanceKm'],
  },
  {
    id: 'infrastructure',
    title: 'البنية التحتية',
    hint: 'النسب تُدخل ككسر بين 0 و1 (0.197 = 19.7%)، ويقبل النظام أيضاً الصيغة 19.7 ويحوّلها.',
    fields: ['waterCoverage', 'pavedRoads', 'unpavedRoads', 'cutRoads'],
  },
  {
    id: 'economy',
    title: 'الاقتصاد المحلي',
    hint: 'الإيرادات وتكلفة المشاريع بالريال اليمني؛ وباقي الحقول أعداد أو نصوص.',
    fields: [
      'revenue', 'agriProduction', 'livestockHeads', 'valueChains', 'inactiveValueChains',
      'associations', 'goodsTons', 'projectCost', 'unemployment', 'lostOpportunityType',
    ],
  },
  {
    id: 'risk',
    title: 'المخاطر والضعف',
    hint: 'قرب خط النار ونِسب الفقر والضعف تدخل في ترتيب الأولويات وأوزانها.',
    fields: ['frontLine', 'povertyRatio', 'vulnerableGroups', 'serviceGapType'],
  },
  {
    id: 'readiness',
    title: 'الجاهزية والمواءمة',
    hint: 'معايير الجاهزية الإدارية: حالة المشروع، المشاركة، الاستدامة، والمواءمة.',
    fields: [
      'projectStatus', 'partnerIntegration', 'communityParticipation',
      'sustainabilityCriteria', 'projectContinuity', 'needAlignment', 'nationalAlignment',
    ],
  },
];

/** Fallback keys used before the catalogue arrives, matching schema.cjs. */
export const MANDATORY_FALLBACK = [
  'population', 'waterCoverage', 'pavedRoads', 'revenue', 'govFacilities', 'schools',
  'agriProduction', 'valueChains', 'projectCost', 'associations', 'goodsTons',
  'frontLine', 'projectStatus',
];

export const DECISION_KEY = 'reviewerDecision';

/** Group id -> fields, for a key that is not listed in any group. */
export function groupOf(key) {
  for (const group of FIELD_GROUPS) if (group.fields.includes(key)) return group.id;
  return 'other';
}

/** Catalogue ready for rendering: groups in order, unknown keys collected last. */
export function groupCatalogue(catalogue) {
  const byKey = new Map(catalogue.map((field) => [field.key, field]));
  const used = new Set();
  const groups = FIELD_GROUPS.map((group) => {
    const fields = group.fields.map((key) => byKey.get(key)).filter(Boolean);
    fields.forEach((field) => used.add(field.key));
    return { ...group, fields };
  }).filter((group) => group.fields.length);
  const rest = catalogue.filter((field) => !used.has(field.key) && field.key !== DECISION_KEY);
  if (rest.length) groups.push({ id: 'other', title: 'حقول أخرى', hint: '', fields: rest });
  return groups;
}
