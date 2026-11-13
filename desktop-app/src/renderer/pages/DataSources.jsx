import React, { useCallback, useEffect, useState } from 'react';
import { Archive, Files, RotateCcw, Search, Trash2, RefreshCw } from 'lucide-react';
import { Badge, Card, Empty, ErrorBanner, Loading } from '../components/ui.jsx';
import { errText, fmtDateTime, fmtNumber } from '../lib/format.js';

const PAGE_SIZE = 30;
const SOURCE_LABELS = {
  manual_entry: 'إدخال يدوي',
  legacy_import: 'استيراد سابق',
  excel_workbook: 'مصنف Excel',
  'excel-workbook': 'ملف Excel مستلم',
  workbook_import: 'ملف Excel مستلم',
  document: 'وثيقة',
  'manual-indicator-observation': 'قياس مؤشر يدوي',
  'manual-project': 'مشروع يدوي',
};
const STATUS_LABELS = {
  staged: 'محفوظ للمراجعة',
  processing: 'جارٍ المعالجة',
  extracted: 'مستخرج',
  review: 'بانتظار المراجعة',
  failed: 'فشل المعالجة',
  unavailable: 'المعالج غير متاح',
  'directorates-applied': 'اكتمل استيراد المديريات',
  'directorates-partially-applied': 'استيراد مديريات جزئي',
  'directorates-applied-project-review-required': 'مديريات مستوردة ومشاريع للمراجعة',
  'directorates-and-projects-applied': 'اكتمل استيراد المديريات والمشاريع',
  'directorates-and-projects-partially-applied': 'استيراد المديريات والمشاريع جزئي',
  'reviewed-without-directorate-write': 'محفوظ دون اعتماد المديريات',
  'projects-review-required': 'مشاريع بانتظار المراجعة',
  'projects-partially-promoted': 'اعتماد مشاريع جزئي',
  'projects-promoted': 'اعتماد المشاريع مكتمل',
  'indicators-review-required': 'مؤشرات بانتظار المراجعة',
  'indicators-partially-promoted': 'اعتماد مؤشرات جزئي',
  'indicators-promoted': 'اعتماد المؤشرات مكتمل',
};

export default function DataSources({ refreshKey = 0, notify }) {
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [status, setStatus] = useState('');
  const [sort, setSort] = useState('newest');
  const [archived, setArchived] = useState('active');
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState({});
  const [payload, setPayload] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [restricted, setRestricted] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const result = await window.localApp.dataSources({ search, dateFrom, dateTo, status, sort, archived, offset, limit: PAGE_SIZE });
      setRestricted(Boolean(result?.restricted));
      if (!result?.restricted) setPayload(result);
    } catch (cause) {
      setError(errText(cause) || 'تعذر تحميل مصادر البيانات.');
    } finally {
      setLoading(false);
    }
  }, [archived, dateFrom, dateTo, offset, search, sort, status]);

  useEffect(() => { load(); }, [load, refreshKey]);

  const updateFilters = (changes) => {
    setOffset(0);
    setSelected({});
    Object.entries(changes).forEach(([key, value]) => {
      if (key === 'searchInput') setSearchInput(value);
      else if (key === 'search') setSearch(value);
      else if (key === 'dateFrom') setDateFrom(value);
      else if (key === 'dateTo') setDateTo(value);
      else if (key === 'status') setStatus(value);
      else if (key === 'sort') setSort(value);
      else if (key === 'archived') setArchived(value);
    });
  };

  const rows = payload?.rows ?? [];
  const total = payload?.total ?? 0;
  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const selectableRows = rows.filter(row => row.resource_type === 'document' || row.resource_type === 'workbook_import');
  const selectedTargets = selectableRows.filter(row => selected[`${row.resource_type}:${row.resource_id}`]);

  const changeArchive = async (targets, action) => {
    if (!targets.length) return;
    if (action === 'archive' && !window.confirm(`سيُنقل ${fmtNumber(targets.length, 0)} ملف إلى الأرشيف. يمكن استعادته لاحقًا، ولن تُحذف بياناته. هل تريد المتابعة؟`)) return;
    setBusy(true);
    setError('');
    try {
      const result = action === 'archive'
        ? await window.localApp.archiveFiles(targets)
        : await window.localApp.restoreFiles(targets);
      setSelected({});
      await load();
      notify?.({
        tone: 'ok', message: action === 'archive'
          ? `نُقل ${fmtNumber(result.archived, 0)} ملف إلى الأرشيف ويمكن استعادته.`
          : `استُعيد ${fmtNumber(result.restored, 0)} ملف من الأرشيف.`,
      });
    } catch (cause) {
      setError(errText(cause) || 'تعذرت إدارة أرشيف الملفات.');
    } finally {
      setBusy(false);
    }
  };

  const targetsFor = items => items.map(row => ({ resourceType: row.resource_type, resourceId: row.resource_id }));

  return (
    <>
      <Card title="مصادر البيانات" subtitle="سجل المصادر والملفات المستوردة والمستلمة. تبقى الملفات المؤرشفة قابلة للاستعادة، ولا يؤدي الأرشيف إلى حذف البيانات المرتبطة." icon={Files}
        actions={<div className="btn-row"><button className="btn small ghost" type="button" onClick={() => updateFilters({ archived: archived === 'active' ? 'archived' : 'active' })}><Archive size={14} />{archived === 'archived' ? 'عرض الملفات النشطة' : 'عرض الأرشيف'}</button><button className="btn small ghost" onClick={load} disabled={loading}><RefreshCw size={14} /> تحديث</button></div>}>
        {restricted ? <div className="quote"><strong>سجل المصادر متاح في وضع المالك فقط.</strong></div> : (
          <>
            <form className="stack" onSubmit={event => { event.preventDefault(); updateFilters({ search: searchInput.trim().slice(0, 120) }); }}>
              <div className="toolbar">
                <div className="search-box" style={{ flex: 1, minWidth: 220 }}><Search size={16} /><input className="input" value={searchInput} onChange={event => setSearchInput(event.target.value)} placeholder="ابحث باسم الملف أو الجهة أو نوع المصدر" /></div>
                <button className="btn primary" type="submit"><Search size={15} /> بحث</button>
                <button className="btn ghost" type="button" onClick={() => { setSearchInput(''); updateFilters({ search: '', dateFrom: '', dateTo: '', status: '' }); }} disabled={!search && !searchInput && !dateFrom && !dateTo && !status}>مسح</button>
              </div>
              <div className="grid-2">
                <label className="stack tight"><span>من تاريخ الاستلام</span><input className="input" type="date" value={dateFrom} onChange={event => updateFilters({ dateFrom: event.target.value })} /></label>
                <label className="stack tight"><span>إلى تاريخ الاستلام</span><input className="input" type="date" value={dateTo} onChange={event => updateFilters({ dateTo: event.target.value })} /></label>
                <label className="stack tight"><span>حالة الاستيراد أو المعالجة</span><select className="input" value={status} onChange={event => updateFilters({ status: event.target.value })}><option value="">كل الحالات</option>{Object.entries(STATUS_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
                <label className="stack tight"><span>ترتيب الملفات</span><select className="input" value={sort} onChange={event => updateFilters({ sort: event.target.value })}><option value="newest">الأحدث أولًا</option><option value="oldest">الأقدم أولًا</option><option value="name">الاسم أبجديًا</option></select></label>
              </div>
            </form>
            <div className="stat-strip"><div className="mini-stat"><strong>{fmtNumber(total, 0)}</strong><span>{archived === 'archived' ? 'ملفًا في الأرشيف' : 'مصدرًا وملفًا مسجلًا'}</span></div><div className="mini-stat"><strong>{archived === 'archived' ? 'قابل للاستعادة' : 'تتبع محفوظ'}</strong><span>الجهة والفترة والبصمة حيث تتوفر</span></div></div>
          </>
        )}
      </Card>

      {error && <ErrorBanner message={error} onDismiss={() => setError('')} />}

      {!restricted && <Card flush>
        {selectedTargets.length > 0 && <div className="row between" style={{ padding: 16 }}><span className="muted">المحدد: {fmtNumber(selectedTargets.length, 0)}</span><div className="btn-row">{archived === 'archived' ? <button className="btn small primary" disabled={busy} onClick={() => changeArchive(targetsFor(selectedTargets), 'restore')}><RotateCcw size={14} /> استعادة المحدد</button> : <button className="btn small ghost" disabled={busy} onClick={() => changeArchive(targetsFor(selectedTargets), 'archive')}><Trash2 size={14} /> أرشفة المحدد</button>}</div></div>}
        {loading && !payload ? <div style={{ padding: 20 }}><Loading /></div> : rows.length === 0 ? <Empty icon={Files} title={archived === 'archived' ? 'لا توجد ملفات مؤرشفة' : 'لا توجد مصادر ضمن هذا البحث'} hint={archived === 'archived' ? 'ستظهر الملفات المؤرشفة هنا ويمكن استعادتها.' : 'تُضاف سجلات المصدر عند الاستيراد أو الإدخال اليدوي أو حفظ وثيقة.'} /> : (
          <div className="stack" style={{ padding: 16 }}>
            {rows.map(source => {
              const key = `${source.resource_type}:${source.resource_id}`;
              const canArchive = source.resource_type === 'document' || source.resource_type === 'workbook_import';
              const label = SOURCE_LABELS[source.source_type] ?? source.source_type ?? 'مصدر';
              return <article className="quote stack tight" key={key}>
                <div className="row between" style={{ flexWrap: 'wrap' }}>
                  <div className="row gap-sm">
                    {canArchive && <input type="checkbox" aria-label={`تحديد ${source.file_name ?? source.document_title ?? 'الملف'}`} checked={Boolean(selected[key])} onChange={event => setSelected(current => ({ ...current, [key]: event.target.checked }))} />}
                    <div className="chip-row"><Badge tone="info">{label}</Badge>{source.status && <Badge tone={source.archived ? 'neutral' : source.status === 'failed' ? 'bad' : 'warn'}>{source.archived ? 'مؤرشف' : STATUS_LABELS[source.status] ?? source.status}</Badge>}<strong>{source.document_title || source.file_name || source.organization || `مصدر ${source.id}`}</strong></div>
                  </div>
                  <div className="row gap-sm"><span className="muted">#{source.id} · {fmtDateTime(source.received_at || source.collected_at)}</span>{canArchive && <button className="btn small ghost" disabled={busy} onClick={() => changeArchive([{ resourceType: source.resource_type, resourceId: source.resource_id }], source.archived ? 'restore' : 'archive')}>{source.archived ? <><RotateCcw size={13} /> استعادة</> : <><Archive size={13} /> أرشفة</>}</button>}</div>
                </div>
                <div className="chip-row">
                  {source.organization && <span className="chip">الجهة: {source.organization}</span>}
                  {source.file_name && <span className="chip">الملف: {source.file_name}</span>}
                  {source.reference_period && <span className="chip">الفترة: {source.reference_period}</span>}
                  {source.file_size != null && <span className="chip">الحجم: {fmtNumber(source.file_size, 0)} بايت</span>}
                  {source.sheet_count != null && <span className="chip">الأوراق: {fmtNumber(source.sheet_count, 0)} · الصفوف: {fmtNumber(source.row_count, 0)} · الخلايا: {fmtNumber(source.cell_count, 0)}</span>}
                  {source.media_count != null && <span className="chip">الصور المحفوظة: {fmtNumber(source.media_stored_count, 0)}/{fmtNumber(source.media_count, 0)}</span>}
                  {source.archived_at && <span className="chip">تاريخ الأرشفة: {fmtDateTime(source.archived_at)}</span>}
                </div>
                {source.content_sha256 && <details><summary>بصمة المصدر SHA-256</summary><code className="mono">{source.content_sha256}</code></details>}
                {source.notes && <p className="muted">{source.notes}</p>}
              </article>;
            })}
          </div>
        )}
        {!loading && total > 0 && <div className="row between" style={{ padding: '12px 16px' }}>
          <span className="muted">عرض {fmtNumber(offset + 1, 0)}–{fmtNumber(Math.min(offset + rows.length, total), 0)} من {fmtNumber(total, 0)}</span>
          <div className="btn-row"><button className="btn small ghost" onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))} disabled={loading || offset === 0}>السابق</button><span className="muted">صفحة {page} / {pages}</span><button className="btn small ghost" onClick={() => setOffset(offset + PAGE_SIZE)} disabled={loading || !payload?.hasNext}>التالي</button></div>
        </div>}
      </Card>}
    </>
  );
}
