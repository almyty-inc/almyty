/**
 * Authentication helpers for the apifai skills CLI.
 *
 * Shares credentials with @apifai/mcp-server via ~/.apifai/credentials.json.
 *
 * Supports:
 * 1. Environment variable (APIFAI_TOKEN) — for CI/scripts
 * 2. Stored credentials (~/.apifai/credentials.json) — for interactive use
 * 3. Interactive login (npx @apifai/skills login) — stores credentials
 */

import { readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { createInterface } from 'readline';

const CREDENTIALS_DIR = join(homedir(), '.apifai');
const CREDENTIALS_FILE = join(CREDENTIALS_DIR, 'credentials.json');

interface StoredCredentials {
  url: string;
  token: string;
  email?: string;
  expiresAt?: string;
}

/**
 * Load stored credentials from ~/.apifai/credentials.json
 */
export function loadCredentials(): StoredCredentials | null {
  try {
    if (!existsSync(CREDENTIALS_FILE)) return null;
    const data = readFileSync(CREDENTIALS_FILE, 'utf-8');
    return JSON.parse(data);
  } catch {
    return null;
  }
}

/**
 * Save credentials to ~/.apifai/credentials.json
 */
export function saveCredentials(creds: StoredCredentials): void {
  mkdirSync(CREDENTIALS_DIR, { recursive: true });
  writeFileSync(CREDENTIALS_FILE, JSON.stringify(creds, null, 2), { mode: 0o600 });
}

/**
 * Remove stored credentials
 */
export function logout(): void {
  try {
    if (existsSync(CREDENTIALS_FILE)) {
      unlinkSync(CREDENTIALS_FILE);
      console.log('Logged out. Credentials removed.');
    } else {
      console.log('No stored credentials found.');
    }
  } catch {
    console.error('Failed to remove credentials.');
  }
}

/**
 * Resolve token: env var > stored credentials
 */
export function resolveAuth(): { url: string; token: string } {
  const envToken = process.env.APIFAI_TOKEN;
  const envUrl = process.env.APIFAI_URL || 'https://api.apif.ai';

  if (envToken) {
    return { url: envUrl, token: envToken };
  }

  const creds = loadCredentials();
  if (creds?.token) {
    return { url: creds.url, token: creds.token };
  }

  console.error('Not authenticated. Run one of:');
  console.error('  npx @apifai/skills login');
  console.error('  export APIFAI_TOKEN=<your-token>');
  process.exit(1);
}

/**
 * Interactive login: prompts for email/password, authenticates against
 * the apifai backend, and stores the JWT token.
 */
export async function login(baseUrl: string): Promise<void> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
  });

  const ask = (question: string): Promise<string> =>
    new Promise((resolve) => rl.question(question, resolve));

  try {
    console.error(`Logging in to ${baseUrl}...\n`);

    const email = await ask('Email: ');
    const password = await ask('Password: ');

    console.error('\nAuthenticating...');

    const response = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });

    if (!response.ok) {
      const errBody: any = await response.json().catch(() => ({ message: 'Authentication failed' }));
      console.error(`Error: ${errBody.message || 'Authentication failed'}`);
      process.exit(1);
    }

    const data: any = await response.json();
    const token = data.accessToken || data.token;

    if (!token) {
      console.error('Error: No token received from server');
      process.exit(1);
    }

    saveCredentials({
      url: baseUrl,
      token,
      email,
    });

    console.error(`\n✓ Logged in as ${email}`);
    console.error(`  Credentials saved to ${CREDENTIALS_FILE}`);
    console.error('\nYou can now install skills:');
    console.error('  npx @apifai/skills install --gateway <id>');
  } finally {
    rl.close();
  }
}
