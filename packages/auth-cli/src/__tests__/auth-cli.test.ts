import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

import { parseArgs, flagNumber, flagString } from '../args';
import {
  credentialSummary,
  expiryState,
  expiresAtFromToken,
  emailFromToken,
  enrichFromToken,
  jwtClaims,
} from '../credentials';
import { assertSecureBackendUrl } from '../config';
import { EXIT } from '../exit-codes';
import { readVersion } from '../version';

const SRC = join(import.meta.dirname, '..');
const ANSI = new RegExp(String.fromCharCode(27) + '\\[');

function sourceFiles(): string[] {
  return readdirSync(SRC)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => join(SRC, f));
}

/**
 * `cmdLogin` did `const { resolveApiUrl } = require('./config')` inside
 * an ESM package, so every `almyty login` died with "require is not
 * defined" before it printed anything. Nothing type-checks that, so
 * guard it at the source level.
 */
describe('ESM correctness (the package is "type": "module")', () => {
  it('uses no CommonJS require() or module.exports', () => {
    for (const file of sourceFiles()) {
      const text = readFileSync(file, 'utf-8');
      expect(text, file).not.toMatch(/(^|[^.\w])require\s*\(/);
      expect(text, file).not.toMatch(/module\.exports/);
    }
  });

  it('gives every relative import a .js specifier', () => {
    // moduleResolution "bundler" emits import specifiers verbatim, so a
    // bare './credentials' is ERR_MODULE_NOT_FOUND at runtime even
    // though tsc is happy. config.ts shipped exactly that.
    const pattern = /(?:from|import)\s*\(?\s*'(\.[^']*)'/g;
    for (const file of sourceFiles()) {
      const text = readFileSync(file, 'utf-8');
      for (const [, spec] of text.matchAll(pattern)) {
        expect(spec.endsWith('.js'), `${file}: ${spec}`).toBe(true);
      }
    }
  });
});

describe('parseArgs', () => {
  it('reads the command and positionals', () => {
    const a = parseArgs(['login', 'extra']);
    expect(a.command).toBe('login');
    expect(a.positional).toEqual(['extra']);
  });

  it('accepts --flag value', () => {
    expect(parseArgs(['login', '--token', 'abc']).flags.token).toBe('abc');
  });

  it('accepts --flag=value', () => {
    // Only the space form used to parse, so `--api=https://x` became a
    // flag literally named `api=https://x` and the value was dropped.
    expect(parseArgs(['login', '--api=https://x']).flags.api).toBe('https://x');
  });

  it('keeps an = inside the value intact', () => {
    expect(parseArgs(['run', '--input={"a":"b=c"}']).flags.input).toBe('{"a":"b=c"}');
  });

  it('never lets a declared boolean swallow the next token', () => {
    const a = parseArgs(['login', '--no-browser', 'positional'], ['no-browser']);
    expect(a.flags['no-browser']).toBe(true);
    expect(a.positional).toEqual(['positional']);
  });

  it('treats --json, --help and --version as booleans everywhere', () => {
    const a = parseArgs(['whoami', '--json', 'trailing']);
    expect(a.flags.json).toBe(true);
    expect(a.positional).toEqual(['trailing']);
  });

  it('supports -h and -v', () => {
    expect(parseArgs(['-h']).flags.help).toBe(true);
    expect(parseArgs(['-v']).flags.version).toBe(true);
  });

  it('passes everything after -- through as positional', () => {
    const a = parseArgs(['run', '--', '--not-a-flag']);
    expect(a.positional).toEqual(['--not-a-flag']);
  });

  it('rejects a non-numeric value for a numeric flag', () => {
    expect(() => flagNumber({ 'max-steps': 'ten' }, 'max-steps')).toThrow(/needs a number/);
    expect(flagNumber({ 'max-steps': '10' }, 'max-steps')).toBe(10);
    expect(flagNumber({}, 'max-steps')).toBeUndefined();
  });

  it('reads a bare flag as absent, not as the string "true"', () => {
    expect(flagString({ token: true }, 'token')).toBeUndefined();
  });
});

describe('credentialSummary', () => {
  it('never returns the token itself', () => {
    const token = 'abcdefghijklmnopqrstuvwxyz';
    const summary = credentialSummary({ url: 'https://api.almyty.com', token });
    expect(JSON.stringify(summary)).not.toContain(token);
    expect(summary.tokenPreview.startsWith('abcdefgh')).toBe(true);
    expect(summary.tokenPreview.endsWith('wxyz')).toBe(true);
  });

  it('masks a short token entirely rather than revealing most of it', () => {
    const summary = credentialSummary({ url: 'u', token: 'short' });
    expect(summary.tokenPreview).toBe('*****');
  });
});

describe('expiryState', () => {
  const now = new Date('2026-01-01T00:00:00Z');

  it('says unknown when nothing was recorded', () => {
    expect(expiryState({ url: 'u', token: 't' }, now).state).toBe('unknown');
  });

  it('says expired for a past timestamp', () => {
    // whoami reported a happy identity for a long-dead token, so the
    // first real failure landed in whichever CLI the user ran next.
    const state = expiryState(
      { url: 'u', token: 't', expiresAt: '2025-12-31T00:00:00Z' },
      now,
    );
    expect(state.state).toBe('expired');
    expect(state.message).toContain('expired');
  });

  it('says valid and how long is left', () => {
    const state = expiryState(
      { url: 'u', token: 't', expiresAt: '2026-01-05T00:00:00Z' },
      now,
    );
    expect(state.state).toBe('valid');
    expect(state.message).toContain('4 days');
  });

  it('does not claim validity for an unparseable timestamp', () => {
    expect(
      expiryState({ url: 'u', token: 't', expiresAt: 'soon' }, now).state,
    ).toBe('unknown');
  });
});

describe('token claims', () => {
  function jwt(payload: Record<string, unknown>): string {
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    return `${b64({ alg: 'none' })}.${b64(payload)}.sig`;
  }

  it('reads exp and email out of a JWT', () => {
    const token = jwt({ exp: 1767225600, email: 'dev@example.com' });
    expect(expiresAtFromToken(token)).toBe('2026-01-01T00:00:00.000Z');
    expect(emailFromToken(token)).toBe('dev@example.com');
  });

  it('returns nothing for an opaque token', () => {
    expect(jwtClaims('not-a-jwt')).toBeNull();
    expect(expiresAtFromToken('not-a-jwt')).toBeUndefined();
    expect(emailFromToken('not-a-jwt')).toBeUndefined();
  });

  it('fills in expiry at save time so whoami has something to check', () => {
    const token = jwt({ exp: 1767225600, email: 'dev@example.com' });
    const enriched = enrichFromToken({ url: 'https://api.almyty.com', token });
    expect(enriched.expiresAt).toBe('2026-01-01T00:00:00.000Z');
    expect(enriched.email).toBe('dev@example.com');
  });

  it('does not overwrite values the caller already supplied', () => {
    const token = jwt({ exp: 1767225600, email: 'dev@example.com' });
    const enriched = enrichFromToken({
      url: 'u',
      token,
      email: 'explicit@example.com',
      expiresAt: '2030-01-01T00:00:00.000Z',
    });
    expect(enriched.email).toBe('explicit@example.com');
    expect(enriched.expiresAt).toBe('2030-01-01T00:00:00.000Z');
  });
});

describe('assertSecureBackendUrl', () => {
  it('allows https anywhere and http on loopback only', () => {
    expect(() => assertSecureBackendUrl('https://api.almyty.com')).not.toThrow();
    expect(() => assertSecureBackendUrl('http://localhost:4000')).not.toThrow();
    expect(() => assertSecureBackendUrl('http://127.0.0.1:4000')).not.toThrow();
    expect(() => assertSecureBackendUrl('http://api.almyty.com')).toThrow(/insecure/);
  });
});

describe('help text', () => {
  it('documents every command and flag the code implements', () => {
    const index = readFileSync(join(SRC, 'index.ts'), 'utf-8');
    const help = index.slice(
      index.indexOf('function printHelp'),
      index.indexOf('function emitJson'),
    );
    for (const token of [
      'login',
      'logout',
      'whoami',
      '--token',
      '--frontend',
      '--api',
      '--no-browser',
      '--verify',
      '--json',
      'ALMYTY_TOKEN',
      'ALMYTY_URL',
      'ALMYTY_FRONTEND_URL',
      'NO_COLOR',
      'Exit codes',
    ]) {
      expect(help, token).toContain(token);
    }
  });

  it('emits no ANSI colour, so piping needs no NO_COLOR', () => {
    for (const file of sourceFiles()) {
      expect(ANSI.test(readFileSync(file, 'utf-8')), file).toBe(false);
    }
  });
});

describe('version', () => {
  it('comes from package.json', () => {
    const pkg = JSON.parse(readFileSync(join(SRC, '../package.json'), 'utf-8'));
    expect(readVersion()).toBe(pkg.version);
  });
});

describe('exit codes', () => {
  it('matches the table the other almyty CLIs use', () => {
    expect(EXIT).toMatchObject({ OK: 0, ERROR: 1, USAGE: 2, AUTH: 3, NOT_FOUND: 4, FAILED: 5 });
  });
});

describe('README matches the code', () => {
  const readme = readFileSync(join(SRC, '../README.md'), 'utf-8');
  const index = readFileSync(join(SRC, 'index.ts'), 'utf-8');
  const help = index.slice(index.indexOf('function printHelp'), index.indexOf('function emitJson'));
  const dispatched = [...index.matchAll(/^\s{4}case '([a-z]+)':/gm)].map((m) => m[1]);

  it('documents every command the code dispatches', () => {
    expect(dispatched).toEqual(['login', 'logout', 'whoami']);
    for (const name of dispatched) {
      expect(readme, name).toContain(`| \`${name}\` |`);
    }
  });

  it('documents every flag --help documents', () => {
    const helpFlags = new Set([...help.matchAll(/--[a-z][a-z-]+/g)].map((m) => m[0]));
    for (const flag of helpFlags) {
      expect(readme, flag).toContain(flag);
    }
  });

  it('documents both files login writes', () => {
    expect(readme).toContain('~/.almyty/credentials.json');
    expect(readme).toContain('~/.almyty/config.json');
  });

  it('documents the exit codes this CLI can return', () => {
    for (const code of [EXIT.OK, EXIT.ERROR, EXIT.USAGE, EXIT.AUTH]) {
      expect(readme, `exit code ${code}`).toContain(`| \`${code}\` |`);
    }
  });

  it('documents every environment variable the code reads', () => {
    for (const name of ['ALMYTY_TOKEN', 'ALMYTY_URL', 'ALMYTY_FRONTEND_URL', 'NO_COLOR']) {
      expect(readme, name).toContain(name);
    }
  });
});
