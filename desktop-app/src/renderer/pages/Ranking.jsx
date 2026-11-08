import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, ArrowDown, ArrowUp, ListOrdered, Medal, Scale, Trophy } from 'lucide-react';
import { Badge, Bar, Card, Empty, ErrorBanner, Loading, Segmented } from '../components/ui.jsx';
import { errText, fmtByType, fmtNumber, fmtPercent } from '../lib/format.js';

/**
 * «ترتيب الأولويات»
 *
 * The rule is stated on the page because it is the product: only a complete,
 * non-anomalous directorate is ranked, and the two exclusion lists are shown in
 * full rather than collapsed into a count. The workbook's own ranking columns
 * are ignored on import; this list is recomputed from the inputs.
 */
export default function Ranking({ catalogue, notify, onOpenCard }) {
  const [mode, setMode] = useState('calibrated');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await window.localApp.sheetRanking({ mode }));
    } catch (cause) {
      setError(errText(cause) || 'تعذر تحميل ترتيب الأولويات.');
    } finally {
      setLoading(false);
    }
  }, [mode]);

  useEffect(() => { load(); }, [load]);

  async function exportPdf() {
    try {
      const result = await window.localApp.exportAnalysisPdf();
      if (!result?.canceled) notify?.({ tone: 'ok', message: `صُدّر التقرير إلى ${result.filePath}` });
    } catch (cause) {
      notify?.({ tone: 'bad', message: errText(cause) || 'تعذر تصدير التقرير.' });
    }
  }

  const ranked = data?.ranked ?? [];
  const waiting = data?.waiting ?? [];
  const anomalies = data?.anomalies ?? [];
  const meta = data?.meta ?? {};

  if (loading && !data) return <Card title="ترتيب الأولويات"><Loading label="جارٍ ترتيب المديريات..." /></Card>;

  return (
    <>
      {error && <ErrorBanner message={error} onDismiss={() => setError('')} />}

      <Card className="gold">
        <div className="row between">
          <div className="stack tight" style={{ maxWidth: '70ch' }}>
            <div className="row gap-sm">
              <Medal size={18} color="var(--gold)" />
              <strong>قاعدة الترتيب</strong>
            </div>
            <p className="muted" style={{ fontSize: '0.86rem' }}>
              {data?.rule ?? 'يُرتب المكتمل فقط، وتُستبعد الصفوف ذات القيم الشاذة حتى تُصحح.'}
              {' '}يعتمد الترتيب على أوزان المؤشرات المعتمدة، ويُحسب داخليًا من البيانات المحفوظة.
            </p>
            <div className="chip-row">
              <Badge tone="ok">مؤهلة: {ranked.length}</Badge>
              <Badge tone="warn">بانتظار الاستكمال: {waiting.length}</Badge>
              <Badge tone="bad">شاذة: {anomalies.length}</Badge>
              {meta.severeCount !== undefined && <Badge tone="violet">حرمان حاد: {meta.severeCount}</Badge>}
              {meta.fragileCount != null && <Badge tone="info">حساسة للأوزان: {meta.fragileCount}</Badge>}
            </div>
          </div>
          <div className="stack tight">
            <Segmented
              value={mode}
              onChange={setMode}
              options={[{ value: 'calibrated', label: 'المعايرة المطلقة' }, { value: 'replica', label: 'المعادلة المرجعية' }]}
            />
            <span className="dim" style={{ fontSize: '0.72rem', textAlign: 'center' }}>
              {mode === 'calibrated' ? 'نقاط مرجعية ثابتة (موصى به)' : 'تطبيق المعادلة المرجعية (القيمة المفقودة = صفر)'}
            </span>
            <button className="btn small" onClick={exportPdf}><Scale size={14} /> تصدير التقرير PDF</button>
          </div>
        </div>
      </Card>

      <Card title="الترتيب" subtitle={`${ranked.length} مديرية مؤهلة، مرتبة تنازليًا حسب مؤشر الاحتياج المركّب.`} icon={ListOrdered} flush>
        {ranked.length === 0 ? (
          <Empty
            icon={Trophy}
            title="لا توجد مديريات مؤهلة بعد"
            hint="يحتاج الترتيب مديريات مكتملة الحقول الإلزامية وخالية من القيم الشاذة. أكمل الناقص من شاشة التصحيح."
          />
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th style={{ width: 54 }}>#</th>
                  <th>المديرية</th>
                  <th>المحافظة</th>
                  <th className="num">المركّب</th>
                  <th style={{ width: 170 }}>الشدة</th>
                  <th>نوع المشروع</th>
                  <th className="num">السكان</th>
                  <th>قرار المراجع</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {ranked.map((row, index) => (
                  <tr key={`${row.directorateId}-${row.rank}`} style={{ animation: `rise .32s var(--ease-out) ${Math.min(index, 24) * 22}ms both` }}>
                    <td>
                      <span className={cxRank(index)}>{row.rank}</span>
                    </td>
                    <td className="strong">
                      <button className="linkish" onClick={() => onOpenCard?.(row.directorateId)}>{row.districtName}</button>
                    </td>
                    <td>{row.governorate}</td>
                    <td className="num strong">{fmtNumber(row.composite, 4)}</td>
                    <td>
                      <Bar value={row.composite} max={1} tone={row.composite >= 0.66 ? 'bad' : row.composite >= 0.33 ? 'warn' : 'ok'} />
                    </td>
                    <td>{row.projectType || '—'}</td>
                    <td className="num">{fmtNumber(row.population, 0)}</td>
                    <td>{row.decision ? <Badge tone={row.decision === 'معتمد' ? 'ok' : row.decision === 'مرفوض' ? 'bad' : 'warn'}>{row.decision}</Badge> : '—'}</td>
                    <td>
                      <button className="btn small ghost" onClick={() => onOpenCard?.(row.directorateId)}>البطاقة</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div className="grid-2">
        <Card title="بانتظار الاستكمال" subtitle="حقول إلزامية ناقصة تمنع دخول المديرية إلى الترتيب.">
          {waiting.length === 0 ? <Empty icon={Trophy} title="لا سجلات معلّقة" hint="كل المديريات المخزّنة مكتملة الحقول الإلزامية." /> : (
            <div className="table-wrap" style={{ maxHeight: 420 }}>
              <table className="data">
                <thead>
                  <tr><th>المديرية</th><th>المحافظة</th><th className="num">الاكتمال</th><th>الناقص</th></tr>
                </thead>
                <tbody>
                  {waiting.map((row) => (
                    <tr key={row.directorateId}>
                      <td className="strong">
                        <button className="linkish" onClick={() => onOpenCard?.(row.directorateId)}>{row.districtName}</button>
                      </td>
                      <td>{row.governorate}</td>
                      <td className="num">{fmtPercent((row.completeness?.ratio ?? 0) * 100, 0)}</td>
                      <td>
                        <div className="chip-row">
                          {(row.missingLabels ?? []).slice(0, 5).map((label) => <span className="chip warn" key={label}>{label}</span>)}
                          {(row.missingLabels?.length ?? 0) > 5 && <span className="chip">+{row.missingLabels.length - 5}</span>}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card title="القيم الشاذة" subtitle="مقادير غير منطقية لوحدتها؛ تُستبعد من الترتيب حتى تُصحح في الملف أو من شاشة التصحيح.">
          {anomalies.length === 0 ? <Empty icon={Trophy} title="لا قيم شاذة" hint="كل القيم المخزّنة داخل المدى المنطقي لوحدتها." /> : (
            <div className="stack tight">
              {anomalies.map((row, index) => (
                <div key={row.directorateId ?? index} className="list-item" style={{ '--i': index }}>
                  <div className="li-title">
                    <AlertTriangle size={14} color="var(--bad)" />
                    <span className="flex1">{row.districtName}</span>
                    <span className="dim" style={{ fontSize: '0.74rem' }}>{row.governorate}</span>
                  </div>
                  <div className="chip-row">
                    {(row.keys ?? []).map((key, keyIndex) => (
                      <span className="chip bad" key={key}>
                        {row.labels?.[keyIndex] ?? key}: {formatRaw(row.values?.[key])}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      <Card title="كيف يُحسب المركّب؟" subtitle="نفس المعادلة في كل صفحة، بلا اعتماد على أعمدة الملف المحسوبة.">
        <div className="grid-2">
          <div className="stack tight">
            <div className="row gap-sm"><ArrowUp size={15} color="var(--warn)" /><strong>مؤشرات يزيد بها الاحتياج</strong></div>
            <p className="muted" style={{ fontSize: '0.83rem' }}>عجز المياه، عجز الطرق، قرب خط النار، سكان/منشأة، تعثر المشروع، العجز المالي.</p>
            <div className="row gap-sm" style={{ marginTop: 6 }}><ArrowDown size={15} color="var(--info)" /><strong>مؤشرات يقل بها الاحتياج</strong></div>
            <p className="muted" style={{ fontSize: '0.83rem' }}>نصيب الفرد من الإيراد، مدارس/10 آلاف، إنتاج/فرد، سلاسل القيمة، جمعيات/10 آلاف، مساعدات/فرد.</p>
          </div>
          <div className="stack tight">
            <div className="kv">
              <dt>عتبة الانحدار (k)</dt><dd className="tnum">{data?.calibration?.kThreshold ?? 'افتراضي'}</dd>
              <dt>خط الحرمان</dt><dd className="tnum">{data?.calibration?.deprivationLine ?? 'افتراضي'}</dd>
              <dt>مرشحون في آخر تشغيل</dt><dd className="tnum">{meta.calibratedRanked ?? '—'}</dd>
              <dt>متوسط اكتمال الحقول</dt><dd className="tnum">{meta.averageCompleteness !== undefined ? fmtPercent(meta.averageCompleteness * 100, 0) : '—'}</dd>
            </div>
            <div className="quote">
              تغيير أي قيمة في التصحيح يعيد حساب اللوحة والمؤشرات والترتيب من جديد؛ لا يوجد كاش قديم يُعرض بالخطأ.
            </div>
          </div>
        </div>
      </Card>
    </>
  );
}

function cxRank(index) {
  return index === 0 ? 'rank-badge top1' : index === 1 ? 'rank-badge top2' : index === 2 ? 'rank-badge top3' : 'rank-badge';
}

function formatRaw(value) {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'number') return fmtNumber(value, Math.abs(value) >= 100 ? 0 : 2);
  return fmtByType(value);
}