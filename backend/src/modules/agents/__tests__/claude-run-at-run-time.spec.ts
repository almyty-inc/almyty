import { AgentRunStatus } from '../../../entities/agent-run.entity';
import { anthropicText, runAgent } from './autonomous-harness';

jest.mock('../../llm-providers/providers/safe-request', () => ({
  ...jest.requireActual('../../llm-providers/providers/safe-request'),
  callLlmProviderHttpStream: jest.fn(),
}));

/**
 * An autonomous run on a Claude model, end to end with only the socket
 * faked, for the three faults a model comparison on staging found
 * (2026-11-13):
 *
 * - the main role named no output limit and Claude calls went out at 1024
 *   tokens, which the model spent before it answered;
 * - such a run was marked completed with an empty answer, and not checked;
 * - earlier tool calls went back as plain text, so the model repeated them.
 */

const MODEL = 'claude-sonnet-5';
// The main role names no output limit: its model card decides.
const MAIN = { key: 'main', name: 'Main', purpose: 'main', kind: 'model', providerId: 'p-strong', model: MODEL } as const;
const single = { strategy: 'single', roles: [MAIN] } as any;
const modelConfig = { providerId: 'p-strong', model: MODEL };
const CARD = { [MODEL]: 64_000 };

const ev = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify({ type: event, ...(data as object) })}\n\n`;

/** A reply that spent its output on thinking and stopped at the limit: no text at all. */
const cutOff = (output: number) => [
  ev('message_start', { message: { model: MODEL, usage: { input_tokens: 900 } } }),
  ev('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '' } }),
  ev('content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: 'sig-cut' } }),
  ev('content_block_stop', { index: 0 }),
  ev('message_delta', { delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: output } }),
  ev('message_stop', {}),
];

/** A reply that thinks, then calls two tools at once. */
const twoCalls = () => [
  ev('message_start', { message: { model: MODEL, usage: { input_tokens: 400 } } }),
  ev('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '' } }),
  ev('content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: 'sig-1' } }),
  ev('content_block_stop', { index: 0 }),
  ev('content_block_start', { index: 1, content_block: { type: 'tool_use', id: 'toolu_recall', name: 'recall_memory', input: {} } }),
  ev('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '{"query":"order 4411"}' } }),
  ev('content_block_stop', { index: 1 }),
  ev('content_block_start', { index: 2, content_block: { type: 'tool_use', id: 'toolu_store', name: 'store_memory', input: {} } }),
  ev('content_block_delta', { index: 2, delta: { type: 'input_json_delta', partial_json: '{"content":"Dana asked about order 4411"}' } }),
  ev('content_block_stop', { index: 2 }),
  ev('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 60 } }),
  ev('message_stop', {}),
];

const memoryAccounts = () => ({
  put: jest.fn(async () => ({ id: 'mem-1' })),
  search: jest.fn(async () => []),
});

describe('an autonomous run on Claude', () => {
  it("asks with the model card's output limit, not 1024", async () => {
    const seen = await runAgent({
      models: single,
      modelConfig,
      cards: CARD,
      streams: { [MODEL]: [anthropicText(MODEL, 100, ['Order 4411 ships Monday.'], 8)] },
    });
    expect(seen.run.status).toBe(AgentRunStatus.COMPLETED);
    expect(seen.bodies[0].body.max_tokens).toBe(64_000);
  });

  it('a reply cut off at its output limit is not the answer: the model is asked again and the run completes with the real answer', async () => {
    const seen = await runAgent({
      models: single,
      modelConfig,
      cards: CARD,
      streams: { [MODEL]: [cutOff(64_000), anthropicText(MODEL, 950, ['Order 4411 ships Monday.'], 8)] },
    });

    expect(seen.leftover).toEqual({});
    expect(seen.run.status).toBe(AgentRunStatus.COMPLETED);
    expect(seen.run.output).toBe('Order 4411 ships Monday.');
    const noAnswer = seen.run.steps.find((s: any) => s.output?.status === 'no_answer');
    expect(noAnswer.output).toMatchObject({
      reason: 'the model stopped at its output limit before answering',
      finishReason: 'max_tokens',
      retried: true,
    });
    // The second call tells the model its reply reached nobody.
    const last = seen.bodies[1].body.messages.at(-1);
    expect(JSON.stringify(last)).toContain('reached the output limit before it was finished');
  });

  it('a run that never answers fails with the reason, and is neither completed nor checked', async () => {
    const seen = await runAgent({
      models: single,
      modelConfig,
      cards: CARD,
      agent: { agentConfig: { verify: { enabled: true, checkers: [{ providerId: 'p-cheap', model: 'o4-mini' }] } } },
      streams: { [MODEL]: [cutOff(2_000), cutOff(2_000), cutOff(2_000)] },
    });

    expect(seen.leftover).toEqual({});
    expect(seen.run.status).toBe(AgentRunStatus.FAILED);
    expect(seen.run.error).toBe('No answer: the model stopped at its output limit before answering.');
    expect(seen.run.output ?? null).toBeNull();
    expect(seen.run.metadata.noAnswer).toEqual({ code: 'NO_ANSWER_OUTPUT_LIMIT', reason: 'the model stopped at its output limit before answering', retries: 2 });
    expect(seen.run.steps.filter((s: any) => s.output?.status === 'no_answer')).toHaveLength(3);
    expect(seen.run.steps.some((s: any) => s.type === 'verify')).toBe(false);
    expect(seen.events.find((e: any) => e.type === 'run.failed')?.data).toMatchObject({ reasonCode: 'NO_ANSWER_OUTPUT_LIMIT' });
  });

  it("is not asked again past the run's own limits: it fails with the no-answer reason, not a limit trip", async () => {
    const seen = await runAgent({
      models: single,
      modelConfig,
      cards: CARD,
      limits: { maxTokens: 3_000 },
      streams: { [MODEL]: [cutOff(2_000), cutOff(2_000)] },
    });

    expect(seen.leftover).toEqual({});
    expect(seen.run.status).toBe(AgentRunStatus.FAILED);
    expect(seen.run.error).toBe('No answer: the model stopped at its output limit before answering.');
    expect(seen.run.metadata.noAnswer.retries).toBe(1);
  });

  it('an empty reply is asked again too, with its own reason', async () => {
    const seen = await runAgent({
      models: single,
      modelConfig,
      cards: CARD,
      streams: { [MODEL]: [anthropicText(MODEL, 100, [''], 0), anthropicText(MODEL, 120, ['Order 4411 ships Monday.'], 8)] },
    });
    expect(seen.run.status).toBe(AgentRunStatus.COMPLETED);
    expect(seen.run.steps.find((s: any) => s.output?.status === 'no_answer').output.reason).toBe('the model returned an empty answer');
  });

  it('sends both calls of a turn, its thinking first, and their results back as structured blocks', async () => {
    const seen = await runAgent({
      models: single,
      modelConfig,
      cards: CARD,
      agent: { memoryConfig: { enabled: true, whose: 'agent', save: 'asked' } },
      memoryAccounts: memoryAccounts(),
      streams: { [MODEL]: [twoCalls(), anthropicText(MODEL, 700, ['Order 4411 ships Monday.'], 8)] },
    });

    expect(seen.leftover).toEqual({});
    expect(seen.run.status).toBe(AgentRunStatus.COMPLETED);
    const messages = seen.bodies[1].body.messages;
    const turn = messages.findIndex((m: any) => m.role === 'assistant' && Array.isArray(m.content) && m.content.some((b: any) => b.type === 'tool_use'));
    expect(messages[turn].content).toEqual([
      { type: 'thinking', thinking: '', signature: 'sig-1' },
      { type: 'tool_use', id: 'toolu_recall', name: 'recall_memory', input: { query: 'order 4411' } },
      { type: 'tool_use', id: 'toolu_store', name: 'store_memory', input: { content: 'Dana asked about order 4411' } },
    ]);
    const results = messages[turn + 1];
    expect(results.role).toBe('user');
    expect(results.content.map((b: any) => [b.type, b.tool_use_id])).toEqual([
      ['tool_result', 'toolu_recall'],
      ['tool_result', 'toolu_store'],
    ]);
  });
});
