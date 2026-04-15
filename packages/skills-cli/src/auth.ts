/**
 * Credential resolver for @almyty/skills.
 *
 * Authentication itself lives in the dedicated @almyty/auth package
 * (`npx @almyty/auth login`). This module just READS the shared
 * credentials store and surfaces them to the rest of the skills CLI.
 *
 * Lookup order:
 *   1. ALMYTY_TOKEN environment variable      (CI / scripts)
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

function loadCredentials(): StoredCredentials | null {
  try {
    if (!existsSync(CREDENTIALS_FILE)) return null;
    return JSON.parse(readFileSync(CREDENTIALS_FILE, 'utf-8')) as StoredCredentials;
  } catch {
    return null;
  }
}

/**
 * Resolve token: env var > stored credentials. Exits with a clear hint
 * if no credentials are available.
 */
export function resolveAuth(): { url: string; token: string } {
  const envToken = process.env.ALMYTY_TOKEN;
  // Read URL from: env > config file > default
  let configUrl: string | undefined;
  try {
    const { readFileSync, existsSync } = require('fs');
    const { join } = require('path');
    const { homedir } = require('os');
    const configPath = join(homedir(), '.almyty', 'config.json');
    if (existsSync(configPath)) {
      configUrl = JSON.parse(readFileSync(configPath, 'utf-8')).apiUrl;
    }
  } catch {}
  const envUrl = process.env.ALMYTY_URL || configUrl || 'https://api.almyty.com';

  if (envToken) {
    return { url: envUrl, token: envToken };
  }

  const creds = loadCredentials();
  if (creds?.token) {
    return { url: creds.url, token: creds.token };
  }

  console.error('Not authenticated. Run one of:');
  console.error('  npx @almyty/auth login        # browser-based login');
  console.error('  export ALMYTY_TOKEN=<token>   # for CI');
  process.exit(1);
}
