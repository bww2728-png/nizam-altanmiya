'use strict';

// ---------------------------------------------------------------------------
// Development analysis service layer (analysis domain).
//
// Read models for SWOT/PESTLE context analysis, development issues, priority
// criteria and issue ranking, plus the single write path of this layer:
// saveAssessment(), which delegates to the central domain service so row
// validation, money handling and the append-only audit trail stay in one place.
//
// Conventions:
//  - every SQL identifier used below is listed in IDENTIFIERS and quoted by q();
//  - values are always bound parameters;
//  - a missing table or column yields an empty structure, never a throw;
//  - missing data stays null, it is never turned into an invented zero;
//  - no roll-up mixes periods: the ranking scope is exactly one period bucket
//    (period_id = ? or period_id IS NULL) and says so in `scope`.
// ---------------------------------------------------------------------------

const domainService = require('./domain-service.cjs');

const DEFAULT_LATEST_ISSUES = 8;
const MAX_RANKING_ISSUES = 1000;
const EPSILON = 1e-12;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// Factor groups per analysis type. Keys are the canonical values used by the
// seeded reference sets (`swot_type`, `pestle_dimension`); the plural English
// spellings are accepted as aliases so an imported workbook cannot lose a row.
const CONTEXT_GROUPS = Object.freeze({
  swot: Object.freeze([
    Object.freeze({ key: 'strength', labelAr: 'قوة', aliases: ['strength', 'strengths'] }),
    Object.freeze({ key: 'weakness', labelAr: 'ضعف', aliases: ['weakness', 'weaknesses'] }),
    Object.freeze({ key: 'opportunity', labelAr: 'فرصة', aliases: ['opportunity', 'opportunities'] }),
    Object.freeze({ key: 'threat', labelAr: 'تهديد', aliases: ['threat', 'threats'] })
  ]),
  pestle: Object.freeze([
    Object.freeze({ key: 'political', labelAr: 'سياسي وحوكمي', aliases: ['political'] }),
    Object.freeze({ key: 'economic', labelAr: 'اقتصادي', aliases: ['economic', 'economical'] }),
    Object.freeze({ key: 'social', labelAr: 'اجتماعي', aliases: ['social'] }),
    Object.freeze({ key: 'technological', labelAr: 'تقني', aliases: ['technological', 'technical'] }),
    Object.freeze({ key: 'legal', labelAr: 'قانوني وتشريعي', aliases: ['legal', 'legislative'] }),
    Object.freeze({ key: 'environmental', labelAr: 'بيئي', aliases: ['environmental', 'environment'] })
  ])
});

const ISSUE_FACTOR_TYPES = Object.freeze([
  'direct_cause',
  'root_cause',
  'effect',
  'constraint',
  'opportunity',
  'risk'
]);

const FORMULA = Object.freeze({
  normalization: 'minmax-per-criterion',
  weighting: 'normalized*direction-adjusted-weight',
  direction: 'a direction starting with "lower", or inverse/desc/descending/negative, inverts the normalized score',
  flatCriterion: 'when every raw score of a criterion is equal the normalized score is 0.5 (mirrors analysis/composite.cjs)',
  total: 'weightedTotal = sum(normalized*appliedWeight)',
  score: 'normalizedScore = weightedTotal/sum(appliedWeight)',
  coverage: 'coverage = sum(appliedWeight)/sum(active default_weight)',
  ranking: 'desc(normalizedScore) then issueId ascending',
  appliedWeight: 'applied_weight stored on the assessment, falling back to priority_criteria.default_weight',
  inactiveCriteria: 'assessments on inactive criteria stay stored but are excluded from the ranking weight basis'
});

// Fixed whitelist: every identifier interpolated into SQL must be listed here.
const IDENTIFIERS = new Set([
  // tables
  'swot_pestle_analyses', 'development_issues', 'development_issue_factors',
  'development_issue_evidence', 'priority_criteria', 'issue_priority_assessments',
  'geographic_units', 'geo_unit_types', 'sectors', 'data_sources', 'periods',
  'development_plans', 'plan_priorities', 'issue_plan_links', 'audit_events',
  // swot_pestle_analyses
  'analysis_id', 'analysis_type', 'evidence_summary', 'impact_direction',
  'impact_severity', 'time_horizon', 'response_strategy',
  // development_issues
  'issue_id', 'issue_code', 'issue_title', 'issue_description', 'general_challenge',
  'population_share', 'evidence_notes',
  // shared columns
  'geo_unit_id', 'period_id', 'sector_id', 'source_id', 'created_at', 'updated_at',
  'title', 'description', 'factor_type', 'severity',
  // development_issue_factors / evidence
  'issue_factor_id', 'issue_evidence_id', 'evidence_type', 'source_locator', 'confidence',
  // priority_criteria
  'criterion_id', 'criterion_code', 'name_ar', 'default_weight', 'direction',
  'scale_min', 'scale_max', 'is_active',
  // issue_priority_assessments
  'assessment_id', 'raw_score', 'normalized_score', 'applied_weight',
  'weighted_score', 'rationale', 'assessed_by', 'assessed_at',
  // reference labels
  'id', 'name', 'name_en', 'parent_geo_unit_id', 'parent_id', 'geo_unit_type_id',
  'unit_type', 'type_code', 'code', 'sector_code', 'document_title', 'file_name',
  'organization_name', 'organization', 'source_code', 'source_type', 'label_ar',
  'period_code', 'year_gregorian', 'plan_id', 'plan_code', 'plan_name', 'plan_status',
  // plan_priorities / issue_plan_links
  'priority_id', 'priority_rank', 'axis_name', 'objective_text', 'sub_program_text',
  'program_text', 'issue_plan_link_id', 'relationship_type', 'notes'
]);

// ---------------------------------------------------------------------------
// Identifier / schema helpers.
// ---------------------------------------------------------------------------

function requireDb(db) {
  if (!db || typeof db.prepare !== 'function') throw new Error('اتصال قاعدة البيانات غير صالح.');
  return db;
}

function q(name) {
  if (!IDENTIFIERS.has(name)) throw new Error(`معرّف SQL غير مسموح في خدمة التحليل: ${name}`);
  return `"${name}"`;
}

function hasTable(db, table) {
  if (!IDENTIFIERS.has(table)) return false;
  return Boolean(db.prepare("SELECT 1 AS hit FROM sqlite_master WHERE type IN ('table','view') AND name=?").get(table));
}

function columnSet(db, table) {
  if (!hasTable(db, table)) return new Set();
  return new Set(db.prepare(`PRAGMA table_info(${q(table)})`).all().map(column => column.name));
}

function countRows(db, table, conditions = [], params = []) {
  if (!hasTable(db, table)) return 0;
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  return Number(db.prepare(`SELECT COUNT(*) AS total FROM ${q(table)} ${where}`).get(...params).total ?? 0);
}

// ---------------------------------------------------------------------------
// Value helpers.
// ---------------------------------------------------------------------------

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function optionalId(value, label) {
  if (value === null || value === undefined || value === '') return null;
  const number = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`معرّف غير صالح في «${label}».`);
  return number;
}

function requiredId(value, label) {
  const id = optionalId(value, label);
  if (id === null) throw new Error(`«${label}» مطلوب.`);
  return id;
}

function cleanText(value, maxLength, label) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (text.length > maxLength) throw new Error(`قيمة «${label}» أطول من الحد المسموح (${maxLength} حرف).`);
  return text;
}

function normalizeDate(value, label) {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim();
  if (!DATE_PATTERN.test(text)) throw new Error(`«${label}» يجب أن يكون تاريخاً بصيغة YYYY-MM-DD.`);
  const date = new Date(`${text}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== text) {
    throw new Error(`«${label}» تاريخ غير صالح.`);
  }
  return text;
}

function isLowerBetter(direction) {
  const text = String(direction ?? '').trim().toLowerCase();
  if (!text) return false;
  if (['inverse', 'desc', 'descending', 'negative', 'lower'].includes(text)) return true;
  return /^lower[_\s-]/.test(text) || /_(lower|inverse)$/.test(text);
}

// Same semantics as analysis/composite.cjs: direction-aware min-max with a 0.5
// midpoint when the sample is flat.
function normalizeScore(raw, stats, inverted) {
  if (!stats || !stats.count || raw === null) return null;
  if (stats.max === stats.min) return 0.5;
  const ratio = (raw - stats.min) / (stats.max - stats.min);
  const value = inverted ? 1 - ratio : ratio;
  if (!Number.isFinite(value)) return null;
  return Math.min(1, Math.max(0, value));
}

function statsOf(values) {
  let min = Infinity;
  let max = -Infinity;
  let count = 0;
  for (const value of values) {
    if (value === null) continue;
    count += 1;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return count ? { min, max, count } : { min: null, max: null, count: 0 };
}

// ---------------------------------------------------------------------------
// Reference label expressions, built only from columns that really exist.
// ---------------------------------------------------------------------------

function geoLabel(db, alias) {
  if (!hasTable(db, 'geographic_units')) return null;
  const columns = columnSet(db, 'geographic_units');
  const valueColumn = columns.has('geo_unit_id') ? 'geo_unit_id' : columns.has('id') ? 'id' : null;
  if (!valueColumn) return null;
  const parts = ['name_ar', 'name'].filter(name => columns.has(name)).map(name => `${alias}.${q(name)}`);
  parts.push(`CAST(${alias}.${q(valueColumn)} AS TEXT)`);
  return { valueColumn, label: `coalesce(${parts.join(',')})` };
}

function sourceLabel(db, alias) {
  if (!hasTable(db, 'data_sources')) return null;
  const columns = columnSet(db, 'data_sources');
  const valueColumn = columns.has('source_id') ? 'source_id' : columns.has('id') ? 'id' : null;
  if (!valueColumn) return null;
  const parts = ['document_title', 'file_name', 'organization_name', 'organization', 'source_code']
    .filter(name => columns.has(name))
    .map(name => `${alias}.${q(name)}`);
  parts.push(`CAST(${alias}.${q(valueColumn)} AS TEXT)`);
  return { valueColumn, label: `coalesce(${parts.join(',')})` };
}

function periodLabel(db, alias) {
  if (!hasTable(db, 'periods')) return null;
  const columns = columnSet(db, 'periods');
  if (!columns.has('period_id') || !columns.has('label_ar')) return null;
  return { valueColumn: 'period_id', label: `coalesce(${alias}.${q('label_ar')}, CAST(${alias}.${q('period_id')} AS TEXT))` };
}

function sectorLabel(db, alias) {
  if (!hasTable(db, 'sectors')) return null;
  const columns = columnSet(db, 'sectors');
  const valueColumn = columns.has('sector_id') ? 'sector_id' : columns.has('id') ? 'id' : null;
  if (!valueColumn) return null;
  const parts = ['name_ar'].filter(name => columns.has(name)).map(name => `${alias}.${q(name)}`);
  parts.push(`CAST(${alias}.${q(valueColumn)} AS TEXT)`);
  return { valueColumn, label: `coalesce(${parts.join(',')})` };
}

// ---------------------------------------------------------------------------
// 1. Analysis dashboard overview.
// ---------------------------------------------------------------------------

function overview(db, request = {}) {
  requireDb(db);
  const geoUnitId = optionalId(request.geoUnitId, 'الوحدة الجغرافية');
  const periodId = optionalId(request.periodId, 'الفترة المرجعية');
  const limit = Math.min(50, Math.max(1, Math.trunc(Number(request.limit) || DEFAULT_LATEST_ISSUES)));
  const notes = {};

  const counts = { contexts: 0, issues: 0, factors: 0, evidence: 0, criteria: 0, assessments: 0 };

  if (hasTable(db, 'swot_pestle_analyses')) {
    const conditions = [];
    const params = [];
    if (geoUnitId !== null) { conditions.push(`${q('geo_unit_id')} = ?`); params.push(geoUnitId); }
    if (periodId !== null) { conditions.push(`${q('period_id')} = ?`); params.push(periodId); }
    counts.contexts = countRows(db, 'swot_pestle_analyses', conditions, params);
  } else {
    notes.contexts = 'جدول تحليلات SWOT/PESTLE غير موجود في قاعدة البيانات الحالية.';
  }

  const issueScope = geoUnitId === null || !hasTable(db, 'development_issues')
    ? null
    : `${q('issue_id')} IN (SELECT ${q('issue_id')} FROM ${q('development_issues')} WHERE ${q('geo_unit_id')} = ?)`;

  if (hasTable(db, 'development_issues')) {
    counts.issues = countRows(db, 'development_issues', geoUnitId === null ? [] : [`${q('geo_unit_id')} = ?`], geoUnitId === null ? [] : [geoUnitId]);
  } else {
    notes.issues = 'جدول القضايا التنموية غير موجود في قاعدة البيانات الحالية.';
  }

  if (hasTable(db, 'development_issue_factors')) {
    const conditions = [];
    const params = [];
    if (issueScope) { conditions.push(issueScope); params.push(geoUnitId); }
    counts.factors = countRows(db, 'development_issue_factors', conditions, params);
  } else {
    notes.factors = 'جدول عوامل القضايا غير موجود في قاعدة البيانات الحالية.';
  }

  if (hasTable(db, 'development_issue_evidence')) {
    const conditions = [];
    const params = [];
    if (issueScope) { conditions.push(issueScope); params.push(geoUnitId); }
    if (periodId !== null) { conditions.push(`${q('period_id')} = ?`); params.push(periodId); }
    counts.evidence = countRows(db, 'development_issue_evidence', conditions, params);
  } else {
    notes.evidence = 'جدول أدلة القضايا غير موجود في قاعدة البيانات الحالية.';
  }

  if (hasTable(db, 'priority_criteria')) {
    counts.criteria = countRows(db, 'priority_criteria');
  } else {
    notes.criteria = 'جدول معايير الأولوية غير موجود في قاعدة البيانات الحالية.';
  }

  if (hasTable(db, 'issue_priority_assessments')) {
    const conditions = [];
    const params = [];
    if (issueScope) { conditions.push(issueScope); params.push(geoUnitId); }
    if (periodId !== null) { conditions.push(`${q('period_id')} = ?`); params.push(periodId); }
    counts.assessments = countRows(db, 'issue_priority_assessments', conditions, params);
  } else {
    notes.assessments = 'جدول تقييمات الأولوية غير موجود في قاعدة البيانات الحالية.';
  }

  const latestIssues = [];
  if (hasTable(db, 'development_issues')) {
    const columns = columnSet(db, 'development_issues');
    const severityColumn = columns.has('severity') ? q('severity') : null;
    const statusColumn = columns.has('status') ? q('status') : null;
    if (!severityColumn) notes.severity = 'جدول development_issues لا يحتوي عمود severity؛ القيمة null ولم تُشتق من جدول آخر.';
    if (!statusColumn) notes.status = 'جدول development_issues لا يحتوي عمود status؛ القيمة null ولم تُشتق من جدول آخر.';
    const select = [`${q('issue_id')} AS issue_id`, `${q('issue_title')} AS issue_title`];
    if (severityColumn) select.push(`${severityColumn} AS severity`);
    if (statusColumn) select.push(`${statusColumn} AS status`);
    const where = geoUnitId === null ? '' : `WHERE ${q('geo_unit_id')} = ?`;
    const order = columns.has('created_at') ? `${q('created_at')} DESC, ${q('issue_id')} DESC` : `${q('issue_id')} DESC`;
    const params = geoUnitId === null ? [limit] : [geoUnitId, limit];
    latestIssues.push(...db.prepare(`SELECT ${select.join(',')} FROM ${q('development_issues')} ${where} ORDER BY ${order} LIMIT ?`)
      .all(...params)
      .map(row => ({
        issueId: Number(row.issue_id),
        title: row.issue_title ?? '',
        severity: severityColumn ? row.severity ?? null : null,
        status: statusColumn ? row.status ?? null : null
      })));
  }

  return {
    counts,
    latestIssues,
    hasData: Object.values(counts).some(value => value > 0),
    scope: { geoUnitId, periodId },
    notes
  };
}

// ---------------------------------------------------------------------------
// 2. SWOT / PESTLE context matrix.
// ---------------------------------------------------------------------------

function contextMatrix(db, request = {}) {
  requireDb(db);
  const analysisType = String(request.analysisType ?? 'swot').trim().toLowerCase();
  if (!CONTEXT_GROUPS[analysisType]) throw new Error('نوع التحليل يجب أن يكون swot أو pestle.');
  const geoUnitId = optionalId(request.geoUnitId, 'الوحدة الجغرافية');
  const periodId = optionalId(request.periodId, 'الفترة المرجعية');

  const groups = {};
  for (const definition of CONTEXT_GROUPS[analysisType]) {
    groups[definition.key] = { labelAr: definition.labelAr, items: [] };
  }
  const unmappedFactorTypes = [];
  let total = 0;

  if (!hasTable(db, 'swot_pestle_analyses')) {
    return {
      analysisType,
      groups,
      total,
      unmappedFactorTypes,
      scope: { geoUnitId, periodId },
      note: 'جدول تحليلات SWOT/PESTLE غير موجود؛ أعيدت مصفوفة فارغة كاملة.'
    };
  }

  const conditions = [`${q('analysis_type')} = ?`];
  const params = [analysisType];
  if (geoUnitId !== null) { conditions.push(`${q('geo_unit_id')} = ?`); params.push(geoUnitId); }
  if (periodId !== null) { conditions.push(`${q('period_id')} = ?`); params.push(periodId); }

  const rows = db.prepare(`SELECT ${q('analysis_id')}, ${q('factor_type')}, ${q('title')}, ${q('description')},
      ${q('evidence_summary')}, ${q('impact_direction')}, ${q('impact_severity')}, ${q('time_horizon')}, ${q('response_strategy')}
    FROM ${q('swot_pestle_analyses')}
    WHERE ${conditions.join(' AND ')}
    ORDER BY ${q('impact_severity')} IS NULL, ${q('impact_severity')} DESC, ${q('analysis_id')}`).all(...params);

  const aliasMap = new Map();
  for (const definition of CONTEXT_GROUPS[analysisType]) {
    for (const alias of definition.aliases) aliasMap.set(alias, definition.key);
    aliasMap.set(definition.key, definition.key);
  }

  const extra = new Map();
  for (const row of rows) {
    total += 1;
    const rawType = String(row.factor_type ?? '').trim();
    const key = aliasMap.get(rawType.toLowerCase());
    const item = {
      analysisId: Number(row.analysis_id),
      factorType: rawType || null,
      title: row.title ?? '',
      description: row.description ?? null,
      evidenceSummary: row.evidence_summary ?? null,
      impactDirection: row.impact_direction ?? null,
      impactSeverity: numberOrNull(row.impact_severity),
      timeHorizon: row.time_horizon ?? null,
      responseStrategy: row.response_strategy ?? null
    };
    if (key) {
      groups[key].items.push(item);
      continue;
    }
    if (!extra.has(rawType)) {
      unmappedFactorTypes.push(rawType || null);
      extra.set(rawType, { labelAr: rawType || 'غير محدد', items: [] });
    }
    extra.get(rawType).items.push(item);
  }

  // Unknown factor types are kept in their own group so no row is ever dropped.
  for (const [rawType, group] of extra) {
    const base = String(rawType || 'unmapped').toLowerCase().replace(/[^a-z0-9_]+/g, '_') || 'unmapped';
    let key = base;
    let suffix = 2;
    while (Object.hasOwn(groups, key)) {
      key = `${base}_${suffix}`;
      suffix += 1;
    }
    groups[key] = group;
  }

  return {
    analysisType,
    groups,
    total,
    unmappedFactorTypes,
    scope: { geoUnitId, periodId }
  };
}

// ---------------------------------------------------------------------------
// 3. Issue tree (causes, effects, evidence, priorities).
// ---------------------------------------------------------------------------

function emptyFactorGroups() {
  const groups = {};
  for (const type of ISSUE_FACTOR_TYPES) groups[type] = [];
  return groups;
}

function issueTree(db, request = {}) {
  requireDb(db);
  const issueId = requiredId(request.issueId, 'القضية التنموية');
  const factors = emptyFactorGroups();
  const evidence = [];
  const priorities = [];

  if (!hasTable(db, 'development_issues')) {
    return {
      issue: null,
      factors,
      evidence,
      priorities,
      note: 'جدول القضايا التنموية غير موجود في قاعدة البيانات الحالية.'
    };
  }

  const issueColumns = columnSet(db, 'development_issues');
  const geo = geoLabel(db, 'geo');
  const sector = sectorLabel(db, 'sec');
  const select = [
    `i.${q('issue_id')} AS issue_id`,
    `${issueColumns.has('issue_code') ? `i.${q('issue_code')}` : 'NULL'} AS issue_code`,
    `i.${q('issue_title')} AS issue_title`,
    `${issueColumns.has('issue_description') ? `i.${q('issue_description')}` : 'NULL'} AS issue_description`,
    `${issueColumns.has('general_challenge') ? `i.${q('general_challenge')}` : 'NULL'} AS general_challenge`,
    `${issueColumns.has('population_share') ? `i.${q('population_share')}` : 'NULL'} AS population_share`,
    `${issueColumns.has('evidence_notes') ? `i.${q('evidence_notes')}` : 'NULL'} AS evidence_notes`,
    `${issueColumns.has('geo_unit_id') ? `i.${q('geo_unit_id')}` : 'NULL'} AS geo_unit_id`,
    `${issueColumns.has('sector_id') ? `i.${q('sector_id')}` : 'NULL'} AS sector_id`,
    `${issueColumns.has('created_at') ? `i.${q('created_at')}` : 'NULL'} AS created_at`,
    `${issueColumns.has('updated_at') ? `i.${q('updated_at')}` : 'NULL'} AS updated_at`,
    `${geo ? `${geo.label} AS geo_unit_name` : 'NULL AS geo_unit_name'}`,
    `${sector ? `${sector.label} AS sector_name` : 'NULL AS sector_name'}`
  ];
  const joins = [];
  if (geo) joins.push(`LEFT JOIN ${q('geographic_units')} geo ON geo.${q(geo.valueColumn)} = i.${q('geo_unit_id')}`);
  if (sector) joins.push(`LEFT JOIN ${q('sectors')} sec ON sec.${q(sector.valueColumn)} = i.${q('sector_id')}`);

  const row = db.prepare(`SELECT ${select.join(',')} FROM ${q('development_issues')} i ${joins.join(' ')}
    WHERE i.${q('issue_id')} = ? LIMIT 1`).get(issueId);
  if (!row) {
    return { issue: null, factors, evidence, priorities, note: 'القضية التنموية المطلوبة غير موجودة.' };
  }

  const issue = {
    issueId: Number(row.issue_id),
    code: row.issue_code ?? null,
    title: row.issue_title ?? '',
    description: row.issue_description ?? null,
    generalChallenge: row.general_challenge ?? null,
    populationShare: numberOrNull(row.population_share),
    evidenceNotes: row.evidence_notes ?? null,
    geoUnitId: row.geo_unit_id === null ? null : Number(row.geo_unit_id),
    geoUnitName: row.geo_unit_name ?? null,
    sectorId: row.sector_id === null ? null : Number(row.sector_id),
    sectorName: row.sector_name ?? null,
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null
  };

  if (hasTable(db, 'development_issue_factors')) {
    const factorColumns = columnSet(db, 'development_issue_factors');
    const rows = db.prepare(`SELECT ${q('issue_factor_id')}, ${q('factor_type')}, ${q('description')}, ${q('severity')},
        ${factorColumns.has('source_id') ? q('source_id') : 'NULL'} AS source_id
      FROM ${q('development_issue_factors')}
      WHERE ${q('issue_id')} = ?
      ORDER BY ${q('factor_type')}, ${q('severity')} IS NULL, ${q('severity')} DESC, ${q('issue_factor_id')}`).all(issueId);
    for (const item of rows) {
      const type = String(item.factor_type ?? '');
      if (!factors[type]) factors[type] = [];
      factors[type].push({
        factorId: Number(item.issue_factor_id),
        description: item.description ?? '',
        severity: numberOrNull(item.severity),
        sourceId: item.source_id === null || item.source_id === undefined ? null : Number(item.source_id)
      });
    }
  }

  if (hasTable(db, 'development_issue_evidence')) {
    const evidenceColumns = columnSet(db, 'development_issue_evidence');
    const source = evidenceColumns.has('source_id') ? sourceLabel(db, 'src') : null;
    const geoRef = evidenceColumns.has('geo_unit_id') ? geoLabel(db, 'evgeo') : null;
    const period = evidenceColumns.has('period_id') ? periodLabel(db, 'per') : null;
    const selectEvidence = [
      `e.${q('issue_evidence_id')} AS issue_evidence_id`,
      `e.${q('evidence_type')} AS evidence_type`,
      `${evidenceColumns.has('description') ? `e.${q('description')}` : 'NULL'} AS description`,
      `${evidenceColumns.has('geo_unit_id') ? `e.${q('geo_unit_id')}` : 'NULL'} AS geo_unit_id`,
      `${evidenceColumns.has('period_id') ? `e.${q('period_id')}` : 'NULL'} AS period_id`,
      `${evidenceColumns.has('source_locator') ? `e.${q('source_locator')}` : 'NULL'} AS source_locator`,
      `${evidenceColumns.has('confidence') ? `e.${q('confidence')}` : 'NULL'} AS confidence`,
      `${evidenceColumns.has('source_id') ? `e.${q('source_id')}` : 'NULL'} AS source_id`,
      `${source ? `${source.label} AS source_label` : 'NULL AS source_label'}`,
      `${geoRef ? `${geoRef.label} AS geo_unit_name` : 'NULL AS geo_unit_name'}`,
      `${period ? `${period.label} AS period_label` : 'NULL AS period_label'}`
    ];
    const joinsEvidence = [];
    if (source) joinsEvidence.push(`LEFT JOIN ${q('data_sources')} src ON src.${q(source.valueColumn)} = e.${q('source_id')}`);
    if (geoRef) joinsEvidence.push(`LEFT JOIN ${q('geographic_units')} evgeo ON evgeo.${q(geoRef.valueColumn)} = e.${q('geo_unit_id')}`);
    if (period) joinsEvidence.push(`LEFT JOIN ${q('periods')} per ON per.${q(period.valueColumn)} = e.${q('period_id')}`);
    const rows = db.prepare(`SELECT ${selectEvidence.join(',')} FROM ${q('development_issue_evidence')} e
      ${joinsEvidence.join(' ')} WHERE e.${q('issue_id')} = ?
      ORDER BY ${q('issue_evidence_id')}`).all(issueId);
    for (const item of rows) {
      evidence.push({
        evidenceId: Number(item.issue_evidence_id),
        evidenceType: item.evidence_type ?? null,
        description: item.description ?? null,
        geoUnitId: item.geo_unit_id === null ? null : Number(item.geo_unit_id),
        geoUnitName: item.geo_unit_name ?? null,
        periodId: item.period_id === null ? null : Number(item.period_id),
        periodLabel: item.period_label ?? null,
        sourceLocator: item.source_locator ?? null,
        confidence: numberOrNull(item.confidence),
        sourceId: item.source_id === null ? null : Number(item.source_id),
        sourceLabel: item.source_label ?? null
      });
    }
  }

  if (hasTable(db, 'issue_priority_assessments') && hasTable(db, 'priority_criteria')) {
    const rows = db.prepare(`SELECT a.${q('assessment_id')}, a.${q('criterion_id')}, a.${q('period_id')},
        a.${q('raw_score')}, a.${q('normalized_score')}, a.${q('applied_weight')}, a.${q('weighted_score')},
        a.${q('rationale')}, a.${q('assessed_by')}, a.${q('assessed_at')},
        c.${q('criterion_code')}, c.${q('name_ar')}, c.${q('direction')}, c.${q('default_weight')}
      FROM ${q('issue_priority_assessments')} a
      JOIN ${q('priority_criteria')} c ON c.${q('criterion_id')} = a.${q('criterion_id')}
      WHERE a.${q('issue_id')} = ?
      ORDER BY c.${q('criterion_id')}, a.${q('assessment_id')}`).all(issueId);
    for (const item of rows) {
      priorities.push({
        assessmentId: Number(item.assessment_id),
        criterionId: Number(item.criterion_id),
        criterionCode: item.criterion_code ?? null,
        criterionName: item.name_ar ?? null,
        direction: item.direction ?? 'higher_is_higher',
        periodId: item.period_id === null ? null : Number(item.period_id),
        rawScore: numberOrNull(item.raw_score),
        normalizedScore: numberOrNull(item.normalized_score),
        appliedWeight: numberOrNull(item.applied_weight),
        defaultWeight: numberOrNull(item.default_weight),
        weightedScore: numberOrNull(item.weighted_score),
        rationale: item.rationale ?? null,
        assessedBy: item.assessed_by ?? null,
        assessedAt: item.assessed_at ?? null
      });
    }
  }

  return { issue, factors, evidence, priorities };
}

// ---------------------------------------------------------------------------
// 4. Priority criteria.
// ---------------------------------------------------------------------------

function criteriaList(db) {
  if (!hasTable(db, 'priority_criteria')) return [];
  return db.prepare(`SELECT ${q('criterion_id')}, ${q('criterion_code')}, ${q('name_ar')}, ${q('description')},
      ${q('default_weight')}, ${q('direction')}, ${q('scale_min')}, ${q('scale_max')}, ${q('is_active')}
    FROM ${q('priority_criteria')}
    ORDER BY ${q('default_weight')} DESC, ${q('criterion_id')}`).all().map(row => ({
    criterionId: Number(row.criterion_id),
    code: row.criterion_code ?? null,
    nameAr: row.name_ar ?? '',
    description: row.description ?? null,
    defaultWeight: numberOrNull(row.default_weight) ?? 0,
    direction: row.direction ?? 'higher_is_higher',
    scaleMin: numberOrNull(row.scale_min),
    scaleMax: numberOrNull(row.scale_max),
    isActive: Number(row.is_active) === 1
  }));
}

function criteria(db) {
  requireDb(db);
  return criteriaList(db);
}

// ---------------------------------------------------------------------------
// 5. Priority ranking (pure read/compute).
// ---------------------------------------------------------------------------

function priorityRanking(db, request = {}) {
  requireDb(db);
  const periodId = optionalId(request.periodId, 'الفترة المرجعية');
  const geoUnitId = optionalId(request.geoUnitId, 'الوحدة الجغرافية');
  const scope = {
    periodId,
    geoUnitId,
    assessmentScope: periodId === null ? 'period_id IS NULL' : 'period_id = ?',
    note: periodId === null
      ? 'التقييمات المرتبطة بفترة محددة مستثناة؛ لا يُخلط بين الفترات. مرّر periodId لترتيب فترة بعينها.'
      : 'الترتيب مقيد بالفترة المحددة ولا يخلط فترات.',
    availablePeriodIds: []
  };

  if (!hasTable(db, 'priority_criteria') || !hasTable(db, 'issue_priority_assessments') || !hasTable(db, 'development_issues')) {
    return {
      rows: [],
      formula: FORMULA,
      criteriaUsed: [],
      scope,
      truncated: false,
      ignoredInactiveAssessments: 0,
      note: 'جداول القضايا أو المعايير أو التقييمات غير مكتملة؛ لا يوجد ترتيب.'
    };
  }

  scope.availablePeriodIds = db.prepare(`SELECT DISTINCT ${q('period_id')} AS period_id FROM ${q('issue_priority_assessments')}
    WHERE ${q('period_id')} IS NOT NULL ORDER BY ${q('period_id')}`).all().map(row => Number(row.period_id));

  const allCriteria = criteriaList(db);
  const criteriaById = new Map(allCriteria.map(item => [item.criterionId, item]));
  const activeCriteria = allCriteria.filter(item => item.isActive);

  const issueColumns = columnSet(db, 'development_issues');
  const issueWhere = geoUnitId === null ? '' : `WHERE ${q('geo_unit_id')} = ?`;
  const issueOrder = issueColumns.has('created_at') ? `${q('created_at')} DESC, ${q('issue_id')} DESC` : `${q('issue_id')} DESC`;
  const issueParams = geoUnitId === null ? [MAX_RANKING_ISSUES + 1] : [geoUnitId, MAX_RANKING_ISSUES + 1];
  const issueRows = db.prepare(`SELECT ${q('issue_id')} AS issue_id, ${q('issue_title')} AS issue_title
    FROM ${q('development_issues')} ${issueWhere} ORDER BY ${issueOrder} LIMIT ?`).all(...issueParams);
  const truncated = issueRows.length > MAX_RANKING_ISSUES;
  const issues = issueRows.slice(0, MAX_RANKING_ISSUES);
  const issueIds = new Set(issues.map(row => Number(row.issue_id)));

  const periodCondition = periodId === null ? `${q('period_id')} IS NULL` : `${q('period_id')} = ?`;
  const periodParams = periodId === null ? [] : [periodId];
  const assessmentRows = db.prepare(`SELECT ${q('assessment_id')}, ${q('issue_id')}, ${q('criterion_id')},
      ${q('raw_score')}, ${q('applied_weight')}
    FROM ${q('issue_priority_assessments')}
    WHERE ${periodCondition}`).all(...periodParams);

  const byIssue = new Map();
  const byCriterion = new Map();
  let ignoredInactiveAssessments = 0;
  for (const row of assessmentRows) {
    const issueIdValue = Number(row.issue_id);
    if (!issueIds.has(issueIdValue)) continue;
    const criterion = criteriaById.get(Number(row.criterion_id));
    // An inactive or unknown criterion is outside the active weight basis, so
    // its stored assessment is left untouched but never ranked.
    if (!criterion || !criterion.isActive) {
      ignoredInactiveAssessments += 1;
      continue;
    }
    const raw = numberOrNull(row.raw_score);
    if (raw === null) continue;
    const appliedWeight = numberOrNull(row.applied_weight) ?? criterion.defaultWeight;
    const entry = { issueId: issueIdValue, criterionId: Number(row.criterion_id), raw, appliedWeight };
    if (!byIssue.has(issueIdValue)) byIssue.set(issueIdValue, []);
    byIssue.get(issueIdValue).push(entry);
    if (!byCriterion.has(entry.criterionId)) byCriterion.set(entry.criterionId, []);
    byCriterion.get(entry.criterionId).push(entry.raw);
  }

  const criterionStats = new Map();
  for (const [criterionIdValue, values] of byCriterion) criterionStats.set(criterionIdValue, statsOf(values));

  const totalActiveWeight = activeCriteria.reduce((total, item) => total + item.defaultWeight, 0);
  const criterionUsage = new Map();

  const rows = [];
  for (const issueRow of issues) {
    const issueIdValue = Number(issueRow.issue_id);
    const assessments = byIssue.get(issueIdValue) ?? [];
    const criterionIds = new Set();
    let rawTotal = null;
    let weightedTotal = null;
    let weightSum = 0;

    for (const entry of assessments) {
      const criterion = criteriaById.get(entry.criterionId);
      const inverted = isLowerBetter(criterion?.direction);
      const normalized = normalizeScore(entry.raw, criterionStats.get(entry.criterionId), inverted);
      if (normalized === null) continue;
      criterionIds.add(entry.criterionId);
      rawTotal = (rawTotal ?? 0) + entry.raw;
      weightedTotal = (weightedTotal ?? 0) + normalized * entry.appliedWeight;
      weightSum += entry.appliedWeight;
      const usage = criterionUsage.get(entry.criterionId) ?? { issues: 0 };
      usage.issues += 1;
      criterionUsage.set(entry.criterionId, usage);
    }

    const coverage = weightSum <= 0
      ? 0
      : totalActiveWeight > 0
        ? Math.min(1, weightSum / totalActiveWeight)
        : Math.min(1, activeCriteria.length ? criterionIds.size / activeCriteria.length : 0);

    rows.push({
      issueId: issueIdValue,
      title: issueRow.issue_title ?? '',
      rawTotal,
      weightedTotal,
      normalizedScore: weightSum > 0 && weightedTotal !== null ? weightedTotal / weightSum : null,
      coverage,
      rank: null
    });
  }

  const ranked = rows.filter(row => row.normalizedScore !== null)
    .sort((left, right) => {
      const delta = right.normalizedScore - left.normalizedScore;
      if (Math.abs(delta) > EPSILON) return delta;
      return left.issueId - right.issueId;
    });
  ranked.forEach((row, index) => { row.rank = index + 1; });

  rows.sort((left, right) => {
    if (left.rank !== null && right.rank !== null) return left.rank - right.rank;
    if (left.rank !== null) return -1;
    if (right.rank !== null) return 1;
    return left.issueId - right.issueId;
  });

  const criteriaUsed = activeCriteria
    .filter(item => criterionUsage.has(item.criterionId))
    .map(item => {
      const stats = criterionStats.get(item.criterionId);
      return {
        criterionId: item.criterionId,
        code: item.code,
        nameAr: item.nameAr,
        direction: item.direction,
        lowerIsBetter: isLowerBetter(item.direction),
        defaultWeight: item.defaultWeight,
        assessedIssues: criterionUsage.get(item.criterionId).issues,
        scale: stats && stats.count ? { min: stats.min, max: stats.max } : null
      };
    });

  return {
    rows,
    formula: FORMULA,
    criteriaUsed,
    scope,
    truncated,
    ignoredInactiveAssessments,
    unrankedCount: rows.filter(row => row.rank === null).length
  };
}

// ---------------------------------------------------------------------------
// 6. Assessment write path (delegated to the central domain service).
// ---------------------------------------------------------------------------

function assessmentPeriodPool(db, criterionId, periodId) {
  return db.prepare(`SELECT ${q('assessment_id')}, ${q('issue_id')}, ${q('raw_score')}, ${q('applied_weight')}
    FROM ${q('issue_priority_assessments')}
    WHERE ${q('criterion_id')} = ? AND ${periodId === null ? `${q('period_id')} IS NULL` : `${q('period_id')} = ?`}
    ORDER BY ${q('assessment_id')}`).all(...(periodId === null ? [criterionId] : [criterionId, periodId]));
}

function saveAssessment(db, request = {}) {
  requireDb(db);
  const issueId = requiredId(request.issueId, 'القضية التنموية');
  const criterionId = requiredId(request.criterionId, 'معيار الأولوية');
  const rawScore = numberOrNull(request.rawScore);
  if (rawScore === null) throw new Error('الدرجة الخام مطلوبة ويجب أن تكون رقماً صالحاً.');
  const periodId = optionalId(request.periodId, 'الفترة المرجعية');
  const actor = cleanText(request.actor, 120, 'المنفّذ');
  const assessedBy = cleanText(request.assessedBy, 160, 'المقيّم');
  const rationale = cleanText(request.rationale, 1000, 'مبرر التقييم');

  if (!hasTable(db, 'issue_priority_assessments')) throw new Error('جدول تقييمات أولوية القضايا غير موجود في قاعدة البيانات.');
  if (!hasTable(db, 'priority_criteria')) throw new Error('جدول معايير الأولوية غير موجود في قاعدة البيانات.');

  const criterion = db.prepare(`SELECT ${q('criterion_id')}, ${q('default_weight')}, ${q('direction')}, ${q('name_ar')}, ${q('is_active')}
    FROM ${q('priority_criteria')} WHERE ${q('criterion_id')} = ? LIMIT 1`).get(criterionId);
  if (!criterion) throw new Error('معيار الأولوية المطلوب غير موجود.');
  if (Number(criterion.is_active) !== 1) throw new Error('معيار الأولوية غير مفعّل؛ فعّله قبل تسجيل التقييم.');
  const appliedWeight = numberOrNull(criterion.default_weight);
  if (appliedWeight === null || appliedWeight < 0) throw new Error('الوزن الافتراضي للمعيار غير صالح.');
  const inverted = isLowerBetter(criterion.direction);

  const existing = db.prepare(`SELECT ${q('assessment_id')} FROM ${q('issue_priority_assessments')}
    WHERE ${q('issue_id')} = ? AND ${q('criterion_id')} = ?
      AND ${periodId === null ? `${q('period_id')} IS NULL` : `${q('period_id')} = ?`}
    LIMIT 1`).get(...(periodId === null ? [issueId, criterionId] : [issueId, criterionId, periodId]));

  return db.transaction(() => {
    // Normalisation pool after this save (min-max mirrors priorityRanking()).
    const pool = assessmentPeriodPool(db, criterionId, periodId);
    const rawValues = [];
    let replaced = false;
    for (const row of pool) {
      const raw = numberOrNull(row.raw_score);
      if (raw === null) continue;
      if (existing && Number(row.assessment_id) === Number(existing.assessment_id)) {
        rawValues.push(rawScore);
        replaced = true;
      } else {
        rawValues.push(raw);
      }
    }
    if (!replaced) rawValues.push(rawScore);
    const stats = statsOf(rawValues);
    const normalizedScore = normalizeScore(rawScore, stats, inverted);
    const weightedScore = normalizedScore === null ? 0 : normalizedScore * appliedWeight;

    const values = {
      issue_id: issueId,
      criterion_id: criterionId,
      period_id: periodId,
      raw_score: rawScore,
      normalized_score: normalizedScore,
      applied_weight: appliedWeight,
      weighted_score: weightedScore,
      rationale
    };
    if (assessedBy !== null) values.assessed_by = assessedBy;
    if (!existing) {
      values.assessed_at = new Date().toISOString();
    }

    const saved = domainService.save(db, {
      dataset: 'issuePriorityAssessments',
      id: existing ? Number(existing.assessment_id) : null,
      values,
      actor,
      reason: rationale ?? `تقييم أولوية القضية ${issueId} على المعيار ${criterionId}`
    });

    // The min-max pool of this criterion/period shifted, so every other stored
    // row of the same pool is re-derived with the same formula. applied_weight
    // stays explicit, therefore any historical score remains reproducible.
    let recalculated = 0;
    for (const row of pool) {
      if (Number(row.assessment_id) === Number(saved.id)) continue;
      const raw = numberOrNull(row.raw_score);
      if (raw === null) continue;
      const weight = numberOrNull(row.applied_weight) ?? appliedWeight;
      const normalized = normalizeScore(raw, stats, inverted);
      if (normalized === null) continue;
      const weighted = normalized * weight;
      const result = domainService.save(db, {
        dataset: 'issuePriorityAssessments',
        id: Number(row.assessment_id),
        values: { normalized_score: normalized, weighted_score: weighted },
        actor,
        reason: 'إعادة احتساب الدرجة المعيارية بعد تغيّر مجموعة تقييمات المعيار والفترة'
      });
      if ((result.changedFields ?? []).length) recalculated += 1;
    }

    return {
      assessmentId: Number(saved.id),
      normalizedScore,
      weightedScore,
      appliedWeight,
      created: Boolean(saved.created),
      changedFields: saved.changedFields ?? [],
      recalculated,
      scale: stats.count ? { min: stats.min, max: stats.max, count: stats.count } : null,
      scaleScope: 'criterion+period pool (every geographic unit), identical to priorityRanking without geoUnitId',
      lowerIsBetter: inverted
    };
  })();
}

// ---------------------------------------------------------------------------
// 7. Issue links to plans and plan priorities.
// ---------------------------------------------------------------------------

function issueLinks(db, request = {}) {
  requireDb(db);
  const issueId = requiredId(request.issueId, 'القضية التنموية');
  const links = [];
  const plans = [];
  const priorities = [];

  if (!hasTable(db, 'issue_plan_links') || !hasTable(db, 'plan_priorities')) {
    return {
      issueId,
      links,
      plans,
      priorities,
      note: 'جداول ربط القضايا بالأولويات غير موجودة في قاعدة البيانات الحالية.'
    };
  }

  const planJoin = hasTable(db, 'development_plans');
  const rows = db.prepare(`SELECT l.${q('issue_plan_link_id')}, l.${q('priority_id')}, l.${q('relationship_type')}, l.${q('notes')},
      l.${q('created_at')},
      p.${q('priority_id')} AS priority_ref, p.${q('plan_id')}, p.${q('priority_rank')}, p.${q('axis_name')},
      p.${q('objective_text')}, p.${q('sub_program_text')}, p.${q('program_text')}
      ${planJoin ? `, pl.${q('plan_code')} AS plan_code, pl.${q('plan_name')} AS plan_name, pl.${q('plan_status')} AS plan_status` : ''}
    FROM ${q('issue_plan_links')} l
    LEFT JOIN ${q('plan_priorities')} p ON p.${q('priority_id')} = l.${q('priority_id')}
    ${planJoin ? `LEFT JOIN ${q('development_plans')} pl ON pl.${q('plan_id')} = p.${q('plan_id')}` : ''}
    WHERE l.${q('issue_id')} = ?
    ORDER BY l.${q('issue_plan_link_id')}`).all(issueId);

  const planMap = new Map();
  for (const row of rows) {
    const priorityId = row.priority_ref === null || row.priority_ref === undefined ? Number(row.priority_id) : Number(row.priority_ref);
    const planId = row.plan_id === null || row.plan_id === undefined ? null : Number(row.plan_id);
    const link = {
      linkId: Number(row.issue_plan_link_id),
      issueId,
      priorityId,
      relationshipType: row.relationship_type ?? null,
      notes: row.notes ?? null,
      createdAt: row.created_at ?? null
    };
    links.push(link);
    priorities.push({
      ...link,
      planId,
      priorityRank: row.priority_rank === null || row.priority_rank === undefined ? null : Number(row.priority_rank),
      axisName: row.axis_name ?? null,
      objectiveText: row.objective_text ?? null,
      subProgramText: row.sub_program_text ?? null,
      programText: row.program_text ?? null,
      planCode: row.plan_code ?? null,
      planName: row.plan_name ?? null,
      planStatus: row.plan_status ?? null
    });
    if (planId !== null && !planMap.has(planId)) {
      planMap.set(planId, {
        planId,
        planCode: row.plan_code ?? null,
        planName: row.plan_name ?? null,
        planStatus: row.plan_status ?? null
      });
    }
  }
  plans.push(...planMap.values());

  return { issueId, links, plans, priorities };
}

module.exports = {
  overview,
  contextMatrix,
  issueTree,
  criteria,
  priorityRanking,
  saveAssessment,
  issueLinks,
  // exposed for tests and for the planning layer's reuse of the same semantics
  isLowerBetter,
  normalizeScore,
  FORMULA
};
