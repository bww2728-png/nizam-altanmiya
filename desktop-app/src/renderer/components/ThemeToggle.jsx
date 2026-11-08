import React from 'react';
import { Moon, Sun } from 'lucide-react';

export default function ThemeToggle({ theme, onToggle }) {
  const isLight = theme === 'light';
  const label = isLight ? 'الوضع الليلي' : 'الوضع النهاري';
  const Icon = isLight ? Moon : Sun;

  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={onToggle}
      aria-label={`التبديل إلى ${label}`}
      aria-pressed={isLight}
      title={`التبديل إلى ${label}`}
    >
      <Icon size={16} aria-hidden="true" />
      <span>{label}</span>
    </button>
  );
}
