'use strict';

const { INPUT_FIELDS, DECISION_FIELD, MANDATORY_FIELDS } = require('./schema.cjs');

const FILTER_FIELDS = new Map([...INPUT_FIELDS, DECISION_FIELD].map((field) => [field.key, field]));
const SOURCE_COLUMN = {
  __sourceFile: 'source_file',
  __sourceSheet: 'source_sheet',
  __sourceRow: 'source_row',
  __updatedAt: 'updated_at',
  __createdAt: 'created_at',
};

function presentSql(alias, definitionAlias) {
  return `COALESCE(${alias}.value_state,'unknown')<>'unknown' AND CASE
    WHEN ${definitionAlias}.data_type IN ('number','numeric','integer','decimal','ratio','percentage','percent') THEN ${alias}.value_number IS NOT NULL
    WHEN ${definitionAlias}.data_type IN ('boolean','bool') THEN ${alias}.value_boolean IS NOT NULL
    WHEN ${definitionAlias}.data_type IN ('date','datetime') THEN COALESCE(${alias}.value_date,${alias}.value_text) IS NOT NULL
    ELSE TRIM(COALESCE(${alias}.value_text,''))<>'' END`;
}

function fieldCondition(condition, allowedKeys, dynamicFields = new Map(), periodKey = '') {
  const key = String(condition?.key ?? '');
  const field = FILTER_FIELDS.get(key) ?? dynamicFields.get(key);
  if (!field || !allowedKeys.has(key)) return null;
  const operator = String(condition.operator ?? '');
  const periodClause = periodKey ? 'AND fv.period_key=?' : "AND fv.period_key=''";
  const valueSql = (predicate, predicateParams = []) => ({
    sql: `EXISTS (SELECT 1 FROM entity_field_values fv JOIN data_field_definitions fd ON fd.id=fv.field_definition_id WHERE fv.record_id=er.id ${periodClause} AND fd.entity_type='directorate' AND fd.field_key=? AND ${predicate})`,
    params: [...(periodKey ? [periodKey] : []), key, ...predicateParams],
  });
  let result;
  if (operator === 'empty') {
    const present = valueSql(presentSql('fv','fd'));
    result = { sql: `NOT (${present.sql})`, params: present.params };
  } else if (operator === 'present') {
    result = valueSql(presentSql('fv','fd'));
  } else if (field.type === 'number' || field.type === 'ratio') {
    const predicates = [];
    const params = [];
    if (condition.min !== null && condition.min !== undefined && condition.min !== '') {
      const min = Number(condition.min);
      if (Number.isFinite(min)) { predicates.push('fv.value_number>=?'); params.push(min); }
    }
    if (condition.max !== null && condition.max !== undefined && condition.max !== '') {
      const max = Number(condition.max);
      if (Number.isFinite(max)) { predicates.push('fv.value_number<=?'); params.push(max); }
    }
    if (!predicates.length) return null;
    const present = valueSql(`fd.data_type IN ('number','numeric','integer','decimal','ratio','percentage','percent') AND fv.value_number IS NOT NULL AND COALESCE(fv.value_state,'unknown')<>'unknown' AND ${predicates.join(' AND ')}`, params);
    if (condition.missing === 'include') {
      const missing = valueSql(presentSql('fv','fd'));
      result = { sql: `(${present.sql} OR NOT (${missing.sql}))`, params: [...present.params, ...missing.params] };
    } else result = present;
  } else if (field.type === 'date') {
    const predicates = [];
    const params = [];
    if (condition.min) { predicates.push('COALESCE(fv.value_date,fv.value_text)>=?'); params.push(String(condition.min).slice(0, 10)); }
    if (condition.max) { predicates.push('COALESCE(fv.value_date,fv.value_text)<=?'); params.push(`${String(condition.max).slice(0, 10)}T23:59:59.999Z`); }
    if (!predicates.length) return null;
    result = valueSql(`fd.data_type IN ('date','datetime') AND COALESCE(fv.value_date,fv.value_text) IS NOT NULL AND ${predicates.join(' AND ')} AND COALESCE(fv.value_state,'unknown')<>'unknown'`, params);
  } else if (field.type === 'boolean') {
    if (condition.value !== '0' && condition.value !== '1' && condition.value !== 0 && condition.value !== 1) return null;
    result = valueSql("fd.data_type IN ('boolean','bool') AND fv.value_boolean=? AND COALESCE(fv.value_state,'unknown')<>'unknown'", [Number(condition.value)]);
  } else if (operator === 'in' || operator === 'not-in') {
    const options = [...new Set((Array.isArray(condition.values) ? condition.values : []).map((item) => String(item).trim()).filter(Boolean))].slice(0, 100);
    if (!options.length) return null;
    const placeholders = options.map(() => '?').join(',');
    result = valueSql(`fd.data_type IN ('text','long_text','reference','entity_reference') AND fv.value_text IN (${placeholders}) AND COALESCE(fv.value_state,'unknown')<>'unknown'`, options);
    if (operator === 'not-in') result.sql = `NOT (${result.sql})`;
  } else if (operator === 'contains' && field.type === 'text') {
    const query = typeof condition.value === 'string' ? condition.value.trim().slice(0, 120) : '';
    if (!query) return null;
    result = valueSql("fd.data_type IN ('text','long_text','reference','entity_reference') AND instr(fv.value_text,?)>0 AND COALESCE(fv.value_state,'unknown')<>'unknown'", [query]);
  } else {
    return null;
  }
  if (condition.exclude === true) result.sql = `NOT (${result.sql})`;
  return result;
}

function metadataCondition(condition) {
  const key = String(condition?.key ?? '');
  const column = SOURCE_COLUMN[key];
  const operator = String(condition.operator ?? '');
  const values = [];
  let expression;
  if (key === '__district') {
    if (operator === 'empty') expression = "TRIM(COALESCE(unit.name,''))=''";
    else if (operator === 'present') expression = "TRIM(COALESCE(unit.name,''))<>''";
    else if (operator === 'in' || operator === 'not-in') {
      const options = [...new Set((Array.isArray(condition.values) ? condition.values : []).map((item) => String(item).trim()).filter(Boolean))].slice(0, 100);
      if (!options.length) return null;
      expression = `unit.name IN (${options.map(() => '?').join(',')})`;
      values.push(...options);
      if (operator === 'not-in') expression = `NOT (${expression})`;
    } else if (operator === 'contains') {
      const query = typeof condition.value === 'string' ? condition.value.trim().slice(0, 120) : '';
      if (!query) return null;
      expression = 'instr(unit.name,?)>0';
      values.push(query);
    } else return null;
  } else {
    if (!column) return null;
    if (operator === 'empty') expression = `legacy.${column} IS NULL OR TRIM(CAST(legacy.${column} AS TEXT))=''`;
    else if (operator === 'present') expression = `legacy.${column} IS NOT NULL AND TRIM(CAST(legacy.${column} AS TEXT))<>''`;
    else if (key === '__sourceRow' && (condition.min !== '' || condition.max !== '')) {
      const parts = [];
      if (condition.min !== '' && Number.isFinite(Number(condition.min))) { parts.push(`legacy.${column}>=?`); values.push(Number(condition.min)); }
      if (condition.max !== '' && Number.isFinite(Number(condition.max))) { parts.push(`legacy.${column}<=?`); values.push(Number(condition.max)); }
      if (!parts.length) return null;
      expression = parts.join(' AND ');
    } else if (['__updatedAt', '__createdAt'].includes(key) && (condition.min || condition.max)) {
      const parts = [];
      if (condition.min) { parts.push(`legacy.${column}>=?`); values.push(String(condition.min)); }
      if (condition.max) { parts.push(`legacy.${column}<=?`); values.push(`${String(condition.max).slice(0, 10)}T23:59:59.999Z`); }
      if (!parts.length) return null;
      expression = parts.join(' AND ');
    } else if (operator === 'contains') {
      const query = typeof condition.value === 'string' ? condition.value.trim().slice(0, 120) : '';
      if (!query) return null;
      expression = `instr(CAST(legacy.${column} AS TEXT),?)>0`;
      values.push(query);
    } else return null;
  }
  return { sql: condition.exclude === true ? `NOT (${expression})` : `(${expression})`, params: values };
}

function completenessCondition(condition, allowedMandatoryKeys, periodKey = '') {
  const keys = MANDATORY_FIELDS.map((field) => field.key).filter((key) => allowedMandatoryKeys.has(key));
  if (!keys.length) return null;
  const placeholders = keys.map(() => '?').join(',');
  const periodClause = periodKey ? 'AND qv.period_key=?' : "AND qv.period_key=''";
  const ratio = `(SELECT COUNT(*) * 1.0 / ${keys.length} FROM entity_field_values qv JOIN data_field_definitions qf ON qf.id=qv.field_definition_id WHERE qv.record_id=er.id ${periodClause} AND qf.entity_type='directorate' AND qf.field_key IN (${placeholders}) AND ${presentSql('qv','qf')})`;
  const clauses = [];
  const params = [];
  if (condition.min !== '' && Number.isFinite(Number(condition.min))) { clauses.push(`${ratio}>=?`); params.push(...(periodKey ? [periodKey] : []),...keys,Number(condition.min) / 100); }
  if (condition.max !== '' && Number.isFinite(Number(condition.max))) { clauses.push(`${ratio}<=?`); params.push(...(periodKey ? [periodKey] : []),...keys,Number(condition.max) / 100); }
  if (!clauses.length) return null;
  return { sql: condition.exclude === true ? `NOT (${clauses.join(' AND ')})` : clauses.join(' AND '), params };
}

function missingFieldCondition(condition, allowedKeys, dynamicFields = new Map(), periodKey = '') {
  const keys = [...new Set((Array.isArray(condition.values) ? condition.values : []).map(String))]
    .filter((key) => allowedKeys.has(key) && (FILTER_FIELDS.has(key) || dynamicFields.has(key))).slice(0, 40);
  if (!keys.length) return null;
  const periodClause = periodKey ? 'AND mv.period_key=?' : "AND mv.period_key=''";
  const missing = keys.map(() => `NOT EXISTS (SELECT 1 FROM entity_field_values mv JOIN data_field_definitions mf ON mf.id=mv.field_definition_id WHERE mv.record_id=er.id ${periodClause} AND mf.entity_type='directorate' AND mf.field_key=? AND ${presentSql('mv','mf')})`);
  const sql = `(${missing.join(' OR ')})`;
  const params = keys.flatMap((key) => periodKey ? [periodKey,key] : [key]);
  return { sql: condition.exclude === true ? `NOT ${sql}` : sql, params };
}

function qualityCondition(condition) {
  const values = [...new Set((Array.isArray(condition.values) ? condition.values : []).map(String))]
    .filter((value) => ['warnings', 'clean'].includes(value));
  if (!values.length) return null;
  const warning = "COALESCE(legacy.import_warnings,'[]') NOT IN ('','[]')";
  const sql = values.length === 2 ? '1=1' : values[0] === 'warnings' ? warning : `NOT (${warning})`;
  return { sql: condition.exclude === true ? `NOT (${sql})` : `(${sql})`, params: [] };
}

function buildDirectorateWhere(filter = {}, options = {}) {
  const allowedKeys = options.allowedKeys instanceof Set ? options.allowedKeys : new Set(FILTER_FIELDS.keys());
  const clauses = ["er.entity_type='directorate'", "er.status='approved'", "er.external_key GLOB 'legacy-directorate:[0-9]*'"];
  const params = [];
  const governorates = [...new Set((Array.isArray(filter.governorates) ? filter.governorates : []).map((item) => String(item).trim()).filter(Boolean))].slice(0, 100);
  if (governorates.length) { clauses.push(`governorate.name IN (${governorates.map(() => '?').join(',')})`); params.push(...governorates); }
  else if (filter.governorate) { clauses.push('governorate.name=?'); params.push(String(filter.governorate).trim()); }
  const search = typeof filter.search === 'string' ? filter.search.trim().slice(0, 120) : '';
  if (search) { clauses.push('instr(unit.name,?)>0'); params.push(search); }
  const periodKey = typeof filter.periodKey === 'string' ? filter.periodKey.trim().slice(0, 80) : '';
  const allowedMandatoryKeys = options.allowedMandatoryKeys instanceof Set
    ? options.allowedMandatoryKeys
    : new Set(MANDATORY_FIELDS.map((field) => field.key).filter((key) => allowedKeys.has(key)));
  const dynamicFields = options.dynamicFields instanceof Map ? options.dynamicFields : new Map();
  const criteria = (Array.isArray(filter.criteria) ? filter.criteria : []).slice(0, 64).map((condition) => {
    if (condition?.key === '__completeness') return completenessCondition(condition, allowedMandatoryKeys, periodKey);
    if (condition?.key === '__missingField') return missingFieldCondition(condition, allowedKeys, dynamicFields, periodKey);
    if (condition?.key === '__qualityLevel') return qualityCondition(condition, options.profile);
    return fieldCondition(condition, allowedKeys, dynamicFields, periodKey) ?? metadataCondition(condition);
  }).filter(Boolean);
  if (criteria.length) {
    const joiner = filter.logic === 'or' ? ' OR ' : ' AND ';
    clauses.push(`(${criteria.map((item) => `(${item.sql})`).join(joiner)})`);
    for (const item of criteria) params.push(...item.params);
  }
  return { clauses, params };
}

module.exports = { buildDirectorateWhere, FILTER_FIELDS };
