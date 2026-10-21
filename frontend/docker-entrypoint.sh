#!/bin/sh
# Runs from the stock nginx /docker-entrypoint.d before nginx starts.
#
# Emits the SPA's runtime configuration so the hosted-chat base domain
# is per-environment k8s config, not baked into the image. nginx serves
# /tmp/runtime-config.js at /runtime-config.js (see nginx.conf); the SPA
# reads it before boot. /tmp is the writable path under readOnlyRootFilesystem.
#
# Also writes /tmp/almyty-csp.conf, the API origin the CSP admits (see
# nginx-security-headers.inc), from ALMYTY_API_BASE_URL: the API URL the
# bundle was built against, carried into this stage by the Dockerfile.
# ALMYTY_RUNTIME_DIR moves both files, for the tests only.
set -eu

out="${ALMYTY_RUNTIME_DIR:-/tmp}"

# Only a bare hostname is ever valid here; strip anything that could
# break out of the JS string literal so a misconfigured value cannot
# inject script.
domain="$(printf '%s' "${HOSTED_CHAT_BASE_DOMAIN:-}" | tr -cd 'A-Za-z0-9.-')"

cat > "$out/runtime-config.js" <<EOF
window.__ALMYTY_RUNTIME__ = { hostedChatBaseDomain: "${domain}" };
EOF

# The origin of the API URL: scheme, host and port, nothing else, so no value
# can add a directive to the header. A relative or empty URL is the page's
# own origin, which 'self' already covers. Our own deploys keep
# https://*.almyty.com for requests, as before; a self-hosted image built for
# any other API gets exactly that origin.
origin="$(printf '%s' "${ALMYTY_API_BASE_URL:-}" | sed -nE 's#^(https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?)(/.*)?$#\1#p')"
connect_src="$origin"
case "$origin" in
  https://*.almyty.com) connect_src="https://*.almyty.com" ;;
esac

cat > "$out/almyty-csp.conf" <<EOF
map \$host \$almyty_api_connect_src { default "${connect_src}"; }
map \$host \$almyty_api_frame_src { default "${origin}"; }
EOF
