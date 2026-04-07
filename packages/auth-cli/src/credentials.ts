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
  mkdirSync(CREDENTIALS_DIR, { recursive: true });
  writeFileSync(CREDENTIALS_FILE, JSON.stringify(creds, null, 2));
  // Ensure the file is owner-only readable. writeFileSync's `mode` option
  // only applies on creation; chmod is idempotent and safer when the file
  // already exists with looser permissions.
  try {
    chmodSync(CREDENTIALS_FILE, 0o600);
  } catch {
    // Best-effort on platforms (Windows) where chmod may not apply.
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
