import { agentEnvironmentId, capabilityProblems, normaliseCapabilities } from '../agent-capabilities';

/**
 * An agent's machine is a hosted environment (agentConfig.environmentId)
 * or the runners its owner runs (runnerId / runnerLabels), never both: a
 * call cannot go to two places.
 */
describe('agentConfig.environmentId', () => {
  const ENV = '6f1c2a3b-4d5e-4f60-8a9b-0c1d2e3f4a5b';
  const RUNNER = '7a1c2a3b-4d5e-4f60-8a9b-0c1d2e3f4a5b';

  it('is read as the environment its runner-backed tools run on', () => {
    expect(agentEnvironmentId({ agentConfig: { environmentId: ENV } } as any)).toBe(ENV);
    expect(agentEnvironmentId({ agentConfig: {} } as any)).toBeNull();
    expect(agentEnvironmentId({ agentConfig: { environmentId: '' } } as any)).toBeNull();
  });

  it('must be an environment id', () => {
    expect(capabilityProblems({ environmentId: 'my-env' })).toContain('The environment it runs on must be an environment id');
    expect(capabilityProblems({ environmentId: ENV })).toEqual([]);
  });

  it('is refused together with a pinned runner or machine labels', () => {
    const both = 'An agent runs on a hosted environment or on your own machines, not both: clear the runner and machine labels, or the environment';
    expect(capabilityProblems({ environmentId: ENV, runnerId: RUNNER })).toContain(both);
    expect(capabilityProblems({ environmentId: ENV, runnerLabels: { gpu: 'yes' } })).toContain(both);
    expect(capabilityProblems({ environmentId: ENV, runnerLabels: 'gpu=yes' })).toContain(both);
    expect(capabilityProblems({ environmentId: ENV, runnerLabels: {} })).toEqual([]);
  });

  it('is cleared, not stored, when empty', () => {
    const cfg: any = { environmentId: '' };
    normaliseCapabilities(cfg);
    expect('environmentId' in cfg).toBe(false);
  });
});
