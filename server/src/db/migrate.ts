/**
 * Применение схемы PostgreSQL.
 *
 * Отдельная команда, а не шаг старта сервера: миграции выполняет роль-владелец,
 * а приложение ходит другой ролью, которая намеренно не владеет таблицами.
 * Если совместить их в одной роли, RLS перестанет применяться к приложению
 * везде, где не включён FORCE — молча, без единой ошибки в логах.
 *
 *   DATABASE_MIGRATION_URL=postgres://owner:...@host/db \
 *   npm run db:migrate --workspace=server
 */
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const SCHEMA = join(here, '../../../db/postgres/schema.sql');

async function main(): Promise<void> {
  const url = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
  if (!url) {
    console.error('Нужен DATABASE_MIGRATION_URL (или DATABASE_URL) от имени владельца схемы');
    process.exit(1);
  }

  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const exists = await client.query(
      `SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'budgets'`,
    );
    if (exists.rowCount) {
      console.log('Схема уже применена — ничего не делаю.');
      return;
    }
    await client.query(readFileSync(SCHEMA, 'utf8'));
    console.log('Схема PostgreSQL применена.');
  } finally {
    await client.end();
  }
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
