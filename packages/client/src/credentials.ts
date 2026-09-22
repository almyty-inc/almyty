/**
 * Shared credential resolver for all almyty CLI packages.
 *
 * Reads from ALMYTY_TOKEN env var first, then falls back to
 * ~/.almyty/credentials.json written by `npx @almyty/auth login`.
 */

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const CREDENTIALS_FILE = join(homedir(), '.almyty', 'credentials.json');

export interface StoredCredentials {
  url: string;
  token: string;
  email?: string;
  frontendUrl?: string;
  /**
   * When the token stops working, from the JWT's own `exp` claim.
   *
   * `@almyty/auth` writes it; this reader did not carry the field, so
   * every CLI other than `auth` could not tell an expired credential
   * from a live one and discovered the difference on its first API call
   * — as a 401 from whatever the user was actually trying to do.
   */
  expiresAt?: string;
}

/** Past its `exp`, treating a malformed or absent value as "no idea, assume live". */
export function credentialsExpired(creds: Pick<StoredCredentials, 'expiresAt'>): boolean {
  if (!creds.expiresAt) return false;
  const at = Date.parse(creds.expiresAt);
  return Number.isFinite(at) && at <= Date.now();
}

export function loadCredentials(): StoredCredentials | null {
  try {
    if (!existsSync(CREDENTIALS_FILE)) return null;
    return JSON.parse(readFileSync(CREDENTIALS_FILE, 'utf-8')) as StoredCredentials;
  } catch {
    return null;
  }
}

/**
 * Resolve credentials from env or file. Returns null if nothing usable
 * was found — an expired stored credential counts as nothing, because
 * using it produces a 401 on the user's actual request rather than a
 * sentence telling them to log in again.
 *
 * `ALMYTY_TOKEN` is never expiry-checked: it did not come from `auth
 * login`, so there is no claim to check and no file to correct.
 */
export function resolveCredentials(): StoredCredentials | null {
  const envToken = process.env.ALMYTY_TOKEN;
  const envUrl = process.env.ALMYTY_URL || 'https://api.almyty.com';
  if (envToken) return { url: envUrl, token: envToken };

  const stored = loadCredentials();
  if (stored?.token && !credentialsExpired(stored)) return stored;

  return null;
}

/**
 * Resolve credentials or exit.
 *
 * Exits 3, which is "not authenticated" in the exit-code table every
 * almyty CLI shares (0 ok, 1 unexpected, 2 usage, 3 not authenticated,
 * 4 not found, 5 the operation ran and failed). It exited 1 before, so
 * a script could not tell a stale login from a crash.
 */
export function resolveCredentialsOrExit(): StoredCredentials {
  const creds = resolveCredentials();
  if (creds) return creds;

  const stored = loadCredentials();
  if (stored?.token && credentialsExpired(stored)) {
    console.error(`Your login expired on ${stored.expiresAt}. Run:`);
    console.error('  npx @almyty/auth login');
    process.exit(3);
  }

  console.error('Not authenticated. Run one of:');
  console.error('  npx @almyty/auth login');
  console.error('  export ALMYTY_TOKEN=<your-token>');
  process.exit(3);
}

/**
 * Extract the default org slug from a JWT token.
 * Returns null if the token isn't a JWT or has no orgs.
 */
export function getOrgSlugFromToken(token: string): string | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    let payload = parts[1];
    payload += '='.repeat((4 - payload.length % 4) % 4);
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString());
    const orgs = decoded.organizations;
    if (!Array.isArray(orgs) || !orgs.length) return null;
    // Use slug if available, otherwise derive from name
    const org = orgs[0];
    if (org.slug) return org.slug;
    if (org.name) return org.name.toLowerCase().replace(/\s+/g, '-');
    return null;
  } catch {
    return null;
  }
}
