'use strict';

const ExcelJS = require('exceljs');

const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF18324B' } };

function styleHeader(row) {
  row.height = 28;
  row.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
  row.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  row.eachCell((cell) => { cell.fill = HEADER_FILL; cell.border = { bottom: { style: 'thin', color: { argb: 'FFD9A441' } } }; });
}

function addSheet(workbook, name, columns, rows) {
  const sheet = workbook.addWorksheet(name, { views: [{ rightToLeft: true, state: 'frozen', ySplit: 1, showGridLines: false }] });
  sheet.columns = columns.map((column) => ({ key: column.key, width: Math.min(36, Math.max(12, column.width ?? 18)) }));
  sheet.addRow(columns.map((column) => column.header));
  styleHeader(sheet.getRow(1));
  for (const row of rows) sheet.addRow(columns.map((column) => row[column.key] ?? null));
  if (columns.length) sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
  return sheet;
}

async function exportFilteredWorkbook(filePath, report) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'نظام التنمية المحلية';
  workbook.created = new Date();
  workbook.views = [{ x: 0, y: 0, width: 18000, height: 12000, firstSheet: 0, activeTab: 0 }];
  const summaryRows = [
    { key: 'التقرير', value: report.title },
    { key: 'تاريخ الاستخراج', value: report.generatedAt },
    { key: 'عدد النتائج المطابقة', value: report.summary?.total ?? report.rows.length },
    { key: 'منطق الشروط', value: report.filters?.logic === 'or' ? 'OR — أي شرط' : 'AND — كل الشروط' },
    { key: 'نمط الترتيب', value: report.filters?.mode === 'replica' ? 'المعادلة المرجعية' : 'المعاير' },
    ...(report.filters?.labels ?? []).map((label, index) => ({ key: `الشرط ${index + 1}`, value: label })),
    ...(report.summary?.items ?? []).map((item) => ({ key: item.label, value: item.value })),
  ];
  addSheet(workbook, 'ملخص التقرير', [
    { key: 'key', header: 'البند', width: 32 },
    { key: 'value', header: 'القيمة', width: 64 },
  ], summaryRows);
  addSheet(workbook, 'النتائج المطابقة', report.columns, report.rows);
  await workbook.xlsx.writeFile(filePath);
  return { filePath };
}

module.exports = { exportFilteredWorkbook };
