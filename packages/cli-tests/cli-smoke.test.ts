/**
 * CLI smoke tests for @almyty/chat, @almyty/mcp-server, @almyty/models
 * and @almyty/connections, exercised against a real backend.
 *
 * The four core CLIs (@almyty/cli, auth, agents, skills) are covered by
 * core-cli-smoke.test.ts, which also asserts the conventions they share.
 *
 * Gated behind RUN_CLI_SMOKE=1, same pattern as the backend's
 * RUN_DB_INTEGRATION=1 gate for real-Postgres integration specs.
 *
 * Prerequisites:
 *   1. All CLI packages built (npx tsc in each package dir)
 *   2. ~/.almyty/credentials.json with a valid token
 *   3. At least one gateway with tools on the target backend
 *
 * Nothing here logs in, and nothing writes to ~/.almyty — install tests
 * write into a temp project directory and clean up after themselves.
 *
 * Run:
 *   cd packages/cli-tests
 *   RUN_CLI_SMOKE=1 npx vitest run
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync, spawnSync, ExecFileSyncOptions } from 'child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';

const GATED = !process.env.RUN_CLI_SMOKE;
const ROOT = resolve(import.meta.dirname, '../..');

/** The shared exit-code table every almyty CLI uses. */
const EXIT = { OK: 0, ERROR: 1, USAGE: 2, AUTH: 3, NOT_FOUND: 4, FAILED: 5 } as const;

function bin(pkg: string): string {
  return join(ROOT, 'packages', pkg, 'dist', 'index.js');
}

function pkgVersion(pkg: string): string {
  return JSON.parse(
    readFileSync(join(ROOT, 'packages', pkg, 'package.json'), 'utf-8'),
  ).version;
}

function run(pkg: string, args: string[], opts?: ExecFileSyncOptions): string {
  return execFileSync('node', [bin(pkg), ...args], {
    encoding: 'utf-8',
    timeout: 20_000,
    stdio: ['pipe', 'pipe', 'pipe'],
    ...opts,
  }).trim();
}

function runOrFail(
  pkg: string,
  args: string[],
  opts?: ExecFileSyncOptions,
): { stdout: string; exitCode: number } {
  try {
    return { stdout: run(pkg, args, opts), exitCode: 0 };
  } catch (err: any) {
    return { stdout: (err.stdout || '') + (err.stderr || ''), exitCode: err.status ?? 1 };
  }
}

/** A HOME with no credentials file, so the auth path can be exercised. */
function unauthenticatedEnv(): NodeJS.ProcessEnv {
  const home = join(tmpdir(), `almyty-nohome-${Date.now()}`);
  mkdirSync(home, { recursive: true });
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.ALMYTY_TOKEN;
  return env;
}

describe.skipIf(GATED)('CLI smoke tests (RUN_CLI_SMOKE=1)', () => {
  beforeAll(() => {
    // Verify binaries exist
    for (const pkg of ['auth-cli', 'agents-cli', 'chat-cli', 'skills-cli', 'mcp-server', 'almyty-cli']) {
      if (!existsSync(bin(pkg))) {
        throw new Error(`${pkg} not built. Run: cd packages/${pkg} && npx tsc`);
      }
    }
  });

  // ---- chat-cli ----
  //
  // chat is a REPL, so the interactive path needs a tty and cannot be
  // driven from here. What is testable is everything that deliberately
  // works without one: the help, the flag surface, one-shot --message,
  // piped --stdin, --json, and the exit-code table. An agent answer can
  // take a while, so these pass their own timeout.

  describe('chat-cli', () => {
    /** An agent to talk to, resolved once from the account's own list. */
    let agentRef: string | null = null;

    /** A question short enough that any model answers it cheaply. */
    const PROMPT = 'Reply with the single word: ready';

    /** An answer can outlast the suite-wide 20s ceiling. */
    const SLOW: ExecFileSyncOptions = { timeout: 90_000 };

    beforeAll(() => {
      try {
        const agents = JSON.parse(run('agents-cli', ['list', '--json']));
        const first = Array.isArray(agents)
          ? (agents.find((a: any) => a.status === 'active') ?? agents[0])
          : null;
        agentRef = first ? (first.slug ?? first.name) : null;
      } catch {
        agentRef = null;
      }
    });

    it('--help documents every slash command, flag, key and exit code', () => {
      const out = run('chat-cli', ['--help']);
      for (const cmd of ['/agents', '/model', '/tools', '/cost', '/trace', '/resume', '/new', '/runners', '/code', '/code-stop', '/esc', '/help', '/clear', '/quit']) {
        expect(out, `${cmd} missing from --help`).toContain(cmd);
      }
      for (const flag of ['--message', '--stdin', '--resume', '--json', '--no-stream', '--no-color', '--max-steps', '--max-cost-cents']) {
        expect(out, `${flag} missing from --help`).toContain(flag);
      }
      expect(out).toContain('Ctrl-C');
      expect(out).toContain('Ctrl-D');
      expect(out).toContain('Exit codes:');
      expect(out).toContain('ALMYTY_AGENT');
    });

    // ── Usage errors ────────────────────────────────────────────

    it('an unknown flag exits 2 and names the flag', () => {
      // Unknown flags used to be dropped silently, so --jsonl looked
      // like a --json that printed nothing machine-readable.
      const { stdout, exitCode } = runOrFail('chat-cli', ['--jsonl']);
      expect(exitCode).toBe(EXIT.USAGE);
      expect(stdout).toContain('--jsonl');
    });

    it('a value flag with no value exits 2', () => {
      expect(runOrFail('chat-cli', ['--resume']).exitCode).toBe(EXIT.USAGE);
    });

    it('no agent and no tty exits 2 rather than drawing a picker', () => {
      expect(runOrFail('chat-cli', ['--json']).exitCode).toBe(EXIT.USAGE);
    });

    // ── Errors a user can act on ────────────────────────────────

    it('no credential exits 3 and names the login command', () => {
      const { stdout, exitCode } = runOrFail('chat-cli', ['acme/bot', '-m', 'hi'], { env: unauthenticatedEnv() });
      expect(exitCode).toBe(EXIT.AUTH);
      expect(stdout).toContain('auth login');
    });

    it('a nonexistent agent exits 4 with a sentence, not a status code', () => {
      const { stdout, exitCode } = runOrFail('chat-cli', ['nosuchorg/nosuchagent', '-m', 'hi']);
      expect(exitCode).toBe(EXIT.NOT_FOUND);
      expect(stdout).not.toMatch(/API error/);
      expect(stdout.length).toBeGreaterThan(20);
    });

    it('an unreachable API says so rather than printing a fetch error', () => {
      const { stdout, exitCode } = runOrFail('chat-cli', ['acme/bot', '-m', 'hi'], {
        // A port nothing is listening on, on purpose.
        env: { ...process.env, ALMYTY_URL: 'http://127.0.0.1:9', ALMYTY_TOKEN: 'not-a-real-token' },
      });
      expect(exitCode).not.toBe(EXIT.OK);
      expect(stdout).toMatch(/Cannot reach|ALMYTY_URL/);
    });

    // ── The answering path ──────────────────────────────────────

    it('answers one question with --message and exits 0', () => {
      if (!agentRef) { console.warn('no agent available, skipping'); return; }
      expect(run('chat-cli', [agentRef, '-m', PROMPT], SLOW).length).toBeGreaterThan(0);
    });

    it('reads the question from a pipe with --stdin', () => {
      if (!agentRef) { console.warn('no agent available, skipping'); return; }
      expect(run('chat-cli', [agentRef, '--stdin'], { ...SLOW, input: PROMPT }).length).toBeGreaterThan(0);
    });

    it('keeps stdout clean, so it can be piped', () => {
      if (!agentRef) { console.warn('no agent available, skipping'); return; }
      // Attribution goes to stderr; only the answer is on stdout.
      const out = run('chat-cli', [agentRef, '-m', PROMPT], { ...SLOW, stdio: ['pipe', 'pipe', 'ignore'] });
      expect(out).not.toContain(' tok');
    });

    it('--json prints one parseable object carrying usage, model and ids', () => {
      if (!agentRef) { console.warn('no agent available, skipping'); return; }
      const parsed = JSON.parse(run('chat-cli', [agentRef, '-m', PROMPT, '--json'], { ...SLOW, stdio: ['pipe', 'pipe', 'ignore'] }));
      expect(parsed).toHaveProperty('status');
      expect(parsed).toHaveProperty('output');
      expect(parsed).toHaveProperty('agent.id');
      expect(parsed).toHaveProperty('usage.cost');
      expect(parsed).toHaveProperty('usage.tokens');
      // Null is a valid answer; the key has to be there either way.
      expect(Object.keys(parsed)).toContain('model');
      expect(Object.keys(parsed)).toContain('conversationId');
    });

    it('reports a token count for an answer that completed', () => {
      if (!agentRef) { console.warn('no agent available, skipping'); return; }
      const parsed = JSON.parse(run('chat-cli', [agentRef, '-m', PROMPT, '--json'], { ...SLOW, stdio: ['pipe', 'pipe', 'ignore'] }));
      if (parsed.status !== 'completed') { console.warn(`run ${parsed.status}, skipping usage assertion`); return; }
      expect(parsed.usage.tokens).toBeGreaterThan(0);
    });

    it('--resume continues the conversation it is given', () => {
      if (!agentRef) { console.warn('no agent available, skipping'); return; }
      const quiet: ExecFileSyncOptions = { ...SLOW, stdio: ['pipe', 'pipe', 'ignore'] };
      const first = JSON.parse(run('chat-cli', [agentRef, '-m', 'Remember the word violet.', '--json'], quiet));
      if (!first.conversationId) { console.warn('agent returned no conversation id, skipping'); return; }
      const second = JSON.parse(
        run('chat-cli', [agentRef, '-m', 'What word did I ask you to remember?', '--json', '--resume', first.conversationId], quiet),
      );
      expect(second.conversationId).toBe(first.conversationId);
    });

    // ── Terminal conventions ────────────────────────────────────

    it('emits no colour when NO_COLOR is set', () => {
      if (!agentRef) { console.warn('no agent available, skipping'); return; }
      const out = run('chat-cli', [agentRef, '-m', PROMPT], {
        ...SLOW,
        stdio: ['pipe', 'pipe', 'ignore'],
        env: { ...process.env, NO_COLOR: '1' },
      });
      const ansi = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m');
      expect(out).not.toMatch(ansi);
    });

    it('honours ALMYTY_AGENT, which is how a compiled terminal app knows its agent', () => {
      if (!agentRef) { console.warn('no agent available, skipping'); return; }
      const out = run('chat-cli', ['-m', PROMPT, '--json'], {
        ...SLOW,
        stdio: ['pipe', 'pipe', 'ignore'],
        env: { ...process.env, ALMYTY_AGENT: agentRef },
      });
      expect(JSON.parse(out)).toHaveProperty('status');
    });

    it('--no-stream still produces the answer', () => {
      if (!agentRef) { console.warn('no agent available, skipping'); return; }
      expect(run('chat-cli', [agentRef, '-m', PROMPT, '--no-stream'], SLOW).length).toBeGreaterThan(0);
    });
  });

  // ---- mcp-server ----

  describe('mcp-server', () => {
    it('--help prints configuration docs', () => {
      const out = run('mcp-server', ['--help']);
      expect(out).toContain('Skill-first');
      expect(out).toContain('ALMYTY_TOKEN');
    });

    it('starts and discovers tools', () => {
      // mcp-server prints tool count to stderr, then reads stdin.
      // With stdin piped to nothing, it exits after discovery.
      const result = spawnSync('node', [bin('mcp-server')], {
        encoding: 'utf-8',
        timeout: 15_000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const combined = (result.stdout || '') + (result.stderr || '');
      expect(combined).toMatch(/\d+ tools/);
    });
  });

  // ---- mcp-server, over the wire ----
  //
  // NOTE (cli-audit): a concurrent edit to this file dropped the opening
  // of this describe block and its `speak()` helper. Both are
  // reconstructed here from how the tests below use them; if the
  // original differed, replace this header rather than the tests.

  describe('mcp-server JSON-RPC', () => {
    const initialize = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'cli-smoke', version: '0' },
      },
    };

    /** Feed JSON-RPC messages in on stdin, collect what comes back. */
    function speak(
      messages: unknown[],
      env: Record<string, string> = {},
    ): { stdout: string; stderr: string } {
      const result = spawnSync('node', [bin('mcp-server')], {
        encoding: 'utf-8',
        timeout: 20_000,
        input: messages.map((m) => JSON.stringify(m)).join('\n') + '\n',
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...env },
      });
      return { stdout: result.stdout || '', stderr: result.stderr || '' };
    }

    it('puts nothing but protocol on stdout', () => {
      // A stray console.log on stdout corrupts the stream and the host
      // editor loses the server with no useful error, so every line stdout
      // carries has to be a JSON-RPC message.
      const { stdout } = speak([initialize, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }]);
      const lines = stdout.trim().split('\n').filter(Boolean);
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        const message = JSON.parse(line);
        expect(message.jsonrpc).toBe('2.0');
      }
    });

    it('registers the two skill-first tools and the management tools', () => {
      const { stdout } = speak([initialize, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }]);
      const listing = stdout.trim().split('\n').map((l) => JSON.parse(l)).find((m) => m.id === 2);
      const names = listing.result.tools.map((t: any) => t.name);
      expect(names).toContain('almyty_execute');
      expect(names).toContain('almyty_search');
      expect(names).toContain('almyty_list_agents');
      // A vendor key must never be a tool parameter: it would be written
      // into the assistant's transcript and the editor's logs.
      const addProvider = listing.result.tools.find((t: any) => t.name === 'almyty_add_provider');
      expect(Object.keys(addProvider.inputSchema.properties)).toContain('credentialId');
      expect(Object.keys(addProvider.inputSchema.properties)).not.toContain('apiKey');
    });

    it('answers a malformed request with a JSON-RPC error rather than dying', () => {
      const { stdout } = speak([
        initialize,
        { jsonrpc: '2.0', id: 2, method: 'no/such/method', params: {} },
        { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'almyty_execute', arguments: { wrong: 1 } } },
      ]);
      const messages = stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
      const unknownMethod = messages.find((m) => m.id === 2);
      expect(unknownMethod.error).toBeTruthy();
      // A bad argument set is an error on that call, and the server keeps going.
      const badArgs = messages.find((m) => m.id === 3);
      expect(badArgs).toBeTruthy();
      expect(badArgs.error || badArgs.result?.isError).toBeTruthy();
    });

    it('still completes the handshake when almyty is unreachable', () => {
      // Discovery used to run before the transport connected, so a backend
      // that was down killed the process mid-handshake and the editor
      // showed a server that had simply died.
      const { stdout, stderr } = speak([initialize], {
        ALMYTY_TOKEN: 'smoke-not-a-real-token',
        ALMYTY_URL: 'http://127.0.0.1:9',
      });
      const reply = JSON.parse(stdout.trim().split('\n')[0]);
      expect(reply.id).toBe(1);
      expect(reply.result.serverInfo.name).toBe('almyty');
      expect(stderr).toMatch(/discovery failed/i);
      // And it says the management tools are still usable.
      expect(stderr).toMatch(/management tools still work/i);
    });

    it('reports a stale token on the tool call rather than as a raw 401', () => {
      const { stdout } = speak([
        initialize,
        { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'almyty_list_agents', arguments: {} } },
      ], { ALMYTY_TOKEN: 'smoke-not-a-real-token' });
      const messages = stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
      const call = messages.find((m) => m.id === 2);
      expect(call).toBeTruthy();
      const text = JSON.stringify(call);
      // Either a clean tool error naming the fix, or a permitted success if
      // the smoke token happens to be accepted by this backend.
      if (call.result?.isError || call.error) {
        expect(text).toMatch(/auth login|lacks permission|Could not reach/);
      }
    });
  });


  // ---- models-cli ----
  //
  // Read-only throughout. Registering a card, deploying weights or deleting
  // one would leave state behind on a shared backend and cost money, so the
  // write path is exercised by the unit suite in packages/models-cli and by
  // hand, not here.

  describe('models-cli', () => {
    it('--version prints a semver', () => {
      expect(run('models-cli', ['--version'])).toMatch(/^\d+\.\d+\.\d+$/);
    });

    it('--help names every command it implements', () => {
      const out = run('models-cli', ['--help']);
      for (const command of [
        'list', 'get <id>', 'register ', 'register-endpoint', 'set <id>', 'sync', 'validate <id>',
        'delete <id>', 'route ', 'versions', 'register-version', 'adapters', 'deploy ',
        'deployments', 'deployment <id>', 'scale ', 'teardown ',
      ]) {
        expect(out, `--help should document ${command}`).toContain(command);
      }
      // The safe ways to pass adapter configuration have to be discoverable.
      expect(out).toContain('--config-file');
      expect(out).toContain('--config-stdin');
    });

    it('list --json returns a parseable array and nothing else on stdout', () => {
      const out = run('models-cli', ['list', '--json']);
      expect(() => JSON.parse(out)).not.toThrow();
      expect(Array.isArray(JSON.parse(out))).toBe(true);
    });

    it('list --selectable returns only cards the router may pick', () => {
      const cards = JSON.parse(run('models-cli', ['list', '--selectable', '--json']));
      for (const card of cards) expect(card.selectable).toBe(true);
    });

    it('adapters lists what each adapter can run', () => {
      const adapters = JSON.parse(run('models-cli', ['adapters', '--json']));
      expect(Array.isArray(adapters)).toBe(true);
      for (const adapter of adapters) {
        expect(adapter.key).toBeTruthy();
        expect(Array.isArray(adapter.modelSchemes)).toBe(true);
      }
    });

    it('route answers with candidates and rejections, calling nothing', () => {
      const { stdout, exitCode } = runOrFail('models-cli', ['route', '--json']);
      // Exit 5 when no card satisfies the policy, which is a legitimate
      // answer on a backend with an empty catalog.
      expect([0, 5]).toContain(exitCode);
      const plan = JSON.parse(stdout);
      expect(Array.isArray(plan.candidates)).toBe(true);
      expect(Array.isArray(plan.rejected)).toBe(true);
      for (const r of plan.rejected) expect(r.reason).toBeTruthy();
    });

    it('deployments --json returns an array', () => {
      const out = run('models-cli', ['deployments', '--json']);
      expect(Array.isArray(JSON.parse(out))).toBe(true);
    });

    it('versions --json returns an array', () => {
      expect(Array.isArray(JSON.parse(run('models-cli', ['versions', '--json'])))).toBe(true);
    });

    it('a missing id is a usage error, not a request for /models/undefined', () => {
      const { stdout, exitCode } = runOrFail('models-cli', ['get']);
      expect(exitCode).toBe(2);
      expect(stdout).toContain('card id is required');
    });

    it('refuses an endpoint key passed on the command line', () => {
      // argv is readable through `ps` and lands in shell history.
      const { stdout, exitCode } = runOrFail('models-cli', [
        'register-endpoint', '--name', 'smoke', '--url', 'https://example.invalid/v1',
        '--model', 'm', '--api-key', 'not-a-real-key',
      ]);
      expect(exitCode).toBe(2);
      expect(stdout).toContain('--api-key-stdin');
      // Nothing was created: the refusal happens before the request.
    });

    it('unknown command exits 2', () => {
      expect(runOrFail('models-cli', ['nonexistent-cmd']).exitCode).toBe(2);
    });
  });

  // ---- connections-cli ----
  //
  // Read-only only, and deliberately so: connecting an account means
  // handling a real third-party secret. `connect`, `rotate` and
  // `disconnect` are never exercised here.

  describe('connections-cli', () => {
    it('--version prints a semver', () => {
      expect(run('connections-cli', ['--version'])).toMatch(/^\d+\.\d+\.\d+$/);
    });

    it('--help names every command it implements', () => {
      const out = run('connections-cli', ['--help']);
      for (const command of [
        'connectors', 'list', 'get <id>', 'connect <key>', 'complete <key>',
        'validate <id>', 'rotate <id>', 'disconnect <id>', 'grants <id>', 'grant <id>', 'revoke <id>',
      ]) {
        expect(out, `--help should document ${command}`).toContain(command);
      }
      // The safe ways to supply a secret have to be discoverable.
      expect(out).toContain('--input-file');
      expect(out).toContain('--input-stdin');
      expect(out).toContain('--headless');
    });

    it('connectors --json describes what can be connected, and how', () => {
      const connectors = JSON.parse(run('connections-cli', ['connectors', '--json']));
      expect(connectors.length).toBeGreaterThan(0);
      for (const connector of connectors) {
        expect(connector.key).toBeTruthy();
        expect(connector.kind).toBeTruthy();
        expect(Array.isArray(connector.connect)).toBe(true);
        expect(connector.connect.length).toBeGreaterThan(0);
      }
    });

    it('connectors --kind filters at the API', () => {
      const inference = JSON.parse(run('connections-cli', ['connectors', '--kind', 'inference', '--json']));
      for (const connector of inference) expect(connector.kind).toBe('inference');
    });

    it('list --json never returns a secret value', () => {
      const connections = JSON.parse(run('connections-cli', ['list', '--json']));
      expect(Array.isArray(connections)).toBe(true);
      for (const connection of connections) {
        expect(connection.health?.status).toBeTruthy();
        // The store never hands a secret back, not even masked.
        expect(connection).not.toHaveProperty('config');
        expect(connection).not.toHaveProperty('configuration');
        expect(JSON.stringify(connection)).not.toMatch(/"apiKey"|"accessToken"|"bot_token"/);
      }
    });

    it('a missing id is a usage error, not a request for /connections/undefined', () => {
      const { stdout, exitCode } = runOrFail('connections-cli', ['validate']);
      expect(exitCode).toBe(2);
      expect(stdout).toContain('connection id is required');
    });

    it('refuses a secret passed with --input', () => {
      // Needs a connector whose form marks a field secret; every api_key
      // connector does. Skipped when the catalog has none.
      const connectors = JSON.parse(run('connections-cli', ['connectors', '--json']));
      const withSecret = connectors.find((c: any) =>
        (c.connect ?? []).some((m: any) => Object.values(m.schema?.properties ?? {}).some((p: any) => p['x-secret'] === true)));
      if (!withSecret) {
        console.warn('No connector with a secret form field; skipping the argv-secret check');
        return;
      }
      const method = withSecret.connect.find((m: any) =>
        Object.values(m.schema?.properties ?? {}).some((p: any) => p['x-secret'] === true));
      const secretField = Object.entries(method.schema.properties)
        .find(([, p]: any) => p['x-secret'] === true)![0];

      const { stdout, exitCode } = runOrFail('connections-cli', [
        'connect', withSecret.key, '--method', method.type,
        '--input', JSON.stringify({ [secretField]: 'not-a-real-secret' }),
      ]);
      expect(exitCode).toBe(2);
      expect(stdout).toContain(secretField);
      expect(stdout).toContain('--input-stdin');
    });

    it('unknown command exits 2', () => {
      expect(runOrFail('connections-cli', ['nonexistent-cmd']).exitCode).toBe(2);
    });
  });
});
