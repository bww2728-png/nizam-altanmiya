import React, { useCallback, useEffect, useState } from 'react';
import { FileSearch, FileSpreadsheet, FileText, RefreshCw, Search, Upload } from 'lucide-react';
import { Badge, Card, Empty, ErrorBanner, Loading } from '../components/ui.jsx';
import { errText, fmtDateTime, fmtNumber } from '../lib/format.js';
import DocumentCenter from './DocumentCenter.jsx';
import ImportPage from './Import.jsx';

const PAGE_SIZE = 50;

function statusLabel(status) {
  return ({ staged: 'محفوظ للمراجعة', processing: 'جارٍ الفحص', extracted: 'تم الفحص', review: 'بانتظار المراجعة', complete: 'اكتملت المراجعة', promoted: 'نُقلت بيانات بعد التأكيد', failed: 'تعذر الفحص', error: 'تعذر الفحص', unavailable: 'المعالجة غير متاحة', 'projects-review-required': 'بانتظار مراجعة المشاريع', 'indicators-review-required': 'بانتظار مراجعة المؤشرات' })[status] ?? status ?? 'محفوظ';
}

function statusTone(status) {
  if (['complete', 'promoted', 'extracted'].includes(status)) return 'ok';
  if (['failed', 'unavailable'].includes(status)) return 'bad';
  if (['staged', 'processing', 'review'].includes(status)) return 'warn';
  return 'neutral';
}

export default function DocumentsHub({ onNavigate, notify, onApplied, accessProfile }) {
  const [files, setFiles] = useState({ rows: [], total: 0, offset: 0 });
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const [query, setQuery] = useState('');

  const visibleFiles = (files.rows ?? []).filter(file => !query.trim() || `${file.fileName} ${file.fileType} ${statusLabel(file.status)}`.toLocaleLowerCase('ar').includes(query.trim().toLocaleLowerCase('ar')));

  const load = useCallback(async () => {
    if (accessProfile !== 'owner') return;
    setLoading(true);
    try {
      const result = await window.localApp.fileInbox({ offset: files.offset, limit: PAGE_SIZE });
      if (result?.restricted) throw new Error('إدارة الملفات متاحة في وضع المالك فقط.');
      setFiles(result);
      setError('');
    } catch (cause) {
      setError(errText(cause) || 'تعذر تحميل قائمة الملفات.');
    } finally {
      setLoading(false);
    }
  }, [accessProfile, files.offset]);

  useEffect(() => { load(); }, [load, refreshKey]);

  async function uploadWord() {
    setBusy(true);
    setError('');
    try {
      const result = await window.localApp.stageDocument({ type: 'word' });
      if (result?.canceled) return;
      notify?.({ tone: result?.duplicate ? 'warn' : 'success', message: result?.duplicate ? 'هذا الملف محفوظ بالفعل.' : 'حُفظ ملف Word للمراجعة.' });
      setFiles(current => ({ ...current, offset: 0 }));
      setRefreshKey(value => value + 1);
    } catch (cause) {
      setError(errText(cause) || 'تعذر حفظ ملف Word.');
    } finally {
      setBusy(false);
    }
  }

  function openFile(file) {
    setError('');
    setSelected(file);
  }

  function backToInbox() {
    setSelected(null);
    setRefreshKey(value => value + 1);
  }

  if (accessProfile !== 'owner') return <Card title="مركز الملفات" icon={FileSearch}><p className="field-hint">رفع الملفات ومراجعتها متاحان في وضع المالك فقط.</p></Card>;

  if (selected?.resourceType === 'document') return <DocumentCenter notify={notify} accessProfile={accessProfile}
    initialDocumentId={selected.resourceId} reviewOnly onBack={backToInbox} onUpdated={() => setRefreshKey(value => value + 1)} />;

  if (selected?.resourceType === 'workbook') return <ImportPage key={`batch-${selected.resourceId}`} onNavigate={onNavigate} notify={notify}
    onApplied={() => { onApplied?.(); setRefreshKey(value => value + 1); }} initialBatchId={selected.resourceId} onBack={backToInbox} />;

  return (
    <div className="stack">
      <Card title="مركز الملفات" subtitle="ارفع الملفات مرة واحدة، ثم افتح كل ملف لمراجعة محتواه قبل اعتماد أي بيانات." icon={FileSearch}>
        <div className="row between" style={{ flexWrap: 'wrap' }}>
          <div className="chip-row"><span className="chip">{fmtNumber(files.total, 0)} ملفاً محفوظاً</span><span className="field-hint">الرفع وحده لا يضيف بيانات إلى السجلات الرسمية.</span></div>
          <div className="btn-row">
            <button type="button" className="btn small primary" onClick={() => { setSelected({ resourceType: 'new-workbook' }); }} disabled={busy}><FileSpreadsheet size={15} /> رفع Excel</button>
            <button type="button" className="btn small" onClick={uploadWord} disabled={busy}><Upload size={15} /> رفع Word</button>
            <button type="button" className="btn small ghost" onClick={() => setRefreshKey(value => value + 1)} disabled={loading || busy}><RefreshCw size={15} /> تحديث</button>
          </div>
        </div>
      </Card>

      {error && <ErrorBanner message={error} onDismiss={() => setError('')} />}

      {selected?.resourceType === 'new-workbook' ? <ImportPage onNavigate={onNavigate} notify={notify}
        onApplied={() => { onApplied?.(); setRefreshKey(value => value + 1); }}
        onStaged={staging => { setFiles(current => ({ ...current, offset: 0 })); setSelected({ resourceType: 'workbook', resourceId: staging.batchId }); setRefreshKey(value => value + 1); }}
        onBack={backToInbox} /> : (
        <Card title="الملفات المرفوعة" subtitle="اختر ملفاً لفتح مراجعته الخاصة." icon={FileText} flush>
          {loading && !files.rows?.length ? <div style={{ padding: 20 }}><Loading label="جارٍ تحميل الملفات…" /></div>
            : files.rows?.length ? <div className="stack" style={{ padding: 12 }}>
              <label className="toolbar"><Search size={16} /><input className="input" value={query} onChange={event => setQuery(event.target.value)} placeholder="ابحث عن ملف باسمه أو نوعه أو حالته" aria-label="بحث في الملفات" /></label>
              {!visibleFiles.length && <p className="field-hint">لا توجد ملفات تطابق البحث الحالي.</p>}
              {visibleFiles.map(file => <article key={file.id} className="quote row between" style={{ flexWrap: 'wrap' }}>
                <div className="stack tight">
                  <button type="button" className="btn small ghost" onClick={() => openFile(file)}><FileText size={15} /> {file.fileName}</button>
                  <span className="muted">{file.fileType} · رُفع {fmtDateTime(file.createdAt)} · {fmtNumber(file.fileSize ?? 0, 0)} بايت</span>
                </div>
                <div className="chip-row"><Badge tone={statusTone(file.status)}>{statusLabel(file.status)}</Badge>
                  {file.resourceType === 'workbook' && <span className="muted">{fmtNumber(file.sheetCount ?? 0, 0)} أوراق · {fmtNumber(file.rowCount ?? 0, 0)} صفوف</span>}
                  <button type="button" className="btn small" onClick={() => openFile(file)}>فتح المراجعة</button>
                </div>
              </article>)}
              <div className="row between"><span className="muted">عرض {files.rows.length} من {fmtNumber(files.total, 0)}</span><div className="btn-row">
                <button type="button" className="btn small ghost" disabled={!files.offset || loading} onClick={() => setFiles(current => ({ ...current, offset: Math.max(0, current.offset - PAGE_SIZE) }))}>السابق</button>
                <button type="button" className="btn small ghost" disabled={files.offset + files.rows.length >= files.total || loading} onClick={() => setFiles(current => ({ ...current, offset: current.offset + PAGE_SIZE }))}>التالي</button>
              </div></div>
            </div> : <Empty icon={FileSearch} title="لا توجد ملفات محفوظة بعد" hint="ارفع ملف Excel أو Word؛ سيظهر هنا مع تاريخ رفعه وحالته." />}
        </Card>
      )}
    </div>
  );
}
