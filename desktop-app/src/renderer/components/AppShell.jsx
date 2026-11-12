import React from 'react';
import {
  Activity, Briefcase, ClipboardCheck, DatabaseZap, FileSearch, FileSpreadsheet, LayoutDashboard, ListOrdered,
  LogOut, PenLine, RefreshCw, RotateCcw, ShieldCheck, Users, Files, GitBranch, Target, Wallet,
} from 'lucide-react';
import { cx, fmtDate } from '../lib/format.js';
import ThemeToggle from './ThemeToggle.jsx';
import logoBadge from '../assets/logo-badge.png';

/**
 * Application shell: navigation, top bar and the page slot.
 *
 * The page slot is the only animated part of the shell. `App` keeps the leaving
 * page mounted for one frame pair so the exit animation can run (see
 * `usePageTransition` in App.jsx).
 */

export const NAV_GROUPS = [
  {
    caption: 'اللوحات',
    items: [
      { id: 'dashboard', label: 'اللوحة التفاعلية', icon: LayoutDashboard },
      { id: 'indicators', label: 'المؤشرات الـ 12', icon: Activity },
      { id: 'ranking', label: 'ترتيب الأولويات', icon: ListOrdered },
    ],
  },
  {
    caption: 'البيانات',
    items: [
      { id: 'import', label: 'الاستيراد الآلي', icon: FileSpreadsheet },
      { id: 'documents', label: 'مركز الوثائق والبحث', icon: FileSearch },
      { id: 'data-entry', label: 'الإدخال اليدوي المركزي', icon: PenLine },
      { id: 'projects', label: 'سجل المشاريع', icon: Briefcase },
      { id: 'observations', label: 'سجل قياسات المؤشرات', icon: Activity },
      { id: 'quality', label: 'جودة البيانات', icon: ClipboardCheck },
      { id: 'sources', label: 'مصادر البيانات', icon: Files },
      { id: 'correction', label: 'تصحيح البيانات', icon: PenLine },
      { id: 'database', label: 'قاعدة البيانات الشاملة', icon: DatabaseZap },
    ],
  },
  {
    caption: 'البيانات التنموية الموحدة',
    items: [
      { id: 'domain-records', label: 'سجلات البيانات الموحدة', icon: DatabaseZap },
      { id: 'development-analysis', label: 'التحليل التنموي', icon: Target },
      { id: 'planning', label: 'التخطيط والتنفيذ', icon: GitBranch },
      { id: 'finance', label: 'المالية والموازنة', icon: Wallet },
    ],
  },
  {
    caption: 'البطاقات',
    items: [
      { id: 'card', label: 'بطاقة مديرية', icon: Users },
    ],
  },
];

export const NAV_LABELS = Object.fromEntries(NAV_GROUPS.flatMap((group) => group.items.map((item) => [item.id, item.label])));

export default function AppShell({
  route, phase, onNavigate, children, profile, profileLabel, onToggleProfile,
  onLock, onBackup, onRestore, onRefresh, refreshing, generatedAt, counts = {}, theme, onToggleTheme,
}) {
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-lockup">
          <img src={logoBadge} alt="" />
          <div>
            <strong>التنمية المحلية</strong>
            <span>مركز إدارة البيانات</span>
          </div>
        </div>

        <div className="workspace-card">
          <span className="status-dot" />
          <div>
            <strong>قاعدة بيانات SQLite محلية</strong>
            <small>البيانات على هذا الجهاز في ملف غير مشفّر</small>
          </div>
        </div>

        <nav className="side-nav" aria-label="التنقل الرئيسي">
          {NAV_GROUPS.map((group) => (
            <React.Fragment key={group.caption}>
              <p className="nav-caption">{group.caption}</p>
              {group.items.map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  className={cx('nav-item', route === id && 'active')}
                  onClick={() => onNavigate(id)}
                  aria-current={route === id ? 'page' : undefined}
                >
                  <Icon size={18} />
                  <span>{label}</span>
                  {counts[id] ? <span className="nav-badge">{counts[id]}</span> : null}
                </button>
              ))}
            </React.Fragment>
          ))}
        </nav>

        <div className="sidebar-bottom">
          <ThemeToggle theme={theme} onToggle={onToggleTheme} />
          <button className="nav-item lock-action" onClick={onLock}>
            <LogOut size={18} />
            <span>قفل قاعدة البيانات</span>
          </button>
          <div className="sidebar-footer">نظام داخلي · معالجة محلية بلا اتصال</div>
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <div className="breadcrumbs">
            <span>نظام التنمية المحلية</span>
            <span className="crumb-divider">/</span>
            <strong>{NAV_LABELS[route] ?? '—'}</strong>
          </div>
          <div className="topbar-actions">
            <span className="muted" style={{ fontSize: '0.76rem' }}>
              آخر تحديث {fmtDate(generatedAt)}
            </span>
            <button
              className={cx('chip', 'clickable', profile === 'shared' && 'warn')}
              onClick={onToggleProfile}
              title="وضع مالك الجهاز يرى كل الحقول، ووضع المشاركة يحجب الحقول المقيّدة والحساسة في العرض والتصدير."
            >
              <ShieldCheck size={14} />
              {profileLabel ?? profile}
            </button>
            {profile !== 'shared' && (
              <>
                <button className="icon-button" onClick={onBackup} title="إنشاء نسخة احتياطية الآن" aria-label="إنشاء نسخة احتياطية الآن">
                  <DatabaseZap size={17} />
                </button>
                <button className="icon-button" onClick={onRestore} title="استعادة نسخة احتياطية" aria-label="استعادة نسخة احتياطية">
                  <RotateCcw size={17} />
                </button>
              </>
            )}
            <button
              className={cx('icon-button', refreshing && 'spin')}
              onClick={onRefresh}
              title="تحديث الأرقام من قاعدة البيانات"
            >
              <RefreshCw size={17} />
            </button>
            <span className="chip"><DatabaseZap size={13} /> محلي · SQLite بلا تشفير</span>
            <span className="chip gold">م</span>
          </div>
        </header>

        <div key={route} className={cx('page-content', phase === 'exit' ? 'page-exit' : 'page-enter')}>
          {children}
        </div>
      </main>
    </div>
  );
}
