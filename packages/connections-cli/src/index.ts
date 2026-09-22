#!/usr/bin/env node
/**
 * @almyty/connections: third-party accounts from the terminal.
 *
 * Connections are the one place almyty keeps a third-party secret: every
 * connection is a credential row with a connector key, an account label and
 * a health status, and everything that uses it (agents, models, deployments,
 * channels) holds a reference rather than a copy. See docs/connections.md.
 *
 * How a secret reaches the API matters, so this tool never wants one on the
 * command line: argv is visible in `ps` and lands in shell history and CI
 * logs. The paths are, best first: the connector's sign-in flow (nothing to
 * paste), a hidden terminal prompt, `--input-file`, or `--input-stdin`.
 * `--input` stays for non-secret fields and is refused for secret ones.
 */
import { createInterface } from 'readline';
import { readFileSync } from 'fs';
import { AlmytyClient, resolveCredentialsOrExit } from '@almyty/client';
import { EXIT, EXIT_CODE_HELP, UsageError, describeError, exitCodeFor } from './exit-codes.js';
import { VERSION } from './version.js';


export interface ParsedArgs {
  command?: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

/** Flags that never take a value. */
const BOOLEAN_FLAGS = new Set(['json', 'open', 'headless', 'input-stdin']);

export function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = { positional: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h') { result.flags.help = true; continue; }
    if (arg === '-v') { result.flags.version = true; continue; }
    if (arg === '--') {
      // Everything after `--` is positional, flags included.
      result.positional.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith('--')) {
      const body = arg.slice(2);
      // `--flag=value` as well as `--flag value`. With only the space form,
      // `--input='{"a":1}'` became a flag literally named `input={"a":1}`
      // and the value was dropped without a word.
      const eq = body.indexOf('=');
      if (eq !== -1) { result.flags[body.slice(0, eq)] = body.slice(eq + 1); continue; }
      if (body === 'help' || body === 'version') { result.flags[body] = true; continue; }
      if (BOOLEAN_FLAGS.has(body)) { result.flags[body] = true; continue; }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { result.flags[body] = next; i++; }
      else result.flags[body] = true;
      continue;
    }
    if (!result.command) result.command = arg;
    else result.positional.push(arg);
  }
  return result;
}

function printHelp(): void {
  console.log(`
@almyty/connections v${VERSION}

Connect a third-party account once; agents, models, deployments and channels
use the connection. The secret is stored encrypted in almyty and is never
returned, not even masked.

Usage:
  npx @almyty/connections <command> [options]

Read:
  connectors [--kind k]                 Connector catalog: what can be connected, and how
                                        --kind inference|deployment|memory|mcp|tool_source|channel|cloud|registry
  list                                  Connected accounts with health
  get <id>                              One connection: connector, account, health, scopes, owner
  grants <id>                           Who may use this connection

Connect:
  connect <key> [--method m] [--owner org|user] [--name n] [--headless] [--open]
                                        Sign-in connectors print an authorize URL (--open launches
                                        a browser, --headless asks the provider for a code to paste).
                                        Form connectors prompt for each field, secrets not echoed.
  complete <key> --state s --code c     Finish a headless sign-in by pasting the code
  validate <id>                         Re-check against the provider; refreshes health and label.
                                        Exits non-zero unless the health comes back valid.
  rotate <id> [--headless] [--open]     Replace the secret in place; everything pointing at the
                                        connection keeps working. Prompts for the new value.
  disconnect <id>                       Revoke at the provider where it can be, then delete

Share:
  grant <id> --principal user|team|role|agent|workspace --to <principalId>
             [--permission use|manage] [--expires <iso8601>]
  revoke <id> <grantId>                 Withdraw one grant

Supplying form fields without a prompt (connect, rotate):
  --input-file <path>                   Read the fields as a JSON object from a file
  --input-stdin                         Read the fields as a JSON object from stdin
  --input '<json>'                      Non-secret fields only. Refused when it carries a field the
                                        connector marks secret, because argv is world-readable.

Options:
  --json                                Undecorated JSON on stdout, for scripts
  -h, --help                            This help
  -v, --version                         Print the version

Environment:
  ALMYTY_TOKEN                          Token override (skips ~/.almyty/credentials.json)
  ALMYTY_URL                            API URL override
  NO_COLOR                              Honoured: this tool never colours its output

Exit codes:
${EXIT_CODE_HELP}
`);
}

const str = (flags: ParsedArgs['flags'], key: string): string | undefined => (typeof flags[key] === 'string' ? (flags[key] as string) : undefined);
const need = (flags: ParsedArgs['flags'], key: string): string => {
  const v = str(flags, key);
  if (!v) throw new UsageError(`--${key} is required`);
  return v;
};

/**
 * A missing id used to be sent to the API as the literal string "undefined",
 * which came back as an opaque 400. Say what is missing instead.
 */
export function needArg(positional: string[], index: number, name: string, usage: string): string {
  const v = positional[index];
  if (!v) throw new UsageError(`${name} is required\n  usage: almyty connections ${usage}`);
  return v;
}

export function connectBody(flags: ParsedArgs['flags'], input?: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = { owner: str(flags, 'owner') ?? 'org' };
  if (!['org', 'user'].includes(body.owner as string)) throw new UsageError('--owner must be org or user');
  if (str(flags, 'method')) body.method = str(flags, 'method');
  if (str(flags, 'name')) body.name = str(flags, 'name');
  if (input && Object.keys(input).length > 0) body.input = input;
  return body;
}

export function grantBody(flags: ParsedArgs['flags']): Record<string, unknown> {
  const principalType = need(flags, 'principal');
  if (!['user', 'team', 'role', 'agent', 'workspace'].includes(principalType)) throw new UsageError('--principal must be user, team, role, agent or workspace');
  const permission = str(flags, 'permission') ?? 'use';
  if (!['use', 'manage'].includes(permission)) throw new UsageError('--permission must be use or manage');
  const body: Record<string, unknown> = { principalType, principalId: need(flags, 'to'), permission };
  if (str(flags, 'expires')) body.expiresAt = str(flags, 'expires');
  return body;
}

/** A JSON object, or a message naming which flag was wrong. */
export function parseInputObject(raw: string, flag: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new UsageError(`${flag} must be valid JSON`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new UsageError(`${flag} must be a JSON object`);
  return parsed as Record<string, unknown>;
}

export function parseInput(flags: ParsedArgs['flags']): Record<string, unknown> | undefined {
  const raw = str(flags, 'input');
  if (!raw) return undefined;
  try {
    return parseInputObject(raw, '--input');
  } catch {
    throw new UsageError('--input must be a JSON object');
  }
}

/** Names of the fields a connect form marks `x-secret`. */
export function secretFields(schema: any): string[] {
  const props: Record<string, any> = schema?.properties ?? {};
  return Object.entries(props).filter(([, def]) => def?.['x-secret'] === true).map(([key]) => key);
}

/**
 * Refuse a secret that arrived on the command line.
 *
 * argv is readable by every process on the machine through `ps`, is written
 * to shell history, and is echoed by most CI runners. A key that travelled
 * that way has to be treated as disclosed, so the tool declines rather than
 * accepting it and storing it as if it were safe.
 */
export function assertNoArgvSecrets(schema: any, input: Record<string, unknown>): void {
  const offending = secretFields(schema).filter((f) => input[f] !== undefined);
  if (offending.length === 0) return;
  throw new UsageError(
    `${offending.join(', ')} ${offending.length === 1 ? 'is a secret' : 'are secrets'} and --input puts it in your shell history and in \`ps\`.\n` +
    '  Leave --input off and the field is prompted without echo, or pass the whole object as\n' +
    '    --input-file <path>   read the JSON object from a file\n' +
    '    --input-stdin         read the JSON object from stdin',
  );
}

/**
 * The methods that send the user to the provider and finish on the callback,
 * spelled exactly the way the API spells them (`REDIRECT_METHODS`).
 * Guessing from the name prefix was wrong for both of the methods whose name
 * does not match their shape: `oauth2_client_credentials` is a form (a client
 * id and secret you paste, so it must be prompted) and `installation` is a
 * redirect that does not start with `oauth2`.
 */
const REDIRECT_METHODS = ['oauth2_pkce', 'oauth2_code', 'installation'];

export function isRedirectMethod(type: string): boolean {
  return REDIRECT_METHODS.includes(type);
}

/** browser unless asked for headless; --open only makes sense with a browser. */
export function connectMode(flags: ParsedArgs['flags']): 'browser' | 'headless' {
  return flags.headless ? 'headless' : 'browser';
}

/**
 * What to tell the user after a sign-in connect. The backend decides how the
 * flow finishes and says so in `completeWith`; printing the paste-a-code
 * instruction for a callback flow sent people to a command that cannot work,
 * because the state is consumed by the redirect.
 */
export function pendingRedirectMessage(pending: any, connectorKey: string): string {
  const lines = [`Open this URL to continue:`, pending.authorizeUrl, ''];
  if (pending.completeWith === 'code') {
    lines.push(
      'The provider will show you a code. Paste it with:',
      `  almyty connections complete ${connectorKey} --state ${pending.state} --code <code>`,
    );
  } else {
    lines.push(
      'Approve in the browser and the connect finishes on its own; then:',
      '  almyty connections list',
      '',
      'On a machine with no browser, start again with --headless and the provider',
      'shows a code you paste into `almyty connections complete` instead.',
    );
  }
  if (pending.expiresInSeconds) lines.push('', `This link expires in ${Math.round(pending.expiresInSeconds / 60)} minutes.`);
  return lines.join('\n');
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

/**
 * The detail view. `list` is one line per connection; this answers the
 * question the one-liner cannot: what is wrong with this connection, when
 * was that last checked, and what may it do.
 */
export function formatConnectionDetail(c: any): string {
  const lines = [
    `${c.name ?? c.connectorKey}`,
    `  id          ${c.id}`,
    `  connector   ${c.connectorKey}${c.connectorDisplayName ? ` (${c.connectorDisplayName})` : ''}${c.kind ? `  [${c.kind}]` : ''}`,
    `  owner       ${c.owner}${c.ownerUserId ? ` (${c.ownerUserId})` : ''}`,
    `  method      ${c.method ?? 'unknown'}`,
    `  account     ${c.accountLabel ?? '(the provider named none)'}`,
    `  health      ${c.health?.status ?? 'unknown'}${c.health?.checkedAt ? `, checked ${c.health.checkedAt}` : ', never checked'}`,
  ];
  if (c.health?.error) lines.push(`  error       ${c.health.error}`);
  lines.push(`  scopes      ${c.scopesGranted?.length ? c.scopesGranted.join(', ') : '(none reported)'}`);
  if (c.expiresAt) lines.push(`  expires     ${c.expiresAt}`);
  if (c.health?.status && c.health.status !== 'valid') {
    lines.push('', healthAdvice(c.health.status), '', 'The stored secret is never returned, so fix it at the provider and then:', `  almyty connections rotate ${c.id}`);
  }
  return lines.join('\n');
}

/** Every health status other than `valid` has a different next step. */
export function healthAdvice(status: string): string {
  switch (status) {
    case 'failed': return 'The provider rejected the stored secret. Re-check it and rotate.';
    case 'expired': return 'The stored secret has expired. Rotate to replace it.';
    case 'revoked': return 'The secret was revoked at the provider. Rotate to replace it.';
    case 'quota': return 'The credential is good but the account is out of quota or over its rate limit at the provider.';
    case 'unknown': return 'Never checked against the provider. Run `almyty connections validate <id>`.';
    default: return `Health is ${status}.`;
  }
}

export function formatGrant(g: any): string {
  return `${g.id}  ${g.principalType}:${g.principalName ?? g.principalId}  ${g.permission}${g.expiresAt ? `  until ${g.expiresAt}` : ''}`;
}

/** Pick the method to use: the one asked for, else the connector's best. */
export function chooseMethod(connector: any, wanted?: string): any {
  const methods: any[] = connector?.connect ?? [];
  if (methods.length === 0) throw new UsageError(`${connector?.key ?? 'connector'} has no connect method`);
  if (!wanted) return methods[0];
  const found = methods.find((m) => m.type === wanted);
  if (!found) throw new UsageError(`${connector.key} does not support ${wanted}; available: ${methods.map((m) => m.type).join(', ')}`);
  return found;
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

/**
 * Reading stdin when stdin is the terminal means waiting for a person to
 * type JSON and press ctrl-D, which looks exactly like a hang. Say so.
 */
export function assertStdinIsPiped(flag: string): void {
  if (!process.stdin.isTTY) return;
  throw new UsageError(
    `${flag} reads stdin, and stdin is your terminal, so it would wait forever.\n` +
    `  Pipe the JSON in:  cat fields.json | almyty connections <command> ${flag}\n` +
    '  Or use --input-file <path>, or leave both off and be prompted.',
  );
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

/**
 * Where the form fields come from, in order of how safely the secret travels:
 * a file, stdin, then argv (non-secret fields only), then a hidden prompt.
 * Returns undefined when nothing was supplied and the caller should prompt.
 */
async function suppliedInput(
  flags: ParsedArgs['flags'],
  schema: any,
  /**
   * False when the form is not known yet, so which fields are secret is not
   * known either. `rotate` is in that position: the API only answers with
   * the form after the first call, so `--input` cannot be screened and is
   * refused outright rather than accepted blind.
   */
  schemaKnown = true,
): Promise<Record<string, unknown> | undefined> {
  const file = str(flags, 'input-file');
  if (file) return parseInputObject(readFileSync(file, 'utf8'), `--input-file ${file}`);
  if (flags['input-stdin']) {
    assertStdinIsPiped('--input-stdin');
    return parseInputObject(await readStdin(), '--input-stdin');
  }
  const inline = parseInput(flags);
  if (inline) {
    if (!schemaKnown) throw new UsageError(unscreenableInputMessage());
    assertNoArgvSecrets(schema, inline);
    return inline;
  }
  return undefined;
}

/** Why `--input` is refused where the form is not known in advance. */
export function unscreenableInputMessage(): string {
  return [
    '--input cannot be used here: which of these fields are secret is only known once the API',
    'answers with the form, and argv is in your shell history and in `ps`.',
    '  --input-file <path>   read the JSON object from a file',
    '  --input-stdin         read the JSON object from stdin',
    '  or leave both off and the fields are prompted, secrets without echo',
  ].join('\n');
}

/**
 * Prompting needs a terminal. Without one (a pipe, a CI job, a cron) the
 * prompt used to read end-of-file and submit an empty form, which the
 * provider then rejected for a reason that had nothing to do with the key.
 */
export function requireTty(what: string, isTty = process.stdin.isTTY): void {
  if (isTty) return;
  throw new UsageError(
    `${what} needs a terminal to prompt on, and stdin is not one.\n` +
    '  Pass the fields instead:\n' +
    '    --input-file <path>   read the JSON object from a file\n' +
    '    --input-stdin         read the JSON object from stdin',
  );
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
      // Filtered by the API, so an unknown kind is an error instead of an
      // empty list that looks like "nothing can be connected".
      const kind = str(args.flags, 'kind');
      const res = await q(`/connectors${kind ? `?kind=${encodeURIComponent(kind)}` : ''}`);
      out(args, res.data, () => (res.data.length ? res.data.map(formatConnector).join('\n') : `No connectors${kind ? ` of kind ${kind}` : ''}.`));
      return;
    }
    case 'list': {
      const res = await q('/connections');
      out(args, res.data, () => (res.data.length ? res.data.map(formatConnection).join('\n') : 'No connections yet. Run: almyty connections connectors'));
      return;
    }
    case 'get': {
      const id = needArg(args.positional, 0, 'connection id', 'get <id>');
      const res = await q(`/connections/${id}`);
      out(args, res.data, () => formatConnectionDetail(res.data));
      return;
    }
    case 'connect': {
      const key = needArg(args.positional, 0, 'connector key', 'connect <connectorKey>');
      const catalog = await q('/connectors');
      const connector = catalog.data.find((c: any) => c.key === key);
      if (!connector) throw new UsageError(`unknown connector ${key}; run: almyty connections connectors`);
      const method = chooseMethod(connector, str(args.flags, 'method'));
      const isRedirect = isRedirectMethod(method.type);
      let input = await suppliedInput(args.flags, method.schema);
      if (!isRedirect && !input && method.schema) {
        // `description` is the field the connector catalog actually carries;
        // `instructions` is kept for custom connectors that use that name.
        const guidance = method.description ?? method.instructions;
        if (guidance) console.log(`\n${guidance}\n`);
        const keyPage = method.keyPageUrl ?? connector.keyPageUrl;
        if (keyPage) console.log(`Get a key at: ${keyPage}`);
        if (method.quickCreateUrl) console.log(`Quick create: ${method.quickCreateUrl}`);
        requireTty(`connect ${key} via ${method.type}`);
        input = await promptForSchema(method.schema);
      }
      const body = connectBody({ ...args.flags, method: method.type }, input);
      if (isRedirect) body.mode = connectMode(args.flags);
      const res = await post(`/connections/connect/${key}`, body);
      if (res.data?.authorizeUrl) {
        if (args.flags.json) console.log(JSON.stringify(res.data, null, 2));
        else console.log(pendingRedirectMessage(res.data, key));
        if (args.flags.open) await openInBrowser(res.data.authorizeUrl);
        return;
      }
      out(args, res.data, () => `Connected.\n${formatConnection(res.data.connection ?? res.data)}`);
      return;
    }
    case 'complete': {
      const key = needArg(args.positional, 0, 'connector key', 'complete <connectorKey> --state s --code c');
      const res = await post(`/connections/connect/${key}/complete`, { state: need(args.flags, 'state'), code: need(args.flags, 'code') });
      out(args, res.data, () => `Connected.\n${formatConnection(res.data.connection ?? res.data)}`);
      return;
    }
    case 'validate': {
      const id = needArg(args.positional, 0, 'connection id', 'validate <id>');
      const res = await post(`/connections/${id}/validate`, {});
      const connection = res.data.connection ?? res.data;
      const status = connection.health?.status ?? 'unknown';
      out(args, connection, () => (status === 'valid'
        ? `Valid.\n${formatConnection(connection)}`
        : `${status}.\n${formatConnection(connection)}\n\n${healthAdvice(status)}`));
      // A validate that came back failed is a failure. Exiting 0 made this
      // useless in a script and in a health check.
      if (status !== 'valid') process.exitCode = EXIT.FAILED;
      return;
    }
    case 'rotate': {
      const id = needArg(args.positional, 0, 'connection id', 'rotate <id>');
      const supplied = await suppliedInput(args.flags, undefined, false);
      const body: Record<string, unknown> = {};
      if (supplied) body.input = supplied;
      if (args.flags.headless) body.mode = 'headless';
      let res = await post(`/connections/${id}/rotate`, body);
      if (res.data?.authorizeUrl) {
        if (args.flags.json) console.log(JSON.stringify(res.data, null, 2));
        else console.log(pendingRedirectMessage(res.data, res.data.connectorKey ?? '<connector>'));
        if (args.flags.open) await openInBrowser(res.data.authorizeUrl);
        return;
      }
      // A pasted-key connector answers a rotate with the form to fill in.
      // Sending {} and reporting "Rotated." left the old secret in place.
      if (res.data?.pending && res.data.form) {
        const form = res.data.form;
        if (form.keyPageUrl) console.log(`Create the replacement key at: ${form.keyPageUrl}`);
        requireTty(`rotate ${id}`);
        const input = await promptForSchema(form.schema);
        if (Object.keys(input).length === 0) throw new Error('nothing entered; the connection was left as it was');
        res = await post(`/connections/${id}/rotate`, { input });
      }
      out(args, res.data, () => `Rotated.\n${formatConnection(res.data.connection ?? res.data)}`);
      return;
    }
    case 'disconnect': {
      const id = needArg(args.positional, 0, 'connection id', 'disconnect <id>');
      const res = await q(`/connections/${id}`, { method: 'DELETE' });
      out(args, res?.data ?? { id, disconnected: true }, () => 'Disconnected.');
      return;
    }
    case 'grants': {
      const id = needArg(args.positional, 0, 'connection id', 'grants <id>');
      const res = await q(`/connections/${id}/grants`);
      out(args, res.data, () => (res.data.length ? res.data.map(formatGrant).join('\n') : 'No grants: only the owner (and org admins for org connections) can use it.'));
      return;
    }
    case 'grant': {
      const id = needArg(args.positional, 0, 'connection id', 'grant <id> --principal p --to id');
      const res = await post(`/connections/${id}/grants`, grantBody(args.flags));
      out(args, res.data, () => `Granted.\n${formatGrant(res.data)}`);
      return;
    }
    case 'revoke': {
      const id = needArg(args.positional, 0, 'connection id', 'revoke <id> <grantId>');
      const grantId = needArg(args.positional, 1, 'grant id', 'revoke <id> <grantId>');
      const res = await q(`/connections/${id}/grants/${grantId}`, { method: 'DELETE' });
      out(args, res?.data ?? { id: grantId, revoked: true }, () => 'Revoked.');
      return;
    }
    default:
      console.error(`Unknown command: ${args.command}\n`);
      printHelp();
      process.exit(EXIT.USAGE);
  }
}

const invokedDirectly = process.argv[1] && /connections-cli|almyty-connections|dist\/index\.js|src\/index\.ts/.test(process.argv[1]) && !process.env.VITEST;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(describeError(err, process.env.ALMYTY_URL));
    process.exit(exitCodeFor(err));
  });
}
