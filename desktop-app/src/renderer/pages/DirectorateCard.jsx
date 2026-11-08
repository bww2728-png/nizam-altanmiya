import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity, ArrowLeft, CheckCircle2, Database, FileSpreadsheet, History,
  MapPin, PenLine, RotateCcw, Trophy, Users,
} from 'lucide-react';
import {
  Badge, Bar, Card, Empty, ErrorBanner, Loading, Segmented,
} from '../components/ui.jsx';
import { cx, errText, fmtByType, fmtDateTime, fmtNumber, fmtPercent, fmtRatio } from '../lib/format.js';
import { groupCatalogue, MANDATORY_FALLBACK } from '../lib/fields.js';
import { INDICATORS_META } from '../lib/indicatorsMeta.mjs';

/**
 * «بطاقة مديرية» — one directorate as a complete file.
 *
 * Everything the system knows about a record in one screen: every input field,
 * the 12 indicators with their scores and contributions, provenance of each
 * value, the rank it holds (or why it is excluded), and its version history.
 */
export default function DirectorateCard({ id, catalogue, notify, refreshKey, onNavigate }) {
  const [detail, setDetail] = useState(null);
  const [indicators, setIndicators] = useState(null);
  const [ranking, setRanking] = useState(null);
  const [versions, setVersions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [view, setView] = useState('values');

  const load = useCallback(async () => {
    if (id === null || id === undefined) { setLoading(false); return; }
    setLoading(true);
    setError('');
    try {
      const [record, indicatorPayload, rankingPayload, history] = await Promise.all([
        window.localApp.getDirectorate(id),
        window.localApp.sheetIndicators(),
        window.localApp.sheetRanking({ mode: 'calibrated' }),
        window.localApp.directorateHistory(id),
      ]);
      setDetail(record);
      setIndicators(indicatorPayload);
      setRanking(rankingPayload);
      setVersions(history ?? []);
    } catch (cause) {
      setError(errText(cause) || 'تعذر تحميل بطاقة المديرية.');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load, refreshKey]);

  const groups = useMemo(() => groupCatalogue(catalogue), [catalogue]);
  const mandatoryKeys = useMemo(() => {
    const flagged = catalogue.filter((field) => field.mandatory).map((field) => field.key);
    return flagged.length ? flagged : MANDATORY_FALLBACK;
  }, [catalogue]);

  const indicatorRow = useMemo(
    () => (indicators?.rows ?? []).find((row) => Number(row.directorateId) === Number(id)) ?? null,
    [indicators, id],
  );

  const rankRow = useMemo(
    () => (ranking?.ranked ?? []).find((row) => Number(row.directorateId) === Number(id)) ?? null,
    [ranking, id],
  );
  const anomalyRow = useMemo(
    () => (ranking?.anomalies ?? []).find((row) => Number(row.directorateId) === Number(id)) ?? null,
    [ranking, id],
  );
  const waitingRow = useMemo(
    () => (ranking?.waiting ?? []).find((row) => Number(row.directorateId) === Number(id)) ?? null,
    [ranking, id],
  );

  const missing = useMemo(() => {
    if (!detail) return [];
    return mandatoryKeys
      .filter((key) => detail.values?.[key] === null || detail.values?.[key] === undefined || String(detail.values[key]).trim() === '')
      .map((key) => catalogue.find((field) => field.key === key)?.header ?? key);
  }, [detail, mandatoryKeys, catalogue]);

  const completeness = mandatoryKeys.length ? (mandatoryKeys.length - missing.length) / mandatoryKeys.length : 0;

  async function restoreVersion(versionId) {
    try {
      await window.localApp.restoreVersion(versionId);
      notify?.({ tone: 'ok', message: 'أُعيد الإصدار السابق.' });
      await load();
    } catch (cause) {
      notify?.({ tone: 'bad', message: errText(cause) || 'تعذر الإرجاع.' });
    }
  }

  if (id === null || id === undefined) {
    return (
      <Card>
        <Empty
          icon={Users}
          title="لم تُحدد مديرية"
          hint="اختر مديرية من قاعدة البيانات الشاملة أو من شاشة تصحيح البيانات لعرض بطاقتها الكاملة."
          action={<button className="btn primary" onClick={() => onNavigate('database')}><Database size={16} /> قاعدة البيانات</button>}
        />
      </Card>
    );
  }

  if (loading && !detail) return <Card><Loading label="جارٍ تحميل بطاقة المديرية..." /></Card>;
  if (error && !detail) return <ErrorBanner message={error} />;
  if (!detail) return null;

  return (
    <>
      {error && <ErrorBanner message={error} onDismiss={() => setError('')} />}

      <Card className="gold">
        <div className="row between">
          <div className="stack tight">
            <div className="row gap-sm">
              <span className="metric-icon"><MapPin size={18} /></span>
              <div>
                <h1 style={{ fontSize: '1.35rem' }}>{detail.districtName}</h1>
                <span className="muted" style={{ fontSize: '0.84rem' }}>{detail.governorate || 'بلا محافظة'} · سجل #{detail.dbId}</span>
              </div>
            </div>
            <div className="chip-row">
              {rankRow && <Badge tone="gold" icon={Trophy}>المرتبة {rankRow.rank} · مركّب {fmtNumber(rankRow.composite, 4)}</Badge>}
              {anomalyRow && <Badge tone="bad">شاذ: {(anomalyRow.labels ?? []).join('، ')}</Badge>}
              {waitingRow && <Badge tone="warn">ناقص: {(waitingRow.missingLabels ?? []).slice(0, 3).join('، ')}</Badge>}
              {!rankRow && !anomalyRow && !waitingRow && <Badge tone="ok" icon={CheckCircle2}>مؤهل للترتيب</Badge>}
              {detail.values?.reviewerDecision && <Badge tone="info">قرار المراجع: {detail.values.reviewerDecision}</Badge>}
            </div>
          </div>
          <div className="btn-row">
            <button className="btn small" onClick={() => onNavigate('correction', { focusId: detail.dbId })}><PenLine size={15} /> تحرير</button>
            <button className="btn small ghost" onClick={() => onNavigate('database')}><ArrowLeft size={15} /> العودة للقاعدة</button>
          </div>
        </div>
      </Card>

      <div className="grid-2">
        <Card title="الاكتمال" subtitle={`${mandatoryKeys.length - missing.length} من ${mandatoryKeys.length} حقلًا إلزاميًا.`}>
          <div className="stack">
            <div className="completeness" style={{ fontSize: '0.9rem' }}>
              <Bar value={completeness} max={1} tone={completeness === 1 ? 'ok' : 'warn'} />
              <strong className="tnum">{fmtPercent(completeness * 100, 0)}</strong>
            </div>
            {missing.length === 0
              ? <div className="row gap-sm"><CheckCircle2 size={16} color="var(--ok)" /><span className="muted">كل الحقول الإلزامية مكتملة.</span></div>
              : (
                <div className="chip-row">
                  {missing.map((label) => <span className="chip warn" key={label}>{label}</span>)}
                </div>
              )}
            {anomalyRow && (
              <div className="quote" style={{ borderInlineStartColor: 'var(--bad)' }}>
                القيم الشاذة: {(anomalyRow.labels ?? []).map((label, index) => `${label} = ${fmtByType(anomalyRow.values?.[anomalyRow.keys?.[index]], 'number')}`).join('، ')}
              </div>
            )}
          </div>
        </Card>

        <Card title="المصدر" subtitle="من أين جاء هذا السجل، ومتى عُدّل آخر مرة.">
          <dl className="kv">
            <dt>ملف المصدر</dt><dd>{detail.sourceFile ?? '—'}</dd>
            <dt>الورقة</dt><dd>{detail.sourceSheet ?? '—'}</dd>
            <dt>صف المصدر</dt><dd className="tnum">{detail.rowNumber ?? '—'}</dd>
            <dt>أُنشئ</dt><dd>{fmtDateTime(detail.createdAt)}</dd>
            <dt>آخر تعديل</dt><dd>{fmtDateTime(detail.updatedAt)}</dd>
            <dt>حقول موثّقة</dt><dd className="tnum">{(detail.sources ?? []).length}</dd>
          </dl>
        </Card>
      </div>

      <Card
        title="المؤشرات الـ 12"
        subtitle="القيم والدرجات المعيارية ومساهمة كل مؤشر في المركّب."
        icon={Activity}
        actions={<Segmented value={view} onChange={setView} options={[
          { value: 'values', label: 'القيم' },
          { value: 'scores', label: 'الدرجات' },
          { value: 'contributions', label: 'المساهمة' },
        ]} />}
      >
        {!indicatorRow ? <Empty icon={Activity} title="لا توجد مؤشرات محسوبة" hint="شغّل التحليل أو تحقق من اكتمال الحقول." /> : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr><th>المؤشر</th><th>الوحدة</th><th className="num">القيمة</th><th className="num">الدرجة</th><th className="num">المساهمة</th></tr>
              </thead>
              <tbody>
                {(indicators?.registry ?? INDICATORS_META).map((indicator) => {
                  const value = indicatorRow.values?.[indicator.code];
                  const score = indicatorRow.scores?.[indicator.code];
                  const contribution = indicatorRow.contributions?.[indicator.code];
                  return (
                    <tr key={indicator.code}>
                      <td className="strong">{indicator.header}</td>
                      <td className="dim">{indicator.unit || '—'}</td>
                      <td className="num">{formatIndicator(value, indicator.unit)}</td>
                      <td className="num">{Number.isFinite(score) ? fmtNumber(score, 1) : '—'}</td>
                      <td className="num">{Number.isFinite(contribution) ? fmtNumber(contribution, 3) : '—'}</td>
                    </tr>
                  );
                })}
                <tr>
                  <td className="strong" colSpan={4}>المؤشر المركّب</td>
                  <td className="num strong">{indicatorRow.composite === null || indicatorRow.composite === undefined ? '—' : fmtNumber(indicatorRow.composite, 4)}</td>
                </tr>
              </tbody>
            </table>
            <div className="dim" style={{ fontSize: '0.74rem', padding: '8px 4px' }}>
              العمود المميّز في العرض الحالي: {view === 'values' ? 'القيمة' : view === 'scores' ? 'الدرجة المعيارية' : 'المساهمة'}.
            </div>
          </div>
        )}
      </Card>

      <Card title="كل الحقول" subtitle="أعمدة الإدخال A..AM بقيمها المخزّنة.">
        <div className="stack">
          {groups.map((group) => (
            <div key={group.id} className="stack tight">
              <div className="row gap-sm" style={{ marginTop: 4 }}>
                <h3 style={{ fontSize: '0.9rem' }}>{group.title}</h3>
                <span className="dim" style={{ fontSize: '0.74rem' }}>{group.fields.length} حقلًا</span>
              </div>
              <div className="form-grid">
                {group.fields.map((field) => {
                  const value = detail.values?.[field.key];
                  const isMissingMandatory = mandatoryKeys.includes(field.key) && (value === null || value === undefined || String(value).trim() === '');
                  return (
                    <div key={field.key} className={cx('field')}>
                      <span className="field-label">
                        {field.header}
                        <span className="dim mono" style={{ fontSize: '0.66rem' }}>{field.column}</span>
                        {isMissingMandatory && <span className="req" title="حقل إلزامي ناقص">*</span>}
                      </span>
                      <div
                        className={cx('input')}
                        style={{
                          color: value === null || value === undefined || value === '' ? 'var(--text-4)' : 'var(--text)',
                          borderColor: isMissingMandatory ? 'rgba(226,168,60,.4)' : undefined,
                        }}
                      >
                        {fmtDisplay(value, field)}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </Card>

      <div className="grid-2">
        <Card title="توثيق القيم" subtitle="نص القيمة كما ورد في المصدر، ومكانها." icon={FileSpreadsheet}>
          {(detail.sources ?? []).length === 0 ? <Empty icon={FileSpreadsheet} title="لا سجلات توثيق" hint="لم تُسجّل مصادر لهذا السجل بعد." /> : (
            <div className="table-wrap" style={{ maxHeight: 380 }}>
              <table className="data">
                <thead><tr><th>الحقل</th><th>النص الأصلي</th><th>المصدر</th><th>الموضع</th></tr></thead>
                <tbody>
                  {detail.sources.map((source) => (
                    <tr key={`${source.field_key}-${source.data_value_id ?? source.captured_at}`}>
                      <td>{catalogue.find((field) => field.key === source.field_key)?.header ?? source.field_key}</td>
                      <td className="mono">{source.value_text ?? '—'}</td>
                      <td className="dim">{source.source_file ?? '—'}</td>
                      <td className="mono dim">{source.source_location ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card title="السجل الزمني" subtitle="الإصدارات المحفوظة قبل كل تعديل." icon={History}>
          {versions.length === 0 ? <Empty icon={History} title="لا إصدارات" hint="يُحفظ إصدار قبل أول تعديل يدوي." /> : (
            <div className="timeline">
              {versions.map((version) => (
                <div className="timeline-item" key={version.id}>
                  <span className="dot" />
                  <div className="tl-body row between">
                    <div>
                      <strong>إصدار #{version.id}</strong>
                      <div className="dim" style={{ fontSize: '0.74rem' }}>{version.reason ?? 'snapshot'} · {fmtDateTime(version.created_at)}</div>
                    </div>
                    <button className="btn small" onClick={() => restoreVersion(version.id)}><RotateCcw size={14} /> إرجاع</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </>
  );
}

function fmtDisplay(value, field) {
  if (value === null || value === undefined || value === '') return '—';
  if (field.type === 'ratio') return fmtRatio(value);
  if (field.type === 'boolean') return Number(value) === 1 ? 'نعم' : 'لا';
  if (field.type === 'number') return fmtNumber(value, 2);
  return String(value);
}

function formatIndicator(value, unit) {
  if (!Number.isFinite(value)) return '—';
  if (unit === '%') return fmtNumber(value, 2);
  if (Math.abs(value) >= 1000) return fmtNumber(value, 0);
  return fmtNumber(value, 3);
}