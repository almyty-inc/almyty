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

# Coding CLIs call almyty's Anthropic- and OpenAI-compatible endpoints with
# the pod's model token (ALMYTY_MODEL_TOKEN), so vendor keys stay in the
# store and every call is routed, budgeted and attributed (design:
# hosted-runners-and-always-on.md, Decision 6). A family the pod already
# configured itself (a base URL or a key of its own) is left alone.
#   Claude Code  ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN, sent as a bearer
#                to POST /v1/messages. Not ANTHROPIC_API_KEY, which makes it
#                ask which credential to use.
#   aider        AIDER_* names, which it hands to litellm: OpenAI models go
#                to POST /v1/chat/completions, Anthropic ones to
#                /v1/messages (via ANTHROPIC_BASE_URL).
#   Codex        ignores OPENAI_BASE_URL and speaks only the Responses API,
#                so it gets a provider in its config.toml pointing at
#                POST /v1/responses. The file is rewritten on every start
#                while it carries the marker line; replace it to manage it.
#   Gemini CLI   no almyty endpoint speaks its API; a vendor key from the
#                store (GEMINI_API_KEY) is the pod's to inject.
if [ -n "${ALMYTY_MODEL_TOKEN:-}" ] && [ -n "${ALMYTY_API_URL:-}" ]; then
  api="${ALMYTY_API_URL%/}"
  if [ -z "${ANTHROPIC_BASE_URL:-}${ANTHROPIC_API_KEY:-}${ANTHROPIC_AUTH_TOKEN:-}" ]; then
    export ANTHROPIC_BASE_URL="$api"
    export ANTHROPIC_AUTH_TOKEN="$ALMYTY_MODEL_TOKEN"
    export AIDER_ANTHROPIC_API_KEY="${AIDER_ANTHROPIC_API_KEY:-$ALMYTY_MODEL_TOKEN}"
  fi
  if [ -z "${OPENAI_BASE_URL:-}${OPENAI_API_KEY:-}" ]; then
    export OPENAI_BASE_URL="$api/v1"
    export OPENAI_API_KEY="$ALMYTY_MODEL_TOKEN"
    export AIDER_OPENAI_API_BASE="${AIDER_OPENAI_API_BASE:-$OPENAI_BASE_URL}"
    export AIDER_OPENAI_API_KEY="${AIDER_OPENAI_API_KEY:-$ALMYTY_MODEL_TOKEN}"
    codex_home="${CODEX_HOME:-$HOME/.codex}"
    codex_config="$codex_home/config.toml"
    marker='# Written by the runner-env entrypoint on every start; replace this file to manage it yourself.'
    if [ ! -e "$codex_config" ] || [ "$(head -n 1 "$codex_config")" = "$marker" ]; then
      mkdir -p "$codex_home"
      printf '%s\nmodel_provider = "almyty"\n\n[model_providers.almyty]\nname = "almyty"\nbase_url = "%s"\nenv_key = "OPENAI_API_KEY"\nwire_api = "responses"\n' \
        "$marker" "$OPENAI_BASE_URL" > "$codex_config"
    fi
  fi
fi

# Claude Code opens with a first-run walkthrough a driven session cannot
# answer; mark it done once, on the volume, and leave the file alone after.
if command -v claude >/dev/null 2>&1; then
  claude_json="${CLAUDE_CONFIG_DIR:-$HOME}/.claude.json"
  if [ ! -e "$claude_json" ]; then
    mkdir -p "$(dirname "$claude_json")"
    printf '{"hasCompletedOnboarding":true}\n' > "$claude_json"
  fi
fi

exec "$@"
