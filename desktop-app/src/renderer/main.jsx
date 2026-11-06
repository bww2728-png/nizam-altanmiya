import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Activity, AlertTriangle, ArrowDownToLine, Check, ChevronDown, CircleHelp, Database, FileSpreadsheet, FileText, FolderUp, Home, LockKeyhole, LogOut, MapPinned, RefreshCw, Search, ShieldCheck, Table2, X } from 'lucide-react';
import './styles.css';
import brandBanner from './assets/brand-banner.jpg';
import logoBadge from './assets/logo-badge.png';

const TAGLINES = ['تطوير مستدام', 'تنمية محلية', 'تمكين مجتمعي', 'إزدهار وطني'];

const numberFormat = new Intl.NumberFormat('ar');
const dateFormat = new Intl.DateTimeFormat('ar', { dateStyle: 'medium', timeStyle: 'short' });

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : dateFormat.format(date);
}

function App() {
  const [unlocked, setUnlocked] = useState(false);
  const [databaseExists, setDatabaseExists] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [active, setActive] = useState('overview');
  const [overview, setOverview] = useState(null);
  const [imports, setImports] = useState([]);
  const [review, setReview] = useState([]);
  const [reviewTab, setReviewTab] = useState('pending');
  const [selected, setSelected] = useState(new Set());
  const [searchTerm, setSearchTerm] = useState('');
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState('');
  const [toast, setToast] = useState('');
  const [filter, setFilter] = useState('');

  const refresh = useCallback(async () => {
    if (!unlocked) return;
    try {
      const [stats, history, items] = await Promise.all([
        window.localApp.overview(),
        window.localApp.imports(),
        window.localApp.reviewItems({ status: reviewTab, batchId: filter || undefined, limit: 500 }),
      ]);
      setOverview(stats);
      setImports(history);
      setReview(items);
      setSelected(new Set());
    } catch (cause) {
      setError(cause.message || 'تعذر تحديث البيانات.');
    }
  }, [unlocked, reviewTab, filter]);

  useEffect(() => {
    window.localApp.status().then((status) => {
      setUnlocked(status.unlocked);
      setDatabaseExists(status.hasDatabase);
    }).catch((cause) => setError(cause.message || 'تعذر فحص قاعدة البيانات المحلية.')).finally(() => setReady(true));
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    const unsubscribe = window.localApp.onImportProgress((message) => setProgress(message.message || ''));
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (!toast) return undefined;
    const timer = window.setTimeout(() => setToast(''), 3500);
    return () => window.clearTimeout(timer);
  }, [toast]);

  async function enterWorkspace() {
    setError('');
    setLoading(true);
    try {
      await window.localApp.open();
      setDatabaseExists(true);
      setUnlocked(true);
      setToast('تم فتح قاعدة البيانات المحلية المشفّرة.');
    } catch (cause) {
      setError(cause.message || 'تعذر فتح قاعدة البيانات.');
    } finally {
      setLoading(false);
    }
  }

  async function lockDatabase() {
    await window.localApp.lock();
    setUnlocked(false);
    setOverview(null);
    setReview([]);
    setToast('أُغلقت قاعدة البيانات.');
  }

  async function importFile() {
    setError('');
    setLoading(true);
    try {
      const result = await window.localApp.selectAndExtract();
      if (!result.canceled) {
        setFilter(String(result.batchId));
        setReviewTab('pending');
        setActive('review');
        setToast(`استخرج النظام ${numberFormat.format(result.itemCount)} قيمة لتدقيقك من «${result.fileName}».`);
        if (result.warnings?.length) setError(result.warnings.join(' '));
        if (result.truncated) setError('بلغ الاستخراج حد العرض الآمن؛ راجع سجل الاستيراد لتأكيد أن الملف عولج كاملًا.');
      }
    } catch (cause) {
      setError(cause.message || 'تعذر استيراد الملف محليًا.');
    } finally {
      setLoading(false);
      setProgress('');
      refresh();
    }
  }

  async function saveReviewItem(item, values) {
    try {
      await window.localApp.updateReviewItem({
        id: item.id,
        fieldName: values.get('fieldName'),
        value: values.get('value'),
        proposedType: values.get('proposedType'),
        governorate: values.get('governorate'),
        district: values.get('district'),
        subdistrict: values.get('subdistrict'),
        settlement: values.get('settlement'),
        recordId: values.get('recordId'),
      });
      setToast('حُفظت تعديلات المراجعة محليًا.');
      refresh();
    } catch (cause) {
      setError(cause.message || 'تعذر حفظ التعديلات.');
    }
  }

  async function resolveSelected(action) {
    if (!selected.size) return;
    if (action !== 'reject' && !window.confirm(`سيُعتمد ${numberFormat.format(selected.size)} سجلًا بعد التحقق من اكتمال المفتاح الجغرافي. متابعة؟`)) return;
    setLoading(true);
    setError('');
    try {
      const result = await window.localApp.resolveReviewItems({ action, ids: [...selected] });
      const messages = [];
      if (result.accepted) messages.push(`اعتماد ${numberFormat.format(result.accepted)}`);
      if (result.conflicts) messages.push(`تعارض ${numberFormat.format(result.conflicts)}`);
      if (result.ignored) messages.push(`غير مكتمل ${numberFormat.format(result.ignored)}`);
      if (result.rejected) messages.push(`رفض ${numberFormat.format(result.rejected)}`);
      setToast(messages.join(' · ') || 'اكتملت العملية.');
      await refresh();
    } catch (cause) {
      setError(cause.message || 'تعذر إتمام المراجعة.');
    } finally {
      setLoading(false);
    }
  }

  async function exportData() {
    try {
      const result = await window.localApp.exportApprovedData();
      if (!result.canceled) setToast('تم تصدير السجلات المعتمدة إلى ملف Excel محلي.');
    } catch (cause) {
      setError(cause.message || 'تعذر تصدير البيانات.');
    }
  }

  const filteredReview = useMemo(() => {
    const term = searchTerm.trim().toLocaleLowerCase('ar');
    if (!term) return review;
    return review.filter((item) => [item.field_name, item.value_text, item.file_name, item.source_location, item.district, item.settlement].some((value) => String(value || '').toLocaleLowerCase('ar').includes(term)));
  }, [review, searchTerm]);

  if (!ready) return <main className="welcome-screen"><section className="welcome-card"><div className="welcome-loading"><img src={logoBadge} alt="" /><p className="eyebrow">منظومة محلية مستقلة</p><h1>نظام التنمية المحلية</h1><p className="welcome-copy">جارٍ فحص قاعدة البيانات على هذا الجهاز...</p></div></section></main>;

  if (!unlocked) {
    return <main className="welcome-screen">
      <section className="welcome-card">
        <img className="welcome-banner" src={brandBanner} alt="شعار نظام التنمية المحلية" />
        <div className="welcome-body">
          <p className="welcome-subtitle">YEMEN LOCAL DEVELOPMENT SYSTEM</p>
          <h1>نظام التنمية المحلية</h1>
          <p className="welcome-republic">الجمهورية اليمنية · مركز إدارة البيانات المحلية</p>
          <p className="welcome-copy">استيراد ملفات Excel وPDF وWord، واستخراج قيمها مع موضع كل قيمة في مصدرها، ثم مراجعتها واعتمادها محليًا على هذا الجهاز. الدخول مباشر بلا حساب وبلا كلمة مرور، ولا تُرسل أي بيانات إلى أي خدمة خارجية.</p>
          <ul className="welcome-taglines">{TAGLINES.map((tagline) => <li key={tagline}>{tagline}</li>)}</ul>
          {error && <div className="error-banner"><AlertTriangle size={17} /><span>{error}</span></div>}
          <button className="primary-button full-width" onClick={enterWorkspace} disabled={loading}>{loading ? 'جارٍ التهيئة...' : databaseExists ? 'الدخول إلى مساحة العمل' : 'إنشاء قاعدة البيانات والدخول'}</button>
          <div className="privacy-note"><ShieldCheck size={18} /><span>قاعدة بيانات مشفّرة على جهازك · معالجة الملفات محليًا · لا اتصال سحابي</span></div>
        </div>
      </section>
    </main>;
  }

  const navItems = [
    { id: 'overview', label: 'نظرة عامة', icon: Home },
    { id: 'review', label: 'مراجعة الاستخراج', icon: Check, badge: (overview?.pending || 0) + (overview?.conflicts || 0) },
    { id: 'imports', label: 'سجل الاستيراد', icon: FolderUp },
    { id: 'data', label: 'البيانات المعتمدة', icon: Table2 },
  ];

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand-lockup"><div className="brand-icon"><img src={logoBadge} alt="" /></div><div><strong>التنمية المحلية</strong><span>مركز إدارة البيانات</span></div></div>
      <div className="workspace-label">مساحة العمل <ChevronDown size={15} /></div>
      <div className="workspace-card"><span className="workspace-dot" /><div><strong>قاعدة محلية مشفّرة</strong><small>البيانات على هذا الجهاز</small></div></div>
      <nav className="side-nav" aria-label="التنقل الرئيسي">
        <p className="nav-caption">المساحة الرئيسية</p>
        {navItems.map(({ id, label, icon: Icon, badge }) => <button key={id} className={`nav-item ${active === id ? 'active' : ''}`} onClick={() => { setActive(id); setError(''); }}><Icon size={18} /><span>{label}</span>{badge > 0 && <b>{numberFormat.format(badge)}</b>}</button>)}
      </nav>
      <div className="sidebar-bottom">
        <div className="local-status"><span className="status-pulse" /><div><strong>وضع عدم الاتصال</strong><small>معالجة محلية فقط</small></div></div>
        <button className="nav-item lock-action" onClick={lockDatabase}><LogOut size={18} /><span>قفل قاعدة البيانات</span></button>
        <div className="sidebar-footer">نظام داخلي · إصدار تجريبي</div>
      </div>
    </aside>

    <main className="main-area">
      <header className="topbar"><div className="breadcrumbs"><span>نظام التنمية المحلية</span><span className="crumb-divider">/</span><strong>{navItems.find((item) => item.id === active)?.label}</strong></div><div className="topbar-actions"><span className="local-chip"><LockKeyhole size={14} /> محلي ومشفّر</span><button className="icon-button" title="تحديث البيانات" onClick={refresh}><RefreshCw size={17} /></button><div className="avatar">م</div></div></header>
      <section className="page-content">
        {error && <div className="error-banner page-error"><AlertTriangle size={18} /><span>{error}</span><button onClick={() => setError('')} aria-label="إغلاق التنبيه"><X size={16} /></button></div>}
        {progress && <div className="progress-banner"><Activity size={18} />{progress}</div>}

        {active === 'overview' && <>
                    <section className="overview-hero">
            <img className="overview-hero-banner" src={brandBanner} alt="نظام التنمية المحلية" />
            <div className="overview-hero-row">
              <div>
                <p className="eyebrow">مساحة البيانات</p>
                <h1>مرحبًا بك في نظام التنمية المحلية</h1>
                <p>ملخص البيانات المحلية وحالة المراجعات، وكل قيمة مرتبطة بموضعها في ملفها الأصلي.</p>
              </div>
              <button className="primary-button" onClick={importFile} disabled={loading}><FolderUp size={17} />استيراد ملف</button>
            </div>
          </section>
          <div className="metric-grid">
            <MetricCard label="السجلات الجغرافية" value={overview?.records} note="تجمعات وأصول بعد اعتمادها" icon={MapPinned} tone="teal" />
            <MetricCard label="القيم المعتمدة" value={overview?.values} note="مرتبطة بموضعها ومصدرها" icon={Database} tone="blue" />
            <MetricCard label="مراجعات غير محسومة" value={(overview?.pending || 0) + (overview?.conflicts || 0)} note="مسودات أو تعارضات غير محسومة" icon={AlertTriangle} tone="amber" />
            <MetricCard label="ملفات مستوردة" value={overview?.batches} note="سجل الاستيراد المحلي" icon={FileText} tone="violet" />
          </div>
          <div className="dashboard-grid">
            <section className="panel recent-panel"><div className="panel-heading"><div><h2>آخر عمليات الاستيراد</h2><p>تظهر نتائج الاستخراج للمراجعة قبل الاعتماد.</p></div><button className="text-button" onClick={() => setActive('imports')}>عرض السجل</button></div>
              {overview?.recent?.length ? <div className="recent-list">{overview.recent.map((row) => <div className="recent-row" key={row.id}><div className={`file-icon ${row.file_type}`}><FileIcon type={row.file_type} /></div><div className="recent-file"><strong>{row.file_name}</strong><span>{formatDate(row.created_at)} · {numberFormat.format(row.item_count)} قيمة</span></div><StatusPill status={row.status} /></div>)}</div> : <EmptyState icon={FolderUp} title="لا توجد ملفات مستوردة" text="ابدأ برفع ملف Excel أو PDF أو Word محليًا." action="استيراد ملف" onAction={importFile} />}
            </section>
            <section className="panel workflow-panel"><div className="panel-heading"><div><h2>سير العمل</h2><p>لا تُعتمد أي قيمة دون مراجعة المستخدم.</p></div><CircleHelp size={19} className="muted-icon" /></div><div className="workflow-steps"><WorkflowStep number="01" title="استيراد محلي" description="اختر ملفًا من جهازك؛ لا يُرفع إلى الإنترنت." done={Boolean(overview?.batches)} /><WorkflowStep number="02" title="تدقيق الاستخراج" description="صحّح الحقول وأدخل المفتاح الجغرافي ومصدر القيمة." active={Boolean(overview?.pending)} /><WorkflowStep number="03" title="اعتماد البيانات" description="تُحفظ القيم المقبولة فقط في القاعدة المشفّرة." done={Boolean(overview?.values)} last /></div></section>
          </div>
          <div className="info-strip"><ShieldCheck size={19} /><div><strong>تنبيه جودة البيانات</strong><span>استخراج PDF/OCR قد يخطئ؛ كل نتيجة مسودة غير معتمدة حتى تراجعها. تُحفظ بيانات المصدر وموضع الصفحة أو الخلية مع القيمة.</span></div></div>
        </>}

        {active === 'review' && <>
          <div className="page-heading"><div><p className="eyebrow">حوكمة البيانات</p><h1>مراجعة الاستخراج</h1><p>تأكد من القيمة ومفتاحها الجغرافي قبل اعتمادها في قاعدة البيانات.</p></div><button className="primary-button" onClick={importFile} disabled={loading}><FolderUp size={17} />استيراد ملف</button></div>
          <div className="review-guidance"><ShieldCheck size={18} /><span>القيم المستخرجة لا تدخل في الحسابات تلقائيًا. أكمل الحقول الجغرافية المطلوبة لكل سجل، ثم اعتمده.</span></div>
          <div className="toolbar"><div className="tabs"><button className={reviewTab === 'pending' ? 'selected' : ''} onClick={() => setReviewTab('pending')}>بانتظار المراجعة</button><button className={reviewTab === 'conflict' ? 'selected' : ''} onClick={() => setReviewTab('conflict')}>التعارضات</button><button className={reviewTab === 'accepted' ? 'selected' : ''} onClick={() => setReviewTab('accepted')}>المعتمدة</button><button className={reviewTab === 'rejected' ? 'selected' : ''} onClick={() => setReviewTab('rejected')}>المرفوضة</button></div><label className="search-box"><Search size={17} /><input value={searchTerm} onChange={(event) => setSearchTerm(event.target.value)} placeholder="بحث في الحقل أو القيمة أو المصدر" /></label></div>
          {reviewTab === 'pending' && <div className="bulk-toolbar"><label><input type="checkbox" checked={filteredReview.length > 0 && selected.size === filteredReview.length} onChange={(event) => setSelected(event.target.checked ? new Set(filteredReview.map((item) => item.id)) : new Set())} />تحديد النتائج الظاهرة ({numberFormat.format(selected.size)})</label><div><button className="secondary-button danger-button" disabled={!selected.size || loading} onClick={() => resolveSelected('reject')}>رفض المحدد</button><button className="primary-button" disabled={!selected.size || loading} onClick={() => resolveSelected('accept')}><Check size={16} />اعتماد المحدد</button></div></div>}
          {filteredReview.length ? <div className="review-list">{filteredReview.map((item) => <ReviewCard key={item.id} item={item} selectable={reviewTab === 'pending'} selected={selected.has(item.id)} onSelect={(checked) => setSelected((previous) => { const next = new Set(previous); if (checked) next.add(item.id); else next.delete(item.id); return next; })} onSave={saveReviewItem} onAccept={() => resolveOne(item, 'accept')} onReplace={() => resolveOne(item, 'replace')} onReject={() => resolveOne(item, 'reject')} />)}</div> : <div className="panel"><EmptyState icon={Check} title={reviewTab === 'pending' ? 'لا توجد قيم بانتظار المراجعة' : 'لا توجد نتائج في هذا القسم'} text="يمكنك استيراد ملف جديد لمعالجة محلية ومراجعة موثقة." action="استيراد ملف" onAction={importFile} /></div>}
        </>}

        {active === 'imports' && <>
          <div className="page-heading"><div><p className="eyebrow">تتبّع المصدر</p><h1>سجل الاستيراد</h1><p>الملفات المستوردة محليًا مع عدد العناصر التحليلية وحالة المراجعة.</p></div><button className="primary-button" onClick={importFile} disabled={loading}><FolderUp size={17} />استيراد ملف</button></div>
          <section className="panel table-panel"><div className="table-scroll"><table><thead><tr><th>اسم الملف</th><th>النوع</th><th>الحجم</th><th>العناصر</th><th>الحالة</th><th>تاريخ الاستيراد</th><th>الإجراء</th></tr></thead><tbody>{imports.map((row) => <tr key={row.id}><td className="file-name-cell"><span className={`file-icon ${row.file_type}`}><FileIcon type={row.file_type} /></span>{row.file_name}</td><td>{row.file_type.toUpperCase()}</td><td>{numberFormat.format(Math.ceil(row.file_size / 1024))} ك.ب</td><td>{numberFormat.format(row.item_count)}</td><td><StatusPill status={row.status} /></td><td>{formatDate(row.created_at)}</td><td><button className="text-button" onClick={() => { setFilter(String(row.id)); setReviewTab('pending'); setActive('review'); }}>مراجعة العناصر</button></td></tr>)}</tbody></table></div>{!imports.length && <EmptyState icon={FolderUp} title="سجل الاستيراد فارغ" text="ستظهر الملفات هنا بعد اختيارها من جهازك." action="استيراد ملف" onAction={importFile} />}</section>
        </>}

        {active === 'data' && <>
          <div className="page-heading"><div><p className="eyebrow">البيانات الموثقة</p><h1>البيانات المعتمدة</h1><p>السجلات المراجعة والمحفوظة محليًا، مع المحافظة على مصدر كل قيمة.</p></div><button className="primary-button" onClick={exportData}><ArrowDownToLine size={17} />تصدير Excel</button></div>
          <div className="data-banner"><Database size={19} /><span><strong>{numberFormat.format(overview?.values || 0)} قيمة محفوظة</strong> — التصدير ينشئ نسخة XLSX محلية ولا يغيّر قاعدة البيانات المشفّرة.</span></div>
          <ApprovedDataTable />
        </>}
      </section>
    </main>
    {toast && <div className="toast" role="status" aria-live="polite"><Check size={17} />{toast}</div>}
  </div>;

  async function resolveOne(item, action) {
    if (action !== 'reject' && !window.confirm('اعتماد هذه القيمة بعد التحقق من اكتمال المفتاح الجغرافي؟')) return;
    setLoading(true);
    try {
      const result = await window.localApp.resolveReviewItems({ action, ids: [item.id] });
      setToast(result.accepted ? 'تم اعتماد السجل.' : result.conflicts ? 'وجد تعارض؛ اختر «استبدال» بعد التحقق.' : result.rejected ? 'تم رفض السجل.' : 'أكمل حقول الموقع الجغرافي قبل الاعتماد.');
      await refresh();
    } catch (cause) { setError(cause.message || 'تعذر تحديث الحالة.'); }
    finally { setLoading(false); }
  }
}

function MetricCard({ label, value, note, icon: Icon, tone }) {
  return <article className="metric-card"><div className={`metric-icon ${tone}`}><Icon size={20} /></div><span className="metric-label">{label}</span><strong className="metric-value">{numberFormat.format(value || 0)}</strong><span className="metric-note">{note}</span></article>;
}

function FileIcon({ type }) {
  if (type === 'xlsx') return <FileSpreadsheet size={18} />;
  return <FileText size={18} />;
}

function StatusPill({ status }) {
  const options = { review: ['قيد المراجعة', 'pending'], pending: ['بانتظار المراجعة', 'pending'], conflict: ['تعارض', 'conflict'], accepted: ['معتمد', 'accepted'], rejected: ['مرفوض', 'rejected'], completed: ['مكتمل', 'accepted'] };
  const [label, style] = options[status] || [status || '—', 'pending'];
  return <span className={`status-pill ${style}`}>{label}</span>;
}

function EmptyState({ icon: Icon, title, text, action, onAction }) {
  return <div className="empty-state"><div className="empty-icon"><Icon size={21} /></div><strong>{title}</strong><p>{text}</p>{action && <button className="secondary-button" onClick={onAction}>{action}</button>}</div>;
}

function WorkflowStep({ number, title, description, done, active, last }) {
  return <div className={`workflow-step ${done ? 'done' : ''} ${active ? 'current' : ''} ${last ? 'last' : ''}`}><div className="step-marker">{done ? <Check size={15} /> : number}</div><div><strong>{title}</strong><p>{description}</p></div></div>;
}

function ReviewCard({ item, selectable, selected, onSelect, onSave, onAccept, onReplace, onReject }) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const fields = [
    ['governorate', 'المحافظة'], ['district', 'المديرية'], ['subdistrict', 'العزلة'], ['settlement', 'التجمع/القرية'], ['recordId', 'معرّف السجل'],
  ];
  async function submit(event) {
    event.preventDefault();
    setSaving(true);
    await onSave(item, new FormData(event.currentTarget));
    setSaving(false);
    setEditing(false);
  }
  return <article className={`review-card ${selected ? 'selected' : ''}`}>
    <div className="review-card-top">{selectable && <input type="checkbox" checked={selected} onChange={(event) => onSelect(event.target.checked)} aria-label="تحديد السجل" />}<div className="review-title"><span className="review-field">{item.field_name}</span><StatusPill status={item.status} /></div><span className="confidence">المصدر محفوظ</span><button className="quiet-button" onClick={() => setEditing((value) => !value)}>{editing ? 'إلغاء التعديل' : 'تعديل السجل'}</button></div>
    {editing ? <form className="review-edit-form" onSubmit={submit}><label>اسم الحقل<input name="fieldName" defaultValue={item.field_name} required /></label><label className="wide-field">القيمة<input name="value" defaultValue={item.value_text} required /></label><label>نوع السجل<input name="proposedType" defaultValue={item.proposed_type || ''} placeholder="مدرسة، مرفق صحي…" /></label>{fields.map(([name, label]) => <label key={name}>{label}<input name={name} defaultValue={item[name === 'recordId' ? 'record_id' : name] || ''} required={name !== 'recordId'} /></label>)}<button className="primary-button" disabled={saving}><Check size={15} />حفظ التعديلات</button></form> : <div className="review-value">{item.value_text}</div>}
    <div className="review-source"><FileText size={15} /><span>{item.file_name}</span><span className="source-divider">·</span><span>{item.source_location}</span><span className="source-divider">·</span><time>{formatDate(item.created_at)}</time></div>
    {item.status === 'conflict' && <div className="conflict-note"><AlertTriangle size={15} />هذا المفتاح والحقل موجودان مسبقًا. قارن المصدرين قبل اختيار الاستبدال.</div>}
    {(selectable || item.status === 'conflict') && <div className="review-actions">{item.status === 'conflict' && <button className="secondary-button" onClick={onReplace}>استبدال القيمة الحالية</button>}<button className="secondary-button danger-button" onClick={onReject}>رفض</button><button className="primary-button" onClick={onAccept}><Check size={15} />اعتماد</button></div>}
  </article>;
}

function ApprovedDataTable() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  useEffect(() => { window.localApp.approvedValues().then(setRows).catch(() => {}).finally(() => setLoading(false)); }, []);
  const visible = rows.filter((row) => [row.field_name, row.value_text, row.district, row.settlement, row.governorate].some((value) => String(value || '').toLowerCase().includes(search.toLowerCase())));
  return <section className="panel table-panel"><div className="panel-heading data-panel-heading"><div><h2>السجلات التي راجعها المستخدم</h2><p>تظهر هنا بيانات السجلات المقبولة للمراجعة الموثقة.</p></div><label className="search-box"><Search size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="بحث في السجلات" /></label></div><div className="table-scroll"><table><thead><tr><th>الحقل</th><th>القيمة</th><th>المحافظة</th><th>المديرية</th><th>العزلة</th><th>التجمع/القرية</th><th>المصدر والموضع</th></tr></thead><tbody>{visible.map((row) => <tr key={row.id}><td>{row.field_name}</td><td className="approved-value">{row.value_text}</td><td>{row.governorate}</td><td>{row.district}</td><td>{row.subdistrict}</td><td>{row.settlement}</td><td>{row.source_file} · {row.source_location}</td></tr>)}</tbody></table></div>{loading && <div className="table-empty">جارٍ التحميل…</div>}{!loading && !visible.length && <div className="table-empty">لا توجد سجلات معتمدة للعرض. راجع القيم المستخرجة أولًا.</div>}</section>;
}

createRoot(document.getElementById('root')).render(<React.StrictMode><App /></React.StrictMode>);
