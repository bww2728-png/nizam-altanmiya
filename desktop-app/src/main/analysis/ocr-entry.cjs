'use strict';

/**
 * Turns raw OCR text into proposed directorate fields for the manual-entry screen.
 *
 * Design rule: OCR is never trusted. This module only produces *proposals* with
 * their raw text and a confidence proxy (the header-match score); the user must
 * review and confirm every value before it reaches the encrypted store.
 */

const { INPUT_FIELDS, FIELD_BY_KEY } = require('./schema.cjs');
const { matchHeader } = require('./mapping.cjs');
const { parseFieldValue } = require('./parse.cjs');

const MAX_LINES = 4000;
const MAX_TEXT = 400000;

/**
 * Below these thresholds a proposal is marked `needsReview` instead of being
 * presented as a normal value. They are deliberately conservative: a false
 * "low confidence" costs one click, a false "high confidence" costs a wrong
 * decision.
 */
const MIN_LINE_CONFIDENCE = 0.6;
const MIN_HEADER_SCORE = 0.72;

/** Separators that appear between a label and its value in real forms. */
const SEPARATOR = /[:：؛\t=]/;

/** Units that OCR commonly glues onto a numeric value. */
const UNIT_SUFFIX = /(?:\s|^)(?:نسمة|نسمه|فرد|كم|كيلومتر|مدرسة|مدارس|طالب|طلاب|منشأة|منشأه|منشات|ريال|طن|رأس|راس|سلسلة|سلسله|جمعية|جمعيه|كجم|كيلوغرام)\s*$/u;

const NUMERIC_TYPES = new Set(['number', 'ratio', 'boolean']);

function cleanLine(value) {
  // Keep internal runs of spaces: they are the only table-like signal OCR gives
  // us for "label    value" lines that have no colon.
  return String(value ?? '').replace(/\u0000/g, '').trim();
}

function stripUnitSuffix(field, value) {
  if (!field || !NUMERIC_TYPES.has(field.type)) return value;
  let text = String(value).trim();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const next = text.replace(UNIT_SUFFIX, '').trim();
    if (next === text || !next) break;
    text = next;
  }
  return text;
}

/**
 * Splits one OCR line into a label and a value using, in order:
 *  1. an explicit separator (`:`, `：`, `؛`, tab, `=`);
 *  2. a run of two or more spaces (table-like OCR output);
 *  3. a leading phrase that matches a known header/alias.
 *
 * @returns {{label:string, value:string, method:string}}
 */
function splitLabelValue(line) {
  const text = cleanLine(line);
  if (!text) return { label: '', value: '', method: 'empty' };

  const separator = text.match(SEPARATOR);
  if (separator) {
    return {
      label: text.slice(0, separator.index).trim(),
      value: text.slice(separator.index + separator[0].length).trim(),
      method: 'separator',
    };
  }

  const runs = [...text.matchAll(/ {2,}/g)];
  for (const run of runs) {
    const label = text.slice(0, run.index).trim();
    const value = text.slice(run.index + run[0].length).trim();
    if (label && value && matchHeader(label).score >= 0.62) {
      return { label, value, method: 'spaces' };
    }
  }

  const words = text.split(' ').filter(Boolean);
  for (let count = Math.min(5, words.length - 1); count >= 1; count -= 1) {
    const label = words.slice(0, count).join(' ');
    if (matchHeader(label).score >= 0.8) {
      return { label, value: words.slice(count).join(' '), method: 'prefix' };
    }
  }

  return { label: text, value: '', method: 'none' };
}

function emptyProposal() {
  return { lines: [], fields: {}, unmatched: [], warnings: [], truncated: false };
}

/**
 * Detects a line that actually contains two fields (a header row read by OCR as
 * "label   label", or two "label: value" pairs separated by a tab). Such a line
 * must never be turned into a low-quality text value with a high label score.
 */
function looksLikeMultiField(value) {
  const text = String(value ?? '').trim();
  if (!text) return false;
  if (matchHeader(text).score >= 0.8) return true;

  const chunks = text.split(/ {2,}/).map((chunk) => chunk.trim()).filter(Boolean);
  if (chunks.length > 1 && chunks.slice(1).some((chunk) => matchHeader(chunk).score >= 0.62)) return true;

  const parts = text.split(SEPARATOR).map((part) => part.trim()).filter(Boolean);
  if (parts.length > 1 && parts.slice(1).some((part) => matchHeader(part).score >= 0.62)) return true;

  return false;
}

/**
 * Parses OCR text into `{ fields, unmatched, warnings }`.
 *
 * `fields[key] = { raw, value, score, method, header, confidence, needsReview, reviewReasons }`
 * where `value` is already typed (number / 0..1 ratio / 0|1 boolean / text).
 * Invalid or unknown lines are reported instead of guessed.
 *
 * @param {string} text
 * @param {{lineConfidence?:Array<number>, lineConfidenceByText?:Map<string,number>}} options
 * @returns {{lines:string[], fields:object, unmatched:Array, warnings:Array}}
 */
function parseLabeledText(text, options = {}) {
  const original = String(text ?? '');
  const source = original.slice(0, MAX_TEXT);
  if (!source.trim()) return emptyProposal();

  const allLines = source
    .split(/\r?\n/)
    .map(cleanLine)
    .filter(Boolean);
  const lines = allLines.slice(0, MAX_LINES);
  const truncated = original.length > MAX_TEXT || allLines.length > MAX_LINES;

  const lineConfidence = Array.isArray(options.lineConfidence) ? options.lineConfidence : [];
  const byText = options.lineConfidenceByText instanceof Map ? options.lineConfidenceByText : null;
  const confidenceOf = (line, index) => {
    const direct = Number(lineConfidence[index]);
    if (Number.isFinite(direct) && direct > 0) return Math.max(0, Math.min(1, direct));
    if (byText && byText.has(line)) return Math.max(0, Math.min(1, Number(byText.get(line))));
    return null;
  };

  const fields = {};
  const unmatched = [];
  const warnings = [];
  const claimed = new Map();

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const split = splitLabelValue(line);
    if (!split.value) {
      if (/[\u0600-\u06FF]/.test(line) && line.length > 1) unmatched.push({ raw: line, reason: 'no-value' });
      continue;
    }

    if (looksLikeMultiField(split.value)) {
      unmatched.push({ raw: line, label: split.label, reason: 'multi-field-line' });
      continue;
    }

    const match = matchHeader(split.label);
    if (!match.key || !FIELD_BY_KEY[match.key]) {
      unmatched.push({ raw: line, label: split.label, reason: 'unknown-label' });
      continue;
    }

    if (claimed.has(match.key)) {
      warnings.push({ key: match.key, header: FIELD_BY_KEY[match.key].header, raw: line, code: 'duplicate-line' });
      continue;
    }

    const field = FIELD_BY_KEY[match.key];
    const candidate = stripUnitSuffix(field, split.value);
    const parsed = parseFieldValue(candidate, field);

    if (parsed.state === 'invalid') {
      warnings.push({ key: match.key, header: field.header, raw: split.value, line, code: `invalid-${field.type}` });
      continue;
    }
    if (parsed.state === 'empty') continue;

    const engineConfidence = confidenceOf(line, index);
    const reviewReasons = [];
    if (engineConfidence !== null && engineConfidence < MIN_LINE_CONFIDENCE) reviewReasons.push('low-ocr-confidence');
    if (match.score < MIN_HEADER_SCORE) reviewReasons.push('weak-label-match');
    if (split.method === 'prefix') reviewReasons.push('label-guessed');
    for (const warning of parsed.warnings) {
      // A converted percentage is exactly the kind of silent change this screen
      // must surface, so it forces review rather than riding along unnoticed.
      reviewReasons.push(warning.code);
    }

    fields[match.key] = {
      raw: split.value,
      value: parsed.value,
      score: match.score,
      method: split.method,
      header: field.header,
      confidence: engineConfidence,
      needsReview: reviewReasons.length > 0,
      reviewReasons,
    };
    claimed.set(match.key, true);
    for (const warning of parsed.warnings) {
      warnings.push({ key: match.key, header: field.header, raw: split.value, code: warning.code });
    }
  }

  return { lines, fields, unmatched: unmatched.slice(0, 200), warnings: warnings.slice(0, 200), truncated };
}

/**
 * Cross-field sanity checks that catch the errors OCR makes most often: a
 * decimal point that disappears ("43739" read as "4373.9"), a student count
 * larger than the population, a coverage above 100%.
 *
 * Returns warnings only; it never changes a value.
 */
function crossFieldWarnings(fields) {
  const issues = [];
  const value = (key) => (fields[key] ? Number(fields[key].value) : null);
  const population = value('population');
  const enrolled = value('enrolledStudents');
  const schools = value('schools');
  const beneficiaries = value('expectedBeneficiaries');
  const rural = value('ruralPopulation');

  if (Number.isFinite(population) && population > 0) {
    if (Number.isFinite(enrolled) && enrolled > population) {
      issues.push({ key: 'enrolledStudents', code: 'enrolled-exceeds-population', detail: `الملتحقون (${enrolled}) أكبر من السكان (${population})` });
    }
    if (Number.isFinite(beneficiaries) && beneficiaries > population) {
      issues.push({ key: 'expectedBeneficiaries', code: 'beneficiaries-exceed-population', detail: `المستفيدون (${beneficiaries}) أكبر من السكان (${population})` });
    }
    if (Number.isFinite(rural) && rural > population) {
      issues.push({ key: 'ruralPopulation', code: 'rural-exceeds-population', detail: `سكان الريف (${rural}) أكبر من السكان (${population})` });
    }
    if (Number.isFinite(schools) && schools > population) {
      issues.push({ key: 'schools', code: 'schools-exceed-population', detail: `المدارس (${schools}) أكبر من السكان (${population})` });
    }
  }
  for (const [key, entry] of Object.entries(fields)) {
    const field = FIELD_BY_KEY[key];
    if (!field) continue;
    if (field.type === 'ratio' && Number.isFinite(Number(entry.value)) && (entry.value < 0 || entry.value > 1)) {
      issues.push({ key, code: 'ratio-out-of-range', detail: `${field.header} خارج المدى 0-1` });
    }
  }
  return issues;
}

/**
 * Reads an image or PDF locally and returns both the raw text and the parsed,
 * reviewable proposal. Recognition never writes to the database.
 */
async function recognizeEntryFile(filePath, options = {}) {
  // Required lazily so unit tests can exercise parseLabeledText without loading
  // tesseract.js / pdfjs-dist / canvas.
  const { extractEntryText } = require('../importers.cjs');
  const extracted = await extractEntryText(filePath, options);

  const lineConfidenceByText = new Map();
  for (const line of extracted.lines ?? []) {
    const text = cleanLine(line?.text ?? '');
    if (!text) continue;
    const confidence = Number(line.confidence);
    if (!Number.isFinite(confidence)) continue;
    // First occurrence wins: the same label twice is already flagged as a
    // duplicate line, and the earlier occurrence is the one that is used.
    if (!lineConfidenceByText.has(text)) lineConfidenceByText.set(text, confidence);
  }

  const parsed = parseLabeledText(extracted.text, { lineConfidenceByText });

  const crossField = crossFieldWarnings(parsed.fields);
  const reasonsByKey = new Map();
  for (const issue of crossField) {
    const list = reasonsByKey.get(issue.key) ?? [];
    list.push(issue.code);
    reasonsByKey.set(issue.key, list);
  }
  for (const [key, entry] of Object.entries(parsed.fields)) {
    const extra = reasonsByKey.get(key);
    if (!extra) continue;
    entry.reviewReasons = [...new Set([...(entry.reviewReasons ?? []), ...extra])];
    entry.needsReview = true;
  }
  const fieldCount = Object.keys(parsed.fields).length;
  const reviewCount = Object.values(parsed.fields).filter((entry) => entry.needsReview).length;

  return {
    ...extracted,
    parsed: {
      ...parsed,
      crossField,
      summary: {
        fieldCount,
        reviewCount,
        // Nothing OCR produces may be auto-accepted: the UI has to show the
        // proposals and let a human confirm them one by one.
        autoAcceptable: false,
        requiresReview: true,
      },
    },
  };
}

module.exports = {
  parseLabeledText,
  splitLabelValue,
  stripUnitSuffix,
  crossFieldWarnings,
  recognizeEntryFile,
  INPUT_FIELD_KEYS: INPUT_FIELDS.map((field) => field.key),
  MAX_LINES,
  MIN_LINE_CONFIDENCE,
  MIN_HEADER_SCORE,
};