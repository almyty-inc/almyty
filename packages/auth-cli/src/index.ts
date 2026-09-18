#!/usr/bin/env node
/**
 * @almyty/auth — login / logout / whoami for almyty CLIs.
 *
 *   npx @almyty/auth login                # browser-based login (default)
 *   npx @almyty/auth login --token <T>    # paste a token directly
 *   npx @almyty/auth logout
 *   npx @almyty/auth whoami [--json] [--verify]
 */

import { browserLogin } from './browser-login.js';
import {
  CREDENTIALS_FILE,
  credentialSummary,
  expiryState,
  loadCredentials,
  saveCredentials,
  clearCredentials,
} from './credentials.js';
import {
  CONFIG_FILE,
  resolveApiUrl,
  resolveFrontendUrl,
  saveConfig,
} from './config.js';
import { parseArgs, flagString, type ParsedArgs } from './args.js';
import { EXIT } from './exit-codes.js';
import { VERSION } from './version.js';

/** Flags that are switches, so they never swallow the next token. */
const BOOLEAN_FLAGS = ['no-browser', 'verify'] as const;

function printHelp(): void {
  console.log(`@almyty/auth v${VERSION}

One login for every almyty CLI. The credentials it writes are read by
@almyty/agents, @almyty/chat, @almyty/skills, @almyty/models,
@almyty/connections, @almyty/mcp-server and @almyty/runner.

Usage:
  npx @almyty/auth <command> [options]

Commands:
  login                Open the browser, log in, store credentials
  logout               Remove stored credentials
  whoami               Show the stored identity and when it expires
  help                 Show this help

Login options:
  --token <T>          Skip the browser, store this token directly (CI)
  --frontend <url>     Frontend origin hosting /cli-login (default https://app.almyty.com)
  --api <url>          API origin to store alongside the token (default https://api.almyty.com)
  --no-browser         Print the login URL instead of opening a browser

whoami options:
  --verify             Also call the API to confirm the token still works
  --json               Machine-readable output, no decoration

Global options:
  --json               Machine-readable output where the command has any
  --help, -h           Show this help
  --version, -v        Print the version

Environment:
  ALMYTY_TOKEN         Token override (read instead of the credentials file)
  ALMYTY_URL           API URL override
  ALMYTY_FRONTEND_URL  Frontend URL override
  NO_COLOR             Honoured; these commands emit no ANSI colour anyway

Files:
  ${CREDENTIALS_FILE}
      The token, the API URL it belongs to, and its expiry. Written
      mode 0600 in a 0700 directory.
  ${CONFIG_FILE}
      The API and frontend URLs \`login\` was pointed at, so later
      commands do not need the flags again.

Exit codes:
  0  success
  1  unexpected error
  2  usage error (bad flags, unknown command)
  3  not authenticated, or the stored token was rejected
`);
}

function emitJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

async function cmdLogin(args: ParsedArgs): Promise<void> {
  // resolveApiUrl refuses a plaintext remote URL, so do it before
  // anything is written to disk. A bad URL is the user's typo, not an
  // internal failure -- exit 2 so a script can tell the two apart
  // instead of seeing the same 1 it gets for a network blip.
  let apiUrl: string;
  let frontendUrl: string;
  try {
    apiUrl = resolveApiUrl(flagString(args.flags, 'api'));
    frontendUrl = resolveFrontendUrl(flagString(args.flags, 'frontend'));
  } catch (err: any) {
    console.error(err.message);
    process.exit(EXIT.USAGE);
  }

  // Direct token paste — skips the browser entirely.
  const token = flagString(args.flags, 'token');
  if (token !== undefined) {
    if (token.trim().length === 0) {
      console.error('--token needs a value.');
      process.exit(EXIT.USAGE);
    }
    saveCredentials({ url: apiUrl, token, frontendUrl });
    saveConfig({ apiUrl, frontendUrl });
    console.error(`Token saved to ${CREDENTIALS_FILE}`);
    return;
  }

  try {
    const result = await browserLogin({
      frontendUrl,
      openBrowser: args.flags['no-browser'] !== true,
    });
    saveCredentials({
      url: apiUrl,
      token: result.token,
      frontendUrl: result.frontendUrl,
    });
    // Only once the login succeeded. Persisting the URLs first meant a
    // cancelled `login --api <typo>` left the typo behind for every
    // later command to fail against.
    saveConfig({ apiUrl, frontendUrl });
    console.error('');
    console.error(`Logged in. Credentials saved to ${CREDENTIALS_FILE}`);
  } catch (err: any) {
    console.error('');
    console.error(`Login failed: ${err.message}`);
    console.error('');
    console.error('Alternatives:');
    console.error('  npx @almyty/auth login --token <T>   # paste a token directly');
    console.error('  npx @almyty/auth login --no-browser  # show the URL only');
    process.exit(EXIT.AUTH);
  }
}

function cmdLogout(args: ParsedArgs): void {
  const removed = clearCredentials();
  if (args.flags.json) {
    emitJson({ removed, credentialsFile: CREDENTIALS_FILE });
    return;
  }
  console.error(removed ? 'Logged out.' : 'No stored credentials.');
}

/**
 * Ask the API who this token belongs to. Returns the profile, or a
 * reason string when the token is no longer good for anything.
 */
async function fetchProfile(
  url: string,
  token: string,
): Promise<{ ok: true; email?: string; organizations: string[] } | { ok: false; reason: string }> {
  let res: Response;
  try {
    res = await fetch(`${url.replace(/\/$/, '')}/auth/profile`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch (err: any) {
    return { ok: false, reason: `could not reach ${url}: ${err.message}` };
  }
  if (res.status === 401 || res.status === 403) {
    return { ok: false, reason: 'the API rejected this token' };
  }
  if (!res.ok) {
    return { ok: false, reason: `API error ${res.status}` };
  }
  const body: any = await res.json().catch(() => null);
  const profile = body?.data ?? body ?? {};
  const organizations: string[] = Array.isArray(profile.organizationMemberships)
    ? profile.organizationMemberships
        .map((m: any) => m?.organization?.slug || m?.organization?.name)
        .filter((s: unknown): s is string => typeof s === 'string')
    : [];
  return { ok: true, email: profile.email, organizations };
}

async function cmdWhoami(args: ParsedArgs): Promise<void> {
  const creds = loadCredentials();
  if (!creds?.token) {
    if (args.flags.json) {
      emitJson({ authenticated: false, credentialsFile: CREDENTIALS_FILE });
    } else {
      console.error('Not logged in. Run: npx @almyty/auth login');
    }
    process.exit(EXIT.AUTH);
  }

  const summary = credentialSummary(creds);
  const expiry = expiryState(creds);

  let verified: { ok: boolean; reason?: string; email?: string; organizations?: string[] } | undefined;
  if (args.flags.verify) {
    const profile = await fetchProfile(creds.url, creds.token);
    verified = profile.ok
      ? { ok: true, email: profile.email, organizations: profile.organizations }
      : { ok: false, reason: profile.reason };
  }

  if (args.flags.json) {
    emitJson({
      authenticated: true,
      ...summary,
      expiry: expiry.state,
      expiresAt: creds.expiresAt ?? null,
      credentialsFile: CREDENTIALS_FILE,
      ...(verified ? { verified } : {}),
    });
  } else {
    console.log(`API:       ${summary.url}`);
    if (summary.frontendUrl) console.log(`Frontend:  ${summary.frontendUrl}`);
    if (verified?.email || summary.email) {
      console.log(`Email:     ${verified?.email ?? summary.email}`);
    }
    console.log(`Token:     ${summary.tokenPreview}`);
    console.log(`Expiry:    ${expiry.message}`);
    if (verified?.organizations?.length) {
      console.log(`Orgs:      ${verified.organizations.join(', ')}`);
    }
    if (verified) {
      console.log(
        verified.ok
          ? 'Verified:  the API accepted this token'
          : `Verified:  no — ${verified.reason}`,
      );
    }
  }

  // An expired or rejected credential is not a working login, whatever
  // the file says. Reporting success here meant every other CLI's first
  // call was the one that discovered the token was dead.
  if (expiry.state === 'expired' || verified?.ok === false) {
    if (!args.flags.json) {
      console.error('');
      console.error('Run `npx @almyty/auth login` to refresh it.');
    }
    process.exit(EXIT.AUTH);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2), BOOLEAN_FLAGS);

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
      cmdLogout(args);
      return;
    case 'whoami':
      await cmdWhoami(args);
      return;
    default:
      console.error(`Unknown command: ${args.command}`);
      console.error('Commands: login, logout, whoami. Run --help for detail.');
      process.exit(EXIT.USAGE);
  }
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(EXIT.ERROR);
});
