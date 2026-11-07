import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Check, FileScan, History, Pencil, Plus, RefreshCw, RotateCcw, Save, Search, ShieldCheck, Trash2, X,
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

/**
 * Why the engine flagged a proposal. Shown verbatim next to the field so the
 * reviewer knows what to check on the page instead of seeing a bare percentage.
 */
const OCR_REASON_LABEL = {
  'low-ocr-confidence': 'ثقة قراءة منخفضة',
  'weak-label-match': 'اسم حقل غير مؤكد',
  'label-guessed': 'اسم الحقل مستنتج من البداية',
  'percent-converted': 'حُوّلت نسبة مئوية إلى كسر',
  'had-percent': 'القيمة تحمل علامة %',
  placeholder: 'القيمة نص بديل لا رقم',
  'duplicate-line': 'الحقل تكرر في الصفحة',
  'enrolled-exceeds-population': 'الملتحقون أكبر من السكان',
  'beneficiaries-exceed-population': 'المستفيدون أكبر من السكان',
  'rural-exceeds-population': 'سكان الريف أكبر من السكان',
  'schools-exceed-population': 'عدد المدارس أكبر من السكان',
  'ratio-out-of-range': 'النسبة خارج المدى 0-1',
};

function ocrReasonLabel(code) {
  if (!code) return '';
  if (OCR_REASON_LABEL[code]) return OCR_REASON_LABEL[code];
  if (String(code).startsWith('invalid-')) return 'قيمة غير صالحة لنوع الحقل';
  return String(code);
}

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
  const [ocrProgress, setOcrProgress] = useState(null);
  const [ocrSelected, setOcrSelected] = useState(new Set());
  const [historyTarget, setHistoryTarget] = useState(null);
  const [historyVersions, setHistoryVersions] = useState([]);
  const [historyBusy, setHistoryBusy] = useState(false);
  // Per-field reviewer decision, mirrored into `ocr_field_confidence` so the
  // draft keeps an audit trail of what a human accepted, rejected, or edited.
  const [decisions, setDecisions] = useState({});
  const [drafts, setDrafts] = useState([]);

  const notify = useCallback((message) => { if (onToast) onToast(message); }, [onToast]);
  const fail = useCallback((cause, fallback) => { if (onError) onError(cause?.message || fallback); }, [onError]);

  const fieldMap = useMemo(() => new Map(fields.map((field) => [field.key, field])), [fields]);

  // Values the engine saw but could not parse: they are *not* proposed, so the
  // reviewer must read them from the page instead of trusting a guess.
  const unreadable = useMemo(
    () => (ocr?.parsed?.warnings ?? []).filter((warning) => String(warning.code ?? '').startsWith('invalid-')),
    [ocr],
  );

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

  // OCR drafts are stored in the database, so closing the screen must not lose
  // them. The list is small (10 most recent) and refreshed after any decision.
  const loadDrafts = useCallback(async () => {
    try {
      const list = await window.localApp.ocrDrafts({ limit: 10 });
      setDrafts(Array.isArray(list) ? list : []);
    } catch {
      // Listing drafts is a convenience; a failure must never block data entry.
    }
  }, []);

  useEffect(() => { loadDrafts(); }, [loadDrafts]);

  // OCR runs in the main process; progress and the cancel affordance come over a
  // single event channel so a long page never looks frozen.
  useEffect(() => {
    if (!window.localApp.onOcrProgress) return undefined;
    return window.localApp.onOcrProgress((message) => {
      if (!message || message.stage === 'done') { setOcrProgress(null); return; }
      setOcrProgress(message);
    });
  }, []);

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

  function clearOcr() {
    setOcr(null);
    setOcrSelected(new Set());
    setDecisions({});
  }

  function startAdd() {
    clearOcr();
    setForm(emptyForm());
  }

  function cancelForm() {
    setForm(null);
    clearOcr();
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
      clearOcr();
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
      clearOcr();
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

  /**
   * A snapshot is written before every edit and delete, so the history panel is
   * the only place a reviewer can see what a record looked like before a change
   * — including a record that was deleted and re-created from a snapshot.
   */
  async function openHistory(row) {
    setHistoryTarget(row);
    setHistoryVersions([]);
    setHistoryBusy(true);
    try {
      const versions = await window.localApp.directorateHistory(row.id);
      setHistoryVersions(Array.isArray(versions) ? versions : []);
    } catch (cause) {
      fail(cause, 'تعذر تحميل سجل التغييرات.');
    } finally {
      setHistoryBusy(false);
    }
  }

  function closeHistory() {
    setHistoryTarget(null);
    setHistoryVersions([]);
  }

  async function restoreVersion(version) {
    const confirmed = window.confirm(
      `استعادة النسخة #${version.id} من «${version.district ?? historyTarget?.district ?? ''}»؟\n` +
      'تُحفظ الحالة الحالية كلقطة أولًا، فيبقى هذا التراجع نفسه قابلًا للتراجع.',
    );
    if (!confirmed) return;
    setHistoryBusy(true);
    try {
      const restored = await window.localApp.restoreVersion(version.id);
      notify(`استُعيدت المديرية #${restored?.id ?? ''} من النسخة #${version.id}. حُفظت الحالة السابقة كلقطة.`);
      // The form may hold values that no longer match the restored record.
      if (form && historyTarget && form.id === historyTarget.id) cancelForm();
      await load();
      if (historyTarget) await openHistory(historyTarget);
    } catch (cause) {
      fail(cause, 'تعذرت استعادة النسخة.');
    } finally {
      setHistoryBusy(false);
    }
  }

  function historyActionLabel(action) {
    const labels = {
      edit: 'قبل التعديل',
      delete: 'قبل الحذف',
      'snapshot-before-restore': 'قبل الاستعادة',
      restore: 'استعادة',
    };
    return labels[action] ?? String(action ?? 'لقطة');
  }

  async function runOcr() {
    setOcrBusy(true);
    setOcrProgress(null);
    try {
      const result = await window.localApp.readOcrEntry();
      if (result.canceled) return;
      setOcr(result);
      setDecisions({});
      // Nothing is pre-selected on the user's behalf except proposals the engine
      // itself did not flag. A flagged field (low OCR confidence, weak label
      // match, converted percentage, impossible cross-field value) must be
      // ticked deliberately after the reviewer looks at the raw text.
      const trusted = Object.entries(result.parsed?.fields ?? {})
        .filter(([, entry]) => !entry.needsReview)
        .map(([key]) => key);
      setOcrSelected(new Set(trusted));
      const count = Object.keys(result.parsed?.fields ?? {}).length;
      const review = count - trusted.length;
      notify(`قُرئ «${result.fileName}»: ${count} حقلًا مقترحًا${review ? `، ${review} منها تحتاج مراجعة يدوية` : ''}.`);
      loadDrafts();
    } catch (cause) {
      fail(cause, 'تعذرت قراءة الملف بالـOCR.');
    } finally {
      setOcrBusy(false);
      setOcrProgress(null);
    }
  }

  async function cancelOcr() {
    try {
      await window.localApp.cancelOcr();
      notify('أُلغي التعرف الضوئي.');
    } catch (cause) {
      fail(cause, 'تعذر إلغاء التعرف الضوئي.');
    }
  }

  function toggleOcrField(key) {
    setOcrSelected((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  /**
   * Record one reviewer decision for one proposed field.
   *
   * The decision is written to the draft even when the value is not applied, so
   * the stored draft always explains why a proposal was left out: rejected by a
   * human, not merely forgotten. A bookkeeping failure never blocks the form —
   * the reviewer's real work is applying values — so it is reported as a notice.
   */
  async function decideField(key, decision) {
    const entry = ocr?.parsed?.fields?.[key];
    if (!entry) return;
    setDecisions((previous) => ({ ...previous, [key]: decision }));
    setOcrSelected((previous) => {
      const next = new Set(previous);
      if (decision === 'accepted') next.add(key);
      else next.delete(key);
      return next;
    });
    if (!ocr?.draftId) return;
    try {
      await window.localApp.ocrDecision({
        draftId: ocr.draftId,
        fieldKey: key,
        decision,
        value: decision === 'accepted' ? entry.value : null,
      });
      loadDrafts();
    } catch (cause) {
      notify(`سُجّل القرار محليًا لكن تعذر حفظه في مسودة OCR: ${cause?.message ?? ''}`);
    }
  }

  /**
   * Reopen a stored draft with the decisions already taken on it, so a reviewer
   * can finish a long page in a second sitting instead of re-reading the paper.
   */
  async function resumeDraft(draftId) {
    setOcrBusy(true);
    try {
      const draft = await window.localApp.ocrDraft(draftId);
      const payload = draft.payload ?? {};
      const draftFields = payload.fields ?? {};
      const storedDecisions = {};
      const selected = new Set();
      for (const field of draft.fields ?? []) {
        if (field.decision === 'accepted' || field.decision === 'rejected') storedDecisions[field.fieldKey] = field.decision;
        if (field.decision === 'accepted') selected.add(field.fieldKey);
      }
      for (const [key, entry] of Object.entries(draftFields)) {
        if (storedDecisions[key]) continue;
        if (!entry.needsReview) selected.add(key);
      }
      setOcr({
        draftId: draft.id,
        fileName: draft.fileName,
        confidence: draft.confidence,
        text: draft.text ?? '',
        pages: 1,
        pagesRead: 1,
        preview: null,
        parsed: {
          fields: draftFields,
          unmatched: payload.unmatched ?? [],
          warnings: payload.warnings ?? [],
          crossField: payload.crossField ?? [],
          summary: payload.summary ?? null,
        },
      });
      setOcrSelected(selected);
      setDecisions(storedDecisions);
      notify(`أُعيد فتح مسودة «${draft.fileName}» بقراراتها المحفوظة. الصورة الأصلية غير محفوظة؛ اعتمد على النص الخام.`);
    } catch (cause) {
      fail(cause, 'تعذر فتح مسودة OCR.');
    } finally {
      setOcrBusy(false);
    }
  }

  /**
   * Applies only the fields the reviewer ticked. Auto-filling everything would
   * make "the engine guessed it" indistinguishable from "the user confirmed it".
   */
  function applyOcr() {
    const parsed = ocr?.parsed?.fields ?? {};
    const keys = [...ocrSelected].filter((key) => parsed[key]);
    if (!keys.length) {
      fail({ message: 'لم تحدد أي حقل لتطبيقه. علّم الحقول التي راجعتها أولًا.' }, '');
      return;
    }
    const base = form ?? emptyForm();
    const next = { ...base, values: { ...base.values } };
    for (const key of keys) {
      const entry = parsed[key];
      if (key === 'districtName') next.districtName = String(entry.value ?? '');
      else if (key === 'governorate') next.governorate = String(entry.value ?? '');
      else next.values[key] = entry.value === null || entry.value === undefined ? '' : String(entry.value);
      // Applying a proposal *is* accepting it. Recording that keeps the draft
      // consistent with what actually reached the form.
      if (ocr?.draftId && decisions[key] !== 'accepted') decideField(key, 'accepted');
    }
    setForm(next);
    notify(`طُبّق ${keys.length} حقلًا على النموذج. لم تُطبَّق الحقول غير المعلّمة. راجع القيم ثم احفظ.`);
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

    {drafts.length > 0 && <section className="panel drafts-panel">
      <div className="panel-heading">
        <div>
          <h2>مسودات OCR محفوظة ({drafts.length})</h2>
          <p>القرارات المحفوظة مع كل مسودة تُستعاد عند إعادة فتحها. الصورة الأصلية لا تُخزَّن؛ يبقى النص الخام والقراءات.</p>
        </div>
      </div>
      <ul className="drafts-list">{drafts.map((draft) => <li key={draft.id}>
        <div>
          <strong>{draft.file_name ?? 'بلا اسم ملف'}</strong>
          <span>{formatDate(draft.created_at)} · {draft.field_count} حقلًا · {draft.pending_count} بانتظار القرار · ثقة المحرك {Math.round((draft.confidence ?? 0) * 100)}%</span>
        </div>
        <button className="quiet-button" onClick={() => resumeDraft(draft.id)} disabled={ocrBusy}>
          <FileScan size={14} />متابعة
        </button>
      </li>)}</ul>
    </section>}

    {ocrBusy && <section className="panel ocr-panel ocr-running">
      <div className="ocr-running-row">
        <FileScan size={20} />
        <div>
          <strong>{ocrProgress?.status === 'reading-page' ? `جارٍ قراءة الصفحة ${ocrProgress.page} من ${ocrProgress.pages}` : 'جارٍ التعرف الضوئي محليًا...'}</strong>
          <span>{ocrProgress?.progress !== null && ocrProgress?.progress !== undefined ? `${Math.round(Number(ocrProgress.progress) * 100)}%` : 'تحضير الصفحة'}</span>
        </div>
        <button className="quiet-button danger-text" onClick={cancelOcr}><X size={15} />إلغاء القراءة</button>
      </div>
      <div className="ocr-progress-track"><span style={{ width: `${Math.round(Math.min(1, Math.max(0, Number(ocrProgress?.progress) || 0)) * 100)}%` }} /></div>
    </section>}

    {ocr && <section className="panel ocr-panel">
      <div className="panel-heading">
        <div>
          <h2>نتيجة OCR: {ocr.fileName}</h2>
          <p>{ocr.pagesRead ?? ocr.pages ?? 1} من {ocr.pages ?? 1} صفحة · ثقة المحرك {Math.round((ocr.confidence ?? 0) * 100)}% · {Object.keys(ocr.parsed?.fields ?? {}).length} حقلًا مطابقًا · {ocrSelected.size} محدَّدًا للتطبيق. النص مسودة، وليست بيانات معتمدة.</p>
        </div>
        <div className="ocr-actions">
          <button className="primary-button" onClick={applyOcr} disabled={!ocrSelected.size}><Check size={15} />تطبيق المحدد ({ocrSelected.size})</button>
          <button className="quiet-button" onClick={clearOcr}><X size={15} />إغلاق</button>
        </div>
      </div>
      {(ocr.warnings?.length > 0 || ocr.truncated || ocr.textTruncated) && <div className="inline-warning">
        {[...(ocr.warnings ?? []), ocr.truncated ? 'قُرئ جزء من الملف فقط؛ أكمل الباقي يدويًا.' : null, ocr.textTruncated ? 'عُرض جزء من النص الخام فقط.' : null].filter(Boolean).join(' ')}
      </div>}
      {ocr.preprocessing && <div className="ocr-preprocessing">
        <span>الدقة: {ocr.preprocessing.width}×{ocr.preprocessing.height}</span>
        <span>ميل مصحّح: {Number(ocr.preprocessing.angle ?? 0).toFixed(1)}°</span>
        {ocr.preprocessing.rotation ? <span>دوران: {ocr.preprocessing.rotation}°</span> : null}
        <span>تكبير: ×{ocr.preprocessing.upscale}</span>
      </div>}
      <div className="ocr-review-bar">
        <ShieldCheck size={16} />
        <span>الحقول المعلّمة فقط ستُطبَّق. الحقول المعلّمة بتحذير لا تُحدَّد تلقائيًا: طابق الرقم مع الصورة قبل تعليمها.</span>
        <button className="quiet-button" onClick={() => setOcrSelected(new Set(Object.entries(ocr.parsed?.fields ?? {}).filter(([, entry]) => !entry.needsReview).map(([key]) => key)))}>تحديد الآمن فقط</button>
        <button className="quiet-button" onClick={() => setOcrSelected(new Set(Object.keys(ocr.parsed?.fields ?? {})))}>تحديد الكل</button>
        <button className="quiet-button" onClick={() => setOcrSelected(new Set())}>إلغاء التحديد</button>
      </div>
      {ocr.preview && <details className="ocr-preview">
        <summary>عرض الصورة المقروءة للمقارنة</summary>
        <img src={ocr.preview} alt="الصفحة التي قُرئت" />
      </details>}
      <div className="ocr-fields">
        {Object.entries(ocr.parsed?.fields ?? {}).map(([key, entry]) => <label key={key} className={`ocr-chip${entry.needsReview ? ' needs-review' : ''}${ocrSelected.has(key) ? ' is-selected' : ''}`}>
          <input type="checkbox" checked={ocrSelected.has(key)} onChange={() => toggleOcrField(key)} />
          <span className="ocr-chip-header">{entry.header}</span>
          <b>{String(entry.value)}</b>
          <em>تطابق الاسم {Math.round(entry.score * 100)}%{entry.confidence !== null && entry.confidence !== undefined ? ` · ثقة القراءة ${Math.round(entry.confidence * 100)}%` : ''}</em>
          {entry.raw !== undefined && String(entry.raw) !== String(entry.value) && <code dir="auto">النص الخام: {String(entry.raw)}</code>}
          {(entry.reviewReasons ?? []).length > 0 && <span className="ocr-chip-reasons">{(entry.reviewReasons ?? []).map(ocrReasonLabel).join(' · ')}</span>}
          <span className="ocr-chip-actions">
            <button type="button" className={`ocr-chip-action${decisions[key] === 'accepted' ? ' is-on' : ''}`} onClick={(event) => { event.preventDefault(); event.stopPropagation(); decideField(key, 'accepted'); }}>قبول</button>
            <button type="button" className={`ocr-chip-action reject${decisions[key] === 'rejected' ? ' is-off' : ''}`} onClick={(event) => { event.preventDefault(); event.stopPropagation(); decideField(key, 'rejected'); }}>رفض</button>
            <em className={`ocr-chip-decision ${decisions[key] ?? 'pending'}`}>{decisions[key] === 'accepted' ? 'مقبول' : decisions[key] === 'rejected' ? 'مرفوض' : 'بانتظار القرار'}</em>
          </span>
        </label>)}
        {!Object.keys(ocr.parsed?.fields ?? {}).length && <span className="muted">لم يُطابق أي حقل تلقائيًا؛ املأ النموذج يدويًا.</span>}
      </div>
      {ocr.parsed?.crossField?.length > 0 && <div className="inline-warning">
        تعارض بين الحقول: {ocr.parsed.crossField.slice(0, 6).map((issue) => issue.detail).join(' · ')}
      </div>}
      {unreadable.length > 0 && <div className="inline-warning">
        قيم لم تُقرأ بثقة كافية فلم تُقترح أصلًا (أدخلها يدويًا من الصورة): {unreadable.map((warning) => `${warning.header} (${String(warning.raw ?? '')})`).join(' · ')}
      </div>}
      {ocr.parsed?.warnings?.length > 0 && <details className="ocr-unmatched">
        <summary>تنبيهات أثناء التحليل ({ocr.parsed.warnings.length})</summary>
        <ul>{ocr.parsed.warnings.slice(0, 30).map((warning, index) => <li key={`${warning.code}-${index}`}><span>{ocrReasonLabel(warning.code)}</span>{warning.header ? `${warning.header}: ${String(warning.raw ?? '')}` : String(warning.raw ?? '')}</li>)}</ul>
      </details>}
      {ocr.parsed?.unmatched?.length > 0 && <details className="ocr-unmatched">
        <summary>أسطر لم تُطابق ({ocr.parsed.unmatched.length})</summary>
        <ul>{ocr.parsed.unmatched.slice(0, 30).map((item, index) => <li key={`${item.reason}-${index}`}><span>{item.reason}</span>{item.raw}</li>)}</ul>
      </details>}
      <details className="ocr-text">
        <summary>النص الخام</summary>
        <pre dir="auto">{ocr.text}</pre>
      </details>
    </section>}

    {historyTarget && <section className="panel history-panel">
      <div className="panel-heading">
        <div>
          <h2><History size={16} /> سجل تغييرات: {historyTarget.district} {historyTarget.governorate ? `— ${historyTarget.governorate}` : ''}</h2>
          <p>لقطة كاملة قبل كل تعديل أو حذف. الاستعادة نفسها تُسجَّل كلقطة، فلا يوجد تراجع نهائي بلا أثر.</p>
        </div>
        <button className="quiet-button" onClick={closeHistory}><X size={15} />إغلاق</button>
      </div>
      {historyBusy && <p className="muted history-empty">جارٍ تحميل السجل...</p>}
      {!historyBusy && !historyVersions.length && <p className="muted history-empty">لا توجد لقطات بعد. تُنشأ تلقائيًا عند أول تعديل أو حذف.</p>}
      {!historyBusy && historyVersions.length > 0 && <div className="table-scroll"><table className="analysis-table compact">
        <thead><tr><th>#</th><th>الحدث</th><th>المديرية في اللقطة</th><th>المحافظة</th><th>التاريخ</th><th>إجراء</th></tr></thead>
        <tbody>{historyVersions.map((version) => <tr key={version.id}>
          <td className="ltr-cell">{version.id}</td>
          <td>{historyActionLabel(version.action)}</td>
          <td>{version.district ?? '—'}</td>
          <td>{version.governorate ?? '—'}</td>
          <td>{formatDate(version.created_at)}</td>
          <td>
            <button className="quiet-button" onClick={() => restoreVersion(version)} disabled={historyBusy}>
              <RotateCcw size={14} />استعادة
            </button>
          </td>
        </tr>)}</tbody>
      </table></div>}
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
            <button className="quiet-button" onClick={() => openHistory(row)} disabled={Boolean(busy) || ocrBusy}><History size={14} />السجل</button>
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