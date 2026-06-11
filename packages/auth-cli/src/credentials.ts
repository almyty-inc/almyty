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
  writeFileSync(CREDENTIALS_FILE, JSON.stringify(creds, null, 2), { mode: 0o600 });
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
