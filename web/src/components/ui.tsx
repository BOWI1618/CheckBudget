import { useEffect, useRef, type ReactNode, type CSSProperties } from 'react';
import { Icon } from './Icon.js';

export function Card({
  children, className = '', style, padding = true,
}: { children: ReactNode; className?: string; style?: CSSProperties; padding?: boolean }) {
  return (
    <section className={`card ${padding ? 'card--pad' : ''} ${className}`} style={style}>
      {children}
    </section>
  );
}

export function CardTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <header className="card__head">
      <h2 className="card__title">{children}</h2>
      {action}
    </header>
  );
}

export function Button({
  children, onClick, variant = 'secondary', size = 'md', type = 'button',
  disabled, full, icon, title,
}: {
  children?: ReactNode;
  onClick?: () => void;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  type?: 'button' | 'submit';
  disabled?: boolean;
  full?: boolean;
  icon?: string;
  title?: string;
}) {
  return (
    <button
      type={type} onClick={onClick} disabled={disabled} title={title}
      className={`btn btn--${variant} btn--${size} ${full ? 'btn--full' : ''} ${!children ? 'btn--icon' : ''}`}
    >
      {icon && <Icon name={icon} size={size === 'sm' ? 16 : 18} />}
      {children}
    </button>
  );
}

export function Field({
  label, children, hint, error,
}: { label: string; children: ReactNode; hint?: string; error?: string }) {
  return (
    <label className="field">
      <span className="field__label">{label}</span>
      {children}
      {error ? <span className="field__error">{error}</span>
        : hint ? <span className="field__hint">{hint}</span> : null}
    </label>
  );
}

export function Segmented<T extends string>({
  value, onChange, options,
}: { value: T; onChange: (v: T) => void; options: Array<{ value: T; label: string; tone?: 'expense' | 'income' }> }) {
  return (
    <div className="segmented" role="tablist">
      {options.map((option) => (
        <button
          key={option.value} role="tab" aria-selected={value === option.value}
          className={`segmented__item ${value === option.value ? 'is-active' : ''} ${option.tone ? `tone-${option.tone}` : ''}`}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Модальное окно, которое на мобильном превращается в bottom sheet.
 *
 * Это не косметика: на телефоне диалог, «прилетающий» сверху, оказывается
 * вне зоны большого пальца, и до кнопок приходится тянуться двумя руками.
 */
export function Sheet({
  open, onClose, title, children, footer, wide,
}: {
  open: boolean; onClose: () => void; title: string;
  children: ReactNode; footer?: ReactNode; wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    ref.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="sheet__backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title}
        className={`sheet ${wide ? 'sheet--wide' : ''}`}
      >
        <header className="sheet__head">
          <div className="sheet__grip" aria-hidden="true" />
          <h2 className="sheet__title">{title}</h2>
          <button className="sheet__close" onClick={onClose} aria-label="Закрыть">
            <Icon name="x" size={20} />
          </button>
        </header>
        <div className="sheet__body">{children}</div>
        {footer && <footer className="sheet__foot">{footer}</footer>}
      </div>
    </div>
  );
}

export function EmptyState({
  icon, title, text, action,
}: { icon: string; title: string; text?: string; action?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty__icon"><Icon name={icon} size={26} /></div>
      <p className="empty__title">{title}</p>
      {text && <p className="empty__text">{text}</p>}
      {action}
    </div>
  );
}

export function Skeleton({ height = 16, width = '100%', radius = 8 }: { height?: number; width?: string | number; radius?: number }) {
  return <div className="skeleton" style={{ height, width, borderRadius: radius }} />;
}

export function CategoryDot({ color, icon, size = 36 }: { color: string; icon: string; size?: number }) {
  return (
    <span
      className="cat-dot"
      style={{ width: size, height: size, background: `color-mix(in srgb, ${color} 16%, transparent)`, color }}
    >
      <Icon name={icon} size={size * 0.52} />
    </span>
  );
}

export function ProgressBar({ value, tone }: { value: number; tone: 'ok' | 'warn' | 'over' }) {
  return (
    <div className={`progress progress--${tone}`}>
      <div className="progress__fill" style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
    </div>
  );
}
