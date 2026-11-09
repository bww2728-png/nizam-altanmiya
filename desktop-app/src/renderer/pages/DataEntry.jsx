import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, ClipboardList, RefreshCw, Search, Send, ShieldAlert } from 'lucide-react';
import { Card, Field, Loading, SelectInput, TextInput } from '../components/ui.jsx';
import { errText } from '../lib/format.js';

const STATUS_LABELS = {
  draft: 'مسودة', pending_review: 'قيد المراجعة', approved: 'معتمد', rejected: 'مرفوض', superseded: 'مستبدل', archived: 'مؤرشف',
};
const VALUE_STATE_LABELS = {
  known: 'قيمة معروفة', zero: 'صفر فعلي', not_available: 'غير متوفر', unknown: 'غير معروف',
  not_applicable: 'لا ينطبق', not_collected: 'لم يُجمع', not_verified: 'غير متحقق منه',
};

export default function DataEntry({ notify, refreshKey = 0 }) {
  const [forms, setForms] = useState([]);
  const [formVersionId, setFormVersionId] = useState('');
  const [definition, setDefinition] = useState(null);
  const [geography, setGeography] = useState([]);
  const [periods, setPeriods] = useState([]);
  const [records, setRecords] = useState([]);
  const [recordSearchInput, setRecordSearchInput] = useState('');
  const [recordSearch, setRecordSearch] = useState('');
  const [recordStatus, setRecordStatus] = useState('all');
  const [recordFormVersionId, setRecordFormVersionId] = useState('');
  const [recordOffset, setRecordOffset] = useState(0);
  const [recordTotal, setRecordTotal] = useState(0);
  const [values, setValues] = useState({});
  const [valueStates, setValueStates] = useState({});
  const [recordLabel, setRecordLabel] = useState('');
  const [notes, setNotes] = useState('');
  const [geoUnitId, setGeoUnitId] = useState('');
  const [periodId, setPeriodId] = useState('');
  const [periodYear, setPeriodYear] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editingRecord, setEditingRecord] = useState(null);
  const [changeReason, setChangeReason] = useState('');
  const [reviewReasons, setReviewReasons] = useState({});

  const activeForms = useMemo(() => forms.filter((form) => form.is_active && form.form_version_id && form.version_status === 'published'), [forms]);

  const loadForms = useCallback(async () => {
    setLoading(true);
    try {
      const [formRows, geoResult, periodResult] = await Promise.all([
        window.localApp.dataForms(), window.localApp.dataGeography(''), window.localApp.dataPeriods(),
      ]);
      setForms(formRows ?? []);
      setGeography(geoResult?.rows ?? []);
      setPeriods(periodResult?.rows ?? []);
      const active = (formRows ?? []).find((form) => form.is_active && form.form_version_id && form.version_status === 'published');
      setFormVersionId((current) => current || String(active?.form_version_id ?? ''));
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
  }, [notify, recordFormVersionId, recordOffset, recordSearch, recordStatus]);

  useEffect(() => { loadForms(); }, [loadForms]);
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
        setRecordLabel(record?.record?.record_label ?? '');
        setNotes(record?.record?.notes ?? '');
        setGeoUnitId(record?.record?.geo_unit_id == null ? '' : String(record.record.geo_unit_id));
        setPeriodId(record?.record?.period_id == null ? '' : String(record.record.period_id));
        setPeriodYear(record?.record?.period_year == null ? '' : String(record.record.period_year));
        setChangeReason('');
      })
      .catch((cause) => notify({ tone: 'bad', message: errText(cause) || 'تعذر تحميل النموذج.' }));
    return () => { active = false; };
  }, [formVersionId, editingRecord, notify]);

  const beginEdit = async (formRecordId) => {
    try {
      const record = await window.localApp.dataRecord(formRecordId);
      setEditingRecord(record);
      setFormVersionId(String(record.record.form_version_id));
    } catch (cause) {
      notify({ tone: 'bad', message: errText(cause) || 'تعذر تحميل السجل للتعديل.' });
    }
  };

  const cancelEdit = () => {
    setEditingRecord(null);
    setValues({});
    setValueStates({});
    setRecordLabel('');
    setNotes('');
    setGeoUnitId('');
    setPeriodId('');
    setPeriodYear('');
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
        recordLabel: recordLabel.trim() || null, notes: notes.trim() || null, values: payload, changeReason: changeReason.trim() || null,
      });
      notify({ tone: 'ok', message: `${editingRecord ? 'حُدّث' : 'حُفظ'} السجل ${saved.formRecordId} كمسودة، مع توثيق مصدر الإدخال.` });
      setEditingRecord(null);
      setValues({});
      setValueStates({});
      setRecordLabel('');
      setNotes('');
      setGeoUnitId('');
      setPeriodId('');
      setPeriodYear('');
      setChangeReason('');
      await loadRecords();
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
    } catch (cause) {
      notify({ tone: 'bad', message: errText(cause) || 'تعذر تنفيذ قرار المراجعة.' });
    }
  };

  const formOptions = forms.map((form) => ({
    value: String(form.form_version_id ?? ''),
    label: `${form.form_code} — ${form.name_ar}${form.is_active ? '' : ' (غير معرّف)'}`,
    disabled: !form.is_active || !form.form_version_id || form.version_status !== 'published',
  }));
  const geoOptions = [{ value: '', label: '— دون ربط جغرافي —' }, ...geography.map((unit) => ({
    value: String(unit.geo_unit_id), label: `${unit.type_name_ar} — ${unit.name_ar}${unit.parent_name_ar ? ` / ${unit.parent_name_ar}` : ''}`,
  }))];
  const periodOptions = [{ value: '', label: '— فترة غير محددة —' }, ...periods.map((period) => ({ value: String(period.period_id), label: period.label_ar }))];

  if (loading && forms.length === 0) return <Card><Loading label="جارٍ تحميل كتالوج البيانات..." /></Card>;

  return (
    <div className="stack">
      <Card title="الإدخال اليدوي المركزي" subtitle="تعريفات النماذج والحقول تُقرأ من قاعدة البيانات؛ الحفظ ينشئ مسودة ومصدراً وسجل تغيير لكل تعديل.">
        {activeForms.length === 0 ? (
          <div className="notice warn"><ShieldAlert size={17} /><span>لا يوجد نموذج منشور قابل للإدخال. النموذج المتاح حالياً للمديريات يستلزم تعريفاً موثوقاً قبل نشره؛ لن نُفعّل الحقول الوصفية غير المحسومة تلقائياً.</span></div>
        ) : (
          <form className="stack" onSubmit={submit}>
            <div className="form-grid">
              <Field label="النموذج" required>
                <SelectInput value={formVersionId} onChange={(value) => { cancelEdit(); setFormVersionId(value); }} options={formOptions} />
              </Field>
              <Field label="الوحدة الجغرافية">
                <SelectInput value={geoUnitId} onChange={setGeoUnitId} options={geoOptions} />
              </Field>
              <Field label="الفترة المرجعية">
                <SelectInput value={periodId} onChange={(value) => { setPeriodId(value); setPeriodYear(''); }} options={periodOptions} />
              </Field>
              <Field label="أو سنة ميلادية جديدة" hint="تُضاف كفترة مرجعية للسنة التي أدخلتها.">
                <TextInput type="number" min="1900" max="2200" step="1" value={periodYear} onChange={(value) => { setPeriodYear(value); setPeriodId(''); }} placeholder="2025" />
              </Field>
              <Field label="عنوان السجل">
                <TextInput value={recordLabel} onChange={setRecordLabel} />
              </Field>
            </div>
            {definition?.sections?.map((section) => {
              const sectionFields = definition.fields.filter((field) => field.section_id === section.section_id);
              if (!sectionFields.length) return null;
              return (
                <section className="card data-entry-section" key={section.section_id}>
                  <header className="card-head"><div className="head-text"><h2>{section.name_ar}</h2></div></header>
                  <div className="card-body"><div className="form-grid">
                    {sectionFields.map((field) => <DefinitionField key={field.form_field_id} field={field} value={values[field.field_code] ?? ''} state={valueStates[field.field_code] ?? 'known'} editingRecord={Boolean(editingRecord)} onChange={(value) => setValues((current) => ({ ...current, [field.field_code]: value }))} onStateChange={(state) => {
                      setValueStates((current) => ({ ...current, [field.field_code]: state }));
                      if (state === 'zero') setValues((current) => ({ ...current, [field.field_code]: '0' }));
                    }} />)}
                  </div></div>
                </section>
              );
            })}
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
                {record.record_status === 'draft' && <button className="btn small" onClick={() => review(record.form_record_id,'submit')}><Send size={13} />إرسال</button>}
                {['pending_review','approved'].includes(record.record_status) && <TextInput value={reviewReasons[record.form_record_id] ?? ''} onChange={(value) => setReviewReasons((current) => ({ ...current,[record.form_record_id]:value }))} placeholder={record.record_status === 'approved' ? 'سبب إعادة الفتح' : 'سبب الإعادة'} />}
                {record.record_status === 'pending_review' && <><button className="btn small primary" onClick={() => review(record.form_record_id,'approve')}><Check size={13} />اعتماد</button><button className="btn small" onClick={() => review(record.form_record_id,'return')}>إعادة</button></>}
                {record.record_status === 'approved' && <button className="btn small" onClick={() => review(record.form_record_id,'reopen')}>إعادة فتح للتصحيح</button>}
              </div></td>
            </tr>
          ))}</tbody>
        </table></div>
        {records.length === 0 && <div className="empty-state"><ClipboardList size={22} /><strong>لا توجد سجلات ضمن المرشحات</strong><span>جرّب تغيير النموذج أو الحالة أو عبارة البحث.</span></div>}
        <div className="row between" style={{ marginTop: 12 }}><span className="muted">{recordTotal} سجلًا · صفحة {Math.floor(recordOffset / 30) + 1} من {Math.max(1,Math.ceil(recordTotal / 30))}</span><div className="btn-row"><button type="button" className="btn ghost small" onClick={() => setRecordOffset(Math.max(0,recordOffset-30))} disabled={recordOffset === 0}>السابق</button><button type="button" className="btn ghost small" onClick={() => setRecordOffset(recordOffset+30)} disabled={recordOffset+records.length>=recordTotal}>التالي</button><button type="button" className="btn ghost small" onClick={loadRecords}><RefreshCw size={13} /> تحديث</button></div></div>
      </Card>
    </div>
  );
}

function DefinitionField({ field, value, state, editingRecord, onChange, onStateChange }) {
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
  else if (field.storage_class === 'reference_value' || type === 'reference' || type === 'entity_reference') input = <TextInput disabled={disabled || !['known','zero'].includes(state)} type="number" value={value} onChange={onChange} placeholder="معرّف مرجعي" />;
  else {
    const inputType = numeric ? 'text' : type === 'date' ? 'date' : 'text';
    input = <TextInput disabled={disabled || !['known','zero'].includes(state)} type={inputType} value={value} onChange={onChange} inputMode={numeric ? 'decimal' : undefined} />;
  }
  return <Field label={field.label_ar} required={Boolean(field.is_required)} hint={hint}>
    <div className="stack tight">
      <SelectInput disabled={disabled} value={state} onChange={onStateChange} options={stateOptions} />
      {input}
    </div>
  </Field>;
}
