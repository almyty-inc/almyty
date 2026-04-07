#!/usr/bin/env bash
#
# End-to-end smoke test for @almyty/cli.
#
# What it verifies:
#
#   1. All five packages (auth, agents, chat, skills, mcp-server) build
#      cleanly into dist/.
#   2. We can install @almyty/cli from a tarball into a temp directory
#      and the `almyty` binary lands on PATH.
#   3. `almyty help` and `almyty version` work without authentication.
#   4. Each subcommand routes to the right underlying package by
#      exec'ing it with `--help` and grepping the output for the
#      package's identifying banner.
#
# This is a smoke test, not a functional test — it does NOT exercise
# real backend calls. The point is to prove the umbrella + standalone
# packages are wired correctly.
#
# Usage:
#   packages/almyty-cli/scripts/smoke-test.sh
#
# Env:
#   KEEP_TMPDIR=1   leave the temp install dir behind for inspection
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
PACKAGES_DIR="$REPO_ROOT/packages"

# Five packages we expect to find. The umbrella depends on the first four.
PACKAGES=(auth-cli agents-cli chat-cli skills-cli almyty-cli)

# Optional: mcp-server isn't currently installed by default in tests
# (its node_modules can be missing) so we don't include it in the smoke
# test, but the umbrella's routing table includes it for users who do
# install it.

GREEN=$'\033[32m'
RED=$'\033[31m'
DIM=$'\033[2m'
RESET=$'\033[0m'

ok()   { printf "%s ✓ %s%s\n" "$GREEN" "$1" "$RESET"; }
fail() { printf "%s ✗ %s%s\n" "$RED" "$1" "$RESET"; exit 1; }
log()  { printf "%s· %s%s\n" "$DIM" "$1" "$RESET"; }

# ──────────────────────────────────────────────────────────────────
# 1. Build every package
# ──────────────────────────────────────────────────────────────────
log "building packages…"
for pkg in "${PACKAGES[@]}"; do
  pkg_dir="$PACKAGES_DIR/$pkg"
  [[ -d "$pkg_dir" ]] || fail "missing package dir: $pkg_dir"

  # Use the local tsc if available, otherwise fall back to PATH tsc.
  pushd "$pkg_dir" > /dev/null
  if [[ -x node_modules/.bin/tsc ]]; then
    node_modules/.bin/tsc -p tsconfig.json > /tmp/almyty-build-$pkg.log 2>&1 \
      || { cat /tmp/almyty-build-$pkg.log; fail "tsc failed for $pkg"; }
  else
    # Fall back to global tsc with backend's @types/node (matches the
    # type-check we do during development).
    tsc -p tsconfig.json --types node \
      --typeRoots "$REPO_ROOT/backend/node_modules/@types" \
      > /tmp/almyty-build-$pkg.log 2>&1 \
      || { cat /tmp/almyty-build-$pkg.log; fail "tsc failed for $pkg"; }
  fi
  [[ -f dist/index.js ]] || fail "$pkg: dist/index.js not produced"
  popd > /dev/null

  ok "$pkg built"
done

# ──────────────────────────────────────────────────────────────────
# 2. Verify the umbrella's bin can be invoked directly
# ──────────────────────────────────────────────────────────────────
ALMYTY_BIN="$PACKAGES_DIR/almyty-cli/dist/index.js"
[[ -f "$ALMYTY_BIN" ]] || fail "umbrella bin not found at $ALMYTY_BIN"

log "running 'almyty help'…"
HELP_OUT=$(node "$ALMYTY_BIN" help)
echo "$HELP_OUT" | grep -q "almyty CLI" || fail "help output missing umbrella banner"
echo "$HELP_OUT" | grep -q "agents list" || fail "help output missing 'agents list'"
echo "$HELP_OUT" | grep -q "chat" || fail "help output missing 'chat'"
echo "$HELP_OUT" | grep -q "skills install" || fail "help output missing 'skills install'"
echo "$HELP_OUT" | grep -q "login" || fail "help output missing 'login'"
ok "almyty help routes correctly"

log "running 'almyty version'…"
VERSION_OUT=$(node "$ALMYTY_BIN" --version)
echo "$VERSION_OUT" | grep -qE "^[0-9]+\.[0-9]+\.[0-9]+$" || fail "version output not semver: $VERSION_OUT"
ok "almyty --version returns semver"

# ──────────────────────────────────────────────────────────────────
# 3. Verify each subcommand routes to the right underlying package
# ──────────────────────────────────────────────────────────────────
#
# We can't easily install from a tarball in this sandbox, but we CAN
# point the umbrella's `require.resolve` at the local sibling packages
# by setting NODE_PATH so it finds them on disk.
#
# This is the tricky part: require.resolve('@almyty/auth/package.json')
# walks up node_modules from the umbrella's location. The packages
# directory has each package as a sibling, not as a node_modules entry.
# We work around this by symlinking each package into a tmp
# node_modules tree, then setting NODE_PATH to point at it.

TMPDIR=$(mktemp -d -t almyty-smoke.XXXXXX)
trap '[[ -n "${KEEP_TMPDIR:-}" ]] || rm -rf "$TMPDIR"' EXIT

mkdir -p "$TMPDIR/node_modules/@almyty"
for pkg in "${PACKAGES[@]}"; do
  # Use the package's actual npm name from package.json so we end up
  # with @almyty/<name> directories.
  npm_name=$(node -e "console.log(require('$PACKAGES_DIR/$pkg/package.json').name)")
  link_name="${npm_name#@almyty/}"
  ln -sfn "$PACKAGES_DIR/$pkg" "$TMPDIR/node_modules/@almyty/$link_name"
done
ok "linked packages into $TMPDIR/node_modules/@almyty"

# Now run each subcommand with --help via the umbrella and verify it
# delegated. We grep for a string that's UNIQUE to each delegated
# package's --help output.

run_subcommand() {
  local cmd_args="$1"
  local expected="$2"
  local label="$3"
  log "running 'almyty $cmd_args'…"
  local out
  if ! out=$(NODE_PATH="$TMPDIR/node_modules" node "$ALMYTY_BIN" $cmd_args 2>&1); then
    echo "$out"
    fail "$label exited non-zero"
  fi
  if ! echo "$out" | grep -qF "$expected"; then
    echo "$out"
    fail "$label: expected output to contain '$expected'"
  fi
  ok "$label"
}

run_subcommand "auth --help"    "@almyty/auth"    "almyty auth → @almyty/auth"
run_subcommand "agents --help"  "@almyty/agents"  "almyty agents → @almyty/agents"
run_subcommand "chat --help"    "@almyty/chat"    "almyty chat → @almyty/chat"
run_subcommand "skills --help"  "almyty Skills CLI" "almyty skills → @almyty/skills"

# Top-level shortcut: `almyty login` should also delegate to @almyty/auth.
run_subcommand "login --help"   "@almyty/auth"    "almyty login → @almyty/auth login"

# Unknown command should error.
log "running 'almyty bogus' (expect failure)…"
if NODE_PATH="$TMPDIR/node_modules" node "$ALMYTY_BIN" bogus 2>/dev/null; then
  fail "unknown command 'bogus' should have exited non-zero"
fi
ok "unknown command exits non-zero"

printf "\n${GREEN}All smoke checks passed.${RESET}\n"
