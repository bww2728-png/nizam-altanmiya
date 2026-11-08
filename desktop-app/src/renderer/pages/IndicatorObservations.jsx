import React, { useCallback, useEffect, useState } from 'react';
import { Activity, Plus, RefreshCw, Search } from 'lucide-react';
import { Badge, Card, Empty, ErrorBanner, Loading, Modal } from '../components/ui.jsx';
import { errText, fmtDateTime, fmtNumber } from '../lib/format.js';

const PAGE_SIZE = 30;

export default function IndicatorObservations({ notify }) {
  const [references, setReferences] = useState({ geographicUnits: [], indicators: [] });
  const [payload, setPayload] = useState(null);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [form, setForm] = useState(emptyForm());
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [restricted, setRestricted] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const result = await window.localApp.indicatorObservations({ search, offset, limit: PAGE_SIZE });
      setRestricted(Boolean(result?.restricted));
      if (!result?.restricted) setPayload(result);
    } catch (cause) {
      setError(errText(cause) || 'تعذر تحميل قياسات المؤشرات.');
    } finally {
      setLoading(false);
    }
  }, [offset, search]);

  useEffect(() => {
    window.localApp.canonicalProjectReferences()
      .then(result => setReferences({ geographicUnits: result?.geographicUnits ?? [], indicators: result?.indicators ?? [] }))
      .catch(cause => setError(errText(cause) || 'تعذر تحميل مراجع المؤشرات.'));
  }, []);

  useEffect(() => { load(); }, [load]);

  const openNew = () => {
    setForm(emptyForm());
    setError('');
    setEditing(true);
  };

  const openEdit = row => {
    setForm({ id: row.id, indicator_id: String(row.indicator_id), geographic_unit_id: String(row.geographic_unit_id), period_key: row.period_key, value_number: String(row.value_number ?? '') });
    setError('');
    setEditing(true);
  };

  const save = async event => {
    event.preventDefault();
    setSaving(true);
    setError('');
    try {
      const result = await window.localApp.saveIndicatorObservation(form);
      setEditing(false);
      notify?.({ tone: 'ok', message: result.action === 'created' ? 'تم حفظ القياس مع مصدر الإدخال.' : 'تم تحديث القياس مع حفظ النسخة السابقة.' });
      await load();
    } catch (cause) {
      setError(errText(cause) || 'تعذر حفظ قياس المؤشر.');
    } finally {
      setSaving(false);
    }
  };

  const rows = payload?.rows ?? [];
  const districts = references.geographicUnits.filter(unit => unit.unit_type === 'district');
  const governorates = new Map(references.geographicUnits.filter(unit => unit.unit_type === 'governorate').map(unit => [unit.id, unit.name]));
  const total = payload?.total ?? 0;
  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <>
      <Card title="سجل قياسات المؤشرات" subtitle="قياسات معيارية مؤرخة ومصدرها محفوظ. هذا السجل منفصل عن مؤشرات التحليل الحالية ولا يغيّر الأوزان أو الترتيب تلقائيًا." icon={Activity}
        actions={<button className="btn small primary" onClick={openNew} disabled={restricted}><Plus size={14} /> قياس جديد</button>}>
        {restricted ? <div className="quote"><strong>السجل متاح في وضع المالك فقط.</strong></div> : (
          <form className="toolbar" onSubmit={event => { event.preventDefault(); setOffset(0); setSearch(searchInput.trim().slice(0, 120)); }}>
            <div className="search-box" style={{ flex: 1, minWidth: 220 }}><Search size={16} /><input className="input" value={searchInput} onChange={event => setSearchInput(event.target.value)} placeholder="بحث بالمؤشر أو المديرية أو المحافظة أو الفترة" /></div>
            <button className="btn primary" type="submit"><Search size={15} /> بحث</button>
            <button className="btn ghost" type="button" onClick={() => { setSearchInput(''); setSearch(''); setOffset(0); }} disabled={!searchInput && !search}>مسح</button>
            <button className="btn ghost" type="button" onClick={load} disabled={loading}><RefreshCw size={14} /> تحديث</button>
          </form>
        )}
      </Card>

      {error && <ErrorBanner message={error} onDismiss={() => setError('')} />}

      {!restricted && <Card flush>
        {loading && !payload ? <div style={{ padding: 20 }}><Loading /></div> : rows.length === 0 ? <Empty icon={Activity} title="لا توجد قياسات محفوظة" hint="يمكن استيراد قياسات من ملف Excel بعد مراجعة الربط، أو إدخالها يدويًا." /> : (
          <>
            <div className="table-wrap" style={{ maxHeight: '68vh' }}>
              <table className="data">
                <thead><tr><th>المؤشر</th><th>المديرية</th><th>المحافظة</th><th>الفترة</th><th>القيمة</th><th>المصدر</th><th>النسخ</th><th /></tr></thead>
                <tbody>{rows.map(row => (
                  <tr key={row.id}>
                    <td><div className="stack tight"><strong>{row.indicator_label}</strong><span className="muted">{row.unit || 'بلا وحدة'}</span></div></td>
                    <td>{row.district}</td><td>{row.governorate || '—'}</td>
                    <td>{row.period_key}</td>
                    <td className="num">{row.value_state === 'known' ? fmtNumber(row.value_number, 2) : row.value_state}</td>
                    <td><div className="stack tight"><span>{row.source_file || row.source_title || (row.source_type === 'manual-indicator-observation' ? 'إدخال يدوي' : 'مصدر غير محدد')}</span>{row.source_location && <span className="muted">{row.source_location}</span>}</div></td>
                    <td className="num">{fmtNumber(row.version_count, 0)}</td>
                    <td><button className="btn small ghost" onClick={() => openEdit(row)}>تحرير</button></td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
            <div className="row between" style={{ padding: '12px 16px' }}>
              <span className="muted">عرض {fmtNumber(offset + 1, 0)}–{fmtNumber(Math.min(offset + rows.length, total), 0)} من {fmtNumber(total, 0)}</span>
              <div className="btn-row"><button className="btn small ghost" onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))} disabled={loading || offset === 0}>السابق</button><span className="muted">صفحة {page} / {pages}</span><button className="btn small ghost" onClick={() => setOffset(offset + PAGE_SIZE)} disabled={loading || offset + rows.length >= total}>التالي</button></div>
            </div>
          </>
        )}
      </Card>}

      <Modal open={editing} title={form.id ? 'تحرير قياس مؤشر' : 'إضافة قياس مؤشر'} subtitle="يتطلب كل قياس مؤشرًا ومديرية وفترة وقيمة؛ لا تُستبدل القياسات المكررة بصمت." onClose={() => { if (!saving) setEditing(false); }}
        footer={<div className="btn-row"><button className="btn ghost" type="button" onClick={() => setEditing(false)} disabled={saving}>إلغاء</button><button className="btn primary" type="submit" form="indicator-observation-form" disabled={saving}>{saving ? 'جارٍ الحفظ...' : 'حفظ القياس'}</button></div>}>
        <form id="indicator-observation-form" className="stack" onSubmit={save}>
          {error && <ErrorBanner message={error} onDismiss={() => setError('')} />}
          <label className="stack tight"><span>المؤشر *</span><select className="input" required value={form.indicator_id} onChange={event => setForm(current => ({ ...current, indicator_id: event.target.value }))}><option value="">اختر مؤشرًا</option>{references.indicators.map(item => <option key={item.id} value={item.id}>{item.label_ar} · {item.unit || 'بلا وحدة'}</option>)}</select></label>
          <label className="stack tight"><span>المديرية *</span><select className="input" required value={form.geographic_unit_id} onChange={event => setForm(current => ({ ...current, geographic_unit_id: event.target.value }))}><option value="">اختر مديرية</option>{districts.map(unit => <option key={unit.id} value={unit.id}>{unit.name}{governorates.get(unit.parent_id) ? ' · ' + governorates.get(unit.parent_id) : ''}</option>)}</select></label>
          <div className="grid-2"><label className="stack tight"><span>الفترة المرجعية *</span><input className="input" required maxLength={80} value={form.period_key} placeholder="مثال: 2025 أو 2025-Q1" onChange={event => setForm(current => ({ ...current, period_key: event.target.value }))} /></label><label className="stack tight"><span>القيمة *</span><input className="input" required type="number" min="0" step="any" value={form.value_number} onChange={event => setForm(current => ({ ...current, value_number: event.target.value }))} /></label></div>
          <p className="muted" style={{ fontSize: '0.8rem' }}>يُحفظ تعديل القياس كمصدر جديد وتُسجل القيمة السابقة في سجل النسخ. يلزم تعديل وحدة المؤشر من تعريفه المعتمد، ولا تُحوّل الوحدات تلقائيًا.</p>
        </form>
      </Modal>
    </>
  );
}

function emptyForm() {
  return { indicator_id: '', geographic_unit_id: '', period_key: '', value_number: '' };
}
