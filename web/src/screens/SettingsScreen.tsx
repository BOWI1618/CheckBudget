import { useState } from 'react';
import { CURRENCIES } from '@checkbudget/shared';
import { store } from '../data/store.js';
import { useApp } from '../data/hooks.js';
import { Card, CardTitle, Button, Field, Sheet, Segmented } from '../components/ui.js';
import { Icon } from '../components/Icon.js';

export function SettingsScreen() {
  const app = useApp();
  const [newBudget, setNewBudget] = useState(false);
  const [budgetName, setBudgetName] = useState('');
  const [budgetCurrency, setBudgetCurrency] = useState('RUB');

  const settings = app.settings;
  const data = app.data;

  return (
    <div className="stack">
      <Card>
        <CardTitle>Аккаунт</CardTitle>
        <div className="list-row">
          <div className="list-row__body">
            <div className="list-row__title">{app.user?.displayName}</div>
            <div className="list-row__sub">{app.user?.email}</div>
          </div>
          <Button variant="ghost" icon="logout" onClick={() => store.logout()}>Выйти</Button>
        </div>
      </Card>

      <Card>
        <CardTitle>Бюджеты</CardTitle>
        {app.budgets.map((budget) => (
          <button key={budget.id} className="list-row" style={{ width: '100%', textAlign: 'left' }}
                  onClick={() => store.selectBudget(budget.id)}>
            <div className="list-row__body">
              <div className="list-row__title">{budget.name}</div>
              <div className="list-row__sub">
                {budget.baseCurrency} · {budget.role === 'owner' ? 'владелец'
                  : budget.role === 'editor' ? 'участник' : 'наблюдатель'}
              </div>
            </div>
            {budget.id === app.currentBudgetId
              ? <Icon name="check" size={18} className="tone-income" />
              : <Icon name="chevronRight" size={16} className="tone-muted" />}
          </button>
        ))}
        <Button variant="secondary" icon="plus" full onClick={() => setNewBudget(true)}>
          Создать бюджет
        </Button>
      </Card>

      <Card>
        <CardTitle>Валюта</CardTitle>
        <Field
          label="Базовая валюта нового бюджета"
          hint="Валюта, в которой считается вся аналитика. У каждого бюджета она своя."
        >
          <select
            className="select"
            value={settings?.baseCurrency ?? 'RUB'}
            onChange={(e) => store.updateSettings({ baseCurrency: e.target.value })}
          >
            {CURRENCIES.map((c) => (
              <option key={c.code} value={c.code}>{c.symbol} {c.code} — {c.nameRu}</option>
            ))}
          </select>
        </Field>

        {data && (
          <div className="banner banner--offline" style={{ marginTop: 12 }}>
            <Icon name="warning" size={16} />
            <span>
              Текущий бюджет «{data.budget.name}» ведётся в {data.budget.baseCurrency}.
              Смена базовой валюты существующего бюджета требует пересчёта всех операций
              по историческим курсам — это отдельная операция, а не переключатель.
            </span>
          </div>
        )}
      </Card>

      <Card>
        <CardTitle>Оформление</CardTitle>
        <Segmented
          value={settings?.theme ?? 'system'}
          onChange={(theme) => store.updateSettings({ theme })}
          options={[
            { value: 'system', label: 'Как в системе' },
            { value: 'light', label: 'Светлая' },
            { value: 'dark', label: 'Тёмная' },
          ]}
        />
      </Card>

      <Card>
        <CardTitle>Синхронизация</CardTitle>
        <div className="list-row">
          <div className="list-row__body">
            <div className="list-row__title">
              {app.connection === 'online' ? 'Подключено'
                : app.connection === 'connecting' ? 'Подключение…' : 'Нет соединения'}
            </div>
            <div className="list-row__sub">
              {app.queueSize > 0
                ? `${app.queueSize} изменен. ждут отправки`
                : 'Все изменения отправлены'}
            </div>
          </div>
          <span className="badge" style={{
            background: app.connection === 'online' ? 'var(--income-soft)' : 'var(--warning-soft)',
            color: app.connection === 'online' ? 'var(--income)' : 'var(--warning)',
          }}>
            seq {data?.seq ?? 0}
          </span>
        </div>
        {app.queueSize > 0 && (
          <Button variant="secondary" full onClick={() => store.flushQueue()}>Отправить сейчас</Button>
        )}
      </Card>

      <Sheet
        open={newBudget} onClose={() => setNewBudget(false)} title="Новый бюджет"
        footer={
          <>
            <Button variant="secondary" full onClick={() => setNewBudget(false)}>Отмена</Button>
            <Button variant="primary" full disabled={!budgetName.trim()}
                    onClick={async () => {
                      await store.createBudget(budgetName.trim(), budgetCurrency);
                      setNewBudget(false);
                      setBudgetName('');
                    }}>
              Создать
            </Button>
          </>
        }
      >
        <Field label="Название" hint="Например: «Семейный бюджет» или «Отпуск»">
          <input className="input" value={budgetName} autoFocus maxLength={80}
                 onChange={(e) => setBudgetName(e.target.value)} placeholder="Семейный бюджет" />
        </Field>
        <Field label="Базовая валюта" hint="Изменить её потом будет непросто — выберите основную валюту жизни">
          <select className="select" value={budgetCurrency} onChange={(e) => setBudgetCurrency(e.target.value)}>
            {CURRENCIES.map((c) => (
              <option key={c.code} value={c.code}>{c.symbol} {c.code} — {c.nameRu}</option>
            ))}
          </select>
        </Field>
      </Sheet>
    </div>
  );
}
