import { Runner, RunnerState } from '../../entities/runner.entity';
import { RunnerSession } from '../../entities/runner-session.entity';
import { Workspace } from '../../entities/workspace.entity';
import { fakeRepository } from '../../test/fake-repository';
import { RunnerService } from './runner.service';
import { RunnerOnlineHooks } from './runner-online.hooks';
import { runtimeInfoProblem } from './runner-runtime-info';

const VALID = {
  os: 'linux', arch: 'x64', hostname: 'hr-ws-1', cpuCount: 1, memoryMb: 2048, runnerVersion: '1.5.6',
  binaries: { git: 'git version 2.47.0', docker: null },
  codingAgents: [{ id: 'aider', displayName: 'Aider', binary: 'aider', resolvedBinary: 'aider', version: 'aider 0.86.2', providerFamily: 'multi', supportsMcp: false, canManage: true }],
};

describe('runtimeInfoProblem', () => {
  it('accepts what a runner probes', () => {
    expect(runtimeInfoProblem(VALID)).toBeNull();
  });

  it.each([
    ['nothing', undefined],
    ['an array', []],
    ['no os', { ...VALID, os: undefined }],
    ['a version that is not a string', { ...VALID, binaries: { git: 2 } }],
    ['binaries as an array', { ...VALID, binaries: ['git'] }],
    ['a coding agent missing its fields', { ...VALID, codingAgents: [{ id: 'x' }] }],
    ['too many binaries', { ...VALID, binaries: Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`b${i}`, null])) }],
  ])('refuses %s', (_label, raw) => {
    expect(runtimeInfoProblem(raw)).not.toBeNull();
  });
});

describe('RunnerService: runtime reports and coming online', () => {
  function setup() {
    const runners = fakeRepository<Runner>({ idPrefix: 'r' });
    const hooks = new RunnerOnlineHooks();
    const online: string[] = [];
    hooks.on((id) => { online.push(id); });
    const service = new RunnerService(
      runners as any,
      fakeRepository<RunnerSession>({ idPrefix: 's' }) as any,
      fakeRepository<Workspace>({ idPrefix: 'w' }) as any,
      {} as any,
      {} as any,
      undefined,
      hooks,
    );
    runners.seed({ id: 'r-1', organizationId: 'org-1', kind: 'hosted', state: RunnerState.REGISTERED, lastHeartbeatAt: null, runtimeInfo: { ...VALID, binaries: {}, codingAgents: [] } } as any);
    return { runners, service, online };
  }
  const flush = () => new Promise((r) => setImmediate(r));

  it('stores a valid runtime report and drops an invalid one', async () => {
    const { runners, service } = setup();
    expect(await service.updateRuntimeInfo('r-1', VALID)).toBe(true);
    expect(runners.row('r-1')!.runtimeInfo).toEqual(VALID);
    expect(await service.updateRuntimeInfo('r-1', { ...VALID, binaries: { git: 2 } })).toBe(false);
    expect(runners.row('r-1')!.runtimeInfo).toEqual(VALID);
  });

  it('announces the first heartbeat, and a return from stale, but not every beat', async () => {
    const { runners, service, online } = setup();
    await service.heartbeat('r-1');
    await flush();
    expect(online).toEqual(['r-1']);
    await service.heartbeat('r-1');
    await flush();
    expect(online).toEqual(['r-1']);
    await runners.update({ id: 'r-1' }, { state: RunnerState.STALE });
    await service.heartbeat('r-1');
    await flush();
    expect(online).toEqual(['r-1', 'r-1']);
  });

  it('a listener that throws does not fail the heartbeat', async () => {
    const { service } = setup();
    const hooks = (service as any).onlineHooks as RunnerOnlineHooks;
    hooks.on(() => { throw new Error('listener down'); });
    await expect(service.heartbeat('r-1')).resolves.toMatchObject({ state: RunnerState.ONLINE });
    await flush();
  });
});
