import React from 'react';
import {
  Activity, Briefcase, ClipboardCheck, DatabaseZap, FileSpreadsheet, LayoutDashboard, ListOrdered,
  LockKeyhole, LogOut, PenLine, RefreshCw, RotateCcw, ShieldCheck, Users,
} from 'lucide-react';
import { cx, fmtDate } from '../lib/format.js';
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
      { id: 'projects', label: 'سجل المشاريع', icon: Briefcase },
      { id: 'observations', label: 'سجل قياسات المؤشرات', icon: Activity },
      { id: 'quality', label: 'جودة البيانات', icon: ClipboardCheck },
      { id: 'correction', label: 'تصحيح البيانات', icon: PenLine },
      { id: 'database', label: 'قاعدة البيانات الشاملة', icon: DatabaseZap },
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
  onLock, onBackup, onRestore, onRefresh, refreshing, generatedAt, counts = {},
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
            <strong>قاعدة محلية مشفّرة</strong>
            <small>البيانات على هذا الجهاز فقط</small>
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
            <span className="chip"><LockKeyhole size={13} /> محلي ومشفّر</span>
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
