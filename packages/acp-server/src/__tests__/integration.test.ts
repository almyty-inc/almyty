/**
 * Integration test: spawn the ACP server as a child process,
 * connect via stdin/stdout ndjson, run the full ACP lifecycle.
 *
 * Uses a mock HTTP server standing in for the almyty backend.
 *
 * No sleep before the first request: stdin is a pipe, so anything written
 * before the child finishes booting is buffered by the OS and delivered to
 * readline the moment the loop attaches. Readiness is the handshake reply
 * itself, and every read goes through one persistent reader so a response
 * can never land between two short-lived ones.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { resolve } from 'node:path';

// ── Mock backend ────────────────────────────────────────────────

/**
 * Agent ids are UUIDs everywhere in almyty; the server only takes its
 * `GET /agents/:id` fast path for a UUID and otherwise resolves the
 * argument as a name or slug against `GET /agents`.
 */
const AGENT_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

const MOCK_AGENT = {
  id: AGENT_ID,
  name: 'Test Agent',
  slug: 'test-agent',
  description: 'A test agent',
  mode: 'autonomous',
  status: 'active',
  pipeline: { nodes: [], edges: [] },
};

interface MockBackend {
  server: Server;
  port: number;
  /** Every request the server made, as "METHOD /path". */
  requests: string[];
}

function createMockBackend(): Promise<MockBackend> {
  return new Promise((resolveReady) => {
    const requests: string[] = [];

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        const url = req.url || '';
        requests.push(`${req.method} ${url}`);
        res.setHeader('Content-Type', 'application/json');

        // Auth profile check
        if (url === '/auth/profile') {
          res.end(JSON.stringify({ id: 'user-1', email: 'test@test.com', organizations: [{ id: 'org-1', name: 'Test', role: 'owner' }] }));
          return;
        }
        // List agents — "/agents", optionally with a query string, but not
        // a sub-resource such as "/agents/:id".
        if (req.method === 'GET' && /^\/agents(\?|$)/.test(url)) {
          res.end(JSON.stringify({ agents: [MOCK_AGENT] }));
          return;
        }
        // Get agent by ID
        if (req.method === 'GET' && new RegExp(`^/agents/${AGENT_ID}(\\?|$)`).test(url)) {
          res.end(JSON.stringify(MOCK_AGENT));
          return;
        }
        // Start run
        if (req.method === 'POST' && new RegExp(`^/agents/${AGENT_ID}/runs$`).test(url)) {
          res.end(JSON.stringify({ id: 'run-1', status: 'completed', output: { message: 'Hello from the agent' } }));
          return;
        }
        // Get run
        if (req.method === 'GET' && new RegExp(`^/agents/${AGENT_ID}/runs/run-1$`).test(url)) {
          res.end(JSON.stringify({ id: 'run-1', status: 'completed', output: { message: 'Hello from the agent' } }));
          return;
        }
        // Fallback
        res.statusCode = 404;
        res.end(JSON.stringify({ error: { message: 'Not found', statusCode: 404 } }));
      });
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolveReady({ server, port: addr.port, requests });
    });
  });
}

// ── ndjson client ────────────────────────────────────────────────

const ENTRY_POINT = resolve(__dirname, '../../dist/index.js');

/**
 * One reader over the child's stdout for the whole test: responses are
 * matched by id, notifications are collected separately, and nothing is
 * dropped between requests.
 */
class AcpClient {
  readonly proc: ChildProcess;
  readonly notifications: any[] = [];
  readonly stderr: string[] = [];

  private buffer = '';
  private readonly responses = new Map<number | string, any>();
  private readonly waiters = new Map<number | string, (msg: any) => void>();
  private exited: string | null = null;

  constructor(port: number, agentRef = 'test-agent') {
    this.proc = spawn('node', [ENTRY_POINT, agentRef], {
      env: {
        ...process.env,
        ALMYTY_URL: `http://127.0.0.1:${port}`,
        ALMYTY_TOKEN: 'test-token',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.proc.stdout!.on('data', (chunk) => this.onStdout(String(chunk)));
    this.proc.stderr!.on('data', (chunk) => this.stderr.push(String(chunk)));
    this.proc.on('exit', (code, signal) => {
      this.exited = `child exited (code=${code}, signal=${signal})`;
    });
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;

      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // skip malformed lines
      }

      if (msg.id === undefined || msg.id === null) {
        this.notifications.push(msg);
        continue;
      }
      const waiter = this.waiters.get(msg.id);
      if (waiter) {
        this.waiters.delete(msg.id);
        waiter(msg);
      } else {
        this.responses.set(msg.id, msg);
      }
    }
  }

  send(method: string, params: Record<string, unknown>, id: number): void {
    this.proc.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  }

  /** Write several requests as a single chunk, so they arrive together. */
  sendBurst(requests: Array<{ id: number; method: string; params?: Record<string, unknown> }>): void {
    const payload = requests
      .map((r) => JSON.stringify({ jsonrpc: '2.0', id: r.id, method: r.method, params: r.params ?? {} }))
      .join('\n');
    this.proc.stdin!.write(payload + '\n');
  }

  response(id: number, timeoutMs = 20_000): Promise<any> {
    const already = this.responses.get(id);
    if (already) {
      this.responses.delete(id);
      return Promise.resolve(already);
    }
    return new Promise((resolveMsg, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(id);
        reject(
          new Error(
            `Timed out after ${timeoutMs}ms waiting for response id=${id}. ` +
              `${this.exited ?? 'child still running'}. stderr: ${this.stderr.join('')}`,
          ),
        );
      }, timeoutMs);

      this.waiters.set(id, (msg) => {
        clearTimeout(timer);
        resolveMsg(msg);
      });
    });
  }

  /** Send a request and wait for its response. */
  request(method: string, params: Record<string, unknown>, id: number, timeoutMs = 20_000): Promise<any> {
    this.send(method, params, id);
    return this.response(id, timeoutMs);
  }

  kill(): void {
    this.proc.kill('SIGTERM');
  }
}

// ── Tests ───────────────────────────────────────────────────────

describe('ACP server integration', () => {
  let backend: MockBackend;
  let client: AcpClient | undefined;

  beforeAll(async () => {
    backend = await createMockBackend();
  });

  afterAll(() => {
    backend?.server.close();
  });

  beforeEach(() => {
    backend.requests.length = 0;
  });

  afterEach(() => {
    client?.kill();
    client = undefined;
  });

  it('completes full lifecycle: initialize -> authenticate -> session/new -> session/close', async () => {
    client = new AcpClient(backend.port);

    // 1. Initialize — the reply is the readiness signal.
    const initResp = await client.request('initialize', { protocolVersion: 1, clientCapabilities: {} }, 1);
    expect(initResp.error).toBeUndefined();
    expect(initResp.id).toBe(1);
    expect(initResp.result).toBeDefined();
    expect(initResp.result.protocolVersion).toBe(1);
    expect(initResp.result.agentInfo.name).toBe('Test Agent');

    // 2. Authenticate
    const authResp = await client.request('authenticate', { methodId: 'almyty_token' }, 2);
    expect(authResp.id).toBe(2);
    expect(authResp.error).toBeUndefined();
    expect(authResp.result.authenticated).toBe(true);

    // 3. Session new
    const sessionResp = await client.request('session/new', { cwd: '/tmp' }, 3);
    expect(sessionResp.id).toBe(3);
    expect(sessionResp.error).toBeUndefined();
    expect(sessionResp.result?.sessionId).toBeDefined();

    const sessionId = sessionResp.result.sessionId;

    // 4. Close session — the session must still exist on the same agent.
    const closeResp = await client.request('session/close', { sessionId }, 4);
    expect(closeResp.id).toBe(4);
    expect(closeResp.error).toBeUndefined();
    expect(closeResp.result.closed).toBe(true);
  }, 60_000);

  /**
   * Regression guard for the lazy-init race: readline delivers every line
   * already buffered in the pipe in one synchronous burst, so a batch of
   * requests arriving before the first agent resolution settles used to
   * build one agent — and one SessionManager — per line. Sessions created
   * by one message were then invisible to the next.
   */
  it('shares one agent across requests that arrive in a single burst', async () => {
    client = new AcpClient(backend.port);

    client.sendBurst([
      { id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } },
      { id: 2, method: 'session/new', params: { cwd: '/tmp' } },
    ]);

    const initResp = await client.response(1);
    const sessionResp = await client.response(2);

    expect(initResp.result?.protocolVersion).toBe(1);
    const sessionId = sessionResp.result?.sessionId;
    expect(sessionId).toBeDefined();

    // The agent was resolved exactly once, not once per buffered line.
    const listCalls = backend.requests.filter((r) => r === 'GET /agents');
    expect(listCalls).toHaveLength(1);

    // And the session lives on the agent that later requests reach.
    const closeResp = await client.request('session/close', { sessionId }, 3);
    expect(closeResp.error).toBeUndefined();
    expect(closeResp.result.closed).toBe(true);
  }, 60_000);
});
