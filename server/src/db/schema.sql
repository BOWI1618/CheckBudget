-- CheckBudget — схема данных (SQLite, MVP).
-- Соответствующий Postgres-DDL с RLS: db/postgres/schema.sql
--
-- Инварианты, зашитые в схему:
--   1. Все денежные величины — INTEGER в минорных единицах валюты. Никаких REAL.
--   2. Каждая изменяемая сущность имеет version INTEGER — основа оптимистичных блокировок.
--   3. Всё, что принадлежит бюджету, имеет budget_id и составной индекс с ним:
--      это делает невозможным дешёвый запрос без скоупа по бюджету.
--   4. Удаление операций/счетов/категорий — мягкое (deleted_at), чтобы конфликт
--      "удалено на одном устройстве / изменено на другом" был разрешим.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ─────────────────────────────── Пользователи ───────────────────────────────

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL,
  email_lower   TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,           -- scrypt: N$r$p$salt$hash
  display_name  TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_settings (
  user_id          TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  base_currency    TEXT NOT NULL DEFAULT 'RUB',
  display_currency TEXT,
  locale           TEXT NOT NULL DEFAULT 'ru-RU',
  theme            TEXT NOT NULL DEFAULT 'system' CHECK (theme IN ('light','dark','system')),
  default_budget_id TEXT,
  updated_at       TEXT NOT NULL
);

-- Refresh-токены. Хранится только SHA-256 хеш.
-- family_id объединяет цепочку ротаций: повторное использование уже
-- использованного токена = сигнал кражи -> отзывается вся семья.
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_id  TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  used_at    TEXT,
  revoked_at TEXT,
  expires_at TEXT NOT NULL,
  user_agent TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_refresh_user   ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_family ON refresh_tokens(family_id);

CREATE TABLE IF NOT EXISTS password_resets (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  used_at    TEXT,
  created_at TEXT NOT NULL
);

-- ──────────────────────────────── Валюты ────────────────────────────────────

CREATE TABLE IF NOT EXISTS currencies (
  code      TEXT PRIMARY KEY,            -- ISO 4217
  name_ru   TEXT NOT NULL,
  symbol    TEXT NOT NULL,
  exponent  INTEGER NOT NULL,            -- знаков после запятой
  is_active INTEGER NOT NULL DEFAULT 1
);

-- Курс — рациональное число rate_num/rate_den, а не float.
CREATE TABLE IF NOT EXISTS exchange_rates (
  id        TEXT PRIMARY KEY,
  base_code TEXT NOT NULL REFERENCES currencies(code),
  quote_code TEXT NOT NULL REFERENCES currencies(code),
  rate_num  INTEGER NOT NULL,
  rate_den  INTEGER NOT NULL CHECK (rate_den > 0),
  valid_on  TEXT NOT NULL,               -- YYYY-MM-DD
  source    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (base_code, quote_code, valid_on, source)
);
CREATE INDEX IF NOT EXISTS idx_rates_lookup ON exchange_rates(base_code, quote_code, valid_on DESC);

-- ──────────────────────────────── Бюджеты ───────────────────────────────────

CREATE TABLE IF NOT EXISTS budgets (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  base_currency TEXT NOT NULL REFERENCES currencies(code),
  owner_id      TEXT NOT NULL REFERENCES users(id),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  version       INTEGER NOT NULL DEFAULT 1,
  archived_at   TEXT
);

CREATE TABLE IF NOT EXISTS budget_members (
  budget_id  TEXT NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('owner','editor','viewer')),
  invited_by TEXT REFERENCES users(id),
  joined_at  TEXT NOT NULL,
  PRIMARY KEY (budget_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_members_user ON budget_members(user_id);

CREATE TABLE IF NOT EXISTS budget_invites (
  id         TEXT PRIMARY KEY,
  budget_id  TEXT NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
  code_hash  TEXT NOT NULL UNIQUE,       -- код в открытом виде не хранится
  role       TEXT NOT NULL CHECK (role IN ('editor','viewer')),
  created_by TEXT NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL,
  max_uses   INTEGER NOT NULL DEFAULT 1,
  uses       INTEGER NOT NULL DEFAULT 0,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_invites_budget ON budget_invites(budget_id);

-- ───────────────────────── Счета, категории, операции ───────────────────────

CREATE TABLE IF NOT EXISTS accounts (
  id                   TEXT PRIMARY KEY,
  budget_id            TEXT NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
  name                 TEXT NOT NULL,
  type                 TEXT NOT NULL CHECK (type IN ('cash','card','bank','ewallet','savings')),
  currency             TEXT NOT NULL REFERENCES currencies(code),
  initial_balance_minor INTEGER NOT NULL DEFAULT 0,
  color                TEXT NOT NULL DEFAULT '#6366f1',
  icon                 TEXT NOT NULL DEFAULT 'wallet',
  is_archived          INTEGER NOT NULL DEFAULT 0,
  sort_order           INTEGER NOT NULL DEFAULT 0,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  version              INTEGER NOT NULL DEFAULT 1,
  deleted_at           TEXT
);
CREATE INDEX IF NOT EXISTS idx_accounts_budget ON accounts(budget_id, deleted_at);

CREATE TABLE IF NOT EXISTS categories (
  id         TEXT PRIMARY KEY,
  budget_id  TEXT NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
  parent_id  TEXT REFERENCES categories(id),
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('expense','income')),
  icon       TEXT NOT NULL DEFAULT 'tag',
  color      TEXT NOT NULL DEFAULT '#6366f1',
  is_system  INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version    INTEGER NOT NULL DEFAULT 1,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_categories_budget ON categories(budget_id, deleted_at);
CREATE INDEX IF NOT EXISTS idx_categories_parent ON categories(parent_id);

-- Операция. Хранит и исходный факт (amount_minor + currency), и замороженный
-- результат конвертации (base_amount_minor + курс). Изменение курса в справочнике
-- НИКОГДА не меняет уже записанную операцию.
CREATE TABLE IF NOT EXISTS transactions (
  id                  TEXT PRIMARY KEY,
  budget_id           TEXT NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
  type                TEXT NOT NULL CHECK (type IN ('expense','income','transfer')),
  account_id          TEXT NOT NULL REFERENCES accounts(id),
  counter_account_id  TEXT REFERENCES accounts(id),
  category_id         TEXT REFERENCES categories(id),

  amount_minor        INTEGER NOT NULL CHECK (amount_minor > 0),
  currency            TEXT NOT NULL REFERENCES currencies(code),

  base_amount_minor   INTEGER,           -- NULL = курс на дату отсутствует
  base_currency       TEXT NOT NULL REFERENCES currencies(code),
  rate_num            INTEGER,
  rate_den            INTEGER,
  rate_date           TEXT,
  rate_source         TEXT,

  counter_amount_minor INTEGER,          -- только для переводов
  counter_currency     TEXT REFERENCES currencies(code),

  occurred_on         TEXT NOT NULL,     -- календарная дата, не timestamp
  note                TEXT,
  created_by          TEXT NOT NULL REFERENCES users(id),
  updated_by          TEXT NOT NULL REFERENCES users(id),
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  version             INTEGER NOT NULL DEFAULT 1,
  deleted_at          TEXT,

  CHECK (type <> 'transfer' OR counter_account_id IS NOT NULL),
  CHECK (type =  'transfer' OR category_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_tx_budget_date  ON transactions(budget_id, occurred_on DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_tx_budget_cat   ON transactions(budget_id, category_id, occurred_on);
CREATE INDEX IF NOT EXISTS idx_tx_budget_acc   ON transactions(budget_id, account_id, occurred_on);
CREATE INDEX IF NOT EXISTS idx_tx_counter_acc  ON transactions(counter_account_id);

CREATE TABLE IF NOT EXISTS budget_limits (
  id          TEXT PRIMARY KEY,
  budget_id   TEXT NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
  category_id TEXT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  period      TEXT NOT NULL,             -- YYYY-MM
  limit_minor INTEGER NOT NULL CHECK (limit_minor >= 0),
  currency    TEXT NOT NULL REFERENCES currencies(code),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  version     INTEGER NOT NULL DEFAULT 1,
  UNIQUE (budget_id, category_id, period)
);
CREATE INDEX IF NOT EXISTS idx_limits_period ON budget_limits(budget_id, period);

CREATE TABLE IF NOT EXISTS goals (
  id           TEXT PRIMARY KEY,
  budget_id    TEXT NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  target_minor INTEGER NOT NULL CHECK (target_minor > 0),
  saved_minor  INTEGER NOT NULL DEFAULT 0,
  currency     TEXT NOT NULL REFERENCES currencies(code),
  due_on       TEXT,
  icon         TEXT NOT NULL DEFAULT 'target',
  color        TEXT NOT NULL DEFAULT '#10b981',
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  version      INTEGER NOT NULL DEFAULT 1,
  deleted_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_goals_budget ON goals(budget_id, deleted_at);

-- ─────────────────── Журнал событий (transactional outbox) ──────────────────
-- Пишется в ОДНОЙ транзакции с мутацией. seq монотонно возрастает и даёт
-- клиенту возможность догрузить хвост после переподключения вместо
-- полной перезагрузки данных.

CREATE TABLE IF NOT EXISTS events (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  budget_id  TEXT NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
  entity     TEXT NOT NULL,
  entity_id  TEXT NOT NULL,
  op         TEXT NOT NULL CHECK (op IN ('insert','update','delete')),
  actor_id   TEXT NOT NULL,
  -- Устройство, а не пользователь: два устройства одного человека — это
  -- ровно тот сценарий, ради которого сделана синхронизация, и «своё»
  -- изменение для одного из них является чужим для другого.
  actor_client_id TEXT,
  payload    TEXT NOT NULL,              -- JSON
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_budget_seq ON events(budget_id, seq);

-- Идемпотентность мутаций. Повтор запроса с тем же ключом возвращает
-- сохранённый ответ вместо создания дубля.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key          TEXT NOT NULL,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_hash TEXT NOT NULL,
  status_code  INTEGER NOT NULL,
  response     TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (key, user_id)
);
CREATE INDEX IF NOT EXISTS idx_idem_created ON idempotency_keys(created_at);
