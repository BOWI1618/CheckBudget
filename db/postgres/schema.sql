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
--
-- Модель ролей. Их ДВЕ, и это принципиально:
--
--   checkbudget_owner — владелец схемы. Выполняет миграции. Приложение
--                       им не пользуется.
--   checkbudget_app   — роль приложения. НЕ владелец, NOSUPERUSER, NOBYPASSRLS.
--                       Именно к ней применяются политики.
--
-- Если приложение ходит владельцем таблиц, RLS для него не работает нигде,
-- где не включён FORCE — то есть весь второй рубеж защиты молча исчезает.
--
-- Приложение выполняет `SET LOCAL app.user_id = '<uuid>'` в начале каждой
-- транзакции; на этом значении держатся все политики.

CREATE OR REPLACE FUNCTION app_user_id() RETURNS UUID AS $$
  SELECT NULLIF(current_setting('app.user_id', TRUE), '')::UUID;
$$ LANGUAGE SQL STABLE;

-- Функции проверки прав читают budget_members и budgets. Они SECURITY DEFINER,
-- то есть выполняются от имени владельца схемы, который обходит RLS этих таблиц.
--
-- Именно поэтому на budget_members и budgets НЕ включается FORCE ROW LEVEL
-- SECURITY: под FORCE политики применяются и к владельцу, и тогда политика
-- budget_members начинает вызывать is_member(), который читает budget_members —
-- Postgres обрывает это ошибкой «infinite recursion detected in policy».
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

-- Отдельная функция для владельца бюджета. Без неё невозможно записать
-- первого участника: в момент создания бюджета его автор ещё не член,
-- и политика, опирающаяся на членство, отвергла бы вставку самого себя.
CREATE OR REPLACE FUNCTION is_budget_owner(target UUID) RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM budgets WHERE id = target AND owner_id = app_user_id()
  );
$$ LANGUAGE SQL STABLE SECURITY DEFINER;

-- ── Данные бюджета ──────────────────────────────────────────────────────────
-- Здесь FORCE уместен: эти таблицы не читаются функциями проверки прав,
-- поэтому рекурсии не возникает, а защита действует даже на владельца.

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['accounts','categories','transactions','budget_limits','goals']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);

    EXECUTE format(
      'CREATE POLICY %I_read ON %I FOR SELECT USING (is_member(budget_id))', t, t);
    EXECUTE format(
      'CREATE POLICY %I_insert ON %I FOR INSERT WITH CHECK (can_write(budget_id))', t, t);
    EXECUTE format(
      'CREATE POLICY %I_update ON %I FOR UPDATE USING (can_write(budget_id)) WITH CHECK (can_write(budget_id))', t, t);
    EXECUTE format(
      'CREATE POLICY %I_delete ON %I FOR DELETE USING (can_write(budget_id))', t, t);
  END LOOP;
END $$;

-- ── Журнал событий ──────────────────────────────────────────────────────────
-- Политики отличаются от остальных таблиц бюджета по двум причинам.
--
-- 1. Запись разрешена любому участнику, а не только owner/editor.
--    Событие пишет сервер как побочный эффект законной операции, и такие
--    операции есть и у наблюдателя: присоединение к бюджету по приглашению
--    порождает событие о составе участников. Проверка can_write отвергала бы
--    его — при том, что сама операция полностью легитимна. Изменить данные
--    наблюдатель всё равно не может: это отсекают политики других таблиц.
--
-- 2. UPDATE и DELETE не разрешены НИКОМУ. Журнал append-only по существу:
--    на его seq держится вся синхронизация, и задним числом переписанное
--    событие означало бы разъехавшиеся клиенты. Ретеншен выполняется
--    владельцем схемы через DROP PARTITION, а не удалением строк.
ALTER TABLE events ENABLE ROW LEVEL SECURITY;
ALTER TABLE events FORCE ROW LEVEL SECURITY;

CREATE POLICY events_read ON events FOR SELECT
  USING (is_member(budget_id));
CREATE POLICY events_insert ON events FOR INSERT
  WITH CHECK (is_member(budget_id));

-- Рассылка событий между инстансами читает журнал вне контекста пользователя,
-- поэтому ей нужна отдельная политика. Она привязана к КОНКРЕТНОЙ роли
-- (TO checkbudget_replicator) — роль приложения под неё не подпадает
-- и по-прежнему видит только события своих бюджетов.
CREATE POLICY events_replication ON events FOR SELECT
  TO checkbudget_replicator
  USING (TRUE);

-- ── Бюджеты ─────────────────────────────────────────────────────────────────
-- RLS без FORCE: см. комментарий к is_budget_owner выше.

ALTER TABLE budgets ENABLE ROW LEVEL SECURITY;

-- Владелец видит свой бюджет ДО того, как появится строка в budget_members.
--
-- Это не удобство, а необходимость: под RLS `INSERT ... RETURNING` прогоняет
-- возвращаемую строку через SELECT-политику. Проверка только по членству
-- означала бы, что создание бюджета падает с «new row violates row-level
-- security policy» — при том, что сам INSERT политику проходит.
-- Ошибка выглядит как проблема записи, а на деле её вызывает чтение.
CREATE POLICY budgets_read ON budgets FOR SELECT
  USING (is_member(id) OR owner_id = app_user_id());

-- Создать бюджет может любой аутентифицированный пользователь, но только
-- на собственное имя: owner_id обязан совпадать с текущим пользователем.
-- Без этой политики RLS запрещал бы вставку вообще — и приложение
-- не смогло бы создать ни одного бюджета.
CREATE POLICY budgets_insert ON budgets FOR INSERT
  WITH CHECK (owner_id = app_user_id());

CREATE POLICY budgets_update ON budgets FOR UPDATE
  USING (owner_id = app_user_id()) WITH CHECK (owner_id = app_user_id());

CREATE POLICY budgets_delete ON budgets FOR DELETE
  USING (owner_id = app_user_id());

-- ── Участники ───────────────────────────────────────────────────────────────

ALTER TABLE budget_members ENABLE ROW LEVEL SECURITY;

-- Три условия, а не одно, и каждое нужно:
--   own    — человек всегда видит собственное членство. Без этого
--            `INSERT ... RETURNING` при добавлении участника падает:
--            is_member объявлена STABLE и не видит строку, которую сама
--            же вставляемая команда ещё не зафиксировала;
--   owner  — владелец бюджета видит весь состав, включая только что добавленных;
--   member — участники видят друг друга.
CREATE POLICY members_read ON budget_members FOR SELECT
  USING (
    user_id = app_user_id()
    OR is_budget_owner(budget_id)
    OR is_member(budget_id)
  );

-- Состав участников меняет владелец бюджета — и, отдельным случаем,
-- сам приглашённый в момент приёма кода.
--
-- is_budget_owner смотрит на budgets.owner_id, а не на членство, поэтому
-- работает и при создании бюджета, когда участников ещё нет.
--
-- Второе условие закрывает приём приглашения: человек может добавить
-- ТОЛЬКО САМ СЕБЯ и только в тот бюджет, для которого предъявил
-- действующий код. Хеш кода лежит в переменной транзакции, поэтому
-- подставить чужой budget_id не получится.
CREATE POLICY members_insert ON budget_members FOR INSERT
  WITH CHECK (
    is_budget_owner(budget_id)
    OR (
      user_id = app_user_id()
      AND EXISTS (
        SELECT 1 FROM budget_invites i
         WHERE i.budget_id = budget_members.budget_id
           AND i.code_hash = current_setting('app.invite_code_hash', TRUE)
      )
    )
  );

CREATE POLICY members_update ON budget_members FOR UPDATE
  USING (is_budget_owner(budget_id)) WITH CHECK (is_budget_owner(budget_id));

-- Владелец исключает участников; участник может выйти сам.
CREATE POLICY members_delete ON budget_members FOR DELETE
  USING (is_budget_owner(budget_id) OR user_id = app_user_id());

-- ── Приглашения ─────────────────────────────────────────────────────────────
-- Приглашения содержат хеш кода доступа, поэтому закрываются наравне
-- с данными бюджета. Принять приглашение по коду можно и не будучи
-- участником — этот путь идёт через SECURITY DEFINER функцию приложения.

ALTER TABLE budget_invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE budget_invites FORCE ROW LEVEL SECURITY;

-- Владелец видит приглашения своего бюджета.
--
-- Приглашение принимает человек, который участником ЕЩЁ НЕ является —
-- проверка по членству отвергла бы его. Право доступа здесь даёт знание
-- секрета: приложение кладёт хеш предъявленного кода в app.invite_code_hash
-- на время транзакции, и видимой становится ровно одна строка — та,
-- чей хеш уже известен. Перебрать таблицу это не позволяет.
CREATE POLICY invites_read ON budget_invites FOR SELECT
  USING (
    is_budget_owner(budget_id)
    OR code_hash = current_setting('app.invite_code_hash', TRUE)
  );

CREATE POLICY invites_insert ON budget_invites FOR INSERT
  WITH CHECK (is_budget_owner(budget_id));

-- UPDATE нужен и принимающему: приём увеличивает счётчик использований.
CREATE POLICY invites_update ON budget_invites FOR UPDATE
  USING (
    is_budget_owner(budget_id)
    OR code_hash = current_setting('app.invite_code_hash', TRUE)
  )
  WITH CHECK (
    is_budget_owner(budget_id)
    OR code_hash = current_setting('app.invite_code_hash', TRUE)
  );

-- ── Персональные данные пользователя ────────────────────────────────────────
-- Настройки, сессии и ключи идемпотентности принадлежат одному человеку
-- и никогда не должны читаться другим — даже при ошибке в коде.

ALTER TABLE user_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY settings_own ON user_settings FOR ALL
  USING (user_id = app_user_id()) WITH CHECK (user_id = app_user_id());

ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY idempotency_own ON idempotency_keys FOR ALL
  USING (user_id = app_user_id()) WITH CHECK (user_id = app_user_id());

-- refresh_tokens намеренно БЕЗ RLS: они проверяются до того, как
-- app.user_id вообще известен — по хешу токена. Политика на user_id
-- сделала бы вход невозможным. Доступ к таблице ограничивается тем,
-- что обращается к ней только модуль аутентификации.

-- Партиция журнала на текущий месяц. В проде создаётся плановой задачей
-- на месяц вперёд, старые удаляются DROP TABLE по истечении ретеншена.
CREATE TABLE events_default PARTITION OF events DEFAULT;
