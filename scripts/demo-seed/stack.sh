#!/usr/bin/env bash
# The local stack the docs screenshots are captured from: scripts/dev-stack.sh
# on its own ports and container names, plus the fake model/API server the
# seed points at and an install-wide Business license signed by a throwaway
# key made here (never the vendor key, never a staging secret).
#
#   scripts/demo-seed/stack.sh up      containers, fake upstream, API, frontend
#   scripts/demo-seed/stack.sh down    stop all of it and remove the containers
#   scripts/demo-seed/stack.sh env     print the variables seed.mjs/capture read
#
# Ports default to ones the usual stacks leave alone; override any of them.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
export LOG_DIR="${LOG_DIR:-/tmp/almyty-demo}"
export PG_NAME="${PG_NAME:-almyty-demo-pg}"
export REDIS_NAME="${REDIS_NAME:-almyty-demo-redis}"
export PG_PORT="${PG_PORT:-55510}"
export REDIS_PORT="${REDIS_PORT:-56510}"
export API_PORT="${API_PORT:-4210}"
export WEB_PORT="${WEB_PORT:-3210}"
export FAKE_PORT="${FAKE_PORT:-4290}"
mkdir -p "$LOG_DIR"

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

print_env() {
  cat <<EOF
DEMO_WEB_URL=http://localhost:$WEB_PORT
DEMO_API_URL=http://localhost:$API_PORT
DEMO_FAKE_URL=http://localhost:$FAKE_PORT
DEMO_PSQL="docker exec -i $PG_NAME psql -U postgres -d almyty_qa"
EOF
}

case "${1:-}" in
  up)
    license
    # The fake model and API are on localhost, which the product refuses by default.
    export LLM_ALLOW_PRIVATE_URLS=true MCP_ALLOW_PRIVATE_URLS=true
    # Model prices come from the live feed, as in production; offline they read "Price unknown".
    export MODEL_PRICE_FEED_DISABLED="${MODEL_PRICE_FEED_DISABLED:-false}"
    # The commercial build, as staging runs it: compliance, audit streams and the other ee/ pages have their API.
    export BACKEND_EE="${BACKEND_EE:-true}"
    # Hosted environments with the stub adapter, which starts nothing. The
    # reconcile sweep is off so the machine states seed.mjs writes stay put.
    export HOSTED_RUNNERS_ENABLED=true HOSTED_RUNNERS_PROVIDER=stub
    sweep_off='{"reconcile":{"sweepCron":"off"}}'
    export HOSTED_RUNNERS_SETTINGS="${HOSTED_RUNNERS_SETTINGS:-$sweep_off}"
    if ! curl -sf "http://localhost:$FAKE_PORT/health" >/dev/null 2>&1; then
      FAKE_PORT="$FAKE_PORT" nohup node "$HERE/fake-upstream.mjs" >"$LOG_DIR/fake.log" 2>&1 &
      echo $! >"$LOG_DIR/fake.pid"
    fi
    "$ROOT/scripts/dev-stack.sh" up
    print_env
    ;;
  down)
    if [ -f "$LOG_DIR/fake.pid" ]; then kill "$(cat "$LOG_DIR/fake.pid")" 2>/dev/null || true; rm -f "$LOG_DIR/fake.pid"; fi
    "$ROOT/scripts/dev-stack.sh" down
    ;;
  env) print_env ;;
  *) echo "usage: $0 up|down|env" >&2; exit 2 ;;
esac
