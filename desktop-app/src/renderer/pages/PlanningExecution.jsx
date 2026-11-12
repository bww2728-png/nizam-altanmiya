import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { BarChart3, GitBranch, Link2, RefreshCw, Target, Users } from 'lucide-react';
import { Badge, Bar, Card, Empty, ErrorBanner, Field, Loading, Modal, SelectInput, Stat, TextInput } from '../components/ui.jsx';
import { DASH, errText, fmtInt, fmtNumber, fmtPercent } from '../lib/format.js';

const STATUS_LABELS = {
  not_started: 'لم يبدأ',
  in_progress: 'قيد التنفيذ',
  at_risk: 'معرّض للخطر',
  completed: 'مكتمل',
};
const STATUS_TONES = { not_started: '', in_progress: 'info', at_risk: 'warn', completed: 'ok' };

function bridge() {
  return typeof window === 'undefined' ? null : window.localApp ?? null;
}

function statusLabel(status) {
  if (!status) return DASH;
  return STATUS_LABELS[status] ?? status;
}

function ratioText(value) {
  return value === null || value === undefined ? DASH : fmtPercent(value * 100, 0);
}

export default function PlanningExecution({ notify, refreshKey }) {
  const api = bridge();
  const planning = api?.planning ?? null;
  const unified = api?.unified ?? null;

  const [overview, setOverview] = useState(null);
  const [plans, setPlans] = useState([]);
  const [planId, setPlanId] = useState('');
  const [tree, setTree] = useState(null);
  const [programList, setProgramList] = useState([]);
  const [coverage, setCoverage] = useState([]);
  const [projects, setProjects] = useState([]);
  const [projectId, setProjectId] = useState('');
  const [progress, setProgress] = useState(null);
  const [portfolio, setPortfolio] = useState(null);
  const [beneficiaries, setBeneficiaries] = useState(null);
  const [geography, setGeography] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [linkForm, setLinkForm] = useState(null);
  const [linking, setLinking] = useState(false);

  const load = useCallback(async () => {
    if (!planning) return;
    setLoading(true);
    try {
      const [summary, projectList] = await Promise.all([
        planning.overview().catch(() => null),
        Promise.resolve(api?.canonicalProjects?.({ limit: 300 })).catch(() => []),
      ]);
      setOverview(summary);
      const resolvedProjects = Array.isArray(projectList) ? projectList : (projectList?.rows ?? projectList?.projects ?? []);
      setProjects(resolvedProjects);
      if (unified) {
        const listed = await unified.list({ dataset: 'developmentPlans', limit: 200 }).catch(() => null);
        setPlans(Array.isArray(listed?.rows) ? listed.rows : []);
      }
      setError('');
    } catch (cause) {
      setError(errText(cause) || 'تعذر تحميل ملخص التخطيط.');
    } finally {
      setLoading(false);
    }
  }, [api, planning, unified]);

  useEffect(() => { load(); }, [load, refreshKey]);

  const activePlanId = planId === '' ? undefined : Number(planId);

  useEffect(() => {
    if (!planning) return;
    let cancelled = false;
    (async () => {
      try {
        const [nextTree, nextPrograms, nextCoverage] = await Promise.all([
          planning.objectives({ planId: activePlanId }).catch(() => null),
          planning.programs({ planId: activePlanId }).catch(() => null),
          planning.objectiveCoverage({ planId: activePlanId }).catch(() => null),
        ]);
        if (cancelled) return;
        setTree(nextTree);
        setProgramList(Array.isArray(nextPrograms?.programs) ? nextPrograms.programs : []);
        setCoverage(Array.isArray(nextCoverage?.objectives) ? nextCoverage.objectives : (Array.isArray(nextCoverage?.rows) ? nextCoverage.rows : []));
      } catch (cause) {
        if (!cancelled) setError(errText(cause) || 'تعذر تحميل خطة الأهداف والبرامج.');
      }
    })();
    return () => { cancelled = true; };
  }, [planning, activePlanId, refreshKey]);

  useEffect(() => {
    if (!planning) return;
    let cancelled = false;
    (async () => {
      if (!activePlanId) { setPortfolio(null); return; }
      const next = await planning.portfolio({ planId: activePlanId }).catch(() => null);
      if (!cancelled) setPortfolio(next);
    })();
    return () => { cancelled = true; };
  }, [planning, activePlanId, refreshKey]);

  useEffect(() => {
    if (!planning || !projectId) { setProgress(null); setBeneficiaries(null); setGeography(null); return; }
    let cancelled = false;
    (async () => {
      const id = Number(projectId);
      const [nextProgress, nextBeneficiaries, nextGeography] = await Promise.all([
        planning.projectProgress({ projectId: id }).catch(() => null),
        planning.beneficiaries({ projectId: id }).catch(() => null),
        planning.geography({ projectId: id }).catch(() => null),
      ]);
      if (cancelled) return;
      setProgress(nextProgress);
      setBeneficiaries(nextBeneficiaries);
      setGeography(nextGeography);
    })();
    return () => { cancelled = true; };
  }, [planning, projectId, refreshKey]);

  const objectiveRows = useMemo(() => {
    const flatten = (nodes, depth = 0, output = []) => {
      (nodes ?? []).forEach((node) => {
        output.push({ ...node, depth });
        flatten(node.children, depth + 1, output);
      });
      return output;
    };
    return flatten(tree?.objectives ?? []);
  }, [tree]);

  const planOptions = [{ value: '', label: 'كل الخطط' }, ...plans.map((plan) => ({ value: String(plan.plan_id ?? plan.planId), label: plan.plan_name ?? plan.planName ?? `خطة ${plan.plan_id ?? plan.planId}` }))];
  const projectOptions = [{ value: '', label: '— اختر مشروعاً —' }, ...projects.map((project) => ({ value: String(project.id ?? project.projectId), label: project.name ?? project.projectName ?? `مشروع ${project.id ?? project.projectId}` }))];

  async function submitLink() {
    if (!planning || !linkForm) return;
    setLinking(true);
    try {
      const result = await planning.linkProject({
        programId: Number(linkForm.programId),
        projectId: Number(linkForm.projectId),
        reason: linkForm.reason,
      });
      setLinkForm(null);
      notify?.({ tone: 'ok', message: result?.alreadyLinked ? 'الربط موجود مسبقاً.' : 'تم ربط المشروع بالبرنامج.' });
      const nextPrograms = await planning.programs({ planId: activePlanId }).catch(() => null);
      setProgramList(Array.isArray(nextPrograms?.programs) ? nextPrograms.programs : []);
    } catch (cause) {
      setLinkForm((current) => ({ ...current, banner: errText(cause) || 'تعذر ربط المشروع.' }));
    } finally {
      setLinking(false);
    }
  }

  if (!planning) {
    return (
      <Card title="التخطيط والتنفيذ">
        <Empty
          icon={GitBranch}
          title="جسر التخطيط غير متاح"
          hint="هذه النافذة تحتاج واجهة window.localApp.planning. أعد تشغيل التطبيق بالنسخة التي تسجل قنوات التخطيط."
        />
      </Card>
    );
  }

  if (loading && !overview) return <Card title="التخطيط والتنفيذ"><Loading label="جارٍ تحميل بيانات التخطيط..." /></Card>;

  return (
    <>
      {error && <ErrorBanner message={error} onDismiss={() => setError('')} />}

      <Card
        title="التخطيط والتنفيذ"
        subtitle="سلسلة: القضايا التنموية ← الأهداف ← البرامج ← المشاريع ← الأنشطة والمعالم."
        icon={GitBranch}
        actions={(
          <div className="btn-row">
            <SelectInput value={planId} onChange={setPlanId} options={planOptions} />
            <button className="btn small" onClick={load}><RefreshCw size={15} /> تحديث</button>
          </div>
        )}
      >
        <div className="report-summary-strip">
          <div><span>الخطط</span><strong>{fmtInt(overview?.plans ?? 0)}</strong></div>
          <div><span>الأهداف</span><strong>{fmtInt(overview?.objectives ?? 0)}</strong></div>
          <div><span>البرامج</span><strong>{fmtInt(overview?.programs ?? 0)}</strong></div>
          <div><span>روابط البرامج</span><strong>{fmtInt(overview?.programProjectLinks ?? 0)}</strong></div>
          <div><span>الأنشطة</span><strong>{fmtInt(overview?.activities ?? 0)}</strong></div>
          <div><span>المعالم</span><strong>{fmtInt(overview?.milestones ?? 0)}</strong></div>
          <div><span>متوسط الإنجاز</span><strong>{ratioText(overview?.totals?.completionRatio ?? null)}</strong></div>
        </div>
        {overview?.totals?.note && <p className="field-hint">{overview.totals.note}</p>}
      </Card>

      <Card title="شجرة الأهداف" subtitle="الهدف العام ← الاستراتيجي ← المحدد ← التنفيذي، مع الأهداف اليتيمة." icon={Target}
        actions={<span className="chip gold">{fmtInt(objectiveRows.length)} هدف</span>}>
        {tree?.note && <p className="field-hint">{tree.note}</p>}
        {!objectiveRows.length ? <Empty icon={Target} title="لا أهداف" hint="لم تُسجل أهداف استراتيجية بعد." /> : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>الهدف</th><th>الرمز</th><th>المستوى</th><th className="num">خط الأساس</th><th className="num">المستهدف</th><th>الوحدة</th><th>فترة الاستهداف</th></tr></thead>
              <tbody>
                {objectiveRows.map((row) => (
                  <tr key={`${row.objectiveId}-${row.depth}`}>
                    <td className="strong" style={{ paddingInlineStart: 10 + row.depth * 18 }}>
                      {row.title}
                      {row.orphan && <Badge tone="warn"> بدون أب</Badge>}
                    </td>
                    <td>{row.code ?? DASH}</td>
                    <td>{row.level ?? DASH}</td>
                    <td className="num">{row.baselineValue === null || row.baselineValue === undefined ? DASH : fmtNumber(row.baselineValue, 2)}</td>
                    <td className="num">{row.targetValue === null || row.targetValue === undefined ? DASH : fmtNumber(row.targetValue, 2)}</td>
                    <td>{row.unitLabel ?? DASH}</td>
                    <td>{row.targetPeriodLabel ?? DASH}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="البرامج والمشاريع" subtitle="كل برنامج مرتبط بخطة وهدف، ولكل برنامج مشاريع مرتبطة." icon={BarChart3}
        actions={<button className="btn small primary" onClick={() => setLinkForm({ programId: '', projectId: '', reason: '', banner: '' })}><Link2 size={15} /> ربط مشروع</button>}>
        {!programList.length ? <Empty icon={BarChart3} title="لا برامج" hint="لم تُسجل برامج تنموية بعد." /> : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>البرنامج</th><th>الرمز</th><th>الهدف</th><th>القطاع</th><th>الفترة</th><th className="num">المشاريع</th><th>الحالة</th></tr></thead>
              <tbody>
                {programList.map((program) => (
                  <tr key={program.programId}>
                    <td className="strong">{program.name}</td>
                    <td>{program.code ?? DASH}</td>
                    <td>{program.objectiveTitle ?? DASH}</td>
                    <td>{program.sectorLabel ?? DASH}</td>
                    <td>{program.periodLabel ?? DASH}</td>
                    <td className="num">{fmtInt(program.projectCount ?? 0)}</td>
                    <td>{program.status ?? DASH}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="متابعة تنفيذ المشروع" icon={BarChart3}
        actions={<SelectInput value={projectId} onChange={setProjectId} options={projectOptions} />}>
        {!progress ? <Empty icon={Users} title="اختر مشروعاً" hint="لعرض الأنشطة والمعالم والمستفيدين والنطاق الجغرافي." /> : (
          <>
            <div className="report-summary-strip">
              <div><span>الإنجاز</span><strong>{ratioText(progress.completion)}</strong></div>
              <div><span>إنجاز المعالم</span><strong>{ratioText(progress.milestoneCompletion)}</strong></div>
              <div><span>الحالة</span><strong><Badge tone={STATUS_TONES[progress.status] ?? ''}>{statusLabel(progress.status)}</Badge></strong></div>
              <div><span>أدلة التحقق</span><strong>{fmtInt(progress.evidenceCount ?? 0)}</strong></div>
            </div>
            <Bar value={(progress.completion ?? 0) * 100} max={100} />
            <div className="table-wrap" style={{ marginTop: 12 }}>
              <table className="data">
                <thead><tr><th>النشاط</th><th>البداية</th><th>النهاية</th><th className="num">نسبة الإنجاز</th><th>الحالة</th></tr></thead>
                <tbody>
                  {(progress.activities ?? []).map((activity) => (
                    <tr key={activity.activityId}>
                      <td className="strong">{activity.name ?? activity.activityName}</td>
                      <td>{activity.startDate ?? DASH}</td>
                      <td>{activity.endDate ?? DASH}</td>
                      <td className="num">{ratioText(activity.progressRatio ?? null)}</td>
                      <td>{activity.status ?? DASH}</td>
                    </tr>
                  ))}
                  {!(progress.activities ?? []).length && <tr><td colSpan={5}>{DASH} لا أنشطة مسجلة</td></tr>}
                </tbody>
              </table>
            </div>
            <div className="table-wrap" style={{ marginTop: 12 }}>
              <table className="data">
                <thead><tr><th>المعلم</th><th>الاستحقاق</th><th>التحقيق</th><th>الحالة</th><th>متأخر</th></tr></thead>
                <tbody>
                  {(progress.milestones ?? []).map((milestone) => (
                    <tr key={milestone.milestoneId}>
                      <td className="strong">{milestone.name ?? milestone.milestoneName}</td>
                      <td>{milestone.dueDate ?? DASH}</td>
                      <td>{milestone.achievedDate ?? DASH}</td>
                      <td>{milestone.status ?? DASH}</td>
                      <td>{milestone.overdue ? <Badge tone="bad">متأخر</Badge> : DASH}</td>
                    </tr>
                  ))}
                  {!(progress.milestones ?? []).length && <tr><td colSpan={5}>{DASH} لا معالم مسجلة</td></tr>}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Card>

      {portfolio && (
        <Card title="محفظة المشاريع في الخطة" subtitle={`طريقة التجميع: ${portfolio.aggregation ?? DASH}`}>
          <div className="report-summary-strip">
            <div><span>المشاريع</span><strong>{fmtInt((portfolio.projects ?? []).length)}</strong></div>
            <div><span>متوسط الإنجاز</span><strong>{ratioText(portfolio.overall?.completion ?? null)}</strong></div>
            <div><span>مكتملة</span><strong>{fmtInt(portfolio.overall?.completed ?? 0)}</strong></div>
            <div><span>معرّضة للخطر</span><strong>{fmtInt(portfolio.overall?.atRisk ?? 0)}</strong></div>
          </div>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>المشروع</th><th className="num">الإنجاز</th><th className="num">إنجاز المعالم</th><th>الحالة</th></tr></thead>
              <tbody>
                {(portfolio.projects ?? []).map((project) => (
                  <tr key={project.projectId}>
                    <td className="strong">{project.name ?? project.projectId}</td>
                    <td className="num">{ratioText(project.completion)}</td>
                    <td className="num">{ratioText(project.milestoneCompletion)}</td>
                    <td><Badge tone={STATUS_TONES[project.status] ?? ''}>{statusLabel(project.status)}</Badge></td>
                  </tr>
                ))}
                {!(portfolio.projects ?? []).length && <tr><td colSpan={4}>{DASH} لا مشاريع مرتبطة بهذه الخطة</td></tr>}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {(beneficiaries || geography) && (
        <Card title="المستفيدون والنطاق الجغرافي" subtitle="الأرقام المستهدفة لا تُخلط مع أرقام فعلية غير مسجلة.">
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>الفئة</th><th>الفترة</th><th className="num">العدد المستهدف</th><th className="num">العدد الفعلي</th><th>المصدر</th></tr></thead>
              <tbody>
                {(beneficiaries?.targets ?? []).map((target) => (
                  <tr key={target.beneficiaryTargetId}>
                    <td className="strong">{target.groupLabel ?? target.groupCode ?? DASH}</td>
                    <td>{target.periodLabel ?? DASH}</td>
                    <td className="num">{target.targetCount === null || target.targetCount === undefined ? DASH : fmtInt(target.targetCount)}</td>
                    <td className="num">{target.actualCount === null || target.actualCount === undefined ? DASH : fmtInt(target.actualCount)}</td>
                    <td>{DASH}</td>
                  </tr>
                ))}
                {!(beneficiaries?.targets ?? []).length && <tr><td colSpan={5}>{DASH} لا مستهدفات مسجلة</td></tr>}
              </tbody>
            </table>
          </div>
          {beneficiaries?.note && <p className="field-hint">{beneficiaries.note}</p>}
          <div className="table-wrap" style={{ marginTop: 12 }}>
            <table className="data">
              <thead><tr><th>الوحدة الجغرافية</th><th>النوع</th><th>الأب</th></tr></thead>
              <tbody>
                {(geography?.units ?? []).map((unit) => (
                  <tr key={unit.geoUnitId}><td className="strong">{unit.name ?? DASH}</td><td>{unit.unitType ?? DASH}</td><td>{unit.parentName ?? DASH}</td></tr>
                ))}
                {!(geography?.units ?? []).length && <tr><td colSpan={3}>{DASH} لا نطاق جغرافي مسجل</td></tr>}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <Card title="تغطية الأهداف في سلسلة التخطيط" subtitle="هدف بلا برنامج أو مشروع أو قيمة مستهدفة = فجوة تخطيطية.">
        {!coverage.length ? <Empty icon={Target} title="لا بيانات تغطية" hint="لا أهداف مرتبطة بهذه الخطة." /> : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>الهدف</th><th className="num">البرامج</th><th className="num">المشاريع</th><th>قيمة مستهدفة</th><th>فجوات</th></tr></thead>
              <tbody>
                {coverage.map((row, index) => (
                  <tr key={row.objectiveId ?? index}>
                    <td className="strong">{row.title ?? row.objectiveTitle ?? DASH}</td>
                    <td className="num">{fmtInt(row.programCount ?? 0)}</td>
                    <td className="num">{fmtInt(row.projectCount ?? 0)}</td>
                    <td>{row.hasTarget ? <Badge tone="ok">موجودة</Badge> : <Badge tone="warn">ناقصة</Badge>}</td>
                    <td>{(row.gaps ?? []).join('، ') || DASH}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Modal
        open={Boolean(linkForm)}
        title="ربط مشروع ببرنامج"
        subtitle="الربط مسجَّل في جدول program_projects مع تدقيق كامل."
        onClose={() => setLinkForm(null)}
        footer={(
          <div className="btn-row">
            <button className="btn primary" onClick={submitLink} disabled={linking || !linkForm?.programId || !linkForm?.projectId}>{linking ? 'جارٍ الربط...' : 'ربط'}</button>
            <button className="btn ghost" onClick={() => setLinkForm(null)}>إلغاء</button>
          </div>
        )}
      >
        {linkForm?.banner && <ErrorBanner message={linkForm.banner} onDismiss={() => setLinkForm((current) => ({ ...current, banner: '' }))} />}
        <Field label="البرنامج" required>
          <SelectInput value={linkForm?.programId ?? ''} onChange={(value) => setLinkForm((current) => ({ ...current, programId: value }))}
            options={[{ value: '', label: '— اختر برنامجاً —' }, ...programList.map((program) => ({ value: String(program.programId), label: program.name }))]} />
        </Field>
        <Field label="المشروع" required>
          <SelectInput value={linkForm?.projectId ?? ''} onChange={(value) => setLinkForm((current) => ({ ...current, projectId: value }))} options={projectOptions} />
        </Field>
        <Field label="سبب الربط" required>
          <TextInput value={linkForm?.reason ?? ''} onChange={(value) => setLinkForm((current) => ({ ...current, reason: value }))} placeholder="سبب الربط" />
        </Field>
      </Modal>
    </>
  );
}