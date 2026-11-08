import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  DatabaseZap, FileSpreadsheet, FileText, Search, Trash2,
} from 'lucide-react';
import {
  Badge, Card, Empty, ErrorBanner, Loading, Modal, SelectInput, Switch,
} from '../components/ui.jsx';
import { cx, errText, fmtByType, fmtDateTime, fmtNumber } from '../lib/format.js';

/**
 * «قاعدة البيانات الشاملة»
 *
 * The browse view over the 39 input columns. The default column set is the one
 * an operator scans (identity, population, coverage, money, services); the full
 * 39 columns are one switch away, in schema order A..AM.
 */

const DEFAULT_KEYS = [
  'districtName', 'governorate', 'population', 'waterCoverage', 'pavedRoads',
  'revenue', 'schools', 'govFacilities', 'valueChains', 'projectCost', 'projectStatus',
];

export default function Database({ catalogue, notify, refreshKey, onOpenCard }) {
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState('');
  const [governorate, setGovernorate] = useState('');
  const [allColumns, setAllColumns] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [pendingDelete, setPendingDelete] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await window.localApp.directorates({ search: search.trim() || undefined, governorate: governorate || undefined, limit: 3000 });
      setRows(result.rows ?? []);
      setTotal(result.total ?? 0);
    } catch (cause) {
      setError(errText(cause) || 'تعذر تحميل قاعدة البيانات.');
    } finally {
      setLoading(false);
    }
  }, [search, governorate]);

  useEffect(() => {
    const timer = setTimeout(load, 220);
    return () => clearTimeout(timer);
  }, [load, refreshKey]);

  const governorates = useMemo(() => {
    const names = [...new Set(rows.map((row) => row.governorate).filter(Boolean))].sort();
    return [{ value: '', label: 'كل المحافظات' }, ...names.map((name) => ({ value: name, label: name }))];
  }, [rows]);

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
      const result = await window.localApp.exportAnalysisPdf();
      if (!result?.canceled) notify?.({ tone: 'ok', message: `صُدّر التقرير إلى ${result.filePath}` });
    } catch (cause) {
      notify?.({ tone: 'bad', message: errText(cause) || 'تعذر تصدير التقرير.' });
    }
  }

  return (
    <>
      <Card
        title="قاعدة البيانات الشاملة"
        subtitle={`${fmtNumber(total, 0)} مديرية مخزّنة. كل صف سجل واحد بمفتاح (اسم المديرية + المحافظة).`}
        icon={DatabaseZap}
        actions={(
          <div className="btn-row">
            <button className="btn small" onClick={exportExcel}><FileSpreadsheet size={15} /> Excel</button>
            <button className="btn small" onClick={exportPdf}><FileText size={15} /> PDF</button>
          </div>
        )}
      >
        <div className="toolbar">
          <div className="search-box">
            <Search size={16} />
            <input className="input" placeholder="بحث باسم المديرية..." value={search} onChange={(event) => setSearch(event.target.value)} />
          </div>
          <div style={{ minWidth: 190 }}>
            <SelectInput value={governorate} onChange={setGovernorate} options={governorates} />
          </div>
          <Switch checked={allColumns} onChange={setAllColumns} label={`عرض كل الأعمدة (${catalogue.length - 1})`} />
          {!allColumns && <Badge tone="gold">عرض مختصر</Badge>}
        </div>
      </Card>

      {error && <ErrorBanner message={error} onDismiss={() => setError('')} />}

      <Card flush>
        {loading && rows.length === 0 ? <div style={{ padding: 20 }}><Loading /></div> : rows.length === 0 ? (
          <Empty
            icon={DatabaseZap}
            title="لا سجلات"
            hint="ابدأ باستيراد ملف «القالب المحدث» من شاشة الاستيراد الآلي."
          />
        ) : (
          <div className="table-wrap" style={{ maxHeight: '68vh' }}>
            <table className="data">
              <thead>
                <tr>
                  <th className="sticky-col" style={{ width: 56 }}>#</th>
                  {columns.map((column) => (
                    <th key={column.key} title={column.header} className="nowrap">{column.header}</th>
                  ))}
                  <th className="nowrap">آخر تحديث</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((row, index) => (
                  <tr key={row.id} style={{ animation: `rise .3s var(--ease-out) ${Math.min(index, 24) * 12}ms both` }}>
                    <td className="sticky-col num dim">{row.id}</td>
                    {columns.map((column) => (
                      <td
                        key={column.key}
                        className={cx(column.type === 'number' || column.type === 'ratio' ? 'num' : '', column.key === 'districtName' && 'strong')}
                      >
                        {renderCell(row[column.dbColumn], column)}
                      </td>
                    ))}
                    <td className="nowrap dim" style={{ fontSize: '0.76rem' }}>{fmtDateTime(row.updated_at)}</td>
                    <td>
                      <div className="cell-actions">
                        <button className="btn small ghost" onClick={() => onOpenCard?.(row.id)}>البطاقة</button>
                        <button className="icon-button" title="حذف السجل" onClick={() => setPendingDelete(row)}><Trash2 size={15} /></button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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
        <p className="muted">
          هل تريد حذف «{pendingDelete?.district}» في «{pendingDelete?.governorate || 'بلا محافظة'}»؟
        </p>
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