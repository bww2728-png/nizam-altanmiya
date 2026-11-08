import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle, ArrowLeft, CheckCircle2, ChevronLeft, FileSpreadsheet, FileWarning,
  History, Layers, RefreshCw, ShieldCheck, Sparkles, XCircle,
} from 'lucide-react';
import {
  Badge, Bar, Card, Empty, ErrorBanner, Segmented, Switch,
} from '../components/ui.jsx';
import { baseName, cx, errText, fmtNumber } from '../lib/format.js';

/**
 * «الاستيراد الآلي» — the only door into the database.
 *
 * The screen never writes on its own: it asks the main process for a plan, shows
 * every row with its verdict and issues, lets the operator decide per row, and
 * only then applies. Re-scanning the same file shows the field-by-field
 * difference against the stored record so an overwrite is an explicit choice.
 */

const STATUS_META = {
  ready: { label: 'جاهز', tone: 'ok' },
  review: { label: 'يحتاج مراجعة', tone: 'warn' },
  blocked: { label: 'محجوب', tone: 'bad' },
};

const ACTION_META = {
  create: { label: 'إضافة جديدة', tone: 'info' },
  update: { label: 'تحديث', tone: 'gold' },
  unchanged: { label: 'بلا تغيير', tone: '' },
  blocked: { label: 'محجوب', tone: 'bad' },
  duplicate: { label: 'مكرر', tone: 'warn' },
};

/**
 * Every row starts unapproved. Only a direct row decision or the explicit
 * "approve eligible rows on this page" action may send an apply decision.
 */
const defaultDecision = () => 'skip';

const PREVIEW_LIMIT = 250;

export default function ImportPage({ onNavigate, notify, onApplied }) {
  const [step, setStep] = useState('idle');
  const [plan, setPlan] = useState(null);
  const [fullPlan, setFullPlan] = useState(null);
  const [decisions, setDecisions] = useState({});
  const [force, setForce] = useState(false);
  const [progress, setProgress] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [hideUnchanged, setHideUnchanged] = useState(false);
  const [statusFilter, setStatusFilter] = useState('all');
  const [page, setPage] = useState(0);

  const rows = useMemo(() => (fullPlan?.preview ?? plan?.preview ?? []), [fullPlan, plan]);

  useEffect(() => {
    // The main process pushes `import:progress` while it scans; the banner below
    // is therefore driven by real events, never by a client-side timer.
    const unsubscribe = window.localApp.onImportProgress?.((message) => setProgress(message));
    return () => { if (typeof unsubscribe === 'function') unsubscribe(); };
  }, []);

  const chooseFile = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const scanned = await window.localApp.scanWorkbook({});
      if (scanned?.canceled) {
        setProgress(null);
        setStep('idle');
        return;
      }
      setPlan(scanned);
      setFullPlan(null);
      setResult(null);
      setDecisions({});
      setPage(0);
      setStep('plan');
      notify?.({
        tone: scanned.scope?.blocked ? 'warn' : 'ok',
        message: `قُرئ الملف: ${scanned.totalRows} صفًا، ${scanned.matchedCount} عمودًا مفهومًا.`,
      });
    } catch (cause) {
      setError(errText(cause) || 'تعذر قراءة الملف.');
      setStep('idle');
    } finally {
      setProgress(null);
      setBusy(false);
    }
  }, [notify]);

  const loadAllRows = useCallback(async () => {
    setBusy(true);
    try {
      const full = await window.localApp.importPlan();
      setFullPlan({ ...full, fileName: plan?.fileName, generatedAt: full?.createdAt });
      setPage(0);
      notify?.({ tone: 'ok', message: `حُمّلت كل الصفوف (${full.totalRows}).` });
    } catch (cause) {
      setError(errText(cause) || 'تعذر تحميل بقية الصفوف.');
    } finally {
      setBusy(false);
    }
  }, [plan, notify]);

  const apply = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      // The main process defaults every unlisted row to skip. Send only
      // decisions that the operator explicitly made in this review session.
      const applied = await window.localApp.applyImport({ decisions, force });
      setResult(applied);
      setStep('applied');
      onApplied?.();
      notify?.({
        tone: applied.refused.length ? 'warn' : 'ok',
        message: `اكتمل الاستيراد: ${applied.created} إضافة، ${applied.updated} تحديث، ${applied.refused.length} محجوب.`,
      });
    } catch (cause) {
      setError(errText(cause) || 'تعذر تطبيق خطة الاستيراد.');
    } finally {
      setBusy(false);
    }
  }, [decisions, force, notify, onApplied]);

  const visibleRows = useMemo(() => rows.filter((row) => {
    if (hideUnchanged && row.action === 'unchanged') return false;
    if (statusFilter !== 'all' && row.status !== statusFilter) return false;
    return true;
  }), [rows, hideUnchanged, statusFilter]);

  const pageCount = Math.max(1, Math.ceil(visibleRows.length / PREVIEW_LIMIT));
  const safePage = Math.min(page, pageCount - 1);
  const previewRows = visibleRows.slice(safePage * PREVIEW_LIMIT, (safePage + 1) * PREVIEW_LIMIT);
  const scope = plan?.scope ?? {};

  const approveEligiblePage = useCallback(() => {
    setDecisions((current) => {
      const next = { ...current };
      for (const row of previewRows) {
        if (row.status === 'ready' && row.action !== 'unchanged' && row.action !== 'duplicate') {
          next[row.rowNumber] = 'apply';
        }
      }
      return next;
    });
  }, [previewRows]);
  const decisionCount = useMemo(() => {
    let skip = 0;
    for (const row of previewRows) {
      if ((decisions[row.rowNumber] ?? defaultDecision(row)) === 'skip') skip += 1;
    }
    return { skip, apply: previewRows.length - skip };
  }, [previewRows, decisions]);

  return (
    <>
      <Card flush>
        <div style={{ padding: '16px 20px' }}>
          <Stepper step={step} />
        </div>
      </Card>

      {error && <ErrorBanner message={error} onDismiss={() => setError('')} />}

      {progress?.message && (
        <div className="quote row gap-sm">
          <span className="spinner" />
          <span>{progress.message}</span>
        </div>
      )}

      {step === 'idle' && <Starter busy={busy} onChoose={chooseFile} />}

      {step === 'plan' && plan && (
        <>
          <Card
            title="خطة الاستيراد"
            subtitle={`${plan.fileName} · الورقة «${plan.sheetName}» · صف الرؤوس ${plan.headerRow}`}
            actions={(
              <div className="btn-row">
                <button className="btn small ghost" onClick={chooseFile} disabled={busy}>
                  <RefreshCw size={15} /> اختيار ملف آخر
                </button>
                {!fullPlan && (plan.totalRows > rows.length || rows.length > PREVIEW_LIMIT) && (
                  <button className="btn small" onClick={loadAllRows} disabled={busy}>
                    <Layers size={15} /> تحميل كل الصفوف ({plan.totalRows})
                  </button>
                )}
              </div>
            )}
          >
            <div className="stat-strip">
              <MiniStat label="صفوف في الملف" value={fmtNumber(plan.totalRows, 0)} />
              <MiniStat label="أعمدة مفهومة" value={fmtNumber(plan.matchedCount, 0)} />
              <MiniStat label="إضافات" value={fmtNumber(scope.create, 0)} />
              <MiniStat label="تحديثات" value={fmtNumber(scope.update, 0)} />
              <MiniStat label="بلا تغيير" value={fmtNumber(scope.unchanged, 0)} />
              <MiniStat label="مكرر" value={fmtNumber(scope.duplicate, 0)} />
            </div>

            <div className="chip-row" style={{ marginTop: 16 }}>
              <Badge tone="ok">جاهز: {scope.ready}</Badge>
              <Badge tone="warn">يحتاج مراجعة: {scope.review}</Badge>
              <Badge tone="bad">محجوب: {scope.blocked}</Badge>
              <Badge tone="violet">شاذ: {scope.anomaly}</Badge>
              <Badge tone="info">ناقص: {scope.incomplete}</Badge>
              {scope.stale > 0 && <Badge tone="warn">سجلات اختفت من الملف: {scope.stale}</Badge>}
            </div>

            {plan.missingInputs?.length > 0 && (
              <Notice tone="bad" title="أعمدة إلزامية غير موجودة في الملف">
                {plan.missingInputs.map((item) => (
                  <span className="chip bad" key={item.key ?? item.column}>{item.header ?? item.key ?? item.column}</span>
                ))}
              </Notice>
            )}

            {plan.unmatched?.length > 0 && (
              <Notice tone="info" title="أعمدة في الملف لم تُطابق أي حقل معروف (تُتجاهل)">
                {plan.unmatched.map((item) => <span className="chip" key={`${item.column}-${item.label}`}>{item.label}</span>)}
              </Notice>
            )}

            {plan.warnings?.length > 0 && (
              <Notice tone="warn" title="ملاحظات قراءة الملف">
                {plan.warnings.map((warning, index) => (
                  <span className="chip warn" key={index}>{warning.message ?? warning.code}</span>
                ))}
              </Notice>
            )}

            {plan.stale?.length > 0 && (
              <Notice tone="warn" title="مديريات محفوظة من نفس الملف ولم تظهر في القراءة الجديدة (لا تُحذف تلقائيًا)">
                {plan.stale.map((item) => <span className="chip warn" key={item.id}>{item.district} · {item.governorate}</span>)}
              </Notice>
            )}

            {plan.changedFields?.length > 0 && (
              <Notice tone="gold" title="حقول ستتغير في السجلات القائمة">
                {plan.changedFields.map((key) => <span className="chip gold" key={key}>{key}</span>)}
              </Notice>
            )}
          </Card>

          <Card
            title="مراجعة الصفوف"
            subtitle="كل الصفوف تبدأ غير معتمدة. اعتمد الصفوف المؤهلة في الصفحة الحالية أو اختر القرار لكل صف؛ لا يُكتب أي صف غير معتمد صراحةً. الصف المحجوب يحتاج قرار تطبيق مستقلًا مع تفعيل القوة."
            actions={(
              <div className="row">
                <Segmented
                  value={statusFilter}
                  onChange={(value) => { setStatusFilter(value); setPage(0); }}
                  options={[
                    { value: 'all', label: 'الكل' },
                    { value: 'ready', label: 'جاهز' },
                    { value: 'review', label: 'مراجعة' },
                    { value: 'blocked', label: 'محجوب' },
                  ]}
                />
                <Switch checked={hideUnchanged} onChange={(value) => { setHideUnchanged(value); setPage(0); }} label="إخفاء بلا تغيير" />
              </div>
            )}
          >
            <div className="row between" style={{ marginBottom: 12 }}>
              <span className="muted" style={{ fontSize: '0.8rem' }}>
                الصفحة {safePage + 1} من {pageCount} · يُعرض {previewRows.length} من {visibleRows.length} صفًا
                {!fullPlan && (plan.totalRows > rows.length || rows.length > PREVIEW_LIMIT) ? ' · حمّل كل الصفوف أولًا للمراجعة الكاملة' : ''}
              </span>
              <div className="btn-row">
                <span className="chip">تخطٍّ: {decisionCount.skip}</span>
                <span className="chip ok">معتمد صراحةً: {decisionCount.apply}</span>
                <button className="btn small" onClick={approveEligiblePage} disabled={!previewRows.some((row) => row.status === 'ready' && row.action !== 'unchanged' && row.action !== 'duplicate')}>
                  <CheckCircle2 size={14} /> اعتماد الجاهز في هذه الصفحة
                </button>
                <button className="btn small ghost" onClick={() => setDecisions({})}>إلغاء كل الاعتمادات</button>
              </div>
            </div>

            {previewRows.length === 0 ? (
              <Empty icon={CheckCircle2} title="لا صفوف مطابقة للمرشّح الحالي" />
            ) : (
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>صف</th>
                      <th>المديرية</th>
                      <th>المحافظة</th>
                      <th>العملية</th>
                      <th>الحالة</th>
                      <th style={{ width: 150 }}>الاكتمال</th>
                      <th>الملاحظات والفرق</th>
                      <th>القرار</th>
                    </tr>
                  </thead>
                  <tbody>
                    {previewRows.map((row, index) => {
                      const decision = decisions[row.rowNumber] ?? defaultDecision(row);
                      const status = STATUS_META[row.status] ?? STATUS_META.review;
                      const action = ACTION_META[row.action] ?? ACTION_META.unchanged;
                      return (
                        <tr key={row.rowNumber ?? index} style={{ animation: `rise .3s var(--ease-out) ${Math.min(index, 30) * 16}ms both` }}>
                          <td className="num dim">{row.rowNumber}</td>
                          <td className="strong">{row.districtName || '—'}</td>
                          <td>{row.governorate || '—'}</td>
                          <td><Badge tone={action.tone}>{action.label}</Badge></td>
                          <td><Badge tone={status.tone}>{status.label}</Badge></td>
                          <td>
                            <div className="completeness">
                              <Bar value={row.completeness?.present} max={row.completeness?.total || 1} tone={row.completeness?.present === row.completeness?.total ? 'ok' : 'warn'} />
                              <small>{row.completeness?.present}/{row.completeness?.total}</small>
                            </div>
                          </td>
                          <td>
                            <div className="chip-row">
                              {row.issues?.slice(0, 4).map((issue, issueIndex) => (
                                <span className={cx('issue', issue.severity)} key={`${issue.code}-${issueIndex}`} title={issue.reason}>
                                  {issue.header ? `${issue.header}: ` : ''}{issue.reason ?? issue.code}
                                </span>
                              ))}
                              {row.issues?.length > 4 && <span className="chip">+{row.issues.length - 4}</span>}
                            </div>
                            {row.changes?.length > 0 && (
                              <div className="chip-row" style={{ marginTop: 6 }}>
                                {row.changes.slice(0, 4).map((change) => (
                                  <span className="diff" key={change.key}>
                                    <span className="muted">{change.header}</span>
                                    <span className="before">{String(change.before ?? '—')}</span>
                                    <ChevronLeft size={12} />
                                    <span className="after">{String(change.after ?? '—')}</span>
                                  </span>
                                ))}
                                {row.changes.length > 4 && <span className="chip">+{row.changes.length - 4} حقلًا</span>}
                              </div>
                            )}
                          </td>
                          <td>
                            <Segmented
                              value={decision}
                              onChange={(value) => setDecisions((current) => ({ ...current, [row.rowNumber]: value }))}
                              options={[
                                { value: 'apply', label: 'تطبيق' },
                                { value: 'skip', label: 'تخطٍّ' },
                              ]}
                            />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {pageCount > 1 && (
              <div className="row between" style={{ marginTop: 14 }}>
                <button className="btn small ghost" onClick={() => setPage((value) => Math.max(0, value - 1))} disabled={safePage === 0}>
                  <ChevronLeft size={14} /> الصفحة السابقة
                </button>
                <span className="muted">الصفحة {safePage + 1} / {pageCount}</span>
                <button className="btn small ghost" onClick={() => setPage((value) => Math.min(pageCount - 1, value + 1))} disabled={safePage >= pageCount - 1}>
                  الصفحة التالية <ChevronLeft size={14} style={{ transform: 'rotate(180deg)' }} />
                </button>
              </div>
            )}
          </Card>

          <Card className="gold">
            <div className="row between">
              <div className="stack tight">
                <div className="row">
                  <Switch checked={force} onChange={setForce} label="السماح بكتابة الصفوف المحجوبة التي اخترت لها «تطبيق» صراحةً" />
                </div>
                <span className="muted" style={{ fontSize: '0.8rem' }}>
                  التطبيق يكتب الصفوف المعتمدة صراحةً فقط وفي معاملة واحدة؛ الصفوف غير المعتمدة تُتخطى، وأي فشل يترك قاعدة البيانات كما كانت.
                </span>
              </div>
              <div className="btn-row">
                <button className="btn ghost" onClick={() => { setStep('idle'); setPlan(null); }} disabled={busy}>إلغاء</button>
                <button className="btn primary sheen" onClick={apply} disabled={busy}>
                  <Sparkles size={16} /> تطبيق خطة الاستيراد
                </button>
              </div>
            </div>
          </Card>
        </>
      )}

      {step === 'applied' && result && (
        <Card title="اكتمل الاستيراد" subtitle={result.fileName}>
          <div className="stat-strip">
            <MiniStat label="أُضيفت" value={fmtNumber(result.created, 0)} />
            <MiniStat label="حُدّثت" value={fmtNumber(result.updated, 0)} />
            <MiniStat label="محجوبة" value={fmtNumber(result.refused.length, 0)} />
            <MiniStat label="متخطّاة" value={fmtNumber(result.skipped.length, 0)} />
          </div>

          {result.refused.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <Notice tone="bad" title="صفوف رُفضت لوجود حاجب">
                {result.refused.map((item) => (
                  <span className="chip bad" key={item.rowNumber}>
                    صف {item.rowNumber} · {item.districtName} — {item.blockers.join('، ')}
                  </span>
                ))}
              </Notice>
              <p className="muted" style={{ fontSize: '0.8rem', marginTop: 8 }}>
                الحدّث الملف لإصلاح هذه الخلايا ثم أعد الاستيراد؛ أو فعّل «تطبيق الصفوف المحجوبة» إن كانت القيمة مقبولة.
              </p>
            </div>
          )}

          <div className="btn-row" style={{ marginTop: 18 }}>
            <button className="btn primary" onClick={() => onNavigate('correction')}>
              <ArrowLeft size={16} /> الانتقال إلى تصحيح البيانات
            </button>
            <button className="btn" onClick={() => onNavigate('dashboard')}>اللوحة التفاعلية</button>
            <button className="btn ghost" onClick={() => { setStep('idle'); setPlan(null); setResult(null); }}>استيراد ملف آخر</button>
          </div>
        </Card>
      )}
    </>
  );
}

function Starter({ busy, onChoose }) {
  return (
    <div className="grid-2">
      <Card title="الاستيراد الآلي من Excel" subtitle="المسار الوحيد لإدخال البيانات في النظام.">
        <div className="stack">
          <p className="muted" style={{ fontSize: '0.88rem' }}>
            اختر ملف «القالب المحدث». يقرأ النظام أعمدة قاعدة البيانات بترتيبها، يطابق الرؤوس بالمعنى
            (لا بالنص الحرفي)، يبني خطة، ويعرضها عليك قبل أن يكتب أي قيمة.
          </p>
          <ul className="stack tight">
            <li className="row gap-sm"><CheckCircle2 size={16} className="muted" /> الصيغ المقبولة: xlsx أو xlsm بحجم أقصى 200 ميجابايت.</li>
            <li className="row gap-sm"><CheckCircle2 size={16} className="muted" /> الورقة: «قاعدة البيانات الشاملة»، وصف الرؤوس يُكتشف تلقائيًا.</li>
            <li className="row gap-sm"><CheckCircle2 size={16} className="muted" /> تُقرأ أعمدة الإدخال A..AM فقط، وتُتجاهل الأعمدة المحسوبة في الملف.</li>
            <li className="row gap-sm"><CheckCircle2 size={16} className="muted" /> النسب تُقبل ككسر (0.197) أو نسبة (19.7) وتُطبّع مع تسجيل الأصل.</li>
            <li className="row gap-sm"><CheckCircle2 size={16} className="muted" /> الصف غير المفهوم يُحجر ويُستمر بالبقية، ويظهر سببه بالتفصيل.</li>
          </ul>
          <div className="btn-row">
            <button className="btn primary sheen" onClick={onChoose} disabled={busy}>
              <FileSpreadsheet size={17} /> {busy ? 'جارٍ القراءة...' : 'اختيار ملف القالب'}
            </button>
            <span className="chip"><ShieldCheck size={13} /> يتحقق من الصيغة والحجم قبل الفتح</span>
          </div>
        </div>
      </Card>

      <Card title="ماذا يحدث بعد الاستيراد؟" subtitle="الخطوات الثلاث كما تظهر في الشريط أعلاه.">
        <div className="timeline">
          <TimelineItem n={1} title="قراءة الملف وبناء الخطة" body="تطابق الرؤوس، تصنيف كل صف (جاهز/مراجعة/محجوب)، وحساب الفرق مقابل المخزّن." />
          <TimelineItem n={2} title="مراجعة صفًا صفًا" body="ترى الحقول التي ستتغير، وقيمها قبل وبعد، وسبب كل ملاحظة، ثم تقرر تطبيق أو تخطٍّ." />
          <TimelineItem n={3} title="التطبيق ثم التصحيح" body="يُكتب المقبول في معاملة واحدة، ثم تنتقل إلى شاشة التصحيح لإكمال ما نقص." />
        </div>
        <div className="quote" style={{ marginTop: 14 }}>
          إعادة استيراد نفس الملف لا تنشئ نسخًا مكررة: مفتاح المطابقة هو (اسم المديرية + المحافظة)، والصفوف المختفية
          من الملف تُعرض كتنبيه ولا تُحذف تلقائيًا.
        </div>
      </Card>
    </div>
  );
}

function Stepper({ step }) {
  const order = ['idle', 'plan', 'applied'];
  const index = order.indexOf(step);
  const items = [
    { label: 'اختيار الملف', icon: FileSpreadsheet },
    { label: 'مراجعة الخطة', icon: FileWarning },
    { label: 'التطبيق', icon: ShieldCheck },
  ];
  return (
    <div className="stepper">
      {items.map((item, itemIndex) => {
        const state = itemIndex < index ? 'done' : itemIndex === index ? 'active' : '';
        return (
          <React.Fragment key={item.label}>
            {itemIndex > 0 && <ChevronLeft size={16} className="step-arrow" />}
            <div className={cx('step', state)}>
              <span className="step-dot">{itemIndex < index ? <CheckCircle2 size={15} /> : itemIndex + 1}</span>
              <span>{item.label}</span>
            </div>
          </React.Fragment>
        );
      })}
    </div>
  );
}

function TimelineItem({ n, title, body }) {
  return (
    <div className="timeline-item">
      <span className="dot" />
      <div className="tl-body">
        <strong>{n}. {title}</strong>
        <p className="muted" style={{ fontSize: '0.82rem' }}>{body}</p>
      </div>
    </div>
  );
}

function MiniStat({ label, value }) {
  return (
    <div className="mini-stat">
      <strong className="tnum">{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function Notice({ tone = 'info', title, children }) {
  const Icon = tone === 'bad' ? XCircle : tone === 'warn' ? AlertTriangle : tone === 'gold' ? History : FileWarning;
  return (
    <div className={cx('quote')} style={{ marginTop: 14 }}>
      <div className="row gap-sm" style={{ marginBottom: 8 }}>
        <Icon size={16} />
        <strong style={{ fontSize: '0.84rem' }}>{title}</strong>
      </div>
      <div className="chip-row">{children}</div>
    </div>
  );
}

/** Exported for the correction screen's reuse of the same status vocabulary. */
export { STATUS_META, ACTION_META };