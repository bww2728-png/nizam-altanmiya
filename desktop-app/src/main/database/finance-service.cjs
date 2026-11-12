'use strict';

// ---------------------------------------------------------------------------
// Finance and budget service over the unified development data model.
//
// Money exists twice in the schema: the original REAL column (<col>) and an
// exact integer mirror in minor units (<col>_minor). Every total below is
// summed from the integer mirror, and a decimal string is produced only for
// display, from `currencies.minor_unit`. No total is ever accumulated in
// floating point, and currencies are never summed together: each currency is
// its own bucket.
//
// Every write delegates to domain-service.cjs, so the audit trail stays single
// and validation stays consistent with the rest of the application.
//
// Missing tables/columns degrade to empty results plus an explicit `note`;
// they never throw.
// ---------------------------------------------------------------------------

const domain = require('./domain-service.cjs');

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CURRENCY_CODE = /^[A-Z]{3}$/;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;
const MAX_OFFSET = 1000000;

const REVENUE_FIELDS = Object.freeze([
  'geo_unit_id', 'period_id', 'account_id', 'collecting_entity_id',
  'assessed_amount', 'collected_amount', 'remitted_amount',
  'currency_code', 'transaction_date', 'source_id'
]);

const EXPENDITURE_FIELDS = Object.freeze([
  'geo_unit_id', 'period_id', 'account_id', 'project_id',
  'paid_amount', 'currency_code', 'transaction_date',
  'expenditure_status', 'source_id'
]);

const REVENUE_ALIASES = Object.freeze({
  geoUnitId: 'geo_unit_id',
  periodId: 'period_id',
  accountId: 'account_id',
  collectingEntityId: 'collecting_entity_id',
  assessedAmount: 'assessed_amount',
  collectedAmount: 'collected_amount',
  remittedAmount: 'remitted_amount',
  currencyCode: 'currency_code',
  transactionDate: 'transaction_date',
  sourceId: 'source_id'
});

const EXPENDITURE_ALIASES = Object.freeze({
  geoUnitId: 'geo_unit_id',
  periodId: 'period_id',
  accountId: 'account_id',
  projectId: 'project_id',
  paidAmount: 'paid_amount',
  currencyCode: 'currency_code',
  transactionDate: 'transaction_date',
  expenditureStatus: 'expenditure_status',
  sourceId: 'source_id'
});

// ---------------------------------------------------------------------------
// Small schema helpers.
// ---------------------------------------------------------------------------

function requireDb(db) {
  if (!db || typeof db.prepare !== 'function') throw new Error('اتصال قاعدة البيانات غير صالح.');
  return db;
}

function quote(name) {
  const text = String(name ?? '');
  if (!IDENTIFIER.test(text)) throw new Error(`معرّف SQL غير صالح: ${text}`);
  return `"${text}"`;
}

function tablePresent(db, table) {
  if (!IDENTIFIER.test(String(table ?? ''))) return false;
  return Boolean(db.prepare("SELECT 1 AS hit FROM sqlite_master WHERE type='table' AND name=?").get(String(table)));
}

function tableColumns(db, table) {
  if (!tablePresent(db, table)) return new Set();
  return new Set(db.prepare(`PRAGMA table_info(${quote(table)})`).all().map(column => column.name));
}

function countRows(db, table) {
  if (!tablePresent(db, table)) return 0;
  return Number(db.prepare(`SELECT COUNT(*) AS total FROM ${quote(table)}`).get().total ?? 0);
}

function clampLimit(value, fallback = DEFAULT_LIMIT, max = MAX_LIMIT) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  const integer = Math.trunc(number);
  if (integer < 1) return fallback;
  return Math.min(max, integer);
}

function clampOffset(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return 0;
  return Math.min(MAX_OFFSET, Math.trunc(number));
}

function positiveId(value, label) {
  const candidate = typeof value === 'number' ? value : Number(String(value ?? '').trim());
  if (!Number.isSafeInteger(candidate) || candidate <= 0) throw new Error(`المعرّف في «${label}» غير صالح.`);
  return candidate;
}

function normaliseCurrency(value, label = 'العملة') {
  const code = String(value ?? '').trim().toUpperCase();
  if (!CURRENCY_CODE.test(code)) throw new Error(`رمز العملة في «${label}» يجب أن يكون ثلاثة أحرف لاتينية كبيرة.`);
  return code;
}

// Optional integer filter: null when the caller did not supply one.
function optionalId(value, label) {
  if (value === null || value === undefined || value === '') return null;
  return positiveId(value, label);
}

function pushNote(notes, text) {
  if (!notes.includes(text)) notes.push(text);
}

// ---------------------------------------------------------------------------
// Money helpers. Integers in, decimal strings out.
// ---------------------------------------------------------------------------

function minorUnits(db) {
  const units = new Map();
  if (!tablePresent(db, 'currencies')) return units;
  const columns = tableColumns(db, 'currencies');
  if (!columns.has('currency_code') || !columns.has('minor_unit')) return units;
  for (const row of db.prepare('SELECT upper(trim(currency_code)) AS code, minor_unit AS unit FROM currencies').all()) {
    const unit = Number(row.unit);
    if (row.code && Number.isInteger(unit) && unit >= 0 && unit <= 4) units.set(String(row.code), unit);
  }
  return units;
}

function unitOf(units, code) {
  const key = String(code ?? '').trim().toUpperCase();
  return units.has(key) ? units.get(key) : 2;
}

// Exact decimal text from an integer minor amount. BigInt keeps the division
// exact even near the safe-integer boundary.
function formatMinor(minor, unit) {
  const digits = Number.isInteger(unit) && unit >= 0 && unit <= 4 ? unit : 2;
  const number = Number(minor);
  const value = Number.isFinite(number) ? Math.trunc(number) : 0;
  const absolute = BigInt(Math.abs(value));
  const sign = value < 0 ? '-' : '';
  if (digits === 0) return `${sign}${absolute.toString()}`;
  const factor = 10n ** BigInt(digits);
  return `${sign}${(absolute / factor).toString()}.${(absolute % factor).toString().padStart(digits, '0')}`;
}

// Per-row integer factor from the currency registry (CASE keeps it integral).
function factorSql(db, alias) {
  if (!tablePresent(db, 'currencies')) return '100';
  return `(CASE coalesce((SELECT c.minor_unit FROM currencies c
    WHERE upper(trim(c.currency_code)) = upper(trim(${alias}.currency_code))),2)
    WHEN 0 THEN 1 WHEN 1 THEN 10 WHEN 2 THEN 100 WHEN 3 THEN 1000 ELSE 10000 END)`;
}

// Exact integer expression: the stored mirror when present, otherwise a
// per-row rounding of the REAL column (never a running float sum).
function minorSql(db, alias, base, minorColumn, hasCurrency) {
  const real = `${alias}.${quote(base)}`;
  const factor = hasCurrency ? factorSql(db, alias) : '100';
  if (minorColumn) {
    return `COALESCE(${alias}.${quote(minorColumn)}, CAST(ROUND(${real} * ${factor}) AS INTEGER))`;
  }
  return `CAST(ROUND(${real} * ${factor}) AS INTEGER)`;
}

// Reads one row's money: mirror first, rounded REAL as a marked fallback.
function moneyOf(row, base, minorColumn, unit) {
  if (!row) return { minor: null, derived: false };
  const mirror = minorColumn ? row[minorColumn] : null;
  if (mirror !== null && mirror !== undefined) {
    const value = Number(mirror);
    return { minor: Number.isFinite(value) ? Math.trunc(value) : null, derived: false };
  }
  const raw = row[base];
  if (raw === null || raw === undefined) return { minor: null, derived: false };
  const number = Number(raw);
  if (!Number.isFinite(number)) return { minor: null, derived: false };
  return { minor: Math.round(number * 10 ** unit), derived: true };
}

function formattedTotals(totals, unit) {
  const formatted = {};
  for (const [key, value] of Object.entries(totals)) {
    formatted[key] = value === null || value === undefined ? null : formatMinor(value, unit);
  }
  return formatted;
}

// ---------------------------------------------------------------------------
// Lookup joins (account / geography / entity / project labels).
// ---------------------------------------------------------------------------

// Placeholder for a lookup that cannot be joined because the foreign-key column
// (or the target table) is missing: the query stays valid and the label is NULL.
const NO_JOIN = Object.freeze({ join: '', label: 'NULL', labelColumn: null, columns: new Set() });

function lookupJoin(db, options) {
  const { table, alias, keyColumns, labelColumns, fkExpression } = options;
  const columns = tableColumns(db, table);
  const keyColumn = keyColumns.find(candidate => columns.has(candidate));
  if (!keyColumn) return { join: '', label: 'NULL', labelColumn: null, columns };
  const labelColumn = labelColumns.find(candidate => columns.has(candidate)) ?? null;
  const parts = labelColumns.filter(candidate => columns.has(candidate)).map(candidate => `${alias}.${quote(candidate)}`);
  parts.push(`CAST(${alias}.${quote(keyColumn)} AS TEXT)`);
  return {
    join: `LEFT JOIN ${quote(table)} ${alias} ON ${alias}.${quote(keyColumn)} = ${fkExpression}`,
    label: `coalesce(${parts.join(',')})`,
    labelColumn,
    columns
  };
}

// ---------------------------------------------------------------------------
// 1. Overview.
// ---------------------------------------------------------------------------

function currencyBuckets(db, notes) {
  const units = minorUnits(db);
  if (!units.size) pushNote(notes, 'جدول العملات (currencies) غير متاح؛ استُخدمت مرحلتان عشريتان للعرض فقط.');
  const buckets = new Map();

  const bucket = code => {
    const key = code && code.trim() ? code.trim().toUpperCase() : 'UNSPECIFIED';
    if (!buckets.has(key)) {
      buckets.set(key, {
        currencyCode: key,
        minorUnit: unitOf(units, key),
        approvedMinor: 0,
        revisedMinor: 0,
        actualMinor: 0,
        revenueMinor: 0,
        expenditureMinor: 0
      });
    }
    return buckets.get(key);
  };

  const grouped = (table, columns) => {
    if (!tablePresent(db, table)) return [];
    const present = tableColumns(db, table);
    if (!present.has('currency_code')) {
      pushNote(notes, `الجدول ${table} لا يحتوي عمود currency_code؛ استُثني من الإجماليات.`);
      return [];
    }
    const selects = [`UPPER(TRIM(COALESCE(t.currency_code,''))) AS code`];
    for (const [base, sumAlias] of columns) {
      if (!present.has(base)) {
        selects.push(`0 AS ${sumAlias}`);
        continue;
      }
      const mirror = present.has(`${base}_minor`) ? `${base}_minor` : null;
      selects.push(`CAST(COALESCE(SUM(${minorSql(db, 't', base, mirror, true)}),0) AS INTEGER) AS ${sumAlias}`);
    }
    return db.prepare(`SELECT ${selects.join(',')} FROM ${quote(table)} t GROUP BY code`).all();
  };

  for (const row of grouped('budget_lines', [
    ['approved_amount', 'approved_minor'],
    ['revised_amount', 'revised_minor'],
    ['actual_amount', 'actual_minor']
  ])) {
    const target = bucket(row.code);
    target.approvedMinor = Number(row.approved_minor ?? 0);
    target.revisedMinor = Number(row.revised_minor ?? 0);
    target.actualMinor = Number(row.actual_minor ?? 0);
  }

  for (const row of grouped('revenue_transactions', [['collected_amount', 'revenue_minor']])) {
    bucket(row.code).revenueMinor = Number(row.revenue_minor ?? 0);
  }

  for (const row of grouped('expenditure_transactions', [['paid_amount', 'expenditure_minor']])) {
    bucket(row.code).expenditureMinor = Number(row.expenditure_minor ?? 0);
  }

  return { buckets, units };
}

function overview(db) {
  requireDb(db);
  const notes = [];
  const counts = {
    accounts: countRows(db, 'financial_accounts'),
    budgets: countRows(db, 'budget_headers'),
    budgetLines: countRows(db, 'budget_lines'),
    revenueCount: countRows(db, 'revenue_transactions'),
    expenditureCount: countRows(db, 'expenditure_transactions')
  };
  for (const [key, table] of [
    ['accounts', 'financial_accounts'],
    ['budgets', 'budget_headers'],
    ['budgetLines', 'budget_lines'],
    ['revenueCount', 'revenue_transactions'],
    ['expenditureCount', 'expenditure_transactions']
  ]) {
    if (!tablePresent(db, table)) pushNote(notes, `الجدول ${table} غير موجود؛ العدد المعروض صفر.`);
  }

  const { buckets } = currencyBuckets(db, notes);
  const totalsByCurrency = [...buckets.values()]
    .map(item => {
      const balanceMinor = item.revenueMinor - item.expenditureMinor;
      return {
        ...item,
        balanceMinor,
        formatted: formattedTotals({
          approved: item.approvedMinor,
          revised: item.revisedMinor,
          actual: item.actualMinor,
          revenue: item.revenueMinor,
          expenditure: item.expenditureMinor,
          balance: balanceMinor
        }, item.minorUnit)
      };
    })
    .sort((left, right) => left.currencyCode.localeCompare(right.currencyCode));

  const hasData = Object.values(counts).some(value => value > 0);
  return { ...counts, totalsByCurrency, hasData, notes };
}

// ---------------------------------------------------------------------------
// 2. Chart of accounts as a tree.
// ---------------------------------------------------------------------------

function accountsTree(db) {
  requireDb(db);
  if (!tablePresent(db, 'financial_accounts')) return [];
  const columns = tableColumns(db, 'financial_accounts');
  if (!columns.has('account_id')) return [];

  const select = [
    'account_id AS account_id',
    columns.has('account_code') ? 'account_code AS account_code' : 'NULL AS account_code',
    columns.has('account_name_ar') ? 'account_name_ar AS account_name' : 'NULL AS account_name',
    columns.has('account_type') ? 'account_type AS account_type' : 'NULL AS account_type',
    columns.has('parent_account_id') ? 'parent_account_id AS parent_account_id' : 'NULL AS parent_account_id',
    columns.has('is_active') ? 'is_active AS is_active' : '1 AS is_active'
  ];

  const rows = db.prepare(`SELECT ${select.join(',')} FROM "financial_accounts"
    ORDER BY coalesce(account_code,''), account_id`).all();

  const nodes = rows.map(row => ({
    accountId: Number(row.account_id),
    accountCode: row.account_code ?? null,
    accountName: row.account_name ?? null,
    accountType: row.account_type ?? null,
    isActive: row.is_active === null ? null : Number(row.is_active) === 1,
    parentAccountId: row.parent_account_id === null || row.parent_account_id === undefined
      ? null
      : Number(row.parent_account_id),
    orphan: false,
    cycle: false,
    children: []
  }));

  const byId = new Map(nodes.map(node => [node.accountId, node]));
  const attached = new Set();

  const mobile = (start, originId) => {
    let cursor = start;
    const seen = new Set();
    while (cursor) {
      if (cursor.accountId === originId) return true;
      if (seen.has(cursor.accountId)) return true;
      seen.add(cursor.accountId);
      cursor = cursor.parentAccountId === null ? null : byId.get(cursor.parentAccountId) ?? null;
    }
    return false;
  };

  for (const node of nodes) {
    if (node.parentAccountId === null) continue;
    const parent = byId.get(node.parentAccountId);
    if (!parent) {
      node.orphan = true; // dangling parent reference: exposed at root, flagged
      continue;
    }
    if (parent.accountId === node.accountId || mobile(parent, node.accountId)) {
      node.orphan = true;
      node.cycle = true;
      continue;
    }
    parent.children.push(node);
    attached.add(node.accountId);
  }

  const finish = node => {
    node.childCount = node.children.length;
    for (const child of node.children) finish(child);
    return node;
  };

  return nodes.filter(node => !attached.has(node.accountId)).map(finish);
}

// ---------------------------------------------------------------------------
// 3. Budget variances.
// ---------------------------------------------------------------------------

function emptyVariance(budgetId, notes) {
  return {
    budget: budgetId === null ? null : { budgetId },
    currencyCode: null,
    lines: [],
    totals: {
      lineCount: 0,
      approvedMinor: 0,
      revisedMinor: null,
      actualMinor: null,
      varianceMinor: null,
      formatted: {}
    },
    excludedLines: 0,
    notes
  };
}

function budgetVariance(db, request = {}) {
  requireDb(db);
  const notes = [];
  const budgetId = positiveId(request.budgetId, 'الموازنة');

  if (!tablePresent(db, 'budget_headers')) {
    pushNote(notes, 'جدول رؤوس الموازنات (budget_headers) غير موجود.');
    return emptyVariance(budgetId, notes);
  }

  const header = db.prepare('SELECT * FROM budget_headers WHERE budget_id = ? LIMIT 1').get(budgetId);
  if (!header) throw new Error('الموازنة المطلوبة غير موجودة.');

  const budget = {
    budgetId: Number(header.budget_id),
    budgetCode: header.budget_code ?? null,
    budgetName: header.budget_name ?? null,
    budgetStatus: header.budget_status ?? null,
    currencyCode: header.currency_code ? String(header.currency_code).toUpperCase() : null,
    geoUnitId: header.geo_unit_id === null || header.geo_unit_id === undefined ? null : Number(header.geo_unit_id),
    periodId: header.period_id === null || header.period_id === undefined ? null : Number(header.period_id),
    approvedAt: header.approved_at ?? null
  };

  if (!tablePresent(db, 'budget_lines')) {
    pushNote(notes, 'جدول بنود الموازنة (budget_lines) غير موجود.');
    return { ...emptyVariance(budgetId, notes), budget };
  }

  const columns = tableColumns(db, 'budget_lines');
  if (!columns.has('currency_code')) {
    pushNote(notes, 'جدول بنود الموازنة لا يحتوي عمود currency_code؛ تعذر عزل العملات.');
  }
  if (!columns.has('budget_id')) {
    pushNote(notes, 'جدول بنود الموازنة لا يحتوي عمود budget_id؛ تعذر ربط البنود بالموازنة.');
    return { ...emptyVariance(budgetId, notes), budget };
  }

  const present = columns.has('currency_code')
    ? db.prepare(`SELECT DISTINCT UPPER(TRIM(currency_code)) AS code FROM budget_lines
        WHERE budget_id = ? AND trim(COALESCE(currency_code,'')) <> ''`).all(budgetId).map(row => row.code)
    : [];

  let currencyCode = null;
  if (request.currencyCode !== null && request.currencyCode !== undefined && String(request.currencyCode).trim() !== '') {
    currencyCode = normaliseCurrency(request.currencyCode, 'العملة');
  } else if (present.length > 1) {
    throw new Error(`الموازنة تحتوي أكثر من عملة (${present.join('، ')}); حدد رمز العملة صراحةً قبل طلب الفروقات.`);
  } else if (present.length === 1) {
    currencyCode = present[0];
  } else if (budget.currencyCode) {
    currencyCode = budget.currencyCode;
  }

  const units = minorUnits(db);
  const unit = unitOf(units, currencyCode);

  const has = name => columns.has(name);
  const approvedMinor = has('approved_amount')
    ? minorSql(db, 'l', 'approved_amount', has('approved_amount_minor') ? 'approved_amount_minor' : null, has('currency_code'))
    : '0';
  const revisedMinor = has('revised_amount')
    ? minorSql(db, 'l', 'revised_amount', has('revised_amount_minor') ? 'revised_amount_minor' : null, has('currency_code'))
    : 'NULL';
  const actualMinor = has('actual_amount')
    ? minorSql(db, 'l', 'actual_amount', has('actual_amount_minor') ? 'actual_amount_minor' : null, has('currency_code'))
    : 'NULL';
  const revisedPresence = has('revised_amount_minor') || has('revised_amount')
    ? `CASE WHEN ${has('revised_amount_minor') ? 'l.revised_amount_minor IS NOT NULL' : '0'}
        OR ${has('revised_amount') ? 'l.revised_amount IS NOT NULL' : '0'} THEN 1 ELSE 0 END`
    : '0';

  const accountJoin = has('account_id')
    ? lookupJoin(db, {
      table: 'financial_accounts',
      alias: 'a',
      keyColumns: ['account_id'],
      labelColumns: ['account_name_ar', 'account_name'],
      fkExpression: 'l.account_id'
    })
    : NO_JOIN;
  const sectorJoin = has('sector_id')
    ? lookupJoin(db, {
      table: 'sectors',
      alias: 's',
      keyColumns: ['sector_id', 'id'],
      labelColumns: ['name_ar', 'name'],
      fkExpression: 'l.sector_id'
    })
    : NO_JOIN;

  const conditions = ['l.budget_id = ?'];
  const params = [budgetId];
  if (currencyCode && has('currency_code')) {
    conditions.push(`UPPER(TRIM(l.currency_code)) = ?`);
    params.push(currencyCode);
  }

  const accountIdSql = has('account_id') ? 'l.account_id' : 'NULL';
  const orderSql = has('account_id') && accountJoin.columns.has('account_code')
    ? 'coalesce(a.account_code, CAST(l.account_id AS TEXT)), l.budget_line_id'
    : `l.${quote('budget_line_id')}`;

  const rows = db.prepare(`SELECT
      l.budget_line_id AS line_id,
      ${accountIdSql} AS account_id,
      ${accountJoin.columns.has('account_code') ? 'a.account_code' : 'NULL'} AS account_code,
      ${accountJoin.label} AS account_name,
      ${sectorJoin.label} AS sector_label,
      CAST(${approvedMinor} AS INTEGER) AS approved_minor,
      CAST(${revisedMinor} AS INTEGER) AS revised_minor,
      CAST(${actualMinor} AS INTEGER) AS actual_minor,
      ${revisedPresence} AS has_revised,
      ${has('currency_code') ? "UPPER(TRIM(l.currency_code))" : 'NULL'} AS currency_code
    FROM budget_lines l
    ${accountJoin.join}
    ${sectorJoin.join}
    WHERE ${conditions.join(' AND ')}
    ORDER BY ${orderSql}`).all(...params);

  const excludedLines = currencyCode && has('currency_code')
    ? Number(db.prepare(`SELECT COUNT(*) AS total FROM budget_lines
        WHERE budget_id = ? AND UPPER(TRIM(currency_code)) <> ?`).get(budgetId, currencyCode).total ?? 0)
    : 0;
  if (excludedLines > 0) pushNote(notes, `استُثني ${excludedLines} بنداً بعملات أخرى من فروقات هذه العملة.`);
  if (present.length && currencyCode && !present.includes(currencyCode)) {
    pushNote(notes, `العملة ${currencyCode} غير مستخدمة في بنود هذه الموازنة.`);
  }
  if (!units.size) pushNote(notes, 'جدول العملات غير متاح؛ عُرضت القيم بمرحلتين عشريتين.');

  let approvedTotal = 0;
  let revisedTotal = null;
  let actualTotal = null;
  let varianceTotal = null;

  const lines = rows.map(row => {
    const approved = Number(row.approved_minor ?? 0);
    const revised = row.revised_minor === null || row.revised_minor === undefined ? null : Number(row.revised_minor);
    const actual = row.actual_minor === null || row.actual_minor === undefined ? null : Number(row.actual_minor);
    const hasRevised = Number(row.has_revised) === 1;
    const base = hasRevised ? revised : approved;
    const basis = actual === null
      ? 'missing-actual'
      : hasRevised ? 'revised' : 'approved';
    const variance = actual === null || base === null ? null : actual - base;
    const ratio = variance === null || base === 0 ? null : variance / base;

    approvedTotal += approved;
    if (revised !== null) revisedTotal = (revisedTotal ?? 0) + revised;
    if (actual !== null) actualTotal = (actualTotal ?? 0) + actual;
    if (variance !== null) varianceTotal = (varianceTotal ?? 0) + variance;

    return {
      lineId: Number(row.line_id),
      accountId: row.account_id === null || row.account_id === undefined ? null : Number(row.account_id),
      accountCode: row.account_code ?? null,
      accountName: row.account_name ?? null,
      sectorLabel: row.sector_label ?? null,
      currencyCode: row.currency_code ?? currencyCode,
      approvedMinor: approved,
      revisedMinor: revised,
      actualMinor: actual,
      varianceMinor: variance,
      varianceRatio: ratio,
      basis,
      exceeds: variance !== null && variance > 0
    };
  });

  const totals = {
    lineCount: lines.length,
    approvedMinor: approvedTotal,
    revisedMinor: revisedTotal,
    actualMinor: actualTotal,
    varianceMinor: varianceTotal
  };

  return {
    budget,
    currencyCode,
    lines,
    minorUnit: unit,
    totals: {
      ...totals,
      formatted: formattedTotals({
        approved: totals.approvedMinor,
        revised: totals.revisedMinor,
        actual: totals.actualMinor,
        variance: totals.varianceMinor
      }, unit)
    },
    excludedLines,
    notes
  };
}

// ---------------------------------------------------------------------------
// 4. Transaction ledger (revenue / expenditure).
// ---------------------------------------------------------------------------

const LEDGER_KINDS = Object.freeze({
  revenue: {
    table: 'revenue_transactions',
    pk: 'revenue_transaction_id',
    amount: 'collected_amount',
    dataset: 'revenueTransactions'
  },
  expenditure: {
    table: 'expenditure_transactions',
    pk: 'expenditure_transaction_id',
    amount: 'paid_amount',
    dataset: 'expenditureTransactions'
  }
});

function ledger(db, request = {}) {
  requireDb(db);
  const kind = String(request.kind ?? '').trim().toLowerCase();
  const definition = LEDGER_KINDS[kind];
  if (!definition) throw new Error('نوع الحركة يجب أن يكون revenue أو expenditure.');

  const notes = [];
  const limit = clampLimit(request.limit);
  const offset = clampOffset(request.offset);

  if (!tablePresent(db, definition.table)) {
    pushNote(notes, `الجدول ${definition.table} غير موجود.`);
    return { kind, rows: [], total: 0, limit, offset, notes };
  }

  const columns = tableColumns(db, definition.table);
  const units = minorUnits(db);
  const minorColumn = columns.has(`${definition.amount}_minor`) ? `${definition.amount}_minor` : null;

  const accountJoin = columns.has('account_id')
    ? lookupJoin(db, {
      table: 'financial_accounts',
      alias: 'a',
      keyColumns: ['account_id'],
      labelColumns: ['account_name_ar', 'account_name'],
      fkExpression: 't.account_id'
    })
    : NO_JOIN;
  const geoJoin = columns.has('geo_unit_id')
    ? lookupJoin(db, {
      table: 'geographic_units',
      alias: 'g',
      keyColumns: ['geo_unit_id', 'id'],
      labelColumns: ['name_ar', 'name'],
      fkExpression: 't.geo_unit_id'
    })
    : NO_JOIN;

  const conditions = [];
  const params = [];

  const geoUnitId = optionalId(request.geoUnitId, 'الوحدة الجغرافية');
  if (geoUnitId !== null && columns.has('geo_unit_id')) { conditions.push('t.geo_unit_id = ?'); params.push(geoUnitId); }
  const periodId = optionalId(request.periodId, 'الفترة');
  if (periodId !== null && columns.has('period_id')) { conditions.push('t.period_id = ?'); params.push(periodId); }
  if (request.currencyCode !== null && request.currencyCode !== undefined && String(request.currencyCode).trim() !== '') {
    if (columns.has('currency_code')) {
      conditions.push('UPPER(TRIM(t.currency_code)) = ?');
      params.push(normaliseCurrency(request.currencyCode));
    } else {
      pushNote(notes, `الجدول ${definition.table} لا يحتوي عمود currency_code؛ تعذر تصفية العملة.`);
    }
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const total = Number(db.prepare(`SELECT COUNT(*) AS total FROM ${quote(definition.table)} t ${where}`)
    .get(...params).total ?? 0);

  // Revenue is collected by an entity, expenditure is carried by a project.
  let entityJoin = NO_JOIN;
  let entityFk = 'NULL';
  if (kind === 'revenue' && columns.has('collecting_entity_id')) {
    entityJoin = lookupJoin(db, {
      table: 'entities',
      alias: 'e',
      keyColumns: ['entity_id'],
      labelColumns: ['name_ar', 'name_en'],
      fkExpression: 't.collecting_entity_id'
    });
    entityFk = 't.collecting_entity_id';
  } else if (kind === 'expenditure' && columns.has('project_id')) {
    entityJoin = lookupJoin(db, {
      table: 'projects',
      alias: 'p',
      keyColumns: ['project_id', 'id'],
      labelColumns: ['project_name', 'name'],
      fkExpression: 't.project_id'
    });
    entityFk = 't.project_id';
  }

  const orderBy = columns.has('transaction_date')
    ? `ORDER BY t.transaction_date DESC, t.${quote(definition.pk)} DESC`
    : `ORDER BY t.${quote(definition.pk)} DESC`;

  const rows = db.prepare(`SELECT
      t.${quote(definition.pk)} AS transaction_id,
      ${columns.has('currency_code') ? "UPPER(TRIM(t.currency_code))" : 'NULL'} AS currency_code,
      ${columns.has(definition.amount) ? `t.${quote(definition.amount)}` : 'NULL'} AS amount_value,
      ${minorColumn ? `t.${quote(minorColumn)}` : 'NULL'} AS amount_minor,
      ${columns.has('transaction_date') ? 't.transaction_date' : 'NULL'} AS transaction_date,
      ${columns.has('account_id') ? 't.account_id' : 'NULL'} AS account_id,
      ${accountJoin.columns.has('account_code') ? 'a.account_code' : 'NULL'} AS account_code,
      ${accountJoin.label} AS account_label,
      ${columns.has('geo_unit_id') ? 't.geo_unit_id' : 'NULL'} AS geo_unit_id,
      ${geoJoin.label} AS geo_label,
      ${entityFk} AS entity_id,
      ${entityJoin.label} AS entity_label,
      ${columns.has('source_id') ? 't.source_id' : 'NULL'} AS source_id
    FROM ${quote(definition.table)} t
    ${accountJoin.join}
    ${geoJoin.join}
    ${entityJoin.join}
    ${where}
    ${orderBy}
    LIMIT ? OFFSET ?`).all(...params, limit, offset);

  if (!units.size) pushNote(notes, 'جدول العملات غير متاح؛ استُخدمت مرحلتان عشريتان لحساب القيم الدقيقة.');
  if (minorColumn === null && rows.some(row => row.amount_value !== null)) {
    pushNote(notes, `العمود ${definition.amount}_minor غير موجود؛ حُسبت القيم الدقيقة من العمود العشري.`);
  }

  const mapped = rows.map(row => {
    const currencyCode = row.currency_code ?? null;
    const unit = unitOf(units, currencyCode);
    const money = moneyOf(row, 'amount_value', 'amount_minor', unit);
    return {
      transactionId: Number(row.transaction_id),
      kind,
      currencyCode,
      minorUnit: unit,
      amountMinor: money.minor,
      amount: money.minor === null ? null : formatMinor(money.minor, unit),
      derivedMinor: money.derived,
      date: row.transaction_date ?? null,
      accountId: row.account_id === null || row.account_id === undefined ? null : Number(row.account_id),
      accountCode: row.account_code ?? null,
      accountLabel: row.account_label ?? null,
      geoUnitId: row.geo_unit_id === null || row.geo_unit_id === undefined ? null : Number(row.geo_unit_id),
      geoLabel: row.geo_label ?? null,
      entityId: row.entity_id === null || row.entity_id === undefined ? null : Number(row.entity_id),
      entityLabel: row.entity_label ?? null,
      entityRole: kind === 'revenue' ? 'collecting' : 'project',
      sourceId: row.source_id === null || row.source_id === undefined ? null : Number(row.source_id)
    };
  });

  return { kind, rows: mapped, total, limit, offset, notes };
}

// ---------------------------------------------------------------------------
// 5. Writes: revenue and expenditure.
// ---------------------------------------------------------------------------

function pickValues(payload, fields, aliases, labelAr) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(`بيانات ${labelAr} غير صالحة.`);
  }
  const values = {};
  for (const [rawKey, rawValue] of Object.entries(payload)) {
    const name = Object.hasOwn(aliases, rawKey) ? aliases[rawKey] : rawKey;
    if (!fields.includes(name)) throw new Error(`حقل غير معروف في ${labelAr}: ${rawKey}`);
    values[name] = rawValue;
  }
  return values;
}

function recordTransaction(db, request, options) {
  requireDb(db);
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new Error(`بيانات ${options.labelAr} غير صالحة.`);
  }
  const { actor = null, reason = null, sessionId = null, ...payload } = request;
  const values = pickValues(payload, options.fields, options.aliases, options.labelAr);

  const currency = String(values.currency_code ?? '').trim();
  if (!currency) throw new Error(`رمز العملة مطلوب لتسجيل ${options.labelAr}.`);
  values.currency_code = normaliseCurrency(currency, 'العملة');

  const saved = domain.save(db, {
    dataset: options.dataset,
    values,
    actor: actor === null ? null : String(actor),
    reason: reason === null ? null : String(reason),
    sessionId: sessionId === null ? null : String(sessionId)
  });

  const record = domain.read(db, options.dataset, saved.id);
  const row = record?.row ?? null;
  const units = minorUnits(db);
  const unit = unitOf(units, values.currency_code);
  const minorColumn = row && Object.hasOwn(row, `${options.amount}_minor`) ? `${options.amount}_minor` : null;
  const money = row ? moneyOf(row, options.amount, minorColumn, unit) : { minor: null, derived: false };

  return {
    id: saved.id,
    created: saved.created,
    dataset: options.dataset,
    currencyCode: values.currency_code,
    amountMinor: money.minor,
    amount: money.minor === null ? null : formatMinor(money.minor, unit),
    minorMirror: minorColumn,
    derivedMinor: money.derived,
    changedFields: saved.changedFields
  };
}

function recordRevenue(db, payload) {
  return recordTransaction(db, payload, {
    dataset: 'revenueTransactions',
    labelAr: 'حركة الإيراد',
    fields: REVENUE_FIELDS,
    aliases: REVENUE_ALIASES,
    amount: 'collected_amount'
  });
}

function recordExpenditure(db, payload) {
  return recordTransaction(db, payload, {
    dataset: 'expenditureTransactions',
    labelAr: 'حركة الإنفاق',
    fields: EXPENDITURE_FIELDS,
    aliases: EXPENDITURE_ALIASES,
    amount: 'paid_amount'
  });
}

// ---------------------------------------------------------------------------
// 6. Per-currency summary.
// ---------------------------------------------------------------------------

function currencySummary(db, request = {}) {
  requireDb(db);
  const notes = [];
  const periodId = optionalId(request.periodId, 'الفترة');
  if (periodId !== null && !tablePresent(db, 'periods')) {
    pushNote(notes, 'جدول الفترات غير موجود؛ طُبّق المرشح على معرّف الفترة كما هو.');
  }
  const units = minorUnits(db);
  const buckets = new Map();

  const bucket = code => {
    const key = code && String(code).trim() ? String(code).trim().toUpperCase() : 'UNSPECIFIED';
    if (!buckets.has(key)) {
      buckets.set(key, {
        currencyCode: key,
        minorUnit: unitOf(units, key),
        revenueMinor: 0,
        revenueCount: 0,
        expenditureMinor: 0,
        expenditureCount: 0
      });
    }
    return buckets.get(key);
  };

  const aggregate = (table, base, countKey, amountKey) => {
    if (!tablePresent(db, table)) {
      pushNote(notes, `الجدول ${table} غير موجود؛ استُثني من الملخص.`);
      return;
    }
    const columns = tableColumns(db, table);
    if (!columns.has('currency_code') || !columns.has(base)) {
      pushNote(notes, `الجدول ${table} لا يحتوي العملة أو عمود المبلغ؛ استُثني من الملخص.`);
      return;
    }
    const mirror = columns.has(`${base}_minor`) ? `${base}_minor` : null;
    const conditions = [];
    const params = [];
    if (periodId !== null && columns.has('period_id')) { conditions.push('t.period_id = ?'); params.push(periodId); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = db.prepare(`SELECT
        UPPER(TRIM(COALESCE(t.currency_code,''))) AS code,
        CAST(COALESCE(SUM(${minorSql(db, 't', base, mirror, true)}),0) AS INTEGER) AS total_minor,
        COUNT(*) AS row_count
      FROM ${quote(table)} t ${where} GROUP BY code`).all(...params);
    for (const row of rows) {
      const target = bucket(row.code);
      target[amountKey] = Number(row.total_minor ?? 0);
      target[countKey] = Number(row.row_count ?? 0);
    }
  };

  aggregate('revenue_transactions', 'collected_amount', 'revenueCount', 'revenueMinor');
  aggregate('expenditure_transactions', 'paid_amount', 'expenditureCount', 'expenditureMinor');

  const currencies = [...buckets.values()]
    .map(item => {
      const balanceMinor = item.revenueMinor - item.expenditureMinor;
      return {
        ...item,
        balanceMinor,
        formatted: formattedTotals({
          revenue: item.revenueMinor,
          expenditure: item.expenditureMinor,
          balance: balanceMinor
        }, item.minorUnit)
      };
    })
    .sort((left, right) => left.currencyCode.localeCompare(right.currencyCode));

  if (currencies.length > 1) {
    pushNote(notes, 'الملخص يعرض كل عملة على حدة؛ لا يوجد جمع بين العملات.');
  }

  return { periodId, currencies, mixedCurrency: currencies.length > 1, notes };
}

// ---------------------------------------------------------------------------
// 7. Commitment control.
// ---------------------------------------------------------------------------

function commitmentControl(db, request = {}) {
  requireDb(db);
  const notes = [];
  let budgetId = null;
  try {
    budgetId = positiveId(request.budgetId, 'الموازنة');
  } catch (error) {
    // Never throws on missing data: an unknown budget is reported, not raised.
    return {
      budgetId: null,
      currencyCode: null,
      lines: [],
      minorUnit: null,
      totals: { lineCount: 0, approvedMinor: 0, actualMinor: null, remainingMinor: null, exceededCount: 0 },
      notes: [error.message]
    };
  }

  if (!tablePresent(db, 'budget_lines')) {
    return {
      budgetId,
      currencyCode: null,
      lines: [],
      minorUnit: null,
      totals: { lineCount: 0, approvedMinor: 0, actualMinor: null, remainingMinor: null, exceededCount: 0 },
      notes: ['جدول بنود الموازنة (budget_lines) غير موجود.']
    };
  }

  const header = tablePresent(db, 'budget_headers')
    ? db.prepare('SELECT * FROM budget_headers WHERE budget_id = ? LIMIT 1').get(budgetId)
    : null;
  if (tablePresent(db, 'budget_headers') && !header) {
    pushNote(notes, 'الموازنة المطلوبة غير موجودة؛ لا توجد بنود للمتابعة.');
  }

  const columns = tableColumns(db, 'budget_lines');
  const units = minorUnits(db);
  const unit = unitOf(units, header?.currency_code ? String(header.currency_code).toUpperCase() : null);

  if (!columns.has('budget_id')) {
    return {
      budgetId,
      currencyCode: null,
      lines: [],
      minorUnit: null,
      totals: { lineCount: 0, approvedMinor: 0, actualMinor: null, remainingMinor: null, exceededCount: 0 },
      notes: ['جدول بنود الموازنة لا يحتوي عمود budget_id؛ تعذر ربط البنود بالموازنة.']
    };
  }

  const fkAccount = columns.has('account_id');
  const accountJoin = fkAccount
    ? lookupJoin(db, {
      table: 'financial_accounts',
      alias: 'a',
      keyColumns: ['account_id'],
      labelColumns: ['account_name_ar', 'account_name'],
      fkExpression: 'l.account_id'
    })
    : NO_JOIN;
  const orderSql = fkAccount && accountJoin.columns.has('account_code')
    ? 'coalesce(a.account_code, CAST(l.account_id AS TEXT)), l.budget_line_id'
    : `l.${quote('budget_line_id')}`;

  const rows = db.prepare(`SELECT
      l.budget_line_id AS line_id,
      ${columns.has('account_id') ? 'l.account_id' : 'NULL'} AS account_id,
      ${accountJoin.columns.has('account_code') ? 'a.account_code' : 'NULL'} AS account_code,
      ${accountJoin.label} AS account_name,
      ${columns.has('currency_code') ? "UPPER(TRIM(l.currency_code))" : 'NULL'} AS currency_code,
      ${columns.has('approved_amount') ? `CAST(${minorSql(db, 'l', 'approved_amount', columns.has('approved_amount_minor') ? 'approved_amount_minor' : null, columns.has('currency_code'))} AS INTEGER)` : '0'} AS approved_minor,
      ${columns.has('actual_amount') ? `CAST(${minorSql(db, 'l', 'actual_amount', columns.has('actual_amount_minor') ? 'actual_amount_minor' : null, columns.has('currency_code'))} AS INTEGER)` : 'NULL'} AS actual_minor
    FROM budget_lines l
    ${accountJoin.join}
    WHERE l.budget_id = ?
    ORDER BY ${orderSql}`).all(budgetId);

  let approvedTotal = 0;
  let actualTotal = null;
  let remainingTotal = null;
  let exceededCount = 0;

  const lines = rows.map(row => {
    const approved = Number(row.approved_minor ?? 0);
    const actual = row.actual_minor === null || row.actual_minor === undefined ? null : Number(row.actual_minor);
    const remaining = actual === null ? null : approved - actual;
    const exceeded = actual !== null && actual > approved;

    approvedTotal += approved;
    if (actual !== null) actualTotal = (actualTotal ?? 0) + actual;
    if (remaining !== null) remainingTotal = (remainingTotal ?? 0) + remaining;
    if (exceeded) exceededCount += 1;

    return {
      lineId: Number(row.line_id),
      accountId: row.account_id === null || row.account_id === undefined ? null : Number(row.account_id),
      accountCode: row.account_code ?? null,
      accountName: row.account_name ?? null,
      currencyCode: row.currency_code ?? (header?.currency_code ? String(header.currency_code).toUpperCase() : null),
      approvedMinor: approved,
      actualMinor: actual,
      remainingMinor: remaining,
      actualKnown: actual !== null,
      exceeded
    };
  });

  if (lines.some(line => !line.actualKnown)) pushNote(notes, 'بعض البنود بلا مبلغ فعلي مسجل؛ لم تُعد متجاوزة.');
  if (!units.size) pushNote(notes, 'جدول العملات غير متاح؛ عُرضت القيم بمرحلتين عشريتين.');

  const totals = {
    lineCount: lines.length,
    approvedMinor: approvedTotal,
    actualMinor: actualTotal,
    remainingMinor: remainingTotal,
    exceededCount
  };

  return {
    budgetId,
    currencyCode: header?.currency_code ? String(header.currency_code).toUpperCase() : null,
    lines,
    minorUnit: unit,
    totals,
    notes
  };
}

module.exports = {
  overview,
  accountsTree,
  budgetVariance,
  ledger,
  recordRevenue,
  recordExpenditure,
  currencySummary,
  commitmentControl
};
