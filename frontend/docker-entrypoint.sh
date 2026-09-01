#!/bin/sh
# Runs from the stock nginx /docker-entrypoint.d before nginx starts.
#
# Emits the SPA's runtime configuration so the hosted-chat base domain
# is per-environment k8s config, not baked into the image. nginx serves
# /tmp/runtime-config.js at /runtime-config.js (see nginx.conf); the SPA
# reads it before boot. /tmp is the writable path under readOnlyRootFilesystem.
set -eu

# Only a bare hostname is ever valid here; strip anything that could
# break out of the JS string literal so a misconfigured value cannot
# inject script.
domain="$(printf '%s' "${HOSTED_CHAT_BASE_DOMAIN:-}" | tr -cd 'A-Za-z0-9.-')"

cat > /tmp/runtime-config.js <<EOF
window.__ALMYTY_RUNTIME__ = { hostedChatBaseDomain: "${domain}" };
EOF
