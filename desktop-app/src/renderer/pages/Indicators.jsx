import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, ArrowDown, ArrowUp, FileSpreadsheet, FileText, Search } from 'lucide-react';
import { Badge, Card, Empty, ErrorBanner, Loading, Segmented, SelectInput } from '../components/ui.jsx';
import { errText, fmtNumber, fmtPercent } from '../lib/format.js';
import { INDICATORS_META, NEED_LABEL } from '../lib/indicatorsMeta.mjs';

/**
 * «المؤشرات الـ 12»
 *
 * The registry shows how each indicator is defined (unit, direction, weight,
 * Excel column and the original formula), the stats table shows coverage and
 * range, and the matrix shows every directorate against every indicator with a
 * magnitude heat so an outlier is visible without reading 12 columns of digits.
 */

const VIEWS = [
  { value: 'values', label: 'القيم' },
  { value: 'scores', label: 'الدرجات 0-100' },
  { value: 'contributions', label: 'المساهمة في المركّب' },
];

export default function Indicators({ notify }) {
  const [payload, setPayload] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [view, setView] = useState('values');
  const [search, setSearch] = useState('');
  const [governorate, setGovernorate] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setPayload(await window.localApp.sheetIndicators());
    } catch (cause) {
      setError(errText(cause) || 'تعذر تحميل المؤشرات.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const registry = payload?.registry ?? INDICATORS_META;
  const rows = payload?.rows ?? [];
  const stats = payload?.stats ?? {};

  const governorates = useMemo(() => {
    const names = [...new Set(rows.map((row) => row.governorate).filter(Boolean))].sort();
    return [{ value: '', label: 'كل المحافظات' }, ...names.map((name) => ({ value: name, label: name }))];
  }, [rows]);

  const filtered = useMemo(() => rows.filter((row) => {
    if (governorate && row.governorate !== governorate) return false;
    if (search && !`${row.districtName} ${row.governorate}`.includes(search.trim())) return false;
    return true;
  }), [rows, governorate, search]);

  async function exportExcel() {
    try {
      const result = await window.localApp.exportAnalysisExcel();
      if (!result?.canceled) notify?.({ tone: 'ok', message: `صُدّر ملف Excel إلى ${result.filePath}` });
    } catch (cause) {
      notify?.({ tone: 'bad', message: errText(cause) || 'تعذر التصدير.' });
    }
  }

  async function exportPdf() {
    try {
      const result = await window.localApp.exportFilteredPdf({
        type: 'indicators',
        filters: { search: search.trim(), governorate },
        view,
      });
      if (!result?.canceled) notify?.({ tone: 'ok', message: `صُدّر تقرير المؤشرات إلى ${result.filePath}` });
    } catch (cause) {
      notify?.({ tone: 'bad', message: errText(cause) || 'تعذر تصدير تقرير المؤشرات.' });
    }
  }

  if (loading && !payload) return <Card title="المؤشرات الـ 12"><Loading label="جارٍ حساب المؤشرات..." /></Card>;

  return (
    <>
      {error && <ErrorBanner message={error} onDismiss={() => setError('')} />}

      <Card
        title="المؤشرات الـ 12"
        subtitle="مؤشرات محسوبة داخل النظام من أعمدة الإدخال A..AM؛ الأعمدة المحسوبة في ملف Excel تُتجاهل عند الاستيراد."
        icon={Activity}
        actions={(
          <div className="btn-row">
            <button className="btn small" onClick={exportExcel}><FileSpreadsheet size={15} /> تصدير Excel</button>
            <button className="btn small" onClick={exportPdf}><FileText size={15} /> تقرير PDF</button>
            <span className="chip gold">{rows.length} مديرية</span>
          </div>
        )}
      >
        <div className="grid-2">
          {registry.map((indicator, index) => {
            const stat = stats[indicator.code] ?? {};
            return (
              <div
                key={indicator.code}
                className="lift"
                style={{
                  padding: '13px 15px',
                  border: '1px solid var(--line)',
                  borderRadius: 12,
                  background: 'rgba(140,168,208,.045)',
                  animation: `rise .4s var(--ease-out) ${index * 35}ms both`,
                }}
              >
                <div className="row between" style={{ marginBottom: 6 }}>
                  <strong style={{ fontSize: '0.9rem' }}>{indicator.header}</strong>
                  <span className="chip mono">{indicator.excel}</span>
                </div>
                <div className="chip-row">
                  <Badge tone={indicator.direction === 'needUp' ? 'warn' : 'info'}>
                    {indicator.direction === 'needUp' ? <ArrowUp size={12} /> : <ArrowDown size={12} />}
                    {NEED_LABEL[indicator.direction]}
                  </Badge>
                  <span className="chip">الوحدة: {indicator.unit || '—'}</span>
                  {indicator.weight !== undefined && <span className="chip">الوزن: {fmtNumber(indicator.weight, 2)}</span>}
                  <span className="chip">تغطية: {stat.count ?? 0}/{rows.length}</span>
                </div>
                {indicator.formula && (
                  <div className="mono dim" style={{ fontSize: '0.7rem', marginTop: 8, overflowX: 'auto', whiteSpace: 'nowrap' }}>
                    {indicator.formula}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </Card>

      <Card title="إحصاءات المؤشرات" subtitle="المدى والتغطية لكل مؤشر على البيانات المخزّنة.">
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>المؤشر</th>
                <th className="num">محسوب</th>
                <th className="num">ناقص</th>
                <th className="num">الأدنى</th>
                <th className="num">الأعلى</th>
                <th className="num">المتوسط</th>
                <th>التغطية</th>
              </tr>
            </thead>
            <tbody>
              {registry.map((indicator) => {
                const stat = stats[indicator.code] ?? {};
                const coverage = rows.length ? (stat.count ?? 0) / rows.length : 0;
                return (
                  <tr key={indicator.code}>
                    <td className="strong">{indicator.header}</td>
                    <td className="num">{fmtNumber(stat.count, 0)}</td>
                    <td className="num">{fmtNumber(stat.missing, 0)}</td>
                    <td className="num">{formatStat(stat.min, indicator.unit)}</td>
                    <td className="num">{formatStat(stat.max, indicator.unit)}</td>
                    <td className="num">{formatStat(stat.average, indicator.unit)}</td>
                    <td style={{ width: 160 }}>
                      <div className="completeness">
                        <div className="bar"><div className="bar-fill" style={{ width: `${coverage * 100}%` }} /></div>
                        <small>{fmtPercent(coverage * 100, 0)}</small>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <Card
        title="مصفوفة المؤشرات"
        subtitle="كل صف مديرية وكل عمود مؤشر؛ لون الخلية يعبّر عن مقدار القيمة داخل مدى المؤشر."
        actions={(
          <div className="row">
            <Segmented value={view} onChange={setView} options={VIEWS} />
            <div style={{ minWidth: 170 }}>
              <SelectInput value={governorate} onChange={setGovernorate} options={governorates} />
            </div>
            <div className="search-box" style={{ minWidth: 200 }}>
              <Search size={15} />
              <input className="input" placeholder="بحث..." value={search} onChange={(event) => setSearch(event.target.value)} />
            </div>
          </div>
        )}
      >
        {filtered.length === 0 ? <Empty icon={Activity} title="لا صفوف" hint="لا توجد مديريات مطابقة." /> : (
          <div className="table-wrap" style={{ maxHeight: 620 }}>
            <table className="data">
              <thead>
                <tr>
                  <th className="sticky-col">المديرية</th>
                  {registry.map((indicator) => <th key={indicator.code} title={indicator.header} className="nowrap">{indicator.header}</th>)}
                </tr>
              </thead>
              <tbody>
                {filtered.map((row, index) => (
                  <tr key={`${row.directorateId}-${index}`}>
                    <td className="sticky-col strong nowrap">
                      {row.districtName}
                      <div className="dim" style={{ fontSize: '0.7rem' }}>{row.governorate}</div>
                    </td>
                    {registry.map((indicator) => {
                      const value = pickValue(row, indicator.code, view);
                      return (
                        <td key={indicator.code} style={{ padding: 6 }}>
                          <div
                            className="heat"
                            style={{ background: heat(value, stats[indicator.code]), color: value === null || value === undefined ? 'var(--text-4)' : 'var(--text)' }}
                            title={`${indicator.header}: ${value ?? '—'}`}
                          >
                            {value === null || value === undefined ? '—' : formatCell(value, view, indicator.unit)}
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="row between" style={{ marginTop: 12 }}>
          <div className="legend">
            <span>أدنى</span>
            <span className="swatch" style={{ background: 'linear-gradient(90deg, rgba(98,168,232,.35), rgba(216,180,95,.75))' }} />
            <span>أعلى</span>
          </div>
          <span className="muted" style={{ fontSize: '0.76rem' }}>
            {view === 'scores' ? 'الدرجة 0-100 بعد المعايرة (100 = أسوأ احتياج)' : view === 'contributions' ? 'مساهمة المؤشر في المؤشر المركّب' : 'القيمة الأصلية بوحدة المؤشر'}
          </span>
        </div>
      </Card>
    </>
  );
}

function pickValue(row, code, view) {
  if (view === 'scores') {
    const score = row.scores?.[code];
    return Number.isFinite(score) ? score : null;
  }
  if (view === 'contributions') {
    const contribution = row.contributions?.[code];
    const value = contribution && typeof contribution === 'object' ? contribution.contribution : contribution;
    return Number.isFinite(value) ? value : null;
  }
  const value = row.values?.[code];
  return Number.isFinite(value) ? value : null;
}

function formatCell(value, view, unit) {
  if (view === 'values') {
    if (unit === '%') return fmtNumber(value, 1);
    if (Math.abs(value) >= 1000) return fmtNumber(value, 0);
    return fmtNumber(value, 2);
  }
  return fmtNumber(value, view === 'contributions' ? 2 : 0);
}

function formatStat(value, unit) {
  if (value === null || value === undefined) return '—';
  return unit === '%' ? fmtNumber(value, 1) : fmtNumber(value, 2);
}

/** Blue at the bottom of the range, gold at the top; neutral when unknown. */
function heat(value, stat) {
  if (value === null || value === undefined || !stat || stat.min === null || stat.max === null) {
    return 'rgba(140,168,208,.05)';
  }
  const span = Math.max(1e-9, Math.abs(stat.max - stat.min));
  const ratio = Math.min(1, Math.max(0, (value - stat.min) / span));
  const hue = 205 - 163 * ratio;
  return `hsla(${hue}, 62%, 46%, ${0.14 + 0.3 * ratio})`;
}