import React, { useEffect, useMemo, useState } from 'react';
import { Filter, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { Badge } from './ui.jsx';

const GROUPS = [
  { key: 'geography', title: 'الجغرافيا والإدارة', fields: ['__district', 'districtNature'] },
  { key: 'population', title: 'السكان والديموغرافيا', fields: ['population', 'migrants', 'densityPerKm2', 'expectedBeneficiaries', 'ruralPopulation'] },
  { key: 'services', title: 'الخدمات والبنية التحتية', fields: ['waterCoverage', 'serviceGapType', 'pavedRoads', 'unpavedRoads', 'cutRoads', 'serviceDistanceKm', 'schools', 'enrolledStudents', 'govFacilities', 'privateFacilities'] },
  { key: 'economy', title: 'الاقتصاد والإنتاج', fields: ['revenue', 'agriProduction', 'livestockHeads', 'valueChains', 'inactiveValueChains', 'unemployment', 'lostOpportunityType', 'associations', 'goodsTons'] },
  { key: 'vulnerability', title: 'الفقر والهشاشة والمخاطر', fields: ['povertyRatio', 'vulnerableGroups', 'frontLine', 'geographicDispersion'] },
  { key: 'projects', title: 'المشاريع والجاهزية', fields: ['projectCost', 'projectStatus', 'partnerIntegration', 'communityParticipation', 'sustainabilityCriteria', 'projectContinuity', 'needAlignment', 'nationalAlignment', 'reviewerDecision'] },
  { key: 'quality', title: 'جودة البيانات واكتمالها', fields: ['__completeness', '__missingField', '__qualityLevel'] },
  { key: 'source', title: 'المصدر والتاريخ', fields: ['__sourceFile', '__sourceSheet', '__sourceRow', '__createdAt', '__updatedAt'] },
];

const VIRTUAL_FIELDS = {
  __district: { key: '__district', header: 'المديرية', type: 'text' },
  __completeness: { key: '__completeness', header: 'اكتمال الحقول الإلزامية %', type: 'ratio' },
  __missingField: { key: '__missingField', header: 'حقل أو أكثر غير متوفر', type: 'list' },
  __qualityLevel: { key: '__qualityLevel', header: 'تحذيرات الاستيراد', type: 'quality' },
  __sourceFile: { key: '__sourceFile', header: 'ملف المصدر', type: 'text' },
  __sourceSheet: { key: '__sourceSheet', header: 'ورقة المصدر', type: 'text' },
  __sourceRow: { key: '__sourceRow', header: 'رقم صف المصدر', type: 'number' },
  __createdAt: { key: '__createdAt', header: 'تاريخ الاستيراد', type: 'date' },
  __updatedAt: { key: '__updatedAt', header: 'آخر تحديث', type: 'date' },
};

function newCondition(key, fieldsByKey) {
  const field = fieldsByKey.get(key);
  const operator = field?.type === 'number' || field?.type === 'ratio' ? 'range'
    : field?.type === 'boolean' ? 'equals' : field?.type === 'list' ? 'in'
      : field?.type === 'quality' ? 'in' : field?.type === 'date' ? 'range' : 'contains';
  return { id: `${Date.now()}-${Math.random()}`, key, operator, min: '', max: '', value: '', values: [], exclude: false, missing: 'exclude' };
}

export function DatabaseReportFilters({ catalogue, accessProfile, value, onChange, onApply, resultCount, loading }) {
  const fieldsByKey = useMemo(() => {
    const fields = [...catalogue.filter((field) => !['governorate', 'reviewerDecision'].includes(field.key)
      || (field.key === 'reviewerDecision' && accessProfile !== 'shared'))];
    for (const field of Object.values(VIRTUAL_FIELDS)) fields.push(field);
    return new Map(fields.map((field) => [field.key, field]));
  }, [catalogue, accessProfile]);
  const criteria = value.criteria ?? [];
  const [filterOptions, setFilterOptions] = useState({});
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

  const visibleGroups = useMemo(() => GROUPS.map((group) => ({
    ...group,
    fields: group.fields.map((key) => fieldsByKey.get(key)).filter((field) => field
      && (field.sensitivity === undefined || accessProfile !== 'shared' || field.sensitivity === 'public')),
  })).filter((group) => group.fields.length), [fieldsByKey, accessProfile]);

  function update(patch) { onChange({ ...value, ...patch }); }
  function updateCondition(id, patch) {
    update({ criteria: criteria.map((item) => item.id === id ? { ...item, ...patch } : item) });
  }
  function changeField(item, key) {
    const replacement = newCondition(key, fieldsByKey);
    updateCondition(item.id, replacement);
  }
  function addCondition(key) {
    update({ criteria: [...criteria, newCondition(key, fieldsByKey)] });
  }
  function removeCondition(id) { update({ criteria: criteria.filter((item) => item.id !== id) }); }

  function conditionControls(item, field) {
    if (field.type === 'number' || field.type === 'ratio') {
      return (
        <>
          <input className="input report-number" type="number" value={item.min} placeholder="من" onChange={(event) => updateCondition(item.id, { min: event.target.value })} />
          <input className="input report-number" type="number" value={item.max} placeholder="إلى" onChange={(event) => updateCondition(item.id, { max: event.target.value })} />
          <label className="report-check"><input type="checkbox" checked={item.missing === 'include'} onChange={(event) => updateCondition(item.id, { missing: event.target.checked ? 'include' : 'exclude' })} /> مع الفارغ</label>
        </>
      );
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
      const choices = catalogue.filter((candidate) => candidate.sensitivity === 'public' || accessProfile !== 'shared');
      return <select className="input report-multiselect" multiple size={3} value={item.values} onChange={(event) => updateCondition(item.id, { values: [...event.target.selectedOptions].map((option) => option.value) })}>{choices.map((choice) => <option key={choice.key} value={choice.key}>{choice.header}</option>)}</select>;
    }
    const options = filterOptions[item.key] ?? [];
    return <>
      <select className="input report-control" value={item.operator} onChange={(event) => updateCondition(item.id, { operator: event.target.value, values: [] })}>
        <option value="contains">يحتوي على</option><option value="in">يساوي إحدى القيم</option><option value="not-in">لا يساوي القيم</option><option value="empty">فارغ</option><option value="present">غير فارغ</option>
      </select>
      {['in', 'not-in'].includes(item.operator) && options.length > 0
        ? <select className="input report-multiselect" multiple size={3} value={item.values} onChange={(event) => updateCondition(item.id, { values: [...event.target.selectedOptions].map((option) => option.value) })}>{options.map((option) => <option key={option} value={option}>{option}</option>)}</select>
        : item.operator === 'contains' && <input className="input report-control" value={item.value} placeholder="اكتب نصًا" onChange={(event) => updateCondition(item.id, { value: event.target.value })} />}
    </>;
  }

  return (
    <section className="report-builder">
      <div className="report-builder-head">
        <div><div className="report-kicker"><Filter size={14} /> منشئ تقرير البيانات</div><h3>حدّد نطاق البيانات وشروط المطابقة</h3><p>الفلاتر الخام والجغرافية هنا؛ أما المؤشرات والترتيب فلهما منشئ مستقل في شاشة المؤشرات.</p></div>
        <Badge tone="gold">{criteria.length} شرط</Badge>
      </div>
      <div className="report-geo-grid">
        <label>بحث باسم المديرية<input className="input" value={value.search ?? ''} onChange={(event) => update({ search: event.target.value })} placeholder="اسم كامل أو جزء منه" /></label>
        <label>المحافظات <select className="input report-multiselect" multiple size={3} value={value.governorates ?? []} onChange={(event) => update({ governorates: [...event.target.selectedOptions].map((option) => option.value) })}>{governors.map((name) => <option key={name} value={name}>{name}</option>)}</select><small>اختيار عدة محافظات يعني «أو» بينها.</small></label>
        <label>منطق الشروط <select className="input" value={value.logic ?? 'and'} onChange={(event) => update({ logic: event.target.value })}><option value="and">AND — كل الشروط</option><option value="or">OR — أي شرط</option></select></label>
      </div>
      <div className="report-group-list">
        {visibleGroups.map((group) => {
          const active = criteria.filter((item) => group.fields.some((field) => field.key === item.key));
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
                  <button className="icon-button" title="إزالة الشرط" onClick={() => removeCondition(item.id)}><Trash2 size={15} /></button>
                </div>;
              })}
              <div className="report-group-actions">
                <select className="input report-field-select" id={`add-${group.key}`} defaultValue={group.fields[0]?.key}>{group.fields.map((field) => <option key={field.key} value={field.key}>{field.header}</option>)}</select>
                <button className="btn small ghost" onClick={() => addCondition(document.getElementById(`add-${group.key}`)?.value ?? group.fields[0]?.key)}><Plus size={14} /> إضافة شرط</button>
              </div>
            </div>
          </details>;
        })}
      </div>
      <div className="report-builder-footer">
        <button className="btn gold" disabled={loading} onClick={onApply}><Filter size={15} /> {loading ? 'جارٍ التطبيق...' : 'تطبيق الفلاتر'}</button>
        <button className="btn ghost" onClick={() => { onChange({ search: '', governorates: [], logic: 'and', criteria: [] }); }}><RotateCcw size={14} /> مسح الكل</button>
        <strong>{Number(resultCount ?? 0).toLocaleString('ar')} مديرية مطابقة</strong>
      </div>
    </section>
  );
}
