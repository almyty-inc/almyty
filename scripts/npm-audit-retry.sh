#!/usr/bin/env bash
# npm audit, retried when the registry's advisory endpoint is the thing
# failing rather than our dependency tree.
#
# `npm audit` exits 1 both for "vulnerabilities found" and for "could not
# reach https://registry.npmjs.org/-/npm/v1/security/advisories/bulk".
# The second one is an outage on npm's side (it took every PR down for a
# morning on 2026-09-04), so tell them apart by the error text and retry
# only that case with backoff. Real findings still fail immediately.
#
# Usage: scripts/npm-audit-retry.sh [npm audit args...]
set -uo pipefail

attempts="${NPM_AUDIT_ATTEMPTS:-4}"
delay="${NPM_AUDIT_BACKOFF_SECONDS:-20}"

for ((i = 1; i <= attempts; i++)); do
  out="$(npm audit "$@" 2>&1)"
  code=$?
  printf '%s\n' "$out"
  if [ "$code" -eq 0 ]; then
    exit 0
  fi
  if ! grep -qiE 'audit endpoint returned an error|network timeout|ECONNRESET|ETIMEDOUT|EAI_AGAIN|503 Service Unavailable|502 Bad Gateway' <<<"$out"; then
    # A genuine finding (or anything that is not a transport failure).
    exit "$code"
  fi
  if [ "$i" -lt "$attempts" ]; then
    echo "::warning::npm audit could not reach the registry advisory endpoint (attempt $i/$attempts); retrying in ${delay}s"
    sleep "$delay"
    delay=$((delay * 2))
  fi
done

echo "::error::npm audit failed to reach the registry advisory endpoint after $attempts attempts"
exit "$code"
