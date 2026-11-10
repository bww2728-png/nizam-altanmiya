import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Download, RefreshCw, X } from 'lucide-react';
import AppShell from './components/AppShell.jsx';
import ThemeToggle from './components/ThemeToggle.jsx';
import { ErrorBanner, Loading, ToastStack } from './components/ui.jsx';
import Dashboard from './pages/Dashboard.jsx';
import ImportPage from './pages/Import.jsx';
import DocumentCenter from './pages/DocumentCenter.jsx';
import DataEntry from './pages/DataEntry.jsx';
import Projects from './pages/Projects.jsx';
import IndicatorObservations from './pages/IndicatorObservations.jsx';
import DataQuality from './pages/DataQuality.jsx';
import DataSources from './pages/DataSources.jsx';
import Correction from './pages/Correction.jsx';
import Indicators from './pages/Indicators.jsx';
import Ranking from './pages/Ranking.jsx';
import Database from './pages/Database.jsx';
import DirectorateCard from './pages/DirectorateCard.jsx';
import Welcome from './pages/Welcome.jsx';
import { cx, errText } from './lib/format.js';

/**
 * Application root.
 *
 * Owns the session state (unlocked store, access profile, field catalogue), the
 * route, the toast queue and the page transition. Pages are stateless with
 * respect to navigation: they receive callbacks, never a router.
 */

const PAGES_NEEDING_CATALOGUE = new Set(['correction', 'database', 'ranking', 'card']);

/** Auto-update states that deserve a banner; idle/checking/not-available stay silent. */
const UPDATE_BANNER_STATES = new Set(['available', 'downloading', 'downloaded', 'error']);

/** Whole percent, clamped, or null when the main process has not reported one. */
function updatePercent(value) {
  const numeric = Number(value);
  if (value === null || value === undefined || !Number.isFinite(numeric)) return null;
  return Math.min(100, Math.max(0, Math.round(numeric)));
}

export default function App() {
  const [status, setStatus] = useState(null);
  const [ready, setReady] = useState(false);
  const [catalogue, setCatalogue] = useState(null);
  const [bootError, setBootError] = useState('');
  const [route, setRoute] = useState('dashboard');
  const [view, setView] = useState({ route: 'dashboard', phase: 'enter', next: null, params: {} });
  const [theme, setTheme] = useState(() => {
    try {
      return window.localStorage.getItem('ldi-theme') === 'light' ? 'light' : 'dark';
    } catch {
      return 'dark';
    }
  });
  const [params, setParams] = useState({});
  const [refreshKey, setRefreshKey] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [toasts, setToasts] = useState([]);
  const [updateStatus, setUpdateStatus] = useState(null);
  const [dismissedUpdateError, setDismissedUpdateError] = useState(null);
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

  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      window.localStorage.setItem('ldi-theme', theme);
    } catch {
      return;
    }
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme((current) => current === 'dark' ? 'light' : 'dark');
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

  /* ------------------------------------------------------- auto-update feed */

  useEffect(() => {
    let active = true;
    const bridge = window.localApp;
    const apply = (value) => {
      if (active && value && typeof value === 'object') setUpdateStatus(value);
    };

    // The bridge is optional: the renderer also runs in a plain browser during dev.
    // Subscribe before the first fetch so a status pushed during that await is
    // not overwritten by the older snapshot.
    const unsubscribe = bridge?.onUpdateStatus?.(apply);
    try {
      bridge?.updateStatus?.()?.then?.(apply)?.catch?.(() => {});
    } catch (cause) {
      void cause;
    }
    return () => {
      active = false;
      if (typeof unsubscribe === 'function') unsubscribe();
    };
  }, []);

  // A dismissed error stays dismissed until the flow moves on to another state.
  useEffect(() => {
    if (updateStatus?.state !== 'error') setDismissedUpdateError(null);
  }, [updateStatus?.state]);

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

  const restore = useCallback(async () => {
    const confirmed = window.confirm('ستُستبدل قاعدة البيانات الحالية بالنسخة المختارة. سيُنشئ النظام نسخة أمان من البيانات الحالية أولًا. هل تريد المتابعة؟');
    if (!confirmed) return;
    try {
      const result = await window.localApp.restoreDatabase();
      if (result?.canceled) return;
      setStatus((current) => ({ ...current, unlocked: true, hasDatabase: true, hasKey: true }));
      setCatalogue(null);
      setRefreshKey((key) => key + 1);
      await loadCatalogue();
      notify({ tone: 'ok', message: 'تمت استعادة النسخة الاحتياطية والتحقق من قاعدة البيانات. نسخة الأمان: ' + (result.safetyBackup ?? 'غير مطلوبة') });
    } catch (cause) {
      notify({ tone: 'bad', message: errText(cause) || 'تعذرت استعادة النسخة الاحتياطية؛ لم يُفترض فقد البيانات الحالية.' });
      try {
        const next = await window.localApp.status();
        setStatus(next);
        if (next.unlocked) await loadCatalogue();
      } catch { /* keep the original restore error visible */ }
    }
  }, [loadCatalogue, notify]);

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
  const updateErrorKey = updateStatus?.state === 'error' ? updateStatus.message ?? '' : null;
  const showUpdateBanner = UPDATE_BANNER_STATES.has(updateStatus?.state)
    && updateErrorKey !== dismissedUpdateError;

  return (
    <>
      {showUpdateBanner && (
        <UpdateBanner
          status={updateStatus}
          onDismiss={updateStatus?.state === 'error' ? () => setDismissedUpdateError(updateErrorKey) : undefined}
        />
      )}
      <AppShell
        route={route}
        phase={view.phase}
        onNavigate={navigate}
        theme={theme}
        onToggleTheme={toggleTheme}
        profile={status.accessProfile}
        profileLabel={status.accessProfileLabel}
        onToggleProfile={toggleProfile}
        onLock={lock}
        onBackup={backup}
        onRestore={restore}
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
      case 'projects':
        return <Projects notify={notify} refreshKey={refreshKey} />;
      case 'observations':
        return <IndicatorObservations notify={notify} />;
      case 'quality':
        return <DataQuality notify={notify} />;
      case 'sources':
        return <DataSources refreshKey={refreshKey} />;
      case 'import':
        return <ImportPage onNavigate={navigate} notify={notify} onApplied={refresh} />;
      case 'documents':
        return <DocumentCenter notify={notify} accessProfile={status?.accessProfile ?? 'owner'} />;
      case 'data-entry':
        return <DataEntry notify={notify} refreshKey={refreshKey} />;
      case 'correction':
        return <Correction catalogue={catalogue ?? []} notify={notify} refreshKey={refreshKey} focusId={params.focusId ?? null} />;
      case 'indicators':
        return <Indicators accessProfile={status?.accessProfile ?? 'owner'} notify={notify} refreshKey={refreshKey} />;
      case 'ranking':
        return <Ranking catalogue={catalogue ?? []} notify={notify} onOpenCard={(id) => navigate('card', { id })} />;
      case 'database':
        return <Database catalogue={catalogue ?? []} accessProfile={status?.accessProfile ?? 'owner'} notify={notify} refreshKey={refreshKey} onOpenCard={(id) => navigate('card', { id })} />;
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

/**
 * Slim status strip for the automatic updater (GitHub Releases).
 *
 * It only renders for the four states the user must see; the icon and tone are
 * derived from the state so a single component covers download, ready and
 * failure. The restart control asks the main process to install and quit.
 */
function UpdateBanner({ status, onDismiss }) {
  const state = status?.state;
  const version = status?.version ? `v${status.version}` : '';
  const percent = updatePercent(status?.percent);

  let tone = 'info';
  let message = 'يتوفر تحديث جديد.';
  if (state === 'available') {
    message = version
      ? `يتوفر إصدار جديد (${version}) — جارٍ التنزيل تلقائيًا...`
      : 'يتوفر إصدار جديد — جارٍ التنزيل تلقائيًا...';
  } else if (state === 'downloading') {
    message = percent === null
      ? 'جارٍ تنزيل التحديث...'
      : `جارٍ تنزيل التحديث... ${percent}%`;
  } else if (state === 'downloaded') {
    tone = 'ok';
    message = version
      ? `اكتمل تنزيل الإصدار ${version} —`
      : 'اكتمل تنزيل التحديث —';
  } else if (state === 'error') {
    tone = 'bad';
    const cause = status?.message ?? 'خطأ غير معروف';
    // The same state also reports a failed install, where the build is already on
    // disk and nothing needs to be fetched again.
    message = status?.phase === 'downloaded'
      ? `تعذّر تشغيل مثبّت التحديث: ${cause}`
      : `تعذّر التحقق من التحديث: ${cause}`;
  }

  const install = () => {
    try {
      Promise.resolve(window.localApp?.installUpdate?.()).catch(() => {});
    } catch (cause) {
      void cause;
    }
  };

  const icon = state === 'error'
    ? <AlertTriangle size={16} />
    : state === 'downloaded'
      ? <RefreshCw size={16} />
      : <Download size={16} />;

  return (
    <div className={cx('update-banner', tone)} role="status">
      <span className="update-banner-icon" aria-hidden="true">{icon}</span>
      <span className="update-banner-text">{message}</span>
      {state === 'downloaded' && (
        <button type="button" className="update-banner-action" onClick={install}>
          <RefreshCw size={14} aria-hidden="true" />
          إعادة التشغيل والتحديث
        </button>
      )}
      {state === 'error' && typeof onDismiss === 'function' && (
        <button type="button" className="update-banner-close" onClick={onDismiss} aria-label="إغلاق">
          <X size={16} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}