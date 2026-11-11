#!/usr/bin/env bash
# The local stack the benchmark measures: Postgres (pgvector) and Redis in
# docker, and the backend built from this checkout and run as in production
# (NODE_ENV=production, compiled JS, no per-query logging). Its own ports and
# container names, so it runs beside docker-compose and scripts/dev-stack.sh.
# Two settings differ from a default install: CODE_MODE_GATEWAYS=true (code
# exposure is off by default) and RATE_LIMIT_MAX=100000 (the harness polls
# the import job every 100 ms, past the default 100 requests a minute).
#
#   benchmarks/stack.sh up      build the backend, start containers + API
#   benchmarks/stack.sh down    stop the API and remove the containers
#
# Settings (environment): API_PORT (4310), PG_PORT (5440), REDIS_PORT (6390),
# PG_NAME (almyty-bench-pg), REDIS_NAME (almyty-bench-redis), LOG_DIR
# (/tmp/almyty-bench), SKIP_BUILD=1 to run the dist/ already there.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_PORT="${API_PORT:-4310}"
PG_PORT="${PG_PORT:-5440}"
REDIS_PORT="${REDIS_PORT:-6390}"
PG_NAME="${PG_NAME:-almyty-bench-pg}"
REDIS_NAME="${REDIS_NAME:-almyty-bench-redis}"
LOG_DIR="${LOG_DIR:-/tmp/almyty-bench}"
DB_NAME=almyty_bench
PID_FILE="$LOG_DIR/api.pid"
mkdir -p "$LOG_DIR"

up() {
  docker inspect "$PG_NAME" >/dev/null 2>&1 || docker run -d --name "$PG_NAME" \
    -e POSTGRES_PASSWORD=postgres -e POSTGRES_USER=postgres -e POSTGRES_DB="$DB_NAME" \
    -p "$PG_PORT:5432" pgvector/pgvector:pg16 >/dev/null
  docker inspect "$REDIS_NAME" >/dev/null 2>&1 || docker run -d --name "$REDIS_NAME" -p "$REDIS_PORT:6379" redis:7-alpine >/dev/null
  docker start "$PG_NAME" "$REDIS_NAME" >/dev/null
  for _ in $(seq 1 60); do docker exec "$PG_NAME" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done

  if [ "${SKIP_BUILD:-0}" != "1" ]; then
    (cd "$ROOT/backend" && rm -f ./*.tsbuildinfo && npx nest build >"$LOG_DIR/build.log" 2>&1)
  fi

  if curl -sf "http://localhost:$API_PORT/health" >/dev/null 2>&1; then
    echo "something already answers on port $API_PORT; run '$0 down' first" >&2
    return 1
  fi

  # `cd` and the launch are separate commands, so $! is node's own pid.
  (cd "$ROOT/backend" || exit 1
   env PORT="$API_PORT" NODE_ENV=production TZ=UTC \
    DATABASE_HOST=localhost DATABASE_PORT="$PG_PORT" DATABASE_USERNAME=postgres DATABASE_PASSWORD=postgres \
    DATABASE_NAME="$DB_NAME" DB_SSL=false REDIS_HOST=localhost REDIS_PORT="$REDIS_PORT" \
    JWT_SECRET="${JWT_SECRET:-bench-jwt-secret-local-only-not-a-real-secret}" \
    JWT_REFRESH_SECRET="${JWT_REFRESH_SECRET:-bench-refresh-secret-local-only}" \
    ENCRYPTION_KEY="${ENCRYPTION_KEY:-bench-encryption-key-32-bytes-minimum!!}" \
    FRONTEND_URL="http://localhost:3310" CORS_ORIGIN="http://localhost:3310" \
    BASE_URL="http://localhost:$API_PORT" API_BASE_URL="http://localhost:$API_PORT" \
    CODE_MODE_GATEWAYS=true MODEL_PRICE_FEED_DISABLED=true RATE_LIMIT_MAX=100000 \
    nohup node dist/main >"$LOG_DIR/api.log" 2>&1 &
   echo $! >"$PID_FILE")

  # A cold start (module files not in the page cache) can take minutes.
  for _ in $(seq 1 600); do
    if curl -sf "http://localhost:$API_PORT/health" >/dev/null; then
      echo "api up on http://localhost:$API_PORT (log: $LOG_DIR/api.log)"
      return 0
    fi
    sleep 1
  done
  echo "api did not become healthy; see $LOG_DIR/api.log" >&2
  return 1
}

down() {
  if [ -f "$PID_FILE" ]; then
    pid="$(cat "$PID_FILE")"
    kill "$pid" 2>/dev/null || true
    # Nest's shutdown hooks can take a while; past 20 s it is killed outright.
    for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
    kill -9 "$pid" 2>/dev/null || true
    rm -f "$PID_FILE"
  fi
  docker rm -f "$PG_NAME" "$REDIS_NAME" >/dev/null 2>&1 || true
  echo "stopped"
}

case "${1:-}" in
  up) up ;;
  down) down ;;
  *) echo "usage: $0 up|down" >&2; exit 2 ;;
esac
