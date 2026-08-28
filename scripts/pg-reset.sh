#!/usr/bin/env bash
# Пересоздаёт локальную базу Postgres целиком: роли, схема, права.
#
# Только для разработки и тестов. В проде эти три шага выполняются
# по отдельности и разными ролями: суперпользователь заводит роли,
# владелец схемы применяет DDL и выдаёт права приложению.
#
# psql берётся из контейнера, чтобы не требовать клиента на хосте.
set -euo pipefail

CONTAINER="${PG_CONTAINER:-checkbudget-pg}"
DB="${PG_DB:-checkbudget}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

run_as() {  # run_as <пользователь> <файл|->
  docker exec -i -e PGPASSWORD="$2" "$CONTAINER" \
    psql -v ON_ERROR_STOP=1 -q -U "$1" -h 127.0.0.1 -d "$DB"
}

# Роли живут в кластере, а не в схеме, поэтому чистим их отдельно.
run_as postgres devpass <<'SQL'
DROP SCHEMA IF EXISTS public CASCADE;
CREATE SCHEMA public;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'checkbudget_app') THEN
    EXECUTE 'DROP OWNED BY checkbudget_app';
    EXECUTE 'DROP ROLE checkbudget_app';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'checkbudget_owner') THEN
    EXECUTE 'DROP OWNED BY checkbudget_owner';
    EXECUTE 'DROP ROLE checkbudget_owner';
  END IF;
END $$;
SQL

run_as postgres devpass          < "$ROOT/db/postgres/roles.sql"
run_as checkbudget_owner ownerpass < "$ROOT/db/postgres/schema.sql"
run_as checkbudget_owner ownerpass < "$ROOT/db/postgres/grants.sql"

echo "База пересоздана: схема применена владельцем, права выданы роли приложения."
