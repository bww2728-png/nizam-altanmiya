'use strict';

const crypto = require('node:crypto');
const { INDICATORS, INPUT_FIELDS, FIELD_BY_COLUMN, TEMPLATE, CALIBRATION } = require('./schema.cjs');

const MIGRATION_VERSION = 1;
const MIGRATION_CODE = 'indicator-calculation-lineage-v1';
const ALGORITHM_VERSION = 'development-analysis-v1';
const MIGRATION_SQL = `
  CREATE TABLE IF NOT EXISTS indicator_calculation_schema_migrations (
    version INTEGER PRIMARY KEY,
    migration_code TEXT NOT NULL UNIQUE,
    checksum TEXT NOT NULL,
    applied_at TEXT NOT NULL,
    success INTEGER NOT NULL CHECK(success IN (0,1)),
    details TEXT
  );
  CREATE TABLE IF NOT EXISTS analysis_calculation_run_links (
    legacy_analysis_run_id INTEGER NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
    calculation_run_id INTEGER NOT NULL REFERENCES indicator_calculation_runs(calculation_run_id) ON DELETE CASCADE,
    run_mode TEXT NOT NULL CHECK(run_mode IN ('replica','calibrated')),
    created_at TEXT NOT NULL,
    PRIMARY KEY(legacy_analysis_run_id,run_mode),
    UNIQUE(calculation_run_id)
  );
  CREATE TABLE IF NOT EXISTS analysis_calculation_result_links (
    legacy_analysis_result_id INTEGER NOT NULL REFERENCES analysis_results(id) ON DELETE CASCADE,
    calculation_result_id INTEGER NOT NULL REFERENCES indicator_calculation_results(calculation_result_id) ON DELETE CASCADE,
    run_mode TEXT NOT NULL CHECK(run_mode IN ('replica','calibrated')),
    created_at TEXT NOT NULL,
    PRIMARY KEY(legacy_analysis_result_id,run_mode),
    UNIQUE(calculation_result_id)
  );
  CREATE INDEX IF NOT EXISTS idx_analysis_calculation_result_legacy ON analysis_calculation_result_links(legacy_analysis_result_id,run_mode);
`;

function checksum() {
  const definitions = INDICATORS.map(indicator => ({
    code: indicator.code,
    formula: indicator.formula,
    direction: indicator.direction,
    unit: indicator.unit ?? null,
    benchmark: indicator.benchmark ?? null,
    anchors: indicator.anchors ?? null,
  }));
  return crypto.createHash('sha256').update(MIGRATION_SQL + JSON.stringify({ MIGRATION_VERSION, MIGRATION_CODE, definitions })).digest('hex');
}

function tableColumns(database, table) {
  return new Set(database.prepare(`PRAGMA table_info(${table})`).all().map(column => column.name));
}

function ensureColumn(database, table, name, definition) {
  if (tableColumns(database, table).has(name)) return;
  database.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function getInputColumns(indicator) {
  return [...new Set((indicator.formula.match(/\b[A-Z]{1,3}\b/g) ?? []).filter(column => FIELD_BY_COLUMN[column]))];
}

function seedDefinitions(database, now) {
  const getDefinition = database.prepare('SELECT id,formula_json FROM indicator_definitions WHERE code=?');
  const getVersion = database.prepare('SELECT indicator_version_id,definition_json,formula_version FROM indicator_definition_versions WHERE indicator_id=? ORDER BY version_number DESC LIMIT 1');
  const insertVersion = database.prepare(`INSERT INTO indicator_definition_versions
    (indicator_id,version_number,definition_json,methodology,formula_version,change_reason,created_at)
    VALUES(?,1,?,?,?,?,?)`);
  const getField = database.prepare('SELECT field_definition_id FROM field_definitions WHERE field_code=?');
  const insertComponent = database.prepare(`INSERT INTO indicator_components
    (indicator_version_id,component_code,component_role,field_definition_id,expression,is_required,sort_order)
    VALUES(?,?,'input',?,?,1,?) ON CONFLICT(indicator_version_id,component_code) DO NOTHING`);

  for (const [index, indicator] of INDICATORS.entries()) {
    const definition = getDefinition.get(indicator.code);
    if (!definition) throw new Error(`تعريف المؤشر المعياري غير موجود: ${indicator.code}`);
    let storedFormula;
    try {
      storedFormula = JSON.parse(definition.formula_json ?? '{}').formula;
    } catch {
      storedFormula = null;
    }
    if (storedFormula !== indicator.formula) throw new Error(`صيغة المؤشر ${indicator.code} لا تطابق الصيغة المعيارية؛ يلزم ترحيل إصدار تعريف جديد.`);

    let version = getVersion.get(definition.id);
    const definitionJson = {
      code: indicator.code,
      labelAr: indicator.header,
      unit: indicator.unit ?? null,
      formula: indicator.formula,
      formulaVersion: TEMPLATE.version,
      direction: indicator.direction,
      defaultWeight: indicator.weight,
      benchmark: indicator.benchmark ?? null,
      launch: indicator.launch ?? null,
      anchors: indicator.anchors ?? null,
      inputFields: getInputColumns(indicator).map(column => ({ column, fieldCode: `directorate.${FIELD_BY_COLUMN[column].key}` })),
    };
    if (!version) {
      const versionId = Number(insertVersion.run(
        definition.id,
        JSON.stringify(definitionJson),
        'صيغة القالب المحدث V3.3؛ تُحفظ القيم والأوزان في كل تشغيل دون تعديل منهجية الحساب.',
        TEMPLATE.version,
        'تسجيل الصيغة الحالية كإصدار قابل لإعادة الإنتاج دون تغييرها.',
        now,
      ).lastInsertRowid);
      version = { indicator_version_id: versionId, definition_json: JSON.stringify(definitionJson), formula_version: TEMPLATE.version };
    }
    let storedVersion;
    try {
      storedVersion = JSON.parse(version.definition_json);
    } catch {
      storedVersion = null;
    }
    if (!storedVersion || storedVersion.formula !== indicator.formula) throw new Error(`إصدار تعريف المؤشر ${indicator.code} لا يطابق المحرك الحالي.`);

    for (const [componentIndex, column] of getInputColumns(indicator).entries()) {
      const fieldCode = `directorate.${FIELD_BY_COLUMN[column].key}`;
      const field = getField.get(fieldCode);
      if (!field) throw new Error(`تعريف حقل صيغة المؤشر غير موجود: ${fieldCode}`);
      insertComponent.run(version.indicator_version_id, fieldCode, field.field_definition_id, `عمود القالب ${column}`, componentIndex);
    }
  }
}

function migrate(database) {
  const sourceChecksum = checksum();
  database.exec(`CREATE TABLE IF NOT EXISTS indicator_calculation_schema_migrations (
    version INTEGER PRIMARY KEY,
    migration_code TEXT NOT NULL UNIQUE,
    checksum TEXT NOT NULL,
    applied_at TEXT NOT NULL,
    success INTEGER NOT NULL CHECK(success IN (0,1)),
    details TEXT
  )`);
  const previous = database.prepare('SELECT checksum,success FROM indicator_calculation_schema_migrations WHERE version=? AND migration_code=?')
    .get(MIGRATION_VERSION, MIGRATION_CODE);
  if (previous?.success === 1) {
    if (previous.checksum !== sourceChecksum) throw new Error(`ترحيل ${MIGRATION_CODE} عُدّل بعد تطبيقه؛ أنشئ إصدار ترحيل جديداً.`);
    return { version: MIGRATION_VERSION, alreadyApplied: true };
  }

  const now = new Date().toISOString();
  try {
    const apply = database.transaction(() => {
      if (previous) database.prepare('DELETE FROM indicator_calculation_schema_migrations WHERE version=? AND success=0').run(MIGRATION_VERSION);
      database.exec(MIGRATION_SQL);
      ensureColumn(database, 'indicator_result_inputs', 'record_field_value_id', 'INTEGER REFERENCES record_field_values(record_field_value_id) ON DELETE SET NULL');
      ensureColumn(database, 'indicator_result_inputs', 'field_definition_id', 'INTEGER REFERENCES field_definitions(field_definition_id) ON DELETE SET NULL');
      ensureColumn(database, 'indicator_result_inputs', 'input_value_text', 'TEXT');
      ensureColumn(database, 'indicator_result_inputs', 'input_value_boolean', 'INTEGER CHECK(input_value_boolean IS NULL OR input_value_boolean IN (0,1))');
      database.exec('CREATE INDEX IF NOT EXISTS idx_indicator_result_inputs_record_value ON indicator_result_inputs(record_field_value_id)');
      seedDefinitions(database, now);
      const foreignKeys = database.pragma('foreign_key_check');
      if (foreignKeys.length) throw new Error(`مخالفة مفتاح خارجي بترحيل المؤشرات: ${JSON.stringify(foreignKeys.slice(0,8))}`);
      database.prepare(`INSERT INTO indicator_calculation_schema_migrations(version,migration_code,checksum,applied_at,success,details)
        VALUES(?,?,?,?,1,?)`).run(MIGRATION_VERSION, MIGRATION_CODE, sourceChecksum, now,
        'تفعيل نسخ تشغيلات المؤشرات ومدخلاتها إلى المخطط الموحد مع روابط توافق صريحة.');
    });
    if (database.inTransaction) apply();
    else apply.exclusive();
    return { version: MIGRATION_VERSION, alreadyApplied: false };
  } catch (error) {
    database.prepare(`INSERT OR REPLACE INTO indicator_calculation_schema_migrations(version,migration_code,checksum,applied_at,success,details)
      VALUES(?,?,?,?,0,?)`).run(MIGRATION_VERSION, MIGRATION_CODE, sourceChecksum, new Date().toISOString(), String(error.message).slice(0,4000));
    throw error;
  }
}

function resolvePeriodId(database, periodKey) {
  const key = String(periodKey ?? '').trim();
  if (!key) return null;
  const period = database.prepare('SELECT period_id FROM periods WHERE period_code=? OR CAST(year_gregorian AS TEXT)=? ORDER BY period_id LIMIT 1').get(key, key);
  if (!period) throw new Error(`الفترة ${key} غير معرفة في مرجع الفترات؛ لم يُحفظ تشغيل المؤشر.`);
  return Number(period.period_id);
}

function latestLinkedRecord(database, legacyDirectorateId, periodId) {
  return database.prepare(`SELECT record.form_record_id,record.geo_unit_id,record.period_id
    FROM form_record_legacy_links link JOIN form_records record USING(form_record_id)
    WHERE link.legacy_entity_type='directorate' AND link.legacy_entity_id=? AND record.record_status='approved'
      AND ((? IS NULL AND record.period_id IS NULL) OR record.period_id=?
        OR EXISTS(SELECT 1 FROM observations observation WHERE observation.form_record_id=record.form_record_id AND observation.period_id=?))
    ORDER BY CASE WHEN record.period_id=? THEN 0 ELSE 1 END,coalesce(record.approved_at,record.updated_at) DESC,record.form_record_id DESC LIMIT 1`)
    .get(legacyDirectorateId, periodId, periodId, periodId, periodId);
}

function approvedRecordByIdentity(database, row, periodId) {
  const matches = database.prepare(`SELECT record.form_record_id,record.geo_unit_id,record.period_id
    FROM form_records record JOIN form_versions version USING(form_version_id) JOIN form_definitions form USING(form_id)
    JOIN geographic_units unit ON unit.geo_unit_id=record.geo_unit_id
    LEFT JOIN geographic_units parent ON parent.geo_unit_id=unit.parent_geo_unit_id
    WHERE form.form_code='legacy_directorate_v1' AND record.record_status='approved'
      AND unit.name_ar=? AND coalesce(parent.name_ar,'')=?
      AND ((? IS NULL AND record.period_id IS NULL) OR record.period_id=?
        OR EXISTS(SELECT 1 FROM observations observation WHERE observation.form_record_id=record.form_record_id AND observation.period_id=?))
    ORDER BY CASE WHEN record.period_id=? THEN 0 ELSE 1 END,coalesce(record.approved_at,record.updated_at) DESC,record.form_record_id DESC LIMIT 2`)
    .all(String(row.districtName ?? '').trim(), String(row.governorate ?? '').trim(), periodId, periodId, periodId, periodId);
  if (matches.length > 1) throw new Error(`تعذر تمييز أكثر من سجل معياري معتمد باسم ${row.districtName} في ${row.governorate}.`);
  return matches[0] ?? null;
}

function inputEvidence(database, record, periodId) {
  return database.prepare(`
    SELECT field.field_code,observation.observation_id,NULL AS record_field_value_id,observation.field_definition_id,
      coalesce(observation.value_integer,observation.value_real) AS input_number,observation.value_text,NULL AS input_boolean,
      observation.value_state,observation.source_id,provenance.source_locator,provenance.original_value_text,provenance.normalized_value_text,
      provenance.provenance_id,1 AS evidence_priority,observation.updated_at AS evidence_updated_at,observation.observation_id AS evidence_key
    FROM observations observation JOIN form_fields field USING(form_field_id)
    LEFT JOIN value_provenance provenance ON provenance.observation_id=observation.observation_id
    WHERE observation.form_record_id=? AND ((? IS NULL AND observation.period_id IS NULL) OR observation.period_id=?)
    UNION ALL
    SELECT field.field_code,NULL AS observation_id,value.record_field_value_id,field.field_definition_id,
      NULL AS input_number,value.value_text,value.value_boolean,value.value_state,provenance.source_id,provenance.source_locator,
      coalesce(provenance.original_value_text,value.raw_value_text),coalesce(provenance.normalized_value_text,value.normalized_value_text),
      provenance.provenance_id,2 AS evidence_priority,value.updated_at AS evidence_updated_at,value.record_field_value_id AS evidence_key
    FROM record_field_values value JOIN form_fields field USING(form_field_id) JOIN form_records record USING(form_record_id)
    LEFT JOIN value_provenance provenance ON provenance.record_field_value_id=value.record_field_value_id
    WHERE value.form_record_id=? AND ((? IS NULL AND record.period_id IS NULL) OR record.period_id=?
      OR EXISTS(SELECT 1 FROM observations observation WHERE observation.form_record_id=record.form_record_id AND observation.period_id=?))
    ORDER BY evidence_priority,evidence_updated_at DESC,evidence_key DESC
  `).all(record.form_record_id, periodId, periodId, record.form_record_id, periodId, periodId, periodId);
}

function numericOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function stateForInput(value, evidence, fieldType) {
  if (evidence?.value_state && !['known','zero'].includes(evidence.value_state)) return evidence.value_state;
  if (value === null || value === undefined || value === '') return evidence?.value_state && evidence.value_state !== 'known' ? evidence.value_state : 'not_collected';
  if (fieldType !== 'boolean' && (Number(value) === 0 || value === '0')) return 'zero';
  return evidence?.value_state ?? 'known';
}

function insertWeightProfile(database, runId, runMode, weights, now) {
  const profileCode = `analysis-run-${runId}-${runMode}`;
  database.prepare(`INSERT INTO indicator_weight_profiles(profile_code,profile_name,description,methodology,is_active,created_at)
    VALUES(?,?,?,?,0,?)`).run(
    profileCode,
    `تشغيل التحليل ${runId} — ${runMode}`,
    `نسخة الأوزان المستخدمة فعلياً في تشغيل التحليل ${runId}. غير معتمدة كمنهجية مستقلة.`,
    `template=${TEMPLATE.version}; mode=${runMode}; approval=not-recorded`,
    now,
  );
  const profileId = Number(database.prepare('SELECT weight_profile_id FROM indicator_weight_profiles WHERE profile_code=?').get(profileCode).weight_profile_id);
  const insertWeight = database.prepare(`INSERT INTO indicator_weights(weight_profile_id,indicator_id,weight_value,rationale)
    VALUES(?,?,?,'قيمة محفوظة كما استخدمت في تشغيل التحليل؛ لا تسجل اعتماداً منهجياً.')`);
  const getIndicator = database.prepare('SELECT id FROM indicator_definitions WHERE code=?');
  for (const indicator of INDICATORS) {
    const definition = getIndicator.get(indicator.code);
    const weight = Number(weights[indicator.code]);
    if (!definition || !Number.isFinite(weight) || weight < 0) throw new Error(`وزن أو تعريف غير صالح للمؤشر ${indicator.code}.`);
    insertWeight.run(profileId, definition.id, weight);
  }
  return profileId;
}

function calculationRunParameters(analysis, mode, legacyRunId, weightProfileId, periodId, filter) {
  return {
    legacyRunId,
    runMode: mode,
    templateVersion: TEMPLATE.version,
    algorithmVersion: ALGORITHM_VERSION,
    weightProfileId,
    weights: analysis.meta?.weights ?? {},
    kThreshold: analysis.meta?.kThreshold ?? CALIBRATION.kThreshold,
    deprivationLine: analysis.meta?.deprivationLine ?? CALIBRATION.deprivationLine,
    minWeightCoverage: analysis.meta?.minWeightCoverage ?? CALIBRATION.minWeightCoverage,
    periodId,
    filter: filter ?? {},
    indicatorDefinitionVersions: INDICATORS.map(indicator => ({ code: indicator.code, version: 1 })),
  };
}

function persistCalculationRuns(database, { legacyRunId, analysis, legacyResults, filter = {}, createdAt = new Date().toISOString() }) {
  const weights = analysis.meta?.weights ?? {};
  const periodId = resolvePeriodId(database, filter.periodKey);
  const inputSnapshot = [];
  const evidenceByResultId = new Map();
  const recordsByResultId = new Map();
  for (const item of legacyResults) {
    const legacyId = Number(item.legacyDirectorateId);
    const hasLegacyId = Number.isSafeInteger(legacyId) && legacyId > 0;
    const record = (hasLegacyId ? latestLinkedRecord(database, legacyId, periodId) : null) ?? approvedRecordByIdentity(database, item.row, periodId);
    if (!record || !Number(record.geo_unit_id)) throw new Error(`السجل المعياري المعتمد أو موقعه الجغرافي غير موجود للمديرية ${item.row.districtName}.`);
    recordsByResultId.set(item.legacyResultId, record);
    const evidence = inputEvidence(database, record, periodId);
    const map = new Map();
    for (const value of evidence) {
      if (!map.has(value.field_code)) map.set(value.field_code, value);
    }
    evidenceByResultId.set(item.legacyResultId, map);
    inputSnapshot.push({
      legacyId: hasLegacyId ? legacyId : null,
      legacyResultId: item.legacyResultId,
      formRecordId: record.form_record_id,
      geoUnitId: record.geo_unit_id,
      values: Object.fromEntries(INPUT_FIELDS.map(field => [field.key, item.row.values?.[field.key] ?? null])),
      evidence: [...map.values()].map(value => ({ fieldCode: value.field_code, valueState: value.value_state, sourceId: value.source_id, sourceLocator: value.source_locator, originalValue: value.original_value_text, normalizedValue: value.normalized_value_text })),
    });
  }
  const inputSnapshotHash = crypto.createHash('sha256').update(stableStringify(inputSnapshot)).digest('hex');
  const insertRun = database.prepare(`INSERT INTO indicator_calculation_runs
    (weight_profile_id,period_id,run_mode,algorithm_version,input_snapshot_hash,parameters_json,started_by,started_at,completed_at,run_status)
    VALUES(?,?,?,?,?,?,NULL,?,?, 'completed')`);
  const insertRunLink = database.prepare('INSERT INTO analysis_calculation_run_links(legacy_analysis_run_id,calculation_run_id,run_mode,created_at) VALUES(?,?,?,?)');
  const insertResult = database.prepare(`INSERT INTO indicator_calculation_results
    (calculation_run_id,indicator_id,geo_unit_id,raw_value,normalized_value,weighted_value,composite_score,rank_value,confidence_level,coverage_ratio,missing_inputs_json,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insertResultLink = database.prepare(`INSERT INTO analysis_calculation_result_links
    (legacy_analysis_result_id,calculation_result_id,run_mode,created_at) VALUES(?,?,?,?)`);
  const insertInput = database.prepare(`INSERT INTO indicator_result_inputs
    (calculation_result_id,observation_id,source_indicator_result_id,input_role,input_value,input_state,transformation_json,source_id,source_locator,created_at,record_field_value_id,field_definition_id,input_value_text,input_value_boolean)
    VALUES(?,?,NULL,?,?,?,?,?,?,?,?,?,?,?)`);
  const getIndicator = database.prepare('SELECT id FROM indicator_definitions WHERE code=?');
  const getComponentVersion = database.prepare(`SELECT version.indicator_version_id FROM indicator_definition_versions version
    JOIN indicator_definitions definition ON definition.id=version.indicator_id WHERE definition.code=? ORDER BY version.version_number DESC LIMIT 1`);
  const getField = database.prepare('SELECT field_definition_id FROM field_definitions WHERE field_code=?');
  const getFormValue = database.prepare(`SELECT field.form_field_id,field.field_definition_id,field.unit_id FROM form_fields field
    JOIN form_versions version USING(form_version_id) JOIN form_definitions form USING(form_id)
    WHERE form.form_code='legacy_directorate_v1' AND field.field_code=? ORDER BY version.version_number DESC LIMIT 1`);
  const runIds = {};
  const resultRows = new Map(legacyResults.map(item => [item.legacyResultId, item]));

  for (const mode of ['replica','calibrated']) {
    const profileId = insertWeightProfile(database, legacyRunId, mode, weights, createdAt);
    const parameters = calculationRunParameters(analysis, mode, legacyRunId, profileId, periodId, filter);
    const runInfo = insertRun.run(profileId, periodId, mode, ALGORITHM_VERSION, inputSnapshotHash, JSON.stringify(parameters), createdAt, createdAt);
    const calculationRunId = Number(runInfo.lastInsertRowid);
    runIds[mode] = calculationRunId;
    insertRunLink.run(legacyRunId, calculationRunId, mode, createdAt);
    for (const item of legacyResults) {
      const record = recordsByResultId.get(item.legacyResultId);
      const inputs = evidenceByResultId.get(item.legacyResultId);
      const row = item.row;
      const calculated = mode === 'replica' ? row.replica : row.calibrated;
      const indicatorMissing = INDICATORS.filter(indicator => typeof row.indicators?.[indicator.code] !== 'number').map(indicator => indicator.code);
      const coverage = mode === 'replica'
        ? (Number(calculated?.numericCount ?? 0) / INDICATORS.length)
        : numericOrNull(calculated?.weightCoverage);
      const aggregateDetails = {
        mode,
        severe: Boolean(row.calibrated?.severe),
        degradedCount: row.calibrated?.degradedCount ?? null,
        blocked: Boolean(row.calibrated?.blocked),
        blockReason: row.calibrated?.blockReason ?? null,
        weightCoverage: row.calibrated?.weightCoverage ?? null,
        numericIndicatorCount: row.replica?.numericCount ?? 0,
        missingIndicators: indicatorMissing,
        completeness: row.completeness?.ratio ?? null,
      };
      const aggregateResultId = Number(insertResult.run(
        calculationRunId, null, record.geo_unit_id, null, null, null,
        numericOrNull(calculated?.composite), calculated?.rank ?? null, row.confidence?.level ?? null,
        coverage, JSON.stringify(aggregateDetails), createdAt,
      ).lastInsertRowid);
      insertResultLink.run(item.legacyResultId, aggregateResultId, mode, createdAt);

      for (const indicator of INDICATORS) {
        const indicatorDefinition = getIndicator.get(indicator.code);
        const indicatorVersion = getComponentVersion.get(indicator.code);
        if (!indicatorDefinition || !indicatorVersion) throw new Error(`تعريف أو إصدار المؤشر غير موجود: ${indicator.code}`);
        const code = indicator.code;
        const rawValue = numericOrNull(row.indicators?.[code]);
        const replicaContribution = row.replica?.contributions?.[code];
        const calibratedContribution = row.calibrated?.contributions?.[code];
        const normalizedValue = mode === 'replica'
          ? numericOrNull(replicaContribution?.normalized)
          : numericOrNull(row.calibrated?.scores?.[code]);
        const weightedValue = mode === 'replica'
          ? numericOrNull(replicaContribution?.contribution)
          : numericOrNull(calibratedContribution?.contribution);
        const missing = rawValue === null ? getInputColumns(indicator).map(column => FIELD_BY_COLUMN[column].key) : [];
        const resultId = Number(insertResult.run(
          calculationRunId, indicatorDefinition.id, record.geo_unit_id, rawValue, normalizedValue, weightedValue,
          null, null, null, null, missing.length ? JSON.stringify({ missingInputFields: missing }) : null, createdAt,
        ).lastInsertRowid);

        for (const column of getInputColumns(indicator)) {
          const field = FIELD_BY_COLUMN[column];
          const fieldCode = `directorate.${field.key}`;
          const fieldDefinition = getField.get(fieldCode);
          const formField = getFormValue.get(fieldCode);
          if (!fieldDefinition || !formField) throw new Error(`حقل مدخل المؤشر غير مربوط بالقاموس: ${fieldCode}`);
          const source = inputs.get(fieldCode) ?? null;
          const inputValue = row.values?.[field.key] ?? null;
          const textValue = inputValue === null || inputValue === undefined ? null : String(inputValue);
          const booleanValue = field.type === 'boolean' && inputValue !== null && inputValue !== undefined ? (Number(inputValue) ? 1 : 0) : null;
          const numberValue = field.type === 'number' || field.type === 'ratio' || field.type === 'boolean' ? numericOrNull(inputValue) : null;
          if (inputValue !== null && inputValue !== undefined && !source) throw new Error(`تعذر تتبع مدخل المؤشر إلى سجل القيم: ${fieldCode}، المديرية ${row.districtName}.`);
          const transformation = {
            fieldCode,
            fieldDefinitionId: fieldDefinition.field_definition_id,
            formFieldId: formField.form_field_id,
            sourceFormRecordId: record.form_record_id,
            formula: indicator.formula,
            formulaVersion: TEMPLATE.version,
            rawSourceValue: source?.original_value_text ?? source?.normalized_value_text ?? textValue,
            normalizedStoredValue: inputValue,
            engineValue: inputValue,
            mode,
            replicaMissingAsZero: mode === 'replica' && numberValue === null,
          };
          insertInput.run(
            resultId,
            source?.observation_id ?? null,
            field.key,
            numberValue,
            stateForInput(inputValue, source, field.type),
            JSON.stringify(transformation),
            source?.source_id ?? null,
            source?.source_locator ?? null,
            createdAt,
            source?.record_field_value_id ?? null,
            fieldDefinition.field_definition_id,
            field.type === 'text' ? textValue : null,
            booleanValue,
          );
        }
      }
    }
  }
  return { calculationRunIds: runIds, inputSnapshotHash };
}

function hydrateCalculation(database, legacyResultId) {
  const linked = database.prepare(`SELECT link.run_mode,run.calculation_run_id,run.algorithm_version,run.input_snapshot_hash,run.parameters_json
    FROM analysis_calculation_result_links result_link
    JOIN analysis_calculation_run_links link ON link.legacy_analysis_run_id=(SELECT run_id FROM analysis_results WHERE id=result_link.legacy_analysis_result_id)
      AND link.run_mode=result_link.run_mode
    JOIN indicator_calculation_runs run USING(calculation_run_id)
    WHERE result_link.legacy_analysis_result_id=? ORDER BY result_link.run_mode`).all(legacyResultId);
  if (!linked.length) return null;
  const calculations = {};
  for (const run of linked) {
    const aggregate = database.prepare(`SELECT result.* FROM analysis_calculation_result_links link
      JOIN indicator_calculation_results result USING(calculation_result_id)
      WHERE link.legacy_analysis_result_id=? AND link.run_mode=? AND result.indicator_id IS NULL`).get(legacyResultId, run.run_mode);
    if (!aggregate) continue;
    const indicators = {};
    const components = database.prepare(`SELECT result.calculation_result_id,definition.code,result.raw_value,result.normalized_value,result.weighted_value,result.missing_inputs_json
      FROM indicator_calculation_results result JOIN indicator_definitions definition ON definition.id=result.indicator_id
      WHERE result.calculation_run_id=? AND result.geo_unit_id=? ORDER BY definition.code`).all(run.calculation_run_id, aggregate.geo_unit_id);
    for (const component of components) {
      const inputs = database.prepare(`SELECT input.input_role,input.input_value,input.input_state,input.input_value_text,input.input_value_boolean,
        input.record_field_value_id,input.field_definition_id,input.source_id,input.source_locator,input.transformation_json
        FROM indicator_result_inputs input WHERE input.calculation_result_id=? ORDER BY input.result_input_id`).all(component.calculation_result_id);
      indicators[component.code] = {
        rawValue: component.raw_value,
        normalizedValue: component.normalized_value,
        weightedValue: component.weighted_value,
        missingInputs: JSON.parse(component.missing_inputs_json || '{"missingInputFields":[]}').missingInputFields ?? [],
        inputs: inputs.map(input => ({
          fieldCode: input.input_role,
          value: input.input_value ?? input.input_value_text ?? input.input_value_boolean,
          state: input.input_state,
          recordFieldValueId: input.record_field_value_id,
          fieldDefinitionId: input.field_definition_id,
          sourceId: input.source_id,
          sourceLocator: input.source_locator,
          transformation: JSON.parse(input.transformation_json || '{}'),
        })),
      };
    }
    calculations[run.run_mode] = {
      calculationRunId: run.calculation_run_id,
      algorithmVersion: run.algorithm_version,
      inputSnapshotHash: run.input_snapshot_hash,
      parameters: JSON.parse(run.parameters_json || '{}'),
      compositeScore: aggregate.composite_score,
      rank: aggregate.rank_value,
      confidenceLevel: aggregate.confidence_level,
      coverageRatio: aggregate.coverage_ratio,
      details: JSON.parse(aggregate.missing_inputs_json || '{}'),
      indicators,
    };
  }
  return calculations;
}

module.exports = {
  MIGRATION_VERSION,
  MIGRATION_CODE,
  ALGORITHM_VERSION,
  checksum,
  migrate,
  persistCalculationRuns,
  hydrateCalculation,
};
