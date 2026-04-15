#!/usr/bin/env node
/**
 * @almyty/auth — login / logout / whoami for almyty CLIs.
 *
 *   npx @almyty/auth login                # browser-based login (default)
 *   npx @almyty/auth login --token <T>    # paste a token directly
 *   npx @almyty/auth logout
 *   npx @almyty/auth whoami
 */

import { browserLogin } from './browser-login.js';
import {
  CREDENTIALS_FILE,
  loadCredentials,
  saveCredentials,
  clearCredentials,
} from './credentials.js';

const VERSION = '0.1.0';

function printHelp(): void {
  console.log(`
@almyty/auth v${VERSION}

Usage:
  npx @almyty/auth <command> [options]

Commands:
  login                Open the browser, log in, store credentials
  logout               Remove stored credentials
  whoami               Show the currently logged-in identity
  help                 Show this help

Login options:
  --token <T>          Skip the browser, store this token directly
  --frontend <url>     Override the frontend origin (default https://app.almyty.com)
  --api <url>          Override the API origin (default https://api.almyty.com)
  --no-browser         Print the URL but don't auto-open the browser

Environment:
  ALMYTY_TOKEN         Token override (skips ~/.almyty/credentials.json)
  ALMYTY_URL           API URL override
  ALMYTY_FRONTEND_URL  Frontend URL override

Credentials:
  Stored at ${CREDENTIALS_FILE} (mode 0600). All almyty CLIs (skills,
  agents, chat, mcp-server) read from this same file.
`);
}

interface ParsedArgs {
  command?: string;
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = { flags: {} };
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      result.flags.help = true;
    } else if (arg === '--version' || arg === '-v') {
      result.flags.version = true;
    } else if (arg === '--no-browser') {
      result.flags.noBrowser = true;
    } else if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        result.flags[key] = next;
        i++;
      } else {
        result.flags[key] = true;
      }
    } else if (!result.command) {
      result.command = arg;
    }
    i++;
  }
  return result;
}

async function cmdLogin(args: ParsedArgs): Promise<void> {
  const { resolveApiUrl, resolveFrontendUrl, saveConfig } = require('./config');
  const apiUrl = resolveApiUrl(args.flags.api as string);
  const frontendUrl = resolveFrontendUrl(args.flags.frontend as string);

  // Persist URL config so future commands don't need env vars
  saveConfig({ apiUrl, frontendUrl });

  // Direct token paste — skips the browser entirely.
  if (typeof args.flags.token === 'string') {
    saveCredentials({ url: apiUrl, token: args.flags.token, frontendUrl });
    console.error(`✓ Token saved to ${CREDENTIALS_FILE}`);
    return;
  }

  try {
    const result = await browserLogin({
      frontendUrl,
      openBrowser: !args.flags.noBrowser,
    });
    saveCredentials({
      url: apiUrl,
      token: result.token,
      frontendUrl: result.frontendUrl,
    });
    console.error('');
    console.error(`✓ Logged in. Credentials saved to ${CREDENTIALS_FILE}`);
  } catch (err: any) {
    console.error('');
    console.error(`Login failed: ${err.message}`);
    console.error('');
    console.error('Alternatives:');
    console.error('  npx @almyty/auth login --token <T>   # paste a token directly');
    console.error('  npx @almyty/auth login --no-browser  # show the URL only');
    process.exit(1);
  }
}

function cmdLogout(): void {
  const removed = clearCredentials();
  if (removed) {
    console.error('✓ Logged out.');
  } else {
    console.error('No stored credentials.');
  }
}

function cmdWhoami(): void {
  const creds = loadCredentials();
  if (!creds) {
    console.error('Not logged in. Run: npx @almyty/auth login');
    process.exit(1);
  }
  console.log(`API:      ${creds.url}`);
  if (creds.frontendUrl) console.log(`Frontend: ${creds.frontendUrl}`);
  if (creds.email) console.log(`Email:    ${creds.email}`);
  console.log(`Token:    ${creds.token.slice(0, 8)}…${creds.token.slice(-4)}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.flags.version) {
    console.log(VERSION);
    return;
  }
  if (args.flags.help || !args.command || args.command === 'help') {
    printHelp();
    return;
  }

  switch (args.command) {
    case 'login':
      await cmdLogin(args);
      return;
    case 'logout':
      cmdLogout();
      return;
    case 'whoami':
      cmdWhoami();
      return;
    default:
      console.error(`Unknown command: ${args.command}`);
      printHelp();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
