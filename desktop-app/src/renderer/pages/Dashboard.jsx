import React, { useCallback, useEffect, useState } from 'react';
import {
  Activity, AlertTriangle, Building2, CheckCircle2, FileSpreadsheet, Gauge,
  MapPinned, ShieldCheck, Sparkles, Trophy, Users,
} from 'lucide-react';
import { Bar, Card, Empty, ErrorBanner, Loading, MiniStat, ProgressRow, Reveal, Stat } from '../components/ui.jsx';
import { errText, fmtDate, fmtNumber, fmtPercent } from '../lib/format.js';
import brandBanner from '../assets/brand-banner.jpg';

/**
 * «اللوحة التفاعلية»
 *
 * One payload (`sheet:dashboard`) drives every number on the page, so no two
 * panels can show figures from different moments of the data.
 */
export default function Dashboard({ onNavigate, refreshKey }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setData(await window.localApp.sheetDashboard());
    } catch (cause) {
      setError(errText(cause) || 'تعذر تحميل اللوحة التفاعلية.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load, refreshKey]);

  if (loading && !data) return <Card title="اللوحة التفاعلية"><Loading label="جارٍ حساب اللوحة من قاعدة البيانات..." /></Card>;
  if (error && !data) return <ErrorBanner message={error} />;
  if (!data) return null;

  const totals = data.totals ?? {};
  const empty = !totals.directorates;

  if (empty) {
    return (
      <>
        <Hero onNavigate={onNavigate} generatedAt={data.generatedAt} />
        <Card>
          <Empty
            icon={FileSpreadsheet}
            title="لا توجد مديريات محفوظة بعد"
            hint="يمكن إدخال البيانات يدويًا أو استيراد ملف Excel، ثم مراجعتها واعتمادها قبل حفظها في قاعدة البيانات."
            action={<button className="btn primary" onClick={() => onNavigate('import')}><FileSpreadsheet size={17} />استيراد البيانات</button>}
          />
        </Card>
      </>
    );
  }

  const buckets = data.completenessBuckets ?? [];
  const totalForBuckets = buckets.reduce((sum, bucket) => sum + bucket.count, 0) || 1;
  const governorates = data.governorates ?? [];
  const needs = data.needs ?? [];
  const coverage = data.indicatorsCoverage ?? [];
  const quality = data.quality ?? null;

  return (
    <>
      <Hero onNavigate={onNavigate} generatedAt={data.generatedAt} />

      {error && <ErrorBanner message={error} onDismiss={() => setError('')} />}

      <div className="metric-grid">
        <Stat index={0} label="المديريات المحفوظة" value={totals.directorates} icon={MapPinned} tone="info" note="سجل جغرافي واحد لكل (مديرية، محافظة)" />
        <Stat index={1} label="مكتملة الحقول" value={totals.complete} icon={CheckCircle2} tone="ok" note="تستوفي الحقول الإلزامية الـ 13" />
        <Stat index={2} label="ناقصة" value={totals.incomplete} icon={AlertTriangle} tone="warn" note="لا تدخل الترتيب حتى تُكمل" />
        <Stat index={3} label="شاذة" value={totals.anomalies} icon={Activity} tone="bad" note="مقادير غير منطقية مستبعدة" />
        <Stat index={4} label="المحافظات" value={totals.governorates} icon={Building2} tone="violet" note="محافظات ممثّلة في القاعدة" />
        <Stat index={5} label="إجمالي السكان" value={totals.population} icon={Users} tone="info" note="مجموع سكان المديريات" />
        <Stat index={6} label="قابلة للترتيب" value={totals.ranked} icon={Trophy} tone="gold" note="مكتملة وخالية من الشواذ" />
        <Stat
          index={7}
          label="متوسط المركّب"
          display={totals.averageComposite === null || totals.averageComposite === undefined ? '—' : fmtNumber(totals.averageComposite, 4)}
          icon={Gauge}
          tone="violet"
          note="متوسط مؤشر الأولوية للمؤهلة"
        />
      </div>

      <div className="grid-2">
        <Card title="حالة الاكتمال" subtitle="توزيع المديريات على ثلاث حالات، والقاعدة: المكتمل فقط يدخل الترتيب.">
          <div className="stack">
            {buckets.map((bucket, index) => (
              <Reveal key={bucket.key} i={index}>
                <ProgressRow
                  label={bucket.label}
                  value={bucket.count}
                  max={totalForBuckets}
                  display={`${bucket.count} (${fmtPercent((bucket.count / totalForBuckets) * 100, 0)})`}
                />
              </Reveal>
            ))}
          </div>
          <div className="quote" style={{ marginTop: 16 }}>
            يُستبعد الصف الشاذ من الترتيب تلقائيًا، ويعود بمجرد تصحيح الخلية وإعادة الاستيراد — الشذوذ محسوب من القيمة لا مخزّن كعلَم.
          </div>
        </Card>

        <Card title="أعلى احتياج" subtitle="أول عشرة مراكز في المؤشر المركّب المعاير (المكتملة فقط).">
          {needs.length === 0
            ? <Empty icon={Trophy} title="لا يوجد مركز مؤهل بعد" hint="أكمل الحقول الإلزامية للمديريات ليبدأ الترتيب." />
            : (
              <div className="stack tight">
                {needs.map((need, index) => (
                  <Reveal key={need.districtName + need.governorate} i={index} className="row between lift" style={{ padding: '8px 10px', borderRadius: 8 }}>
                    <div className="row gap-sm" style={{ minWidth: 0 }}>
                      <span className={`rank-badge ${index === 0 ? 'top1' : index === 1 ? 'top2' : index === 2 ? 'top3' : ''}`}>{need.rank}</span>
                      <div style={{ minWidth: 0 }}>
                        <div className="nowrap" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{need.districtName}</div>
                        <div className="dim" style={{ fontSize: '0.72rem' }}>{need.governorate} · {need.projectType || 'بلا نوع مشروع'}</div>
                      </div>
                    </div>
                    <div style={{ width: 120 }}>
                      <Bar value={need.composite} max={1} />
                      <div className="dim tnum" style={{ fontSize: '0.72rem', textAlign: 'left' }}>{fmtNumber(need.composite, 4)}</div>
                    </div>
                  </Reveal>
                ))}
              </div>
            )}
        </Card>
      </div>

      <Card
        title="المحافظات"
        subtitle="كل محافظة بعدد مديرياتها وسكانها ومتوسط مؤشرها المركّب."
        actions={<button className="btn small ghost" onClick={() => onNavigate('database')}>قاعدة البيانات الشاملة</button>}
      >
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>المحافظة</th>
                <th className="num">المديريات</th>
                <th className="num">المكتملة</th>
                <th className="num">السكان</th>
                <th className="num">متوسط المركّب</th>
                <th style={{ width: 160 }}>الاكتمال</th>
              </tr>
            </thead>
            <tbody>
              {governorates.map((governorate, index) => (
                <tr key={governorate.name} style={{ animation: `rise .35s var(--ease-out) ${index * 30}ms both` }}>
                  <td className="strong">{governorate.name}</td>
                  <td className="num">{fmtNumber(governorate.count, 0)}</td>
                  <td className="num">{fmtNumber(governorate.complete, 0)}</td>
                  <td className="num">{fmtNumber(governorate.population, 0)}</td>
                  <td className="num">{governorate.averageComposite === null ? '—' : fmtNumber(governorate.averageComposite, 4)}</td>
                  <td>
                    <Bar value={governorate.complete} max={governorate.count || 1} tone={governorate.complete === governorate.count ? 'ok' : 'warn'} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="grid-2">
        <Card title="تغطية المؤشرات الـ 12" subtitle="عدد المديريات التي أمكن حساب كل مؤشر لها. الأسوأ تغطية أولًا.">
          <div className="stack tight">
            {coverage.map((indicator, index) => (
              <Reveal key={indicator.code} i={index}>
                <ProgressRow
                  label={indicator.header}
                  value={indicator.present}
                  max={indicator.total || 1}
                  display={`${indicator.present}/${indicator.total}`}
                />
              </Reveal>
            ))}
          </div>
        </Card>

        <Card title="جودة البيانات" subtitle="ملخص فحوص الاتساق التي أجراها المحرك على الصفوف المخزّنة.">
          {quality ? (
            <div className="stat-strip">
              <MiniStat label="ملاحظات حاجبة" value={fmtNumber(quality.blocker, 0)} />
              <MiniStat label="تحذيرات" value={fmtNumber(quality.warning, 0)} />
              <MiniStat label="معلومات" value={fmtNumber(quality.info, 0)} />
              <MiniStat label="سجلات بها حاجب" value={fmtNumber(quality.recordsWithBlockers, 0)} />
            </div>
          ) : <Empty icon={ShieldCheck} title="لا توجد ملاحظات جودة" hint="لم يرصد المحرك أي مخالفة على البيانات الحالية." />}
          {quality?.byCode && Object.keys(quality.byCode).length > 0 && (
            <div className="chip-row" style={{ marginTop: 14 }}>
              {Object.entries(quality.byCode).slice(0, 8).map(([code, count]) => (
                <span className="chip warn" key={code}>{code} · {count}</span>
              ))}
            </div>
          )}
          <div className="quote" style={{ marginTop: 14 }}>
            تُجرى هذه الفحوص داخليًا على البيانات المحفوظة في قاعدة البيانات.
          </div>
        </Card>
      </div>
    </>
  );
}

function Hero({ onNavigate, generatedAt }) {
  return (
    <section className="hero reveal-soft">
      <img className="hero-bg" src={brandBanner} alt="" />
      <div className="hero-inner">
        <div className="flex1">
          <p className="eyebrow">لوحة القيادة</p>
          <h1>نظرة شاملة على المديريات المحلية</h1>
          <p>
            تعكس هذه الأرقام البيانات المحفوظة محليًا في قاعدة البيانات المشفّرة على هذا الجهاز.
            آخر تحديث: {fmtDate(generatedAt)}.
          </p>
        </div>
        <div className="hero-actions">
          <button className="btn primary sheen" onClick={() => onNavigate('import')}>
            <FileSpreadsheet size={17} />
            استيراد ملف Excel
          </button>
          <button className="btn" onClick={() => onNavigate('ranking')}>
            <Sparkles size={16} />
            ترتيب الأولويات
          </button>
        </div>
      </div>
    </section>
  );
}