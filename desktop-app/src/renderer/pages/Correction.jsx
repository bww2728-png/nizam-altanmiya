import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle, CheckCircle2, History, PenLine, Plus, RotateCcw, Save,
  Search, Trash2, Users, XCircle,
} from 'lucide-react';
import {
  Badge, Bar, Card, Empty, ErrorBanner, Field, Loading, Modal, NumberInput,
  SelectInput, TextInput,
} from '../components/ui.jsx';
import { cx, errText, fmtDateTime, fmtNumber, toNumber } from '../lib/format.js';
import { DECISION_KEY, groupCatalogue, MANDATORY_FALLBACK } from '../lib/fields.js';

/**
 * «تصحيح البيانات»
 *
 * The workbook is the entry path, but a plan can legitimately leave cells empty
 * (a mandatory field missing, a value refused as unparsable). This screen is
 * where those records are completed by hand — with the same parser and the same
 * validation the importer uses, so a typed value and an imported one store
 * identically.
 */
export default function Correction({ catalogue, notify, refreshKey, focusId = null }) {
  const [search, setSearch] = useState('');
  const [governorate, setGovernorate] = useState('');
  const [list, setList] = useState({ rows: [], total: 0 });
  const [ranking, setRanking] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedId, setSelectedId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [versions, setVersions] = useState([]);
  const [confirmDelete, setConfirmDelete] = useState(false);

  /* ---------------------------------------------------------------- loading */

  const loadList = useCallback(async () => {
    setLoading(true);
    try {
      const [rows, rank] = await Promise.all([
        window.localApp.directorates({ search: search.trim() || undefined, governorate: governorate || undefined, limit: 3000 }),
        window.localApp.sheetRanking({ mode: 'calibrated' }),
      ]);
      setList({ rows: rows.rows ?? [], total: rows.total ?? 0 });
      setRanking(rank);
    } catch (cause) {
      setError(errText(cause) || 'تعذر تحميل المديريات.');
    } finally {
      setLoading(false);
    }
  }, [search, governorate]);

  useEffect(() => {
    const timer = setTimeout(loadList, 220);
    return () => clearTimeout(timer);
  }, [loadList, refreshKey]);

  // Arriving from a directorate card ("تحرير هذا السجل") selects that record.
  useEffect(() => {
    if (focusId !== null && focusId !== undefined) {
      setCreating(false);
      setSelectedId(Number(focusId));
    }
  }, [focusId]);

  const loadDetail = useCallback(async (id) => {
    if (id === null || id === undefined) { setDetail(null); return; }
    setDetailLoading(true);
    try {
      setDetail(await window.localApp.getDirectorate(id));
    } catch (cause) {
      setError(errText(cause) || 'تعذر تحميل بطاقة المديرية.');
    } finally {
      setDetailLoading(false);
    }
  }, []);

  useEffect(() => { loadDetail(selectedId); }, [selectedId, loadDetail]);

  const anomalies = useMemo(() => new Map((ranking?.anomalies ?? []).map((item) => [item.directorateId, item])), [ranking]);
  const waiting = useMemo(() => new Map((ranking?.waiting ?? []).map((item) => [item.directorateId, item])), [ranking]);

  const groups = useMemo(() => groupCatalogue(catalogue), [catalogue]);
  const mandatoryKeys = useMemo(() => {
    const flagged = catalogue.filter((field) => field.mandatory).map((field) => field.key);
    return flagged.length ? flagged : MANDATORY_FALLBACK;
  }, [catalogue]);
  const decisionField = catalogue.find((field) => field.key === DECISION_KEY) ?? null;

  const governorateOptions = useMemo(() => {
    const names = [...new Set(list.rows.map((row) => row.governorate).filter(Boolean))].sort();
    return [{ value: '', label: 'كل المحافظات' }, ...names.map((name) => ({ value: name, label: name }))];
  }, [list.rows]);

  /* ----------------------------------------------------------------- actions */

  async function saveRecord(payload) {
    try {
      const saved = await window.localApp.saveDirectorate(payload);
      notify?.({ tone: 'ok', message: saved.created ? 'أُضيفت مديرية جديدة.' : 'حُفظت التعديلات.' });
      setCreating(false);
      await loadList();
      setSelectedId(saved.id);
      await loadDetail(saved.id);
      return true;
    } catch (cause) {
      notify?.({ tone: 'bad', message: errText(cause) || 'تعذر الحفظ.' });
      return false;
    }
  }

  async function removeRecord(id) {
    try {
      await window.localApp.deleteDirectorate(id);
      notify?.({ tone: 'warn', message: 'حُذفت المديرية وسجلات مصدرها.' });
      setConfirmDelete(false);
      setSelectedId(null);
      setDetail(null);
      await loadList();
    } catch (cause) {
      notify?.({ tone: 'bad', message: errText(cause) || 'تعذر الحذف.' });
    }
  }

  async function openHistory() {
    if (!detail) return;
    try {
      setVersions(await window.localApp.directorateHistory(detail.dbId ?? detail.values?.id ?? selectedId));
      setHistoryOpen(true);
    } catch (cause) {
      notify?.({ tone: 'bad', message: errText(cause) || 'تعذر تحميل السجل الزمني.' });
    }
  }

  async function restoreVersion(versionId) {
    try {
      await window.localApp.restoreVersion(versionId);
      notify?.({ tone: 'ok', message: 'أُعيد الإصدار السابق.' });
      setHistoryOpen(false);
      await loadList();
      await loadDetail(selectedId);
    } catch (cause) {
      notify?.({ tone: 'bad', message: errText(cause) || 'تعذر الإرجاع.' });
    }
  }

  /* ------------------------------------------------------------------- view */

  return (
    <>
      <Card
        title="تصحيح البيانات"
        subtitle="استكمال الحقول الناقصة أو تصحيح القيم بعد الاستيراد. الحفظ يمر بنفس مُحلِّل القيم المستخدم في الاستيراد."
        icon={PenLine}
        actions={(
          <div className="btn-row">
            <span className="chip info">{fmtNumber(list.total, 0)} سجلًا</span>
            <button
              className="btn small primary"
              onClick={() => { setCreating(true); setSelectedId(null); setDetail(null); }}
            >
              <Plus size={15} /> مديرية جديدة
            </button>
          </div>
        )}
      >
        <div className="toolbar">
          <div className="search-box">
            <Search size={16} />
            <input
              className="input"
              placeholder="ابحث باسم المديرية..."
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          <div style={{ minWidth: 200 }}>
            <SelectInput value={governorate} onChange={setGovernorate} options={governorateOptions} />
          </div>
        </div>
      </Card>

      {error && <ErrorBanner message={error} onDismiss={() => setError('')} />}

      <div className="split">
        <Card title="السجلات" subtitle="اختر سجلًا لتحريره." bodyClass="tight">
          {loading ? <Loading /> : list.rows.length === 0 ? (
            <Empty icon={Users} title="لا نتائج" hint="لا توجد مديريات مطابقة للبحث الحالي." />
          ) : (
            <div className="list">
              {list.rows.map((row, index) => {
                const key = row.id;
                const anomaly = anomalies.get(key);
                const wait = waiting.get(key);
                const present = mandatoryKeys.filter((field) => {
                  const column = columnOfCatalogue(catalogue, field);
                  return row[column] !== null && row[column] !== undefined && row[column] !== '';
                }).length;
                const ratio = present / (mandatoryKeys.length || 1);
                return (
                  <button
                    key={key}
                    className={cx('list-item', selectedId === key && 'selected')}
                    style={{ '--i': index }}
                    onClick={() => { setCreating(false); setSelectedId(key); }}
                  >
                    <div className="li-title">
                      <span className="flex1 nowrap" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{row.district}</span>
                      {anomaly && <XCircle size={14} color="var(--bad)" />}
                      {!anomaly && wait && <AlertTriangle size={14} color="var(--warn)" />}
                      {!anomaly && !wait && <CheckCircle2 size={14} color="var(--ok)" />}
                    </div>
                    <div className="li-sub">{row.governorate || 'بلا محافظة'}</div>
                    <Bar value={ratio} max={1} tone={ratio === 1 ? 'ok' : 'warn'} height={5} />
                  </button>
                );
              })}
            </div>
          )}
        </Card>

        <div className="stack">
          {creating && (
            <DirectorateForm
              mode="create"
              catalogue={catalogue}
              groups={groups}
              mandatoryKeys={mandatoryKeys}
              decisionField={decisionField}
              onSave={saveRecord}
              onCancel={() => setCreating(false)}
            />
          )}

          {!creating && !selectedId && (
            <Card>
              <Empty
                icon={PenLine}
                title="اختر مديرية من القائمة"
                hint="تظهر هنا بطاقة التحرير الكاملة: كل الحقول الـ 39 مجمّعة، مع تحقق فوري من النوع والمدى."
              />
            </Card>
          )}

          {!creating && selectedId && (
            <>
              {detailLoading || !detail ? <Card><Loading /></Card> : (
                <>
                  <Card
                    title={detail.districtName}
                    subtitle={`${detail.governorate || 'بلا محافظة'} · سجل #${detail.dbId}`}
                    actions={(
                      <div className="btn-row">
                        <button className="btn small" onClick={openHistory}><History size={15} /> السجل الزمني</button>
                        <button className="btn small danger" onClick={() => setConfirmDelete(true)}><Trash2 size={15} /> حذف</button>
                      </div>
                    )}
                  >
                    <div className="row between">
                      <div className="row gap-sm">
                        {anomalies.has(selectedId) && <Badge tone="bad">قيم شاذة: {(anomalies.get(selectedId).labels ?? []).join('، ')}</Badge>}
                        {waiting.has(selectedId) && <Badge tone="warn">ناقص: {(waiting.get(selectedId).missingLabels ?? []).slice(0, 4).join('، ')}</Badge>}
                        {!anomalies.has(selectedId) && !waiting.has(selectedId) && <Badge tone="ok">مؤهل للترتيب</Badge>}
                      </div>
                      <span className="muted" style={{ fontSize: '0.76rem' }}>
                        آخر تحديث {fmtDateTime(detail.updatedAt)}
                      </span>
                    </div>
                  </Card>

                  <DirectorateForm
                    mode="edit"
                    key={selectedId}
                    catalogue={catalogue}
                    groups={groups}
                    mandatoryKeys={mandatoryKeys}
                    decisionField={decisionField}
                    initial={detail}
                    onSave={saveRecord}
                    onCancel={() => setSelectedId(null)}
                  />
                </>
              )}
            </>
          )}
        </div>
      </div>

      <Modal
        open={historyOpen}
        title="السجل الزمني للتعديلات"
        subtitle="كل إصدار محفوظ قبل التعديل، ويمكن الإرجاع إليه."
        onClose={() => setHistoryOpen(false)}
      >
        {versions.length === 0 ? <Empty icon={History} title="لا إصدارات محفوظة بعد" /> : (
          <div className="timeline">
            {versions.map((version) => (
              <div className="timeline-item" key={version.id}>
                <span className="dot" />
                <div className="tl-body row between">
                  <div>
                    <strong>إصدار #{version.id}</strong>
                    <div className="dim" style={{ fontSize: '0.76rem' }}>{version.reason ?? 'snapshot'} · {fmtDateTime(version.created_at)}</div>
                  </div>
                  <button className="btn small" onClick={() => restoreVersion(version.id)}><RotateCcw size={14} /> إرجاع</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Modal>

      <Modal
        open={confirmDelete}
        title="حذف المديرية"
        subtitle="سيُحذف السجل وسجلات مصدره. التقارير التاريخية السابقة تحتفظ بنسختها."
        onClose={() => setConfirmDelete(false)}
        footer={(
          <>
            <button className="btn danger" onClick={() => removeRecord(selectedId)}><Trash2 size={15} /> تأكيد الحذف</button>
            <button className="btn ghost" onClick={() => setConfirmDelete(false)}>إلغاء</button>
          </>
        )}
      >
        <p className="muted">هل تريد حذف «{detail?.districtName}»؟ هذا الإجراء لا يمكن التراجع عنه من هذه الشاشة.</p>
      </Modal>
    </>
  );
}

/* -------------------------------------------------------------------------- */

/** All 39 fields, grouped, with per-field validation before the write. */
function DirectorateForm({ mode, catalogue, groups, mandatoryKeys, decisionField, initial, onSave, onCancel }) {
  const [districtName, setDistrictName] = useState(initial?.districtName ?? '');
  const [governorate, setGovernorate] = useState(initial?.governorate ?? '');
  const [values, setValues] = useState(() => initialValues(catalogue, initial));
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDistrictName(initial?.districtName ?? '');
    setGovernorate(initial?.governorate ?? '');
    setValues(initialValues(catalogue, initial));
    setErrors({});
  }, [initial, catalogue]);

  function setValue(key, value) {
    setValues((current) => ({ ...current, [key]: value }));
    setErrors((current) => (current[key] ? { ...current, [key]: undefined } : current));
  }

  function validate() {
    const next = {};
    if (!String(districtName).trim()) next.districtName = 'اسم المديرية مطلوب.';
    if (String(districtName).length > 200) next.districtName = 'أطول من 200 حرف.';
    if (String(governorate).length > 200) next.governorate = 'أطول من 200 حرف.';

    for (const field of catalogue) {
      if (field.key === DECISION_KEY) continue;
      const raw = values[field.key];
      const blank = raw === null || raw === undefined || String(raw).trim() === '';
      if (blank) {
        if (mandatoryKeys.includes(field.key)) next[field.key] = 'حقل إلزامي؛ اتركه فارغًا فقط إن كان غير متوفر فعلًا.';
        continue;
      }
      const text = String(raw).trim();
      if (field.type === 'number' || field.type === 'ratio') {
        const numeric = toNumber(text);
        if (numeric === null) { next[field.key] = 'قيمة رقمية غير صالحة.'; continue; }
        if (field.positive && numeric < 0) next[field.key] = 'لا يقبل قيمة سالبة.';
        if (field.type === 'ratio' && numeric > 100) next[field.key] = 'النسبة خارج المدى المفهوم (0-100%).';
      }
      if (field.type === 'text' && text.length > 2000) next[field.key] = 'أطول من 2000 حرف.';
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  async function submit(event) {
    event.preventDefault();
    if (!validate()) return;
    setSaving(true);
    const ok = await onSave({
      id: mode === 'edit' ? (initial?.dbId ?? null) : null,
      districtName: String(districtName).trim(),
      governorate: String(governorate).trim(),
      values: { ...values, districtName: String(districtName).trim(), governorate: String(governorate).trim() },
    });
    setSaving(false);
    if (ok && mode === 'create') {
      setDistrictName('');
      setGovernorate('');
      setValues(initialValues(catalogue, null));
    }
  }

  const filled = Object.values(values).filter((value) => value !== null && value !== undefined && String(value).trim() !== '').length;

  return (
    <form className="stack" onSubmit={submit}>
      <Card
        title={mode === 'create' ? 'مديرية جديدة' : 'تحرير الحقول'}
        subtitle={`${filled} حقلًا يحتوي قيمة. الحقول المعلّمة بـ * إلزامية وتدخل في حساب الاكتمال.`}
        actions={(
          <div className="btn-row">
            <span className="chip">الاكتمال: {mandatoryKeys.filter((key) => values[key] !== null && values[key] !== undefined && String(values[key]).trim() !== '').length}/{mandatoryKeys.length}</span>
            <button type="button" className="btn ghost small" onClick={onCancel}>إلغاء</button>
            <button type="submit" className="btn primary small" disabled={saving}>
              <Save size={15} /> {saving ? 'جارٍ الحفظ...' : 'حفظ'}
            </button>
          </div>
        )}
      >
        <div className="form-grid">
          <Field label="اسم المديرية" required error={errors.districtName}>
            <TextInput value={districtName} onChange={setDistrictName} invalid={Boolean(errors.districtName)} placeholder="مثال: مديرية الشعر" />
          </Field>
          <Field label="المحافظة" error={errors.governorate}>
            <TextInput value={governorate} onChange={setGovernorate} invalid={Boolean(errors.governorate)} placeholder="مثال: إب" />
          </Field>
          {decisionField && (
            <Field label={decisionField.header} hint={`القيم المسموحة: ${(decisionField.allowed ?? []).join('، ')}`}>
              <SelectInput
                value={values[DECISION_KEY] ?? ''}
                onChange={(value) => setValue(DECISION_KEY, value)}
                options={[{ value: '', label: '— بلا قرار —' }, ...(decisionField.allowed ?? []).map((allowed) => ({ value: allowed, label: allowed }))]}
              />
            </Field>
          )}
        </div>
      </Card>

      {groups.map((group) => (
        <Card key={group.id} title={group.title} subtitle={group.hint}>
          <div className="form-grid">
            {group.fields.map((field) => (
              <FieldRenderer
                key={field.key}
                field={field}
                value={values[field.key]}
                error={errors[field.key]}
                required={mandatoryKeys.includes(field.key)}
                onChange={(value) => setValue(field.key, value)}
              />
            ))}
          </div>
        </Card>
      ))}
    </form>
  );
}

function FieldRenderer({ field, value, error, required, onChange }) {
  const hint = [
    field.unit ? `الوحدة: ${field.unit}` : null,
    field.type === 'ratio' ? 'يُقبل 0.197 أو 19.7' : null,
    field.sensitivity !== 'public' ? 'حقل مقيّد' : null,
  ].filter(Boolean).join(' · ');

  if (field.type === 'boolean') {
    return (
      <Field label={field.header} hint={hint} error={error} required={required}>
        <SelectInput
          value={value === null || value === undefined || value === '' ? '' : String(value)}
          onChange={onChange}
          options={[{ value: '', label: '— غير محدد —' }, { value: '1', label: 'نعم' }, { value: '0', label: 'لا' }]}
        />
      </Field>
    );
  }

  if (field.type === 'number' || field.type === 'ratio') {
    return (
      <Field label={field.header} hint={hint} error={error} required={required}>
        <NumberInput value={value} onChange={onChange} invalid={Boolean(error)} />
      </Field>
    );
  }

  return (
    <Field label={field.header} hint={hint} error={error} required={required}>
      <TextInput value={value} onChange={onChange} invalid={Boolean(error)} />
    </Field>
  );
}

/* -------------------------------------------------------------------------- */

function initialValues(catalogue, initial) {
  const output = {};
  for (const field of catalogue) {
    if (field.key === 'districtName' || field.key === 'governorate') continue;
    const value = initial?.values?.[field.key];
    if (value === null || value === undefined) output[field.key] = '';
    else if (typeof value === 'number') output[field.key] = String(value);
    else output[field.key] = String(value);
  }
  return output;
}

/** The DB column of a catalogue key, needed because the list returns raw rows. */
function columnOfCatalogue(catalogue, key) {
  return catalogue.find((field) => field.key === key)?.dbColumn ?? key;
}
