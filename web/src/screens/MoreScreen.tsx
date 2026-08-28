import { Link } from 'react-router-dom';
import { Card, CardTitle } from '../components/ui.js';
import { Icon } from '../components/Icon.js';
import { useApp } from '../data/hooks.js';

/** Экран «Ещё» существует только на мобильном: на десктопе всё это в сайдбаре. */
const LINKS = [
  { to: '/accounts', icon: 'wallet', label: 'Счета и кошельки', hint: 'Карты, наличные, накопления' },
  { to: '/categories', icon: 'tag', label: 'Категории', hint: 'Расходы и доходы, вложенность' },
  { to: '/members', icon: 'users', label: 'Участники', hint: 'Совместный бюджет и права' },
  { to: '/settings', icon: 'settings', label: 'Настройки', hint: 'Валюта, тема, аккаунт' },
];

export function MoreScreen() {
  const app = useApp();
  return (
    <div className="stack">
      <Card>
        <CardTitle>Бюджет</CardTitle>
        <div className="list-row">
          <div className="list-row__body">
            <div className="list-row__title">{app.data?.budget.name}</div>
            <div className="list-row__sub">
              {app.data?.budget.baseCurrency} · {app.data?.members.length ?? 1} участн.
            </div>
          </div>
        </div>
      </Card>

      <Card>
        {LINKS.map((link) => (
          <Link key={link.to} to={link.to} className="list-row">
            <div className="cat-dot" style={{ width: 38, height: 38, background: 'var(--surface-2)' }}>
              <Icon name={link.icon} size={19} />
            </div>
            <div className="list-row__body">
              <div className="list-row__title">{link.label}</div>
              <div className="list-row__sub">{link.hint}</div>
            </div>
            <Icon name="chevronRight" size={16} className="tone-muted" />
          </Link>
        ))}
      </Card>
    </div>
  );
}
