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
  const [importHistory, setImportHistory] = useState([]);

  const refreshHistory = useCallback(async () => {
    try {
      const rows = await window.localApp.importHistory?.({ limit: 20 });
      if (Array.isArray(rows)) setImportHistory(rows);
    } catch {
      // History is supplementary; a temporary read failure must not block scanning.
    }
  }, []);

  useEffect(() => { refreshHistory(); }, [refreshHistory]);

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
      await refreshHistory();
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
  }, [notify, refreshHistory]);

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
      setPlan(current => current?.staging ? { ...current, stagingStatus: applied.stagingStatus } : current);
      await refreshHistory();
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
  }, [decisions, force, notify, onApplied, refreshHistory]);

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

      {plan?.staging && <DurableStaging staging={plan.staging} status={plan.stagingStatus ?? plan.staging.status} stagingOnly={plan.stagingOnly} message={plan.stagingMessage} />}
      <ImportHistory rows={importHistory} />

      {step === 'idle' && <Starter busy={busy} onChoose={chooseFile} />}

      {step === 'plan' && plan && (
        <>
          <Card
            title="خطة الاستيراد"
            subtitle={plan.stagingOnly
              ? `${plan.fileName} · حُفظ الملف في منطقة المراجعة دون تحويله إلى سجلات مديريات`
              : `${plan.fileName} · الورقة «${plan.sheetName}» · صف الرؤوس ${plan.headerRow}`}
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
            {(plan.stagingOnly || plan.totalRows === 0) && (
              <Notice tone="warn" title="هذه الدفعة محفوظة للمراجعة فقط">
                لم يُكتشف جدول مديريات قابلًا للاستيراد المباشر. لا يمكن تنفيذ زر اعتماد المديريات لهذه الدفعة؛ تبقى أوراقها وبياناتها محفوظة في سجل الاستقبال حتى يُضاف لها مسار مطابقة واعتماد مخصص.
              </Notice>
            )}
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

          {plan.workbookInventory && (
            <Card
              title="فحص بنية ملف Excel"
              subtitle={`فُحصت ${plan.workbookInventory.sheetCount} ورقة؛ اختر النظام جدولًا واحدًا للمسار الحالي، وتظهر هنا كل الأوراق ومناطق العناوين المرشحة.`}
            >
              <div className="stat-strip">
                <MiniStat label="أوراق العمل" value={fmtNumber(plan.workbookInventory.sheetCount, 0)} />
                <MiniStat label="أوراق ظاهرة" value={fmtNumber(plan.workbookInventory.visibleSheetCount, 0)} />
                <MiniStat label="أوراق مخفية" value={fmtNumber(plan.workbookInventory.hiddenSheetCount, 0)} />
                <MiniStat label="رؤوس مرشحة" value={fmtNumber(plan.workbookInventory.sheets.reduce((sum, sheet) => sum + sheet.headerCandidates.length, 0), 0)} />
                <MiniStat label="أصول صور" value={fmtNumber(plan.workbookInventory.workbookImageAssetCount ?? 0, 0)} />
              </div>
              <div className="table-wrap" style={{ marginTop: 14 }}>
                <table className="data">
                  <thead>
                    <tr>
                      <th>ورقة العمل</th>
                      <th>الحالة</th>
                      <th>الأبعاد (صف × عمود)</th>
                      <th>عناوين الجداول المحتملة</th>
                      <th>محتوى إضافي</th>
                      <th>الإجراء</th>
                    </tr>
                  </thead>
                  <tbody>
                    {plan.workbookInventory.sheets.map((sheet) => (
                      <tr key={sheet.name}>
                        <td className="strong">{sheet.name}</td>
                        <td>{sheet.hidden ? <Badge tone="warn">مخفية</Badge> : <Badge tone="ok">ظاهرة</Badge>}</td>
                        <td className="num">{fmtNumber(sheet.rowCount, 0)} × {fmtNumber(sheet.columnCount, 0)}</td>
                        <td>
                          {sheet.headerCandidates.length
                            ? sheet.headerCandidates.map((candidate) => `صف ${candidate.headerRow} · ${candidate.matchedCount} حقول`).join('، ')
                            : <span className="muted">لم يُكتشف رأس معروف</span>}
                        </td>
                        <td>
                          <div className="chip-row">
                            {sheet.imageCount > 0 && <span className="chip">صور: {sheet.imageCount}</span>}
                            {sheet.formulaCount > 0 && <span className="chip">صيغ: {sheet.formulaCount}</span>}
                            {sheet.mergedRangeCount > 0 && <span className="chip">دمج: {sheet.mergedRangeCount}</span>}
                            {sheet.tableCount > 0 && <span className="chip">جداول Excel: {sheet.tableCount}</span>}
                            {sheet.hiddenRowCount > 0 && <span className="chip">صفوف مخفية: {sheet.hiddenRowCount}</span>}
                            {!sheet.imageCount && !sheet.formulaCount && !sheet.mergedRangeCount && !sheet.tableCount && !sheet.hiddenRowCount && <span className="muted">—</span>}
                          </div>
                        </td>
                        <td>
                          {sheet.selected
                            ? <Badge tone="ok">الورقة المستخدمة</Badge>
                            : sheet.headerCandidates.length
                              ? <Badge tone="warn">مرشح غير مستورد</Badge>
                              : <Badge>غير مستهدفة</Badge>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Notice tone="warn" title="حدود الاستيراد الحالية">
                <span className="chip warn">يُستورد أول جدول مرشح فقط من ورقة ظاهرة واحدة</span>
                <span className="chip">الأوراق والجداول الإضافية لا تُدمج أو تُستورد تلقائيًا</span>
                <span className="chip">الصور والصيغ والخلايا المدمجة تُحصَر للمراجعة ولا تُحوّل إلى بيانات تلقائيًا</span>
                <span className="chip">مواضع الصور غير المؤكدة: {fmtNumber(plan.workbookInventory.unanchoredImageAssetCount ?? 0, 0)}</span>
                <span className="chip">يلزم اختيار وربط مستقل قبل إدخال جداول المشاريع أو المؤشرات القطاعية المتعددة</span>
              </Notice>
              {(plan.workbookInventory.sheets.some((sheet) => sheet.inventoryTruncated || sheet.headerScanTruncated)) && (
                <p className="muted" style={{ fontSize: '0.8rem', marginTop: 10 }}>
                  ملاحظة: حدود الفحص ظاهرة في التقرير؛ قد توجد عناوين أو تفاصيل إضافية بعد الحد الأعلى المعلن.
                </p>
              )}
            </Card>
          )}

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
                <button className="btn primary sheen" onClick={apply} disabled={busy || plan.stagingOnly || plan.totalRows === 0}>
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

function DurableStaging({ staging, status, stagingOnly, message }) {
  return (
    <Card
      title="نسخة الاستقبال المحفوظة داخل قاعدة البيانات"
      subtitle={`دفعة #${staging.batchId} · SHA-256 ${String(staging.sha256 ?? '').slice(0, 16)}… · الحالة: ${status ?? 'staged'}`}
    >
      <div className="stat-strip">
        <MiniStat label="أوراق العمل" value={fmtNumber(staging.sheetCount, 0)} />
        <MiniStat label="صفوف مفحوصة" value={fmtNumber(staging.rowCount, 0)} />
        <MiniStat label="خلايا محفوظة" value={fmtNumber(staging.cellCount, 0)} />
        <MiniStat label="صيغ" value={fmtNumber(staging.formulaCount, 0)} />
        <MiniStat label="صفوف مخفية" value={fmtNumber(staging.hiddenRowCount, 0)} />
        <MiniStat label="صور مستخرجة" value={`${fmtNumber(staging.mediaStoredCount, 0)}/${fmtNumber(staging.mediaCount, 0)}`} />
      </div>
      {stagingOnly && <Notice tone="warn" title="لم يُكتشف جدول مديريات مطابق للمسار الحالي">{message ?? 'حُفظ الملف الأصلي وبنيته للمراجعة؛ لم تُنشأ مديريات تلقائيًا.'}</Notice>}
      {staging.truncated && <Notice tone="warn" title="وصل الملف إلى حد فحص معلن">حُفظت النسخة الأصلية، لكن فهرسة الصفوف والخلايا توقفت عند حدود الحماية. لا تعتبر هذه الدفعة مفحوصة بالكامل.</Notice>}
      {staging.mediaUnanchoredCount > 0 && <Notice tone="warn" title="صور بلا موضع موثوق">{fmtNumber(staging.mediaUnanchoredCount, 0)} صورة/عنصر لم يمكن ربط موضعه بورقة وخلية بشكل موثوق؛ حُفظت غير منسوبة إلى كيان.</Notice>}
      <div className="table-wrap" style={{ marginTop: 14 }}>
        <table className="data">
          <thead><tr><th>الورقة</th><th>الحالة</th><th>الأبعاد</th><th>صفوف محفوظة</th><th>خلايا</th><th>مناطق مرشحة</th><th>محتوى إضافي</th></tr></thead>
          <tbody>
            {(staging.sheets ?? []).map(sheet => (
              <tr key={sheet.name}>
                <td className="strong">{sheet.name}</td>
                <td>{sheet.state === 'visible' ? <Badge tone="ok">ظاهرة</Badge> : <Badge tone="warn">{sheet.state}</Badge>}</td>
                <td className="num">{fmtNumber(sheet.rowCount,0)} × {fmtNumber(sheet.columnCount,0)}</td>
                <td className="num">{fmtNumber(sheet.nonemptyRows,0)}</td>
                <td className="num">{fmtNumber(sheet.cellCount,0)}</td>
                <td>{sheet.regions?.length ? sheet.regions.map(region => `صف ${region.headerRow} · ${region.matchedCount} حقول · ${region.candidateType}`).join('، ') : '—'}</td>
                <td><div className="chip-row">
                  {sheet.formulaCount > 0 && <span className="chip">صيغ: {sheet.formulaCount}</span>}
                  {sheet.hiddenRowCount > 0 && <span className="chip">مخفية: {sheet.hiddenRowCount}</span>}
                  {sheet.imageCount > 0 && <span className="chip">صور: {sheet.imageCount}</span>}
                  {sheet.tableCount > 0 && <span className="chip">جداول: {sheet.tableCount}</span>}
                  {sheet.mergedRangeCount > 0 && <span className="chip">دمج: {sheet.mergedRangeCount}</span>}
                  {sheet.truncated && <Badge tone="warn">حد فحص</Badge>}
                  {!sheet.formulaCount && !sheet.hiddenRowCount && !sheet.imageCount && !sheet.tableCount && !sheet.mergedRangeCount && !sheet.truncated && '—'}
                </div></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Notice tone="info" title="ما الذي تم حفظه؟">
        <span className="chip">الملف الأصلي وبصمته</span>
        <span className="chip">خلايا كل ورقة مع موقعها ومحتواها وصيغها وملاحظاتها</span>
        <span className="chip">الصفوف المخفية ومناطق العناوين المرشحة</span>
        <span className="chip">الصورة ومعلومات المرساة عند توفرها</span>
        <span className="chip warn">لا يوجد ربط آلي بين صفوف المشاريع أو الصور والمديريات</span>
      </Notice>
    </Card>
  );
}

function ImportHistory({ rows }) {
  return (
    <Card title="سجل ملفات الاستيراد المستلمة" subtitle="هذه الدفعات محفوظة محليًا حتى عند إغلاق الشاشة؛ حالة الاستقبال لا تعني اعتماد بياناتها.">
      {rows.length === 0 ? <p className="muted">لا توجد دفعات محفوظة بعد.</p> : (
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>الملف</th><th>تاريخ الاستلام</th><th>الأوراق</th><th>الصفوف</th><th>الخلايا</th><th>الصور</th><th>الحالة</th></tr></thead>
            <tbody>{rows.map(row => (
              <tr key={row.id}>
                <td className="strong">{row.file_name}</td>
                <td>{row.created_at}</td>
                <td className="num">{fmtNumber(row.sheet_count,0)}</td>
                <td className="num">{fmtNumber(row.row_count,0)}</td>
                <td className="num">{fmtNumber(row.cell_count,0)}</td>
                <td className="num">{fmtNumber(row.media_stored_count,0)}/{fmtNumber(row.media_count,0)}</td>
                <td><Badge tone={row.status === 'staged' ? 'warn' : 'info'}>{row.status}</Badge></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function Starter({ busy, onChoose }) {
  return (
    <div className="grid-2">
      <Card title="استقبال ملفات Excel" subtitle="يحفظ الملف الأصلي ويفهرس محتواه قبل اعتماد أي بيانات.">
        <div className="stack">
          <p className="muted" style={{ fontSize: '0.88rem' }}>
            اختر ملف Excel حتى لو اختلفت أوراقه أو عناوينه أو ترتيب أعمدته. يحفظ النظام النسخة الأصلية ويفحص الأوراق
            والخلايا والجداول والصور التي يستطيع استخراجها. وإذا وجد جدول مديريات معروفًا، يعرض خطة منفصلة قبل كتابة أي قيمة.
          </p>
          <ul className="stack tight">
            <li className="row gap-sm"><CheckCircle2 size={16} className="muted" /> الصيغ المقبولة: xlsx أو xlsm بحجم أقصى 200 ميجابايت.</li>
            <li className="row gap-sm"><CheckCircle2 size={16} className="muted" /> تُفهرس جميع الأوراق الظاهرة والمخفية ومناطق العناوين المرشحة ضمن حدود الفحص المعلنة.</li>
            <li className="row gap-sm"><CheckCircle2 size={16} className="muted" /> الاستيراد المباشر الحالي يقتصر على جدول المديريات المعروف؛ بقية الجداول تبقى محفوظة للمراجعة ولا تُحوّل قسرًا إلى مديريات.</li>
            <li className="row gap-sm"><CheckCircle2 size={16} className="muted" /> تُحفظ مواقع الخلايا والصيغ ونتائجها المخزنة والملاحظات؛ لا تُنفذ صيغ Excel.</li>
            <li className="row gap-sm"><CheckCircle2 size={16} className="muted" /> لا تُعتمد أي بيانات أو صور ولا تُربط بكيان اعتمادًا على التشابه وحده.</li>
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
          <TimelineItem n={1} title="حفظ وفهرسة الملف" body="حفظ النسخة الأصلية، فحص جميع الأوراق والخلايا ومناطق البيانات والصور القابلة للاستخراج." />
          <TimelineItem n={2} title="مطابقة البيانات المعروفة" body="إذا وُجد جدول مديريات معروف، تُعرض خطة صفوفه وفروقها. أما الجداول الأخرى فتبقى في الاستقبال غير المعتمد." />
          <TimelineItem n={3} title="الاعتماد المرحلي" body="لا يُكتب جدول المديريات إلا بقرار صريح. يتطلب استيراد المشاريع والمؤشرات وبقية الكيانات ربطًا ومراجعة مخصصين." />
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