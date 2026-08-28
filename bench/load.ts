/**
 * Нагрузочная проба.
 *
 * Не «сколько выдержит прод» — для этого нужна настоящая среда. Задача проще
 * и полезнее: увидеть, во что упирается сервер при конкурентных запросах,
 * и сравнить состояние до и после изменений. Поэтому меряются перцентили,
 * а не среднее: среднее прячет ровно те задержки, из-за которых интерфейс
 * кажется медленным.
 *
 *   npx tsx bench/load.ts [--url http://localhost:3001] [--conc 20] [--sec 8]
 */
const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1]!;
};

const BASE = arg('url', 'http://localhost:3001') + '/api/v1';
const CONCURRENCY = Number(arg('conc', '20'));
const SECONDS = Number(arg('sec', '8'));
const EMAIL = arg('email', 'ivan@example.com');
const PASSWORD = arg('password', 'demo12345');

interface Sample { ms: number; ok: boolean }

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index]!;
}

function report(name: string, samples: Sample[], seconds: number): void {
  const ok = samples.filter((s) => s.ok);
  const times = ok.map((s) => s.ms).sort((a, b) => a - b);
  const failed = samples.length - ok.length;
  const rps = samples.length / seconds;
  console.log(
    `${name.padEnd(26)} ${String(Math.round(rps)).padStart(6)} rps   ` +
    `p50 ${percentile(times, 50).toFixed(0).padStart(4)} ms   ` +
    `p95 ${percentile(times, 95).toFixed(0).padStart(5)} ms   ` +
    `p99 ${percentile(times, 99).toFixed(0).padStart(5)} ms` +
    (failed ? `   ОШИБОК: ${failed}` : ''),
  );
}

async function login(): Promise<string> {
  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`Вход не удался: ${res.status} ${await res.text()}`);
  return (await res.json()).accessToken;
}

async function measure(
  name: string,
  request: () => Promise<Response>,
): Promise<void> {
  const samples: Sample[] = [];
  const deadline = Date.now() + SECONDS * 1000;

  // Фиксированное число параллельных «клиентов»: каждый шлёт следующий
  // запрос сразу после ответа. Так нагрузка не выходит за пределы,
  // которые сервер реально успевает обработать.
  const worker = async () => {
    while (Date.now() < deadline) {
      const started = performance.now();
      try {
        const res = await request();
        await res.arrayBuffer();
        samples.push({ ms: performance.now() - started, ok: res.ok });
      } catch {
        samples.push({ ms: performance.now() - started, ok: false });
      }
    }
  };

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  report(name, samples, SECONDS);
}

async function main(): Promise<void> {
  const token = await login();
  const auth = { authorization: `Bearer ${token}` };

  const budgets = await (await fetch(`${BASE}/budgets`, { headers: auth })).json();
  const budgetId = budgets.items[0].id;

  const snapshot = await (await fetch(`${BASE}/budgets/${budgetId}/snapshot`, { headers: auth })).json();
  const accountId = snapshot.accounts[0].id;
  const categoryId = snapshot.categories.find((c: { kind: string }) => c.kind === 'expense').id;

  console.log(`\nПараллельных клиентов: ${CONCURRENCY}, по ${SECONDS} с на сценарий\n`);

  await measure('снимок бюджета', () =>
    fetch(`${BASE}/budgets/${budgetId}/snapshot`, { headers: auth }));

  await measure('список операций', () =>
    fetch(`${BASE}/budgets/${budgetId}/transactions?limit=100`, { headers: auth }));

  await measure('счета (баланс — агрегат)', () =>
    fetch(`${BASE}/budgets/${budgetId}/accounts`, { headers: auth }));

  await measure('лимиты с прогрессом', () =>
    fetch(`${BASE}/budgets/${budgetId}/limits`, { headers: auth }));

  await measure('аналитика по категориям', () =>
    fetch(`${BASE}/budgets/${budgetId}/analytics/by-category`, { headers: auth }));

  await measure('создание операции', () => {
    const snapshotDate = new Date().toISOString().slice(0, 10);
    return fetch(`${BASE}/budgets/${budgetId}/transactions`, {
      method: 'POST',
      headers: {
        ...auth,
        'content-type': 'application/json',
        'idempotency-key': crypto.randomUUID(),
      },
      body: JSON.stringify({
        type: 'expense',
        accountId,
        categoryId,
        amountMinor: '10000',
        currency: 'RUB',
        occurredOn: snapshotDate,
      }),
    });
  });
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
