import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, Check, ChevronRight, Save, ShieldCheck } from 'lucide-react';
import { Loading, SelectInput, TextInput } from '../components/ui.jsx';
import { errText } from '../lib/format.js';

const VALUE_STATES = {
  known: 'قيمة معروفة',
  zero: 'صفر فعلي',
  unknown: 'غير معروف',
  not_available: 'غير متوفر',
  not_applicable: 'لا ينطبق',
  not_collected: 'لم يُجمع',
  not_verified: 'غير متحقق منه',
};
const IDENTITY_FIELDS = new Set(['directorate.districtName', 'directorate.governorate']);

function emptyObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function isFilled(input) {
  return input && typeof input === 'object'
    ? Boolean(input.state) || (input.value !== null && input.value !== undefined && input.value !== '')
    : input !== null && input !== undefined && input !== '';
}

function readInputValue(input) {
  return input && typeof input === 'object' && Object.hasOwn(input, 'value') ? input.value ?? '' : input ?? '';
}

function typeLabel(field) {
  const labels = { integer: 'عدد صحيح', decimal: 'عدد', number: 'عدد', boolean: 'نعم/لا', date: 'تاريخ', reference: 'اختيار مرجعي', text: 'نص', long_text: 'نص' };
  return labels[field.data_type] ?? 'نص';
}

function FieldInput({ field, value, onChange, dimensions = {}, onDimensionChange }) {
  const label = field.label_ar || field.canonical_name_ar || field.field_code;
  const writable = Boolean(field.is_importable) && !field.is_derived && field.storage_class !== 'ignored_derived';
  const type = field.data_type;
  const inputValue = readInputValue(value);
  const options = field.referenceValues ?? [];
  let input;
  if (options.length) {
    input = <SelectInput value={inputValue} onChange={onChange} options={options.map(option => ({ value: option.id, label: option.label }))} placeholder="اختر قيمة" disabled={!writable} />;
  } else if (type === 'boolean') {
    input = <SelectInput value={inputValue} onChange={onChange} options={[{ value: '1', label: 'نعم' }, { value: '0', label: 'لا' }]} placeholder="اختر نعم أو لا" disabled={!writable} />;
  } else if (type === 'long_text') {
    input = <textarea value={inputValue} onChange={event => onChange(event.target.value)} rows={2} disabled={!writable} aria-label={label} />;
  } else {
    const typeAttribute = type === 'date' ? 'date' : ['integer', 'decimal', 'number'].includes(type) ? 'number' : 'text';
    input = <TextInput type={typeAttribute} value={inputValue} onChange={onChange} step={type === 'integer' ? '1' : 'any'} disabled={!writable} placeholder={typeLabel(field)} />;
  }
  return <div className={`manual-entry-field${writable ? '' : ' is-readonly'}`}>
    <label className="manual-entry-field-label">
      <span>{label}{field.is_required ? <b> *</b> : null}</span>
      {field.unit_name_ar ? <small>{field.unit_name_ar}</small> : null}
    </label>
    {input}
    {field.dimensions?.length ? <div className="manual-entry-dimensions">
      {field.dimensions.map(dimension => <label key={dimension.code}>
        <span>{dimension.name}{dimension.required ? ' *' : ''}</span>
        {dimension.values?.length
          ? <SelectInput value={dimensions[dimension.code] ?? ''} onChange={next => onDimensionChange(dimension.code, next)} options={dimension.values.map(item => ({ value: item.code, label: item.label }))} placeholder="اختر" disabled={!writable} />
          : <TextInput value={dimensions[dimension.code] ?? ''} onChange={next => onDimensionChange(dimension.code, next)} placeholder={dimension.name} disabled={!writable} />}
      </label>)}
    </div> : null}
    {writable ? <details className="manual-entry-value-state">
      <summary>تحديد حالة القيمة</summary>
      <SelectInput value={value?.state && value.state !== 'known' && value.state !== 'zero' ? value.state : ''} onChange={next => onChange(next ? { value: null, state: next } : '')} options={Object.entries(VALUE_STATES).filter(([state]) => state !== 'known' && state !== 'zero').map(([state, title]) => ({ value: state, label: title }))} placeholder="قيمة مدخلة" />
    </details> : <small className="manual-entry-readonly-note">حقل مشتق أو غير متاح للإدخال المباشر</small>}
  </div>;
}

export default function DataEntry({ notify, refreshKey = 0, initialEntry = {}, onDataChanged, onShowDatabase }) {
  const [catalog, setCatalog] = useState(null);
  const [geoUnits, setGeoUnits] = useState([]);
  const [selectedGeoUnitId, setSelectedGeoUnitId] = useState('');
  const [stepIndex, setStepIndex] = useState(0);
  const [skippedGroups, setSkippedGroups] = useState({});
  const [skipReason, setSkipReason] = useState('');
  const [valuesByForm, setValuesByForm] = useState({});
  const [dimensionsByForm, setDimensionsByForm] = useState({});
  const [district, setDistrict] = useState('');
  const [governorate, setGovernorate] = useState('');
  const [periodYear, setPeriodYear] = useState('');
  const [sourceNote, setSourceNote] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [draftAvailable, setDraftAvailable] = useState(false);
  const [draftStatus, setDraftStatus] = useState('loading');
  const [hasDraftChanges, setHasDraftChanges] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [existing, setExisting] = useState(null);
  const [existingRecords, setExistingRecords] = useState([]);
  const [recordDetail, setRecordDetail] = useState(null);
  const [editing, setEditing] = useState(null);
  const [changeReason, setChangeReason] = useState('');
  const [draftRestored, setDraftRestored] = useState(false);
  const timerRef = useRef(null);
  const draftSnapshotRef = useRef(null);
  const draftDirtyRef = useRef(false);

  const groups = useMemo(() => catalog?.domains?.flatMap(domain => domain.groups.map(group => ({ ...group, domainCode: domain.code, domainName: domain.name }))) ?? [], [catalog]);
  const formDefinitions = useMemo(() => new Map(groups.flatMap(group => group.forms.map(form => [Number(form.versionId), { ...form, groupCode: group.code, groupName: group.name, definition: form.definition }]))), [groups]);
  const fieldLabels = useMemo(() => new Map([...formDefinitions.values()].flatMap(form => (form.definition?.fields ?? []).map(field => [field.field_code, field.label_ar || field.canonical_name_ar || field.field_code]))), [formDefinitions]);
  const filledForms = useMemo(() => Object.entries(valuesByForm).filter(([, values]) => Object.values(emptyObject(values)).some(isFilled)), [valuesByForm]);
  const currentGroup = stepIndex > 0 ? groups[stepIndex - 1] ?? null : null;
  const totalSteps = groups.length + 1;
  const progressPercent = totalSteps ? Math.round((stepIndex / (totalSteps - 1)) * 100) : 0;

  const makeDraftSnapshot = useCallback(() => ({ district, governorate, selectedGeoUnitId, stepIndex, skippedGroups, periodYear, sourceNote, valuesByForm, dimensionsByForm, editing, changeReason }), [district, governorate, selectedGeoUnitId, stepIndex, skippedGroups, periodYear, sourceNote, valuesByForm, dimensionsByForm, editing, changeReason]);

  useEffect(() => {
    let active = true;
    Promise.all([window.localApp.dataEntryCatalog(), window.localApp.manualEntryWorkspace(), window.localApp.manualEntryDraft.load(), window.localApp.dataGeography('')])
      .then(async ([baseCatalog, workspaceCatalog, storedDraft, geographyResult]) => {
        if (!active) return;
        const baseGroupCount = baseCatalog.domains.reduce((count, domain) => count + domain.groups.length, 0);
        const workspaceGroupCount = workspaceCatalog.domains.reduce((count, domain) => count + domain.groups.length, 0);
        if (baseCatalog.domains.length !== workspaceCatalog.domains.length || baseGroupCount !== workspaceGroupCount) {
          throw new Error('تعريفات كتالوج الإدخال غير متطابقة؛ أوقف النظام الحفظ لحماية البيانات.');
        }
        setGeoUnits((geographyResult.rows ?? []).filter(unit => unit.type_code === 'directorate' && Number(unit.is_active) === 1));
        setCatalog(workspaceCatalog);
        setDraftAvailable(Boolean(storedDraft.available));
        const workspaceGroups = workspaceCatalog.domains.flatMap(domain => domain.groups.map(group => ({ ...group, forms: group.forms ?? [] })));
        const requestedGroupCode = initialEntry.groupCode ?? workspaceGroups.find(group => group.forms.some(form => form.definition?.form_code === initialEntry.formCode))?.code;
        const requestedStep = Math.max(0, workspaceGroups.findIndex(group => group.code === requestedGroupCode) + 1);
        if (storedDraft.draft) {
          const draft = storedDraft.draft;
          setDistrict(String(draft.district ?? ''));
          setGovernorate(String(draft.governorate ?? ''));
          setSelectedGeoUnitId(String(draft.selectedGeoUnitId ?? ''));
          setStepIndex(Math.min(workspaceGroups.length, Math.max(0, Number(draft.stepIndex) || 0)));
          setSkippedGroups(emptyObject(draft.skippedGroups));
          setPeriodYear(String(draft.periodYear ?? ''));
          setSourceNote(String(draft.sourceNote ?? ''));
          setValuesByForm(emptyObject(draft.valuesByForm));
          setDimensionsByForm(emptyObject(draft.dimensionsByForm));
          setEditing(draft.editing ?? null);
          setChangeReason(String(draft.changeReason ?? ''));
          setHasDraftChanges(true);
          setDraftRestored(true);
        } else {
          setStepIndex(requestedStep);
          if (initialEntry.geoUnitId) setSelectedGeoUnitId(String(initialEntry.geoUnitId));
        }
        if (initialEntry.recordId) {
          const detail = await window.localApp.dataRecord(initialEntry.recordId);
          if (!active) return;
          setRecordDetail(detail);
          const selectedRecord = detail.record;
          const geoUnitId = selectedRecord.geo_unit_id ?? initialEntry.geoUnitId;
          if (geoUnitId) {
            setSelectedGeoUnitId(String(geoUnitId));
            const unit = (geographyResult.rows ?? []).find(item => Number(item.geo_unit_id) === Number(geoUnitId));
            setDistrict(unit?.name_ar ?? selectedRecord.geo_name ?? '');
            setGovernorate(unit?.parent_name_ar ?? '');
            setExisting({ geoUnitId: Number(geoUnitId), district: unit?.name_ar ?? selectedRecord.geo_name ?? '', governorate: unit?.parent_name_ar ?? '' });
            const records = await window.localApp.dataRecords({ geoUnitId, limit: 100, offset: 0 });
            if (!active) return;
            setExistingRecords(records.rows ?? []);
          }
          const recordGroupIndex = workspaceGroups.findIndex(group => group.forms.some(form => Number(form.versionId) === Number(selectedRecord.form_version_id)));
          if (recordGroupIndex >= 0) setStepIndex(recordGroupIndex + 1);
        }
        setDraftStatus(storedDraft.available ? 'ready' : 'volatile');
      })
      .catch(error => {
        if (active) {
          setSaveError(errText(error) || 'تعذر تحميل تعريفات الإدخال.');
          notify?.({ tone: 'bad', message: errText(error) || 'تعذر تحميل تعريفات الإدخال.' });
        }
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [notify]);

  useEffect(() => {
    if (!catalog || !hasDraftChanges || !draftAvailable) return undefined;
    if (timerRef.current) clearTimeout(timerRef.current);
    const snapshot = makeDraftSnapshot();
    draftSnapshotRef.current = snapshot;
    draftDirtyRef.current = true;
    setDraftStatus('saving');
    timerRef.current = setTimeout(() => {
      window.localApp.manualEntryDraft.save(snapshot)
        .then(() => setDraftStatus('saved'))
        .catch(error => setDraftStatus(errText(error) || 'error'));
    }, 450);
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [catalog, hasDraftChanges, makeDraftSnapshot, draftAvailable]);

  useEffect(() => () => {
    if (draftDirtyRef.current && draftSnapshotRef.current && window.localApp?.manualEntryDraft?.save) {
      window.localApp.manualEntryDraft.save(draftSnapshotRef.current).catch(() => {});
    }
  }, []);

  const markChanged = () => {
    setHasDraftChanges(true);
    draftDirtyRef.current = true;
    window.localApp?.manualEntryDraft?.markDirty?.().catch(() => {});
    setSaveError('');
  };
  const changeFormValue = (versionId, fieldCode, value) => {
    setValuesByForm(previous => ({ ...previous, [versionId]: { ...emptyObject(previous[versionId]), [fieldCode]: value === '' ? '' : typeof value === 'object' ? value : { value, state: value === '0' ? 'zero' : 'known' } } }));
    const groupCode = formDefinitions.get(Number(versionId))?.groupCode;
    if (groupCode && skippedGroups[groupCode]) setSkippedGroups(previous => { const next = { ...previous }; delete next[groupCode]; return next; });
    markChanged();
  };
  const changeDimension = (versionId, fieldCode, dimensionCode, value) => {
    setDimensionsByForm(previous => ({ ...previous, [versionId]: { ...emptyObject(previous[versionId]), [fieldCode]: { ...emptyObject(previous[versionId]?.[fieldCode]), [dimensionCode]: value } } }));
    markChanged();
  };

  const loadExistingRecords = async geoUnitId => {
    const result = await window.localApp.dataRecords({ geoUnitId, limit: 100, offset: 0 });
    setExistingRecords(result.rows ?? []);
  };

  const chooseDirectorate = geoUnitId => {
    const selected = geoUnits.find(unit => Number(unit.geo_unit_id) === Number(geoUnitId));
    setSelectedGeoUnitId(geoUnitId ? String(geoUnitId) : '');
    if (selected) {
      setDistrict(selected.name_ar ?? '');
      setGovernorate(selected.parent_name_ar ?? '');
      setExisting({ geoUnitId: Number(selected.geo_unit_id), district: selected.name_ar, governorate: selected.parent_name_ar ?? '' });
      loadExistingRecords(Number(selected.geo_unit_id)).catch(error => notify?.({ tone: 'bad', message: errText(error) || 'تعذر تحميل سجلات المديرية.' }));
    } else {
      setDistrict('');
      setGovernorate('');
      setExisting(null);
      setExistingRecords([]);
    }
    markChanged();
  };

  const moveToNextStep = () => {
    if (stepIndex === 0 && !selectedGeoUnitId && (!district.trim() || !governorate.trim())) {
      setSaveError('اختر مديرية موجودة أو اكتب اسم مديرية ومحافظة جديدتين.');
      return;
    }
    setSaveError('');
    setStepIndex(index => Math.min(groups.length, index + 1));
    setSkipReason('');
    markChanged();
  };

  const skipCurrentGroup = () => {
    if (!currentGroup || !skipReason.trim()) {
      setSaveError('اكتب سبب تجاوز هذه المجموعة حتى يبقى قرارك واضحاً.');
      return;
    }
    setSkippedGroups(previous => ({ ...previous, [currentGroup.code]: skipReason.trim() }));
    setStepIndex(index => Math.min(groups.length, index + 1));
    setSkipReason('');
    setSaveError('');
    markChanged();
  };

  const saveWorkspace = async () => {
    setSaveError('');
    if (!selectedGeoUnitId && (!district.trim() || !governorate.trim())) {
      setSaveError('اختر المديرية أو اكتب اسم المديرية والمحافظة قبل الحفظ.');
      return;
    }
    const forms = [];
    let hasMeasurement = false;
    for (const [versionText, rawValues] of Object.entries(valuesByForm)) {
      const versionId = Number(versionText);
      const form = formDefinitions.get(versionId);
      if (!form?.definition || form.definition.rows?.length || skippedGroups[form.groupCode]) continue;
      const values = { ...emptyObject(rawValues) };
      if (form.definition.form_code === 'legacy_directorate_v1' && !selectedGeoUnitId) {
        values['directorate.districtName'] = { value: district.trim(), state: 'known' };
        values['directorate.governorate'] = { value: governorate.trim(), state: 'known' };
      }
      const providedValues = Object.fromEntries(Object.entries(values).filter(([, value]) => isFilled(value)));
      if (!Object.keys(providedValues).length) continue;
      if (form.definition.fields.some(field => field.storage_class === 'measurement' && isFilled(providedValues[field.field_code]))) hasMeasurement = true;
      forms.push({ formVersionId: versionId, values: providedValues, dimensionValues: dimensionsByForm[versionId] ?? {}, ...(initialEntry.parentRecordId != null && form.definition.form_code === initialEntry.formCode ? { parentRecordId: initialEntry.parentRecordId } : {}) });
    }
    if (!selectedGeoUnitId) {
      const identityForm = [...formDefinitions.values()].find(form => form.definition?.form_code === 'legacy_directorate_v1');
      if (!identityForm) {
        setSaveError('نموذج تعريف المديرية غير متاح؛ لم يتم حفظ أي بيانات.');
        return;
      }
      const existingIdentity = forms.find(form => form.formVersionId === identityForm.versionId);
      if (existingIdentity) {
        existingIdentity.values['directorate.districtName'] = { value: district.trim(), state: 'known' };
        existingIdentity.values['directorate.governorate'] = { value: governorate.trim(), state: 'known' };
      } else {
        forms.unshift({ formVersionId: identityForm.versionId, values: {
          'directorate.districtName': { value: district.trim(), state: 'known' },
          'directorate.governorate': { value: governorate.trim(), state: 'known' },
        }, dimensionValues: {} });
      }
    }
    if (hasMeasurement && !periodYear) {
      setSaveError('أدخل سنة مرجعية واحدة على الأقل للقياسات التي أضفتها.');
      return;
    }
    if (!selectedGeoUnitId && !forms.some(form => formDefinitions.get(form.formVersionId)?.definition?.form_code === 'legacy_directorate_v1')) {
      setSaveError('نموذج تعريف المديرية غير متاح؛ لم يتم حفظ أي بيانات.');
      return;
    }
    setSaving(true);
    try {
      const snapshot = makeDraftSnapshot();
      draftSnapshotRef.current = snapshot;
      if (draftAvailable && hasDraftChanges) await window.localApp.manualEntryDraft.save(snapshot);
      if (editing) {
        const editedValues = forms.find(form => form.formVersionId === editing.formVersionId)?.values ?? {};
        const editedDimensions = dimensionsByForm[editing.formVersionId] ?? {};
        const saved = await window.localApp.saveDataRecord({
          formRecordId: editing.formRecordId,
          formVersionId: editing.formVersionId,
          geoUnitId: editing.geoUnitId,
          periodYear: periodYear || null,
          recordLabel: editing.recordLabel,
          changeReason,
          values: editedValues,
          dimensionValues: editedDimensions,
          valueSources: sourceNote ? Object.fromEntries(Object.keys(editedValues).map(code => [code, sourceNote])) : undefined,
        });
        notify?.({ tone: 'ok', message: `تم حفظ التعديل كسجل أولي، رقم ${saved.formRecordId}.` });
        setEditing(null);
        setChangeReason('');
        await loadExistingRecords(editing.geoUnitId);
      } else {
        const wasExistingDirectorate = Boolean(selectedGeoUnitId);
        const result = await window.localApp.saveManualEntryWorkspace({ geoUnitId: selectedGeoUnitId || null, district, governorate, periodYear: periodYear || null, sourceNote, forms, skippedGroups: Object.entries(skippedGroups).map(([groupCode, reason]) => ({ groupCode, reason })) });
        if (result.duplicate) {
          const duplicate = { geoUnitId: result.existingGeoUnitId, district: result.districtName || district, governorate: result.governorateName || governorate };
          setExisting(duplicate);
          await loadExistingRecords(duplicate.geoUnitId);
          setSaveError(`هذه المديرية موجودة بالفعل في ${duplicate.governorate}؛ لم تُنشأ نسخة ولم تُحفظ القيم. يمكنك فتح سجلاتها أدناه.`);
          return;
        }
        await window.localApp.manualEntryDraft.clear();
        setExisting(null);
        setExistingRecords([]);
        setRecordDetail(null);
        setValuesByForm({});
        setDimensionsByForm({});
        setSkippedGroups({});
        setSelectedGeoUnitId('');
        setStepIndex(0);
        setDistrict('');
        setGovernorate('');
        setPeriodYear('');
        setSourceNote('');
        setHasDraftChanges(false);
        draftDirtyRef.current = false;
        setDraftStatus('ready');
        setDraftRestored(false);
        notify?.({ tone: 'ok', message: `${wasExistingDirectorate ? 'أضيفت البيانات إلى' : 'حُفظت بيانات'} المديرية ${district} كبيانات أولية؛ أُنشئ ${result.records.length} سجل قابل للمراجعة.` });
      }
      setHasDraftChanges(false);
      draftDirtyRef.current = false;
      await window.localApp.manualEntryDraft.clear();
      onDataChanged?.();
    } catch (error) {
      setSaveError(errText(error) || 'تعذر الحفظ؛ بقيت البيانات في المسودة ولم يتم حذفها.');
      notify?.({ tone: 'bad', message: errText(error) || 'تعذر حفظ بيانات الإدخال.' });
    } finally {
      setSaving(false);
    }
  };

  const openExistingRecord = async record => {
    try {
      const detail = await window.localApp.dataRecord(record.form_record_id);
      setRecordDetail(detail);
      const recordGroupIndex = groups.findIndex(group => group.forms.some(form => Number(form.versionId) === Number(record.form_version_id)));
      if (recordGroupIndex >= 0) setStepIndex(recordGroupIndex + 1);
      const storedValues = Object.fromEntries(Object.entries(detail.values ?? {}).map(([code, input]) => [code, { value: input.value ?? '', state: input.state ?? 'known' }]));
      const storedDimensions = Object.fromEntries(Object.entries(detail.values ?? {}).filter(([, input]) => input.dimensions && Object.keys(input.dimensions).length).map(([code, input]) => [code, Object.fromEntries(Object.entries(input.dimensions).map(([dimensionCode, value]) => [dimensionCode, value.code]))]));
      if (record.record_status === 'draft' || record.record_status === 'rejected') {
        setDistrict(String(detail.values?.['directorate.districtName']?.value ?? district));
        setGovernorate(String(detail.values?.['directorate.governorate']?.value ?? governorate));
        setPeriodYear(String(detail.record.period_year ?? periodYear));
        setValuesByForm(previous => ({ ...previous, [record.form_version_id]: storedValues }));
        setDimensionsByForm(previous => ({ ...previous, [record.form_version_id]: storedDimensions }));
        setEditing({ formRecordId: record.form_record_id, formVersionId: record.form_version_id, geoUnitId: record.geo_unit_id, recordLabel: record.record_label, status: record.record_status });
        setChangeReason('');
        markChanged();
      }
    } catch (error) {
      notify?.({ tone: 'bad', message: errText(error) || 'تعذر فتح السجل المحدد.' });
    }
  };

  const reviewRecord = async decision => {
    if (!recordDetail?.record?.form_record_id) return;
    setSaving(true);
    try {
      const formRecordId = recordDetail.record.form_record_id;
      const updated = await window.localApp.reviewDataRecord({ formRecordId, decision });
      setRecordDetail(await window.localApp.dataRecord(formRecordId));
      const geoUnitId = recordDetail.record.geo_unit_id;
      if (geoUnitId) await loadExistingRecords(geoUnitId);
      if (decision === 'approve') onDataChanged?.();
      notify?.({ tone: 'ok', message: decision === 'approve' ? 'اعتُمد السجل وأصبح متاحاً للعرض الرسمي.' : 'أُرسل السجل إلى قائمة المراجعة.' });
      if (updated.status === 'approved') setHasDraftChanges(false);
    } catch (error) {
      notify?.({ tone: 'bad', message: errText(error) || 'تعذر تحديث حالة السجل.' });
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <Loading label="جارٍ تجهيز نموذج الإدخال المركزي…" />;
  if (!catalog) return <div className="manual-entry-error" role="alert">{saveError || 'تعذر تحميل كتالوج الإدخال.'}</div>;

  return <div className="manual-entry-page unified-manual-entry" dir="rtl">
    <header className="manual-entry-header">
      <div>
        <span className="manual-entry-eyebrow">مركز الإدخال اليدوي</span>
        <h1>إدخال بيانات مديرية</h1>
        <p>ابدأ باسم المديرية والمحافظة، ثم أدخل المتاح من الحقول في صفحة واحدة. البيانات المحفوظة تبدأ كمسودة للمراجعة.</p>
      </div>
      <div className="manual-entry-header-count"><strong>{catalog.domains.length}</strong><span>مجالاً</span><strong>{groups.length}</strong><span>مجموعة</span></div>
    </header>

    {draftRestored ? <div className="manual-entry-notice" role="status"><Check size={16} /> استُعيدت مسودتك السابقة من هذا الجهاز. لم تُحفظ بعد في قاعدة البيانات.</div> : null}
    {!draftAvailable && draftStatus !== 'loading' ? <div className="manual-entry-notice is-warning" role="status"><AlertCircle size={16} /> لا يتوفر تخزين محلي آمن للمسودة على هذا الجهاز؛ تبقى التغييرات في هذه الصفحة فقط حتى تضغط «حفظ».</div> : null}
    {draftStatus === 'saved' ? <div className="manual-entry-draft-status" role="status"><ShieldCheck size={15} /> المسودة محفوظة محلياً بأمان — لم تُرسل للمراجعة بعد</div> : null}

    <div className="manual-entry-progress" aria-label={`الخطوة ${stepIndex + 1} من ${totalSteps}`}>
      <div className="manual-entry-progress-copy"><strong>الخطوة {stepIndex + 1} من {totalSteps}</strong><span>{Math.max(0, totalSteps - stepIndex - 1)} خطوة متبقية</span><span>{filledForms.length} نموذجاً يحتوي بيانات</span></div>
      <div className="manual-entry-progress-track"><span style={{ width: `${progressPercent}%` }} /></div>
    </div>

    {stepIndex === 0 ? <section className="manual-entry-identity" aria-labelledby="manual-entry-identity-title">
      <h2 id="manual-entry-identity-title">الخطوة الأولى: تحديد المديرية</h2>
      <div className="manual-entry-identity-fields">
        <label><span>اختر مديرية موجودة أو أضف جديدة</span><SelectInput value={selectedGeoUnitId} onChange={chooseDirectorate} options={[
          { value: '', label: 'إضافة مديرية جديدة' },
          ...geoUnits.map(unit => ({ value: String(unit.geo_unit_id), label: `${unit.name_ar} — ${unit.parent_name_ar ?? 'بلا محافظة'}` })),
        ]} placeholder="اختر المديرية" />
        </label>
        <label><span>اسم المديرية <b>*</b></span><TextInput value={district} onChange={value => { setDistrict(value); markChanged(); }} disabled={Boolean(selectedGeoUnitId)} placeholder="اكتب اسم المديرية" /></label>
        <label><span>المحافظة <b>*</b></span><TextInput value={governorate} onChange={value => { setGovernorate(value); markChanged(); }} disabled={Boolean(selectedGeoUnitId)} placeholder="اكتب اسم المحافظة" /></label>
        <label><span>السنة المرجعية للقياسات</span><TextInput type="number" value={periodYear} onChange={value => { setPeriodYear(value); markChanged(); }} placeholder="مثال: 2025" /></label>
        <label className="manual-entry-source-note"><span>مصدر البيانات أو ملاحظة عنه</span><TextInput value={sourceNote} onChange={value => { setSourceNote(value); markChanged(); }} placeholder="اختياري؛ يربط بهذه القيم عند الحفظ" /></label>
      </div>
      {selectedGeoUnitId ? <p className="field-hint">ستُربط كل السجلات الجديدة بمديرية «{district}» في «{governorate}». تُعرض السجلات المعتمدة فقط في قاعدة البيانات الشاملة.</p> : null}
      {existing ? <section className="manual-entry-existing" aria-live="polite">
        <div className="manual-entry-existing-head"><div><strong>{existing.district} — {existing.governorate}</strong><span>ستُضاف البيانات إلى المديرية الموجودة، دون إنشاء نسخة منها.</span></div></div>
        {existingRecords.length ? <div className="manual-entry-existing-list">{existingRecords.slice(0, 5).map(record => <button type="button" className="manual-entry-existing-row" key={record.form_record_id} onClick={() => openExistingRecord(record)}><span>{record.form_name} · {record.record_status === 'approved' ? 'معتمد' : 'قيد المراجعة'}</span><span>{record.value_count} قيمة · عرض المصدر</span></button>)}</div> : null}
      </section> : null}
    </section> : currentGroup ? <section className="manual-entry-current-group">
      <div className="manual-entry-current-heading"><div><span>{currentGroup.domainName}</span><h2>{currentGroup.name}</h2></div><span>المجموعة {stepIndex} من {groups.length}</span></div>
      <p className="field-hint">المديرية: {district} — {governorate || 'المحافظة غير محددة'}{periodYear ? ` · السنة المرجعية: ${periodYear}` : ''}</p>
      {skippedGroups[currentGroup.code] ? <div className="manual-entry-notice is-warning">سبق تجاوز هذه المجموعة: {skippedGroups[currentGroup.code]} <button type="button" className="btn small ghost" onClick={() => { setSkippedGroups(previous => { const next = { ...previous }; delete next[currentGroup.code]; return next; }); markChanged(); }}>إلغاء التجاوز وإدخال البيانات</button></div> : null}
      {currentGroup.forms.filter(form => form.definition).length ? currentGroup.forms.filter(form => form.definition).map(form => {
        const definition = form.definition;
        const values = emptyObject(valuesByForm[form.versionId]);
        const dimensions = emptyObject(dimensionsByForm[form.versionId]);
        const visibleFields = (definition?.fields ?? []).filter(field => !IDENTITY_FIELDS.has(field.field_code));
        const editableFields = visibleFields.filter(field => field.is_importable && !field.is_derived && field.storage_class !== 'ignored_derived');
        return <div className="manual-entry-form-section" key={form.versionId}>
          <div className="manual-entry-form-heading"><strong>{form.name}</strong><span className="manual-entry-status is-pending">بيانات أولية؛ لا تدخل الاستخدام الرسمي قبل المراجعة والاعتماد</span></div>
          {definition.rows?.length ? <div className="manual-entry-unavailable">هذا النموذج يحتوي جدولاً متكرراً ولم يُفعّل له إدخال آمن في هذه الصفحة بعد.</div> : editableFields.length ? <div className="manual-entry-fields-grid">{visibleFields.map(field => <FieldInput key={field.form_field_id} field={field} value={values[field.field_code] ?? ''} dimensions={emptyObject(dimensions[field.field_code])} onChange={value => changeFormValue(form.versionId, field.field_code, value)} onDimensionChange={(dimensionCode, value) => changeDimension(form.versionId, field.field_code, dimensionCode, value)} />)}</div> : <p className="manual-entry-unavailable">لا يحتوي هذا النموذج حقولاً قابلة للإدخال المباشر حالياً.</p>}
          {editing?.formVersionId === form.versionId ? <label className="manual-entry-change-reason"><span>سبب تعديل السجل *</span><TextInput value={changeReason} onChange={value => { setChangeReason(value); markChanged(); }} placeholder="اذكر سبب التعديل" /></label> : null}
        </div>;
      }) : <div className="manual-entry-unavailable">لا يوجد نموذج إدخال فعلي منشور لهذه المجموعة بعد؛ يمكنك تجاوزها مع ذكر السبب.</div>}
      {(currentGroup.fields?.length || currentGroup.rawRequirements?.length) ? <details className="manual-entry-unavailable"><summary>متطلبات تحتاج تعريفاً أو مراجعة</summary>{(currentGroup.fields ?? []).map(field => field.name).concat((currentGroup.rawRequirements ?? []).filter(item => !item.fieldCode).map(item => item.text)).join('، ')}</details> : null}
      <label className="manual-entry-change-reason"><span>سبب تجاوز هذه المجموعة، عند عدم انطباقها</span><TextInput value={skipReason} onChange={value => setSkipReason(value)} placeholder="مثال: لا توجد بيانات لهذه المديرية في هذه المجموعة" /></label>
    </section> : null}

    {recordDetail?.record ? <section className="manual-entry-record-detail" aria-live="polite">
      <div className="manual-entry-current-heading"><div><span>تفاصيل السجل ومصدر القيم</span><h2>{recordDetail.record.record_label || recordDetail.record.form_code}</h2></div>
        <div className="btn-row"><span>{recordDetail.record.record_status === 'approved' ? 'معتمد' : recordDetail.record.record_status}</span>
          {['draft','rejected'].includes(recordDetail.record.record_status) && <button type="button" className="btn small" disabled={saving} onClick={() => reviewRecord('submit')}>إرسال للمراجعة</button>}
          {recordDetail.record.record_status === 'pending_review' && <button type="button" className="btn small primary" disabled={saving} onClick={() => reviewRecord('approve')}>اعتماد السجل</button>}
          <button type="button" className="btn small ghost" onClick={() => setRecordDetail(null)}>إغلاق</button></div></div>
      <dl>{Object.entries(recordDetail.values ?? {}).map(([code, value]) => <div key={code}>
        <dt>{fieldLabels.get(code) ?? code}</dt><dd>{value.value || `حالة القيمة: ${value.state ?? 'غير محددة'}`}<small>{value.documentTitle || value.fileName || value.organization || value.sourceLocator || value.provenanceType || 'المصدر غير موثق'}</small></dd>
      </div>)}</dl>
    </section> : null}

    {saveError ? <div className="manual-entry-error" role="alert"><AlertCircle size={17} />{saveError}</div> : null}
    {draftStatus === 'saving' ? <div className="manual-entry-draft-status" role="status">جارٍ حفظ المسودة محلياً بأمان…</div> : null}

    {editing ? <div className="manual-entry-edit-banner"><AlertCircle size={16} />يجري تعديل سجل واحد فقط ({editing.recordLabel}). يلزم ذكر سبب التعديل قبل الحفظ.</div> : null}
    <footer className="manual-entry-save-bar">
      <span>{draftStatus === 'saved' ? 'المسودة محفوظة محلياً؛ لم تُحفظ كسجل رسمي' : 'تُحفظ كل النماذج في عملية واحدة عند إكمال الخطوات'}</span>
      <div>
        {onShowDatabase ? <button type="button" className="btn ghost" onClick={onShowDatabase}><ChevronRight size={16} />قاعدة البيانات</button> : null}
        <button type="button" className="btn ghost" onClick={() => { setStepIndex(index => Math.max(0, index - 1)); markChanged(); }} disabled={stepIndex === 0}>السابق</button>
        {stepIndex < groups.length ? <>
          {stepIndex > 0 ? <button type="button" className="btn ghost" onClick={skipCurrentGroup} disabled={!skipReason.trim()}>تجاوز المجموعة</button> : null}
          <button type="button" className="btn primary" onClick={moveToNextStep}>التالي</button>
        </> : <button type="button" className="btn primary" onClick={saveWorkspace} disabled={saving || !district.trim() || !governorate.trim() || Boolean(editing && !changeReason.trim())}>
          <Save size={16} />{saving ? 'جارٍ الحفظ…' : editing ? 'حفظ التعديل' : 'حفظ جميع البيانات'}
        </button>}
      </div>
    </footer>
  </div>;
}
