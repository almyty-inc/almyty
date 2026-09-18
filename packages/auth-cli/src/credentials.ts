/**
 * Shared credentials store at ~/.almyty/credentials.json.
 *
 * Every almyty CLI (skills, agents, chat, mcp-server) reads from this same
 * file. The file is owner-readable only (mode 0600).
 */

import { readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync, chmodSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export const CREDENTIALS_DIR = join(homedir(), '.almyty');
export const CREDENTIALS_FILE = join(CREDENTIALS_DIR, 'credentials.json');

export interface StoredCredentials {
  url: string;
  token: string;
  email?: string;
  expiresAt?: string;
  // The frontend origin used to acquire this token (for browser flow).
  frontendUrl?: string;
}

export function loadCredentials(): StoredCredentials | null {
  try {
    if (!existsSync(CREDENTIALS_FILE)) return null;
    const data = readFileSync(CREDENTIALS_FILE, 'utf-8');
    return JSON.parse(data) as StoredCredentials;
  } catch {
    return null;
  }
}

export function saveCredentials(creds: StoredCredentials): void {
  // Owner-only directory (0700). mkdir's mode only applies on creation, so
  // chmod an existing dir too — best-effort (no-op/throw on Windows).
  mkdirSync(CREDENTIALS_DIR, { recursive: true, mode: 0o700 });
  try {
    chmodSync(CREDENTIALS_DIR, 0o700);
  } catch {
    /* best-effort */
  }

  // Create the file 0600 from the start (closes the brief world-readable
  // window that exists when a file is created with default perms and only
  // chmod'd afterwards). chmod again for the already-exists case.
  writeFileSync(CREDENTIALS_FILE, JSON.stringify(enrichFromToken(creds), null, 2), { mode: 0o600 });
  try {
    chmodSync(CREDENTIALS_FILE, 0o600);
  } catch {
    /* best-effort on platforms where chmod may not apply */
  }
}
export function clearCredentials(): boolean {
  if (!existsSync(CREDENTIALS_FILE)) return false;
  try {
    unlinkSync(CREDENTIALS_FILE);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the active credentials, preferring environment variables.
 * Returns null when no credentials are available.
 */
export function resolveCredentials(): StoredCredentials | null {
  const envToken = process.env.ALMYTY_TOKEN;
  const envUrl = process.env.ALMYTY_URL || 'https://api.almyty.com';
  if (envToken) {
    return { url: envUrl, token: envToken };
  }
  return loadCredentials();
}

export type ExpiryState = 'unknown' | 'valid' | 'expired';

/**
 * Whether the stored credential has passed its own `expiresAt`.
 *
 * `whoami` used to report a happy identity for a token that expired
 * weeks ago, because it only checked that the file existed. Nothing
 * here contacts the network: an expiry the token itself carries is
 * enough to say "log in again" before any command wastes a round trip.
 */
export function expiryState(
  creds: StoredCredentials,
  now: Date = new Date(),
): { state: ExpiryState; message: string } {
  if (!creds.expiresAt) {
    return { state: 'unknown', message: 'not recorded' };
  }
  const at = new Date(creds.expiresAt);
  if (Number.isNaN(at.getTime())) {
    return { state: 'unknown', message: `unreadable (${creds.expiresAt})` };
  }
  const deltaMs = at.getTime() - now.getTime();
  if (deltaMs <= 0) {
    return { state: 'expired', message: `expired ${at.toISOString()}` };
  }
  const hours = Math.floor(deltaMs / 3_600_000);
  const remaining =
    hours >= 48
      ? `${Math.floor(hours / 24)} days`
      : hours >= 1
        ? `${hours}h`
        : `${Math.max(1, Math.round(deltaMs / 60_000))}m`;
  return { state: 'valid', message: `${at.toISOString()} (in ${remaining})` };
}

/**
 * The parts of a credential that are safe to print. Never returns the
 * token itself — only a first-8/last-4 preview, enough to tell two
 * tokens apart in a bug report without pasting one into a terminal
 * someone is screen-sharing.
 */
export function credentialSummary(creds: StoredCredentials): {
  url: string;
  frontendUrl?: string;
  email?: string;
  tokenPreview: string;
} {
  const token = creds.token ?? '';
  const preview =
    token.length > 16
      ? `${token.slice(0, 8)}…${token.slice(-4)}`
      : `${'*'.repeat(Math.max(0, token.length))}`;
  return {
    url: creds.url,
    ...(creds.frontendUrl ? { frontendUrl: creds.frontendUrl } : {}),
    ...(creds.email ? { email: creds.email } : {}),
    tokenPreview: preview,
  };
}

/**
 * Read the unverified payload of a JWT.
 *
 * The CLI never validates the signature — the API does that on every
 * call. All this is for is filling in what the token already says
 * about itself (`exp`, `email`) so `whoami` can answer without a round
 * trip, and so an expired token is reported as expired instead of as a
 * working login.
 */
export function jwtClaims(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = Buffer.from(parts[1], 'base64url').toString('utf-8');
    const parsed = JSON.parse(payload);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/** The token's own `exp` claim as an ISO string, when it has one. */
export function expiresAtFromToken(token: string): string | undefined {
  const exp = jwtClaims(token)?.exp;
  if (typeof exp !== 'number' || !Number.isFinite(exp)) return undefined;
  const at = new Date(exp * 1000);
  return Number.isNaN(at.getTime()) ? undefined : at.toISOString();
}

/** The token's own `email` claim, when it has one. */
export function emailFromToken(token: string): string | undefined {
  const email = jwtClaims(token)?.email;
  return typeof email === 'string' && email.length > 0 ? email : undefined;
}

/**
 * Fill in what the token says about itself before storing it, so
 * `whoami` can report an expiry instead of "not recorded". `login`
 * stored only url+token, which is why the expiry check had nothing to
 * check.
 */
export function enrichFromToken(creds: StoredCredentials): StoredCredentials {
  return {
    ...creds,
    email: creds.email ?? emailFromToken(creds.token),
    expiresAt: creds.expiresAt ?? expiresAtFromToken(creds.token),
  };
}
