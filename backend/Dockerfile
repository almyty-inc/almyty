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
RUN npm run build:ee && echo "Build timestamp: $(date)"

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

USER nestjs

EXPOSE 3000

ENV NODE_ENV=production

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "const http = require('http'); http.get('http://localhost:3000/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "dist-ee/src/main"]
