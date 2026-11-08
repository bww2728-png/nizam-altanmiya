import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, Check, Info, X } from 'lucide-react';
import { cx, fmtInt } from '../lib/format.js';

/**
 * Shared presentation primitives.
 *
 * Everything the pages need to look and move the same way lives here: cards,
 * metric tiles, bars, chips, empty states, modals, toasts and the field inputs.
 */

/* --------------------------------------------------------------------------
   Motion
   -------------------------------------------------------------------------- */

/** Staggered entrance. `i` is the position in the grid/list. */
export function Reveal({ i = 0, className = '', as: Tag = 'div', children, ...rest }) {
  return (
    <Tag className={cx('reveal', className)} style={{ '--i': i }} {...rest}>
      {children}
    </Tag>
  );
}

/**
 * Numbers count up on mount so a metric change is visible rather than silent.
 * Values that are not finite numbers render as-is.
 */
export function AnimatedNumber({ value, format = fmtInt, duration = 620 }) {
  const target = typeof value === 'number' && Number.isFinite(value) ? value : null;
  const [shown, setShown] = useState(target === null ? null : 0);
  const frame = useRef(0);

  useEffect(() => {
    if (target === null) return undefined;
    const started = performance.now();
    const from = 0;
    const step = (now) => {
      const progress = Math.min(1, (now - started) / duration);
      const eased = 1 - (1 - progress) ** 3;
      setShown(from + (target - from) * eased);
      if (progress < 1) frame.current = requestAnimationFrame(step);
    };
    frame.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame.current);
  }, [target, duration]);

  if (target === null) return <span>{format(value)}</span>;
  return <span>{format(shown)}</span>;
}

/* --------------------------------------------------------------------------
   Containers
   -------------------------------------------------------------------------- */

export function Card({ title, subtitle, icon: Icon, actions, children, className = '', bodyClass = '', flush = false }) {
  return (
    <section className={cx('card', className)}>
      {(title || actions) && (
        <header className="card-head">
          {Icon && <span className="metric-icon"><Icon size={18} /></span>}
          <div className="head-text">
            {title && <h2>{title}</h2>}
            {subtitle && <p>{subtitle}</p>}
          </div>
          {actions && <div className="head-actions">{actions}</div>}
        </header>
      )}
      <div className={cx('card-body', flush && 'flush', bodyClass)}>{children}</div>
    </section>
  );
}

export function Stat({ label, value, display, note, icon: Icon, tone = '', index = 0, format }) {
  return (
    <article className="metric lift reveal" style={{ '--i': index }}>
      {Icon && <span className={cx('metric-icon', tone)}><Icon size={18} /></span>}
      <span className="metric-label">{label}</span>
      <strong className="metric-value">
        {display !== undefined ? display : <AnimatedNumber value={value} format={format ?? fmtInt} />}
      </strong>
      {note && <span className="metric-note">{note}</span>}
    </article>
  );
}

export function MiniStat({ label, value }) {
  return (
    <div className="mini-stat">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

/* --------------------------------------------------------------------------
   Chips and bars
   -------------------------------------------------------------------------- */

export function Badge({ tone = '', children, className = '', icon: Icon }) {
  return (
    <span className={cx('chip', tone, className)}>
      {Icon && <Icon size={13} />}
      {children}
    </span>
  );
}

export function Bar({ value, max = 100, tone = '', height }) {
  const ratio = max > 0 ? Math.max(0, Math.min(1, (Number(value) || 0) / max)) : 0;
  return (
    <div className="bar" style={height ? { height } : undefined}>
      <div className={cx('bar-fill', tone)} style={{ width: `${ratio * 100}%` }} />
    </div>
  );
}

export function ProgressRow({ label, value, max, display }) {
  return (
    <div className="bar-row">
      <span>{label}</span>
      <Bar value={value} max={max} />
      <span className="bar-value">{display ?? fmtInt(value)}</span>
    </div>
  );
}

/* --------------------------------------------------------------------------
   States
   -------------------------------------------------------------------------- */

export function Empty({ icon: Icon, title, hint, action }) {
  return (
    <div className="empty">
      {Icon && <span className="empty-icon"><Icon size={26} /></span>}
      {title && <h3>{title}</h3>}
      {hint && <p>{hint}</p>}
      {action}
    </div>
  );
}

export function Loading({ label = 'جارٍ التحميل...' }) {
  return (
    <div className="loading-line">
      <span className="spinner" />
      <span>{label}</span>
    </div>
  );
}

export function Skeleton({ rows = 3, className = '' }) {
  return (
    <div className={cx('stack tight', className)}>
      {Array.from({ length: rows }).map((_, index) => (
        <div key={index} className="skeleton" style={{ height: 46 }} />
      ))}
    </div>
  );
}

export function ErrorBanner({ message, onDismiss }) {
  if (!message) return null;
  return (
    <div className="error-banner rise">
      <AlertTriangle size={18} />
      <span>{message}</span>
      {onDismiss && <button onClick={onDismiss} aria-label="إغلاق التنبيه"><X size={16} /></button>}
    </div>
  );
}

/* --------------------------------------------------------------------------
   Modal
   -------------------------------------------------------------------------- */

export function Modal({ open, title, subtitle, onClose, children, footer, wide = false }) {
  useEffect(() => {
    if (!open || !onClose) return undefined;
    const onKey = (event) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose?.(); }}>
      <div className={cx('modal-card', wide && 'wide')} role="dialog" aria-modal="true" aria-label={title}>
        <header className="modal-head">
          <div className="head-text">
            <h2>{title}</h2>
            {subtitle && <p className="muted" style={{ fontSize: '0.8rem' }}>{subtitle}</p>}
          </div>
          <button className="icon-button" onClick={onClose} aria-label="إغلاق"><X size={17} /></button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}

/* --------------------------------------------------------------------------
   Toasts
   -------------------------------------------------------------------------- */

const TOAST_ICON = { ok: Check, bad: AlertTriangle, warn: AlertTriangle, info: Info };

export function ToastStack({ toasts, onDismiss }) {
  return (
    <div className="toast-stack" role="status" aria-live="polite">
      {toasts.map((toast) => {
        const Icon = TOAST_ICON[toast.tone ?? 'info'] ?? Info;
        return (
          <div key={toast.id} className={cx('toast', toast.tone)}>
            <Icon size={17} />
            <span>{toast.message}</span>
            <button onClick={() => onDismiss(toast.id)} aria-label="إغلاق"><X size={15} /></button>
          </div>
        );
      })}
    </div>
  );
}

/* --------------------------------------------------------------------------
   Inputs
   -------------------------------------------------------------------------- */

export function Field({ label, hint, error, required, children, className = '' }) {
  return (
    <label className={cx('field', className)}>
      {label && (
        <span className="field-label">
          {label}
          {required && <span className="req" title="حقل إلزامي">*</span>}
        </span>
      )}
      {children}
      {hint && !error && <span className="field-hint">{hint}</span>}
      {error && <span className="field-error">{error}</span>}
    </label>
  );
}

export function TextInput({ value, onChange, placeholder, invalid, ...rest }) {
  return (
    <input
      className={cx('input', invalid && 'invalid')}
      value={value ?? ''}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
      {...rest}
    />
  );
}

export function NumberInput({ value, onChange, invalid, step = 'any', ...rest }) {
  return (
    <input
      className={cx('input', invalid && 'invalid')}
      type="number"
      inputMode="decimal"
      step={step}
      value={value ?? ''}
      onChange={(event) => onChange(event.target.value)}
      {...rest}
    />
  );
}

export function SelectInput({ value, onChange, options, ...rest }) {
  return (
    <select className="select" value={value ?? ''} onChange={(event) => onChange(event.target.value)} {...rest}>
      {options.map((option) => (
        <option key={option.value} value={option.value}>{option.label}</option>
      ))}
    </select>
  );
}

export function Segmented({ value, options, onChange }) {
  return (
    <div className="segmented" role="tablist">
      {options.map((option) => (
        <button
          key={option.value}
          role="tab"
          aria-selected={option.value === value}
          className={cx(option.value === value && 'active')}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Switch({ checked, onChange, label }) {
  return (
    <label className="switch">
      <input type="checkbox" checked={Boolean(checked)} onChange={(event) => onChange(event.target.checked)} />
      {label}
    </label>
  );
}
