#!/usr/bin/env node
/**
 * @almyty/connections: third-party accounts from the terminal.
 *
 *   almyty connections connectors [--kind inference]
 *   almyty connections list
 *   almyty connections connect <connectorKey> [--method api_key] [--owner org|user] [--input '<json>'] [--open]
 *   almyty connections complete <connectorKey> --state s --code c     (headless OAuth: paste the code)
 *   almyty connections validate <id>
 *   almyty connections rotate <id>
 *   almyty connections disconnect <id>
 *   almyty connections grants <id>
 *   almyty connections grant <id> --principal user|team|role|agent|workspace --to <principalId> [--permission use|manage] [--expires <iso>]
 *   almyty connections revoke <id> <grantId>
 *
 * Secrets are typed into the terminal or passed as --input and go straight
 * to the API over TLS; nothing is written to disk by this tool.
 */
import { createInterface } from 'readline';
import { AlmytyClient, resolveCredentialsOrExit } from '@almyty/client';

const VERSION = '1.2.0';

export interface ParsedArgs {
  command?: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = { positional: [], flags: {} };
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') result.flags.help = true;
    else if (arg === '--version' || arg === '-v') result.flags.version = true;
    else if (arg === '--json' || arg === '--open') result.flags[arg.slice(2)] = true;
    else if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        result.flags[key] = next;
        i++;
      } else result.flags[key] = true;
    } else if (!result.command) result.command = arg;
    else result.positional.push(arg);
    i++;
  }
  return result;
}

function printHelp(): void {
  console.log(`
@almyty/connections v${VERSION}

Usage:
  npx @almyty/connections <command> [options]

Commands:
  connectors [--kind k]                 Connector catalog (what can be connected, and how)
  list                                  Connected accounts with health
  connect <connectorKey> [--method m] [--owner org|user] [--input '<json>'] [--open]
                                        API-key style methods prompt for each field (secrets hidden);
                                        OAuth methods print the authorize URL (--open launches the browser)
  complete <connectorKey> --state s --code c
                                        Finish an OAuth connect by pasting the code
  validate <id>                         Re-check a connection and refresh its account label
  rotate <id>                           Run the connect method again for a new secret
  disconnect <id>                       Revoke at the provider where possible and remove
  grants <id>                           Who may use this connection
  grant <id> --principal p --to id [--permission use|manage] [--expires iso]
  revoke <id> <grantId>

Options:
  --json                                Raw JSON output

Environment:
  ALMYTY_TOKEN                          Token override (skips ~/.almyty/credentials.json)
  ALMYTY_URL                            API URL override
`);
}

const str = (flags: ParsedArgs['flags'], key: string): string | undefined => (typeof flags[key] === 'string' ? (flags[key] as string) : undefined);
const need = (flags: ParsedArgs['flags'], key: string): string => {
  const v = str(flags, key);
  if (!v) throw new Error(`--${key} is required`);
  return v;
};

export function connectBody(flags: ParsedArgs['flags'], input?: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = { owner: str(flags, 'owner') ?? 'org' };
  if (!['org', 'user'].includes(body.owner as string)) throw new Error('--owner must be org or user');
  if (str(flags, 'method')) body.method = str(flags, 'method');
  if (input && Object.keys(input).length > 0) body.input = input;
  return body;
}

export function grantBody(flags: ParsedArgs['flags']): Record<string, unknown> {
  const principalType = need(flags, 'principal');
  if (!['user', 'team', 'role', 'agent', 'workspace'].includes(principalType)) throw new Error('--principal must be user, team, role, agent or workspace');
  const permission = str(flags, 'permission') ?? 'use';
  if (!['use', 'manage'].includes(permission)) throw new Error('--permission must be use or manage');
  const body: Record<string, unknown> = { principalType, principalId: need(flags, 'to'), permission };
  if (str(flags, 'expires')) body.expiresAt = str(flags, 'expires');
  return body;
}

export function parseInput(flags: ParsedArgs['flags']): Record<string, unknown> | undefined {
  const raw = str(flags, 'input');
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    return parsed;
  } catch {
    throw new Error('--input must be a JSON object');
  }
}

/** Pick the method to use: the one asked for, else the connector's best. */
export function chooseMethod(connector: any, wanted?: string): any {
  const methods: any[] = connector?.connect ?? [];
  if (methods.length === 0) throw new Error(`${connector?.key ?? 'connector'} has no connect method`);
  if (!wanted) return methods[0];
  const found = methods.find((m) => m.type === wanted);
  if (!found) throw new Error(`${connector.key} does not support ${wanted}; available: ${methods.map((m) => m.type).join(', ')}`);
  return found;
}

export function formatConnector(c: any): string {
  const methods = (c.connect ?? []).map((m: any) => m.type).join(', ');
  return `${c.key}  ${c.displayName}  [${c.kind}]  ${methods}${c.custom ? '  (custom)' : ''}`;
}

export function formatConnection(c: any): string {
  const health = c.health?.status ?? 'unknown';
  const label = c.accountLabel ? `  ${c.accountLabel}` : '';
  const err = c.health?.error ? `\n    ${c.health.error}` : '';
  return `${c.id}  ${c.connectorKey}  ${c.owner}${label}  ${health}${err}`;
}

export function formatGrant(g: any): string {
  return `${g.id}  ${g.principalType}:${g.principalName ?? g.principalId}  ${g.permission}${g.expiresAt ? `  until ${g.expiresAt}` : ''}`;
}

/** Ask for each schema field at the terminal; x-secret fields are read without echo. */
async function promptForSchema(schema: any): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const props: Record<string, any> = schema?.properties ?? {};
  const required: string[] = schema?.required ?? [];
  for (const [key, def] of Object.entries(props)) {
    const label = `${def.title ?? key}${required.includes(key) ? '' : ' (optional)'}${def.default !== undefined ? ` [${def.default}]` : ''}: `;
    const value = await ask(label, Boolean(def['x-secret']));
    if (value === '' && def.default !== undefined) out[key] = def.default;
    else if (value !== '') out[key] = def.type === 'integer' || def.type === 'number' ? Number(value) : def.type === 'boolean' ? /^(y|yes|true|1)$/i.test(value) : value;
  }
  return out;
}

function ask(label: string, secret: boolean): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (secret) {
      // Hide the typed characters: readline echoes through _writeToOutput.
      const anyRl = rl as any;
      anyRl._writeToOutput = (s: string) => {
        if (s.includes(label)) anyRl.output.write(label);
      };
    }
    rl.question(label, (answer) => {
      rl.close();
      if (secret) process.stdout.write('\n');
      resolve(answer.trim());
    });
  });
}

function newClient(): AlmytyClient {
  const creds = resolveCredentialsOrExit();
  return new AlmytyClient(creds.url, creds.token);
}

function out(args: ParsedArgs, data: unknown, pretty: () => string): void {
  console.log(args.flags.json ? JSON.stringify(data, null, 2) : pretty());
}

async function openInBrowser(url: string): Promise<void> {
  const { spawn } = await import('child_process');
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  spawn(cmd, [url], { detached: true, stdio: 'ignore' }).unref();
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.flags.version) return void console.log(VERSION);
  if (!args.command || args.command === 'help' || args.flags.help) return printHelp();
  const client = newClient();
  const q = (path: string, init?: RequestInit) => client.request(path, init);
  const post = (path: string, body: unknown) => q(path, { method: 'POST', body: JSON.stringify(body) });

  switch (args.command) {
    case 'connectors': {
      const res = await q('/connectors');
      const kind = str(args.flags, 'kind');
      const rows = kind ? res.data.filter((c: any) => c.kind === kind) : res.data;
      out(args, rows, () => rows.map(formatConnector).join('\n'));
      return;
    }
    case 'list': {
      const res = await q('/connections');
      out(args, res.data, () => (res.data.length ? res.data.map(formatConnection).join('\n') : 'No connections yet. Run: almyty connections connectors'));
      return;
    }
    case 'connect': {
      const key = args.positional[0];
      if (!key) throw new Error('connector key is required');
      const catalog = await q('/connectors');
      const connector = catalog.data.find((c: any) => c.key === key);
      if (!connector) throw new Error(`unknown connector ${key}; run: almyty connections connectors`);
      const method = chooseMethod(connector, str(args.flags, 'method'));
      let input = parseInput(args.flags);
      if (!method.type.startsWith('oauth2') && !input && method.schema) {
        if (method.instructions) console.log(`\n${method.instructions}\n`);
        if (connector.keyPageUrl) console.log(`Get a key at: ${connector.keyPageUrl}`);
        if (method.quickCreateUrl) console.log(`Quick create: ${method.quickCreateUrl}`);
        input = await promptForSchema(method.schema);
      }
      const res = await post(`/connections/connect/${key}`, connectBody({ ...args.flags, method: method.type }, input));
      if (res.data?.authorizeUrl) {
        console.log(`Open this URL to continue:\n${res.data.authorizeUrl}\n\nThen either finish in the browser, or paste the code with:\n  almyty connections complete ${key} --state ${res.data.state} --code <code>`);
        if (args.flags.open) await openInBrowser(res.data.authorizeUrl);
        return;
      }
      out(args, res.data, () => `Connected.\n${formatConnection(res.data.connection ?? res.data)}`);
      return;
    }
    case 'complete': {
      const key = args.positional[0];
      if (!key) throw new Error('connector key is required');
      const res = await post(`/connections/connect/${key}/complete`, { state: need(args.flags, 'state'), code: need(args.flags, 'code') });
      out(args, res.data, () => `Connected.\n${formatConnection(res.data.connection ?? res.data)}`);
      return;
    }
    case 'validate': {
      const res = await post(`/connections/${args.positional[0]}/validate`, {});
      out(args, res.data, () => formatConnection(res.data.connection ?? res.data));
      return;
    }
    case 'rotate': {
      const res = await post(`/connections/${args.positional[0]}/rotate`, {});
      if (res.data?.authorizeUrl) {
        console.log(`Open this URL to continue:\n${res.data.authorizeUrl}`);
        if (args.flags.open) await openInBrowser(res.data.authorizeUrl);
        return;
      }
      out(args, res.data, () => `Rotated.\n${formatConnection(res.data.connection ?? res.data)}`);
      return;
    }
    case 'disconnect': {
      await q(`/connections/${args.positional[0]}`, { method: 'DELETE' });
      console.log('Disconnected.');
      return;
    }
    case 'grants': {
      const res = await q(`/connections/${args.positional[0]}/grants`);
      out(args, res.data, () => (res.data.length ? res.data.map(formatGrant).join('\n') : 'No grants: only the owner (and org admins for org connections) can use it.'));
      return;
    }
    case 'grant': {
      const res = await post(`/connections/${args.positional[0]}/grants`, grantBody(args.flags));
      out(args, res.data, () => `Granted.\n${formatGrant(res.data)}`);
      return;
    }
    case 'revoke': {
      await q(`/connections/${args.positional[0]}/grants/${args.positional[1]}`, { method: 'DELETE' });
      console.log('Revoked.');
      return;
    }
    default:
      console.error(`Unknown command: ${args.command}\n`);
      printHelp();
      process.exit(1);
  }
}

const invokedDirectly = process.argv[1] && /connections-cli|almyty-connections|dist\/index\.js|src\/index\.ts/.test(process.argv[1]) && !process.env.VITEST;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
