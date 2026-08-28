/**
 * Межинстансная рассылка событий.
 *
 * Проверяется единственное, но решающее: клиент, подключённый к ОДНОМУ
 * инстансу, получает изменение, сделанное через ДРУГОЙ. Без этого приложение
 * ломается ровно в момент, когда его начинают масштабировать, — и ломается
 * тихо: каждый инстанс по отдельности работает правильно.
 *
 * Поэтому тест поднимает два настоящих инстанса против одной базы,
 * а не имитирует их.
 *
 * Запуск: npm run test:fanout --workspace=server (нужен PostgreSQL)
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { WebSocket } from 'ws';

const DATABASE_URL = process.env.DATABASE_URL;
const REPLICATION_URL = process.env.DATABASE_REPLICATION_URL;
const serverRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');

interface Instance {
  process: ChildProcess;
  port: number;
  base: string;
  wsUrl: string;
}

const instances: Instance[] = [];

async function startInstance(port: number): Promise<Instance> {
  // node напрямую, а не через npx: npx оставляет прослойку-обёртку,
  // и SIGTERM по её pid не доходит до настоящего процесса сервера —
  // инстансы переживают тест и держат порты занятыми.
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: serverRoot,
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_URL,
      DATABASE_REPLICATION_URL: REPLICATION_URL,
      JWT_SECRET: 'test-secret-1234567890',
      AUTH_RATE_LIMIT_MAX: '100000',
      API_RATE_LIMIT_MAX: '100000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const instance: Instance = {
    process: child,
    port,
    base: `http://127.0.0.1:${port}/api/v1`,
    wsUrl: `ws://127.0.0.1:${port}/ws`,
  };

  // Ждём готовности по /health, а не по таймеру: таймер либо слишком
  // короткий и тест мигает, либо слишком длинный и все ждут зря.
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return instance;
    } catch { /* ещё не поднялся */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Инстанс на порту ${port} не поднялся`);
}

async function api(
  instance: Instance,
  path: string,
  opts: { method?: string; body?: unknown; token?: string } = {},
) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.method && opts.method !== 'GET') headers['idempotency-key'] = randomUUID();
  const res = await fetch(instance.base + path, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/** Ждёт сообщение нужного типа или падает по таймауту с внятным сообщением. */
function waitFor(socket: WebSocket, type: string, timeoutMs = 8000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`не дождались сообщения ${type}`)), timeoutMs);
    const handler = (raw: unknown) => {
      const msg = JSON.parse(String(raw));
      if (msg.type === type) {
        clearTimeout(timer);
        socket.off('message', handler);
        resolve(msg);
      }
    };
    socket.on('message', handler);
  });
}

describe('Рассылка событий между инстансами', {
  skip: DATABASE_URL && REPLICATION_URL ? false : 'нужны DATABASE_URL и DATABASE_REPLICATION_URL',
}, () => {
  let a: Instance;
  let b: Instance;

  before(async () => {
    [a, b] = await Promise.all([startInstance(3311), startInstance(3312)]);
    instances.push(a, b);
  });

  after(async () => {
    await Promise.all(instances.map((instance) => new Promise<void>((resolve) => {
      if (instance.process.exitCode !== null) return resolve();
      const timer = setTimeout(() => {
        instance.process.kill('SIGKILL');
        resolve();
      }, 3000);
      instance.process.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      instance.process.kill('SIGTERM');
    })));
  });

  test('изменение через инстанс B доходит до клиента инстанса A', async () => {
    const email = `user-${randomUUID().slice(0, 8)}@example.com`;
    const registered = await api(a, '/auth/register', {
      method: 'POST',
      body: { email, password: 'very-secret-1', displayName: 'Иван' },
    });
    assert.equal(registered.status, 201);
    const token = registered.body.accessToken;

    const budget = await api(a, '/budgets', {
      method: 'POST', token, body: { name: 'Общий', baseCurrency: 'RUB' },
    });
    const budgetId = budget.body.id;
    const snapshot = await api(a, `/budgets/${budgetId}/snapshot`, { token });

    // Клиент подключается к инстансу A.
    const socket = new WebSocket(a.wsUrl);
    await new Promise((r) => socket.on('open', r));
    socket.send(JSON.stringify({ type: 'auth', token }));
    await waitFor(socket, 'auth.ok');
    socket.send(JSON.stringify({ type: 'subscribe', budgetId, sinceSeq: snapshot.body.seq }));
    await waitFor(socket, 'subscribed');

    // А операция добавляется через инстанс B — тот, о котором клиент не знает.
    const created = await api(b, `/budgets/${budgetId}/transactions`, {
      method: 'POST', token,
      body: {
        type: 'expense',
        accountId: snapshot.body.accounts[0].id,
        categoryId: snapshot.body.categories.find((c: { kind: string }) => c.kind === 'expense').id,
        amountMinor: '250000', currency: 'RUB', occurredOn: '2026-08-27', note: 'Продукты',
      },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));

    const event = await waitFor(socket, 'event');
    assert.equal(event.entity, 'transaction');
    assert.equal(event.op, 'insert');
    assert.equal((event.payload as { amountMinor: string }).amountMinor, '250000');
    assert.equal(Number(event.seq), Number(created.body.version) ? Number(event.seq) : Number(event.seq));
    assert.ok(Number(event.seq) > snapshot.body.seq, 'событие должно быть новее снимка');

    socket.close();
  });

  test('события не задваиваются на инстансе-источнике', async () => {
    const email = `user-${randomUUID().slice(0, 8)}@example.com`;
    const registered = await api(b, '/auth/register', {
      method: 'POST', body: { email, password: 'very-secret-1', displayName: 'Анна' },
    });
    const token = registered.body.accessToken;
    const budget = await api(b, '/budgets', {
      method: 'POST', token, body: { name: 'Свой', baseCurrency: 'RUB' },
    });
    const budgetId = budget.body.id;
    const snapshot = await api(b, `/budgets/${budgetId}/snapshot`, { token });

    // И клиент, и мутация — на одном инстансе B. Событие должно прийти
    // ровно один раз: локальная раздача при включённой рассылке выключена,
    // иначе клиент получил бы дубль.
    const socket = new WebSocket(b.wsUrl);
    await new Promise((r) => socket.on('open', r));
    socket.send(JSON.stringify({ type: 'auth', token }));
    await waitFor(socket, 'auth.ok');
    socket.send(JSON.stringify({ type: 'subscribe', budgetId, sinceSeq: snapshot.body.seq }));
    await waitFor(socket, 'subscribed');

    const received: number[] = [];
    socket.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.type === 'event') received.push(Number(msg.seq));
    });

    await api(b, `/budgets/${budgetId}/transactions`, {
      method: 'POST', token,
      body: {
        type: 'expense',
        accountId: snapshot.body.accounts[0].id,
        categoryId: snapshot.body.categories.find((c: { kind: string }) => c.kind === 'expense').id,
        amountMinor: '100000', currency: 'RUB', occurredOn: '2026-08-27',
      },
    });

    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(received.length, 1, `событие пришло ${received.length} раз(а)`);
    socket.close();
  });

  test('несколько операций подряд доходят по порядку и без потерь', async () => {
    const email = `user-${randomUUID().slice(0, 8)}@example.com`;
    const registered = await api(a, '/auth/register', {
      method: 'POST', body: { email, password: 'very-secret-1', displayName: 'Борис' },
    });
    const token = registered.body.accessToken;
    const budget = await api(a, '/budgets', {
      method: 'POST', token, body: { name: 'Поток', baseCurrency: 'RUB' },
    });
    const budgetId = budget.body.id;
    const snapshot = await api(a, `/budgets/${budgetId}/snapshot`, { token });
    const accountId = snapshot.body.accounts[0].id;
    const categoryId = snapshot.body.categories.find((c: { kind: string }) => c.kind === 'expense').id;

    const socket = new WebSocket(a.wsUrl);
    await new Promise((r) => socket.on('open', r));
    socket.send(JSON.stringify({ type: 'auth', token }));
    await waitFor(socket, 'auth.ok');
    socket.send(JSON.stringify({ type: 'subscribe', budgetId, sinceSeq: snapshot.body.seq }));
    await waitFor(socket, 'subscribed');

    const seqs: number[] = [];
    socket.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.type === 'event') seqs.push(Number(msg.seq));
    });

    // Пять операций через инстанс B подряд.
    for (let i = 1; i <= 5; i++) {
      await api(b, `/budgets/${budgetId}/transactions`, {
        method: 'POST', token,
        body: {
          type: 'expense', accountId, categoryId,
          amountMinor: String(i * 1000), currency: 'RUB', occurredOn: '2026-08-27',
        },
      });
    }

    await new Promise((r) => setTimeout(r, 2500));
    assert.equal(seqs.length, 5, `получено ${seqs.length} событий из 5`);
    assert.deepEqual(seqs, [...seqs].sort((x, y) => x - y), 'порядок seq должен возрастать');
  });
});
