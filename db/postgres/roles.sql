-- Роли для развёртывания. Выполняется суперпользователем ОДИН раз,
-- до применения schema.sql.
--
-- Ролей две, и это принципиально:
--   checkbudget_owner — владелец схемы, выполняет миграции;
--   checkbudget_app   — роль приложения, НЕ владелец таблиц.
--
-- Если приложение ходит владельцем, RLS для него не действует нигде,
-- где не включён FORCE, и второй рубеж защиты исчезает молча.
-- Пароли передаются переменными psql, а не пишутся здесь: файл лежит
-- в репозитории, и любой зашитый в него пароль считается известным всем.
-- Разработка подставляет заглушки (scripts/pg-reset.sh), развёртывание —
-- сгенерированные (deploy/bin/provision.sh).
--
--   psql -v owner_pw=... -v app_pw=... -v repl_pw=... -f roles.sql

CREATE ROLE checkbudget_owner LOGIN PASSWORD :'owner_pw' NOSUPERUSER NOBYPASSRLS;
CREATE ROLE checkbudget_app   LOGIN PASSWORD :'app_pw'   NOSUPERUSER NOBYPASSRLS;

-- Третья роль — для рассылки событий между инстансами.
--
-- Читает ТОЛЬКО журнал событий и ничего больше. Обойтись ролью приложения
-- нельзя: рассылка происходит вне запроса пользователя, app.user_id указать
-- неоткуда, и RLS вернул бы пустоту. Давать же приложению право читать
-- события всех бюджетов означало бы снять весь второй рубеж защиты.
CREATE ROLE checkbudget_replicator LOGIN PASSWORD :'repl_pw' NOSUPERUSER NOBYPASSRLS;

ALTER SCHEMA public OWNER TO checkbudget_owner;

-- Расширения ставит суперпользователь: владельцу схемы это не положено.
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "citext";
