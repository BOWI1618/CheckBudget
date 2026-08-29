import { useEffect, useRef, useState, type ReactNode } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { store } from '../data/store.js';
import { useApp, useCanEdit } from '../data/hooks.js';
import { countOf } from '@checkbudget/shared';
import { Icon } from '../components/Icon.js';
import { Button } from '../components/ui.js';
import { formatPeriod, shiftPeriod, currentPeriod } from '../lib/dates.js';

/** Пять пунктов — предел для нижней навигации: дальше цели мельче пальца. */
const TABS = [
  { to: '/', icon: 'home2', label: 'Главная' },
  { to: '/transactions', icon: 'list', label: 'Операции' },
  { to: '/analytics', icon: 'chart', label: 'Аналитика' },
  { to: '/budgets', icon: 'target', label: 'Бюджеты' },
  { to: '/more', icon: 'dots', label: 'Ещё' },
];

/** На десктопе места хватает на все разделы сразу — «Ещё» не нужно. */
const SIDEBAR = [
  { to: '/', icon: 'home2', label: 'Главная' },
  { to: '/transactions', icon: 'list', label: 'Операции' },
  { to: '/analytics', icon: 'chart', label: 'Аналитика' },
  { to: '/budgets', icon: 'target', label: 'Бюджеты' },
  { to: '/accounts', icon: 'wallet', label: 'Счета' },
  { to: '/categories', icon: 'tag', label: 'Категории' },
  { to: '/members', icon: 'users', label: 'Участники' },
  { to: '/settings', icon: 'settings', label: 'Настройки' },
];

const PERIODLESS = ['/accounts', '/categories', '/members', '/settings', '/more'];

export function Layout({
  children, period, onPeriodChange, onAdd,
}: {
  children: ReactNode;
  period: string;
  onPeriodChange: (period: string) => void;
  onAdd: () => void;
}) {
  const app = useApp();
  const canEdit = useCanEdit();
  const location = useLocation();
  const navigate = useNavigate();
  const showPeriod = !PERIODLESS.includes(location.pathname);

  // Горячие клавиши десктопа: новая операция и поиск — то, что делается чаще всего.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') return;
      if (e.key === 'n' && canEdit) { e.preventDefault(); onAdd(); }
      if (e.key === '/') { e.preventDefault(); navigate('/transactions'); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onAdd, canEdit, navigate]);

  const title = SIDEBAR.find((s) => s.to === location.pathname)?.label ?? 'Ещё';

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="sidebar__brand">
          <Icon name="chart" size={22} />
          CheckBudget
        </div>

        <BudgetSwitcher />

        {SIDEBAR.map((item) => (
          <NavLink key={item.to} to={item.to} end={item.to === '/'}
                   className={({ isActive }) => `sidebar__item ${isActive ? 'is-active' : ''}`}>
            <Icon name={item.icon} size={18} />
            {item.label}
          </NavLink>
        ))}

        {canEdit && (
          <div style={{ padding: '12px 4px 0' }}>
            <Button variant="primary" icon="plus" full onClick={onAdd}>Добавить</Button>
          </div>
        )}

        <div className="sidebar__foot">
          <ConnectionBadge />
        </div>
      </aside>

      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <header className="topbar">
          {showPeriod ? (
            <div className="row" style={{ gap: 2 }}>
              <Button variant="ghost" size="sm" icon="chevronLeft" title="Предыдущий месяц"
                      onClick={() => onPeriodChange(shiftPeriod(period, -1))} />
              <button className="period-picker" onClick={() => onPeriodChange(currentPeriod())}
                      title="Вернуться к текущему месяцу">
                {formatPeriod(period)}
              </button>
              <Button variant="ghost" size="sm" icon="chevronRight" title="Следующий месяц"
                      disabled={period >= currentPeriod()}
                      onClick={() => onPeriodChange(shiftPeriod(period, 1))} />
            </div>
          ) : (
            <h1 className="topbar__title">{title}</h1>
          )}

          <div className="topbar__spacer" />
          <ConnectionBadge compact />
        </header>

        <main className="shell__main">
          {app.connection === 'offline' && (
            <div className="banner banner--offline" style={{ marginBottom: 12 }}>
              <Icon name="wifiOff" size={16} />
              Нет соединения.{app.queueSize > 0
                && ` ${countOf(app.queueSize, ['изменение', 'изменения', 'изменений'])} отправим при подключении.`}
            </div>
          )}
          {children}
        </main>
      </div>

      {canEdit && (
        <button className="fab" onClick={onAdd} aria-label="Добавить операцию">
          <Icon name="plus" size={26} strokeWidth={2.2} />
        </button>
      )}

      <nav className="tabbar">
        {TABS.map((tab) => (
          <NavLink key={tab.to} to={tab.to} end={tab.to === '/'}
                   className={({ isActive }) => `tabbar__item ${isActive ? 'is-active' : ''}`}>
            <Icon name={tab.icon} size={21} />
            {tab.label}
          </NavLink>
        ))}
      </nav>

      <Toasts />
    </div>
  );
}

/**
 * Переключатель бюджетов.
 *
 * Раньше на этом месте была кнопка с шевроном, которая вела в настройки —
 * то есть в то же место, что и пункт «Настройки» двумя строками ниже.
 * Шеврон обещает список, и теперь он его открывает: между личным
 * и семейным бюджетом переключаются отсюда, а не через отдельный экран.
 *
 * Если бюджет один, список не нужен — остаётся просто подпись.
 */
function BudgetSwitcher() {
  const app = useApp();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const current = app.budgets.find((b) => b.id === app.currentBudgetId);
  const name = current?.name ?? app.data?.budget.name ?? 'Бюджет';

  if (app.budgets.length < 2) {
    return (
      <div className="budget-current">
        <Icon name="wallet" size={17} />
        <span>{name}</span>
      </div>
    );
  }

  return (
    <div className="budget-switch" ref={ref}>
      <button
        className="budget-switch__button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        <Icon name="wallet" size={17} />
        <span className="budget-switch__name">{name}</span>
        <Icon name="chevronDown" size={14} />
      </button>

      {open && (
        <div className="budget-switch__menu" role="menu">
          {app.budgets.map((budget) => (
            <button
              key={budget.id}
              role="menuitem"
              className={`budget-switch__item ${budget.id === app.currentBudgetId ? 'is-current' : ''}`}
              onClick={() => {
                setOpen(false);
                if (budget.id !== app.currentBudgetId) void store.selectBudget(budget.id);
              }}
            >
              <span className="budget-switch__item-name">{budget.name}</span>
              <span className="budget-switch__item-role">
                {budget.role === 'owner' ? 'владелец'
                  : budget.role === 'editor' ? 'участник' : 'наблюдатель'}
              </span>
              {budget.id === app.currentBudgetId && <Icon name="check" size={15} />}
            </button>
          ))}
          <button
            role="menuitem"
            className="budget-switch__item budget-switch__item--muted"
            onClick={() => { setOpen(false); navigate('/settings'); }}
          >
            Создать бюджет
          </button>
        </div>
      )}
    </div>
  );
}

function ConnectionBadge({ compact }: { compact?: boolean }) {
  const app = useApp();
  if (app.connection === 'online' && app.queueSize === 0) {
    return compact ? null : (
      <span className="list-row__sub" style={{ padding: '0 8px' }}>
        <span style={{
          display: 'inline-block', width: 7, height: 7, borderRadius: '50%',
          background: 'var(--income)', marginRight: 7,
        }} />
        Синхронизировано
      </span>
    );
  }
  return (
    <span className="badge" style={{ background: 'var(--warning-soft)', color: 'var(--warning)' }}>
      {app.connection === 'connecting' ? 'подключение…'
        : app.queueSize > 0 ? `${app.queueSize} в очереди` : 'офлайн'}
    </span>
  );
}

function Toasts() {
  const app = useApp();
  if (app.toasts.length === 0) return null;
  return (
    <div className="toasts">
      {app.toasts.map((toast) => (
        <div key={toast.id} className={`toast toast--${toast.kind}`} onClick={() => store.dismissToast(toast.id)}>
          <Icon name={toast.kind === 'error' ? 'warning' : toast.kind === 'success' ? 'check' : 'sparkles'} size={16} />
          <span style={{ flex: 1 }}>{toast.text}</span>
        </div>
      ))}
    </div>
  );
}
