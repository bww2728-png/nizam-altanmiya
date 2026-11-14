import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Activity, Check, ChevronDown, ClipboardList, FileText, Filter, Plus, RefreshCw, Search, Send, ShieldAlert, Star } from 'lucide-react';
import { Card, Field, Loading, SelectInput, TextInput } from '../components/ui.jsx';
import { errText, fmtNumber } from '../lib/format.js';
import { FIELD_GROUPS, DECISION_KEY } from '../lib/fields.js';

const STATUS_LABELS = {
  draft: 'مسودة', pending_review: 'قيد المراجعة', approved: 'معتمد', rejected: 'مرفوض', superseded: 'مستبدل', archived: 'مؤرشف',
};
const VALUE_STATE_LABELS = {
  known: 'قيمة معروفة', zero: 'صفر فعلي', not_available: 'غير متوفر', unknown: 'غير معروف',
  not_applicable: 'لا ينطبق', not_collected: 'لم يُجمع', not_verified: 'غير متحقق منه',
};

export default function DataEntry({ notify, refreshKey = 0, onDataChanged, onShowDatabase, initialEntry = {} }) {
  const [catalog, setCatalog] = useState(null);
  const [selectedDomainCode, setSelectedDomainCode] = useState('');
  const [selectedGroupCode, setSelectedGroupCode] = useState('');
  const [catalogSearch, setCatalogSearch] = useState('');
  const [catalogStatusFilter, setCatalogStatusFilter] = useState('all');
  const [catalogTypeFilter, setCatalogTypeFilter] = useState('all');
  const [catalogFavoriteFilter, setCatalogFavoriteFilter] = useState(false);
  const [workspaceTab, setWorkspaceTab] = useState('overview');
  const [favorites, setFavorites] = useState(() => {
    try { return new Set(JSON.parse(localStorage.getItem('manual-entry-favorites') ?? '[]')); } catch { return new Set(); }
  });
  const [expandedDomains, setExpandedDomains] = useState(() => new Set());
  const [overview, setOverview] = useState(null);
  const [forms, setForms] = useState([]);
  const [formVersionId, setFormVersionId] = useState('');
  const [definition, setDefinition] = useState(null);
  const projectFormVersionId = forms.find((form) => form.form_code === 'project_v1' && form.version_status === 'published')?.form_version_id ?? '';
  const [geography, setGeography] = useState([]);
  const [periods, setPeriods] = useState([]);
  const [records, setRecords] = useState([]);
  const [recordSearchInput, setRecordSearchInput] = useState('');
  const [recordSearch, setRecordSearch] = useState('');
  const [recordStatus, setRecordStatus] = useState('all');
  const [recordFormVersionId, setRecordFormVersionId] = useState('');
  const [recordFormRecordId, setRecordFormRecordId] = useState('');
  const [recordOffset, setRecordOffset] = useState(0);
  const [recordTotal, setRecordTotal] = useState(0);
  const [entryMode, setEntryMode] = useState('single');
  const [showOptionalFields, setShowOptionalFields] = useState(false);
  const [autoSaveState, setAutoSaveState] = useState('idle');
  const [autoSaveError, setAutoSaveError] = useState('');
  const [draftRecordId, setDraftRecordId] = useState(null);
  const saveTimerRef = useRef(null);
  const persistDraftRef = useRef(null);
  const latestDraftSignatureRef = useRef('');
  const latestDraftVersionRef = useRef('');
  const savingRef = useRef(false);
  const lastSavedPayloadRef = useRef('');
  const [values, setValues] = useState({});
  const [valueStates, setValueStates] = useState({});
  const [dimensionValues, setDimensionValues] = useState({});
  const [valueSources, setValueSources] = useState({});
  const [recordLabel, setRecordLabel] = useState('');
  const [notes, setNotes] = useState('');
  const [geoUnitId, setGeoUnitId] = useState('');
  const [periodId, setPeriodId] = useState('');
  const [periodYear, setPeriodYear] = useState('');
  const [parentRecordId, setParentRecordId] = useState('');
  const [projectParentRows, setProjectParentRows] = useState([]);
  const [projectParentSearch, setProjectParentSearch] = useState('');
  const [projectParentTotal, setProjectParentTotal] = useState(0);
  const [projectParentOffset, setProjectParentOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editingRecord, setEditingRecord] = useState(null);
  const [viewingRecord, setViewingRecord] = useState(null);
  const [viewingDefinition, setViewingDefinition] = useState(null);
  const [changeReason, setChangeReason] = useState('');
  const [reviewReasons, setReviewReasons] = useState({});

  const domains = catalog?.domains ?? [];
  const selectedDomain = domains.find((domain) => domain.code === selectedDomainCode) ?? domains[0] ?? null;
  const selectedGroup = selectedDomain?.groups.find((group) => group.code === selectedGroupCode) ?? selectedDomain?.groups[0] ?? null;
  const groupType = (group) => {
    const fields = [...(group.fields ?? []),...(group.publishedFields ?? [])];
    if (fields.some((field) => field.semanticType === 'measurement' || field.storage === 'measurement')) return 'measurement';
    if (fields.some((field) => ['attribute','classification','narrative'].includes(field.semanticType))) return 'descriptive';
    return 'unclassified';
  };
  const groupReadiness = (group) => group.forms.some((form) => !form.rawCaptureOnly)
    ? 'available' : group.rawCaptureAvailable ? 'raw' : 'unresolved';
  const visibleGroups = (domain) => domain.groups.filter((group) => {
    const query = catalogSearch.trim().toLocaleLowerCase();
    const matchesSearch = !query || domain.name.toLocaleLowerCase().includes(query)
      || group.name.toLocaleLowerCase().includes(query)
      || group.fields?.some((field) => `${field.name} ${field.code}`.toLocaleLowerCase().includes(query))
      || group.publishedFields?.some((field) => `${field.name} ${field.code}`.toLocaleLowerCase().includes(query))
      || group.rawRequirements?.some((item) => item.text.toLocaleLowerCase().includes(query));
    return matchesSearch && (catalogStatusFilter === 'all' || groupReadiness(group) === catalogStatusFilter)
      && (catalogTypeFilter === 'all' || groupType(group) === catalogTypeFilter)
      && (!catalogFavoriteFilter || favorites.has(group.code));
  });
  const matchingDomains = domains.filter((domain) => visibleGroups(domain).length > 0);
  const getGroupStats = (group) => {
    if (!overview || overview.restricted) return { recordCount: null,latestUpdatedAt: null };
    const linkedForms = group.forms.map((form) => overview.formVersionCounts?.[String(form.versionId)]).filter(Boolean);
    return {
      recordCount: linkedForms.reduce((count, form) => count + form.recordCount, 0),
      latestUpdatedAt: linkedForms.map((form) => form.latestUpdatedAt).filter(Boolean).sort().at(-1) ?? null,
    };
  };
  const selectCatalogGroup = async (domain, group) => {
    if (editingRecord) return;
    const hasStartedRecord = Object.keys(values).length || Object.keys(valueStates).length || recordLabel || notes || geoUnitId || periodId || periodYear || parentRecordId;
    if (definition && hasStartedRecord) {
      const saved = await persistDraft(true);
      if (!saved && !window.confirm('تعذر حفظ المسودة؛ هل تريد ترك هذه المجموعة والتخلص من المدخلات الحالية؟')) return;
    }
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    setSelectedDomainCode(domain.code);
    setSelectedGroupCode(group.code);
    setWorkspaceTab('group');
    setRecordFormRecordId('');
    setRecordOffset(0);
    setDraftRecordId(null);
    lastSavedPayloadRef.current = '';
    setAutoSaveState('idle');
    setValues({});
    setValueStates({});
    setDimensionValues({});
    setValueSources({});
    setRecordLabel('');
    setNotes('');
    setGeoUnitId('');
    setPeriodId('');
    setPeriodYear('');
    setParentRecordId('');
    setChangeReason('');
    setFormVersionId(String(group.forms.find((form) => form.versionId)?.versionId ?? ''));
  };
  const toggleFavorite = (groupCode) => setFavorites((current) => {
    const next = new Set(current);
    if (next.has(groupCode)) next.delete(groupCode); else next.add(groupCode);
    try { localStorage.setItem('manual-entry-favorites', JSON.stringify([...next])); } catch {}
    return next;
  });

  const loadOverview = useCallback(async () => {
    try {
      const result = await window.localApp.dataRecordOverview({ limit: 6 });
      setOverview(result ?? null);
    } catch (cause) {
      notify({ tone: 'bad', message: errText(cause) || 'تعذر تحميل ملخص السجلات.' });
    }
  }, [notify]);

  const loadForms = useCallback(async () => {
    setLoading(true);
    try {
      const [catalogResult, formRows, geoResult, periodResult] = await Promise.all([
        window.localApp.dataEntryCatalog(), window.localApp.dataForms(), window.localApp.dataGeography(''), window.localApp.dataPeriods(),
      ]);
      setCatalog(catalogResult);
      setForms(formRows ?? []);
      setGeography(geoResult?.rows ?? []);
      setPeriods(periodResult?.rows ?? []);
      const firstPublishedGroup = catalogResult?.domains.flatMap((domain) => domain.groups.map((group) => ({ domain, group })))
        .find(({ group }) => group.forms.some((form) => form.versionId));
      setSelectedDomainCode((current) => current || firstPublishedGroup?.domain.code || catalogResult?.domains[0]?.code || '');
      setSelectedGroupCode((current) => current || firstPublishedGroup?.group.code || '');
      setExpandedDomains((current) => current.size ? current : new Set([firstPublishedGroup?.domain.code ?? catalogResult?.domains[0]?.code].filter(Boolean)));
      const active = (formRows ?? []).find((form) => form.is_active && form.form_version_id && form.version_status === 'published');
      const initialFormVersionId = firstPublishedGroup?.group.forms.find((form) => form.versionId)?.versionId ?? active?.form_version_id ?? '';
      setFormVersionId((current) => current || String(initialFormVersionId));
    } catch (cause) {
      notify({ tone: 'bad', message: errText(cause) || 'تعذر تحميل تعريفات الإدخال.' });
    } finally {
      setLoading(false);
    }
  }, [notify]);

  const loadRecords = useCallback(async () => {
    try {
      const result = await window.localApp.dataRecords({
        formVersionId: recordFormVersionId || undefined,
        formRecordId: recordFormRecordId || undefined,
        status: recordStatus === 'all' ? undefined : recordStatus,
        search: recordSearch,
        offset: recordOffset,
        limit: 30,
      });
      setRecords(result?.rows ?? []);
      setRecordTotal(result?.total ?? 0);
    } catch (cause) {
      notify({ tone: 'bad', message: errText(cause) || 'تعذر تحميل السجلات.' });
    }
  }, [notify, recordFormRecordId, recordFormVersionId, recordOffset, recordSearch, recordStatus]);

  useEffect(() => { loadForms(); }, [loadForms]);
  useEffect(() => { loadRecords(); }, [loadRecords, refreshKey]);
  useEffect(() => { loadOverview(); }, [loadOverview, refreshKey]);
  useEffect(() => () => { if (saveTimerRef.current) clearTimeout(saveTimerRef.current); }, []);
  useEffect(() => {
    const hasInput = Object.keys(values).length || Object.keys(valueStates).length || recordLabel || notes || geoUnitId || periodId || periodYear || parentRecordId;
    if (!definition || !hasInput || (editingRecord && !changeReason.trim())) return undefined;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    setAutoSaveState('pending');
    saveTimerRef.current = setTimeout(() => { persistDraft(true); }, 900);
    return () => { if (saveTimerRef.current) clearTimeout(saveTimerRef.current); };
  }, [definition,editingRecord,changeReason,formVersionId,values,valueStates,dimensionValues,valueSources,recordLabel,notes,geoUnitId,periodId,periodYear,parentRecordId]);

  useEffect(() => {
    if (!catalog || !forms.length) return;
    const domain = catalog.domains.find((item) => item.code === initialEntry.domainCode);
    const group = domain?.groups.find((item) => item.code === initialEntry.groupCode)
      ?? catalog.domains.flatMap((item) => item.groups).find((item) => item.code === initialEntry.groupCode);
    if (domain) setSelectedDomainCode(domain.code);
    if (group) {
      setSelectedGroupCode(group.code);
      const groupForm = group.forms.find((item) => item.code === initialEntry.formCode && item.versionId);
      if (groupForm) setFormVersionId(String(groupForm.versionId));
    }
    const form = forms.find((item) => item.form_code === initialEntry.formCode && item.version_status === 'published');
    if (form) {
      setFormVersionId(String(form.form_version_id));
      setRecordFormVersionId(initialEntry.recordId ? String(form.form_version_id) : '');
    }
    if (initialEntry.recordId) {
      setRecordFormRecordId(String(initialEntry.recordId));
      setRecordStatus('all');
      setRecordOffset(0);
    }
    if (initialEntry.parentRecordId) setParentRecordId(String(initialEntry.parentRecordId));
  }, [catalog, forms, initialEntry.domainCode, initialEntry.groupCode, initialEntry.formCode, initialEntry.recordId, initialEntry.parentRecordId]);
  useEffect(() => { loadRecords(); }, [loadRecords, refreshKey]);

  useEffect(() => {
    if (!formVersionId) { setDefinition(null); return; }
    let active = true;
    window.localApp.dataFormDefinition(Number(formVersionId))
      .then((result) => {
        if (!active) return;
        const record = editingRecord?.record?.form_version_id === Number(formVersionId) ? editingRecord : null;
        setDefinition(result);
        setValues(record ? Object.fromEntries(Object.entries(record.values).map(([code,item]) => [code,item.value])) : {});
        setValueStates(record ? Object.fromEntries(Object.entries(record.values).map(([code,item]) => [code,item.state])) : {});
        setDimensionValues(record ? Object.fromEntries(Object.entries(record.values).filter(([,item]) => Object.keys(item.dimensions ?? {}).length)
          .map(([code,item]) => [code,Object.fromEntries(Object.entries(item.dimensions).map(([dimensionCode,value]) => [dimensionCode,value.code]))])) : {});
        setValueSources(record ? Object.fromEntries(Object.entries(record.values).filter(([,item]) => item.sourceLocator).map(([code,item]) => [code,item.sourceLocator])) : {});
        setRecordLabel(record?.record?.record_label ?? '');
        setNotes(record?.record?.notes ?? '');
        setGeoUnitId(record?.record?.geo_unit_id == null ? '' : String(record.record.geo_unit_id));
        setPeriodId(record?.record?.period_id == null ? '' : String(record.record.period_id));
        setPeriodYear(record?.record?.period_year == null ? '' : String(record.record.period_year));
        setParentRecordId(record?.record?.parent_record_id == null
          ? (initialEntry.formCode === 'project_funding_v1' ? String(initialEntry.parentRecordId ?? '') : '')
          : String(record.record.parent_record_id));
        setChangeReason('');
      })
      .catch((cause) => notify({ tone: 'bad', message: errText(cause) || 'تعذر تحميل النموذج.' }));
    return () => { active = false; };
  }, [formVersionId, editingRecord, notify]);

  useEffect(() => {
    if (definition?.form_code !== 'project_funding_v1' || !projectFormVersionId) {
      setProjectParentRows([]);
      setProjectParentTotal(0);
      return undefined;
    }
    let active = true;
    window.localApp.dataProjectParents({
      search: projectParentSearch,
      parentRecordId: editingRecord?.record?.parent_record_id ?? initialEntry.parentRecordId ?? undefined,
      offset: projectParentOffset,
      limit: 50,
    }).then((result) => {
      if (!active) return;
      setProjectParentRows(result?.rows ?? []);
      setProjectParentTotal(result?.total ?? 0);
    }).catch((cause) => {
      if (active) notify({ tone: 'bad', message: errText(cause) || 'تعذر تحميل المشاريع المعتمدة لربط التمويل.' });
    });
    return () => { active = false; };
  }, [definition?.form_code,editingRecord,initialEntry.parentRecordId,notify,projectFormVersionId,projectParentOffset,projectParentSearch]);

  const beginEdit = async (formRecordId) => {
    try {
      const record = await window.localApp.dataRecord(formRecordId);
      const location = domains.map((domain) => ({ domain, group: domain.groups.find((group) => group.forms.some((form) => Number(form.versionId) === Number(record.record.form_version_id))) }))
        .find((item) => item.group);
      if (location) {
        setSelectedDomainCode(location.domain.code);
        setSelectedGroupCode(location.group.code);
      }
      setEditingRecord(record);
      setWorkspaceTab('group');
      setFormVersionId(String(record.record.form_version_id));
      requestAnimationFrame(() => document.getElementById('data-entry-form')?.scrollIntoView({ behavior:'smooth',block:'start' }));
    } catch (cause) {
      notify({ tone: 'bad', message: errText(cause) || 'تعذر تحميل السجل للتعديل.' });
    }
  };

  const openRecord = async (formRecordId) => {
    try {
      const record = await window.localApp.dataRecord(formRecordId);
      const form = await window.localApp.dataFormDefinition(Number(record.record.form_version_id));
      setViewingRecord(record);
      setViewingDefinition(form);
      setWorkspaceTab('records');
      requestAnimationFrame(() => document.getElementById('data-entry-detail')?.scrollIntoView({ behavior:'smooth',block:'start' }));
    } catch (cause) {
      notify({ tone: 'bad', message: errText(cause) || 'تعذر تحميل تفاصيل السجل ومصادر قيمه.' });
    }
  };

  const cancelEdit = () => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    setEditingRecord(null);
    setDraftRecordId(null);
    lastSavedPayloadRef.current = '';
    setAutoSaveState('idle');
    setValues({});
    setValueStates({});
    setDimensionValues({});
    setValueSources({});
    setRecordLabel('');
    setNotes('');
    setGeoUnitId('');
    setPeriodId('');
    setPeriodYear('');
    setParentRecordId('');
    setProjectParentSearch('');
    setProjectParentOffset(0);
    setChangeReason('');
  };

  const buildRecordPayload = () => {
    const fieldMap = new Map(definition.fields.map((field) => [field.field_code, field]));
    const codes = new Set([...Object.keys(values), ...Object.keys(valueStates)]);
    const payload = Object.fromEntries([...codes].filter((fieldCode) => {
      const state = valueStates[fieldCode];
      return state && !['known', 'zero'].includes(state)
        ? true
        : values[fieldCode] !== '' && values[fieldCode] !== null && values[fieldCode] !== undefined;
    }).map((fieldCode) => {
      const field = fieldMap.get(fieldCode);
      const type = field?.data_type_override ?? field?.data_type;
      const state = valueStates[fieldCode];
      if (state && !['known', 'zero'].includes(state)) return [fieldCode, { value: null, state }];
      const numericZero = ['integer', 'decimal'].includes(type) && Number(values[fieldCode]) === 0;
      const value = state === 'zero' ? '0' : values[fieldCode];
      return [fieldCode, { value, state: state === 'zero' || numericZero ? 'zero' : 'known' }];
    }));
    return payload;
  };

  const buildDraftSignature = (payload = buildRecordPayload()) => JSON.stringify({ formVersionId, payload, valueStates, dimensionValues, valueSources, recordLabel, notes, geoUnitId, periodId, periodYear, parentRecordId });
  latestDraftSignatureRef.current = buildDraftSignature();
  latestDraftVersionRef.current = String(formVersionId);

  const persistDraft = async (automatic = false) => {
    if (!definition || Number(definition.form_version_id) !== Number(formVersionId) || savingRef.current) return null;
    const payload = buildRecordPayload();
    const signature = buildDraftSignature(payload);
    const persistedVersionId = Number(formVersionId);
    if (signature === lastSavedPayloadRef.current) {
      if (!automatic) notify({ tone:'ok',message:`المسودة ${draftRecordId} محفوظة بالفعل؛ يمكنك إرسالها للمراجعة من قائمة السجلات.` });
      return { unchanged:true };
    }
    const requiredFields = definition.fields.filter((field) => field.is_required);
    if (Object.keys(payload).length === 0 || requiredFields.some((field) => !payload[field.field_code] || !['known','zero'].includes(payload[field.field_code].state))) {
      setAutoSaveState('incomplete');
      if (!automatic) notify({ tone:'warn',message:'أكمل الحقول المطلوبة قبل حفظ المسودة.' });
      return null;
    }
    const editId = editingRecord?.record?.form_record_id;
    const existingId = editId ?? draftRecordId;
    const reason = changeReason.trim() || (automatic ? 'حفظ تلقائي لمسودة قيد الإدخال.' : 'استكمال المسودة يدوياً.');
    if (editId && !changeReason.trim()) {
      setAutoSaveState('reason');
      if (!automatic) notify({ tone:'warn',message:'أدخل سبب التعديل قبل حفظ السجل.' });
      return null;
    }
    if (definition.form_code === 'project_funding_v1' && !Number(parentRecordId)) {
      setAutoSaveState('incomplete');
      if (!automatic) notify({ tone:'warn',message:'اختر المشروع المعتمد المرتبط بسجل التمويل.' });
      return null;
    }
    savingRef.current = true;
    setSaving(true);
    setAutoSaveError('');
    setAutoSaveState('saving');
    try {
      const saved = await window.localApp.saveDataRecord({
        formVersionId:Number(formVersionId),formRecordId:existingId,
        geoUnitId:geoUnitId || null,periodId:periodId || null,periodYear:periodYear.trim() || null,
        parentRecordId:definition.form_code === 'project_funding_v1' ? Number(parentRecordId) || null : undefined,
        recordLabel:recordLabel.trim() || null,notes:notes.trim() || null,values:payload,dimensionValues,valueSources,
        changeReason:existingId ? reason : null,
      });
      setDraftRecordId(saved.formRecordId);
      lastSavedPayloadRef.current = signature;
      setAutoSaveState('saved');
      await loadRecords();
      if (!automatic) {
        notify({ tone:'ok',message:`${existingId ? 'حُدّث' : 'حُفظ'} السجل ${saved.formRecordId} كمسودة، مع توثيق مصدر الإدخال.` });
        setEditingRecord(null);
        setDraftRecordId(null);
        setValues({});
        setValueStates({});
        setDimensionValues({});
        setValueSources({});
        setRecordLabel('');
        setNotes('');
        setGeoUnitId('');
        setPeriodId('');
        setPeriodYear('');
        setParentRecordId('');
        setChangeReason('');
        lastSavedPayloadRef.current = '';
        setAutoSaveState('idle');
        onDataChanged?.();
        if (entryMode === 'single') {
          setWorkspaceTab('records');
          requestAnimationFrame(() => document.getElementById('data-entry-records')?.scrollIntoView({ behavior:'smooth',block:'start' }));
        }
      }
      return saved;
    } catch (cause) {
      setAutoSaveError(errText(cause) || 'تعذر الحفظ التلقائي. أعد المحاولة قبل مغادرة النموذج.');
      setAutoSaveState('error');
      if (!automatic) notify({ tone:'bad',message:errText(cause) || 'تعذر حفظ المسودة.' });
      return null;
    } finally {
      savingRef.current = false;
      setSaving(false);
      if (automatic && latestDraftVersionRef.current === String(persistedVersionId) && latestDraftSignatureRef.current !== signature) {
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        saveTimerRef.current = setTimeout(() => { persistDraftRef.current?.(true); }, 350);
      }
    }
  };
  persistDraftRef.current = persistDraft;

  const submit = async (event) => {
    event.preventDefault();
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    await persistDraft(false);
  };

  const saveAndSubmitDraft = async () => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    const saved = await persistDraft(true);
    if (!saved) return;
    const formRecordId = saved.formRecordId ?? (saved.unchanged ? draftRecordId : null);
    if (formRecordId) await review(formRecordId,'submit');
  };

  const review = async (formRecordId, decision) => {
    const enteredReason = String(reviewReasons[formRecordId] ?? '').trim();
    if (['return','reopen'].includes(decision) && !enteredReason) {
      notify({ tone: 'warn', message: 'أدخل سبب إعادة السجل أو فتحه مجددًا.' });
      return;
    }
    try {
      await window.localApp.reviewDataRecord({ formRecordId, decision, reason: decision === 'approve' ? enteredReason || 'مراجعة من واجهة قاعدة البيانات.' : enteredReason || undefined });
      notify({ tone: 'ok', message: decision === 'submit' ? 'أُرسل السجل للمراجعة.' : decision === 'approve' ? 'اعتُمد السجل.' : decision === 'reopen' ? 'أُعيد فتح السجل للتصحيح.' : 'أُعيد السجل للتصحيح.' });
      setReviewReasons((current) => { const next = { ...current }; delete next[formRecordId]; return next; });
      await loadRecords();
      onDataChanged?.();
    } catch (cause) {
      notify({ tone: 'bad', message: errText(cause) || 'تعذر تنفيذ قرار المراجعة.' });
    }
  };

  const selectedForm = forms.find((form) => Number(form.form_version_id) === Number(formVersionId));
  const rawCaptureOnly = selectedForm?.form_code?.startsWith('raw_collection_v1_') ?? false;
  const formOptions = (selectedGroup?.forms ?? []).map((catalogForm) => {
    const form = forms.find((item) => Number(item.form_version_id) === Number(catalogForm.versionId));
    return form ? {
      value: String(form.form_version_id),
      label: `${form.name_ar} — إصدار ${form.version_number}${catalogForm.rawCaptureOnly ? ' · التقاط خام غير مصنف' : form.collection_mode === 'primary_collection' ? ' · جمع أولي' : ''}`,
      disabled: !form.is_active || form.version_status !== 'published',
    } : null;
  }).filter(Boolean);
  const hasGroupForm = formOptions.length > 0;
  const geoOptions = [{ value: '', label: '— دون ربط جغرافي —' }, ...geography.map((unit) => ({
    value: String(unit.geo_unit_id), label: `${unit.type_name_ar} — ${unit.name_ar}${unit.parent_name_ar ? ` / ${unit.parent_name_ar}` : ''}`,
  }))];
  const periodOptions = [{ value: '', label: '— فترة غير محددة —' }, ...periods.map((period) => ({ value: String(period.period_id), label: period.label_ar }))];
  const entryFields = (definition?.fields ?? []).filter((field) => field.field_code.split('.').at(-1) !== DECISION_KEY);
  const groupedFields = FIELD_GROUPS.map((group) => ({
    ...group,
    fields: entryFields.filter((field) => group.fields.includes(field.field_code.split('.').at(-1))),
  })).filter((group) => group.fields.length);
  const groupedFieldCodes = new Set(groupedFields.flatMap((group) => group.fields.map((field) => field.field_code)));
  const additionalFields = entryFields.filter((field) => !groupedFieldCodes.has(field.field_code));
  if (additionalFields.length) groupedFields.push({ id: 'other', title: 'حقول إضافية في النموذج', hint: '', fields: additionalFields });
  const renderedGroups = groupedFields.map((group) => ({ ...group, fields: group.fields.filter((field) => showOptionalFields || field.is_required) })).filter((group) => group.fields.length);
  const optionalFieldCount = entryFields.filter((field) => !field.is_required).length;
  const hasKnownMeasurements = entryFields.some((field) => field.storage_class === 'measurement'
    && ['known','zero'].includes(valueStates[field.field_code] ?? 'known')
    && ((values[field.field_code] !== '' && values[field.field_code] !== null && values[field.field_code] !== undefined)
      || valueStates[field.field_code] === 'zero'));

  if (loading && forms.length === 0) return <Card><Loading label="جارٍ تحميل كتالوج البيانات..." /></Card>;

  return (
    <div className="stack data-entry-page">
      <header className="data-entry-hero">
        <div>
          <span className="eyebrow">إدارة البيانات التنموية</span>
          <h1>مركز الإدخال اليدوي</h1>
          <p>استعرض المجالات، اختر نموذجاً، وتابع السجلات من مكان واحد.</p>
        </div>
        <div className="btn-row">
          {onShowDatabase && <button type="button" className="btn" onClick={onShowDatabase}><ClipboardList size={15} /> قاعدة البيانات الشاملة</button>}
          <button type="button" className="btn primary" onClick={() => document.getElementById('data-entry-form')?.scrollIntoView({ behavior:'smooth',block:'start' })}><Plus size={15} /> بدء إدخال جديد</button>
        </div>
      </header>

      <nav className="data-entry-workspace-tabs" aria-label="أقسام مركز الإدخال">
        <button type="button" className={workspaceTab === 'overview' ? 'active' : ''} onClick={() => { setWorkspaceTab('overview'); document.querySelector('.data-entry-overview')?.scrollIntoView({ behavior:'smooth',block:'start' }); }}><Activity size={15} /> الملخص</button>
        <button type="button" className={workspaceTab === 'group' ? 'active' : ''} onClick={() => { setWorkspaceTab('group'); document.querySelector('.data-entry-layout')?.scrollIntoView({ behavior:'smooth',block:'start' }); }}><ClipboardList size={15} /> المجالات والنماذج</button>
        <button type="button" className={workspaceTab === 'records' ? 'active' : ''} onClick={() => { setWorkspaceTab('records'); document.getElementById('data-entry-records')?.scrollIntoView({ behavior:'smooth',block:'start' }); }}><FileText size={15} /> السجلات والمراجعة</button>
      </nav>

      <section className="data-entry-overview" aria-label="ملخص السجلات">
        <div className="data-entry-overview-head"><div><h2>ملخص العمل</h2><p>إحصاءات مباشرة من سجلات قاعدة البيانات المحلية.</p></div><button type="button" className="btn small ghost" onClick={() => { loadOverview(); loadRecords(); }}><RefreshCw size={14} /> تحديث</button></div>
        {overview?.restricted ? <div className="quote">عرض ملخص السجلات وإدارتها يتطلب وضع المالك.</div> : overview ? <div className="data-entry-stats">
          <button type="button" className="data-entry-stat" onClick={() => { setRecordStatus('all'); document.getElementById('data-entry-records')?.scrollIntoView({ behavior:'smooth' }); }}><span>كل السجلات</span><strong>{new Intl.NumberFormat('ar').format(overview.total)}</strong></button>
          {Object.entries({ draft:'مسودات',pending_review:'قيد المراجعة',approved:'معتمدة',rejected:'معادة',superseded:'مستبدلة',archived:'مؤرشفة' }).map(([status,label]) => <button key={status} type="button" className={`data-entry-stat status-${status}`} onClick={() => { setRecordStatus(status); document.getElementById('data-entry-records')?.scrollIntoView({ behavior:'smooth' }); }}><span>{label}</span><strong>{new Intl.NumberFormat('ar').format(overview.statusCounts?.[status] ?? 0)}</strong></button>)}
        </div> : <Loading label="جارٍ تحميل ملخص السجلات..." />}
        {!overview?.restricted && overview?.latest?.length > 0 && <div className="data-entry-recent"><strong>آخر السجلات</strong><div className="data-entry-recent-list">{overview.latest.slice(0,4).map((record) => <button type="button" key={record.form_record_id} onClick={() => openRecord(record.form_record_id)}><span className="data-entry-recent-title">{record.record_label || `${record.form_name} · ${record.form_record_id}`}</span><span>{record.geo_name || 'دون موقع'} · {record.period_label || 'دون فترة'}</span><span>تحديث {record.updated_at ? new Date(record.updated_at).toLocaleDateString('ar') : 'غير محدد'}</span><span className={`data-entry-status status-${record.record_status}`}>{STATUS_LABELS[record.record_status] ?? record.record_status}</span></button>)}</div></div>}
      </section>

      <section className="data-entry-layout">
        <aside className="data-entry-catalog" aria-label="مجالات ومجموعات الإدخال">
          <div className="data-entry-catalog-head"><div><span className="eyebrow">الكتالوج المركزي</span><h2>المجالات والمجموعات</h2></div><span className="chip">{domains.length} مجالاً</span></div>
          <div className="search-box"><Search size={16} /><input className="input" value={catalogSearch} onChange={(event) => setCatalogSearch(event.target.value)} placeholder="ابحث عن مجال أو مجموعة" aria-label="ابحث عن مجال أو مجموعة" /></div>
          <div className="data-entry-filters">
            <label><span><Filter size={13} /> حالة الإتاحة</span><select className="select" value={catalogStatusFilter} onChange={(event) => setCatalogStatusFilter(event.target.value)}><option value="all">كل الحالات</option><option value="available">نموذج منشور</option><option value="raw">جمع خام</option><option value="unresolved">قيد التعريف</option></select></label>
            <label><span>طبيعة البيانات الموصوفة</span><select className="select" value={catalogTypeFilter} onChange={(event) => setCatalogTypeFilter(event.target.value)}><option value="all">كل الأنواع</option><option value="measurement">قياس</option><option value="descriptive">حقول وصفية أو تصنيفية</option><option value="unclassified">لا يوجد تصنيف دلالي كافٍ</option></select></label>
          </div>
          <button type="button" className={`data-entry-favorites-toggle ${catalogFavoriteFilter ? 'active' : ''}`} onClick={() => setCatalogFavoriteFilter((current) => !current)}><Star size={14} fill={catalogFavoriteFilter ? 'currentColor' : 'none'} /> {catalogFavoriteFilter ? 'عرض كل المجموعات' : `المفضلة (${favorites.size})`}</button>
          <nav className="data-entry-domain-list">
            {matchingDomains.map((domain) => {
              const groups = visibleGroups(domain);
              const expanded = expandedDomains.has(domain.code) || Boolean(catalogSearch.trim());
              return <section className="data-entry-domain" key={domain.code}>
                <button type="button" className={`data-entry-domain-toggle ${selectedDomainCode === domain.code ? 'active' : ''}`} aria-expanded={expanded} onClick={() => setExpandedDomains((current) => { const next = new Set(current); if (next.has(domain.code)) next.delete(domain.code); else next.add(domain.code); return next; })}>
                  <ChevronDown size={15} className={expanded ? '' : 'collapsed'} /><span>{domain.name}</span><small>{groups.length}/{domain.groups.length}</small>
                </button>
                {expanded && <div className="data-entry-group-list">{groups.map((group) => {
                  const stats = getGroupStats(group);
                  return <div className={`data-entry-group-item ${selectedGroup?.code === group.code ? 'active' : ''}`} key={group.code}>
                    <button type="button" className="data-entry-group-select" disabled={Boolean(editingRecord)} onClick={() => selectCatalogGroup(domain,group)}>
                      <span className="data-entry-group-name">{group.name}</span>
                      <small>{groupReadiness(group) === 'available' ? 'نموذج منشور' : groupReadiness(group) === 'raw' ? 'جمع خام' : 'قيد التعريف'}</small>
                      <span className="data-entry-group-metrics"><span>{stats.recordCount == null ? '—' : new Intl.NumberFormat('ar').format(stats.recordCount)} سجل</span><span>{stats.latestUpdatedAt ? `آخر تحديث ${new Date(stats.latestUpdatedAt).toLocaleDateString('ar')}` : 'لا تحديثات بعد'}</span></span>
                    </button>
                    <button type="button" className="data-entry-favorite" aria-label={favorites.has(group.code) ? `إزالة ${group.name} من المفضلة` : `إضافة ${group.name} للمفضلة`} aria-pressed={favorites.has(group.code)} onClick={() => toggleFavorite(group.code)}><Star size={14} fill={favorites.has(group.code) ? 'currentColor' : 'none'} /></button>
                  </div>;
                })}</div>}
              </section>;
            })}
            {matchingDomains.length === 0 && <p className="data-entry-no-results">لا توجد مجموعات تطابق البحث والمرشحات.</p>}
          </nav>
        </aside>

        <main className="data-entry-main">
          <div className="data-entry-content-heading"><div><span className="eyebrow">{selectedDomain?.name ?? 'المواصفة'}</span><h2>{selectedGroup?.name ?? 'اختر مجموعة للبدء'}</h2><p>يعرض الكتالوج عناصر المواصفة وحالة النماذج كما هي في النظام.</p></div>
            {selectedGroup && <button type="button" className="btn primary" onClick={() => document.getElementById('data-entry-form')?.scrollIntoView({ behavior:'smooth',block:'start' })}><Plus size={15} /> فتح نموذج الإدخال</button>}
          </div>
          <div className="data-entry-status-banner">
            <ShieldAlert size={17} />
            <span><strong>حالة الكتالوج:</strong> {domains.length} مجالاً مرتبة وفق المواصفة. النموذج المنشور قد يغطي جزءاً من المجموعة؛ الجمع الخام للمراجعة لا يعني اعتماد تعريف أو وحدة أو صلاحية تحليلية.</span>
          </div>
          {selectedGroup ? <div className="data-entry-group-summary">
            <div className="data-entry-summary-status"><span className={`data-entry-status status-${groupReadiness(selectedGroup)}`}>{groupReadiness(selectedGroup) === 'available' ? 'نموذج منشور — تغطية جزئية' : groupReadiness(selectedGroup) === 'raw' ? 'جمع خام — غير معتمد تحليلياً' : 'قيد التعريف'}</span><span>{selectedGroup.requirementItemCount ?? 0} بنداً في المواصفة</span></div>
            <p>{selectedGroup.forms.some((form) => !form.rawCaptureOnly)
              ? `توجد ${selectedGroup.forms.filter((form) => !form.rawCaptureOnly).length} نماذج لحقول موصوفة؛ ${selectedGroup.rawCaptureFieldCount} حقلاً خاماً إضافياً متاحاً للمراجعة، ولا يعني ذلك تغطية المجموعة كاملة.`
              : selectedGroup.rawCaptureAvailable ? `يمكن تسجيل ${selectedGroup.rawCaptureFieldCount} بنداً كما ورد في المواصفة دون افتراض معنى أو وحدة أو منهجية.`
                : 'لا يوجد نموذج منشور أو جمع خام لهذه المجموعة بعد؛ لا تُعرض تعريفات غير محسومة على أنها حقول معتمدة.'}</p>
            {selectedGroup.fields?.length > 0 && <div className="data-entry-candidate-fields"><strong>تعريفات مرشحة للمراجعة الدلالية</strong><div className="chip-row">{selectedGroup.fields.map((field) => <span className="chip" key={field.code} title={`${field.code} · ${field.semanticType} · ${field.dataType}`}>{field.name}{field.unit ? ` (${field.unit})` : ''}</span>)}</div></div>}
          </div> : <div className="empty-state"><ClipboardList size={22} /><strong>اختر مجالاً ومجموعة</strong><span>يمكنك البحث أو تصفية القائمة، ثم اختيار المجموعة لإظهار وضعها ونموذجها.</span></div>}
        </main>
      </section>

      <section id="data-entry-form" className="data-entry-section-anchor">
      <Card title={selectedGroup ? `إدخال البيانات — ${selectedGroup.name}` : 'الإدخال اليدوي'} subtitle="تعريفات النماذج والحقول تُقرأ من قاعدة البيانات؛ الحفظ ينشئ مسودة ومصدراً وسجل تغيير لكل تعديل.">
        {initialEntry.recordId && !editingRecord ? (
          <div className="quote">فُتح سجل المشروع المركزي المحدد. راجع حالته في قائمة السجلات أدناه؛ إذا كان معتمداً، أعد فتحه للتصحيح ثم اختر «تعديل المسودة». كل تعديل يُحفظ للمراجعة ولا يغيّر سجل المشاريع قبل الاعتماد.</div>
        ) : !hasGroupForm ? (
          <div className="quote"><ShieldAlert size={17} /> لم يُنشر نموذج جمع لهذه المجموعة بعد. نقص المنهجيات أو المراجع لا يمنع إنشاء نموذج أولي؛ المتاح حالياً هما السكان حسب العمر والجنس وسجل المنشآت التعليمية.</div>
        ) : (
          <form className="stack" onSubmit={submit}>
            <div className="data-entry-form-tools">
              <div className="data-entry-mode-toggle" role="group" aria-label="طريقة الإدخال">
                <button type="button" className={entryMode === 'single' ? 'active' : ''} onClick={() => setEntryMode('single')}><FileText size={14} /> سجل مفصل</button>
                <button type="button" className={entryMode === 'repeat' ? 'active' : ''} onClick={() => setEntryMode('repeat')}><Plus size={14} /> إدخال متكرر</button>
              </div>
              <button type="button" className="btn ghost small" onClick={() => setShowOptionalFields((current) => !current)} disabled={!optionalFieldCount}>{showOptionalFields ? 'إخفاء الحقول الاختيارية' : `إظهار الحقول الاختيارية (${optionalFieldCount})`}</button>
              <span className={`data-entry-autosave state-${autoSaveState}`} aria-live="polite">{({ pending:'سيُحفظ بعد التوقف عن الكتابة',saving:'جارٍ حفظ المسودة...',saved:'المسودة محفوظة تلقائياً',incomplete:'استكمل الحقول المطلوبة للحفظ',reason:'أدخل سبب التعديل للحفظ',error:'تعذر الحفظ التلقائي' })[autoSaveState] ?? 'الحفظ التلقائي للمسودة مفعّل'}</span>
              {autoSaveError && <div className="data-entry-autosave-error" role="alert">{autoSaveError}</div>}
            </div>
            {draftRecordId && !editingRecord && <div className="data-entry-draft-banner"><Check size={15} /><span>حُفظت هذه المسودة تلقائياً. أكمل التعديل هنا، أو أرسل أحدث نسخة منها للمراجعة.</span><button type="button" className="btn small ghost" onClick={saveAndSubmitDraft} disabled={saving}><Send size={13} /> إرسال للمراجعة</button></div>}
            <div className="form-grid">
              <Field label="النموذج" required>
                <SelectInput value={formVersionId} onChange={(value) => { cancelEdit(); setFormVersionId(value); }} options={formOptions} />
              </Field>
              {(selectedForm?.collection_mode === 'primary_collection' || Number(selectedForm?.analysis_eligible) === 0) && <div className="quote" role="status">
                <strong>{rawCaptureOnly ? 'جمع خام للمراجعة — غير مصنف وغير مؤهل للتحليل:' : 'نموذج جمع أولي — لا اعتماد تحليلي:'}</strong> {rawCaptureOnly
                  ? `تُحفظ الإجابة كنص خام مطابق لبند المواصفة، لا كمتغير معرف أو قيمة ذات وحدة أو بُعد معتمد. ${selectedForm.methodology_status || 'المنهجية غير معرّفة'}؛ لا تدخل هذه السجلات التحليل الرسمي.`
                  : `يمكن حفظ البيانات ومراجعتها دون انتظار المنهجية أو المصدر الرسمي. لا تُستخدم هذه القيم في المؤشرات أو النتائج الرسمية؛ حالة المنهجية: ${selectedForm.methodology_status || 'غير معرّفة'}، حالة التعريف: ${selectedForm.definition_status || 'غير محددة'}.`}
              </div>}
              {definition?.form_code === 'project_funding_v1' && <Field label="مشروع التمويل" required hint="تُعرض المشاريع المعتمدة فقط؛ يُحفظ سجل التمويل تابعاً للمشروع المختار.">
                <div className="stack tight">
                  <TextInput value={projectParentSearch} onChange={(value) => { setProjectParentSearch(value); setProjectParentOffset(0); }} placeholder="ابحث باسم المشروع أو رمزه" />
                  <SelectInput required value={parentRecordId} onChange={(value) => {
                    setParentRecordId(value);
                    const parent = projectParentRows.find((project) => String(project.formRecordId) === value);
                    setGeoUnitId(parent?.geoUnitId == null ? '' : String(parent.geoUnitId));
                  }} options={[
                    { value: '', label: '— اختر مشروعاً معتمداً —' },
                    ...projectParentRows.map((project) => ({
                      value: String(project.formRecordId),
                      label: `${project.name || `مشروع ${project.projectId}`}${project.code ? ` · ${project.code}` : ''}${project.geoName ? ` · ${project.geoName}` : ''}`,
                    })),
                  ]} />
                  <div className="row between"><span className="muted">{projectParentTotal} مشروعاً معتمداً</span><div className="btn-row">
                    <button type="button" className="btn ghost small" onClick={() => setProjectParentOffset(Math.max(0,projectParentOffset-50))} disabled={projectParentOffset === 0}>السابق</button>
                    <button type="button" className="btn ghost small" onClick={() => setProjectParentOffset(projectParentOffset+50)} disabled={projectParentOffset+projectParentRows.length>=projectParentTotal}>التالي</button>
                  </div></div>
                </div>
              </Field>}
              <Field label="الوحدة الجغرافية" hint={definition?.form_code === 'project_funding_v1' ? 'تُحدد تلقائياً من المشروع الأب.' : undefined}>
                <SelectInput disabled={definition?.form_code === 'project_funding_v1'} value={geoUnitId} onChange={setGeoUnitId} options={geoOptions} />
              </Field>
              <Field label="الفترة المرجعية" required={hasKnownMeasurements}>
                <SelectInput required={hasKnownMeasurements && !periodYear} value={periodId} onChange={(value) => { setPeriodId(value); setPeriodYear(''); }} options={periodOptions} />
              </Field>
              <Field label="أو سنة ميلادية جديدة" required={hasKnownMeasurements} hint="تُضاف كفترة مرجعية للسنة التي أدخلتها.">
                <TextInput type="number" min="1900" max="2200" step="1" required={hasKnownMeasurements && !periodId} value={periodYear} onChange={(value) => { setPeriodYear(value); setPeriodId(''); }} placeholder="2025" />
              </Field>
              <Field label="عنوان السجل">
                <TextInput value={recordLabel} onChange={setRecordLabel} />
              </Field>
            </div>
            <div className="data-entry-form-summary">النموذج {selectedForm?.name_ar ?? 'غير محدد'} · {fmtNumber(entryFields.length, 0)} حقلاً. تُعرض الحقول المطلوبة أولاً؛ يمكن إظهار الاختيارية عند الحاجة.</div>
            {renderedGroups.map((group) => (
              <section className="card data-entry-section" key={group.id}>
                <header className="card-head"><div className="head-text"><h2>{group.title}</h2>{group.hint && <p>{group.hint}</p>}</div><span className="chip">{group.fields.length} حقلاً</span></header>
                <div className="card-body"><div className="form-grid">
                  {group.fields.map((field) => <DefinitionField key={field.form_field_id} field={field} value={values[field.field_code] ?? ''} state={valueStates[field.field_code] ?? 'known'} sourceLocator={valueSources[field.field_code] ?? ''}
                    dimensionValues={dimensionValues[field.field_code] ?? {}} editingRecord={Boolean(editingRecord)}
                    onChange={(value) => setValues((current) => ({ ...current, [field.field_code]: value }))}
                    onDimensionChange={(dimensionCode,value) => setDimensionValues((current) => ({ ...current,[field.field_code]:{ ...(current[field.field_code] ?? {}),[dimensionCode]:value } }))}
                    onSourceChange={(sourceLocator) => setValueSources((current) => ({ ...current,[field.field_code]:sourceLocator }))} onStateChange={(state) => {
                    setValueStates((current) => ({ ...current, [field.field_code]: state }));
                    if (state === 'zero') setValues((current) => ({ ...current, [field.field_code]: '0' }));
                  }} />)}
                </div></div>
              </section>
            ))}
            {!showOptionalFields && optionalFieldCount > 0 && <button type="button" className="data-entry-optional-callout" onClick={() => setShowOptionalFields(true)}>إظهار {optionalFieldCount} حقلاً اختيارياً إضافياً</button>}
            <Field label="ملاحظات السجل"><textarea className="textarea" value={notes} onChange={(event) => setNotes(event.target.value)} /></Field>
            {(editingRecord || Object.values(valueStates).includes('clear')) && <Field label="سبب التعديل أو الحذف الصريح" required><TextInput required value={changeReason} onChange={setChangeReason} placeholder="اذكر سبب التغيير أو حذف القيمة" /></Field>}
            <div className="btn-row"><button type="submit" className="btn primary" disabled={saving}><Check size={15} />{saving ? 'جارٍ الحفظ...' : editingRecord ? 'حفظ التعديلات' : entryMode === 'repeat' ? 'حفظ وبدء سجل آخر' : 'حفظ كمسودة والانتقال للسجلات'}</button>
              {editingRecord && <button type="button" className="btn" onClick={cancelEdit} disabled={saving}>إلغاء التعديل</button>}</div>
          </form>
        )}
      </Card>
      </section>

      <section id="data-entry-records" className="data-entry-section-anchor">
      <Card title="السجلات والمراجعة" subtitle="ابحث في جميع النماذج، وضيّق النتائج حسب الحالة أو النموذج؛ المسودات لا تدخل البيانات المعتمدة قبل المراجعة.">
        <form className="toolbar" onSubmit={(event) => { event.preventDefault(); setRecordOffset(0); setRecordSearch(recordSearchInput.trim().slice(0,120)); }}>
          <div className="search-box" style={{ flex: 1, minWidth: 220 }}><Search size={16} /><input className="input" value={recordSearchInput} onChange={(event) => setRecordSearchInput(event.target.value)} placeholder="بحث بعنوان السجل أو الموقع أو النموذج" /></div>
          <select className="input" value={recordFormVersionId} onChange={(event) => { setRecordFormVersionId(event.target.value); setRecordOffset(0); }}>
            <option value="">جميع النماذج</option>{forms.filter((form) => form.form_version_id).map((form) => <option key={form.form_version_id} value={form.form_version_id}>{form.name_ar}</option>)}
          </select>
          <select className="input" value={recordStatus} onChange={(event) => { setRecordStatus(event.target.value); setRecordOffset(0); }}>
            <option value="all">كل الحالات</option>{Object.entries(STATUS_LABELS).map(([value,label]) => <option key={value} value={value}>{label}</option>)}
          </select>
          <button className="btn primary" type="submit"><Search size={15} /> بحث</button>
          <button type="button" className="btn ghost" onClick={() => { setRecordSearchInput(''); setRecordSearch(''); setRecordStatus('all'); setRecordFormVersionId(''); setRecordOffset(0); }} disabled={!recordSearch && recordStatus === 'all' && !recordFormVersionId}>مسح المرشحات</button>
        </form>
        <div className={`data-entry-records-layout ${viewingRecord ? 'with-detail' : ''}`}>
        {!viewingRecord && <div className="table-wrap"><table className="data"><thead><tr><th>السجل</th><th>النموذج</th><th>الموقع</th><th>الفترة</th><th>الحالة</th><th>القيم</th><th>توثيق المصدر</th><th>آخر تحديث</th><th>الإجراءات</th></tr></thead>
          <tbody>{records.map((record) => (
            <tr key={record.form_record_id}>
              <td className="strong">{record.record_label || `سجل ${record.form_record_id}`}</td>
              <td>{record.form_name || '—'}</td>
              <td>{record.geo_name || '—'}</td><td>{record.period_label || 'غير محددة'}</td>
              <td><span className={`data-entry-status status-${record.record_status}`}>{STATUS_LABELS[record.record_status] ?? record.record_status}</span></td><td className="num">{record.value_count}</td>
              <td>{record.source_count > 0 ? 'موثق على مستوى القيم' : 'مصدر عام للسجل'}</td><td>{record.updated_at ? new Date(record.updated_at).toLocaleString('ar') : '—'}</td>
              <td><div className="cell-actions">
                {['draft','rejected'].includes(record.record_status) && <button className="btn small" onClick={() => beginEdit(record.form_record_id)}>تعديل المسودة</button>}
                <button className="btn small" onClick={() => openRecord(record.form_record_id)}>تفاصيل ومصادر</button>
                {record.record_status === 'draft' && <button className="btn small" onClick={() => review(record.form_record_id,'submit')}><Send size={13} />إرسال</button>}
                {['pending_review','approved'].includes(record.record_status) && <TextInput value={reviewReasons[record.form_record_id] ?? ''} onChange={(value) => setReviewReasons((current) => ({ ...current,[record.form_record_id]:value }))} placeholder={record.record_status === 'approved' ? 'سبب إعادة الفتح' : 'سبب الإعادة'} />}
                {record.record_status === 'pending_review' && <><button className="btn small primary" onClick={() => review(record.form_record_id,'approve')}><Check size={13} />اعتماد</button><button className="btn small" onClick={() => review(record.form_record_id,'return')}>إعادة</button></>}
                {record.record_status === 'approved' && <button className="btn small" onClick={() => review(record.form_record_id,'reopen')}>إعادة فتح للتصحيح</button>}
              </div></td>
            </tr>
          ))}</tbody>
        </table></div>}
        {viewingRecord && viewingDefinition && <aside id="data-entry-detail" className="card data-entry-detail-panel">
          <header className="card-head"><div className="head-text"><span className="eyebrow">تفاصيل السجل ومصدر البيانات</span><h2>{viewingRecord.record.record_label || `سجل ${viewingRecord.record.form_record_id}`}</h2><p>{viewingRecord.record.form_name} · القيمة الخام والمعيارية ومصدرها وموضعها وسجل إدخالها.</p></div><button type="button" className="btn" onClick={() => { setViewingRecord(null); setViewingDefinition(null); }}>العودة إلى السجلات</button></header>
          <div className="row between" style={{ padding:'0 16px 12px' }}><span className="muted">{STATUS_LABELS[viewingRecord.record.record_status] ?? viewingRecord.record.record_status} · {viewingRecord.record.geo_name || 'دون موقع'} · {viewingRecord.record.period_label || 'دون فترة'}</span></div>
          <div className="table-wrap"><table className="data"><thead><tr><th>الحقل</th><th>القيمة / الحالة</th><th>الأبعاد</th><th>القيمة الخام</th><th>القيمة المعيارية</th><th>المصدر وموضعه</th><th>الإدخال والتوقيت</th></tr></thead>
            <tbody>{viewingDefinition.fields.map((field) => {
              const item = viewingRecord.values[field.field_code];
              if (!item) return <tr key={field.form_field_id}><th>{field.label_ar}</th><td colSpan="6">غير مدخل</td></tr>;
              const sourceParts = [item.documentTitle,item.fileName,item.organization,item.sourceLocator].filter(Boolean);
              const dimensionText = Object.entries(item.dimensions ?? {}).map(([code,value]) => `${code}: ${value.label}`).join(' · ') || '—';
              return <tr key={field.form_field_id}><th>{field.label_ar}</th>
                <td>{['known','zero'].includes(item.state) ? (item.value === '' ? '—' : item.value) : VALUE_STATE_LABELS[item.state] ?? item.state}</td>
                <td>{dimensionText}</td>
                <td>{item.originalValue ?? '—'}</td><td>{item.normalizedValue ?? '—'}</td>
                <td>{sourceParts.length ? sourceParts.join(' · ') : 'مصدر إدخال عام على مستوى السجل'}</td>
                <td>{[item.enteredBy,item.provenanceAt].filter(Boolean).join(' · ') || '—'}</td>
              </tr>;
            })}</tbody>
          </table></div>
        </aside>}
        </div>
        {!viewingRecord && records.length === 0 && <div className="empty-state"><ClipboardList size={22} /><strong>لا توجد سجلات ضمن المرشحات</strong><span>جرّب تغيير النموذج أو الحالة أو عبارة البحث.</span></div>}
        {!viewingRecord && <div className="row between" style={{ marginTop: 12 }}><span className="muted">{recordTotal} سجلًا · صفحة {Math.floor(recordOffset / 30) + 1} من {Math.max(1,Math.ceil(recordTotal / 30))}</span><div className="btn-row"><button type="button" className="btn ghost small" onClick={() => setRecordOffset(Math.max(0,recordOffset-30))} disabled={recordOffset === 0}>السابق</button><button type="button" className="btn ghost small" onClick={() => setRecordOffset(recordOffset+30)} disabled={recordOffset+records.length>=recordTotal}>التالي</button><button type="button" className="btn ghost small" onClick={loadRecords}><RefreshCw size={13} /> تحديث</button></div></div>}
      </Card>
      </section>
    </div>
  );
}

function DefinitionField({ field, value, state, sourceLocator, dimensionValues, editingRecord, onChange, onDimensionChange, onStateChange, onSourceChange }) {
  const type = field.data_type_override ?? field.data_type ?? 'text';
  const disabled = !field.is_importable || field.is_derived || field.storage_class === 'ignored_derived';
  const numeric = ['integer','decimal'].includes(type) || field.storage_class === 'measurement';
  const hint = [field.unit_name_ar ? `الوحدة: ${field.unit_name_ar}` : null,
    field.source_header_text && field.source_header_text !== field.label_ar ? `العنوان الأصلي: ${field.source_header_text}` : null,
    field.min_value != null ? `الحد الأدنى: ${field.min_value}` : null,
    field.max_value != null ? `الحد الأعلى: ${field.max_value}` : null,
    disabled ? 'قيمة مشتقة أو غير قابلة للإدخال' : null].filter(Boolean).join(' · ');
  const stateOptions = [
    { value:'known',label:VALUE_STATE_LABELS.known },
    ...(numeric ? [{ value:'zero',label:VALUE_STATE_LABELS.zero }] : []),
    ...Object.entries(VALUE_STATE_LABELS).filter(([key]) => !['known','zero'].includes(key)).map(([value,label]) => ({ value,label })),
    ...(editingRecord && !field.is_required ? [{ value:'clear',label:'حذف القيمة الحالية' }] : []),
  ];
  let input;
  if (type === 'boolean') input = <SelectInput disabled={disabled || !['known','zero'].includes(state)} value={value} onChange={onChange} options={[{value:'',label:'— اختر —'},{value:'1',label:'نعم'},{value:'0',label:'لا'}]} />;
  else if (type === 'long_text' || field.storage_class === 'narrative') input = <textarea className="textarea" disabled={disabled || !['known','zero'].includes(state)} value={value} onChange={(event) => onChange(event.target.value)} />;
  else if (field.referenceValues?.length) input = <SelectInput disabled={disabled || !['known','zero'].includes(state)} value={value} onChange={onChange}
    options={[{ value:'',label:'— اختر —' },...field.referenceValues.map((option) => ({ value:String(option.id),label:option.label }))]} />;
  else if (field.storage_class === 'reference_value' || type === 'reference' || type === 'entity_reference') input = <TextInput disabled={disabled || !['known','zero'].includes(state)} type="number" value={value} onChange={onChange} placeholder="معرّف مرجعي" />;
  else {
    const inputType = numeric ? 'text' : type === 'date' ? 'date' : 'text';
    input = <TextInput disabled={disabled || !['known','zero'].includes(state)} type={inputType} value={value} onChange={onChange} inputMode={numeric ? 'decimal' : undefined} />;
  }
  return <Field label={field.label_ar} required={Boolean(field.is_required)} hint={hint}>
    <div className="stack tight">
      <SelectInput disabled={disabled} value={state} onChange={onStateChange} options={stateOptions} />
      {input}
      {(field.dimensions ?? []).map((dimension) => <Field key={dimension.code} label={dimension.name} required={Boolean(dimension.required)}>
        <SelectInput disabled={disabled} value={dimensionValues?.[dimension.code] ?? ''}
          onChange={(selected) => onDimensionChange(dimension.code,selected)}
          options={[{ value:'',label:'— اختر —' },...dimension.values.map((option) => ({ value:option.code,label:option.label }))]} />
      </Field>)}
      <TextInput disabled={disabled} value={sourceLocator} onChange={onSourceChange} maxLength={1000} placeholder="موضع المصدر أو طريقة الجمع: الصفحة، ورقة/خلية Excel، أو الجهة" />
    </div>
  </Field>;
}
