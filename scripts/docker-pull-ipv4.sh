#!/usr/bin/env bash
#
# Обходной путь для машин, где `docker pull` не работает, а сеть есть.
#
# Симптом: демон Docker ходит к реестру по IPv6 и получает connection refused,
# при том что `curl -4 https://registry-1.docker.io/v2/` отвечает нормально.
# Правильное решение — починить IPv6 или заставить демон предпочитать IPv4,
# но это правка системного конфига. Здесь образ скачивается напрямую через
# Registry API и подаётся в `docker load`.
#
#   ./scripts/docker-pull-ipv4.sh /tmp/img && docker load -i /tmp/img/postgres.tar
#
# Проверка, нужен ли обход:
#   docker pull postgres:16-alpine   → «failed to fetch anonymous token … connection refused»
#   curl -4 -s -o /dev/null -w '%{http_code}' https://registry-1.docker.io/v2/   → 401 (сеть есть)
set -euo pipefail

REPO="library/postgres"
TAG="16-alpine"
OUT="$1"
WORK="$OUT/work"
mkdir -p "$WORK/blobs"

CURL=(curl -4 -sSL --retry 3 --retry-delay 2 --connect-timeout 20)

echo "→ токен"
TOKEN=$("${CURL[@]}" "https://auth.docker.io/token?service=registry.docker.io&scope=repository:${REPO}:pull" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')

ACCEPT_LIST='application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.v2+json,application/vnd.oci.image.manifest.v1+json'

echo "→ индекс манифестов"
"${CURL[@]}" -H "Authorization: Bearer $TOKEN" -H "Accept: $ACCEPT_LIST" \
  "https://registry-1.docker.io/v2/${REPO}/manifests/${TAG}" > "$WORK/index.json"

DIGEST=$(python3 - "$WORK/index.json" <<'PY'
import sys, json
doc = json.load(open(sys.argv[1]))
if 'manifests' in doc:
    for m in doc['manifests']:
        p = m.get('platform', {})
        if p.get('architecture') == 'amd64' and p.get('os') == 'linux':
            print(m['digest']); break
    else:
        sys.exit('нет linux/amd64')
else:
    print('')   # уже конкретный манифест
PY
)

if [ -n "$DIGEST" ]; then
  echo "→ манифест linux/amd64: ${DIGEST:0:19}…"
  "${CURL[@]}" -H "Authorization: Bearer $TOKEN" -H "Accept: $ACCEPT_LIST" \
    "https://registry-1.docker.io/v2/${REPO}/manifests/${DIGEST}" > "$WORK/manifest.json"
else
  cp "$WORK/index.json" "$WORK/manifest.json"
fi

CONFIG=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["config"]["digest"])' "$WORK/manifest.json")
LAYERS=$(python3 -c 'import json,sys;[print(l["digest"]) for l in json.load(open(sys.argv[1]))["layers"]]' "$WORK/manifest.json")

echo "→ конфиг"
"${CURL[@]}" -H "Authorization: Bearer $TOKEN" \
  "https://registry-1.docker.io/v2/${REPO}/blobs/${CONFIG}" > "$WORK/${CONFIG#sha256:}.json"

i=0
LAYER_PATHS=()
for L in $LAYERS; do
  i=$((i+1))
  echo "→ слой $i: ${L:0:19}…"
  DIR="$WORK/layer$i"; mkdir -p "$DIR"
  if [ -s "$DIR/layer.tar" ]; then
    echo "   уже скачан"
  else
    # Токен живёт ~5 минут, а крупный слой качается дольше. Без обновления
    # перед каждым слоем сервер отдаёт 401, и в файл попадает JSON с ошибкой
    # вместо данных — gunzip падает с «not in gzip format».
    TOKEN=$("${CURL[@]}" "https://auth.docker.io/token?service=registry.docker.io&scope=repository:${REPO}:pull" \
      | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')
    "${CURL[@]}" -C - -H "Authorization: Bearer $TOKEN" \
      "https://registry-1.docker.io/v2/${REPO}/blobs/${L}" -o "$DIR/layer.tar.gz"
    # Пустой или битый ответ лучше обнаружить сразу, чем на docker load.
    if ! gzip -t "$DIR/layer.tar.gz" 2>/dev/null; then
      echo "   ОШИБКА: слой скачан повреждённым"; head -c 300 "$DIR/layer.tar.gz"; exit 1
    fi
    gunzip -f "$DIR/layer.tar.gz"
  fi
  LAYER_PATHS+=("layer$i/layer.tar")
done

python3 - "$WORK" "${CONFIG#sha256:}.json" "${LAYER_PATHS[@]}" <<'PY'
import sys, json, os
work, config, *layers = sys.argv[1:]
json.dump([{ "Config": config,
             "RepoTags": ["postgres:16-alpine"],
             "Layers": layers }],
          open(os.path.join(work, "manifest.json"), "w"))
PY

echo "→ сборка архива"
tar -C "$WORK" -cf "$OUT/postgres.tar" manifest.json "${CONFIG#sha256:}.json" "${LAYER_PATHS[@]}"
ls -lh "$OUT/postgres.tar"
