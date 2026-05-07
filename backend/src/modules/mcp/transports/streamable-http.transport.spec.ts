import { Test } from '@nestjs/testing';
import { Request, Response } from 'express';
import { EventEmitter } from 'events';

import { StreamableHttpTransport } from './streamable-http.transport';
import { McpService } from '../mcp.service';
import { McpSessionService } from '../mcp-session.service';
import { WORKER_PROTOCOL_VERSION, WORKER_ERROR_CODES } from '../types/worker-protocol.types';

/**
 * Each test exercises one specific behavior of the Streamable HTTP
 * transport. No coverage padding: if a test isn't pinning a real
 * failure mode, it isn't here.
 */
describe('StreamableHttpTransport', () => {
  let transport: StreamableHttpTransport;
  let mcpService: { handleJsonRpc: jest.Mock };
  let sessionService: { createSession: jest.Mock };

  beforeEach(async () => {
    mcpService = { handleJsonRpc: jest.fn() };
    sessionService = {
      createSession: jest.fn().mockReturnValue({ id: 'mcp-session', organizationId: 'org', transport: 'streamable-http' }),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        StreamableHttpTransport,
        { provide: McpService, useValue: mcpService },
        { provide: McpSessionService, useValue: sessionService },
      ],
    }).compile();
    transport = moduleRef.get(StreamableHttpTransport);
  });

  afterEach(async () => {
    await transport.shutdown();
  });

  // ── helpers ─────────────────────────────────────────────────────────

  function mockReq(headers: Record<string, string> = {}, body: unknown = undefined): Request {
    return {
      header: (name: string) => headers[name] ?? headers[name.toLowerCase()],
      body,
    } as unknown as Request;
  }

  function mockRes() {
    const events = new EventEmitter();
    const writes: string[] = [];
    const headers: Record<string, string> = {};
    let statusCode = 200;
    let ended = false;
    let jsonBody: unknown;

    const res: any = {
      headersSent: false,
      destroyed: false,
      setHeader: (k: string, v: string) => { headers[k] = v; },
      getHeader: (k: string) => headers[k],
      flushHeaders: jest.fn(),
      status(code: number) { statusCode = code; return this; },
      json(body: unknown) { jsonBody = body; return this; },
      end() { ended = true; return this; },
      write(chunk: string) { writes.push(chunk); return true; },
      on: events.on.bind(events),
      emit: events.emit.bind(events),
      // helpers visible only to the test
      _writes: writes,
      _headers: headers,
      get _statusCode() { return statusCode; },
      get _ended() { return ended; },
      get _jsonBody() { return jsonBody; },
      get _events() { return events; },
    };
    return res as Response & { _writes: string[]; _headers: Record<string, string>; _statusCode: number; _ended: boolean; _jsonBody: any; _events: EventEmitter };
  }

  function parseEventFrames(raw: string[]): { id: string; event: string; data: any }[] {
    return raw
      .map(frame => {
        const id = /^id: (.+)$/m.exec(frame)?.[1] ?? '';
        const event = /^event: (.+)$/m.exec(frame)?.[1] ?? '';
        const data = /^data: (.+)$/m.exec(frame)?.[1] ?? '';
        return { id, event, data: data ? JSON.parse(data) : undefined };
      });
  }

  // ── POST: JSON-RPC dispatch ─────────────────────────────────────────

  it('POST with JSON-RPC body dispatches to McpService and returns 200 with the response inline', async () => {
    mcpService.handleJsonRpc.mockResolvedValue({ jsonrpc: '2.0', id: 1, result: { ok: true } });
    const req = mockReq({}, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const res = mockRes();

    await transport.handlePost(req, res, 'org', 'user');

    expect(mcpService.handleJsonRpc).toHaveBeenCalledWith(
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      'org',
      'user',
    );
    expect(res._statusCode).toBe(200);
    expect(res._jsonBody).toEqual({ jsonrpc: '2.0', id: 1, result: { ok: true } });
    expect(res._headers['Mcp-Session-Id']).toBeTruthy();
  });

  it('POST with JSON-RPC notification (no id) returns 202 with no body', async () => {
    const req = mockReq({}, { jsonrpc: '2.0', method: 'notifications/initialized' });
    const res = mockRes();
    mcpService.handleJsonRpc.mockResolvedValue(undefined);

    await transport.handlePost(req, res, 'org', 'user');

    expect(res._statusCode).toBe(202);
    expect(res._ended).toBe(true);
  });

  // ── POST: worker envelope dispatch ──────────────────────────────────

  it('POST with a worker envelope emits an envelope event and returns 202', async () => {
    const onEnvelope = jest.fn();
    transport.on('envelope', onEnvelope);

    const env = {
      v: WORKER_PROTOCOL_VERSION,
      type: 'request' as const,
      id: 'req-1',
      ts: Date.now(),
      payload: { method: 'process.spawn', args: ['echo', 'hi'] },
    };
    const res = mockRes();
    await transport.handlePost(mockReq({}, env), res, 'org', 'user');

    expect(onEnvelope).toHaveBeenCalledTimes(1);
    expect(onEnvelope.mock.calls[0][0]).toMatchObject({ id: 'req-1', type: 'request' });
    expect(res._statusCode).toBe(202);
    // McpService should not have been invoked for a worker envelope.
    expect(mcpService.handleJsonRpc).not.toHaveBeenCalled();
  });

  it('POST with a malformed envelope (wrong v) returns a typed error, not 500', async () => {
    const env = { v: 999, type: 'request', id: 'x', ts: Date.now(), payload: {} };
    const res = mockRes();
    await transport.handlePost(mockReq({}, env), res, 'org', 'user');

    expect(res._statusCode).toBe(400);
    expect(res._jsonBody.payload.code).toBe(WORKER_ERROR_CODES.MALFORMED_ENVELOPE);
  });

  it('POST with an unrecognized body returns malformed-envelope error', async () => {
    const res = mockRes();
    await transport.handlePost(mockReq({}, { hello: 'world' }), res, 'org', 'user');
    expect(res._statusCode).toBe(400);
    expect(res._jsonBody.payload.code).toBe(WORKER_ERROR_CODES.MALFORMED_ENVELOPE);
  });

  // ── Sessions ─────────────────────────────────────────────────────────

  it('POST without Mcp-Session-Id mints a fresh session and echoes the id', async () => {
    mcpService.handleJsonRpc.mockResolvedValue({ jsonrpc: '2.0', id: 1, result: 'ok' });
    const res = mockRes();
    await transport.handlePost(mockReq({}, { jsonrpc: '2.0', id: 1, method: 'ping' }), res, 'org');
    const sid = res._headers['Mcp-Session-Id'];
    expect(sid).toMatch(/^sh_/);
    expect(transport.getStats().sessions).toBe(1);
  });

  it('POST with a known Mcp-Session-Id reuses the existing session', async () => {
    mcpService.handleJsonRpc.mockResolvedValue({ jsonrpc: '2.0', id: 1, result: 'ok' });
    const r1 = mockRes();
    await transport.handlePost(mockReq({}, { jsonrpc: '2.0', id: 1, method: 'a' }), r1, 'org');
    const sid = r1._headers['Mcp-Session-Id'];
    const r2 = mockRes();
    await transport.handlePost(mockReq({ 'Mcp-Session-Id': sid }, { jsonrpc: '2.0', id: 2, method: 'b' }), r2, 'org');
    expect(r2._headers['Mcp-Session-Id']).toBe(sid);
    expect(transport.getStats().sessions).toBe(1);
  });

  // ── GET stream + Last-Event-ID replay ───────────────────────────────

  it('GET without Mcp-Session-Id returns 404 with UNKNOWN_SESSION', () => {
    const res = mockRes();
    transport.handleStream(mockReq({}), res, 'org');
    expect(res._statusCode).toBe(404);
    expect(res._jsonBody.payload.code).toBe(WORKER_ERROR_CODES.UNKNOWN_SESSION);
  });

  it('GET refuses cross-tenant session reuse (different org returns UNKNOWN_SESSION)', async () => {
    mcpService.handleJsonRpc.mockResolvedValue({ jsonrpc: '2.0', id: 1, result: 'ok' });
    const r1 = mockRes();
    await transport.handlePost(mockReq({}, { jsonrpc: '2.0', id: 1, method: 'ping' }), r1, 'org-a');
    const sid = r1._headers['Mcp-Session-Id'];

    const r2 = mockRes();
    transport.handleStream(mockReq({ 'Mcp-Session-Id': sid }), r2, 'org-b');
    expect(r2._statusCode).toBe(404);
  });

  it('push() writes formatted SSE frame with id+event+data and increments seq', async () => {
    mcpService.handleJsonRpc.mockResolvedValue({ jsonrpc: '2.0', id: 1, result: 'ok' });
    const r1 = mockRes();
    await transport.handlePost(mockReq({}, { jsonrpc: '2.0', id: 1, method: 'ping' }), r1, 'org');
    const sid = r1._headers['Mcp-Session-Id'];

    const r2 = mockRes();
    transport.handleStream(mockReq({ 'Mcp-Session-Id': sid }), r2, 'org');

    transport.push(sid, 'event', { hello: 'world' });
    transport.push(sid, 'event', { goodbye: 'moon' });

    const frames = parseEventFrames(r2._writes);
    expect(frames).toHaveLength(2);
    expect(frames[0].event).toBe('event');
    expect(frames[0].data.payload).toEqual({ hello: 'world' });
    expect(frames[0].data.seq).toBe(1);
    expect(frames[1].data.seq).toBe(2);
  });

  it('mid-stream disconnect + reconnect with Last-Event-ID replays missed events', async () => {
    mcpService.handleJsonRpc.mockResolvedValue({ jsonrpc: '2.0', id: 1, result: 'ok' });
    const r1 = mockRes();
    await transport.handlePost(mockReq({}, { jsonrpc: '2.0', id: 1, method: 'ping' }), r1, 'org');
    const sid = r1._headers['Mcp-Session-Id'];

    // Open stream, push two, "disconnect", push two more, reconnect with
    // Last-Event-ID set to the last seen id, expect to receive the two
    // missed events on the new stream.
    const stream1 = mockRes();
    transport.handleStream(mockReq({ 'Mcp-Session-Id': sid }), stream1, 'org');
    transport.push(sid, 'event', { n: 1 });
    transport.push(sid, 'event', { n: 2 });
    const seenFrames = parseEventFrames(stream1._writes);
    const lastSeenId = seenFrames[seenFrames.length - 1].id;

    // Simulate disconnect.
    stream1._events.emit('close');

    transport.push(sid, 'event', { n: 3 });
    transport.push(sid, 'event', { n: 4 });

    // Reconnect with Last-Event-ID.
    const stream2 = mockRes();
    transport.handleStream(mockReq({ 'Mcp-Session-Id': sid, 'Last-Event-ID': lastSeenId }), stream2, 'org');
    const replayed = parseEventFrames(stream2._writes);
    expect(replayed.map(f => f.data.payload)).toEqual([{ n: 3 }, { n: 4 }]);
  });

  it('reconnect with an aged-out Last-Event-ID emits REPLAY_UNAVAILABLE error event', async () => {
    mcpService.handleJsonRpc.mockResolvedValue({ jsonrpc: '2.0', id: 1, result: 'ok' });
    const r1 = mockRes();
    await transport.handlePost(mockReq({}, { jsonrpc: '2.0', id: 1, method: 'ping' }), r1, 'org');
    const sid = r1._headers['Mcp-Session-Id'];

    // Push an event so the buffer is non-empty.
    const stream1 = mockRes();
    transport.handleStream(mockReq({ 'Mcp-Session-Id': sid }), stream1, 'org');
    transport.push(sid, 'event', { ok: true });
    stream1._events.emit('close');

    // Reconnect with an event id we never sent.
    const stream2 = mockRes();
    transport.handleStream(mockReq({ 'Mcp-Session-Id': sid, 'Last-Event-ID': 'totally-fake-id' }), stream2, 'org');
    const frames = parseEventFrames(stream2._writes);
    expect(frames.find(f => f.event === 'error')?.data.payload.code).toBe(WORKER_ERROR_CODES.REPLAY_UNAVAILABLE);
  });
});
