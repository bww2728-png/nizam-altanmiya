import React, { useCallback, useEffect, useState } from 'react';
import { Files, RefreshCw, Search } from 'lucide-react';
import { Badge, Card, Empty, ErrorBanner, Loading } from '../components/ui.jsx';
import { errText, fmtDateTime, fmtNumber } from '../lib/format.js';

const PAGE_SIZE = 30;
const SOURCE_LABELS = {
  manual_entry: 'إدخال يدوي',
  legacy_import: 'استيراد سابق',
  excel_workbook: 'مصنف Excel',
  workbook_import: 'مصنف Excel',
  'manual-indicator-observation': 'قياس مؤشر يدوي',
  'manual-project': 'مشروع يدوي',
};

export default function DataSources({ refreshKey = 0 }) {
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const [payload, setPayload] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [restricted, setRestricted] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const result = await window.localApp.dataSources({ search, offset, limit: PAGE_SIZE });
      setRestricted(Boolean(result?.restricted));
      if (!result?.restricted) setPayload(result);
    } catch (cause) {
      setError(errText(cause) || 'تعذر تحميل مصادر البيانات.');
    } finally {
      setLoading(false);
    }
  }, [offset, search]);

  useEffect(() => { load(); }, [load, refreshKey]);

  const rows = payload?.rows ?? [];
  const total = payload?.total ?? 0;
  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <>
      <Card title="مصادر البيانات" subtitle="سجل قابل للبحث في الملفات والوثائق والإدخالات التي تستند إليها القيم المعتمدة. المصدر محفوظ كسجل تاريخي ولا يُعدّل من هذه الشاشة." icon={Files}
        actions={<button className="btn small ghost" onClick={load} disabled={loading}><RefreshCw size={14} /> تحديث</button>}>
        {restricted ? <div className="quote"><strong>سجل المصادر متاح في وضع المالك فقط.</strong></div> : (
          <form className="toolbar" onSubmit={event => { event.preventDefault(); setOffset(0); setSearch(searchInput.trim().slice(0,120)); }}>
            <div className="search-box" style={{ flex: 1, minWidth: 220 }}><Search size={16} /><input className="input" value={searchInput} onChange={event => setSearchInput(event.target.value)} placeholder="ابحث بالجهة أو الملف أو الوثيقة أو الفترة" /></div>
            <button className="btn primary" type="submit"><Search size={15} /> بحث</button>
            <button className="btn ghost" type="button" onClick={() => { setSearchInput(''); setSearch(''); setOffset(0); }} disabled={!search && !searchInput}>مسح</button>
          </form>
        )}
        {!restricted && <div className="stat-strip"><div className="mini-stat"><strong>{fmtNumber(total,0)}</strong><span>مصدرًا مسجلًا</span></div><div className="mini-stat"><strong>تتبع محفوظ</strong><span>الجهة والفترة والبصمة حيث تتوفر</span></div></div>}
      </Card>

      {error && <ErrorBanner message={error} onDismiss={() => setError('')} />}

      {!restricted && <Card flush>
        {loading && !payload ? <div style={{ padding: 20 }}><Loading /></div> : rows.length === 0 ? <Empty icon={Files} title="لا توجد مصادر ضمن هذا البحث" hint="تُضاف سجلات المصدر عند الاستيراد أو الإدخال اليدوي أو إنشاء مشروع أو قياس." /> : (
          <div className="stack" style={{ padding: 16 }}>
            {rows.map(source => (
              <article className="quote stack tight" key={source.id}>
                <div className="row between" style={{ flexWrap: 'wrap' }}>
                  <div className="chip-row"><Badge tone="info">{SOURCE_LABELS[source.source_type] ?? source.source_type ?? 'مصدر'}</Badge><strong>{source.document_title || source.file_name || source.organization || `مصدر ${source.id}`}</strong></div>
                  <span className="muted">#{source.id} · {fmtDateTime(source.received_at || source.collected_at)}</span>
                </div>
                <div className="chip-row">
                  {source.organization && <span className="chip">الجهة: {source.organization}</span>}
                  {source.file_name && <span className="chip">الملف: {source.file_name}</span>}
                  {source.reference_period && <span className="chip">الفترة: {source.reference_period}</span>}
                  {source.file_size != null && <span className="chip">الحجم: {fmtNumber(source.file_size,0)} بايت</span>}
                  {source.source_code && <span className="chip">الرمز: {source.source_code}</span>}
                </div>
                {source.content_sha256 && <details><summary>بصمة المصدر SHA-256</summary><code className="mono">{source.content_sha256}</code></details>}
                {source.notes && <p className="muted">{source.notes}</p>}
              </article>
            ))}
          </div>
        )}
        {!loading && total > 0 && <div className="row between" style={{ padding: '12px 16px' }}>
          <span className="muted">عرض {fmtNumber(offset + 1,0)}–{fmtNumber(Math.min(offset + rows.length,total),0)} من {fmtNumber(total,0)}</span>
          <div className="btn-row"><button className="btn small ghost" onClick={() => setOffset(Math.max(0,offset-PAGE_SIZE))} disabled={loading || offset === 0}>السابق</button><span className="muted">صفحة {page} / {pages}</span><button className="btn small ghost" onClick={() => setOffset(offset+PAGE_SIZE)} disabled={loading || !payload?.hasNext}>التالي</button></div>
        </div>}
      </Card>}
    </>
  );
}
