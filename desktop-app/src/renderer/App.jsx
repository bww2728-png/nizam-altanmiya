import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import AppShell from './components/AppShell.jsx';
import { ErrorBanner, Loading, ToastStack } from './components/ui.jsx';
import Dashboard from './pages/Dashboard.jsx';
import ImportPage from './pages/Import.jsx';
import Correction from './pages/Correction.jsx';
import Indicators from './pages/Indicators.jsx';
import Ranking from './pages/Ranking.jsx';
import Database from './pages/Database.jsx';
import DirectorateCard from './pages/DirectorateCard.jsx';
import Welcome from './pages/Welcome.jsx';
import { errText } from './lib/format.js';

/**
 * Application root.
 *
 * Owns the session state (unlocked store, access profile, field catalogue), the
 * route, the toast queue and the page transition. Pages are stateless with
 * respect to navigation: they receive callbacks, never a router.
 */

const PAGES_NEEDING_CATALOGUE = new Set(['correction', 'database', 'ranking', 'card']);

export default function App() {
  const [status, setStatus] = useState(null);
  const [ready, setReady] = useState(false);
  const [catalogue, setCatalogue] = useState(null);
  const [bootError, setBootError] = useState('');
  const [route, setRoute] = useState('dashboard');
  const [view, setView] = useState({ route: 'dashboard', phase: 'enter', next: null, params: {} });
  const [params, setParams] = useState({});
  const [refreshKey, setRefreshKey] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [toasts, setToasts] = useState([]);
  const toastId = useRef(0);

  /* --------------------------------------------------------------- toasts */

  const notify = useCallback((input) => {
    const message = typeof input === 'string' ? input : input?.message;
    if (!message) return;
    const tone = typeof input === 'string' ? 'info' : input.tone ?? 'info';
    toastId.current += 1;
    const id = toastId.current;
    setToasts((current) => [...current, { id, message, tone }]);
    setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), 5200);
  }, []);

  const dismissToast = useCallback((id) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  /* ---------------------------------------------------------------- session */

  const loadCatalogue = useCallback(async () => {
    try {
      setCatalogue(await window.localApp.fieldCatalogue());
    } catch (cause) {
      notify({ tone: 'bad', message: errText(cause) || 'تعذر تحميل جدول الحقول.' });
    }
  }, [notify]);

  useEffect(() => {
    window.localApp.status()
      .then((value) => {
        setStatus(value);
        if (value.unlocked) return loadCatalogue();
        return null;
      })
      .catch((cause) => setBootError(errText(cause) || 'تعذر فحص قاعدة البيانات المحلية.'))
      .finally(() => setReady(true));
  }, [loadCatalogue]);

  const onOpened = useCallback(async () => {
    try {
      const next = await window.localApp.status();
      setStatus(next);
      await loadCatalogue();
      setRefreshKey((key) => key + 1);
    } catch (cause) {
      notify({ tone: 'bad', message: errText(cause) || 'تعذر تحديث حالة الجلسة.' });
    }
  }, [loadCatalogue, notify]);

  const lock = useCallback(async () => {
    try {
      await window.localApp.lock();
      setStatus((current) => ({ ...current, unlocked: false }));
      setCatalogue(null);
      setToasts([]);
    } catch (cause) {
      notify({ tone: 'bad', message: errText(cause) || 'تعذر قفل قاعدة البيانات.' });
    }
  }, [notify]);

  const backup = useCallback(async () => {
    try {
      const result = await window.localApp.backupDatabase();
      notify({ tone: 'ok', message: `أُنشئت نسخة احتياطية (${result.backups ?? 1} نسخة في المجلد).` });
    } catch (cause) {
      notify({ tone: 'bad', message: errText(cause) || 'تعذر إنشاء النسخة الاحتياطية.' });
    }
  }, [notify]);

  const toggleProfile = useCallback(async () => {
    try {
      const currentProfile = status?.accessProfile ?? 'owner';
      const next = currentProfile === 'shared' ? 'owner' : 'shared';
      const result = await window.localApp.setAccessProfile({ profile: next });
      setStatus((current) => ({ ...current, accessProfile: result.profile, accessProfileLabel: result.label }));
      notify({
        tone: result.profile === 'shared' ? 'warn' : 'ok',
        message: result.profile === 'shared'
          ? 'وضع المشاركة مفعّل: الحقول المقيّدة والحساسة محجوبة في العرض والتصدير.'
          : 'وضع مالك الجهاز مفعّل: كل الحقول مرئية.',
      });
      setRefreshKey((key) => key + 1);
    } catch (cause) {
      notify({ tone: 'bad', message: errText(cause) || 'تعذر تغيير وضع الوصول.' });
    }
  }, [status, notify]);

  const refresh = useCallback(() => {
    setRefreshing(true);
    setRefreshKey((key) => key + 1);
    setTimeout(() => setRefreshing(false), 700);
  }, []);

  /* --------------------------------------------------------- page transition */

  const navigate = useCallback((nextRoute, nextParams = {}) => {
    setView((current) => {
      if (current.route === nextRoute && current.phase !== 'exit') return current;
      return { route: current.route, phase: 'exit', next: nextRoute, params: nextParams };
    });
  }, []);

  useEffect(() => {
    if (view.phase !== 'exit') return undefined;
    const timer = setTimeout(() => {
      setRoute(view.next);
      setParams(view.params ?? {});
      setView({ route: view.next, phase: 'enter', next: null, params: {} });
      // A new page starts at the top, like a real document.
      window.scrollTo({ top: 0, behavior: 'auto' });
    }, 200);
    return () => clearTimeout(timer);
  }, [view]);

  /* ------------------------------------------------------------------ render */

  const generatedAt = useMemo(() => new Date().toISOString(), [refreshKey]);

  if (!ready) {
    return (
      <main className="welcome-screen">
        <section className="welcome-card">
          <div className="welcome-loading">
            <span className="spinner" />
            <h1>نظام التنمية المحلية</h1>
            <p className="muted">جارٍ فحص قاعدة البيانات المحلية...</p>
          </div>
        </section>
      </main>
    );
  }

  if (!status?.unlocked) {
    return (
      <>
        {bootError && <div style={{ position: 'fixed', insetBlockStart: 16, insetInline: 16, zIndex: 200 }}><ErrorBanner message={bootError} onDismiss={() => setBootError('')} /></div>}
        <Welcome status={status} onOpened={onOpened} />
        <ToastStack toasts={toasts} onDismiss={dismissToast} />
      </>
    );
  }

  const needsCatalogue = PAGES_NEEDING_CATALOGUE.has(route);
  const catalogueReady = Array.isArray(catalogue) && catalogue.length > 0;

  return (
    <>
      <AppShell
        route={route}
        phase={view.phase}
        onNavigate={navigate}
        profile={status.accessProfile}
        profileLabel={status.accessProfileLabel}
        onToggleProfile={toggleProfile}
        onLock={lock}
        onBackup={backup}
        onRefresh={refresh}
        refreshing={refreshing}
        generatedAt={generatedAt}
      >
        {needsCatalogue && !catalogueReady ? <CardishLoading /> : renderPage()}
      </AppShell>
      <ToastStack toasts={toasts} onDismiss={dismissToast} />
    </>
  );

  function renderPage() {
    switch (route) {
      case 'import':
        return <ImportPage onNavigate={navigate} notify={notify} onApplied={refresh} />;
      case 'correction':
        return <Correction catalogue={catalogue ?? []} notify={notify} refreshKey={refreshKey} focusId={params.focusId ?? null} />;
      case 'indicators':
        return <Indicators notify={notify} />;
      case 'ranking':
        return <Ranking catalogue={catalogue ?? []} notify={notify} onOpenCard={(id) => navigate('card', { id })} />;
      case 'database':
        return <Database catalogue={catalogue ?? []} notify={notify} refreshKey={refreshKey} onOpenCard={(id) => navigate('card', { id })} />;
      case 'card':
        return <DirectorateCard id={params.id ?? null} catalogue={catalogue ?? []} notify={notify} refreshKey={refreshKey} onNavigate={navigate} />;
      case 'dashboard':
      default:
        return <Dashboard onNavigate={navigate} refreshKey={refreshKey} />;
    }
  }
}

function CardishLoading() {
  return (
    <section className="card padded">
      <Loading label="جارٍ تحميل جدول الحقول..." />
    </section>
  );
}