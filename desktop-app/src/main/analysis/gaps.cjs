'use strict';

const { INPUT_FIELDS, MANDATORY_FIELDS, RATIO_KEYS } = require('./schema.cjs');

/**
 * Data-gap analysis.
 *
 * The workbook measures completeness (BD) — "is the cell filled" — and the
 * audit's gap #5 says that is not quality. This module adds the missing checks
 * without ever blocking a row silently: every finding is returned with a
 * severity, a human explanation and the field it belongs to.
 */

const SEVERITY = { blocker: 'مانع', warning: 'تحذير', info: 'معلومة' };

function issue(severity, code, field, message, extra = {}) {
  return { severity, code, field, message, ...extra };
}

function round(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * @param {Array<{id:any, districtName:string, governorate:string, values:object, warnings:Array, rawValues?:object}>} records
 */
function analyzeGaps(records) {
  const recordIssues = new Map();
  const byCode = new Map();

  const add = (record, item) => {
    if (!recordIssues.has(record)) recordIssues.set(record, []);
    recordIssues.get(record).push(item);
    byCode.set(item.code, (byCode.get(item.code) ?? 0) + 1);
  };

  // ---- per-record checks ------------------------------------------------
  for (const record of records) {
    const values = record.values ?? {};

    // A value that was read but could not be parsed (invalid-* / ratio-out-of-range)
    // is already reported with its own reason. Reporting it a second time as
    // `missing-mandatory` would double the findings for one cell, so an unparsable
    // key is exempted — the same rule `import-plan` follows when it builds a plan.
    const unparsable = new Set();
    for (const warning of record.warnings ?? []) {
      if (String(warning.code).startsWith('invalid') || warning.code === 'ratio-out-of-range') unparsable.add(warning.key);
    }

    for (const field of MANDATORY_FIELDS) {
      if (unparsable.has(field.key)) continue;
      const value = values[field.key];
      const present = field.key === 'frontLine' || field.key === 'projectStatus'
        ? value !== null && value !== undefined && String(value).trim() !== ''
        : typeof value === 'number' && Number.isFinite(value);
      if (!present) {
        add(record, issue('blocker', 'missing-mandatory', field.key,
          `الحقل الإلزامي «${field.label}» (${field.column}) فارغ؛ يمنع الترقية للترتيب.`,
          { column: field.column }));
      }
    }

    for (const warning of record.warnings ?? []) {
      const field = INPUT_FIELDS.find((item) => item.key === warning.key);
      const label = field ? `${field.header} (${field.column})` : warning.key;
      if (warning.code === 'percent-converted') {
        add(record, issue('warning', 'percent-converted', warning.key,
          `القيمة «${warning.raw}» في ${label} قُرئت كنسبة مئوية وحُوّلت إلى كسر (${warning.value}).`, { raw: warning.raw }));
      } else if (warning.code === 'placeholder') {
        add(record, issue('warning', 'placeholder-value', warning.key,
          `القيمة «${warning.raw}» في ${label} نص بديل وليست بيانات.`, { raw: warning.raw }));
      } else if (String(warning.code).startsWith('invalid') || warning.code === 'ratio-out-of-range') {
        add(record, issue('blocker', 'invalid-value', warning.key,
          `القيمة «${warning.raw}» في ${label} غير قابلة للتحويل؛ تُعامل كفراغ مع تسجيل السبب.`, { raw: warning.raw }));
      }
    }

    if (typeof values.population === 'number' && values.population <= 0) {
      add(record, issue('blocker', 'zero-population', 'population',
        'عدد السكان صفر أو سالب؛ كل المؤشرات النسبية (نصيب الفرد، مدارس/10آلاف...) تصبح غير قابلة للحساب.'));
    }

    const roadShares = [values.pavedRoads, values.unpavedRoads, values.cutRoads]
      .filter((value) => typeof value === 'number' && Number.isFinite(value));
    if (roadShares.length === 3) {
      const total = roadShares.reduce((sum, value) => sum + value, 0);
      if (total > 1.05) {
        add(record, issue('warning', 'roads-shares-exceed', 'pavedRoads',
          `مجموع نسب الطرق (مزفلتة + ترابية + شق) = ${round(total * 100, 1)}% ويتجاوز 105%؛ تناقض داخلي.`));
      }
    }

    if (typeof values.waterCoverage === 'number' && typeof values.pavedRoads === 'number') {
      if (values.waterCoverage > 0.9 && values.pavedRoads < 0.1) {
        add(record, issue('warning', 'implausible-combination', 'waterCoverage',
          'تغطية مياه تتجاوز 90% مع طرق مزفلتة أقل من 10%؛ يستحسن التحقق الميداني.'));
      }
    }

    if (typeof values.povertyRatio === 'number' && typeof values.waterCoverage === 'number') {
      if (values.povertyRatio < 0.1 && values.waterCoverage < 0.4) {
        add(record, issue('warning', 'contradiction-poverty-water', 'povertyRatio',
          'فقر أقل من 10% مع تغطية مياه أقل من 40%؛ تناقض يستدعي مراجعة المصدر.'));
      }
    }

    if (typeof values.revenue === 'number' && typeof values.population === 'number' && values.population > 0) {
      const perCapita = values.revenue / values.population;
      if (perCapita < 1) {
        add(record, issue('info', 'low-revenue-per-capita', 'revenue',
          `نصيب الفرد من الإيراد ${round(perCapita, 2)} فقط؛ تحقق من وحدة الإيراد (ريال لا مليون).`));
      }
    }

    for (const key of RATIO_KEYS) {
      const value = values[key];
      if (typeof value === 'number' && (value < 0 || value > 1)) {
        add(record, issue('blocker', 'ratio-out-of-range', key, `نسبة خارج النطاق 0..1: ${value}.`));
      }
    }
  }

  // ---- cross-record checks ---------------------------------------------
  const crossIssues = [];

  const seen = new Map();
  for (const record of records) {
    const key = `${String(record.governorate ?? '').trim()}|${String(record.districtName ?? '').trim()}`;
    if (!record.districtName) continue;
    if (seen.has(key)) {
      crossIssues.push(issue('blocker', 'duplicate-district', 'districtName',
        `المديرية «${record.districtName}» مكرّرة (${key}); الصفّان سيُنافسان على المرتبة نفسها.`));
    } else seen.set(key, record.id);
  }

  if (records.length >= 5) {
    for (const field of INPUT_FIELDS) {
      if (field.type !== 'number') continue;
      const values = records
        .map((record) => record.values?.[field.key])
        .filter((value) => typeof value === 'number' && Number.isFinite(value));
      if (values.length < 5) continue;
      const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
      const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
      const std = Math.sqrt(variance);
      if (std === 0) continue;
      for (const record of records) {
        const value = record.values?.[field.key];
        if (typeof value !== 'number' || !Number.isFinite(value)) continue;
        const z = (value - mean) / std;
        if (Math.abs(z) >= 3) {
          add(record, issue('warning', 'statistical-outlier', field.key,
            `قيمة شاذة إحصائيًا في «${field.header}» (z=${round(z, 2)}، المتوسط ${round(mean, 2)}).`));
        }
      }
    }
  }

  // ---- summary ---------------------------------------------------------
  const summary = { blocker: 0, warning: 0, info: 0, total: 0, byCode: {} };
  for (const issues of recordIssues.values()) {
    for (const item of issues) {
      summary[item.severity] += 1;
      summary.total += 1;
    }
  }
  for (const item of crossIssues) summary[item.severity] += 1;
  if (crossIssues.length) summary.total += crossIssues.length;
  summary.byCode = Object.fromEntries([...byCode.entries()].sort((a, b) => b[1] - a[1]));
  summary.recordsWithBlockers = [...recordIssues.entries()].filter(([, issues]) => issues.some((item) => item.severity === 'blocker')).length;

  return { recordIssues, crossIssues, summary, severityLabels: SEVERITY };
}

module.exports = { analyzeGaps, SEVERITY };