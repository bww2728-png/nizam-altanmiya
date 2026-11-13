'use strict';

// ---------------------------------------------------------------------------
// Single central data-access layer for the unified development data model.
//
// Every application module reads and writes through this module instead of
// talking to the ~40 domain tables directly. Identifiers interpolated into SQL
// always come from domain-registry.cjs or from PRAGMA table_info, never from
// raw user input, and values are always bound parameters.
//
// Pure server-side module: no Electron, no fs, no new dependencies.
// ---------------------------------------------------------------------------

const { DATASETS, LAYERS, LAYER_LABELS, lookupRefs, getDataset } = require('./domain-registry.cjs');

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DECIMAL_TEXT = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const INTEGER_TEXT = /^[+-]?\d+$/;
const DATE_TEXT = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?$/;
const REF_KINDS = new Set(['reference', 'dimension', 'entity', 'geo', 'period', 'sector', 'unit', 'account']);

const EMPTY_VALUE_STATES = new Set(['not_available', 'unknown', 'not_applicable', 'not_collected', 'not_verified']);
const KNOWN_VALUE_STATES = new Set(['known', 'zero']);

const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 50;
const OPTION_DEFAULT_LIMIT = 200;
const MAX_OPTION_LIMIT = 500;
const MAX_LABEL_IDS = 500;
const AUDIT_JSON_LIMIT = 4000;
const AUDIT_DETAILS_LIMIT = 500;

class DomainValidationError extends Error {
  constructor(errors) {
    super(errors.map(error => error.message).join('\n'));
    this.name = 'DomainValidationError';
    this.errors = errors;
  }
}

// ---------------------------------------------------------------------------
// Schema introspection helpers.
// ---------------------------------------------------------------------------

function requireDb(db) {
  if (!db || typeof db.prepare !== 'function') throw new Error('اتصال قاعدة البيانات غير صالح.');
  return db;
}

function quoteIdentifier(name) {
  const text = String(name ?? '');
  if (!IDENTIFIER.test(text)) throw new Error(`معرّف SQL غير صالح: ${text}`);
  return `"${text}"`;
}

function tableInfo(db, table) {
  if (!IDENTIFIER.test(String(table ?? ''))) throw new Error(`اسم جدول غير صالح: ${table}`);
  return db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all();
}

function datasetContext(db, dataset) {
  const info = tableInfo(db, dataset.table);
  return { info, real: new Map(info.map(column => [column.name, column])) };
}

function declaredType(declaration) {
  return String(declaration ?? '').toUpperCase();
}

// Inferred metadata for a column the registry does not describe. The UI must
// never see a hidden column, so an unregistered column still becomes a field.
function inferType(column) {
  const declaration = declaredType(column.type);
  const name = String(column.name ?? '');
  if (name.endsWith('_minor')) return 'integer';
  if (/BOOLEAN/.test(declaration)) return 'boolean';
  if (/INT/.test(declaration)) return /^(is_|has_|allow_)/i.test(name) ? 'boolean' : 'integer';
  if (/(REAL|FLOA|DOUB|NUMERIC|DEC)/.test(declaration)) return 'decimal';
  if (/json$/i.test(name) || /(description|notes|summary|measure|rationale|methodology)$/i.test(name)) return 'long_text';
  if (/DATE|TIME/.test(declaration) || /(_at|_date|date_)$/i.test(name)) return 'datetime';
  return 'text';
}

function buildFields(dataset, info) {
  const declared = new Map(dataset.fields.map(item => [item.name, item]));
  return info.map(column => {
    const meta = declared.get(column.name);
    if (meta) return { ...meta, present: true };
    return {
      name: column.name,
      labelAr: column.name,
      type: inferType(column),
      present: true,
      inferred: true
    };
  });
}

function clampLimit(value, fallback, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  const integer = Math.trunc(number);
  if (integer < 1) return fallback;
  return Math.min(max, integer);
}

function clampOffset(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return 0;
  return Math.min(1000000, Math.trunc(number));
}

// ---------------------------------------------------------------------------
// Reference resolution.
// ---------------------------------------------------------------------------

function resolveRefValueColumn(ref, names) {
  const candidates = [ref.valueColumn, ...(ref.fallbackValueColumns ?? [])];
  return candidates.find(candidate => names.has(candidate)) ?? null;
}

// Builds `coalesce(label_a, label_b, CAST(pk AS TEXT))` from the columns that
// actually exist, so a missing label column can never break a lookup.
function labelExpression(ref, names, alias) {
  const parts = (ref.labelColumns ?? [])
    .filter(column => names.has(column))
    .map(column => `${alias}.${quoteIdentifier(column)}`);
  parts.push(`CAST(${alias}.${quoteIdentifier(ref.valueColumn)} AS TEXT)`);
  return `coalesce(${parts.join(',')})`;
}

function detailExpression(ref, names, alias) {
  const column = (ref.detailColumns ?? []).find(candidate => names.has(candidate));
  if (!column) return null;
  return `${alias}.${quoteIdentifier(column)}`;
}

// Returns null when the reference table does not exist in this database.
function referenceTableInfo(db, ref) {
  const info = tableInfo(db, ref.table);
  if (!info.length) return null;
  const names = new Set(info.map(column => column.name));
  const valueColumn = resolveRefValueColumn(ref, names);
  if (!valueColumn) return null;
  return { info, names, valueColumn };
}

function minorUnitOf(db, code) {
  if (!code) return 2;
  const target = referenceTableInfo(db, lookupRefs.currency);
  if (!target) return 2;
  const column = lookupRefs.currency.minorUnitColumn ?? 'minor_unit';
  if (!target.names.has(column)) return 2;
  const row = db.prepare(`SELECT ${quoteIdentifier(column)} AS unit FROM ${quoteIdentifier(lookupRefs.currency.table)}
    WHERE upper(trim(${quoteIdentifier(target.valueColumn)})) = upper(trim(?)) LIMIT 1`).get(String(code));
  const unit = Number(row?.unit);
  return Number.isInteger(unit) && unit >= 0 && unit <= 4 ? unit : 2;
}

// ---------------------------------------------------------------------------
// Shared introspection helpers for the public operations.
// ---------------------------------------------------------------------------

// Service-managed columns are never taken from the caller.
const MANAGED_COLUMNS = new Set(['created_at', 'updated_at']);
const VALUE_COLUMN_TYPES = new Set(['integer', 'decimal', 'boolean', 'date', 'datetime']);
const REFERENCE_FIELD_TYPES = new Set([...REF_KINDS, 'currency']);

function tablePresent(db, table) {
  if (!IDENTIFIER.test(String(table ?? ''))) return false;
  return Boolean(db.prepare("SELECT 1 AS hit FROM sqlite_master WHERE type IN ('table','view') AND name=?").get(String(table)));
}

function rowCount(db, table) {
  return Number(db.prepare(`SELECT COUNT(*) AS total FROM ${quoteIdentifier(table)}`).get().total ?? 0);
}

// Label expression built from the value column that actually exists.
function resolvedLabelSql(ref, names, alias, valueColumn) {
  const parts = (ref.labelColumns ?? [])
    .filter(column => names.has(column))
    .map(column => `${alias}.${quoteIdentifier(column)}`);
  parts.push(`CAST(${alias}.${quoteIdentifier(valueColumn)} AS TEXT)`);
  return `coalesce(${parts.join(',')})`;
}

function escapeLike(term) {
  return String(term ?? '').replace(/[\\%_]/g, character => `\\${character}`);
}

function fieldLabel(field) {
  return field.labelAr ?? field.name;
}

// Known physical columns that the registry does not declare still get an Arabic
// label so the UI never falls back to a raw English identifier.
const INFERRED_LABELS = Object.freeze({
  created_at: 'تاريخ الإنشاء',
  updated_at: 'تاريخ التحديث',
  value_state: 'حالة القيمة',
  source_id: 'المصدر',
  notes: 'ملاحظات'
});

function inferredLabel(name) {
  if (INFERRED_LABELS[name]) return INFERRED_LABELS[name];
  if (name.endsWith('_minor')) return `${name} (وحدات العملة الدقيقة)`;
  return name;
}

function declaredFields(dataset) {
  return new Map(dataset.fields.map(field => [field.name, field]));
}

// Registry metadata merged with the physical columns; unknown real columns are
// still exposed so the UI can never hide data.
function datasetFields(dataset, real) {
  const declared = declaredFields(dataset);
  const fields = [];
  for (const column of real.values()) {
    const meta = declared.get(column.name);
    const base = meta ?? {
      name: column.name,
      labelAr: inferredLabel(column.name),
      type: inferType(column),
      inferred: true
    };
    const isAutoKey = dataset.autoPk && column.name === dataset.primaryKey[0];
    fields.push({
      ...base,
      physicalType: column.type,
      present: true,
      nullable: column.notnull === 0 && column.pk === 0,
      readOnly: Boolean(base.readOnly || isAutoKey || MANAGED_COLUMNS.has(column.name) || base.inferred)
    });
  }
  return fields;
}

function missingColumns(dataset, real) {
  return dataset.fields.filter(field => !real.has(field.name)).map(field => field.name);
}

// Columns that carry a measured value and must be NULL for empty value states.
function valueColumns(dataset, real) {
  const declared = declaredFields(dataset);
  const names = [];
  for (const column of real.values()) {
    const name = column.name;
    if (MANAGED_COLUMNS.has(name) || name === 'value_state' || name.endsWith('_minor')) continue;
    if (/_id$/.test(name)) continue;
    const meta = declared.get(name);
    const type = meta?.type ?? inferType(column);
    if (VALUE_COLUMN_TYPES.has(type)) names.push(name);
  }
  return names;
}

// ---------------------------------------------------------------------------
// 1. Dataset catalogue.
// ---------------------------------------------------------------------------

function listDatasets(db) {
  requireDb(db);
  return Object.values(DATASETS).map(dataset => {
    const available = tablePresent(db, dataset.table);
    return {
      key: dataset.key,
      labelAr: dataset.labelAr,
      layer: dataset.layer,
      layerLabelAr: LAYER_LABELS[dataset.layer] ?? dataset.layer,
      description: dataset.description,
      count: available ? rowCount(db, dataset.table) : 0,
      available
    };
  });
}

// ---------------------------------------------------------------------------
// 2. Dataset description (registry + physical columns).
// ---------------------------------------------------------------------------

function describe(db, datasetKey) {
  requireDb(db);
  const dataset = getDataset(datasetKey);
  const { real } = datasetContext(db, dataset);
  return {
    key: dataset.key,
    labelAr: dataset.labelAr,
    layer: dataset.layer,
    table: dataset.table,
    pk: dataset.pk,
    primaryKey: [...dataset.primaryKey],
    autoPk: dataset.autoPk,
    fields: datasetFields(dataset, real),
    missingColumns: missingColumns(dataset, real)
  };
}

// ---------------------------------------------------------------------------
// 3. Lookup options.
// ---------------------------------------------------------------------------

function options(db, kind, request = {}) {
  requireDb(db);
  const name = String(kind ?? '').trim();
  const ref = lookupRefs[name];
  if (!ref) throw new Error(`نوع المرجع غير معروف: ${name || '(فارغ)'}`);
  const target = referenceTableInfo(db, ref);
  if (!target) return [];
  const limit = clampLimit(request.limit, OPTION_DEFAULT_LIMIT, MAX_OPTION_LIMIT);
  const search = String(request.search ?? '').trim().slice(0, 120);
  const filter = request.filter && typeof request.filter === 'object' && !Array.isArray(request.filter) ? request.filter : {};

  const alias = 'o';
  const labelSql = resolvedLabelSql(ref, target.names, alias, target.valueColumn);
  const detailSql = detailExpression(ref, target.names, alias);
  const conditions = [];
  const params = [];

  if (search) {
    const pattern = `%${escapeLike(search)}%`;
    const labelParts = (ref.labelColumns ?? []).filter(column => target.names.has(column));
    const searchable = [...labelParts.map(column => `${alias}.${quoteIdentifier(column)}`)];
    searchable.push(`CAST(${alias}.${quoteIdentifier(target.valueColumn)} AS TEXT)`);
    conditions.push(`(${searchable.map(part => `${part} LIKE ? ESCAPE '\\'`).join(' OR ')})`);
    for (let index = 0; index < searchable.length; index += 1) params.push(pattern);
  }

  const dimensionCode = filter.dimensionCode ?? ref.filter?.dimensionCode ?? null;
  let join = '';
  if (dimensionCode && ref.dimensionTable && ref.dimensionIdColumn && ref.dimensionCodeColumn) {
    if (tablePresent(db, ref.dimensionTable)) {
      const dimensionInfo = tableInfo(db, ref.dimensionTable);
      const dimensionNames = new Set(dimensionInfo.map(column => column.name));
      if (dimensionNames.has(ref.dimensionIdColumn) && dimensionNames.has(ref.dimensionCodeColumn)
        && target.names.has(ref.dimensionIdColumn)) {
        join = `JOIN ${quoteIdentifier(ref.dimensionTable)} dim ON dim.${quoteIdentifier(ref.dimensionIdColumn)} = ${alias}.${quoteIdentifier(ref.dimensionIdColumn)}`;
        conditions.push(`dim.${quoteIdentifier(ref.dimensionCodeColumn)} = ?`);
        params.push(String(dimensionCode));
      }
    }
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const selectParts = [
    `${alias}.${quoteIdentifier(target.valueColumn)} AS value`,
    `${labelSql} AS label`
  ];
  if (detailSql) selectParts.push(`${detailSql} AS subtitle`);

  const rows = db.prepare(`SELECT ${selectParts.join(',')}
    FROM ${quoteIdentifier(ref.table)} ${alias} ${join} ${where}
    ORDER BY label COLLATE NOCASE LIMIT ?`).all(...params, limit);

  return rows.map(row => ({
    value: row.value,
    label: row.label ?? String(row.value ?? ''),
    subtitle: row.subtitle ?? null
  }));
}

// ---------------------------------------------------------------------------
// 4. Filtered, sorted listing with reference labels.
// ---------------------------------------------------------------------------

const FILTER_OPERATORS = new Set(['eq', 'contains', 'gte', 'lte', 'in', 'empty', 'notempty']);

function normalizeFilters(filters) {
  const items = [];
  if (!filters) return items;
  if (Array.isArray(filters)) {
    for (const entry of filters) {
      if (!entry || typeof entry !== 'object' || !entry.field) continue;
      items.push({ field: String(entry.field), op: String(entry.op ?? 'eq'), value: entry.value });
    }
    return items;
  }
  if (typeof filters !== 'object') return items;
  for (const [field, value] of Object.entries(filters)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && typeof value.op === 'string') {
      items.push({ field, op: value.op, value: value.value });
    } else {
      items.push({ field, op: 'eq', value });
    }
  }
  return items;
}

function buildFilterSql(filters, real, alias) {
  const conditions = [];
  const params = [];
  for (const filter of filters) {
    if (!real.has(filter.field)) continue; // unknown filter fields are ignored
    const column = `${alias}.${quoteIdentifier(filter.field)}`;
    const op = FILTER_OPERATORS.has(filter.op) ? filter.op : 'eq';
    if (op === 'empty') {
      conditions.push(`(${column} IS NULL OR trim(CAST(${column} AS TEXT)) = '')`);
      continue;
    }
    if (op === 'notempty') {
      conditions.push(`(${column} IS NOT NULL AND trim(CAST(${column} AS TEXT)) <> '')`);
      continue;
    }
    if (op === 'in') {
      const values = Array.isArray(filter.value) ? filter.value.slice(0, 200) : [];
      if (!values.length) { conditions.push('1 = 0'); continue; }
      conditions.push(`${column} IN (${values.map(() => '?').join(',')})`);
      params.push(...values);
      continue;
    }
    if (op === 'contains') {
      if (filter.value === null || filter.value === undefined) continue;
      conditions.push(`CAST(${column} AS TEXT) LIKE ? ESCAPE '\\'`);
      params.push(`%${escapeLike(filter.value)}%`);
      continue;
    }
    if (filter.value === null || filter.value === undefined) {
      conditions.push(`${column} IS NULL`);
      continue;
    }
    conditions.push(`${column} ${op === 'gte' ? '>=' : op === 'lte' ? '<=' : '='} ?`);
    params.push(filter.value);
  }
  return { conditions, params };
}

function normalizeSort(dataset, real, sort) {
  const fallback = { field: dataset.primaryKey[0], direction: 'DESC' };
  if (!sort) return fallback;
  let field = '';
  let direction = '';
  if (typeof sort === 'string') {
    const text = sort.trim();
    const match = /^(-?)([A-Za-z_][A-Za-z0-9_]*)(?::(asc|desc))?$/i.exec(text);
    if (!match) return fallback;
    if (match[1] === '-') direction = 'DESC';
    field = match[2];
    if (match[3]) direction = match[3].toUpperCase();
  } else if (typeof sort === 'object' && sort.field) {
    field = String(sort.field);
    direction = String(sort.direction ?? sort.dir ?? '').toLowerCase() === 'desc' ? 'DESC' : 'ASC';
  }
  if (!field || !real.has(field)) return fallback;
  return { field, direction: direction === 'ASC' ? 'ASC' : 'DESC' };
}

// One query per declared reference field; at most MAX_LABEL_IDS ids per field.
function buildLabels(db, dataset, rows) {
  const labels = {};
  if (!rows.length) return labels;
  for (const field of dataset.fields) {
    if (!REFERENCE_FIELD_TYPES.has(field.type) || !field.ref) continue;
    if (!Object.hasOwn(rows[0], field.name)) continue;
    const ids = [...new Set(rows.map(row => row[field.name]).filter(value => value !== null && value !== undefined))].slice(0, MAX_LABEL_IDS);
    if (!ids.length) { labels[field.name] = {}; continue; }
    const target = referenceTableInfo(db, field.ref);
    if (!target) { labels[field.name] = {}; continue; }
    const placeholders = ids.map(() => '?').join(',');
    const sql = `SELECT ${quoteIdentifier(target.valueColumn)} AS id, ${resolvedLabelSql(field.ref, target.names, 'l', target.valueColumn)} AS label
      FROM ${quoteIdentifier(field.ref.table)} l WHERE ${quoteIdentifier(target.valueColumn)} IN (${placeholders})`;
    const map = {};
    for (const row of db.prepare(sql).all(...ids)) map[String(row.id)] = row.label ?? String(row.id);
    labels[field.name] = map;
  }
  return labels;
}

function list(db, request = {}) {
  requireDb(db);
  const dataset = getDataset(request.dataset);
  if (!tablePresent(db, dataset.table)) {
    return { rows: [], total: 0, fields: [], labels: {} };
  }
  const { real } = datasetContext(db, dataset);
  const limit = clampLimit(request.limit, DEFAULT_LIMIT, MAX_LIMIT);
  const offset = clampOffset(request.offset);
  const filterState = buildFilterSql(normalizeFilters(request.filters), real, 'r');
  const conditions = [...filterState.conditions];
  const params = [...filterState.params];

  const search = String(request.search ?? '').trim().slice(0, 120);
  if (search) {
    const pattern = `%${escapeLike(search)}%`;
    const searchable = dataset.fields
      .filter(field => (field.type === 'text' || field.type === 'long_text') && real.has(field.name))
      .slice(0, 6)
      .map(field => `CAST(r.${quoteIdentifier(field.name)} AS TEXT) LIKE ? ESCAPE '\\'`);
    if (searchable.length) {
      conditions.push(`(${searchable.join(' OR ')})`);
      for (let index = 0; index < searchable.length; index += 1) params.push(pattern);
    }
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const sort = normalizeSort(dataset, real, request.sort);
  const orderBy = `ORDER BY r.${quoteIdentifier(sort.field)} ${sort.direction}`;
  const secondary = sort.field === dataset.primaryKey[0] ? '' : `, r.${quoteIdentifier(dataset.primaryKey[0])} DESC`;
  const total = Number(db.prepare(`SELECT COUNT(*) AS total FROM ${quoteIdentifier(dataset.table)} r ${where}`).get(...params).total ?? 0);
  const rows = db.prepare(`SELECT r.* FROM ${quoteIdentifier(dataset.table)} r ${where} ${orderBy}${secondary} LIMIT ? OFFSET ?`)
    .all(...params, limit, offset);
  return { rows, total, fields: datasetFields(dataset, real), labels: buildLabels(db, dataset, rows) };
}

// ---------------------------------------------------------------------------
// 5. Single row read.
// ---------------------------------------------------------------------------

function read(db, datasetKey, id) {
  requireDb(db);
  const dataset = getDataset(datasetKey);
  if (!tablePresent(db, dataset.table)) return null;
  const candidate = typeof id === 'number' ? id : Number(String(id ?? '').trim());
  if (!Number.isSafeInteger(candidate) || candidate <= 0) throw new Error('معرّف السجل غير صالح.');
  const row = db.prepare(`SELECT * FROM ${quoteIdentifier(dataset.table)} WHERE ${quoteIdentifier(dataset.primaryKey[0])} = ? LIMIT 1`).get(candidate);
  if (!row) return null;
  return { row, labels: buildLabels(db, dataset, [row]) };
}

// ---------------------------------------------------------------------------
// Value coercion.
// ---------------------------------------------------------------------------

function coerceInteger(value, label) {
  if (typeof value === 'boolean') throw new Error(`الحقل «${label}» يقبل عدداً صحيحاً فقط.`);
  let number;
  if (typeof value === 'number') {
    number = value;
  } else {
    const text = String(value).trim();
    if (!INTEGER_TEXT.test(text)) throw new Error(`الحقل «${label}» يقبل عدداً صحيحاً فقط.`);
    number = Number(text);
  }
  if (!Number.isFinite(number) || !Number.isInteger(number)) throw new Error(`الحقل «${label}» يقبل عدداً صحيحاً فقط.`);
  if (!Number.isSafeInteger(number)) throw new Error(`قيمة «${label}» خارج النطاق المسموح.`);
  return number;
}

function coerceDecimal(value, label) {
  const text = typeof value === 'number' ? String(value) : String(value).trim();
  if (!DECIMAL_TEXT.test(text)) throw new Error(`الحقل «${label}» يقبل قيمة رقمية عشرية فقط.`);
  const number = Number(text);
  if (!Number.isFinite(number)) throw new Error(`قيمة «${label}» خارج النطاق المسموح.`);
  return number;
}

function coerceBoolean(value, label) {
  if (typeof value === 'boolean') return value ? 1 : 0;
  const text = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'نعم'].includes(text)) return 1;
  if (['0', 'false', 'no', 'لا'].includes(text)) return 0;
  throw new Error(`الحقل «${label}» يقبل قيمة منطقية (نعم/لا) فقط.`);
}

function coerceDate(value, label) {
  const text = String(value).trim();
  if (!DATE_TEXT.test(text)) throw new Error(`الحقل «${label}» يقبل تاريخاً بصيغة YYYY-MM-DD.`);
  const date = new Date(`${text}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== text) throw new Error(`تاريخ «${label}» غير صالح.`);
  return text;
}

function coerceDateTime(value, label) {
  const text = String(value).trim();
  if (!ISO_DATETIME.test(text)) throw new Error(`الحقل «${label}» يقبل تاريخاً ووقتاً بصيغة ISO.`);
  const date = new Date(text);
  if (!Number.isFinite(date.getTime())) throw new Error(`تاريخ ووقت «${label}» غير صالح.`);
  return date.toISOString();
}

function coerceReference(value, label) {
  let id;
  if (typeof value === 'number') {
    id = value;
  } else {
    const text = String(value).trim();
    if (!INTEGER_TEXT.test(text)) throw new Error(`المرجع في «${label}» يجب أن يكون معرّفاً رقمياً.`);
    id = Number(text);
  }
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`المرجع في «${label}» غير صالح.`);
  return id;
}

function coerceCurrency(db, value, label) {
  const code = String(value).trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) throw new Error(`رمز العملة في «${label}» يجب أن يكون ثلاثة أحرف لاتينية كبيرة.`);
  const target = referenceTableInfo(db, lookupRefs.currency);
  if (target) {
    const row = db.prepare(`SELECT 1 AS hit FROM ${quoteIdentifier(lookupRefs.currency.table)}
      WHERE upper(trim(${quoteIdentifier(target.valueColumn)})) = ? LIMIT 1`).get(code);
    if (!row) throw new Error(`العملة «${code}» غير مسجلة في جدول العملات المعتمد.`);
  }
  return code;
}

// ---------------------------------------------------------------------------
// Validation (shared by save() and validateRow()).
// ---------------------------------------------------------------------------

function sameStoredValue(left, right) {
  const a = left === undefined ? null : left;
  const b = right === undefined ? null : right;
  if (a === null || b === null) return a === b;
  if (typeof a === 'number' || typeof b === 'number') return Number(a) === Number(b);
  return String(a) === String(b);
}

/**
 * Normalizes and validates the caller payload for one dataset.
 * Returns { normalized } or throws DomainValidationError with every problem.
 */
function validateValues(db, dataset, real, rawValues, context) {
  const errors = [];
  const declared = declaredFields(dataset);
  const provided = new Map();
  const stateColumn = real.has('value_state');
  const valueColumnNames = new Set(valueColumns(dataset, real));

  let explicitState = null;
  if (stateColumn && Object.hasOwn(rawValues, 'value_state')) {
    const raw = rawValues.value_state;
    if (raw !== null && raw !== undefined && String(raw).trim() !== '') explicitState = String(raw).trim();
  }
  if (explicitState !== null && !EMPTY_VALUE_STATES.has(explicitState) && !KNOWN_VALUE_STATES.has(explicitState)) {
    errors.push({ field: 'value_state', message: `حالة القيمة «${explicitState}» غير معتمدة.` });
  }
  const effectiveState = explicitState ?? (context.previous?.value_state ?? null);
  const emptyState = effectiveState !== null && EMPTY_VALUE_STATES.has(effectiveState);

  for (const [name, value] of Object.entries(rawValues)) {
    if (!real.has(name)) {
      errors.push({ field: name, message: `حقل غير معروف في «${dataset.labelAr}»: ${name}.` });
      continue;
    }
    if (MANAGED_COLUMNS.has(name) || name === 'value_state') continue;
    if (dataset.autoPk && name === dataset.primaryKey[0]) continue; // generated key
    if (name.endsWith('_minor') && real.has(name.slice(0, -6))) {
      errors.push({ field: name, message: `الحقل «${name}» محسوب تلقائياً من العملة ولا يُدخل يدوياً.` });
      continue;
    }
    if (!declared.has(name)) {
      errors.push({ field:name,message:`الحقل «${name}» موجود في قاعدة البيانات لكنه غير موثق في سجل المجموعة؛ لا يقبل الكتابة.` });
      continue;
    }
    provided.set(name, value);
  }

  if (context.create) {
    for (const field of dataset.fields) {
      if (!field.required || !real.has(field.name) || provided.has(field.name)) continue;
      const column = real.get(field.name);
      if (column.dflt_value !== null && column.dflt_value !== undefined) continue;
      errors.push({ field: field.name, message: `الحقل «${fieldLabel(field)}» مطلوب.` });
    }
  }

  const normalized = {};

  for (const [name, raw] of provided) {
    const column = real.get(name);
    const field = declared.get(name) ?? { name, labelAr: inferredLabel(name), type: inferType(column), inferred: true };
    const label = fieldLabel(field);
    const blank = raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '');

    if (emptyState && valueColumnNames.has(name)) {
      if (!blank) {
        errors.push({ field: name, message: `لا يمكن إدخال قيمة في «${label}» مع حالة «${effectiveState}»؛ يجب أن تبقى فارغة.` });
      }
      normalized[name] = null;
      continue;
    }

    if (blank) {
      if (field.required) {
        errors.push({ field: name, message: `الحقل «${label}» مطلوب ولا يقبل قيمة فارغة.` });
        continue;
      }
      if (column.notnull === 1 && column.dflt_value === null) {
        errors.push({ field: name, message: `الحقل «${label}» لا يقبل قيمة فارغة في هذا الجدول.` });
        continue;
      }
      normalized[name] = field.allowEmpty && typeof raw === 'string' ? '' : null;
      continue;
    }

    let parsed;
    try {
      switch (field.type) {
        case 'integer': parsed = coerceInteger(raw, label); break;
        case 'decimal': parsed = coerceDecimal(raw, label); break;
        case 'boolean': parsed = coerceBoolean(raw, label); break;
        case 'date': parsed = coerceDate(raw, label); break;
        case 'datetime': parsed = coerceDateTime(raw, label); break;
        case 'currency': parsed = coerceCurrency(db, raw, label); break;
        default:
          if (REF_KINDS.has(field.type)) parsed = coerceReference(raw, label);
          else if (typeof raw === 'object') throw new Error(`الحقل «${label}» يقبل قيمة نصية فقط.`);
          else parsed = String(raw).trim();
      }
    } catch (error) {
      errors.push({ field: name, message: error.message });
      continue;
    }

    if (typeof parsed === 'number' && (field.type === 'integer' || field.type === 'decimal')) {
      if (field.min !== undefined && field.min !== null && parsed < field.min) {
        errors.push({ field: name, message: `قيمة «${label}» أقل من الحد الأدنى (${field.min}).` });
        continue;
      }
      if (field.max !== undefined && field.max !== null && parsed > field.max) {
        errors.push({ field: name, message: `قيمة «${label}» أكبر من الحد الأعلى (${field.max}).` });
        continue;
      }
      if (effectiveState === 'zero' && parsed !== 0) {
        errors.push({ field: name, message: `حالة الصفر تتطلب أن تكون قيمة «${label}» صفراً.` });
        continue;
      }
    }

    if (Array.isArray(field.enum) && !field.enum.map(String).includes(String(parsed))) {
      errors.push({ field: name, message: `قيمة «${label}» خارج القيم المعتمدة.` });
      continue;
    }

    if (REF_KINDS.has(field.type) && field.ref) {
      const target = referenceTableInfo(db, field.ref);
      if (target) {
        const hit = db.prepare(`SELECT 1 AS hit FROM ${quoteIdentifier(field.ref.table)}
          WHERE ${quoteIdentifier(target.valueColumn)} = ? LIMIT 1`).get(parsed);
        if (!hit) {
          errors.push({ field: name, message: `المرجع المحدد في «${label}» غير موجود.` });
          continue;
        }
      }
    }

    normalized[name] = parsed;
  }

  // Empty value states force every nullable value column to NULL, even when the
  // caller only sends the state (never turning absence into an invented zero).
  if (emptyState && stateColumn) {
    for (const name of valueColumnNames) {
      if (Object.hasOwn(normalized, name)) continue;
      const column = real.get(name);
      if (!column || column.notnull === 1) continue;
      normalized[name] = null;
    }
  }

  // Keep money columns and their exact minor-unit mirrors consistent.
  const currencyForScale = Object.hasOwn(normalized, 'currency_code')
    ? normalized.currency_code
    : (context.previous?.currency_code ?? null);
  if (real.has('currency_code') && (Object.hasOwn(normalized, 'currency_code') || context.previous)) {
    for (const column of real.values()) {
      if (!column.name.endsWith('_minor')) continue;
      const base = column.name.slice(0, -6);
      if (!real.has(base)) continue;
      const meta = declared.get(base);
      if (meta && !['decimal', 'integer'].includes(meta.type)) continue;
      const hasFresh = Object.hasOwn(normalized, base);
      if (!hasFresh && !Object.hasOwn(normalized, 'currency_code')) continue;
      const value = hasFresh ? normalized[base] : context.previous?.[base];
      const unit = minorUnitOf(db, currencyForScale);
      normalized[column.name] = value === null || value === undefined || value === '' ? null : Math.round(Number(value) * 10 ** unit);
    }
  }

  if (explicitState !== null) normalized.value_state = explicitState;

  if (errors.length) throw new DomainValidationError(errors);
  return { normalized };
}

// ---------------------------------------------------------------------------
// 6. Create / update with append-only audit.
// ---------------------------------------------------------------------------

function auditJson(value) {
  if (value === null || value === undefined) return null;
  let text;
  try { text = JSON.stringify(value); } catch { return null; }
  if (text.length <= AUDIT_JSON_LIMIT) return text;
  const marker = '[truncated]';
  return text.slice(0, AUDIT_JSON_LIMIT - marker.length) + marker;
}

function writeAudit(db, entry) {
  db.prepare(`INSERT INTO audit_events(event_code,resource_type,resource_id,action_type,old_value_json,new_value_json,performed_by,session_id,performed_at,details)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
    entry.code,
    entry.resourceType,
    entry.resourceId === null || entry.resourceId === undefined ? null : String(entry.resourceId),
    entry.action,
    auditJson(entry.before),
    auditJson(entry.after),
    entry.actor ?? 'system',
    entry.sessionId ?? null,
    entry.performedAt,
    entry.details ?? null
  );
}

function save(db, request = {}) {
  requireDb(db);
  const dataset = getDataset(request.dataset);
  if (!tablePresent(db, dataset.table)) throw new Error(`جدول مجموعة «${dataset.labelAr}» غير موجود في قاعدة البيانات.`);
  const { real } = datasetContext(db, dataset);

  let id = null;
  if (request.id !== undefined && request.id !== null && request.id !== '') {
    const candidate = typeof request.id === 'number' ? request.id : Number(String(request.id).trim());
    if (!Number.isSafeInteger(candidate) || candidate <= 0) {
      throw new DomainValidationError([{ field: 'id', message: 'معرّف السجل غير صالح.' }]);
    }
    id = candidate;
  }

  const rawValues = request.values && typeof request.values === 'object' && !Array.isArray(request.values) ? request.values : {};
  const actor = typeof request.actor === 'string' && request.actor.trim() ? request.actor.trim().slice(0, 120) : null;
  const reason = request.reason === null || request.reason === undefined ? null : String(request.reason).trim().slice(0, AUDIT_DETAILS_LIMIT);
  const sessionId = request.sessionId === null || request.sessionId === undefined || request.sessionId === ''
    ? null
    : String(request.sessionId).slice(0, 120);
  let requestedSource = null;
  if (request.sourceId !== null && request.sourceId !== undefined && request.sourceId !== '') {
    requestedSource = Number(request.sourceId);
    if (!Number.isSafeInteger(requestedSource) || requestedSource <= 0) {
      throw new DomainValidationError([{ field: 'source_id', message: 'معرّف المصدر غير صالح.' }]);
    }
  }

  const table = quoteIdentifier(dataset.table);
  const pkColumn = dataset.primaryKey[0];
  const now = new Date().toISOString();

  return db.transaction(() => {
    const previous = id === null
      ? null
      : db.prepare(`SELECT * FROM ${table} WHERE ${quoteIdentifier(pkColumn)} = ? LIMIT 1`).get(id);
    if (id !== null && !previous) throw new Error('السجل المطلوب تعديله غير موجود.');

    const { normalized } = validateValues(db, dataset, real, rawValues, { create: id === null, previous, sourceId: requestedSource });

    let created;
    let changedFields;

    if (previous) {
      const payload = { ...normalized };
      changedFields = Object.keys(payload).filter(name => !sameStoredValue(previous[name], payload[name]));
      if (!changedFields.length) return { id, created: false, changedFields: [] };
      if (real.has('updated_at')) payload.updated_at = now;
      const columns = Object.keys(payload);
      db.prepare(`UPDATE ${table} SET ${columns.map(name => `${quoteIdentifier(name)} = ?`).join(', ')}
        WHERE ${quoteIdentifier(pkColumn)} = ?`).run(...columns.map(name => payload[name]), id);
      created = false;
    } else {
      const payload = { ...normalized };
      if (real.has('created_at')) payload.created_at = now;
      if (real.has('updated_at')) payload.updated_at = now;
      if (real.has('source_id') && !Object.hasOwn(payload, 'source_id') && requestedSource !== null) payload.source_id = requestedSource;
      const columns = Object.keys(payload);
      if (!columns.length) throw new DomainValidationError([{ field: null, message: 'لا توجد قيم صالحة للحفظ.' }]);
      const result = db.prepare(`INSERT INTO ${table} (${columns.map(quoteIdentifier).join(', ')})
        VALUES (${columns.map(() => '?').join(', ')})`).run(...columns.map(name => payload[name]));
      const inserted = Number(result.lastInsertRowid);
      id = Number.isSafeInteger(inserted) && inserted > 0
        ? inserted
        : (Number.isSafeInteger(Number(payload[pkColumn])) ? Number(payload[pkColumn]) : null);
      if (id === null) throw new Error('تعذر تحديد معرّف السجل بعد الإدراج.');
      created = true;
      changedFields = Object.keys(normalized);
    }

    const after = db.prepare(`SELECT * FROM ${table} WHERE ${quoteIdentifier(pkColumn)} = ? LIMIT 1`).get(id);
    writeAudit(db, {
      code: created ? 'unified.domain.create' : 'unified.domain.update',
      resourceType: dataset.table,
      resourceId: id,
      action: created ? 'create' : 'update',
      before: created ? null : previous,
      after,
      actor,
      sessionId,
      performedAt: now,
      details: reason
    });

    return { id, created: Boolean(created), changedFields };
  })();
}

// ---------------------------------------------------------------------------
// 7. Delete with child-reference protection.
// ---------------------------------------------------------------------------

// Every declared field that points at this table, including self references.
function childReferences(dataset) {
  const children = [];
  for (const other of Object.values(DATASETS)) {
    for (const field of other.fields) {
      if (!field.ref || field.ref.table !== dataset.table) continue;
      if (other.table === dataset.table && field.name === dataset.primaryKey[0]) continue;
      children.push({ dataset: other, field, selfReference: other.table === dataset.table });
    }
  }
  return children;
}

function remove(db, request = {}) {
  requireDb(db);
  const dataset = getDataset(request.dataset);
  if (!tablePresent(db, dataset.table)) throw new Error(`جدول مجموعة «${dataset.labelAr}» غير موجود في قاعدة البيانات.`);
  const candidate = typeof request.id === 'number' ? request.id : Number(String(request.id ?? '').trim());
  if (!Number.isSafeInteger(candidate) || candidate <= 0) throw new Error('معرّف السجل غير صالح.');
  const actor = typeof request.actor === 'string' && request.actor.trim() ? request.actor.trim().slice(0, 120) : null;
  const reason = request.reason === null || request.reason === undefined ? null : String(request.reason).trim().slice(0, AUDIT_DETAILS_LIMIT);
  const sessionId = request.sessionId === null || request.sessionId === undefined || request.sessionId === ''
    ? null
    : String(request.sessionId).slice(0, 120);
  const table = quoteIdentifier(dataset.table);
  const now = new Date().toISOString();

  return db.transaction(() => {
    const previous = db.prepare(`SELECT * FROM ${table} WHERE ${quoteIdentifier(dataset.primaryKey[0])} = ? LIMIT 1`).get(candidate);
    if (!previous) throw new Error('السجل المطلوب حذفه غير موجود.');

    const blockers = [];
    for (const child of childReferences(dataset)) {
      if (!tablePresent(db, child.dataset.table)) continue;
      if (!tableInfo(db, child.dataset.table).some(column => column.name === child.field.name)) continue;
      const selfGuard = child.selfReference ? ` AND ${quoteIdentifier(dataset.primaryKey[0])} <> ?` : '';
      const statement = db.prepare(`SELECT COUNT(*) AS total FROM ${quoteIdentifier(child.dataset.table)}
        WHERE ${quoteIdentifier(child.field.name)} = ?${selfGuard}`);
      const count = Number((child.selfReference ? statement.get(candidate, candidate) : statement.get(candidate)).total ?? 0);
      if (count > 0) blockers.push(`«${child.dataset.labelAr}» (${count})`);
    }
    if (blockers.length) {
      throw new Error(`لا يمكن حذف السجل لارتباطه بسجلات تابعة: ${blockers.join('، ')}. احذف السجلات التابعة أو أعد ربطها أولاً.`);
    }

    db.prepare(`DELETE FROM ${table} WHERE ${quoteIdentifier(dataset.primaryKey[0])} = ?`).run(candidate);
    writeAudit(db, {
      code: 'unified.domain.delete',
      resourceType: dataset.table,
      resourceId: candidate,
      action: 'delete',
      before: previous,
      after: null,
      actor,
      sessionId,
      performedAt: now,
      details: reason
    });
    return { deleted: true };
  })();
}

// ---------------------------------------------------------------------------
// 8. Database summary.
// ---------------------------------------------------------------------------

function countOpenQualityIssues(db) {
  if (!tablePresent(db, 'data_quality_issues')) return 0;
  const columns = new Set(tableInfo(db, 'data_quality_issues').map(column => column.name));
  const statusColumn = columns.has('quality_status') ? 'quality_status' : columns.has('status') ? 'status' : null;
  if (!statusColumn) return 0;
  return Number(db.prepare(`SELECT COUNT(*) AS total FROM "data_quality_issues" WHERE ${quoteIdentifier(statusColumn)} = 'open'`).get().total ?? 0);
}

function summary(db) {
  requireDb(db);
  const datasets = listDatasets(db);
  const layers = LAYERS.map(layer => {
    const scoped = datasets.filter(dataset => dataset.layer === layer.key);
    return {
      key: layer.key,
      labelAr: layer.labelAr,
      datasets: scoped.filter(dataset => dataset.available).length,
      rows: scoped.reduce((total, dataset) => total + dataset.count, 0)
    };
  });
  const auditEvents = tablePresent(db, 'audit_events') ? rowCount(db, 'audit_events') : 0;
  return {
    layers,
    totals: {
      datasets: datasets.filter(dataset => dataset.available).length,
      rows: datasets.reduce((total, dataset) => total + dataset.count, 0),
      auditEvents,
      openQualityIssues: countOpenQualityIssues(db)
    }
  };
}

// ---------------------------------------------------------------------------
// 9. Standalone validation.
// ---------------------------------------------------------------------------

function validateRow(db, datasetKey, values) {
  requireDb(db);
  const dataset = getDataset(datasetKey);
  if (!tablePresent(db, dataset.table)) {
    return { valid: false, errors: [{ field: null, message: `جدول مجموعة «${dataset.labelAr}» غير موجود في قاعدة البيانات.` }] };
  }
  const { real } = datasetContext(db, dataset);
  const payload = values && typeof values === 'object' && !Array.isArray(values) ? values : {};
  try {
    validateValues(db, dataset, real, payload, { create: true, previous: null, sourceId: null });
    return { valid: true, errors: [] };
  } catch (error) {
    if (error instanceof DomainValidationError) return { valid: false, errors: error.errors };
    return { valid: false, errors: [{ field: null, message: error.message }] };
  }
}

module.exports = {
  listDatasets,
  describe,
  options,
  list,
  read,
  save,
  remove,
  summary,
  validateRow,
  DomainValidationError
};
