#!/usr/bin/env bash
# A second, non-colliding local stack for QA runs: Postgres (pgvector) on
# 5433, Redis on 6380, the API on 4100 and vite on 3102. Nothing here touches
# the docker-compose stack on 4000/3002/5432/6379.
#
#   scripts/dev-stack.sh up      start containers, API and frontend
#   scripts/dev-stack.sh down    stop everything this script started
#   scripts/dev-stack.sh status  ports + health
#
# The API is started with OLLAMA_ALLOW_PRIVATE_URLS=true so an Ollama-typed
# provider may point at a localhost fake server (the models E2E specs start
# one), MODEL_RECONCILE_CRON at every minute so deployments settle quickly,
# and the price feed off. Logs land in $LOG_DIR (default: /tmp/almyty-qa).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="${LOG_DIR:-/tmp/almyty-qa}"
PG_NAME="${PG_NAME:-almyty-qa-pg}"
REDIS_NAME="${REDIS_NAME:-almyty-qa-redis}"
PG_PORT="${PG_PORT:-5433}"
REDIS_PORT="${REDIS_PORT:-6380}"
API_PORT="${API_PORT:-4100}"
WEB_PORT="${WEB_PORT:-3102}"
# The memory migration needs the vector extension, so plain postgres will not do.
PG_IMAGE="${PG_IMAGE:-pgvector/pgvector:pg16}"

mkdir -p "$LOG_DIR"

api_env() {
  env PORT="$API_PORT" NODE_ENV=development \
    DATABASE_HOST=localhost DATABASE_PORT="$PG_PORT" DATABASE_USERNAME=postgres DATABASE_PASSWORD=postgres DATABASE_NAME=almyty_qa DB_SSL=false \
    REDIS_HOST=localhost REDIS_PORT="$REDIS_PORT" \
    JWT_SECRET="${JWT_SECRET:-qa-jwt-secret-0123456789abcdef0123456789}" \
    JWT_REFRESH_SECRET="${JWT_REFRESH_SECRET:-qa-refresh-secret-0123456789abcdef}" \
    ENCRYPTION_KEY="${ENCRYPTION_KEY:-qa-encryption-key-32-bytes-minimum!!}" \
    FRONTEND_URL="http://localhost:$WEB_PORT" CORS_ORIGIN="http://localhost:$WEB_PORT" \
    BASE_URL="http://localhost:$API_PORT" API_BASE_URL="http://localhost:$API_PORT" \
    OLLAMA_ALLOW_PRIVATE_URLS=true MODEL_RECONCILE_CRON='*/1 * * * *' MODEL_PRICE_FEED_DISABLED=true \
    "$@"
}

up() {
  docker inspect "$PG_NAME" >/dev/null 2>&1 || docker run -d --name "$PG_NAME" \
    -e POSTGRES_PASSWORD=postgres -e POSTGRES_USER=postgres -e POSTGRES_DB=almyty_qa \
    -p "$PG_PORT:5432" "$PG_IMAGE" >/dev/null
  docker inspect "$REDIS_NAME" >/dev/null 2>&1 || docker run -d --name "$REDIS_NAME" -p "$REDIS_PORT:6379" redis:7-alpine >/dev/null
  docker start "$PG_NAME" "$REDIS_NAME" >/dev/null

  (cd "$ROOT/backend" && api_env nohup npm run start:dev >"$LOG_DIR/backend.log" 2>&1 & echo $! >"$LOG_DIR/backend.pid")
  (cd "$ROOT/frontend" && PORT="$WEB_PORT" ALMYTY_API_TARGET="http://localhost:$API_PORT" nohup npm run dev >"$LOG_DIR/frontend.log" 2>&1 & echo $! >"$LOG_DIR/frontend.pid")

  echo "waiting for http://localhost:$API_PORT/health ..."
  for _ in $(seq 1 180); do
    if curl -sf "http://localhost:$API_PORT/health" >/dev/null; then
      echo "api up on $API_PORT, web on $WEB_PORT, logs in $LOG_DIR"
      return 0
    fi
    sleep 2
  done
  echo "api did not become healthy; see $LOG_DIR/backend.log" >&2
  return 1
}

down() {
  for f in backend frontend; do
    if [ -f "$LOG_DIR/$f.pid" ]; then
      pkill -P "$(cat "$LOG_DIR/$f.pid")" 2>/dev/null || true
      kill "$(cat "$LOG_DIR/$f.pid")" 2>/dev/null || true
      rm -f "$LOG_DIR/$f.pid"
    fi
  done
  docker rm -f "$PG_NAME" "$REDIS_NAME" >/dev/null 2>&1 || true
  echo "stopped"
}

status() {
  docker ps --format '{{.Names}} {{.Ports}}' | grep -E "$PG_NAME|$REDIS_NAME" || echo "containers: none"
  curl -s -m 3 "http://localhost:$API_PORT/health" || echo "api: down"
  echo
  curl -s -m 3 -o /dev/null -w "web: %{http_code}\n" "http://localhost:$WEB_PORT/" || echo "web: down"
}

case "${1:-}" in
  up) up ;;
  down) down ;;
  status) status ;;
  *) echo "usage: $0 up|down|status" >&2; exit 2 ;;
esac
