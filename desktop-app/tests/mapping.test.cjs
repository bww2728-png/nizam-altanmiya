'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const { readDirectorateWorkbook } = require('../src/main/analysis/template-reader.cjs');
const { matchHeader, mapHeaderRow, normalizeLabel } = require('../src/main/analysis/mapping.cjs');
const { analyze } = require('../src/main/analysis/engine.cjs');

const FIXTURE = path.join(__dirname, 'fixtures', 'template-v3.3.xlsx');

test('normalisation makes Arabic labels comparable without changing meaning', () => {
  assert.equal(normalizeLabel('نسبة المياه %'), 'نسبه المياه');
  assert.equal(normalizeLabel('الطرق المزفلتة %'), 'الطرق المزفلته');
  assert.equal(normalizeLabel('  عدد   السكان '), 'عدد السكان');
  assert.equal(normalizeLabel('إيرادات المديرية'), 'ايرادات المديريه');
  assert.equal(normalizeLabel('الكثافة السكانية (نسمة/كم2)'), 'الكثافه السكانيه نسمه كم2');
});

test('header matching is by meaning, not by position', () => {
  assert.equal(matchHeader('اسم المديرية').key, 'districtName');
  assert.equal(matchHeader('طبيعة المديرية').key, 'districtNature');
  assert.equal(matchHeader('نسبة المياه %').key, 'waterCoverage');
  assert.equal(matchHeader('الطرق المزفلتة %').key, 'pavedRoads');
  assert.equal(matchHeader('تكلفة المشاريع').key, 'projectCost');
  assert.equal(matchHeader('قرب خط النار').key, 'frontLine');
  assert.equal(matchHeader('قرار المراجع').key, 'reviewerDecision');
  // An alias used in field-collected files.
  assert.equal(matchHeader('المسفلتة').key, null);
  assert.equal(matchHeader('نسبة تغطية المياه').key, 'waterCoverage');
  assert.equal(matchHeader('عنوان لا علاقة له').key, null);
});

test('two-row header is detected and every column is mapped by name', () => {
  const cells = [
    'البيانات الأساسية', 'البيانات الأساسية', 'البيانات الأساسية', 'التعليم', 'الصحة', 'البنية التحتية',
    'الطرق المزفلتة %', 'إيرادات المديرية', 'اسم المديرية', 'عدد المدارس', 'منشآت حكومية', 'نسبة المياه %',
  ];
  const { columnMap, matched, unmatched, duplicates } = mapHeaderRow(cells);
  assert.equal(columnMap.districtName, 9);
  assert.equal(columnMap.schools, 10);
  assert.equal(columnMap.govFacilities, 11);
  assert.equal(columnMap.waterCoverage, 12);
  assert.equal(columnMap.pavedRoads, 7);
  assert.equal(columnMap.revenue, 8);
  assert.equal(duplicates.length, 0);
  // `matched` is the report the UI shows; it must list the mapped fields.
  assert.equal(matched.length, Object.keys(columnMap).length);
  assert.ok(matched.every((entry) => columnMap[entry.key] === entry.column));
  // Group headers have no canonical meaning and must be reported, not guessed.
  assert.equal(unmatched.length, 6);
});

test('reading the real template finds the right sheet, header row and 39 input columns', async () => {
  const result = await readDirectorateWorkbook(FIXTURE);

  assert.equal(result.sheetName, 'قاعدة البيانات الشاملة');
  assert.equal(result.headerRow, 2, 'the field-name row is the second row');
  assert.equal(result.firstDataRow, 3);
  assert.equal(result.rows.length, 3, 'the workbook currently holds three directorates');
  assert.equal(result.missingInputs.length, 0, 'all 39 input columns are present');

  const [shaar, azal, faqih] = result.rows;
  assert.equal(shaar.districtName, 'مديرية الشعر');
  assert.equal(shaar.governorate, 'إب');
  assert.equal(shaar.values.population, 43739);
  assert.ok(Math.abs(shaar.values.waterCoverage - 0.197) < 1e-12);
  assert.equal(shaar.values.revenue, 75643312);
  assert.ok(shaar.values.frontLine === null || shaar.values.frontLine === undefined, 'an empty cell must stay missing, never zero');
  assert.equal(shaar.sources.population, 'C3', 'each value keeps its cell address');

  assert.equal(azal.districtName, 'مديرية أزال');
  assert.equal(faqih.districtName, 'مديرية بيت الفقيه');
  const inventoryNoticeCodes = new Set([
    'unimported-data-sheets',
    'hidden-data-sheets',
    'unimported-table-regions',
    'embedded-images-detected',
    'formula-cells-detected',
    'merged-cells-detected',
    'inventory-row-limit',
    'header-scan-limit',
  ]);
  assert.ok(
    result.warnings.every((warning) => inventoryNoticeCodes.has(warning.code)),
    `unexpected row/mapping warning: ${JSON.stringify(result.warnings)}`
  );
});

test('file to engine: the numbers match the workbook end to end', async () => {
  const source = await readDirectorateWorkbook(FIXTURE);
  const result = analyze(source.rows.map((row) => ({
    id: row.id,
    districtName: row.districtName,
    governorate: row.governorate,
    values: row.values,
    rawValues: row.rawValues,
    sources: row.sources,
    warnings: row.warnings,
  })));

  const [shaar, azal, faqih] = result.rows;
  assert.ok(Math.abs(shaar.replica.composite - 0.2) < 1e-12);
  assert.ok(Math.abs(azal.replica.composite - 0.29646838351672766) < 1e-9);
  assert.ok(Math.abs(faqih.replica.composite - 0.19508183587563138) < 1e-9);

  assert.equal(shaar.completeness.ratio, 0.538);
  assert.equal(azal.completeness.ratio, 0.308);
  assert.equal(faqih.completeness.ratio, 0.385);

  assert.equal(shaar.project.label, '🚰 مشروع مياه');
  assert.equal(azal.project.label, '⏳ بيانات ناقصة: المياه');
  assert.equal(shaar.confidence.level, 'preliminary');
  assert.equal(azal.confidence.level, 'blocked');

  // No directorate is complete, so nothing is ranked — the same conclusion the
  // workbook reaches, now produced by the application.
  assert.equal(result.summary.replicaRanked, 0);
  assert.equal(result.summary.waiting, 3);
});

test('reading a workbook without a directorate column fails loudly', async () => {
  const ExcelJS = require('exceljs');
  const os = require('node:os');
  const fs = require('node:fs');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'no-name-'));
  const filePath = path.join(directory, 'bad.xlsx');
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('عشوائي');
  sheet.addRow(['عدد السكان', 'الطرق المزفلتة %']);
  sheet.addRow([1000, 0.5]);
  await workbook.xlsx.writeFile(filePath);

  await assert.rejects(readDirectorateWorkbook(filePath), /اسم المديرية/);
  fs.rmSync(directory, { recursive: true, force: true });
});