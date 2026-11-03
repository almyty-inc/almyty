/**
 * An autonomous answer streams to the ACP client as it is written: each
 * `llm.chunk` of the answering call goes out as an `agent_message_chunk`
 * the moment it arrives, not the whole answer at the end. The working (a
 * step that goes on to call tools) goes out as thought, never as answer,
 * and the answer is not sent twice when the run's final output lands.
 */
import { describe, it, expect } from 'vitest';

import { AlmytyAcpAgent } from '../agent.js';
import { autonomousTextStream, isTerminalEvent, mapStreamEvent, type SessionUpdatePayload } from '../events.js';
import type { StreamEvent } from '../proxy.js';

/** A runtime event as the run stream sends it: the event whole, with its place. */
const ev = (type: string, data: Record<string, unknown>, pos = '1-0'): StreamEvent => ({
  event: type,
  data: { type, data, timestamp: 't', pos },
});

const RUN_EVENTS: StreamEvent[] = [
  ev('llm.started', { step: 0, answer: false }),
  ev('llm.chunk', { step: 0, content: 'Looking up the order' }),
  ev('llm.response', { step: 0, content: 'Looking up the order', toolCalls: [{ id: 't1', name: 'orders' }] }),
  ev('tool.started', { step: 0, toolCallId: 't1', tool: 'orders' }),
  ev('llm.started', { step: 1, answer: true }),
  ev('llm.chunk', { step: 1, content: 'Your order' }),
  ev('llm.chunk', { step: 1, content: ' ships Monday.' }),
  ev('llm.response', { step: 1, content: 'Your order ships Monday.' }),
  ev('run.completed', { output: 'Your order ships Monday.' }),
];

function harness(events: StreamEvent[]) {
  const log: string[] = [];
  const sent: any[] = [];
  const proxy: any = {
    getAgent: async () => ({ id: 'a1', name: 'Orders', mode: 'autonomous', status: 'active' }),
    startRun: async () => ({ id: 'r1', status: 'running', conversationId: 'c1' }),
    getRun: async () => ({ id: 'r1', status: 'completed', output: 'Your order ships Monday.' }),
    cancelRun: async () => undefined,
    async *streamRun() {
      for (const event of events) {
        log.push(`yield ${event.event}`);
        yield event;
      }
    },
  };
  const agent = new AlmytyAcpAgent(proxy, 'a1', (msg: any) => {
    sent.push(msg);
    const update = msg?.params?.update;
    if (update?.sessionUpdate) log.push(`${update.sessionUpdate}|${update.content?.text ?? ''}`);
  });
  const call = async (id: number, method: string, params: Record<string, unknown> = {}) => {
    await agent.handleMessage({ jsonrpc: '2.0', id, method, params } as any);
    return sent.find((m) => m.id === id);
  };
  return { log, sent, call };
}

describe('ACP: an autonomous answer streams as it is written', () => {
  it('sends each answer chunk as it arrives, before the run ends, and the working as thought', async () => {
    const h = harness(RUN_EVENTS);
    await h.call(1, 'initialize', { protocolVersion: 1, clientCapabilities: {} });
    const session = await h.call(2, 'session/new', { cwd: '/tmp' });
    const reply = await h.call(3, 'session/prompt', {
      sessionId: session.result.sessionId,
      prompt: [{ type: 'text', text: 'Where is my order?' }],
    });

    const answerChunks = h.log.filter((l) => l.startsWith('agent_message_chunk'));
    expect(answerChunks).toEqual(['agent_message_chunk|Your order', 'agent_message_chunk| ships Monday.']);
    // Each chunk went out right after the event that carried it, ahead of the run's end.
    const firstChunk = h.log.indexOf('agent_message_chunk|Your order');
    expect(firstChunk).toBeGreaterThan(-1);
    expect(firstChunk).toBeLessThan(h.log.indexOf('yield run.completed'));
    expect(h.log[firstChunk - 1]).toBe('yield llm.chunk');
    // The working is thought, never the answer.
    expect(h.log).toContain('agent_thought_chunk|Looking up the order');
    expect(answerChunks.join('')).not.toContain('Looking up');
    // The prompt answers with the answer, once.
    expect(reply.result.content).toEqual([{ type: 'text', text: 'Your order ships Monday.' }]);
  });

  it('a step the provider never classifies goes out whole when its response lands', () => {
    const text = autonomousTextStream();
    const out: SessionUpdatePayload[] = [];
    for (const event of [
      ev('llm.chunk', { step: 0, content: 'Your order ' }),
      ev('llm.chunk', { step: 0, content: 'ships Monday.' }),
      ev('llm.response', { step: 0, content: 'Your order ships Monday.' }),
    ]) {
      out.push(...(text.map(event) ?? []));
    }
    expect(out).toEqual([{ type: 'agent_message_chunk', text: 'Your order ships Monday.' }]);
    expect(text.answer()).toBe('Your order ships Monday.');
  });

  it('held chunks follow the provider’s verdict: text streams as answer, tool as thought', () => {
    const text = autonomousTextStream();
    const map = (event: StreamEvent) => text.map(event) ?? [];
    expect(map(ev('llm.chunk', { step: 0, content: 'Checking ' }))).toEqual([]);
    expect(map(ev('llm.step_kind', { step: 0, kind: 'tool' }))).toEqual([{ type: 'agent_thought_chunk', text: 'Checking ' }]);
    expect(map(ev('llm.chunk', { step: 1, content: 'Your order' }))).toEqual([]);
    expect(map(ev('llm.step_kind', { step: 1, kind: 'text' }))).toEqual([{ type: 'agent_message_chunk', text: 'Your order' }]);
    expect(map(ev('llm.chunk', { step: 1, content: ' ships.' }))).toEqual([{ type: 'agent_message_chunk', text: ' ships.' }]);
    // The response adds only what the stream did not carry.
    expect(map(ev('llm.response', { step: 1, content: 'Your order ships. Monday.' }))).toEqual([
      { type: 'agent_message_chunk', text: ' Monday.' },
    ]);
    // Anything that is not model output is the caller's to map.
    expect(text.map(ev('tool.started', { tool: 'orders' }))).toBeNull();
  });

  it('the rest of the final output that did not stream goes out at the end, and nothing twice', async () => {
    const h = harness([
      ev('llm.started', { step: 0, answer: true }),
      ev('llm.chunk', { step: 0, content: 'Your order' }),
      ev('run.completed', { output: { text: 'Your order ships Monday.' } }),
    ]);
    await h.call(1, 'initialize', { protocolVersion: 1, clientCapabilities: {} });
    const session = await h.call(2, 'session/new', { cwd: '/tmp' });
    const reply = await h.call(3, 'session/prompt', { sessionId: session.result.sessionId, prompt: [{ type: 'text', text: 'Hi' }] });
    expect(h.log.filter((l) => l.startsWith('agent_message_chunk'))).toEqual([
      'agent_message_chunk|Your order',
      'agent_message_chunk| ships Monday.',
    ]);
    expect(reply.result.content).toEqual([{ type: 'text', text: 'Your order ships Monday.' }]);
  });
});

describe('ACP: an autonomous run’s tool calls reach the editor', () => {
  it('reads each event’s own fields from under `data`, as the run stream sends them', () => {
    expect(mapStreamEvent(ev('tool.started', { step: 0, toolCallId: 't1', tool: 'search_orders' }))).toEqual([
      { type: 'tool_call', toolCallId: 't1', title: 'search_orders', kind: 'search', status: 'running', rawInput: undefined },
    ]);
    expect(mapStreamEvent(ev('tool.result', { step: 0, toolCallId: 't1', tool: 'search_orders', success: true, executionTime: 40 }))).toEqual([
      { type: 'tool_call_update', toolCallId: 't1', status: 'completed', content: undefined },
    ]);
    expect(mapStreamEvent(ev('tool.result', { step: 0, toolCallId: 't2', tool: 'refund', success: false, error: 'Card declined' }))).toEqual([
      { type: 'tool_call_update', toolCallId: 't2', status: 'error', error: 'Card declined' },
    ]);
  });

  it('a failed run says why, and ends the turn', () => {
    const failed = ev('run.failed', { error: 'Provider unavailable' });
    expect(mapStreamEvent(failed)).toEqual([{ type: 'agent_message_chunk', text: 'Error: Provider unavailable' }]);
    expect(isTerminalEvent(failed)).toBe(true);
  });

  it('an event with no envelope (a workflow stream) is read as it is', () => {
    const plain: StreamEvent = { event: 'node.started', data: { nodeId: 'n1', nodeType: 'llm_call', label: 'Draft', data: { nested: true } } };
    expect(mapStreamEvent(plain)).toEqual([
      { type: 'tool_call', toolCallId: 'n1', title: 'Draft', kind: 'think', status: 'running', rawInput: undefined },
    ]);
  });

  it('the editor sees the tool call start and finish during a prompt', async () => {
    const h = harness([
      ev('tool.started', { step: 0, toolCallId: 't1', tool: 'search_orders' }),
      ev('tool.result', { step: 0, toolCallId: 't1', tool: 'search_orders', success: true }),
      ...RUN_EVENTS.slice(4),
    ]);
    await h.call(1, 'initialize', { protocolVersion: 1, clientCapabilities: {} });
    const session = await h.call(2, 'session/new', { cwd: '/tmp' });
    await h.call(3, 'session/prompt', { sessionId: session.result.sessionId, prompt: [{ type: 'text', text: 'Where is my order?' }] });
    const updates = h.sent.map((m) => m?.params?.update).filter(Boolean);
    expect(updates).toContainEqual(expect.objectContaining({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'search_orders', status: 'running' }));
    expect(updates).toContainEqual(expect.objectContaining({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' }));
  });
});
