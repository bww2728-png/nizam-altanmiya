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
 * `fields[key] = { raw, value, score, method, header }` where `value` is already
 * typed (number / 0..1 ratio / 0|1 boolean / text). Invalid or unknown lines are
 * reported instead of guessed.
 *
 * @param {string} text
 * @returns {{lines:string[], fields:object, unmatched:Array, warnings:Array}}
 */
function parseLabeledText(text) {
  const original = String(text ?? '');
  const source = original.slice(0, MAX_TEXT);
  if (!source.trim()) return emptyProposal();

  const allLines = source
    .split(/\r?\n/)
    .map(cleanLine)
    .filter(Boolean);
  const lines = allLines.slice(0, MAX_LINES);
  const truncated = original.length > MAX_TEXT || allLines.length > MAX_LINES;

  const fields = {};
  const unmatched = [];
  const warnings = [];
  const claimed = new Map();

  for (const line of lines) {
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
      warnings.push({ key: match.key, header: field.header, raw: split.value, code: `invalid-${field.type}` });
      continue;
    }
    if (parsed.state === 'empty') continue;

    fields[match.key] = {
      raw: split.value,
      value: parsed.value,
      score: match.score,
      method: split.method,
      header: field.header,
    };
    claimed.set(match.key, true);
    for (const warning of parsed.warnings) {
      warnings.push({ key: match.key, header: field.header, raw: split.value, code: warning.code });
    }
  }

  return { lines, fields, unmatched: unmatched.slice(0, 200), warnings: warnings.slice(0, 200), truncated };
}

/**
 * Reads an image or PDF locally and returns both the raw text and the parsed,
 * reviewable proposal. Recognition never writes to the database.
 */
async function recognizeEntryFile(filePath) {
  // Required lazily so unit tests can exercise parseLabeledText without loading
  // tesseract.js / pdfjs-dist / canvas.
  const { extractEntryText } = require('../importers.cjs');
  const extracted = await extractEntryText(filePath);
  return { ...extracted, parsed: parseLabeledText(extracted.text) };
}

module.exports = {
  parseLabeledText,
  splitLabelValue,
  stripUnitSuffix,
  recognizeEntryFile,
  INPUT_FIELD_KEYS: INPUT_FIELDS.map((field) => field.key),
  MAX_LINES,
};