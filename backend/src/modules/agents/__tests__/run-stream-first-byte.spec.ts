import { createServer, request, type IncomingMessage, type Server } from 'http';
import { AddressInfo } from 'net';

import { AgentRunsController } from '../agent-runs.controller';
import { EVENT_STREAM_OPENING, openEventStream } from '../../../common/utils/event-stream';

/**
 * A run with nothing new to say must still answer at once. Proxies (vite's
 * dev proxy, nginx, an ingress) can hold a response until its first body
 * byte; a stream that wrote only headers then looked like "Connecting" for
 * up to the 25 s keep-alive. The stream now opens with an SSE comment and
 * asks not to be buffered or transformed.
 */
describe('the run stream answers before its first event', () => {
  let server: Server;
  let port: number;
  let aborted: Promise<void>;

  beforeEach(async () => {
    let markAborted!: () => void;
    aborted = new Promise((r) => (markAborted = r));
    // A run that never produces an event while the viewer watches.
    const runtime = {
      getRun: jest.fn(async () => ({ id: 'run-1' })),
      subscribeRunLog: jest.fn((_runId: string, _after: number, _onLog: unknown, _onEvent: unknown, signal: AbortSignal) =>
        new Promise<void>((resolve) => signal.addEventListener('abort', () => { markAborted(); resolve(); }))),
      subscribeRunEvents: jest.fn((_runId: string, _handler: unknown, signal: AbortSignal) =>
        new Promise<void>((resolve) => signal.addEventListener('abort', () => { markAborted(); resolve(); }))),
    };
    const controller = new AgentRunsController(runtime as any);
    server = createServer((req, res) => {
      const after = new URL(req.url ?? '/', 'http://x').searchParams.get('after') ?? undefined;
      void controller.streamRun('agent-1', 'run-1', Object.assign(req, { user: { currentOrganizationId: 'org-1' } }) as any, res as any, after);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    // A stream left open would keep close() waiting; drop every connection first.
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });

  // Headers and the first body chunk, or a timeout; then hang up.
  const firstBytes = (path: string) =>
    new Promise<{ res: IncomingMessage; chunk: string }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no body byte within 1 s')), 1000);
      const req = request({ host: '127.0.0.1', port, path, headers: { accept: 'text/event-stream' } }, (res) => {
        res.once('data', (d) => {
          clearTimeout(timer);
          resolve({ res, chunk: String(d) });
          req.destroy();
        });
      });
      req.on('error', () => {});
      req.end();
    });

  it.each([['resuming from a seq', '/s?after=0'], ['the live stream', '/s']])('%s: an opening comment arrives at once, with headers that forbid buffering', async (_name, path) => {
    const { res, chunk } = await firstBytes(path);
    expect(chunk).toBe(EVENT_STREAM_OPENING);
    expect(res.headers['content-type']).toBe('text/event-stream');
    expect(res.headers['cache-control']).toBe('no-cache, no-transform');
    expect(res.headers['x-accel-buffering']).toBe('no');
    // Hanging up ends the subscription.
    await aborted;
  });

  it('the opening is a comment, which every SSE reader skips', () => {
    expect(EVENT_STREAM_OPENING.startsWith(':')).toBe(true);
    expect(EVENT_STREAM_OPENING.endsWith('\n\n')).toBe(true);
    const out: string[] = [];
    const headers: Record<string, string> = {};
    openEventStream({ setHeader: (k, v) => (headers[k] = v), flushHeaders: () => {}, write: (c) => out.push(c) });
    expect(out).toEqual([EVENT_STREAM_OPENING]);
    expect(headers).toEqual({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
  });
});
