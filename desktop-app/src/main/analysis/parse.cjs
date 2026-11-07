'use strict';

/**
 * Arabic-first value parsing.
 *
 * The template is an Arabic Excel workbook: values arrive as strings from the
 * importer, often with Arabic-Indic digits, Arabic separators, percent signs,
 * placeholders such as "—" or "غير متوفر", and — most dangerously — ratios
 * typed as percentages ("19.7") where the workbook expects a fraction (0.197).
 *
 * Every function here returns a *state* instead of throwing, because a data
 * gap must be reportable, not fatal.
 */

const ARABIC_INDIC = '٠١٢٣٤٥٦٧٨٩';
const EXTENDED_ARABIC_INDIC = '۰۱۲۳۴۵۶۷۸۹';

const PLACEHOLDERS = new Set([
  '', '-', '—', '–', '...', '…', 'لا يوجد', 'غير متوفر', 'غير متوفرة', 'غير متاح',
  'غير معروف', 'لا شيء', 'مجهول', 'n/a', 'na', 'null', 'nil', 'none', 'undefined', '؟', '?',
]);

const TRUE_WORDS = new Set(['نعم', 'يوجد', 'يوجد تعثر', 'متعثر', 'true', 'yes', 'y', '1', 'صحيح', 'مؤكد']);
const FALSE_WORDS = new Set(['لا', 'لا يوجد', 'غير متعثر', 'false', 'no', 'n', '0', 'خطأ', 'غير مؤكد']);

function normalizeDigits(value) {
  if (typeof value !== 'string') return String(value ?? '');
  return value
    .replace(/[٠-٩]/g, (digit) => String(ARABIC_INDIC.indexOf(digit)))
    .replace(/[۰-۹]/g, (digit) => String(EXTENDED_ARABIC_INDIC.indexOf(digit)))
    // Superscript/subscript digits appear in headers such as «نسمة/كم²».
    .replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]/g, (digit) => String('⁰¹²³⁴⁵⁶⁷⁸⁹'.indexOf(digit)))
    .replace(/[₀₁₂₃₄₅₆₇₈₉]/g, (digit) => String('₀₁₂₃₄₅₆₇₈₉'.indexOf(digit)));
}

/** Removes tashkeel/tatweel so labels compare reliably ("المديريّة" == "المديرية"). */
function stripDiacritics(value) {
  return String(value ?? '')
    .replace(/[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED]/g, '')
    .replace(/\u0640/g, '');
}

function roundHalfAway(value, digits = 0) {
  if (!Number.isFinite(value)) return NaN;
  const factor = 10 ** digits;
  const scaled = value * factor;
  const rounded = scaled >= 0 ? Math.floor(scaled + 0.5 + 1e-9) : Math.ceil(scaled - 0.5 - 1e-9);
  return rounded / factor;
}

/** Excel-compatible TEXT(value, "0.000"). */
function formatFixed(value, digits = 3) {
  if (value === null || value === undefined || value === '' || !Number.isFinite(Number(value))) return '—';
  return roundHalfAway(Number(value), digits).toFixed(digits);
}

/** Excel-compatible TEXT(value, "0%"). */
function formatPercent(ratio, digits = 0) {
  if (ratio === null || ratio === undefined || !Number.isFinite(Number(ratio))) return '—';
  return `${roundHalfAway(Number(ratio) * 100, digits).toFixed(digits)}%`;
}

function emptyResult(raw, reason = 'empty') {
  if (reason === 'empty') return { state: 'empty', value: null, raw, warnings: [] };
  // A placeholder ("—", "غير متوفر") is an explicit "no value", not a parse failure.
  if (reason === 'placeholder') return { state: 'empty', value: null, raw, warnings: [{ code: 'placeholder' }] };
  return { state: 'invalid', value: null, raw, warnings: [{ code: reason }] };
}

/**
 * Parses a numeric cell that may be Arabic, may contain thousands separators,
 * may carry a percent sign, and may be a placeholder.
 *
 * @returns {{state: 'ok'|'empty'|'invalid', value: number|null, raw: any, warnings: Array<{code: string}>}}
 */
function parseNumber(raw) {
  if (raw === null || raw === undefined) return emptyResult(raw);
  if (typeof raw === 'number') return Number.isFinite(raw) ? { state: 'ok', value: raw, raw, warnings: [] } : emptyResult(raw, 'invalid-number');

  let text = normalizeDigits(String(raw)).trim();
  if (!text) return emptyResult(raw);
  const lowered = text.toLowerCase();
  if (PLACEHOLDERS.has(lowered)) return emptyResult(raw, 'placeholder');

  const warnings = [];
  let hadPercent = false;
  if (/[%٪]/.test(text)) {
    hadPercent = true;
    text = text.replace(/[%٪]/g, '');
    warnings.push({ code: 'had-percent' });
  }

  // Negative markers used in Arabic sheets.
  const negative = /^[-−–]/.test(text);
  text = text.replace(/^[-−–+]\s*/, '').replace(/\s/g, '').replace(/[\u066C\u060C\u2019']/g, '');

  const dots = (text.match(/\./g) || []).length;
  const commas = (text.match(/,/g) || []).length;
  if (dots && commas) {
    // Both present: the right-most separator is the decimal mark.
    if (text.lastIndexOf(',') > text.lastIndexOf('.')) text = text.replace(/\./g, '').replace(',', '.');
    else text = text.replace(/,/g, '');
  } else if (commas) {
    const parts = text.split(',');
    const looksLikeThousands = parts.length > 1 && parts.slice(1).every((part) => part.length === 3);
    text = looksLikeThousands ? text.replace(/,/g, '') : text.replace(',', '.');
  }

  if (!/^\d*\.?\d+$|^\d+\.$/.test(text)) return emptyResult(raw, 'invalid-number');
  const value = Number(text);
  if (!Number.isFinite(value)) return emptyResult(raw, 'invalid-number');
  return { state: 'ok', value: negative ? -value : value, raw, warnings };
}

/**
 * Ratio fields are stored as fractions 0..1 by the template (V3.0 migration).
 * A value above 1 but at most 100 is treated as a percentage and converted,
 * with an explicit warning so the review screen can show it.
 */
function parseRatio(raw) {
  const parsed = parseNumber(raw);
  if (parsed.state !== 'ok') return parsed;
  const warnings = parsed.warnings.filter((warning) => warning.code !== 'had-percent');
  const hadPercent = parsed.warnings.some((warning) => warning.code === 'had-percent');
  let value = parsed.value;

  if (hadPercent) {
    if (value > 100) return emptyResult(raw, 'ratio-out-of-range');
    value /= 100;
    warnings.push({ code: 'percent-converted' });
  } else if (value > 1) {
    if (value > 100) return emptyResult(raw, 'ratio-out-of-range');
    value /= 100;
    warnings.push({ code: 'percent-converted' });
  }
  if (value < 0) return emptyResult(raw, 'ratio-out-of-range');
  return { state: 'ok', value, raw, warnings };
}

function parseBoolean(raw) {
  if (raw === null || raw === undefined) return emptyResult(raw);
  if (typeof raw === 'boolean') return { state: 'ok', value: raw ? 1 : 0, raw, warnings: [] };
  if (typeof raw === 'number') {
    if (raw === 1) return { state: 'ok', value: 1, raw, warnings: [] };
    if (raw === 0) return { state: 'ok', value: 0, raw, warnings: [] };
    return emptyResult(raw, 'invalid-boolean');
  }
  const text = stripDiacritics(normalizeDigits(String(raw))).trim().replace(/\s+/g, ' ');
  if (!text) return emptyResult(raw);
  const lowered = text.toLowerCase();
  if (PLACEHOLDERS.has(lowered)) return emptyResult(raw, 'placeholder');
  if (TRUE_WORDS.has(lowered)) return { state: 'ok', value: 1, raw, warnings: [] };
  if (FALSE_WORDS.has(lowered)) return { state: 'ok', value: 0, raw, warnings: [] };
  return emptyResult(raw, 'invalid-boolean');
}

function parseText(raw) {
  if (raw === null || raw === undefined) return emptyResult(raw);
  const text = stripDiacritics(normalizeDigits(String(raw))).replace(/\s+/g, ' ').trim();
  if (!text) return emptyResult(raw);
  const lowered = text.toLowerCase();
  if (PLACEHOLDERS.has(lowered)) return emptyResult(raw, 'placeholder');
  return { state: 'ok', value: text, raw, warnings: [] };
}

function parseFieldValue(raw, field) {
  switch (field.type) {
    case 'number': return parseNumber(raw);
    case 'ratio': return parseRatio(raw);
    case 'boolean': return parseBoolean(raw);
    default: return parseText(raw);
  }
}

module.exports = {
  normalizeDigits,
  stripDiacritics,
  roundHalfAway,
  formatFixed,
  formatPercent,
  parseNumber,
  parseRatio,
  parseBoolean,
  parseText,
  parseFieldValue,
  PLACEHOLDERS,
};