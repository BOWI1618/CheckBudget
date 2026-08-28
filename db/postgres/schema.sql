-- CheckBudget — продакшен-схема (PostgreSQL 16).
--
-- Отличия от SQLite-версии (server/src/db/schema.sql) — только в типах
-- и в наличии RLS. Модель данных, имена и инварианты идентичны:
-- переезд не требует изменений в прикладном коде, кроме драйвера БД.
--
-- Ключевая добавка — Row Level Security. Это ВТОРОЙ рубеж защиты, а не
-- замена проверок в приложении: даже забытый `WHERE budget_id = ?` не приведёт
-- к утечке чужого бюджета, потому что политика отсечёт строки на уровне БД.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "citext";

CREATE TYPE member_role     AS ENUM ('owner', 'editor', 'viewer');
CREATE TYPE account_type    AS ENUM ('cash', 'card', 'bank', 'ewallet', 'savings');
CREATE TYPE category_kind   AS ENUM ('expense', 'income');
CREATE TYPE tx_type         AS ENUM ('expense', 'income', 'transfer');
CREATE TYPE event_op        AS ENUM ('insert', 'update', 'delete');

-- ─────────────────────────────── Пользователи ───────────────────────────────

CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         CITEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE user_settings (
  user_id           UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  base_currency     CHAR(3) NOT NULL DEFAULT 'RUB',
  display_currency  CHAR(3),
  locale            TEXT NOT NULL DEFAULT 'ru-RU',
  theme             TEXT NOT NULL DEFAULT 'system' CHECK (theme IN ('light','dark','system')),
  default_budget_id UUID,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE refresh_tokens (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_id  UUID NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  used_at    TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON refresh_tokens (user_id);
CREATE INDEX ON refresh_tokens (family_id);

-- Задел под OAuth (Яндекс ID, Google). В MVP не используется.
CREATE TABLE user_identities (
  provider    TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, provider_id)
);

-- ──────────────────────────────── Валюты ────────────────────────────────────

CREATE TABLE currencies (
  code      CHAR(3) PRIMARY KEY,
  name_ru   TEXT NOT NULL,
  symbol    TEXT NOT NULL,
  exponent  SMALLINT NOT NULL CHECK (exponent BETWEEN 0 AND 4),
  is_active BOOLEAN NOT NULL DEFAULT TRUE
);

-- Курс — рациональное число. NUMERIC тоже подошёл бы, но пара BIGINT
-- делает невозможным даже случайное приведение курса к float в приложении.
CREATE TABLE exchange_rates (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  base_code  CHAR(3) NOT NULL REFERENCES currencies(code),
  quote_code CHAR(3) NOT NULL REFERENCES currencies(code),
  rate_num   BIGINT NOT NULL CHECK (rate_num > 0),
  rate_den   BIGINT NOT NULL CHECK (rate_den > 0),
  valid_on   DATE NOT NULL,
  source     TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (base_code, quote_code, valid_on, source)
);
CREATE INDEX ON exchange_rates (base_code, quote_code, valid_on DESC);

-- ──────────────────────────────── Бюджеты ───────────────────────────────────

CREATE TABLE budgets (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  base_currency CHAR(3) NOT NULL REFERENCES currencies(code),
  owner_id      UUID NOT NULL REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  version       INTEGER NOT NULL DEFAULT 1,
  archived_at   TIMESTAMPTZ
);

CREATE TABLE budget_members (
  budget_id  UUID NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       member_role NOT NULL,
  invited_by UUID REFERENCES users(id),
  joined_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (budget_id, user_id)
);
CREATE INDEX ON budget_members (user_id);

CREATE TABLE budget_invites (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  budget_id  UUID NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
  code_hash  TEXT NOT NULL UNIQUE,
  role       member_role NOT NULL CHECK (role <> 'owner'),
  created_by UUID NOT NULL REFERENCES users(id),
  expires_at TIMESTAMPTZ NOT NULL,
  max_uses   INTEGER NOT NULL DEFAULT 1,
  uses       INTEGER NOT NULL DEFAULT 0,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON budget_invites (budget_id);

-- ───────────────────────── Счета, категории, операции ───────────────────────

CREATE TABLE accounts (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  budget_id             UUID NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
  name                  TEXT NOT NULL,
  type                  account_type NOT NULL,
  currency              CHAR(3) NOT NULL REFERENCES currencies(code),
  initial_balance_minor BIGINT NOT NULL DEFAULT 0,
  color                 TEXT NOT NULL DEFAULT '#6366f1',
  icon                  TEXT NOT NULL DEFAULT 'wallet',
  is_archived           BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order            INTEGER NOT NULL DEFAULT 0,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  version               INTEGER NOT NULL DEFAULT 1,
  deleted_at            TIMESTAMPTZ
);
CREATE INDEX ON accounts (budget_id) WHERE deleted_at IS NULL;

CREATE TABLE categories (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  budget_id  UUID NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
  parent_id  UUID REFERENCES categories(id),
  name       TEXT NOT NULL,
  kind       category_kind NOT NULL,
  icon       TEXT NOT NULL DEFAULT 'tag',
  color      TEXT NOT NULL DEFAULT '#6366f1',
  is_system  BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  version    INTEGER NOT NULL DEFAULT 1,
  deleted_at TIMESTAMPTZ
);
CREATE INDEX ON categories (budget_id) WHERE deleted_at IS NULL;
CREATE INDEX ON categories (parent_id);

CREATE TABLE transactions (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  budget_id            UUID NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
  type                 tx_type NOT NULL,
  account_id           UUID NOT NULL REFERENCES accounts(id),
  counter_account_id   UUID REFERENCES accounts(id),
  category_id          UUID REFERENCES categories(id),

  -- Исходный факт: неизменяем.
  amount_minor         BIGINT NOT NULL CHECK (amount_minor > 0),
  currency             CHAR(3) NOT NULL REFERENCES currencies(code),

  -- Замороженный результат конвертации + всё для его воспроизведения.
  base_amount_minor    BIGINT,
  base_currency        CHAR(3) NOT NULL REFERENCES currencies(code),
  rate_num             BIGINT,
  rate_den             BIGINT,
  rate_date            DATE,
  rate_source          TEXT,

  counter_amount_minor BIGINT,
  counter_currency     CHAR(3) REFERENCES currencies(code),

  occurred_on          DATE NOT NULL,
  note                 TEXT,
  created_by           UUID NOT NULL REFERENCES users(id),
  updated_by           UUID NOT NULL REFERENCES users(id),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  version              INTEGER NOT NULL DEFAULT 1,
  deleted_at           TIMESTAMPTZ,

  CONSTRAINT transfer_needs_counter CHECK (type <> 'transfer' OR counter_account_id IS NOT NULL),
  CONSTRAINT non_transfer_needs_category CHECK (type = 'transfer' OR category_id IS NOT NULL),
  CONSTRAINT rate_is_complete CHECK (
    (base_amount_minor IS NULL AND rate_num IS NULL)
    OR (base_amount_minor IS NOT NULL AND rate_num IS NOT NULL AND rate_den > 0)
  )
);
CREATE INDEX ON transactions (budget_id, occurred_on DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX ON transactions (budget_id, category_id, occurred_on) WHERE deleted_at IS NULL;
CREATE INDEX ON transactions (budget_id, account_id, occurred_on) WHERE deleted_at IS NULL;
CREATE INDEX ON transactions (counter_account_id) WHERE deleted_at IS NULL;

CREATE TABLE budget_limits (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  budget_id   UUID NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
  category_id UUID NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  period      CHAR(7) NOT NULL,
  limit_minor BIGINT NOT NULL CHECK (limit_minor >= 0),
  currency    CHAR(3) NOT NULL REFERENCES currencies(code),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  version     INTEGER NOT NULL DEFAULT 1,
  UNIQUE (budget_id, category_id, period)
);
CREATE INDEX ON budget_limits (budget_id, period);

CREATE TABLE goals (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  budget_id    UUID NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  target_minor BIGINT NOT NULL CHECK (target_minor > 0),
  saved_minor  BIGINT NOT NULL DEFAULT 0,
  currency     CHAR(3) NOT NULL REFERENCES currencies(code),
  due_on       DATE,
  icon         TEXT NOT NULL DEFAULT 'target',
  color        TEXT NOT NULL DEFAULT '#10b981',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  version      INTEGER NOT NULL DEFAULT 1,
  deleted_at   TIMESTAMPTZ
);
CREATE INDEX ON goals (budget_id) WHERE deleted_at IS NULL;

-- ─────────────────── Журнал событий (transactional outbox) ──────────────────
-- Партиционирование по месяцам: ретеншен реализуется через DROP PARTITION,
-- а не через DELETE по миллионам строк.

CREATE TABLE events (
  seq             BIGSERIAL,
  budget_id       UUID NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
  entity          TEXT NOT NULL,
  entity_id       UUID NOT NULL,
  op              event_op NOT NULL,
  actor_id        UUID NOT NULL,
  actor_client_id TEXT,
  payload         JSONB NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (seq, created_at)
) PARTITION BY RANGE (created_at);

CREATE INDEX ON events (budget_id, seq);

CREATE TABLE idempotency_keys (
  key          TEXT NOT NULL,
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_hash TEXT NOT NULL,
  status_code  SMALLINT NOT NULL,
  response     JSONB NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (key, user_id)
);
CREATE INDEX ON idempotency_keys (created_at);

-- ──────────────────────── Row Level Security ────────────────────────────────
-- Приложение выполняет `SET LOCAL app.user_id = '<uuid>'` в начале каждой
-- транзакции. Роль приложения НЕ должна быть суперпользователем и НЕ должна
-- иметь BYPASSRLS — иначе политики не применяются.

CREATE OR REPLACE FUNCTION app_user_id() RETURNS UUID AS $$
  SELECT NULLIF(current_setting('app.user_id', TRUE), '')::UUID;
$$ LANGUAGE SQL STABLE;

CREATE OR REPLACE FUNCTION is_member(target UUID) RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM budget_members
     WHERE budget_id = target AND user_id = app_user_id()
  );
$$ LANGUAGE SQL STABLE SECURITY DEFINER;

CREATE OR REPLACE FUNCTION can_write(target UUID) RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM budget_members
     WHERE budget_id = target AND user_id = app_user_id()
       AND role IN ('owner', 'editor')
  );
$$ LANGUAGE SQL STABLE SECURITY DEFINER;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['accounts','categories','transactions','budget_limits','goals','events']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I_read ON %I FOR SELECT USING (is_member(budget_id))', t, t);
  END LOOP;

  -- Запись разрешена только owner/editor. events пишутся тем же соединением,
  -- что и сама мутация, поэтому политика та же.
  FOREACH t IN ARRAY ARRAY['accounts','categories','transactions','budget_limits','goals','events']
  LOOP
    EXECUTE format(
      'CREATE POLICY %I_write ON %I FOR INSERT WITH CHECK (can_write(budget_id))', t, t);
    EXECUTE format(
      'CREATE POLICY %I_update ON %I FOR UPDATE USING (can_write(budget_id)) WITH CHECK (can_write(budget_id))', t, t);
    EXECUTE format(
      'CREATE POLICY %I_delete ON %I FOR DELETE USING (can_write(budget_id))', t, t);
  END LOOP;
END $$;

ALTER TABLE budgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE budgets FORCE ROW LEVEL SECURITY;
CREATE POLICY budgets_read ON budgets FOR SELECT USING (is_member(id));
CREATE POLICY budgets_write ON budgets FOR UPDATE
  USING (owner_id = app_user_id()) WITH CHECK (owner_id = app_user_id());

ALTER TABLE budget_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE budget_members FORCE ROW LEVEL SECURITY;
CREATE POLICY members_read ON budget_members FOR SELECT USING (is_member(budget_id));

-- Партиция журнала на текущий месяц. В проде создаётся плановой задачей
-- на месяц вперёд, старые удаляются DROP TABLE по истечении ретеншена.
CREATE TABLE events_default PARTITION OF events DEFAULT;
