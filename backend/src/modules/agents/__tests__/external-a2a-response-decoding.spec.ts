import { AgentSubAgentExecutors } from '../agent-subagent-executors.helper';

/**
 * The response extractor filtered parts with `p.type === 'text'`. That
 * discriminator only ever existed in the v0.1.x draft: v0.2/v0.3 use `kind`,
 * and v1.0 removed the discriminator entirely in favour of which member of
 * the `content` oneof is set. So no released A2A version matched, every
 * remote agent's answer was thrown away, and the node's output was the raw
 * JSON-RPC envelope object instead of the text the agent replied with.
 */
describe('external A2A sub-agent responses are decoded, not dropped', () => {
  const build = (rpcResponse: any) => {
    const executors = Object.create(
      AgentSubAgentExecutors.prototype,
    ) as AgentSubAgentExecutors;

    (executors as any).externalAgentsService = {
      findById: async () => ({ id: 'ext-1', name: 'remote', url: 'https://remote.example/a2a' }),
    };
    (executors as any).a2aClientService = {
      sendMessage: async () => rpcResponse,
    };

    return executors;
  };

  const node = { id: 'n1', type: 'sub_agent' } as any;
  const options = { organizationId: 'org-1', userId: 'user-1' } as any;

  const run = (rpcResponse: any) =>
    build(rpcResponse).executeExternalA2ASubAgent(
      node,
      'ext-1',
      { text: 'ping' },
      options,
      Date.now(),
    );

  it('reads a v1.0 status message, where presence of `text` is the discriminator', async () => {
    const result = await run({
      result: { status: { message: { parts: [{ text: 'the answer' }] } } },
    });
    expect(result.output).toBe('the answer');
  });

  it('reads a v0.2/v0.3 status message, which discriminates on `kind`', async () => {
    const result = await run({
      result: { status: { message: { parts: [{ kind: 'text', text: 'the answer' }] } } },
    });
    expect(result.output).toBe('the answer');
  });

  it('reads the v0.1.x draft shape too, so older peers keep working', async () => {
    const result = await run({
      result: { status: { message: { parts: [{ type: 'text', text: 'the answer' }] } } },
    });
    expect(result.output).toBe('the answer');
  });

  it('flattens artifact parts across artifacts', async () => {
    const result = await run({
      result: {
        artifacts: [
          { parts: [{ text: 'first' }] },
          { parts: [{ kind: 'text', text: 'second' }] },
        ],
      },
    });
    expect(result.output).toBe('first\nsecond');
  });

  it('never hands the raw JSON-RPC envelope to the next node', async () => {
    const result = await run({
      result: { status: { message: { parts: [{ text: 'the answer' }] } } },
    });
    expect(typeof result.output).toBe('string');
    expect(result.output).not.toHaveProperty('result');
  });

  it('still surfaces a JSON-RPC error as a thrown error', async () => {
    await expect(run({ error: { code: -32603, message: 'remote exploded' } })).rejects.toThrow(
      /remote exploded/,
    );
  });
});
