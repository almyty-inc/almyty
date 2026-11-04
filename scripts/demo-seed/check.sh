#!/bin/sh
# The demo seed's checks, a step of `npm run check` (scripts/check.js): its
# two dependencies (zod, and Playwright's library without a browser), then
# its tests (engine, schema, fakes, and that every local-demo screenshot in
# the manifest is taken by exactly one walk step) and the type check. No
# stack, no browser, no ports.
set -e
cd "$(dirname "$0")"
npm ci --no-audit --no-fund --loglevel=error
npm test
npm run typecheck
