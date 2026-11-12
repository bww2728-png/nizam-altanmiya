import React, { useCallback, useEffect, useState } from 'react';
import { Briefcase, Plus, RefreshCw, Search } from 'lucide-react';
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
  const [references, setReferences] = useState({ geographicUnits: [], sectors: [] });
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorBusy, setEditorBusy] = useState(false);
  const [editorError, setEditorError] = useState('');
  const [form, setForm] = useState(emptyProjectForm());
  const [fundingForm, setFundingForm] = useState({ partner_name: '', amount: '', currency_code: '', funding_date: '' });
  const [fundingError, setFundingError] = useState('');
  const [fundingBusy, setFundingBusy] = useState(false);
  const [attachmentBusy, setAttachmentBusy] = useState(false);
  const [exportingAttachmentId, setExportingAttachmentId] = useState(null);
  const [qualityResolutions, setQualityResolutions] = useState({});
  const [qualityBusyId, setQualityBusyId] = useState(null);

  useEffect(() => {
    window.localApp.canonicalProjectReferences()
      .then(result => setReferences(result ?? { geographicUnits: [], sectors: [] }))
      .catch(cause => setEditorError(errText(cause) || 'تعذر تحميل المراجع.'));
  }, []);

  const openEditor = (project = null) => {
    setForm(project ? {
      id: project.id,
      name: project.name ?? '',
      code: project.code ?? '',
      description: project.description ?? '',
      status: project.status ?? 'draft',
      estimated_cost: project.estimated_cost ?? '',
      actual_cost: project.actual_cost ?? '',
      currency_code: project.currency_code ?? '',
      start_date: project.start_date ?? '',
      end_date: project.end_date ?? '',
      geographic_unit_id: project.geographic_unit_id ?? '',
      sector_id: project.sector_id ?? '',
    } : emptyProjectForm());
    setEditorError('');
    setEditorOpen(true);
  };

  const saveProject = async (event) => {
    event.preventDefault();
    setEditorBusy(true);
    setEditorError('');
    try {
      const result = await window.localApp.saveCanonicalProject(form);
      setEditorOpen(false);
      notify?.({ tone: 'ok', message: result.action === 'created' ? 'تم إنشاء المشروع وحفظ مصدر الإدخال.' : 'تم تحديث المشروع وحفظ نسخة سابقة.' });
      await load();
      if (selectedId) setDetail(await window.localApp.canonicalProject(selectedId));
    } catch (cause) {
      setEditorError(errText(cause) || 'تعذر حفظ المشروع.');
    } finally {
      setEditorBusy(false);
    }
  };

  const saveFunding = async (event) => {
    event.preventDefault();
    if (!selectedId) return;
    setFundingBusy(true);
    setFundingError('');
    try {
      await window.localApp.addProjectFunding({ projectId: selectedId, ...fundingForm });
      setFundingForm({ partner_name: '', amount: '', currency_code: '', funding_date: '' });
      setDetail(await window.localApp.canonicalProject(selectedId));
      await load();
      notify?.({ tone: 'ok', message: 'تم تسجيل التمويل ومصدره.' });
    } catch (cause) {
      setFundingError(errText(cause) || 'تعذر تسجيل التمويل.');
    } finally {
      setFundingBusy(false);
    }
  };

  const addAttachment = async () => {
    if (!selectedId) return;
    setAttachmentBusy(true);
    try {
      const result = await window.localApp.addProjectAttachment(selectedId);
      if (!result?.canceled) {
        setDetail(await window.localApp.canonicalProject(selectedId));
        await load();
        notify?.({ tone: 'ok', message: 'تم حفظ المرفق داخل قاعدة البيانات المحلية غير المشفّرة.' });
      }
    } catch (cause) {
      notify?.({ tone: 'bad', message: errText(cause) || 'تعذر إضافة المرفق.' });
    } finally {
      setAttachmentBusy(false);
    }
  };

  const exportAttachment = async attachment => {
    if (!selectedId) return;
    setExportingAttachmentId(attachment.id);
    try {
      const result = await window.localApp.exportProjectAttachment({ projectId: selectedId, attachmentId: attachment.id });
      if (!result?.canceled) notify?.({ tone: 'ok', message: 'حُفظت نسخة من المرفق: ' + result.filePath });
    } catch (cause) {
      notify?.({ tone: 'bad', message: errText(cause) || 'تعذر تصدير المرفق.' });
    } finally {
      setExportingAttachmentId(null);
    }
  };

  const resolveIssue = async (issueId) => {
    if (!selectedId) return;
    setQualityBusyId(issueId);
    try {
      await window.localApp.resolveProjectQualityIssue({
        projectId: selectedId,
        issueId,
        resolution: qualityResolutions[issueId] ?? '',
      });
      setDetail(await window.localApp.canonicalProject(selectedId));
      setQualityResolutions(current => ({ ...current, [issueId]: '' }));
      await load();
      notify?.({ tone: 'ok', message: 'تم تسوية الملاحظة وحفظ سبب القرار.' });
    } catch (cause) {
      notify?.({ tone: 'bad', message: errText(cause) || 'تعذر تسوية الملاحظة.' });
    } finally {
      setQualityBusyId(null);
    }
  };

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

  const editProject = async (id) => {
    try {
      const result = await window.localApp.canonicalProject(id);
      openEditor(result.project);
    } catch (cause) {
      setError(errText(cause) || 'تعذر تحميل بيانات المشروع للتحرير.');
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
        icon={Briefcase}
        actions={(
          <div className="btn-row">
            <button className="btn small primary" onClick={() => openEditor()} disabled={restricted}>
              <Plus size={14} /> مشروع جديد
            </button>
            <button className="btn small ghost" onClick={load} disabled={loading}>
              <RefreshCw size={14} /> تحديث
            </button>
          </div>
        )}
      >
        {restricted ? (
          <div className="quote">
            <strong>البيانات المالية والمصدرية محجوبة في العرض والتصدير</strong>
            <p className="muted">انتقل إلى وضع المالك لعرض المشاريع وتكاليفها وتمويلها ومعلومات المصدر. هذا الحجب يخص العرض والتصدير فقط، وليس حماية للملف.</p>
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
              icon={Briefcase}
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
                        <td>
                          <div className="btn-row">
                            <button className="btn small ghost" onClick={() => editProject(row.id)}>تعديل</button>
                            <button className="btn small ghost" onClick={() => openDetails(row.id)}>التفاصيل</button>
                          </div>
                        </td>
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
        <Card title="بيانات المشروع ومصدرها" subtitle="الإدخال اليدوي والتمويل والمرفقات وتسوية ملاحظات المشروع تحفظ المصدر وسجل التغيير.">
          <div className="chip-row">
            <span className="chip">البيانات محفوظة في قاعدة المشاريع المعيارية</span>
            <span className="chip">مصدر وموضع الصف محفوظان عند الاستيراد</span>
            <span className="chip">التكاليف والتمويل بعملة صريحة</span>
            <span className="chip">تسوية الملاحظة تسجل سبب القرار وتاريخه</span>
          </div>
        </Card>
      )}

      <Modal
        open={editorOpen}
        title={form.id ? 'تعديل بيانات المشروع' : 'إضافة مشروع يدويًا'}
        subtitle="الحقول المقدمة تمر بالتحقق نفسه في الباكند، ويحفظ النظام مصدر الإدخال وتاريخ التعديل."
        onClose={() => { if (!editorBusy) setEditorOpen(false); }}
        wide
        footer={(
          <div className="btn-row">
            <button className="btn ghost" type="button" onClick={() => setEditorOpen(false)} disabled={editorBusy}>إلغاء</button>
            <button className="btn primary" type="submit" form="canonical-project-form" disabled={editorBusy}>{editorBusy ? 'جارٍ الحفظ...' : 'حفظ المشروع'}</button>
          </div>
        )}
      >
        <form id="canonical-project-form" className="stack" onSubmit={saveProject}>
          {editorError && <ErrorBanner message={editorError} onDismiss={() => setEditorError('')} />}
          <div className="grid-2">
            <label className="stack tight"><span>اسم المشروع *</span><input className="input" required maxLength={240} value={form.name} onChange={event => setForm(current => ({ ...current, name: event.target.value }))} /></label>
            <label className="stack tight"><span>رمز المشروع</span><input className="input" maxLength={80} value={form.code} onChange={event => setForm(current => ({ ...current, code: event.target.value }))} /></label>
            <label className="stack tight"><span>الحالة</span><input className="input" maxLength={80} value={form.status} onChange={event => setForm(current => ({ ...current, status: event.target.value }))} /></label>
            <label className="stack tight"><span>رمز العملة (مثل USD)</span><input className="input" maxLength={3} value={form.currency_code} onChange={event => setForm(current => ({ ...current, currency_code: event.target.value }))} /></label>
            <label className="stack tight"><span>التكلفة التقديرية</span><input className="input" type="number" min="0" step="any" value={form.estimated_cost} onChange={event => setForm(current => ({ ...current, estimated_cost: event.target.value }))} /></label>
            <label className="stack tight"><span>التكلفة الفعلية</span><input className="input" type="number" min="0" step="any" value={form.actual_cost} onChange={event => setForm(current => ({ ...current, actual_cost: event.target.value }))} /></label>
            <label className="stack tight"><span>تاريخ البداية</span><input className="input" type="date" value={form.start_date} onChange={event => setForm(current => ({ ...current, start_date: event.target.value }))} /></label>
            <label className="stack tight"><span>تاريخ النهاية</span><input className="input" type="date" value={form.end_date} onChange={event => setForm(current => ({ ...current, end_date: event.target.value }))} /></label>
            <label className="stack tight"><span>الموقع الجغرافي</span><select className="input" value={form.geographic_unit_id} onChange={event => setForm(current => ({ ...current, geographic_unit_id: event.target.value }))}>
              <option value="">غير مربوط</option>{references.geographicUnits.map(unit => <option key={unit.id} value={unit.id}>{unit.name} · {unit.unit_type}</option>)}
            </select></label>
            <label className="stack tight"><span>القطاع</span><select className="input" value={form.sector_id} onChange={event => setForm(current => ({ ...current, sector_id: event.target.value }))}>
              <option value="">غير محدد</option>{references.sectors.map(sector => <option key={sector.id} value={sector.id}>{sector.name_ar}</option>)}
            </select></label>
          </div>
          <label className="stack tight"><span>وصف المشروع</span><textarea className="input" rows={4} maxLength={4000} value={form.description} onChange={event => setForm(current => ({ ...current, description: event.target.value }))} /></label>
        </form>
      </Modal>

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
              <form className="grid-2" onSubmit={saveFunding}>
                <label className="stack tight"><span>جهة التمويل *</span><input className="input" maxLength={240} required value={fundingForm.partner_name} onChange={event => setFundingForm(current => ({ ...current, partner_name: event.target.value }))} /></label>
                <label className="stack tight"><span>المبلغ</span><input className="input" type="number" min="0" step="any" value={fundingForm.amount} onChange={event => setFundingForm(current => ({ ...current, amount: event.target.value }))} /></label>
                <label className="stack tight"><span>العملة</span><input className="input" maxLength={3} value={fundingForm.currency_code} onChange={event => setFundingForm(current => ({ ...current, currency_code: event.target.value.toUpperCase() }))} /></label>
                <label className="stack tight"><span>تاريخ التمويل</span><input className="input" type="date" value={fundingForm.funding_date} onChange={event => setFundingForm(current => ({ ...current, funding_date: event.target.value }))} /></label>
                <div className="row"><button className="btn small primary" type="submit" disabled={fundingBusy}>{fundingBusy ? 'جارٍ الحفظ...' : 'إضافة تمويل'}</button></div>
              </form>
              {fundingError && <ErrorBanner message={fundingError} onDismiss={() => setFundingError('')} />}
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
              <div className="row between">
                <strong>المرفقات</strong>
                <button className="btn small ghost" onClick={addAttachment} disabled={attachmentBusy}>{attachmentBusy ? 'جارٍ الحفظ...' : 'إرفاق صورة أو PDF'}</button>
              </div>
              {detail.attachments?.length
                ? detail.attachments.map(attachment => (
                  <div className="quote" key={attachment.id}>
                    <strong>{attachment.original_name}</strong>
                    <span className="muted">{attachment.mime_type} · {fmtNumber(attachment.size_bytes, 0)} بايت · {fmtDateTime(attachment.created_at)}</span>
                    <div className="row between" style={{ flexWrap: 'wrap' }}><span className="muted" style={{ fontSize: '0.76rem' }}>SHA-256: {attachment.sha256}</span><button className="btn small ghost" onClick={() => exportAttachment(attachment)} disabled={exportingAttachmentId === attachment.id}>{exportingAttachmentId === attachment.id ? 'جارٍ التصدير...' : 'حفظ نسخة'}</button></div>
                  </div>
                ))
                : <span className="muted">لا توجد مرفقات مرتبطة بهذا المشروع.</span>}
              <span className="muted">تُحفظ المحتويات داخل قاعدة البيانات المحلية غير المشفّرة ولا تُعرض أو تُرسل عبر الشبكة.</span>
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
                  {issue.status === 'open' ? (
                    <div className="stack tight">
                      <label className="stack tight"><span>سبب التسوية</span><textarea className="input" rows={2} maxLength={1000} value={qualityResolutions[issue.id] ?? ''} onChange={event => setQualityResolutions(current => ({ ...current, [issue.id]: event.target.value }))} /></label>
                      <div className="row"><button className="btn small primary" onClick={() => resolveIssue(issue.id)} disabled={qualityBusyId === issue.id || !(qualityResolutions[issue.id] ?? '').trim()}>{qualityBusyId === issue.id ? 'جارٍ التسوية...' : 'تسوية الملاحظة'}</button></div>
                    </div>
                  ) : (
                    <div className="muted">سبب التسوية: {issue.resolution || 'غير مسجل'} · {fmtDateTime(issue.resolved_at)}</div>
                  )}
                </div>
              ))}
            </div>

            <div className="stack tight">
              <strong>سجل التعديلات</strong>
              {detail.versions?.length
                ? detail.versions.map(version => <span className="muted" key={version.id}>{version.action} · {fmtDateTime(version.created_at)} · مصدر #{version.source_id}</span>)
                : <span className="muted">لا توجد نسخ محفوظة.</span>}
            </div>

            <div className="row between">
              <span className="muted">التعديلات اليدوية تسجل نسخة سابقة ولا تمس بيانات التمويل المرتبطة.</span>
              <button className="btn primary" onClick={() => editProject(detail.project.id)}>تحرير هذا المشروع</button>
            </div>
          </div>
        ) : null}
      </Modal>
    </>
  );
}

function emptyProjectForm() {
  return {
    name: '', code: '', description: '', status: 'draft', estimated_cost: '', actual_cost: '',
    currency_code: '', start_date: '', end_date: '', geographic_unit_id: '', sector_id: '',
  };
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
