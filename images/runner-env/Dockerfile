# almyty/runner-env: the curated images a hosted runner pod runs.
#
# One Dockerfile, one target per flavour:
#
#   node              base + pnpm and yarn
#   python            base + pip, venv and the headers native wheels build against
#   standard          node + python + the coding CLIs (the default an environment gets)
#   standard-browser  standard + Playwright and headless Chromium
#
# `base` is not offered on its own; it is what the flavours share: Debian
# slim with Node 26 (the repo's one Node major, scripts/check-node-version.js),
# git, the common build tools, tini, and @almyty/runner at a pinned version.
#
# Built for the pod the backend writes (backend/src/modules/hosted-runners/
# adapters/kubernetes/manifests.ts): uid/gid 1000, read-only root, the
# workspace volume at /workspace and an emptyDir at /tmp as the only
# writable places, HOME=/workspace/.home. Nothing here writes outside those
# at run time: npm, pip and corepack-style tools are pointed at HOME by the
# entrypoint.
#
# Build one flavour (from the repo root):
#   docker build --target standard -t almyty/runner-env:standard-1.5.4 images/runner-env
#
# Build with the runner from this checkout instead of the registry (what CI
# does, so a change to packages/runner is exercised in the image before it is
# published): put `npm pack` output named almyty-runner.tgz in a folder and
# pass it as the `runner-pkg` build context:
#   docker build --target standard --build-context runner-pkg=<folder> images/runner-env
#
# The tags and the pinned runner version are listed in settings.json next to
# this file; keep RUNNER_VERSION below and that file in step
# (scripts/check-runner-env-images.js).

# Empty unless a `runner-pkg` build context replaces it.
FROM scratch AS runner-pkg

FROM node:26-bookworm-slim AS base
ARG RUNNER_VERSION=1.5.4

LABEL org.opencontainers.image.source="https://github.com/almyty-inc/almyty" \
      org.opencontainers.image.description="almyty hosted runner environment" \
      org.opencontainers.image.licenses="Apache-2.0"

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    ALMYTY_WORKSPACE_ROOT=/workspace \
    PIP_BREAK_SYSTEM_PACKAGES=1

# build-essential and python3 are also what node-gyp needs for node-pty,
# the runner's PTY binding, which has no prebuilt Linux binary.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash ca-certificates curl git git-lfs gnupg jq less make openssh-client \
      procps python3 tini unzip xz-utils zip build-essential pkg-config \
 && rm -rf /var/lib/apt/lists/*

RUN --mount=type=bind,from=runner-pkg,target=/opt/runner-pkg \
    if [ -f /opt/runner-pkg/almyty-runner.tgz ]; then \
      PKG=/opt/runner-pkg/almyty-runner.tgz; \
    else \
      PKG="@almyty/runner@${RUNNER_VERSION}"; \
    fi \
 && npm install --global --omit=dev --no-audit --no-fund "$PKG" \
 && npm cache clean --force \
 && rm -rf /root/.npm /root/.cache /tmp/* \
 && almyty-runner --version

# The node image's own user is uid/gid 1000, what the Deployment runs as.
# Named for what it is; its home is replaced by HOME=/workspace/.home at
# run time.
RUN usermod --login runner --home /workspace/.home node \
 && groupmod --new-name runner node \
 && mkdir -p /workspace \
 && chown 1000:1000 /workspace

COPY --chmod=0755 entrypoint.sh /usr/local/bin/runner-env-entrypoint

WORKDIR /workspace
USER 1000:1000
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/runner-env-entrypoint"]
CMD ["almyty-runner", "start", "--enroll"]

FROM base AS node
ARG PNPM_VERSION=12.10.1
ARG YARN_VERSION=1.22.22
USER root
RUN npm install --global --no-audit --no-fund "pnpm@${PNPM_VERSION}" "yarn@${YARN_VERSION}" \
 && npm cache clean --force \
 && rm -rf /root/.npm /root/.cache /tmp/*
USER 1000:1000

FROM base AS python
USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3-dev python3-pip python3-venv \
 && rm -rf /var/lib/apt/lists/* \
 && ln -sf /usr/bin/python3 /usr/local/bin/python
USER 1000:1000

# The coding CLIs the runner detects and drives (packages/runner/src/
# coding-agents/registry.ts), each from its vendor's own package at a pinned
# version: Claude Code, Codex and Gemini CLI from npm, aider from PyPI in its
# own venv so its pinned dependencies never meet a project's. Installed into
# the image, read-only at run time; what they write (config, sessions,
# caches) goes under HOME=/workspace/.home on the volume. The entrypoint
# points them at almyty's model endpoints when the pod carries a model token.
FROM node AS standard
ARG CLAUDE_CODE_VERSION=2.1.293
ARG CODEX_VERSION=0.161.0
ARG GEMINI_CLI_VERSION=0.63.0
ARG AIDER_VERSION=0.86.2
USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3-dev python3-pip python3-venv \
 && rm -rf /var/lib/apt/lists/* \
 && ln -sf /usr/bin/python3 /usr/local/bin/python
RUN npm install --global --no-audit --no-fund \
      "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
      "@openai/codex@${CODEX_VERSION}" \
      "@google/gemini-cli@${GEMINI_CLI_VERSION}" \
 && npm cache clean --force \
 && rm -rf /root/.npm /root/.cache /tmp/*
RUN python3 -m venv /opt/aider \
 && /opt/aider/bin/pip install --no-cache-dir --disable-pip-version-check "aider-chat==${AIDER_VERSION}" \
 && ln -s /opt/aider/bin/aider /usr/local/bin/aider \
 && rm -rf /root/.cache /tmp/*
# No self-updates (the root is read-only and the version is the image's),
# no first-run questions and no analytics calls from a pod whose egress is
# an allowlist.
ENV DISABLE_AUTOUPDATER=1 \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
    AIDER_CHECK_UPDATE=false \
    AIDER_ANALYTICS_DISABLE=true \
    AIDER_SHOW_RELEASE_NOTES=false
USER 1000:1000

# standard + headless Chromium for agents that need a browser. Playwright
# at a pinned version with the headless Chromium build it was released
# against (`--only-shell`: a pod has no display, and the full browser adds
# 400 MB) and the system libraries it needs (`--with-deps`). The browser
# sits in /opt/ms-playwright, read-only at run time; a project that pins
# another Playwright release sets PLAYWRIGHT_BROWSERS_PATH under HOME and
# installs its own. NODE_PATH makes the global `playwright` requirable
# without a project install.
#
# Chromium runs without its own sandbox here, which is Playwright's default
# (chromiumSandbox: false adds --no-sandbox). The sandbox needs either a
# setuid helper, which allowPrivilegeEscalation: false rules out, or
# unprivileged user namespaces, which the RuntimeDefault seccomp profile
# refuses to a pod without CAP_SYS_ADMIN. The pod itself is the sandbox:
# gVisor, non-root, no capabilities, read-only root.
FROM standard AS standard-browser
ARG PLAYWRIGHT_VERSION=1.64.0
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright \
    NODE_PATH=/usr/local/lib/node_modules
USER root
RUN npm install --global --no-audit --no-fund "playwright@${PLAYWRIGHT_VERSION}" \
 && playwright install --with-deps --only-shell chromium \
 && chmod -R a+rX /opt/ms-playwright \
 && npm cache clean --force \
 && rm -rf /var/lib/apt/lists/* /root/.npm /root/.cache /tmp/*
USER 1000:1000
