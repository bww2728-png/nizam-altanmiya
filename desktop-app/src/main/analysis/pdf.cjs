'use strict';

/**
 * PDF report.
 *
 * Rendering happens in a hidden BrowserWindow (Chromium print engine), which is
 * the only way to get correct Arabic shaping and RTL layout on Windows without
 * shipping a second font stack. `renderReportHtml` is pure so it can be tested
 * and previewed without Electron.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function reportValue(value, type = 'text') {
  if (value === null || value === undefined || value === '') return '—';
  if (type === 'boolean') return Number(value) === 1 || value === true ? 'نعم' : 'لا';
  if (type === 'ratio') {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return '—';
    const ratio = Math.abs(numeric) > 1.5 ? numeric : numeric * 100;
    return `${new Intl.NumberFormat('ar-YE-u-nu-latn', { maximumFractionDigits: 1 }).format(ratio)}%`;
  }
  if (type === 'number') {
    const numeric = Number(value);
    return Number.isFinite(numeric)
      ? new Intl.NumberFormat('ar-YE-u-nu-latn', { maximumFractionDigits: 2 }).format(numeric)
      : '—';
  }
  return String(value);
}

function filterSummary(filters, labels = {}) {
  const items = Object.entries(filters ?? {}).filter(([key, value]) => key !== 'labels'
    && value !== null && value !== undefined && value !== ''
    && (!Array.isArray(value) || value.length > 0));
  if (!items.length) return 'من دون تصفية إضافية';
  return items.map(([key, value]) => `<span><strong>${escapeHtml(labels[key] ?? key)}:</strong> ${escapeHtml(Array.isArray(value) ? value.join('، ') : value)}</span>`).join(' — ');
}

const FILTERED_REPORT_STYLE = `
  @page { size: A3 landscape; margin: 10mm; }
  * { box-sizing: border-box; }
  body { font-family: "Segoe UI", "Traditional Arabic", "Arial", sans-serif; direction: rtl; color: #17324d; margin: 0; font-size: 10pt; line-height: 1.55; }
  h1 { font-size: 22pt; margin: 0 0 5px; color: #0f2740; }
  h2 { font-size: 13pt; margin: 14px 0 6px; color: #0f2740; border-bottom: 2px solid #d9a441; padding-bottom: 4px; page-break-after: avoid; }
  .cover { text-align: center; border-bottom: 3px double #d9a441; padding: 12px 0; margin-bottom: 12px; }
  .muted { color: #64798c; font-size: 9pt; }
  .summary { background: #f7fafc; border: 1px solid #d7e0e8; border-radius: 6px; padding: 8px 12px; margin: 10px 0; }
  table { width: 100%; border-collapse: collapse; table-layout: fixed; margin: 6px 0 14px; font-size: 8pt; page-break-inside: auto; }
  thead { display: table-header-group; }
  th { background: #18324b; color: white; padding: 5px 4px; text-align: right; font-weight: 600; overflow-wrap: anywhere; }
  td { padding: 4px; border-bottom: 1px solid #e2e9ef; vertical-align: top; overflow-wrap: anywhere; }
  tbody tr:nth-child(even) { background: #f6f9fb; }
  tr { page-break-inside: avoid; }
  .ltr { direction: ltr; unicode-bidi: embed; text-align: left; }
  footer { position: fixed; bottom: 0; left: 0; right: 0; text-align: center; font-size: 8pt; color: #7b8fa1; }
`;

function renderDatabaseReportHtml({ rows = [], columns = [], filters = {}, summary = {}, total = rows.length, generatedAt = new Date().toISOString() } = {}) {
  const identity = columns.filter((column) => ['districtName', 'governorate'].includes(column.key));
  const measures = columns.filter((column) => !['districtName', 'governorate'].includes(column.key));
  const groups = [];
  for (let index = 0; index < measures.length; index += 6) groups.push(measures.slice(index, index + 6));
  if (!groups.length) groups.push([]);
  const sections = groups.map((group) => {
    const heading = group.length ? group.map((column) => column.header).join('، ') : identity.map((column) => column.header).join('، ');
    const fields = [...identity, ...group];
    return `<h2>${escapeHtml(heading || 'السجلات المطابقة')}</h2>
      <table><thead><tr><th style="width:4%">#</th>${fields.map((column) => `<th>${escapeHtml(column.header)}</th>`).join('')}</tr></thead>
      <tbody>${rows.length ? rows.map((row, rowIndex) => `<tr><td>${rowIndex + 1}</td>${fields.map((column) => `<td>${escapeHtml(reportValue(row[column.dbColumn], column.type))}</td>`).join('')}</tr>`).join('') : `<tr><td colspan="${fields.length + 1}">لا توجد سجلات مطابقة للفلاتر الحالية.</td></tr>`}</tbody></table>`;
  }).join('');
  const labels = { search: 'البحث', governorates: 'المحافظات', logic: 'منطق الشروط', criteria: 'الشروط الإضافية', allColumns: 'الأعمدة المعروضة' };
  const filterValues = { ...filters, allColumns: filters.allColumns ? 'كل الحقول' : 'الأعمدة المختارة' };
  const governorateBars = (summary.governorates ?? []).map((item) => {
    const width = summary.governorates?.[0]?.count ? Math.max(3, Math.round(item.count / summary.governorates[0].count * 100)) : 0;
    return `<div class="bar-row"><span>${escapeHtml(item.name)}</span><div class="bar-track"><i style="width:${width}%"></i></div><strong>${item.count}</strong></div>`;
  }).join('');
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>تقرير قاعدة البيانات الشاملة</title><style>${FILTERED_REPORT_STYLE}.bar-row{display:grid;grid-template-columns:140px 1fr 36px;gap:8px;align-items:center;margin:4px 0}.bar-track{height:8px;background:#e7edf2;border-radius:8px;overflow:hidden}.bar-track i{display:block;height:100%;background:#d9a441}</style></head><body>
    <div class="cover"><div>الجمهورية اليمنية — نظام التنمية المحلية</div><h1>تقرير قاعدة البيانات الشاملة</h1><div class="muted">تاريخ الإنشاء: ${escapeHtml(arabicDate(generatedAt))}</div></div>
    <div class="summary"><strong>الفلاتر:</strong> ${filterSummary(filterValues, labels)}<br><strong>عدد المديريات المطابقة:</strong> ${total} — <strong>المصدّرة:</strong> ${rows.length}${summary.population !== null && summary.population !== undefined ? ` — <strong>مجموع السكان:</strong> ${escapeHtml(reportValue(summary.population, 'number'))}` : ''}</div>
    ${governorateBars ? `<h2>التوزيع الجغرافي للنتائج</h2>${governorateBars}` : ''}
    ${sections}<footer>نظام التنمية المحلية — تقرير آلي من البيانات المحلية المعتمدة.</footer></body></html>`;
}

function indicatorValue(row, code, view) {
  if (view === 'scores') return row.scores?.[code];
  if (view === 'contributions') {
    const contribution = row.contributions?.[code];
    return contribution && typeof contribution === 'object' ? contribution.contribution : contribution;
  }
  return row.values?.[code];
}

function indicatorReportStat(rows, indicator, view) {
  const values = rows.map((row) => indicatorValue(row, indicator.code, view))
    .filter((value) => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)))
    .map(Number);
  return {
    count: values.length,
    missing: rows.length - values.length,
    min: values.length ? Math.min(...values) : null,
    max: values.length ? Math.max(...values) : null,
    average: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null,
  };
}

function renderIndicatorsReportHtml({ rows = [], registry = [], filters = {}, view = 'values', mode = 'calibrated', total = rows.length, summary = {}, generatedAt = new Date().toISOString() } = {}) {
  const viewLabels = { values: 'القيم الأصلية', scores: 'الدرجات 0–100', contributions: 'المساهمة في المؤشر المركّب' };
  const summaries = registry.map((indicator) => {
    const stat = indicatorReportStat(rows, indicator, view);
    return `<tr><td>${escapeHtml(indicator.header)}</td><td>${stat.count}</td><td>${stat.missing}</td><td class="ltr">${escapeHtml(reportValue(stat.min, 'number'))}</td><td class="ltr">${escapeHtml(reportValue(stat.max, 'number'))}</td><td class="ltr">${escapeHtml(reportValue(stat.average, 'number'))}</td></tr>`;
  }).join('');
  const rankKey = mode === 'replica' ? 'replicaRank' : 'calibratedRank';
  const body = rows.length ? rows.map((row, index) => `<tr><td>${index + 1}</td><td class="ltr">${row[rankKey] ?? '—'}</td><td>${escapeHtml(row.districtName)}</td><td>${escapeHtml(row.governorate)}</td>${registry.map((indicator) => `<td class="ltr">${escapeHtml(reportValue(indicatorValue(row, indicator.code, view), 'number'))}</td>`).join('')}</tr>`).join('') : `<tr><td colspan="${registry.length + 4}">لا توجد مديريات مطابقة للفلاتر الحالية.</td></tr>`;
  const labels = { criteria: 'الشروط', logic: 'منطق الشروط', mode: 'مسار الأولوية', sort: 'الترتيب', view: 'طريقة العرض' };
  const filterValues = { ...filters, mode: mode === 'replica' ? 'المعادلة المرجعية' : 'المعاير', view: viewLabels[view] ?? viewLabels.values };
  const summaryCards = [
    ['النتائج المطابقة', total],
    ...(summary.rankable === null || summary.rankable === undefined ? [] : [['قابلة للترتيب', summary.rankable]]),
    ...(summary.complete === null || summary.complete === undefined ? [] : [['مكتملة البيانات', summary.complete]]),
    ...(summary.averageComposite === null || summary.averageComposite === undefined ? [] : [['متوسط الأولوية', Number(summary.averageComposite).toFixed(3)]]),
  ].map(([label, value]) => `<span><strong>${escapeHtml(label)}:</strong> ${escapeHtml(value)}</span>`).join(' — ');
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>تقرير مؤشرات التنمية</title><style>${FILTERED_REPORT_STYLE}</style></head><body>
    <div class="cover"><div>الجمهورية اليمنية — نظام التنمية المحلية</div><h1>تقرير مؤشرات التنمية</h1><div class="muted">تاريخ الإنشاء: ${escapeHtml(arabicDate(generatedAt))}</div></div>
    <div class="summary"><strong>الفلاتر:</strong> ${filterSummary(filterValues, labels)}<br>${summaryCards}</div>
    <h2>ملخص المؤشرات ضمن النتائج المطابقة</h2><table><thead><tr><th>المؤشر</th><th>محسوب</th><th>ناقص</th><th>الأدنى</th><th>الأعلى</th><th>المتوسط</th></tr></thead><tbody>${summaries}</tbody></table>
    <h2>تفاصيل النتائج — ${escapeHtml(viewLabels[view] ?? viewLabels.values)}</h2><table><thead><tr><th style="width:3%">#</th><th style="width:5%">الرتبة</th><th style="width:12%">المديرية</th><th style="width:9%">المحافظة</th>${registry.map((indicator) => `<th>${escapeHtml(indicator.header)}${indicator.unit ? `<div class="muted">${escapeHtml(indicator.unit)}</div>` : ''}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table>
    <footer>نظام التنمية المحلية — تقرير آلي من المؤشرات المحسوبة على البيانات المحلية.</footer></body></html>`;
}

function fixed(value, digits = 3) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return value.toFixed(digits);
}

function percent(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return `${Math.round(value * 100)}%`;
}

function arabicDate(iso) {
  const date = iso ? new Date(iso) : new Date();
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('ar-YE', { dateStyle: 'long', timeStyle: 'short' }).format(date);
}

const STYLE = `
  @page { size: A4; margin: 14mm 12mm 16mm; }
  * { box-sizing: border-box; }
  body {
    font-family: "Segoe UI", "Traditional Arabic", "Arial", sans-serif;
    direction: rtl; color: #17324d; margin: 0; font-size: 11pt; line-height: 1.7;
  }
  h1 { font-size: 24pt; margin: 0 0 4px; color: #0f2740; }
  h2 { font-size: 15pt; margin: 22px 0 10px; padding-bottom: 6px; border-bottom: 2px solid #d9a441; color: #0f2740; page-break-after: avoid; }
  h3 { font-size: 12pt; margin: 14px 0 6px; color: #1d3f60; page-break-after: avoid; }
  .cover { text-align: center; padding: 40px 0 26px; border-bottom: 3px double #d9a441; margin-bottom: 18px; }
  .cover .kicker { letter-spacing: 2px; font-size: 10pt; color: #8a6d2f; }
  .cover .sub { font-size: 13pt; color: #3b5a78; margin-top: 6px; }
  .grid { display: flex; flex-wrap: wrap; gap: 10px; margin: 10px 0; }
  .card { flex: 1 1 21%; min-width: 150px; border: 1px solid #d7e0e8; border-radius: 8px; padding: 10px 12px; background: #f7fafc; }
  .card .label { font-size: 9pt; color: #5b7891; }
  .card .value { font-size: 18pt; font-weight: 700; color: #0f2740; }
  table { width: 100%; border-collapse: collapse; margin: 8px 0 16px; font-size: 9.5pt; }
  th { background: #18324b; color: #fff; padding: 7px 6px; text-align: right; font-weight: 600; }
  td { padding: 6px; border-bottom: 1px solid #e2e9ef; vertical-align: top; }
  tbody tr:nth-child(even) { background: #f6f9fb; }
  .muted { color: #64798c; }
  .badge { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 8.5pt; }
  .badge.severe { background: #fde2e1; color: #a4201a; }
  .badge.blocked { background: #eef1f4; color: #55636f; }
  .badge.ok { background: #e3f3e6; color: #1f6b33; }
  .note { border-right: 4px solid #d9a441; background: #fbf6e7; padding: 8px 12px; border-radius: 4px; margin: 12px 0; font-size: 9.5pt; }
  .page-break { page-break-before: always; }
  footer { position: fixed; bottom: 0; left: 0; right: 0; font-size: 8pt; color: #7b8fa1; text-align: center; }
  .ltr { direction: ltr; unicode-bidi: embed; }
`;

function cards(summary) {
  const items = [
    { label: 'المديريات المحلّلة', value: summary.rows ?? 0 },
    { label: 'سجلات مكتملة', value: summary.complete ?? 0 },
    { label: 'بانتظار استكمال البيانات', value: summary.waiting ?? 0 },
    { label: 'قابلة للترتيب', value: summary.calibratedRanked ?? 0 },
    { label: 'حرمان حاد', value: summary.severeCount ?? 0 },
    { label: 'ترتيب غير مستقر', value: summary.fragileCount ?? 0 },
    { label: 'متوسط الاكتمال', value: percent(summary.averageCompleteness) },
    { label: 'المحافظات الممثّلة', value: summary.governorates ?? '—' },
  ];
  return `<div class="grid">${items.map((item) => `
    <div class="card"><div class="label">${escapeHtml(item.label)}</div><div class="value">${escapeHtml(item.value)}</div></div>`).join('')}</div>`;
}

function priorityTable(rows) {
  // `rows` is the rankable set already ordered by the canonical rule
  // (severe deprivation first, then the composite); number by position so the
  // report matches the interface, which renumbers the same population from 1.
  if (!rows.length) return '<p class="muted">لا توجد مديريات مؤهلة للترتيب في هذه الدفعة.</p>';
  return `<table>
    <thead><tr>
      <th style="width:6%">#</th><th style="width:26%">المديرية</th><th style="width:14%">المحافظة</th>
      <th style="width:12%">مؤشر الأولوية</th><th style="width:24%">نوع المشروع المقترح</th><th style="width:18%">الحالة</th>
    </tr></thead>
    <tbody>${rows.map((row, index) => `<tr>
      <td>${index + 1}</td>
      <td>${escapeHtml(row.districtName)}${row.calibrated?.severe ? ' <span class="badge severe">حرمان حاد</span>' : ''}</td>
      <td>${escapeHtml(row.governorate)}</td>
      <td class="ltr">${fixed(row.calibrated?.composite)}</td>
      <td>${escapeHtml(row.project?.label ?? '—')}</td>
      <td>${escapeHtml((row.confidence?.text ?? '').split('|')[0].trim() || '—')}</td>
    </tr>`).join('')}</tbody></table>`;
}

function blockedTable(rows) {
  const blocked = rows.filter((row) => row.calibrated?.blocked);
  if (!blocked.length) return '<p class="muted">لا توجد مديريات محجوبة في هذه الدفعة.</p>';
  return `<table>
    <thead><tr><th style="width:34%">المديرية</th><th style="width:18%">المحافظة</th><th style="width:22%">تغطية الأوزان المتاحة</th><th style="width:26%">حالة الحكم</th></tr></thead>
    <tbody>${blocked.map((row) => `<tr>
      <td>${escapeHtml(row.districtName)}</td><td>${escapeHtml(row.governorate)}</td>
      <td class="ltr">${percent(row.calibrated.weightCoverage)}</td>
      <td>${row.calibrated.blockReason === 'insufficient-weight-coverage'
        ? 'محجوب: الأدلة أقل من الحد الأدنى'
        : escapeHtml(row.calibrated.blockReason ?? '—')}</td>
    </tr>`).join('')}</tbody></table>`;
}

function comparisonTable(rows) {
  if (!rows.length) return '<p class="muted">لا توجد نتائج كافية لمقارنة المسارين.</p>';
  // Both ranks are recomputed over the same ranked set (the priority table), so a
  // row shows one consistent pair of numbers across the report.
  const replicaOrder = rows
    .filter((row) => Number.isFinite(row.replica?.composite))
    .sort((a, b) => ((b.replica?.composite ?? 0) - (a.replica?.composite ?? 0))
      || String(a.districtName ?? '').localeCompare(String(b.districtName ?? ''), 'ar'));
  const replicaRank = new Map(replicaOrder.map((row, index) => [row, index + 1]));
  return `<table>
    <thead><tr>
      <th style="width:26%">المديرية</th><th style="width:12%">المؤشر المرجّح</th><th style="width:10%">رتبته</th>
      <th style="width:12%">مؤشر الاحتياج</th><th style="width:10%">رتبته</th><th style="width:10%">فرق الرتبة</th>
      <th style="width:20%">حالة المسار المعاير</th>
    </tr></thead>
    <tbody>${rows.map((row, index) => {
      const calibratedRank = index + 1;
      const rankedReplica = replicaRank.get(row) ?? null;
      const shift = rankedReplica && calibratedRank ? rankedReplica - calibratedRank : null;
      const status = row.calibrated?.severe ? 'حرمان حاد' : 'مرتّب';
      return `<tr>
        <td>${escapeHtml(row.districtName)}</td>
        <td class="ltr">${fixed(row.replica?.composite)}</td>
        <td class="ltr">${rankedReplica ?? '—'}</td>
        <td class="ltr">${fixed(row.calibrated?.composite)}</td>
        <td class="ltr">${calibratedRank}</td>
        <td class="ltr">${shift === null ? '—' : (shift > 0 ? `+${shift}` : String(shift))}</td>
        <td>${status}</td>
      </tr>`;
    }).join('')}</tbody></table>`;
}

function anomaliesTable(rows) {
  const { anomalyKeys } = require('./import-plan.cjs');
  const entries = [];
  for (const row of rows) {
    const keys = anomalyKeys(row.values ?? {});
    for (const key of keys) entries.push({ district: row.districtName, governorate: row.governorate, key, value: row.values?.[key] });
  }
  if (!entries.length) return '<p class="muted">لا توجد قيم شاذة في هذه الدفعة.</p>';
  return `<table>
    <thead><tr><th style="width:34%">المديرية</th><th style="width:20%">المحافظة</th><th style="width:26%">الحقل</th><th style="width:20%">القيمة</th></tr></thead>
    <tbody>${entries.map((entry) => `<tr>
      <td>${escapeHtml(entry.district)}</td><td>${escapeHtml(entry.governorate)}</td>
      <td>${escapeHtml(entry.key)}</td><td class="ltr">${fixed(entry.value)}</td>
    </tr>`).join('')}</tbody></table>`;
}

function gapsTable(analysis) {
  const summary = analysis.gaps?.summary ?? {};
  const rows = [];
  for (const [record, issues] of analysis.gaps?.recordIssues ?? []) {
    for (const issue of issues) {
      if (issue.severity === 'info') continue;
      rows.push({ district: record.districtName, severity: issue.severity, message: issue.message });
    }
  }
  const top = rows.slice(0, 120);
  return `<div class="grid">
      <div class="card"><div class="label">موانع</div><div class="value">${summary.blocker ?? 0}</div></div>
      <div class="card"><div class="label">تحذيرات</div><div class="value">${summary.warning ?? 0}</div></div>
      <div class="card"><div class="label">مديريات فيها موانع</div><div class="value">${summary.recordsWithBlockers ?? 0}</div></div>
    </div>
    ${top.length ? `<table><thead><tr><th style="width:22%">المديرية</th><th style="width:12%">الخطورة</th><th>الوصف</th></tr></thead>
      <tbody>${top.map((row) => `<tr><td>${escapeHtml(row.district)}</td><td>${row.severity === 'blocker' ? 'مانع' : 'تحذير'}</td><td>${escapeHtml(row.message)}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">لا توجد فجوات مسجّلة.</p>'}`;
}

function sensitivityTable(rows) {
  const list = rows.filter((row) => row.sensitivity);
  if (!list.length) return '<p class="muted">لم تُحسب الحساسية.</p>';
  return `<table>
    <thead><tr><th>المديرية</th><th>أدنى رتبة</th><th>أعلى رتبة</th><th>مدى التذبذب</th><th>هشّة</th><th>إزاحة عند حذف مديرية</th></tr></thead>
    <tbody>${list.map((row) => `<tr>
      <td>${escapeHtml(row.districtName)}</td>
      <td>${row.sensitivity.minRank ?? '—'}</td>
      <td>${row.sensitivity.maxRank ?? '—'}</td>
      <td>${row.sensitivity.rankRange ?? '—'}</td>
      <td>${row.sensitivity.fragile ? '<span class="badge severe">نعم</span>' : '<span class="badge ok">لا</span>'}</td>
      <td>${row.sensitivity.sampleMaxShift ?? 0}</td>
    </tr>`).join('')}</tbody></table>`;
}

function weightsTable(analysis) {
  const weights = analysis.meta?.weights ?? {};
  const { INDICATORS } = require('./schema.cjs');
  return `<table>
    <thead><tr><th style="width:60%">البُعد</th><th style="width:20%">الوزن</th><th style="width:20%">الاتجاه</th></tr></thead>
    <tbody>${INDICATORS.map((indicator) => `<tr>
      <td>${escapeHtml(indicator.header)}</td>
      <td class="ltr">${weights[indicator.code] ?? '—'}</td>
      <td>${indicator.direction === 'needUp' ? 'يزداد الاحتياج بارتفاعه' : 'يزداد الاحتياج بانخفاضه'}</td>
    </tr>`).join('')}</tbody></table>`;
}

/**
 * Pure HTML builder for the report.
 *
 * @param {object} analysis engine.analyze output
 * @param {{audit?:Array}} [context]
 */
function renderReportHtml(analysis, context = {}) {
  const meta = analysis.meta ?? {};
  const summary = analysis.summary ?? {};
  const rows = analysis.rows ?? [];
  // The ranking mirrors the interface: only complete, non-anomalous rows are
  // ordered (severe deprivation first, matching the engine), and the anomalies and
  // incomplete rows get their own sections so nothing is dropped silently.
  const { isRankableCalibrated, compareCalibratedRows } = require('./sheets.cjs');
  const rankable = rows.filter(isRankableCalibrated);
  const ordered = [...rankable].sort(compareCalibratedRows);
  const top = ordered.slice(0, 15);

  return `<!doctype html>
<html lang="ar" dir="rtl"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:">
<title>تقرير تحليل التنمية المحلية</title>
<style>${STYLE}</style></head>
<body>
  <div class="cover">
    <div class="kicker">الجمهورية اليمنية — نظام التنمية المحلية</div>
    <h1>تقرير تحليل وترتيب أولويات التنمية</h1>
    <div class="sub">مستوى المديرية — تقرير تحليلي رسمي</div>
    <div class="sub muted">تاريخ التوليد: ${escapeHtml(arabicDate(meta.generatedAt))}</div>
  </div>

  <h2>الملخص التنفيذي</h2>
  ${cards({
    ...summary,
    calibratedRanked: rankable.length,
    // Match the interface badge: count severe rows within the ranked set only
    // (same predicate as sheets.cjs buildRanking), so the executive-summary card
    // and the on-screen «حرمان حاد» cannot diverge for the same dataset.
    severeCount: rankable.filter((row) => row.calibrated?.severe === true).length,
  })}
  <div class="note">
    يعرض التقرير مسارين تحليليين متوازيين على البيانات نفسها: <strong>المؤشر المرجّح</strong> الذي يجمع الأبعاد الاثني عشر
    بأوزانها جمعًا خطيًا، و<strong>مؤشر الاحتياج المعاير</strong> الذي يقيس الاحتياج بنقاط مرجعية ثابتة ويحجب الحكم حين لا تكفي الأدلة.
    الفروق بين المسارين ليست خطأً، بل هي نتيجة التقرير، وتُعرض للمقارنة لا للتوفيق بينها.
  </div>

  <h2>أعلى أولويات التدخّل (مؤشر الاحتياج المعاير)</h2>
  ${priorityTable(top)}

  <h2>مقارنة المسارين</h2>
  ${comparisonTable(ordered)}

  <div class="page-break"></div>
  <h2>مديريات محجوبة لقلة الأدلة</h2>
  ${blockedTable(rows)}
  <div class="note">الحجب يعني أن نسبة الأوزان المتاحة أقل من الحد الأدنى (${percent(meta.minWeightCoverage ?? 0.6)})، فلا يصح إصدار رقم مركب. المطلوب استكمال البيانات لا تعديل المعادلة.</div>

  <h2>قيم شاذة مستبعدة من الترتيب</h2>
  ${anomaliesTable(rows)}

  <h2>فجوات البيانات</h2>
  ${gapsTable(analysis)}

  <div class="page-break"></div>
  <h2>حساسية القرار</h2>
  ${sensitivityTable(rows)}

  <h2>المنهجية والأوزان</h2>
  <p>عتبة الانحدار (k) = <span class="ltr">${meta.kThreshold ?? 4}</span> من 12 بُعدًا، وخط الحرمان = <span class="ltr">${meta.deprivationLine ?? 0.6}</span>.
  المديرية التي تتجاوز أبعادها المتدهورة العتبة تُصنّف «حرمان حاد» وتتصدر القائمة مهما كان متوسطها.
  المديريات ذات القيم غير المنطقية تُستبعد من الترتيب حتى تُصحَّح، وتُدرَج في القسم المخصص لها أعلاه.</p>
  ${weightsTable(analysis)}

  <h2>حدود التقرير</h2>
  <ul>
    <li>المصدر الوحيد للحقيقة هو قاعدة البيانات المحلية المعتمدة، وليس ملف Excel المصدّر.</li>
    <li>المستوى الجغرافي مديرية فقط؛ لا تُستنتج نتائج على مستوى العزلة أو القرية.</li>
    <li>نقاط المعايرة المرجعية (anchors) معاملات موثّقة قابلة للنقاش، وقد تُحدَّث بقرار فني موثّق.</li>
    <li>الحقول الحساسة (الإيرادات، الفقر، الفئات الأكثر ضعفًا، قرار المراجع) لا تُعرض إلا بصلاحية مناسبة وتُسجَّل في سجل الوصول.</li>
  </ul>

  <footer>نظام التنمية المحلية — تقرير آلي؛ لا يُعتمد دون مراجعة بشرية.</footer>
</body></html>`;
}

/**
 * Render the report to PDF using a hidden BrowserWindow.
 *
 * @param {object} electronApi { BrowserWindow } from require('electron')
 * @param {string} filePath destination .pdf
 * @param {object} analysis
 * @param {{audit?:Array}} [context]
 */
async function exportReportHtmlPdf(electronApi, filePath, html, pageSize = 'A4') {
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ldi-report-'));
  const tempFile = path.join(tempDirectory, 'report.html');
  let window = null;

  try {
    fs.writeFileSync(tempFile, html, 'utf8');
    window = new electronApi.BrowserWindow({
      show: false,
      width: 1200,
      height: 1600,
      webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    await window.loadFile(tempFile);
    const data = await window.webContents.printToPDF({
      printBackground: true,
      pageSize,
      margins: { top: 0.55, bottom: 0.63, left: 0.47, right: 0.47 },
      preferCSSPageSize: true,
    });
    fs.writeFileSync(filePath, data);
    return { filePath, bytes: data.length };
  } finally {
    if (window && !window.isDestroyed()) window.destroy();
    try { fs.rmSync(tempDirectory, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

async function exportAnalysisPdf(electronApi, filePath, analysis, context = {}) {
  return exportReportHtmlPdf(electronApi, filePath, renderReportHtml(analysis, context));
}

async function exportDatabaseReportPdf(electronApi, filePath, report) {
  return exportReportHtmlPdf(electronApi, filePath, renderDatabaseReportHtml(report), 'A3');
}

async function exportIndicatorsReportPdf(electronApi, filePath, report) {
  return exportReportHtmlPdf(electronApi, filePath, renderIndicatorsReportHtml(report), 'A3');
}

module.exports = {
  renderReportHtml,
  renderDatabaseReportHtml,
  renderIndicatorsReportHtml,
  exportAnalysisPdf,
  exportDatabaseReportPdf,
  exportIndicatorsReportPdf,
  escapeHtml,
};
