'use strict';

/**
 * Excel export.
 *
 * Two workbooks in one file:
 *  - «قاعدة البيانات الشاملة» reproduces the template layout (A..BH) so the
 *    result can be diffed against the original workbook cell by cell;
 *  - the analysis sheets (ترتيب، فجوات، حساسية، أوزان، سجل تدقيق) carry the
 *    parts of the answer the template cannot express.
 */

const ExcelJS = require('exceljs');
const { INPUT_FIELDS, INDICATORS, DECISION_FIELD, CALIBRATION } = require('./schema.cjs');

const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF18324B' } };
const HEADER_FONT = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };

function num(value, digits = 4) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return value === 0 ? 0 : null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Ordered A..BH template layout used by the export sheet. */
function templateLayout() {
  const columns = [];
  for (const field of INPUT_FIELDS) {
    columns.push({
      letter: field.column,
      header: field.header,
      width: field.type === 'text' ? 22 : 16,
      value: (row) => {
        const value = row.values?.[field.key];
        if (value === null || value === undefined) return null;
        if (field.type === 'boolean') return value === 1 || value === true ? 'نعم' : 'لا';
        return value;
      },
    });
  }
  for (const indicator of INDICATORS) {
    columns.push({
      letter: indicator.excel,
      header: indicator.header,
      width: 16,
      value: (row) => num(row.indicators?.[indicator.code]),
    });
  }
  columns.push(
    { letter: 'AZ', header: 'المركب (مطابقة القالب)', width: 20, value: (row) => num(row.replica?.composite) },
    { letter: 'BA', header: 'نوع المشروع المقترح', width: 26, value: (row) => row.project?.label ?? null },
    { letter: 'BB', header: 'الثقة والحساسية', width: 46, value: (row) => row.confidence?.text ?? null },
    { letter: 'BC', header: DECISION_FIELD.header, width: 16, value: (row) => row.values?.reviewerDecision ?? null },
    { letter: 'BD', header: 'الاكتمال', width: 12, value: (row) => num(row.completeness?.ratio, 3) },
    { letter: 'BE', header: 'مؤهلة للترتيب', width: 14, value: (row) => (row.completeness?.ratio === 1 ? 'نعم' : 'لا') },
    { letter: 'BF', header: 'الحقول الناقصة', width: 40, value: (row) => row.completeness?.missingText ?? null },
    { letter: 'BG', header: 'نسبة تغطية الأوزان', width: 18, value: (row) => num(row.calibrated?.weightCoverage, 3) },
    { letter: 'BH', header: 'حالة السجل', width: 14, value: (row) => (row.completeness?.waiting ? 'بانتظار' : 'جاهز') },
  );
  return columns;
}

function styleHeader(row) {
  row.height = 30;
  row.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  row.font = HEADER_FONT;
  row.eachCell((cell) => { cell.fill = HEADER_FILL; cell.border = { bottom: { style: 'thin', color: { argb: 'FFD9A441' } } }; });
}

function addDataSheet(workbook, name, definition, records) {
  const sheet = workbook.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1, rightToLeft: true, showGridLines: false }] });
  sheet.columns = definition.map((column, index) => ({
    key: column.key ?? column.letter ?? `col${index}`,
    width: column.width ?? 16,
  }));
  sheet.addRow(definition.map((column) => column.header));
  styleHeader(sheet.getRow(1));
  for (const record of records) {
    sheet.addRow(definition.map((column) => {
      const value = column.value ? column.value(record) : record[column.key];
      return value === undefined ? null : value;
    }));
  }
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: definition.length } };
  return sheet;
}

/**
 * Build the analysis workbook.
 *
 * @param {object} analysis output of engine.analyze (or the hydrated latest run)
 * @param {{audit?:Array, generatedAt?:string, sourceLabels?:object}} context
 * @returns {Promise<ExcelJS.Workbook>}
 */
async function buildAnalysisWorkbook(analysis, context = {}) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'نظام التنمية المحلية';
  workbook.created = new Date(context.generatedAt ?? analysis.meta?.generatedAt ?? Date.now());

  // 1. Template layout.
  addDataSheet(workbook, 'قاعدة البيانات الشاملة', templateLayout(), analysis.rows ?? []);

  // 2. Ranking (both modes side by side).
  addDataSheet(workbook, 'الترتيب والأولويات', [
    { header: 'المديرية', key: 'district', width: 26 },
    { header: 'المحافظة', key: 'governorate', width: 20 },
    { header: 'الأولوية المعايرة', key: 'calibratedRank', width: 16 },
    { header: 'المركب المعاير', key: 'calibratedComposite', width: 16 },
    { header: 'الأبعاد المتدهورة', key: 'degraded', width: 16 },
    { header: 'حرمان حاد', key: 'severe', width: 12 },
    { header: 'تغطية الأوزان', key: 'coverage', width: 14 },
    { header: 'رتبة مطابقة القالب', key: 'replicaRank', width: 18 },
    { header: 'مركب القالب', key: 'replicaComposite', width: 14 },
    { header: 'إزاحة الرتبة', key: 'shift', width: 12 },
    { header: 'نوع المشروع المقترح', key: 'project', width: 28 },
    { header: 'التقييم', key: 'confidence', width: 44 },
  ], (analysis.rows ?? []).map((row) => ({
    district: row.districtName,
    governorate: row.governorate,
    calibratedRank: row.calibrated?.rank ?? (row.calibrated?.blocked ? 'محجوبة' : '—'),
    calibratedComposite: num(row.calibrated?.composite),
    degraded: row.calibrated?.degradedCount ?? null,
    severe: row.calibrated?.severe ? 'نعم' : 'لا',
    coverage: num(row.calibrated?.weightCoverage, 3),
    replicaRank: row.replica?.rank ?? 'غير مؤهلة',
    replicaComposite: num(row.replica?.composite),
    shift: row.replica?.rank && row.calibrated?.rank ? row.replica.rank - row.calibrated.rank : null,
    project: row.project?.label ?? '',
    confidence: row.confidence?.text ?? '',
  })));

  // 3. Data gaps.
  const gapRows = [];
  for (const [record, issues] of analysis.gaps?.recordIssues ?? []) {
    for (const issue of issues) {
      gapRows.push({
        district: record.districtName,
        governorate: record.governorate ?? '',
        severity: issue.severity,
        code: issue.code,
        field: issue.field,
        message: issue.message,
      });
    }
  }
  for (const issue of analysis.gaps?.crossIssues ?? []) {
    gapRows.push({ district: '—', governorate: '—', severity: issue.severity, code: issue.code, field: issue.field, message: issue.message });
  }
  addDataSheet(workbook, 'فجوات البيانات', [
    { header: 'المديرية', key: 'district', width: 24 },
    { header: 'المحافظة', key: 'governorate', width: 18 },
    { header: 'الخطورة', key: 'severity', width: 12 },
    { header: 'الرمز', key: 'code', width: 24 },
    { header: 'الحقل', key: 'field', width: 22 },
    { header: 'الوصف', key: 'message', width: 80 },
  ], gapRows);

  // 4. Sensitivity.
  addDataSheet(workbook, 'الحساسية', [
    { header: 'المديرية', key: 'district', width: 24 },
    { header: 'أدنى رتبة', key: 'minRank', width: 12 },
    { header: 'أعلى رتبة', key: 'maxRank', width: 12 },
    { header: 'مدى التذبذب', key: 'range', width: 14 },
    { header: 'رتب متميزة', key: 'distinct', width: 14 },
    { header: 'هشّة', key: 'fragile', width: 10 },
    { header: 'إزاحة عند حذف مديرية', key: 'sampleShift', width: 22 },
  ], (analysis.rows ?? []).filter((row) => row.sensitivity).map((row) => ({
    district: row.districtName,
    minRank: row.sensitivity.minRank,
    maxRank: row.sensitivity.maxRank,
    range: row.sensitivity.rankRange,
    distinct: row.sensitivity.distinctRanks,
    fragile: row.sensitivity.fragile ? 'نعم' : 'لا',
    sampleShift: row.sensitivity.sampleMaxShift,
  })));

  // 5. Weights & calibration.
  const weights = analysis.meta?.weights ?? {};
  const weightsRows = [
    { item: 'ملف القالب المرجعي', value: analysis.meta?.template?.fileName ?? '' },
    { item: 'إصدار القالب', value: analysis.meta?.template?.version ?? '' },
    { item: 'عتبة الانحدار (k)', value: analysis.meta?.kThreshold ?? CALIBRATION.kThreshold },
    { item: 'خط الحرمان', value: analysis.meta?.deprivationLine ?? CALIBRATION.deprivationLine },
    { item: 'أدنى تغطية أوزان مسموحة', value: analysis.meta?.minWeightCoverage ?? CALIBRATION.minWeightCoverage },
    { item: 'زمن التوليد', value: analysis.meta?.generatedAt ?? '' },
    ...INDICATORS.map((indicator) => ({ item: `وزن: ${indicator.header}`, value: weights[indicator.code] ?? '' })),
  ];
  // An export must say what it left out, otherwise a masked report is
  // indistinguishable from a report where those fields were simply empty.
  const protectedFields = Array.isArray(context.protectedFields) ? context.protectedFields : [];
  if (context.accessProfile === 'shared') {
    weightsRows.push({ item: 'وضع الوصول', value: 'وضع المشاركة — حقول مقيّدة/حساسة محجوبة' });
    weightsRows.push({ item: 'الحقول المحجوبة', value: protectedFields.length ? protectedFields.join('، ') : 'لا شيء' });
  } else {
    weightsRows.push({ item: 'وضع الوصول', value: 'مالك الجهاز — كل الحقول ظاهرة' });
  }
  addDataSheet(workbook, 'الأوزان والمعايرة', [
    { header: 'البند', key: 'item', width: 40 },
    { header: 'القيمة', key: 'value', width: 30 },
  ], weightsRows);

  // 6. Audit trail.
  addDataSheet(workbook, 'سجل التدقيق', [
    { header: '#', key: 'id', width: 8 },
    { header: 'الإجراء', key: 'action', width: 18 },
    { header: 'الكيان', key: 'entity', width: 18 },
    { header: 'المعرّف', key: 'entity_id', width: 12 },
    { header: 'التفاصيل', key: 'detail', width: 60 },
    { header: 'الوقت', key: 'created_at', width: 28 },
  ], context.audit ?? []);

  return workbook;
}

/** Write the workbook to disk. */
async function exportAnalysisWorkbook(filePath, analysis, context = {}) {
  const workbook = await buildAnalysisWorkbook(analysis, context);
  await workbook.xlsx.writeFile(filePath);
  return { filePath };
}

module.exports = { buildAnalysisWorkbook, exportAnalysisWorkbook, templateLayout, num };
