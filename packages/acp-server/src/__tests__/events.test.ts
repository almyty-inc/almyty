import { describe, it, expect } from 'vitest';
import { mapStreamEvent, buildPlanFromPipeline, isTerminalEvent, extractFinalOutput } from '../events.js';

describe('mapStreamEvent', () => {
  it('maps node.started to tool_call with running status', () => {
    const results = mapStreamEvent({ event: 'node.started', data: { nodeId: 'n1', nodeType: 'tool_call', name: 'get_users' } });
    expect(results.length).toBeGreaterThan(0);
    const tc = results.find(r => r.type === 'tool_call');
    expect(tc).toBeDefined();
    expect((tc as any).status).toBe('running');
  });

  it('maps node.completed to tool_call_update', () => {
    const results = mapStreamEvent({ event: 'node.completed', data: { nodeId: 'n1', output: { users: [] } } });
    expect(results.length).toBeGreaterThan(0);
    const update = results.find(r => r.type === 'tool_call_update');
    expect(update).toBeDefined();
    expect((update as any).status).toBe('completed');
  });

  it('maps node.error to tool_call_update with error', () => {
    const results = mapStreamEvent({ event: 'node.error', data: { nodeId: 'n1', error: 'timeout' } });
    expect(results.length).toBeGreaterThan(0);
    const update = results.find(r => r.type === 'tool_call_update');
    expect(update).toBeDefined();
    expect((update as any).status).toBe('error');
  });

  it('maps text events to agent_message_chunk', () => {
    for (const event of ['text', 'message', 'chunk', 'token']) {
      const results = mapStreamEvent({ event, data: { text: 'hello' } });
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].type).toBe('agent_message_chunk');
    }
  });

  it('maps thinking events to agent_thought_chunk', () => {
    const results = mapStreamEvent({ event: 'thinking', data: { text: 'hmm' } });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].type).toBe('agent_thought_chunk');
  });

  it('returns empty array for unknown events', () => {
    expect(mapStreamEvent({ event: 'unknown_xyz', data: {} })).toHaveLength(0);
  });
});

describe('buildPlanFromPipeline', () => {
  it('converts pipeline nodes to plan entries (filters input/output)', () => {
    const nodes = [
      { id: 'n1', type: 'input', data: {} },
      { id: 'n2', type: 'llm_call', data: {} },
      { id: 'n3', type: 'tool_call', data: { toolName: 'fetch' } },
      { id: 'n4', type: 'output', data: {} },
    ];
    const plan = buildPlanFromPipeline(nodes as any);
    expect(plan.type).toBe('plan');
    // input + output filtered out, llm_call + tool_call remain
    expect(plan.entries.length).toBe(2);
  });

  it('returns empty plan for empty pipeline', () => {
    const plan = buildPlanFromPipeline([]);
    expect(plan.entries).toHaveLength(0);
  });
});

describe('isTerminalEvent', () => {
  it('recognizes terminal events', () => {
    expect(isTerminalEvent({ event: 'execution.completed', data: {} })).toBe(true);
    expect(isTerminalEvent({ event: 'execution.error', data: {} })).toBe(true);
    expect(isTerminalEvent({ event: 'run.completed', data: {} })).toBe(true);
  });

  it('rejects non-terminal events', () => {
    expect(isTerminalEvent({ event: 'text', data: {} })).toBe(false);
    expect(isTerminalEvent({ event: 'node.started', data: {} })).toBe(false);
  });
});

describe('extractFinalOutput', () => {
  it('extracts text from output', () => {
    expect(extractFinalOutput({ event: 'execution.completed', data: { output: 'result' } })).toBe('result');
  });

  it('stringifies object output', () => {
    const result = extractFinalOutput({ event: 'execution.completed', data: { output: { key: 'val' } } });
    expect(result).toContain('key');
  });

  it('returns undefined for missing output', () => {
    expect(extractFinalOutput({ event: 'execution.completed', data: {} })).toBeUndefined();
  });
});
