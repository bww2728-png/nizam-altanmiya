import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, ArrowDown, ArrowUp, FileSpreadsheet, FileText } from 'lucide-react';
import { Badge, Card, Empty, ErrorBanner, Loading, Segmented } from '../components/ui.jsx';
import IndicatorReportFilters from '../components/IndicatorReportFilters.jsx';
import { errText, fmtNumber, fmtPercent } from '../lib/format.js';
import { INDICATORS_META, NEED_LABEL } from '../lib/indicatorsMeta.mjs';

const VIEWS = [
  { value: 'values', label: 'القيم' },
  { value: 'scores', label: 'الدرجات 0-100' },
  { value: 'contributions', label: 'المساهمة في المركّب' },
];
const INITIAL_FILTERS = { criteria: [], logic: 'and', mode: 'calibrated', view: 'values', sort: 'rank', direction: 'desc' };

export default function Indicators({ accessProfile, notify, refreshKey }) {
  const [payload, setPayload] = useState(null);
  const [filters, setFilters] = useState(INITIAL_FILTERS);
  const [applied, setApplied] = useState(INITIAL_FILTERS);
  const [selectedCodes, setSelectedCodes] = useState([]);
  const [showColumns, setShowColumns] = useState(false);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const next = await window.localApp.filteredIndicatorReport(applied);
      setPayload(next);
      setSelectedCodes((current) => current.length ? current.filter((code) => next.registry.some((item) => item.code === code)) : next.registry.map((item) => item.code));
    } catch (cause) {
      setError(errText(cause) || 'تعذر تطبيق فلاتر المؤشرات.');
    } finally {
      setLoading(false);
    }
  }, [applied]);

  useEffect(() => { load(); }, [load, refreshKey]);

  const registry = payload?.registry ?? INDICATORS_META;
  const rows = payload?.rows ?? [];
  const stats = payload?.stats ?? {};
  const summary = payload?.summary ?? {};
  const view = payload?.filters?.view ?? applied.view;
  const mode = payload?.filters?.mode ?? applied.mode;
  const selectedRegistry = registry.filter((indicator) => selectedCodes.includes(indicator.code));

  async function exportReport(format) {
    setExporting(true);
    try {
      const request = { type: 'indicators', filters: applied, columns: { indicators: selectedCodes, includePriority: true } };
      const result = format === 'pdf'
        ? await window.localApp.exportFilteredPdf(request)
        : await window.localApp.exportFilteredExcel(request);
      if (!result?.canceled) notify?.({ tone: 'ok', message: `صُدّر تقرير المؤشرات المطابق إلى ${result.filePath}` });
    } catch (cause) {
      notify?.({ tone: 'bad', message: errText(cause) || 'تعذر تصدير تقرير المؤشرات المطابق.' });
    } finally {
      setExporting(false);
    }
  }

  if (loading && !payload) return <Card title="المؤشرات الـ 12"><Loading label="جارٍ حساب المؤشرات..." /></Card>;

  return (
    <>
      {error && <ErrorBanner message={error} onDismiss={() => setError('')} />}
      <Card
        title="المؤشرات الـ 12"
        subtitle="هذه الشاشة للفلاتر المشتقة والترتيب وجودة نتائج التحليل؛ فلاتر السكان والخدمات والاقتصاد الخام والجغرافيا موجودة في قاعدة البيانات الشاملة فقط."
        icon={Activity}
        actions={(
          <div className="btn-row">
            <button className="btn small" onClick={() => exportReport('excel')} disabled={exporting}><FileSpreadsheet size={15} /> Excel مطابق</button>
            <button className="btn small" onClick={() => exportReport('pdf')} disabled={exporting}><FileText size={15} /> PDF مطابق</button>
            <span className="chip gold">{fmtNumber(rows.length, 0)} نتيجة</span>
          </div>
        )}
      >
        <IndicatorReportFilters
          registry={registry}
          accessProfile={accessProfile}
          value={filters}
          onChange={setFilters}
          onApply={() => setApplied({ ...filters, criteria: [...filters.criteria] })}
          resultCount={payload?.total ?? rows.length}
          loading={loading}
        />
        <div className="report-table-toolbar">
          <button className="btn small ghost" onClick={() => setShowColumns((current) => !current)}>{showColumns ? 'إخفاء أعمدة التقرير' : 'تحديد أعمدة التقرير'}</button>
          <span className="chip">المحدد: {selectedRegistry.length} مؤشرًا</span>
        </div>
        {showColumns && (
          <div className="report-column-picker">
            {registry.map((indicator) => <label key={indicator.code}><input type="checkbox" checked={selectedCodes.includes(indicator.code)} onChange={() => setSelectedCodes((current) => current.includes(indicator.code) ? current.filter((code) => code !== indicator.code) : [...current, indicator.code])} />{indicator.header}</label>)}
          </div>
        )}
      </Card>

      <Card title="ملخص النتائج المطابقة" subtitle="تُحسب الإحصاءات بعد تطبيق شروط المؤشرات فقط.">
        <div className="report-summary-strip">
          <div><span>المطابقة</span><strong>{fmtNumber(summary.total, 0)}</strong></div>
          {summary.complete !== null && <div><span>مكتملة البيانات</span><strong>{fmtNumber(summary.complete, 0)}</strong></div>}
          {summary.rankable !== null && <div><span>قابلة للترتيب</span><strong>{fmtNumber(summary.rankable, 0)}</strong></div>}
          <div><span>قيم شاذة</span><strong>{fmtNumber(summary.anomalous, 0)}</strong></div>
          {summary.averageComposite !== null && <div><span>متوسط الدرجة</span><strong>{fmtNumber(summary.averageComposite, 3)}</strong></div>}
        </div>
      </Card>

      <Card title="إحصاءات المؤشرات المطابقة" subtitle="المدى والتغطية المتوسطان للصفوف التي اجتازت المرشحات.">
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>المؤشر</th><th className="num">محسوب</th><th className="num">ناقص</th><th className="num">الأدنى</th><th className="num">الأعلى</th><th className="num">المتوسط</th><th>التغطية</th></tr></thead>
            <tbody>{registry.map((indicator) => {
              const stat = stats[indicator.code] ?? {};
              const coverage = rows.length ? (stat.count ?? 0) / rows.length : 0;
              return <tr key={indicator.code}><td className="strong">{indicator.header}</td><td className="num">{fmtNumber(stat.count, 0)}</td><td className="num">{fmtNumber(stat.missing, 0)}</td><td className="num">{formatStat(stat.min, indicator.unit)}</td><td className="num">{formatStat(stat.max, indicator.unit)}</td><td className="num">{formatStat(stat.average, indicator.unit)}</td><td style={{ width: 160 }}><div className="completeness"><div className="bar"><div className="bar-fill" style={{ width: `${coverage * 100}%` }} /></div><small>{fmtPercent(coverage * 100, 0)}</small></div></td></tr>;
            })}</tbody>
          </table>
        </div>
      </Card>

      <Card
        title="مصفوفة المؤشرات المطابقة"
        subtitle={`كل صف نتيجة مطابقة؛ درجة الرتبة مستقلة حسب المسار ${mode === 'replica' ? 'المرجعي' : 'المعاير'}.`}
        actions={<Segmented value={view} onChange={(nextView) => { const next = { ...applied, view: nextView }; setFilters((current) => ({ ...current, view: nextView })); setApplied(next); }} options={VIEWS} />}
      >
        {rows.length === 0 ? <Empty icon={Activity} title="لا نتائج مطابقة" hint="خفّف الشروط أو امسح الفلاتر." /> : (
          <div className="table-wrap" style={{ maxHeight: 620 }}>
            <table className="data">
              <thead><tr><th className="sticky-col">#</th><th className="nowrap">المديرية</th><th className="num">الرتبة</th><th className="num">درجة المسار</th>{registry.map((indicator) => <th key={indicator.code} title={indicator.header} className="nowrap">{indicator.header}</th>)}</tr></thead>
              <tbody>{rows.map((row, index) => {
                const rank = mode === 'replica' ? row.replicaRank : row.calibratedRank;
                const composite = mode === 'replica' ? row.replicaComposite : row.composite;
                return <tr key={`${row.directorateId}-${index}`}><td className="sticky-col num dim">{index + 1}</td><td className="strong nowrap">{row.districtName}</td><td className="num">{rank ?? '—'}</td><td className="num">{composite === null || composite === undefined ? '—' : fmtNumber(composite, 3)}</td>{registry.map((indicator) => {
                  const value = pickValue(row, indicator.code, view);
                  return <td key={indicator.code} style={{ padding: 6 }}><div className="heat" style={{ background: heat(value, stats[indicator.code]), color: value === null || value === undefined ? 'var(--text-4)' : 'var(--text)' }} title={`${indicator.header}: ${value ?? '—'}`}>{value === null || value === undefined ? '—' : formatCell(value, view, indicator.unit)}</div></td>;
                })}</tr>;
              })}</tbody>
            </table>
          </div>
        )}
        <div className="row between" style={{ marginTop: 12 }}><div className="legend"><span>أدنى</span><span className="swatch" style={{ background: 'linear-gradient(90deg, rgba(98,168,232,.35), rgba(216,180,95,.75))' }} /><span>أعلى</span></div><span className="muted" style={{ fontSize: '0.76rem' }}>{view === 'scores' ? 'الدرجة 0-100 بعد المعايرة (100 = أسوأ احتياج)' : view === 'contributions' ? 'مساهمة المؤشر في المؤشر المركّب' : 'القيمة الأصلية بوحدة المؤشر'}</span></div>
      </Card>
    </>
  );
}

function pickValue(row, code, view) {
  if (view === 'scores') { const score = row.scores?.[code]; return Number.isFinite(score) ? score : null; }
  if (view === 'contributions') { const contribution = row.contributions?.[code]; const value = contribution && typeof contribution === 'object' ? contribution.contribution : contribution; return Number.isFinite(value) ? value : null; }
  const value = row.values?.[code]; return Number.isFinite(value) ? value : null;
}

function formatCell(value, view, unit) {
  if (view === 'values') return fmtNumber(value, unit === '%' ? 1 : 2);
  if (view === 'scores') return fmtNumber(value, 1);
  return fmtPercent(value * 100, 1);
}

function formatStat(value, unit) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
  return unit === '%' ? `${fmtNumber(value * 100, 1)}%` : fmtNumber(value, 2);
}

function heat(value, stat) {
  if (!Number.isFinite(value) || !Number.isFinite(stat?.min) || !Number.isFinite(stat?.max)) return 'rgba(140,168,208,.04)';
  const range = stat.max - stat.min;
  const ratio = range === 0 ? 0.5 : Math.max(0, Math.min(1, (value - stat.min) / range));
  const alpha = 0.08 + ratio * 0.22;
  return `rgba(${Math.round(98 + ratio * 118)}, ${Math.round(168 + ratio * 12)}, ${Math.round(232 - ratio * 137)}, ${alpha})`;
}
