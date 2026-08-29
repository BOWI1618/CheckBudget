import { useEffect, useRef, useState, type ReactNode } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { store } from '../data/store.js';
import { useApp, useCanEdit } from '../data/hooks.js';
import { countOf } from '@checkbudget/shared';
import { Icon } from '../components/Icon.js';
import { Button } from '../components/ui.js';
import { formatPeriod, shiftPeriod, currentPeriod } from '../lib/dates.js';

/**
 * Нижняя навигация: четыре раздела и ввод расхода посередине.
 *
 * Кнопка ввода стоит В РЯДУ, а не висит над ним: плавающая кнопка
 * закрывала собой последнюю строку списка операций.
 */
const TABS = [
  { to: '/', icon: 'home2', label: 'Сводка' },
  { to: '/transactions', icon: 'list', label: 'Операции' },
  { to: '/analytics', icon: 'chart', label: 'Отчёты' },
  { to: '/more', icon: 'dots', label: 'Ещё' },
];

/** На десктопе разделы — таблетки в шапке. Остальное живёт в «Ещё». */
const TOPNAV = [
  { to: '/', label: 'Сводка' },
  { to: '/transactions', label: 'Операции' },
  { to: '/analytics', label: 'Аналитика' },
  { to: '/budgets', label: 'Лимиты' },
  { to: '/accounts', label: 'Счета' },
  { to: '/more', label: 'Ещё' },
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

  return (
    <div className="shell">
      <div className="board">
        <header className="topnav">
          <span className="topnav__brand">
            <span className="topnav__mark"><Icon name="chart" size={20} /></span>
            CheckBudget
          </span>

          <nav className="topnav__nav">
            {TOPNAV.map((item) => (
              <NavLink key={item.to} to={item.to} end={item.to === '/'}
                       className={({ isActive }) => `topnav__item ${isActive ? 'is-active' : ''}`}>
                {item.label}
              </NavLink>
            ))}
          </nav>

          <div className="topnav__spacer" />

          {showPeriod && (
            <div className="period">
              <button className="period__arrow" title="Предыдущий месяц"
                      onClick={() => onPeriodChange(shiftPeriod(period, -1))}>
                <Icon name="chevronLeft" size={16} />
              </button>
              <button className="period__label" onClick={() => onPeriodChange(currentPeriod())}
                      title="Вернуться к текущему месяцу">
                {formatPeriod(period)}
              </button>
              <button className="period__arrow" title="Следующий месяц"
                      disabled={period >= currentPeriod()}
                      onClick={() => onPeriodChange(shiftPeriod(period, 1))}>
                <Icon name="chevronRight" size={16} />
              </button>
            </div>
          )}

          <BudgetSwitcher />
          <ConnectionBadge />

          {canEdit && (
            <span className="topnav__add">
              <Button variant="primary" icon="plus" onClick={onAdd}>Добавить</Button>
            </span>
          )}
        </header>

        <main className="board__main">
          {app.connection === 'offline' && (
            <div className="banner banner--offline">
              <Icon name="wifiOff" size={16} />
              Нет соединения.{app.queueSize > 0
                && ` ${countOf(app.queueSize, ['изменение', 'изменения', 'изменений'])} отправим при подключении.`}
            </div>
          )}
          {children}
        </main>
      </div>

      <nav className="tabbar">
        {TABS.slice(0, 2).map((tab) => (
          <NavLink key={tab.to} to={tab.to} end={tab.to === '/'}
                   className={({ isActive }) => `tabbar__item ${isActive ? 'is-active' : ''}`}>
            <Icon name={tab.icon} size={20} />
            {tab.label}
          </NavLink>
        ))}

        {canEdit && (
          <button className="tabbar__add" onClick={onAdd} aria-label="Добавить операцию">
            <Icon name="plus" size={24} strokeWidth={2.2} />
          </button>
        )}

        {TABS.slice(2).map((tab) => (
          <NavLink key={tab.to} to={tab.to} end={tab.to === '/'}
                   className={({ isActive }) => `tabbar__item ${isActive ? 'is-active' : ''}`}>
            <Icon name={tab.icon} size={20} />
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

  // Плашка называет не только бюджет, но и его состав: в семейном бюджете
  // важнее знать, чьи это деньги, чем как бюджет назван.
  const who = (app.data?.members ?? []).map((m) => m.displayName).join(' и ');

  if (app.budgets.length < 2) {
    return (
      <span className="who">
        <span className="who__dot" />
        {who || name}
      </span>
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
        <span className="who__dot" />
        <span className="budget-switch__name">{who || name}</span>
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

function ConnectionBadge() {
  const app = useApp();
  // Пока всё синхронизировано, сообщать не о чем: значок появляется только
  // когда есть о чём предупредить.
  if (app.connection === 'online' && app.queueSize === 0) return null;
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
