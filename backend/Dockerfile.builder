# Agent-app build worker (mode: worker).
#
# The full build toolchain on a glibc base, so a dedicated deployment can
# produce and sign every target — terminal apps and standalone binaries
# (bun), macOS artifacts (rcodesign, sign + notarise), Windows executables
# (osslsigncode), and desktop apps (electron-builder). It consumes the same
# build queue as the API; the API pods run with APP_BUILD_MODE=off so they
# do not grab jobs this worker is here to handle.
#
# Kept separate from the API image on purpose: compilers, packagers and
# signing tools do not belong in the request-serving pod. See
# docs/builder-image-topology.md.

# --- build the app (same as the API image) ---
FROM node:26-bookworm-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --legacy-peer-deps
COPY . .
RUN npm run build:ee && node scripts/ee-di-smoke.js

# --- runtime: the app plus the full build toolchain ---
FROM node:26-bookworm-slim AS worker
WORKDIR /app

ARG TARGETARCH
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl unzip xz-utils \
      osslsigncode \
      libarchive-tools fakeroot \
 && rm -rf /var/lib/apt/lists/*

# bun — terminal apps and standalone binaries.
RUN curl -fsSL https://bun.sh/install | bash \
 && mv /root/.bun/bin/bun /usr/local/bin/bun \
 && bun --version

# rcodesign — macOS signing and notarisation. The musl static build runs
# on glibc; arch-selected for amd64 and arm64.
RUN set -eux; \
    case "${TARGETARCH}" in \
      amd64) RC_ARCH=x86_64 ;; \
      arm64) RC_ARCH=aarch64 ;; \
      *) RC_ARCH=x86_64 ;; \
    esac; \
    curl -sL "https://github.com/indygreg/apple-platform-rs/releases/download/apple-codesign%2F0.29.0/apple-codesign-0.29.0-${RC_ARCH}-unknown-linux-musl.tar.gz" | tar xz -C /tmp; \
    mv /tmp/apple-codesign-*/rcodesign /usr/local/bin/rcodesign; \
    rm -rf /tmp/apple-codesign-*; \
    rcodesign --version

# The terminal client bun compiles, same as the API image (#538). Without
# an entry point, a terminal or binary build fails with nothing to build.
RUN mkdir -p /opt/almyty \
 && cd /opt/almyty \
 && npm install --omit=dev --legacy-peer-deps @almyty/chat@1.2.0 \
 && test -f /opt/almyty/node_modules/@almyty/chat/dist/index.js
ENV APP_BUILD_CLIENT_ENTRY=/opt/almyty/node_modules/@almyty/chat/dist/index.js

# The Electron shell a desktop build packages. Copied from the repo
# because it is a private workspace package, not published to npm. This
# is the reason the worker exists: electron-builder needs it, and it is
# not in the API image.
COPY --from=builder /app/packages/desktop-shell /opt/almyty/desktop-shell
ENV APP_BUILD_DESKTOP_SHELL=/opt/almyty/desktop-shell

# Production deps + the built app.
COPY package*.json ./
RUN npm ci --omit=dev --legacy-peer-deps && npm cache clean --force
COPY --from=builder /app/dist-ee ./dist-ee

# This process is the build worker: consume build jobs, and only those.
ENV NODE_ENV=production
ENV APP_BUILD_MODE=worker
# electron-builder needs the terminal client + shell to package; those are
# resolved the same way the processor already resolves them.

CMD ["node", "dist-ee/src/main"]
