-- Права роли приложения. Выполняется владельцем схемы ПОСЛЕ schema.sql.
--
-- Приложению даются только операции над данными. Права на изменение схемы
-- не выдаются намеренно: миграции — работа отдельной роли.

GRANT USAGE ON SCHEMA public TO checkbudget_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO checkbudget_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO checkbudget_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO checkbudget_app;

-- Рассылке событий доступен журнал и ровно две колонки таблицы пользователей.
--
-- Имя автора нужно, чтобы клиент показал «Иван изменил операцию». Права
-- на таблицу целиком для этого не требуются: колоночный GRANT оставляет
-- недоступными email и хеш пароля.
GRANT USAGE ON SCHEMA public TO checkbudget_replicator;
GRANT SELECT ON events TO checkbudget_replicator;
GRANT SELECT (id, display_name) ON users TO checkbudget_replicator;

-- Таблицы, созданные будущими миграциями, тоже должны быть доступны.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO checkbudget_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO checkbudget_app;
