/**
 * Drives the real entry point over stdio, and stands in for the almyty
 * backend with a local HTTP server. Not a spec file: shared by the specs
 * that start the process.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { createServer as createHttpServer, type IncomingHttpHeaders, type Server } from 'http';
import { createServer } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';

export type Message = { jsonrpc: '2.0'; id?: number; method?: string; params?: any; result?: any; error?: any };

const packageDir = join(import.meta.dirname, '..', '..');

/** A port that was free a moment ago, so a connect to it is refused at once. */
export async function closedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

export function waitFor(check: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (check()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error(`timed out waiting for ${what}`));
      setTimeout(tick, 20);
    };
    tick();
  });
}

export const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const MODERN_META = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientCapabilities': {},
  'io.modelcontextprotocol/clientInfo': { name: 'spec', version: '0' },
};

export interface StdioServer {
  messages: Message[];
  stderr(): string;
  send(message: Record<string, unknown>): void;
  response(id: number): Promise<Message>;
  stop(): void;
}

/** Start `src/index.ts` with the given environment. */
export function startServer(env: Record<string, string>, args: string[] = ['acme/petstore']): StdioServer {
  const home = mkdtempSync(join(tmpdir(), 'almyty-mcp-spec-'));
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, ['--import', 'tsx', join('src', 'index.ts'), ...args], {
    cwd: packageDir,
    env: { ...process.env, HOME: home, USERPROFILE: home, ALMYTY_TOKEN: 'test-token', ...env },
  });
  const messages: Message[] = [];
  let stderr = '';
  let buffered = '';
  child.stdout.setEncoding('utf-8');
  child.stdout.on('data', (chunk: string) => {
    buffered += chunk;
    let newline: number;
    while ((newline = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      if (line) messages.push(JSON.parse(line));
    }
  });
  child.stderr.setEncoding('utf-8');
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  return {
    messages,
    stderr: () => stderr,
    send: (message) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`),
    async response(id: number) {
      await waitFor(() => messages.some((m) => m.id === id && (m.result !== undefined || m.error !== undefined)), `response ${id}`);
      return messages.find((m) => m.id === id && (m.result !== undefined || m.error !== undefined))!;
    },
    stop() {
      child.kill();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

export interface FakeAlmyty {
  url: string;
  requests: Array<{ headers: IncomingHttpHeaders; body: any }>;
  close(): Promise<void>;
}

/**
 * An almyty backend that speaks MCP 2026-07-28 on `/acme/petstore`: one
 * gateway tool with a title, an output schema and annotations, and no
 * skills. A 2026 request without its headers is refused, as the real core
 * does.
 */
export async function fakeAlmyty(options: { toolsListDelayMs?: number } = {}): Promise<FakeAlmyty> {
  const requests: FakeAlmyty['requests'] = [];
  const tool = {
    name: 'orders_get_order',
    title: 'Get order',
    description: 'Look an order up by its number',
    inputSchema: { type: 'object', properties: { orderId: { type: 'string', description: 'e.g. NW-10428' } }, required: ['orderId'] },
    outputSchema: { type: 'object', properties: { id: { type: 'string' }, status: { type: 'string' } }, required: ['id', 'status'] },
    annotations: { readOnlyHint: true, openWorldHint: true },
  };
  const server: Server = createHttpServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      requests.push({ headers: req.headers, body });
      const modern = !!body.params?._meta;
      const reply = (result: unknown) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: modern ? { ...(result as object), resultType: 'complete' } : result }));
      };
      if (modern && (req.headers['mcp-protocol-version'] !== '2026-07-28' || req.headers['mcp-method'] !== body.method)) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32020, message: 'Header mismatch' } }));
        return;
      }
      if (body.method === 'tools/list') {
        setTimeout(() => reply({ tools: [tool] }), options.toolsListDelayMs ?? 0);
        return;
      }
      if (body.method === 'skills/list') return reply({ skills: [] });
      if (body.method === 'tools/call') {
        const order = { id: body.params.arguments.orderId, status: 'delayed' };
        return reply({ content: [{ type: 'text', text: JSON.stringify(order) }], structuredContent: order, isError: false });
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'Method not found' } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
