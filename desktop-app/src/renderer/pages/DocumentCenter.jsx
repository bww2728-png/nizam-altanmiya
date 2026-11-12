import React, { useCallback, useEffect, useState } from 'react';
import { Check, FileSearch, FileText, HardDrive, RefreshCw, Search, Upload } from 'lucide-react';
import { Badge, Card, Empty, ErrorBanner, Loading } from '../components/ui.jsx';
import { errText, fmtDateTime, fmtNumber } from '../lib/format.js';

const PAGE_SIZE = 30;

function compatibleFieldType(sourceType, targetType) {
  const normalize = type => {
    const value = String(type ?? '').trim().toLowerCase();
    if (['string','str','varchar','textual'].includes(value)) return 'text';
    if (['number','numeric','float','double','real'].includes(value)) return 'decimal';
    if (['int','long'].includes(value)) return 'integer';
    if (['bool'].includes(value)) return 'boolean';
    return value;
  };
  return normalize(sourceType) === normalize(targetType);
}

function statusLabel(status) {
  return ({ staged: 'محفوظ للمراجعة', processing: 'جارٍ الاستخراج', extracted: 'مستخرج', review: 'بانتظار المراجعة', failed: 'فشل الاستخراج', unavailable: 'المحرك غير جاهز' })[status] ?? status;
}

function statusTone(status) {
  if (status === 'review' || status === 'extracted') return 'ok';
  if (status === 'failed') return 'bad';
  if (status === 'unavailable' || status === 'staged') return 'warn';
  return 'neutral';
}

function candidateStatusLabel(status) {
  return ({ pending: 'بانتظار المراجعة', reviewed: 'رُوجع — غير معتمد رسميًا', rejected: 'مرفوض', no_evidence: 'لم يُعثر على دليل' })[status] ?? status;
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
  const [candidateValues, setCandidateValues] = useState({});
  const [candidateNotes, setCandidateNotes] = useState({});
  const [forms, setForms] = useState([]);
  const [geography, setGeography] = useState([]);
  const [periods, setPeriods] = useState([]);
  const [selectedCandidateIds, setSelectedCandidateIds] = useState({});
  const [candidateMappings, setCandidateMappings] = useState({});
  const [promotionFormVersionId, setPromotionFormVersionId] = useState('');
  const [promotionDefinition, setPromotionDefinition] = useState(null);
  const [promotionGeoUnitId, setPromotionGeoUnitId] = useState('');
  const [promotionPeriodId, setPromotionPeriodId] = useState('');
  const [promotionPeriodYear, setPromotionPeriodYear] = useState('');
  const [promotionRecordLabel, setPromotionRecordLabel] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [page, service, formRows, geographyResult, periodResult] = await Promise.all([
        window.localApp.documents({ offset: documents.offset, limit: PAGE_SIZE }),
        window.localApp.ragflowStatus(),
        window.localApp.dataForms(),
        window.localApp.dataGeography(''),
        window.localApp.dataPeriods(),
      ]);
      if (page?.restricted || service?.restricted) throw new Error('مركز الوثائق متاح في وضع المالك فقط.');
      setDocuments(page);
      setRagflow(service);
      setForms((formRows ?? []).filter(form => form.is_active && form.form_version_id && form.version_status === 'published'));
      setGeography(geographyResult?.rows ?? []);
      setPeriods(periodResult?.rows ?? []);
      if (selected?.document?.id) {
        const details = await window.localApp.document(selected.document.id);
        details.fieldReview = await window.localApp.documentFieldCandidates(selected.document.id);
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
    setSelectedCandidateIds({});
    setCandidateMappings({});
    setPromotionFormVersionId('');
    setPromotionDefinition(null);
    setPromotionGeoUnitId('');
    setPromotionPeriodId('');
    setPromotionPeriodYear('');
    setPromotionRecordLabel('');
    try {
      const details = await window.localApp.document(documentId);
      details.fieldReview = await window.localApp.documentFieldCandidates(documentId);
      setSelected(details);
    } catch (cause) { setError(errText(cause) || 'تعذر فتح الوثيقة.'); }
  };

  const reviewCandidate = async (candidate, status) => {
    setBusyId(selected.document.id);
    setError('');
    try {
      await window.localApp.reviewDocumentFieldCandidate({
        candidateId: candidate.id,
        status,
        value: status === 'reviewed' ? (candidateValues[candidate.id] ?? candidate.raw_value ?? '') : null,
        note: candidateNotes[candidate.id] ?? '',
      });
      const fieldReview = await window.localApp.documentFieldCandidates(selected.document.id);
      setSelected(current => ({ ...current, fieldReview }));
      notify?.({ tone: 'ok', message: status === 'reviewed' ? 'حُفظت نتيجة المراجعة كمرشح فقط؛ لم تتغير البيانات الرسمية.' : 'رُفض المرشح؛ لم تتغير البيانات الرسمية.' });
    } catch (cause) { setError(errText(cause) || 'تعذرت مراجعة المرشح.'); }
    finally { setBusyId(''); }
  };

  const choosePromotionForm = async (value) => {
    setPromotionFormVersionId(value);
    setPromotionDefinition(null);
    setCandidateMappings({});
    if (!value) return;
    try {
      const definition = await window.localApp.dataFormDefinition(Number(value));
      setPromotionDefinition(definition);
      const fields = new Map((definition.fields ?? []).map(field => [field.field_code,field]));
      const defaults = Object.fromEntries((selected?.fieldReview?.rows ?? [])
        .filter(candidate => candidate.review_status === 'reviewed' && !candidate.promoted_form_record_id)
        .filter(candidate => {
          const field = fields.get(candidate.field_code);
          return field && compatibleFieldType(candidate.data_type,field.data_type_override ?? field.data_type) && field.is_importable && !field.is_derived;
        })
        .map(candidate => [candidate.id,candidate.field_code]));
      setCandidateMappings(defaults);
    } catch (cause) { setError(errText(cause) || 'تعذر تحميل النموذج المستهدف.'); }
  };

  const promoteReviewedCandidates = async () => {
    const candidateIds = Object.entries(selectedCandidateIds).filter(([,checked]) => checked).map(([id]) => id);
    if (!selected?.document?.id || !promotionFormVersionId || candidateIds.length === 0) return;
    setBusyId(selected.document.id);
    setError('');
    try {
      const result = await window.localApp.promoteDocumentFieldCandidates({
        documentId:selected.document.id,
        formVersionId:Number(promotionFormVersionId),
        candidateIds,
        fieldMappings:Object.fromEntries(candidateIds.map(id => [id,candidateMappings[id] ?? ''])),
        geoUnitId:promotionGeoUnitId || null,
        periodId:promotionPeriodId || null,
        periodYear:promotionPeriodYear.trim() || null,
        recordLabel:promotionRecordLabel.trim() || selected.document.file_name,
      });
      notify?.({ tone:'ok',message:`أُنشئ السجل المعياري ${fmtNumber(result.formRecordId,0)} وأُرسل للمراجعة والاعتماد؛ لم يصبح معتمدًا بعد.` });
      setSelectedCandidateIds({});
      setPromotionRecordLabel('');
      await load();
    } catch (cause) { setError(errText(cause) || 'تعذر إنشاء السجل المعياري من المرشحين.'); }
    finally { setBusyId(''); }
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
  const reviewedCandidates = (selected?.fieldReview?.rows ?? []).filter(candidate => candidate.review_status === 'reviewed' && !candidate.promoted_form_record_id);
  const selectedPromotionCandidates = reviewedCandidates.filter(candidate => selectedCandidateIds[candidate.id]);
  const selectedTargetCodes = selectedPromotionCandidates.map(candidate => candidateMappings[candidate.id]).filter(Boolean);
  const missingRequiredFields = (promotionDefinition?.fields ?? []).filter(field => field.is_required && !selectedTargetCodes.includes(field.field_code));
  const selectedRequiresPeriod = selectedPromotionCandidates.some(candidate => promotionDefinition?.fields?.find(field => field.field_code === candidateMappings[candidate.id])?.storage_class === 'measurement');
  const hasPromotionPeriod = Boolean(promotionPeriodId || promotionPeriodYear);
  const hasUnmappedSelectedCandidates = selectedPromotionCandidates.some(candidate => !candidateMappings[candidate.id]);
  const totalPages = Math.max(1, Math.ceil((documents.total ?? 0) / PAGE_SIZE));
  const page = Math.floor((documents.offset ?? 0) / PAGE_SIZE) + 1;

  if (accessProfile !== 'owner') return <Card title="مركز الوثائق" icon={FileSearch}><div className="quote">محتوى الوثائق والبحث متاح في وضع المالك فقط.</div></Card>;

  return (
    <>
      <Card title="مركز الوثائق والبحث المعرفي" subtitle="احفظ الوثائق محليًا، واستخرج محتواها للمراجعة، أو ابحث عن أدلة نصية داخل محرك المعرفة المحلي. لا تُرحّل مخرجات الاستخراج تلقائيًا إلى بيانات التنمية المعتمدة." icon={FileSearch}
        actions={<button className="btn small primary" onClick={stage}><Upload size={15} /> إضافة وثيقة</button>}>
        <div className="stat-strip">
          <div className="mini-stat"><strong>{fmtNumber(documents.total ?? 0, 0)}</strong><span>وثيقة أصلية محفوظة</span></div>
          <div className="mini-stat"><strong>{ragflow?.available ? 'متصلة محليًا' : 'غير متاحة'}</strong><span>محرك المعرفة · اتصال محلي فقط</span></div>
          <div className="mini-stat"><strong>{ragflow?.generation === 'disabled' ? 'متوقف' : '—'}</strong><span>توليد إجابات بالنموذج اللغوي</span></div>
        </div>
      </Card>

      {error && <ErrorBanner message={error} onDismiss={() => setError('')} />}

      <Card title="حالة محرك البحث المحلي" subtitle="تعرض الشاشة حالة الاتصال فقط، ولا تطلب مفاتيح أو معرّفات تقنية من المستخدم." icon={HardDrive}>
        <div className="row between" style={{ flexWrap: 'wrap' }}>
          <div className="stack tight"><strong>{ragflow?.available ? 'متصل محليًا' : 'غير متاح حاليًا'}</strong><span className="muted">{ragflow?.configured ? 'الخدمة مهيأة على هذا الجهاز.' : 'لم يجهّز مسؤول النظام خدمة البحث بعد.'}</span></div>
          <button className="btn small ghost" type="button" onClick={load} disabled={loading}><RefreshCw size={14} /> فحص الخدمة</button>
        </div>
        {ragflow?.configured && !ragflow?.available && <div className="quote" role="status">تعذر الوصول إلى محرك البحث المحلي. يمكنك متابعة حفظ الوثائق واستخراجها والبحث النصي؛ لا يؤثر ذلك على قاعدة البيانات الأساسية.</div>}
      </Card>

      <Card title="البحث في الوثائق" subtitle="تظهر مقتطفات المصدر التي أعادها محرك البحث؛ لا ينشئ النظام إجابات أو استشهادات من عنده." icon={Search}>
        <form className="stack" onSubmit={search}>
          <div className="grid-2" style={{ alignItems: 'end' }}>
            <label className="stack tight"><span>سؤال أو عبارة للبحث</span><input className="input" value={query} onChange={event => setQuery(event.target.value)} maxLength={500} placeholder="مثال: معوقات مشاريع المياه في مديرية معينة" /></label>
            <label className="stack tight"><span>مصدر البحث</span><select className="input" value={searchMode} onChange={event => setSearchMode(event.target.value)}><option value="knowledge">بحث المعرفة الدلالي المحلي</option><option value="literal">مطابقة نصية حرفية محلية</option></select></label>
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

      <Card title="الوثائق المحفوظة" subtitle="الأصل محفوظ داخل قاعدة البيانات المشفرة. يُستخرج نص Word محليًا؛ أما PDF والصور فتحتاج إلى محركات معالجة محلية إضافية." actions={<button className="btn small ghost" onClick={load} disabled={loading}><RefreshCw size={14} /> تحديث</button>}>
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
        {selected.fieldReview?.run && <section className="stack" style={{ marginBottom: 18 }}>
          <div><h3>حقول مقترحة للمراجعة</h3><p className="muted">المقترحات مستخرجة من أدلة الوثائق فقط. مراجعتها هنا لا تعتمدها ولا تغيّر قاعدة البيانات الرسمية.</p>
            <div className="chip-row"><Badge>{fmtNumber(selected.fieldReview.run.searched_count, 0)} حقلاً جرى فحصه</Badge><Badge tone="ok">{fmtNumber(selected.fieldReview.run.evidence_count, 0)} دليلًا</Badge><Badge tone="neutral">{fmtNumber(selected.fieldReview.run.no_evidence_count, 0)} بلا دليل</Badge></div>
          </div>
          {(selected.fieldReview.rows ?? []).filter(candidate => candidate.review_status === 'pending').map(candidate => <article className="quote stack tight" key={candidate.id}>
            <div className="row between" style={{ flexWrap: 'wrap' }}><strong>{candidate.field_label_ar}</strong><Badge>{candidateStatusLabel(candidate.review_status)}</Badge></div>
            <div className="chip-row"><Badge>{candidate.entity_type} · {candidate.field_key}</Badge>{candidate.source_file_name && <Badge>{candidate.source_file_name}</Badge>}{candidate.page_number && <Badge>صفحة {fmtNumber(candidate.page_number, 0)}</Badge>}</div>
            {candidate.evidence_text && <p>{candidate.evidence_text}</p>}
            <label className="stack tight"><span>القيمة بعد التحقق من الدليل</span><input className="input" value={candidateValues[candidate.id] ?? candidate.raw_value ?? ''} onChange={event => setCandidateValues(current => ({ ...current, [candidate.id]: event.target.value }))} maxLength={1000} /></label>
            <label className="stack tight"><span>سبب قرار المراجعة (مطلوب)</span><input className="input" value={candidateNotes[candidate.id] ?? ''} onChange={event => setCandidateNotes(current => ({ ...current, [candidate.id]: event.target.value }))} maxLength={1000} /></label>
            <div className="row"><button className="btn small primary" onClick={() => reviewCandidate(candidate, 'reviewed')} disabled={busyId === selected.document.id || !(candidateNotes[candidate.id] ?? '').trim()}>تسجيل المراجعة</button><button className="btn small ghost" onClick={() => reviewCandidate(candidate, 'rejected')} disabled={busyId === selected.document.id || !(candidateNotes[candidate.id] ?? '').trim()}>رفض المرشح</button><span className="muted">لا يُرحّل إلى البيانات الرسمية تلقائيًا.</span></div>
          </article>)}
          {reviewedCandidates.length > 0 && <section className="stack" style={{ marginBottom: 18 }}>
            <div><h3>إنشاء سجل معياري من القيم المراجَعة</h3><p className="muted">اختر الحقول بعد التحقق من قيمها واربطها بنموذج منشور. سيُنشأ سجل «قيد المراجعة» فقط؛ لا تصبح القيم رسمية حتى يعتمدها المراجع في شاشة الإدخال المركزي.</p></div>
            <label className="stack tight"><span>النموذج المستهدف</span><select className="input" value={promotionFormVersionId} onChange={event => choosePromotionForm(event.target.value)}><option value="">— اختر نموذجًا منشورًا —</option>{forms.map(form => <option key={form.form_version_id} value={form.form_version_id}>{form.form_code} — {form.name_ar}</option>)}</select></label>
            {promotionFormVersionId && <form className="stack" onSubmit={event => { event.preventDefault(); promoteReviewedCandidates(); }}>
              {reviewedCandidates.map(candidate => {
                const compatibleFields = (promotionDefinition?.fields ?? []).filter(field => compatibleFieldType(candidate.data_type,field.data_type_override ?? field.data_type) && field.is_importable && !field.is_derived && field.storage_class !== 'ignored_derived');
                return <article className="quote stack tight" key={candidate.id}>
                  <label className="row"><input type="checkbox" checked={Boolean(selectedCandidateIds[candidate.id])} onChange={event => setSelectedCandidateIds(current => ({ ...current,[candidate.id]:event.target.checked }))} /><strong>{candidate.field_label_ar}</strong><Badge>{candidate.data_type}</Badge></label>
                  <label className="stack tight"><span>العمود/الحقل المعياري المطابق</span><select className="input" value={candidateMappings[candidate.id] ?? ''} onChange={event => setCandidateMappings(current => ({ ...current,[candidate.id]:event.target.value }))}><option value="">— اختر الحقل المطابق —</option>{compatibleFields.map(field => <option key={field.form_field_id} value={field.field_code}>{field.label_ar} · {field.field_code}</option>)}</select></label>
                  <div><span className="muted">القيمة المؤكدة: </span><strong>{candidate.reviewedValue?.value ?? '—'}</strong>{candidate.source_file_name && <span className="muted"> · المصدر: {candidate.source_file_name}{candidate.page_number ? `، صفحة ${fmtNumber(candidate.page_number,0)}` : ''}</span>}</div>
                </article>;
              })}
              <div className="grid-2" style={{ alignItems:'end' }}>
                <label className="stack tight"><span>الوحدة الجغرافية</span><select className="input" value={promotionGeoUnitId} onChange={event => setPromotionGeoUnitId(event.target.value)}><option value="">— دون ربط جغرافي —</option>{geography.filter(unit => unit.is_active).map(unit => <option key={unit.geo_unit_id} value={unit.geo_unit_id}>{unit.type_name_ar} — {unit.name_ar}{unit.parent_name_ar ? ` / ${unit.parent_name_ar}` : ''}</option>)}</select></label>
                <label className="stack tight"><span>الفترة المرجعية</span><select className="input" value={promotionPeriodId} onChange={event => { setPromotionPeriodId(event.target.value); setPromotionPeriodYear(''); }}><option value="">— فترة غير محددة —</option>{periods.map(period => <option key={period.period_id} value={period.period_id}>{period.label_ar}</option>)}</select></label>
                <label className="stack tight"><span>أو سنة ميلادية جديدة</span><input className="input" type="number" min="1900" max="2200" step="1" value={promotionPeriodYear} onChange={event => { setPromotionPeriodYear(event.target.value); setPromotionPeriodId(''); }} placeholder="2025" /></label>
                <label className="stack tight"><span>عنوان السجل</span><input className="input" value={promotionRecordLabel} onChange={event => setPromotionRecordLabel(event.target.value)} maxLength={240} placeholder={selected.document.file_name} /></label>
              </div>
              {selectedPromotionCandidates.length > 0 && missingRequiredFields.length > 0 && <div className="quote">النموذج يتطلب حقولًا لم تُربط بمرشحين مراجَعين: {missingRequiredFields.map(field => field.label_ar).join('، ')}.</div>}
              {selectedRequiresPeriod && !hasPromotionPeriod && <div className="quote">اختر فترة مرجعية أو سنة للقياسات المختارة.</div>}
              <button className="btn small primary" type="submit" disabled={busyId === selected.document.id || selectedPromotionCandidates.length === 0 || hasUnmappedSelectedCandidates || missingRequiredFields.length > 0 || (selectedRequiresPeriod && !hasPromotionPeriod)}><Check size={14} /> إنشاء السجل وإرساله للمراجعة ({fmtNumber(selectedPromotionCandidates.length,0)})</button>
            </form>}
          </section>}
          {(selected.fieldReview.rows ?? []).some(candidate => ['reviewed','rejected'].includes(candidate.review_status)) && <details><summary>قرارات المراجعة السابقة ({fmtNumber((selected.fieldReview.rows ?? []).filter(candidate => ['reviewed','rejected'].includes(candidate.review_status)).length, 0)})</summary><div className="stack" style={{ marginTop: 10 }}>{(selected.fieldReview.rows ?? []).filter(candidate => ['reviewed','rejected'].includes(candidate.review_status)).map(candidate => <article className="quote stack tight" key={candidate.id}><div className="row between"><strong>{candidate.field_label_ar}</strong><Badge>{candidateStatusLabel(candidate.review_status)}</Badge></div>{candidate.promoted_form_record_id && <Badge tone="ok">مرتبطة بالسجل المعياري {fmtNumber(candidate.promoted_form_record_id,0)}</Badge>}{candidate.reviewedValue?.value && <span>القيمة التي راجعها المستخدم: {candidate.reviewedValue.value}</span>}<span>السبب: {candidate.review_note}</span><span className="muted">المراجع: {candidate.reviewed_by ?? 'غير مسجل'} · {fmtDateTime(candidate.reviewed_at)}</span></article>)}</div></details>}
          {(selected.fieldReview.rows ?? []).some(candidate => candidate.review_status === 'no_evidence') && <details><summary>الحقول التي لم يظهر لها دليل ({fmtNumber((selected.fieldReview.rows ?? []).filter(candidate => candidate.review_status === 'no_evidence').length, 0)})</summary><div className="chip-row" style={{ marginTop: 10 }}>{(selected.fieldReview.rows ?? []).filter(candidate => candidate.review_status === 'no_evidence').map(candidate => <Badge key={candidate.id}>{candidate.field_label_ar}</Badge>)}</div></details>}
        </section>}
        {selected.fieldReview?.run?.status === 'failed' && <div className="quote">تعذر إنشاء قائمة المرشحين: {selected.fieldReview.run.error_text}</div>}
        {(selected.artifacts ?? []).map(artifact => artifact.artifact_type === 'markdown' ? <details key={artifact.artifact_type}><summary>النص Markdown المستخرج (للمراجعة فقط)</summary><pre style={{ whiteSpace: 'pre-wrap', maxHeight: 500, overflow: 'auto' }}>{artifact.content}</pre></details> : <details key={artifact.artifact_type}><summary>بيانات {artifact.artifact_type}</summary><pre style={{ whiteSpace: 'pre-wrap', maxHeight: 500, overflow: 'auto' }}>{artifact.content.slice(0, 20000)}</pre></details>)}
        <div className="stack" style={{ marginTop: 16 }}>{(selected.elements ?? []).map(element => <article className="quote" key={element.id}><div className="chip-row"><Badge>{element.element_type}</Badge>{element.page_number && <Badge>صفحة {element.page_number}</Badge>}{element.confidence !== null && <Badge>ثقة OCR {Number(element.confidence).toFixed(3)}</Badge>}</div>{element.heading && <strong>{element.heading}</strong>}<p>{element.content}</p><span className="muted">مصدر العنصر: {element.source_json}</span></article>)}</div>
        {(selected.ragflowReferences ?? []).map(reference => <div className="muted" key={reference.dataset_id}>حالة الفهرسة في محرك المعرفة: {reference.status} · {fmtDateTime(reference.updated_at)}</div>)}
      </Card>}
    </>
  );
}
