#!/usr/bin/env bash
# CLI smoke test — exercises every CLI command against a real backend.
#
# Prerequisites:
#   1. All CLI packages built (npx tsc in each package dir)
#   2. Authenticated: ~/.almyty/credentials.json with a valid token
#   3. At least one gateway with tools assigned on the target backend
#
# Usage:
#   bash packages/cli-smoke-test.sh                          # test against stored creds
#   ALMYTY_URL=https://api.staging.almyty.com bash packages/cli-smoke-test.sh
#
# Exit codes:
#   0 — all tests passed
#   1 — one or more tests failed

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PASS=0
FAIL=0
ERRORS=""

run() {
  local label="$1"; shift
  local output
  if output=$("$@" 2>&1); then
    PASS=$((PASS + 1))
    printf "  \033[32m✓\033[0m %s\n" "$label"
  else
    local exit_code=$?
    FAIL=$((FAIL + 1))
    ERRORS="${ERRORS}\n  ✗ ${label}: exit=${exit_code}\n    ${output}\n"
    printf "  \033[31m✗\033[0m %s (exit=%d)\n" "$label" "$exit_code"
  fi
}

expect_fail() {
  local label="$1"; shift
  if "$@" >/dev/null 2>&1; then
    FAIL=$((FAIL + 1))
    ERRORS="${ERRORS}\n  ✗ ${label}: expected failure but got exit=0\n"
    printf "  \033[31m✗\033[0m %s (expected failure)\n" "$label"
  else
    PASS=$((PASS + 1))
    printf "  \033[32m✓\033[0m %s (expected failure)\n" "$label"
  fi
}

echo ""
echo "almyty CLI smoke test"
echo "====================="
echo ""

# --- auth-cli ---
echo "auth-cli:"
run "version"       node "$ROOT/packages/auth-cli/dist/index.js" --version
run "help"          node "$ROOT/packages/auth-cli/dist/index.js" --help
run "whoami"        node "$ROOT/packages/auth-cli/dist/index.js" whoami

# --- agents-cli ---
echo ""
echo "agents-cli:"
run "version"       node "$ROOT/packages/agents-cli/dist/index.js" --version
run "help"          node "$ROOT/packages/agents-cli/dist/index.js" --help
run "list"          node "$ROOT/packages/agents-cli/dist/index.js" list
run "list --json"   node "$ROOT/packages/agents-cli/dist/index.js" list --json
expect_fail "get nonexistent" node "$ROOT/packages/agents-cli/dist/index.js" get nonexistent-agent-xyz

# --- skills-cli ---
echo ""
echo "skills-cli:"
run "version"       node "$ROOT/packages/skills-cli/dist/index.js" --version
run "help"          node "$ROOT/packages/skills-cli/dist/index.js" --help
run "gateways"      node "$ROOT/packages/skills-cli/dist/index.js" gateways
run "list"          node "$ROOT/packages/skills-cli/dist/index.js" list

# Install into a temp dir
TMPDIR=$(mktemp -d)
mkdir -p "$TMPDIR/.claude"

# Find first gateway ref from list output
GATEWAY_REF=$(node "$ROOT/packages/skills-cli/dist/index.js" list 2>&1 | grep -oE '@[^ ]+' | head -1 | sed 's|/[^/]*$||')
if [ -n "$GATEWAY_REF" ]; then
  run "install"     node "$ROOT/packages/skills-cli/dist/index.js" install "$GATEWAY_REF" --dir "$TMPDIR"
  run "installed"   node "$ROOT/packages/skills-cli/dist/index.js" installed --dir "$TMPDIR"
  run "remove"      node "$ROOT/packages/skills-cli/dist/index.js" remove --dir "$TMPDIR"
else
  echo "  (skipping install/remove — no gateway ref found)"
fi
rm -rf "$TMPDIR"

# --- chat-cli ---
echo ""
echo "chat-cli:"
run "version"       node "$ROOT/packages/chat-cli/dist/index.js" --version
run "help"          node "$ROOT/packages/chat-cli/dist/index.js" --help

# --- mcp-server ---
echo ""
echo "mcp-server:"
run "help"          node "$ROOT/packages/mcp-server/dist/index.js" --help
# Start server, let it discover tools, then kill
if timeout 8 node "$ROOT/packages/mcp-server/dist/index.js" </dev/null 2>&1 | grep -q "tools.*skills"; then
  PASS=$((PASS + 1))
  printf "  \033[32m✓\033[0m startup + tool discovery\n"
else
  FAIL=$((FAIL + 1))
  printf "  \033[31m✗\033[0m startup + tool discovery\n"
fi

# --- almyty-cli (umbrella) ---
echo ""
echo "almyty-cli:"
run "version"       node "$ROOT/packages/almyty-cli/dist/index.js" --version
run "help"          node "$ROOT/packages/almyty-cli/dist/index.js" help
run "whoami"        node "$ROOT/packages/almyty-cli/dist/index.js" whoami
run "agents list"   node "$ROOT/packages/almyty-cli/dist/index.js" agents list
expect_fail "unknown cmd" node "$ROOT/packages/almyty-cli/dist/index.js" nonexistent

# --- Summary ---
echo ""
echo "--------------------"
printf "Results: \033[32m%d passed\033[0m" "$PASS"
if [ "$FAIL" -gt 0 ]; then
  printf ", \033[31m%d failed\033[0m" "$FAIL"
fi
echo ""

if [ "$FAIL" -gt 0 ]; then
  echo ""
  echo "Failures:"
  printf "$ERRORS"
  echo ""
  exit 1
fi

echo ""
exit 0
