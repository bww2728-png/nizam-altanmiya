import React, { useCallback, useEffect, useState } from 'react';
import { BriefcaseBusiness, RefreshCw, Search } from 'lucide-react';
import { Badge, Card, Empty, ErrorBanner, Loading, Modal } from '../components/ui.jsx';
import { errText, fmtDate, fmtDateTime, fmtNumber } from '../lib/format.js';

export default function Projects({ notify, refreshKey }) {
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const pageSize = 30;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [restricted, setRestricted] = useState(false);
  const [selectedId, setSelectedId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const result = await window.localApp.canonicalProjects({ search, offset, limit: pageSize });
      setRestricted(Boolean(result?.restricted));
      if (result?.restricted) {
        setRows([]);
        setTotal(0);
      } else {
        setRows(result.rows ?? []);
        setTotal(result.total ?? 0);
      }
    } catch (cause) {
      setError(errText(cause) || 'تعذر تحميل سجل المشاريع.');
    } finally {
      setLoading(false);
    }
  }, [offset, search]);

  useEffect(() => {
    const timer = setTimeout(load, 180);
    return () => clearTimeout(timer);
  }, [load, refreshKey]);

  const openDetails = async (id) => {
    setSelectedId(id);
    setDetail(null);
    setDetailLoading(true);
    try {
      const result = await window.localApp.canonicalProject(id);
      setDetail(result);
    } catch (cause) {
      const message = errText(cause) || 'تعذر تحميل تفاصيل المشروع.';
      setError(message);
      notify?.({ tone: 'bad', message });
      setSelectedId(null);
    } finally {
      setDetailLoading(false);
    }
  };

  const submitSearch = (event) => {
    event?.preventDefault?.();
    setOffset(0);
    setSearch(searchInput.trim().slice(0, 120));
  };

  const page = Math.floor(offset / pageSize) + 1;
  const pages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <>
      <Card
        title="سجل المشاريع المعتمدة"
        subtitle={restricted
          ? 'يتطلب عرض المشاريع والتكاليف ومصادرها وضع المالك.'
          : fmtNumber(total, 0) + ' مشروعًا في قاعدة البيانات المعيارية. البحث يشمل اسم المشروع ورمزه ووصفه.'}
        icon={BriefcaseBusiness}
        actions={(
          <button className="btn small ghost" onClick={load} disabled={loading}>
            <RefreshCw size={14} /> تحديث
          </button>
        )}
      >
        {restricted ? (
          <div className="quote">
            <strong>البيانات المالية والمصدرية محمية</strong>
            <p className="muted">انتقل إلى وضع المالك لعرض المشاريع وتكاليفها وتمويلها ومعلومات المصدر.</p>
          </div>
        ) : (
          <form className="toolbar" onSubmit={submitSearch}>
            <div className="search-box" style={{ flex: 1, minWidth: 220 }}>
              <Search size={16} />
              <input
                className="input"
                placeholder="ابحث بالاسم أو الرمز أو الوصف..."
                value={searchInput}
                onChange={event => setSearchInput(event.target.value)}
              />
            </div>
            <button className="btn primary" type="submit"><Search size={15} /> بحث</button>
            <button className="btn ghost" type="button"
              onClick={() => { setSearchInput(''); setSearch(''); setOffset(0); }}
              disabled={!searchInput && !search}>مسح</button>
          </form>
        )}
      </Card>

      {error && <ErrorBanner message={error} onDismiss={() => setError('')} />}

      {!restricted && (
        <Card flush>
          {loading && rows.length === 0 ? (
            <div style={{ padding: 20 }}><Loading /></div>
          ) : rows.length === 0 ? (
            <Empty
              icon={BriefcaseBusiness}
              title="لا توجد مشاريع مطابقة"
              hint={search
                ? 'جرّب اسمًا أو رمزًا آخر، أو امسح البحث.'
                : 'استقبل ملف Excel من شاشة الاستيراد، ثم راجع جدول المشاريع واربط أعمدته واعتمد الصفوف التي اخترتها.'}
            />
          ) : (
            <>
              <div className="table-wrap" style={{ maxHeight: '68vh' }}>
                <table className="data">
                  <thead>
                    <tr>
                      <th className="sticky-col">#</th>
                      <th>المشروع</th>
                      <th>الحالة</th>
                      <th>الموقع</th>
                      <th>القطاع</th>
                      <th>التكلفة التقديرية</th>
                      <th>التمويل</th>
                      <th>ملاحظات الجودة</th>
                      <th>آخر تحديث</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(row => (
                      <tr key={row.id}>
                        <td className="sticky-col num dim">{row.id}</td>
                        <td>
                          <div className="stack tight">
                            <strong>{row.name}</strong>
                            <span className="muted" style={{ fontSize: '0.76rem' }}>{row.code || 'بلا رمز'}</span>
                          </div>
                        </td>
                        <td><Badge tone={statusTone(row.status)}>{row.status || 'غير محدد'}</Badge></td>
                        <td>{row.geographicUnitName || <span className="dim">غير مربوط جغرافيًا</span>}</td>
                        <td>{row.sectorName || <span className="dim">غير محدد</span>}</td>
                        <td className="num nowrap">
                          {row.estimated_cost === null || row.estimated_cost === undefined
                            ? <span className="dim">—</span>
                            : fmtNumber(row.estimated_cost, 2) + ' ' + (row.currency_code || 'بلا عملة')}
                        </td>
                        <td className="num">{fmtNumber(row.fundingCount, 0)} جهة</td>
                        <td>
                          {Number(row.openQualityIssues) > 0
                            ? <Badge tone="warn">{fmtNumber(row.openQualityIssues, 0)} مفتوحة</Badge>
                            : <Badge tone="ok">لا ملاحظات مفتوحة</Badge>}
                        </td>
                        <td className="nowrap dim" style={{ fontSize: '0.76rem' }}>{fmtDateTime(row.updated_at)}</td>
                        <td><button className="btn small ghost" onClick={() => openDetails(row.id)}>التفاصيل</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="row between" style={{ padding: '12px 16px' }}>
                <span className="muted">عرض {fmtNumber(offset + 1, 0)}–{fmtNumber(Math.min(offset + rows.length, total), 0)} من {fmtNumber(total, 0)}</span>
                <div className="btn-row">
                  <button className="btn small ghost" onClick={() => setOffset(Math.max(0, offset - pageSize))} disabled={loading || offset === 0}>السابق</button>
                  <span className="muted">صفحة {page} / {pages}</span>
                  <button className="btn small ghost" onClick={() => setOffset(offset + pageSize)} disabled={loading || offset + rows.length >= total}>التالي</button>
                </div>
              </div>
            </>
          )}
        </Card>
      )}

      {!restricted && (
        <Card title="حدود السجل الحالي" subtitle="هذه شاشة قراءة ومتابعة للمشاريع المستوردة، وليست محررًا كاملًا لإدارة المشاريع.">
          <div className="chip-row">
            <span className="chip">البيانات محفوظة في قاعدة المشاريع المعيارية</span>
            <span className="chip">مصدر وموضع الصف محفوظان عند الاستيراد</span>
            <span className="chip">تكاليف وتمويل بعملة صريحة</span>
            <span className="chip warn">التحرير اليدوي وسير اعتماد التعديلات لم يُفعّلا بعد</span>
          </div>
        </Card>
      )}

      <Modal
        open={Boolean(selectedId)}
        title={detail?.project?.name ?? 'تفاصيل المشروع'}
        subtitle={detail?.project?.code || 'سجل مشروع معياري'}
        onClose={() => { setSelectedId(null); setDetail(null); }}
      >
        {detailLoading ? <Loading label="جارٍ تحميل تفاصيل المشروع..." /> : detail ? (
          <div className="stack">
            <div className="stat-strip">
              <Mini label="الحالة" value={detail.project.status || 'غير محدد'} />
              <Mini label="التكلفة التقديرية" value={detail.project.estimated_cost == null
                ? '—' : fmtNumber(detail.project.estimated_cost, 2) + ' ' + (detail.project.currency_code || 'بلا عملة')} />
              <Mini label="التكلفة الفعلية" value={detail.project.actual_cost == null
                ? '—' : fmtNumber(detail.project.actual_cost, 2) + ' ' + (detail.project.currency_code || 'بلا عملة')} />
            </div>
            {detail.project.description && <p>{detail.project.description}</p>}
            <div className="grid-2">
              <Mini label="الموقع" value={detail.project.geographic_unit_name || 'غير مربوط جغرافيًا'} />
              <Mini label="القطاع" value={detail.project.sector_name || 'غير محدد'} />
              <Mini label="تاريخ البداية" value={fmtDate(detail.project.start_date) || '—'} />
              <Mini label="تاريخ النهاية" value={fmtDate(detail.project.end_date) || '—'} />
            </div>

            <div className="stack tight">
              <strong>جهات التمويل</strong>
              {detail.funding.length === 0 ? <span className="muted">لا توجد جهات تمويل مسجلة.</span> : (
                <div className="table-wrap">
                  <table className="data">
                    <thead><tr><th>الجهة</th><th>المبلغ</th><th>تاريخ التمويل</th></tr></thead>
                    <tbody>
                      {detail.funding.map(funding => (
                        <tr key={funding.id}>
                          <td>{funding.partner_name}</td>
                          <td className="num">{funding.amount == null ? '—' : fmtNumber(funding.amount, 2) + ' ' + (funding.currency_code || 'بلا عملة')}</td>
                          <td>{fmtDate(funding.funding_date) || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div className="stack tight">
              <strong>مصدر البيانات</strong>
              {detail.provenance ? (
                <>
                  <span className="muted">{detail.provenance.file_name} · {detail.provenance.source_location}</span>
                  <span className="muted" style={{ fontSize: '0.76rem' }}>SHA-256: {detail.provenance.sha256}</span>
                </>
              ) : <span className="muted">{detail.project.source_file || 'لا يوجد مصدر ملف مسجل.'}</span>}
            </div>

            <div className="stack tight">
              <strong>ملاحظات الجودة</strong>
              {detail.issues.length === 0 ? <Badge tone="ok">لا توجد ملاحظات مفتوحة</Badge> : detail.issues.map(issue => (
                <div className="quote" key={issue.id}>
                  <div className="row between">
                    <Badge tone={issue.severity === 'error' ? 'bad' : 'warn'}>{issue.issue_code}</Badge>
                    <span className="muted">{issue.status}</span>
                  </div>
                  <p>{issue.message}</p>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </Modal>
    </>
  );
}

function Mini({ label, value }) {
  return <div className="mini-stat"><strong>{value}</strong><span>{label}</span></div>;
}

function statusTone(status) {
  const value = String(status ?? '').toLowerCase();
  if (value.includes('complete') || value.includes('مكتمل') || value.includes('معتمد')) return 'ok';
  if (value.includes('cancel') || value.includes('متوقف') || value.includes('مرفوض')) return 'bad';
  if (value.includes('progress') || value.includes('تنفيذ')) return 'gold';
  return 'info';
}
