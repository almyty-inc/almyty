/**
 * Authentication helpers for the almyty MCP server.
 *
 * Supports:
 * 1. Environment variable (APIFAI_TOKEN) — for CI/scripts
 * 2. Stored credentials (~/.almyty/credentials.json) — for interactive use
 * 3. Interactive login (npx @almyty/mcp-server login) — stores credentials
 */

import { readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { createInterface } from 'readline';

const CREDENTIALS_DIR = join(homedir(), '.almyty');
const CREDENTIALS_FILE = join(CREDENTIALS_DIR, 'credentials.json');

interface StoredCredentials {
  url: string;
  token: string;
  email?: string;
  expiresAt?: string;
}

/**
 * Load stored credentials from ~/.almyty/credentials.json
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
 * Save credentials to ~/.almyty/credentials.json
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
    }
  } catch {
    // Ignore errors
  }
}

/**
 * Interactive login: prompts for email/password, authenticates against
 * the almyty backend, and stores the JWT token.
 */
export async function login(baseUrl: string): Promise<void> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stderr, // Use stderr so stdout stays clean for MCP
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
      const error: any = await response.json().catch(() => ({ message: 'Authentication failed' }));
      console.error(`Error: ${error.message || 'Authentication failed'}`);
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

    console.error(`\nLogged in successfully as ${email}`);
    console.error(`Credentials saved to ${CREDENTIALS_FILE}`);
    console.error('\nYou can now use the MCP server without APIFAI_TOKEN:');
    console.error('  npx @almyty/mcp-server');
  } finally {
    rl.close();
  }
}
