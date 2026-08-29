import { useMemo, useState } from 'react';
import { formatMoney, parseAmount, toInputValue } from '@checkbudget/shared';
import { store } from '../data/store.js';
import { useApp, useCanEdit, useCategoryTree } from '../data/hooks.js';
import { Card, CardTitle, EmptyState, Button, Sheet, Field, ProgressBar, CategoryDot } from '../components/ui.js';
import { Icon } from '../components/Icon.js';
import { formatPeriod } from '../lib/dates.js';

/**
 * Лимиты на месяц по категориям расходов.
 *
 * Показываются три числа, которые человек реально держит в голове:
 * сколько потрачено, сколько осталось и укладывается ли он в темп.
 */
export function BudgetsScreen({ period }: { period: string }) {
  const app = useApp();
  const canEdit = useCanEdit();
  const roots = useCategoryTree('expense');
  const [editing, setEditing] = useState<{ categoryId: string; name: string; value: string } | null>(null);

  const data = app.data;
  const base = data?.budget.baseCurrency ?? 'RUB';
  const limits = useMemo(
    () => (data?.limits ?? []).filter((l) => l.period === period),
    [data?.limits, period],
  );
  const limitByCategory = useMemo(() => new Map(limits.map((l) => [l.categoryId, l])), [limits]);

  const totals = limits.reduce(
    (acc, l) => ({ limit: acc.limit + l.limitMinor, spent: acc.spent + l.spentMinor }),
    { limit: 0, spent: 0 },
  );

  const save = async () => {
    if (!editing) return;
    const minor = editing.value.trim() ? parseAmount(editing.value, base) : 0;
    await store.setLimit(editing.categoryId, period, minor);
    setEditing(null);
  };

  return (
    <div className="stack">
      <Card>
        <CardTitle>Лимиты на {formatPeriod(period).toLowerCase()}</CardTitle>
        {totals.limit === 0 ? (
          <EmptyState
            icon="target"
            title="Лимиты не установлены"
            text="Задайте месячный лимит на категорию — приложение предупредит при приближении к нему"
          />
        ) : (
          <>
            <div className="limit__nums" style={{ marginBottom: 8, fontSize: 14 }}>
              <span className="money">Потрачено {formatMoney(totals.spent, base)}</span>
              <span className="tnum tone-muted">
                {totals.spent > totals.limit
                  ? `превышение на ${formatMoney(totals.spent - totals.limit, base)}`
                  : `осталось ${formatMoney(totals.limit - totals.spent, base)}`}
              </span>
            </div>
            <ProgressBar
              value={(totals.spent / totals.limit) * 100}
              tone={totals.spent > totals.limit ? 'over' : totals.spent > totals.limit * 0.8 ? 'warn' : 'ok'}
            />
          </>
        )}
      </Card>

      <Card>
        <CardTitle>Категории расходов</CardTitle>
        {roots.map((category) => {
          const limit = limitByCategory.get(category.id);
          const pct = limit && limit.limitMinor > 0 ? (limit.spentMinor / limit.limitMinor) * 100 : 0;
          const tone = pct > 100 ? 'over' : pct > 80 ? 'warn' : 'ok';

          return (
            <div className="limit" key={category.id}>
              <div className="limit__top">
                <CategoryDot color={category.color} icon={category.icon} size={32} />
                <span className="limit__name">{category.name}</span>
                {canEdit && (
                  <Button
                    variant="ghost" size="sm"
                    onClick={() => setEditing({
                      categoryId: category.id,
                      name: category.name,
                      value: limit ? toInputValue(limit.limitMinor, base) : '',
                    })}
                  >
                    {limit ? 'Изменить' : 'Задать лимит'}
                  </Button>
                )}
              </div>

              {limit && (
                <>
                  <ProgressBar value={pct} tone={tone} />
                  <div className="limit__nums">
                    <span className="money">
                      {formatMoney(limit.spentMinor, base)} из {formatMoney(limit.limitMinor, base)}
                    </span>
                    <span className={`money ${tone === 'over' ? 'tone-expense' : tone === 'warn' ? '' : 'tone-muted'}`}>
                      {tone === 'over'
                        ? `превышен на ${formatMoney(limit.spentMinor - limit.limitMinor, base)}`
                        : `осталось ${formatMoney(limit.limitMinor - limit.spentMinor, base)}`}
                    </span>
                  </div>
                  {tone === 'warn' && (
                    <div className="banner banner--offline">
                      <Icon name="warning" size={15} /> Осталось меньше 20% лимита
                    </div>
                  )}
                  {tone === 'over' && (
                    <div className="banner banner--error">
                      <Icon name="warning" size={15} /> Лимит превышен
                    </div>
                  )}
                </>
              )}
            </div>
          );
        })}
      </Card>

      <Sheet
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={`Лимит: ${editing?.name ?? ''}`}
        footer={
          <>
            <Button variant="secondary" full onClick={() => setEditing(null)}>Отмена</Button>
            <Button variant="primary" full onClick={save}>Сохранить</Button>
          </>
        }
      >
        <Field
          label={`Лимит на ${formatPeriod(period).toLowerCase()}, ${base}`}
          hint="Пустое значение или 0 — снять лимит. Лимит на категорию учитывает и её подкатегории."
        >
          <input
            className="input" inputMode="decimal" autoFocus
            value={editing?.value ?? ''}
            onChange={(e) => setEditing((s) => s && { ...s, value: e.target.value.replace(/[^\d.,\s]/g, '') })}
            placeholder="30 000"
          />
        </Field>
      </Sheet>
    </div>
  );
}
