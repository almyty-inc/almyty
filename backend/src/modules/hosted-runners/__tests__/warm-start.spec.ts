import { HostedRunnersProcessor } from '../hosted-runners.processor';
import { HostedAdapterRegistry } from '../adapters/adapter.registry';
import { StubHostedAdapter } from '../adapters/stub.adapter';
import { DEFAULT_HOSTED_RUNNER_SETTINGS, HostedRunnerSettingsService } from '../hosted-runner-settings';
import { fakeRepository } from '../../../test/fake-repository';
import { HostedRunner } from '../../../entities/hosted-runner.entity';
import { Workspace, WorkspaceStatus } from '../../../entities/workspace.entity';
import { Runner, RunnerState } from '../../../entities/runner.entity';
import { RunnerSession } from '../../../entities/runner-session.entity';
import { Environment } from '../../../entities/environment.entity';
import { RunnerService } from '../../runner/runner.service';
import { RunnerOnlineHooks } from '../../runner/runner-online.hooks';

const ORG = '22222222-2222-4222-8222-222222222222';
const HR = '11111111-1111-4111-8111-111111111111';
const WS = '44444444-4444-4444-8444-444444444444';
const RUNNER = '55555555-5555-4555-8555-555555555555';
const ENV = '33333333-3333-4333-8333-333333333333';

const flush = () => new Promise((r) => setImmediate(r));

/**
 * Warm start: a woken machine is ready on its runner's first heartbeat.
 * Before, only the reconcile sweep (every minute) noticed the runner was
 * online, so a pod whose runner had enrolled and heartbeated stayed
 * "provisioning" to every caller until the next sweep: ~15 s on staging,
 * up to 60 s. The heartbeat now announces the runner coming online and the
 * reconcile loop listens.
 */
describe('hosted runner warm start: ready on the first heartbeat', () => {
  let stub: StubHostedAdapter;
  let processor: HostedRunnersProcessor;
  let runnerService: RunnerService;
  let hostedRunners: ReturnType<typeof fakeRepository<HostedRunner>>;
  let runners: ReturnType<typeof fakeRepository<Runner>>;
  let enqueued: string[];
  const settings = new HostedRunnerSettingsService({ ...DEFAULT_HOSTED_RUNNER_SETTINGS, apiUrl: 'https://api.almyty.test' }, { HOSTED_RUNNERS_ENABLED: 'true' });

  beforeEach(async () => {
    stub = new StubHostedAdapter();
    const registry = new HostedAdapterRegistry();
    registry.register(stub);
    hostedRunners = fakeRepository<HostedRunner>({ idPrefix: 'hr' });
    const workspaces = fakeRepository<Workspace>({ idPrefix: 'ws' });
    runners = fakeRepository<Runner>({ idPrefix: 'r' });
    const environments = fakeRepository<Environment>({ idPrefix: 'env' });
    const sessions = fakeRepository<RunnerSession>({ idPrefix: 's' });
    const hooks = new RunnerOnlineHooks();
    enqueued = [];
    // The real queue runs the reconcile job at once; so does this one.
    const service = {
      clusterCredentialsFor: jest.fn(async () => ({})),
      resolveSecretEnv: jest.fn(async () => ({})),
      audit: jest.fn(),
      enqueue: jest.fn(async (id: string) => {
        enqueued.push(id);
        await processor.reconcile(id);
      }),
    };
    processor = new HostedRunnersProcessor(
      { add: jest.fn(), getRepeatableJobs: jest.fn(async () => []) } as any,
      hostedRunners as any,
      environments as any,
      workspaces as any,
      runners as any,
      registry,
      service as any,
      { mint: jest.fn(async () => 'token-1') } as any,
      { open: jest.fn(async () => undefined), close: jest.fn(async () => 0) } as any,
      settings,
      undefined,
      hooks,
    );
    processor.onModuleInit();
    runnerService = new RunnerService(runners as any, sessions as any, workspaces as any, {} as any, {} as any, undefined, hooks);

    environments.seed({ id: ENV, organizationId: ORG, name: 'app', version: 1, image: { base: 'standard', ref: 'almyty/runner-env:standard' }, egress: { allowHosts: [] }, cache: { paths: [] }, envBindings: [], repo: null, setupScript: null, resourceClass: 'small', idleTimeoutMinutes: 15, deletedAt: null } as any);
    runners.seed({ id: RUNNER, organizationId: ORG, kind: 'hosted', hostedRunnerId: HR, state: RunnerState.REGISTERED, lastHeartbeatAt: null } as any);
    workspaces.seed({ id: WS, organizationId: ORG, runnerId: RUNNER, kind: 'persistent', environmentId: ENV, status: WorkspaceStatus.SUSPENDED, agentId: null, volumeRef: null } as any);
    hostedRunners.seed({
      id: HR, organizationId: ORG, environmentId: ENV, environmentVersion: 1, workspaceId: WS, runnerId: RUNNER,
      providerType: 'stub', desired: { replicas: 1, resourceClass: 'small' }, providerConfig: {}, externalRef: { stubId: HR, volume: `ws-${WS}` }, actual: null,
      state: 'provisioning', lastActiveAt: new Date(), lastReconcileAt: null, lastError: null,
    } as any);
    // The machine's objects exist, scaled to zero: a warm wake.
    await stub.provision({ hostedRunnerId: HR, workspaceId: WS } as any, {});
  });

  it('marks the machine ready on its runner\'s first heartbeat, with no sweep', async () => {
    // Woken: the pod is scaled up and Ready; its runner enrolled, not yet heartbeated.
    await processor.reconcile(HR);
    expect(stub.pods.get(HR)).toMatchObject({ replicas: 1 });
    await processor.reconcile(HR);
    expect((hostedRunners.row(HR) as HostedRunner).state).toBe('provisioning');

    await runnerService.heartbeat(RUNNER);
    await flush();
    await flush();

    expect(enqueued).toEqual([HR]);
    expect((hostedRunners.row(HR) as HostedRunner).state).toBe('ready');
  });

  it('does not reconcile again on later heartbeats of a runner already online', async () => {
    await processor.reconcile(HR);
    await runnerService.heartbeat(RUNNER);
    await flush();
    await flush();
    expect(enqueued).toEqual([HR]);
    await runnerService.heartbeat(RUNNER);
    await flush();
    await flush();
    expect(enqueued).toEqual([HR]);
  });

  it('leaves a machine nobody wants up to the sweep', async () => {
    await hostedRunners.update({ id: HR }, { desired: { replicas: 0, resourceClass: 'small' } } as any);
    await processor.onRunnerOnline(RUNNER);
    expect(enqueued).toEqual([]);
  });
});
