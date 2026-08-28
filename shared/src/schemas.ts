import { z } from 'zod';
import { isKnownCurrency } from './currencies.js';
import { MAX_MINOR } from './money.js';

/**
 * Денежная сумма в транспорте — СТРОКА целого числа минорных единиц.
 * Это исключает любую возможность попадания суммы в float при парсинге JSON
 * на любом клиенте (JS, Swift, Kotlin — везде).
 */
export const minorAmount = z
  .union([z.string(), z.number()])
  .transform((v, ctx) => {
    const s = typeof v === 'number' ? String(v) : v.trim();
    if (!/^-?\d+$/.test(s)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Сумма должна быть целым числом минорных единиц' });
      return z.NEVER;
    }
    const n = Number(s);
    if (!Number.isSafeInteger(n) || Math.abs(n) > MAX_MINOR) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Сумма превышает допустимый предел' });
      return z.NEVER;
    }
    return n;
  });

export const positiveMinorAmount = minorAmount.refine((n) => n > 0, 'Сумма должна быть больше нуля');

export const currencyCode = z.string().length(3).toUpperCase().refine(isKnownCurrency, 'Неизвестная валюта');

export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Дата в формате ГГГГ-ММ-ДД');
export const period = z.string().regex(/^\d{4}-\d{2}$/, 'Период в формате ГГГГ-ММ');
export const uuid = z.string().uuid();
export const version = z.number().int().positive();
export const role = z.enum(['owner', 'editor', 'viewer']);

export const registerSchema = z.object({
  email: z.string().email('Некорректный email').max(254).toLowerCase(),
  password: z.string().min(8, 'Пароль минимум 8 символов').max(200),
  displayName: z.string().trim().min(1, 'Укажите имя').max(80),
});

export const loginSchema = z.object({
  email: z.string().email().max(254).toLowerCase(),
  password: z.string().min(1).max(200),
});

export const settingsSchema = z.object({
  baseCurrency: currencyCode.optional(),
  displayCurrency: currencyCode.nullable().optional(),
  theme: z.enum(['light', 'dark', 'system']).optional(),
  defaultBudgetId: uuid.nullable().optional(),
});

export const createBudgetSchema = z.object({
  name: z.string().trim().min(1, 'Укажите название').max(80),
  baseCurrency: currencyCode,
});

export const updateBudgetSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  version,
});

export const createAccountSchema = z.object({
  name: z.string().trim().min(1, 'Укажите название').max(80),
  type: z.enum(['cash', 'card', 'bank', 'ewallet', 'savings']),
  currency: currencyCode,
  initialBalanceMinor: minorAmount.default(0),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#6366f1'),
  icon: z.string().max(24).default('wallet'),
});

export const updateAccountSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  type: z.enum(['cash', 'card', 'bank', 'ewallet', 'savings']).optional(),
  initialBalanceMinor: minorAmount.optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  icon: z.string().max(24).optional(),
  isArchived: z.boolean().optional(),
  version,
});

export const createCategorySchema = z.object({
  name: z.string().trim().min(1, 'Укажите название').max(60),
  kind: z.enum(['expense', 'income']),
  parentId: uuid.nullable().default(null),
  icon: z.string().max(24).default('tag'),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#6366f1'),
});

export const updateCategorySchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  parentId: uuid.nullable().optional(),
  icon: z.string().max(24).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  version,
});

export const createTransactionSchema = z
  .object({
    type: z.enum(['expense', 'income', 'transfer']),
    accountId: uuid,
    counterAccountId: uuid.nullable().default(null),
    categoryId: uuid.nullable().default(null),
    amountMinor: positiveMinorAmount,
    currency: currencyCode,
    counterAmountMinor: positiveMinorAmount.nullable().default(null),
    occurredOn: isoDate,
    note: z.string().trim().max(500).nullable().default(null),
  })
  .superRefine((v, ctx) => {
    if (v.type === 'transfer') {
      if (!v.counterAccountId) {
        ctx.addIssue({ code: 'custom', path: ['counterAccountId'], message: 'Укажите счёт назначения' });
      }
      if (v.counterAccountId === v.accountId) {
        ctx.addIssue({ code: 'custom', path: ['counterAccountId'], message: 'Счета должны различаться' });
      }
    } else if (!v.categoryId) {
      ctx.addIssue({ code: 'custom', path: ['categoryId'], message: 'Выберите категорию' });
    }
  });

export const updateTransactionSchema = z.object({
  accountId: uuid.optional(),
  counterAccountId: uuid.nullable().optional(),
  categoryId: uuid.nullable().optional(),
  amountMinor: positiveMinorAmount.optional(),
  currency: currencyCode.optional(),
  counterAmountMinor: positiveMinorAmount.nullable().optional(),
  occurredOn: isoDate.optional(),
  note: z.string().trim().max(500).nullable().optional(),
  version,
});

export const putLimitSchema = z.object({
  categoryId: uuid,
  period,
  limitMinor: minorAmount,
});

export const createGoalSchema = z.object({
  name: z.string().trim().min(1).max(80),
  targetMinor: positiveMinorAmount,
  savedMinor: minorAmount.default(0),
  currency: currencyCode,
  dueOn: isoDate.nullable().default(null),
  icon: z.string().max(24).default('target'),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#10b981'),
});

export const updateGoalSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  targetMinor: positiveMinorAmount.optional(),
  savedMinor: minorAmount.optional(),
  dueOn: isoDate.nullable().optional(),
  icon: z.string().max(24).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  version,
});

export const createInviteSchema = z.object({
  role: z.enum(['editor', 'viewer']),
  expiresInHours: z.number().int().min(1).max(24 * 30).default(72),
});

export const acceptInviteSchema = z.object({ code: z.string().trim().min(6).max(40) });
export const updateMemberSchema = z.object({ role: z.enum(['editor', 'viewer']) });

export const deleteSchema = z.object({ version });

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type CreateTransactionInput = z.infer<typeof createTransactionSchema>;
export type UpdateTransactionInput = z.infer<typeof updateTransactionSchema>;
export type CreateAccountInput = z.infer<typeof createAccountSchema>;
export type CreateCategoryInput = z.infer<typeof createCategorySchema>;
