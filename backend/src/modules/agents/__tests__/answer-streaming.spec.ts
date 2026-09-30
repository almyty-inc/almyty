import { streamableAnswerNode } from '../answer-node';
import { CompatAgentInvoker } from '../compat-agent-invoker.service';

/**
 * Which pipelines stream their answer token by token, and what the compat
 * invoker does when the stream and the finished answer disagree. The SDK
 * specs (openai-sdk-compat, anthropic-sdk-compat) drive the common shapes
 * end to end; these pin the edges of the rule.
 */
describe('streamableAnswerNode', () => {
  const pos = { x: 0, y: 0 };
  const pipeline = (over: { llm?: Record<string, any>; out?: Record<string, any>; extraNodes?: any[]; extraEdges?: any[] } = {}) => ({
    nodes: [
      { id: 'in', type: 'input', position: pos, data: {} },
      { id: 'llm', type: 'llm_call', position: pos, data: { providerId: 'p1', userPromptTemplate: '{{input.message}}', ...over.llm } },
      { id: 'out', type: 'output', position: pos, data: { mapping: '{{nodes.llm.output}}', ...over.out } },
      ...(over.extraNodes ?? []),
    ],
    edges: [
      { id: 'e1', source: 'in', target: 'llm' },
      { id: 'e2', source: 'llm', target: 'out' },
      ...(over.extraEdges ?? []),
    ],
  });

  it('names the llm_call whose text the output node returns unchanged', () => {
    expect(streamableAnswerNode(pipeline())).toBe('llm');
    expect(streamableAnswerNode(pipeline({ out: { mapping: '  {{nodes.llm.output}} ' } }))).toBe('llm');
  });

  it('reads the node config from `config` as well as `data`, as the executor does', () => {
    const p = pipeline();
    (p.nodes[2] as any).config = p.nodes[2].data;
    delete (p.nodes[2] as any).data;
    expect(streamableAnswerNode(p)).toBe('llm');
  });

  it.each([
    ['the output wraps the text', { out: { mapping: 'Answer: {{nodes.llm.output}}' } }],
    ['the output picks a field', { out: { mapping: '{{nodes.llm.output.summary}}' } }],
    ['the output has no mapping (it returns every node output)', { out: { mapping: undefined } }],
    ['the model call offers tools', { llm: { toolIds: ['t1'] } }],
    ['the model call is routed', { llm: { providerId: undefined, routing: { strategy: 'cheapest' } } }],
    [
      'something else also feeds the output node',
      { extraNodes: [{ id: 'x', type: 'transform', position: pos, data: {} }], extraEdges: [{ id: 'e3', source: 'x', target: 'out' }] },
    ],
    ['a loop could run the call more than once', { extraNodes: [{ id: 'loop', type: 'loop', position: pos, data: {} }] }],
  ])('streams nothing when %s', (_why, over) => {
    expect(streamableAnswerNode(pipeline(over as any))).toBeNull();
  });

  it('streams nothing when the node feeding the output is not a model call, or there is no single output', () => {
    const viaTransform = {
      nodes: [
        { id: 'in', type: 'input', data: {} },
        { id: 't', type: 'transform', data: {} },
        { id: 'out', type: 'output', data: { mapping: '{{nodes.t.output}}' } },
      ],
      edges: [
        { id: 'e1', source: 'in', target: 't' },
        { id: 'e2', source: 't', target: 'out' },
      ],
    };
    expect(streamableAnswerNode(viaTransform as any)).toBeNull();
    const two = pipeline({ extraNodes: [{ id: 'out2', type: 'output', position: pos, data: {} }] });
    expect(streamableAnswerNode(two)).toBeNull();
    expect(streamableAnswerNode(undefined)).toBeNull();
  });
});

describe('CompatAgentInvoker, streaming a workflow answer', () => {
  const agent: any = { id: 'a1', mode: 'workflow', pipeline: {} };
  const apiKey: any = { organizationId: 'org-1', userId: 'u1' };

  /** An engine that streams `chunks` as the answer and then finishes with `output`. */
  const engine = (chunks: string[], output: string) => ({
    execute: jest.fn(async (_agent: any, _org: string, _user: string, options: any, onEvent?: (e: any) => void) => {
      if (options.streamAnswer) for (const content of chunks) onEvent?.({ type: 'answer.chunk', data: { content }, timestamp: 0 });
      return { id: 'e1', status: 'completed', output, totalTokens: 3, inputTokens: 2, outputTokens: 1 };
    }),
  });

  it('asks the engine to stream only when the caller streams', async () => {
    const e = engine([], 'x');
    const invoker = new CompatAgentInvoker(e as any);
    await invoker.invoke(agent, {}, apiKey, { protocol: 'openai_compat' });
    await invoker.invoke(agent, {}, apiKey, { protocol: 'openai_compat', onDelta: () => undefined });
    expect(e.execute.mock.calls.map((c) => c[3].streamAnswer)).toEqual([false, true]);
  });

  it('sends what the stream did not carry once the run finishes', async () => {
    const deltas: string[] = [];
    const outcome = await new CompatAgentInvoker(engine(['Hel'], 'Hello') as any).invoke(agent, {}, apiKey, {
      protocol: 'openai_compat',
      onDelta: (d) => deltas.push(d),
    });
    expect(outcome).toMatchObject({ ok: true, content: 'Hello' });
    expect(deltas).toEqual(['Hel', 'lo']);
  });

  it('sends a whole answer in one piece when nothing streamed', async () => {
    const deltas: string[] = [];
    await new CompatAgentInvoker(engine([], 'Hello') as any).invoke(agent, {}, apiKey, {
      protocol: 'openai_compat',
      onDelta: (d) => deltas.push(d),
    });
    expect(deltas).toEqual(['Hello']);
  });

  it('fails, rather than ending on a wrong answer, when the finished answer does not start with what was streamed', async () => {
    const deltas: string[] = [];
    const outcome = await new CompatAgentInvoker(engine(['Goodbye'], 'Hello') as any).invoke(agent, {}, apiKey, {
      protocol: 'anthropic_messages',
      onDelta: (d) => deltas.push(d),
    });
    expect(outcome).toMatchObject({ ok: false, failure: 'answer_superseded' });
    expect(deltas).toEqual(['Goodbye']);
  });
});
