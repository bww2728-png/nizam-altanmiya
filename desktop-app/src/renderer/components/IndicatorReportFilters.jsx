import React from 'react';
import { Filter, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { Badge } from './ui.jsx';

const PRIORITY_OPTIONS = [
  { key: 'composite', label: 'درجة الاحتياج المركبة', type: 'number' },
  { key: 'rank', label: 'الترتيب', type: 'number' },
  { key: 'degradedCount', label: 'الأبعاد المتدهورة', type: 'number' },
  { key: 'weightCoverage', label: 'تغطية الأوزان %', type: 'ratio' },
  { key: 'severe', label: 'الحرمان الحاد', type: 'boolean' },
  { key: 'blocked', label: 'الحجب عن الترتيب', type: 'boolean' },
  { key: 'complete', label: 'اكتمال البيانات', type: 'boolean' },
  { key: 'anomalous', label: 'وجود قيمة شاذة', type: 'boolean' },
  { key: 'confidenceLevel', label: 'تصنيف الثقة', type: 'confidence' },
  { key: 'fragile', label: 'قرار هشّ بسبب الأوزان', type: 'boolean' },
  { key: 'maxRankShift', label: 'مدى تغيّر الرتبة بين الأوزان', type: 'number' },
];

function createCondition(field, code = '') {
  return { id: `${Date.now()}-${Math.random()}`, field, code, operator: 'range', min: '', max: '', value: '', exclude: false };
}

export default function IndicatorReportFilters({ registry, accessProfile, value, onChange, onApply, resultCount, loading }) {
  const criteria = value.criteria ?? [];
  const publicProfile = accessProfile === 'shared';
  const priority = PRIORITY_OPTIONS.filter((option) => !publicProfile || ![
    'composite', 'rank', 'degradedCount', 'weightCoverage', 'severe', 'blocked', 'complete', 'confidenceLevel', 'fragile', 'maxRankShift',
  ].includes(option.key));
  const controls = [
    ...registry.map((indicator) => ({ key: `metric:${indicator.code}`, field: 'metric', code: indicator.code, label: indicator.header, type: 'number' })),
    ...priority.map((option) => ({ ...option, field: option.key })),
  ];

  function update(patch) { onChange({ ...value, ...patch }); }
  function patchCondition(id, patch) { update({ criteria: criteria.map((condition) => condition.id === id ? { ...condition, ...patch } : condition) }); }
  function addCondition(key) {
    const option = controls.find((candidate) => candidate.key === key) ?? controls[0];
    if (option) update({ criteria: [...criteria, createCondition(option.field, option.code)] });
  }
  function conditionField(condition, selection) {
    const option = controls.find((candidate) => candidate.key === selection);
    if (option) patchCondition(condition.id, { field: option.field, code: option.code, operator: option.type === 'boolean' ? 'boolean' : option.type === 'confidence' ? 'equals' : 'range', min: '', max: '', value: '' });
  }
  function typeOf(condition) {
    if (condition.field === 'metric') return 'number';
    return controls.find((option) => option.field === condition.field)?.type ?? 'number';
  }
  function keyOf(condition) { return condition.field === 'metric' ? `metric:${condition.code}` : condition.field; }
  function labelOf(condition) { return controls.find((option) => option.key === keyOf(condition))?.label ?? condition.field; }

  return (
    <section className="report-builder indicator-builder">
      <div className="report-builder-head">
        <div><div className="report-kicker"><Filter size={14} /> منشئ تقرير المؤشرات</div><h3>فلترة القيم المحسوبة والأولويات والجودة</h3><p>البيانات الخام والجغرافيا تبقى في شاشة قاعدة البيانات؛ هنا تظهر المؤشرات والنتائج المشتقة فقط.</p></div>
        <Badge tone="gold">{criteria.length} شرط</Badge>
      </div>
      <div className="indicator-report-settings">
        <label>مسار الدرجة والرتبة<select className="input" value={value.mode} onChange={(event) => update({ mode: event.target.value })}><option value="calibrated">المعاير — لا يخلط مع مطابقة القالب</option><option value="replica">مطابقة القالب — المسار المرجعي</option></select></label>
        <label>القيم المعروضة والمفلترة<select className="input" value={value.view} onChange={(event) => update({ view: event.target.value })}><option value="values">القيم الأصلية للمؤشر</option><option value="scores">درجات الاحتياج 0–100</option><option value="contributions">المساهمة في المركّب</option></select></label>
        <label>الترتيب<select className="input" value={value.sort} onChange={(event) => update({ sort: event.target.value })}><option value="rank">الرتبة في المسار المختار</option><option value="composite">درجة المركّب</option>{registry.map((indicator) => <option key={indicator.code} value={indicator.code}>{indicator.header}</option>)}</select></label>
        <label>الاتجاه<select className="input" value={value.direction} onChange={(event) => update({ direction: event.target.value })}><option value="desc">تنازلي</option><option value="asc">تصاعدي</option></select></label>
        <label>منطق الشروط<select className="input" value={value.logic} onChange={(event) => update({ logic: event.target.value })}><option value="and">AND — كل الشروط</option><option value="or">OR — أي شرط</option></select></label>
      </div>
      {!publicProfile && criteria.some((condition) => ['fragile', 'maxRankShift'].includes(condition.field)) && <div className="report-sensitivity-note">تحليل حساسية الأوزان سيُحسب عند تطبيق الفلاتر؛ حساسية الحذف لا تُحسب للمجموعات الأكبر من 400 مديرية.</div>}
      <div className="report-condition-list">
        {criteria.map((condition) => {
          const type = typeOf(condition);
          const selection = keyOf(condition);
          return <div className="report-condition" key={condition.id}>
            <select className="input report-field-select" value={selection} onChange={(event) => conditionField(condition, event.target.value)} aria-label="المؤشر أو معيار الأولوية">{controls.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}</select>
            {type === 'number' || type === 'ratio' ? <><input className="input report-number" type="number" value={condition.min} placeholder="من" onChange={(event) => patchCondition(condition.id, { min: event.target.value })} /><input className="input report-number" type="number" value={condition.max} placeholder="إلى" onChange={(event) => patchCondition(condition.id, { max: event.target.value })} /><select className="input report-operator" value={condition.operator} onChange={(event) => patchCondition(condition.id, { operator: event.target.value })}><option value="range">ضمن النطاق</option><option value="empty">فارغ</option><option value="present">متوفر</option></select></>
              : type === 'boolean' ? <><select className="input report-control" value={condition.value} onChange={(event) => patchCondition(condition.id, { value: event.target.value })}><option value="">اختر</option><option value="true">نعم</option><option value="false">لا</option></select><select className="input report-operator" value={condition.operator} onChange={(event) => patchCondition(condition.id, { operator: event.target.value })}><option value="boolean">يساوي</option><option value="empty">غير متوفر</option></select></>
                : type === 'confidence' ? <select className="input report-control" value={condition.value} onChange={(event) => patchCondition(condition.id, { value: event.target.value })}><option value="">اختر التصنيف</option><option value="confirmed">مؤكدة</option><option value="boundary">حدّية</option><option value="preliminary">مبدئية</option><option value="blocked">محجوبة</option></select>
                  : null}
            <label className="report-check"><input type="checkbox" checked={Boolean(condition.exclude)} onChange={(event) => patchCondition(condition.id, { exclude: event.target.checked })} /> NOT</label>
            <button className="icon-button" title="إزالة الشرط" onClick={() => update({ criteria: criteria.filter((item) => item.id !== condition.id) })}><Trash2 size={15} /></button>
          </div>;
        })}
      </div>
      <div className="report-group-actions">
        <select className="input report-field-select" id="add-indicator-filter" defaultValue={controls[0]?.key}>{controls.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}</select>
        <button className="btn small ghost" onClick={() => addCondition(document.getElementById('add-indicator-filter')?.value)}><Plus size={14} /> إضافة معيار</button>
      </div>
      <div className="report-builder-footer">
        <button className="btn gold" disabled={loading} onClick={onApply}><Filter size={15} /> {loading ? 'جارٍ التطبيق...' : 'معاينة النتائج'}</button>
        <button className="btn ghost" onClick={() => onChange({ criteria: [], logic: 'and', mode: 'calibrated', view: 'values', sort: 'rank', direction: 'desc' })}><RotateCcw size={14} /> مسح الفلاتر</button>
        <strong>{Number(resultCount ?? 0).toLocaleString('ar')} نتيجة مطابقة</strong>
      </div>
    </section>
  );
}
