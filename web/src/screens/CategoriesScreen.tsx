import { useEffect, useState } from 'react';
import type { Category } from '@checkbudget/shared';
import { store } from '../data/store.js';
import { useCanEdit, useCategoryTree } from '../data/hooks.js';
import { Card, CardTitle, Button, Sheet, Field, Segmented, CategoryDot } from '../components/ui.js';
import { Icon, ICON_NAMES } from '../components/Icon.js';

const PALETTE = [
  '#e5484d', '#f76b15', '#f5a524', '#22c55e', '#12a594',
  '#06b6d4', '#3b82f6', '#6366f1', '#8b5cf6', '#ec4899', '#64748b',
];

type Kind = 'expense' | 'income';
type Editing = { mode: 'new'; parentId: string | null } | { mode: 'edit'; category: Category };

/**
 * Два уровня вложенности: «Еда → Продукты».
 * Третий уровень усложняет выбор при вводе операции сильнее, чем помогает
 * при анализе, поэтому сознательно не поддержан.
 */
export function CategoriesScreen() {
  const [kind, setKind] = useState<Kind>('expense');
  const tree = useCategoryTree(kind);
  const canEdit = useCanEdit();
  const [editing, setEditing] = useState<Editing | null>(null);

  return (
    <div className="stack">
      <Segmented<Kind>
        value={kind} onChange={setKind}
        options={[
          { value: 'expense', label: 'Расходы', tone: 'expense' },
          { value: 'income', label: 'Доходы', tone: 'income' },
        ]}
      />

      {tree.map((root) => (
        <Card key={root.id}>
          <CardTitle
            action={canEdit ? (
              <div className="row" style={{ gap: 4 }}>
                <Button variant="ghost" size="sm" icon="plus"
                        onClick={() => setEditing({ mode: 'new', parentId: root.id })}>
                  Подкатегория
                </Button>
                <Button variant="ghost" size="sm" icon="edit" title="Изменить"
                        onClick={() => setEditing({ mode: 'edit', category: root })} />
              </div>
            ) : undefined}
          >
            <span className="row" style={{ gap: 10 }}>
              <CategoryDot color={root.color} icon={root.icon} size={30} />
              <span style={{ color: 'var(--text)', fontSize: 15, fontWeight: 600 }}>{root.name}</span>
            </span>
          </CardTitle>

          {root.children.length === 0 ? (
            <p className="tone-muted" style={{ fontSize: 13, margin: '0 0 4px 4px' }}>
              Без подкатегорий
            </p>
          ) : (
            root.children.map((child) => (
              <button key={child.id} className="list-row" style={{ width: '100%', textAlign: 'left' }}
                      onClick={() => canEdit && setEditing({ mode: 'edit', category: child })}>
                <CategoryDot color={child.color} icon={child.icon} size={28} />
                <div className="list-row__body"><div className="list-row__title">{child.name}</div></div>
                {canEdit && <Icon name="chevronRight" size={16} className="tone-muted" />}
              </button>
            ))
          )}
        </Card>
      ))}

      {canEdit && (
        <Button variant="secondary" icon="plus" full
                onClick={() => setEditing({ mode: 'new', parentId: null })}>
          Новая категория
        </Button>
      )}

      <CategorySheet editing={editing} kind={kind} onClose={() => setEditing(null)} />
    </div>
  );
}

function CategorySheet({
  editing, kind, onClose,
}: { editing: Editing | null; kind: Kind; onClose: () => void }) {
  const [name, setName] = useState('');
  const [icon, setIcon] = useState('tag');
  const [color, setColor] = useState(PALETTE[7]!);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (!editing) return;
    setConfirmDelete(false);
    if (editing.mode === 'edit') {
      setName(editing.category.name);
      setIcon(editing.category.icon);
      setColor(editing.category.color);
    } else {
      setName('');
      setIcon('tag');
      setColor(PALETTE[7]!);
    }
  }, [editing]);

  if (!editing) return null;

  const save = async () => {
    if (editing.mode === 'new') {
      await store.saveEntity('categories', 'POST', { name, kind, parentId: editing.parentId, icon, color });
    } else {
      await store.saveEntity('categories', 'PATCH', {
        name, icon, color, version: editing.category.version,
      }, editing.category.id);
    }
    onClose();
  };

  const remove = async () => {
    if (editing.mode !== 'edit') return;
    await store.saveEntity('categories', 'DELETE', { version: editing.category.version }, editing.category.id);
    onClose();
  };

  return (
    <Sheet
      open onClose={onClose}
      title={editing.mode === 'new' ? 'Новая категория' : 'Категория'}
      footer={
        confirmDelete ? (
          <>
            <Button variant="secondary" full onClick={() => setConfirmDelete(false)}>Отмена</Button>
            <Button variant="danger" full onClick={remove}>Удалить категорию</Button>
          </>
        ) : (
          <>
            {editing.mode === 'edit' && (
              <Button variant="danger" icon="trash" onClick={() => setConfirmDelete(true)} />
            )}
            <Button variant="primary" full onClick={save} disabled={!name.trim()}>Сохранить</Button>
          </>
        )
      }
    >
      <div className="row" style={{ justifyContent: 'center', paddingTop: 4 }}>
        <CategoryDot color={color} icon={icon} size={58} />
      </div>

      <Field label="Название">
        <input className="input" value={name} autoFocus maxLength={60}
               onChange={(e) => setName(e.target.value)} placeholder="Продукты" />
      </Field>

      <Field label="Цвет">
        <div className="chips">
          {PALETTE.map((value) => (
            <button
              key={value} type="button" aria-label={`Цвет ${value}`}
              onClick={() => setColor(value)}
              style={{
                width: 30, height: 30, borderRadius: 10, background: value,
                outline: color === value ? '2px solid var(--text)' : 'none', outlineOffset: 2,
              }}
            />
          ))}
        </div>
      </Field>

      <Field label="Иконка">
        <div className="chips">
          {ICON_NAMES.map((value) => (
            <button
              key={value} type="button" aria-label={value}
              className={`chip ${icon === value ? 'is-active' : ''}`}
              style={{ padding: 9 }}
              onClick={() => setIcon(value)}
            >
              <Icon name={value} size={18} />
            </button>
          ))}
        </div>
      </Field>

      {confirmDelete && (
        <div className="banner banner--error">
          <Icon name="warning" size={16} />
          Категорию с операциями удалить нельзя — сначала перенесите их
        </div>
      )}
    </Sheet>
  );
}
