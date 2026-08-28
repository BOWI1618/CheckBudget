import type { FastifyInstance } from 'fastify';
import {
  createTransactionSchema,
  updateTransactionSchema,
  deleteSchema,
  type CreateTransactionInput,
  type UpdateTransactionInput,
} from '@checkbudget/shared';
import { db } from '../db/index.js';
import { mutate, type Emit } from '../core/events.js';
import { requireMember, type Membership } from '../core/permissions.js';
import { notFound, unprocessable, VersionConflictError } from '../core/errors.js';
import { newId, nowIso } from '../core/ids.js';
import { convertToBase } from '../core/rates.js';
import { requireAuth, parseBody, idempotent } from '../http/helpers.js';
import { toTransaction, type TransactionRow } from './mappers.js';

const SELECT_TX = 'SELECT * FROM transactions';

function findTx(budgetId: string, id: string): TransactionRow {
  // Скоуп по budget_id обязателен: без него подмена id в URL дала бы
  // доступ к чужой операции. Метода поиска «просто по id» в коде нет.
  const row = db.get<TransactionRow>(
    `${SELECT_TX} WHERE budget_id = ? AND id = ? AND deleted_at IS NULL`,
    budgetId,
    id,
  );
  if (!row) throw notFound('Операция не найдена');
  return row;
}

/**
 * Проверка ссылочной целостности В ПРЕДЕЛАХ БЮДЖЕТА.
 *
 * Это третий рубеж защиты и самый часто пропускаемый: без него участник
 * бюджета A смог бы записать операцию на счёт из бюджета B, просто передав
 * чужой account_id — членство в бюджете A у него ведь есть.
 */
function requireAccount(budgetId: string, accountId: string) {
  const acc = db.get<{ id: string; currency: string; name: string }>(
    'SELECT id, currency, name FROM accounts WHERE budget_id = ? AND id = ? AND deleted_at IS NULL',
    budgetId,
    accountId,
  );
  if (!acc) throw unprocessable('unknown_account', 'Счёт не найден в этом бюджете');
  return acc;
}

function requireCategory(budgetId: string, categoryId: string, type: string) {
  const cat = db.get<{ id: string; kind: string }>(
    'SELECT id, kind FROM categories WHERE budget_id = ? AND id = ? AND deleted_at IS NULL',
    budgetId,
    categoryId,
  );
  if (!cat) throw unprocessable('unknown_category', 'Категория не найдена в этом бюджете');
  if (cat.kind !== type) {
    throw unprocessable(
      'category_kind_mismatch',
      type === 'expense' ? 'Это категория доходов' : 'Это категория расходов',
    );
  }
  return cat;
}

/**
 * Валюта операции обязана совпадать с валютой счёта.
 *
 * Это не ограничение мультивалютности, а условие корректности: баланс счёта
 * должен быть однозначным числом в одной валюте. Если вы расплатились евро
 * рублёвой картой — банк списал рубли, и записывать нужно рубли.
 * Мультивалютность живёт на уровне счетов и базовой валюты бюджета.
 */
function checkCurrencyMatchesAccount(accountCurrency: string, currency: string, accountName: string) {
  if (accountCurrency !== currency) {
    throw unprocessable(
      'currency_mismatch',
      `Счёт «${accountName}» ведётся в ${accountCurrency} — операция должна быть в этой же валюте`,
    );
  }
}

export function createTransaction(
  member: Membership,
  input: CreateTransactionInput,
  emit: Emit,
): TransactionRow {
  const account = requireAccount(member.budgetId, input.accountId);
  checkCurrencyMatchesAccount(account.currency, input.currency, account.name);

  let counterAmountMinor: number | null = null;
  let counterCurrency: string | null = null;

  if (input.type === 'transfer') {
    const counter = requireAccount(member.budgetId, input.counterAccountId!);
    counterCurrency = counter.currency;
    // При переводе между счетами в разных валютах обе стороны задаются явно:
    // курс обмена определяет банк, а не наш справочник.
    if (counter.currency === account.currency) {
      counterAmountMinor = input.counterAmountMinor ?? input.amountMinor;
      if (counterAmountMinor !== input.amountMinor) {
        throw unprocessable(
          'transfer_amount_mismatch',
          'Для перевода внутри одной валюты суммы должны совпадать',
        );
      }
    } else if (input.counterAmountMinor == null) {
      throw unprocessable(
        'counter_amount_required',
        `Укажите сумму зачисления в ${counter.currency}`,
      );
    } else {
      counterAmountMinor = input.counterAmountMinor;
    }
  } else {
    requireCategory(member.budgetId, input.categoryId!, input.type);
  }

  // Курс замораживается здесь и больше никогда не пересчитывается.
  const conv = convertToBase(input.amountMinor, input.currency, member.baseCurrency, input.occurredOn);

  const id = newId();
  const ts = nowIso();
  db.run(
    `INSERT INTO transactions (
       id, budget_id, type, account_id, counter_account_id, category_id,
       amount_minor, currency, base_amount_minor, base_currency,
       rate_num, rate_den, rate_date, rate_source,
       counter_amount_minor, counter_currency,
       occurred_on, note, created_by, updated_by, created_at, updated_at, version
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)`,
    id, member.budgetId, input.type, input.accountId,
    input.type === 'transfer' ? input.counterAccountId : null,
    input.type === 'transfer' ? null : input.categoryId,
    input.amountMinor, input.currency,
    conv.baseAmountMinor, member.baseCurrency,
    conv.rateNum, conv.rateDen, conv.rateDate, conv.rateSource,
    counterAmountMinor, counterCurrency,
    input.occurredOn, input.note, member.userId, member.userId, ts, ts,
  );

  const row = findTx(member.budgetId, id);
  emit({
    budgetId: member.budgetId,
    entity: 'transaction',
    entityId: id,
    op: 'insert',
    actorId: member.userId,
    payload: toTransaction(row),
  });
  return row;
}

export function updateTransaction(
  member: Membership,
  id: string,
  input: UpdateTransactionInput,
  emit: Emit,
): TransactionRow {
  const current = findTx(member.budgetId, id);

  // Оптимистичная блокировка. Клиент прислал версию, на которой основывал
  // своё изменение; если она устарела — возвращаем 409 с актуальным состоянием,
  // и решение принимает пользователь. Молча перезаписать чужое изменение нельзя.
  if (current.version !== input.version) {
    throw new VersionConflictError(toTransaction(current));
  }

  const next = {
    accountId: input.accountId ?? current.account_id,
    counterAccountId:
      input.counterAccountId !== undefined ? input.counterAccountId : current.counter_account_id,
    categoryId: input.categoryId !== undefined ? input.categoryId : current.category_id,
    amountMinor: input.amountMinor ?? current.amount_minor,
    currency: input.currency ?? current.currency,
    counterAmountMinor:
      input.counterAmountMinor !== undefined ? input.counterAmountMinor : current.counter_amount_minor,
    occurredOn: input.occurredOn ?? current.occurred_on,
    note: input.note !== undefined ? input.note : current.note,
  };

  const account = requireAccount(member.budgetId, next.accountId);
  checkCurrencyMatchesAccount(account.currency, next.currency, account.name);

  let counterCurrency: string | null = null;
  if (current.type === 'transfer') {
    if (!next.counterAccountId) {
      throw unprocessable('counter_account_required', 'Укажите счёт назначения');
    }
    if (next.counterAccountId === next.accountId) {
      throw unprocessable('same_account', 'Счета перевода должны различаться');
    }
    const counter = requireAccount(member.budgetId, next.counterAccountId);
    counterCurrency = counter.currency;
    if (counter.currency === account.currency) {
      next.counterAmountMinor = next.amountMinor;
    } else if (next.counterAmountMinor == null) {
      throw unprocessable('counter_amount_required', `Укажите сумму зачисления в ${counter.currency}`);
    }
  } else {
    if (!next.categoryId) throw unprocessable('category_required', 'Выберите категорию');
    requireCategory(member.budgetId, next.categoryId, current.type);
    next.counterAmountMinor = null;
    next.counterAccountId = null;
  }

  // Пересчёт в базовую валюту нужен только если изменились сумма, валюта или дата.
  const needRecalc =
    next.amountMinor !== current.amount_minor ||
    next.currency !== current.currency ||
    next.occurredOn !== current.occurred_on;

  const conv = needRecalc
    ? convertToBase(next.amountMinor, next.currency, member.baseCurrency, next.occurredOn)
    : {
        baseAmountMinor: current.base_amount_minor,
        rateNum: current.rate_num,
        rateDen: current.rate_den,
        rateDate: current.rate_date,
        rateSource: current.rate_source,
      };

  const ts = nowIso();
  const { changes } = db.run(
    `UPDATE transactions SET
       account_id = ?, counter_account_id = ?, category_id = ?,
       amount_minor = ?, currency = ?,
       base_amount_minor = ?, rate_num = ?, rate_den = ?, rate_date = ?, rate_source = ?,
       counter_amount_minor = ?, counter_currency = ?,
       occurred_on = ?, note = ?, updated_by = ?, updated_at = ?, version = version + 1
     WHERE budget_id = ? AND id = ? AND version = ? AND deleted_at IS NULL`,
    next.accountId, next.counterAccountId, next.categoryId,
    next.amountMinor, next.currency,
    conv.baseAmountMinor, conv.rateNum, conv.rateDen, conv.rateDate, conv.rateSource,
    next.counterAmountMinor, counterCurrency,
    next.occurredOn, next.note, member.userId, ts,
    member.budgetId, id, input.version,
  );

  // Условие version = ? в самом UPDATE — второй барьер против гонки:
  // даже если две транзакции прошли проверку выше одновременно,
  // применится ровно одна.
  if (changes === 0) throw new VersionConflictError(toTransaction(findTx(member.budgetId, id)));

  const row = findTx(member.budgetId, id);
  emit({
    budgetId: member.budgetId,
    entity: 'transaction',
    entityId: id,
    op: 'update',
    actorId: member.userId,
    payload: toTransaction(row),
  });
  return row;
}

export function deleteTransaction(member: Membership, id: string, version: number, emit: Emit): void {
  const current = findTx(member.budgetId, id);
  if (current.version !== version) throw new VersionConflictError(toTransaction(current));

  // Мягкое удаление: строка остаётся как tombstone. Это делает разрешимым
  // конфликт «удалено на телефоне / изменено на ПК» — иначе второе устройство
  // получило бы «объект не найден» без возможности что-либо предложить.
  const ts = nowIso();
  const { changes } = db.run(
    `UPDATE transactions SET deleted_at = ?, updated_by = ?, updated_at = ?, version = version + 1
      WHERE budget_id = ? AND id = ? AND version = ? AND deleted_at IS NULL`,
    ts, member.userId, ts, member.budgetId, id, version,
  );
  if (changes === 0) throw new VersionConflictError(toTransaction(findTx(member.budgetId, id)));

  emit({
    budgetId: member.budgetId,
    entity: 'transaction',
    entityId: id,
    op: 'delete',
    actorId: member.userId,
    payload: { id, version: version + 1, deletedAt: ts },
  });
}

export const transactionRoutes = async (app: FastifyInstance): Promise<void> => {
  app.addHook('preHandler', requireAuth);

  app.get<{ Params: { budgetId: string }; Querystring: Record<string, string> }>(
    '/budgets/:budgetId/transactions',
    async (req) => {
      const member = requireMember(req.userId, req.params.budgetId);
      const q = req.query;
      const where: string[] = ['budget_id = ?', 'deleted_at IS NULL'];
      const params: unknown[] = [member.budgetId];

      if (q.from) { where.push('occurred_on >= ?'); params.push(q.from); }
      if (q.to) { where.push('occurred_on <= ?'); params.push(q.to); }
      if (q.categoryId) { where.push('category_id = ?'); params.push(q.categoryId); }
      if (q.accountId) {
        where.push('(account_id = ? OR counter_account_id = ?)');
        params.push(q.accountId, q.accountId);
      }
      if (q.type) { where.push('type = ?'); params.push(q.type); }
      if (q.q) { where.push('note LIKE ?'); params.push(`%${q.q}%`); }

      // Курсорная пагинация по (occurred_on, id): стабильна при вставках,
      // в отличие от OFFSET, и не деградирует на больших смещениях.
      if (q.cursor) {
        const [date, id] = q.cursor.split('|');
        where.push('(occurred_on < ? OR (occurred_on = ? AND id < ?))');
        params.push(date, date, id);
      }

      const limit = Math.min(Number(q.limit ?? 100) || 100, 500);
      const rows = db.all<TransactionRow>(
        `${SELECT_TX} WHERE ${where.join(' AND ')} ORDER BY occurred_on DESC, id DESC LIMIT ?`,
        ...params,
        limit + 1,
      );
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const last = page[page.length - 1];
      return {
        items: page.map(toTransaction),
        nextCursor: hasMore && last ? `${last.occurred_on}|${last.id}` : null,
      };
    },
  );

  app.post<{ Params: { budgetId: string } }>(
    '/budgets/:budgetId/transactions',
    async (req, reply) => {
      const member = requireMember(req.userId, req.params.budgetId, 'editor');
      const input = parseBody(createTransactionSchema, req.body);
      return idempotent(
        req,
        reply,
        () => mutate((emit) => toTransaction(createTransaction(member, input, emit))),
        201,
      );
    },
  );

  app.patch<{ Params: { budgetId: string; id: string } }>(
    '/budgets/:budgetId/transactions/:id',
    async (req, reply) => {
      const member = requireMember(req.userId, req.params.budgetId, 'editor');
      const input = parseBody(updateTransactionSchema, req.body);
      const { id } = req.params;
      return idempotent(req, reply, () =>
        mutate((emit) => toTransaction(updateTransaction(member, id, input, emit))),
      );
    },
  );

  app.delete<{ Params: { budgetId: string; id: string } }>(
    '/budgets/:budgetId/transactions/:id',
    async (req, reply) => {
      const member = requireMember(req.userId, req.params.budgetId, 'editor');
      const { version } = parseBody(deleteSchema, req.body);
      const { id } = req.params;
      return idempotent(req, reply, () => {
        mutate((emit) => deleteTransaction(member, id, version, emit));
        return { ok: true };
      });
    },
  );
};
