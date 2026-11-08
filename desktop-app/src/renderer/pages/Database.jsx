import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ChevronLeft, ChevronRight, DatabaseZap, FileSpreadsheet, FileText, Search, Trash2,
} from 'lucide-react';
import {
  Badge, Card, Empty, ErrorBanner, Loading, Modal, Switch,
} from '../components/ui.jsx';
import { DatabaseReportFilters } from '../components/ReportFilters.jsx';
import { cx, errText, fmtByType, fmtDateTime, fmtNumber } from '../lib/format.js';

const DEFAULT_KEYS = [
  'districtName', 'governorate', 'population', 'waterCoverage', 'pavedRoads',
  'revenue', 'schools', 'govFacilities', 'valueChains', 'projectCost', 'projectStatus',
];
const PAGE_SIZE = 100;

export default function Database({ catalogue, accessProfile, notify, refreshKey, onOpenCard }) {
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [draftFilters, setDraftFilters] = useState({ search: '', governorates: [], logic: 'and', criteria: [] });
  const [appliedFilters, setAppliedFilters] = useState({ search: '', governorates: [], logic: 'and', criteria: [] });
  const [page, setPage] = useState(0);
  const [allColumns, setAllColumns] = useState(false);
  const [reportColumns, setReportColumns] = useState(DEFAULT_KEYS);
  const [showReportColumns, setShowReportColumns] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [pendingDelete, setPendingDelete] = useState(null);
  const [exporting, setExporting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await window.localApp.directorates({ ...appliedFilters, limit: PAGE_SIZE, offset: page * PAGE_SIZE });
      setRows(result.rows ?? []);
      setTotal(result.total ?? 0);
    } catch (cause) {
      setError(errText(cause) || 'تعذر تحميل قاعدة البيانات.');
    } finally {
      setLoading(false);
    }
  }, [appliedFilters, page]);

  useEffect(() => { load(); }, [load, refreshKey]);

  const columns = useMemo(() => {
    const byKey = new Map(catalogue.map((field) => [field.key, field]));
    const keys = allColumns ? catalogue.filter((field) => field.key !== 'reviewerDecision').map((field) => field.key) : DEFAULT_KEYS;
    return keys.map((key) => byKey.get(key)).filter(Boolean).map((field) => ({
      key: field.key,
      header: field.header,
      dbColumn: field.dbColumn,
      type: field.type,
    }));
  }, [catalogue, allColumns]);

  const reportColumnOptions = useMemo(() => catalogue.filter((field) => accessProfile !== 'shared' || field.sensitivity === 'public'), [catalogue, accessProfile]);
  const safeReportColumns = reportColumns.filter((key) => reportColumnOptions.some((field) => field.key === key));
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  async function remove(id) {
    try {
      await window.localApp.deleteDirectorate(id);
      notify?.({ tone: 'warn', message: 'حُذف السجل من قاعدة البيانات.' });
      setPendingDelete(null);
      await load();
    } catch (cause) {
      notify?.({ tone: 'bad', message: errText(cause) || 'تعذر الحذف.' });
    }
  }

  function applyFilters() {
    setPage(0);
    setAppliedFilters({ ...draftFilters, governorates: [...draftFilters.governorates], criteria: [...draftFilters.criteria] });
  }

  async function exportReport(format) {
    setExporting(true);
    try {
      const request = { type: 'database', filters: appliedFilters, columns: safeReportColumns };
      const result = format === 'pdf'
        ? await window.localApp.exportFilteredPdf(request)
        : await window.localApp.exportFilteredExcel(request);
      if (!result?.canceled) notify?.({ tone: 'ok', message: `صُدّر التقرير المطابق إلى ${result.filePath}` });
    } catch (cause) {
      notify?.({ tone: 'bad', message: errText(cause) || 'تعذر تصدير التقرير المطابق.' });
    } finally {
      setExporting(false);
    }
  }

  function toggleReportColumn(key) {
    setReportColumns((current) => current.includes(key) ? current.filter((item) => item !== key) : [...current, key]);
  }

  return (
    <>
      <Card
        title="قاعدة البيانات الشاملة"
        subtitle="فلاتر البيانات الجغرافية والسكانية والقطاعية والاقتصادية والجودة والمصدر تُنفّذ محليًا داخل قاعدة البيانات."
        icon={DatabaseZap}
        actions={(
          <div className="btn-row">
            <button className="btn small" onClick={() => exportReport('excel')} disabled={exporting}><FileSpreadsheet size={15} /> Excel مطابق</button>
            <button className="btn small" onClick={() => exportReport('pdf')} disabled={exporting}><FileText size={15} /> PDF مطابق</button>
          </div>
        )}
      >
        <DatabaseReportFilters
          catalogue={catalogue}
          accessProfile={accessProfile}
          value={draftFilters}
          onChange={setDraftFilters}
          onApply={applyFilters}
          resultCount={total}
          loading={loading}
        />
        <div className="toolbar report-table-toolbar">
          <Switch checked={allColumns} onChange={setAllColumns} label={`عرض كل الأعمدة (${catalogue.filter((field) => field.key !== 'reviewerDecision').length})`} />
          {!allColumns && <Badge tone="gold">عرض مختصر</Badge>}
          <button className="btn small ghost" onClick={() => setShowReportColumns((value) => !value)}>{showReportColumns ? 'إخفاء خيارات التقرير' : 'اختيار أعمدة التقرير'}</button>
          <span className="chip">التقرير: {safeReportColumns.length} عمودًا</span>
        </div>
        {showReportColumns && (
          <div className="report-column-picker">
            {reportColumnOptions.map((field) => <label key={field.key}><input type="checkbox" checked={safeReportColumns.includes(field.key)} onChange={() => toggleReportColumn(field.key)} />{field.header}</label>)}
          </div>
        )}
      </Card>

      {error && <ErrorBanner message={error} onDismiss={() => setError('')} />}

      <Card flush>
        {loading && rows.length === 0 ? <div style={{ padding: 20 }}><Loading /></div> : rows.length === 0 ? (
          <Empty icon={DatabaseZap} title="لا سجلات مطابقة" hint="عدّل شروط التقرير أو امسح الفلاتر لعرض السجلات." />
        ) : (
          <>
            <div className="table-wrap" style={{ maxHeight: '68vh' }}>
              <table className="data">
                <thead>
                  <tr>
                    <th className="sticky-col" style={{ width: 56 }}>#</th>
                    {columns.map((column) => <th key={column.key} title={column.header} className="nowrap">{column.header}</th>)}
                    <th className="nowrap">آخر تحديث</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, index) => (
                    <tr key={row.id} style={{ animation: `rise .3s var(--ease-out) ${Math.min(index, 24) * 12}ms both` }}>
                      <td className="sticky-col num dim">{row.id}</td>
                      {columns.map((column) => <td key={column.key} className={cx(column.type === 'number' || column.type === 'ratio' ? 'num' : '', column.key === 'districtName' && 'strong')}>{renderCell(row[column.dbColumn], column)}</td>)}
                      <td className="nowrap dim" style={{ fontSize: '0.76rem' }}>{fmtDateTime(row.updated_at)}</td>
                      <td><div className="cell-actions"><button className="btn small ghost" onClick={() => onOpenCard?.(row.id)}>البطاقة</button><button className="icon-button" title="حذف السجل" onClick={() => setPendingDelete(row)}><Trash2 size={15} /></button></div></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="report-pagination">
              <span>عرض {Math.min(total, page * PAGE_SIZE + 1)}–{Math.min(total, (page + 1) * PAGE_SIZE)} من {fmtNumber(total, 0)} مديرية</span>
              <div className="btn-row">
                <button className="btn small ghost" disabled={page <= 0 || loading} onClick={() => setPage((value) => Math.max(0, value - 1))}><ChevronRight size={15} /> السابقة</button>
                <span className="chip">صفحة {fmtNumber(page + 1, 0)} / {fmtNumber(pageCount, 0)}</span>
                <button className="btn small ghost" disabled={page + 1 >= pageCount || loading} onClick={() => setPage((value) => value + 1)}>التالية <ChevronLeft size={15} /></button>
              </div>
            </div>
          </>
        )}
      </Card>

      <Modal
        open={Boolean(pendingDelete)}
        title="حذف من قاعدة البيانات"
        subtitle="سيُحذف السجل وسجلات مصدره. لا يمكن التراجع من هذه الشاشة."
        onClose={() => setPendingDelete(null)}
        footer={(
          <>
            <button className="btn danger" onClick={() => remove(pendingDelete.id)}><Trash2 size={15} /> تأكيد الحذف</button>
            <button className="btn ghost" onClick={() => setPendingDelete(null)}>إلغاء</button>
          </>
        )}
      >
        <p className="muted">هل تريد حذف «{pendingDelete?.district}» في «{pendingDelete?.governorate || 'بلا محافظة'}»؟</p>
      </Modal>
    </>
  );
}

function renderCell(value, column) {
  if (value === null || value === undefined || value === '') return <span className="dim">—</span>;
  if (column.type === 'boolean') return Number(value) === 1 ? 'نعم' : 'لا';
  if (column.type === 'ratio') return fmtByType(value, 'ratio');
  if (column.type === 'number') return fmtNumber(value, 2);
  return String(value);
}
