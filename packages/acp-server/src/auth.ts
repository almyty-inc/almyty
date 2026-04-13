/**
 * Credential resolver for @almyty/acp-server.
 *
 * Reads the shared credential store written by `npx @almyty/auth login`.
 * Lookup order: ALMYTY_TOKEN env var, then ~/.almyty/credentials.json.
 */

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CREDENTIALS_FILE = join(homedir(), '.almyty', 'credentials.json');

interface StoredCredentials {
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
 * Resolve token: env var > stored credentials. Returns null when no
 * credentials are available.
 */
export function resolveCredentials(): { url: string; token: string } | null {
  const envToken = process.env.ALMYTY_TOKEN;
  const envUrl = process.env.ALMYTY_URL || 'https://api.almyty.com';

  if (envToken) {
    return { url: envUrl, token: envToken };
  }

  const creds = loadCredentials();
  if (creds?.token) {
    return { url: creds.url, token: creds.token };
  }

  return null;
}
