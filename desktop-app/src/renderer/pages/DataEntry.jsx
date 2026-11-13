import React, { useCallback, useEffect, useState } from 'react';
import { Check, ClipboardList, RefreshCw, Search, Send, ShieldAlert } from 'lucide-react';
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
  const matchingDomains = domains.filter((domain) => {
    const query = catalogSearch.trim().toLocaleLowerCase();
    return !query || domain.name.toLocaleLowerCase().includes(query)
      || domain.groups.some((group) => group.name.toLocaleLowerCase().includes(query)
        || group.fields?.some((field) => `${field.name} ${field.code}`.toLocaleLowerCase().includes(query))
        || group.publishedFields?.some((field) => `${field.name} ${field.code}`.toLocaleLowerCase().includes(query))
        || group.rawRequirements?.some((item) => item.text.toLocaleLowerCase().includes(query)));
  });
  const selectCatalogGroup = (domain, group) => {
    if (editingRecord) return;
    setSelectedDomainCode(domain.code);
    setSelectedGroupCode(group.code);
    setFormVersionId(String(group.forms.find((form) => form.versionId)?.versionId ?? ''));
  };

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
      setFormVersionId(String(record.record.form_version_id));
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
    } catch (cause) {
      notify({ tone: 'bad', message: errText(cause) || 'تعذر تحميل تفاصيل السجل ومصادر قيمه.' });
    }
  };

  const cancelEdit = () => {
    setEditingRecord(null);
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

  const submit = async (event) => {
    event.preventDefault();
    if (!definition) return;
    setSaving(true);
    try {
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
      const saved = await window.localApp.saveDataRecord({
        formVersionId: Number(formVersionId), formRecordId: editingRecord?.record?.form_record_id,
        geoUnitId: geoUnitId || null, periodId: periodId || null, periodYear: periodYear.trim() || null,
        parentRecordId: definition.form_code === 'project_funding_v1' ? Number(parentRecordId) || null : undefined,
        recordLabel: recordLabel.trim() || null, notes: notes.trim() || null, values: payload, dimensionValues, valueSources, changeReason: changeReason.trim() || null,
      });
      notify({ tone: 'ok', message: `${editingRecord ? 'حُدّث' : 'حُفظ'} السجل ${saved.formRecordId} كمسودة، مع توثيق مصدر الإدخال.` });
      setEditingRecord(null);
      setValues({});
      setValueStates({});
      setValueSources({});
      setRecordLabel('');
      setNotes('');
      setGeoUnitId('');
      setPeriodId('');
      setPeriodYear('');
      setParentRecordId('');
      setChangeReason('');
      await loadRecords();
      onDataChanged?.();
    } catch (cause) {
      notify({ tone: 'bad', message: errText(cause) || 'تعذر حفظ المسودة.' });
    } finally {
      setSaving(false);
    }
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
  const hasKnownMeasurements = entryFields.some((field) => field.storage_class === 'measurement'
    && ['known','zero'].includes(valueStates[field.field_code] ?? 'known')
    && ((values[field.field_code] !== '' && values[field.field_code] !== null && values[field.field_code] !== undefined)
      || valueStates[field.field_code] === 'zero'));

  if (loading && forms.length === 0) return <Card><Loading label="جارٍ تحميل كتالوج البيانات..." /></Card>;

  return (
    <div className="stack">
      <Card title="مركز إدارة وإدخال البيانات التنموية الموحد" subtitle="اختر المجال والمجموعة؛ يمكن نشر نماذج الجمع الأولي قبل اعتماد المنهجية التحليلية.">
        <div className="row between">
          <span className="muted">إدخال ومراجعة السجلات وفق قاموس النماذج المركزي.</span>
          {onShowDatabase && <button type="button" className="btn small" onClick={onShowDatabase}>عرض قاعدة البيانات الشاملة</button>}
        </div>
        <div className="stack tight">
          <div className="quote"><strong>نطاق الكتالوج:</strong> يعرض {domains.length} مجالاً من المواصفة. قد تكون النماذج الأولية صالحة لجمع القيم الخام مع بقاء التعريفات أو الوحدات أو المراجع قيد المراجعة؛ هذا لا يجعل القيم معتمدة للتحليل الرسمي.</div>
          <Field label="ابحث عن مجال أو مجموعة">
            <TextInput value={catalogSearch} onChange={setCatalogSearch} placeholder="مثال: السكان، المدارس، الإيرادات" />
          </Field>
          <div className="row" role="group" aria-label="المجالات التنموية">
            {matchingDomains.map((domain) => <button key={domain.code} type="button" className={`btn small ${selectedDomain?.code === domain.code ? 'primary' : 'ghost'}`} aria-pressed={selectedDomain?.code === domain.code} onClick={() => {
              setSelectedDomainCode(domain.code);
              const query = catalogSearch.trim().toLocaleLowerCase();
              const nextGroup = query
                ? domain.groups.find((group) => group.name.toLocaleLowerCase().includes(query)
                  || group.fields?.some((field) => `${field.name} ${field.code}`.toLocaleLowerCase().includes(query))
                  || group.publishedFields?.some((field) => `${field.name} ${field.code}`.toLocaleLowerCase().includes(query))
                  || group.rawRequirements?.some((item) => item.text.toLocaleLowerCase().includes(query)))
                  ?? domain.groups.find((group) => group.forms.some((form) => form.versionId)) ?? domain.groups[0]
                : domain.groups.find((group) => group.forms.some((form) => form.versionId)) ?? domain.groups[0];
              setSelectedGroupCode(nextGroup?.code ?? '');
              setFormVersionId(String(nextGroup?.forms.find((form) => form.versionId)?.versionId ?? ''));
            }}>{domain.name}<span className="dim"> · {domain.groups.length}</span></button>)}
          </div>
          {selectedDomain && <section className="stack tight" aria-label="المجموعات الفرعية">
            <strong>{selectedDomain.name}</strong>
            <div className="row">
              {selectedDomain.groups.filter((group) => {
                const query = catalogSearch.trim().toLocaleLowerCase();
                return !query || selectedDomain.name.toLocaleLowerCase().includes(query) || group.name.toLocaleLowerCase().includes(query)
                  || group.fields?.some((field) => `${field.name} ${field.code}`.toLocaleLowerCase().includes(query))
                  || group.publishedFields?.some((field) => `${field.name} ${field.code}`.toLocaleLowerCase().includes(query))
                  || group.rawRequirements?.some((item) => item.text.toLocaleLowerCase().includes(query));
              }).map((group) => <button key={group.code} type="button" className={`btn small ${selectedGroup?.code === group.code ? 'primary' : 'ghost'}`} aria-pressed={selectedGroup?.code === group.code} disabled={Boolean(editingRecord)} onClick={() => selectCatalogGroup(selectedDomain, group)}>
                {group.name}<span className="dim"> · {group.forms.some((form) => !form.rawCaptureOnly) ? 'نموذج جزئي' : group.rawCaptureAvailable ? `جمع خام · ${group.rawCaptureFieldCount}` : 'قيد التعريف'}</span>
              </button>)}
            </div>
          </section>}
          {selectedGroup && <div className="stack tight">
            <div className="quote">
              <strong>{selectedGroup.forms.some((form) => !form.rawCaptureOnly) ? 'التغطية الدلالية المنشورة جزئية:' : selectedGroup.rawCaptureAvailable ? 'التقاط خام متاح لهذه المجموعة:' : 'لا يوجد نموذج إدخال لهذه المجموعة بعد:'}</strong>{' '}{selectedGroup.forms.some((form) => !form.rawCaptureOnly)
                ? `توجد ${selectedGroup.forms.filter((form) => !form.rawCaptureOnly).length} نماذج لحقول موصوفة؛ ${selectedGroup.rawCaptureFieldCount} حقلاً خاماً إضافياً متاحاً للمراجعة. نطاق النماذج الموصوفة لا يغطي عناصر المجال كاملة.`
                : selectedGroup.rawCaptureAvailable ? `أُنشئ نموذج عام يتيح التقاط ${selectedGroup.rawCaptureFieldCount} بنداً كما ورد في المواصفة، دون تحويلها إلى تعريفات أو وحدات أو أبعاد مفترضة.`
                  : 'يلزم تعريف موثوق قبل إنشاء نموذج دلالي. نقص المنهجيات لا يمنع جمع القيم الخام الواضحة.'}
              {selectedGroup.rawCaptureAvailable && <p>{selectedGroup.requirementItemCount} بنداً مفهرساً؛ تظهر العناصر غير المحسومة كحقول نصية للمراجعة، ولا تُستخدم في التحليل الرسمي.</p>}
              {!selectedGroup.forms.length && <p>{selectedGroup.fieldCoverageState === 'needs_domain_review'
                ? `عُثر على ${selectedGroup.fields.length} تعريفات مرشحة تحتاج ربطاً دلالياً؛ لم تُستخدم تلقائياً في النموذج الخام.`
                : 'لا توجد تعريفات حقول حالية مرتبطة بهذه المجموعة؛ يمكن بدء النموذج الدلالي بعد مراجعة مواصفة البيانات المتاحة.'}</p>}
            </div>
            {selectedGroup.fields?.length > 0 && <div className="quote">
              <strong>حقول موجودة تحتاج مراجعة دلالية ({selectedGroup.fields.length}):</strong>
              <p>هذه روابط مرشحة من قاموس النظام، وليست حقول إدخال معتمدة ولا تظهر في التحليلات قبل مراجعتها ونشر نموذج موثق.</p>
              <div className="row">{selectedGroup.fields.map((field) => <span className="chip" key={field.code} title={`${field.code} · ${field.semanticType} · ${field.dataType}`}>
                {field.name}{field.unit ? ` (${field.unit})` : ''}
              </span>)}</div>
            </div>}
          </div>}
        </div>
      </Card>
      <Card title={selectedGroup ? `إدخال البيانات — ${selectedGroup.name}` : 'الإدخال اليدوي'} subtitle="تعريفات النماذج والحقول تُقرأ من قاعدة البيانات؛ الحفظ ينشئ مسودة ومصدراً وسجل تغيير لكل تعديل.">
        {initialEntry.recordId && !editingRecord ? (
          <div className="quote">فُتح سجل المشروع المركزي المحدد. راجع حالته في قائمة السجلات أدناه؛ إذا كان معتمداً، أعد فتحه للتصحيح ثم اختر «تعديل المسودة». كل تعديل يُحفظ للمراجعة ولا يغيّر سجل المشاريع قبل الاعتماد.</div>
        ) : !hasGroupForm ? (
          <div className="quote"><ShieldAlert size={17} /> لم يُنشر نموذج جمع لهذه المجموعة بعد. نقص المنهجيات أو المراجع لا يمنع إنشاء نموذج أولي؛ المتاح حالياً هما السكان حسب العمر والجنس وسجل المنشآت التعليمية.</div>
        ) : (
          <form className="stack" onSubmit={submit}>
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
            <div className="quote">يشمل هذا النموذج {fmtNumber(entryFields.length, 0)} حقلًا موزعًا على مجموعات موضوعية. تُدخل القيم المعروفة يدويًا، وتُترك الحقول غير المتاحة أو غير المتحقق منها بحالتها المناسبة.</div>
            {groupedFields.map((group) => (
              <section className="card data-entry-section" key={group.id}>
                <header className="card-head"><div className="head-text"><h2>{group.title}</h2>{group.hint && <p>{group.hint}</p>}</div></header>
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
            <Field label="ملاحظات السجل"><textarea className="textarea" value={notes} onChange={(event) => setNotes(event.target.value)} /></Field>
            {(editingRecord || Object.values(valueStates).includes('clear')) && <Field label="سبب التعديل أو الحذف الصريح" required><TextInput required value={changeReason} onChange={setChangeReason} placeholder="اذكر سبب التغيير أو حذف القيمة" /></Field>}
            <div className="btn-row"><button type="submit" className="btn primary" disabled={saving}><Check size={15} />{saving ? 'جارٍ الحفظ...' : editingRecord ? 'حفظ التعديلات' : 'حفظ كمسودة'}</button>
              {editingRecord && <button type="button" className="btn" onClick={cancelEdit} disabled={saving}>إلغاء التعديل</button>}</div>
          </form>
        )}
      </Card>

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
        <div className="table-wrap"><table className="data"><thead><tr><th>السجل</th><th>النموذج</th><th>الموقع</th><th>الفترة</th><th>الحالة</th><th>القيم</th><th>الإجراءات</th></tr></thead>
          <tbody>{records.map((record) => (
            <tr key={record.form_record_id}>
              <td className="strong">{record.record_label || `سجل ${record.form_record_id}`}</td>
              <td>{record.form_name || '—'}</td>
              <td>{record.geo_name || '—'}</td><td>{record.period_label || 'غير محددة'}</td>
              <td>{STATUS_LABELS[record.record_status] ?? record.record_status}</td><td className="num">{record.value_count}</td>
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
        </table></div>
        {viewingRecord && viewingDefinition && <Card title={`تفاصيل السجل — ${viewingRecord.record.record_label || viewingRecord.record.form_record_id}`} subtitle="القيمة المسجلة وحالتها، والقيمة الخام والمعيارية، ومصدرها وموضعها، ومن أدخلها وتاريخ الإدخال.">
          <div className="row between"><span className="muted">{STATUS_LABELS[viewingRecord.record.record_status] ?? viewingRecord.record.record_status} · {viewingRecord.record.geo_name || 'دون موقع'} · {viewingRecord.record.period_label || 'دون فترة'}</span><button type="button" className="btn small" onClick={() => { setViewingRecord(null); setViewingDefinition(null); }}>إغلاق التفاصيل</button></div>
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
        </Card>}
        {records.length === 0 && <div className="empty-state"><ClipboardList size={22} /><strong>لا توجد سجلات ضمن المرشحات</strong><span>جرّب تغيير النموذج أو الحالة أو عبارة البحث.</span></div>}
        <div className="row between" style={{ marginTop: 12 }}><span className="muted">{recordTotal} سجلًا · صفحة {Math.floor(recordOffset / 30) + 1} من {Math.max(1,Math.ceil(recordTotal / 30))}</span><div className="btn-row"><button type="button" className="btn ghost small" onClick={() => setRecordOffset(Math.max(0,recordOffset-30))} disabled={recordOffset === 0}>السابق</button><button type="button" className="btn ghost small" onClick={() => setRecordOffset(recordOffset+30)} disabled={recordOffset+records.length>=recordTotal}>التالي</button><button type="button" className="btn ghost small" onClick={loadRecords}><RefreshCw size={13} /> تحديث</button></div></div>
      </Card>
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
