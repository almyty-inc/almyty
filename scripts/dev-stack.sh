#!/usr/bin/env bash
# A second, non-colliding local stack for QA runs: Postgres (pgvector) on
# 5433, Redis on 6380, the API on 4100 and vite on 3102. Nothing here touches
# the docker-compose stack on 4000/3002/5432/6379.
#
#   scripts/dev-stack.sh up      start containers, API and frontend
#   scripts/dev-stack.sh down    stop everything this script started
#   scripts/dev-stack.sh status  ports + health
#
# Several stacks can run side by side; each one is named by STACK and every
# setting below can be overridden from the environment:
#
#   STACK       name of this stack (default: qa)
#   LOG_DIR     logs and pid files (default: /tmp/almyty-$STACK)
#   PG_NAME     Postgres container (default: almyty-$STACK-pg)
#   REDIS_NAME  Redis container (default: almyty-$STACK-redis)
#   PG_PORT     Postgres host port (default: 5433)
#   REDIS_PORT  Redis host port (default: 6380)
#   API_PORT    API port (default: 4100)
#   WEB_PORT    vite port (default: 3102)
#   DB_NAME     database name (default: almyty_qa)
#
#   STACK=tutorial API_PORT=4200 WEB_PORT=3202 PG_PORT=5434 REDIS_PORT=6381 \
#     scripts/dev-stack.sh up
#
# `down` stops only processes this stack started. A pid file records the
# pid, its start time and its working directory; a pid that is gone, was
# reused by another process (different start time) or runs elsewhere
# (different directory) is left alone. Whatever still listens on API_PORT or
# WEB_PORT afterwards is stopped only if it runs from this checkout's
# backend/ or frontend/ (PORT_SWEEP=0 skips that look; each lsof gets
# LSOF_TIMEOUT seconds, default 20).
#
# The API is started with OLLAMA_ALLOW_PRIVATE_URLS=true so an Ollama-typed
# provider may point at a localhost fake server (the models E2E specs start
# one), MODEL_RECONCILE_CRON at every minute so deployments settle quickly,
# and the price feed off unless MODEL_PRICE_FEED_DISABLED=false.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STACK="${STACK:-qa}"
LOG_DIR="${LOG_DIR:-/tmp/almyty-$STACK}"
PG_NAME="${PG_NAME:-almyty-$STACK-pg}"
REDIS_NAME="${REDIS_NAME:-almyty-$STACK-redis}"
PG_PORT="${PG_PORT:-5433}"
REDIS_PORT="${REDIS_PORT:-6380}"
API_PORT="${API_PORT:-4100}"
WEB_PORT="${WEB_PORT:-3102}"
DB_NAME="${DB_NAME:-almyty_qa}"
PORT_SWEEP="${PORT_SWEEP:-1}"
LSOF_TIMEOUT="${LSOF_TIMEOUT:-20}"
# The memory migration needs the vector extension, so plain postgres will not do.
PG_IMAGE="${PG_IMAGE:-pgvector/pgvector:pg16}"

mkdir -p "$LOG_DIR"

# Run a command for at most LSOF_TIMEOUT seconds: a port lookup has lsof
# read every process on the host, which on a busy one takes minutes.
bounded() {
  "$@" 2>/dev/null &
  local pid=$! watchdog
  (sleep "$LSOF_TIMEOUT"; kill "$pid" 2>/dev/null) >/dev/null 2>&1 &
  watchdog=$!
  wait "$pid" 2>/dev/null
  local rc=$?
  kill "$watchdog" 2>/dev/null || true
  return "$rc"
}

# When a process started; a reused pid has another start time.
proc_started() {
  { ps -o lstart= -p "$1" 2>/dev/null | sed 's/^ *//;s/ *$//'; } || true
}

# A process's working directory, or nothing when it cannot be read.
proc_cwd() {
  if [ -e "/proc/$1/cwd" ]; then
    readlink "/proc/$1/cwd" 2>/dev/null || true
  elif command -v lsof >/dev/null 2>&1; then
    { bounded lsof -b -w -a -p "$1" -d cwd -Fn | sed -n 's/^n//p' | head -n 1; } || true
  fi
}

# Physical path, so /tmp and /private/tmp (macOS) compare equal.
real_dir() {
  (cd "$1" 2>/dev/null && pwd -P) || printf '%s\n' "$1"
}

# record NAME PID DIR: what `down` checks before it stops PID.
record() {
  printf '%s\t%s\t%s\n' "$2" "$(proc_started "$2")" "$(real_dir "$3")" >"$LOG_DIR/$1.pid"
}

# owned PID STARTED DIR: PID is still the process this stack started.
owned() {
  local pid="$1" started="$2" dir="$3" cwd
  case "$pid" in '' | *[!0-9]*) return 1 ;; esac
  kill -0 "$pid" 2>/dev/null || return 1
  [ -n "$started" ] && [ "$(proc_started "$pid")" = "$started" ] || return 1
  cwd="$(proc_cwd "$pid")"
  [ -z "$cwd" ] || [ "$(real_dir "$cwd")" = "$dir" ]
}

descendants() {
  local child
  for child in $(pgrep -P "$1" 2>/dev/null || true); do
    descendants "$child"
    echo "$child"
  done
}

kill_tree() {
  local pids
  pids="$(descendants "$1") $1"
  # shellcheck disable=SC2086
  kill $pids 2>/dev/null || true
}

api_env() {
  env PORT="$API_PORT" NODE_ENV=development TZ="${TZ:-UTC}" \
    DATABASE_HOST=localhost DATABASE_PORT="$PG_PORT" DATABASE_USERNAME=postgres DATABASE_PASSWORD=postgres DATABASE_NAME="$DB_NAME" DB_SSL=false \
    REDIS_HOST=localhost REDIS_PORT="$REDIS_PORT" \
    JWT_SECRET="${JWT_SECRET:-qa-jwt-secret-0123456789abcdef0123456789}" \
    JWT_REFRESH_SECRET="${JWT_REFRESH_SECRET:-qa-refresh-secret-0123456789abcdef}" \
    ENCRYPTION_KEY="${ENCRYPTION_KEY:-qa-encryption-key-32-bytes-minimum!!}" \
    FRONTEND_URL="http://localhost:$WEB_PORT" CORS_ORIGIN="http://localhost:$WEB_PORT" \
    BASE_URL="http://localhost:$API_PORT" API_BASE_URL="http://localhost:$API_PORT" \
    OLLAMA_ALLOW_PRIVATE_URLS=true MODEL_RECONCILE_CRON='*/1 * * * *' MODEL_PRICE_FEED_DISABLED="${MODEL_PRICE_FEED_DISABLED:-true}" \
    "$@"
}

up() {
  docker inspect "$PG_NAME" >/dev/null 2>&1 || docker run -d --name "$PG_NAME" \
    -e POSTGRES_PASSWORD=postgres -e POSTGRES_USER=postgres -e POSTGRES_DB="$DB_NAME" \
    -p "$PG_PORT:5432" "$PG_IMAGE" >/dev/null
  docker inspect "$REDIS_NAME" >/dev/null 2>&1 || docker run -d --name "$REDIS_NAME" -p "$REDIS_PORT:6379" redis:7-alpine >/dev/null
  docker start "$PG_NAME" "$REDIS_NAME" >/dev/null

  # nest-cli sets deleteOutDir, so `start:dev` wipes dist on boot. If an
  # incremental build state survives that wipe, the compiler reports
  # "Found 0 errors", emits nothing, and the API dies on a missing
  # dist/main that never gets rebuilt. Clearing it costs one cold compile
  # and removes a failure that looks like a code bug and is not.
  rm -f "$ROOT/backend"/*.tsbuildinfo

  # BACKEND_EE=true runs the commercial build the way the image does
  # (build:ee, then dist-ee/src/main), so the ee/ modules are served too;
  # the default is the OSS watch build, which never loads ee/.
  if [ "${BACKEND_EE:-false}" = "true" ]; then
    (cd "$ROOT/backend" && npm run build:ee >"$LOG_DIR/backend-build.log" 2>&1)
    (cd "$ROOT/backend" && api_env nohup node dist-ee/src/main >"$LOG_DIR/backend.log" 2>&1 & record backend $! "$ROOT/backend")
  else
    (cd "$ROOT/backend" && api_env nohup npm run start:dev >"$LOG_DIR/backend.log" 2>&1 & record backend $! "$ROOT/backend")
  fi
  (cd "$ROOT/frontend" && PORT="$WEB_PORT" ALMYTY_API_TARGET="http://localhost:$API_PORT" nohup npm run dev >"$LOG_DIR/frontend.log" 2>&1 & record frontend $! "$ROOT/frontend")

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
  local f pid started dir listener cwd
  for f in backend frontend; do
    [ -f "$LOG_DIR/$f.pid" ] || continue
    IFS=$'\t' read -r pid started dir <"$LOG_DIR/$f.pid" || true
    if [ "$dir" = "$(real_dir "$ROOT/$f")" ] && owned "$pid" "$started" "$dir"; then
      kill_tree "$pid"
    elif [ -n "$pid" ]; then
      echo "$f: pid $pid is not the process this stack started; left alone" >&2
    fi
    rm -f "$LOG_DIR/$f.pid"
  done
  # A watcher's child (nest's dist/main, vite) can outlive its parent.
  for f in "backend:$API_PORT" "frontend:$WEB_PORT"; do
    [ "$PORT_SWEEP" = "1" ] && command -v lsof >/dev/null 2>&1 || break
    for listener in $(bounded lsof -b -w -nP -tiTCP:"${f#*:}" -sTCP:LISTEN || true); do
      cwd="$(proc_cwd "$listener")"
      if [ -n "$cwd" ] && [ "$(real_dir "$cwd")" = "$(real_dir "$ROOT/${f%%:*}")" ]; then
        kill_tree "$listener"
      else
        echo "port ${f#*:}: pid $listener is not from this checkout; left alone" >&2
      fi
    done
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
