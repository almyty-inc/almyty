#!/usr/bin/env bash
#
# End-to-end smoke test for @almyty/cli.
#
# What it verifies:
#
#   1. auth-cli, agents-cli, chat-cli, skills-cli and almyty-cli build
#      cleanly into dist/.
#   2. `almyty` with no arguments prints a short tour, not a wall.
#   3. `almyty help` lists every routed command, the exit-code table and
#      the completion subcommand; `almyty --version` agrees with
#      package.json.
#   4. `almyty completion <shell>` emits a script for bash, zsh and fish
#      and refuses anything else.
#   5. Each subcommand routes to the right underlying package by exec'ing
#      it with `--help` and grepping for that package's banner.
#   6. Every package the routing table names is a dependency of
#      @almyty/cli, so no advertised command can answer "not installed".
#   7. An unknown command exits 2, and a near-miss suggests the real one.
#
# This is a smoke test, not a functional test — it does NOT exercise
# real backend calls and never authenticates. The point is to prove the
# umbrella + standalone packages are wired correctly.
#
# Usage:
#   packages/almyty-cli/scripts/smoke-test.sh
#
# Env:
#   KEEP_TMPDIR=1   leave the temp install dir behind for inspection
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
PACKAGES_DIR="$REPO_ROOT/packages"

# Five packages we expect to find. The umbrella depends on all of them,
# plus @almyty/models, @almyty/connections, @almyty/mcp-server,
# @almyty/acp-server and @almyty/runner, which this script does not
# build (their node_modules may be absent in a bare checkout).
PACKAGES=(auth-cli agents-cli chat-cli skills-cli almyty-cli)

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

log "running 'almyty' with no arguments (expect the short tour)…"
TOUR_OUT=$(node "$ALMYTY_BIN")
echo "$TOUR_OUT" | grep -q "almyty login" || fail "tour missing 'almyty login'"
echo "$TOUR_OUT" | grep -q "almyty help" || fail "tour missing the pointer to 'almyty help'"
[[ $(echo "$TOUR_OUT" | wc -l) -lt 20 ]] || fail "bare 'almyty' printed a wall, not a tour"
ok "bare 'almyty' prints a short tour"

log "running 'almyty help'…"
HELP_OUT=$(node "$ALMYTY_BIN" help)
echo "$HELP_OUT" | grep -q "almyty CLI" || fail "help output missing umbrella banner"
for cmd in login logout whoami auth agents chat skills models connections runner mcp acp; do
  echo "$HELP_OUT" | grep -qE "^  $cmd +" || fail "help output missing '$cmd'"
done
echo "$HELP_OUT" | grep -q "Exit codes" || fail "help output missing the exit-code table"
echo "$HELP_OUT" | grep -q "completion <shell>" || fail "help output missing 'completion'"
ok "almyty help lists every command, the exit codes, and completion"

log "running 'almyty version'…"
VERSION_OUT=$(node "$ALMYTY_BIN" --version)
echo "$VERSION_OUT" | grep -qE "^[0-9]+\.[0-9]+\.[0-9]+$" || fail "version output not semver: $VERSION_OUT"
PKG_VERSION=$(node -e "console.log(require('$PACKAGES_DIR/almyty-cli/package.json').version)")
[[ "$VERSION_OUT" == "$PKG_VERSION" ]] || fail "--version says $VERSION_OUT, package.json says $PKG_VERSION"
ok "almyty --version matches package.json ($VERSION_OUT)"

log "running 'almyty completion <shell>' for each shell…"
for shell in bash zsh fish; do
  node "$ALMYTY_BIN" completion "$shell" | grep -q almyty || fail "completion $shell produced nothing usable"
done
if node "$ALMYTY_BIN" completion powershell > /dev/null 2>&1; then
  fail "completion should reject an unsupported shell"
fi
ok "shell completion emitted for bash, zsh and fish"

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
run_subcommand "skills --help"  "@almyty/skills"  "almyty skills → @almyty/skills"

# Top-level shortcut: `almyty login` should also delegate to @almyty/auth.
run_subcommand "login --help"   "@almyty/auth"    "almyty login → @almyty/auth login"

# Every delegated command must name a package the umbrella depends on,
# otherwise `almyty models …` answers "package is not installed" for a
# command its own --help advertises.
log "checking every routed package is a dependency…"
node -e '
const { readFileSync } = require("fs");
const pkg = JSON.parse(readFileSync(process.argv[1], "utf-8"));
const src = readFileSync(process.argv[2], "utf-8");
const routed = [...src.matchAll(/pkg: .(@almyty\/[a-z-]+)./g)].map((m) => m[1]);
if (routed.length < 8) { console.error("did not find the routing table"); process.exit(1); }
const missing = routed.filter((p) => !pkg.dependencies?.[p]);
if (missing.length) { console.error("routed but not depended on: " + missing.join(", ")); process.exit(1); }
' "$PACKAGES_DIR/almyty-cli/package.json" "$PACKAGES_DIR/almyty-cli/src/commands.ts" \
  || fail "the routing table names a package @almyty/cli does not depend on"
ok "every routed package is a dependency"

# Unknown command should be a usage error (2), not a generic failure (1).
log "running 'almyty bogus' (expect exit 2)…"
set +e
NODE_PATH="$TMPDIR/node_modules" node "$ALMYTY_BIN" bogus > /dev/null 2>&1
bogus_code=$?
set -e
[[ $bogus_code -eq 2 ]] || fail "unknown command exited $bogus_code, expected 2"
ok "unknown command exits 2"

log "checking the suggestion for a near-miss…"
NODE_PATH="$TMPDIR/node_modules" node "$ALMYTY_BIN" agent 2>&1 | grep -q "Did you mean" \
  || fail "'almyty agent' should suggest 'almyty agents'"
ok "a near-miss command suggests the real one"

printf "\n${GREEN}All smoke checks passed.${RESET}\n"
