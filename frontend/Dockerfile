# Stage 1: Base - install deps and build
#
# Runs on the BUILD host's own architecture: the output is static
# JS/CSS/HTML, identical for every target platform, so compiling it
# under QEMU emulation for arm64 turns a one-minute build into an
# hour. Only the nginx stage below is per-architecture.
FROM --platform= node:26-alpine AS base

WORKDIR /app

COPY package*.json ./
RUN npm ci --legacy-peer-deps

COPY . .

ARG ALMYTY_API_BASE_URL=http://localhost:3000
ENV ALMYTY_API_BASE_URL=$ALMYTY_API_BASE_URL
# PostHog product analytics (publishable client key; baked at build time).
# Cross-domain funnels stitch to the marketing site's same PostHog EU project.
ARG ALMYTY_POSTHOG_KEY=phc_wLKPNJ2JTUp7vbdjPKXcieuA6vJrjjDSib4HrSNzfV4e
ENV ALMYTY_POSTHOG_KEY=$ALMYTY_POSTHOG_KEY
# Same-origin reverse-proxy path (nginx forwards /ingest → PostHog EU),
# so ad blockers can't drop the third-party host. Override with an
# absolute URL (e.g. https://app.almyty.com/ingest) to align origins.
ARG ALMYTY_POSTHOG_HOST=/ingest
ENV ALMYTY_POSTHOG_HOST=$ALMYTY_POSTHOG_HOST
# Sentry error tracking (baked at build time). Empty by default →
# Sentry never initializes (no-op). Set the DSN to light it up.
ARG ALMYTY_SENTRY_DSN=
ENV ALMYTY_SENTRY_DSN=$ALMYTY_SENTRY_DSN
ARG ALMYTY_TURNSTILE_SITE_KEY=
ENV ALMYTY_TURNSTILE_SITE_KEY=$ALMYTY_TURNSTILE_SITE_KEY
# Tenant hosts: {slug}.<this domain>. staging must be staging.almyty.app
# or published chat URLs hit production.
# HOSTED_CHAT_BASE_DOMAIN is NOT baked here: it is per-environment k8s
# config emitted at container start by docker-entrypoint.sh.

RUN npx vite build

# Stage 2: Development
FROM node:26-alpine AS development
WORKDIR /app

COPY package*.json ./
RUN npm ci --legacy-peer-deps

COPY . .

USER node

EXPOSE 3000

CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0", "--port", "3000"]

# Stage 3: Production - serve with nginx
FROM nginx:1.31-alpine AS production

# CA bundle required for proxy_ssl_verify of PostHog upstreams.
RUN apk add --no-cache ca-certificates && update-ca-certificates

# Remove default nginx config
RUN rm /etc/nginx/conf.d/default.conf

# Copy custom nginx configuration
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY nginx-security-headers.inc /etc/nginx/conf.d/security-headers.inc

# Copy built assets from base stage
COPY --from=base /app/dist /usr/share/nginx/html

# Runtime-config entrypoint (emits /tmp/runtime-config.js from env)
COPY docker-entrypoint.sh /docker-entrypoint.d/40-almyty-runtime-config.sh
RUN chmod +x /docker-entrypoint.d/40-almyty-runtime-config.sh

# Create non-root nginx user
RUN chown -R nginx:nginx /usr/share/nginx/html && \
    chown -R nginx:nginx /var/cache/nginx && \
    chown -R nginx:nginx /var/log/nginx && \
    touch /var/run/nginx.pid && \
    chown -R nginx:nginx /var/run/nginx.pid

USER nginx

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8080/health || exit 1

CMD ["nginx", "-g", "daemon off;"]
