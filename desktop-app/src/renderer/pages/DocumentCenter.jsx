import React, { useCallback, useEffect, useState } from 'react';
import { FileSearch, FileText, HardDrive, RefreshCw, Search, Upload } from 'lucide-react';
import { Badge, Card, Empty, ErrorBanner, Loading } from '../components/ui.jsx';
import { errText, fmtDateTime, fmtNumber } from '../lib/format.js';

const PAGE_SIZE = 30;

function statusLabel(status) {
  return ({ staged: 'محفوظ للمراجعة', processing: 'جارٍ الاستخراج', extracted: 'مستخرج', review: 'بانتظار المراجعة', failed: 'فشل الاستخراج', unavailable: 'المحرك غير جاهز' })[status] ?? status;
}

function statusTone(status) {
  if (status === 'review' || status === 'extracted') return 'ok';
  if (status === 'failed') return 'bad';
  if (status === 'unavailable' || status === 'staged') return 'warn';
  return 'neutral';
}

export default function DocumentCenter({ notify, accessProfile = 'owner' }) {
  const [documents, setDocuments] = useState({ rows: [], total: 0, offset: 0, limit: PAGE_SIZE });
  const [selected, setSelected] = useState(null);
  const [ragflow, setRagflow] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState('');
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [searchMode, setSearchMode] = useState('knowledge');
  const [results, setResults] = useState(null);
  const [apiKey, setApiKey] = useState('');
  const [datasetIds, setDatasetIds] = useState('');
  const [savingConfig, setSavingConfig] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [page, service] = await Promise.all([window.localApp.documents({ offset: documents.offset, limit: PAGE_SIZE }), window.localApp.ragflowStatus()]);
      if (page?.restricted || service?.restricted) throw new Error('مركز الوثائق متاح في وضع المالك فقط.');
      setDocuments(page);
      setRagflow(service);
      if (selected?.document?.id) {
        const details = await window.localApp.document(selected.document.id);
        setSelected(details);
      }
    } catch (cause) {
      setError(errText(cause) || 'تعذر تحميل مركز الوثائق.');
    } finally {
      setLoading(false);
    }
  }, [documents.offset, selected?.document?.id]);

  useEffect(() => { load(); }, [load]);

  const stage = async () => {
    setError('');
    try {
      const result = await window.localApp.stageDocument();
      if (!result?.canceled) {
        notify?.({ tone: result?.duplicate ? 'warn' : 'ok', message: result?.duplicate ? 'هذه الوثيقة محفوظة مسبقًا؛ لم تُنشأ نسخة أخرى.' : 'حُفظ الأصل داخل قاعدة البيانات المحلية المشفرة.' });
        setDocuments(current => ({ ...current, offset: 0 }));
        setSelected(null);
        await load();
      }
    } catch (cause) { setError(errText(cause) || 'تعذر حفظ الوثيقة.'); }
  };

  const openDocument = async (documentId) => {
    setError('');
    try { setSelected(await window.localApp.document(documentId)); }
    catch (cause) { setError(errText(cause) || 'تعذر فتح الوثيقة.'); }
  };

  const extract = async (documentId) => {
    setBusyId(documentId);
    setError('');
    try {
      const result = await window.localApp.extractDocument(documentId);
      notify?.({ tone: 'ok', message: `اكتمل الاستخراج المحلي: ${fmtNumber(result.elementCount, 0)} عنصر. البيانات تنتظر مراجعتك.` });
      await load();
    } catch (cause) {
      setError(errText(cause) || 'تعذر استخراج الوثيقة. الأصل محفوظ كما هو.');
      await load();
    } finally { setBusyId(''); }
  };

  const indexDocument = async (documentId) => {
    setBusyId(documentId);
    setError('');
    try {
      const result = await window.localApp.indexDocumentInRagflow(documentId);
      notify?.({ tone: 'ok', message: `أُرسلت الوثيقة إلى خدمة البحث المحلية في ${fmtNumber(result.results.length, 0)} مجموعة. ستظهر بعد انتهاء الفهرسة.` });
      await load();
    } catch (cause) { setError(errText(cause) || 'تعذرت فهرسة الوثيقة.'); }
    finally { setBusyId(''); }
  };

  const syncIndexStatus = async (documentId) => {
    setBusyId(documentId);
    setError('');
    try {
      const result = await window.localApp.syncDocumentIndexStatus(documentId);
      const failures = result.results.filter(reference => reference.error).length;
      await load();
      notify?.({ tone: failures ? 'warn' : 'ok', message: failures ? `تعذر فحص ${fmtNumber(failures, 0)} مرجع فهرسة محلي.` : `تم فحص حالة ${fmtNumber(result.results.length, 0)} مرجع فهرسة محلي.` });
    } catch (cause) { setError(errText(cause) || 'تعذر فحص حالة الفهرسة.'); }
    finally { setBusyId(''); }
  };

  const saveConfig = async (event) => {
    event.preventDefault();
    setSavingConfig(true);
    setError('');
    try {
      const ids = datasetIds.split(/[\s,،]+/).map(value => value.trim()).filter(Boolean);
      await window.localApp.saveRagflowConfig({ apiKey, datasetIds: ids });
      setApiKey('');
      await load();
      notify?.({ tone: 'ok', message: 'حُفظ مفتاح الاتصال مشفرًا بواسطة نظام التشغيل.' });
    } catch (cause) { setError(errText(cause) || 'تعذر حفظ إعدادات البحث.'); }
    finally { setSavingConfig(false); }
  };

  const search = async (event) => {
    event.preventDefault();
    setError('');
    setResults(null);
    try {
      const result = searchMode === 'knowledge'
        ? await window.localApp.searchKnowledge({ question: query, limit: 10 })
        : await window.localApp.searchDocuments({ query, limit: 20 });
      setResults(result);
    } catch (cause) { setError(errText(cause) || 'تعذر تنفيذ البحث.'); }
  };

  const rows = documents.rows ?? [];
  const totalPages = Math.max(1, Math.ceil((documents.total ?? 0) / PAGE_SIZE));
  const page = Math.floor((documents.offset ?? 0) / PAGE_SIZE) + 1;

  if (accessProfile !== 'owner') return <Card title="مركز الوثائق" icon={FileSearch}><div className="quote">محتوى الوثائق والبحث متاح في وضع المالك فقط.</div></Card>;

  return (
    <>
      <Card title="مركز الوثائق والبحث المعرفي" subtitle="احفظ الوثائق محليًا، واستخرج محتواها للمراجعة، أو ابحث عن أدلة نصية داخل خدمة RAGFlow المحلية. لا تُرحّل مخرجات الاستخراج تلقائيًا إلى بيانات التنمية المعتمدة." icon={FileSearch}
        actions={<button className="btn small primary" onClick={stage}><Upload size={15} /> إضافة وثيقة</button>}>
        <div className="stat-strip">
          <div className="mini-stat"><strong>{fmtNumber(documents.total ?? 0, 0)}</strong><span>وثيقة أصلية محفوظة</span></div>
          <div className="mini-stat"><strong>{ragflow?.available ? 'متصلة محليًا' : 'غير متاحة'}</strong><span>خدمة RAGFlow · لا اتصال سحابي</span></div>
          <div className="mini-stat"><strong>{ragflow?.generation === 'disabled' ? 'متوقف' : '—'}</strong><span>توليد إجابات بالنموذج اللغوي</span></div>
        </div>
        {ragflow?.error && <div className="quote" role="status">خدمة البحث المحلية غير متاحة حاليًا: {ragflow.error}</div>}
      </Card>

      {error && <ErrorBanner message={error} onDismiss={() => setError('')} />}

      <Card title="تهيئة البحث المحلي" subtitle="أدخل مفتاح API ومعرّف مجموعة RAGFlow تعمل على هذا الجهاز. يُحفظ المفتاح مشفرًا، ولا ترسل الوثائق إلى خدمة خارج الجهاز." icon={HardDrive}>
        <form className="grid-2" onSubmit={saveConfig}>
          <label className="stack tight"><span>مفتاح API المحلي</span><input className="input" type="password" autoComplete="new-password" value={apiKey} onChange={event => setApiKey(event.target.value)} placeholder={ragflow?.configured ? 'مفتاح محفوظ؛ أدخل مفتاحًا جديدًا للاستبدال' : 'Bearer API key من خدمة RAGFlow المحلية'} /></label>
          <label className="stack tight"><span>معرّف مجموعة المستندات (32 خانة hex)</span><input className="input" value={datasetIds} onChange={event => setDatasetIds(event.target.value)} placeholder="معرف المجموعة المحلية" /></label>
          <div className="row" style={{ gridColumn: '1 / -1' }}><button className="btn small primary" type="submit" disabled={savingConfig || !apiKey.trim() || !datasetIds.trim()}>{savingConfig ? 'جارٍ الحفظ...' : 'حفظ إعدادات البحث'}</button><button className="btn small ghost" type="button" onClick={load} disabled={loading}><RefreshCw size={14} /> فحص الخدمة</button></div>
        </form>
      </Card>

      <Card title="البحث في الوثائق" subtitle="تظهر مقتطفات المصدر التي أعادها محرك البحث؛ لا ينشئ النظام إجابات أو استشهادات من عنده." icon={Search}>
        <form className="stack" onSubmit={search}>
          <div className="grid-2" style={{ alignItems: 'end' }}>
            <label className="stack tight"><span>سؤال أو عبارة للبحث</span><input className="input" value={query} onChange={event => setQuery(event.target.value)} maxLength={500} placeholder="مثال: معوقات مشاريع المياه في مديرية معينة" /></label>
            <label className="stack tight"><span>مصدر البحث</span><select className="input" value={searchMode} onChange={event => setSearchMode(event.target.value)}><option value="knowledge">بحث RAGFlow المحلي</option><option value="literal">مطابقة نصية حرفية محلية</option></select></label>
          </div>
          <div className="row"><button className="btn small primary" type="submit" disabled={query.trim().length < 2 || (searchMode === 'knowledge' && !ragflow?.configured)}><Search size={14} /> بحث</button>{searchMode === 'literal' && <span className="muted">مطابقة حرفية للنص المستخرج فقط؛ ليست بحثًا دلاليًا.</span>}</div>
        </form>
        {results && <div className="stack" style={{ marginTop: 16 }}>
          <strong>{results.rows?.length ? `المقاطع المسترجعة: ${fmtNumber(results.rows.length, 0)}` : 'لا توجد مقاطع مطابقة ضمن الوثائق المتاحة.'}</strong>
          {(results.rows ?? []).map((item, index) => <article className="quote stack tight" key={item.element_id ?? `${item.documentId}-${index}`}>
            <div className="chip-row"><Badge tone="neutral">{item.documentName ?? item.file_name ?? 'وثيقة'}</Badge>{item.page_number && <Badge tone="neutral">الصفحة {fmtNumber(item.page_number, 0)}</Badge>}{item.similarity !== null && item.similarity !== undefined && <Badge tone="neutral">درجة الاسترجاع {Number(item.similarity).toFixed(3)}</Badge>}</div>
            <p>{item.content}</p>
            {item.sha256 && <span className="muted">SHA-256: {item.sha256}</span>}
            {item.positions?.length > 0 && <span className="muted">مواضع المقطع: {JSON.stringify(item.positions).slice(0, 500)}</span>}
          </article>)}
        </div>}
      </Card>

      <Card title="الوثائق المحفوظة" subtitle="الأصل محفوظ داخل قاعدة البيانات المشفرة. معالجة PDF/Word والصور اختيارية وتتطلب تجهيز محركاتها المحلية." actions={<button className="btn small ghost" onClick={load} disabled={loading}><RefreshCw size={14} /> تحديث</button>}>
        {loading && !documents.rows ? <Loading /> : rows.length === 0 ? <Empty icon={FileText} title="لا توجد وثائق بعد" hint="أضف ملف PDF أو Word بصيغة DOCX أو صورة لبدء المكتبة المحلية." /> : <div className="stack">
          {rows.map(document => <article className="quote stack tight" key={document.id}>
            <div className="row between" style={{ flexWrap: 'wrap' }}>
              <button className="btn small ghost" onClick={() => openDocument(document.id)}><FileText size={14} />{document.file_name}</button>
              <div className="chip-row"><Badge tone={statusTone(document.status)}>{statusLabel(document.status)}</Badge><span className="muted">{fmtNumber(document.file_size, 0)} بايت · {fmtDateTime(document.created_at)}</span></div>
            </div>
            <div className="row" style={{ flexWrap: 'wrap' }}>
              <button className="btn small ghost" onClick={() => extract(document.id)} disabled={busyId === document.id}>{busyId === document.id ? 'جارٍ المعالجة...' : 'استخراج محلي ومراجعة'}</button>
              <button className="btn small ghost" onClick={() => indexDocument(document.id)} disabled={busyId === document.id || !ragflow?.configured}>{busyId === document.id ? 'جارٍ الإرسال...' : 'إرسال إلى البحث المحلي'}</button>
              <span className="muted">SHA-256: {document.sha256}</span>
            </div>
            {document.processing_error && <span className="muted">آخر حالة للمحرك: {document.processing_error}</span>}
          </article>)}
          <div className="row between"><span className="muted">صفحة {page} من {totalPages}</span><div className="btn-row"><button className="btn small ghost" disabled={loading || documents.offset === 0} onClick={() => setDocuments(current => ({ ...current, offset: Math.max(0, current.offset - PAGE_SIZE) }))}>السابق</button><button className="btn small ghost" disabled={loading || documents.offset + rows.length >= documents.total} onClick={() => setDocuments(current => ({ ...current, offset: current.offset + PAGE_SIZE }))}>التالي</button></div></div>
        </div>}
      </Card>

      {selected && <Card title={`مراجعة: ${selected.document.file_name}`} subtitle={`الأصل SHA-256: ${selected.document.sha256} · المحرك: ${selected.document.engine_name ?? 'لم يُشغّل'} ${selected.document.engine_version ?? ''}`} actions={selected.ragflowReferences?.length > 0 ? <button className="btn small ghost" onClick={() => syncIndexStatus(selected.document.id)} disabled={busyId === selected.document.id || !ragflow?.configured}><RefreshCw size={14} /> فحص حالة الفهرسة</button> : null}>
        {selected.document.processing_error && <div className="quote">{selected.document.processing_error}</div>}
        {(selected.artifacts ?? []).map(artifact => artifact.artifact_type === 'markdown' ? <details key={artifact.artifact_type}><summary>النص Markdown المستخرج (للمراجعة فقط)</summary><pre style={{ whiteSpace: 'pre-wrap', maxHeight: 500, overflow: 'auto' }}>{artifact.content}</pre></details> : <details key={artifact.artifact_type}><summary>بيانات {artifact.artifact_type}</summary><pre style={{ whiteSpace: 'pre-wrap', maxHeight: 500, overflow: 'auto' }}>{artifact.content.slice(0, 20000)}</pre></details>)}
        <div className="stack" style={{ marginTop: 16 }}>{(selected.elements ?? []).map(element => <article className="quote" key={element.id}><div className="chip-row"><Badge>{element.element_type}</Badge>{element.page_number && <Badge>صفحة {element.page_number}</Badge>}{element.confidence !== null && <Badge>ثقة OCR {Number(element.confidence).toFixed(3)}</Badge>}</div>{element.heading && <strong>{element.heading}</strong>}<p>{element.content}</p><span className="muted">مصدر العنصر: {element.source_json}</span></article>)}</div>
        {(selected.ragflowReferences ?? []).map(reference => <div className="muted" key={reference.dataset_id}>RAGFlow {reference.dataset_id}: {reference.status} · {fmtDateTime(reference.updated_at)}</div>)}
      </Card>}
    </>
  );
}
