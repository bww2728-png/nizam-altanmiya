import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle, ArrowDownToLine, Check, ChevronDown, FolderUp, Gauge, Info,
  Play, RefreshCw, Save, ShieldCheck, SlidersHorizontal, Table2, X,
} from 'lucide-react';
import { INDICATORS_META } from './indicatorsMeta.mjs';
import './analysis.css';

const arNumber = new Intl.NumberFormat('ar');

function fmt(value, digits = 3) {
  if (value === null || value === undefined || value === '') return '—';
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric.toFixed(digits) : String(value);
}

function pct(value) {
  if (value === null || value === undefined) return '—';
  const numeric = Number(value);
  return Number.isFinite(numeric) ? `${Math.round(numeric * 100)}%` : '—';
}

const CONFIDENCE_LABEL = {
  blocked: ['محجوبة', 'blocked'],
  preliminary: ['مبدئية', 'preliminary'],
  boundary: ['حدّية', 'boundary'],
  confirmed: ['مؤكدة', 'confirmed'],
};

const TABS = [
  { id: 'priorities', label: 'الأولويات', icon: Gauge },
  { id: 'gaps', label: 'فجوات البيانات', icon: AlertTriangle },
  { id: 'sensitivity', label: 'الحساسية', icon: SlidersHorizontal },
  { id: 'weights', label: 'الأوزان والمعايرة', icon: SlidersHorizontal },
  { id: 'audit', label: 'سجل التدقيق', icon: ShieldCheck },
];

export default function AnalysisPage({ onToast, onError }) {
  const [template, setTemplate] = useState(null);
  const [analysis, setAnalysis] = useState(null);
  const [runId, setRunId] = useState(null);
  const [tab, setTab] = useState('priorities');
  const [busy, setBusy] = useState('');
  const [directorateCount, setDirectorateCount] = useState(null);
  const [latestRun, setLatestRun] = useState(null);
  const [fields, setFields] = useState([]);

  const notify = useCallback((message) => { if (onToast) onToast(message); }, [onToast]);
  const fail = useCallback((cause, fallback) => { if (onError) onError(cause?.message || fallback); }, [onError]);

  const refreshCount = useCallback(async () => {
    try {
      const result = await window.localApp.directorates({ limit: 1 });
      setDirectorateCount(result.total);
    } catch (cause) {
      fail(cause, 'تعذر قراءة عدد المديريات.');
    }
  }, [fail]);

  useEffect(() => {
    refreshCount();
    window.localApp.fieldCatalogue().then(setFields).catch(() => {});
    window.localApp.latestAnalysis()
      .then((value) => { if (value) setLatestRun(value.run); })
      .catch(() => {});
  }, [refreshCount]);

  async function pickTemplate() {
    setBusy('read');
    try {
      const result = await window.localApp.readTemplate();
      if (result.canceled) return;
      setTemplate(result);
      notify(`قُرئ «${result.fileName}»: ${arNumber.format(result.totalRows)} مديرية في ورقة «${result.sheetName}».`);
      if (result.missingInputs?.length) {
        fail({ message: `أعمدة ناقصة في الملف: ${result.missingInputs.map((field) => field.header).join('، ')}` }, '');
      }
    } catch (cause) {
      fail(cause, 'تعذر قراءة ملف القالب.');
    } finally {
      setBusy('');
    }
  }

  async function commitTemplate() {
    setBusy('commit');
    try {
      const result = await window.localApp.commitTemplate();
      notify(`حُفظت ${arNumber.format(result.total)} مديرية (جديد ${result.created} · محدّث ${result.updated}).`);
      const messages = [];
      if (result.duplicates?.length) {
        messages.push(`تكرار داخل الملف: ${result.duplicates.map((entry) => `${entry.district} (${entry.governorate || 'بلا محافظة'})`).join('، ')} — يُعتمد آخر صف، وراجع الصفوف ${result.duplicates.map((entry) => `${entry.firstRow}/${entry.repeatedRow}`).join('، ')}.`);
      }
      if (result.stale?.length) {
        messages.push(`مديريات محفوظة سابقًا من هذا الملف ولم تعد فيه: ${result.stale.map((entry) => `${entry.district} (${entry.governorate || 'بلا محافظة'})`).join('، ')} — بقيت في القاعدة ولن تُحذف تلقائيًا.`);
      }
      if (messages.length) fail({ message: messages.join(' ') }, '');
      setTemplate(null);
      refreshCount();
      window.localApp.latestAnalysis().then((value) => setLatestRun(value ? value.run : null)).catch(() => {});
    } catch (cause) {
      fail(cause, 'تعذر حفظ المديريات في قاعدة البيانات.');
    } finally {
      setBusy('');
    }
  }

  async function runAnalysis() {
    setBusy('run');
    try {
      const result = await window.localApp.runAnalysis({});
      setAnalysis(result.analysis);
      setRunId(result.runId);
      setTab('priorities');
      notify(`اكتمل التحليل: ${arNumber.format(result.analysis.summary.rows)} مديرية.`);
      window.localApp.latestAnalysis().then((value) => { if (value) setLatestRun(value.run); }).catch(() => {});
    } catch (cause) {
      fail(cause, 'تعذر تشغيل التحليل.');
    } finally {
      setBusy('');
    }
  }

  async function exportExcel() {
    setBusy('excel');
    try {
      const result = await window.localApp.exportAnalysisExcel();
      if (!result.canceled) notify('صُدّر ملف Excel بنتائج التحليل.');
    } catch (cause) {
      fail(cause, 'تعذر تصدير Excel.');
    } finally {
      setBusy('');
    }
  }

  async function exportPdf() {
    setBusy('pdf');
    try {
      const result = await window.localApp.exportAnalysisPdf();
      if (!result.canceled) notify('صُدّر تقرير PDF.');
    } catch (cause) {
      fail(cause, 'تعذر تصدير PDF.');
    } finally {
      setBusy('');
    }
  }

  return <div className="analysis-page">
    <div className="page-heading">
      <div>
        <p className="eyebrow">التحليل التنموي</p>
        <h1>تحليل وترتيب الأولويات</h1>
        <p>مسارَان متوازيان: مطابقة حرفية لمعادلة القالب، ومعايرة علمية تحجب الحكم حين لا تكفي الأدلة.</p>
      </div>
      <div className="analysis-actions">
        <button className="secondary-button" onClick={pickTemplate} disabled={Boolean(busy)}>
          <FolderUp size={16} />{busy === 'read' ? 'جارٍ القراءة...' : 'اختيار ملف القالب'}
        </button>
        <button className="primary-button" onClick={runAnalysis} disabled={Boolean(busy) || !directorateCount}>
          <Play size={16} />{busy === 'run' ? 'جارٍ التحليل...' : 'تشغيل التحليل'}
        </button>
      </div>
    </div>

    <div className="analysis-status-strip">
      <div className="analysis-status-item">
        <span className="label">مديريات في القاعدة</span>
        <strong>{directorateCount === null ? '—' : arNumber.format(directorateCount)}</strong>
      </div>
      <div className="analysis-status-item">
        <span className="label">آخر تشغيل محفوظ</span>
        <strong>{latestRun ? new Date(latestRun.createdAt).toLocaleString('ar') : 'لا يوجد'}</strong>
      </div>
      <div className="analysis-status-item">
        <span className="label">القالب المرجعي</span>
        <strong>القالب المحدث · V3.3</strong>
      </div>
      <div className="analysis-status-buttons">
        <button className="secondary-button" onClick={exportExcel} disabled={Boolean(busy)}>
          <ArrowDownToLine size={16} />Excel
        </button>
        <button className="secondary-button" onClick={exportPdf} disabled={Boolean(busy)}>
          <ArrowDownToLine size={16} />PDF
        </button>
        <button className="icon-button" title="تحديث" onClick={refreshCount}><RefreshCw size={16} /></button>
      </div>
    </div>

    {template && <section className="panel template-panel">
      <div className="panel-heading">
        <div>
          <h2>جاهز للاستيراد: {template.fileName}</h2>
          <p>ورقة «{template.sheetName}» · صف الرأس {template.headerRow} · {arNumber.format(template.totalRows)} مديرية · {template.matchedCount} عمودًا مطابقًا</p>
        </div>
        <button className="secondary-button" onClick={() => setTemplate(null)}><X size={15} />إلغاء</button>
      </div>
      {template.preview?.length > 0 && <div className="template-preview">
        {template.preview.map((row) => <span key={`${row.rowNumber}-${row.districtName}`} className="preview-chip">
          {row.districtName}<em>{row.governorate || '—'}</em>
        </span>)}
      </div>}
      {template.warnings?.length > 0 && <div className="inline-warning"><AlertTriangle size={16} />{template.warnings.map((warning) => warning.message).join(' ')}</div>}
      {template.duplicates?.length > 0 && <div className="inline-warning"><AlertTriangle size={16} />أعمدة مكرّرة الدلالة (احتُسب الأعلى تطابقًا): {template.duplicates.map((entry) => `${entry.label} ← ${entry.key}`).join('، ')}</div>}
      <button className="primary-button" onClick={commitTemplate} disabled={Boolean(busy)}>
        <Save size={16} />{busy === 'commit' ? 'جارٍ الحفظ...' : 'حفظ المديريات في قاعدة البيانات'}
      </button>
    </section>}

    {!analysis && <section className="panel analysis-empty">
      <div className="empty-icon"><Table2 size={22} /></div>
      <strong>لا توجد نتائج تحليل بعد</strong>
      <p>اختر ملف «القالب المحدث» لحفظ المديريات في قاعدة البيانات، ثم شغّل التحليل. يمكنك أيضًا تشغيل التحليل مباشرة على المديريات المحفوظة.</p>
      <div className="analysis-steps">
        <span><b>1</b> اختيار ملف القالب وقراءته</span>
        <span><b>2</b> حفظ المديريات في القاعدة المشفّرة</span>
        <span><b>3</b> تشغيل التحليل واستعراض الأولويات</span>
      </div>
    </section>}

    {analysis && <>
      <SummaryCards summary={analysis.summary} />
      <nav className="analysis-tabs">
        {TABS.map(({ id, label, icon: Icon }) => <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}><Icon size={16} />{label}</button>)}
        <span className="run-badge">{runId ? `تشغيل #${runId}` : 'تشغيل غير محفوظ'}</span>
      </nav>

      {tab === 'priorities' && <PrioritiesTab analysis={analysis} fields={fields} />}
      {tab === 'gaps' && <GapsTab analysis={analysis} />}
      {tab === 'sensitivity' && <SensitivityTab analysis={analysis} />}
      {tab === 'weights' && <WeightsTab analysis={analysis} notify={notify} fail={fail} onChanged={() => setAnalysis(null)} />}
      {tab === 'audit' && <AuditTab />}
    </>}
  </div>;
}

function SummaryCards({ summary }) {
  const cards = [
    { label: 'المديريات المحلّلة', value: summary.rows, note: `${summary.complete ?? 0} مكتملة · ${summary.waiting ?? 0} ناقصة` },
    { label: 'مرتبة بالمعايرة', value: summary.calibratedRanked, note: 'المسار العلمي' },
    { label: 'محجوبة لقلة الأدلة', value: summary.calibratedBlocked, note: 'لا يصح إصدار رقم لها' },
    { label: 'حرمان حاد', value: summary.severeCount, note: 'تتجاوز عتبة الأبعاد المتدهورة' },
    { label: 'قرارات هشّة', value: summary.fragileCount, note: 'تتغير رتبتها مع الأوزان' },
    { label: 'متوسط الاكتمال', value: pct(summary.averageCompleteness), note: `${summary.totalMandatoryFields ?? 13} حقلًا إلزاميًا` },
  ];
  return <div className="analysis-metrics">
    {cards.map((card) => <article key={card.label} className="analysis-metric">
      <span>{card.label}</span>
      <strong>{typeof card.value === 'number' ? arNumber.format(card.value) : (card.value ?? '—')}</strong>
      <small>{card.note}</small>
    </article>)}
  </div>;
}

function ConfidenceBadge({ level }) {
  const [label, tone] = CONFIDENCE_LABEL[level] || ['—', 'preliminary'];
  return <span className={`confidence-badge ${tone}`}>{label}</span>;
}

function PrioritiesTab({ analysis, fields }) {
  const [mode, setMode] = useState('calibrated');
  const [expanded, setExpanded] = useState(null);
  const rows = analysis.rows;
  const calibrated = analysis.ranking.calibrated.ranked.map((index) => rows[index]);
  const blocked = analysis.ranking.calibrated.blocked.map((index) => rows[index]);
  const replicaRanked = analysis.ranking.replica.ranked.map((index) => rows[index]);
  const waiting = analysis.ranking.replica.waiting.map((index) => rows[index]);
  const comparison = analysis.ranking.comparison;

  return <div className="analysis-tab-body">
    <div className="mode-switch">
      <button className={mode === 'calibrated' ? 'active' : ''} onClick={() => setMode('calibrated')}>المعايرة العلمية</button>
      <button className={mode === 'replica' ? 'active' : ''} onClick={() => setMode('replica')}>مطابقة القالب</button>
      <span className="mode-note">{mode === 'calibrated'
        ? 'الترتيب: حرمان حاد أولًا، ثم المركب المعاير، ثم عدد الأبعاد المتدهورة.'
        : 'الترتيب: المركب الحرفي (AZ) للسجلات المكتملة فقط، والباقي بانتظار البيانات.'}</span>
    </div>

    {mode === 'calibrated'
      ? <section className="panel table-panel">
        <div className="panel-heading"><div><h2>ترتيب الأولويات</h2><p>{calibrated.length} مديرية مؤهلة · {blocked.length} محجوبة · عتبة الانحدار {comparison?.kThreshold ?? 4} من 12</p></div></div>
        <div className="table-scroll"><table className="analysis-table">
          <thead><tr>
            <th>#</th><th>المديرية</th><th>المحافظة</th><th>المركب المعاير</th>
            <th>أبعاد متدهورة</th><th>تغطية الأوزان</th><th>رتبة القالب</th><th>الإزاحة</th>
            <th>نوع المشروع</th><th>التقييم</th><th />
          </tr></thead>
          <tbody>{calibrated.map((row) => {
            const shift = row.replica?.rank && row.calibrated?.rank ? row.replica.rank - row.calibrated.rank : null;
            return <React.Fragment key={row.key}>
              <tr className={row.calibrated?.severe ? 'row-severe' : ''}>
                <td className="rank-cell">{row.calibrated.rank}</td>
                <td className="district-cell">{row.districtName}{row.calibrated?.severe && <span className="tag severe">حرمان حاد</span>}</td>
                <td>{row.governorate || '—'}</td>
                <td className="num-cell">{fmt(row.calibrated.composite)}</td>
                <td className="num-cell">{row.calibrated.degradedCount} / 12</td>
                <td className="num-cell">{pct(row.calibrated.weightCoverage)}</td>
                <td className="num-cell">{row.replica?.rank ?? 'غير مؤهلة'}</td>
                <td className="num-cell">{shift === null ? '—' : (shift > 0 ? `+${shift}` : shift)}</td>
                <td>{row.project?.label ?? '—'}</td>
                <td><ConfidenceBadge level={row.confidence?.level} /></td>
                <td><button className="quiet-button" onClick={() => setExpanded(expanded === row.key ? null : row.key)}>{expanded === row.key ? 'إخفاء' : 'تفاصيل'}<ChevronDown size={14} /></button></td>
              </tr>
              {expanded === row.key && <tr className="detail-row"><td colSpan={11}><DistrictDetail row={row} fields={fields} /></td></tr>}
            </React.Fragment>;
          })}</tbody>
        </table></div>
        {!calibrated.length && <div className="table-empty">لا توجد مديريات مؤهلة للترتيب المعاير في هذه الدفعة.</div>}
      </section>
      : <section className="panel table-panel">
        <div className="panel-heading"><div><h2>ترتيب مطابقة القالب</h2><p>{replicaRanked.length} مؤهلة · {waiting.length} بانتظار البيانات</p></div></div>
        <div className="table-scroll"><table className="analysis-table">
          <thead><tr><th>#</th><th>المديرية</th><th>المحافظة</th><th>المركب (AZ)</th><th>الاكتمال</th><th>الفجوة عن اكتمال</th><th>نوع المشروع</th><th>التقييم</th></tr></thead>
          <tbody>{replicaRanked.map((row) => <tr key={row.key}>
            <td className="rank-cell">{row.replica.rank}</td>
            <td className="district-cell">{row.districtName}</td>
            <td>{row.governorate || '—'}</td>
            <td className="num-cell">{fmt(row.replica.composite)}</td>
            <td className="num-cell">{pct(row.completeness.ratio)}</td>
            <td className="num-cell">{pct(1 - row.completeness.ratio)}</td>
            <td>{row.project?.label ?? '—'}</td>
            <td><ConfidenceBadge level={row.confidence?.level} /></td>
          </tr>)}</tbody>
        </table></div>
        {waiting.length > 0 && <>
          <div className="panel-heading sub-heading"><div><h3>بانتظار استكمال البيانات</h3><p>لا تُرتَّب هذه السجلات حتى يكتمل اكتمالها بنسبة 100%.</p></div></div>
          <div className="table-scroll"><table className="analysis-table">
            <thead><tr><th>#</th><th>المديرية</th><th>الاكتمال</th><th>الحقول الناقصة</th><th>المركب (AZ)</th></tr></thead>
            <tbody>{waiting.map((row, index) => <tr key={row.key}>
              <td className="rank-cell">{index + 1}</td>
              <td className="district-cell">{row.districtName}</td>
              <td className="num-cell">{pct(row.completeness.ratio)}</td>
              <td className="missing-cell">{row.completeness.missingText}</td>
              <td className="num-cell">{fmt(row.replica.composite)}</td>
            </tr>)}</tbody>
          </table></div>
        </>}
      </section>}

    {mode === 'calibrated' && blocked.length > 0 && <section className="panel table-panel">
      <div className="panel-heading"><div><h2>محجوبة لقلة الأدلة</h2><p>نسبة الأوزان المتاحة أقل من الحد الأدنى؛ الإجابة الصحيحة «بيانات غير كافية» لا رقم مضلّل.</p></div></div>
      <div className="table-scroll"><table className="analysis-table">
        <thead><tr><th>المديرية</th><th>المحافظة</th><th>تغطية الأوزان</th><th>سبب الحجب</th><th>الحقول الناقصة</th></tr></thead>
        <tbody>{blocked.map((row) => <tr key={row.key}>
          <td className="district-cell">{row.districtName}</td>
          <td>{row.governorate || '—'}</td>
          <td className="num-cell">{pct(row.calibrated.weightCoverage)}</td>
          <td>{row.calibrated.blockReason === 'insufficient-weight-coverage' ? 'أدلة غير كافية' : (row.calibrated.blockReason || '—')}</td>
          <td className="missing-cell">{row.completeness.missingText}</td>
        </tr>)}</tbody>
      </table></div>
    </section>}

    {comparison && <section className="panel comparison-panel">
      <div className="panel-heading"><div><h2>مقارنة المسارين</h2><p>{comparison.comparable} مديرية قابلة للمقارنة · {comparison.changed.length} تغيّرت رتبتها · أقصى إزاحة {comparison.maxShift}</p></div></div>
      {comparison.changed.length > 0 && <div className="comparison-list">
        {comparison.changed.map((pair) => <div key={`${pair.index ?? pair.districtName}-${pair.governorate ?? ''}`} className="comparison-chip">
          <span>{pair.districtName}{pair.governorate ? ` · ${pair.governorate}` : ''}</span>
          <em>القالب {pair.replicaRank} ← المعايرة {pair.calibratedRank}</em>
          <b className={pair.delta > 0 ? 'up' : 'down'}>{pair.delta > 0 ? `+${pair.delta}` : pair.delta}</b>
        </div>)}
      </div>}
      {!comparison.changed.length && <p className="muted">لم تتغير أي رتبة بين المسارين في هذه الدفعة.</p>}
    </section>}
  </div>;
}

function DistrictDetail({ row, fields }) {
  const indicators = INDICATORS_META.filter((meta) => typeof row.indicators[meta.code] === 'number');
  // Compact IPC payloads do not carry `values`; the main process sends only the
  // keys of protected fields that are actually present, which is all this panel
  // needs (and keeps the sensitive values out of the renderer entirely).
  const restricted = (fields ?? []).filter((field) => {
    if (!field.sensitivity || field.sensitivity === 'public') return false;
    if (Array.isArray(row.restrictedPresent)) return row.restrictedPresent.includes(field.key);
    const value = row.values?.[field.key];
    return value !== null && value !== undefined && value !== '';
  });
  const sensitivityLabel = { restricted: 'مقيّد', sensitive: 'حساس' };

  // Provenance is loaded on demand: the list payload stays small, and a row that
  // is never opened never triggers a read of its restricted source records.
  const [detail, setDetail] = useState(null);
  const [detailError, setDetailError] = useState('');
  useEffect(() => {
    let alive = true;
    setDetail(null);
    setDetailError('');
    if (!row.dbId) return undefined;
    window.localApp.getDirectorate(row.dbId)
      .then((value) => { if (alive) setDetail(value); })
      .catch((cause) => { if (alive) setDetailError(cause?.message || 'تعذر تحميل مصدر القيم.'); });
    return () => { alive = false; };
  }, [row.dbId]);

  const maskedKeys = new Set(detail?.masked ?? []);
  const sourceByKey = new Map((detail?.sources ?? []).map((source) => [source.field_key, source]));
  const fieldByKey = new Map((fields ?? []).map((field) => [field.key, field]));
  const DECISION_INPUTS = ['population', 'waterCoverage', 'pavedRoads', 'revenue', 'povertyRatio', 'projectCost', 'schools', 'agriProduction'];
  const provenanceRows = DECISION_INPUTS
    .map((key) => ({ key, field: fieldByKey.get(key), source: sourceByKey.get(key) }))
    .filter((entry) => entry.field && entry.source);
  const decision = detail?.values?.reviewerDecision ?? null;

  // Donor-facing opportunity: the single most severe measured need, what it
  // implies in programme terms, and the evidence behind it. It is derived, never
  // stored, so it can never contradict the indicators it is built from.
  const SECTOR_BY_INDICATOR = {
    waterDeficit: 'مياه وإصحاح بيئي',
    frontLineRisk: 'طوارئ وتعافٍ',
    revenuePerCapita: 'تنمية اقتصادية محلية',
    roadsDeficit: 'طرق وبنية تحتية',
    populationPerFacility: 'خدمات أساسية',
    schoolsPer10k: 'تعليم',
    agriPerCapita: 'زراعة وأمن غذائي',
    valueChainsScore: 'سلاسل قيمة وتمكين اقتصادي',
    fiscalGap: 'مالية محلية',
    associationsPer10k: 'مجتمع مدني',
    stalledProject: 'استكمال مشاريع متعثرة',
    aidPerCapita: 'مساعدات إنسانية',
  };
  const worst = indicators
    .map((meta) => ({ meta, value: Number(row.indicators[meta.code]) }))
    .filter((entry) => Number.isFinite(entry.value))
    .sort((left, right) => (right.meta.direction === 'needUp' ? right.value - left.value : left.value - right.value))[0] ?? null;
  const beneficiaries = Number(detail?.values?.expectedBeneficiaries ?? detail?.values?.population ?? 0);
  const opportunity = worst && {
    sector: SECTOR_BY_INDICATOR[worst.meta.code] ?? 'تنمية متعددة القطاعات',
    need: `${worst.meta.header} = ${fmt(worst.value, 3)}${worst.meta.unit && worst.meta.unit !== '%' ? ` ${worst.meta.unit}` : ''}`,
    beneficiaries: Number.isFinite(beneficiaries) && beneficiaries > 0 ? beneficiaries : null,
    alignment: [detail?.values?.nationalAlignment, detail?.values?.partnerIntegration].filter(Boolean).join(' · '),
    cost: maskedKeys.has('projectCost') ? null : detail?.values?.projectCost ?? null,
    evidence: provenanceRows.length,
  };

  return <div className="district-detail">
    <div className="decision-card">
      <div className="decision-head">
        <ShieldCheck size={16} />
        <strong>بطاقة القرار</strong>
        <span className="decision-badge">{decision ? `القرار: ${decision}` : 'لم يُعتمد قرار بعد'}</span>
      </div>
      <div className="decision-grid">
        <div><span>المشروع المقترح</span><b>{row.project?.label ?? '—'}</b></div>
        <div><span>مستوى الثقة</span><b>{row.confidence?.text ?? row.confidence?.level ?? '—'}</b></div>
        <div><span>المركب المعاير</span><b className="ltr">{fmt(row.calibrated?.composite)}</b></div>
        <div><span>الرتبة</span><b>{row.calibrated?.rank ?? (row.calibrated?.blocked ? 'محجوبة' : '—')}</b></div>
        <div><span>عدد المصادر المسجّلة</span><b>{detail ? provenanceRows.length : '...'}</b></div>
      </div>
      {detailError && <div className="inline-warning"><AlertTriangle size={14} />{detailError}</div>}
      {detail && provenanceRows.length > 0 && <div className="provenance-block">
        <h4>وحدة القياس ومصدر كل قيمة أساسية</h4>
        <div className="table-scroll"><table className="analysis-table compact">
          <thead><tr><th>الحقل</th><th>الوحدة</th><th>القيمة الخام</th><th>المصدر</th><th>الموضع</th><th>تاريخ الالتقاط</th></tr></thead>
          <tbody>{provenanceRows.map(({ key, field, source }) => <tr key={key}>
            <td>{field.header}</td>
            <td>{field.unit ?? '—'}</td>
            <td className="ltr-cell">{maskedKeys.has(key) ? 'محجوب' : (source.value_text ?? '—')}</td>
            <td className="ltr-cell">{source.source_file || '—'}</td>
            <td className="ltr-cell">{source.source_location || '—'}</td>
            <td>{source.captured_at ? new Date(source.captured_at).toLocaleDateString('ar') : '—'}</td>
          </tr>)}</tbody>
        </table></div>
        <p className="muted">الوحدة هي وحدة القالب المتوقعة، والقيمة الخام نص المصدر قبل التحويل — فما تراه هنا هو ما وصل فعلًا، لا ما فسّره المحرك.</p>
      </div>}
      {detail && !provenanceRows.length && <p className="muted">لا مصدر مسجّل لهذه المديرية؛ أُدخلت بقيمها مباشرة.</p>}
    </div>
    {opportunity && <div className="opportunity-card">
      <div className="opportunity-head">
        <div>
          <p className="eyebrow">فرصة تنموية قابلة للعرض</p>
          <h4>{opportunity.sector}</h4>
        </div>
        <span className="opportunity-need">الفجوة الأبرز: {opportunity.need}</span>
      </div>
      <div className="decision-grid">
        <div><span>المستفيدون المتوقعون</span><b>{opportunity.beneficiaries ? arNumber.format(opportunity.beneficiaries) : 'غير محدد'}</b></div>
        <div><span>التكلفة التقديرية</span><b className="ltr">{opportunity.cost ? `${arNumber.format(Number(opportunity.cost))} ريال` : (maskedKeys.has('projectCost') ? 'محجوبة في وضع المشاركة' : 'غير مسجّلة')}</b></div>
        <div><span>المواءمة الوطنية والشركاء</span><b>{opportunity.alignment || 'لم تُسجّل'}</b></div>
        <div><span>عدد الأدلة المصدرية</span><b>{opportunity.evidence}</b></div>
      </div>
      <p className="muted">البطاقة مشتقة من المؤشرات المحسوبة ومصادرها؛ لا تُعدّل قيمة ولا تُخفي فجوة، وتُقرأ مع مستوى الثقة أعلاه.</p>
    </div>}
    <div className="detail-columns">
      <div>
        <h4>المؤشرات المحسوبة</h4>
        <div className="indicator-grid">
          {indicators.map((meta) => <div key={meta.code} className="indicator-item">
            <span>{meta.header}</span>
            <strong className="ltr">{fmt(row.indicators[meta.code], 3)}<em className="indicator-unit">{meta.unit ?? ''}</em></strong>
          </div>)}
          {!indicators.length && <p className="muted">لا توجد مؤشرات قابلة للحساب.</p>}
        </div>
      </div>
      <div>
        <h4>حالة السجل</h4>
        <ul className="detail-list">
          <li><span>الاكتمال</span><b>{pct(row.completeness.ratio)}</b></li>
          <li><span>الحقول الناقصة</span><b>{row.completeness.missingText}</b></li>
          <li><span>تغطية الأوزان</span><b>{pct(row.calibrated?.weightCoverage)}</b></li>
          <li><span>الأبعاد المتدهورة</span><b>{row.calibrated?.degradedCount ?? '—'} / 12</b></li>
          <li><span>حدود مراجعة</span><b>{row.boundary?.length ? row.boundary.map((entry) => entry.header).join('، ') : 'لا توجد'}</b></li>
        </ul>
        {restricted.length > 0 && <div className="sensitivity-block">
          <h4>حقول مصنّفة حساسة في هذا السجل</h4>
          <div className="sensitivity-chips">
            {restricted.map((field) => <span key={field.key} className={`sensitivity-chip ${field.sensitivity}`}>
              {field.header}
              <em>{sensitivityLabel[field.sensitivity] ?? field.sensitivity}</em>
            </span>)}
          </div>
          <p className="muted">قراءة هذه القيم مسجّلة في سجل التدقيق عند التشغيل والتصدير.</p>
        </div>}
      </div>
    </div>
    {row.warnings?.length > 0 && <div className="inline-warning"><AlertTriangle size={15} />{row.warnings.map((warning) => `${warning.key}: ${warning.raw}`).join(' · ')}</div>}
  </div>;
}

function GapsTab({ analysis }) {
  const [severity, setSeverity] = useState('all');
  const [term, setTerm] = useState('');
  const { perRow, crossIssues, summary, severityLabels } = analysis.gaps;
  const rowsByName = useMemo(() => new Map((analysis.rows ?? []).map((row) => [row.index, row])), [analysis.rows]);

  const items = useMemo(() => {
    const list = [];
    for (const entry of perRow) {
      const row = rowsByName.get(entry.index);
      for (const issue of entry.issues) list.push({ ...issue, districtName: row?.districtName ?? '—' });
    }
    for (const issue of crossIssues) list.push({ ...issue, districtName: '—' });
    const needle = term.trim();
    return list.filter((item) => (severity === 'all' || item.severity === severity)
      && (!needle || `${item.districtName} ${item.message} ${item.code}`.includes(needle)));
  }, [perRow, crossIssues, rowsByName, severity, term]);

  return <div className="analysis-tab-body">
    <div className="gap-summary">
      <button className={severity === 'all' ? 'active' : ''} onClick={() => setSeverity('all')}>الكل <b>{summary.total ?? 0}</b></button>
      <button className={severity === 'blocker' ? 'active danger' : ''} onClick={() => setSeverity('blocker')}>{severityLabels.blocker} <b>{summary.blocker ?? 0}</b></button>
      <button className={severity === 'warning' ? 'active' : ''} onClick={() => setSeverity('warning')}>{severityLabels.warning} <b>{summary.warning ?? 0}</b></button>
      <button className={severity === 'info' ? 'active' : ''} onClick={() => setSeverity('info')}>{severityLabels.info} <b>{summary.info ?? 0}</b></button>
      <label className="search-box"><input value={term} onChange={(event) => setTerm(event.target.value)} placeholder="بحث في الفجوات" /></label>
    </div>
    <section className="panel table-panel">
      <div className="table-scroll"><table className="analysis-table">
        <thead><tr><th>الخطورة</th><th>المديرية</th><th>الحقل</th><th>الوصف</th></tr></thead>
        <tbody>{items.map((issue, index) => <tr key={`${issue.code}-${issue.districtName}-${index}`}>
          <td><span className={`severity-pill ${issue.severity}`}>{severityLabels[issue.severity] || issue.severity}</span></td>
          <td className="district-cell">{issue.districtName}</td>
          <td>{issue.field}</td>
          <td>{issue.message}</td>
        </tr>)}</tbody>
      </table></div>
      {!items.length && <div className="table-empty">لا توجد فجوات مطابقة للتصفية.</div>}
    </section>
    {summary.byCode && Object.keys(summary.byCode).length > 0 && <div className="gap-codes">
      {Object.entries(summary.byCode).map(([code, count]) => <span key={code}>{code} <b>{count}</b></span>)}
    </div>}
  </div>;
}

function SensitivityTab({ analysis }) {
  const rows = analysis.rows.filter((row) => row.sensitivity);
  const sample = analysis.sensitivity.sample;
  const fragility = analysis.sensitivity.weight.fragility;
  return <div className="analysis-tab-body">
    <div className="analysis-metrics compact">
      <article className="analysis-metric"><span>سيناريوهات الأوزان</span><strong>{fragility?.scenarioCount ?? 0}</strong><small>±20% لكل بُعد وللثلاثة الأثقل</small></article>
      <article className="analysis-metric"><span>قرارات هشّة</span><strong>{fragility?.fragileCount ?? 0}</strong><small>تتحرك رتبتها 3 مراكز أو أكثر</small></article>
      <article className="analysis-metric"><span>حساسية العيّنة</span><strong>{sample?.truncated ? '—' : (sample?.maxShift ?? 0)}</strong><small>{sample?.truncated ? `لم تُحسب: ${arNumber.format(sample.droppedCount ?? 0)} مديرية تتجاوز الحد المسموح` : 'أقصى إزاحة عند حذف مديرية واحدة'}</small></article>
    </div>
    <section className="panel table-panel">
      <div className="panel-heading"><div><h2>ثبات الرتبة أمام تغيّر الأوزان</h2><p>الرتبة التي تصمد أمام كل السيناريوهات قابلة للدفاع عنها في قرار تمويلي.</p></div></div>
      <div className="table-scroll"><table className="analysis-table">
        <thead><tr><th>المديرية</th><th>أدنى رتبة</th><th>أعلى رتبة</th><th>مدى التذبذب</th><th>رتب متميزة</th><th>هشّة</th><th>إزاحة العيّنة</th></tr></thead>
        <tbody>{rows.map((row) => <tr key={row.key} className={row.sensitivity.fragile ? 'row-warn' : ''}>
          <td className="district-cell">{row.districtName}</td>
          <td className="num-cell">{row.sensitivity.minRank ?? '—'}</td>
          <td className="num-cell">{row.sensitivity.maxRank ?? '—'}</td>
          <td className="num-cell">{row.sensitivity.rankRange ?? '—'}</td>
          <td className="num-cell">{row.sensitivity.distinctRanks ?? '—'}</td>
          <td>{row.sensitivity.fragile ? <span className="severity-pill blocker">هشّة</span> : <span className="severity-pill info">مستقرة</span>}</td>
          <td className="num-cell">{row.sensitivity.sampleMaxShift ?? 0}</td>
        </tr>)}</tbody>
      </table></div>
      {!rows.length && <div className="table-empty">لم تُحسب الحساسية لهذه الدفعة.</div>}
    </section>
    {sample?.detail?.length > 0 && <section className="panel">
      <div className="panel-heading"><div><h2>حساسية المسار الحرفي (Min–Max)</h2><p>حذف مديرية واحدة يعيد توزيع المقياس؛ هذه إزاحة كل رتبة.</p></div></div>
      <div className="sample-bars">{sample.detail.map((entry) => <div key={`${entry.index ?? entry.districtName}`} className="sample-bar">
        <span>{entry.districtName}</span>
        <div className="bar-track"><i style={{ width: `${Math.min(100, entry.maxShift * 20)}%` }} /></div>
        <b>{entry.maxShift}</b>
      </div>)}</div>
    </section>}
  </div>;
}

function WeightsTab({ analysis, notify, fail, onChanged }) {
  const [state, setState] = useState({ loading: true, weights: {}, defaults: {}, history: [] });
  const [note, setNote] = useState('');

  useEffect(() => {
    window.localApp.getWeights()
      .then((result) => setState({
        loading: false,
        weights: result.active?.weights ?? result.defaults,
        defaults: result.defaults,
        history: result.history ?? [],
      }))
      .catch(() => setState((previous) => ({ ...previous, loading: false })));
  }, []);

  // Validate exactly what the backend validates: the 12 indicator codes only, each
  // within [0,1], and a total within 1e-6 of unity (same tolerance as validateWeights).
  const total = useMemo(
    () => INDICATORS_META.reduce((sum, meta) => sum + (Number(state.weights[meta.code]) || 0), 0),
    [state.weights],
  );
  const inRange = INDICATORS_META.every((meta) => {
    const value = Number(state.weights[meta.code]);
    return Number.isFinite(value) && value >= 0 && value <= 1;
  });
  const valid = inRange && Math.abs(total - 1) <= 1e-6;

  function update(code, raw) {
    const numeric = Number(raw);
    setState((previous) => ({ ...previous, weights: { ...previous.weights, [code]: Number.isFinite(numeric) ? numeric : 0 } }));
  }

  async function save() {
    try {
      await window.localApp.setWeights({ weights: state.weights, note: note || null });
      notify('حُفظت الأوزان. سيعاد التحليل عند الطلب.');
      setNote('');
      const result = await window.localApp.getWeights();
      setState({ loading: false, weights: result.active?.weights ?? result.defaults, defaults: result.defaults, history: result.history ?? [] });
      onChanged?.();
    } catch (cause) {
      fail(cause, 'تعذر حفظ الأوزان.');
    }
  }

  return <div className="analysis-tab-body">
    <section className="panel">
      <div className="panel-heading">
        <div><h2>أوزان المؤشرات</h2><p>المجموع الحالي <b className={valid ? 'ok' : 'bad'}>{total.toFixed(6)}</b> — يجب أن يساوي 1.000000 (تسامح ‎1e-6‎). الأوزان تُحفظ بنسخة جديدة ولا تُستبدل القديمة.</p></div>
        <button className="secondary-button" onClick={() => setState((previous) => ({ ...previous, weights: { ...previous.defaults } }))}>استعادة الافتراضي</button>
      </div>
      <div className="weights-grid">
        {INDICATORS_META.map((meta) => <label key={meta.code} className="weight-field">
          <span>{meta.header}<em>{meta.excel}</em></span>
          <input type="number" min="0" max="1" step="0.01" value={state.weights[meta.code] ?? 0} onChange={(event) => update(meta.code, event.target.value)} />
        </label>)}
      </div>
      <div className="weights-footer">
        <input className="note-input" value={note} onChange={(event) => setNote(event.target.value)} placeholder="سبب التعديل (يُسجّل في سجل التدقيق)" />
        <button className="primary-button" onClick={save} disabled={!valid}><Save size={16} />حفظ نسخة جديدة</button>
      </div>
    </section>

    <section className="panel">
      <div className="panel-heading"><div><h2>معايرة التشغيل الحالي</h2><p>القيم التي استُخدمت في آخر تحليل.</p></div></div>
      <div className="calibration-grid">
        <div><span>عتبة الانحدار k</span><strong>{analysis.meta.kThreshold} / 12</strong></div>
        <div><span>خط الحرمان</span><strong>{analysis.meta.deprivationLine}</strong></div>
        <div><span>أدنى تغطية أوزان</span><strong>{pct(analysis.meta.minWeightCoverage)}</strong></div>
        <div><span>زمن التوليد</span><strong>{new Date(analysis.meta.generatedAt).toLocaleString('ar')}</strong></div>
      </div>
    </section>

    <section className="panel table-panel">
      <div className="panel-heading"><div><h2>سجل نسخ الأوزان</h2><p>كل تعديل يبقى قابلاً للتتبع.</p></div></div>
      <div className="table-scroll"><table className="analysis-table">
        <thead><tr><th>#</th><th>الاسم</th><th>ملاحظة</th><th>فعّالة</th><th>التاريخ</th></tr></thead>
        <tbody>{state.history.map((entry) => <tr key={entry.id}>
          <td className="rank-cell">{entry.id}</td>
          <td>{entry.name}</td>
          <td>{entry.note || '—'}</td>
          <td>{entry.active ? <Check size={15} className="ok-icon" /> : '—'}</td>
          <td>{new Date(entry.createdAt).toLocaleString('ar')}</td>
        </tr>)}</tbody>
      </table></div>
      {!state.loading && !state.history.length && <div className="table-empty">لا توجد نسخ محفوظة؛ الأوزان الافتراضية مطبقة.</div>}
    </section>
  </div>;
}

function AuditTab() {
  const [state, setState] = useState({ writes: [], reads: [] });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    window.localApp.auditLog({ limit: 300 })
      .then((value) => setState(Array.isArray(value) ? { writes: value, reads: [] } : { writes: value?.writes ?? [], reads: value?.reads ?? [] }))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  return <div className="analysis-tab-body">
    <div className="audit-note"><Info size={16} /><span>سجل الوصول يسجّل القراءات الكتابة والتصدير: من قرأ أي كيان، وأي الحقول حُجبت، وتشغيل التحليل، وتعديل الأوزان. لا يُسجَّل محتوى القيم الحساسة نفسه.</span></div>
    <section className="panel table-panel">
      <div className="panel-heading"><div><h2>سجل القراءات</h2><p>كل قناة قرأت بيانات، ونوع الملف، وهل حُجبت حقول.</p></div></div>
      <div className="table-scroll"><table className="analysis-table">
        <thead><tr><th>#</th><th>القناة</th><th>الكيان</th><th>المعرّف</th><th>الحقول</th><th>النتيجة</th><th>الصفوف</th><th>الجلسة</th><th>الوقت</th></tr></thead>
        <tbody>{state.reads.map((entry) => <tr key={entry.id}>
          <td className="rank-cell">{entry.id}</td>
          <td><span className="severity-pill info">{entry.channel}</span></td>
          <td>{entry.entity || '—'}</td>
          <td className="ltr-cell">{String(entry.entity_id ?? '—').slice(0, 32)}</td>
          <td className="ltr-cell">{entry.fields || '—'}</td>
          <td>{entry.result === 'masked' ? <span className="severity-pill blocker">محجوب جزئيًا</span> : entry.result}</td>
          <td className="num-cell">{entry.row_count ?? '—'}</td>
          <td className="ltr-cell">{String(entry.session_id ?? '—').slice(0, 8)}</td>
          <td>{new Date(entry.created_at).toLocaleString('ar')}</td>
        </tr>)}</tbody>
      </table></div>
      {loading && <div className="table-empty">جارٍ التحميل...</div>}
      {!loading && !state.reads.length && <div className="table-empty">لا توجد قراءات مسجّلة بعد.</div>}
    </section>
    <section className="panel table-panel">
      <div className="panel-heading"><div><h2>سجل الكتابة والتصدير</h2><p>الاستيراد، والتعديل اليدوي، والترحيل، والتصدير.</p></div></div>
      <div className="table-scroll"><table className="analysis-table">
        <thead><tr><th>#</th><th>الإجراء</th><th>الكيان</th><th>المعرّف</th><th>التفاصيل</th><th>الوقت</th></tr></thead>
        <tbody>{state.writes.map((entry) => <tr key={entry.id}>
          <td className="rank-cell">{entry.id}</td>
          <td><span className="severity-pill info">{entry.action}</span></td>
          <td>{entry.entity || '—'}</td>
          <td className="ltr-cell">{String(entry.entity_id ?? '—').slice(0, 43)}</td>
          <td>{entry.detail || '—'}</td>
          <td>{new Date(entry.created_at).toLocaleString('ar')}</td>
        </tr>)}</tbody>
      </table></div>
      {!loading && !state.writes.length && <div className="table-empty">سجل الكتابة فارغ.</div>}
    </section>
  </div>;
}