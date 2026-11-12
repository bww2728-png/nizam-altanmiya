import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Database, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { Badge, Card, Empty, ErrorBanner, Field, Loading, Modal, NumberInput, SelectInput, TextInput } from '../components/ui.jsx';
import { DASH, errText, fmtByType, fmtInt } from '../lib/format.js';

const PAGE_SIZES = [25, 50, 100];
const REFERENCE_KINDS = new Set(['reference', 'dimension', 'entity', 'geo', 'period', 'sector', 'unit', 'account', 'currency']);
const SYSTEM_FIELDS = new Set(['created_at', 'updated_at']);
const DASH_VALUE = DASH;
const FIELD_ERROR = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.+)$/;

function bridge() {
  return typeof window === 'undefined' ? null : window.localApp ?? null;
}

function isSystemField(field) {
  if (!field) return true;
  if (field.readOnly) return true;
  if (SYSTEM_FIELDS.has(field.name)) return true;
  return field.name.endsWith('_minor');
}

function isBlank(value) {
  return value === null || value === undefined || value === '';
}

function displayValue(field, labels, row) {
  const raw = row?.[field.name];
  if (raw === null || raw === undefined) return DASH_VALUE;
  if (REFERENCE_KINDS.has(field.type)) {
    const resolved = labels?.[field.name]?.[String(raw)];
    if (resolved) return resolved;
    return String(raw);
  }
  if (field.type === 'boolean') return Number(raw) === 1 ? 'نعم' : 'لا';
  return fmtByType(raw, field.type);
}

function errorLines(error) {
  return String(error?.message ?? error ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

export default function DomainRecords({ notify, refreshKey }) {
  const api = bridge()?.unified ?? null;
  const [datasets, setDatasets] = useState([]);
  const [layer, setLayer] = useState('');
  const [datasetKey, setDatasetKey] = useState('');
  const [schema, setSchema] = useState(null);
  const [rows, setRows] = useState([]);
  const [labels, setLabels] = useState({});
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState('');
  const [appliedSearch, setAppliedSearch] = useState('');
  const [sort, setSort] = useState('');
  const [limit, setLimit] = useState(50);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [schemaLoading, setSchemaLoading] = useState(false);
  const [error, setError] = useState('');
  const [editor, setEditor] = useState(null);
  const [options, setOptions] = useState({});
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!api) return;
      try {
        const listed = await api.datasets();
        if (cancelled) return;
        setDatasets(Array.isArray(listed) ? listed : []);
        setError('');
      } catch (cause) {
        if (!cancelled) setError(errText(cause) || 'تعذر تحميل قائمة مجموعات البيانات.');
      }
    })();
    return () => { cancelled = true; };
  }, [api, refreshKey]);

  useEffect(() => {
    const timer = setTimeout(() => { setAppliedSearch(search.trim()); setOffset(0); }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  const layers = useMemo(() => {
    const seen = new Map();
    datasets.forEach((item) => { if (item?.layer) seen.set(item.layer, item.layerLabelAr ?? item.layer); });
    return [...seen.entries()].map(([key, label]) => ({ value: key, label }));
  }, [datasets]);

  const visibleDatasets = useMemo(
    () => (layer ? datasets.filter((item) => item.layer === layer) : datasets).filter((item) => item.available),
    [datasets, layer]
  );

  useEffect(() => {
    if (datasetKey || !visibleDatasets.length) return;
    setDatasetKey(visibleDatasets[0].key);
  }, [visibleDatasets, datasetKey]);

  const loadRows = useCallback(async () => {
    if (!api || !datasetKey) return;
    setLoading(true);
    try {
      const payload = await api.list({
        dataset: datasetKey,
        search: appliedSearch,
        limit,
        offset,
        sort: sort || undefined,
      });
      setRows(Array.isArray(payload?.rows) ? payload.rows : []);
      setLabels(payload?.labels ?? {});
      setTotal(Number(payload?.total) || 0);
      setError('');
    } catch (cause) {
      setRows([]);
      setLabels({});
      setTotal(0);
      setError(errText(cause) || 'تعذر تحميل السجلات.');
    } finally {
      setLoading(false);
    }
  }, [api, datasetKey, appliedSearch, limit, offset, sort]);

  useEffect(() => { loadRows(); }, [loadRows, refreshKey]);

  useEffect(() => {
    if (!api || !datasetKey) return;
    let cancelled = false;
    setSchemaLoading(true);
    (async () => {
      try {
        const next = await api.describe(datasetKey);
        if (!cancelled) { setSchema(next); setSort(''); }
      } catch (cause) {
        if (!cancelled) { setSchema(null); setError(errText(cause) || 'تعذر وصف مجموعة البيانات.'); }
      } finally {
        if (!cancelled) setSchemaLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [api, datasetKey]);

  const fields = schema?.fields ?? [];
  const tableFields = fields.filter((field) => !SYSTEM_FIELDS.has(field.name)).slice(0, 8);
  const editableFields = fields.filter((field) => !isSystemField(field));
  const datasetMeta = datasets.find((item) => item.key === datasetKey) ?? null;
  const pages = Math.max(1, Math.ceil(total / limit));
  const currentPage = Math.floor(offset / limit) + 1;

  const loadOptions = useCallback(async (field, currentValue) => {
    if (!api || !REFERENCE_KINDS.has(field.type)) return [];
    const key = `${field.type}:${field.ref?.filter?.dimensionCode ?? ''}`;
    try {
      const listed = await api.options({
        kind: field.type,
        filter: field.ref?.filter ?? undefined,
        limit: 300,
      });
      const options = Array.isArray(listed) ? listed : [];
      if (!isBlank(currentValue) && !options.some((option) => String(option.value) === String(currentValue))) {
        options.push({ value: String(currentValue), label: `${currentValue} (قيمة حالية)` });
      }
      return options;
    } catch {
      return isBlank(currentValue) ? [] : [{ value: String(currentValue), label: `${currentValue} (قيمة حالية)` }];
    }
  }, [api]);

  const openEditor = useCallback(async (mode, row) => {
    const draft = {};
    editableFields.forEach((field) => {
      const value = row?.[field.name];
      draft[field.name] = value === null || value === undefined ? '' : String(value);
    });
    setEditor({ mode, id: row?.[schema?.pk] ?? null, draft, errors: {}, reason: '', banner: '' });
    if (!editableFields.some((field) => REFERENCE_KINDS.has(field.type))) return;
    const loaded = {};
    for (const field of editableFields) {
      if (!REFERENCE_KINDS.has(field.type)) continue;
      loaded[field.name] = await loadOptions(field, row?.[field.name]);
    }
    setOptions(loaded);
  }, [editableFields, loadOptions, schema?.pk]);

  async function submitEditor() {
    if (!editor || !api) return;
    const reason = editor.reason.trim();
    if (reason.length < 3) {
      setEditor((current) => ({ ...current, banner: 'سبب التعديل مطلوب (٣ أحرف على الأقل).' }));
      return;
    }
    const values = {};
    const clientErrors = {};
    editableFields.forEach((field) => {
      const raw = editor.draft[field.name];
      if (isBlank(raw)) {
        values[field.name] = null;
        return;
      }
      if (field.type === 'integer' || field.type === 'decimal') {
        const number = Number(raw);
        if (!Number.isFinite(number)) clientErrors[field.name] = 'قيمة رقمية غير صالحة.';
        values[field.name] = number;
        return;
      }
      if (field.type === 'boolean') {
        values[field.name] = raw === 'true' || raw === '1' || raw === 'نعم';
        return;
      }
      values[field.name] = typeof raw === 'string' ? raw.trim() : raw;
    });
    if (Object.keys(clientErrors).length) {
      setEditor((current) => ({ ...current, errors: clientErrors, banner: 'تحقق من القيم الرقمية.' }));
      return;
    }
    setSaving(true);
    try {
      await api.save({ dataset: datasetKey, id: editor.id ?? undefined, values, reason });
      setEditor(null);
      await loadRows();
      notify?.({ tone: 'ok', message: editor.mode === 'create' ? 'أُضيف السجل بنجاح.' : 'حُدّث السجل بنجاح.' });
    } catch (cause) {
      const errors = {};
      let banner = '';
      errorLines(cause).forEach((line) => {
        const match = FIELD_ERROR.exec(line);
        if (match && fields.some((field) => field.name === match[1])) errors[match[1]] = match[2];
        else banner = banner ? `${banner}\n${line}` : line;
      });
      setEditor((current) => ({ ...current, errors, banner: banner || 'تعذر حفظ السجل.' }));
    } finally {
      setSaving(false);
    }
  }

  async function confirmRemove() {
    if (!removing || !api) return;
    const reason = (removing.reason ?? '').trim();
    if (reason.length < 3) {
      setRemoving((current) => ({ ...current, banner: 'سبب الحذف مطلوب (٣ أحرف على الأقل).' }));
      return;
    }
    try {
      await api.remove({ dataset: datasetKey, id: removing.id, reason });
      setRemoving(null);
      await loadRows();
      notify?.({ tone: 'ok', message: 'حُذف السجل.' });
    } catch (cause) {
      setRemoving((current) => ({ ...current, banner: errText(cause) || 'تعذر حذف السجل.' }));
    }
  }

  if (!api) {
    return (
      <Card title="سجلات البيانات الموحدة">
        <Empty
          icon={Database}
          title="جسر البيانات الموحدة غير متاح"
          hint="هذه النافذة تحتاج واجهة window.localApp.unified. أعد تشغيل التطبيق بالنسخة التي تسجل قنوات البيانات الموحدة."
        />
      </Card>
    );
  }

  return (
    <>
      {error && <ErrorBanner message={error} onDismiss={() => setError('')} />}
      <Card
        title="سجلات البيانات الموحدة"
        subtitle="إدخال وإدارة كل مجموعات البيانات التنموية الموحدة من مسار واحد، مع تدقيق كامل لكل تغيير."
        icon={Database}
        actions={(
          <div className="btn-row">
            <span className="chip gold">{fmtInt(total)} سجل</span>
            <button className="btn small" onClick={loadRows} disabled={loading}><RefreshCw size={15} /> تحديث</button>
            <button className="btn small primary" onClick={() => openEditor('create', null)} disabled={!schema || !editableFields.length}><Plus size={15} /> سجل جديد</button>
          </div>
        )}
      >
        <div className="segmented" role="tablist">
          <button className={`seg-btn${layer === '' ? ' active' : ''}`} onClick={() => setLayer('')}>كل الطبقات</button>
          {layers.map((item) => (
            <button key={item.value} className={`seg-btn${layer === item.value ? ' active' : ''}`} onClick={() => setLayer(item.value)}>{item.label}</button>
          ))}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(240px, 320px) 1fr', gap: 16, marginTop: 14 }}>
          <div className="table-wrap" style={{ maxHeight: 460, overflow: 'auto' }}>
            <table className="data">
              <thead><tr><th>المجموعة</th><th className="num">السجلات</th></tr></thead>
              <tbody>
                {visibleDatasets.map((item) => (
                  <tr key={item.key} onClick={() => { setDatasetKey(item.key); setOffset(0); }} style={{ cursor: 'pointer' }}>
                    <td className="strong">{item.labelAr}{datasetKey === item.key && <Badge tone="gold"> معروضة</Badge>}</td>
                    <td className="num">{fmtInt(item.count ?? 0)}</td>
                  </tr>
                ))}
                {!visibleDatasets.length && <tr><td colSpan={2}><Empty icon={Database} title="لا توجد مجموعات متاحة" hint="لم تُطبَّق ترحيلات النموذج الموحد بعد على قاعدة البيانات." /></td></tr>}
              </tbody>
            </table>
          </div>

          <div>
            <div className="btn-row" style={{ marginBottom: 10 }}>
              <TextInput value={search} onChange={setSearch} placeholder="بحث في السجلات..." />
              <SelectInput
                value={sort}
                onChange={(value) => { setSort(value); setOffset(0); }}
                options={[{ value: '', label: 'الترتيب الافتراضي' }, ...fields.map((field) => ({ value: field.name, label: `${field.labelAr} (تصاعدي)` })), ...fields.map((field) => ({ value: `-${field.name}`, label: `${field.labelAr} (تنازلي)` }))]}
              />
              <SelectInput value={String(limit)} onChange={(value) => { setLimit(Number(value)); setOffset(0); }} options={PAGE_SIZES.map((size) => ({ value: String(size), label: `${size} / صفحة` }))} />
            </div>

            {datasetMeta?.description && <p className="field-hint">{datasetMeta.description}</p>}
            {schemaLoading && <Loading label="جارٍ وصف الحقول..." />}
            {!schemaLoading && !fields.length && <Empty icon={Database} title="لا حقول" hint="لم يتم العثور على أعمدة لهذه المجموعة." />}

            {!schemaLoading && fields.length > 0 && (
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      {tableFields.map((field) => <th key={field.name}>{field.labelAr}</th>)}
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row, index) => (
                      <tr key={String(row[schema?.pk] ?? index)}>
                        {tableFields.map((field) => <td key={field.name}>{displayValue(field, labels, row)}</td>)}
                        <td className="num">
                          <button className="btn small ghost" onClick={() => openEditor('edit', row)}><Pencil size={14} /> تعديل</button>
                          <button className="btn small danger" onClick={() => setRemoving({ id: row[schema?.pk], banner: '', reason: '' })}><Trash2 size={14} /> حذف</button>
                        </td>
                      </tr>
                    ))}
                    {!rows.length && <tr><td colSpan={tableFields.length + 1}><Empty icon={Database} title="لا سجلات" hint="لم تُطابق أي سجلات الشروط الحالية." /></td></tr>}
                  </tbody>
                </table>
              </div>
            )}

            <div className="btn-row" style={{ marginTop: 10 }}>
              <button className="btn small" disabled={currentPage <= 1 || loading} onClick={() => setOffset(Math.max(0, offset - limit))}>السابق</button>
              <span className="chip">صفحة {fmtInt(currentPage)} من {fmtInt(pages)}</span>
              <button className="btn small" disabled={currentPage >= pages || loading} onClick={() => setOffset(offset + limit)}>التالي</button>
            </div>
          </div>
        </div>
      </Card>

      <Modal
        open={Boolean(editor)}
        wide
        title={editor?.mode === 'create' ? `سجل جديد — ${datasetMeta?.labelAr ?? ''}` : `تعديل سجل — ${datasetMeta?.labelAr ?? ''}`}
        subtitle="تُتحقق القيم في الطبقة المركزية قبل الحفظ، ويُسجَّل التغيير في سجل التدقيق."
        onClose={() => setEditor(null)}
        footer={(
          <div className="btn-row">
            <button className="btn primary" onClick={submitEditor} disabled={saving}>{saving ? 'جارٍ الحفظ...' : 'حفظ'}</button>
            <button className="btn ghost" onClick={() => setEditor(null)} disabled={saving}>إلغاء</button>
          </div>
        )}
      >
        {editor?.banner && <ErrorBanner message={editor.banner} onDismiss={() => setEditor((current) => ({ ...current, banner: '' }))} />}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
          {editableFields.map((field) => {
            const value = editor?.draft[field.name] ?? '';
            const setValue = (next) => setEditor((current) => ({ ...current, draft: { ...current.draft, [field.name]: next } }));
            const fieldError = editor?.errors?.[field.name];
            const control = (() => {
              if (field.type === 'boolean') {
                return (
                  <SelectInput
                    value={value}
                    onChange={setValue}
                    options={[{ value: '', label: '— غير محدد —' }, { value: 'true', label: 'نعم' }, { value: 'false', label: 'لا' }]}
                  />
                );
              }
              if (REFERENCE_KINDS.has(field.type)) {
                const listed = options[field.name];
                return (
                  <SelectInput
                    value={value}
                    onChange={setValue}
                    options={[{ value: '', label: listed ? '— بدون —' : 'جارٍ تحميل الخيارات...' }, ...(listed ?? []).map((option) => ({ value: String(option.value), label: option.subtitle ? `${option.label} — ${option.subtitle}` : option.label }))]}
                  />
                );
              }
              if (field.type === 'integer' || field.type === 'decimal') {
                return <NumberInput value={value} onChange={setValue} invalid={Boolean(fieldError)} step={field.type === 'integer' ? '1' : 'any'} />;
              }
              if (field.type === 'date' || field.type === 'datetime') {
                return <TextInput value={value} onChange={setValue} placeholder="YYYY-MM-DD" />;
              }
              return <TextInput value={value} onChange={setValue} placeholder={field.labelAr} />;
            })();
            return (
              <Field key={field.name} label={field.labelAr} required={Boolean(field.required)} error={fieldError} hint={field.note}>
                {control}
              </Field>
            );
          })}
          <Field label="سبب التعديل" required error={editor?.errors?.reason} hint="يُحفظ في سجل التدقيق مع القيم السابقة والجديدة.">
            <TextInput value={editor?.reason ?? ''} onChange={(next) => setEditor((current) => ({ ...current, reason: next }))} placeholder="سبب التعديل" />
          </Field>
        </div>
        {Boolean(schema?.missingColumns?.length) && (
          <p className="field-hint">أعمدة معلنة في السجل المعياري وغير موجودة في قاعدة البيانات الحالية: {schema.missingColumns.join('، ')}</p>
        )}
      </Modal>

      <Modal
        open={Boolean(removing)}
        title="تأكيد الحذف"
        subtitle="لا يمكن التراجع عن الحذف، ويُسجَّل في سجل التدقيق."
        onClose={() => setRemoving(null)}
        footer={(
          <div className="btn-row">
            <button className="btn danger" onClick={confirmRemove}>حذف نهائي</button>
            <button className="btn ghost" onClick={() => setRemoving(null)}>إلغاء</button>
          </div>
        )}
      >
        {removing?.banner && <ErrorBanner message={removing.banner} onDismiss={() => setRemoving((current) => ({ ...current, banner: '' }))} />}
        <Field label="سبب الحذف" required>
          <TextInput value={removing?.reason ?? ''} onChange={(next) => setRemoving((current) => ({ ...current, reason: next }))} placeholder="سبب الحذف" />
        </Field>
      </Modal>
    </>
  );
}