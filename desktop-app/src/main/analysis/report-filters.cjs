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

function presentSql(alias) {
  return `COALESCE(${alias}.value_state,'unknown')<>'unknown' AND CASE ${alias}.data_type WHEN 'number' THEN ${alias}.value_number IS NOT NULL WHEN 'boolean' THEN ${alias}.value_boolean IS NOT NULL ELSE TRIM(COALESCE(${alias}.value_text,''))<>'' END`;
}

function fieldCondition(condition, allowedKeys) {
  const key = String(condition?.key ?? '');
  const field = FILTER_FIELDS.get(key);
  if (!field || !allowedKeys.has(key)) return null;
  const operator = String(condition.operator ?? '');
  const valueSql = (predicate, predicateParams = []) => ({
    sql: `EXISTS (SELECT 1 FROM entity_field_values fv JOIN data_field_definitions fd ON fd.id=fv.field_definition_id WHERE fv.record_id=er.id AND fv.period_key='' AND fd.entity_type='directorate' AND fd.field_key=? AND ${predicate})`,
    params: [key, ...predicateParams],
  });
  let result;
  if (operator === 'empty') {
    const present = valueSql(presentSql('fv'));
    result = { sql: `NOT (${present.sql})`, params: present.params };
  } else if (operator === 'present') {
    result = valueSql(presentSql('fv'));
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
    const present = valueSql(`fv.data_type='number' AND fv.value_number IS NOT NULL AND COALESCE(fv.value_state,'unknown')<>'unknown' AND ${predicates.join(' AND ')}`, params);
    if (condition.missing === 'include') {
      const missing = valueSql(presentSql('fv'));
      result = { sql: `(${present.sql} OR NOT (${missing.sql}))`, params: [...present.params, ...missing.params] };
    } else result = present;
  } else if (field.type === 'boolean') {
    if (condition.value !== '0' && condition.value !== '1' && condition.value !== 0 && condition.value !== 1) return null;
    result = valueSql("fv.data_type='boolean' AND fv.value_boolean=? AND COALESCE(fv.value_state,'unknown')<>'unknown'", [Number(condition.value)]);
  } else if (operator === 'in' || operator === 'not-in') {
    const options = [...new Set((Array.isArray(condition.values) ? condition.values : []).map((item) => String(item).trim()).filter(Boolean))].slice(0, 100);
    if (!options.length) return null;
    const placeholders = options.map(() => '?').join(',');
    result = valueSql(`fv.data_type='text' AND fv.value_text IN (${placeholders}) AND COALESCE(fv.value_state,'unknown')<>'unknown'`, options);
    if (operator === 'not-in') result.sql = `NOT (${result.sql})`;
  } else if (operator === 'contains' && field.type === 'text') {
    const query = typeof condition.value === 'string' ? condition.value.trim().slice(0, 120) : '';
    if (!query) return null;
    result = valueSql("fv.data_type='text' AND instr(fv.value_text,?)>0 AND COALESCE(fv.value_state,'unknown')<>'unknown'", [query]);
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

function completenessCondition(condition, allowedMandatoryKeys) {
  const keys = MANDATORY_FIELDS.map((field) => field.key).filter((key) => allowedMandatoryKeys.has(key));
  if (!keys.length) return null;
  const placeholders = keys.map(() => '?').join(',');
  const ratio = `(SELECT COUNT(*) * 1.0 / ${keys.length} FROM entity_field_values qv JOIN data_field_definitions qf ON qf.id=qv.field_definition_id WHERE qv.record_id=er.id AND qv.period_key='' AND qf.entity_type='directorate' AND qf.field_key IN (${placeholders}) AND ${presentSql('qv')})`;
  const clauses = [];
  const params = [...keys];
  if (condition.min !== '' && Number.isFinite(Number(condition.min))) { clauses.push(`${ratio}>=?`); params.push(Number(condition.min) / 100); }
  if (condition.max !== '' && Number.isFinite(Number(condition.max))) { clauses.push(`${ratio}<=?`); params.push(Number(condition.max) / 100); }
  if (!clauses.length) return null;
  return { sql: condition.exclude === true ? `NOT (${clauses.join(' AND ')})` : clauses.join(' AND '), params };
}

function missingFieldCondition(condition, allowedKeys) {
  const keys = [...new Set((Array.isArray(condition.values) ? condition.values : []).map(String))]
    .filter((key) => allowedKeys.has(key) && FILTER_FIELDS.has(key)).slice(0, 40);
  if (!keys.length) return null;
  const missing = keys.map((key) => `NOT EXISTS (SELECT 1 FROM entity_field_values mv JOIN data_field_definitions mf ON mf.id=mv.field_definition_id WHERE mv.record_id=er.id AND mv.period_key='' AND mf.entity_type='directorate' AND mf.field_key=? AND ${presentSql('mv')})`);
  const sql = `(${missing.join(' OR ')})`;
  return { sql: condition.exclude === true ? `NOT ${sql}` : sql, params: keys };
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
  const allowedMandatoryKeys = options.allowedMandatoryKeys instanceof Set ? options.allowedMandatoryKeys : new Set(MANDATORY_FIELDS.map((field) => field.key));
  const criteria = (Array.isArray(filter.criteria) ? filter.criteria : []).slice(0, 64).map((condition) => {
    if (condition?.key === '__completeness') return completenessCondition(condition, allowedMandatoryKeys);
    if (condition?.key === '__missingField') return missingFieldCondition(condition, allowedKeys);
    if (condition?.key === '__qualityLevel') return qualityCondition(condition, options.profile);
    return fieldCondition(condition, allowedKeys) ?? metadataCondition(condition);
  }).filter(Boolean);
  if (criteria.length) {
    const joiner = filter.logic === 'or' ? ' OR ' : ' AND ';
    clauses.push(`(${criteria.map((item) => `(${item.sql})`).join(joiner)})`);
    for (const item of criteria) params.push(...item.params);
  }
  return { clauses, params };
}

module.exports = { buildDirectorateWhere, FILTER_FIELDS };
