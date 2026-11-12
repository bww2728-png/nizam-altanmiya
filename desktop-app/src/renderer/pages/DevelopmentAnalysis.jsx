import React, { useCallback, useEffect, useState } from 'react';
import { Activity, AlertTriangle, Layers, ListOrdered, RefreshCw, Scale, Target } from 'lucide-react';
import {
  Badge, Card, Empty, ErrorBanner, Field, Loading, Modal, NumberInput, Segmented, SelectInput, Skeleton, Stat, TextInput,
} from '../components/ui.jsx';
import { DASH, errText, fmtNumber, fmtPercent } from '../lib/format.js';

/**
 * «التحليل التنموي» — SWOT/PESTLE, issue trees and priority ranking.
 *
 * Read-only except saveAssessment(): the page never derives a score locally, it
 * shows the normalized/weighted values the service returned so the formula on
 * screen is the one stored in the database. A missing assessment shows `—` and
 * «غير مقيّمة», never rank 0.
 */

const ANALYSIS_TYPES = [
  { value: 'swot', label: 'SWOT' },
  { value: 'pestle', label: 'PESTLE' },
];

const ISSUE_GROUPS = [
  { key: 'direct_cause', label: 'أسباب مباشرة' },
  { key: 'root_cause', label: 'أسباب جذرية' },
  { key: 'effect', label: 'آثار' },
  { key: 'constraint', label: 'قيود' },
  { key: 'opportunity', label: 'فرص' },
  { key: 'risk', label: 'مخاطر' },
];

const ISSUE_SAMPLE_LIMIT = 200;

function bridge() {
  return typeof window === 'undefined' ? null : window.localApp ?? null;
}

/** Select values are strings; the services expect a positive integer or null. */
function toId(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : null;
}

function severityTone(value) {
  if (value === null || value === undefined) return '';
  if (value >= 4) return 'bad';
  if (value >= 3) return 'warn';
  return 'info';
}

function severityLabel(value) {
  if (value === null || value === undefined) return 'بلا شدة';
  return `شدة ${fmtNumber(value, 1)}`;
}

function emptyAssessmentForm() {
  return { issueId: '', criterionId: '', rawScore: '', rationale: '', assessedBy: '' };
}

export default function DevelopmentAnalysis({ notify, refreshKey }) {
  const localApp = bridge();
  const dev = localApp?.development ?? null;
  const unified = localApp?.unified ?? null;

  const [overview, setOverview] = useState(null);
  const [criteria, setCriteria] = useState([]);
  const [issueOptions, setIssueOptions] = useState([]);
  const [issuesSource, setIssuesSource] = useState('overview');
  const [baseLoading, setBaseLoading] = useState(true);
  const [error, setError] = useState('');
  const [criteriaError, setCriteriaError] = useState('');

  const [analysisType, setAnalysisType] = useState('swot');
  const [geoUnitId, setGeoUnitId] = useState('');
  const [periodId, setPeriodId] = useState('');
  const [geoOptions, setGeoOptions] = useState([]);
  const [periodOptions, setPeriodOptions] = useState([]);
  const [filterNote, setFilterNote] = useState('');

  const [matrix, setMatrix] = useState(null);
  const [matrixLoading, setMatrixLoading] = useState(true);
  const [matrixError, setMatrixError] = useState('');

  const [selectedIssueId, setSelectedIssueId] = useState('');
  const [tree, setTree] = useState(null);
  const [treeLoading, setTreeLoading] = useState(false);
  const [treeError, setTreeError] = useState('');

  const [ranking, setRanking] = useState(null);
  const [rankingLoading, setRankingLoading] = useState(true);
  const [rankingError, setRankingError] = useState('');

  const [revision, setRevision] = useState(0);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorBusy, setEditorBusy] = useState(false);
  const [editorError, setEditorError] = useState('');
  const [form, setForm] = useState(emptyAssessmentForm());
  const [saved, setSaved] = useState(null);

  const loadBase = useCallback(async () => {
    if (!dev) {
      setBaseLoading(false);
      return;
    }
    setBaseLoading(true);
    setError('');
    setCriteriaError('');
    const [overviewResult, criteriaResult] = await Promise.allSettled([dev.overview({}), dev.criteria()]);
    if (overviewResult.status === 'fulfilled') setOverview(overviewResult.value ?? null);
    else setError(errText(overviewResult.reason) || 'تعذر تحميل ملخص التحليل التنموي.');
    if (criteriaResult.status === 'fulfilled') setCriteria(Array.isArray(criteriaResult.value) ? criteriaResult.value : []);
    else setCriteriaError(errText(criteriaResult.reason) || 'تعذر تحميل معايير الأولوية.');

    let options = [];
    let source = 'overview';
    if (unified && typeof unified.list === 'function') {
      try {
        const listed = await unified.list({ dataset: 'developmentIssues', limit: ISSUE_SAMPLE_LIMIT });
        options = (listed?.rows ?? [])
          .map(row => ({ id: Number(row.issue_id ?? row.id), title: row.issue_title ?? row.title ?? '' }))
          .filter(item => Number.isSafeInteger(item.id) && item.id > 0);
        if (options.length) source = 'unified';
      } catch {
        options = []; // dataset not registered yet; fall back to the overview sample
      }
    }
    if (!options.length && overviewResult.status === 'fulfilled') {
      options = (overviewResult.value?.latestIssues ?? [])
        .map(item => ({ id: Number(item.issueId), title: item.title ?? '' }))
        .filter(item => Number.isSafeInteger(item.id) && item.id > 0);
    }
    setIssueOptions(options);
    setIssuesSource(source);
    setBaseLoading(false);
  }, [dev, unified]);

  useEffect(() => {
    loadBase();
  }, [loadBase, refreshKey, revision]);

  useEffect(() => {
    let cancelled = false;
    if (!unified || typeof unified.options !== 'function') {
      setFilterNote('قوائم الوحدات والفترات غير متاحة في هذه النسخة؛ يمكن عرض المصفوفة بدون تصفية.');
      return undefined;
    }
    async function loadOptions() {
      const [geoResult, periodResult] = await Promise.allSettled([
        unified.options({ kind: 'geo', limit: 300 }),
        unified.options({ kind: 'period', limit: 200 }),
      ]);
      if (cancelled) return;
      if (geoResult.status === 'fulfilled') setGeoOptions(Array.isArray(geoResult.value) ? geoResult.value : []);
      if (periodResult.status === 'fulfilled') setPeriodOptions(Array.isArray(periodResult.value) ? periodResult.value : []);
      if (geoResult.status === 'rejected' || periodResult.status === 'rejected') {
        setFilterNote('تعذر تحميل بعض قوائم التصفية؛ المصفوفة تظهر لكل النطاق.');
      } else {
        setFilterNote('');
      }
    }
    loadOptions();
    return () => { cancelled = true; };
  }, [unified, refreshKey]);

  useEffect(() => {
    if (!dev) return undefined;
    let cancelled = false;
    setMatrixLoading(true);
    setMatrixError('');
    dev.contextMatrix({ analysisType, geoUnitId: toId(geoUnitId), periodId: toId(periodId) })
      .then(result => { if (!cancelled) setMatrix(result ?? null); })
      .catch(cause => { if (!cancelled) setMatrixError(errText(cause) || 'تعذر تحميل مصفوفة السياق.'); })
      .finally(() => { if (!cancelled) setMatrixLoading(false); });
    return () => { cancelled = true; };
  }, [dev, analysisType, geoUnitId, periodId, refreshKey, revision]);

  useEffect(() => {
    if (!dev) return undefined;
    let cancelled = false;
    setRankingLoading(true);
    setRankingError('');
    dev.priorityRanking({ periodId: toId(periodId), geoUnitId: toId(geoUnitId) })
      .then(result => { if (!cancelled) setRanking(result ?? null); })
      .catch(cause => { if (!cancelled) setRankingError(errText(cause) || 'تعذر تحميل ترتيب أولوية القضايا.'); })
      .finally(() => { if (!cancelled) setRankingLoading(false); });
    return () => { cancelled = true; };
  }, [dev, periodId, geoUnitId, refreshKey, revision]);

  useEffect(() => {
    if (!dev || !selectedIssueId) {
      setTree(null);
      setTreeLoading(false);
      return undefined;
    }
    let cancelled = false;
    setTreeLoading(true);
    setTreeError('');
    dev.issueTree({ issueId: Number(selectedIssueId) })
      .then(result => { if (!cancelled) setTree(result ?? null); })
      .catch(cause => { if (!cancelled) setTreeError(errText(cause) || 'تعذر تحميل شجرة القضية.'); })
      .finally(() => { if (!cancelled) setTreeLoading(false); });
    return () => { cancelled = true; };
  }, [dev, selectedIssueId, refreshKey, revision]);

  const openEditor = (issueId = '') => {
    setForm({ ...emptyAssessmentForm(), issueId: issueId ? String(issueId) : '', criterionId: criteria[0] ? String(criteria[0].criterionId) : '' });
    setSaved(null);
    setEditorError('');
    setEditorOpen(true);
  };

  const submitAssessment = async (event) => {
    event.preventDefault();
    if (!dev || editorBusy) return;
    const issueId = toId(form.issueId);
    const criterionId = toId(form.criterionId);
    const rawScore = Number(form.rawScore);
    if (!issueId || !criterionId) {
      setEditorError('اختر القضية والمعيار قبل الحفظ.');
      return;
    }
    if (!Number.isFinite(rawScore)) {
      setEditorError('الدرجة الخام مطلوبة ويجب أن تكون رقماً صالحاً.');
      return;
    }
    setEditorBusy(true);
    setEditorError('');
    try {
      const result = await dev.saveAssessment({
        issueId,
        criterionId,
        rawScore,
        periodId: toId(periodId),
        rationale: form.rationale.trim() ? form.rationale.trim() : null,
        assessedBy: form.assessedBy.trim() ? form.assessedBy.trim() : null,
      });
      setSaved(result ?? null);
      setRevision(current => current + 1);
      if (!selectedIssueId) setSelectedIssueId(String(issueId));
      notify?.({ tone: 'ok', message: `حُفظ تقييم القضية ${issueId} على المعيار ${criterionId} وأُعيد احتساب الترتيب.` });
    } catch (cause) {
      setEditorError(errText(cause) || 'تعذر حفظ تقييم الأولوية.');
    } finally {
      setEditorBusy(false);
    }
  };

  const refreshAll = () => {
    setRevision(current => current + 1);
    notify?.({ tone: 'info', message: 'جارٍ تحديث التحليل التنموي من قاعدة البيانات.' });
  };

  if (!dev) {
    return (
      <Card title="التحليل التنموي">
        <Empty
          icon={Activity}
          title="وحدة التحليل التنموي غير متاحة"
          hint="هذه النافذة لا تعرّض جسر التحليل التنموي (window.localApp.development). أعد تشغيل التطبيق بالنسخة التي تسجل قنوات التحليل التنموي."
        />
      </Card>
    );
  }

  const counts = overview?.counts ?? {};
  const groups = matrix?.groups ? Object.entries(matrix.groups) : [];
  const rankingRows = ranking?.rows ?? [];
  const unrankedCount = rankingRows.filter(row => row.rank === null || row.rank === undefined).length;
  const selectedCriterion = criteria.find(item => String(item.criterionId) === String(form.criterionId)) ?? null;
  const issueSelectOptions = [{ value: '', label: 'اختر القضية' }, ...issueOptions.map(item => ({
    value: String(item.id),
    label: item.title ? `${item.title} (#${item.id})` : `قضية #${item.id}`,
  }))];
  const criterionSelectOptions = [{ value: '', label: 'اختر المعيار' }, ...criteria.map(item => ({
    value: String(item.criterionId),
    label: item.isActive ? `${item.nameAr} · وزن ${fmtNumber(item.defaultWeight, 3)}` : `${item.nameAr} · غير مفعّل`,
  }))];
  const periodSelectOptions = [{ value: '', label: 'بلا فترة (period_id IS NULL)' }, ...periodOptions.map(item => ({
    value: String(item.value),
    label: item.label ?? String(item.value),
  }))];

  return (
    <>
      <Card
        title="التحليل التنموي"
        subtitle="مصفوفة السياق SWOT/PESTLE وشجرة القضايا وترتيب الأولوية من قاعدة البيانات الشاملة، دون خلط فترات."
        icon={Activity}
        actions={(
          <div className="btn-row">
            <button className="btn small ghost" onClick={refreshAll} disabled={baseLoading && !overview}>
              <RefreshCw size={14} /> تحديث
            </button>
            <button className="btn small primary" onClick={() => openEditor()} disabled={!criteria.length || !issueOptions.length}>
              إضافة تقييم
            </button>
          </div>
        )}
      >
        {baseLoading && !overview ? <Loading label="جارٍ تحميل إحصاءات التحليل..." /> : (
          <div className="metric-grid">
            <Stat label="تحليلات السياق" value={counts.contexts} icon={Layers} index={0} />
            <Stat label="القضايا التنموية" value={counts.issues} icon={Target} index={1} />
            <Stat label="العوامل" value={counts.factors} icon={ListOrdered} index={2} />
            <Stat label="الأدلة" value={counts.evidence} icon={Scale} index={3} />
            <Stat label="معايير الأولوية" value={counts.criteria} icon={Scale} index={4} />
            <Stat label="التقييمات" value={counts.assessments} icon={Activity} index={5}
              note={unrankedCount ? `${fmtNumber(unrankedCount, 0)} قضية غير مقيّمة` : undefined} />
          </div>
        )}
        {overview?.notes && Object.values(overview.notes).length > 0 && (
          <div className="chip-row" style={{ marginTop: 12 }}>
            {Object.values(overview.notes).map(note => <span className="chip warn" key={note}>{note}</span>)}
          </div>
        )}
      </Card>

      {error && <ErrorBanner message={error} onDismiss={() => setError('')} />}

      <Card
        title="مصفوفة السياق"
        subtitle="كل بند يظهر في مجموعته كما هو مخزّن؛ الأنواع غير المعروفة تبقى في مجموعتها ولا تُحذف."
        icon={Layers}
        actions={<Segmented value={analysisType} onChange={setAnalysisType} options={ANALYSIS_TYPES} />}
      >
        <div className="grid-2">
          <Field label="الوحدة الجغرافية">
            <SelectInput
              value={geoUnitId}
              onChange={setGeoUnitId}
              options={[{ value: '', label: 'كل الوحدات الجغرافية' }, ...geoOptions.map(option => ({
                value: String(option.value),
                label: option.subtitle ? `${option.label} · ${option.subtitle}` : option.label,
              }))]}
            />
          </Field>
          <Field label="الفترة المرجعية">
            <SelectInput
              value={periodId}
              onChange={setPeriodId}
              options={[{ value: '', label: 'كل الفترات' }, ...periodOptions.map(option => ({
                value: String(option.value),
                label: option.label ?? String(option.value),
              }))]}
            />
          </Field>
        </div>
        {filterNote && <p className="field-hint">{filterNote}</p>}
        {matrixError && <ErrorBanner message={matrixError} onDismiss={() => setMatrixError('')} />}
        {matrix?.note && <p className="field-hint">{matrix.note}</p>}
        {matrix?.unmappedFactorTypes?.length > 0 && (
          <div className="chip-row">
            {matrix.unmappedFactorTypes.map((type, index) => (
              <Badge tone="warn" key={`${type ?? 'unknown'}-${index}`}>نوع غير معروف: {type ?? 'فارغ'}</Badge>
            ))}
          </div>
        )}
        {matrixLoading && !matrix ? <Skeleton rows={3} /> : groups.length === 0 ? (
          <Empty icon={Layers} title="لا بنود في هذه المصفوفة" hint="أضف بنود SWOT/PESTLE أو غيّر الوحدة الجغرافية والفترة." />
        ) : (
          <div className="grid-2">
            {groups.map(([key, group]) => (
              <Card key={key} title={`${group.labelAr} · ${fmtNumber(group.items?.length ?? 0, 0)}`} className="padded">
                {(group.items ?? []).length === 0
                  ? <span className="muted">لا بنود مسجلة في هذه المجموعة.</span>
                  : (group.items ?? []).map(item => (
                    <div className="quote" key={item.analysisId}>
                      <div className="row between">
                        <strong>{item.title || 'بلا عنوان'}</strong>
                        <div className="chip-row">
                          {item.impactDirection && <Badge tone="info">{item.impactDirection}</Badge>}
                          <Badge tone={severityTone(item.impactSeverity)}>{severityLabel(item.impactSeverity)}</Badge>
                        </div>
                      </div>
                      {item.description && <p>{item.description}</p>}
                      {item.evidenceSummary && <div className="dim" style={{ fontSize: '0.78rem' }}>الدليل: {item.evidenceSummary}</div>}
                      {(item.timeHorizon || item.responseStrategy) && (
                        <div className="muted" style={{ fontSize: '0.76rem' }}>
                          {item.timeHorizon ? `المدى الزمني: ${item.timeHorizon}` : ''}
                          {item.timeHorizon && item.responseStrategy ? ' · ' : ''}
                          {item.responseStrategy ? `الاستجابة: ${item.responseStrategy}` : ''}
                        </div>
                      )}
                    </div>
                  ))}
              </Card>
            ))}
          </div>
        )}
      </Card>

      <Card
        title="شجرة القضية"
        subtitle="الأسباب والآثار والقيود والفرص والمخاطر كما هي مسجلة، مع أدلة كل قضية ومصادرها."
        icon={Target}
        actions={issueOptions.length > 0 ? (
          <SelectInput
            value={selectedIssueId}
            onChange={setSelectedIssueId}
            options={[{ value: '', label: 'اختر قضية تنموية' }, ...issueOptions.map(item => ({
              value: String(item.id),
              label: item.title ? `${item.title} (#${item.id})` : `قضية #${item.id}`,
            }))]}
          />
        ) : null}
      >
        {issuesSource === 'overview' && issueOptions.length > 0 && (
          <p className="field-hint">القائمة مأخوذة من آخر القضايا المسجلة في ملخص التحليل لأن مجموعة بيانات القضايا غير مفعّلة بعد.</p>
        )}
        {treeError && <ErrorBanner message={treeError} onDismiss={() => setTreeError('')} />}
        {!selectedIssueId ? (
          <Empty icon={Target} title="لم تُحدد قضية" hint={issueOptions.length ? 'اختر قضية من القائمة لعرض شجرتها وأدلتها.' : 'لا توجد قضايا مسجلة في قاعدة البيانات الحالية.'} />
        ) : treeLoading && !tree ? <Loading label="جارٍ تحميل شجرة القضية..." /> : tree?.issue ? (
          <div className="stack">
            <div className="card padded">
              <div className="row between">
                <strong>{tree.issue.title}</strong>
                <div className="chip-row">
                  {tree.issue.code && <Badge tone="info">{tree.issue.code}</Badge>}
                  {tree.issue.geoUnitName && <Badge>{tree.issue.geoUnitName}</Badge>}
                  {tree.issue.sectorName && <Badge>{tree.issue.sectorName}</Badge>}
                </div>
              </div>
              {tree.issue.description && <p>{tree.issue.description}</p>}
              {tree.issue.generalChallenge && <p className="muted">التحدي العام: {tree.issue.generalChallenge}</p>}
              {tree.issue.populationShare !== null && tree.issue.populationShare !== undefined && (
                <p className="muted">حصة السكان: {fmtPercent(tree.issue.populationShare * 100, 1)}</p>
              )}
            </div>

            {ISSUE_GROUPS.map(group => {
              const items = tree.factors?.[group.key] ?? [];
              return (
                <div className="stack tight" key={group.key}>
                  <div className="row between">
                    <strong>{group.label}</strong>
                    <Badge tone={items.length ? 'info' : ''}>{fmtNumber(items.length, 0)}</Badge>
                  </div>
                  {items.length === 0 ? <span className="muted">لا بنود مسجلة.</span> : items.map(item => (
                    <div className="list-item" key={item.factorId}>
                      <div className="row between">
                        <span className="flex1">{item.description || 'بلا وصف'}</span>
                        {item.severity !== null && item.severity !== undefined && (
                          <Badge tone={severityTone(item.severity)}>{severityLabel(item.severity)}</Badge>
                        )}
                      </div>
                      {item.sourceId !== null && item.sourceId !== undefined && (
                        <span className="dim" style={{ fontSize: '0.76rem' }}>مصدر #{item.sourceId}</span>
                      )}
                    </div>
                  ))}
                </div>
              );
            })}

            <div className="stack tight">
              <strong>الأدلة</strong>
              <p className="field-hint">المصدر يظهر باسمه عند توفره، وإلا يظهر معرّفه كما هو مسجل.</p>
              {(tree.evidence ?? []).length === 0 ? <span className="muted">لا أدلة مسجلة لهذه القضية.</span> : (
                <div className="table-wrap">
                  <table className="data">
                    <thead>
                      <tr><th>النوع</th><th>الوصف</th><th>المصدر</th><th>الموضع</th><th>الفترة</th><th>الجغرافيا</th><th className="num">الثقة</th></tr>
                    </thead>
                    <tbody>
                      {(tree.evidence ?? []).map(item => (
                        <tr key={item.evidenceId}>
                          <td>{item.evidenceType || DASH}</td>
                          <td>{item.description || DASH}</td>
                          <td>{item.sourceLabel || (item.sourceId ? `#${item.sourceId}` : DASH)}</td>
                          <td className="dim">{item.sourceLocator || DASH}</td>
                          <td>{item.periodLabel || DASH}</td>
                          <td>{item.geoUnitName || DASH}</td>
                          <td className="num">{item.confidence === null || item.confidence === undefined ? DASH : fmtNumber(item.confidence, 2)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        ) : (
          <Empty icon={AlertTriangle} title="لا يمكن عرض هذه القضية" hint={tree?.note ?? 'القضية المحددة غير موجودة أو جدول القضايا غير متاح.'} />
        )}
      </Card>

      <Card
        title="معايير الأولوية"
        subtitle="الوزن والاتجاه كما هما معتمدان في قاعدة البيانات؛ التقييم على معيار غير مفعّل مرفوض من الخدمة."
        icon={Scale}
      >
        {criteriaError && <ErrorBanner message={criteriaError} onDismiss={() => setCriteriaError('')} />}
        {criteria.length === 0 ? (
          <Empty icon={Scale} title="لا معايير أولوية" hint="لم تُسجّل معايير أولوية في قاعدة البيانات الحالية." />
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr><th>الرمز</th><th>المعيار</th><th className="num">الوزن</th><th>الاتجاه</th><th className="num">الأدنى</th><th className="num">الأعلى</th><th>الحالة</th><th /></tr>
              </thead>
              <tbody>
                {criteria.map(criterion => (
                  <tr key={criterion.criterionId}>
                    <td className="mono dim">{criterion.code || DASH}</td>
                    <td className="strong">{criterion.nameAr || DASH}</td>
                    <td className="num">{fmtNumber(criterion.defaultWeight, 3)}</td>
                    <td>{criterion.direction || DASH}</td>
                    <td className="num">{criterion.scaleMin === null ? DASH : fmtNumber(criterion.scaleMin, 2)}</td>
                    <td className="num">{criterion.scaleMax === null ? DASH : fmtNumber(criterion.scaleMax, 2)}</td>
                    <td>{criterion.isActive ? <Badge tone="ok">مفعّل</Badge> : <Badge tone="warn">غير مفعّل</Badge>}</td>
                    <td>
                      <button className="btn small ghost" type="button" disabled={!criterion.isActive}
                        onClick={() => { openEditor(); setForm(current => ({ ...current, criterionId: String(criterion.criterionId) })); }}>
                        تقييم
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card
        title="ترتيب أولوية القضايا"
        subtitle={ranking?.scope?.note ?? 'الترتيب مقيد بنطاق واحد؛ القضايا غير المقيّمة لا تأخذ رتبة ولا درجة صفرية.'}
        icon={ListOrdered}
        flush
      >
        {rankingError && <div style={{ padding: 16 }}><ErrorBanner message={rankingError} onDismiss={() => setRankingError('')} /></div>}
        {ranking?.note && <p className="field-hint" style={{ paddingInline: 16 }}>{ranking.note}</p>}
        {rankingLoading && !ranking ? <div style={{ padding: 20 }}><Loading label="جارٍ حساب الترتيب..." /></div> : rankingRows.length === 0 ? (
          <Empty icon={ListOrdered} title="لا قضايا للترتيب" hint="أضف قضايا وتقييمات على معايير مفعّلة، ثم أعد التحميل." />
        ) : (
          <>
            <div className="table-wrap" style={{ maxHeight: 520 }}>
              <table className="data">
                <thead>
                  <tr>
                    <th className="num">الرتبة</th>
                    <th>القضية</th>
                    <th className="num">الدرجة المعيارية</th>
                    <th className="num">الموزون</th>
                    <th className="num">التغطية</th>
                    <th className="num">المجموع الخام</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {rankingRows.map(row => {
                    const rated = row.rank !== null && row.rank !== undefined;
                    return (
                      <tr key={row.issueId}>
                        <td className="num">{rated ? row.rank : DASH}</td>
                        <td className="strong">
                          <div className="stack tight">
                            <span>{row.title || `قضية #${row.issueId}`}</span>
                            {!rated && <Badge tone="warn">غير مقيّمة</Badge>}
                          </div>
                        </td>
                        <td className="num">{rated && row.normalizedScore !== null ? fmtNumber(row.normalizedScore, 4) : DASH}</td>
                        <td className="num">{rated && row.weightedTotal !== null ? fmtNumber(row.weightedTotal, 4) : DASH}</td>
                        <td className="num">{rated && row.coverage !== null ? fmtPercent(row.coverage * 100, 1) : DASH}</td>
                        <td className="num">{row.rawTotal === null || row.rawTotal === undefined ? DASH : fmtNumber(row.rawTotal, 3)}</td>
                        <td>
                          <button className="btn small ghost" type="button" onClick={() => openEditor(row.issueId)}>
                            {rated ? 'تحديث التقييم' : 'تقييم'}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="row between" style={{ padding: '12px 16px' }}>
              <span className="muted">
                {fmtNumber(rankingRows.length, 0)} قضية في النطاق
                {unrankedCount > 0 ? ` · ${fmtNumber(unrankedCount, 0)} غير مقيّمة` : ''}
                {ranking?.ignoredInactiveAssessments ? ` · ${fmtNumber(ranking.ignoredInactiveAssessments, 0)} تقييم على معايير غير مفعّلة مستثنى` : ''}
              </span>
              <span className="muted" style={{ fontSize: '0.76rem' }}>
                {ranking?.formula?.normalization ? `التطبيع: ${ranking.formula.normalization}` : ''}
              </span>
            </div>
          </>
        )}
      </Card>

      <Modal
        open={editorOpen}
        title="تقييم أولوية قضية"
        subtitle="الخدمة تحسب الدرجة المعيارية والموزونة من مجموعة تقييمات المعيار والفترة نفسها، ثم تعيد احتساب بقية الصفوف."
        onClose={() => { if (!editorBusy) setEditorOpen(false); }}
        footer={(
          <div className="btn-row">
            <button className="btn ghost" type="button" onClick={() => setEditorOpen(false)} disabled={editorBusy}>إغلاق</button>
            <button className="btn primary" type="submit" form="assessment-form" disabled={editorBusy}>
              {editorBusy ? 'جارٍ الحفظ...' : 'حفظ التقييم'}
            </button>
          </div>
        )}
      >
        <form id="assessment-form" className="stack" onSubmit={submitAssessment}>
          {editorError && <ErrorBanner message={editorError} onDismiss={() => setEditorError('')} />}
          <div className="grid-2">
            <Field label="القضية التنموية" required hint={issueOptions.length ? undefined : 'لا قضايا متاحة؛ أضف قضية أولاً.'}>
              <SelectInput value={form.issueId} onChange={value => setForm(current => ({ ...current, issueId: value }))} options={issueSelectOptions} required />
            </Field>
            <Field label="المعيار" required hint={selectedCriterion && selectedCriterion.scaleMin !== null && selectedCriterion.scaleMax !== null
              ? `المدى ${fmtNumber(selectedCriterion.scaleMin, 2)} – ${fmtNumber(selectedCriterion.scaleMax, 2)}`
              : undefined}>
              <SelectInput value={form.criterionId} onChange={value => setForm(current => ({ ...current, criterionId: value }))} options={criterionSelectOptions} required />
            </Field>
            <Field label="الدرجة الخام" required hint="تُدخل كما قيست؛ التطبيع مسؤولية الخدمة.">
              <NumberInput value={form.rawScore} onChange={value => setForm(current => ({ ...current, rawScore: value }))} required />
            </Field>
            <Field label="الفترة المرجعية" hint="بلا فترة يعني تقييماً غير مرتبط بفترة (period_id IS NULL).">
              <SelectInput value={periodId} onChange={setPeriodId} options={periodSelectOptions} />
            </Field>
            <Field label="المقيّم" hint="اسم صريح يُحفظ مع التقييم.">
              <TextInput value={form.assessedBy} onChange={value => setForm(current => ({ ...current, assessedBy: value }))} maxLength={160} placeholder="مثال: محلل التخطيط" />
            </Field>
            <Field label="مبرر التقييم" hint="يُحفظ في سجل التدقيق.">
              <TextInput value={form.rationale} onChange={value => setForm(current => ({ ...current, rationale: value }))} maxLength={1000} placeholder="سبب الدرجة" />
            </Field>
          </div>

          {saved && (
            <div className="quote">
              <strong>القيم المحسوبة بعد الحفظ</strong>
              <div className="chip-row" style={{ marginTop: 6 }}>
                <Badge tone="info">معيارية: {saved.normalizedScore === null ? DASH : fmtNumber(saved.normalizedScore, 4)}</Badge>
                <Badge tone="info">موزونة: {saved.weightedScore === null ? DASH : fmtNumber(saved.weightedScore, 4)}</Badge>
                <Badge>الوزن المطبق: {fmtNumber(saved.appliedWeight, 3)}</Badge>
                <Badge tone={saved.created ? 'ok' : 'warn'}>{saved.created ? 'تقييم جديد' : 'تحديث تقييم'}</Badge>
                {saved.lowerIsBetter && <Badge tone="warn">الاتجاه معكوس</Badge>}
                {saved.recalculated > 0 && <Badge>{fmtNumber(saved.recalculated, 0)} صفاً أُعيد احتسابه</Badge>}
              </div>
              {saved.scale && (
                <div className="muted" style={{ fontSize: '0.76rem' }}>
                  مجموعة التطبيع: {fmtNumber(saved.scale.min, 2)} – {fmtNumber(saved.scale.max, 2)} عبر {fmtNumber(saved.scale.count, 0)} تقييماً.
                </div>
              )}
            </div>
          )}
        </form>
      </Modal>
    </>
  );
}
