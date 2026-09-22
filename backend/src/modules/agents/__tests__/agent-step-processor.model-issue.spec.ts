import { AgentStepProcessor } from '../agent-step-processor';
import { ModelNotFoundError } from '../../llm-providers/model-errors';

/**
 * flagModelIssue is the autonomous-runtime twin of the scheduler's
 * pauseForBrokenModel: it only writes a note, never changes run flow.
 */
describe('AgentStepProcessor.flagModelIssue', () => {
  const call = (ctx: any, agent: any, err: unknown) =>
    (AgentStepProcessor.prototype as any).flagModelIssue.call(ctx, agent, err);

  it('records the retired model, provider, and vendor wording on the agent', async () => {
    const update = jest.fn().mockResolvedValue(undefined);
    const ctx = { s: { agentRepository: { update }, logger: { warn: jest.fn() } } };
    const agent: any = { id: 'a1', settings: { maxExecutionTime: 5 }, modelConfig: { providerId: 'p-cfg', model: 'cfg-model' } };
    const err = Object.assign(new Error('LLM call failed'), {
      cause: new ModelNotFoundError('claude-sonnet-4-20250514', 'p1', 'anthropic', 'model: claude-sonnet-4-20250514'),
    });

    await call(ctx, agent, err);

    expect(update).toHaveBeenCalledWith({ id: 'a1' }, {
      settings: expect.objectContaining({
        maxExecutionTime: 5,
        modelIssue: expect.objectContaining({ code: 'MODEL_NOT_FOUND', model: 'claude-sonnet-4-20250514', providerId: 'p1' }),
      }),
    });
    expect(agent.settings.modelIssue.detectedAt).toEqual(expect.any(String));
  });

  it('falls back to the agent model config when the error carries no details', async () => {
    const update = jest.fn().mockResolvedValue(undefined);
    const ctx = { s: { agentRepository: { update }, logger: { warn: jest.fn() } } };
    const agent = { id: 'a1', settings: null, modelConfig: { providerId: 'p-cfg', model: 'cfg-model' } };

    await call(ctx, agent, Object.assign(new Error('gone'), { code: 'MODEL_NOT_FOUND' }));

    expect(update.mock.calls[0][1].settings.modelIssue).toMatchObject({ model: 'cfg-model', providerId: 'p-cfg', message: 'gone' });
  });

  it('never throws: a failed write is logged and swallowed', async () => {
    const warn = jest.fn();
    const ctx = { s: { agentRepository: { update: jest.fn().mockRejectedValue(new Error('db down')) }, logger: { warn } } };

    await expect(call(ctx, { id: 'a1', settings: {} }, new ModelNotFoundError('m', 'p', 't'))).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('db down'));
  });
});
