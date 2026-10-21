# Security headers for every response the frontend container serves.
#
# nginx's add_header is NOT additive across contexts: the moment a location
# (or an `if` block inside one) declares any add_header of its own, it stops
# inheriting the server-level set. So the server block AND every block that
# sets a Cache-Control / CORS / Content-Type header must include this file,
# or that block silently ships without a CSP or frame protection.
# frontend/src/__tests__/nginx-conf.test.ts enforces the pairing.
add_header X-Frame-Options "SAMEORIGIN" always;
add_header X-Content-Type-Options "nosniff" always;
add_header X-XSS-Protection "0" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
# Fonts: index.html loads Manrope, DM Sans and JetBrains Mono from Google
# Fonts (stylesheet from fonts.googleapis.com, files from fonts.gstatic.com);
# without these two sources production silently fell back to system fonts.
# Sentry: error reports go to its regional ingest host; without it every
# report was refused and production crashes never reached Sentry.
# Captcha: the sign-up form loads Cloudflare Turnstile (or hCaptcha) from
# src/components/auth/captcha-widget.tsx. Without its script and iframe origin
# the widget never rendered and every sign-up failed "Verification required".
# Sources are exactly what each provider documents: Turnstile needs
# script-src + frame-src on challenges.cloudflare.com; hCaptcha needs
# script/frame/style/connect-src on hcaptcha.com and *.hcaptcha.com.
# frame-src keeps 'self', the default-src fallback it had before.
# API: the SPA calls the API it was built against, and the chat widget
# preview frames a page from it (/gateways/:id/widget-preview). Both sources
# are nginx variables that docker-entrypoint.sh derives from
# ALMYTY_API_BASE_URL when the container starts (/tmp/almyty-csp.conf, read
# by nginx.conf), so an image built for another domain allows that domain:
#   $almyty_api_connect_src  the API origin, or https://*.almyty.com when the
#                            API is an almyty.com host; empty for same-origin
#   $almyty_api_frame_src    the API origin exactly; empty for same-origin
add_header Content-Security-Policy "default-src 'self'; script-src 'self' https://challenges.cloudflare.com https://hcaptcha.com https://*.hcaptcha.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://hcaptcha.com https://*.hcaptcha.com; img-src 'self' data: https:; font-src 'self' data: https://fonts.gstatic.com; connect-src 'self' $almyty_api_connect_src https://*.ingest.de.sentry.io https://*.ingest.sentry.io https://hcaptcha.com https://*.hcaptcha.com; frame-src 'self' $almyty_api_frame_src https://challenges.cloudflare.com https://hcaptcha.com https://*.hcaptcha.com; frame-ancestors 'self'; object-src 'none'; base-uri 'self';" always;
