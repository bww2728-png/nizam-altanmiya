'use strict';

const { INPUT_FIELDS, DECISION_FIELD, MANDATORY_FIELDS } = require('./schema.cjs');
const { DIRECTORATE_COLUMNS } = require('./store-schema.cjs');
const { stripDiacritics, normalizeDigits } = require('./parse.cjs');

/**
 * Arabic header matching.
 *
 * The existing importer treats row 1 of a sheet as the header row. Every real
 * workbook in this project has a *two-row* header (row 1 = group, row 2 = field
 * name), which is why a previous end-to-end run approved the literal text
 * "اسم المديرية" as if it were data. This module fixes the cause: it matches
 * headers by meaning, and it is told which row is the header row.
 */

/** Normalises a label for comparison only; never for storage. */
function normalizeLabel(value) {
  let text = normalizeDigits(String(value ?? ''));
  text = stripDiacritics(text);
  text = text
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[()[\]{}%٪:：،,.;/\\|_\-–—+*"'’‘`~!?؟]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  return text;
}

/** Extra Arabic wording seen in field-collected files. */
const ALIASES = {
  districtName: ['اسم المديرية', 'المديرية', 'اسم المديريه', 'مديرية'],
  governorate: ['المحافظة', 'اسم المحافظة', 'محافظة'],
  districtNature: ['طبيعة المديرية', 'طبيعة المنطقة'],
  population: ['عدد السكان', 'السكان', 'سكان المديرية', 'اجمالي السكان'],
  migrants: ['عدد المغتربين', 'المغتربون'],
  densityPerKm2: ['الكثافة السكانية', 'الكثافة', 'الكثافة السكانية نسمة كم2'],
  expectedBeneficiaries: ['حجم المستفيدين المتوقع', 'المستفيدون المتوقعون'],
  schools: ['عدد المدارس', 'المدارس'],
  enrolledStudents: ['عدد الملتحقين', 'الملتحقون', 'الطلاب', 'الطلاب الملتحقون', 'عدد الطلاب', 'الدارسون'],
  govFacilities: ['منشآت حكومية', 'المنشآت الحكومية', 'المرافق الحكومية'],
  privateFacilities: ['منشآت خاصة', 'المنشآت الخاصة', 'المرافق الخاصة'],
  waterCoverage: ['نسبة المياه', 'تغطية المياه', 'نسبة تغطية المياه', 'المياه'],
  pavedRoads: ['الطرق المزفلتة', 'نسبة الطرق المزفلتة', 'الطرق المسفلتة'],
  unpavedRoads: ['الطرق الترابية', 'نسبة الطرق الترابية'],
  cutRoads: ['الطرق شق', 'الطرق المشقوقة'],
  serviceDistanceKm: ['المسافة لمراكز الخدمات', 'المسافة لمراكز الخدمة', 'المسافة كم'],
  revenue: ['ايرادات المديرية', 'الايرادات', 'الموارد المالية', 'الايراد'],
  agriProduction: ['انتاج زراعي', 'الانتاج الزراعي', 'انتاج زراعي طن'],
  livestockHeads: ['انتاج حيواني', 'الثروة الحيوانية', 'المواشي'],
  valueChains: ['عدد السلاسل الفاعلة', 'السلاسل الفاعلة', 'سلاسل القيمة الفاعلة'],
  inactiveValueChains: ['عدد السلاسل غير الفاعلة', 'السلاسل غير الفاعلة'],
  unemployment: ['نسبة البطالة', 'البطالة'],
  lostOpportunityType: ['نوع الفرص المهدرة', 'الفرص المهدرة'],
  associations: ['الجمعيات', 'عدد الجمعيات', 'منظمات المجتمع'],
  goodsTons: ['بضاعه', 'المساعدات', 'البضائع'],
  frontLine: ['قرب خط النار', 'خط النار', 'القرب من خط النار'],
  povertyRatio: ['نسبة الفقر والحرمان', 'نسبة الفقر', 'الفقر'],
  vulnerableGroups: ['نسبة الفئات الاكثر ضعفا', 'الفئات الاكثر ضعفا', 'الفئات الضعيفة'],
  serviceGapType: ['نوع نقص الخدمات', 'نقص الخدمات'],
  ruralPopulation: ['سكان المناطق الريفية', 'السكان الريفيون', 'سكان الريف'],
  geographicDispersion: ['التشتت الجغرافي', 'التشتت'],
  projectCost: ['تكلفه المشاريع', 'التكلفة', 'تكلفة المشروع'],
  projectStatus: ['حاله المشروع', 'حالة المشاريع', 'وضع المشروع'],
  partnerIntegration: ['التكامل مع خطط الشركاء', 'التكامل مع الشركاء'],
  communityParticipation: ['قدره المجتمع علي المشاركه', 'مشاركة المجتمع'],
  sustainabilityCriteria: ['معايير الاستدامه', 'الاستدامة'],
  projectContinuity: ['قابليه المشروع للاستمرار', 'استمرارية المشروع'],
  needAlignment: ['توافق المشروع مع الاحتياج', 'المواءمة مع الاحتياج'],
  nationalAlignment: ['موافقه الاهداف الوطنيه', 'الاهداف الوطنية'],
  reviewerDecision: ['قرار المراجع', 'القرار'],
};

function tokens(label) {
  return new Set(normalizeLabel(label).split(' ').filter(Boolean));
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

const FIELDS = [...INPUT_FIELDS, DECISION_FIELD];

/** Pre-computed index: normalised header/alias -> field key. */
const EXACT = new Map();
const ALIAS_INDEX = new Map();
for (const field of FIELDS) {
  EXACT.set(normalizeLabel(field.header), field.key);
  for (const alias of ALIASES[field.key] ?? []) ALIAS_INDEX.set(normalizeLabel(alias), field.key);
}

/**
 * @returns {{key: string|null, score: number, method: string}}
 */
function matchHeader(rawLabel, options = {}) {
  const threshold = options.threshold ?? 0.62;
  const normalized = normalizeLabel(rawLabel);
  if (!normalized) return { key: null, score: 0, method: 'empty' };

  if (EXACT.has(normalized)) return { key: EXACT.get(normalized), score: 1, method: 'header' };
  if (ALIAS_INDEX.has(normalized)) return { key: ALIAS_INDEX.get(normalized), score: 0.98, method: 'alias' };

  const inputTokens = tokens(normalized);
  let best = { key: null, score: 0, method: 'none' };
  for (const field of FIELDS) {
    const candidates = [field.header, ...(ALIASES[field.key] ?? [])];
    for (const candidate of candidates) {
      const score = jaccard(inputTokens, tokens(candidate));
      if (score > best.score) best = { key: field.key, score, method: 'similarity' };
    }
  }
  if (best.score < threshold) return { key: null, score: best.score, method: 'none' };
  return { key: best.key, score: 0.6 + 0.3 * best.score, method: best.method };
}

/**
 * Maps a header row (array of cell texts, index 0 = column A) to canonical keys.
 * When two columns claim the same field, the higher score wins and the loser is
 * reported so nothing is dropped silently.
 */
function mapHeaderRow(cells) {
  const columnMap = {};
  const taken = new Map();
  const unmatched = [];
  const duplicates = [];

  cells.forEach((label, index) => {
    if (label === null || label === undefined || String(label).trim() === '') return;
    const match = matchHeader(label);
    if (!match.key) {
      unmatched.push({ column: index + 1, label: String(label) });
      return;
    }
    const previous = taken.get(match.key);
    if (previous && previous.score >= match.score) {
      duplicates.push({ column: index + 1, label: String(label), key: match.key, keptColumn: previous.column });
      return;
    }
    if (previous) duplicates.push({ column: previous.column, label: previous.label, key: match.key, keptColumn: index + 1 });
    taken.set(match.key, { column: index + 1, score: match.score, label: String(label), method: match.method });
    columnMap[match.key] = index + 1;
  });

  return {
    columnMap,
    matched: [...taken.entries()].map(([key, info]) => ({ key, ...info })),
    unmatched,
    duplicates,
  };
}

/** How many canonical fields a candidate header row matches. */
function scoreHeaderRow(cells) {
  return Object.keys(mapHeaderRow(cells).columnMap).length;
}

/** Canonical field table for the UI ("mapping" screen). */
function mappingTable() {
  const mandatoryKeys = new Set(MANDATORY_FIELDS.map((field) => field.key));
  return FIELDS.map((field) => ({
    key: field.key,
    column: field.column,
    // The database column matters to the UI because the browse table receives
    // raw rows (snake_case) while the editor works with field keys.
    dbColumn: DIRECTORATE_COLUMNS[field.key] ?? null,
    header: field.header,
    type: field.type,
    unit: field.unit ?? null,
    sensitivity: field.sensitivity,
    // The interface uses these three flags to render required markers, the
    // "must be positive" hint and the decision dropdown without duplicating the
    // schema in the renderer.
    mandatory: mandatoryKeys.has(field.key),
    positive: Boolean(field.positive),
    allowed: field.allowed ?? null,
    aliases: ALIASES[field.key] ?? [],
  }));
}

module.exports = {
  normalizeLabel,
  matchHeader,
  mapHeaderRow,
  scoreHeaderRow,
  mappingTable,
  ALIASES,
};