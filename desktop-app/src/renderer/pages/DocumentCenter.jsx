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

function candidateSourceLabel(candidate) {
  const source = candidate.sourceLocation?.source ?? {};
  const line = source.sheet_name ? `${source.sheet_name}!${(source.cells ?? []).map(cell => cell.address).join('، ')}`
    : source.table_number && source.row_number ? `جدول ${source.table_number} · صف ${source.row_number}`
      : source.row_number ? `صف ${source.row_number}`
        : candidate.page_number ? `الصفحة ${candidate.page_number}` : '';
  return [candidate.source_file_name,line].filter(Boolean).join(' · ') || 'موضع المصدر غير متاح';
}

function candidateGroupKey(candidate) {
  const source = candidate.sourceLocation?.source ?? {};
  const documentId = String(candidate.source_document_id ?? '');
  if (source.sheet_name && source.row_number) return `${documentId}:sheet:${source.sheet_name}:row:${source.row_number}`;
  if (source.table_number && source.row_number) return `${documentId}:table:${source.table_number}:row:${source.row_number}`;
  if (candidate.page_number) return `${documentId}:page:${candidate.page_number}`;
  return `${documentId}:document`;
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
  const [reviewFieldValues, setReviewFieldValues] = useState({});
  const [reviewNote, setReviewNote] = useState('');
  const [selectedReviewGroups, setSelectedReviewGroups] = useState({});
  const [selectedDomainCode, setSelectedDomainCode] = useState('');
  const [selectedGroupCode, setSelectedGroupCode] = useState('');
  const [selectedRecordKey, setSelectedRecordKey] = useState('');
  const [forms, setForms] = useState([]);
  const [catalog, setCatalog] = useState(null);
  const [geography, setGeography] = useState([]);
  const [periods, setPeriods] = useState([]);
  const [selectedCandidateIds, setSelectedCandidateIds] = useState({});
  const [candidateMappings, setCandidateMappings] = useState({});
  const [candidateDimensionValues, setCandidateDimensionValues] = useState({});
  const [promotionFormVersionId, setPromotionFormVersionId] = useState('');
  const [promotionDefinition, setPromotionDefinition] = useState(null);
  const [promotionGeoUnitId, setPromotionGeoUnitId] = useState('');
  const [promotionPeriodId, setPromotionPeriodId] = useState('');
  const [promotionPeriodYear, setPromotionPeriodYear] = useState('');
  const [promotionGroupContexts, setPromotionGroupContexts] = useState({});
  const [promotionRecordLabel, setPromotionRecordLabel] = useState('');
  const [submitForReview, setSubmitForReview] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [page, service, formRows, catalogResult, geographyResult, periodResult] = await Promise.all([
        window.localApp.documents({ offset: documents.offset, limit: PAGE_SIZE }),
        window.localApp.ragflowStatus(),
        window.localApp.dataForms(),
        window.localApp.dataEntryCatalog(),
        window.localApp.dataGeography(''),
        window.localApp.dataPeriods(),
      ]);
      if (page?.restricted || service?.restricted) throw new Error('مركز الوثائق متاح في وضع المالك فقط.');
      setDocuments(page);
      setRagflow(service);
      setForms((formRows ?? []).filter(form => form.is_active && form.form_version_id && form.version_status === 'published' && !form.form_code.startsWith('raw_collection_v1_')));
      setCatalog(catalogResult);
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
        notify?.({ tone: result?.duplicate ? 'warn' : 'ok', message: result?.duplicate ? 'هذه الوثيقة محفوظة مسبقًا؛ لم تُنشأ نسخة أخرى.' : 'حُفظ الأصل داخل قاعدة البيانات المحلية غير المشفّرة.' });
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
    setCandidateDimensionValues({});
    setPromotionFormVersionId('');
    setPromotionDefinition(null);
    setPromotionGeoUnitId('');
    setPromotionPeriodId('');
    setPromotionPeriodYear('');
    setPromotionGroupContexts({});
    setPromotionRecordLabel('');
    try {
      const details = await window.localApp.document(documentId);
      details.fieldReview = await window.localApp.documentFieldCandidates(documentId);
      setSelectedRecordKey(details.fieldReview.records?.[0]?.key ?? '');
      setSelectedDomainCode('');
      setSelectedGroupCode('');
      setSelected(details);
    } catch (cause) { setError(errText(cause) || 'تعذر فتح الوثيقة.'); }
  };

  const reviewFieldGroup = async (record, fieldGroup, status) => {
    const value = reviewFieldValues[`${record.key}:${fieldGroup.fieldCode}`] ?? fieldGroup.reviewedValue?.value ?? fieldGroup.recommendedValue;
    const selectedValueEvidence = fieldGroup.values.find(item => String(item.value) === String(value));
    const primaryCandidateId = selectedValueEvidence?.candidateIds?.[0] ?? fieldGroup.recommendedCandidateIds?.[0] ?? fieldGroup.candidates[0]?.id;
    const supportIds = status === 'reviewed'
      ? (selectedValueEvidence?.candidateIds ?? [primaryCandidateId]).filter(Boolean)
      : fieldGroup.candidates.map(candidate => candidate.id);
    setBusyId(selected.document.id);
    setError('');
    try {
      await window.localApp.reviewDocumentFieldCandidateGroups({
        documentId:selected.document.id,
        note:reviewNote,
        groups:[{
          status,candidateIds:fieldGroup.candidates.filter(candidate => candidate.review_status === 'pending').map(candidate => candidate.id),
          evidenceIds:supportIds.filter(id => fieldGroup.candidates.some(candidate => candidate.id === id && candidate.review_status === 'pending')),primaryCandidateId,value,
        }],
      });
      const fieldReview = await window.localApp.documentFieldCandidates(selected.document.id);
      setSelected(current => ({ ...current,fieldReview }));
      notify?.({ tone:'ok',message:status === 'reviewed' ? 'سُجل قرار الحقل مع تجميع أدلته؛ لم تتغير البيانات الرسمية.' : 'رُفضت أدلة الحقل؛ لم تتغير البيانات الرسمية.' });
    } catch (cause) { setError(errText(cause) || 'تعذرت مراجعة الحقل.'); }
    finally { setBusyId(''); }
  };

  const reviewSelectedFieldGroups = async (fieldGroups) => {
    const groups = fieldGroups.filter(({ record,fieldGroup }) => selectedReviewGroups[`${record.key}:${fieldGroup.fieldCode}`]);
    if (!groups.length || !reviewNote.trim()) return;
    setBusyId(selected.document.id);
    setError('');
    try {
      await window.localApp.reviewDocumentFieldCandidateGroups({
        documentId:selected.document.id,note:reviewNote,
        groups:groups.map(({ record,fieldGroup }) => {
          const key = `${record.key}:${fieldGroup.fieldCode}`;
          const value = reviewFieldValues[key] ?? fieldGroup.recommendedValue;
          const primaryCandidateId = fieldGroup.values.find(item => String(item.value) === String(value))?.candidateIds?.[0] ?? fieldGroup.candidates[0]?.id;
          const evidenceIds = fieldGroup.values.find(item => String(item.value) === String(value))?.candidateIds ?? [primaryCandidateId];
          return { status:'reviewed',candidateIds:fieldGroup.candidates.map(candidate => candidate.id),evidenceIds,primaryCandidateId,value };
        }),
      });
      const fieldReview = await window.localApp.documentFieldCandidates(selected.document.id);
      setSelected(current => ({ ...current,fieldReview }));
      setSelectedReviewGroups({});
      notify?.({ tone:'ok',message:`تمت مراجعة ${fmtNumber(groups.length,0)} حقول مع أدلتها؛ لم تتغير البيانات الرسمية.` });
    } catch (cause) { setError(errText(cause) || 'تعذرت المراجعة الجماعية.'); }
    finally { setBusyId(''); }
  };


  const choosePromotionForm = async (value) => {
    setPromotionFormVersionId(value);
    setPromotionDefinition(null);
    setCandidateMappings({});
    setCandidateDimensionValues({});
    setPromotionGroupContexts({});
    if (!value) return;
    try {
      const definition = await window.localApp.dataFormDefinition(Number(value));
      setPromotionDefinition(definition);
      const fields = new Map((definition.fields ?? []).map(field => [field.field_code,field]));
      const defaults = Object.fromEntries((selected?.fieldReview?.rows ?? [])
        .filter(candidate => candidate.review_status === 'reviewed' && !candidate.promoted_form_record_id)
        .filter(candidate => !candidate.reviewedValue?.primaryCandidateId || candidate.reviewedValue.primaryCandidateId === candidate.id)
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
      const candidateGroups = selectedCandidateGroups.map(group => {
        const context = promotionGroupContexts[group.key] ?? {};
        const contextSuggestion = selected.fieldReview?.contextSuggestions?.groups?.[group.key] ?? {};
        const allowGlobalPeriod = !contextSuggestion.periodConflict && !selected.fieldReview?.contextSuggestions?.global?.periodConflict;
        return {
          candidateIds:group.candidates.map(candidate => candidate.id),
          fieldMappings:Object.fromEntries(group.candidates.map(candidate => [candidate.id,candidateMappings[candidate.id] ?? ''])),
          dimensionValues:Object.fromEntries(group.candidates.map(candidate => [candidate.id,candidateDimensionValues[candidate.id] ?? {}])),
          geoUnitId:context.geoUnitId || promotionGeoUnitId || null,
          periodId:context.periodId || (context.periodYear ? null : allowGlobalPeriod ? promotionPeriodId : null) || null,
          periodYear:context.periodYear || (context.periodId || !allowGlobalPeriod ? null : promotionPeriodYear) || null,
          recordLabel:`${selected.document.file_name} · ${group.label}`.slice(0,240),
        };
      });
      const result = await window.localApp.promoteDocumentFieldCandidates({
        documentId:selected.document.id,
        formVersionId:Number(promotionFormVersionId),
        candidateGroups,
        submitForReview,
        geoUnitId:promotionGeoUnitId || null,
        periodId:promotionPeriodId || null,
        periodYear:promotionPeriodYear.trim() || null,
        recordLabel:promotionRecordLabel.trim() || selected.document.file_name,
      });
      notify?.({ tone:'ok',message:submitForReview
        ? `أُنشئت ${fmtNumber(result.recordCount,0)} سجلات جديدة وأُرسلت للمراجعة؛ لم تصبح معتمدة بعد.`
        : `حُفظت ${fmtNumber(result.recordCount,0)} سجلات جديدة كمسودات غير مرسلة للمراجعة.` });
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
  const unsupportedCatalogGroups = (catalog?.domains ?? []).flatMap(domain => domain.groups.filter(group => !group.forms.some(form => !form.rawCaptureOnly)).map(group => `${domain.name} · ${group.name}`));
  const unmodeledCatalogFields = (catalog?.domains ?? []).flatMap(domain => domain.groups.flatMap(group => group.fields
    .filter(field => !group.publishedFields.some(published => published.code === field.code))
    .map(field => `${group.name} · ${field.name}`)));
  const schemaFields = selected?.fieldReview?.fields ?? [];
  const reviewRecords = selected?.fieldReview?.records ?? [];
  const selectedRecord = reviewRecords.find(record => record.key === selectedRecordKey) ?? reviewRecords[0] ?? null;
  const domainOptions = [...new Map(schemaFields.map(field => [field.domainCode,{ code:field.domainCode,name:field.domainName }])).values()];
  const selectedDomain = domainOptions.find(domain => domain.code === selectedDomainCode) ?? domainOptions[0] ?? null;
  const groupOptions = [...new Map(schemaFields.filter(field => field.domainCode === selectedDomain?.code).map(field => [field.groupCode,{ code:field.groupCode,name:field.groupName }])).values()];
  const selectedGroup = groupOptions.find(group => group.code === selectedGroupCode) ?? groupOptions[0] ?? null;
  const modelOptions = [...new Map(schemaFields.filter(field => field.domainCode === selectedDomain?.code && field.groupCode === selectedGroup?.code).map(field => [field.formVersionId,{ id:field.formVersionId,code:field.formCode,name:field.formName }])).values()];
  const selectedModel = modelOptions.find(form => Number(form.id) === Number(promotionFormVersionId)) ?? null;
  const visibleSchemaFields = schemaFields.filter(field => Number(field.formVersionId) === Number(selectedModel?.id));
  const fieldReviewGroups = (selectedRecord?.fields ?? []).map(fieldGroup => ({
    fieldGroup,field:schemaFields.find(field => field.fieldCode === fieldGroup.fieldCode),
  })).filter(item => item.field && Number(item.field.formVersionId) === Number(selectedModel?.id));
  const flattenedReviewedCandidates = reviewRecords.flatMap(record => record.fields.filter(fieldGroup => fieldGroup.status === 'reviewed')
    .map(fieldGroup => (selected?.fieldReview?.rows ?? []).find(candidate => candidate.id === fieldGroup.reviewedValue?.primaryCandidateId))
    .filter(Boolean));
  const reviewedCandidates = flattenedReviewedCandidates.filter(candidate => candidate.review_status === 'reviewed' && !candidate.promoted_form_record_id);
  const selectedPromotionCandidates = reviewedCandidates.filter(candidate => selectedCandidateIds[candidate.id]);
  const selectedCandidateGroups = [...new Map(selectedPromotionCandidates.map(candidate => [candidateGroupKey(candidate),{
    key:candidateGroupKey(candidate),candidates:[],label:candidateSourceLabel(candidate),
  }])).values()];
  for (const candidate of selectedPromotionCandidates) selectedCandidateGroups.find(group => group.key === candidateGroupKey(candidate)).candidates.push(candidate);
  const reviewedGroupSummaries = [...new Map(reviewedCandidates.map(candidate => [candidateGroupKey(candidate),{
    key:candidateGroupKey(candidate),label:candidateSourceLabel(candidate),count:reviewedCandidates.filter(item => candidateGroupKey(item) === candidateGroupKey(candidate)).length,
  }])).values()];
  const missingRequiredFields = selectedCandidateGroups.flatMap(group => {
    const mappedCodes = group.candidates.map(candidate => candidateMappings[candidate.id]).filter(Boolean);
    return (promotionDefinition?.fields ?? []).filter(field => field.is_required && !mappedCodes.includes(field.field_code))
      .map(field => `${group.label}: ${field.label_ar}`);
  });
  const missingRequiredDimensions = selectedPromotionCandidates.flatMap(candidate => {
    const field = promotionDefinition?.fields?.find(item => item.field_code === candidateMappings[candidate.id]);
    return (field?.dimensions ?? []).filter(dimension => dimension.required && !candidateDimensionValues[candidate.id]?.[dimension.code])
      .map(dimension => `${candidate.field_label_ar} — ${dimension.name}`);
  });
  const selectedRequiresPeriod = selectedCandidateGroups.some(group => group.candidates.some(candidate =>
    promotionDefinition?.fields?.find(field => field.field_code === candidateMappings[candidate.id])?.storage_class === 'measurement'));
  const groupsMissingPeriod = selectedCandidateGroups.filter(group => {
    const hasMeasurements = group.candidates.some(candidate => promotionDefinition?.fields?.find(field => field.field_code === candidateMappings[candidate.id])?.storage_class === 'measurement');
    const context = promotionGroupContexts[group.key] ?? {};
    const suggestion = selected?.fieldReview?.contextSuggestions?.groups?.[group.key] ?? {};
    const periodConflicted = suggestion.periodConflict || selected?.fieldReview?.contextSuggestions?.global?.periodConflict;
    return hasMeasurements && (periodConflicted
      ? !(context.periodId || context.periodYear)
      : !(context.periodId || context.periodYear || promotionPeriodId || promotionPeriodYear));
  });
  const hasPromotionPeriod = groupsMissingPeriod.length === 0;
  const groupsMissingGeography = selectedCandidateGroups.filter(group => {
    const context = promotionGroupContexts[group.key] ?? {};
    return !(context.geoUnitId || promotionGeoUnitId);
  });
  const hasUnmappedSelectedCandidates = selectedPromotionCandidates.some(candidate => !candidateMappings[candidate.id]);
  const bulkReviewGroups = fieldReviewGroups.filter(({ fieldGroup }) => fieldGroup.status === 'pending').map(item => ({ ...item,record:selectedRecord }));
  const selectedBulkCount = bulkReviewGroups.filter(({ fieldGroup }) => selectedReviewGroups[`${selectedRecord?.key}:${fieldGroup.fieldCode}`]).length;
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

      <Card title="الوثائق المحفوظة" subtitle="الأصل محفوظ داخل قاعدة البيانات المحلية غير المشفّرة. يُقرأ Excel محليًا بواسطة ExcelJS؛ أما PDF والصور فتحتاج إلى محركات معالجة محلية إضافية." actions={<button className="btn small ghost" onClick={load} disabled={loading}><RefreshCw size={14} /> تحديث</button>}>
        {loading && !documents.rows ? <Loading /> : rows.length === 0 ? <Empty icon={FileText} title="لا توجد وثائق بعد" hint="أضف ملف Excel XLSX/XLSM أو PDF أو DOCX أو صورة لبدء المكتبة المحلية." /> : <div className="stack">
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
          {(unsupportedCatalogGroups.length > 0 || unmodeledCatalogFields.length > 0) && <details className="quote" style={{ marginBottom: 16 }}>
            <summary>مجالات وحقول غير متاحة للإدخال لعدم نشر نموذج ({fmtNumber(unsupportedCatalogGroups.length + unmodeledCatalogFields.length, 0)})</summary>
            <p className="muted">لن تُحوّل الاقتراحات لهذه المجموعات أو الحقول إلى سجلات حتى يُنشر نموذج إدخال مناسب.</p>
            <div className="chip-row">{unsupportedCatalogGroups.map(label => <Badge key={label} tone="warn">{label}</Badge>)}{unmodeledCatalogFields.map(label => <Badge key={label} tone="warn">{label}</Badge>)}</div>
          </details>}
          <div className="grid-2">
            <label className="stack tight"><span>المجال</span><select className="input" value={selectedDomain?.code ?? ''} onChange={event => { setSelectedDomainCode(event.target.value); setSelectedGroupCode(''); setPromotionFormVersionId(''); setPromotionDefinition(null); }}><option value="">— اختر المجال —</option>{domainOptions.map(domain => <option key={domain.code} value={domain.code}>{domain.name}</option>)}</select></label>
            <label className="stack tight"><span>المجموعة</span><select className="input" value={selectedGroup?.code ?? ''} onChange={event => { setSelectedGroupCode(event.target.value); setPromotionFormVersionId(''); setPromotionDefinition(null); }}><option value="">— اختر المجموعة —</option>{groupOptions.map(group => <option key={group.code} value={group.code}>{group.name}</option>)}</select></label>
            <label className="stack tight"><span>النموذج المنشور</span><select className="input" value={promotionFormVersionId} onChange={event => choosePromotionForm(event.target.value)}><option value="">— اختر نموذجًا —</option>{modelOptions.map(form => <option key={form.id} value={form.id}>{form.name}</option>)}</select></label>
            <label className="stack tight"><span>السجل/الصف/الصفحة</span><select className="input" value={selectedRecord?.key ?? ''} onChange={event => { setSelectedRecordKey(event.target.value); setSelectedReviewGroups({}); }}><option value="">— اختر السجل —</option>{reviewRecords.map(record => <option key={record.key} value={record.key}>{record.sourceLabel}</option>)}</select></label>
          </div>
          <label className="stack tight"><span>سبب قرار المراجعة (مطلوب لكل الحقول المحددة)</span><input className="input" value={reviewNote} onChange={event => setReviewNote(event.target.value)} maxLength={1000} placeholder="مثال: طابقت القيمة مع الجدول الأصلي" /></label>
          <div className="row" style={{ flexWrap:'wrap' }}>
            <button type="button" className="btn small ghost" onClick={() => setSelectedReviewGroups(Object.fromEntries(bulkReviewGroups.map(({ fieldGroup }) => [`${selectedRecord?.key}:${fieldGroup.fieldCode}`,true])))} disabled={!bulkReviewGroups.length}>تحديد حقول هذا النموذج للمراجعة</button>
            <button type="button" className="btn small primary" onClick={() => reviewSelectedFieldGroups(bulkReviewGroups)} disabled={busyId === selected.document.id || !selectedBulkCount || !reviewNote.trim()}>حفظ مراجعة {fmtNumber(selectedBulkCount,0)} حقول</button>
            <span className="muted">كل حقل يظهر مرة واحدة؛ تُجمع الأدلة المتطابقة داخله، ولا تُخلط سجلات الصفحات أو الصفوف.</span>
          </div>
          <section className="stack" style={{ marginBottom: 18 }}>
            <div><h3>إنشاء مسودات من الحقول التي راجعتها</h3><p className="muted">المجال والمجموعة والنموذج والسجل محددة من عناصر الاختيار أعلاه. ستُنشأ سجلات جديدة دون استبدال سجلات قائمة.</p></div>
            <section className="stack" aria-label="حقول النموذج حسب تنظيم الإدخال المركزي">
              <div><h3>حقول النموذج — بنفس مجموعات الإدخال المركزي</h3><p className="muted">كل الحقول المؤهلة تظهر مرة واحدة. الأدلة المتطابقة مجمعة داخل الحقل، والقيم المختلفة تظهر كبدائل. لا يظهر المقتطف إلا عند فتح تفاصيل المصدر.</p></div>
              {!selectedRecord && <div className="quote">لم تُنشأ سجلات قابلة للمراجعة بعد. شغّل الاستخراج المحلي أولًا.</div>}
              {selectedRecord && !selectedModel && <div className="quote">اختر المجال والمجموعة والنموذج من الأعلى لعرض حقوله كاملة.</div>}
              {[...new Set(visibleSchemaFields.map(field => field.sectionName))].map(sectionName => <section className="stack" key={`${selectedModel?.id}:${sectionName}`}>
                <h4>{sectionName}</h4>
                {visibleSchemaFields.filter(field => field.sectionName === sectionName).map(field => {
                  const fieldGroup = fieldReviewGroups.find(item => item.fieldCode === field.fieldCode)?.fieldGroup;
                  const key = `${selectedRecord?.key}:${field.fieldCode}`;
                  const value = reviewFieldValues[key] ?? fieldGroup?.reviewedValue?.value ?? fieldGroup?.recommendedValue ?? '';
                  const pending = fieldGroup?.status === 'pending';
                  return <article className="quote stack tight" key={field.fieldCode}>
                    <div className="row between" style={{ flexWrap:'wrap' }}><strong>{field.label}{field.isRequired ? ' · مطلوب' : ''}</strong><Badge tone={fieldGroup?.status === 'reviewed' ? 'ok' : fieldGroup?.status === 'rejected' ? 'bad' : fieldGroup?.status === 'pending' ? 'warn' : 'neutral'}>{fieldGroup ? candidateStatusLabel(fieldGroup.status) : 'لم يُعثر على دليل'}</Badge></div>
                    {field.unit && <span className="muted">وحدة النموذج: {field.unit}</span>}
                    {fieldGroup?.evidenceCount > 0 ? <>
                      {fieldGroup.values.length > 1 && <div className="quote">تعارض: عُثر على {fmtNumber(fieldGroup.values.length,0)} قيم مختلفة. القيمة المقترحة مرتبة بحسب قوة المطابقة وتعدد الأدلة؛ راجع البدائل قبل القرار.</div>}
                      <label className="stack tight"><span>القيمة المقترحة · ثقة المطابقة {fieldGroup.confidence == null ? 'غير محسوبة' : `${Math.round(fieldGroup.confidence * 100)}٪`} (ليست ضمانًا للصحة)</span>
                        {field.referenceValues?.length > 0 ? <select className="input" value={value} onChange={event => setReviewFieldValues(current => ({ ...current,[key]:event.target.value }))} disabled={!pending}><option value="">— اختر قيمة مرجعية —</option>{!field.referenceValues.some(option => String(option.id) === String(value)) && value && <option value={value}>قيمة غير موجودة في القائمة: {value}</option>}{field.referenceValues.map(option => <option key={option.id} value={String(option.id)}>{option.label}</option>)}</select>
                          : field.dataType === 'boolean' ? <select className="input" value={value} onChange={event => setReviewFieldValues(current => ({ ...current,[key]:event.target.value }))} disabled={!pending}><option value="">— اختر —</option><option value="true">نعم</option><option value="false">لا</option></select> : <input className="input" value={value} onChange={event => setReviewFieldValues(current => ({ ...current,[key]:event.target.value }))} disabled={!pending} maxLength={1000} />}
                      </label>
                      <div className="chip-row"><Badge>{fmtNumber(fieldGroup.evidenceCount,0)} أدلة مجمّعة</Badge><span className="muted">{fieldGroup.recommendationReason}</span></div>
                      {fieldGroup.values.length > 1 && <details><summary>القيم البديلة ومصادرها</summary><div className="stack tight" style={{ marginTop:8 }}>{fieldGroup.values.map((item,index) => <div className="row" key={`${item.value}:${index}`}><button type="button" className="btn small ghost" disabled={!pending} onClick={() => setReviewFieldValues(current => ({ ...current,[key]:item.value }))}>استخدام {item.value}</button><span>{fmtNumber(item.evidenceCount,0)} أدلة · ثقة قصوى {Math.round(item.maxConfidence * 100)}٪</span></div>)}</div></details>}
                      <details><summary>تفاصيل المصدر والأدلة ({fmtNumber(fieldGroup.candidates.length,0)})</summary><div className="stack tight" style={{ marginTop:8 }}>{fieldGroup.candidates.map(candidate => <div className="quote stack tight" key={candidate.id}><div className="chip-row"><Badge>{candidateSourceLabel(candidate)}</Badge>{candidate.retrieval_method === 'local-near-heading' && <Badge tone="warn">عنوان قريب غير مطابق حرفيًا؛ تأكيد الربط مطلوب</Badge>}{candidate.confidence != null && <Badge tone="neutral">ثقة المطابقة {Math.round(candidate.confidence * 100)}٪</Badge>}</div>{candidate.evidence_text && <p>{candidate.evidence_text}</p>}<span className="muted">الأصل: {candidate.raw_value ?? '—'}{candidate.suggested_value != null ? ` · المقترح المطبّع: ${candidate.suggested_value}` : ''}</span></div>)}</div></details>
                      {pending && <div className="row"><label className="row"><input type="checkbox" checked={Boolean(selectedReviewGroups[key])} onChange={event => setSelectedReviewGroups(current => ({ ...current,[key]:event.target.checked }))} />ضمّ للمراجعة الجماعية</label><button type="button" className="btn small primary" onClick={() => reviewFieldGroup(selectedRecord,fieldGroup,'reviewed')} disabled={busyId === selected.document.id || !reviewNote.trim() || !String(value).trim()}>تسجيل مراجعة الحقل</button><button type="button" className="btn small ghost" onClick={() => reviewFieldGroup(selectedRecord,fieldGroup,'rejected')} disabled={busyId === selected.document.id || !reviewNote.trim()}>رفض أدلة الحقل</button></div>}
                    </> : <span className="muted">لم يظهر دليل لهذا الحقل في هذا السجل.</span>}
                  </article>;
                })}
              </section>)}
            </section>
            {false && promotionFormVersionId && promotionDefinition && <section className="stack" aria-label="معاينة نموذج الإدخال" style={{ marginBottom: 16 }}>
              <h4>معاينة نموذج الإدخال ونتائج البحث</h4>
              <div className="quote">درجة المطابقة تقدير أولي لمدى تطابق العنوان مع الحقل، وليست ضماناً لصحة الرقم. راجع المقتطف والمصدر؛ القيم البديلة لا تُعتمد تلقائياً.</div>
              <div className="table-wrap"><table className="data"><thead><tr><th>حقل النموذج</th><th>القيمة المقترحة / الحالة</th><th>المصدر والمقتطف</th><th>الثقة</th></tr></thead>
                <tbody>{promotionDefinition.fields.filter(field => field.field_code.split('.').at(-1) !== 'decision').map(field => {
                  const evidence = (selected.fieldReview?.rows ?? []).filter(candidate => candidate.field_code === field.field_code || candidateMappings[candidate.id] === field.field_code);
                  return <tr key={field.form_field_id}><th>{field.label_ar}{field.is_required ? ' · مطلوب' : ''}</th>
                    <td>{evidence.length ? evidence.map(candidate => <div className="stack tight" key={candidate.id}>
                      {candidate.source_document_id ? <input className="input" aria-label={`القيمة المقترحة: ${field.label_ar}`} value={candidateValues[candidate.id] ?? candidate.reviewedValue?.value ?? candidate.suggested_value ?? candidate.raw_value ?? ''} onChange={event => setCandidateValues(current => ({ ...current, [candidate.id]: event.target.value }))} disabled={candidate.review_status !== 'pending'} maxLength={1000} /> : <span className="muted">لم يُعثر على قيمة في الملف</span>}
                      <Badge tone={candidate.review_status === 'reviewed' ? 'ok' : candidate.review_status === 'rejected' ? 'bad' : 'warn'}>{candidateStatusLabel(candidate.review_status)}</Badge>
                    </div>) : <span className="muted">لم يُعثر على قيمة مقترحة</span>}</td>
                    <td>{evidence.length ? evidence.map(candidate => <div className="stack tight" key={candidate.id}><span>{candidateSourceLabel(candidate)}</span>{candidate.evidence_text && <details><summary>تفاصيل المصدر</summary><small>{candidate.evidence_text}</small></details>}</div>) : '—'}</td>
                    <td>{evidence.length ? evidence.map(candidate => <span className="chip" key={candidate.id}>{candidate.confidence == null ? 'غير محسوبة' : `${Math.round(candidate.confidence * 100)}٪`}</span>) : '—'}</td>
                  </tr>;
                })}</tbody>
              </table></div>
            </section>}
            {promotionFormVersionId && <form className="stack" onSubmit={event => { event.preventDefault(); promoteReviewedCandidates(); }}>
              {reviewedGroupSummaries.length > 0 && <div className="stack tight"><div className="quote stack tight"><strong>السجلات/الصفوف المكتشفة ({fmtNumber(reviewedGroupSummaries.length,0)}):</strong><div className="chip-row">{reviewedGroupSummaries.map(group => <Badge key={group.key} tone={selectedCandidateGroups.some(selectedGroup => selectedGroup.key === group.key) ? 'ok' : 'neutral'}>{group.label} · {fmtNumber(group.count,0)} حقول مراجعة</Badge>)}</div><span className="muted">يمكن إنشاء سجل مستقل لكل صف Excel أو صفحة أو وثيقة. لكل سجل موقعه وفترته؛ القيم العامة أدناه افتراضية، ويمكن تخصيصها لكل سجل.</span></div>{selectedCandidateGroups.map(group => {
                const context = promotionGroupContexts[group.key] ?? {};
                const suggestion = selected.fieldReview?.contextSuggestions?.groups?.[group.key] ?? {};
                return <article className="quote stack tight" key={group.key}><strong>سياق السجل: {group.label}</strong>
                  {(suggestion.geography || suggestion.periodYear || suggestion.periodConflict || suggestion.geography?.ambiguous) && <div className="row" style={{ flexWrap:'wrap' }}>
                    {suggestion.geography?.id && <button type="button" className="btn small ghost" onClick={() => setPromotionGroupContexts(current => ({ ...current,[group.key]:{ ...(current[group.key] ?? {}),geoUnitId:String(suggestion.geography.id) } }))}>استخدام الموقع المقترح: {suggestion.geography.type} — {suggestion.geography.name}</button>}
                    {suggestion.geography?.ambiguous && <span className="muted">تعددت المواقع المحتملة: {suggestion.geography.choices.map(choice => choice.name).join('، ')}؛ اختر الموقع يدويًا.</span>}
                    {suggestion.periodYear && <button type="button" className="btn small ghost" onClick={() => setPromotionGroupContexts(current => ({ ...current,[group.key]:{ ...(current[group.key] ?? {}),periodYear:String(suggestion.periodYear),periodId:'' } }))}>استخدام سنة الصفحة/الصف: {suggestion.periodYear}</button>}
                    {suggestion.periodConflict && <span className="muted">تعارضت السنوات في هذا السجل: {suggestion.periodAlternatives.join('، ')}؛ اترك الفترة فارغة أو اخترها يدويًا.</span>}
                  </div>}
                  <div className="grid-2"><label className="stack tight"><span>مديرية هذا السجل</span><select className="input" value={context.geoUnitId ?? ''} onChange={event => setPromotionGroupContexts(current => ({ ...current,[group.key]:{ ...(current[group.key] ?? {}),geoUnitId:event.target.value } }))}><option value="">اختر مديرية لهذا السجل</option>{geography.filter(unit => unit.type_code === 'directorate' && unit.is_active).map(unit => <option key={unit.geo_unit_id} value={unit.geo_unit_id}>{unit.type_name_ar} — {unit.name_ar}{unit.parent_name_ar ? ` / ${unit.parent_name_ar}` : ''}</option>)}</select></label><label className="stack tight"><span>الفترة لهذا السجل</span><select className="input" value={context.periodId ?? ''} onChange={event => setPromotionGroupContexts(current => ({ ...current,[group.key]:{ ...(current[group.key] ?? {}),periodId:event.target.value,periodYear:'' } }))}><option value="">استخدم الفترة العامة أدناه</option>{periods.map(period => <option key={period.period_id} value={period.period_id}>{period.label_ar}</option>)}</select></label><label className="stack tight"><span>أو سنة لهذا السجل</span><input className="input" type="number" min="1900" max="2200" step="1" value={context.periodYear ?? ''} onChange={event => setPromotionGroupContexts(current => ({ ...current,[group.key]:{ ...(current[group.key] ?? {}),periodYear:event.target.value,periodId:'' } }))} placeholder="استخدم السنة العامة أدناه" /></label></div></article>;
              })}</div>}
              {reviewedCandidates.map(candidate => {
                const compatibleFields = (promotionDefinition?.fields ?? []).filter(field => field.field_code === candidate.field_code && compatibleFieldType(candidate.data_type,field.data_type_override ?? field.data_type) && field.is_importable && !field.is_derived && field.storage_class !== 'ignored_derived');
                return <article className="quote stack tight" key={candidate.id}>
                  <label className="row"><input type="checkbox" checked={Boolean(selectedCandidateIds[candidate.id])} onChange={event => setSelectedCandidateIds(current => ({ ...current,[candidate.id]:event.target.checked }))} /><strong>{candidate.field_label_ar}</strong><Badge>{candidate.data_type}</Badge></label>
                  <label className="stack tight"><span>العمود/الحقل المعياري المطابق</span><select className="input" value={candidateMappings[candidate.id] ?? ''} onChange={event => setCandidateMappings(current => ({ ...current,[candidate.id]:event.target.value }))}><option value="">— اختر الحقل المطابق —</option>{compatibleFields.map(field => <option key={field.form_field_id} value={field.field_code}>{field.label_ar} · {field.field_code}</option>)}</select></label>
                  {(promotionDefinition?.fields ?? []).find(field => field.field_code === candidateMappings[candidate.id])?.dimensions?.map(dimension => <label className="stack tight" key={`${candidate.id}:${dimension.code}`}><span>{dimension.name}{dimension.required ? ' · مطلوب' : ''}</span><select className="input" value={candidateDimensionValues[candidate.id]?.[dimension.code] ?? ''} onChange={event => setCandidateDimensionValues(current => ({ ...current,[candidate.id]:{ ...(current[candidate.id] ?? {}),[dimension.code]:event.target.value } }))}><option value="">— اختر البعد —</option>{dimension.values.map(option => <option key={option.id ?? option.code} value={option.code}>{option.label}</option>)}</select></label>)}
                  <div><span className="muted">القيمة المؤكدة: </span><strong>{candidate.reviewedValue?.value ?? '—'}</strong>{candidate.source_file_name && <span className="muted"> · المصدر: {candidate.source_file_name}{candidate.page_number ? `، صفحة ${fmtNumber(candidate.page_number,0)}` : ''}</span>}</div>
                </article>;
              })}
              <div className="row" style={{ flexWrap:'wrap' }}>
                {selected.fieldReview?.contextSuggestions?.global?.geography?.id && <button type="button" className="btn small ghost" onClick={() => setPromotionGeoUnitId(String(selected.fieldReview.contextSuggestions.global.geography.id))}>استخدام الموقع المقترح للملف: {selected.fieldReview.contextSuggestions.global.geography.type} — {selected.fieldReview.contextSuggestions.global.geography.name}</button>}
                {selected.fieldReview?.contextSuggestions?.global?.periodYear && <button type="button" className="btn small ghost" onClick={() => { setPromotionPeriodYear(String(selected.fieldReview.contextSuggestions.global.periodYear)); setPromotionPeriodId(''); }}>استخدام سنة الملف المقترحة: {selected.fieldReview.contextSuggestions.global.periodYear}</button>}
                {selected.fieldReview?.contextSuggestions?.global?.periodConflict && <span className="muted">وجدت سنوات متعددة في الملف: {selected.fieldReview.contextSuggestions.global.periodAlternatives.join('، ')}؛ لن تُستخدم فترة عامة تلقائيًا.</span>}
                {selected.fieldReview?.contextSuggestions?.global?.geography?.ambiguous && <span className="muted">الموقع العام ملتبس؛ اختره من القائمة دون اعتماد تخمين.</span>}
              </div>
              <div className="grid-2" style={{ alignItems:'end' }}>
                <label className="stack tight"><span>المديرية</span><select className="input" value={promotionGeoUnitId} onChange={event => setPromotionGeoUnitId(event.target.value)}><option value="">اختر مديرية مؤكدة</option>{geography.filter(unit => unit.type_code === 'directorate' && unit.is_active).map(unit => <option key={unit.geo_unit_id} value={unit.geo_unit_id}>{unit.type_name_ar} — {unit.name_ar}{unit.parent_name_ar ? ` / ${unit.parent_name_ar}` : ''}</option>)}</select></label>
                <label className="stack tight"><span>الفترة المرجعية</span><select className="input" value={promotionPeriodId} onChange={event => { setPromotionPeriodId(event.target.value); setPromotionPeriodYear(''); }}><option value="">— فترة غير محددة —</option>{periods.map(period => <option key={period.period_id} value={period.period_id}>{period.label_ar}</option>)}</select></label>
                <label className="stack tight"><span>أو سنة ميلادية جديدة</span><input className="input" type="number" min="1900" max="2200" step="1" value={promotionPeriodYear} onChange={event => { setPromotionPeriodYear(event.target.value); setPromotionPeriodId(''); }} placeholder="2025" /></label>
                <label className="stack tight"><span>عنوان السجل</span><input className="input" value={promotionRecordLabel} onChange={event => setPromotionRecordLabel(event.target.value)} maxLength={240} placeholder={selected.document.file_name} /></label>
              </div>
              <fieldset className="stack tight"><legend>طريقة الحفظ</legend><label className="row"><input type="radio" name="submission-mode" checked={submitForReview} onChange={() => setSubmitForReview(true)} />إنشاء سجل وإرساله للمراجعة المركزية</label><label className="row"><input type="radio" name="submission-mode" checked={!submitForReview} onChange={() => setSubmitForReview(false)} />حفظ كمسودة غير مرسلة</label></fieldset>
              {selectedPromotionCandidates.length > 0 && missingRequiredFields.length > 0 && <div className="quote">النموذج يتطلب حقولًا لم تُربط بمرشحين مراجَعين: {missingRequiredFields.join('، ')}.</div>}
              {missingRequiredDimensions.length > 0 && <div className="quote">اختر أبعاد القياس المطلوبة: {missingRequiredDimensions.join('، ')}.</div>}
              {selectedRequiresPeriod && !hasPromotionPeriod && <div className="quote">اختر فترة مرجعية أو سنة للقياسات المختارة.</div>}
              {groupsMissingGeography.length > 0 && <div className="quote">حدّد مديرية مؤكدة لكل سجل قبل الحفظ. يمكن استخدام الموقع المقترح بعد اختياره صراحةً.</div>}
              <button className="btn small primary" type="submit" disabled={busyId === selected.document.id || selectedPromotionCandidates.length === 0 || hasUnmappedSelectedCandidates || missingRequiredFields.length > 0 || missingRequiredDimensions.length > 0 || (selectedRequiresPeriod && !hasPromotionPeriod) || groupsMissingGeography.length > 0}><Check size={14} />{submitForReview ? 'إنشاء السجل وإرساله للمراجعة' : 'حفظ السجل كمسودة'} ({fmtNumber(selectedPromotionCandidates.length,0)})</button>
            </form>}
          </section>
          {(selected.fieldReview.rows ?? []).some(candidate => ['reviewed','rejected'].includes(candidate.review_status)) && <details><summary>قرارات المراجعة السابقة ({fmtNumber((selected.fieldReview.rows ?? []).filter(candidate => ['reviewed','rejected'].includes(candidate.review_status)).length, 0)})</summary><div className="stack" style={{ marginTop: 10 }}>{(selected.fieldReview.rows ?? []).filter(candidate => ['reviewed','rejected'].includes(candidate.review_status)).map(candidate => <article className="quote stack tight" key={candidate.id}><div className="row between"><strong>{candidate.field_label_ar}</strong><Badge>{candidateStatusLabel(candidate.review_status)}</Badge></div>{candidate.promoted_form_record_id && <Badge tone="ok">مرتبطة بالسجل المعياري {fmtNumber(candidate.promoted_form_record_id,0)}</Badge>}{candidate.reviewedValue?.value && <span>القيمة التي راجعها المستخدم: {candidate.reviewedValue.value}</span>}<span>السبب: {candidate.review_note}</span><span className="muted">المراجع: {candidate.reviewed_by ?? 'غير مسجل'} · {fmtDateTime(candidate.reviewed_at)}</span></article>)}</div></details>}
          {(selected.fieldReview.rows ?? []).some(candidate => candidate.review_status === 'no_evidence') && <details><summary>الحقول التي لم يظهر لها دليل ({fmtNumber((selected.fieldReview.rows ?? []).filter(candidate => candidate.review_status === 'no_evidence').length, 0)})</summary><div className="chip-row" style={{ marginTop: 10 }}>{(selected.fieldReview.rows ?? []).filter(candidate => candidate.review_status === 'no_evidence').map(candidate => <Badge key={candidate.id}>{candidate.field_label_ar}</Badge>)}</div></details>}
        </section>}
        {selected.fieldReview?.run?.status === 'failed' && <div className="quote">تعذر إنشاء قائمة المرشحين: {selected.fieldReview.run.error_text}</div>}
        {(selected.artifacts ?? []).map(artifact => artifact.artifact_type === 'markdown' ? <details key={artifact.artifact_type}><summary>النص Markdown المستخرج (للمراجعة فقط)</summary><pre style={{ whiteSpace: 'pre-wrap', maxHeight: 500, overflow: 'auto' }}>{artifact.content}</pre></details> : <details key={artifact.artifact_type}><summary>بيانات {artifact.artifact_type}</summary><pre style={{ whiteSpace: 'pre-wrap', maxHeight: 500, overflow: 'auto' }}>{artifact.content.slice(0, 20000)}</pre></details>)}
        <details style={{ marginTop: 16 }}><summary>عناصر النص المستخرج ({fmtNumber((selected.elements ?? []).length,0)})</summary><div className="stack" style={{ marginTop: 10 }}>{(selected.elements ?? []).map(element => <article className="quote" key={element.id}><div className="chip-row"><Badge>{element.element_type}</Badge>{element.page_number && <Badge>صفحة {element.page_number}</Badge>}{element.confidence !== null && <Badge>ثقة OCR {Number(element.confidence).toFixed(3)}</Badge>}</div>{element.heading && <strong>{element.heading}</strong>}<p>{element.content}</p><span className="muted">مصدر العنصر: {element.source_json}</span></article>)}</div></details>
        {(selected.ragflowReferences ?? []).map(reference => <div className="muted" key={reference.dataset_id}>حالة الفهرسة في محرك المعرفة: {reference.status} · {fmtDateTime(reference.updated_at)}</div>)}
      </Card>}
    </>
  );
}
