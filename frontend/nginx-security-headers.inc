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
add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data: https:; font-src 'self' data: https://fonts.gstatic.com; connect-src 'self' https://*.almyty.com https://*.ingest.de.sentry.io https://*.ingest.sentry.io; frame-ancestors 'self'; object-src 'none'; base-uri 'self';" always;
