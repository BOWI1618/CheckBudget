#!/usr/bin/env bash
#
# Первичная настройка сервера под CheckBudget. Запускается один раз
# от root на чистой Ubuntu/Debian:
#
#   sudo deploy/bin/provision.sh budget.example.com
#
# Скрипт идемпотентен: повторный запуск ничего не ломает и НЕ перегенерирует
# секреты, если файл окружения уже есть. Это важно — новый JWT_SECRET
# разлогинил бы всех, а новый пароль базы просто оборвал бы приложению доступ.
set -euo pipefail

DOMAIN="${1:-}"
if [[ -z "$DOMAIN" ]]; then
  echo "Использование: sudo $0 <домен>" >&2
  exit 1
fi
if [[ $EUID -ne 0 ]]; then
  echo "Нужны права root: sudo $0 $DOMAIN" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APP_USER=checkbudget
APP_DIR=/opt/checkbudget
ENV_DIR=/etc/checkbudget
ENV_FILE="$ENV_DIR/checkbudget.env"
DB_NAME=checkbudget

say() { printf '\n\033[1m→ %s\033[0m\n' "$1"; }

# ── Пакеты ────────────────────────────────────────────────────────────────
say "Устанавливаю пакеты"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq \
  ca-certificates curl gnupg git rsync \
  nginx postgresql postgresql-contrib \
  certbot python3-certbot-nginx

# ── Node 22 ───────────────────────────────────────────────────────────────
# Версия не «посвежее», а именно 22+: приложение импортирует встроенный
# node:sqlite, которого в 20-й ветке нет, и падает на старте ещё до того,
# как дойдёт до выбора Postgres.
need_node=1
if command -v node >/dev/null 2>&1; then
  major="$(node -p 'process.versions.node.split(".")[0]')"
  minor="$(node -p 'process.versions.node.split(".")[1]')"
  if (( major > 22 )) || { (( major == 22 )) && (( minor >= 5 )); }; then need_node=0; fi
fi
if (( need_node )); then
  say "Ставлю Node 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -qq nodejs
fi
node --version

# ── Пользователь и каталоги ───────────────────────────────────────────────
say "Пользователь и каталоги"
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"
mkdir -p "$APP_DIR" "$ENV_DIR" /var/backups/checkbudget
chown -R "$APP_USER:$APP_USER" "$APP_DIR" /var/backups/checkbudget
chmod 750 /var/backups/checkbudget

# ── База ──────────────────────────────────────────────────────────────────
psql_su() { sudo -u postgres psql -v ON_ERROR_STOP=1 -q "$@"; }

if ! psql_su -tAc "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'" | grep -q 1; then
  say "Создаю базу $DB_NAME"
  sudo -u postgres createdb "$DB_NAME"
fi

if [[ -f "$ENV_FILE" ]]; then
  say "Файл окружения уже есть — секреты не трогаю"
  # shellcheck disable=SC1090
  set -a; source "$ENV_FILE"; set +a
else
  say "Генерирую секреты и роли базы"
  JWT_SECRET="$(openssl rand -hex 32)"
  OWNER_PW="$(openssl rand -hex 24)"
  APP_PW="$(openssl rand -hex 24)"
  REPL_PW="$(openssl rand -hex 24)"

  # Роли создаются только если их ещё нет. Пароли передаются переменными
  # psql: в roles.sql их нет намеренно — файл лежит в репозитории.
  if ! psql_su -d "$DB_NAME" -tAc "SELECT 1 FROM pg_roles WHERE rolname='checkbudget_owner'" | grep -q 1; then
    psql_su -d "$DB_NAME" \
      -v owner_pw="$OWNER_PW" -v app_pw="$APP_PW" -v repl_pw="$REPL_PW" \
      -f "$ROOT/db/postgres/roles.sql"
  else
    echo "Роли уже существуют — задаю им новые пароли"
    psql_su -d "$DB_NAME" -c "ALTER ROLE checkbudget_owner      PASSWORD '$OWNER_PW'"
    psql_su -d "$DB_NAME" -c "ALTER ROLE checkbudget_app        PASSWORD '$APP_PW'"
    psql_su -d "$DB_NAME" -c "ALTER ROLE checkbudget_replicator PASSWORD '$REPL_PW'"
  fi

  install -o root -g "$APP_USER" -m 0640 /dev/null "$ENV_FILE"
  sed -e "s|__DOMAIN__|$DOMAIN|g" "$ROOT/deploy/env.example" > "$ENV_FILE"
  sed -i \
    -e "s|^JWT_SECRET=.*|JWT_SECRET=$JWT_SECRET|" \
    -e "s|^DATABASE_URL=.*|DATABASE_URL=postgres://checkbudget_app:$APP_PW@127.0.0.1:5432/$DB_NAME|" \
    -e "s|^DATABASE_REPLICATION_URL=.*|DATABASE_REPLICATION_URL=postgres://checkbudget_replicator:$REPL_PW@127.0.0.1:5432/$DB_NAME|" \
    "$ENV_FILE"
  chown root:"$APP_USER" "$ENV_FILE"
  chmod 0640 "$ENV_FILE"

  # Пароль владельца в окружение приложения НЕ попадает: схему применяет
  # человек, а приложение не должно уметь её менять.
  install -o root -g root -m 0600 /dev/null "$ENV_DIR/owner.env"
  echo "DATABASE_MIGRATION_URL=postgres://checkbudget_owner:$OWNER_PW@127.0.0.1:5432/$DB_NAME" > "$ENV_DIR/owner.env"
fi

# ── Схема и права ─────────────────────────────────────────────────────────
say "Применяю схему"
# shellcheck disable=SC1091
set -a; source "$ENV_DIR/owner.env"; set +a
OWNER_URL="$DATABASE_MIGRATION_URL"

if psql_su -d "$DB_NAME" -tAc \
    "SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='budgets'" | grep -q 1; then
  echo "Схема уже применена"
else
  psql -v ON_ERROR_STOP=1 -q -d "$OWNER_URL" -f "$ROOT/db/postgres/schema.sql"
  psql -v ON_ERROR_STOP=1 -q -d "$OWNER_URL" -f "$ROOT/db/postgres/grants.sql"
  echo "Схема применена и права выданы"
fi

# ── nginx ─────────────────────────────────────────────────────────────────
say "Настраиваю nginx"
SITE=/etc/nginx/sites-available/checkbudget
# Конфиг после certbot содержит его правки. Перезаписать файл значило бы
# снести TLS-блок и редирект, а следом за ними и сайт.
if grep -q 'ssl_certificate' "$SITE" 2>/dev/null; then
  echo "Конфиг уже дополнен certbot — не трогаю"
else
  sed "s|__DOMAIN__|$DOMAIN|g" "$ROOT/deploy/nginx/checkbudget.conf" > "$SITE"
fi
ln -sf "$SITE" /etc/nginx/sites-enabled/checkbudget
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl enable --quiet nginx
systemctl restart nginx

# Firewall. Правило добавляется, только если ufw УЖЕ включён: включать его
# самому нельзя — если правило для SSH не заведено, команда обрывает
# текущую сессию вместе с доступом к серверу.
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q '^Status: active'; then
  ufw allow 'Nginx Full' >/dev/null && echo "ufw: открыты 80 и 443"
else
  echo "ufw выключен или не установлен — правила не трогаю"
fi

# Проверка снаружи здесь невозможна, поэтому хотя бы изнутри: слушает ли
# кто-нибудь 80-й порт. Закрытый снаружи порт — вторая по частоте причина
# провала certbot после отсутствующей A-записи, и провайдер может резать
# его своим firewall, до которого с сервера не дотянуться.
ss -lntp 2>/dev/null | grep -q ':80 ' \
  && echo "80-й порт слушается локально" \
  || echo "ВНИМАНИЕ: 80-й порт локально не слушается — certbot не пройдёт"


# ── systemd ───────────────────────────────────────────────────────────────
say "Ставлю юниты systemd"
install -m 0644 "$ROOT/deploy/systemd/checkbudget.service" /etc/systemd/system/
install -m 0644 "$ROOT/deploy/systemd/checkbudget-backup.service" /etc/systemd/system/
install -m 0644 "$ROOT/deploy/systemd/checkbudget-backup.timer" /etc/systemd/system/
install -m 0755 "$ROOT/deploy/bin/backup.sh" /usr/local/bin/checkbudget-backup
systemctl daemon-reload
systemctl enable --now checkbudget-backup.timer

cat <<DONE

Готово. Дальше по порядку:

  1) Сертификат:      sudo certbot --nginx -d $DOMAIN
  2) Первый релиз:    sudo $ROOT/deploy/bin/release.sh
  3) Проверка:        curl -s https://$DOMAIN/health ; systemctl status checkbudget

Секреты лежат в $ENV_FILE (root:$APP_USER, 0640).
Пароль владельца схемы — в $ENV_DIR/owner.env (root, 0600), приложению он не виден.
DONE
