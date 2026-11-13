'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3-multiple-ciphers');
const { migrate } = require('../src/main/analysis/store-schema.cjs');
const { listCatalog } = require('../src/main/database/manual-entry-catalog.cjs');

const REGISTER_NOTE = 'سجل لتعريفات قاموس النظام الحالية فقط؛ لا يثبت مطابقة كل عبارة في المواصفة أو سلامة الربط الدلالي أو الاستهلاك التحليلي.';
const OUTPUT_PATH = path.resolve(__dirname, '../../docs/architecture/manual-entry-field-register.csv');
const HEADERS = [
  'field_code', 'field_name_ar', 'description', 'semantic_type', 'data_type', 'unit_ar', 'dimension_code',
  'dimension_ar', 'reference_set_code', 'reference_set_ar', 'active', 'form_required', 'form_repeatable',
  'form_derived', 'form_min_values', 'form_max_values', 'form_decimal_precision', 'form_validation_rules',
  'form_source_headers', 'aliases', 'approved_aliases', 'domain_codes', 'domain_names_ar', 'group_codes', 'group_names_ar',
  'source_field_group_codes', 'published_form_codes', 'mapping_states', 'entry_state', 'specification_match',
  'source_basis', 'notes',
];

function csvCell(value) {
  const text = Array.isArray(value) ? value.join('; ') : String(value ?? '');
  return `"${text.replaceAll('"', '""')}"`;
}

function buildManualEntryFieldRegister(db) {
  const catalog = listCatalog(db);
  const fields = new Map();
  for (const domain of catalog.domains) {
    for (const group of domain.groups) {
      for (const field of [...group.fields, ...group.publishedFields]) {
        let entry = fields.get(field.code);
        if (!entry) {
          entry = {
            code: field.code,
            name: field.name,
            semanticType: field.semanticType,
            dataType: field.dataType,
            unit: field.unit,
            domains: new Map(),
            groups: new Map(),
            sourceGroups: new Set(),
            forms: new Set(),
            mappingStates: new Set(),
            descriptions: new Set(),
            dimensions: new Set(),
            references: new Set(),
            active: new Set(),
            required: new Set(),
            repeatable: new Set(),
            derived: new Set(),
            minimums: new Set(),
            maximums: new Set(),
            precisions: new Set(),
            validations: new Set(),
            sourceHeaders: new Set(),
            aliases: new Set(),
            approvedAliases: new Set(),
          };
          fields.set(field.code, entry);
        }
        entry.domains.set(domain.code, domain.name);
        entry.groups.set(group.code, group.name);
        for (const code of field.sourceGroupCodes ?? []) entry.sourceGroups.add(code);
        for (const code of field.formCodes ?? []) entry.forms.add(code);
        if (field.mappingState) entry.mappingStates.add(field.mappingState);
        if (field.formCodes?.length) entry.mappingStates.add('published_form');
      }
    }
  }

  const definitionRows = db.prepare(`SELECT field.field_code,field.description,field.is_active,unit.name_ar AS unit_name_ar,
      dimension.dimension_code,dimension.name_ar AS dimension_name_ar,reference_set.set_code,reference_set.name_ar AS reference_set_name_ar
    FROM field_definitions field
    LEFT JOIN measurement_units unit ON unit.unit_id=field.default_unit_id
    LEFT JOIN dimension_definitions dimension ON dimension.dimension_id=field.default_dimension_id
    LEFT JOIN reference_sets reference_set ON reference_set.reference_set_id=field.reference_set_id`).all();
  for (const row of definitionRows) {
    const entry = fields.get(row.field_code);
    if (!entry) continue;
    if (row.description) entry.descriptions.add(row.description);
    if (row.dimension_code) entry.dimensions.add(`${row.dimension_code}: ${row.dimension_name_ar}`);
    if (row.set_code) entry.references.add(`${row.set_code}: ${row.reference_set_name_ar}`);
    entry.active.add(String(row.is_active));
    if (row.unit_name_ar) entry.unit = row.unit_name_ar;
  }
  const formRows = db.prepare(`SELECT field.field_code,form_field.is_required,form_field.is_repeatable,form_field.is_derived,
      form_field.min_value,form_field.max_value,form_field.decimal_precision,form_field.validation_rules_json,
      form_field.source_header_text,form.form_code
    FROM form_fields form_field
    JOIN form_versions version ON version.form_version_id=form_field.form_version_id AND version.status='published'
    JOIN form_definitions form ON form.form_id=version.form_id AND form.is_active=1
    JOIN field_definitions field ON field.field_definition_id=form_field.field_definition_id`).all();
  for (const row of formRows) {
    const entry = fields.get(row.field_code);
    if (!entry) continue;
    entry.required.add(String(row.is_required));
    entry.repeatable.add(String(row.is_repeatable));
    entry.derived.add(String(row.is_derived));
    if (row.min_value !== null) entry.minimums.add(String(row.min_value));
    if (row.max_value !== null) entry.maximums.add(String(row.max_value));
    if (row.decimal_precision !== null) entry.precisions.add(String(row.decimal_precision));
    if (row.validation_rules_json) entry.validations.add(row.validation_rules_json);
    if (row.source_header_text) entry.sourceHeaders.add(row.source_header_text);
    entry.forms.add(row.form_code);
    entry.mappingStates.add('published_form');
  }
  const aliasRows = db.prepare(`SELECT field.field_code,alias.alias_text,alias.is_approved
    FROM form_field_aliases alias
    JOIN form_fields form_field ON form_field.form_field_id=alias.form_field_id
    JOIN form_versions version ON version.form_version_id=form_field.form_version_id AND version.status='published'
    JOIN form_definitions form ON form.form_id=version.form_id AND form.is_active=1
    JOIN field_definitions field ON field.field_definition_id=form_field.field_definition_id`).all();
  for (const row of aliasRows) {
    const entry = fields.get(row.field_code);
    if (!entry) continue;
    entry.aliases.add(row.alias_text);
    if (row.is_approved) entry.approvedAliases.add(row.alias_text);
  }

  return [...fields.values()].sort((left, right) => left.code.localeCompare(right.code)).map(field => {
    const published = field.forms.size > 0;
    const candidate = field.mappingStates.has('needs_domain_review');
    return {
      code: field.code,
      name: field.name,
      description: [...field.descriptions].join(' | '),
      semanticType: field.semanticType,
      dataType: field.dataType,
      unit: field.unit,
      dimensions: [...field.dimensions].sort(),
      dimensionCodes: [...field.dimensions].map(value => value.split(': ')[0]).sort(),
      dimensionNames: [...field.dimensions].map(value => value.split(': ').slice(1).join(': ')).sort(),
      references: [...field.references].sort(),
      referenceCodes: [...field.references].map(value => value.split(': ')[0]).sort(),
      referenceNames: [...field.references].map(value => value.split(': ').slice(1).join(': ')).sort(),
      active: [...field.active].sort(),
      required: [...field.required].sort(),
      repeatable: [...field.repeatable].sort(),
      derived: [...field.derived].sort(),
      minimums: [...field.minimums].sort(),
      maximums: [...field.maximums].sort(),
      precisions: [...field.precisions].sort(),
      validations: [...field.validations].sort(),
      sourceHeaders: [...field.sourceHeaders].sort(),
      aliases: [...field.aliases].sort(),
      approvedAliases: [...field.approvedAliases].sort(),
      domains: [...field.domains.keys()],
      domainNames: [...field.domains.values()],
      groups: [...field.groups.keys()],
      groupNames: [...field.groups.values()],
      sourceGroups: [...field.sourceGroups].sort(),
      forms: [...field.forms].sort(),
      mappingStates: [...field.mappingStates].sort(),
      entryState: published ? 'published_form_field' : candidate ? 'review_only_candidate' : 'not_mapped_to_form_or_candidate',
      specificationMatch: 'not_verified_against_each_clause',
      sourceBasis: 'current_unified_field_catalog_and_published_forms',
      notes: REGISTER_NOTE,
    };
  });
}

function renderCsv(rows) {
  const values = rows.map(row => [
    row.code, row.name, row.description, row.semanticType, row.dataType, row.unit, row.dimensionCodes, row.dimensionNames,
    row.referenceCodes, row.referenceNames, row.active, row.required, row.repeatable, row.derived, row.minimums,
    row.maximums, row.precisions, row.validations, row.sourceHeaders, row.aliases, row.approvedAliases,
    row.domains, row.domainNames, row.groups, row.groupNames, row.sourceGroups, row.forms, row.mappingStates,
    row.entryState, row.specificationMatch, row.sourceBasis, row.notes,
  ]);
  return `${HEADERS.map(csvCell).join(',')}\n${values.map(row => row.map(csvCell).join(',')).join('\n')}\n`;
}

function exportManualEntryFieldRegister(outputPath = OUTPUT_PATH) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  try {
    migrate(db);
    const rows = buildManualEntryFieldRegister(db);
    fs.writeFileSync(outputPath, renderCsv(rows), 'utf8');
    return { outputPath, fieldCount: rows.length, rows };
  } finally {
    db.close();
  }
}

if (require.main === module) {
  const { outputPath, fieldCount } = exportManualEntryFieldRegister();
  process.stdout.write(`Generated ${fieldCount} field definitions from a fresh synthetic schema: ${outputPath}\n`);
}

module.exports = { HEADERS, OUTPUT_PATH, REGISTER_NOTE, buildManualEntryFieldRegister, exportManualEntryFieldRegister, renderCsv };
