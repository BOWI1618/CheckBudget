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

ALTER SCHEMA public OWNER TO checkbudget_owner;

-- Расширения ставит суперпользователь: владельцу схемы это не положено.
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "citext";
