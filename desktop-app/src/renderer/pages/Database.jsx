import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ChevronLeft, ChevronRight, Database as DatabaseIcon, DatabaseZap, Download, FileSpreadsheet, FileText, FolderTree, Search, TableProperties, Trash2,
} from 'lucide-react';
import {
  Badge, Card, Empty, ErrorBanner, Loading, Modal, Switch,
} from '../components/ui.jsx';
import { DatabaseReportFilters } from '../components/ReportFilters.jsx';
import DataEntry from './DataEntry.jsx';
import { cx, errText, fmtByType, fmtDateTime, fmtNumber } from '../lib/format.js';

const DEFAULT_KEYS = [
  'districtName', 'governorate', 'population', 'waterCoverage', 'pavedRoads',
  'revenue', 'schools', 'govFacilities', 'valueChains', 'projectCost', 'projectStatus',
];
const PAGE_SIZE = 100;

export default function Database({ catalogue, accessProfile, notify, refreshKey, onOpenCard, onDataChanged }) {
  const api = typeof window === 'undefined' ? null : window.localApp?.databaseBrowser;
  const [overview, setOverview] = useState(null);
  const [directorates, setDirectorates] = useState([]);
  const [periods, setPeriods] = useState([]);
  const [selectedGeoUnitId, setSelectedGeoUnitId] = useState('');
  const [selectedPeriodId, setSelectedPeriodId] = useState('');
  const [section, setSection] = useState('catalog');
  const [selectedGroup, setSelectedGroup] = useState('');
  const [selectedSource, setSelectedSource] = useState('');
  const [selectedRecordId, setSelectedRecordId] = useState(null);
  const [selectedOperational, setSelectedOperational] = useState('');
  const [selectedUnclassified, setSelectedUnclassified] = useState('');
  const [selectedUnclassifiedTable, setSelectedUnclassifiedTable] = useState('');
  const [result, setResult] = useState(null);
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState('');
  const pageSize = 50;

  const loadOverview = useCallback(async () => {
    if (!api || accessProfile !== 'owner') return;
    setLoading(true);
    try {
      const [nextOverview, geography, nextPeriods] = await Promise.all([
        api.overview(),
        window.localApp.dataGeography(''),
        window.localApp.dataPeriods(),
      ]);
      setOverview(nextOverview);
      setDirectorates((geography.rows ?? []).filter(unit => unit.type_code === 'directorate' && Number(unit.is_active) === 1));
      setPeriods(nextPeriods.rows ?? []);
      setError('');
    } catch (cause) {
      setError(errText(cause) || 'تعذر تحميل فهرس قاعدة البيانات.');
    } finally {
      setLoading(false);
    }
  }, [api, accessProfile]);

  useEffect(() => { loadOverview(); }, [loadOverview, refreshKey]);

  const groups = useMemo(() => overview?.domains?.flatMap(domain => domain.groups.map(group => ({ ...group, domainCode: domain.code, domainName: domain.name }))) ?? [], [overview]);
  const activeGroup = groups.find(group => group.code === selectedGroup) ?? groups[0] ?? null;
  const activeSource = activeGroup?.sources.find(source => source.key === selectedSource) ?? activeGroup?.sources[0] ?? null;
  const operational = overview?.operational ?? [];
  const unclassifiedDatasets = overview?.unclassified?.datasets ?? [];
  const selectedUnclassifiedItem = unclassifiedDatasets.find(item => item.key === selectedUnclassified);

  const loadRows = useCallback(async () => {
    if (!api || accessProfile !== 'owner' || section === 'legacy' || section === 'catalog' && (!activeSource || !selectedGeoUnitId)
      || section === 'operational' && !selectedOperational || section === 'unclassified' && !selectedUnclassifiedItem && !selectedUnclassifiedTable) {
      setResult(null);
      return;
    }
    setLoading(true);
    try {
      const request = { search, limit: pageSize, offset };
      const payload = section === 'catalog'
        ? await api.group({ ...request, groupCode: activeGroup.code, sourceKey: activeSource.key, geoUnitId: Number(selectedGeoUnitId), periodId: selectedPeriodId ? Number(selectedPeriodId) : undefined })
        : section === 'operational'
          ? await api.operational({ ...request, table: selectedOperational })
          : section === 'unclassified'
            ? selectedUnclassifiedTable
              ? await api.legacyTable({ ...request, table: selectedUnclassifiedTable })
              : await api.unclassified({ ...request, dataset: selectedUnclassifiedItem.key })
            : null;
      setResult(payload);
      setError('');
    } catch (cause) {
      setResult(null);
      setError(errText(cause) || 'تعذر تحميل السجلات.');
    } finally {
      setLoading(false);
    }
  }, [api, accessProfile, section, activeGroup, activeSource, selectedOperational, selectedUnclassifiedItem, selectedGeoUnitId, selectedPeriodId, search, offset]);

  useEffect(() => { loadRows(); }, [loadRows, refreshKey]);

  async function exportDatabase(format) {
    if (!api || !result || result.requiresApproval || result.requiresGeography) return;
    setExporting(true);
    try {
      const request = { format, section, search };
      if (section === 'catalog') Object.assign(request, { groupCode: activeGroup.code, sourceKey: activeSource.key, geoUnitId: Number(selectedGeoUnitId), periodId: selectedPeriodId ? Number(selectedPeriodId) : undefined });
      if (section === 'operational') request.table = selectedOperational;
      if (section === 'unclassified') Object.assign(request, selectedUnclassifiedTable ? { table: selectedUnclassifiedTable } : { dataset: selectedUnclassifiedItem.key });
      const response = await api.export(request);
      if (!response?.canceled) notify({ tone: 'success', message: `تم تصدير ${fmtNumber(response.rowCount ?? 0, 0)} سجل.` });
    } catch (cause) {
      notify({ tone: 'error', message: errText(cause) || 'تعذر تصدير النتائج.' });
    } finally {
      setExporting(false);
    }
  }

  function chooseGroup(group) {
    setSection('catalog');
    setSelectedGroup(group.code);
    setSelectedSource(group.sources[0]?.key ?? '');
    setSelectedRecordId(null);
    setOffset(0);
    setSearch('');
  }

  function chooseSection(next) {
    setSection(next);
    if (next !== 'entry') setSelectedRecordId(null);
    setResult(null);
    setOffset(0);
    setSearch('');
    if (next === 'unclassified') { setSelectedUnclassified(''); setSelectedUnclassifiedTable(''); }
    if (next === 'operational') setSelectedOperational('');
  }

  if (accessProfile !== 'owner') {
    return <LegacyDirectorates catalogue={catalogue} accessProfile={accessProfile} notify={notify} refreshKey={refreshKey} onOpenCard={onOpenCard} onDataChanged={onDataChanged} />;
  }

  if (section === 'entry') return (
    <div className="stack">
      <Card title="قاعدة البيانات الشاملة" subtitle="إدخال وإدارة السجلات من الكتالوج المركزي نفسه.">
        <button type="button" className="btn small" onClick={() => chooseSection('catalog')}>العودة إلى مستعرض البيانات</button>
      </Card>
      <DataEntry notify={notify} refreshKey={refreshKey} onDataChanged={onDataChanged} onShowDatabase={() => chooseSection('catalog')}
        initialEntry={activeGroup ? { domainCode: activeGroup.domainCode, groupCode: activeGroup.code, formCode: activeSource?.formCode,
          geoUnitId: selectedGeoUnitId || undefined, recordId: selectedRecordId ?? undefined } : { geoUnitId: selectedGeoUnitId || undefined }} />
    </div>
  );

  const pageCount = Math.max(1, Math.ceil(Number(result?.total ?? 0) / pageSize));
  const columns = result?.fields ?? [];
  const listTitle = section === 'catalog' ? `${activeGroup?.domainName ?? ''} · ${activeGroup?.name ?? ''}`
    : section === 'operational' ? operational.find(item => item.table === selectedOperational)?.labelAr ?? 'الجداول التشغيلية'
      : overview?.unclassified?.tables?.find(item => item.table === selectedUnclassifiedTable)?.labelAr
        ?? selectedUnclassifiedItem?.labelAr ?? 'بيانات غير مصنفة / قديمة';

  return (
    <div className="stack">
      <Card title="قاعدة البيانات الشاملة" subtitle="استعراض البيانات وفق ترتيب المجالات والمجموعات في الإدخال المركزي، مع فصل الجداول التشغيلية والبيانات غير المرتبطة." icon={DatabaseZap}>
        <div className="row between">
          <div className="toolbar">
            <span className="chip">{overview?.totals?.domains ?? 18} مجالاً</span>
            <span className="chip">{overview?.totals?.groups ?? 0} مجموعة</span>
            <span className="chip">{overview?.totals?.linkedGroups ?? 0} مجموعة مرتبطة بمصدر</span>
            <span className="chip">{overview?.totals?.operationalTables ?? 0} جدولاً تشغيلياً</span>
          </div>
          <button type="button" className="btn primary small" onClick={() => chooseSection('entry')}>إدخال وإدارة السجلات</button>
        </div>
        <div className="segmented" role="tablist" style={{ marginTop: 14 }}>
          <button className={`seg-btn${section === 'catalog' ? ' active' : ''}`} onClick={() => chooseSection('catalog')}>المجالات والمجموعات</button>
          <button className={`seg-btn${section === 'operational' ? ' active' : ''}`} onClick={() => chooseSection('operational')}>الجداول التشغيلية</button>
          <button className={`seg-btn${section === 'unclassified' ? ' active' : ''}`} onClick={() => chooseSection('unclassified')}>غير مصنفة / قديمة</button>
          <button className={`seg-btn${section === 'legacy' ? ' active' : ''}`} onClick={() => chooseSection('legacy')}>سجلات المديريات القديمة</button>
        </div>
        {section === 'catalog' && <div className="toolbar" style={{ marginTop: 14 }}>
          <label className="stack tight" style={{ minWidth: 220 }}><span>المديرية *</span><select className="input" value={selectedGeoUnitId} onChange={event => { setSelectedGeoUnitId(event.target.value); setOffset(0); setResult(null); }}>
            <option value="">اختر المديرية لعرض بياناتها</option>
            {directorates.map(unit => <option key={unit.geo_unit_id} value={unit.geo_unit_id}>{unit.name_ar}{unit.parent_name_ar ? ` — ${unit.parent_name_ar}` : ''}</option>)}
          </select></label>
          <label className="stack tight" style={{ minWidth: 220 }}><span>الفترة المرجعية (اختيارية)</span><select className="input" value={selectedPeriodId} onChange={event => { setSelectedPeriodId(event.target.value); setOffset(0); setResult(null); }}>
            <option value="">كل الفترات</option>
            {periods.map(period => <option key={period.period_id} value={period.period_id}>{period.label_ar}</option>)}
          </select></label>
        </div>}
      </Card>

      {error && <ErrorBanner message={error} onDismiss={() => setError('')} />}
      {loading && !overview && <Loading label="جارٍ جرد قاعدة البيانات..." />}

      {section === 'catalog' && overview && (
        <div className="database-layout">
          <Card title="كتالوج المجالات" icon={FolderTree} flush>
            <div className="database-domain-list" style={{ maxHeight: '70vh', overflow: 'auto', padding: 8 }}>
              {overview.domains.map(domain => (
                <section key={domain.code} style={{ marginBottom: 12 }}>
                  <h3 style={{ margin: '8px 6px', fontSize: '0.92rem' }}>{domain.name}</h3>
                  {domain.groups.map(group => (
                    <button key={group.code} type="button" className={`database-group-option${activeGroup?.code === group.code ? ' active' : ''}`}
                      onClick={() => chooseGroup(group)} aria-current={activeGroup?.code === group.code ? 'page' : undefined}>
                      <span>{group.name}</span>
                      <span className="database-group-count">{fmtNumber(group.count, 0)}</span>
                      <small>{group.state === 'unlinked' ? 'لا يوجد ربط تخزين مثبت' : group.state === 'empty' ? 'فارغة — مصدر التخزين معروف' : 'تحتوي سجلات'}</small>
                    </button>
                  ))}
                </section>
              ))}
            </div>
          </Card>
          <Card title={listTitle || 'اختر مجموعة'} subtitle={activeGroup?.storageLinked ? `الحالة: ${activeGroup.state === 'filled' ? 'تحتوي بيانات' : 'فارغة'} · آخر تحديث: ${fmtDateTime(activeGroup.latestUpdatedAt)}` : 'لا يوجد مصدر تخزين موثق لهذه المجموعة بعد.'} icon={DatabaseIcon}>
            {activeGroup?.sources?.length > 0 ? (
              <div className="toolbar" style={{ marginBottom: 10 }}>
                {activeGroup.sources.map(source => <button key={source.key} type="button" className={`btn small${activeSource?.key === source.key ? ' primary' : ''}`}
                  onClick={() => { setSelectedSource(source.key); setOffset(0); setResult(null); }}>{source.label} · {fmtNumber(source.count, 0)}</button>)}
              </div>
            ) : <Empty icon={DatabaseIcon} title="لا توجد سجلات في هذا المصدر" hint="لا نعرض هذه المجموعة كجدول فارغ؛ لا يوجد ربط تخزين مثبت لها حالياً." />}
            {!selectedGeoUnitId && activeGroup?.sources?.length > 0 && <p className="field-hint">اختر المديرية أعلاه لعرض السجلات المعتمدة التابعة لها فقط.</p>}
            {activeGroup?.duplicateCount > 0 && <p className="field-hint">يوجد {fmtNumber(activeGroup.duplicateCount, 0)} ربط توافق بين سجل مركزي وسجل قديم؛ لا يُحسب السجل مرتين.</p>}
            {activeGroup?.fieldCoverageState === 'needs_domain_review' && <p className="field-hint">تعريف بعض الحقول المرشحة يحتاج مراجعة؛ الروابط المعروضة لا تعني اعتماداً دلالياً.</p>}
          </Card>
        </div>
      )}

      {(section === 'operational' || section === 'unclassified') && overview && (
        <div className="database-layout">
          <Card title={section === 'operational' ? 'الجداول التشغيلية' : 'البيانات غير المصنفة / القديمة'} flush>
            <div style={{ display: 'grid', gap: 6, padding: 10, maxHeight: '60vh', overflow: 'auto' }}>
              {(section === 'operational' ? operational : unclassifiedDatasets).map(item => {
                const key = section === 'operational' ? item.table : item.key;
                const selected = section === 'operational' ? selectedOperational === key : selectedUnclassified === key;
                return <button key={key} type="button" disabled={!item.browseable} aria-disabled={!item.browseable}
                  className={`database-group-option${selected ? ' active' : ''}`} onClick={() => {
                  if (section === 'operational') setSelectedOperational(key); else { setSelectedUnclassified(key); setSelectedUnclassifiedTable(''); }
                  setOffset(0); setResult(null);
                }}><span>{item.labelAr}</span><span className="database-group-count">{fmtNumber(item.count, 0)}</span><small>{item.state ?? item.layerLabelAr ?? item.contentPolicy}{!item.browseable && item.countOnlyReason ? ` · ${item.countOnlyReason}` : ''}</small></button>;
              })}
              {section === 'unclassified' && (overview.unclassified?.tables ?? []).map(item => item.browseable
                ? <button key={item.table} type="button" className={`database-group-option${selectedUnclassifiedTable === item.table ? ' active' : ''}`} onClick={() => {
                  setSelectedUnclassifiedTable(item.table); setSelectedUnclassified(''); setOffset(0); setResult(null);
                }}><span>{item.labelAr}</span><span className="database-group-count">{fmtNumber(item.count, 0)}</span><small>{item.table} · السجلات غير المرتبطة فقط</small></button>
                : <div key={item.table} className="database-group-option" aria-disabled="true"><span>{item.labelAr}</span><span className="database-group-count">{fmtNumber(item.count, 0)}</span><small>{item.table} · {item.countOnlyReason}</small></div>)}
            </div>
          </Card>
          <Card title={listTitle} subtitle="تُعرض الحقول المسموح بها فقط؛ لا تُمرر أسماء جداول أو أعمدة من الواجهة." icon={TableProperties}>
            {section === 'operational' && <p className="field-hint">المرفقات الثنائية ومحتويات ملفات الاستيراد لا تُعرض. الجداول ذات القيم الحساسة محدودة الحقول الوصفية.</p>}
            {section === 'unclassified' && selectedUnclassifiedItem?.sourceType === 'unknown' && <p className="field-hint">المصدر غير موثق أو لا يوجد حقل مصدر في هذا الجدول.</p>}
          </Card>
        </div>
      )}

      {section === 'legacy' && <LegacyDirectorates catalogue={catalogue} accessProfile={accessProfile} notify={notify} refreshKey={refreshKey} onOpenCard={onOpenCard} onDataChanged={onDataChanged} />}

      {section !== 'legacy' && section !== 'entry' && (section === 'catalog' && activeSource && selectedGeoUnitId || section === 'operational' && selectedOperational || section === 'unclassified' && (selectedUnclassifiedItem || selectedUnclassifiedTable)) && (
        <Card title={`السجلات — ${listTitle}`} flush>
          <div className="toolbar" style={{ padding: 12 }}>
            <TextInput value={search} onChange={value => { setSearch(value); setOffset(0); }} placeholder="بحث في السجلات المعروضة..." />
            <span className="chip">{fmtNumber(result?.total ?? 0, 0)} سجل</span>
            {result && !result.requiresApproval && !result.requiresGeography && <div className="btn-row">
              <button className="btn small" disabled={exporting || loading} onClick={() => exportDatabase('xlsx')}><FileSpreadsheet size={15} /> Excel</button>
              <button className="btn small" disabled={exporting || loading} onClick={() => exportDatabase('pdf')}><FileText size={15} /> PDF</button>
            </div>}
          </div>
          {loading && !result ? <div style={{ padding: 20 }}><Loading /> </div> : result?.rows?.length ? (
            <div className="table-wrap" style={{ maxHeight: '65vh' }}><table className="data"><thead><tr>
              {(columns.length ? columns : Object.keys(result.rows[0]).filter(key => !key.startsWith('_')).map(name => ({ name, labelAr: name }))).map(field => <th key={field.name}>{field.labelAr ?? field.name}</th>)}
              <th>المصدر</th><th>الحالة</th>{section === 'catalog' && activeSource?.type === 'form' && <th>الإجراء</th>}
            </tr></thead><tbody>{result.rows.map((row, rowIndex) => <tr key={row.form_record_id ?? row[columns[0]?.name] ?? rowIndex}>
              {(columns.length ? columns : Object.keys(row).filter(key => !key.startsWith('_')).slice(0, 12).map(name => ({ name, labelAr: name }))).map(field => <td key={field.name}>{formatBrowserValue(row[field.name])}</td>)}
              <td>{row._sourceType ?? 'المصدر غير موثق'}</td><td>{row.record_status ?? row.quality_status ?? row.row_status ?? '—'}</td>
              {section === 'catalog' && activeSource?.type === 'form' && <td><button type="button" className="btn small" onClick={() => { setSelectedRecordId(row.form_record_id); setSection('entry'); }}>فتح السجل ومراجعة مصدره</button></td>}
            </tr>)}</tbody></table></div>
          ) : <Empty icon={DatabaseIcon} title={result?.requiresApproval ? 'المصدر لا يثبت حالة الاعتماد' : result?.requiresGeography ? 'المصدر غير مرتبط بمديرية' : result ? 'لا توجد سجلات مطابقة' : 'جارٍ تجهيز العرض'} hint={result?.requiresApproval ? 'لا يمكن إدراج هذا الجدول ضمن قاعدة البيانات المعتمدة حتى يدعم مسار مراجعة واعتماد واضحاً.' : result?.requiresGeography ? 'لا تُعرض هذه البيانات ضمن مديرية بعينها لأن مصدر التخزين لا يحتوي رابطاً جغرافياً موثقاً.' : 'تعرض هذه القائمة السجلات المعتمدة فقط؛ المسودات والسجلات قيد المراجعة تبقى في مسار المراجعة.'} />}
          {result && <div className="report-pagination"><span>عرض {result.total ? offset + 1 : 0}–{Math.min(offset + pageSize, result.total)} من {fmtNumber(result.total, 0)}</span>
            <div className="btn-row"><button className="btn small" disabled={!offset || loading} onClick={() => setOffset(Math.max(0, offset - pageSize))}>السابق</button>
              <span className="chip">صفحة {fmtNumber(Math.floor(offset / pageSize) + 1, 0)} / {fmtNumber(pageCount, 0)}</span>
              <button className="btn small" disabled={offset + pageSize >= result.total || loading} onClick={() => setOffset(offset + pageSize)}>التالي</button></div>
          </div>}
        </Card>
      )}
    </div>
  );
}

function formatBrowserValue(value) {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'object') return '[بيانات وصفية]';
  if (typeof value === 'number') return fmtNumber(value, 2);
  return String(value);
}

function LegacyDirectorates({ catalogue, accessProfile, notify, refreshKey, onOpenCard, onDataChanged }) {
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
  const [viewMode, setViewMode] = useState('database');

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

  const reportColumnOptions = useMemo(() => catalogue.filter((field) => field.exportable !== false
    && (accessProfile !== 'shared' || field.sensitivity === 'public')), [catalogue, accessProfile]);
  const safeReportColumns = reportColumns.filter((key) => reportColumnOptions.some((field) => field.key === key));
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  if (viewMode === 'entry') return (
    <div className="stack">
      <Card title="قاعدة البيانات الشاملة" subtitle="الإدخال اليدوي وإدارة السجلات يستخدمان القاموس نفسه ومحرك النماذج نفسه.">
        <button type="button" className="btn small" onClick={() => setViewMode('database')}>العودة إلى استعراض قاعدة البيانات</button>
      </Card>
      <DataEntry notify={notify} refreshKey={refreshKey} onDataChanged={onDataChanged} onShowDatabase={() => setViewMode('database')} />
    </div>
  );

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
        : format === 'csv'
          ? await window.localApp.exportFilteredCsv(request)
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
      >
        <div className="row between">
          <span className="muted">استعراض السجلات والتقارير</span>
          {accessProfile === 'owner' && <button type="button" className="btn primary small" onClick={() => setViewMode('entry')}>إدخال وإدارة السجلات</button>}
        </div>
        <DatabaseReportFilters
          catalogue={catalogue}
          accessProfile={accessProfile}
          value={draftFilters}
          onChange={setDraftFilters}
          onApply={applyFilters}
          resultCount={total}
          loading={loading}
        />
        <div className="row between report-download-row">
          <span className="muted">التقرير يشمل كل النتائج المطابقة، لا الصفحة الحالية فقط.</span>
          <div className="btn-row">
            <button className="btn small" onClick={() => exportReport('excel')} disabled={exporting}><FileSpreadsheet size={15} /> Excel مطابق</button>
            <button className="btn small" onClick={() => exportReport('csv')} disabled={exporting}><Download size={15} /> CSV مطابق</button>
            <button className="btn small" onClick={() => exportReport('pdf')} disabled={exporting}><FileText size={15} /> PDF مطابق</button>
          </div>
        </div>
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
                      {columns.map((column) => <td key={column.key} className={cx(column.type === 'number' || column.type === 'ratio' ? 'num' : '', column.key === 'districtName' && 'strong')}>{renderCell(row[column.dbColumn ?? column.key], column)}</td>)}
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
