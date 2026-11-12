'use strict';

// ---------------------------------------------------------------------------
// Indicator catalogue service over the unified development data model.
//
// It answers catalogue questions only: which definition is current, which
// versions exist, what weights are approved, and whether a stored calculation
// run can still be reproduced from the values it recorded. It never recomputes
// an indicator with live weights and never rewrites a stored result.
//
// Every write delegates to domain-service.cjs (single audit trail), and
// multi-write operations run inside one db.transaction.
//
// Array-returning operations stay plain arrays; when a table is missing they
// return [] and attach an explicit non-enumerable `notes` array so callers can
// surface the gap without changing the documented return shape.
// ---------------------------------------------------------------------------

const domain = require('./domain-service.cjs');

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PROFILE_CODE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 200;
const TOLERANCE = 1e-9;
const KNOWN_INPUT_STATES = new Set(['known', 'zero']);

// ---------------------------------------------------------------------------
// Schema helpers.
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

function clampLimit(value, fallback = DEFAULT_LIMIT, max = MAX_LIMIT) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  const integer = Math.trunc(number);
  if (integer < 1) return fallback;
  return Math.min(max, integer);
}

function positiveId(value, label) {
  const candidate = typeof value === 'number' ? value : Number(String(value ?? '').trim());
  if (!Number.isSafeInteger(candidate) || candidate <= 0) throw new Error(`المعرّف في «${label}» غير صالح.`);
  return candidate;
}

function optionalId(value, label) {
  if (value === null || value === undefined || value === '') return null;
  return positiveId(value, label);
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function parseJson(text, fallback = null) {
  if (text === null || text === undefined || text === '') return fallback;
  if (typeof text === 'object') return text;
  try {
    const value = JSON.parse(String(text));
    return value === null || value === undefined ? fallback : value;
  } catch {
    return fallback;
  }
}

function todayDate() {
  return new Date().toISOString().slice(0, 10);
}

function escapeLike(term) {
  return String(term ?? '').replace(/[\\%_]/g, character => `\\${character}`);
}

// Keeps array return types intact while still exposing explicit gaps.
function withNotes(rows, notes) {
  if (notes.length) Object.defineProperty(rows, 'notes', { value: notes, enumerable: false, configurable: true });
  return rows;
}

// ---------------------------------------------------------------------------
// Shared catalogue SQL fragments.
// ---------------------------------------------------------------------------

// A version is "active" while its validity window is still open. Deactivation
// closes effective_to, so exactly one version per indicator can stay active.
const OPEN_VERSION_CONDITION = `(version.effective_to IS NULL
  AND (version.effective_from IS NULL OR version.effective_from <= date('now')))`;

function activeVersionSql() {
  return `(SELECT version.indicator_version_id FROM indicator_definition_versions version
    WHERE version.indicator_id = d.id AND ${OPEN_VERSION_CONDITION}
    ORDER BY version.version_number DESC, version.indicator_version_id DESC LIMIT 1)`;
}

function sectorLabelSql(db, alias = 's', hasForeignKey = true) {
  const columns = tableColumns(db, 'sectors');
  const keyColumn = ['sector_id', 'id'].find(candidate => columns.has(candidate));
  if (!keyColumn || !hasForeignKey) return { join: '', label: 'NULL', joinable: false };
  const parts = ['name_ar', 'name'].filter(column => columns.has(column)).map(column => `${alias}.${quote(column)}`);
  parts.push(`CAST(${alias}.${quote(keyColumn)} AS TEXT)`);
  return {
    join: `LEFT JOIN "sectors" ${alias} ON ${alias}.${quote(keyColumn)} = d.sector_id`,
    label: `coalesce(${parts.join(',')})`,
    joinable: true
  };
}

function sourceLabelSystem(db) {
  const columns = tableColumns(db, 'data_sources');
  if (!columns.size) return null;
  const keyColumn = ['source_id', 'id'].find(candidate => columns.has(candidate));
  if (!keyColumn) return null;
  const parts = ['document_title', 'file_name', 'source_code', 'organization_name']
    .filter(column => columns.has(column))
    .map(column => `src.${quote(column)}`);
  parts.push(`CAST(src.${quote(keyColumn)} AS TEXT)`);
  return { join: `LEFT JOIN "data_sources" src ON src.${quote(keyColumn)} = w.source_id`, label: `coalesce(${parts.join(',')})` };
}

// Geography label for a result row; null when the table/columns are absent so
// the join can be dropped without breaking the query.
function geoLabelSystem(db, fkExpression) {
  const columns = tableColumns(db, 'geographic_units');
  const keyColumn = ['geo_unit_id', 'id'].find(candidate => columns.has(candidate));
  if (!keyColumn) return null;
  const labelColumn = ['name_ar', 'name'].find(candidate => columns.has(candidate));
  return {
    join: `LEFT JOIN "geographic_units" geo ON geo.${quote(keyColumn)} = ${fkExpression}`,
    label: labelColumn ? `geo.${quote(labelColumn)}` : 'NULL'
  };
}

// ---------------------------------------------------------------------------
// 1. Catalogue listing.
// ---------------------------------------------------------------------------

function catalogue(db, request = {}) {
  requireDb(db);
  const notes = [];
  if (!tablePresent(db, 'indicator_definitions')) {
    return withNotes([], ['جدول تعريف المؤشرات (indicator_definitions) غير موجود.']);
  }
  const definitionColumns = tableColumns(db, 'indicator_definitions');
  if (!definitionColumns.has('id')) return withNotes([], ['جدول تعريف المؤشرات لا يحتوي عمود id.']);

  const hasVersions = tablePresent(db, 'indicator_definition_versions');
  if (!hasVersions) notes.push('جدول إصدارات تعريف المؤشرات غير موجود؛ عمود الإصدار الساري فارغ.');
  const hasResults = tablePresent(db, 'indicator_calculation_results');

  const sector = sectorLabelSql(db, 's', definitionColumns.has('sector_id'));
  if (!sector.joinable) notes.push('جدول القطاعات أو عمود القطاع غير متاح؛ اسم القطاع غير معروض.');

  const conditions = [];
  const params = [];

  const search = String(request.search ?? '').trim().slice(0, 120);
  if (search) {
    const pattern = `%${escapeLike(search)}%`;
    const parts = ['CAST(d.code AS TEXT) LIKE ? ESCAPE \'\\\''];
    if (definitionColumns.has('label_ar')) parts.push('CAST(d.label_ar AS TEXT) LIKE ? ESCAPE \'\\\'');
    conditions.push(`(${parts.join(' OR ')})`);
    for (let index = 0; index < parts.length; index += 1) params.push(pattern);
  }

  const sectorId = optionalId(request.sectorId, 'القطاع');
  if (sectorId !== null && definitionColumns.has('sector_id')) {
    conditions.push('d.sector_id = ?');
    params.push(sectorId);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const versionColumns = hasVersions
    ? `v.indicator_version_id AS active_version_id,
       v.version_number AS active_version_number,
       v.formula_version AS active_formula_version,
       v.effective_from AS active_effective_from`
    : `NULL AS active_version_id, NULL AS active_version_number, NULL AS active_formula_version, NULL AS active_effective_from`;

  const rows = db.prepare(`SELECT
      d.id AS indicator_id,
      d.code AS code,
      ${definitionColumns.has('label_ar') ? 'd.label_ar' : 'NULL'} AS label_ar,
      ${definitionColumns.has('sector_id') ? 'd.sector_id' : 'NULL'} AS sector_id,
      ${sector.label} AS sector_label,
      ${definitionColumns.has('unit') ? 'd.unit' : 'NULL'} AS unit,
      ${definitionColumns.has('direction') ? 'd.direction' : 'NULL'} AS direction,
      ${definitionColumns.has('active') ? 'd.active' : '1'} AS active,
      ${versionColumns},
      ${hasResults ? '(SELECT MAX(result.calculation_run_id) FROM indicator_calculation_results result WHERE result.indicator_id = d.id)' : 'NULL'} AS latest_run_id
    FROM "indicator_definitions" d
    ${sector.join}
    ${hasVersions ? `LEFT JOIN "indicator_definition_versions" v ON v.indicator_version_id = ${activeVersionSql()}` : ''}
    ${where}
    ORDER BY CAST(d.code AS TEXT) COLLATE NOCASE`).all(...params);

  // Unit label of the active version's components (falls back to the definition).
  const versionUnitLabels = new Map();
  const versionIds = rows.map(row => row.active_version_id).filter(value => value !== null && value !== undefined);
  if (versionIds.length && tablePresent(db, 'indicator_components') && tablePresent(db, 'measurement_units')) {
    const unitColumns = tableColumns(db, 'measurement_units');
    if (unitColumns.has('unit_id')) {
      const labelColumn = ['name_ar', 'unit_code'].find(column => unitColumns.has(column));
      if (labelColumn) {
        const placeholders = versionIds.map(() => '?').join(',');
        for (const row of db.prepare(`SELECT c.indicator_version_id AS version_id, u.${quote(labelColumn)} AS unit_label
          FROM indicator_components c JOIN measurement_units u ON u.unit_id = c.unit_id
          WHERE c.indicator_version_id IN (${placeholders}) AND c.unit_id IS NOT NULL
          ORDER BY c.sort_order, c.component_id`).all(...versionIds)) {
          if (!versionUnitLabels.has(Number(row.version_id))) {
            versionUnitLabels.set(Number(row.version_id), row.unit_label);
          }
        }
      }
    }
  }

  const items = rows.map(row => {
    const activeVersionId = row.active_version_id === null || row.active_version_id === undefined
      ? null
      : Number(row.active_version_id);
    return {
      indicatorId: Number(row.indicator_id),
      code: row.code ?? null,
      labelAr: row.label_ar ?? null,
      sectorId: row.sector_id === null || row.sector_id === undefined ? null : Number(row.sector_id),
      sectorLabel: row.sector_label ?? null,
      active: row.active === null || row.active === undefined ? null : Number(row.active) === 1,
      activeVersion: activeVersionId === null ? null : {
        indicatorVersionId: activeVersionId,
        versionNumber: row.active_version_number === null ? null : Number(row.active_version_number),
        formulaVersion: row.active_formula_version ?? null,
        effectiveFrom: row.active_effective_from ?? null
      },
      unitLabel: versionUnitLabels.get(activeVersionId ?? -1) ?? row.unit ?? null,
      direction: row.direction ?? null,
      latestRunId: row.latest_run_id === null || row.latest_run_id === undefined ? null : Number(row.latest_run_id)
    };
  });

  return withNotes(items, notes);
}

// ---------------------------------------------------------------------------
// 2. Definition detail with computed gaps.
// ---------------------------------------------------------------------------

function versionHasFormula(version) {
  const parsed = parseJson(version.definition_json, null);
  const formula = parsed && typeof parsed === 'object' ? parsed.formula : null;
  if (typeof formula === 'string' && formula.trim() !== '') return true;
  return version.formula_version !== null && version.formula_version !== undefined
    && String(version.formula_version).trim() !== '';
}

function definitionDetail(db, request = {}) {
  requireDb(db);
  const indicatorId = positiveId(request.indicatorId, 'المؤشر');
  const notes = [];

  const empty = {
    definition: null,
    versions: [],
    activeVersion: null,
    components: [],
    targets: [],
    benchmarks: [],
    weightProfiles: [],
    issues: [],
    notes
  };

  if (!tablePresent(db, 'indicator_definitions')) {
    notes.push('جدول تعريف المؤشرات (indicator_definitions) غير موجود.');
    return empty;
  }

  const definitionColumns = tableColumns(db, 'indicator_definitions');
  const sector = sectorLabelSql(db, 's', definitionColumns.has('sector_id'));
  if (!sector.joinable) notes.push('جدول القطاعات أو عمود القطاع غير متاح؛ اسم القطاع غير معروض.');

  const row = db.prepare(`SELECT
      d.*,
      ${sector.label} AS sector_label
    FROM "indicator_definitions" d
    ${sector.join}
    WHERE d.id = ? LIMIT 1`).get(indicatorId);
  if (!row) throw new Error('المؤشر المطلوب غير موجود.');

  const definition = {
    indicatorId: Number(row.id ?? row.indicator_id ?? indicatorId),
    code: row.code ?? null,
    labelAr: definitionColumns.has('label_ar') ? row.label_ar ?? null : null,
    sectorId: definitionColumns.has('sector_id') && row.sector_id !== null && row.sector_id !== undefined
      ? Number(row.sector_id)
      : null,
    sectorLabel: row.sector_label ?? null,
    unit: definitionColumns.has('unit') ? row.unit ?? null : null,
    direction: definitionColumns.has('direction') ? row.direction ?? null : null,
    methodology: definitionColumns.has('methodology') ? row.methodology ?? null : null,
    formulaJson: parseJson(definitionColumns.has('formula_json') ? row.formula_json : null, null),
    active: definitionColumns.has('active') && row.active !== null && row.active !== undefined
      ? Number(row.active) === 1
      : null,
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null
  };

  let versions = [];
  if (!tablePresent(db, 'indicator_definition_versions')) {
    notes.push('جدول إصدارات تعريف المؤشرات غير موجود؛ لا توجد إصدارات.');
  } else {
    const componentCounts = new Map();
    if (tablePresent(db, 'indicator_components')) {
      for (const count of db.prepare(`SELECT indicator_version_id AS version_id, COUNT(*) AS total
        FROM indicator_components GROUP BY indicator_version_id`).all()) {
        componentCounts.set(Number(count.version_id), Number(count.total));
      }
    }
    versions = db.prepare(`SELECT * FROM indicator_definition_versions
      WHERE indicator_id = ?
      ORDER BY version_number DESC, indicator_version_id DESC`).all(indicatorId).map(version => ({
        indicatorVersionId: Number(version.indicator_version_id),
        versionNumber: Number(version.version_number),
        definitionJson: parseJson(version.definition_json, null),
        formulaVersion: version.formula_version ?? null,
        methodology: version.methodology ?? null,
        effectiveFrom: version.effective_from ?? null,
        effectiveTo: version.effective_to ?? null,
        changeReason: version.change_reason ?? null,
        approvedBy: version.approved_by ?? null,
        approvedAt: version.approved_at ?? null,
        createdAt: version.created_at ?? null,
        componentCount: componentCounts.get(Number(version.indicator_version_id)) ?? 0,
        hasFormula: versionHasFormula(version),
        isActive: version.effective_to === null || version.effective_to === undefined
      }));
  }

  const today = todayDate();
  const openVersions = versions.filter(version => version.effectiveTo === null
    || version.effectiveTo === undefined
    || String(version.effectiveTo) >= today);
  // The stored deactivation model is "effective_to is null"; the date check only
  // protects against a version that was never closed but is already in the past.
  const strictlyOpen = versions.filter(version => version.effectiveTo === null || version.effectiveTo === undefined);
  const activeVersion = (strictlyOpen.length ? strictlyOpen : openVersions)
    .slice()
    .sort((left, right) => right.versionNumber - left.versionNumber)[0] ?? null;

  let components = [];
  if (activeVersion && tablePresent(db, 'indicator_components')) {
    const componentColumns = tableColumns(db, 'indicator_components');
    const fieldLabel = tablePresent(db, 'field_definitions') && tableColumns(db, 'field_definitions').has('canonical_name_ar')
      ? 'f.canonical_name_ar'
      : 'NULL';
    const unitLabel = tablePresent(db, 'measurement_units') && tableColumns(db, 'measurement_units').has('name_ar')
      ? 'u.name_ar'
      : 'NULL';
    components = db.prepare(`SELECT
        c.*,
        ${fieldLabel} AS field_label,
        ${unitLabel} AS unit_label
      FROM indicator_components c
      ${tablePresent(db, 'field_definitions') ? 'LEFT JOIN field_definitions f ON f.field_definition_id = c.field_definition_id' : ''}
      ${tablePresent(db, 'measurement_units') ? 'LEFT JOIN measurement_units u ON u.unit_id = c.unit_id' : ''}
      WHERE c.indicator_version_id = ?
      ORDER BY ${componentColumns.has('sort_order') ? 'c.sort_order,' : ''} c.component_id`).all(activeVersion.indicatorVersionId)
      .map(component => ({
        componentId: Number(component.component_id),
        componentCode: component.component_code ?? null,
        componentRole: component.component_role ?? null,
        fieldDefinitionId: component.field_definition_id === null || component.field_definition_id === undefined
          ? null
          : Number(component.field_definition_id),
        fieldLabel: component.field_label ?? null,
        sourceIndicatorId: component.source_indicator_id === null || component.source_indicator_id === undefined
          ? null
          : Number(component.source_indicator_id),
        expression: component.expression ?? null,
        unitId: component.unit_id === null || component.unit_id === undefined ? null : Number(component.unit_id),
        unitLabel: component.unit_label ?? null,
        isRequired: component.is_required === null || component.is_required === undefined
          ? null
          : Number(component.is_required) === 1,
        sortOrder: component.sort_order === null || component.sort_order === undefined
          ? null
          : Number(component.sort_order)
      }));
  }

  let targets = [];
  if (!tablePresent(db, 'indicator_targets')) {
    notes.push('جدول مستهدفات المؤشرات غير موجود.');
  } else {
    const targetColumns = tableColumns(db, 'indicator_targets');
    const canPeriod = tablePresent(db, 'periods') && targetColumns.has('period_id');
    const canGeo = tablePresent(db, 'geographic_units') && targetColumns.has('geo_unit_id');
    const canUnit = tablePresent(db, 'measurement_units') && targetColumns.has('unit_id');
    const periodLabel = canPeriod && tableColumns(db, 'periods').has('label_ar') ? 'p.label_ar' : 'NULL';
    const geoColumn = canGeo
      ? ['name_ar', 'name'].find(column => tableColumns(db, 'geographic_units').has(column))
      : null;
    const geoLabel = geoColumn ? `g.${geoColumn}` : 'NULL';
    const unitName = canUnit && tableColumns(db, 'measurement_units').has('name_ar') ? 'u.name_ar' : 'NULL';
    const targetOrder = targetColumns.has('period_id')
      ? 't.period_id DESC, t.indicator_target_id'
      : 't.indicator_target_id';
    targets = db.prepare(`SELECT
        t.*,
        ${periodLabel} AS period_label,
        ${geoLabel} AS geo_label,
        ${unitName} AS unit_label
      FROM indicator_targets t
      ${canPeriod ? 'LEFT JOIN periods p ON p.period_id = t.period_id' : ''}
      ${canGeo ? 'LEFT JOIN geographic_units g ON g.geo_unit_id = t.geo_unit_id' : ''}
      ${canUnit ? 'LEFT JOIN measurement_units u ON u.unit_id = t.unit_id' : ''}
      WHERE t.indicator_id = ?
      ORDER BY ${targetOrder}`).all(indicatorId)
      .map(target => ({
        indicatorTargetId: Number(target.indicator_target_id),
        periodId: target.period_id === null || target.period_id === undefined ? null : Number(target.period_id),
        periodLabel: target.period_label ?? null,
        geoUnitId: target.geo_unit_id === null || target.geo_unit_id === undefined ? null : Number(target.geo_unit_id),
        geoLabel: target.geo_label ?? null,
        targetValue: numberOrNull(target.target_value),
        targetType: target.target_type ?? null,
        unitId: target.unit_id === null || target.unit_id === undefined ? null : Number(target.unit_id),
        unitLabel: target.unit_label ?? null,
        notes: target.notes ?? null
      }));
  }

  let benchmarks = [];
  if (!tablePresent(db, 'indicator_benchmarks')) {
    notes.push('جدول القيم المرجعية للمؤشرات غير موجود.');
  } else {
    benchmarks = db.prepare(`SELECT * FROM indicator_benchmarks
      WHERE indicator_id = ? ORDER BY benchmark_id`).all(indicatorId)
      .map(benchmark => ({
        benchmarkId: Number(benchmark.benchmark_id),
        benchmarkType: benchmark.benchmark_type ?? null,
        geographyTypeId: benchmark.geography_type_id === null || benchmark.geography_type_id === undefined
          ? null
          : Number(benchmark.geography_type_id),
        valueNumber: numberOrNull(benchmark.value_number),
        validFrom: benchmark.valid_from ?? null,
        validTo: benchmark.valid_to ?? null,
        rationale: benchmark.rationale ?? null
      }));
  }

  let weightProfiles = [];
  if (!tablePresent(db, 'indicator_weight_profiles') || !tablePresent(db, 'indicator_weights')) {
    notes.push('جداول ملفات الأوزان غير متاحة؛ لا توجد أوزان معروضة.');
  } else {
    weightProfiles = db.prepare(`SELECT
        p.weight_profile_id, p.profile_code, p.profile_name, p.approved_by, p.approved_at, p.is_active,
        w.weight_value,
        (SELECT COUNT(*) AS total FROM indicator_weights w2 WHERE w2.weight_profile_id = p.weight_profile_id) AS indicator_count,
        (SELECT SUM(w2.weight_value) FROM indicator_weights w2 WHERE w2.weight_profile_id = p.weight_profile_id) AS weight_sum
      FROM indicator_weights w
      JOIN indicator_weight_profiles p ON p.weight_profile_id = w.weight_profile_id
      WHERE w.indicator_id = ?
      ORDER BY p.weight_profile_id`).all(indicatorId)
      .map(profile => {
        const weightSum = numberOrNull(profile.weight_sum);
        return {
          profileId: Number(profile.weight_profile_id),
          code: profile.profile_code ?? null,
          nameAr: profile.profile_name ?? null,
          approvedBy: profile.approved_by ?? null,
          approvedAt: profile.approved_at ?? null,
          isActive: profile.is_active === null || profile.is_active === undefined ? null : Number(profile.is_active) === 1,
          indicatorCount: Number(profile.indicator_count ?? 0),
          weight: numberOrNull(profile.weight_value),
          weightSum,
          valid: weightSum !== null && Math.abs(weightSum - 1) < TOLERANCE
        };
      });
  }

  // Issues are computed from what is stored; nothing is invented.
  const issues = [];
  if (!versions.length) {
    issues.push({ code: 'no-versions', severity: 'high', message: 'لا يوجد أي إصدار تعريف محفوظ لهذا المؤشر.' });
  }
  if (strictlyOpen.length > 1) {
    issues.push({
      code: 'multiple-active-versions',
      severity: 'high',
      message: `يوجد ${strictlyOpen.length} إصداراً مفتوحاً لنفس المؤشر؛ يجب أن يبقى إصدار ساري واحد.`,
      subject: strictlyOpen.map(version => version.indicatorVersionId)
    });
  }
  if (versions.length && !activeVersion) {
    issues.push({ code: 'no-active-version', severity: 'high', message: 'كل الإصدارات مغلقة؛ لا يوجد إصدار ساري.' });
  }
  if (activeVersion && !activeVersion.hasFormula) {
    issues.push({
      code: 'active-version-without-formula',
      severity: 'high',
      message: 'الإصدار الساري لا يحمل صيغة ولا إصدار معادلة.',
      subject: activeVersion.indicatorVersionId
    });
  }
  if (activeVersion && !components.length) {
    issues.push({
      code: 'no-components',
      severity: 'medium',
      message: 'الإصدار الساري بلا مكونات معادلة مسجلة.',
      subject: activeVersion.indicatorVersionId
    });
  }
  if (!targets.length) {
    issues.push({ code: 'no-targets', severity: 'medium', message: 'لا توجد مستهدفات مسجلة للمؤشر.' });
  }
  if (!benchmarks.length) {
    issues.push({ code: 'no-benchmarks', severity: 'low', message: 'لا توجد قيمة مرجعية (benchmark) مسجلة للمؤشر.' });
  }
  for (const profile of weightProfiles) {
    if (profile.valid) continue;
    issues.push({
      code: 'weight-sum-not-one',
      severity: 'high',
      message: `مجموع أوزان الملف ${profile.code ?? profile.profileId} لا يساوي 1.`,
      subject: { profileId: profile.profileId, weightSum: profile.weightSum }
    });
  }
  if (definition.active === false) {
    issues.push({ code: 'definition-inactive', severity: 'info', message: 'تعريف المؤشر غير مفعّل.' });
  }

  return {
    definition,
    versions,
    activeVersion,
    components,
    targets,
    benchmarks,
    weightProfiles,
    issues,
    notes
  };
}

// ---------------------------------------------------------------------------
// 3. Additive versioning.
// ---------------------------------------------------------------------------

// A version that stored computation results can never be edited in place.
function storedResultCount(db, indicatorId) {
  if (!tablePresent(db, 'indicator_calculation_results')) return 0;
  return Number(db.prepare('SELECT COUNT(*) AS total FROM indicator_calculation_results WHERE indicator_id = ?')
    .get(indicatorId).total ?? 0);
}

function normaliseVersionPayload(payload, nextVersionNumber, fallbackDate) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('بيانات الإصدار غير صالحة.');
  }
  const values = {};

  const rawDefinition = payload.definition_json ?? payload.definition;
  if (typeof rawDefinition === 'string' && rawDefinition.trim() !== '') {
    const parsed = parseJson(rawDefinition, undefined);
    if (parsed === undefined) throw new Error('تعريف الإصدار (definition_json) ليس JSON صالحاً.');
    values.definition_json = JSON.stringify(parsed);
  } else if (rawDefinition && typeof rawDefinition === 'object' && !Array.isArray(rawDefinition)) {
    values.definition_json = JSON.stringify(rawDefinition);
  } else {
    throw new Error('تعريف الإصدار (definition_json أو definition) مطلوب.');
  }

  const versionNumber = payload.version_number ?? payload.versionNumber ?? nextVersionNumber;
  values.version_number = positiveId(versionNumber, 'رقم الإصدار');

  values.effective_from = payload.effective_from ?? payload.effectiveFrom ?? fallbackDate;
  const effectiveTo = payload.effective_to ?? payload.effectiveTo ?? null;
  if (effectiveTo !== null && effectiveTo !== undefined && effectiveTo !== '') values.effective_to = String(effectiveTo);

  for (const [source, target] of [
    ['methodology', 'methodology'],
    ['formula_version', 'formula_version'],
    ['formulaVersion', 'formula_version'],
    ['change_reason', 'change_reason'],
    ['changeReason', 'change_reason'],
    ['approved_by', 'approved_by'],
    ['approvedBy', 'approved_by'],
    ['approved_at', 'approved_at'],
    ['approvedAt', 'approved_at']
  ]) {
    if (payload[source] === undefined) continue;
    const value = payload[source];
    if (value === null || value === '') continue;
    values[target] = value;
  }

  return values;
}

function saveVersion(db, request = {}) {
  requireDb(db);
  const indicatorId = positiveId(request.indicatorId, 'المؤشر');
  if (!tablePresent(db, 'indicator_definitions')) throw new Error('جدول تعريف المؤشرات غير موجود.');
  if (!tablePresent(db, 'indicator_definition_versions')) throw new Error('جدول إصدارات تعريف المؤشرات غير موجود.');
  if (!db.prepare('SELECT 1 AS hit FROM indicator_definitions WHERE id = ?').get(indicatorId)) {
    throw new Error('المؤشر المطلوب غير موجود.');
  }

  const payload = request.payload && typeof request.payload === 'object' && !Array.isArray(request.payload)
    ? request.payload
    : {};
  const notes = [];
  const results = storedResultCount(db, indicatorId);
  const editingId = payload.indicator_version_id ?? payload.indicatorVersionId ?? null;

  if (editingId !== null && editingId !== undefined) {
    const existing = db.prepare(`SELECT * FROM indicator_definition_versions
      WHERE indicator_version_id = ? AND indicator_id = ?`).get(positiveId(editingId, 'إصدار المؤشر'), indicatorId);
    if (!existing) throw new Error('إصدار المؤشر المطلوب تعديله غير موجود أو لا ينتمي لهذا المؤشر.');
    if (results > 0) {
      throw new Error('لا يمكن تعديل إصدار مؤشر مرتبط بنتائج حساب محفوظة؛ أنشئ إصداراً جديداً بدلاً من التعديل.');
    }
  }

  const highest = db.prepare(`SELECT COALESCE(MAX(version_number),0) AS max_version
    FROM indicator_definition_versions WHERE indicator_id = ?`).get(indicatorId);
  const nextVersionNumber = Number(highest.max_version ?? 0) + 1;
  const values = normaliseVersionPayload(payload, nextVersionNumber, todayDate());

  const collision = db.prepare(`SELECT indicator_version_id FROM indicator_definition_versions
    WHERE indicator_id = ? AND version_number = ?`).get(indicatorId, values.version_number);
  if (collision) {
    throw new Error(`رقم الإصدار ${values.version_number} مستخدم بالفعل لهذا المؤشر؛ استخدم رقماً غير مستخدم.`);
  }

  const actor = request.actor ?? payload.actor ?? null;
  const reason = request.reason ?? payload.changeReason ?? payload.change_reason ?? null;
  const sessionId = request.sessionId ?? null;

  const apply = db.transaction(() => {
    const saved = domain.save(db, {
      dataset: 'indicatorDefinitionVersions',
      values: { indicator_id: indicatorId, ...values },
      actor: actor === null ? null : String(actor),
      reason: reason === null ? null : String(reason),
      sessionId: sessionId === null ? null : String(sessionId)
    });

    const openVersions = db.prepare(`SELECT indicator_version_id, version_number, effective_from
      FROM indicator_definition_versions
      WHERE indicator_id = ? AND effective_to IS NULL AND indicator_version_id <> ?
      ORDER BY version_number DESC`).all(indicatorId, saved.id);

    const closedVersionIds = [];
    for (const version of openVersions) {
      // Closing sets effective_to to the new version's start; the DDL forbids an
      // end date that precedes its own start date, so such a row is left open
      // and reported instead of silently producing an invalid history.
      if (version.effective_from && String(version.effective_from) > values.effective_from) {
        notes.push(`لم يُغلق الإصدار ${version.version_number} لأن تاريخ سريانه لاحق لتاريخ سريان الإصدار الجديد.`);
        continue;
      }
      domain.save(db, {
        dataset: 'indicatorDefinitionVersions',
        id: Number(version.indicator_version_id),
        values: { effective_to: values.effective_from },
        actor: actor === null ? null : String(actor),
        reason: `إغلاق الإصدار ${version.version_number} عند إصدار الإصدار ${values.version_number}.`,
        sessionId: sessionId === null ? null : String(sessionId)
      });
      closedVersionIds.push(Number(version.indicator_version_id));
    }

    return { saved, closedVersionIds };
  });

  const { saved, closedVersionIds } = apply();
  const activeVersionId = values.effective_to === undefined ? saved.id : null;
  if (activeVersionId === null) {
    notes.push('الإصدار الجديد مسجل بتاريخ انتهاء صريح؛ لا يوجد إصدار ساري مفتوح لهذا المؤشر.');
  }

  return {
    indicatorVersionId: saved.id,
    indicatorId,
    versionNumber: values.version_number,
    effectiveFrom: values.effective_from,
    effectiveTo: values.effective_to ?? null,
    activeVersionId,
    closedVersionIds,
    storedResults: results,
    notes
  };
}

// ---------------------------------------------------------------------------
// 4. Weight profiles.
// ---------------------------------------------------------------------------

function sumWeights(weights) {
  let total = 0;
  for (const weight of weights) total += weight;
  return total;
}

function profileWeights(db, profileId, notes) {
  const weights = [];
  if (!tablePresent(db, 'indicator_weights') || !tablePresent(db, 'indicator_definitions')) {
    if (!notes.includes('جداول الأوزان أو تعريفات المؤشرات غير متاحة.')) notes.push('جداول الأوزان أو تعريفات المؤشرات غير متاحة.');
    return weights;
  }
  const source = tableColumns(db, 'indicator_weights').has('source_id') ? sourceLabelSystem(db) : null;
  const rows = db.prepare(`SELECT
      w.indicator_id, w.weight_value, w.rationale, w.source_id,
      d.code AS indicator_code, d.label_ar AS indicator_label
      ${source ? `, ${source.label} AS source_label` : ''}
    FROM indicator_weights w
    LEFT JOIN indicator_definitions d ON d.id = w.indicator_id
    ${source ? source.join : ''}
    WHERE w.weight_profile_id = ?
    ORDER BY w.weight_value DESC, w.indicator_id`).all(profileId);
  for (const row of rows) {
    weights.push({
      indicatorId: Number(row.indicator_id),
      indicatorCode: row.indicator_code ?? null,
      indicatorLabel: row.indicator_label ?? row.indicator_code ?? null,
      weight: numberOrNull(row.weight_value),
      rationale: row.rationale ?? null,
      sourceId: row.source_id === null || row.source_id === undefined ? null : Number(row.source_id),
      referenceSource: row.source_label ?? (row.source_id === null || row.source_id === undefined ? null : String(row.source_id))
    });
  }
  return weights;
}

function weightProfiles(db) {
  requireDb(db);
  const notes = [];
  if (!tablePresent(db, 'indicator_weight_profiles')) {
    return withNotes([], ['جدول ملفات أوزان المؤشرات غير موجود.']);
  }
  const columns = tableColumns(db, 'indicator_weight_profiles');
  // The v1 DDL has no version column on this table; it is reported as null
  // instead of being invented from the code or the creation date.
  const hasVersion = columns.has('version') || columns.has('version_number');
  const versionColumn = columns.has('version') ? 'version' : columns.has('version_number') ? 'version_number' : null;

  const rows = db.prepare(`SELECT p.*, ${hasVersion ? `p.${quote(versionColumn)}` : 'NULL'} AS profile_version
    FROM "indicator_weight_profiles" p ORDER BY p.weight_profile_id`).all();

  return withNotes(rows.map(row => {
    const weights = profileWeights(db, Number(row.weight_profile_id), notes);
    const weightSum = sumWeights(weights.map(item => (item.weight === null ? 0 : item.weight)));
    return {
      profileId: Number(row.weight_profile_id),
      code: row.profile_code ?? null,
      nameAr: row.profile_name ?? null,
      version: row.profile_version === null || row.profile_version === undefined ? null : row.profile_version,
      approvedBy: row.approved_by ?? null,
      approvedAt: row.approved_at ?? null,
      isActive: row.is_active === null || row.is_active === undefined ? null : Number(row.is_active) === 1,
      indicatorCount: weights.length,
      weightSum,
      valid: Math.abs(weightSum - 1) < TOLERANCE,
      weights
    };
  }), notes);
}

function createWeightProfile(db, request = {}) {
  requireDb(db);
  if (!tablePresent(db, 'indicator_weight_profiles')) throw new Error('جدول ملفات أوزان المؤشرات غير موجود.');
  if (!tablePresent(db, 'indicator_weights')) throw new Error('جدول أوزان المؤشرات غير موجود.');
  if (!tablePresent(db, 'indicator_definitions')) throw new Error('جدول تعريف المؤشرات غير موجود.');

  const code = String(request.code ?? '').trim();
  if (!PROFILE_CODE.test(code)) {
    throw new Error('رمز ملف الأوزان مطلوب ويقبل الأحرف اللاتينية والأرقام والنقطة والشرطة فقط (حتى 120 محرفاً).');
  }
  const nameAr = String(request.nameAr ?? request.name_ar ?? '').trim();
  if (!nameAr) throw new Error('اسم ملف الأوزان مطلوب.');

  const rawWeights = request.weights;
  if (!Array.isArray(rawWeights) || rawWeights.length === 0) throw new Error('قائمة الأوزان مطلوبة ولا تقبل الفراغ.');
  if (rawWeights.length > 500) throw new Error('عدد أوزان الملف يتجاوز الحد الأعلى (500).');

  const seen = new Set();
  const weights = rawWeights.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`الوزن رقم ${index + 1} غير صالح.`);
    }
    const indicatorId = positiveId(entry.indicatorId ?? entry.indicator_id, 'المؤشر');
    if (seen.has(indicatorId)) throw new Error(`المؤشر ${indicatorId} مكرر في نفس ملف الأوزان.`);
    seen.add(indicatorId);
    const weight = Number(entry.weight ?? entry.weightValue ?? entry.weight_value);
    if (!Number.isFinite(weight)) throw new Error(`وزن المؤشر ${indicatorId} غير رقمي.`);
    if (weight < 0) throw new Error(`وزن المؤشر ${indicatorId} سالب؛ الأوزان يجب أن تكون غير سالبة.`);
    return {
      indicatorId,
      weight,
      rationale: entry.rationale === null || entry.rationale === undefined ? null : String(entry.rationale),
      sourceId: entry.sourceId ?? entry.source_id ?? null
    };
  });

  const weightSum = sumWeights(weights.map(item => item.weight));
  if (Math.abs(weightSum - 1) >= TOLERANCE) {
    throw new Error(`مجموع الأوزان ${weightSum} لا يساوي 1؛ لا يمكن اعتماد الملف.`);
  }

  const placeholders = weights.map(() => '?').join(',');
  const found = db.prepare(`SELECT id FROM indicator_definitions WHERE id IN (${placeholders})`)
    .all(...weights.map(item => item.indicatorId)).map(row => Number(row.id));
  const foundSet = new Set(found);
  const missing = weights.map(item => item.indicatorId).filter(id => !foundSet.has(id));
  if (missing.length) throw new Error(`مؤشرات غير موجودة في دليل المؤشرات: ${missing.join('، ')}.`);

  if (db.prepare('SELECT 1 AS hit FROM indicator_weight_profiles WHERE profile_code = ?').get(code)) {
    throw new Error(`رمز ملف الأوزان «${code}» مستخدم بالفعل.`);
  }

  const approvedBy = request.approvedBy ?? request.approved_by ?? null;
  const approvedAt = request.approvedAt ?? request.approved_at ?? (approvedBy ? new Date().toISOString() : null);
  const actor = request.actor ?? approvedBy ?? null;

  const apply = db.transaction(() => {
    const saved = domain.save(db, {
      dataset: 'indicatorWeightProfiles',
      values: {
        profile_code: code,
        profile_name: nameAr,
        description: request.description ?? null,
        methodology: request.methodology ?? null,
        is_active: approvedBy ? 1 : 0,
        created_by: request.createdBy ?? request.created_by ?? actor,
        approved_by: approvedBy,
        approved_at: approvedAt
      },
      actor: actor === null ? null : String(actor),
      reason: request.reason ?? 'إنشاء ملف أوزان مؤشرات معتمد.',
      sessionId: request.sessionId ?? null
    });

    for (const item of weights) {
      const values = {
        weight_profile_id: saved.id,
        indicator_id: item.indicatorId,
        weight_value: item.weight,
        rationale: item.rationale
      };
      if (item.sourceId !== null && item.sourceId !== undefined && item.sourceId !== '') values.source_id = item.sourceId;
      domain.save(db, {
        dataset: 'indicatorWeights',
        values,
        actor: actor === null ? null : String(actor),
        sessionId: request.sessionId ?? null
      });
    }

    return saved;
  });

  const saved = apply();
  return {
    profileId: saved.id,
    code,
    nameAr,
    indicatorCount: weights.length,
    weightSum,
    approvedBy: approvedBy === null ? null : String(approvedBy),
    approvedAt
  };
}

// ---------------------------------------------------------------------------
// 5. Stored calculation runs.
// ---------------------------------------------------------------------------

function calculationRuns(db, request = {}) {
  requireDb(db);
  const notes = [];
  const limit = clampLimit(request.limit);
  if (!tablePresent(db, 'indicator_calculation_runs')) {
    return { runs: [], limit, total: 0, notes: ['جدول تشغيلات حساب المؤشرات غير موجود.'] };
  }
  const hasResults = tablePresent(db, 'indicator_calculation_results');
  if (!hasResults) notes.push('جدول نتائج حساب المؤشرات غير موجود؛ الأعداد والغطاء صفر.');

  const total = Number(db.prepare('SELECT COUNT(*) AS total FROM indicator_calculation_runs').get().total ?? 0);
  const rows = db.prepare(`SELECT
      run.calculation_run_id, run.weight_profile_id, run.period_id, run.run_mode,
      run.algorithm_version, run.input_snapshot_hash, run.parameters_json,
      run.started_by, run.started_at, run.completed_at, run.run_status, run.failure_reason,
      ${tablePresent(db, 'indicator_weight_profiles') ? 'profile.profile_code' : 'NULL'} AS profile_code,
      ${tablePresent(db, 'indicator_weight_profiles') ? 'profile.profile_name' : 'NULL'} AS profile_name,
      ${hasResults ? `(SELECT COUNT(*) FROM indicator_calculation_results result
        WHERE result.calculation_run_id = run.calculation_run_id AND result.indicator_id IS NOT NULL)` : '0'} AS result_count,
      ${hasResults ? `(SELECT COUNT(*) FROM indicator_calculation_results result
        WHERE result.calculation_run_id = run.calculation_run_id AND result.indicator_id IS NULL)` : '0'} AS aggregate_count,
      ${hasResults ? `(SELECT AVG(result.coverage_ratio) FROM indicator_calculation_results result
        WHERE result.calculation_run_id = run.calculation_run_id AND result.coverage_ratio IS NOT NULL)` : 'NULL'} AS average_coverage
    FROM indicator_calculation_runs run
    ${tablePresent(db, 'indicator_weight_profiles') ? 'LEFT JOIN indicator_weight_profiles profile ON profile.weight_profile_id = run.weight_profile_id' : ''}
    ORDER BY run.calculation_run_id DESC
    LIMIT ?`).all(limit);

  const runs = rows.map(row => ({
    runId: Number(row.calculation_run_id),
    runMode: row.run_mode ?? null,
    runStatus: row.run_status ?? null,
    algorithmVersion: row.algorithm_version ?? null,
    inputSnapshotHash: row.input_snapshot_hash ?? null,
    weightProfileId: row.weight_profile_id === null || row.weight_profile_id === undefined ? null : Number(row.weight_profile_id),
    weightProfileCode: row.profile_code ?? null,
    weightProfileName: row.profile_name ?? null,
    periodId: row.period_id === null || row.period_id === undefined ? null : Number(row.period_id),
    startedBy: row.started_by ?? null,
    startedAt: row.started_at ?? null,
    completedAt: row.completed_at ?? null,
    failureReason: row.failure_reason ?? null,
    resultsCount: Number(row.result_count ?? 0),
    aggregatesCount: Number(row.aggregate_count ?? 0),
    averageCoverage: numberOrNull(row.average_coverage),
    parameters: parseJson(row.parameters_json, null)
  }));

  return { runs, limit, total, notes };
}

function runDetail(db, request = {}) {
  requireDb(db);
  const runId = positiveId(request.runId, 'التشغيل');
  const notes = [];
  const empty = {
    run: null,
    results: [],
    aggregates: [],
    inputs: [],
    totals: { results: 0, aggregates: 0, inputs: 0, missingInputs: 0, averageCoverage: null },
    notes
  };

  if (!tablePresent(db, 'indicator_calculation_runs')) {
    notes.push('جدول تشغيلات حساب المؤشرات غير موجود.');
    return empty;
  }
  const row = db.prepare('SELECT * FROM indicator_calculation_runs WHERE calculation_run_id = ?').get(runId);
  if (!row) throw new Error('تشغيل حساب المؤشرات المطلوب غير موجود.');

  const run = {
    runId: Number(row.calculation_run_id),
    runMode: row.run_mode ?? null,
    runStatus: row.run_status ?? null,
    algorithmVersion: row.algorithm_version ?? null,
    inputSnapshotHash: row.input_snapshot_hash ?? null,
    parameters: parseJson(row.parameters_json, null),
    weightProfileId: row.weight_profile_id === null || row.weight_profile_id === undefined ? null : Number(row.weight_profile_id),
    periodId: row.period_id === null || row.period_id === undefined ? null : Number(row.period_id),
    startedBy: row.started_by ?? null,
    startedAt: row.started_at ?? null,
    completedAt: row.completed_at ?? null,
    failureReason: row.failure_reason ?? null
  };

  if (!tablePresent(db, 'indicator_calculation_results')) {
    notes.push('جدول نتائج حساب المؤشرات غير موجود.');
    return { ...empty, run };
  }

  const geo = geoLabelSystem(db, 'result.geo_unit_id');

  const resultRows = db.prepare(`SELECT
      result.*,
      definition.code AS indicator_code,
      definition.label_ar AS indicator_label,
      ${geo ? geo.label : 'NULL'} AS geo_label
    FROM indicator_calculation_results result
    LEFT JOIN indicator_definitions definition ON definition.id = result.indicator_id
    ${geo ? geo.join : ''}
    WHERE result.calculation_run_id = ?
    ORDER BY result.calculation_result_id`).all(runId);

  const results = [];
  const aggregates = [];
  for (const result of resultRows) {
    const mapped = {
      calculationResultId: Number(result.calculation_result_id),
      indicatorId: result.indicator_id === null || result.indicator_id === undefined ? null : Number(result.indicator_id),
      indicatorCode: result.indicator_code ?? null,
      indicatorLabel: result.indicator_label ?? null,
      geoUnitId: result.geo_unit_id === null || result.geo_unit_id === undefined ? null : Number(result.geo_unit_id),
      geoLabel: result.geo_label ?? null,
      rawValue: numberOrNull(result.raw_value),
      normalizedValue: numberOrNull(result.normalized_value),
      weightedValue: numberOrNull(result.weighted_value),
      compositeScore: numberOrNull(result.composite_score),
      rank: result.rank_value === null || result.rank_value === undefined ? null : Number(result.rank_value),
      confidenceLevel: result.confidence_level ?? null,
      coverageRatio: numberOrNull(result.coverage_ratio),
      missingInputs: parseJson(result.missing_inputs_json, null),
      createdAt: result.created_at ?? null
    };
    if (mapped.indicatorId === null) aggregates.push(mapped);
    else results.push(mapped);
  }

  let inputs = [];
  if (!tablePresent(db, 'indicator_result_inputs')) {
    notes.push('جدول مدخلات نتائج المؤشرات غير موجود.');
  } else {
    inputs = db.prepare(`SELECT input.*, result.indicator_id AS indicator_id,
        definition.code AS indicator_code, definition.label_ar AS indicator_label
      FROM indicator_result_inputs input
      JOIN indicator_calculation_results result ON result.calculation_result_id = input.calculation_result_id
      LEFT JOIN indicator_definitions definition ON definition.id = result.indicator_id
      WHERE result.calculation_run_id = ?
      ORDER BY input.result_input_id`).all(runId)
      .map(input => ({
        resultInputId: Number(input.result_input_id),
        calculationResultId: Number(input.calculation_result_id),
        indicatorId: input.indicator_id === null || input.indicator_id === undefined ? null : Number(input.indicator_id),
        indicatorCode: input.indicator_code ?? null,
        indicatorLabel: input.indicator_label ?? null,
        inputRole: input.input_role ?? null,
        inputValue: numberOrNull(input.input_value),
        inputValueText: input.input_value_text ?? null,
        inputValueBoolean: input.input_value_boolean === null || input.input_value_boolean === undefined
          ? null
          : Number(input.input_value_boolean) === 1,
        inputState: input.input_state ?? null,
        fieldDefinitionId: input.field_definition_id === null || input.field_definition_id === undefined
          ? null
          : Number(input.field_definition_id),
        sourceId: input.source_id === null || input.source_id === undefined ? null : Number(input.source_id),
        sourceLocator: input.source_locator ?? null,
        observationId: input.observation_id === null || input.observation_id === undefined
          ? null
          : Number(input.observation_id)
      }));
  }

  const coverageValues = results.map(result => result.coverageRatio).filter(value => value !== null);
  const missingInputs = inputs.filter(input => !KNOWN_INPUT_STATES.has(String(input.inputState ?? ''))).length;

  return {
    run,
    results,
    aggregates,
    inputs,
    totals: {
      results: results.length,
      aggregates: aggregates.length,
      inputs: inputs.length,
      missingInputs,
      averageCoverage: coverageValues.length
        ? coverageValues.reduce((total, value) => total + value, 0) / coverageValues.length
        : null
    },
    notes
  };
}

// ---------------------------------------------------------------------------
// 6. Reproducibility check from stored data only.
// ---------------------------------------------------------------------------

function verifyRun(db, request = {}) {
  requireDb(db);
  const runId = positiveId(request.runId, 'التشغيل');
  const base = {
    runId,
    method: 'stored-weight-reaggregation',
    tolerance: TOLERANCE,
    reproducible: false,
    compared: 0,
    differences: [],
    insufficient: []
  };

  if (!tablePresent(db, 'indicator_calculation_runs')) {
    return { ...base, reason: 'جدول تشغيلات حساب المؤشرات غير موجود.' };
  }
  const run = db.prepare('SELECT * FROM indicator_calculation_runs WHERE calculation_run_id = ?').get(runId);
  if (!run) return { ...base, reason: 'تشغيل حساب المؤشرات المطلوب غير موجود.' };
  if (!tablePresent(db, 'indicator_calculation_results')) {
    return { ...base, reason: 'جدول نتائج حساب المؤشرات غير موجود؛ لا يمكن التحقق.' };
  }
  if (!tablePresent(db, 'indicator_weights')) {
    return { ...base, reason: 'جدول أوزان المؤشرات غير موجود؛ لا يمكن إعادة التجميع من أوزان محفوظة.' };
  }

  const weightProfileId = run.weight_profile_id === null || run.weight_profile_id === undefined
    ? null
    : Number(run.weight_profile_id);
  const weights = new Map();
  if (weightProfileId !== null) {
    for (const row of db.prepare('SELECT indicator_id, weight_value FROM indicator_weights WHERE weight_profile_id = ?')
      .all(weightProfileId)) {
      const weight = numberOrNull(row.weight_value);
      if (weight !== null) weights.set(Number(row.indicator_id), weight);
    }
  }
  if (!weights.size) {
    return {
      ...base,
      reason: 'لا توجد أوزان محفوظة لملف الأوزان المرتبط بهذا التشغيل؛ تعذر إعادة التجميع من بيانات محفوظة.'
    };
  }

  const rows = db.prepare(`SELECT calculation_result_id, indicator_id, geo_unit_id,
      normalized_value, weighted_value, composite_score
    FROM indicator_calculation_results
    WHERE calculation_run_id = ?
    ORDER BY calculation_result_id`).all(runId);
  if (!rows.length) return { ...base, reason: 'لا توجد نتائج محفوظة لهذا التشغيل.' };

  const differences = [];
  const insufficient = [];
  const contributions = new Map();
  let compared = 0;

  for (const row of rows) {
    if (row.indicator_id === null || row.indicator_id === undefined) continue;
    const calculationResultId = Number(row.calculation_result_id);
    const indicatorId = Number(row.indicator_id);
    const weight = weights.get(indicatorId);
    const normalized = numberOrNull(row.normalized_value);
    const stored = numberOrNull(row.weighted_value);

    if (weight === undefined) {
      insufficient.push({ calculationResultId, indicatorId, reason: 'missing-stored-weight' });
      continue;
    }
    if (normalized === null) {
      insufficient.push({ calculationResultId, indicatorId, reason: 'missing-normalized-value' });
      continue;
    }
    if (stored === null) {
      insufficient.push({ calculationResultId, indicatorId, reason: 'missing-weighted-value' });
      continue;
    }

    const recomputed = normalized * weight;
    compared += 1;
    if (Math.abs(recomputed - stored) > TOLERANCE) {
      differences.push({
        kind: 'weighted-value',
        calculationResultId,
        indicatorId,
        geoUnitId: row.geo_unit_id === null || row.geo_unit_id === undefined ? null : Number(row.geo_unit_id),
        weight,
        normalizedValue: normalized,
        storedWeightedValue: stored,
        recomputedWeightedValue: recomputed,
        delta: stored - recomputed
      });
    }

    const key = Number(row.geo_unit_id);
    if (!contributions.has(key)) contributions.set(key, { weighted: 0, weight: 0 });
    const accumulator = contributions.get(key);
    accumulator.weighted += recomputed;
    accumulator.weight += weight;
  }

  // The aggregate row is re-derived from the recomputed contributions, never
  // from the stored composite itself.
  for (const row of rows) {
    if (row.indicator_id !== null && row.indicator_id !== undefined) continue;
    const calculationResultId = Number(row.calculation_result_id);
    const composite = numberOrNull(row.composite_score);
    const accumulator = contributions.get(Number(row.geo_unit_id));
    if (composite === null) {
      insufficient.push({ calculationResultId, indicatorId: null, reason: 'missing-composite-score' });
      continue;
    }
    if (!accumulator || accumulator.weight === 0) {
      insufficient.push({ calculationResultId, indicatorId: null, reason: 'missing-aggregate-inputs' });
      continue;
    }
    const recomputed = run.run_mode === 'calibrated'
      ? accumulator.weighted / accumulator.weight
      : accumulator.weighted;
    compared += 1;
    if (Math.abs(recomputed - composite) > TOLERANCE) {
      differences.push({
        kind: 'composite',
        calculationResultId,
        indicatorId: null,
        geoUnitId: row.geo_unit_id === null || row.geo_unit_id === undefined ? null : Number(row.geo_unit_id),
        runMode: run.run_mode ?? null,
        storedComposite: composite,
        recomputedComposite: recomputed,
        delta: composite - recomputed
      });
    }
  }

  if (!compared) {
    return {
      ...base,
      differences,
      insufficient,
      reason: 'لم تتوفر أي نتيجة قابلة لإعادة الحساب من الأوزان والقيم المحفوظة.'
    };
  }

  const reproducible = differences.length === 0 && insufficient.length === 0;
  const result = {
    ...base,
    runMode: run.run_mode ?? null,
    weightProfileId,
    compared,
    differences,
    insufficient,
    reproducible
  };
  if (!reproducible) {
    result.reason = differences.length
      ? `تم رصد ${differences.length} فرقاً بين النتائج المحفوظة وإعادة التجميع من الأوزان المحفوظة.`
      : `البيانات المحفوظة غير كافية لإعادة حساب ${insufficient.length} نتيجة.`;
  }
  return result;
}

// ---------------------------------------------------------------------------
// 7. Target and benchmark coverage.
// ---------------------------------------------------------------------------

function targetCoverage(db, request = {}) {
  requireDb(db);
  const notes = [];
  const periodId = optionalId(request.periodId, 'الفترة');

  if (!tablePresent(db, 'indicator_definitions')) {
    return withNotes([], ['جدول تعريف المؤشرات غير موجود.']);
  }
  const definitions = db.prepare(`SELECT id, code, label_ar FROM indicator_definitions
    ORDER BY CAST(code AS TEXT) COLLATE NOCASE`).all();

  const targets = new Map();
  if (!tablePresent(db, 'indicator_targets')) {
    notes.push('جدول مستهدفات المؤشرات غير موجود؛ لا توجد مستهدفات.');
  } else {
    const columns = tableColumns(db, 'indicator_targets');
    const periodFilter = periodId !== null && columns.has('period_id');
    const where = periodFilter ? 'WHERE period_id = ?' : '';
    const params = periodFilter ? [periodId] : [];
    for (const row of db.prepare(`SELECT indicator_id,
        COUNT(*) AS total,
        MAX(CASE WHEN lower(trim(coalesce(target_type,''))) = 'baseline' THEN 1 ELSE 0 END) AS has_baseline_target
      FROM indicator_targets ${where} GROUP BY indicator_id`).all(...params)) {
      targets.set(Number(row.indicator_id), {
        count: Number(row.total ?? 0),
        hasBaselineTarget: Number(row.has_baseline_target ?? 0) === 1,
        latestValue: null,
        latestPeriodId: null
      });
    }
    const order = columns.has('period_id') ? 'period_id DESC, indicator_target_id DESC' : 'indicator_target_id DESC';
    for (const row of db.prepare(`SELECT indicator_id, target_value, ${columns.has('period_id') ? 'period_id' : 'NULL AS period_id'}
      FROM indicator_targets ${where} ORDER BY ${order}`).all(...params)) {
      const key = Number(row.indicator_id);
      const entry = targets.get(key);
      if (!entry || entry.latestValue !== null) continue;
      const value = numberOrNull(row.target_value);
      if (value === null) continue;
      entry.latestValue = value;
      entry.latestPeriodId = row.period_id === null || row.period_id === undefined ? null : Number(row.period_id);
    }
  }

  const benchmarks = new Map();
  if (!tablePresent(db, 'indicator_benchmarks')) {
    notes.push('جدول القيم المرجعية للمؤشرات غير موجود؛ لا توجد قيم مرجعية.');
  } else {
    for (const row of db.prepare(`SELECT indicator_id, COUNT(*) AS total
      FROM indicator_benchmarks GROUP BY indicator_id`).all()) {
      benchmarks.set(Number(row.indicator_id), { count: Number(row.total ?? 0), latestValue: null });
    }
    for (const row of db.prepare(`SELECT indicator_id, value_number FROM indicator_benchmarks
      ORDER BY benchmark_id DESC`).all()) {
      const entry = benchmarks.get(Number(row.indicator_id));
      if (!entry || entry.latestValue !== null) continue;
      entry.latestValue = numberOrNull(row.value_number);
    }
  }

  // A baseline is either an explicit baseline target or a stored numeric
  // observation of the indicator; absence stays null, never zero.
  const baselineIndicators = new Set();
  for (const [indicatorId, entry] of targets) {
    if (entry.hasBaselineTarget) baselineIndicators.add(indicatorId);
  }
  if (tablePresent(db, 'indicator_observations')) {
    for (const row of db.prepare(`SELECT DISTINCT indicator_id FROM indicator_observations
      WHERE value_number IS NOT NULL AND lower(trim(coalesce(value_state,'known'))) IN ('known','zero')`).all()) {
      baselineIndicators.add(Number(row.indicator_id));
    }
  }

  const items = definitions.map(definition => {
    const indicatorId = Number(definition.id);
    const target = targets.get(indicatorId) ?? null;
    const benchmark = benchmarks.get(indicatorId) ?? null;
    const hasBaseline = baselineIndicators.has(indicatorId);
    const missing = [];
    if (!target || target.count === 0) missing.push('targets');
    if (!benchmark || benchmark.count === 0) missing.push('benchmarks');
    if (!hasBaseline) missing.push('baseline');
    return {
      indicatorId,
      code: definition.code ?? null,
      labelAr: definition.label_ar ?? null,
      targets: target ? target.count : 0,
      benchmarks: benchmark ? benchmark.count : 0,
      hasBaseline,
      targetValue: target && target.count ? target.latestValue : null,
      targetPeriodId: target ? target.latestPeriodId : null,
      benchmarkValue: benchmark && benchmark.count ? benchmark.latestValue : null,
      missing
    };
  });

  return withNotes(items, notes);
}

module.exports = {
  catalogue,
  definitionDetail,
  saveVersion,
  weightProfiles,
  createWeightProfile,
  calculationRuns,
  runDetail,
  verifyRun,
  targetCoverage
};
