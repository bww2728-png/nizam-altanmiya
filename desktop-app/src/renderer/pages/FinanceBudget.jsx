import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge, Card, Empty, ErrorBanner, Field, Loading, Modal, NumberInput, SelectInput, Stat, TextInput } from '../components/ui.jsx';
import { DASH, errText, fmtInt, fmtMinor, fmtPercent } from '../lib/format.js';
import { Banknote, Coins, Landmark, Plus, RefreshCw, Scale, Wallet } from 'lucide-react';

const LEDGER_PAGE_SIZE = 50;

function bridge() {
  return typeof window === 'undefined' ? null : window.localApp ?? null;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function numeric(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function flattenAccounts(nodes, depth = 0, output = []) {
  (Array.isArray(nodes) ? nodes : []).forEach((node) => {
    output.push({ ...node, depth });
    flattenAccounts(node.children, depth + 1, output);
  });
  return output;
}

function moneyText(minor, unit) {
  if (minor === null || minor === undefined) return DASH;
  return fmtMinor(minor, unit ?? 2);
}

function AccountTreeTable({ nodes }) {
  const rows = useMemo(() => flattenAccounts(nodes), [nodes]);
  if (!rows.length) return <Empty icon={Landmark} title="لا دليل حسابات" hint="لم تُسجل حسابات مالية بعد." />;
  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr><th>الحساب</th><th>الرمز</th><th>النوع</th><th>الحالة</th></tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.accountId}>
              <td className="strong" style={{ paddingInlineStart: 10 + row.depth * 18 }}>
                {row.accountName ?? row.accountCode ?? `حساب ${row.accountId}`}
                {row.cycle && <Badge tone="bad"> دورة في الشجرة</Badge>}
                {row.orphan && <Badge tone="warn"> بلا أب</Badge>}
              </td>
              <td>{row.accountCode ?? DASH}</td>
              <td>{row.accountType ?? DASH}</td>
              <td>{row.isActive === 0 ? <Badge tone="warn"> غير نشط</Badge> : <Badge tone="ok"> نشط</Badge>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function FinanceBudget({ notify, refreshKey }) {
  const api = bridge();
  const financeApi = api?.finance ?? null;
  const unified = api?.unified ?? null;

  const [overview, setOverview] = useState(null);
  const [accounts, setAccounts] = useState([]);
  const [budgets, setBudgets] = useState([]);
  const [currencies, setCurrencies] = useState([]);
  const [geoOptions, setGeoOptions] = useState([]);
  const [periodOptions, setPeriodOptions] = useState([]);
  const [projectOptions, setProjectOptions] = useState([]);
  const [accountOptions, setAccountOptions] = useState([]);
  const [budgetId, setBudgetId] = useState('');
  const [currencyCode, setCurrencyCode] = useState('');
  const [variance, setVariance] = useState(null);
  const [commitments, setCommitments] = useState(null);
  const [varianceError, setVarianceError] = useState('');
  const [ledgerKind, setLedgerKind] = useState('revenue');
  const [ledgerGeoId, setLedgerGeoId] = useState('');
  const [ledgerPeriodId, setLedgerPeriodId] = useState('');
  const [ledger, setLedger] = useState(null);
  const [ledgerOffset, setLedgerOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [entry, setEntry] = useState(null);
  const [saving, setSaving] = useState(false);

  const loadBase = useCallback(async () => {
    if (!financeApi) return;
    setLoading(true);
    try {
      const [summary, tree, budgetList, currencyList, geoList, periodList, accountList] = await Promise.all([
        financeApi.overview().catch(() => null),
        financeApi.accounts().catch(() => []),
        unified?.list({ dataset: 'budgetHeaders', limit: 200 }).catch(() => null),
        unified?.options({ kind: 'currency', limit: 100 }).catch(() => []),
        unified?.options({ kind: 'geo', limit: 300 }).catch(() => []),
        unified?.options({ kind: 'period', limit: 200 }).catch(() => []),
        unified?.options({ kind: 'account', limit: 400 }).catch(() => [])
      ]);
      setOverview(summary);
      setAccounts(Array.isArray(tree) ? tree : []);
      setBudgets(Array.isArray(budgetList?.rows) ? budgetList.rows : []);
      setCurrencies(Array.isArray(currencyList) ? currencyList : []);
      setGeoOptions(Array.isArray(geoList) ? geoList : []);
      setPeriodOptions(Array.isArray(periodList) ? periodList : []);
      setAccountOptions(Array.isArray(accountList) ? accountList : []);
      const projects = await Promise.resolve(api?.canonicalProjects?.({ limit: 300 })).catch(() => null);
      const projectRows = Array.isArray(projects) ? projects : (projects?.rows ?? []);
      setProjectOptions(Array.isArray(projectRows) ? projectRows : []);
      setError('');
    } catch (cause) {
      setError(errText(cause) || 'تعذر تحميل ملخص المالية.');
    } finally {
      setLoading(false);
    }
  }, [api, financeApi, unified]);

  useEffect(() => { loadBase(); }, [loadBase, refreshKey]);

  const activeBudgetId = budgetId === '' ? null : Number(budgetId);

  const loadVariance = useCallback(async () => {
    if (!financeApi || !activeBudgetId) { setVariance(null); setCommitments(null); setVarianceError(''); return; }
    const request = { budgetId: activeBudgetId };
    if (currencyCode) request.currencyCode = currencyCode;
    const [varianceResult, commitmentResult] = await Promise.allSettled([
      financeApi.budgetVariance(request),
      financeApi.commitments({ budgetId: activeBudgetId })
    ]);
    if (varianceResult.status === 'fulfilled') { setVariance(varianceResult.value ?? null); setVarianceError(''); }
    else { setVariance(null); setVarianceError(errText(varianceResult.reason) || 'تعذر تحميل فروقات الموازنة.'); }
    setCommitments(commitmentResult.status === 'fulfilled' ? (commitmentResult.value ?? null) : null);
  }, [financeApi, activeBudgetId, currencyCode]);

  useEffect(() => { loadVariance(); }, [loadVariance, refreshKey]);

  const loadLedger = useCallback(async () => {
    if (!financeApi) return;
    try {
      const result = await financeApi.ledger({
        kind: ledgerKind,
        geoUnitId: ledgerGeoId === '' ? undefined : Number(ledgerGeoId),
        periodId: ledgerPeriodId === '' ? undefined : Number(ledgerPeriodId),
        limit: LEDGER_PAGE_SIZE,
        offset: ledgerOffset
      });
      setLedger(result ?? null);
    } catch (cause) {
      setLedger(null);
      setError(errText(cause) || 'تعذر تحميل دفتر الحركات.');
    }
  }, [financeApi, ledgerKind, ledgerGeoId, ledgerPeriodId, ledgerOffset]);

  useEffect(() => { loadLedger(); }, [loadLedger, refreshKey]);

  const currencyLabel = useCallback((code) => {
    if (!code) return DASH;
    const found = currencies.find((item) => String(item.value).toUpperCase() === String(code).toUpperCase());
    return found?.label ? `${code} — ${found.label}` : code;
  }, [currencies]);

  const accountsByCode = useMemo(() => {
    const map = new Map();
    flattenAccounts(accounts).forEach((row) => {
      if (row.accountCode) map.set(row.accountCode, row.accountName ?? row.accountCode);
    });
    return map;
  }, [accounts]);

  function openEntry(kind) {
    setEntry({
      kind,
      geoUnitId: '',
      periodId: '',
      accountId: '',
      projectId: '',
      amount: '',
      currencyCode: currencies[0] ? String(currencies[0].value) : '',
      transactionDate: today(),
      reason: '',
      banner: ''
    });
  }

  async function submitEntry() {
    if (!entry || !financeApi) return;
    const amount = numeric(entry.amount);
    if (!entry.currencyCode) {
      setEntry((current) => ({ ...current, banner: 'رمز العملة مطلوب لتسجيل الحركة.' }));
      return;
    }
    if (amount === null || amount < 0) {
      setEntry((current) => ({ ...current, banner: 'المبلغ يجب أن يكون رقماً غير سالب.' }));
      return;
    }
    if (entry.reason.trim().length < 3) {
      setEntry((current) => ({ ...current, banner: 'سبب التسجيل مطلوب (٣ أحرف على الأقل).' }));
      return;
    }
    const payload = {
      currencyCode: entry.currencyCode,
      transactionDate: entry.transactionDate || undefined,
      reason: entry.reason.trim()
    };
    if (entry.geoUnitId !== '') payload.geoUnitId = Number(entry.geoUnitId);
    if (entry.periodId !== '') payload.periodId = Number(entry.periodId);
    if (entry.accountId !== '') payload.accountId = Number(entry.accountId);
    if (entry.kind === 'revenue') payload.collectedAmount = amount;
    else {
      payload.paidAmount = amount;
      if (entry.projectId !== '') payload.projectId = Number(entry.projectId);
    }
    setSaving(true);
    try {
      const result = entry.kind === 'revenue'
        ? await financeApi.recordRevenue(payload)
        : await financeApi.recordExpenditure(payload);
      setEntry(null);
      notify?.({
        tone: 'ok',
        message: `${entry.kind === 'revenue' ? 'سُجل الإيراد' : 'سُجل الإنفاق'}: ${result?.amount ?? DASH} ${result?.currencyCode ?? ''}`
      });
      await loadLedger();
      setOverview(await financeApi.overview().catch(() => overview));
    } catch (cause) {
      setEntry((current) => ({ ...current, banner: errText(cause) || 'تعذر تسجيل الحركة.' }));
    } finally {
      setSaving(false);
    }
  }

  if (!financeApi) {
    return (
      <Card title="المالية والموازنة">
        <Empty
          icon={Wallet}
          title="جسر المالية غير متاح"
          hint="هذه النافذة تحتاج واجهة window.localApp.finance. أعد تشغيل التطبيق بالنسخة التي تسجل قنوات المالية."
        />
      </Card>
    );
  }

  if (loading && !overview) return <Card title="المالية والموازنة"><Loading label="جارٍ تحميل بيانات المالية..." /></Card>;

  const currenciesInSummary = overview?.totalsByCurrency ?? [];
  const varianceTotals = variance?.totals ?? null;
  const varianceUnit = variance?.minorUnit ?? 2;
  const page = Math.floor(ledgerOffset / LEDGER_PAGE_SIZE) + 1;
  const hasNext = Number(ledger?.total ?? 0) > ledgerOffset + LEDGER_PAGE_SIZE;

  return (
    <>
      {error && <ErrorBanner message={error} onDismiss={() => setError('')} />}

      <Card
        title="المالية والموازنة"
        subtitle="موازنات وفروقات وحركات إيراد وإنفاق، مع الفصل الصارم بين العملات وعدم خلط أي مبلغ مجهول بالصفر."
        icon={Wallet}
        actions={(
          <div className="btn-row">
            <button className="btn small primary" onClick={() => openEntry('revenue')}><Plus size={15} /> إيراد</button>
            <button className="btn small" onClick={() => openEntry('expenditure')}><Plus size={15} /> إنفاق</button>
            <button className="btn small" onClick={loadBase} disabled={loading}><RefreshCw size={15} /> تحديث</button>
          </div>
        )}
      >
        <div className="grid-4" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12 }}>
          <Stat label="الحسابات المالية" value={fmtInt(overview?.accounts ?? 0)} icon={Landmark} />
          <Stat label="الموازنات" value={fmtInt(overview?.budgets ?? 0)} icon={Scale} />
          <Stat label="بنود الموازنة" value={fmtInt(overview?.budgetLines ?? 0)} icon={Coins} />
          <Stat label="حركات الإيراد" value={fmtInt(overview?.revenueCount ?? 0)} icon={Banknote} />
          <Stat label="حركات الإنفاق" value={fmtInt(overview?.expenditureCount ?? 0)} icon={Banknote} />
        </div>

        {!currenciesInSummary.length ? (
          <Empty icon={Coins} title="لا ملخص عملات" hint="لا توجد مبالغ مسجلة حتى الآن؛ يظهر كل مبلغ بعملته فور تسجيله." />
        ) : (
          <div className="table-wrap" style={{ marginTop: 14 }}>
            <table className="data">
              <thead>
                <tr><th>العملة</th><th className="num">فئة الوحدة الدقيقة</th><th className="num">الإيراد</th><th className="num">الإنفاق</th><th className="num">الرصيد</th><th className="num">عدد الحركات</th></tr>
              </thead>
              <tbody>
                {currenciesInSummary.map((bucket) => (
                  <tr key={bucket.currencyCode}>
                    <td className="strong">{currencyLabel(bucket.currencyCode)}</td>
                    <td className="num">{fmtInt(bucket.minorUnit ?? 2)}</td>
                    <td className="num">{moneyText(bucket.revenueMinor, bucket.minorUnit)}</td>
                    <td className="num">{moneyText(bucket.expenditureMinor, bucket.minorUnit)}</td>
                    <td className="num">{moneyText(bucket.balanceMinor, bucket.minorUnit)}</td>
                    <td className="num">{fmtInt((bucket.revenueCount ?? 0) + (bucket.expenditureCount ?? 0))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {overview?.notes?.length ? overview.notes.map((note) => <p className="field-hint" key={note}>{note}</p>) : null}
      </Card>

      <Card title="دليل الحسابات" subtitle="شجرة حسابات مالية هرمية مع كشف الدورات والعقد اليتيمة." icon={Landmark}>
        <AccountTreeTable nodes={accounts} />
      </Card>

      <Card
        title="الموازنة مقابل الفعلي"
        subtitle="الفروق تُحسب داخل قاعدة البيانات على الفئات الدقيقة؛ لا جمع بين عملتين."
        icon={Scale}
        actions={(
          <div className="btn-row">
            <SelectInput
              value={budgetId}
              onChange={(value) => { setBudgetId(value); setCurrencyCode(''); }}
              options={[
                { value: '', label: '— اختر موازنة —' },
                ...budgets.map((item) => ({
                  value: String(item.budget_id ?? item.budgetId),
                  label: item.budget_name ?? item.budgetName ?? item.budget_code ?? `موازنة ${item.budget_id ?? item.budgetId}`
                }))
              ]}
            />
            <SelectInput
              value={currencyCode}
              onChange={setCurrencyCode}
              options={[{ value: '', label: 'العملة تلقائياً' }, ...currencies.map((item) => ({ value: String(item.value), label: item.label ?? String(item.value) }))]}
            />
          </div>
        )}
      >
        {varianceError && <ErrorBanner message={varianceError} onDismiss={() => setVarianceError('')} />}
        {!activeBudgetId ? (
          <Empty icon={Scale} title="اختر موازنة" hint="لعرض البنود المعتمدة والمعدلة والفعلي والفروق." />
        ) : !variance ? (
          <Loading label="جارٍ حساب الفروقات..." />
        ) : (
          <>
            <div className="report-summary-strip">
              <div><span>العملة</span><strong>{currencyLabel(variance.currencyCode)}</strong></div>
              <div><span>البنود</span><strong>{fmtInt(varianceTotals?.lineCount ?? 0)}</strong></div>
              <div><span>المعتمد</span><strong>{moneyText(varianceTotals?.approvedMinor ?? null, varianceUnit)}</strong></div>
              <div><span>الفعلي</span><strong>{varianceTotals?.actualMinor === null || varianceTotals?.actualMinor === undefined ? DASH : moneyText(varianceTotals.actualMinor, varianceUnit)}</strong></div>
              <div><span>الفرق</span><strong>{varianceTotals?.varianceMinor === null || varianceTotals?.varianceMinor === undefined ? DASH : moneyText(varianceTotals.varianceMinor, varianceUnit)}</strong></div>
            </div>
            {variance.budget?.budgetName && <p className="field-hint">{variance.budget.budgetName} — حالة الموازنة: {variance.budget.budgetStatus ?? DASH}</p>}
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr><th>الحساب</th><th>القطاع</th><th className="num">المعتمد</th><th className="num">المعدّل</th><th className="num">الفعلي</th><th className="num">الفرق</th><th className="num">الفرق %</th><th>الأساس</th></tr>
                </thead>
                <tbody>
                  {(variance.lines ?? []).map((line) => (
                    <tr key={line.lineId}>
                      <td className="strong">{line.accountName ?? line.accountCode ?? line.accountId ?? DASH}</td>
                      <td>{line.sectorLabel ?? DASH}</td>
                      <td className="num">{moneyText(line.approvedMinor, varianceUnit)}</td>
                      <td className="num">{line.revisedMinor === null ? DASH : moneyText(line.revisedMinor, varianceUnit)}</td>
                      <td className="num">{line.actualMinor === null ? DASH : moneyText(line.actualMinor, varianceUnit)}</td>
                      <td className="num">{line.varianceMinor === null ? DASH : moneyText(line.varianceMinor, varianceUnit)}</td>
                      <td className="num">{line.varianceRatio === null ? DASH : fmtPercent(line.varianceRatio * 100, 1)}</td>
                      <td>{line.basis === 'missing-actual' ? <Badge tone="warn"> فعلي غير مسجل</Badge> : line.basis === 'revised' ? 'معدّل' : 'معتمد'}</td>
                    </tr>
                  ))}
                  {!(variance.lines ?? []).length && <tr><td colSpan={8}><Empty icon={Scale} title="لا بنود" hint="لا توجد بنود لهذه الموازنة بالعملة المختارة." /></td></tr>}
                </tbody>
              </table>
            </div>
            {variance.excludedLines ? <p className="field-hint">بنود مستثناة من الجمع: {fmtInt(variance.excludedLines)} (عملة مختلفة أو بيانات ناقصة).</p> : null}
            {variance.notes?.length ? variance.notes.map((note) => <p className="field-hint" key={note}>{note}</p>) : null}
          </>
        )}
      </Card>

      {commitments && (
        <Card title="ضبط الالتزامات" subtitle="المتبقي = المعتمد − الفعلي؛ البند بلا مبلغ فعلي لا يُعد متجاوزاً." icon={Coins}>
          <div className="report-summary-strip">
            <div><span>البنود</span><strong>{fmtInt(commitments.totals?.lineCount ?? 0)}</strong></div>
            <div><span>المعتمد</span><strong>{moneyText(commitments.totals?.approvedMinor ?? null, commitments.minorUnit ?? 2)}</strong></div>
            <div><span>الفعلي</span><strong>{commitments.totals?.actualMinor === null ? DASH : moneyText(commitments.totals.actualMinor, commitments.minorUnit ?? 2)}</strong></div>
            <div><span>المتبقي</span><strong>{commitments.totals?.remainingMinor === null ? DASH : moneyText(commitments.totals.remainingMinor, commitments.minorUnit ?? 2)}</strong></div>
            <div><span>بنود متجاوزة</span><strong>{fmtInt(commitments.totals?.exceededCount ?? 0)}</strong></div>
          </div>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>الحساب</th><th className="num">المعتمد</th><th className="num">الفعلي</th><th className="num">المتبقي</th><th>الحالة</th></tr></thead>
              <tbody>
                {(commitments.lines ?? []).map((line) => (
                  <tr key={line.lineId}>
                    <td className="strong">{line.accountName ?? line.accountCode ?? line.accountId ?? DASH}</td>
                    <td className="num">{moneyText(line.approvedMinor, commitments.minorUnit ?? 2)}</td>
                    <td className="num">{line.actualKnown ? moneyText(line.actualMinor, commitments.minorUnit ?? 2) : DASH}</td>
                    <td className="num">{line.remainingMinor === null ? DASH : moneyText(line.remainingMinor, commitments.minorUnit ?? 2)}</td>
                    <td>{line.exceeded ? <Badge tone="bad"> تجاوز</Badge> : line.actualKnown ? <Badge tone="ok"> ضمن الحد</Badge> : <Badge tone="warn"> فعلي غير مسجل</Badge>}</td>
                  </tr>
                ))}
                {!(commitments.lines ?? []).length && <tr><td colSpan={5}><Empty icon={Coins} title="لا بنود التزام" hint="لا بنود لهذه الموازنة." /></td></tr>}
              </tbody>
            </table>
          </div>
          {commitments.notes?.length ? commitments.notes.map((note) => <p className="field-hint" key={note}>{note}</p>) : null}
        </Card>
      )}

      <Card
        title="دفتر الحركات"
        subtitle="كل صف مبلغ واحد بعملته؛ لا تُجمع العملات ولا يظهر المجهول كصفر."
        icon={Banknote}
        actions={(
          <div className="btn-row">
            <SelectInput
              value={ledgerKind}
              onChange={(value) => { setLedgerKind(value); setLedgerOffset(0); }}
              options={[{ value: 'revenue', label: 'الإيرادات' }, { value: 'expenditure', label: 'الإنفاق' }]}
            />
            <SelectInput value={ledgerGeoId} onChange={(value) => { setLedgerGeoId(value); setLedgerOffset(0); }} options={[{ value: '', label: 'كل الوحدات' }, ...geoOptions.map((item) => ({ value: String(item.value), label: item.label }))]} />
            <SelectInput value={ledgerPeriodId} onChange={(value) => { setLedgerPeriodId(value); setLedgerOffset(0); }} options={[{ value: '', label: 'كل الفترات' }, ...periodOptions.map((item) => ({ value: String(item.value), label: item.label }))]} />
          </div>
        )}
      >
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr><th>التاريخ</th><th>الحساب</th><th>الوحدة الجغرافية</th><th>الجهة/المشروع</th><th className="num">المبلغ</th><th>العملة</th></tr>
            </thead>
            <tbody>
              {(ledger?.rows ?? []).map((row) => (
                <tr key={`${row.kind}-${row.transactionId}`}>
                  <td>{row.date ?? DASH}</td>
                  <td className="strong">{row.accountLabel ?? row.accountCode ?? (accountsByCode.get(row.accountCode) ?? DASH)}</td>
                  <td>{row.geoLabel ?? DASH}</td>
                  <td>{row.entityLabel ?? DASH} {row.entityRole === 'collecting' && <Badge tone="info"> محصّل</Badge>}</td>
                  <td className="num">{row.amount === null ? DASH : row.amount}</td>
                  <td>{row.currencyCode ?? DASH}</td>
                </tr>
              ))}
              {!(ledger?.rows ?? []).length && <tr><td colSpan={6}><Empty icon={Banknote} title="لا حركات" hint="لم تُسجل حركات بهذه الشروط." /></td></tr>}
            </tbody>
          </table>
        </div>
        <div className="btn-row" style={{ marginTop: 10 }}>
          <button className="btn small" disabled={ledgerOffset <= 0} onClick={() => setLedgerOffset(Math.max(0, ledgerOffset - LEDGER_PAGE_SIZE))}>السابق</button>
          <span className="chip">صفحة {fmtInt(page)} — {fmtInt(ledger?.total ?? 0)} حركة</span>
          <button className="btn small" disabled={!hasNext} onClick={() => setLedgerOffset(ledgerOffset + LEDGER_PAGE_SIZE)}>التالي</button>
        </div>
        {ledger?.notes?.length ? ledger.notes.map((note) => <p className="field-hint" key={note}>{note}</p>) : null}
      </Card>

      <Modal
        open={Boolean(entry)}
        title={entry?.kind === 'revenue' ? 'تسجيل حركة إيراد' : 'تسجيل حركة إنفاق'}
        subtitle="يُحتسب عمود الفئات الدقيقة تلقائياً من رمز العملة، ويُسجل التغيير في سجل التدقيق."
        onClose={() => setEntry(null)}
        footer={(
          <div className="btn-row">
            <button className="btn primary" onClick={submitEntry} disabled={saving}>{saving ? 'جارٍ التسجيل...' : 'تسجيل'}</button>
            <button className="btn ghost" onClick={() => setEntry(null)} disabled={saving}>إلغاء</button>
          </div>
        )}
      >
        {entry?.banner && <ErrorBanner message={entry.banner} onDismiss={() => setEntry((current) => ({ ...current, banner: '' }))} />}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
          <Field label="العملة" required hint="من سجل العملات المعتمد (YER/USD/SAR).">
            <SelectInput value={entry?.currencyCode ?? ''} onChange={(value) => setEntry((current) => ({ ...current, currencyCode: value }))}
              options={[{ value: '', label: '— اختر عملة —' }, ...currencies.map((item) => ({ value: String(item.value), label: item.label ?? String(item.value) }))]} />
          </Field>
          <Field label={entry?.kind === 'revenue' ? 'المبلغ المحصّل' : 'المبلغ المدفوع'} required hint="يُخزن كرقم عشري مع مرآته بالفئات الدقيقة.">
            <NumberInput value={entry?.amount ?? ''} onChange={(value) => setEntry((current) => ({ ...current, amount: value }))} step="any" />
          </Field>
          <Field label="التاريخ">
            <TextInput value={entry?.transactionDate ?? ''} onChange={(value) => setEntry((current) => ({ ...current, transactionDate: value }))} placeholder="YYYY-MM-DD" />
          </Field>
          <Field label="الحساب">
            <SelectInput value={entry?.accountId ?? ''} onChange={(value) => setEntry((current) => ({ ...current, accountId: value }))}
              options={[{ value: '', label: '— بدون —' }, ...accountOptions.map((item) => ({ value: String(item.value), label: item.label }))]} />
          </Field>
          <Field label="الوحدة الجغرافية">
            <SelectInput value={entry?.geoUnitId ?? ''} onChange={(value) => setEntry((current) => ({ ...current, geoUnitId: value }))}
              options={[{ value: '', label: '— بدون —' }, ...geoOptions.map((item) => ({ value: String(item.value), label: item.label }))]} />
          </Field>
          <Field label="الفترة">
            <SelectInput value={entry?.periodId ?? ''} onChange={(value) => setEntry((current) => ({ ...current, periodId: value }))}
              options={[{ value: '', label: '— بدون —' }, ...periodOptions.map((item) => ({ value: String(item.value), label: item.label }))]} />
          </Field>
          {entry?.kind === 'expenditure' && (
            <Field label="المشروع">
              <SelectInput value={entry?.projectId ?? ''} onChange={(value) => setEntry((current) => ({ ...current, projectId: value }))}
                options={[{ value: '', label: '— بدون —' }, ...projectOptions.map((item) => ({ value: String(item.id ?? item.projectId), label: item.name ?? item.projectName ?? `مشروع ${item.id ?? item.projectId}` }))]} />
            </Field>
          )}
          <Field label="سبب التسجيل" required hint="يُحفظ في سجل التدقيق مع القيم الجديدة.">
            <TextInput value={entry?.reason ?? ''} onChange={(value) => setEntry((current) => ({ ...current, reason: value }))} placeholder="سبب التسجيل" />
          </Field>
        </div>
      </Modal>
    </>
  );
}