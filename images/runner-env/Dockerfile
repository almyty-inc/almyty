# almyty/runner-env: the curated images a hosted runner pod runs.
#
# One Dockerfile, one target per flavour:
#
#   node      base + pnpm and yarn
#   python    base + pip, venv and the headers native wheels build against
#   standard  node + python (the default an environment gets)
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
#   docker build --target standard -t almyty/runner-env:standard-1.5.3 images/runner-env
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
ARG RUNNER_VERSION=1.5.3

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

FROM node AS standard
USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3-dev python3-pip python3-venv \
 && rm -rf /var/lib/apt/lists/* \
 && ln -sf /usr/bin/python3 /usr/local/bin/python
USER 1000:1000
