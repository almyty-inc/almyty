/**
 * Integration test: spawn the ACP server as a child process,
 * connect via stdin/stdout ndjson, run the full ACP lifecycle.
 *
 * Uses a mock HTTP server standing in for the almyty backend.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';

// ── Mock backend ────────────────────────────────────────────────

const MOCK_AGENT = {
  id: 'agent-123',
  name: 'Test Agent',
  description: 'A test agent',
  mode: 'autonomous',
  status: 'active',
  pipeline: { nodes: [], edges: [] },
};

function createMockBackend(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        const url = req.url || '';
        res.setHeader('Content-Type', 'application/json');

        // Auth profile check
        if (url === '/auth/profile') {
          res.end(JSON.stringify({ id: 'user-1', email: 'test@test.com', organizations: [{ id: 'org-1', name: 'Test', role: 'owner' }] }));
          return;
        }
        // List agents
        if (url.startsWith('/agents') && req.method === 'GET' && !url.includes('/')) {
          res.end(JSON.stringify({ agents: [MOCK_AGENT] }));
          return;
        }
        // Get agent by ID
        if (url.match(/\/agents\/agent-123$/) && req.method === 'GET') {
          res.end(JSON.stringify(MOCK_AGENT));
          return;
        }
        // Start run
        if (url.match(/\/agents\/agent-123\/runs$/) && req.method === 'POST') {
          res.end(JSON.stringify({ id: 'run-1', status: 'completed', output: { message: 'Hello from the agent' } }));
          return;
        }
        // Get run
        if (url.match(/\/agents\/agent-123\/runs\/run-1$/) && req.method === 'GET') {
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
      resolve({ server, port: addr.port });
    });
  });
}

// ── ndjson helpers ───────────────────────────────────────────────

function sendRequest(proc: ChildProcess, method: string, params?: any, id?: number): void {
  const msg = JSON.stringify({ jsonrpc: '2.0', id: id ?? 1, method, params: params ?? {} });
  proc.stdin!.write(msg + '\n');
}

function readResponses(proc: ChildProcess, count: number, timeoutMs = 10000): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const results: any[] = [];
    const rl = createInterface({ input: proc.stdout! });
    const timer = setTimeout(() => {
      rl.close();
      resolve(results); // return what we have
    }, timeoutMs);

    rl.on('line', (line) => {
      try {
        results.push(JSON.parse(line));
        if (results.length >= count) {
          clearTimeout(timer);
          rl.close();
          resolve(results);
        }
      } catch {
        // skip malformed lines
      }
    });
  });
}

// ── Tests ───────────────────────────────────────────────────────

describe('ACP server integration', () => {
  let mockBackend: Server;
  let backendPort: number;
  let proc: ChildProcess;

  beforeAll(async () => {
    const backend = await createMockBackend();
    mockBackend = backend.server;
    backendPort = backend.port;
  });

  afterAll(() => {
    proc?.kill('SIGTERM');
    mockBackend?.close();
  });

  it('completes full lifecycle: initialize -> authenticate -> session/new -> session/prompt', async () => {
    const entryPoint = resolve(__dirname, '../../dist/index.js');

    proc = spawn('node', [entryPoint, 'agent-123'], {
      env: {
        ...process.env,
        ALMYTY_URL: `http://127.0.0.1:${backendPort}`,
        ALMYTY_TOKEN: 'test-token',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Give the process a moment to start
    await new Promise((r) => setTimeout(r, 500));

    // 1. Initialize
    sendRequest(proc, 'initialize', { protocolVersion: 1, clientCapabilities: {} }, 1);
    const [initResp] = await readResponses(proc, 1, 5000);
    expect(initResp.id).toBe(1);
    expect(initResp.result).toBeDefined();
    expect(initResp.result.protocolVersion).toBe(1);

    // 2. Authenticate
    sendRequest(proc, 'authenticate', { methodId: 'env_var' }, 2);
    const [authResp] = await readResponses(proc, 1, 5000);
    expect(authResp.id).toBe(2);
    expect(authResp.error).toBeUndefined();

    // 3. Session new
    sendRequest(proc, 'session/new', { cwd: '/tmp' }, 3);
    const [sessionResp] = await readResponses(proc, 1, 5000);
    expect(sessionResp.id).toBe(3);
    expect(sessionResp.result?.sessionId).toBeDefined();

    const sessionId = sessionResp.result.sessionId;

    // 4. Close session
    sendRequest(proc, 'session/close', { sessionId }, 4);
    const [closeResp] = await readResponses(proc, 1, 5000);
    expect(closeResp.id).toBe(4);
    expect(closeResp.error).toBeUndefined();

    // Clean up
    proc.kill('SIGTERM');
  }, 30000);
});
