#!/usr/bin/env bash
# Entrypoint of the almyty/runner-env images (images/runner-env/Dockerfile).
#
# The root filesystem is read-only in a hosted pod; the workspace volume
# and /tmp are the only writable places, and the Deployment sets
# HOME=/workspace/.home. This points the tools that write on their own
# (npm globals, caches, pip user installs) at HOME, then hands over to the
# runner, which enrolls, sets the workspace up on its first start and
# connects (`almyty-runner start --enroll`, docs/hosted-runners.md).
#
# Nothing secret is read or printed here: the enrollment token stays in
# the environment for the runner, which removes it once read.
set -euo pipefail

export HOME="${HOME:-/workspace/.home}"
if ! mkdir -p "$HOME" 2>/dev/null; then
  echo "runner-env: cannot create HOME ($HOME); is the workspace volume mounted?" >&2
  exit 1
fi

export XDG_CACHE_HOME="${XDG_CACHE_HOME:-$HOME/.cache}"
export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
export NPM_CONFIG_PREFIX="${NPM_CONFIG_PREFIX:-$HOME/.npm-global}"
export NPM_CONFIG_CACHE="${NPM_CONFIG_CACHE:-$XDG_CACHE_HOME/npm}"
export PIP_CACHE_DIR="${PIP_CACHE_DIR:-$XDG_CACHE_HOME/pip}"
export TMPDIR="${TMPDIR:-/tmp}"
export PATH="$HOME/.local/bin:$NPM_CONFIG_PREFIX/bin:$PATH"

exec "$@"
