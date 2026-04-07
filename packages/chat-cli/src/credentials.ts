/**
 * Read shared almyty credentials from ~/.almyty/credentials.json.
 *
 * Identical to the helper in @almyty/auth and @almyty/agents — kept
 * inline to keep each CLI package self-contained.
 */

import { readFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

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

export function resolveCredentialsOrExit(): StoredCredentials {
  const envToken = process.env.ALMYTY_TOKEN;
  const envUrl = process.env.ALMYTY_URL || 'https://api.almyty.com';
  if (envToken) return { url: envUrl, token: envToken };

  const stored = loadCredentials();
  if (stored?.token) return stored;

  console.error('Not authenticated. Run one of:');
  console.error('  npx @almyty/auth login');
  console.error('  export ALMYTY_TOKEN=<your-token>');
  process.exit(1);
}
