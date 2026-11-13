'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3-multiple-ciphers');
const { migrate: migrateStore } = require('../src/main/analysis/store-schema.cjs');
const manualEntryCatalog = require('../src/main/database/manual-entry-catalog.cjs');

const OUTPUT_PATH = path.resolve(__dirname, '../../docs/architecture/central-manual-entry-coverage.csv');
const HEADERS = ['#','domain_code','المجال','group_code','المجموعة','form_code','حالة التغطية','عدد الحقول المنشورة',
  'رموز الحقول المنشورة','عدد الحقول المرشحة','حالة ربط الحقول','رموز الحقول المرشحة','ملاحظة'];

function csvCell(value) {
  return `"${String(value ?? '').replaceAll('"', '""')}"`;
}

function buildCoverageRows(db) {
  const catalog = manualEntryCatalog.listCatalog(db);
  const rows = [];
  let index = 0;
  for (const domain of catalog.domains) {
    for (const group of domain.groups) {
      const forms = [...new Set(group.forms.map(form => form.code))].sort();
      const publishedFields = [...new Set(group.publishedFields.map(field => field.code))].sort();
      const candidateFields = [...new Set(group.fields.map(field => field.code))].sort();
      const coverageStatus = forms.length
        ? 'نموذج منشور جزئي؛ الإدخال متاح للحقول المرتبطة فقط'
        : 'غير منفذ؛ لا يوجد نموذج منشور';
      let mappingState = 'لا يوجد تعريف حقل حالي مرتبط';
      let note = 'يجب استكمال التعريف من المواصفة دون تخمين الدلالة أو الوحدة أو الأبعاد.';
      if (candidateFields.length) {
        mappingState = 'مرشحات موجودة؛ تحتاج مراجعة دلالية';
        note = 'الحقول المرشحة لا تُستخدم للإدخال أو التحليل حتى مراجعتها ونشر نموذج معتمد.';
      } else if (publishedFields.length) {
        mappingState = 'لا توجد مرشحات منفصلة؛ الحقول المنشورة أعلاه';
        note = 'تعرض هذه المجموعة حقول النموذج المنشور الجزئي فقط، ولا يدل ذلك على اكتمال موضوعها.';
      }
      if (group.code === 'crosscutting-documentation-quality.value-states') {
        mappingState = 'لا يلزم تعريف حقل مستقل؛ دعم تخزين/تحقق/عرض مشترك';
        note = 'مدعوم في مخطط القيمة الموحدة والخدمة وواجهة الإدخال؛ تغطيته لا تعني وجود نموذج مستقل للمجموعة.';
      }
      rows.push({
        index: ++index,
        domainCode: domain.code,
        domainName: domain.name,
        groupCode: group.code,
        groupName: group.name,
        formCodes: forms,
        coverageStatus,
        publishedFields,
        candidateFields,
        mappingState,
        note,
      });
    }
  }
  return rows;
}

function renderCoverageCsv(rows) {
  const lines = [HEADERS.map(csvCell).join(',')];
  for (const row of rows) {
    lines.push([
      row.index, row.domainCode, row.domainName, row.groupCode, row.groupName, row.formCodes.join('; '),
      row.coverageStatus, row.publishedFields.length, row.publishedFields.join('; '), row.candidateFields.length,
      row.mappingState, row.candidateFields.join('; '), row.note,
    ].map(csvCell).join(','));
  }
  return `\uFEFF${lines.join('\n')}\n`;
}

function exportCoverage(outputPath = OUTPUT_PATH) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  try {
    migrateStore(db);
    manualEntryCatalog.migrate(db);
    const rows = buildCoverageRows(db);
    fs.writeFileSync(outputPath, renderCoverageCsv(rows), 'utf8');
    return { outputPath, rows };
  } finally {
    db.close();
  }
}

if (require.main === module) {
  const { outputPath, rows } = exportCoverage();
  process.stdout.write(`Generated coverage for ${rows.length} groups from a fresh synthetic schema: ${outputPath}\n`);
}

module.exports = { HEADERS, OUTPUT_PATH, buildCoverageRows, exportCoverage, renderCoverageCsv };
