import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  assertNoArgvSecrets,
  assertStdinIsPiped,
  chooseMethod,
  connectBody,
  connectMode,
  formatConnection,
  formatConnectionDetail,
  grantBody,
  healthAdvice,
  isRedirectMethod,
  needArg,
  parseArgs,
  parseInput,
  parseInputObject,
  pendingRedirectMessage,
  requireTty,
  secretFields,
  unscreenableInputMessage,
} from '../index';
import { EXIT, EXIT_CODE_HELP, UsageError, describeError, exitCodeFor } from '../exit-codes';
import { VERSION, readVersion } from '../version';

const apiKeyMethod = {
  type: 'api_key',
  schema: {
    type: 'object',
    required: ['apiKey'],
    properties: {
      apiKey: { type: 'string', title: 'API key', 'x-secret': true },
      region: { type: 'string', title: 'Region' },
    },
  },
};

describe('@almyty/connections', () => {
  it('parses commands, positionals and flags', () => {
    expect(parseArgs(['revoke', 'c1', 'g1', '--json'])).toEqual({ command: 'revoke', positional: ['c1', 'g1'], flags: { json: true } });
  });

  it('never swallows the next argument after a boolean flag', () => {
    // `--headless connect` used to eat the command as the flag's value.
    expect(parseArgs(['connect', 'openrouter', '--headless', '--open'])).toEqual({
      command: 'connect',
      positional: ['openrouter'],
      flags: { headless: true, open: true },
    });
    expect(parseArgs(['connect', 'slack', '--input-stdin'])).toEqual({
      command: 'connect',
      positional: ['slack'],
      flags: { 'input-stdin': true },
    });
  });

  it('stops parsing flags after --', () => {
    expect(parseArgs(['grant', '--', '--weird-id'])).toEqual({ command: 'grant', positional: ['--weird-id'], flags: {} });
  });

  it('builds a connect body with owner, method, name and input, and refuses a bad owner', () => {
    expect(connectBody({ owner: 'user', method: 'api_key' }, { apiKey: 'k' })).toEqual({ owner: 'user', method: 'api_key', input: { apiKey: 'k' } });
    expect(connectBody({})).toEqual({ owner: 'org' });
    expect(connectBody({ name: 'prod key' })).toEqual({ owner: 'org', name: 'prod key' });
    expect(() => connectBody({ owner: 'team' })).toThrow('--owner must be org or user');
  });

  it('parses --input as a JSON object only', () => {
    expect(parseInput({ input: '{"token":"t"}' })).toEqual({ token: 't' });
    expect(() => parseInput({ input: '[1]' })).toThrow('--input must be a JSON object');
    expect(parseInput({})).toBeUndefined();
  });

  it('names the flag that carried bad JSON, so --input-file points at the file', () => {
    expect(() => parseInputObject('{oops', '--input-file /tmp/k.json')).toThrow('--input-file /tmp/k.json must be valid JSON');
    expect(() => parseInputObject('"a string"', '--input-stdin')).toThrow('--input-stdin must be a JSON object');
    expect(parseInputObject('{"bucket":"weights"}', '--input-stdin')).toEqual({ bucket: 'weights' });
  });

  // ── The reason this tool exists in this shape ──────────────────────

  it('reads the secret fields out of a connect form', () => {
    expect(secretFields(apiKeyMethod.schema)).toEqual(['apiKey']);
    expect(secretFields(undefined)).toEqual([]);
    expect(secretFields({ properties: {} })).toEqual([]);
  });

  it('refuses a secret passed on the command line, and says how to pass it safely', () => {
    expect(() => assertNoArgvSecrets(apiKeyMethod.schema, { apiKey: 'sk-live-xxxx' })).toThrow(/apiKey is a secret/);
    expect(() => assertNoArgvSecrets(apiKeyMethod.schema, { apiKey: 'sk-live-xxxx' })).toThrow(/--input-file/);
    expect(() => assertNoArgvSecrets(apiKeyMethod.schema, { apiKey: 'sk-live-xxxx' })).toThrow(/--input-stdin/);
  });

  it('never repeats the secret it refused', () => {
    // The whole point is that the value must not be written anywhere else.
    try {
      assertNoArgvSecrets(apiKeyMethod.schema, { apiKey: 'sk-live-do-not-print-me' });
      throw new Error('should have refused');
    } catch (err: any) {
      expect(err.message).not.toContain('sk-live-do-not-print-me');
    }
  });

  it('lets non-secret fields through on the command line', () => {
    expect(() => assertNoArgvSecrets(apiKeyMethod.schema, { region: 'eu-central-1' })).not.toThrow();
    expect(() => assertNoArgvSecrets(undefined, { anything: 1 })).not.toThrow();
  });

  it('names every secret field when more than one was pasted', () => {
    const schema = { properties: { a: { 'x-secret': true }, b: { 'x-secret': true }, c: {} } };
    expect(() => assertNoArgvSecrets(schema, { a: '1', b: '2', c: '3' })).toThrow(/a, b are secrets/);
  });

  // ── Which methods redirect ────────────────────────────────────────

  it('knows which methods redirect, including the two whose name lies', () => {
    expect(isRedirectMethod('oauth2_pkce')).toBe(true);
    expect(isRedirectMethod('oauth2_code')).toBe(true);
    // Sends the user to the provider, yet does not start with oauth2.
    expect(isRedirectMethod('installation')).toBe(true);
    // Starts with oauth2, yet is a form you paste a client id and secret into.
    expect(isRedirectMethod('oauth2_client_credentials')).toBe(false);
    expect(isRedirectMethod('api_key')).toBe(false);
    expect(isRedirectMethod('cloud_iam')).toBe(false);
    expect(isRedirectMethod('service_account')).toBe(false);
  });

  it('chooses the best method by default and a named one when supported', () => {
    const connector = { key: 'openrouter', connect: [{ type: 'oauth2_pkce' }, { type: 'api_key' }] };
    expect(chooseMethod(connector).type).toBe('oauth2_pkce');
    expect(chooseMethod(connector, 'api_key').type).toBe('api_key');
    expect(() => chooseMethod(connector, 'cloud_iam')).toThrow('does not support cloud_iam');
  });

  // ── Headless vs browser ───────────────────────────────────────────

  it('asks for browser mode unless --headless', () => {
    expect(connectMode({})).toBe('browser');
    expect(connectMode({ headless: true })).toBe('headless');
  });

  it('tells you to paste a code only when the flow finishes with a code', () => {
    const code = pendingRedirectMessage({ authorizeUrl: 'https://p/auth', state: 'st-1', completeWith: 'code', expiresInSeconds: 600 }, 'openrouter');
    expect(code).toContain('almyty connections complete openrouter --state st-1 --code <code>');
    expect(code).toContain('10 minutes');

    const callback = pendingRedirectMessage({ authorizeUrl: 'https://p/auth', state: 'st-1', completeWith: 'callback' }, 'openrouter');
    // The state is consumed by the redirect, so `complete` cannot work here.
    expect(callback).not.toContain('--code');
    expect(callback).toContain('almyty connections list');
    expect(callback).toContain('--headless');
  });

  // ── Reporting ─────────────────────────────────────────────────────

  it('builds a grant body and validates principal and permission', () => {
    expect(grantBody({ principal: 'agent', to: 'a1' })).toEqual({ principalType: 'agent', principalId: 'a1', permission: 'use' });
    expect(grantBody({ principal: 'role', to: 'admin', permission: 'manage', expires: '2027-01-01T00:00:00Z' })).toMatchObject({ permission: 'manage', expiresAt: '2027-01-01T00:00:00Z' });
    expect(() => grantBody({ principal: 'bot', to: 'x' })).toThrow('--principal must be');
    expect(() => grantBody({ principal: 'user', to: 'x', permission: 'own' })).toThrow('--permission must be');
  });

  it('formats a connection with account label and health error', () => {
    const line = formatConnection({ id: 'c1', connectorKey: 'openrouter', owner: 'user', accountLabel: 'ava@northwind', health: { status: 'expired', error: 'key revoked' } });
    expect(line).toContain('openrouter  user  ava@northwind  expired');
    expect(line).toContain('key revoked');
  });

  it('gives a different next step for every health status', () => {
    expect(healthAdvice('failed')).toMatch(/rotate/i);
    expect(healthAdvice('expired')).toMatch(/expired/i);
    expect(healthAdvice('revoked')).toMatch(/revoked/i);
    // Quota is the one where the credential is fine and rotating would not help.
    expect(healthAdvice('quota')).toMatch(/quota|rate limit/i);
    expect(healthAdvice('unknown')).toMatch(/validate/);
  });

  it('shows the detail a one-line list cannot, and what to do about a bad one', () => {
    const detail = formatConnectionDetail({
      id: 'c1', name: 'OpenRouter (prod)', connectorKey: 'openrouter', connectorDisplayName: 'OpenRouter', kind: 'inference',
      owner: 'org', method: 'oauth2_pkce', accountLabel: 'ava@northwind', scopesGranted: ['models:read'],
      health: { status: 'failed', checkedAt: '2026-09-17T10:00:00Z', error: 'invalid_api_key' },
    });
    expect(detail).toContain('c1');
    expect(detail).toContain('inference');
    expect(detail).toContain('models:read');
    expect(detail).toContain('invalid_api_key');
    expect(detail).toContain('checked 2026-09-17T10:00:00Z');
    expect(detail).toContain('almyty connections rotate c1');

    const healthy = formatConnectionDetail({ id: 'c2', connectorKey: 'huggingface', owner: 'user', health: { status: 'valid' } });
    expect(healthy).not.toContain('rotate c2');
    expect(healthy).toContain('(none reported)');
  });

  it('says which argument is missing instead of sending the string "undefined" to the API', () => {
    expect(() => needArg([], 0, 'connection id', 'validate <id>')).toThrow(/connection id is required/);
    expect(() => needArg([], 0, 'connection id', 'validate <id>')).toThrow(/almyty connections validate <id>/);
    expect(needArg(['c1'], 0, 'connection id', 'validate <id>')).toBe('c1');
  });
});

// ── Conventions shared with the other almyty CLIs ─────────────────

describe('conventions', () => {
  it('accepts --flag=value as well as --flag value', () => {
    // With only the space form, --input='{"a":1}' became a flag literally
    // named `input={"a":1}` and the value was silently dropped.
    expect(parseArgs(['connect', 'slack', '--method=api_key']).flags).toEqual({ method: 'api_key' });
    expect(parseArgs(['grant', 'c1', '--principal=agent', '--to=a1']).flags).toEqual({ principal: 'agent', to: 'a1' });
    expect(parseArgs(['connect', 'x', '--input={"region":"eu"}']).flags).toEqual({ input: '{"region":"eu"}' });
    expect(parseInput(parseArgs(['connect', 'x', '--input={"region":"eu"}']).flags)).toEqual({ region: 'eu' });
  });

  it('keeps an empty value an empty value', () => {
    expect(parseArgs(['connect', 'x', '--name=']).flags).toEqual({ name: '' });
  });

  it('pins the exit-code table every almyty CLI shares', () => {
    // A script switching on $? must see the same number from every binary.
    expect(EXIT).toEqual({ OK: 0, ERROR: 1, USAGE: 2, AUTH: 3, NOT_FOUND: 4, FAILED: 5 });
  });

  it('exits 2 for a usage error, so a bad flag is not mistaken for a failure', () => {
    expect(exitCodeFor(new UsageError('--owner must be org or user'))).toBe(EXIT.USAGE);
    expect(exitCodeFor(new Error('--state is required'))).toBe(EXIT.USAGE);
  });

  it('exits 3 when the credential is the problem, naming the login command', () => {
    // The shared client turns a 401 into this exact message.
    expect(exitCodeFor(new Error('Authentication failed. Run: npx @almyty/auth login'))).toBe(EXIT.AUTH);
    expect(exitCodeFor(new Error('API error 403: forbidden'))).toBe(EXIT.AUTH);
  });

  it('exits 4 for a missing thing and 5 for an operation that ran and failed', () => {
    expect(exitCodeFor(new Error('API error 404: Not Found'))).toBe(EXIT.NOT_FOUND);
    expect(exitCodeFor(new Error('API error 422: connector refused the key'))).toBe(EXIT.FAILED);
    expect(exitCodeFor(new Error('API error 500: boom'))).toBe(EXIT.FAILED);
  });

  it('exits 1 for anything it cannot classify', () => {
    expect(exitCodeFor(new Error('socket hang up'))).toBe(EXIT.ERROR);
    expect(exitCodeFor('a bare string')).toBe(EXIT.ERROR);
  });

  it('documents every code in --help', () => {
    for (const code of [0, 1, 2, 3, 4, 5]) expect(EXIT_CODE_HELP).toContain(`  ${code}  `);
    expect(EXIT_CODE_HELP).toContain('almyty auth login');
  });
});

describe('error messages', () => {
  it('names the login command instead of echoing a 401 body', () => {
    const text = describeError(new Error('Authentication failed. Run: npx @almyty/auth login'));
    expect(text).toContain('npx @almyty/auth login');
    expect(text).toContain('ALMYTY_TOKEN');
  });

  it('says which host could not be reached, because "fetch failed" says nothing', () => {
    const text = describeError(new TypeError('fetch failed'), 'https://api.almyty.com');
    expect(text).toContain('Could not reach the almyty API at https://api.almyty.com');
    expect(text).toContain('ALMYTY_URL');
    // And it still works without knowing the URL.
    expect(describeError(new TypeError('fetch failed'))).toContain('Could not reach the almyty API:');
  });

  it('turns a refused connection into the same advice', () => {
    expect(describeError(new Error('connect ECONNREFUSED 127.0.0.1:9'))).toContain('ALMYTY_URL');
  });

  it('explains a 403 as a permission problem, not a login problem', () => {
    const text = describeError(new Error('API error 403: Forbidden'));
    expect(text).toContain('lacks permission');
    expect(text).not.toContain('auth login');
  });

  it('explains a 404 as a wrong id rather than a broken tool', () => {
    expect(describeError(new Error('API error 404: Not Found'))).toContain('another organization');
  });

  it('points a missing file at the flag that named it', () => {
    expect(describeError(new Error("ENOENT: no such file or directory, open '/tmp/k.json'"))).toMatch(/--input-file or --config-file/);
  });

  it('passes an unclassifiable message through unchanged', () => {
    expect(describeError(new Error('something specific the API said'))).toBe('something specific the API said');
  });
});

describe('stdin and the terminal', () => {
  it('refuses a prompt when there is no terminal to prompt on', () => {
    // In a pipe or a CI job the prompt used to read end-of-file and submit
    // an empty form, which the provider then rejected for the wrong reason.
    expect(() => requireTty('connect slack via api_key', false)).toThrow(/needs a terminal/);
    expect(() => requireTty('connect slack via api_key', false)).toThrow(/--input-file/);
    expect(() => requireTty('connect slack via api_key', true)).not.toThrow();
  });

  it('refuses --input-stdin when stdin is the terminal, instead of hanging', () => {
    const wasTty = process.stdin.isTTY;
    try {
      Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
      expect(() => assertStdinIsPiped('--input-stdin')).toThrow(/would wait forever/);
      Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
      expect(() => assertStdinIsPiped('--input-stdin')).not.toThrow();
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: wasTty, configurable: true });
    }
  });
});

describe('--input where the form is not known yet', () => {
  it('refuses --input outright for rotate, because the fields cannot be screened', () => {
    // The API only answers with the form after the first rotate call, so
    // there is no way to tell which field is secret before sending it.
    const text = unscreenableInputMessage();
    expect(text).toContain('--input cannot be used here');
    expect(text).toContain('--input-file');
    expect(text).toContain('--input-stdin');
    expect(text).toContain('without echo');
  });
});

describe('version', () => {
  it('reads the version from package.json rather than a constant that drifts', () => {
    // models-cli shipped `--version` 0.1.0 while the package was 1.2.0.
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf-8'));
    expect(VERSION).toBe(pkg.version);
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('falls back rather than crashing when package.json cannot be read', () => {
    expect(readVersion('9.9.9')).toMatch(/^\d+\.\d+\.\d+/);
  });
});
