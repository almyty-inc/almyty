# Multi-stage build for production optimization.
#
# Node 24 (Krypton) is the Active LTS and the version our sandbox
# hardening depends on: `--permission` graduated from experimental
# in 24 and the flag contract is stable from 24.0 forward. Do not
# downgrade without also auditing NodeSandboxService's execArgv
# plumbing — the worker code assumes the stable flag name.
FROM node:26-alpine AS base

# Install dependencies only when needed
FROM base AS deps
WORKDIR /app

# Copy package files
COPY package*.json ./
RUN npm ci --omit=dev --legacy-peer-deps

# Development image
FROM base AS development
WORKDIR /app

# Copy package files
COPY package*.json ./
RUN npm ci --legacy-peer-deps

# Copy source code
COPY . .

EXPOSE 3000

CMD ["npm", "run", "start:dev"]

# Build stage
FROM base AS builder
WORKDIR /app

# Copy package files and install all dependencies
COPY package*.json ./
RUN npm ci --legacy-peer-deps

# Copy source code and build the EE assembly (one-image open-core model:
# the image contains the EE modules, every EE route is entitlement-gated at
# runtime and 402s without a license token; `npm run build` gives pure OSS).
COPY . .
RUN npm run build:ee && node scripts/ee-di-smoke.js && echo "Build timestamp: $(date)"

# Production image
FROM base AS production
WORKDIR /app

# Create non-root user
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nestjs

# Copy package files and install production dependencies
COPY package*.json ./
RUN npm ci --omit=dev --legacy-peer-deps && npm cache clean --force

# Copy built application (EE layout: dist-ee/src + dist-ee/ee)
COPY --from=builder --chown=nestjs:nodejs /app/dist-ee ./dist-ee

# --- Agent-factory build toolchain -------------------------------------------
# The build processor runs in this pod (a BullMQ consumer), so the tools it
# shells out to have to be present or every build reports "not installed".
#
# bun compiles the terminal app and standalone binary; rcodesign signs and
# notarises macOS artifacts. Both run cleanly on alpine/musl.
#
# NOT here, on purpose: osslsigncode (Windows signing) is not packaged for
# alpine, and electron-builder (desktop apps) needs a glibc base. Those two
# belong in the dedicated glibc build-worker image described in
# docs/builder-image-topology.md; on this image a Windows-signing or desktop
# build reports a clear "not available on this deployment" rather than a crash.
ARG TARGETARCH
RUN apk add --no-cache libgcc libstdc++ curl
COPY --from=oven/bun:1-alpine /usr/local/bin/bun /usr/local/bin/bun
RUN set -eux; \
    case "${TARGETARCH}" in \
      amd64) RC_ARCH=x86_64 ;; \
      arm64) RC_ARCH=aarch64 ;; \
      *) RC_ARCH=x86_64 ;; \
    esac; \
    curl -sL "https://github.com/indygreg/apple-platform-rs/releases/download/apple-codesign%2F0.29.0/apple-codesign-0.29.0-${RC_ARCH}-unknown-linux-musl.tar.gz" \
      | tar xz -C /tmp; \
    mv /tmp/apple-codesign-*/rcodesign /usr/local/bin/rcodesign; \
    rm -rf /tmp/apple-codesign-*; \
    bun --version; \
    rcodesign --version
# -----------------------------------------------------------------------------

USER nestjs

EXPOSE 3000

ENV NODE_ENV=production

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "const http = require('http'); http.get('http://localhost:3000/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "dist-ee/src/main"]
