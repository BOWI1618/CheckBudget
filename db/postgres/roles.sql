-- Роли для развёртывания. Выполняется суперпользователем ОДИН раз,
-- до применения schema.sql.
--
-- Ролей две, и это принципиально:
--   checkbudget_owner — владелец схемы, выполняет миграции;
--   checkbudget_app   — роль приложения, НЕ владелец таблиц.
--
-- Если приложение ходит владельцем, RLS для него не действует нигде,
-- где не включён FORCE, и второй рубеж защиты исчезает молча.
-- Пароли здесь — заглушки для разработки; в проде задаются при развёртывании.

CREATE ROLE checkbudget_owner LOGIN PASSWORD 'ownerpass' NOSUPERUSER NOBYPASSRLS;
CREATE ROLE checkbudget_app   LOGIN PASSWORD 'apppass'   NOSUPERUSER NOBYPASSRLS;

-- Третья роль — для рассылки событий между инстансами.
--
-- Читает ТОЛЬКО журнал событий и ничего больше. Обойтись ролью приложения
-- нельзя: рассылка происходит вне запроса пользователя, app.user_id указать
-- неоткуда, и RLS вернул бы пустоту. Давать же приложению право читать
-- события всех бюджетов означало бы снять весь второй рубеж защиты.
CREATE ROLE checkbudget_replicator LOGIN PASSWORD 'replpass' NOSUPERUSER NOBYPASSRLS;

ALTER SCHEMA public OWNER TO checkbudget_owner;

-- Расширения ставит суперпользователь: владельцу схемы это не положено.
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "citext";
