import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Columns3, DatabaseZap, FileText, Search } from 'lucide-react';
import { Card, Empty, ErrorBanner, Loading } from '../components/ui.jsx';
import { errText, fmtNumber } from '../lib/format.js';

const PAGE_SIZE = 100;
const PREFERENCE_KEY = 'ldi-database-visible-columns-v1';

function readColumnPreference() {
  try {
    const stored = window.localStorage.getItem(PREFERENCE_KEY);
    return stored ? JSON.parse(stored) : null;
  } catch {
    return null;
  }
}

export default function UnifiedDatabase({ accessProfile, notify, refreshKey }) {
  const api = typeof window === 'undefined' ? null : window.localApp?.databaseBrowser;
  const [directorates, setDirectorates] = useState([]);
  const [periods, setPeriods] = useState([]);
  const [geoUnitId, setGeoUnitId] = useState('');
  const [periodId, setPeriodId] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [result, setResult] = useState(null);
  const [visibleKeys, setVisibleKeys] = useState(readColumnPreference);
  const [columnSearch, setColumnSearch] = useState('');
  const [showColumns, setShowColumns] = useState(false);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (accessProfile !== 'owner') return;
    Promise.all([window.localApp.dataGeography(''), window.localApp.dataPeriods()])
      .then(([geography, periodList]) => {
        setDirectorates((geography.rows ?? []).filter(unit => unit.type_code === 'directorate' && Number(unit.is_active) === 1));
        setPeriods(periodList.rows ?? []);
      })
      .catch(cause => setError(errText(cause) || 'تعذر تحميل المديريات والفترات.'));
  }, [accessProfile]);

  const load = useCallback(async () => {
    if (!api || accessProfile !== 'owner' || !geoUnitId) {
      setResult(null);
      return;
    }
    setLoading(true);
    try {
      const request = { geoUnitId: Number(geoUnitId), periodId: periodId ? Number(periodId) : undefined, search, limit: PAGE_SIZE, offset };
      if (Array.isArray(visibleKeys)) request.columns = visibleKeys;
      const next = await api.directorateTable(request);
      setResult(next);
      if (visibleKeys === null) setVisibleKeys(next.allColumns.map(column => column.key));
      setError('');
    } catch (cause) {
      setResult(null);
      setError(errText(cause) || 'تعذر تحميل الجدول الشامل.');
    } finally {
      setLoading(false);
    }
  }, [api, accessProfile, geoUnitId, periodId, search, offset, visibleKeys]);

  useEffect(() => { load(); }, [load, refreshKey]);

  useEffect(() => {
    if (!Array.isArray(visibleKeys)) return;
    try { window.localStorage.setItem(PREFERENCE_KEY, JSON.stringify(visibleKeys)); } catch { return; }
  }, [visibleKeys]);

  const allColumns = result?.allColumns ?? [];
  const shownColumns = useMemo(() => {
    if (!Array.isArray(visibleKeys)) return allColumns;
    const selected = new Set(visibleKeys);
    return allColumns.filter(column => selected.has(column.key));
  }, [allColumns, visibleKeys]);
  const groups = useMemo(() => {
    const normalized = columnSearch.trim().toLocaleLowerCase('ar');
    const filtered = allColumns.filter(column => !normalized || `${column.hierarchyLabel} ${column.fieldCode}`.toLocaleLowerCase('ar').includes(normalized));
    const grouped = new Map();
    for (const column of filtered) {
      const key = column.groupCode ?? 'record-metadata';
      const group = grouped.get(key) ?? { key, domainName: column.domainName ?? 'بيانات السجل', groupName: column.groupName ?? 'بيانات السجل', columns: [] };
      group.columns.push(column);
      grouped.set(key, group);
    }
    return [...grouped.values()];
  }, [allColumns, columnSearch]);

  function toggleColumn(key) {
    setVisibleKeys(current => {
      const selected = new Set(Array.isArray(current) ? current : allColumns.map(column => column.key));
      if (selected.has(key)) selected.delete(key); else selected.add(key);
      return [...selected];
    });
  }

  function setAllColumns(visible) {
    setVisibleKeys(visible ? allColumns.map(column => column.key) : []);
  }

  async function exportPdf() {
    if (!geoUnitId || !api || !shownColumns.length) return;
    setExporting(true);
    try {
      const response = await api.export({ format: 'pdf', section: 'directorate-table', geoUnitId: Number(geoUnitId),
        periodId: periodId ? Number(periodId) : undefined, search, columns: shownColumns.map(column => column.key) });
      if (!response?.canceled) notify?.({ tone: 'success', message: `أُعد تقرير PDF من ${fmtNumber(response.rowCount ?? 0, 0)} سجل.` });
    } catch (cause) {
      notify?.({ tone: 'error', message: errText(cause) || 'تعذر إنشاء تقرير PDF.' });
    } finally {
      setExporting(false);
    }
  }

  const pageCount = Math.max(1, Math.ceil(Number(result?.total ?? 0) / PAGE_SIZE));
  const selectedDirectorate = directorates.find(unit => String(unit.geo_unit_id) === String(geoUnitId));

  if (accessProfile !== 'owner') return <Card title="قاعدة البيانات الشاملة" icon={DatabaseZap}><p className="field-hint">استعراض هذا الجدول متاح في وضع المالك فقط.</p></Card>;

  return (
    <div className="stack">
      <Card title="قاعدة البيانات الشاملة" subtitle="جدول موحد حسب المديرية؛ يعرض السجلات المعتمدة من الإدخال اليدوي والمصادر المرتبطة." icon={DatabaseZap}>
        <div className="toolbar" style={{ alignItems: 'end' }}>
          <label className="stack tight" style={{ minWidth: 240 }}><span>المديرية *</span><select className="input" value={geoUnitId} onChange={event => { setGeoUnitId(event.target.value); setOffset(0); }}>
            <option value="">اختر المديرية</option>
            {directorates.map(unit => <option key={unit.geo_unit_id} value={unit.geo_unit_id}>{unit.name_ar}{unit.parent_name_ar ? ` — ${unit.parent_name_ar}` : ''}</option>)}
          </select></label>
          <label className="stack tight" style={{ minWidth: 190 }}><span>الفترة (اختياري)</span><select className="input" value={periodId} onChange={event => { setPeriodId(event.target.value); setOffset(0); }}>
            <option value="">كل الفترات</option>{periods.map(period => <option key={period.period_id} value={period.period_id}>{period.label_ar}</option>)}
          </select></label>
          <form className="toolbar" onSubmit={event => { event.preventDefault(); setSearch(searchInput.trim()); setOffset(0); }}>
            <label className="stack tight"><span>البحث في الحقول والقيم</span><input className="input" value={searchInput} onChange={event => setSearchInput(event.target.value)} placeholder="ابحث عن اسم حقل أو قيمة" /></label>
            <button type="submit" className="btn small"><Search size={15} /> بحث</button>
          </form>
        </div>
        <div className="row between" style={{ marginTop: 14, flexWrap: 'wrap' }}>
          <div className="chip-row"><span className="chip">{fmtNumber(allColumns.length, 0)} عموداً متاحاً</span><span className="chip">{fmtNumber(shownColumns.length, 0)} ظاهراً</span>
            {selectedDirectorate && <span className="chip">{selectedDirectorate.name_ar}</span>}
            <span className="chip">{fmtNumber(result?.total ?? 0, 0)} سجل معتمد</span></div>
          <div className="btn-row">
            <button type="button" className={`btn small${showColumns ? ' primary' : ''}`} onClick={() => setShowColumns(value => !value)} disabled={!allColumns.length}><Columns3 size={15} /> اختيار الأعمدة</button>
            <button type="button" className="btn small primary" onClick={exportPdf} disabled={!geoUnitId || !shownColumns.length || exporting || loading}><FileText size={15} /> {exporting ? 'جارٍ إعداد التقرير…' : 'تقرير PDF'}</button>
          </div>
        </div>
      </Card>

      {error && <ErrorBanner message={error} onDismiss={() => setError('')} />}
      {showColumns && <Card title="الأعمدة الظاهرة" subtitle="ابحث باسم المجال أو المجموعة أو الحقل، ثم اختر ما تريد إظهاره." flush>
        <div className="toolbar" style={{ padding: 12 }}>
          <input className="input" value={columnSearch} onChange={event => setColumnSearch(event.target.value)} placeholder="ابحث عن اسم العمود…" aria-label="بحث أسماء الأعمدة" />
          <button type="button" className="btn small ghost" onClick={() => setAllColumns(true)}>إظهار الكل</button>
          <button type="button" className="btn small ghost" onClick={() => setAllColumns(false)}>إخفاء الكل</button>
        </div>
        <div className="database-domain-list" style={{ maxHeight: '45vh', overflow: 'auto', padding: '0 12px 12px' }}>
          {groups.map(group => <section key={group.key} style={{ marginBottom: 12 }}>
            <h3 style={{ margin: '8px 0', fontSize: '0.9rem' }}>{group.domainName} › {group.groupName}</h3>
            <div className="grid-2">{group.columns.map(column => <label key={column.key} className="row" style={{ alignItems: 'start', gap: 8 }}>
              <input type="checkbox" checked={visibleKeys === null || visibleKeys.includes(column.key)} onChange={() => toggleColumn(column.key)} />
              <span>{column.fieldName}<small className="muted" style={{ display: 'block' }}>{column.fieldCode}{column.unit ? ` · ${column.unit}` : ''}</small></span>
            </label>)}</div>
          </section>)}
          {!groups.length && <p className="field-hint">لا توجد أعمدة تطابق البحث.</p>}
        </div>
      </Card>}

      {!geoUnitId ? <Empty icon={DatabaseZap} title="اختر مديرية للبدء" hint="ستظهر هنا بياناتها المعتمدة فقط، مع أعمدة المجالات والمجموعات والحقول المتاحة." /> : (
        <Card title="الجدول الشامل" subtitle={`${selectedDirectorate?.name_ar ?? ''}${periodId ? ' · حسب الفترة المحددة' : ' · جميع الفترات'}`} flush>
          {loading && !result ? <div style={{ padding: 20 }}><Loading label="جارٍ تحميل البيانات المعتمدة…" /></div> : result?.rows?.length && shownColumns.length ? (
            <div className="table-wrap unified-database-table"><table className="data"><thead><tr>{shownColumns.map(column => <th key={column.key} title={column.hierarchyLabel}>{column.hierarchyLabel}</th>)}</tr></thead>
              <tbody>{result.rows.map((row, index) => <tr key={row._rowKey ?? index}>{shownColumns.map(column => <td key={column.key}>{displayValue(row[column.key])}</td>)}</tr>)}</tbody>
            </table></div>
          ) : result?.rows?.length ? <Empty icon={Columns3} title="أخفَيت كل الأعمدة" hint="افتح اختيار الأعمدة وأظهر الحقول التي تريدها." />
            : <Empty icon={DatabaseZap} title={loading ? 'جارٍ تحديث الجدول…' : 'لا توجد بيانات معتمدة مطابقة'} hint="قد تكون المجموعة فارغة، أو ما تزال سجلاتها بانتظار المراجعة والاعتماد." />}
          {result && <div className="report-pagination"><span>عرض {result.total ? offset + 1 : 0}–{Math.min(offset + PAGE_SIZE, result.total)} من {fmtNumber(result.total, 0)}</span>
            <div className="btn-row"><button className="btn small" disabled={!offset || loading} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}><ChevronRight size={15} /> السابق</button>
              <span className="chip">صفحة {fmtNumber(Math.floor(offset / PAGE_SIZE) + 1, 0)} / {fmtNumber(pageCount, 0)}</span>
              <button className="btn small" disabled={offset + PAGE_SIZE >= result.total || loading} onClick={() => setOffset(offset + PAGE_SIZE)}>التالي <ChevronLeft size={15} /></button></div>
          </div>}
        </Card>
      )}
    </div>
  );
}

function displayValue(value) {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'object') return '[بيانات وصفية]';
  return String(value);
}
