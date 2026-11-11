import React, { useEffect, useMemo, useState } from 'react';
import { Eye, EyeOff, Filter, Plus, RotateCcw, Search, Trash2 } from 'lucide-react';
import { Badge } from './ui.jsx';

const VIRTUAL_FIELDS = {
  __district: { key: '__district', header: 'المديرية', type: 'text', filterGroup: 'geography', filterGroupLabel: 'الجغرافيا والإدارة' },
  __completeness: { key: '__completeness', header: 'اكتمال الحقول الإلزامية %', type: 'ratio', filterGroup: 'quality', filterGroupLabel: 'جودة البيانات واكتمالها' },
  __missingField: { key: '__missingField', header: 'حقل أو أكثر غير متوفر', type: 'list', filterGroup: 'quality', filterGroupLabel: 'جودة البيانات واكتمالها' },
  __qualityLevel: { key: '__qualityLevel', header: 'تحذيرات الاستيراد', type: 'quality', filterGroup: 'quality', filterGroupLabel: 'جودة البيانات واكتمالها' },
  __sourceFile: { key: '__sourceFile', header: 'ملف المصدر', type: 'text', filterGroup: 'source', filterGroupLabel: 'المصدر والتاريخ' },
  __sourceSheet: { key: '__sourceSheet', header: 'ورقة المصدر', type: 'text', filterGroup: 'source', filterGroupLabel: 'المصدر والتاريخ' },
  __sourceRow: { key: '__sourceRow', header: 'رقم صف المصدر', type: 'number', filterGroup: 'source', filterGroupLabel: 'المصدر والتاريخ' },
  __createdAt: { key: '__createdAt', header: 'تاريخ الاستيراد', type: 'date', filterGroup: 'source', filterGroupLabel: 'المصدر والتاريخ' },
  __updatedAt: { key: '__updatedAt', header: 'آخر تحديث', type: 'date', filterGroup: 'source', filterGroupLabel: 'المصدر والتاريخ' },
};

const GROUP_LABELS = {
  geography: 'الجغرافيا والإدارة',
  attributes: 'الخصائص العامة',
  measurements: 'البيانات والقياسات',
  projects: 'المشاريع',
  review: 'حالة المراجعة',
  system: 'حقول النظام',
};

function newCondition(key, fieldsByKey) {
  const field = fieldsByKey.get(key);
  const operator = field?.type === 'number' || field?.type === 'ratio' || field?.type === 'date' ? 'range'
    : field?.type === 'boolean' ? 'equals' : field?.type === 'list' ? 'in'
      : field?.type === 'quality' ? 'in' : 'contains';
  return { id: `${Date.now()}-${Math.random()}`, key, operator, min: '', max: '', value: '', values: [], exclude: false, missing: 'exclude' };
}

function getGroups(fields) {
  const groups = new Map();
  for (const field of fields) {
    const key = field.filterGroup ?? 'measurements';
    const title = field.filterGroupLabel ?? GROUP_LABELS[key] ?? 'البيانات والقياسات';
    if (!groups.has(key)) groups.set(key, { key, title, fields: [] });
    groups.get(key).fields.push(field);
  }
  return [...groups.values()];
}

export function DatabaseReportFilters({ catalogue, accessProfile, value, onChange, onApply, resultCount, loading }) {
  const fieldsByKey = useMemo(() => {
    const fields = catalogue.filter((field) => field.filterable !== false
      && !['governorate', 'reviewerDecision'].includes(field.key)
      && (accessProfile !== 'shared' || field.sensitivity === 'public'));
    for (const field of Object.values(VIRTUAL_FIELDS)) fields.push(field);
    return new Map(fields.map((field) => [field.key, field]));
  }, [catalogue, accessProfile]);
  const criteria = value.criteria ?? [];
  const [filterOptions, setFilterOptions] = useState({});
  const [filterSearch, setFilterSearch] = useState('');
  const [expanded, setExpanded] = useState(true);
  const [hiddenFields, setHiddenFields] = useState(() => new Set());
  const groups = useMemo(() => getGroups([...fieldsByKey.values()]), [fieldsByKey]);
  const governors = filterOptions.__governorate ?? [];

  useEffect(() => {
    let active = true;
    window.localApp.directorateFilterOptions(['__governorate']).then((options) => {
      if (active) setFilterOptions((current) => ({ ...current, ...options }));
    }).catch(() => {});
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const keys = [...new Set(criteria.map((item) => item.key).filter((key) => (
      fieldsByKey.get(key)?.type === 'text' && key !== '__district'
    )))].filter((key) => !filterOptions[key]);
    if (!keys.length) return undefined;
    let active = true;
    window.localApp.directorateFilterOptions(keys).then((options) => {
      if (active) setFilterOptions((current) => ({ ...current, ...options }));
    }).catch(() => {});
    return () => { active = false; };
  }, [criteria, fieldsByKey, filterOptions]);

  const activeSearch = filterSearch.trim().toLocaleLowerCase();
  const searchResults = activeSearch ? [...fieldsByKey.values()].filter((field) => {
    const group = field.filterGroupLabel ?? GROUP_LABELS[field.filterGroup] ?? '';
    const haystack = [field.header, field.technicalName, field.key, field.description, group, ...(field.aliases ?? []), ...(field.searchTerms ?? [])].join(' ').toLocaleLowerCase();
    return haystack.includes(activeSearch) && !criteria.some((item) => item.key === field.key);
  }).slice(0, 20) : [];

  function update(patch) { onChange({ ...value, ...patch }); }
  function updateCondition(id, patch) {
    update({ criteria: criteria.map((item) => item.id === id ? { ...item, ...patch } : item) });
  }
  function changeField(item, key) {
    updateCondition(item.id, newCondition(key, fieldsByKey));
  }
  function addCondition(key) {
    if (!key || criteria.some((item) => item.key === key)) return;
    setHiddenFields((current) => { const next = new Set(current); next.delete(key); return next; });
    update({ criteria: [...criteria, newCondition(key, fieldsByKey)] });
  }
  function removeCondition(id) { update({ criteria: criteria.filter((item) => item.id !== id) }); }
  function hideCondition(key) { setHiddenFields((current) => new Set(current).add(key)); }
  function showCondition(key) { setHiddenFields((current) => { const next = new Set(current); next.delete(key); return next; }); }

  function conditionControls(item, field) {
    if (field.type === 'number' || field.type === 'ratio') {
      return <>
        <input className="input report-number" type="number" value={item.min} placeholder="من" onChange={(event) => updateCondition(item.id, { min: event.target.value })} />
        <input className="input report-number" type="number" value={item.max} placeholder="إلى" onChange={(event) => updateCondition(item.id, { max: event.target.value })} />
        <label className="report-check"><input type="checkbox" checked={item.missing === 'include'} onChange={(event) => updateCondition(item.id, { missing: event.target.checked ? 'include' : 'exclude' })} /> مع الفارغ</label>
      </>;
    }
    if (field.type === 'boolean') {
      return <select className="input report-control" value={item.value} onChange={(event) => updateCondition(item.id, { value: event.target.value })}><option value="">اختر</option><option value="1">نعم</option><option value="0">لا</option></select>;
    }
    if (field.type === 'date' || item.key === '__sourceRow') {
      return <>
        <input className="input report-control" type={field.type === 'date' ? 'date' : 'number'} value={item.min} aria-label="من" onChange={(event) => updateCondition(item.id, { min: event.target.value })} />
        <input className="input report-control" type={field.type === 'date' ? 'date' : 'number'} value={item.max} aria-label="إلى" onChange={(event) => updateCondition(item.id, { max: event.target.value })} />
      </>;
    }
    if (field.type === 'quality') {
      return <select className="input report-control" value={item.values[0] ?? ''} onChange={(event) => updateCondition(item.id, { values: event.target.value ? [event.target.value] : [] })}><option value="">اختر</option><option value="warnings">به تحذير استيراد</option><option value="clean">بلا تحذيرات استيراد</option></select>;
    }
    if (field.type === 'list') {
      const choices = catalogue.filter((candidate) => candidate.filterable !== false
        && !['governorate', 'reviewerDecision'].includes(candidate.key)
        && (candidate.sensitivity === 'public' || accessProfile !== 'shared'));
      return <select className="input report-multiselect" multiple size={3} value={item.values} onChange={(event) => updateCondition(item.id, { values: [...event.target.selectedOptions].map((option) => option.value) })}>{choices.map((choice) => <option key={choice.key} value={choice.key}>{choice.header}</option>)}</select>;
    }
    const options = filterOptions[item.key] ?? [];
    return <>
      <select className="input report-control" value={item.operator} onChange={(event) => updateCondition(item.id, { operator: event.target.value, values: [] })}>
        <option value="contains">يحتوي على</option><option value="in">يساوي إحدى القيم</option><option value="not-in">لا يساوي القيم</option><option value="empty">فارغ</option><option value="present">غير فارغ</option>
      </select>
      {['in', 'not-in'].includes(item.operator) && options.length > 0
        ? <select className="input report-multiselect" multiple size={3} value={item.values} onChange={(event) => updateCondition(item.id, { values: [...event.target.selectedOptions].map((option) => option.value) })}>{options.map((option) => <option key={option} value={option}>{option}</option>)}</select>
        : ['in', 'not-in'].includes(item.operator)
          ? <input className="input report-control" value={item.values.join(', ')} placeholder="اكتب قيمًا مفصولة بفواصل" onChange={(event) => updateCondition(item.id, { values: event.target.value.split(/[,،]/).map(option => option.trim()).filter(Boolean) })} />
          : item.operator === 'contains' && <input className="input report-control" value={item.value} placeholder="اكتب نصًا" onChange={(event) => updateCondition(item.id, { value: event.target.value })} />}
    </>;
  }

  return (
    <section className="report-builder">
      <div className="report-builder-head">
        <div><div className="report-kicker"><Filter size={14} /> منشئ تقرير البيانات</div><h3>حدّد نطاق البيانات وشروط المطابقة</h3><p>تُبنى الحقول من تعريفات قاعدة البيانات النشطة، وتُنفّذ التصفية محليًا قبل تقسيم النتائج إلى صفحات.</p></div>
        <div className="btn-row"><Badge tone="gold">{criteria.length} شرط نشط</Badge><button className="btn small ghost" onClick={() => setExpanded((current) => !current)} aria-expanded={expanded}>{expanded ? <EyeOff size={14} /> : <Eye size={14} />}{expanded ? 'إخفاء الفلاتر' : 'إظهار الفلاتر'}</button></div>
      </div>
      {criteria.filter((item) => hiddenFields.has(item.key)).length > 0 && <div className="chip-row" aria-label="فلاتر مخفية لكنها مطبقة">
        {criteria.filter((item) => hiddenFields.has(item.key)).map((item) => <button className="chip" key={item.id} onClick={() => showCondition(item.key)} title="إظهار الفلتر دون إلغاء تطبيقه">{fieldsByKey.get(item.key)?.header ?? item.key} · مطبق · إظهار</button>)}
      </div>}
      {expanded && <>
        <div className="report-geo-grid">
          <label>بحث باسم المديرية<input className="input" value={value.search ?? ''} onChange={(event) => update({ search: event.target.value })} placeholder="اسم كامل أو جزء منه" /></label>
          <label>المحافظات <select className="input report-multiselect" multiple size={3} value={value.governorates ?? []} onChange={(event) => update({ governorates: [...event.target.selectedOptions].map((option) => option.value) })}>{governors.map((name) => <option key={name} value={name}>{name}</option>)}</select><small>اختيار عدة محافظات يعني «أو» بينها.</small></label>
          <label>الفترة المرجعية<input className="input" value={value.periodKey ?? ''} onChange={(event) => update({ periodKey: event.target.value })} placeholder="فارغ للقيم العامة؛ مثال: 2025" maxLength={80} /></label>
          <label>منطق الشروط <select className="input" value={value.logic ?? 'and'} onChange={(event) => update({ logic: event.target.value })}><option value="and">AND — كل الشروط</option><option value="or">OR — أي شرط</option></select></label>
        </div>
        <label className="stack tight" style={{ marginTop: 14 }}><span>ابحث عن فلتر حسب الاسم أو المرادف أو الوصف أو الاسم الفني</span><div className="search-field"><Search size={16} /><input className="input" value={filterSearch} onChange={(event) => setFilterSearch(event.target.value)} placeholder="مثال: السكان، project cost، أو وصف الحقل" /></div></label>
        {searchResults.length > 0 && <div className="report-column-picker" role="listbox" aria-label="حقول مطابقة للبحث">
          {searchResults.map((field) => <button className="btn small ghost" key={field.key} onClick={() => addCondition(field.key)} title={field.description || field.technicalName}><Plus size={13} />{field.header}<span className="muted">{field.technicalName}</span></button>)}
        </div>}
        <div className="report-group-list">
          {groups.map((group) => {
            const active = criteria.filter((item) => group.fields.some((field) => field.key === item.key) && !hiddenFields.has(item.key));
            const available = group.fields.filter((field) => !criteria.some((item) => item.key === field.key));
            if (!active.length && !available.length) return null;
            return <details className="report-filter-group" key={group.key} open={Boolean(active.length)}>
              <summary><span>{group.title}</span><Badge>{active.length} نشط</Badge></summary>
              <div className="report-filter-group-body">
                {active.map((item) => {
                  const field = fieldsByKey.get(item.key);
                  return <div className="report-condition" key={item.id}>
                    <select className="input report-field-select" value={item.key} onChange={(event) => changeField(item, event.target.value)} aria-label="الحقل">
                      {group.fields.map((choice) => <option key={choice.key} value={choice.key}>{choice.header}</option>)}
                    </select>
                    {conditionControls(item, field)}
                    <label className="report-check"><input type="checkbox" checked={Boolean(item.exclude)} onChange={(event) => updateCondition(item.id, { exclude: event.target.checked })} /> NOT</label>
                    <button className="icon-button" title="إخفاء هذا الفلتر مع إبقاء شرطه مطبقًا" onClick={() => hideCondition(item.key)}><EyeOff size={15} /></button>
                    <button className="icon-button" title="إزالة الشرط" onClick={() => removeCondition(item.id)}><Trash2 size={15} /></button>
                  </div>;
                })}
                {available.length > 0 && <div className="report-group-actions">
                  <select className="input report-field-select" id={`add-${group.key}`} defaultValue={available[0]?.key}>{available.map((field) => <option key={field.key} value={field.key}>{field.header}</option>)}</select>
                  <button className="btn small ghost" onClick={() => addCondition(document.getElementById(`add-${group.key}`)?.value ?? available[0]?.key)}><Plus size={14} /> إضافة شرط</button>
                </div>}
              </div>
            </details>;
          })}
        </div>
      </>}
      <div className="report-builder-footer">
        <button className="btn gold" disabled={loading} onClick={onApply}><Filter size={15} /> {loading ? 'جارٍ التطبيق...' : 'تطبيق الفلاتر'}</button>
        <button className="btn ghost" onClick={() => { setHiddenFields(new Set()); onChange({ search: '', governorates: [], periodKey: '', logic: 'and', criteria: [] }); }}><RotateCcw size={14} /> مسح الكل</button>
        <strong>{Number(resultCount ?? 0).toLocaleString('ar')} مديرية مطابقة</strong>
      </div>
    </section>
  );
}
