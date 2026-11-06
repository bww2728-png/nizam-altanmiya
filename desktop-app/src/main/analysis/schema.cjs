'use strict';

/**
 * Canonical definition of the "القالب المحدث" (Local Development Template) data contract.
 *
 * Everything in this file is transcribed from the workbook itself, not invented:
 *  - INPUT_FIELDS  -> sheet "قاعدة البيانات الشاملة", header row 2, columns A..AM
 *  - DECISION_FIELD-> column BC
 *  - MANDATORY     -> the 13 fields used by the BD completeness formula
 *  - INDICATORS    -> columns AN..AY with the exact formulas and weights from AZ
 *  - PROJECT_TREE  -> the if/else ladder of column BA
 *
 * Keeping the transcription in one place is what makes the equivalence test
 * (tests/analysis.test.cjs) possible: the same table drives the engine, the
 * database migration and the export.
 */

const TEMPLATE = {
  fileName: 'القالب المحدث.xlsx',
  version: 'V3.3',
  sheet: 'قاعدة البيانات الشاملة',
  firstDataRow: 3,
  lastDataRow: 1002,
  columnCount: 67,
  inputRange: 'A3:AM1002',
  decisionRange: 'BC3:BC1002',
};

/** @typedef {'number'|'text'|'ratio'|'boolean'} FieldType */
/** @typedef {'public'|'restricted'|'sensitive'} Sensitivity */

/**
 * Input columns A..AM.
 * `unit` documents the unit the template expects, not the unit the user typed.
 * `ratio` fields are stored as fractions 0..1 by the template (V3.0 migration),
 * and `parse.cjs` is responsible for accepting "19.7" or "19.7%" and converting.
 */
const INPUT_FIELDS = [
  { key: 'districtName', column: 'A', header: 'اسم المديرية', type: 'text', unit: null, sensitivity: 'public', role: 'identity' },
  { key: 'districtNature', column: 'B', header: 'طبيعة المديرية', type: 'text', unit: null, sensitivity: 'public' },
  { key: 'population', column: 'C', header: 'عدد السكان', type: 'number', unit: 'نسمة', sensitivity: 'public', positive: true },
  { key: 'migrants', column: 'D', header: 'عدد المغتربين', type: 'number', unit: 'نسمة', sensitivity: 'public' },
  { key: 'governorate', column: 'E', header: 'المحافظة', type: 'text', unit: null, sensitivity: 'public', role: 'identity' },
  { key: 'densityPerKm2', column: 'F', header: 'الكثافة السكانية (نسمة/كم2)', type: 'number', unit: 'نسمة/كم2', sensitivity: 'public' },
  { key: 'expectedBeneficiaries', column: 'G', header: 'حجم المستفيدين المتوقع', type: 'number', unit: 'نسمة', sensitivity: 'public' },
  { key: 'schools', column: 'H', header: 'عدد المدارس', type: 'number', unit: 'مدرسة', sensitivity: 'public' },
  { key: 'enrolledStudents', column: 'I', header: 'عدد الملتحقين', type: 'number', unit: 'طالب', sensitivity: 'public' },
  { key: 'govFacilities', column: 'J', header: 'منشآت حكومية', type: 'number', unit: 'منشأة', sensitivity: 'public' },
  { key: 'privateFacilities', column: 'K', header: 'منشآت خاصة', type: 'number', unit: 'منشأة', sensitivity: 'public' },
  { key: 'waterCoverage', column: 'L', header: 'نسبة المياه %', type: 'ratio', unit: 'كسر 0-1 (تغطية)', sensitivity: 'public' },
  { key: 'pavedRoads', column: 'M', header: 'الطرق المزفلتة %', type: 'ratio', unit: 'كسر 0-1 (تغطية)', sensitivity: 'public' },
  { key: 'unpavedRoads', column: 'N', header: 'الطرق الترابية %', type: 'ratio', unit: 'كسر 0-1', sensitivity: 'public' },
  { key: 'cutRoads', column: 'O', header: 'الطرق شق %', type: 'ratio', unit: 'كسر 0-1', sensitivity: 'public' },
  { key: 'serviceDistanceKm', column: 'P', header: 'المسافة لمراكز الخدمات (كم)', type: 'number', unit: 'كم', sensitivity: 'public' },
  { key: 'revenue', column: 'Q', header: 'إيرادات المديرية', type: 'number', unit: 'ريال', sensitivity: 'restricted' },
  { key: 'agriProduction', column: 'R', header: 'إنتاج زراعي (طن)', type: 'number', unit: 'طن', sensitivity: 'public' },
  { key: 'livestockHeads', column: 'S', header: 'إنتاج حيواني (رأس)', type: 'number', unit: 'رأس', sensitivity: 'public' },
  { key: 'valueChains', column: 'T', header: 'عدد السلاسل الفاعلة', type: 'number', unit: 'سلسلة', sensitivity: 'public' },
  { key: 'inactiveValueChains', column: 'U', header: 'عدد السلاسل غير الفاعلة', type: 'number', unit: 'سلسلة', sensitivity: 'public' },
  { key: 'unemployment', column: 'V', header: 'نسبة البطالة %', type: 'ratio', unit: 'كسر 0-1', sensitivity: 'public' },
  { key: 'lostOpportunityType', column: 'W', header: 'نوع الفرص المهدرة', type: 'text', unit: null, sensitivity: 'public' },
  { key: 'associations', column: 'X', header: 'الجمعيات', type: 'number', unit: 'جمعية', sensitivity: 'public' },
  { key: 'goodsTons', column: 'Y', header: 'بضاعة (طن)', type: 'number', unit: 'طن', sensitivity: 'public' },
  { key: 'frontLine', column: 'Z', header: 'قرب خط النار', type: 'boolean', unit: 'نعم/لا', sensitivity: 'sensitive' },
  { key: 'povertyRatio', column: 'AA', header: 'نسبة الفقر والحرمان %', type: 'ratio', unit: 'كسر 0-1', sensitivity: 'restricted' },
  { key: 'vulnerableGroups', column: 'AB', header: 'نسبة الفئات الأكثر ضعفاً %', type: 'ratio', unit: 'كسر 0-1', sensitivity: 'restricted' },
  { key: 'serviceGapType', column: 'AC', header: 'نوع نقص الخدمات', type: 'text', unit: null, sensitivity: 'public' },
  { key: 'ruralPopulation', column: 'AD', header: 'سكان المناطق الريفية', type: 'number', unit: 'نسمة', sensitivity: 'public' },
  { key: 'geographicDispersion', column: 'AE', header: 'التشتت الجغرافي', type: 'text', unit: null, sensitivity: 'public' },
  { key: 'projectCost', column: 'AF', header: 'تكلفة المشاريع', type: 'number', unit: 'ريال', sensitivity: 'restricted' },
  { key: 'projectStatus', column: 'AG', header: 'حالة المشروع', type: 'text', unit: null, sensitivity: 'public' },
  { key: 'partnerIntegration', column: 'AH', header: 'التكامل مع خطط الشركاء', type: 'text', unit: null, sensitivity: 'public' },
  { key: 'communityParticipation', column: 'AI', header: 'قدرة المجتمع على المشاركة', type: 'text', unit: null, sensitivity: 'public' },
  { key: 'sustainabilityCriteria', column: 'AJ', header: 'معايير الاستدامة', type: 'text', unit: null, sensitivity: 'public' },
  { key: 'projectContinuity', column: 'AK', header: 'قابلية المشروع للاستمرار', type: 'text', unit: null, sensitivity: 'public' },
  { key: 'needAlignment', column: 'AL', header: 'توافق المشروع مع الاحتياج', type: 'text', unit: null, sensitivity: 'public' },
  { key: 'nationalAlignment', column: 'AM', header: 'موافقة الأهداف الوطنية', type: 'text', unit: null, sensitivity: 'public' },
];

const DECISION_FIELD = {
  key: 'reviewerDecision', column: 'BC', header: 'قرار المراجع', type: 'text', sensitivity: 'restricted',
  allowed: ['معتمد', 'مرفوض', 'مؤجل', 'بانتظار مراجعة'],
};

/**
 * The 13 completeness fields, in the exact order used by column BF so the
 * "missing fields" string matches the workbook byte for byte.
 */
const MANDATORY_FIELDS = [
  { key: 'population', label: 'سكان', column: 'C' },
  { key: 'waterCoverage', label: 'مياه', column: 'L' },
  { key: 'pavedRoads', label: 'طرق', column: 'M' },
  { key: 'revenue', label: 'إيرادات', column: 'Q' },
  { key: 'govFacilities', label: 'منشآت', column: 'J' },
  { key: 'schools', label: 'مدارس', column: 'H' },
  { key: 'agriProduction', label: 'زراعة', column: 'R' },
  { key: 'valueChains', label: 'سلاسل', column: 'T' },
  { key: 'projectCost', label: 'تكلفة', column: 'AF' },
  { key: 'associations', label: 'جمعيات', column: 'X' },
  { key: 'goodsTons', label: 'مساعدات', column: 'Y' },
  { key: 'frontLine', label: 'نار', column: 'Z' },
  { key: 'projectStatus', label: 'حالة مشروع', column: 'AG' },
];

/**
 * The twelve indicators.
 *
 * `formula` mirrors the Excel expression exactly; the engine implements it in
 * indicators.cjs and the equivalence test proves both agree.
 *
 * `direction`: 'needUp'  -> a larger value means more need (normalised as x-min)
 *              'needDown'-> a larger value means less need (normalised as max-x)
 *
 * `anchors` are used only by the calibrated mode: a fixed, documentable scale
 * instead of the sample-dependent Min–Max. They are parameters, not truths:
 * every anchor carries its provenance so an auditor can contest it.
 */
const INDICATORS = [
  {
    code: 'waterDeficit', excel: 'AN', header: 'عجز المياه %', unit: '%',
    formula: 'IF(L="", "", 100 - L*100)',
    direction: 'needUp', weight: 0.15, benchmark: 30, launch: { op: '>=', value: 50 },
    anchors: { good: 0, bad: 100, provenance: 'template-benchmark', note: 'تغطية 100% = لا عجز؛ 0% تغطية = عجز كامل' },
  },
  {
    code: 'frontLineRisk', excel: 'AO', header: 'قرب النار (0/1)', unit: '0/1',
    formula: 'IF(Z="", "", IF(Z="نعم", 1, 0))',
    direction: 'needUp', weight: 0.12, benchmark: 0, launch: { op: '=', value: 1 },
    anchors: { good: 0, bad: 1, provenance: 'administrative-definition', note: 'تعريف إداري ثنائي' },
  },
  {
    code: 'revenuePerCapita', excel: 'AP', header: 'نصيب الفرد من الإيراد', unit: 'ريال/فرد',
    formula: 'IF(OR(C="", Q=""), "", IF(C>0, Q/C, 0))',
    direction: 'needDown', weight: 0.13, benchmark: 5000, launch: { op: '<', value: 3000 },
    anchors: { good: 5000, bad: 0, provenance: 'template-benchmark', note: 'عتبة القالب 5000 ريال/فرد غير موثقة رسميًا' },
  },
  {
    code: 'roadsDeficit', excel: 'AQ', header: 'عجز الطرق %', unit: '%',
    formula: 'IF(M="", "", 100 - M*100)',
    direction: 'needUp', weight: 0.10, benchmark: 40, launch: { op: '>=', value: 50 },
    anchors: { good: 0, bad: 100, provenance: 'template-benchmark', note: 'نسبة الطرق غير المزفلتة' },
  },
  {
    code: 'populationPerFacility', excel: 'AR', header: 'سكان/منشأة', unit: 'نسمة/منشأة',
    formula: 'IF(OR(C="", J=""), "", IF(J>0, C/J, 0))',
    direction: 'needUp', weight: 0.10, benchmark: 30000, launch: { op: '>=', value: 40000 },
    anchors: { good: 30000, bad: 100000, provenance: 'derived', note: 'الحد الأعلى 100000 مشتق لا موثق' },
  },
  {
    code: 'schoolsPer10k', excel: 'AS', header: 'مدارس/10 آلاف', unit: 'مدرسة/10آلاف',
    formula: 'IF(OR(C="", H=""), "", IF(C>0, H/C*10000, 0))',
    direction: 'needDown', weight: 0.10, benchmark: 10, launch: { op: '<', value: 5 },
    anchors: { good: 10, bad: 0, provenance: 'template-benchmark', note: 'القالب: 10 مدارس لكل 10 آلاف' },
  },
  {
    code: 'agriPerCapita', excel: 'AT', header: 'إنتاج/فرد', unit: 'طن/1000 نسمة',
    formula: 'IF(OR(C="", R=""), "", IF(C>0, R/C*1000, 0))',
    direction: 'needDown', weight: 0.08, benchmark: 2, launch: null,
    anchors: { good: 2, bad: 0, provenance: 'template-benchmark', note: 'العنوان يقول «/فرد» والمعادلة ×1000 أي «/1000 نسمة»' },
  },
  {
    code: 'valueChainsScore', excel: 'AU', header: 'سلاسل قيمة (نقاط)', unit: 'سلسلة',
    formula: 'IF(T="", "", T*1)',
    direction: 'needDown', weight: 0.05, benchmark: 5, launch: null,
    anchors: { good: 5, bad: 0, provenance: 'template-benchmark', note: 'لا يوجد مرجع لسقف 5 سلاسل' },
  },
  {
    code: 'fiscalGap', excel: 'AV', header: 'عجز/فائض (مليار)', unit: 'مليار ريال',
    formula: 'IF(OR(AF="", Q=""), "", (AF - Q*0.1)/1000000000)',
    direction: 'needUp', weight: 0.05, benchmark: 0, launch: null,
    anchors: { good: 0, bad: 10, provenance: 'derived', note: 'الحد الأعلى 10 مليار مشتق؛ الصيغة تخصم 10% من الإيراد بلا توثيق' },
  },
  {
    code: 'associationsPer10k', excel: 'AW', header: 'جمعيات/10 آلاف', unit: 'جمعية/10آلاف',
    formula: 'IF(OR(C="", X=""), "", IF(C>0, X/C*10000, 0))',
    direction: 'needDown', weight: 0.05, benchmark: 0.5, launch: null,
    anchors: { good: 0.5, bad: 0, provenance: 'template-benchmark', note: 'لا مرجع لـ0.5 جمعية/10آلاف' },
  },
  {
    code: 'stalledProject', excel: 'AX', header: 'تعثر (0/1)', unit: '0/1',
    formula: 'IF(AG="", "", IF(AG="متعثر", 1, 0))',
    direction: 'needUp', weight: 0.04, benchmark: 0, launch: { op: '=', value: 1 },
    anchors: { good: 0, bad: 1, provenance: 'administrative-definition', note: 'تعريف إداري ثنائي' },
  },
  {
    code: 'aidPerCapita', excel: 'AY', header: 'مساعدات/فرد كجم', unit: 'كجم/فرد',
    formula: 'IF(OR(C="", Y=""), "", IF(C>0, Y*1000/C, 0))',
    direction: 'needDown', weight: 0.03, benchmark: 1, launch: null,
    anchors: { good: 1, bad: 0, provenance: 'template-benchmark', note: 'لا مرجع لـ1 كجم/فرد' },
  },
];

const INDICATOR_BY_CODE = Object.fromEntries(INDICATORS.map((indicator) => [indicator.code, indicator]));
const FIELD_BY_KEY = Object.fromEntries(INPUT_FIELDS.map((field) => [field.key, field]));
const FIELD_BY_COLUMN = Object.fromEntries(INPUT_FIELDS.map((field) => [field.column, field]));

/** Keys whose parsed value is a 0..1 fraction, with a percent fallback. */
const RATIO_KEYS = INPUT_FIELDS.filter((field) => field.type === 'ratio').map((field) => field.key);

/** Column BA project-type ladder, in evaluation order. */
const PROJECT_TREE = [
  { when: 'waterMissing', label: '⏳ بيانات ناقصة: المياه' },
  { when: 'waterCrisis', label: '🚰 مشروع مياه' },
  { when: 'frontLineMissing', label: '⏳ بيانات ناقصة: النار' },
  { when: 'frontLine', label: '🛡️ مشروع إنساني' },
  { when: 'roadsMissing', label: '⏳ بيانات ناقصة: الطرق' },
  { when: 'roadsCrisis', label: '🛣️ مشروع طرق' },
  { when: 'healthMissing', label: '⏳ بيانات ناقصة: الصحة' },
  { when: 'healthCrisis', label: '🏥 مشروع صحي' },
  { when: 'educationMissing', label: '⏳ بيانات ناقصة: التعليم' },
  { when: 'educationCrisis', label: '🏫 مشروع تعليم' },
  { when: 'economyMissing', label: '⏳ بيانات ناقصة: الإنتاج' },
  { when: 'economyCrisis', label: '💼 مشروع إنتاجي' },
  { when: 'stalledMissing', label: '⏳ بيانات ناقصة: التعثر' },
  { when: 'stalled', label: '🔧 إعادة تأهيل' },
  { when: 'fallback', label: '🔧 مشروع متعدد' },
];

/** Boundary-review margins used by column BB ("⚠️ حدّية"). */
const BOUNDARY_MARGINS = {
  waterDeficit: 5,
  roadsDeficit: 5,
  populationPerFacility: 2000,
  schoolsPer10k: 1,
  revenuePerCapita: 150,
};

const CONFIDENCE = {
  blocked: { icon: '⛔', label: 'محجوبة' },
  preliminary: { icon: '⚠️', label: 'مبدئية' },
  boundary: { icon: '⚠️', label: 'حدّية' },
  confirmed: { icon: '✅', label: 'مؤكدة' },
};

/** Calibrated-mode defaults. Documented, editable, and never hidden. */
const CALIBRATION = {
  /** Deprivation line on the 0..1 need scale. A dimension above it counts as degraded. */
  deprivationLine: 0.6,
  /** k of Alkire–Foster; default = one third of the twelve dimensions. */
  kThreshold: 4,
  /** Below this share of available indicator weight we refuse to publish a composite. */
  minWeightCoverage: 0.6,
  /** Severe deprivation forces the directorate into the top priority tier. */
  severeTierLabel: 'حرمان حاد',
};

module.exports = {
  TEMPLATE,
  INPUT_FIELDS,
  FIELD_BY_KEY,
  FIELD_BY_COLUMN,
  DECISION_FIELD,
  MANDATORY_FIELDS,
  INDICATORS,
  INDICATOR_BY_CODE,
  RATIO_KEYS,
  PROJECT_TREE,
  BOUNDARY_MARGINS,
  CONFIDENCE,
  CALIBRATION,
};