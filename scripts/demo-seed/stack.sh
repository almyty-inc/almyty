#!/usr/bin/env bash
# The local stack the docs screenshots are captured from: scripts/dev-stack.sh
# on its own ports and container names, the fake upstreams a profile needs,
# and an install-wide Business license signed by a throwaway key made here
# (never the vendor key, never a staging secret).
#
#   scripts/demo-seed/stack.sh up      containers, fakes, API, frontend
#   scripts/demo-seed/stack.sh down    stop all of it and remove the containers
#   scripts/demo-seed/stack.sh env     print the variables the walks read
#
# PROFILE picks the fakes (walks/profiles.ts; `npm run demo -- profile <name>`
# shows what it starts). The Northwind fake (model vendors and company
# APIs) runs in every profile on FAKE_PORT; the others add stand-ins for
# Google, HubSpot, Stripe, GitHub and so on, on the ports the published
# screenshots show, and may load modules into the API (redirect.ts sends its
# email, Slack and Telegram traffic to a fake).
#
#   PROFILE=lumen scripts/demo-seed/stack.sh up
#
# Ports default to ones the usual stacks leave alone; override any of them.
# DEMO_PORT_OFFSET moves the profile's fake ports too, for a second stack
# beside this one (its screenshots then show other ports: develop on it,
# capture for publishing without it).
# `down` stops only what this stack started (scripts/lib/owned-processes.sh).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
export PROFILE="${PROFILE:-northwind}"
export LOG_DIR="${LOG_DIR:-/tmp/almyty-demo}"
export PG_NAME="${PG_NAME:-almyty-demo-pg}"
export REDIS_NAME="${REDIS_NAME:-almyty-demo-redis}"
export PG_PORT="${PG_PORT:-55510}"
export REDIS_PORT="${REDIS_PORT:-56510}"
export API_PORT="${API_PORT:-4210}"
export WEB_PORT="${WEB_PORT:-3210}"
export FAKE_PORT="${FAKE_PORT:-4290}"
export DB_NAME="${DB_NAME:-almyty_qa}"
mkdir -p "$LOG_DIR"
# shellcheck source=../lib/owned-processes.sh
. "$ROOT/scripts/lib/owned-processes.sh"

# The walks' own dependencies (zod, playwright), once.
deps() {
  [ -d "$HERE/node_modules/zod" ] || (cd "$HERE" && npm ci --no-audit --no-fund >"$LOG_DIR/demo-deps.log" 2>&1)
}

# What the profile starts, one line each: FAKE <services> <port> [K=V...], REDIRECT <port>, PRELOAD <file>, PUBLIC_API 1.
profile_lines() {
  (cd "$HERE" && node cli.ts profile "$1")
}

# The profile's own fake port: where its email, Slack and Telegram traffic lands, and what the walks call DEMO_USECASE_URL.
upstream_port() {
  local line port=""
  while read -r line; do
    case "$line" in REDIRECT\ *) port="${line#REDIRECT }" ;; esac
  done < <(profile_lines "$1")
  if [ -z "$port" ]; then
    port="$(profile_lines "$1" | awk '$1 == "FAKE" { print $3; exit }')"
  fi
  printf '%s\n' "${port:-4291}"
}

# Business entitlements, install-wide. Chargeback and customer-managed keys
# are Enterprise and stay locked, which is what their locked-state captures show.
license() {
  local key="$LOG_DIR/license-private.pem" pub="$LOG_DIR/license-public.pem"
  if [ ! -f "$key" ]; then
    openssl genpkey -algorithm ed25519 -out "$key" 2>/dev/null
    openssl pkey -in "$key" -pubout -out "$pub"
  fi
  export ALMYTY_LICENSE_PUBLIC_KEY="$(cat "$pub")"
  export ALMYTY_LICENSE_KEY="$(node "$ROOT/backend/scripts/license/mint-license.js" --key "$key" \
    --entitlements sso,advanced_rbac,approval_policy,compliance_pack,audit_export,connections_governance,hosted_shared_environments \
    --seats 25 --issued-to 'Northwind AI (local demo)' 2>/dev/null)"
}

# start_fake NAME SERVICES PORT [K=V...]: a fake upstream, unless one already answers there.
start_fake() {
  local name="$1" services="$2" port="$3"
  shift 3
  if curl -sf "http://localhost:$port/health" >/dev/null 2>&1; then
    echo "port $port already answers; $services not started" >&2
    return 0
  fi
  (cd "$HERE" && env FAKE_PORT="$FAKE_PORT" USECASE_PORT="$port" "$@" \
    nohup node fakes/serve.ts "$services" --port "$port" --log "$LOG_DIR/$name-requests.log" >"$LOG_DIR/$name.log" 2>&1 &
    record "$name" $! "$HERE")
}

print_env() {
  local up
  up="$(upstream_port "$(cat "$LOG_DIR/profile" 2>/dev/null || echo "$PROFILE")")"
  # export lines: `eval "$(stack.sh env)"` has to reach the walks, which are child processes.
  cat <<EOF2
export DEMO_WEB_URL=http://localhost:$WEB_PORT
export DEMO_API_URL=http://localhost:$API_PORT
export DEMO_FAKE_URL=http://localhost:$FAKE_PORT
export DEMO_USECASE_URL=http://localhost:$up
export PG_NAME=$PG_NAME
export DB_NAME=$DB_NAME
export LOG_DIR=$LOG_DIR
EOF2
}

case "${1:-}" in
  up)
    deps
    profile_lines "$PROFILE" >/dev/null
    license
    # The fakes are on localhost, which the product refuses by default.
    export LLM_ALLOW_PRIVATE_URLS=true MCP_ALLOW_PRIVATE_URLS=true
    # Model prices come from the live feed, as in production; offline they read "Price unknown".
    export MODEL_PRICE_FEED_DISABLED="${MODEL_PRICE_FEED_DISABLED:-false}"
    # The commercial build, as staging runs it: compliance, audit streams and the other ee/ pages have their API.
    export BACKEND_EE="${BACKEND_EE:-true}"
    # Hosted environments with the stub adapter, which starts nothing. The
    # reconcile sweep is off so the machine states the seed writes stay put.
    export HOSTED_RUNNERS_ENABLED=true HOSTED_RUNNERS_PROVIDER=stub
    sweep_off='{"reconcile":{"sweepCron":"off"}}'
    export HOSTED_RUNNERS_SETTINGS="${HOSTED_RUNNERS_SETTINGS:-$sweep_off}"
    start_fake fake northwind "$FAKE_PORT"
    while read -r kind a b rest; do
      case "$kind" in
        FAKE)
          # shellcheck disable=SC2086
          start_fake "fake-$b" "$a" "$b" $rest ;;
        REDIRECT)
          export USECASE_UPSTREAM_URL="http://localhost:$a"
          export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--import $HERE/fakes/preload/redirect.ts" ;;
        PRELOAD)
          export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--import $a" ;;
        PUBLIC_API)
          export PUBLIC_API_URL="http://localhost:$API_PORT" ;;
      esac
    done < <(profile_lines "$PROFILE")
    export USECASE_UPSTREAM_URL="${USECASE_UPSTREAM_URL:-http://localhost:$(upstream_port "$PROFILE")}"
    printf '%s\n' "$PROFILE" >"$LOG_DIR/profile"
    "$ROOT/scripts/dev-stack.sh" up
    print_env
    ;;
  down)
    # Only what this stack started: each pid file names a pid, its start
    # time and its directory, and a pid that no longer matches is someone
    # else's (scripts/lib/owned-processes.sh).
    for pidfile in "$LOG_DIR"/fake*.pid; do
      [ -e "$pidfile" ] || continue
      stop_recorded "$(basename "$pidfile" .pid)" "$HERE"
    done
    "$ROOT/scripts/dev-stack.sh" down
    # A process its pid file lost track of -- the BACKEND_EE API (node
    # dist-ee/src/main) outlived the stop -- still listens on this stack's
    # port. Stopped only when it runs from this checkout.
    sweep_port "$API_PORT" "$ROOT/backend"
    sweep_port "$WEB_PORT" "$ROOT/frontend"
    sweep_port "$FAKE_PORT" "$HERE"
    for port in $(profile_lines "$(cat "$LOG_DIR/profile" 2>/dev/null || echo "$PROFILE")" | awk '$1 == "FAKE" || $1 == "REDIRECT" { print ($1 == "FAKE" ? $3 : $2) }' | sort -u); do sweep_port "$port" "$HERE"; done
    rm -f "$LOG_DIR/profile"
    ;;
  env) print_env ;;
  *) echo "usage: $0 up|down|env   (PROFILE=$(cd "$HERE" && node -e "import('./walks/profiles.ts').then((m) => console.log(Object.keys(m.PROFILES).join('|')))" 2>/dev/null || echo name))" >&2; exit 2 ;;
esac
