'use strict';

// ---------------------------------------------------------------------------
// Strategic planning service layer (planning domain).
//
// Read models for the objective tree, development programmes and their project
// links, project/portfolio progress, beneficiary targets and geographic
// coverage, plus the single write path of this layer: linkProject(), which
// delegates to the central domain service so validation and the append-only
// audit trail stay in one place.
//
// Conventions:
//  - every SQL identifier used below is listed in IDENTIFIERS and quoted by q();
//  - values are always bound parameters;
//  - a missing table or column yields an empty structure, never a throw;
//  - completion ratios are null when no observation exists, never 0;
//  - every roll-up states its scope, and nothing is summed across periods or
//    currencies (progress ratios are unitless, beneficiary counts are grouped
//    per period).
// ---------------------------------------------------------------------------

const domainService = require('./domain-service.cjs');

const MAX_PLAN_PROJECTS = 2000;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ACHIEVED_STATUSES = new Set(['achieved', 'completed', 'done', 'complete', 'منجز', 'مكتمل']);

// Fixed whitelist: every identifier interpolated into SQL must be listed here.
const IDENTIFIERS = new Set([
  // tables
  'development_plans', 'strategic_objectives', 'development_programs', 'program_projects',
  'project_activities', 'project_milestones', 'project_beneficiary_targets',
  'project_geographic_units', 'projects', 'geographic_units', 'geo_unit_types', 'sectors',
  'periods', 'measurement_units', 'reference_values', 'managed_attachments',
  // development_plans
  'plan_id', 'plan_code', 'plan_name', 'plan_status', 'geo_unit_id', 'period_id',
  // strategic_objectives
  'objective_id', 'parent_objective_id', 'objective_code', 'objective_level', 'title',
  'description', 'sector_id', 'baseline_value', 'target_value', 'target_unit_id',
  'target_period_id', 'responsible_entity_id',
  // development_programs
  'program_id', 'parent_program_id', 'program_code', 'program_name', 'program_description',
  'start_period_id', 'end_period_id', 'program_status',
  // program_projects
  'project_id', 'relationship_type', 'created_at',
  // project_activities
  'activity_id', 'parent_activity_id', 'activity_code', 'activity_name', 'start_date',
  'end_date', 'activity_status', 'progress_ratio',
  // project_milestones
  'milestone_id', 'milestone_name', 'due_date', 'achieved_date', 'milestone_status',
  'evidence_source_id', 'notes',
  // project_beneficiary_targets
  'beneficiary_target_id', 'beneficiary_group_id', 'target_count', 'actual_count',
  // project_geographic_units
  'role',
  // projects / references
  'id', 'code', 'name', 'project_code', 'project_name', 'status', 'geographic_unit_id',
  'name_ar', 'name_en', 'parent_geo_unit_id', 'parent_id', 'geo_unit_type_id', 'unit_type',
  'type_code', 'sector_code', 'label_ar', 'value_code', 'unit_id', 'unit_code',
  'reference_value_id',
  // managed_attachments
  'entity_type', 'entity_id', 'updated_at'
]);

// ---------------------------------------------------------------------------
// Identifier / schema helpers.
// ---------------------------------------------------------------------------

function requireDb(db) {
  if (!db || typeof db.prepare !== 'function') throw new Error('اتصال قاعدة البيانات غير صالح.');
  return db;
}

function q(name) {
  if (!IDENTIFIERS.has(name)) throw new Error(`معرّف SQL غير مسموح في خدمة التخطيط: ${name}`);
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

function countRows(db, table) {
  if (!hasTable(db, table)) return 0;
  return Number(db.prepare(`SELECT COUNT(*) AS total FROM ${q(table)}`).get().total ?? 0);
}

// Label expression for an optional reference table, built only from columns
// that really exist; null means "table or label column absent".
function referenceLabel(db, table, valueColumns, labelColumns, alias) {
  if (!hasTable(db, table)) return null;
  const columns = columnSet(db, table);
  const valueColumn = valueColumns.find(name => columns.has(name));
  if (!valueColumn) return null;
  const parts = labelColumns.filter(name => columns.has(name)).map(name => `${alias}.${q(name)}`);
  if (!parts.length) return null;
  parts.push(`CAST(${alias}.${q(valueColumn)} AS TEXT)`);
  return { valueColumn, columns, label: `coalesce(${parts.join(',')})` };
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
  const text = String(value ?? '').trim();
  if (!DATE_PATTERN.test(text)) throw new Error(`«${label}» يجب أن يكون تاريخاً بصيغة YYYY-MM-DD.`);
  const date = new Date(`${text}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== text) {
    throw new Error(`«${label}» تاريخ غير صالح.`);
  }
  return text;
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function mean(values) {
  const usable = values.filter(value => typeof value === 'number' && Number.isFinite(value));
  if (!usable.length) return null;
  return usable.reduce((total, value) => total + value, 0) / usable.length;
}

function durationDays(startDate, endDate) {
  if (!DATE_PATTERN.test(String(startDate ?? '')) || !DATE_PATTERN.test(String(endDate ?? ''))) return null;
  const start = Date.parse(`${startDate}T00:00:00.000Z`);
  const end = Date.parse(`${endDate}T00:00:00.000Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  const days = Math.floor((end - start) / 86400000) + 1;
  return days > 0 ? days : null;
}

function isAchieved(milestone) {
  if (milestone.achievedDate) return true;
  return ACHIEVED_STATUSES.has(String(milestone.status ?? '').trim().toLowerCase());
}

// ---------------------------------------------------------------------------
// 1. Planning overview.
// ---------------------------------------------------------------------------

function overview(db) {
  requireDb(db);

  const counts = {
    plans: countRows(db, 'development_plans'),
    objectives: countRows(db, 'strategic_objectives'),
    programs: countRows(db, 'development_programs'),
    programProjectLinks: countRows(db, 'program_projects'),
    activities: countRows(db, 'project_activities'),
    milestones: countRows(db, 'project_milestones'),
    targets: countRows(db, 'project_beneficiary_targets')
  };
  const notes = {};

  let activityStats = { total: counts.activities, withRatio: 0, meanRatio: null };
  if (hasTable(db, 'project_activities')) {
    const row = db.prepare(`SELECT COUNT(*) AS total, COUNT(${q('progress_ratio')}) AS with_ratio,
        AVG(${q('progress_ratio')}) AS mean_ratio FROM ${q('project_activities')}`).get();
    activityStats = {
      total: Number(row.total ?? 0),
      withRatio: Number(row.with_ratio ?? 0),
      meanRatio: Number(row.with_ratio ?? 0) > 0 ? numberOrNull(row.mean_ratio) : null
    };
  } else {
    notes.activities = 'جدول أنشطة المشاريع غير موجود في قاعدة البيانات الحالية.';
  }

  let milestoneStats = { total: counts.milestones, achieved: 0, completion: null };
  if (hasTable(db, 'project_milestones')) {
    const row = db.prepare(`SELECT COUNT(*) AS total,
        COALESCE(SUM(CASE WHEN ${q('achieved_date')} IS NOT NULL
          OR lower(trim(${q('milestone_status')})) IN ('achieved','completed','done','complete','منجز','مكتمل')
          THEN 1 ELSE 0 END),0) AS achieved
        FROM ${q('project_milestones')}`).get();
    const total = Number(row.total ?? 0);
    const achieved = Number(row.achieved ?? 0);
    milestoneStats = { total, achieved, completion: total > 0 ? achieved / total : null };
  } else {
    notes.milestones = 'جدول معالم المشاريع غير موجود في قاعدة البيانات الحالية.';
  }

  return {
    plans: counts.plans,
    objectives: counts.objectives,
    programs: counts.programs,
    programProjectLinks: counts.programProjectLinks,
    activities: counts.activities,
    milestones: counts.milestones,
    targets: counts.targets,
    totals: {
      // Unweighted mean over every activity that actually stores a ratio.
      completionRatio: activityStats.meanRatio,
      activityCount: counts.activities,
      milestoneCount: counts.milestones,
      milestoneCompletion: milestoneStats.completion
    },
    scope: {
      plans: 'all plans',
      aggregation: 'unweighted-mean',
      note: 'نسب الإنجاز بلا وحدة ولا تُجمع مالياً؛ النسبة العامة متوسط غير موزون للأنشطة التي تخزن نسبة إنجاز فقط.'
    },
    notes
  };
}

// ---------------------------------------------------------------------------
// 2. Objective tree (parent/child, orphans preserved).
// ---------------------------------------------------------------------------

function objectiveTree(db, request = {}) {
  requireDb(db);
  const planId = optionalId(request.planId, 'الخطة التنموية');
  if (!hasTable(db, 'strategic_objectives')) {
    return { planId, objectives: [], orphanCount: 0, note: 'جدول الأهداف الاستراتيجية غير موجود في قاعدة البيانات الحالية.' };
  }

  const objectives = columnSet(db, 'strategic_objectives');
  const unit = referenceLabel(db, 'measurement_units', ['unit_id'], ['name_ar'], 'u');
  const period = referenceLabel(db, 'periods', ['period_id'], ['label_ar'], 'p');
  const select = [
    `o.${q('objective_id')} AS objective_id`,
    `${objectives.has('plan_id') ? `o.${q('plan_id')}` : 'NULL'} AS plan_id`,
    `${objectives.has('parent_objective_id') ? `o.${q('parent_objective_id')}` : 'NULL'} AS parent_objective_id`,
    `o.${q('objective_code')} AS objective_code`,
    `o.${q('objective_level')} AS objective_level`,
    `o.${q('title')} AS title`,
    `${objectives.has('baseline_value') ? `o.${q('baseline_value')}` : 'NULL'} AS baseline_value`,
    `${objectives.has('target_value') ? `o.${q('target_value')}` : 'NULL'} AS target_value`,
    `${objectives.has('target_unit_id') ? `o.${q('target_unit_id')}` : 'NULL'} AS target_unit_id`,
    `${objectives.has('target_period_id') ? `o.${q('target_period_id')}` : 'NULL'} AS target_period_id`,
    `${unit ? `${unit.label} AS unit_label` : 'NULL AS unit_label'}`,
    `${period ? `${period.label} AS target_period_label` : 'NULL AS target_period_label'}`
  ];
  const joins = [];
  if (unit && objectives.has('target_unit_id')) {
    joins.push(`LEFT JOIN ${q('measurement_units')} u ON u.${q(unit.valueColumn)} = o.${q('target_unit_id')}`);
  }
  if (period && objectives.has('target_period_id')) {
    joins.push(`LEFT JOIN ${q('periods')} p ON p.${q(period.valueColumn)} = o.${q('target_period_id')}`);
  }
  const where = planId !== null && objectives.has('plan_id') ? `WHERE o.${q('plan_id')} = ?` : '';
  const rows = db.prepare(`SELECT ${select.join(',')} FROM ${q('strategic_objectives')} o ${joins.join(' ')}
    ${where} ORDER BY o.${q('objective_code')}, o.${q('objective_id')}`)
    .all(...(where ? [planId] : []));

  const nodes = rows.map(row => ({
    objectiveId: Number(row.objective_id),
    planId: row.plan_id === null ? null : Number(row.plan_id),
    parentObjectiveId: row.parent_objective_id === null ? null : Number(row.parent_objective_id),
    code: row.objective_code ?? null,
    level: row.objective_level ?? null,
    title: row.title ?? '',
    baselineValue: numberOrNull(row.baseline_value),
    targetValue: numberOrNull(row.target_value),
    unitLabel: row.unit_label ?? null,
    targetPeriodLabel: row.target_period_label ?? null,
    orphan: false,
    orphanReason: null,
    children: []
  }));
  const byId = new Map(nodes.map(node => [node.objectiveId, node]));

  // Break cycles first so no node can become unreachable and silently vanish.
  for (const node of nodes) {
    const seen = new Set([node.objectiveId]);
    let cursor = node;
    while (cursor.parentObjectiveId !== null) {
      const parent = byId.get(cursor.parentObjectiveId);
      if (!parent) break;
      if (seen.has(parent.objectiveId)) {
        node.parentObjectiveId = null;
        node.orphan = true;
        node.orphanReason = 'cycle-detected';
        break;
      }
      seen.add(parent.objectiveId);
      cursor = parent;
    }
  }

  const roots = [];
  for (const node of nodes) {
    const parent = node.parentObjectiveId === null ? null : byId.get(node.parentObjectiveId);
    if (!parent) {
      if (node.parentObjectiveId !== null && !node.orphan) {
        node.orphan = true;
        node.orphanReason = 'parent-not-in-plan';
      }
      roots.push(node);
      continue;
    }
    parent.children.push(node);
  }

  return {
    planId,
    objectives: roots,
    orphanCount: nodes.filter(node => node.orphan).length,
    scope: { planId, note: planId === null ? 'جميع الخطط' : 'خطة واحدة؛ لا تُخلط خطط مختلفة في شجرة واحدة.' }
  };
}

// ---------------------------------------------------------------------------
// 3. Development programmes with their project links.
// ---------------------------------------------------------------------------

function programs(db, request = {}) {
  requireDb(db);
  const planId = optionalId(request.planId, 'الخطة التنموية');
  if (!hasTable(db, 'development_programs')) {
    return { planId, programs: [], note: 'جدول البرامج التنموية غير موجود في قاعدة البيانات الحالية.' };
  }

  const columns = columnSet(db, 'development_programs');
  const where = planId !== null && columns.has('plan_id') ? `WHERE ${q('plan_id')} = ?` : '';
  const rows = db.prepare(`SELECT ${q('program_id')}, ${q('program_code')}, ${q('program_name')},
      ${columns.has('plan_id') ? q('plan_id') : 'NULL'} AS plan_id,
      ${columns.has('objective_id') ? q('objective_id') : 'NULL'} AS objective_id,
      ${columns.has('sector_id') ? q('sector_id') : 'NULL'} AS sector_id,
      ${columns.has('start_period_id') ? q('start_period_id') : 'NULL'} AS start_period_id,
      ${columns.has('end_period_id') ? q('end_period_id') : 'NULL'} AS end_period_id,
      ${columns.has('program_status') ? q('program_status') : 'NULL'} AS program_status
    FROM ${q('development_programs')} ${where}
    ORDER BY ${q('program_code')}, ${q('program_id')}`).all(...(where ? [planId] : []));

  const objectiveTitles = new Map();
  if (hasTable(db, 'strategic_objectives') && rows.some(row => row.objective_id !== null)) {
    for (const row of db.prepare(`SELECT ${q('objective_id')}, ${q('title')} FROM ${q('strategic_objectives')}`).all()) {
      objectiveTitles.set(Number(row.objective_id), row.title ?? '');
    }
  }

  const sector = referenceLabel(db, 'sectors', ['sector_id', 'id'], ['name_ar'], 'sec');
  const sectorNames = new Map();
  if (sector) {
    for (const row of db.prepare(`SELECT ${q(sector.valueColumn)} AS id, ${sector.label} AS label FROM ${q('sectors')} sec`).all()) {
      sectorNames.set(Number(row.id), row.label ?? null);
    }
  }

  const period = referenceLabel(db, 'periods', ['period_id'], ['label_ar'], 'per');
  const periodLabels = new Map();
  if (period) {
    for (const row of db.prepare(`SELECT ${q(period.valueColumn)} AS id, ${period.label} AS label FROM ${q('periods')} per`).all()) {
      periodLabels.set(Number(row.id), row.label ?? null);
    }
  }

  const projectsByProgram = new Map();
  if (hasTable(db, 'program_projects')) {
    for (const row of db.prepare(`SELECT ${q('program_id')}, ${q('project_id')} FROM ${q('program_projects')}
      ORDER BY ${q('project_id')}`).all()) {
      const programId = Number(row.program_id);
      if (!projectsByProgram.has(programId)) projectsByProgram.set(programId, []);
      const projectId = Number(row.project_id);
      if (Number.isSafeInteger(projectId) && !projectsByProgram.get(programId).includes(projectId)) {
        projectsByProgram.get(programId).push(projectId);
      }
    }
  }

  return {
    planId,
    programs: rows.map(row => {
      const programId = Number(row.program_id);
      const projectIds = projectsByProgram.get(programId) ?? [];
      const startLabel = row.start_period_id === null ? null : periodLabels.get(Number(row.start_period_id)) ?? null;
      const endLabel = row.end_period_id === null ? null : periodLabels.get(Number(row.end_period_id)) ?? null;
      let periodLabel = null;
      if (startLabel && endLabel) periodLabel = startLabel === endLabel ? startLabel : `${startLabel} → ${endLabel}`;
      else if (startLabel || endLabel) periodLabel = startLabel ?? endLabel;
      return {
        programId,
        code: row.program_code ?? null,
        name: row.program_name ?? '',
        objectiveId: row.objective_id === null ? null : Number(row.objective_id),
        objectiveTitle: row.objective_id === null ? null : objectiveTitles.get(Number(row.objective_id)) ?? null,
        projectCount: projectIds.length,
        projectIds,
        sectorLabel: row.sector_id === null ? null : sectorNames.get(Number(row.sector_id)) ?? null,
        periodLabel,
        status: row.program_status ?? null
      };
    }),
    scope: { planId, note: planId === null ? 'جميع الخطط' : 'برامج الخطة المحددة فقط' }
  };
}

// ---------------------------------------------------------------------------
// 4. Program ↔ project link (idempotent, delegated write).
// ---------------------------------------------------------------------------

function linkProject(db, request = {}) {
  requireDb(db);
  const programId = requiredId(request.programId, 'البرنامج التنموي');
  const projectId = requiredId(request.projectId, 'المشروع');
  const relationshipType = cleanText(request.relationshipType, 40, 'نوع العلاقة') ?? 'implements';
  const actor = cleanText(request.actor, 120, 'المنفّذ');
  const reason = cleanText(request.reason, 500, 'سبب الربط');

  if (!hasTable(db, 'program_projects')) throw new Error('جدول ربط البرامج بالمشاريع غير موجود في قاعدة البيانات.');
  if (!hasTable(db, 'development_programs')) throw new Error('جدول البرامج التنموية غير موجود في قاعدة البيانات.');
  if (!hasTable(db, 'projects')) throw new Error('جدول المشاريع غير موجود في قاعدة البيانات.');

  const existing = db.prepare(`SELECT ${q('program_id')}, ${q('project_id')}, ${q('relationship_type')}
    FROM ${q('program_projects')}
    WHERE ${q('program_id')} = ? AND ${q('project_id')} = ? AND ${q('relationship_type')} = ?
    LIMIT 1`).get(programId, projectId, relationshipType);
  if (existing) {
    return {
      programId,
      projectId,
      relationshipType,
      created: false,
      alreadyLinked: true,
      note: 'الربط موجود مسبقاً؛ لم تُكتب أي سجلات جديدة ولم يُنشأ حدث تدقيق.'
    };
  }

  const saved = domainService.save(db, {
    dataset: 'programProjects',
    values: {
      program_id: programId,
      project_id: projectId,
      relationship_type: relationshipType
    },
    actor,
    reason: reason ?? `ربط المشروع ${projectId} بالبرنامج ${programId}`
  });

  return { programId, projectId, relationshipType, created: true, alreadyLinked: false, auditId: saved.id };
}

// ---------------------------------------------------------------------------
// 5. Project progress.
// ---------------------------------------------------------------------------

function deriveStatus(completion, milestones, achievedCount) {
  const total = milestones.length;
  const allAchieved = total === 0 ? true : achievedCount === total;
  const overdue = milestones.some(milestone => milestone.overdue);
  if (completion === 1 && allAchieved) return 'completed';
  if (overdue) return 'at_risk';
  if (completion === 0 && achievedCount === 0) return 'not_started';
  if (completion === null && achievedCount === 0) return 'not_started';
  return 'in_progress';
}

function projectProgress(db, request = {}) {
  requireDb(db);
  const projectId = requiredId(request.projectId, 'المشروع');
  const today = request.today === null || request.today === undefined || request.today === ''
    ? todayIso()
    : normalizeDate(request.today, 'تاريخ اليوم');

  const result = {
    projectId,
    name: null,
    activities: [],
    milestones: [],
    completion: null,
    milestoneCompletion: null,
    status: 'not_started',
    evidenceCount: 0,
    statusBasis: [],
    scope: {
      projectId,
      today,
      completion: 'weighted mean of activity progress_ratio, weighted by planned duration in days (fallback weight 1)',
      milestoneCompletion: 'achieved milestones / total milestones',
      statusRules: 'completed > at_risk (overdue milestone) > not_started (completion 0, no achieved milestone) > in_progress'
    },
    notes: {}
  };

  if (!hasTable(db, 'projects')) {
    result.notes.project = 'جدول المشاريع غير موجود في قاعدة البيانات الحالية.';
    return result;
  }
  const projectColumns = columnSet(db, 'projects');
  const idColumn = projectColumns.has('id') ? 'id' : projectColumns.has('project_id') ? 'project_id' : null;
  if (idColumn) {
    const select = [`${projectColumns.has('name') ? q('name') : 'NULL'} AS name`,
      `${projectColumns.has('project_name') ? q('project_name') : 'NULL'} AS project_name`,
      `${projectColumns.has('code') ? q('code') : 'NULL'} AS code`];
    const project = db.prepare(`SELECT ${select.join(',')} FROM ${q('projects')} WHERE ${q(idColumn)} = ? LIMIT 1`).get(projectId);
    if (!project) {
      result.notes.project = 'المشروع المطلوب غير موجود.';
      return result;
    }
    result.name = project.project_name ?? project.name ?? null;
    result.code = project.code ?? null;
  }

  // Activities: leaf activities only, so a summary activity is never counted
  // twice with the children that already carry the real progress.
  if (hasTable(db, 'project_activities')) {
    const rows = db.prepare(`SELECT ${q('activity_id')}, ${q('parent_activity_id')}, ${q('activity_code')},
        ${q('activity_name')}, ${q('activity_status')}, ${q('progress_ratio')}, ${q('start_date')}, ${q('end_date')}
      FROM ${q('project_activities')} WHERE ${q('project_id')} = ?
      ORDER BY ${q('start_date')}, ${q('activity_id')}`).all(projectId);
    const ids = new Set(rows.map(row => Number(row.activity_id)));
    const parentIds = new Set(rows
      .map(row => (row.parent_activity_id === null ? null : Number(row.parent_activity_id)))
      .filter(id => id !== null && ids.has(id)));
    const scoped = parentIds.size ? rows.filter(row => !parentIds.has(Number(row.activity_id))) : rows;
    result.scope.activityScope = parentIds.size ? 'leaf-activities' : 'all-activities';

    let weightTotal = 0;
    let progressTotal = 0;
    let progressCount = 0;
    for (const row of scoped) {
      const duration = durationDays(row.start_date, row.end_date);
      const weight = duration ?? 1;
      const progress = numberOrNull(row.progress_ratio);
      result.activities.push({
        activityId: Number(row.activity_id),
        parentActivityId: row.parent_activity_id === null ? null : Number(row.parent_activity_id),
        code: row.activity_code ?? null,
        name: row.activity_name ?? '',
        status: row.activity_status ?? null,
        progressRatio: progress,
        startDate: row.start_date ?? null,
        endDate: row.end_date ?? null,
        weight,
        weightBasis: duration === null ? 'equal-fallback (no valid date range)' : 'planned-duration-days'
      });
      if (progress === null) continue;
      weightTotal += weight;
      progressTotal += progress * weight;
      progressCount += 1;
    }
    result.completion = weightTotal > 0 ? progressTotal / weightTotal : null;
    result.scope.weightedActivities = progressCount;
  } else {
    result.notes.activities = 'جدول أنشطة المشاريع غير موجود؛ الإنجاز null ولا يُفترض صفر.';
  }

  // Milestones.
  if (hasTable(db, 'project_milestones')) {
    const rows = db.prepare(`SELECT ${q('milestone_id')}, ${q('milestone_name')}, ${q('due_date')},
        ${q('achieved_date')}, ${q('milestone_status')}, ${q('evidence_source_id')}
      FROM ${q('project_milestones')} WHERE ${q('project_id')} = ?
      ORDER BY ${q('due_date')}, ${q('milestone_id')}`).all(projectId);
    let achievedCount = 0;
    for (const row of rows) {
      const achieved = isAchieved({ achievedDate: row.achieved_date, status: row.milestone_status });
      if (achieved) achievedCount += 1;
      const overdue = !achieved && Boolean(row.due_date) && String(row.due_date) < today;
      result.milestones.push({
        milestoneId: Number(row.milestone_id),
        name: row.milestone_name ?? '',
        dueDate: row.due_date ?? null,
        achievedDate: row.achieved_date ?? null,
        status: row.milestone_status ?? null,
        achieved,
        overdue,
        evidenceSourceId: row.evidence_source_id === null ? null : Number(row.evidence_source_id)
      });
    }
    result.milestoneCompletion = rows.length > 0 ? achievedCount / rows.length : null;
    result.scope.milestoneAchievedCount = achievedCount;
    result.scope.milestoneCount = rows.length;
  } else {
    result.notes.milestones = 'جدول معالم المشاريع غير موجود؛ نسبة المعالم null.';
  }

  // Evidence attachments (no invented count: 0 only when the table exists).
  if (hasTable(db, 'managed_attachments')) {
    const columns = columnSet(db, 'managed_attachments');
    if (columns.has('entity_type') && columns.has('entity_id')) {
      result.evidenceCount = Number(db.prepare(`SELECT COUNT(*) AS total FROM ${q('managed_attachments')}
        WHERE ${q('entity_type')} = 'project' AND ${q('entity_id')} = ?`).get(projectId).total ?? 0);
      result.scope.evidenceBasis = 'managed_attachments(entity_type=project)';
    } else {
      result.notes.evidence = 'جدول المرفقات لا يحتوي عمودي entity_type/entity_id؛ العدد 0 بلا أساس.';
    }
  } else {
    result.notes.evidence = 'جدول المرفقات غير موجود؛ عدد الأدلة 0 بلا أساس.';
  }

  result.status = deriveStatus(result.completion, result.milestones, result.scope.milestoneAchievedCount ?? 0);
  result.statusBasis = [
    `completion=${result.completion === null ? 'null' : result.completion}`,
    `milestones=${result.scope.milestoneCount ?? 0}`,
    `achieved=${result.scope.milestoneAchievedCount ?? 0}`,
    `overdue=${result.milestones.filter(milestone => milestone.overdue).length}`
  ];
  return result;
}

// ---------------------------------------------------------------------------
// 6. Portfolio roll-up for one plan.
// ---------------------------------------------------------------------------

function portfolioProgress(db, request = {}) {
  requireDb(db);
  const planId = optionalId(request.planId, 'الخطة التنموية');
  const today = request.today === null || request.today === undefined || request.today === ''
    ? todayIso()
    : normalizeDate(request.today, 'تاريخ اليوم');

  const emptyOverall = { completion: null, milestoneCompletion: null, projectCount: 0, countedProjects: 0 };
  if (!hasTable(db, 'development_programs') || !hasTable(db, 'program_projects') || !hasTable(db, 'projects')) {
    return {
      planId,
      projects: [],
      aggregation: 'unweighted-mean',
      overall: emptyOverall,
      scope: { planId, today },
      note: 'جداول البرامج أو الربط أو المشاريع غير مكتملة؛ لا توجد محفظة.'
    };
  }

  const programWhere = planId !== null ? `WHERE ${q('plan_id')} = ?` : '';
  const programIds = db.prepare(`SELECT ${q('program_id')} FROM ${q('development_programs')} ${programWhere}`)
    .all(...(planId !== null ? [planId] : []))
    .map(row => Number(row.program_id));

  const projectIds = [];
  if (programIds.length) {
    const placeholders = programIds.map(() => '?').join(',');
    for (const row of db.prepare(`SELECT DISTINCT ${q('project_id')} FROM ${q('program_projects')}
      WHERE ${q('program_id')} IN (${placeholders}) ORDER BY ${q('project_id')}`).all(...programIds)) {
      const projectId = Number(row.project_id);
      if (Number.isSafeInteger(projectId) && projectId > 0) projectIds.push(projectId);
    }
  }
  const truncated = projectIds.length > MAX_PLAN_PROJECTS;
  const selected = projectIds.slice(0, MAX_PLAN_PROJECTS);

  const projects = selected.map(projectId => {
    const progress = projectProgress(db, { projectId, today });
    return {
      projectId,
      name: progress.name ?? null,
      completion: progress.completion,
      status: progress.status,
      milestoneCompletion: progress.milestoneCompletion
    };
  });

  const byStatus = { not_started: 0, in_progress: 0, at_risk: 0, completed: 0 };
  for (const project of projects) {
    if (byStatus[project.status] === undefined) byStatus[project.status] = 0;
    byStatus[project.status] += 1;
  }

  return {
    planId,
    projects,
    aggregation: 'unweighted-mean',
    overall: {
      // Unweighted mean of the per-project values; projects with a null value
      // are excluded and counted separately (never treated as zero).
      completion: mean(projects.map(project => project.completion)),
      milestoneCompletion: mean(projects.map(project => project.milestoneCompletion)),
      projectCount: projects.length,
      countedProjects: projects.filter(project => project.completion !== null).length,
      byStatus,
      atRiskProjectIds: projects.filter(project => project.status === 'at_risk').map(project => project.projectId)
    },
    truncated,
    scope: {
      planId,
      today,
      note: planId === null
        ? 'كل البرامج؛ المحفظة ليست مقيّدة بخطة.'
        : 'مشاريع البرامج المرتبطة بالخطة المحددة فقط؛ لا تُخلط خطط.'
    }
  };
}

// ---------------------------------------------------------------------------
// 7. Beneficiary targets (targets only, per period).
// ---------------------------------------------------------------------------

function beneficiaries(db, request = {}) {
  requireDb(db);
  const projectId = requiredId(request.projectId, 'المشروع');
  const result = {
    projectId,
    targets: [],
    totals: [],
    grandTotal: null,
    note: 'الجدول يخزّن مستهدفات المستفيدين فقط؛ الأعداد الفعلية تُعرض كما هي مخزنة ولا تُشتق من سجلات التنفيذ، ولا يُجمع عبر فترات متعددة.',
    scope: { projectId }
  };
  if (!hasTable(db, 'project_beneficiary_targets')) {
    result.note = 'جدول مستهدفات المستفيدين غير موجود في قاعدة البيانات الحالية.';
    return result;
  }

  const columns = columnSet(db, 'project_beneficiary_targets');
  const group = referenceLabel(db, 'reference_values', ['reference_value_id'], ['label_ar'], 'rv');
  const period = referenceLabel(db, 'periods', ['period_id'], ['label_ar'], 'per');
  const geo = referenceLabel(db, 'geographic_units', ['geo_unit_id', 'id'], ['name_ar', 'name'], 'g');
  const hasGroupId = columns.has('beneficiary_group_id');

  const select = [
    `t.${q('beneficiary_target_id')} AS beneficiary_target_id`,
    `${hasGroupId ? `t.${q('beneficiary_group_id')}` : 'NULL'} AS beneficiary_group_id`,
    `${columns.has('geo_unit_id') ? `t.${q('geo_unit_id')}` : 'NULL'} AS geo_unit_id`,
    `${columns.has('target_count') ? `t.${q('target_count')}` : 'NULL'} AS target_count`,
    `${columns.has('actual_count') ? `t.${q('actual_count')}` : 'NULL'} AS actual_count`,
    `${columns.has('period_id') ? `t.${q('period_id')}` : 'NULL'} AS period_id`,
    `${group && hasGroupId ? `${group.label} AS group_label` : 'NULL AS group_label'}`,
    `${group && hasGroupId && group.columns.has('value_code') ? `rv.${q('value_code')} AS group_code` : 'NULL AS group_code'}`,
    `${period && columns.has('period_id') ? `${period.label} AS period_label` : 'NULL AS period_label'}`,
    `${geo && columns.has('geo_unit_id') ? `${geo.label} AS geo_unit_name` : 'NULL AS geo_unit_name'}`
  ];
  const joins = [];
  if (group && hasGroupId) joins.push(`LEFT JOIN ${q('reference_values')} rv ON rv.${q(group.valueColumn)} = t.${q('beneficiary_group_id')}`);
  if (period && columns.has('period_id')) joins.push(`LEFT JOIN ${q('periods')} per ON per.${q(period.valueColumn)} = t.${q('period_id')}`);
  if (geo && columns.has('geo_unit_id')) joins.push(`LEFT JOIN ${q('geographic_units')} g ON g.${q(geo.valueColumn)} = t.${q('geo_unit_id')}`);

  const rows = db.prepare(`SELECT ${select.join(',')} FROM ${q('project_beneficiary_targets')} t
    ${joins.join(' ')} WHERE t.${q('project_id')} = ?
    ORDER BY t.${columns.has('period_id') ? q('period_id') : q('beneficiary_target_id')}, t.${q('beneficiary_target_id')}`)
    .all(projectId);

  const targets = rows.map(row => ({
    beneficiaryTargetId: Number(row.beneficiary_target_id),
    groupId: row.beneficiary_group_id === null ? null : Number(row.beneficiary_group_id),
    groupLabel: row.group_label ?? null,
    groupCode: row.group_code ?? null,
    geoUnitId: row.geo_unit_id === null ? null : Number(row.geo_unit_id),
    geoUnitName: row.geo_unit_name ?? null,
    periodId: row.period_id === null ? null : Number(row.period_id),
    periodLabel: row.period_label ?? null,
    targetCount: numberOrNull(row.target_count),
    actualCount: numberOrNull(row.actual_count)
  }));

  // Totals are grouped by (beneficiary group, period): summing across periods
  // would silently add a target for 2026 to a target for 2027.
  const groups = new Map();
  for (const target of targets) {
    const key = `${target.groupId ?? 'none'}|${target.periodId ?? 'none'}`;
    if (!groups.has(key)) {
      groups.set(key, {
        groupId: target.groupId,
        groupLabel: target.groupLabel,
        groupCode: target.groupCode,
        periodId: target.periodId,
        periodLabel: target.periodLabel,
        targetTotal: null,
        actualTotal: null,
        rows: []
      });
    }
    const bucket = groups.get(key);
    bucket.rows.push(target);
    if (target.targetCount !== null) bucket.targetTotal = (bucket.targetTotal ?? 0) + target.targetCount;
    if (target.actualCount !== null) bucket.actualTotal = (bucket.actualTotal ?? 0) + target.actualCount;
  }

  const periodIds = new Set(targets.filter(target => target.periodId !== null).map(target => target.periodId));
  let grandTotal = null;
  if (periodIds.size <= 1) {
    let targetTotal = null;
    let actualTotal = null;
    for (const target of targets) {
      if (target.targetCount !== null) targetTotal = (targetTotal ?? 0) + target.targetCount;
      if (target.actualCount !== null) actualTotal = (actualTotal ?? 0) + target.actualCount;
    }
    grandTotal = { targetTotal, actualTotal, periodId: periodIds.size ? [...periodIds][0] : null };
  } else {
    result.note = `${result.note} توجد ${periodIds.size} فترات مختلفة، لذلك grandTotal = null.`;
  }

  return {
    ...result,
    targets,
    totals: [...groups.values()],
    grandTotal,
    scope: { projectId, periods: [...periodIds].sort((left, right) => left - right) }
  };
}

// ---------------------------------------------------------------------------
// 8. Project geographic coverage.
// ---------------------------------------------------------------------------

function projectGeography(db, request = {}) {
  requireDb(db);
  const projectId = requiredId(request.projectId, 'المشروع');
  if (!hasTable(db, 'project_geographic_units') || !hasTable(db, 'geographic_units')) {
    return { projectId, units: [], note: 'جداول التغطية الجغرافية غير موجودة في قاعدة البيانات الحالية.' };
  }

  const geo = referenceLabel(db, 'geographic_units', ['geo_unit_id', 'id'], ['name_ar', 'name'], 'g');
  if (!geo) return { projectId, units: [], note: 'تعذر تحديد عمود معرّف الوحدة الجغرافية.' };
  const columns = columnSet(db, 'geographic_units');
  const parentColumn = columns.has('parent_geo_unit_id') ? 'parent_geo_unit_id' : columns.has('parent_id') ? 'parent_id' : null;
  const typeJoin = columns.has('geo_unit_type_id') && hasTable(db, 'geo_unit_types');

  const rows = db.prepare(`SELECT ${q('role')}, g.${q(geo.valueColumn)} AS geo_unit_id, ${geo.label} AS name,
      ${parentColumn ? `g.${q(parentColumn)}` : 'NULL'} AS parent_id,
      ${typeJoin ? 'gt.' + q('name_ar') : 'NULL'} AS unit_type_label,
      ${columns.has('unit_type') ? `g.${q('unit_type')}` : 'NULL'} AS unit_type
    FROM ${q('project_geographic_units')} pgu
    JOIN ${q('geographic_units')} g ON g.${q(geo.valueColumn)} = pgu.${q('geo_unit_id')}
    ${typeJoin ? `LEFT JOIN ${q('geo_unit_types')} gt ON gt.${q('geo_unit_type_id')} = g.${q('geo_unit_type_id')}` : ''}
    WHERE pgu.${q('project_id')} = ?
    ORDER BY name`).all(projectId);

  const parentIds = [...new Set(rows.map(row => (row.parent_id === null ? null : Number(row.parent_id))).filter(id => id !== null))];
  const parentNames = new Map();
  if (parentIds.length) {
    const placeholders = parentIds.map(() => '?').join(',');
    for (const row of db.prepare(`SELECT g.${q(geo.valueColumn)} AS id, ${geo.label} AS name
      FROM ${q('geographic_units')} g WHERE g.${q(geo.valueColumn)} IN (${placeholders})`).all(...parentIds)) {
      parentNames.set(Number(row.id), row.name ?? null);
    }
  }

  return {
    projectId,
    units: rows.map(row => ({
      geoUnitId: Number(row.geo_unit_id),
      name: row.name ?? null,
      unitType: row.unit_type_label ?? row.unit_type ?? null,
      parentName: row.parent_id === null ? null : parentNames.get(Number(row.parent_id)) ?? null,
      role: row.role ?? null
    })),
    scope: { projectId }
  };
}

// ---------------------------------------------------------------------------
// 9. Objective coverage (planning chain completeness).
// ---------------------------------------------------------------------------

function objectiveCoverage(db, request = {}) {
  requireDb(db);
  const planId = optionalId(request.planId, 'الخطة التنموية');
  if (!hasTable(db, 'strategic_objectives')) return [];

  const objectiveColumns = columnSet(db, 'strategic_objectives');
  const where = planId !== null && objectiveColumns.has('plan_id') ? `WHERE ${q('plan_id')} = ?` : '';
  const objectives = db.prepare(`SELECT ${q('objective_id')}, ${q('objective_code')}, ${q('objective_level')}, ${q('title')},
      ${q('target_value')}, ${q('baseline_value')}
    FROM ${q('strategic_objectives')} ${where}
    ORDER BY ${q('objective_code')}, ${q('objective_id')}`).all(...(where ? [planId] : []));

  const programsByObjective = new Map();
  const programIds = new Set();
  if (hasTable(db, 'development_programs')) {
    const programWhere = planId !== null ? `WHERE ${q('plan_id')} = ?` : '';
    for (const row of db.prepare(`SELECT ${q('program_id')}, ${q('objective_id')} FROM ${q('development_programs')} ${programWhere}`)
      .all(...(planId !== null ? [planId] : []))) {
      const objectiveId = row.objective_id === null ? null : Number(row.objective_id);
      if (objectiveId === null) continue;
      if (!programsByObjective.has(objectiveId)) programsByObjective.set(objectiveId, []);
      programsByObjective.get(objectiveId).push(Number(row.program_id));
      programIds.add(Number(row.program_id));
    }
  }

  const projectsByProgram = new Map();
  if (hasTable(db, 'program_projects') && programIds.size) {
    for (const row of db.prepare(`SELECT ${q('program_id')}, ${q('project_id')} FROM ${q('program_projects')}
      ORDER BY ${q('project_id')}`).all()) {
      const programId = Number(row.program_id);
      if (!programIds.has(programId)) continue;
      if (!projectsByProgram.has(programId)) projectsByProgram.set(programId, []);
      projectsByProgram.get(programId).push(Number(row.project_id));
    }
  }

  return objectives.map(row => {
    const objectiveId = Number(row.objective_id);
    const linkedPrograms = programsByObjective.get(objectiveId) ?? [];
    const linkedProjects = new Set();
    for (const programId of linkedPrograms) {
      for (const projectId of projectsByProgram.get(programId) ?? []) linkedProjects.add(projectId);
    }
    const targetValue = numberOrNull(row.target_value);
    const hasPrograms = linkedPrograms.length > 0;
    const hasProjects = linkedProjects.size > 0;
    const hasTargetValue = targetValue !== null;
    return {
      objectiveId,
      code: row.objective_code ?? null,
      level: row.objective_level ?? null,
      title: row.title ?? '',
      programCount: linkedPrograms.length,
      programIds: linkedPrograms.slice().sort((left, right) => left - right),
      projectCount: linkedProjects.size,
      projectIds: [...linkedProjects].sort((left, right) => left - right),
      targetValue,
      baselineValue: numberOrNull(row.baseline_value),
      hasPrograms,
      hasProjects,
      hasTargetValue,
      isComplete: hasPrograms && hasProjects && hasTargetValue
    };
  });
}

module.exports = {
  overview,
  objectiveTree,
  programs,
  linkProject,
  projectProgress,
  portfolioProgress,
  beneficiaries,
  projectGeography,
  objectiveCoverage
};
