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
 * Resolve credentials from env or file. Returns null if nothing found.
 */
export function resolveCredentials(): StoredCredentials | null {
  const envToken = process.env.ALMYTY_TOKEN;
  const envUrl = process.env.ALMYTY_URL || 'https://api.almyty.com';
  if (envToken) return { url: envUrl, token: envToken };

  const stored = loadCredentials();
  if (stored?.token) return stored;

  return null;
}

/**
 * Resolve credentials or exit with an error message.
 */
export function resolveCredentialsOrExit(): StoredCredentials {
  const creds = resolveCredentials();
  if (creds) return creds;

  console.error('Not authenticated. Run one of:');
  console.error('  npx @almyty/auth login');
  console.error('  export ALMYTY_TOKEN=<your-token>');
  process.exit(1);
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
