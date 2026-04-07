/**
 * Credential resolver for @almyty/mcp-server.
 *
 * Authentication itself lives in the dedicated @almyty/auth package
 * (`npx @almyty/auth login`). This module just READS the shared
 * credentials store and surfaces them to the MCP server runtime.
 *
 * Lookup order:
 *   1. ALMYTY_TOKEN environment variable      (CI / scripts / config files)
 *   2. ~/.almyty/credentials.json              (interactive use, written
 *                                               by `npx @almyty/auth login`)
 */

import { readFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

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
 * credentials are available — the MCP server caller decides whether
 * that's fatal (it usually is, but read-only diagnostics may not need
 * a token).
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
