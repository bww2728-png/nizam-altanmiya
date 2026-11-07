/**
 * Formatting helpers shared by every screen.
 *
 * Latin digits are used deliberately: the source workbook and the exported
 * reports are Latin-digit, and mixing numeral systems inside one table is the
 * fastest way to make a column unreadable.
 */

const LOCALE = 'ar-YE-u-nu-latn';

const intFormat = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 0 });
const decimalFormat = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 2 });
const ratioFormat = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 1 });
const dateFormat = new Intl.DateTimeFormat(LOCALE, { dateStyle: 'medium' });
const dateTimeFormat = new Intl.DateTimeFormat(LOCALE, { dateStyle: 'medium', timeStyle: 'short' });

export const DASH = '—';

/** Numbers arrive as numbers from SQLite and as strings from `<input>`s. */
export function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(String(value).replace(/,/g, '').trim());
  return Number.isFinite(numeric) ? numeric : null;
}

export function fmtInt(value) {
  const numeric = toNumber(value);
  return numeric === null ? DASH : intFormat.format(numeric);
}

export function fmtNumber(value, digits = 2) {
  const numeric = toNumber(value);
  if (numeric === null) return DASH;
  if (digits === 0) return intFormat.format(numeric);
  return new Intl.NumberFormat(LOCALE, { maximumFractionDigits: digits }).format(numeric);
}

/** A stored ratio (0..1) shown as a percentage; accepts 19.7 as 19.7% too. */
export function fmtRatio(value) {
  const numeric = toNumber(value);
  if (numeric === null) return DASH;
  const ratio = Math.abs(numeric) > 1.5 ? numeric : numeric * 100;
  return `${ratioFormat.format(ratio)}%`;
}

/** Yemeni rials in words-scale units so a 165,000,000 column stays readable. */
export function fmtMoney(value) {
  const numeric = toNumber(value);
  if (numeric === null) return DASH;
  const abs = Math.abs(numeric);
  if (abs >= 1e9) return `${decimalFormat.format(numeric / 1e9)} مليار`;
  if (abs >= 1e6) return `${decimalFormat.format(numeric / 1e6)} مليون`;
  if (abs >= 1e3) return `${decimalFormat.format(numeric / 1e3)} ألف`;
  return intFormat.format(numeric);
}

/** Value formatter driven by the field type of the catalogue. */
export function fmtByType(value, type) {
  if (value === null || value === undefined || value === '') return DASH;
  if (type === 'ratio') return fmtRatio(value);
  if (type === 'boolean') return Number(value) === 1 || value === true ? 'نعم' : 'لا';
  if (type === 'number') return fmtNumber(value, 2);
  return String(value);
}

export function fmtDate(value) {
  if (!value) return DASH;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : dateFormat.format(date);
}

export function fmtDateTime(value) {
  if (!value) return DASH;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : dateTimeFormat.format(date);
}

export function fmtPercent(value, digits = 1) {
  const numeric = toNumber(value);
  if (numeric === null) return DASH;
  return `${new Intl.NumberFormat(LOCALE, { maximumFractionDigits: digits }).format(numeric)}%`;
}

/** `error` may be an IPC error object, a string, or anything thrown. */
export function errText(error) {
  if (!error) return '';
  if (typeof error === 'string') return error;
  return error.message ? String(error.message) : String(error);
}

export function cx(...values) {
  return values.filter(Boolean).join(' ');
}

export function titleCase(value) {
  const text = String(value ?? '');
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

/** Shorten a long path for a chip without hiding the file name. */
export function baseName(filePath) {
  if (!filePath) return DASH;
  return String(filePath).split(/[\\/]/).pop();
}
