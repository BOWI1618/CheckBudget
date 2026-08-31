#!/usr/bin/env bash
#
# Ночной бэкап базы. Ставится как /usr/local/bin/checkbudget-backup,
# запускается таймером systemd.
#
# ВАЖНО, ПОЧЕМУ ОТ postgres, А НЕ ОТ ВЛАДЕЛЬЦА СХЕМЫ.
# На таблицах включён FORCE ROW LEVEL SECURITY, и он действует НА ВЛАДЕЛЬЦА
# ТОЖЕ. pg_dump от checkbudget_owner отработает без единой ошибки и выгрузит
# пустые таблицы: файл нужного вида, нужного примерно размера и без данных.
# Обнаруживается такое ровно в тот день, когда бэкап понадобился.
# Суперпользователь RLS не подчиняется — поэтому postgres.
set -euo pipefail

DB="${CHECKBUDGET_DB:-checkbudget}"
DIR="${CHECKBUDGET_BACKUP_DIR:-/var/backups/checkbudget}"
KEEP_DAYS="${CHECKBUDGET_BACKUP_KEEP_DAYS:-14}"
STAMP="$(date +%Y%m%d-%H%M%S)"
RAW="$DIR/checkbudget-$STAMP.sql"

mkdir -p "$DIR"

# Сколько строк в базе на самом деле — узнаём ДО выгрузки.
live="$(sudo -u postgres psql -tAq -d "$DB" -c 'SELECT count(*) FROM transactions')"

sudo -u postgres pg_dump --format=plain --no-owner --no-privileges "$DB" > "$RAW"

# Сколько строк доехало до файла. Секция COPY идёт до строки «\.».
dumped="$(awk '
  /^COPY public\.transactions /{inside=1; next}
  inside && /^\\\.$/{inside=0}
  inside{n++}
  END{print n+0}
' "$RAW")"

if [[ "$live" -gt 0 && "$dumped" -eq 0 ]]; then
  rm -f "$RAW"
  echo "БЭКАП ПУСТОЙ: в базе $live операций, в выгрузке 0." >&2
  echo "Почти наверняка pg_dump выполнен ролью, на которую действует RLS." >&2
  exit 1
fi

gzip -9 "$RAW"
chmod 0600 "$RAW.gz"
echo "Бэкап готов: $RAW.gz ($dumped операций из $live)"

# Старые чистим последними: если удаление упадёт, свежий бэкап уже на месте.
find "$DIR" -name 'checkbudget-*.sql.gz' -mtime "+$KEEP_DAYS" -delete
