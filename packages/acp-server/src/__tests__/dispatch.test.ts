/**
 * Unit tests for the stdio line dispatcher.
 *
 * The behaviour under test is the one readline makes easy to get wrong:
 * every line already sitting in the stdin pipe is delivered in a single
 * synchronous burst, so the lazy agent resolution has to be guarded by the
 * in-flight promise rather than by the settled value.
 */
import { describe, it, expect, vi } from 'vitest';
import { createLineHandler, type MessageHandler } from '../dispatch.js';
import type { JsonRpcRequest } from '../agent.js';

/** A stand-in agent that records everything it is handed. */
class RecordingAgent implements MessageHandler {
  readonly seen: JsonRpcRequest[] = [];

  async handleMessage(msg: JsonRpcRequest): Promise<void> {
    this.seen.push(msg);
  }
}

const req = (id: number | null, method: string): string =>
  JSON.stringify(id === null ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', id, method });

describe('createLineHandler', () => {
  it('resolves the agent once for a burst of lines and shares it', async () => {
    const agents: RecordingAgent[] = [];
    const resolveAgent = vi.fn(async () => {
      // A real resolution is at least one HTTP round-trip away.
      await new Promise((r) => setTimeout(r, 10));
      const agent = new RecordingAgent();
      agents.push(agent);
      return agent;
    });

    const handleLine = createLineHandler({ resolveAgent, send: vi.fn() });

    // readline delivers a buffered burst synchronously, one call per line,
    // without awaiting any of them.
    await Promise.all([
      handleLine(req(1, 'initialize')),
      handleLine(req(2, 'session/new')),
      handleLine(req(3, 'session/list')),
    ]);

    expect(resolveAgent).toHaveBeenCalledTimes(1);
    expect(agents).toHaveLength(1);
    expect(agents[0].seen.map((m) => m.id)).toEqual(expect.arrayContaining([1, 2, 3]));
    expect(agents[0].seen).toHaveLength(3);
  });

  it('reuses the resolved agent for later lines', async () => {
    const agent = new RecordingAgent();
    const resolveAgent = vi.fn(async () => agent);
    const handleLine = createLineHandler({ resolveAgent, send: vi.fn() });

    await handleLine(req(1, 'initialize'));
    await handleLine(req(2, 'session/new'));

    expect(resolveAgent).toHaveBeenCalledTimes(1);
    expect(agent.seen).toHaveLength(2);
  });

  it('answers every line of a burst when resolution fails, and retries later', async () => {
    const send = vi.fn();
    const resolveAgent = vi
      .fn()
      .mockRejectedValueOnce(new Error('No auth token. Run: npx @almyty/auth login'))
      .mockResolvedValueOnce(new RecordingAgent());

    const handleLine = createLineHandler({ resolveAgent, send });

    await Promise.all([handleLine(req(1, 'initialize')), handleLine(req(2, 'session/new'))]);

    expect(resolveAgent).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(2);
    for (const [msg] of send.mock.calls) {
      expect(msg.error.code).toBe(-32603);
      expect(msg.error.message).toBe('No auth token. Run: npx @almyty/auth login');
    }
    expect(send.mock.calls.map(([m]) => m.id)).toEqual([1, 2]);

    // The failed memo is cleared, so a later message tries again.
    send.mockClear();
    await handleLine(req(3, 'initialize'));
    expect(resolveAgent).toHaveBeenCalledTimes(2);
    expect(send).not.toHaveBeenCalled();
  });

  it('ignores blank lines without resolving an agent', async () => {
    const resolveAgent = vi.fn(async () => new RecordingAgent());
    const send = vi.fn();
    const handleLine = createLineHandler({ resolveAgent, send });

    await handleLine('');
    await handleLine('   \t ');

    expect(resolveAgent).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('answers unparseable input with a parse error and no agent resolution', async () => {
    const resolveAgent = vi.fn(async () => new RecordingAgent());
    const send = vi.fn();
    const handleLine = createLineHandler({ resolveAgent, send });

    await handleLine('{not json');

    expect(resolveAgent).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'Parse error' },
    });
  });

  it('rejects a malformed envelope that still carries an id', async () => {
    const send = vi.fn();
    const handleLine = createLineHandler({ resolveAgent: vi.fn(), send });

    await handleLine(JSON.stringify({ jsonrpc: '1.0', id: 7, method: 'initialize' }));
    await handleLine(JSON.stringify({ jsonrpc: '2.0', id: 8 })); // no method

    expect(send.mock.calls.map(([m]) => m)).toEqual([
      { jsonrpc: '2.0', id: 7, error: { code: -32600, message: 'Invalid request' } },
      { jsonrpc: '2.0', id: 8, error: { code: -32600, message: 'Invalid request' } },
    ]);
  });

  it('stays silent for a malformed notification', async () => {
    const send = vi.fn();
    const handleLine = createLineHandler({ resolveAgent: vi.fn(), send });

    await handleLine(JSON.stringify({ jsonrpc: '2.0' }));

    expect(send).not.toHaveBeenCalled();
  });

  it('turns a thrown handler into an internal error for requests only', async () => {
    const send = vi.fn();
    const log = vi.fn();
    const agent: MessageHandler = {
      handleMessage: vi.fn(async () => {
        throw new Error('boom');
      }),
    };
    const handleLine = createLineHandler({ resolveAgent: async () => agent, send, log });

    await handleLine(req(9, 'session/new'));
    expect(send).toHaveBeenCalledWith({
      jsonrpc: '2.0',
      id: 9,
      error: { code: -32603, message: 'Internal error' },
    });

    send.mockClear();
    await handleLine(req(null, 'session/cancel')); // notification: no id
    expect(send).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(2);
  });
});
