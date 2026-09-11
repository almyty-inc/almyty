import { AgentNodeExecutor } from '../agent-node-executor';

/**
 * L4 gate at the node: a node names a role, the run fills it once, and the
 * node uses that model. The existing per-node model field stays valid, so
 * nothing that works today stops working.
 *
 * The point being proved is that a pinned role reaches a provider without
 * the router planning anything. `plan()` is asserted never to be called.
 */
function makeExecutor(overrides: Record<string, unknown> = {}): AgentNodeExecutor {
  const executor = Object.create(AgentNodeExecutor.prototype) as AgentNodeExecutor;
  Object.assign(executor, {
    logger: { log: jest.fn(), error: jest.fn(), warn: jest.fn() },
    templateResolver: { resolve: (t: string) => t },
    llmProvidersService: { chat: jest.fn().mockResolvedValue({ message: { role: 'assistant', content: 'ok' }, usage: {}, cost: 0, model: 'm', responseTime: 1 }) },
    defaultRoutingFor: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  });
  return executor;
}

const node = (config: Record<string, unknown>) => ({ id: 'n1', type: 'llm_call', data: config });
const context = { input: {}, nodes: {} } as never;

describe('a node fills its model from a role', () => {
  it('calls the role model through a lookup, never through the router', async () => {
    const plan = jest.fn();
    const chat = jest.fn().mockResolvedValue({ message: { role: 'assistant', content: 'ok' }, usage: {}, cost: 0, model: 'm', responseTime: 1 });
    const executor = makeExecutor({
      llmProvidersService: { chat },
      modelRouter: {
        plan,
        providerForModelId: jest.fn().mockResolvedValue({
          card: { id: 'card-1', name: 'Opus', vendorModelId: 'claude-opus-4-6' },
          provider: { id: 'prov-1' },
        }),
      },
    });

    await (executor as never as { executeLlmCallNode: Function }).executeLlmCallNode(
      node({ roleKey: 'principal', userPromptTemplate: 'hi' }),
      context,
      'org',
      'user',
      { organizationId: 'org', resolvedRoles: [{ key: 'principal', modelId: 'card-1', via: 'pinned' }] },
    );

    expect(plan).not.toHaveBeenCalled();
    // The provider came from the role, and the model on the wire is the
    // card's vendor id rather than whatever the node happened to carry.
    expect(chat).toHaveBeenCalledWith('prov-1', expect.objectContaining({ model: 'claude-opus-4-6' }), 'org', 'user');
  });

  it('still honours a node that names a providerId, with no role in sight', async () => {
    const chat = jest.fn().mockResolvedValue({ message: { role: 'assistant', content: 'ok' }, usage: {}, cost: 0, model: 'm', responseTime: 1 });
    const executor = makeExecutor({ llmProvidersService: { chat } });

    await (executor as never as { executeLlmCallNode: Function }).executeLlmCallNode(
      node({ providerId: 'prov-legacy', model: 'gpt-5', userPromptTemplate: 'hi' }),
      context,
      'org',
      'user',
      { organizationId: 'org' },
    );

    expect(chat).toHaveBeenCalledWith('prov-legacy', expect.objectContaining({ model: 'gpt-5' }), 'org', 'user');
  });

  it('refuses a node naming a role the agent does not define, and says which', async () => {
    const executor = makeExecutor({ modelRouter: { plan: jest.fn(), providerForModelId: jest.fn() } });

    await expect(
      (executor as never as { executeLlmCallNode: Function }).executeLlmCallNode(
        node({ roleKey: 'reviewer', userPromptTemplate: 'hi' }),
        context,
        'org',
        'user',
        { organizationId: 'org', resolvedRoles: [{ key: 'principal', modelId: 'card-1', via: 'pinned' }] },
      ),
    ).rejects.toThrow(/names role 'reviewer'/);
  });

  it('says so plainly when a role is named but the catalog is not available', async () => {
    const executor = makeExecutor();

    await expect(
      (executor as never as { executeLlmCallNode: Function }).executeLlmCallNode(
        node({ roleKey: 'principal', userPromptTemplate: 'hi' }),
        context,
        'org',
        'user',
        { organizationId: 'org', resolvedRoles: [{ key: 'principal', modelId: 'card-1', via: 'pinned' }] },
      ),
    ).rejects.toThrow(/model catalog is not available/);
  });
});
