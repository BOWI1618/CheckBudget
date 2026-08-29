import { useState } from 'react';
import type { Role } from '@checkbudget/shared';
import { store } from '../data/store.js';
import { useApp } from '../data/hooks.js';
import { Card, CardTitle, Button, Sheet, Field } from '../components/ui.js';
import { Icon } from '../components/Icon.js';

const ROLE_LABEL: Record<Role, string> = {
  owner: 'Владелец',
  editor: 'Участник',
  viewer: 'Наблюдатель',
};

const ROLE_HINT: Record<Role, string> = {
  owner: 'Полный доступ, включая управление участниками',
  editor: 'Может добавлять и изменять операции, категории, счета',
  viewer: 'Только просмотр — ничего изменить не может',
};

export function MembersScreen() {
  const app = useApp();
  const data = app.data;
  const isOwner = data?.budget.role === 'owner';

  const [inviteRole, setInviteRole] = useState<'editor' | 'viewer'>('editor');
  const [code, setCode] = useState<string | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [joinOpen, setJoinOpen] = useState(false);
  const [joinCode, setJoinCode] = useState('');
  const [removing, setRemoving] = useState<string | null>(null);

  if (!data) return null;

  const create = async () => {
    const result = await store.createInvite(inviteRole);
    if (result) setCode(result);
  };

  return (
    <div className="stack">
      <Card>
        <CardTitle>Участники «{data.budget.name}»</CardTitle>
        {data.members.map((member) => {
          const isMe = member.userId === app.user?.id;
          return (
            <div className="list-row" key={member.userId}>
              <div className="cat-dot" style={{
                width: 38, height: 38,
                background: 'var(--accent-soft)', color: 'var(--accent)',
                fontWeight: 650, fontSize: 'var(--t-base)',
              }}>
                {member.displayName.slice(0, 1).toUpperCase()}
              </div>
              <div className="list-row__body">
                <div className="list-row__title">
                  {member.displayName}{isMe && <span className="tone-muted"> · вы</span>}
                </div>
                <div className="list-row__sub">{member.email}</div>
              </div>

              {isOwner && !isMe && member.role !== 'owner' ? (
                <div className="row" style={{ gap: 6 }}>
                  <select
                    className="select" style={{ width: 'auto', padding: '6px 10px', fontSize: 'var(--t-small)' }}
                    value={member.role}
                    onChange={(e) => store.changeMemberRole(member.userId, e.target.value as 'editor' | 'viewer')}
                  >
                    <option value="editor">Участник</option>
                    <option value="viewer">Наблюдатель</option>
                  </select>
                  <Button variant="ghost" size="sm" icon="x" title="Исключить"
                          onClick={() => setRemoving(member.userId)} />
                </div>
              ) : (
                <span className={`badge badge--${member.role}`}>{ROLE_LABEL[member.role]}</span>
              )}
            </div>
          );
        })}

        {isOwner && (
          <Button variant="secondary" icon="plus" full
                  onClick={() => { setInviteOpen(true); setCode(null); }}>
            Пригласить участника
          </Button>
        )}
      </Card>

      <Card>
        <CardTitle>Присоединиться к чужому бюджету</CardTitle>
        <p className="tone-muted" style={{ fontSize: 'var(--t-small)', margin: '0 0 12px' }}>
          Если вам прислали код приглашения — введите его здесь.
        </p>
        <Button variant="secondary" full onClick={() => setJoinOpen(true)}>Ввести код</Button>
      </Card>

      <Card>
        <CardTitle>Что может каждая роль</CardTitle>
        {(['owner', 'editor', 'viewer'] as Role[]).map((role) => (
          <div className="list-row" key={role}>
            <span className={`badge badge--${role}`}>{ROLE_LABEL[role]}</span>
            <div className="list-row__body"><div className="list-row__sub">{ROLE_HINT[role]}</div></div>
          </div>
        ))}
        <p className="tone-muted" style={{ fontSize: 'var(--t-small)', marginBottom: 0 }}>
          Права проверяются на сервере при каждом запросе, а не только скрытием кнопок.
        </p>
      </Card>

      <Sheet
        open={inviteOpen} onClose={() => setInviteOpen(false)} title="Приглашение"
        footer={code ? (
          <Button variant="primary" full onClick={() => setInviteOpen(false)}>Готово</Button>
        ) : (
          <>
            <Button variant="secondary" full onClick={() => setInviteOpen(false)}>Отмена</Button>
            <Button variant="primary" full onClick={create}>Создать код</Button>
          </>
        )}
      >
        {code ? (
          <>
            <p className="tone-muted" style={{ fontSize: 'var(--t-small)', margin: 0 }}>
              Передайте этот код тому, кого приглашаете. Код действует 72 часа
              и сработает один раз.
            </p>
            <div className="code-box">
              <span style={{ flex: 1 }}>{code}</span>
              <Button variant="ghost" icon="copy" title="Скопировать"
                      onClick={() => navigator.clipboard?.writeText(code)} />
            </div>
            <div className="banner banner--offline">
              <Icon name="warning" size={16} />
              Код показывается один раз — на сервере хранится только его хеш
            </div>
          </>
        ) : (
          <Field label="Роль приглашаемого" hint={ROLE_HINT[inviteRole]}>
            <select className="select" value={inviteRole}
                    onChange={(e) => setInviteRole(e.target.value as 'editor' | 'viewer')}>
              <option value="editor">Участник — может вести операции</option>
              <option value="viewer">Наблюдатель — только просмотр</option>
            </select>
          </Field>
        )}
      </Sheet>

      <Sheet
        open={joinOpen} onClose={() => setJoinOpen(false)} title="Код приглашения"
        footer={
          <>
            <Button variant="secondary" full onClick={() => setJoinOpen(false)}>Отмена</Button>
            <Button variant="primary" full disabled={joinCode.trim().length < 6}
                    onClick={async () => {
                      if (await store.acceptInvite(joinCode.trim())) {
                        setJoinOpen(false);
                        setJoinCode('');
                      }
                    }}>
              Присоединиться
            </Button>
          </>
        }
      >
        <Field label="Код">
          <input className="input" value={joinCode} autoFocus placeholder="ABCD-EFGH-JKLM"
                 style={{ letterSpacing: '0.08em', fontWeight: 600 }}
                 onChange={(e) => setJoinCode(e.target.value.toUpperCase())} />
        </Field>
      </Sheet>

      <Sheet
        open={removing !== null} onClose={() => setRemoving(null)} title="Исключить участника"
        footer={
          <>
            <Button variant="secondary" full onClick={() => setRemoving(null)}>Отмена</Button>
            <Button variant="danger" full onClick={async () => {
              if (removing) await store.removeMember(removing);
              setRemoving(null);
            }}>
              Исключить
            </Button>
          </>
        }
      >
        <p style={{ margin: 0, fontSize: 'var(--t-base)', lineHeight: 1.5 }}>
          Участник потеряет доступ к бюджету немедленно — в том числе открытые
          у него вкладки перестанут получать обновления. Добавленные им операции
          останутся в бюджете.
        </p>
      </Sheet>
    </div>
  );
}
