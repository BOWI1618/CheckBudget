#!/usr/bin/env bash
#
# Выкат новой версии. Запускается от root в каталоге приложения:
#
#   sudo /opt/checkbudget/deploy/bin/release.sh
#
# Собирает клиент и сервер, применяет недостающие миграции схемы
# и перезапускает службу. Собирает В КАТАЛОГЕ ПРИЛОЖЕНИЯ, а не рядом:
# сборка клиента зависит от версий пакетов, и «собрал здесь — скопировал
# туда» рано или поздно даёт расхождение, которое ищется полдня.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/checkbudget}"
APP_USER=checkbudget
ENV_DIR=/etc/checkbudget

if [[ $EUID -ne 0 ]]; then
  echo "Нужны права root: sudo $0" >&2
  exit 1
fi

cd "$APP_DIR"
say() { printf '\n\033[1m→ %s\033[0m\n' "$1"; }

say "Забираю изменения"
git fetch --quiet origin
BEFORE="$(git rev-parse --short HEAD)"
git reset --hard --quiet origin/main
AFTER="$(git rev-parse --short HEAD)"
echo "$BEFORE → $AFTER"

say "Устанавливаю зависимости"
npm ci --silent

say "Проверяю типы и тесты"
# Выкат без проверки — способ узнать о поломке от людей, а не от тестов.
# На 2 ГБ это занимает меньше минуты.
npm run typecheck
npm test

say "Собираю"
npm run build

say "Применяю миграции схемы"
# От имени владельца схемы: приложение менять её не должно и не умеет.
# Если новых миграций нет, команда сообщает об этом и выходит.
# shellcheck disable=SC1091
set -a; source "$ENV_DIR/owner.env"; set +a
npm run db:migrate --workspace=server

say "Права на файлы"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"
# nginx читает статику от www-data: каталог должен быть проходим извне.
chmod 755 "$APP_DIR"
find "$APP_DIR/web/dist" -type d -exec chmod 755 {} +
find "$APP_DIR/web/dist" -type f -exec chmod 644 {} +

say "Перезапускаю службу"
systemctl restart checkbudget
sleep 2
systemctl is-active --quiet checkbudget || {
  echo "Служба не поднялась. Логи:" >&2
  journalctl -u checkbudget -n 40 --no-pager >&2
  exit 1
}

# Проверяем не «процесс жив», а «отвечает»: упавшее на старте подключение
# к базе оставило бы процесс живым и бесполезным.
for i in $(seq 1 10); do
  if curl -fsS -m 3 http://127.0.0.1:3001/health >/dev/null; then
    echo
    curl -s http://127.0.0.1:3001/health
    echo
    echo "Готово: $AFTER выкачен."
    exit 0
  fi
  sleep 1
done

echo "Служба запущена, но /health не отвечает. Логи:" >&2
journalctl -u checkbudget -n 40 --no-pager >&2
exit 1
