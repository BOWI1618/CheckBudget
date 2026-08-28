/**
 * Сквозной тест: проверяет ровно те инварианты, ради которых сделана
 * архитектура — изоляцию бюджетов, оптимистичные блокировки, идемпотентность,
 * заморозку курса и доставку realtime-событий второму устройству.
 *
 * Запускается против живого сервера: node --import tsx --test server/src/e2e.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { buildApp } from './index.js';
import { db } from './db/index.js';
import { seedReference } from './db/seed.js';
import { attachRealtime, closeRealtime } from './realtime/hub.js';

let base: string;
let wsUrl: string;
let app: Awaited<ReturnType<typeof buildApp>>;

before(async () => {
  db.migrate();
  seedReference();
  app = await buildApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  attachRealtime(app.server);
  const addr = app.server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}/api/v1`;
  wsUrl = `ws://127.0.0.1:${addr.port}/ws`;
});

after(async () => {
  await closeRealtime();
  await app.close();
  db.close();
});

interface Session { token: string; userId: string }

async function api(
  path: string,
  opts: { method?: string; body?: unknown; token?: string; idem?: string; clientId?: string } = {},
) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.clientId) headers['x-client-id'] = opts.clientId;
  if (opts.method && opts.method !== 'GET') {
    headers['idempotency-key'] = opts.idem ?? randomUUID();
  }
  const res = await fetch(base + path, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function register(name: string): Promise<Session> {
  const res = await api('/auth/register', {
    method: 'POST',
    body: {
      email: `user-${randomUUID().slice(0, 8)}@example.com`,
      password: 'very-secret-1',
      displayName: name,
    },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return { token: res.body.accessToken, userId: res.body.user.id };
}

test('регистрация задаёт RUB как базовую валюту', async () => {
  const ivan = await register('Иван');
  const me = await api('/me', { token: ivan.token });
  assert.equal(me.body.settings.baseCurrency, 'RUB');
});

test('новый бюджет получает стандартные категории и счета', async () => {
  const ivan = await register('Иван');
  const budget = await api('/budgets', {
    method: 'POST', token: ivan.token, body: { name: 'Семейный бюджет', baseCurrency: 'RUB' },
  });
  assert.equal(budget.status, 201);

  const snapshot = await api(`/budgets/${budget.body.id}/snapshot`, { token: ivan.token });
  assert.ok(snapshot.body.categories.length > 20, 'должны быть категории по умолчанию');
  assert.equal(snapshot.body.accounts.length, 2);
  assert.equal(snapshot.body.budget.role, 'owner');
});

test('чужой бюджет недоступен по подмене ID в URL', async () => {
  const ivan = await register('Иван');
  const anna = await register('Анна');
  const budget = await api('/budgets', {
    method: 'POST', token: ivan.token, body: { name: 'Личный', baseCurrency: 'RUB' },
  });

  // Анна знает id бюджета Ивана, но не является участником.
  const asAnna = await api(`/budgets/${budget.body.id}/snapshot`, { token: anna.token });
  assert.equal(asAnna.status, 404, 'должен быть 404, а не 403 — иначе id перебираются');

  const txAsAnna = await api(`/budgets/${budget.body.id}/transactions`, { token: anna.token });
  assert.equal(txAsAnna.status, 404);
});

test('нельзя записать операцию на счёт из чужого бюджета', async () => {
  const ivan = await register('Иван');
  const a = await api('/budgets', { method: 'POST', token: ivan.token, body: { name: 'A', baseCurrency: 'RUB' } });
  const b = await api('/budgets', { method: 'POST', token: ivan.token, body: { name: 'B', baseCurrency: 'RUB' } });

  const snapA = await api(`/budgets/${a.body.id}/snapshot`, { token: ivan.token });
  const snapB = await api(`/budgets/${b.body.id}/snapshot`, { token: ivan.token });

  // Иван — участник обоих бюджетов, но счёт из B в бюджете A использовать нельзя.
  const res = await api(`/budgets/${a.body.id}/transactions`, {
    method: 'POST', token: ivan.token,
    body: {
      type: 'expense',
      accountId: snapB.body.accounts[0].id,
      categoryId: snapA.body.categories.find((c: { kind: string }) => c.kind === 'expense').id,
      amountMinor: '100000', currency: 'RUB', occurredOn: '2026-08-01',
    },
  });
  assert.equal(res.status, 422);
  assert.equal(res.body.error.code, 'unknown_account');
});

test('добавление расхода и вычисление баланса счёта', async () => {
  const ivan = await register('Иван');
  const budget = await api('/budgets', { method: 'POST', token: ivan.token, body: { name: 'Б', baseCurrency: 'RUB' } });
  const snap = await api(`/budgets/${budget.body.id}/snapshot`, { token: ivan.token });
  const account = snap.body.accounts[0];
  const category = snap.body.categories.find((c: { kind: string }) => c.kind === 'expense');

  const tx = await api(`/budgets/${budget.body.id}/transactions`, {
    method: 'POST', token: ivan.token,
    body: {
      type: 'expense', accountId: account.id, categoryId: category.id,
      amountMinor: '250000', currency: 'RUB', occurredOn: '2026-08-15', note: 'Продукты',
    },
  });
  assert.equal(tx.status, 201);
  assert.equal(tx.body.amountMinor, '250000', 'суммы передаются строками');
  assert.equal(tx.body.baseAmountMinor, '250000');
  assert.equal(tx.body.version, 1);

  const accounts = await api(`/budgets/${budget.body.id}/accounts`, { token: ivan.token });
  const updated = accounts.body.items.find((a: { id: string }) => a.id === account.id);
  assert.equal(updated.balanceMinor, '-250000');
});

test('операция в валюте счёта конвертируется в базовую валюту бюджета и курс замораживается', async () => {
  const ivan = await register('Иван');
  const budget = await api('/budgets', { method: 'POST', token: ivan.token, body: { name: 'Б', baseCurrency: 'RUB' } });
  const bid = budget.body.id;

  const usdAccount = await api(`/budgets/${bid}/accounts`, {
    method: 'POST', token: ivan.token,
    body: { name: 'Валютный', type: 'bank', currency: 'USD', initialBalanceMinor: '100000' },
  });
  assert.equal(usdAccount.status, 201);

  const snap = await api(`/budgets/${bid}/snapshot`, { token: ivan.token });
  const category = snap.body.categories.find((c: { kind: string }) => c.kind === 'expense');

  const tx = await api(`/budgets/${bid}/transactions`, {
    method: 'POST', token: ivan.token,
    body: {
      type: 'expense', accountId: usdAccount.body.id, categoryId: category.id,
      amountMinor: '10000', currency: 'USD', occurredOn: '2026-08-15',
    },
  });
  assert.equal(tx.status, 201);
  // 100.00 USD × 92.4567 = 9245.67 RUB
  assert.equal(tx.body.baseAmountMinor, '924567');
  assert.equal(tx.body.baseCurrency, 'RUB');
  assert.equal(tx.body.rateNum, 924567);
  assert.equal(tx.body.rateDen, 10000);

  // Курс изменился — историческая операция не меняется.
  db.run(
    `INSERT OR REPLACE INTO exchange_rates (id, base_code, quote_code, rate_num, rate_den, valid_on, source, created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    randomUUID(), 'USD', 'RUB', 1500000, 10000, '2026-08-20', 'test', new Date().toISOString(),
  );
  const again = await api(`/budgets/${bid}/transactions`, { token: ivan.token });
  const same = again.body.items.find((t: { id: string }) => t.id === tx.body.id);
  assert.equal(same.baseAmountMinor, '924567', 'история не должна меняться при обновлении курса');
});

test('валюта операции обязана совпадать с валютой счёта', async () => {
  const ivan = await register('Иван');
  const budget = await api('/budgets', { method: 'POST', token: ivan.token, body: { name: 'Б', baseCurrency: 'RUB' } });
  const snap = await api(`/budgets/${budget.body.id}/snapshot`, { token: ivan.token });
  const res = await api(`/budgets/${budget.body.id}/transactions`, {
    method: 'POST', token: ivan.token,
    body: {
      type: 'expense', accountId: snap.body.accounts[0].id,
      categoryId: snap.body.categories.find((c: { kind: string }) => c.kind === 'expense').id,
      amountMinor: '10000', currency: 'USD', occurredOn: '2026-08-15',
    },
  });
  assert.equal(res.status, 422);
  assert.equal(res.body.error.code, 'currency_mismatch');
});

test('идемпотентность: повтор запроса не создаёт дубль', async () => {
  const ivan = await register('Иван');
  const budget = await api('/budgets', { method: 'POST', token: ivan.token, body: { name: 'Б', baseCurrency: 'RUB' } });
  const snap = await api(`/budgets/${budget.body.id}/snapshot`, { token: ivan.token });
  const key = randomUUID();
  const body = {
    type: 'expense', accountId: snap.body.accounts[0].id,
    categoryId: snap.body.categories.find((c: { kind: string }) => c.kind === 'expense').id,
    amountMinor: '150000', currency: 'RUB', occurredOn: '2026-08-10',
  };

  const first = await api(`/budgets/${budget.body.id}/transactions`, { method: 'POST', token: ivan.token, body, idem: key });
  const retry = await api(`/budgets/${budget.body.id}/transactions`, { method: 'POST', token: ivan.token, body, idem: key });

  assert.equal(first.status, 201);
  assert.equal(retry.status, 201);
  assert.equal(retry.body.id, first.body.id, 'повтор должен вернуть ту же операцию');

  const list = await api(`/budgets/${budget.body.id}/transactions`, { token: ivan.token });
  assert.equal(list.body.items.length, 1, 'дубля быть не должно');
});

test('конфликт версий: два устройства правят одну операцию', async () => {
  const ivan = await register('Иван');
  const budget = await api('/budgets', { method: 'POST', token: ivan.token, body: { name: 'Б', baseCurrency: 'RUB' } });
  const bid = budget.body.id;
  const snap = await api(`/budgets/${bid}/snapshot`, { token: ivan.token });

  const tx = await api(`/budgets/${bid}/transactions`, {
    method: 'POST', token: ivan.token,
    body: {
      type: 'expense', accountId: snap.body.accounts[0].id,
      categoryId: snap.body.categories.find((c: { kind: string }) => c.kind === 'expense').id,
      amountMinor: '100000', currency: 'RUB', occurredOn: '2026-08-12',
    },
  });
  const baseVersion = tx.body.version;

  // Телефон: 1000 -> 1500
  const phone = await api(`/budgets/${bid}/transactions/${tx.body.id}`, {
    method: 'PATCH', token: ivan.token, body: { amountMinor: '150000', version: baseVersion },
  });
  assert.equal(phone.status, 200);
  assert.equal(phone.body.amountMinor, '150000');
  assert.equal(phone.body.version, baseVersion + 1);

  // ПК: 1000 -> 1200, на устаревшей версии
  const desktop = await api(`/budgets/${bid}/transactions/${tx.body.id}`, {
    method: 'PATCH', token: ivan.token, body: { amountMinor: '120000', version: baseVersion },
  });
  assert.equal(desktop.status, 409);
  assert.equal(desktop.body.error.code, 'version_conflict');
  assert.equal(desktop.body.error.current.amountMinor, '150000', 'ответ несёт актуальное состояние');
  assert.equal(desktop.body.error.current.version, baseVersion + 1);

  // Данные не потеряны: изменение телефона на месте, ничего не перезаписано молча.
  const check = await api(`/budgets/${bid}/transactions`, { token: ivan.token });
  assert.equal(check.body.items[0].amountMinor, '150000');
});

test('viewer не может изменять данные, editor может', async () => {
  const ivan = await register('Иван');
  const anna = await register('Анна');
  const budget = await api('/budgets', { method: 'POST', token: ivan.token, body: { name: 'Семья', baseCurrency: 'RUB' } });
  const bid = budget.body.id;

  const invite = await api(`/budgets/${bid}/invites`, {
    method: 'POST', token: ivan.token, body: { role: 'viewer', expiresInHours: 24 },
  });
  assert.equal(invite.status, 201);
  await api('/invites/accept', { method: 'POST', token: anna.token, body: { code: invite.body.code } });

  const snap = await api(`/budgets/${bid}/snapshot`, { token: anna.token });
  assert.equal(snap.status, 200, 'viewer видит бюджет');
  assert.equal(snap.body.budget.role, 'viewer');

  const write = await api(`/budgets/${bid}/transactions`, {
    method: 'POST', token: anna.token,
    body: {
      type: 'expense', accountId: snap.body.accounts[0].id,
      categoryId: snap.body.categories.find((c: { kind: string }) => c.kind === 'expense').id,
      amountMinor: '50000', currency: 'RUB', occurredOn: '2026-08-01',
    },
  });
  assert.equal(write.status, 403, 'viewer не может писать');

  // Владелец повышает до editor — и запись проходит.
  await api(`/budgets/${bid}/members/${anna.userId}`, {
    method: 'PATCH', token: ivan.token, body: { role: 'editor' },
  });
  const write2 = await api(`/budgets/${bid}/transactions`, {
    method: 'POST', token: anna.token,
    body: {
      type: 'expense', accountId: snap.body.accounts[0].id,
      categoryId: snap.body.categories.find((c: { kind: string }) => c.kind === 'expense').id,
      amountMinor: '50000', currency: 'RUB', occurredOn: '2026-08-01',
    },
  });
  assert.equal(write2.status, 201);
});

test('editor не может приглашать участников', async () => {
  const ivan = await register('Иван');
  const anna = await register('Анна');
  const budget = await api('/budgets', { method: 'POST', token: ivan.token, body: { name: 'Семья', baseCurrency: 'RUB' } });
  const invite = await api(`/budgets/${budget.body.id}/invites`, {
    method: 'POST', token: ivan.token, body: { role: 'editor', expiresInHours: 24 },
  });
  await api('/invites/accept', { method: 'POST', token: anna.token, body: { code: invite.body.code } });

  const res = await api(`/budgets/${budget.body.id}/invites`, {
    method: 'POST', token: anna.token, body: { role: 'viewer', expiresInHours: 24 },
  });
  assert.equal(res.status, 403);
});

test('realtime: изменение с телефона доходит до второго устройства', async () => {
  const ivan = await register('Иван');
  const anna = await register('Анна');
  const budget = await api('/budgets', { method: 'POST', token: ivan.token, body: { name: 'Семья', baseCurrency: 'RUB' } });
  const bid = budget.body.id;

  const invite = await api(`/budgets/${bid}/invites`, {
    method: 'POST', token: ivan.token, body: { role: 'editor', expiresInHours: 24 },
  });
  await api('/invites/accept', { method: 'POST', token: anna.token, body: { code: invite.body.code } });

  const socket = new WebSocket(wsUrl);
  const messages: Record<string, unknown>[] = [];
  const waitFor = (type: string, timeoutMs = 4000) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const found = messages.find((m) => m.type === type);
      if (found) return resolve(found);
      const timer = setTimeout(() => reject(new Error(`нет сообщения ${type}`)), timeoutMs);
      const handler = (raw: unknown) => {
        const msg = JSON.parse(String(raw));
        messages.push(msg);
        if (msg.type === type) {
          clearTimeout(timer);
          socket.off('message', handler);
          resolve(msg);
        }
      };
      socket.on('message', handler);
    });

  await new Promise((r) => socket.on('open', r));
  socket.send(JSON.stringify({ type: 'auth', token: anna.token }));
  await waitFor('auth.ok');
  socket.send(JSON.stringify({ type: 'subscribe', budgetId: bid, sinceSeq: 0 }));
  const subscribed = await waitFor('subscribed');
  assert.equal(subscribed.budgetId, bid);

  // Иван добавляет расход «Продукты — 2500 ₽» со своего устройства.
  const snap = await api(`/budgets/${bid}/snapshot`, { token: ivan.token });
  const created = api(`/budgets/${bid}/transactions`, {
    method: 'POST', token: ivan.token,
    body: {
      type: 'expense', accountId: snap.body.accounts[0].id,
      categoryId: snap.body.categories.find((c: { kind: string }) => c.kind === 'expense').id,
      amountMinor: '250000', currency: 'RUB', occurredOn: '2026-08-27', note: 'Продукты',
    },
  });

  const event = await waitFor('event');
  await created;

  assert.equal(event.entity, 'transaction');
  assert.equal(event.op, 'insert');
  assert.equal(event.actorName, 'Иван');
  assert.ok(Number(event.seq) > 0, 'событие несёт монотонный seq');
  assert.equal((event.payload as { amountMinor: string }).amountMinor, '250000');

  socket.close();
});

test('realtime: догрузка пропущенных событий по sinceSeq', async () => {
  const ivan = await register('Иван');
  const budget = await api('/budgets', { method: 'POST', token: ivan.token, body: { name: 'Б', baseCurrency: 'RUB' } });
  const bid = budget.body.id;
  const snap = await api(`/budgets/${bid}/snapshot`, { token: ivan.token });
  const seqBefore = snap.body.seq;

  // Устройство офлайн — за это время создаются две операции.
  for (const amount of ['10000', '20000']) {
    await api(`/budgets/${bid}/transactions`, {
      method: 'POST', token: ivan.token,
      body: {
        type: 'expense', accountId: snap.body.accounts[0].id,
        categoryId: snap.body.categories.find((c: { kind: string }) => c.kind === 'expense').id,
        amountMinor: amount, currency: 'RUB', occurredOn: '2026-08-05',
      },
    });
  }

  const socket = new WebSocket(wsUrl);
  await new Promise((r) => socket.on('open', r));
  const subscribed = await new Promise<Record<string, unknown>>((resolve) => {
    socket.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.type === 'subscribed') resolve(msg);
    });
    socket.send(JSON.stringify({ type: 'auth', token: ivan.token }));
    setTimeout(() => socket.send(JSON.stringify({ type: 'subscribe', budgetId: bid, sinceSeq: seqBefore })), 50);
  });

  const events = subscribed.events as Array<{ entity: string; op: string }>;
  assert.equal(events.length, 2, 'обе пропущенные операции должны догрузиться');
  assert.ok(events.every((e) => e.entity === 'transaction' && e.op === 'insert'));
  socket.close();
});

test('realtime: подписка без членства отклоняется', async () => {
  const ivan = await register('Иван');
  const anna = await register('Анна');
  const budget = await api('/budgets', { method: 'POST', token: ivan.token, body: { name: 'Личный', baseCurrency: 'RUB' } });

  const socket = new WebSocket(wsUrl);
  await new Promise((r) => socket.on('open', r));
  const response = await new Promise<Record<string, unknown>>((resolve) => {
    socket.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.type === 'error' || msg.type === 'subscribed') resolve(msg);
    });
    socket.send(JSON.stringify({ type: 'auth', token: anna.token }));
    setTimeout(() => socket.send(JSON.stringify({ type: 'subscribe', budgetId: budget.body.id, sinceSeq: 0 })), 50);
  });
  assert.equal(response.type, 'error');
  assert.equal(response.code, 'forbidden');
  socket.close();
});

test('realtime: без авторизации подписка невозможна', async () => {
  const socket = new WebSocket(wsUrl);
  await new Promise((r) => socket.on('open', r));
  const response = await new Promise<Record<string, unknown>>((resolve) => {
    socket.on('message', (raw) => resolve(JSON.parse(String(raw))));
    socket.send(JSON.stringify({ type: 'subscribe', budgetId: randomUUID(), sinceSeq: 0 }));
  });
  assert.equal(response.code, 'unauthorized');
  socket.close();
});

test('перевод между счетами не попадает в доходы и расходы', async () => {
  const ivan = await register('Иван');
  const budget = await api('/budgets', { method: 'POST', token: ivan.token, body: { name: 'Б', baseCurrency: 'RUB' } });
  const bid = budget.body.id;
  const snap = await api(`/budgets/${bid}/snapshot`, { token: ivan.token });
  const [card, cash] = snap.body.accounts;

  const tx = await api(`/budgets/${bid}/transactions`, {
    method: 'POST', token: ivan.token,
    body: {
      type: 'transfer', accountId: card.id, counterAccountId: cash.id,
      amountMinor: '500000', currency: 'RUB', occurredOn: '2026-08-03',
    },
  });
  assert.equal(tx.status, 201);

  const summary = await api(`/budgets/${bid}/analytics/summary?from=2026-08-01&to=2026-08-31`, { token: ivan.token });
  assert.equal(summary.body.incomeMinor, '0');
  assert.equal(summary.body.expenseMinor, '0');

  const accounts = await api(`/budgets/${bid}/accounts`, { token: ivan.token });
  const cardAfter = accounts.body.items.find((a: { id: string }) => a.id === card.id);
  const cashAfter = accounts.body.items.find((a: { id: string }) => a.id === cash.id);
  assert.equal(cardAfter.balanceMinor, '-500000');
  assert.equal(cashAfter.balanceMinor, '500000');
});

test('удаление мягкое: операция исчезает из выдачи, версия растёт', async () => {
  const ivan = await register('Иван');
  const budget = await api('/budgets', { method: 'POST', token: ivan.token, body: { name: 'Б', baseCurrency: 'RUB' } });
  const bid = budget.body.id;
  const snap = await api(`/budgets/${bid}/snapshot`, { token: ivan.token });
  const tx = await api(`/budgets/${bid}/transactions`, {
    method: 'POST', token: ivan.token,
    body: {
      type: 'expense', accountId: snap.body.accounts[0].id,
      categoryId: snap.body.categories.find((c: { kind: string }) => c.kind === 'expense').id,
      amountMinor: '30000', currency: 'RUB', occurredOn: '2026-08-07',
    },
  });

  const stale = await api(`/budgets/${bid}/transactions/${tx.body.id}`, {
    method: 'DELETE', token: ivan.token, body: { version: 99 },
  });
  assert.equal(stale.status, 409, 'удаление тоже требует актуальной версии');

  const del = await api(`/budgets/${bid}/transactions/${tx.body.id}`, {
    method: 'DELETE', token: ivan.token, body: { version: tx.body.version },
  });
  assert.equal(del.status, 200);

  const list = await api(`/budgets/${bid}/transactions`, { token: ivan.token });
  assert.equal(list.body.items.length, 0);

  const row = db.get<{ deleted_at: string | null }>('SELECT deleted_at FROM transactions WHERE id = ?', tx.body.id);
  assert.ok(row?.deleted_at, 'строка остаётся как tombstone');
});

test('лимит показывает потрачено с учётом подкатегорий', async () => {
  const ivan = await register('Иван');
  const budget = await api('/budgets', { method: 'POST', token: ivan.token, body: { name: 'Б', baseCurrency: 'RUB' } });
  const bid = budget.body.id;
  const snap = await api(`/budgets/${bid}/snapshot`, { token: ivan.token });

  const food = snap.body.categories.find((c: { name: string }) => c.name === 'Продукты');
  const child = snap.body.categories.find((c: { parentId: string | null }) => c.parentId === food.id);

  await api(`/budgets/${bid}/limits`, {
    method: 'PUT', token: ivan.token,
    body: { categoryId: food.id, period: '2026-08', limitMinor: '3000000' },
  });
  for (const [categoryId, amount] of [[food.id, '1000000'], [child.id, '500000']] as const) {
    await api(`/budgets/${bid}/transactions`, {
      method: 'POST', token: ivan.token,
      body: { type: 'expense', accountId: snap.body.accounts[0].id, categoryId, amountMinor: amount, currency: 'RUB', occurredOn: '2026-08-14' },
    });
  }

  const limits = await api(`/budgets/${bid}/limits?period=2026-08`, { token: ivan.token });
  const limit = limits.body.items[0];
  assert.equal(limit.limitMinor, '3000000');
  assert.equal(limit.spentMinor, '1500000', 'лимит на «Продукты» покрывает подкатегории');
});

test('аналитика группирует расходы по корневой категории', async () => {
  const ivan = await register('Иван');
  const budget = await api('/budgets', { method: 'POST', token: ivan.token, body: { name: 'Б', baseCurrency: 'RUB' } });
  const bid = budget.body.id;
  const snap = await api(`/budgets/${bid}/snapshot`, { token: ivan.token });
  const parent = snap.body.categories.find((c: { name: string }) => c.name === 'Транспорт');
  const children = snap.body.categories.filter((c: { parentId: string | null }) => c.parentId === parent.id);

  for (const child of children.slice(0, 2)) {
    await api(`/budgets/${bid}/transactions`, {
      method: 'POST', token: ivan.token,
      body: { type: 'expense', accountId: snap.body.accounts[0].id, categoryId: child.id, amountMinor: '100000', currency: 'RUB', occurredOn: '2026-08-09' },
    });
  }

  const byCategory = await api(`/budgets/${bid}/analytics/by-category?from=2026-08-01&to=2026-08-31`, { token: ivan.token });
  assert.equal(byCategory.body.items.length, 1, 'подкатегории сливаются в корневую');
  assert.equal(byCategory.body.items[0].name, 'Транспорт');
  assert.equal(byCategory.body.items[0].amountMinor, '200000');
});

test('событие несёт идентификатор устройства — телефон и ПК одного человека различимы', async () => {
  const ivan = await register('Иван');
  const budget = await api('/budgets', { method: 'POST', token: ivan.token, body: { name: 'Б', baseCurrency: 'RUB' } });
  const bid = budget.body.id;
  const snap = await api(`/budgets/${bid}/snapshot`, { token: ivan.token });

  const phone = 'device-phone';
  const desktop = 'device-desktop';

  const socket = new WebSocket(wsUrl);
  await new Promise((r) => socket.on('open', r));
  const events: Array<Record<string, unknown>> = [];
  socket.on('message', (raw) => events.push(JSON.parse(String(raw))));
  socket.send(JSON.stringify({ type: 'auth', token: ivan.token }));
  await new Promise((r) => setTimeout(r, 80));
  socket.send(JSON.stringify({ type: 'subscribe', budgetId: bid, sinceSeq: snap.body.seq }));
  await new Promise((r) => setTimeout(r, 80));

  // Иван добавляет расход с телефона.
  await api(`/budgets/${bid}/transactions`, {
    method: 'POST', token: ivan.token, clientId: phone,
    body: {
      type: 'expense', accountId: snap.body.accounts[0].id,
      categoryId: snap.body.categories.find((c: { kind: string }) => c.kind === 'expense').id,
      amountMinor: '250000', currency: 'RUB', occurredOn: '2026-08-27', note: 'Продукты',
    },
  });

  await new Promise((r) => setTimeout(r, 300));
  const event = events.find((e) => e.type === 'event');
  assert.ok(event, 'событие должно прийти');
  assert.equal(event.actorClientId, phone);
  assert.notEqual(event.actorClientId, desktop,
    'для ПК это изменение внешнее, хотя пользователь тот же');
  socket.close();
});

test('идемпотентность разделена по пользователям', async () => {
  const ivan = await register('Иван');
  const anna = await register('Анна');
  const key = randomUUID();

  const a = await api('/budgets', { method: 'POST', token: ivan.token, idem: key, body: { name: 'A', baseCurrency: 'RUB' } });
  const b = await api('/budgets', { method: 'POST', token: anna.token, idem: key, body: { name: 'B', baseCurrency: 'RUB' } });

  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
  assert.notEqual(a.body.id, b.body.id, 'один и тот же ключ у разных пользователей — разные объекты');
});

test('тот же ключ идемпотентности с другими данными отвергается', async () => {
  const ivan = await register('Иван');
  const key = randomUUID();
  const first = await api('/budgets', { method: 'POST', token: ivan.token, idem: key, body: { name: 'A', baseCurrency: 'RUB' } });
  assert.equal(first.status, 201);

  const second = await api('/budgets', { method: 'POST', token: ivan.token, idem: key, body: { name: 'ДРУГОЕ', baseCurrency: 'USD' } });
  assert.equal(second.status, 422);
  assert.equal(second.body.error.code, 'idempotency_key_reuse');
});

test('мутация без Idempotency-Key отвергается', async () => {
  const ivan = await register('Иван');
  const res = await fetch(`${base}/budgets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${ivan.token}` },
    body: JSON.stringify({ name: 'Без ключа', baseCurrency: 'RUB' }),
  });
  assert.equal(res.status, 400);
});

test('удалённый участник теряет доступ немедленно', async () => {
  const ivan = await register('Иван');
  const anna = await register('Анна');
  const budget = await api('/budgets', { method: 'POST', token: ivan.token, body: { name: 'Семья', baseCurrency: 'RUB' } });
  const bid = budget.body.id;

  const invite = await api(`/budgets/${bid}/invites`, {
    method: 'POST', token: ivan.token, body: { role: 'editor', expiresInHours: 24 },
  });
  await api('/invites/accept', { method: 'POST', token: anna.token, body: { code: invite.body.code } });
  assert.equal((await api(`/budgets/${bid}/snapshot`, { token: anna.token })).status, 200);

  await api(`/budgets/${bid}/members/${anna.userId}`, { method: 'DELETE', token: ivan.token });

  // Токен Анны ещё действует, но членства больше нет — доступа быть не должно.
  const after = await api(`/budgets/${bid}/snapshot`, { token: anna.token });
  assert.equal(after.status, 404);
});

test('приглашение срабатывает один раз', async () => {
  const ivan = await register('Иван');
  const anna = await register('Анна');
  const boris = await register('Борис');
  const budget = await api('/budgets', { method: 'POST', token: ivan.token, body: { name: 'Семья', baseCurrency: 'RUB' } });

  const invite = await api(`/budgets/${budget.body.id}/invites`, {
    method: 'POST', token: ivan.token, body: { role: 'editor', expiresInHours: 24 },
  });
  const first = await api('/invites/accept', { method: 'POST', token: anna.token, body: { code: invite.body.code } });
  assert.equal(first.status, 200);

  const second = await api('/invites/accept', { method: 'POST', token: boris.token, body: { code: invite.body.code } });
  assert.equal(second.status, 422);
  assert.equal(second.body.error.code, 'invite_used');
});

test('владелец не может понизить или исключить сам себя', async () => {
  const ivan = await register('Иван');
  const budget = await api('/budgets', { method: 'POST', token: ivan.token, body: { name: 'Б', baseCurrency: 'RUB' } });
  const bid = budget.body.id;

  const demote = await api(`/budgets/${bid}/members/${ivan.userId}`, {
    method: 'PATCH', token: ivan.token, body: { role: 'viewer' },
  });
  assert.equal(demote.status, 403);

  const remove = await api(`/budgets/${bid}/members/${ivan.userId}`, { method: 'DELETE', token: ivan.token });
  assert.equal(remove.status, 403);
});

test('ротация refresh-токена: повторное использование отзывает всю семью', async () => {
  const email = `user-${randomUUID().slice(0, 8)}@example.com`;
  const registration = await fetch(`${base}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() },
    body: JSON.stringify({ email, password: 'very-secret-1', displayName: 'Иван' }),
  });
  const cookie = registration.headers.get('set-cookie')!.split(';')[0]!;

  const refresh = (c: string) => fetch(`${base}/auth/refresh`, { method: 'POST', headers: { cookie: c } });

  const first = await refresh(cookie);
  assert.equal(first.status, 200, 'первое обновление проходит');
  const rotated = first.headers.get('set-cookie')!.split(';')[0]!;

  // Повторное предъявление уже использованного токена = признак кражи.
  const replay = await refresh(cookie);
  assert.equal(replay.status, 401);
  const replayBody = (await replay.json()) as { error: { code: string } };
  assert.equal(replayBody.error.code, 'token_reuse');

  // И новый токен из той же семьи тоже отозван.
  const afterRevoke = await refresh(rotated);
  assert.equal(afterRevoke.status, 401);
});

test('счёт с операциями нельзя удалить — только архивировать', async () => {
  const ivan = await register('Иван');
  const budget = await api('/budgets', { method: 'POST', token: ivan.token, body: { name: 'Б', baseCurrency: 'RUB' } });
  const bid = budget.body.id;
  const snap = await api(`/budgets/${bid}/snapshot`, { token: ivan.token });
  const account = snap.body.accounts[0];

  await api(`/budgets/${bid}/transactions`, {
    method: 'POST', token: ivan.token,
    body: {
      type: 'expense', accountId: account.id,
      categoryId: snap.body.categories.find((c: { kind: string }) => c.kind === 'expense').id,
      amountMinor: '10000', currency: 'RUB', occurredOn: '2026-08-02',
    },
  });

  const del = await api(`/budgets/${bid}/accounts/${account.id}`, {
    method: 'DELETE', token: ivan.token, body: { version: account.version },
  });
  assert.equal(del.status, 422);
  assert.equal(del.body.error.code, 'account_in_use');

  const archive = await api(`/budgets/${bid}/accounts/${account.id}`, {
    method: 'PATCH', token: ivan.token, body: { isArchived: true, version: account.version },
  });
  assert.equal(archive.status, 200);
  assert.equal(archive.body.isArchived, true);
});

test('вложенность категорий ограничена двумя уровнями', async () => {
  const ivan = await register('Иван');
  const budget = await api('/budgets', { method: 'POST', token: ivan.token, body: { name: 'Б', baseCurrency: 'RUB' } });
  const bid = budget.body.id;
  const snap = await api(`/budgets/${bid}/snapshot`, { token: ivan.token });
  const child = snap.body.categories.find((c: { parentId: string | null }) => c.parentId !== null);

  const res = await api(`/budgets/${bid}/categories`, {
    method: 'POST', token: ivan.token,
    body: { name: 'Третий уровень', kind: 'expense', parentId: child.id },
  });
  assert.equal(res.status, 422);
  assert.equal(res.body.error.code, 'too_deep');
});
