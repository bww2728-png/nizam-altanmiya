'use strict';

/**
 * Import plan: the reviewable contract between a workbook and the database.
 *
 * The workbook is the only entry point of the system, so every decision that
 * used to happen "inside" the parser now happens here, explicitly and visibly:
 *
 *  - a row is classified as `ready`, `review` or `blocked` (never silently kept
 *    or silently dropped);
 *  - every cell that failed to parse keeps its raw text and the reason, so the
 *    operator can fix it in Excel instead of guessing;
 *  - unit mistakes are converted when the conversion is safe (0.197 vs 19.7 in a
 *    ratio column) and recorded, never invented;
 *  - implausible magnitudes are reported as anomalies and excluded from ranking
 *    until a human clears them (a percentage of 75,643,312 is a typo, not data);
 *  - re-importing shows a field-by-field difference against what is stored, so a
 *    human decides per record whether the new value wins.
 *
 * The plan is deliberately a plain data structure: it is serialised to the
 * renderer, asserted in tests, and applied by `applyImportPlan`, which keeps
 * "what was proposed" and "what was written" separable.
 */

const crypto = require('node:crypto');
const { INPUT_FIELDS, FIELD_BY_KEY, MANDATORY_FIELDS } = require('./schema.cjs');
const { DIRECTORATE_COLUMNS } = require('./store-schema.cjs');

const MANDATORY_BY_KEY = new Map(MANDATORY_FIELDS.map((field) => [field.key, field]));

/** schema.cjs exposes plain lookup objects; wrap them once, not per call. */
const FIELD_BY_KEY_MAP = new Map(Object.entries(FIELD_BY_KEY));

/**
 * Magnitude above which a count column is treated as a unit error rather than a
 * value: ten million people/roads/schools in a single district does not exist in
 * the source domain, so such a cell is flagged and kept out of the ranking. The
 * threshold is deliberately an order of magnitude above the largest plausible
 * count (a governorate capital district) and below the observed mis-keyed value
 * (75,643,312 typed into a count or percentage column).
 */
const ANOMALY_ABSOLUTE_LIMIT = 1e7;

/**
 * Currency columns are legitimately large in Yemeni rials (a district revenue of
 * 165 million is normal), so the magnitude net applies to counts only.
 */
const CURRENCY_KEYS = new Set(['revenue', 'projectCost']);

/** Codes that mean "this cell could not be understood": the row is quarantined. */
const BLOCKING_CODES = new Set(['invalid-number', 'invalid-boolean', 'ratio-out-of-range', 'missing-identity']);
/** Codes that leave the row writable but incomplete or annotated. */
const WARNING_CODES = new Set(['missing-mandatory', 'percent-converted', 'placeholder', 'had-percent', 'anomaly', 'duplicate-in-file']);

function nowIso() {
  return new Date().toISOString();
}

/**
 * Fingerprint the exact persisted data that an import plan may overwrite.
 * Include field provenance as well as directorate values: a manual correction,
 * source reassignment, insert or delete invalidates every pending plan.
 */
function databaseFingerprint(database) {
  const directorates = database.prepare('SELECT * FROM directorates ORDER BY id').all();
  const sources = database.prepare(
    'SELECT * FROM directorate_sources ORDER BY directorate_id, field_key'
  ).all();
  return crypto.createHash('sha256')
    .update(JSON.stringify({ directorates, sources }), 'utf8')
    .digest('hex');
}

function captureDatabaseState(database) {
  return database.transaction(() => ({
    directorates: database.prepare('SELECT * FROM directorates ORDER BY id').all(),
    sources: database.prepare(
      'SELECT * FROM directorate_sources ORDER BY directorate_id, field_key'
    ).all(),
  }))();
}

function identityKey(governorate, district) {
  return `${String(governorate ?? '').trim()}|${String(district ?? '').trim()}`;
}

/** Human-readable Arabic reason for every machine code we can emit. */
const CODE_LABELS = {
  'invalid-number': 'قيمة رقمية غير صالحة (نص في حقل رقمي)',
  'invalid-boolean': 'قيمة نعم/لا غير مفهومة',
  'ratio-out-of-range': 'نسبة خارج المدى المفهوم (0-100%)',
  anomaly: 'مقدار غير منطقي (خطأ وحدة مرجّح)',
  'missing-mandatory': 'حقل إلزامي ناقص',
  'missing-identity': 'حقل الهوية مفقود',
  'percent-converted': 'نسبة حُوّلت إلى كسر (19.7 → 0.197)',
  placeholder: 'خلية تحمل «لا يوجد/—» فتُعامل كفراغ',
  'had-percent': 'الخلية تحمل علامة % صريحة',
  'duplicate-in-file': 'مفتاح مكرر داخل الملف',
};

function labelFor(code) {
  return CODE_LABELS[code] ?? code;
}

/** Convert one parser warning into a reviewable issue. */
function issueFor(warning) {
  const field = FIELD_BY_KEY_MAP.get(warning.key) ?? null;
  const code = warning.code ?? 'invalid';
  const severity = BLOCKING_CODES.has(code) ? 'blocker' : WARNING_CODES.has(code) ? 'warning' : 'info';
  return {
    key: warning.key ?? null,
    column: field?.column ?? null,
    header: field?.header ?? null,
    code,
    reason: labelFor(code),
    severity,
    raw: warning.raw ?? '',
    previous: warning.value ?? null,
  };
}

/**
 * Keys whose stored value is implausible for its unit.
 *
 * Computed from the values themselves (never stored as a flag) so fixing a cell
 * on the correction screen clears the anomaly automatically.
 */
function anomalyKeys(values) {
  const keys = [];
  for (const field of INPUT_FIELDS) {
    if (field.type !== 'number') continue;
    if (CURRENCY_KEYS.has(field.key)) continue;
    const numeric = Number(values?.[field.key]);
    if (!Number.isFinite(numeric)) continue;
    if (Math.abs(numeric) > ANOMALY_ABSOLUTE_LIMIT) keys.push(field.key);
  }
  return keys;
}

function anomalyIssue(key) {
  const field = FIELD_BY_KEY_MAP.get(key);
  return {
    key,
    column: field?.column ?? null,
    header: field?.header ?? null,
    code: 'anomaly',
    reason: `${labelFor('anomaly')} — «${field?.header ?? key}»`,
    severity: 'warning',
    raw: '',
    previous: null,
  };
}

/** Field-by-field difference against the stored record. */
function diffAgainst(record, values, sources) {
  if (!record) return [];
  const changes = [];
  for (const field of INPUT_FIELDS) {
    const next = values[field.key];
    if (next === undefined) continue; // absent in the file: not a change
    const column = DIRECTORATE_COLUMNS[field.key];
    if (!column) continue;
    const before = record[column];
    // A stored null/undefined is "no value", not zero: a workbook cell holding an
    // explicit 0 (or false) against an empty stored cell IS a change, otherwise
    // the first real zero would be swallowed and the column would stay NULL.
    const beforeAbsent = before === null || before === undefined;
    const nextAbsent = next === null || next === undefined;
    const same = beforeAbsent || nextAbsent
      ? beforeAbsent && nextAbsent
      : typeof next === 'number' || typeof before === 'number'
        ? Number(before) === Number(next)
        : String(before) === String(next);
    if (same) continue;
    changes.push({
      key: field.key,
      column: field.column,
      header: field.header,
      before: before ?? null,
      after: next,
      source: sources[field.key] ?? null,
    });
  }
  return changes;
}

/** Completeness of a planned row using the same 13 mandatory fields as column BD. */
function completenessOf(values) {
  const missing = MANDATORY_FIELDS.filter((field) => values[field.key] === undefined || values[field.key] === null);
  const total = MANDATORY_FIELDS.length;
  return {
    present: total - missing.length,
    total,
    ratio: total ? (total - missing.length) / total : 0,
    missing: missing.map((field) => field.key),
    missingLabels: missing.map((field) => field.label),
  };
}

/**
 * Build the plan.
 *
 * `stale` lists directorates already stored from this same source file but
 * absent from the new read: they are never deleted, only surfaced, because the
 * workbook is meant to be the source of truth and a human must decide whether a
 * disappearance is a real removal or a truncated/broken export.
 *
 * @param {object} database better-sqlite3 handle (read-only use)
 * @param {object} read result of readDirectorateWorkbook
 * @param {{fileName?:string, sheetName?:string}} [meta]
 */
function buildImportPlan(database, read, meta = {}) {
  // Capture directorates and their provenance within one SQLite read transaction
  // so the review plan and its concurrency token describe the same DB snapshot.
  const databaseState = captureDatabaseState(database);
  const stored = new Map();
  for (const record of databaseState.directorates) {
    stored.set(identityKey(record.governorate, record.district), record);
  }
  const planDatabaseFingerprint = crypto.createHash('sha256')
    .update(JSON.stringify(databaseState), 'utf8')
    .digest('hex');

  const rows = [];
  const seen = new Map();
  const scope = { create: 0, update: 0, unchanged: 0, duplicate: 0, ready: 0, review: 0, blocked: 0, anomaly: 0, incomplete: 0, stale: 0 };

  for (const row of read.rows ?? []) {
    const values = { ...(row.values ?? {}) };
    const sources = { ...(row.sources ?? {}) };
    const rawValues = { ...(row.rawValues ?? {}) };
    const issues = (row.warnings ?? []).map(issueFor);

    const anomalous = anomalyKeys(values);
    for (const key of anomalous) {
      if (!issues.some((issue) => issue.key === key && issue.code === 'anomaly')) issues.push(anomalyIssue(key));
    }

    const completeness = completenessOf(values);
    for (const field of MANDATORY_FIELDS) {
      if (values[field.key] !== undefined && values[field.key] !== null) continue;
      if (issues.some((issue) => issue.key === field.key)) continue; // already reported as unparsable
      issues.push({
        key: field.key,
        column: field.column,
        header: FIELD_BY_KEY_MAP.get(field.key)?.header ?? field.label,
        code: 'missing-mandatory',
        reason: `${labelFor('missing-mandatory')}: ${field.label}`,
        severity: 'warning',
        raw: rawValues[field.key] ?? '',
        previous: null,
      });
    }

    // The identity is (governorate, district): a row missing either half cannot
    // be matched or stored safely, so it is blocked outright and never `create`d.
    const governorate = values.governorate ?? row.governorate ?? '';
    const districtName = values.districtName ?? row.districtName ?? '';
    const missingIdentity = [];
    if (!String(governorate).trim()) missingIdentity.push({ key: 'governorate', column: 'E', header: 'المحافظة' });
    if (!String(districtName).trim()) missingIdentity.push({ key: 'districtName', column: 'A', header: 'اسم المديرية' });
    for (const field of missingIdentity) {
      issues.push({
        key: field.key,
        column: field.column,
        header: field.header,
        code: 'missing-identity',
        reason: `${labelFor('missing-identity')}: ${field.header}`,
        severity: 'blocker',
        raw: rawValues[field.key] ?? '',
        previous: null,
      });
    }
    const identityComplete = missingIdentity.length === 0;

    const key = identityKey(governorate, districtName);
    // A repeated identity inside one file is collapsed to a single application
    // (the first occurrence): later rows are reported as duplicates, not applied.
    const isDuplicate = identityComplete && seen.has(key);
    const duplicateOf = isDuplicate ? (seen.get(key) ?? null) : null;
    if (isDuplicate) {
      issues.push({
        key: 'districtName',
        column: 'A',
        header: 'اسم المديرية',
        code: 'duplicate-in-file',
        reason: `${labelFor('duplicate-in-file')} (الصف ${duplicateOf}) — يُطبَّق الصف الأول فقط`,
        severity: 'warning',
        raw: '',
        previous: null,
      });
    } else if (identityComplete) {
      seen.set(key, row.rowNumber ?? null);
    }

    const record = stored.get(key) ?? null;
    const changes = diffAgainst(record, values, sources);
    const status = issues.some((issue) => issue.severity === 'blocker')
      ? 'blocked'
      : issues.some((issue) => issue.severity === 'warning') ? 'review' : 'ready';
    const action = !identityComplete
      ? 'blocked'
      : isDuplicate
        ? 'duplicate'
        : !record ? 'create' : changes.length ? 'update' : 'unchanged';

    scope[status] += 1;
    if (anomalous.length) scope.anomaly += 1;
    if (completeness.missing.length) scope.incomplete += 1;
    if (action === 'create') scope.create += 1;
    else if (action === 'update') scope.update += 1;
    else if (action === 'duplicate') scope.duplicate += 1;
    else if (action === 'unchanged') scope.unchanged += 1;

    rows.push({
      rowNumber: row.rowNumber ?? null,
      districtName,
      governorate,
      directorateId: record?.id ?? null,
      action,
      status,
      completeness,
      anomalyKeys: anomalous,
      issues,
      changes,
      values,
      rawValues,
      sources,
      duplicateOf,
      // The raw parser warnings travel with the row unmetamorphosed so they can
      // be stored per record on apply; the quality report (gaps) reads that
      // column verbatim, so it must keep the parser's own field names.
      warnings: row.warnings ?? [],
    });
  }

  const fileName = meta.fileName ?? read.fileName ?? null;
  const stale = fileName
    ? [...stored.values()]
      .filter((record) => record.source_file && String(record.source_file) === String(fileName) && !seen.has(identityKey(record.governorate, record.district)))
      .map((record) => ({ id: record.id, governorate: record.governorate, district: record.district }))
    : [];
  scope.stale = stale.length;

  const matchedCount = read.matched?.length ?? 0;
  return {
    fileName,
    sheetName: meta.sheetName ?? read.sheetName ?? null,
    headerRow: read.headerRow ?? null,
    columnCount: matchedCount + (read.unmatched?.length ?? 0),
    matched: read.matched ?? [],
    unmatched: read.unmatched ?? [],
    duplicates: read.duplicates ?? [],
    missingInputs: read.missingInputs ?? [],
    warnings: read.warnings ?? [],
    stale,
    totalRows: rows.length,
    scope,
    rows,
    workbookInventory: read.workbookInventory ?? null,
    // Kept in the main-process plan only; summarizePlan intentionally omits it.
    databaseFingerprint: planDatabaseFingerprint,
    createdAt: nowIso(),
  };
}

/** Compact payload for the summary banner and the review table. */
function summarizePlan(plan, limit = 300) {
  return {
    fileName: plan.fileName,
    sheetName: plan.sheetName,
    headerRow: plan.headerRow,
    matchedCount: plan.matched.length,
    missingInputs: plan.missingInputs,
    unmatched: plan.unmatched,
    duplicates: plan.duplicates,
    stale: plan.stale ?? [],
    warnings: plan.warnings,
    totalRows: plan.totalRows,
    scope: plan.scope,
    createdAt: plan.createdAt,
    workbookInventory: plan.workbookInventory ?? null,
    changedFields: [...new Set(plan.rows.flatMap((row) => row.changes.map((change) => change.key)))],
    preview: plan.rows.slice(0, limit).map((row) => ({
      rowNumber: row.rowNumber,
      districtName: row.districtName,
      governorate: row.governorate,
      directorateId: row.directorateId,
      action: row.action,
      status: row.status,
      completeness: row.completeness,
      anomalyKeys: row.anomalyKeys,
      issues: row.issues.map((issue) => ({
        key: issue.key,
        header: issue.header,
        code: issue.code,
        reason: issue.reason,
        severity: issue.severity,
        raw: issue.raw,
      })),
      changes: row.changes.map((change) => ({
        key: change.key,
        header: change.header,
        before: change.before,
        after: change.after,
      })),
    })),
  };
}

/**
 * Apply the plan.
 *
 * `decisions` maps a row number to `'apply'` or `'skip'`. For create/update
 * rows, absence of an explicit `'apply'` is always a skip: the backend never
 * assumes that a row was reviewed just because it appeared in a preview.
 * A blocked row needs both `force` and an explicit per-row `'apply'`.
 * `unchanged` rows and intra-file duplicates are never written. Data and the
 * audit entry share one transaction: a failure leaves the database untouched.
 */
function applyImportPlan(database, plan, request = {}) {
  const decisions = request.decisions ?? {};
  const force = Boolean(request.force);
  const persist = require('./persist.cjs');
  const meta = { fileName: plan.fileName, sheetName: plan.sheetName };
  const applied = [];
  const skipped = [];
  const refused = [];
  const duplicates = [];
  let unchanged = 0;

  const run = database.transaction((rows) => {
    // A plan is valid only for the exact DB snapshot the operator reviewed.
    // Check inside the write transaction before the first insert/update.
    if (!plan.databaseFingerprint || databaseFingerprint(database) !== plan.databaseFingerprint) {
      throw new Error('تغيرت البيانات المعتمدة بعد فحص الملف. أعد فحص ملف Excel وراجع الخطة الجديدة قبل التطبيق.');
    }

    for (const row of rows) {
      const requested = decisions[row.rowNumber] ?? decisions[String(row.rowNumber)];

      if (requested === 'skip') {
        skipped.push({ rowNumber: row.rowNumber, districtName: row.districtName, reason: 'تخطٍّ بطلب المستخدم' });
        continue;
      }

      // A repeated identity inside the file is collapsed to one application:
      // only the first occurrence is written, the rest are reported.
      if (row.action === 'duplicate') {
        duplicates.push({
          rowNumber: row.rowNumber,
          districtName: row.districtName,
          governorate: row.governorate,
          duplicateOf: row.duplicateOf ?? null,
          reason: 'مفتاح مكرر داخل الملف — يُطبَّق الصف الأول فقط',
        });
        continue;
      }

      // A row identical to what is already stored is not written, and is never
      // counted as an update.
      if (row.action === 'unchanged') {
        unchanged += 1;
        continue;
      }

      if (row.status === 'blocked') {
        // A blocked row needs two independent acts: explicit per-row approval
        // and the separate force switch. Identity-blocked rows are never writable.
        const writable = force && requested === 'apply' && row.action !== 'blocked';
        if (!writable) {
          if (force) {
            skipped.push({
              rowNumber: row.rowNumber,
              districtName: row.districtName,
              reason: row.action === 'blocked'
                ? 'صف بلا هوية (محافظة/مديرية) — لا يمكن كتابته'
                : 'صف محجوب بلا قرار «apply» صريح',
            });
          } else {
            refused.push({
              rowNumber: row.rowNumber,
              districtName: row.districtName,
              governorate: row.governorate,
              blockers: row.issues.filter((issue) => issue.severity === 'blocker').map((issue) => `${issue.header ?? issue.key}: ${issue.reason}`),
            });
          }
          continue;
        }
      } else if (requested !== 'apply') {
        skipped.push({
          rowNumber: row.rowNumber,
          districtName: row.districtName,
          reason: requested === 'skip' ? 'تخطٍّ بطلب المستخدم' : 'لم يصدر اعتماد صريح لهذا الصف',
        });
        continue;
      }

      const result = persist.upsertDirectorate(database, {
        districtName: row.districtName,
        governorate: row.governorate,
        values: row.values,
        rawValues: row.rawValues,
        sources: row.sources,
        rowNumber: row.rowNumber,
      }, { ...meta, warnings: row.warnings ?? [] });
      applied.push({
        rowNumber: row.rowNumber,
        directorateId: result.id,
        created: result.created,
        districtName: row.districtName,
        governorate: row.governorate,
      });
    }

    const created = applied.filter((entry) => entry.created).length;
    const updated = applied.length - created;
    // The audit entry joins the same transaction as the data it describes, so
    // audit and data always commit or roll back together.
    database.prepare(
      'INSERT INTO access_log (action, entity, entity_id, fields, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(
      'excel-import',
      'directorates',
      plan.fileName ?? '',
      String(applied.length),
      `created=${created};updated=${updated};unchanged=${unchanged};refused=${refused.length};skipped=${skipped.length};duplicates=${duplicates.length}`,
      nowIso(),
    );
    return { created, updated };
  });
  const { created, updated } = run(plan.rows ?? []);

  return {
    fileName: plan.fileName,
    total: plan.rows?.length ?? 0,
    created,
    updated,
    applied: applied.length,
    unchanged,
    refused,
    skipped,
    duplicates,
    appliedRows: applied,
  };
}

module.exports = { buildImportPlan, summarizePlan, applyImportPlan, anomalyKeys, CODE_LABELS };
