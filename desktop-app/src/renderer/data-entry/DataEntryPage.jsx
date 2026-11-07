import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Check, FileScan, Pencil, Plus, RefreshCw, Save, Search, Trash2, X,
} from 'lucide-react';
import '../analysis/analysis.css';
import './data-entry.css';

const arNumber = new Intl.NumberFormat('ar');

/** Fields that live on the record identity rather than in the values bag. */
const IDENTITY_KEYS = new Set(['districtName', 'governorate']);

/** The A..AM columns, grouped for a form a human can actually fill. */
const GROUPS = [
  { id: 'identity', title: 'الهوية', keys: ['districtName', 'governorate'] },
  { id: 'population', title: 'السكان', keys: ['districtNature', 'population', 'migrants', 'densityPerKm2', 'ruralPopulation', 'expectedBeneficiaries'] },
  {
    id: 'services',
    title: 'الخدمات والبنية التحتية',
    keys: ['schools', 'enrolledStudents', 'govFacilities', 'privateFacilities', 'waterCoverage', 'pavedRoads', 'unpavedRoads', 'cutRoads', 'serviceDistanceKm', 'serviceGapType', 'geographicDispersion'],
  },
  {
    id: 'economy',
    title: 'الاقتصاد والمعيشة',
    keys: ['revenue', 'agriProduction', 'livestockHeads', 'valueChains', 'inactiveValueChains', 'unemployment', 'lostOpportunityType', 'associations', 'goodsTons'],
  },
  { id: 'sensitive', title: 'الحساسية والحرمان', keys: ['frontLine', 'povertyRatio', 'vulnerableGroups'] },
  {
    id: 'project',
    title: 'المشروع والمواءمة',
    keys: ['projectCost', 'projectStatus', 'partnerIntegration', 'communityParticipation', 'sustainabilityCriteria', 'projectContinuity', 'needAlignment', 'nationalAlignment'],
  },
];

const SENSITIVITY_LABEL = { restricted: 'مقيّد', sensitive: 'حساس' };

function pct(value) {
  if (value === null || value === undefined || value === '') return '—';
  const numeric = Number(value);
  return Number.isFinite(numeric) ? `${Math.round(numeric * 100)}%` : '—';
}

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('ar');
}

export default function DataEntryPage({ onToast, onError }) {
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [fields, setFields] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [search, setSearch] = useState('');
  const [governorate, setGovernorate] = useState('');
  const [form, setForm] = useState(null);
  const [ocr, setOcr] = useState(null);
  const [ocrBusy, setOcrBusy] = useState(false);

  const notify = useCallback((message) => { if (onToast) onToast(message); }, [onToast]);
  const fail = useCallback((cause, fallback) => { if (onError) onError(cause?.message || fallback); }, [onError]);

  const fieldMap = useMemo(() => new Map(fields.map((field) => [field.key, field])), [fields]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await window.localApp.directorates({ limit: 5000 });
      setRows(result.rows ?? []);
      setTotal(result.total ?? (result.rows?.length ?? 0));
    } catch (cause) {
      fail(cause, 'تعذر تحميل المديريات.');
    } finally {
      setLoading(false);
    }
  }, [fail]);

  useEffect(() => {
    load();
    window.localApp.fieldCatalogue()
      .then(setFields)
      .catch((cause) => fail(cause, 'تعذر تحميل حقول النموذج؛ أعد فتح الصفحة قبل الإدخال.'));
  }, [load, fail]);

  const governorates = useMemo(
    () => [...new Set(rows.map((row) => row.governorate).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ar')),
    [rows],
  );

  const visible = useMemo(() => {
    const term = search.trim().toLocaleLowerCase('ar');
    return rows.filter((row) => (!governorate || row.governorate === governorate)
      && (!term || `${row.district} ${row.governorate}`.toLocaleLowerCase('ar').includes(term)));
  }, [rows, search, governorate]);

  function emptyForm() {
    const values = {};
    for (const field of fields) {
      if (IDENTITY_KEYS.has(field.key)) continue;
      values[field.key] = '';
    }
    return { id: null, districtName: '', governorate: '', values };
  }

  function startAdd() {
    setOcr(null);
    setForm(emptyForm());
  }

  function cancelForm() {
    setForm(null);
    setOcr(null);
  }

  function updateValue(key, value) {
    setForm((previous) => (previous ? { ...previous, values: { ...previous.values, [key]: value } } : previous));
  }

  function updateIdentity(key, value) {
    setForm((previous) => (previous ? { ...previous, [key]: value } : previous));
  }

  async function editRow(row) {
    setBusy(`edit-${row.id}`);
    try {
      const detail = await window.localApp.getDirectorate(row.id);
      const values = {};
      for (const field of fields) {
        if (IDENTITY_KEYS.has(field.key)) continue;
        const value = detail.values?.[field.key];
        values[field.key] = value === null || value === undefined ? '' : String(value);
      }
      setOcr(null);
      setForm({
        id: detail.dbId ?? row.id,
        districtName: detail.districtName ?? '',
        governorate: detail.governorate ?? '',
        values,
      });
    } catch (cause) {
      fail(cause, 'تعذر تحميل بيانات المديرية.');
    } finally {
      setBusy('');
    }
  }

  async function saveForm() {
    if (!form) return;
    if (!form.districtName.trim()) {
      fail({ message: 'اسم المديرية مطلوب قبل الحفظ.' }, '');
      return;
    }
    setBusy('save');
    try {
      const payload = {
        districtName: form.districtName,
        governorate: form.governorate,
        values: form.values,
      };
      if (form.id) payload.id = form.id;
      const result = await window.localApp.saveDirectorate(payload);
      notify(result?.created ? 'أُضيفت المديرية إلى قاعدة البيانات.' : 'حُدّثت المديرية في قاعدة البيانات.');
      setForm(null);
      setOcr(null);
      await load();
    } catch (cause) {
      fail(cause, 'تعذر حفظ المديرية.');
    } finally {
      setBusy('');
    }
  }

  async function deleteRow(row) {
    const confirmed = window.confirm(`حذف «${row.district}» نهائيًا؟\nسيُحذف سجلها وحقول مصدرها، وتبقى نتائج التحليل السابقة كما هي.`);
    if (!confirmed) return;
    setBusy(`delete-${row.id}`);
    try {
      await window.localApp.deleteDirectorate(row.id);
      notify('حُذفت المديرية.');
      if (form?.id === row.id) cancelForm();
      await load();
    } catch (cause) {
      fail(cause, 'تعذر حذف المديرية.');
    } finally {
      setBusy('');
    }
  }

  async function runOcr() {
    setOcrBusy(true);
    try {
      const result = await window.localApp.readOcrEntry();
      if (result.canceled) return;
      setOcr(result);
      const count = Object.keys(result.parsed?.fields ?? {}).length;
      notify(`قُرئ «${result.fileName}»: ${count} حقلًا مقترحًا. راجعها ثم اضغط «تطبيق المقترحات».`);
    } catch (cause) {
      fail(cause, 'تعذرت قراءة الملف بالـOCR.');
    } finally {
      setOcrBusy(false);
    }
  }

  /**
   * Applies the OCR proposal only on an explicit click. Auto-filling would risk
   * clobbering an edit the user opened while a slow OCR pass was still running.
   */
  function applyOcr() {
    const parsed = ocr?.parsed?.fields ?? {};
    if (!Object.keys(parsed).length) {
      fail({ message: 'لا توجد حقول مقترحة لتطبيقها.' }, '');
      return;
    }
    const base = form ?? emptyForm();
    const next = { ...base, values: { ...base.values } };
    for (const [key, entry] of Object.entries(parsed)) {
      if (key === 'districtName') next.districtName = String(entry.value ?? '');
      else if (key === 'governorate') next.governorate = String(entry.value ?? '');
      else next.values[key] = entry.value === null || entry.value === undefined ? '' : String(entry.value);
    }
    setForm(next);
    notify('طُبّقت مقترحات OCR على النموذج. راجع القيم ثم احفظ.');
  }

  return <div className="data-entry-page">
    <div className="page-heading">
      <div>
        <p className="eyebrow">الإدخال المباشر</p>
        <h1>إدخال البيانات</h1>
        <p>أضف المديريات أو عدّلها أو احذفها هنا، أو اقرأ نموذجًا ورقيًا بالـOCR ثم راجع القيم قبل حفظها. كل قيمة تُسجَّل في سجل التدقيق.</p>
      </div>
      <div className="entry-actions">
        <button className="secondary-button" onClick={runOcr} disabled={ocrBusy || Boolean(busy)}>
          <FileScan size={16} />{ocrBusy ? 'جارٍ قراءة OCR...' : 'قراءة نموذج بالـOCR'}
        </button>
        <button className="primary-button" onClick={startAdd} disabled={Boolean(busy) || ocrBusy}>
          <Plus size={16} />إضافة مديرية
        </button>
      </div>
    </div>

    {ocr && <section className="panel ocr-panel">
      <div className="panel-heading">
        <div>
          <h2>نتيجة OCR: {ocr.fileName}</h2>
          <p>{ocr.pagesRead ?? ocr.pages ?? 1} من {ocr.pages ?? 1} صفحة · ثقة المحرك {Math.round((ocr.confidence ?? 0) * 100)}% · {Object.keys(ocr.parsed?.fields ?? {}).length} حقلًا مطابقًا. النص مسودة، وليست بيانات معتمدة.</p>
        </div>
        <div className="ocr-actions">
          <button className="primary-button" onClick={applyOcr} disabled={!Object.keys(ocr.parsed?.fields ?? {}).length}><Check size={15} />تطبيق المقترحات</button>
          <button className="quiet-button" onClick={() => setOcr(null)}><X size={15} />إغلاق</button>
        </div>
      </div>
      {(ocr.warnings?.length > 0 || ocr.truncated || ocr.textTruncated) && <div className="inline-warning">
        {[...(ocr.warnings ?? []), ocr.truncated ? 'قُرئ جزء من الملف فقط؛ أكمل الباقي يدويًا.' : null, ocr.textTruncated ? 'عُرض جزء من النص الخام فقط.' : null].filter(Boolean).join(' ')}
      </div>}
      {ocr.parsed?.warnings?.length > 0 && <div className="inline-warning">تنبيهات الحقول: {ocr.parsed.warnings.slice(0, 8).map((warning) => `${warning.header}: ${warning.code}`).join(' · ')}</div>}
      <div className="ocr-fields">
        {Object.entries(ocr.parsed?.fields ?? {}).map(([key, entry]) => <span key={key} className="ocr-chip">
          {entry.header}
          <b>{String(entry.value)}</b>
          <em>تطابق {Math.round(entry.score * 100)}%</em>
        </span>)}
        {!Object.keys(ocr.parsed?.fields ?? {}).length && <span className="muted">لم يُطابق أي حقل تلقائيًا؛ املأ النموذج يدويًا.</span>}
      </div>
      {ocr.parsed?.unmatched?.length > 0 && <details className="ocr-unmatched">
        <summary>أسطر لم تُطابق ({ocr.parsed.unmatched.length})</summary>
        <ul>{ocr.parsed.unmatched.slice(0, 30).map((item, index) => <li key={`${item.reason}-${index}`}><span>{item.reason}</span>{item.raw}</li>)}</ul>
      </details>}
      <details className="ocr-text">
        <summary>النص الخام</summary>
        <pre dir="auto">{ocr.text}</pre>
      </details>
    </section>}

    {form && <section className="panel entry-form-panel">
      <div className="panel-heading">
        <div>
          <h2>{form.id ? `تعديل مديرية #${form.id}` : 'إضافة مديرية جديدة'}</h2>
          <p>الحقول الفارغة تُحفظ كـ«لا بيانات». النسب تُقبل ككسر (0.197) أو نسبة مئوية (19.7).</p>
        </div>
        <button className="quiet-button" onClick={cancelForm}><X size={15} />إلغاء</button>
      </div>

      <div className="entry-identity">
        <label className="entry-field">
          <span>اسم المديرية <b className="required">*</b></span>
          <input value={form.districtName} onChange={(event) => updateIdentity('districtName', event.target.value)} placeholder="مثال: مديرية الشعر" />
        </label>
        <label className="entry-field">
          <span>المحافظة</span>
          <input value={form.governorate} onChange={(event) => updateIdentity('governorate', event.target.value)} placeholder="مثال: إب" list="entry-governorates" />
          <datalist id="entry-governorates">{governorates.map((name) => <option key={name} value={name} />)}</datalist>
        </label>
      </div>

      {GROUPS.filter((group) => group.id !== 'identity').map((group) => <fieldset key={group.id} className="entry-group">
        <legend>{group.title}</legend>
        <div className="entry-grid">
          {group.keys.map((key) => {
            const field = fieldMap.get(key);
            if (!field) return null;
            return <FieldInput key={key} field={field} value={form.values[key] ?? ''} onChange={updateValue} />;
          })}
        </div>
      </fieldset>)}

      <div className="entry-footer">
        <span className="muted">{form.id ? 'التعديل يستبدل القيم الظاهرة ويحدّث سجل المصدر.' : 'سيُسجَّل المصدر «إدخال يدوي» مع كل قيمة.'}</span>
        <button className="primary-button" onClick={saveForm} disabled={busy === 'save'}>
          <Save size={16} />{busy === 'save' ? 'جارٍ الحفظ...' : 'حفظ المديرية'}
        </button>
      </div>
    </section>}

    <section className="panel table-panel">
      <div className="panel-heading">
        <div>
          <h2>المديريات المسجّلة</h2>
          <p>{arNumber.format(total)} مديرية · {arNumber.format(visible.length)} ظاهرة حسب التصفية{rows.length < total ? ` · تُعرض ${arNumber.format(rows.length)} فقط (حد الشاشة)` : ''}</p>
        </div>
        <div className="entry-toolbar">
          <label className="search-box"><Search size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="بحث باسم المديرية أو المحافظة" /></label>
          <select className="entry-select" value={governorate} onChange={(event) => setGovernorate(event.target.value)}>
            <option value="">كل المحافظات</option>
            {governorates.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
          <button className="icon-button" title="تحديث" onClick={load} disabled={Boolean(busy) || ocrBusy}><RefreshCw size={16} /></button>
        </div>
      </div>
      <div className="table-scroll"><table className="analysis-table">
        <thead><tr>
          <th>#</th><th>المديرية</th><th>المحافظة</th><th>الطبيعة</th><th>السكان</th><th>تغطية المياه</th><th>آخر تحديث</th><th>الإجراءات</th>
        </tr></thead>
        <tbody>{visible.map((row) => <tr key={row.id}>
          <td className="rank-cell">{row.id}</td>
          <td className="district-cell">{row.district}</td>
          <td>{row.governorate || '—'}</td>
          <td>{row.nature || '—'}</td>
          <td className="num-cell">{row.population === null || row.population === undefined ? '—' : arNumber.format(row.population)}</td>
          <td className="num-cell">{pct(row.water_coverage)}</td>
          <td>{formatDate(row.updated_at)}</td>
          <td className="entry-row-actions">
            <button className="quiet-button" onClick={() => editRow(row)} disabled={Boolean(busy) || ocrBusy}><Pencil size={14} />تعديل</button>
            <button className="quiet-button danger-text" onClick={() => deleteRow(row)} disabled={Boolean(busy) || ocrBusy}><Trash2 size={14} />حذف</button>
          </td>
        </tr>)}</tbody>
      </table></div>
      {loading && <div className="table-empty">جارٍ التحميل...</div>}
      {!loading && !visible.length && <div className="table-empty">لا توجد مديريات مطابقة. أضف مديرية أو استورد ملف القالب.</div>}
    </section>
  </div>;
}

function FieldInput({ field, value, onChange }) {
  const hint = field.type === 'ratio' ? 'كسر 0..1 أو %' : (field.unit || null);
  const sensitivity = field.sensitivity && field.sensitivity !== 'public' ? SENSITIVITY_LABEL[field.sensitivity] : null;

  let control;
  if (field.type === 'boolean') {
    control = <select value={String(value ?? '')} onChange={(event) => onChange(field.key, event.target.value)}>
      <option value="">غير محدد</option>
      <option value="1">نعم</option>
      <option value="0">لا</option>
    </select>;
  } else if (field.type === 'number' || field.type === 'ratio') {
    control = <input
      type="number"
      step="any"
      value={value ?? ''}
      onChange={(event) => onChange(field.key, event.target.value)}
      placeholder={field.type === 'ratio' ? '0.000' : '0'}
    />;
  } else {
    control = <input type="text" value={value ?? ''} onChange={(event) => onChange(field.key, event.target.value)} />;
  }

  return <label className={`entry-field ${field.type === 'ratio' || field.type === 'number' ? 'numeric' : ''}`}>
    <span>
      {field.header}
      {sensitivity && <em className={`sensitivity-chip ${field.sensitivity}`}>{sensitivity}</em>}
    </span>
    {control}
    <small>{hint ?? `${field.type === 'boolean' ? 'نعم/لا' : 'نص'}`}</small>
  </label>;
}