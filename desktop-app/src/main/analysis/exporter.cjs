'use strict';

/**
 * Excel export.
 *
 * Eight sheets, one methodology:
 *  - «قاعدة البيانات الشاملة» carries the input columns (A..AM) followed by the
 *    computed indicators, the priority index and the weighted composite, so a
 *    reviewer can read a row end to end without opening the application;
 *  - «الترتيب والأولويات», «قيم شاذة», «فجوات البيانات», «استقرار الترتيب» and
 *    «سجل التدقيق» carry the parts a sheet of inputs cannot express;
 *  - «المنهجية والأوزان» records the parameters behind the index;
 *  - «بيانات الإصدار» records when the file was produced and what an access
 *    profile left out, so a filtered export is never mistaken for an empty one.
 */

const ExcelJS = require('exceljs');
const { INPUT_FIELDS, INDICATORS, DECISION_FIELD } = require('./schema.cjs');
const { isRankableCalibrated } = require('./sheets.cjs');

/**
 * Ranking eligibility, matching the interface: complete, free of anomalies, and
 * backed by a finite composite (a blocked row is complete but not computable, so
 * it must not count). Mirrors the ranking sheet's `rankable` predicate.
 */
function isRankableRow(row) {
  // Delegates to the shared predicate so the export, the interface and the PDF
  // can never disagree about who is rankable.
  return isRankableCalibrated(row);
}

const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF18324B' } };
const HEADER_FONT = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };

function num(value, digits = 4) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return value === 0 ? 0 : null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Input columns A..AM, then the computed indicators and the priority index. */
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
    { letter: 'AZ', header: 'مؤشر الأولوية', width: 20, value: (row) => num(row.calibrated?.composite) },
    { letter: 'BA', header: 'نوع المشروع المقترح', width: 26, value: (row) => row.project?.label ?? null },
    { letter: 'BB', header: 'التقييم', width: 46, value: (row) => row.confidence?.text ?? null },
    { letter: 'BC', header: DECISION_FIELD.header, width: 16, value: (row) => row.values?.reviewerDecision ?? null },
    { letter: 'BD', header: 'الاكتمال', width: 12, value: (row) => num(row.completeness?.ratio, 3) },
    { letter: 'BE', header: 'مؤهلة للترتيب', width: 14, value: (row) => (isRankableRow(row) ? 'نعم' : 'لا') },
    { letter: 'BF', header: 'الحقول الناقصة', width: 40, value: (row) => row.completeness?.missingText ?? null },
    { letter: 'BG', header: 'المؤشر المرجّح المباشر', width: 20, value: (row) => num(row.replica?.composite) },
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
  // Lazy require: the anomaly rule lives with the import plan, and export must
  // exclude exactly what the interface excludes.
  const { anomalyKeys } = require('./import-plan.cjs');
  const { compareCalibratedRows } = require('./sheets.cjs');
  // The interface ranks only complete, non-anomalous rows and renumbers them
  // from 1; the report must show the same population with the same numbering, so
  // it applies the same predicate instead of the engine's raw rank (which still
  // numbers rows the interface parks under «بانتظار الاستكمال»).
  const rankable = isRankableCalibrated;
  const rankedRows = (analysis.rows ?? []).filter(rankable);
  const calibratedOrder = [...rankedRows].sort(compareCalibratedRows);
  const calibratedRank = new Map(calibratedOrder.map((row, index) => [row, index + 1]));
  const replicaOrder = rankedRows
    .filter((row) => Number.isFinite(row.replica?.composite))
    .sort((a, b) => ((b.replica?.composite ?? 0) - (a.replica?.composite ?? 0))
      || String(a.districtName ?? '').localeCompare(String(b.districtName ?? ''), 'ar'));
  const replicaRank = new Map(replicaOrder.map((row, index) => [row, index + 1]));
  workbook.creator = 'نظام التنمية المحلية';
  workbook.created = new Date(context.generatedAt ?? analysis.meta?.generatedAt ?? Date.now());

  // 1. Template layout.
  addDataSheet(workbook, 'قاعدة البيانات الشاملة', templateLayout(), analysis.rows ?? []);

  // 2. Ranking: the priority index and the weighted composite side by side, so
  //    the difference between the two paths is visible rather than implied.
  addDataSheet(workbook, 'الترتيب والأولويات', [
    { header: 'الأولوية', key: 'rank', width: 12 },
    { header: 'المديرية', key: 'district', width: 26 },
    { header: 'المحافظة', key: 'governorate', width: 20 },
    { header: 'مؤشر الأولوية', key: 'composite', width: 16 },
    { header: 'المؤشر المرجّح', key: 'replicaComposite', width: 16 },
    { header: 'رتبة المؤشر المرجّح', key: 'replicaRank', width: 16 },
    { header: 'فرق الرتبة', key: 'shift', width: 12 },
    { header: 'أبعاد حرجة', key: 'degraded', width: 14 },
    { header: 'حرمان حاد', key: 'severe', width: 12 },
    { header: 'نوع المشروع المقترح', key: 'project', width: 28 },
    { header: 'التقييم', key: 'confidence', width: 44 },
  ], calibratedOrder.map((row) => {
    const rank = calibratedRank.get(row) ?? null;
    const replica = replicaRank.get(row) ?? null;
    return {
      rank,
      district: row.districtName,
      governorate: row.governorate,
      composite: num(row.calibrated?.composite),
      replicaComposite: num(row.replica?.composite),
      replicaRank: replica,
      shift: rank && replica ? replica - rank : null,
      degraded: row.calibrated?.degradedCount ?? null,
      severe: row.calibrated?.severe ? 'نعم' : 'لا',
      project: row.project?.label ?? '',
      confidence: row.confidence?.text ?? '',
    };
  }));

  // 3. Anomalies: values outside the plausible range are excluded from the
  //    ranking, so the report states them instead of dropping them silently.
  addDataSheet(workbook, 'قيم شاذة', [
    { header: 'المديرية', key: 'district', width: 26 },
    { header: 'المحافظة', key: 'governorate', width: 20 },
    { header: 'الحقل', key: 'field', width: 26 },
    { header: 'القيمة', key: 'value', width: 18 },
  ], (analysis.rows ?? []).flatMap((row) => anomalyKeys(row.values ?? {}).map((key) => ({
    district: row.districtName,
    governorate: row.governorate,
    field: key,
    value: num(row.values?.[key], 4),
  }))));

  // 4. Data gaps.
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

  // 5. Rank stability.
  addDataSheet(workbook, 'استقرار الترتيب', [
    { header: 'المديرية', key: 'district', width: 24 },
    { header: 'أدنى رتبة', key: 'minRank', width: 12 },
    { header: 'أعلى رتبة', key: 'maxRank', width: 12 },
    { header: 'مدى التذبذب', key: 'range', width: 14 },
    { header: 'رتب متميزة', key: 'distinct', width: 14 },
    { header: 'مستقر', key: 'stable', width: 10 },
  ], (analysis.rows ?? []).filter((row) => row.sensitivity).map((row) => ({
    district: row.districtName,
    minRank: row.sensitivity.minRank,
    maxRank: row.sensitivity.maxRank,
    range: row.sensitivity.rankRange,
    distinct: row.sensitivity.distinctRanks,
    stable: row.sensitivity.fragile ? 'لا' : 'نعم',
  })));

  // 6. Methodology and weights: the parameters behind the priority index, so a
  //    reader can re-derive the numbers without the application.
  const weights = analysis.meta?.weights ?? {};
  const methodologyRows = [
    { item: 'عتبة الانحدار (k)', value: String(analysis.meta?.kThreshold ?? 4) },
    { item: 'خط الحرمان', value: String(analysis.meta?.deprivationLine ?? 0.6) },
    { item: 'أدنى تغطية أوزان مسموحة', value: String(analysis.meta?.minWeightCoverage ?? 0.6) },
    { item: 'مفهوم حرمان حاد', value: 'تجاوز عتبة الانحدار: تُصنَّف المديرية حرمانًا حادًا وتتصدّر القائمة مهما كان متوسطها.' },
    { item: 'مفهوم الحجب', value: 'نسبة الأوزان المتاحة أقل من الحد الأدنى، فلا يصح إصدار رقم مركب؛ المطلوب استكمال البيانات لا تعديل المعادلة.' },
    { item: 'المؤشر المرجّح', value: 'جمع خطي للأبعاد الاثني عشر بأوزانها (الفراغ = صفر).' },
    { item: 'مؤشر الاحتياج المعاير', value: 'قياس مطلق بنقاط مرجعية ثابتة، مع تعداد الأبعاد المتدهورة.' },
    { item: 'المستوى الجغرافي', value: 'مديرية فقط.' },
    { item: 'استبعاد الشذوذ', value: 'المديريات ذات القيم غير المنطقية تُستبعد من الترتيب حتى تُصحَّح، وتُدرَج في ورقة «قيم شاذة» لا في الترتيب.' },
    { item: 'المصدر المعتمد', value: 'قاعدة البيانات المحلية المعتمدة، وليس أي ملف مصدَّر.' },
    ...INDICATORS.map((indicator) => ({ item: `وزن: ${indicator.header}`, value: String(weights[indicator.code] ?? '') })),
  ];
  addDataSheet(workbook, 'المنهجية والأوزان', [
    { header: 'البند', key: 'item', width: 40 },
    { header: 'القيمة', key: 'value', width: 72 },
  ], methodologyRows);

  // 7. Issue data: when it was produced and what the access profile left out.
  //    An export must say what it omitted, otherwise a masked report is
  //    indistinguishable from a report where those fields were simply empty.
  const protectedFields = Array.isArray(context.protectedFields) ? context.protectedFields : [];
  const issueRows = [
    { item: 'جهة الإصدار', value: 'نظام التنمية المحلية' },
    { item: 'المستوى الجغرافي', value: 'مديرية' },
    { item: 'عدد المديريات', value: String((analysis.rows ?? []).length) },
    { item: 'زمن التوليد', value: analysis.meta?.generatedAt ?? '' },
  ];
  if (context.accessProfile === 'shared') {
    issueRows.push({ item: 'وضع الوصول', value: 'وضع المشاركة — حقول مقيّدة/حساسة محجوبة' });
    issueRows.push({ item: 'الحقول المحجوبة', value: protectedFields.length ? protectedFields.join('، ') : 'لا شيء' });
  } else {
    issueRows.push({ item: 'وضع الوصول', value: 'مالك الجهاز — كل الحقول ظاهرة' });
  }
  addDataSheet(workbook, 'بيانات الإصدار', [
    { header: 'البند', key: 'item', width: 34 },
    { header: 'القيمة', key: 'value', width: 48 },
  ], issueRows);

  // 8. Audit trail. The source workbook path/name is an input, not a result: the
  //    exported report must not name the file it was built from, so every audit
  //    identity that is a file name or path is blanked whichever event wrote it
  //    (scan, import, export, backup), while numeric entity ids are kept.
  const FILE_IDENTITY = /[\\/]|\.(xlsx|xlsm|xls|csv|pdf|db|sqlite|bak|enc|zip)$/i;
  addDataSheet(workbook, 'سجل التدقيق', [
    { header: '#', key: 'id', width: 8 },
    { header: 'الإجراء', key: 'action', width: 18 },
    { header: 'الكيان', key: 'entity', width: 18 },
    { header: 'المعرّف', key: 'entity_id', width: 12 },
    { header: 'التفاصيل', key: 'detail', width: 60 },
    { header: 'الوقت', key: 'created_at', width: 28 },
  ], (context.audit ?? []).map((row) => ({
    ...row,
    entity_id: typeof row.entity_id === 'string' && FILE_IDENTITY.test(row.entity_id) ? '—' : row.entity_id,
  })));

  return workbook;
}

/** Write the workbook to disk. */
async function exportAnalysisWorkbook(filePath, analysis, context = {}) {
  const workbook = await buildAnalysisWorkbook(analysis, context);
  await workbook.xlsx.writeFile(filePath);
  return { filePath };
}

module.exports = { buildAnalysisWorkbook, exportAnalysisWorkbook, templateLayout, num };
