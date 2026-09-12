import { OrchestratorService } from '../orchestrator.service';
import { Agent } from '../../../../entities/agent.entity';

/**
 * The orchestrator, actually called.
 *
 * The prompt, the answer reader and the fallback were all written and
 * tested before anything called them, so switching the orchestrator on
 * changed nothing at run time. Those unit tests stayed green throughout.
 * This file drives the service, and every case here is a way the decision
 * fails in the real world.
 */
describe('choosing a strategy per request', () => {
  const agent = (orchestrator?: Record<string, unknown>, strategyKey?: string): Agent =>
    ({
      id: 'a1',
      organizationId: 'org-1',
      settings: { execution: { ...(strategyKey ? { strategyKey } : {}), ...(orchestrator ? { orchestrator } : {}) } },
    }) as any;

  const on = { enabled: true, roleKey: 'orchestrator', timeoutMs: 50, fallbackStrategyKey: 'single' };

  const build = ({
    answer,
    chat,
    resolved = [{ key: 'orchestrator', modelId: 'm1' }, { key: 'principal', modelId: 'm2' }],
  }: { answer?: string; chat?: jest.Mock; resolved?: any[] } = {}) =>
    new OrchestratorService(
      { find: jest.fn().mockResolvedValue([]) } as any,
      { resolveRoles: jest.fn().mockResolvedValue(resolved) } as any,
      { providerForModelId: jest.fn().mockResolvedValue({ provider: { id: 'p1' } }) } as any,
      { chat: chat ?? jest.fn().mockResolvedValue({ message: { content: answer ?? '' } }) } as any,
    );

  it('does not decide anything for an agent that has it switched off', async () => {
    expect(await build().choose(agent(), 'hello')).toBeNull();
    expect(await build().choose(agent({ ...on, enabled: false }), 'hello')).toBeNull();
  });

  it('uses the strategy the model named', async () => {
    const choice = await build({
      answer: JSON.stringify({ strategy: 'cascade', roleBindings: { drafter: 'principal', verifier: 'principal', principal: 'principal' }, reasoning: 'cheap first' }),
    }).choose(agent(on), 'summarise this');

    expect(choice).toMatchObject({ strategyKey: 'cascade', via: 'orchestrator', reasoning: 'cheap first' });
  });

  it('falls back, with the reason, when it names a strategy nobody has', async () => {
    const choice = await build({ answer: JSON.stringify({ strategy: 'telepathy', roleBindings: {} }) }).choose(agent(on), 'x');

    expect(choice).toMatchObject({ strategyKey: 'single', via: 'fallback' });
    expect(choice?.fallbackReason).toContain('telepathy');
  });

  it('falls back when the answer is not JSON at all', async () => {
    const choice = await build({ answer: 'I think cascade would be nice' }).choose(agent(on), 'x');
    expect(choice?.via).toBe('fallback');
    expect(choice?.fallbackReason).toBeTruthy();
  });

  it('falls back when it takes longer than its budget, rather than holding up the run', async () => {
    const slow = jest.fn(() => new Promise(() => {}));
    const choice = await build({ chat: slow as any }).choose(agent(on), 'x');

    expect(choice).toMatchObject({ strategyKey: 'single', via: 'fallback' });
    expect(choice?.fallbackReason).toContain('50ms');
  });

  it('falls back when the deciding role does not exist on this agent', async () => {
    const choice = await build({ resolved: [{ key: 'principal', modelId: 'm2' }] }).choose(agent(on), 'x');
    expect(choice?.via).toBe('fallback');
    expect(choice?.fallbackReason).toContain('orchestrator');
  });

  it('falls back when the model cannot be reached at all', async () => {
    const service = new OrchestratorService(
      { find: jest.fn().mockResolvedValue([]) } as any,
      { resolveRoles: jest.fn().mockRejectedValue(new Error('no provider for m1')) } as any,
      { providerForModelId: jest.fn() } as any,
      { chat: jest.fn() } as any,
    );
    const choice = await service.choose(agent(on), 'x');
    expect(choice).toMatchObject({ strategyKey: 'single', via: 'fallback' });
    expect(choice?.fallbackReason).toContain('no provider');
  });

  it('honours an allowed list, refusing a shape outside it', async () => {
    const choice = await build({ answer: JSON.stringify({ strategy: 'panel', roleBindings: {} }) }).choose(
      agent({ ...on, allowedStrategyKeys: ['single', 'cascade'] }),
      'x',
    );
    expect(choice?.via).toBe('fallback');
    expect(choice?.fallbackReason).toMatch(/allowed/);
  });

  it('never leaves a run without a shape, whatever happens', async () => {
    const choice = await build({ chat: jest.fn().mockRejectedValue(new Error('boom')) as any }).choose(agent(on), 'x');
    expect(choice?.strategyKey).toBe('single');
  });
});
