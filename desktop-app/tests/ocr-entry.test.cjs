'use strict';

/**
 * OCR text parsing for manual entry. These are pure-function tests: no
 * tesseract worker and no image are needed, which keeps `npm test` fast while
 * still proving the label/value/type contract the UI depends on.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { parseLabeledText, splitLabelValue, stripUnitSuffix } = require('../src/main/analysis/ocr-entry.cjs');

test('parses labelled OCR lines into typed field proposals', () => {
  const text = [
    'اسم المديرية: مديرية الشعر',
    'المحافظة: إب',
    'عدد السكان: 43,739 نسمة',
    'نسبة المياه %: 19.7%',
    'قرب خط النار: نعم',
    'نسبة البطالة: 12.5',
  ].join('\n');

  const parsed = parseLabeledText(text);

  assert.equal(parsed.fields.districtName.value, 'مديرية الشعر');
  assert.equal(parsed.fields.governorate.value, 'إب');
  assert.equal(parsed.fields.population.value, 43739);
  assert.ok(Math.abs(parsed.fields.waterCoverage.value - 0.197) < 1e-12);
  assert.equal(parsed.fields.frontLine.value, 1);
  assert.ok(Math.abs(parsed.fields.unemployment.value - 0.125) < 1e-12);
  assert.equal(parsed.unmatched.length, 0);
});

test('splitLabelValue understands separators, wide gaps and bare prefixes', () => {
  assert.deepEqual(
    { label: splitLabelValue('عدد السكان: 43739').label, value: splitLabelValue('عدد السكان: 43739').value },
    { label: 'عدد السكان', value: '43739' },
  );

  const wide = splitLabelValue('عدد السكان    43739');
  assert.equal(wide.label, 'عدد السكان');
  assert.equal(wide.value, '43739');

  const bare = splitLabelValue('عدد السكان 43739');
  assert.equal(bare.label, 'عدد السكان');
  assert.equal(bare.value, '43739');

  const unknown = splitLabelValue('كلام عشوائي بلا معنى');
  assert.equal(unknown.value, '');
  assert.equal(unknown.method, 'none');
});

test('stripUnitSuffix removes glued units only for numeric fields', () => {
  assert.equal(stripUnitSuffix({ type: 'number' }, '1,200 نسمة'), '1,200');
  assert.equal(stripUnitSuffix({ type: 'ratio' }, '19.7%'), '19.7%');
  assert.equal(stripUnitSuffix({ type: 'text' }, 'ريفية نسمة'), 'ريفية نسمة');
});

test('unknown and valueless lines are reported, never guessed', () => {
  const parsed = parseLabeledText(['سطر غير معروف: 123', 'سطر بلا قيمة'].join('\n'));
  assert.equal(Object.keys(parsed.fields).length, 0);
  assert.ok(parsed.unmatched.some((item) => item.reason === 'unknown-label'));
  assert.ok(parsed.unmatched.some((item) => item.reason === 'no-value'));
});

test('invalid values and duplicate lines produce warnings instead of overwriting', () => {
  const parsed = parseLabeledText([
    'نسبة المياه %: 150',
    'عدد السكان: 100',
    'عدد السكان: 200',
  ].join('\n'));

  assert.equal(parsed.fields.waterCoverage, undefined);
  assert.ok(parsed.warnings.some((item) => item.key === 'waterCoverage' && item.code === 'invalid-ratio'));
  assert.ok(parsed.warnings.some((item) => item.key === 'population' && item.code === 'duplicate-line'));
  assert.equal(parsed.fields.population.value, 100, 'the first accepted value wins');
});

test('empty OCR text yields an empty proposal', () => {
  const parsed = parseLabeledText('   \n  ');
  assert.deepEqual(parsed.fields, {});
  assert.deepEqual(parsed.unmatched, []);
  assert.deepEqual(parsed.warnings, []);
});

test('Arabic decimal separator and Arabic-Indic digits parse as a ratio', () => {
  const parsed = parseLabeledText('نسبة المياه %: ١٩٫٧');
  assert.ok(Math.abs(parsed.fields.waterCoverage.value - 0.197) < 1e-12);
});

test('lines that contain two fields are reported instead of becoming text values', () => {
  const headerRow = parseLabeledText('المحافظة   المديرية   السكان');
  assert.equal(headerRow.fields.governorate, undefined, 'a header row must not become a governorate value');
  assert.ok(headerRow.unmatched.some((item) => item.reason === 'multi-field-line'));

  const tabbed = parseLabeledText('المحافظة: إب\tالمديرية: الشعر');
  assert.equal(tabbed.fields.governorate, undefined);
  assert.ok(tabbed.unmatched.some((item) => item.reason === 'multi-field-line'));
});