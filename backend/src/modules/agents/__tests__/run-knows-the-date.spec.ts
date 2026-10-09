/**
 * An agent asked for "today's meetings" or to "follow up after three days
 * without a reply" has to know what day it is. The model does not: its
 * system prompt has to say so, on every step, as of that step.
 */
import { AgentRuntimeBuilders, describeNow } from '../agent-runtime-builders';

describe('a run is told the current date and time', () => {
  const builders = new AgentRuntimeBuilders({ find: jest.fn(async () => []) } as any, { listActiveRules: jest.fn(async () => []) } as any);
  const agent: any = { id: 'a1', instructions: 'Write the morning brief.', agentConfig: {}, memoryConfig: {} };
  const run: any = { id: 'r1', organizationId: 'org-1' };

  afterEach(() => jest.useRealTimers());

  it('describes the moment with its weekday, in UTC', () => {
    expect(describeNow(new Date('2026-10-08T07:05:00Z'))).toBe('It is Thursday, 2026-10-08, 07:05 UTC (2026-10-08T07:05:00.000Z).');
  });

  it('puts it in the system prompt, after the instructions', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-12T06:30:00Z'), doNotFake: ['nextTick', 'setImmediate'] });

    const [system] = await builders.buildMessages(agent, run, [], '');

    expect(system.role).toBe('system');
    expect(system.content).toContain('[CURRENT TIME]\nIt is Monday, 2026-10-12, 06:30 UTC');
    expect(system.content.indexOf('[INSTRUCTIONS]')).toBeLessThan(system.content.indexOf('[CURRENT TIME]'));
  });
});
