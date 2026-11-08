import React, { useCallback, useEffect, useState } from 'react';
import { ClipboardCheck, RefreshCw } from 'lucide-react';
import { Badge, Card, Empty, ErrorBanner, Loading, Segmented } from '../components/ui.jsx';
import { errText, fmtDateTime, fmtNumber } from '../lib/format.js';

const PAGE_SIZE = 50;
const STATUS_OPTIONS = [
  { value: 'open', label: 'مفتوحة' },
  { value: 'resolved', label: 'مسوّاة' },
  { value: 'all', label: 'الكل' },
];

export default function DataQuality({ notify }) {
  const [status, setStatus] = useState('open');
  const [offset, setOffset] = useState(0);
  const [payload, setPayload] = useState(null);
  const [resolutions, setResolutions] = useState({});
  const [busyId, setBusyId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [restricted, setRestricted] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const result = await window.localApp.dataQualityIssues({ status, offset, limit: PAGE_SIZE });
      setRestricted(Boolean(result?.restricted));
      if (!result?.restricted) setPayload(result);
    } catch (cause) {
      setError(errText(cause) || 'تعذر تحميل سجل جودة البيانات.');
    } finally {
      setLoading(false);
    }
  }, [offset, status]);

  useEffect(() => { load(); }, [load]);

  const resolve = async issueId => {
    const resolution = String(resolutions[issueId] ?? '').trim();
    if (!resolution) return;
    setBusyId(issueId);
    setError('');
    try {
      await window.localApp.resolveDataQualityIssue({ issueId, resolution });
      setResolutions(current => ({ ...current, [issueId]: '' }));
      await load();
      notify?.({ tone: 'ok', message: 'تمت تسوية الملاحظة وحفظ سبب القرار في سجل التدقيق.' });
    } catch (cause) {
      setError(errText(cause) || 'تعذرت تسوية الملاحظة.');
    } finally {
      setBusyId(null);
    }
  };

  const rows = payload?.rows ?? [];
  const total = payload?.total ?? 0;
  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <>
      <Card title="جودة البيانات" subtitle="قضايا الاستيراد والكيانات مع مصدرها وحالتها. التسوية تتطلب سببًا وتبقى محفوظة للتدقيق؛ لا تحذف السجل الأصلي أو مصدره." icon={ClipboardCheck}
        actions={<div className="btn-row"><Segmented value={status} onChange={value => { setStatus(value); setOffset(0); }} options={STATUS_OPTIONS} /><button className="btn small ghost" onClick={load} disabled={loading}><RefreshCw size={14} /> تحديث</button></div>}>
        {restricted && <div className="quote"><strong>سجل الجودة متاح في وضع المالك فقط.</strong></div>}
        {!restricted && <div className="stat-strip"><div className="mini-stat"><strong>{fmtNumber(total, 0)}</strong><span>{status === 'open' ? 'ملاحظة مفتوحة' : status === 'resolved' ? 'ملاحظة مسوّاة' : 'ملاحظة'}</span></div><div className="mini-stat"><strong>تسوية موثقة</strong><span>سبب القرار وتاريخه محفوظان</span></div></div>}
      </Card>

      {error && <ErrorBanner message={error} onDismiss={() => setError('')} />}

      {!restricted && <Card flush>
        {loading && !payload ? <div style={{ padding: 20 }}><Loading /></div> : rows.length === 0 ? <Empty icon={ClipboardCheck} title="لا توجد ملاحظات ضمن هذا المرشح" hint="قضايا البيانات الجديدة ستظهر هنا بعد تحليل السجلات أو استيرادها." /> : (
          <>
            <div className="stack" style={{ padding: 16 }}>
              {rows.map(issue => (
                <article className="quote stack tight" key={issue.id}>
                  <div className="row between" style={{ flexWrap: 'wrap' }}>
                    <div className="chip-row"><Badge tone={issue.severity === 'error' || issue.severity === 'blocker' ? 'bad' : 'warn'}>{issue.issue_code}</Badge><Badge tone={issue.status === 'open' ? 'warn' : 'ok'}>{issue.status === 'open' ? 'مفتوحة' : 'مسوّاة'}</Badge>{issue.field_label && <span className="chip">{issue.field_label}</span>}</div>
                    <span className="muted">#{issue.id} · {fmtDateTime(issue.created_at)}</span>
                  </div>
                  <p>{issue.message}</p>
                  <div className="chip-row">
                    {issue.file_name && <span className="chip">الملف: {issue.file_name}</span>}
                    {issue.sheet_name && <span className="chip">الورقة: {issue.sheet_name}</span>}
                    {issue.row_number && <span className="chip">الصف: {fmtNumber(issue.row_number, 0)}</span>}
                    {issue.project_name && <span className="chip">المشروع: {issue.project_name}</span>}
                    {issue.promoted_entity_type && <span className="chip">الكيان: {issue.promoted_entity_type} #{issue.target_id}</span>}
                    {issue.record_id && <span className="chip">السجل #{issue.record_id}</span>}
                  </div>
                  {issue.status === 'open' ? (
                    <div className="grid-2" style={{ alignItems: 'end' }}>
                      <label className="stack tight"><span>سبب التسوية *</span><textarea className="input" rows={2} maxLength={1000} value={resolutions[issue.id] ?? ''} onChange={event => setResolutions(current => ({ ...current, [issue.id]: event.target.value }))} placeholder="اشرح ما تمت مراجعته أو الإجراء المتخذ" /></label>
                      <div className="row"><button className="btn small primary" onClick={() => resolve(issue.id)} disabled={busyId === issue.id || !(resolutions[issue.id] ?? '').trim()}>{busyId === issue.id ? 'جارٍ الحفظ...' : 'تسوية مع حفظ السبب'}</button></div>
                    </div>
                  ) : <div className="muted">سبب التسوية: {issue.resolution || 'غير مسجل'} · {fmtDateTime(issue.resolved_at)}</div>}
                </article>
              ))}
            </div>
            <div className="row between" style={{ padding: '12px 16px' }}><span className="muted">عرض {fmtNumber(offset + 1, 0)}–{fmtNumber(Math.min(offset + rows.length, total), 0)} من {fmtNumber(total, 0)}</span><div className="btn-row"><button className="btn small ghost" onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))} disabled={loading || offset === 0}>السابق</button><span className="muted">صفحة {page} / {pages}</span><button className="btn small ghost" onClick={() => setOffset(offset + PAGE_SIZE)} disabled={loading || offset + rows.length >= total}>التالي</button></div></div>
          </>
        )}
      </Card>}
    </>
  );
}
