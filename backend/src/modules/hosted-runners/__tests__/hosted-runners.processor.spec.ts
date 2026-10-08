import { HostedRunnersProcessor } from '../hosted-runners.processor';
import { HostedAdapterRegistry } from '../adapters/adapter.registry';
import { StubHostedAdapter } from '../adapters/stub.adapter';
import { DEFAULT_HOSTED_RUNNER_SETTINGS, HostedRunnerSettingsService } from '../hosted-runner-settings';
import { fakeRepository } from '../../../test/fake-repository';
import { HostedRunner } from '../../../entities/hosted-runner.entity';
import { Workspace, WorkspaceStatus } from '../../../entities/workspace.entity';
import { Runner, RunnerState } from '../../../entities/runner.entity';
import { Environment } from '../../../entities/environment.entity';
import { AuditAction } from '../../../entities/audit-log.entity';

const ORG = '22222222-2222-4222-8222-222222222222';
const HR = '11111111-1111-4111-8111-111111111111';
const WS = '44444444-4444-4444-8444-444444444444';
const RUNNER = '55555555-5555-4555-8555-555555555555';
const ENV = '33333333-3333-4333-8333-333333333333';

/**
 * The reconcile loop against the stub adapter: every row of the
 * desired/actual table, the claim lease, three strikes to failed, the
 * orphan grace, and what it writes to the workspace, the runner and the
 * usage record on the way.
 */
describe('hosted runner reconcile loop (stub adapter)', () => {
  let stub: StubHostedAdapter;
  let processor: HostedRunnersProcessor;
  let hostedRunners: ReturnType<typeof fakeRepository<HostedRunner>> & { createQueryBuilder?: any };
  let workspaces: ReturnType<typeof fakeRepository<Workspace>>;
  let runners: ReturnType<typeof fakeRepository<Runner>>;
  let environments: ReturnType<typeof fakeRepository<Environment>>;
  let usage: { open: jest.Mock; close: jest.Mock };
  let service: Record<string, jest.Mock>;
  let minted: number;

  const settings = new HostedRunnerSettingsService({ ...DEFAULT_HOSTED_RUNNER_SETTINGS, apiUrl: 'https://api.almyty.test' }, { HOSTED_RUNNERS_ENABLED: 'true' });

  /** The claim's UPDATE ... WHERE, evaluated over the fake table's own rows. */
  function claimBuilder() {
    let patch: any;
    const clauses: Array<{ sql: string; params: any }> = [];
    const qb: any = {
      update: () => qb,
      set: (v: any) => { patch = v; return qb; },
      where: (sql: string, params: any = {}) => { clauses.push({ sql, params }); return qb; },
      andWhere: (sql: string, params: any = {}) => { clauses.push({ sql, params }); return qb; },
      execute: async () => {
        const p = Object.assign({}, ...clauses.map((c) => c.params));
        const row = hostedRunners.row(p.id) as any;
        if (!row) return { affected: 0 };
        const free = row.externalRef === null
          && (row.state !== p.provisioning || row.lastReconcileAt === null || row.lastReconcileAt < p.stale);
        if (clauses.map((c) => c.sql).join(' AND ') !== 'id = :id AND "externalRef" IS NULL AND (state <> :provisioning OR "lastReconcileAt" IS NULL OR "lastReconcileAt" < :stale)') {
          throw new Error('claim clauses changed: model them here');
        }
        if (!free) return { affected: 0 };
        await hostedRunners.update({ id: p.id }, patch);
        return { affected: 1 };
      },
    };
    return qb;
  }

  beforeEach(() => {
    stub = new StubHostedAdapter();
    const registry = new HostedAdapterRegistry();
    registry.register(stub);
    hostedRunners = fakeRepository<HostedRunner>({ idPrefix: 'hr' }) as any;
    hostedRunners.createQueryBuilder = jest.fn(() => claimBuilder());
    workspaces = fakeRepository<Workspace>({ idPrefix: 'ws' });
    runners = fakeRepository<Runner>({ idPrefix: 'r' });
    environments = fakeRepository<Environment>({ idPrefix: 'env' });
    usage = { open: jest.fn(async () => undefined), close: jest.fn(async () => 0) };
    minted = 0;
    service = {
      clusterCredentialsFor: jest.fn(async () => ({})),
      resolveSecretEnv: jest.fn(async () => ({ NPM_TOKEN: 'bound-value' })),
      capacityFor: jest.fn(async () => ({ maxConcurrentRunners: 2, maxWorkspaces: 10, resourceClasses: null })),
      audit: jest.fn(),
      suspendIdle: jest.fn(async () => []),
      sweepSuspended: jest.fn(async () => ({ noticed: 0, expired: 0 })),
    };
    const enrollment = { mint: jest.fn(async () => `token-${++minted}`) };
    processor = new HostedRunnersProcessor(
      { add: jest.fn(), getRepeatableJobs: jest.fn(async () => []) } as any,
      hostedRunners as any,
      environments as any,
      workspaces as any,
      runners as any,
      registry,
      service as any,
      enrollment as any,
      usage as any,
      settings,
    );

    environments.seed({ id: ENV, organizationId: ORG, name: 'app', version: 1, image: { base: 'standard', ref: 'almyty/runner-env:standard' }, egress: { allowHosts: ['github.com'] }, cache: { paths: [] }, envBindings: [], repo: { url: 'https://github.com/acme/app', ref: 'main', connectionId: null }, setupScript: 'npm ci', resourceClass: 'small', idleTimeoutMinutes: 15, deletedAt: null } as any);
    runners.seed({ id: RUNNER, organizationId: ORG, kind: 'hosted', hostedRunnerId: HR, state: RunnerState.REGISTERED, lastHeartbeatAt: null } as any);
    workspaces.seed({ id: WS, organizationId: ORG, runnerId: RUNNER, kind: 'persistent', environmentId: ENV, status: WorkspaceStatus.SUSPENDED, agentId: null, volumeRef: null } as any);
    hostedRunners.seed({
      id: HR, organizationId: ORG, environmentId: ENV, environmentVersion: 1, workspaceId: WS, runnerId: RUNNER,
      providerType: 'stub', desired: { replicas: 0, resourceClass: 'small' }, providerConfig: {}, externalRef: null, actual: null,
      state: 'pending', lastActiveAt: new Date(), lastReconcileAt: null, lastError: null,
    } as any);
  });

  const row = () => hostedRunners.row(HR) as HostedRunner;
  const want = async (replicas: 0 | 1, extra: Record<string, any> = {}) => hostedRunners.update({ id: HR }, { desired: { ...row().desired, replicas, ...extra } });
  const runnerOnline = () => runners.update({ id: RUNNER }, { state: RunnerState.ONLINE, lastHeartbeatAt: new Date() });

  it('provisions a row that was never provisioned, and with nothing wanted parks it', async () => {
    await processor.reconcile(HR);
    expect(stub.calls).toEqual([`provision:${HR}`, `read:${HR}`, `clear:${HR}`]);
    expect(row()).toMatchObject({ state: 'suspended', externalRef: { stubId: HR }, environmentVersion: 1 });
    expect(workspaces.row(WS)!.volumeRef).toEqual({ name: `ws-${WS}`, sizeGi: 10, provider: 'stub' });
    // What the adapter got: plain settings only, sized from the class, egress incl. the API and the repo host.
    const request = stub.pods.get(HR)!.request;
    expect(request.resources).toMatchObject({ name: 'small', cpu: '1', memory: '2Gi', volumeGi: 10 });
    expect(request.egressHosts.sort()).toEqual(['api.almyty.test', 'github.com']);
    expect(request.secretEnv).toEqual({});
    expect(JSON.stringify(request.env)).not.toMatch(/token-|bound-value/);
  });

  it('wakes with a fresh token and resolved variables in the Secret, then goes ready once the runner is online', async () => {
    await processor.reconcile(HR);
    await want(1);
    await processor.reconcile(HR);
    expect(stub.pods.get(HR)).toMatchObject({ replicas: 1, secretEnv: { ALMYTY_ENROLLMENT_TOKEN: 'token-1', NPM_TOKEN: 'bound-value' } });
    expect(row().state).toBe('provisioning');
    expect(usage.open).not.toHaveBeenCalled();

    // The pod is up but its runner has not enrolled and heartbeated yet.
    await processor.reconcile(HR);
    expect(row().state).toBe('provisioning');
    expect(minted).toBe(1);

    await runnerOnline();
    await processor.reconcile(HR);
    expect(row().state).toBe('ready');
    expect(usage.open).toHaveBeenCalledTimes(1);
    expect(workspaces.row(WS)!.status).toBe(WorkspaceStatus.ACTIVE);
    expect(service.audit).toHaveBeenCalledWith(expect.anything(), AuditAction.WORKSPACE_RESUMED, null, { workspaceId: WS });
  });

  it('idle -> suspended -> resumed on the same volume, closing and reopening usage', async () => {
    await processor.reconcile(HR);
    await want(1);
    await processor.reconcile(HR);
    await runnerOnline();
    await processor.reconcile(HR);
    expect(row().state).toBe('ready');

    await want(0);
    await processor.reconcile(HR);
    expect(row().state).toBe('suspending');
    await processor.reconcile(HR);
    expect(row().state).toBe('suspended');
    expect(usage.close).toHaveBeenCalled();
    expect(workspaces.row(WS)!.status).toBe(WorkspaceStatus.SUSPENDED);
    expect(runners.row(RUNNER)!.state).toBe(RunnerState.OFFLINE);
    // The volume is kept; nothing secret stays in the cluster between wakes.
    expect(stub.pods.get(HR)).toMatchObject({ volume: true, secretEnv: null, replicas: 0 });

    await want(1);
    await processor.reconcile(HR);
    expect(stub.calls.filter((c) => c.startsWith('provision')).length).toBe(1);
    expect(stub.pods.get(HR)!.secretEnv!.ALMYTY_ENROLLMENT_TOKEN).toBe('token-2');
    await runnerOnline();
    await processor.reconcile(HR);
    expect(row().state).toBe('ready');
    expect(workspaces.row(WS)!.status).toBe(WorkspaceStatus.ACTIVE);
    expect(usage.open).toHaveBeenCalledTimes(2);
  });

  it('applies a newer environment version only while there is no pod', async () => {
    await processor.reconcile(HR);
    await environments.update({ id: ENV }, { version: 2, setupScript: 'pnpm i' });
    await want(1);
    await processor.reconcile(HR);
    expect(stub.calls.filter((c) => c.startsWith('provision')).length).toBe(2);
    expect(row().environmentVersion).toBe(2);
    expect(stub.pods.get(HR)!.request.env.ALMYTY_SETUP_SCRIPT).toBe('pnpm i');
  });

  it('restarts a pod that has not enrolled within the wait, with a new token', async () => {
    await processor.reconcile(HR);
    await want(1);
    await processor.reconcile(HR);
    const issued = new Date(Date.now() - settings.minutes(settings.current.reconcile.enrollWaitMinutes) - 1000).toISOString();
    await hostedRunners.update({ id: HR }, { actual: { ...row().actual, enrollIssuedAt: issued } });
    await processor.reconcile(HR);
    expect(stub.pods.get(HR)!.replicas).toBe(0);
    await processor.reconcile(HR);
    expect(stub.pods.get(HR)).toMatchObject({ replicas: 1, secretEnv: { ALMYTY_ENROLLMENT_TOKEN: 'token-2' } });
  });

  it('tears down, deleting the volume, and a finished row is left alone', async () => {
    await processor.reconcile(HR);
    await want(0, { teardownRequested: true, keepVolume: false });
    await processor.reconcile(HR);
    expect(stub.calls).toContain(`teardown:${HR}:delete`);
    expect(row()).toMatchObject({ state: 'torn_down', externalRef: null, desired: { teardownRequested: false } });
    expect(usage.close).toHaveBeenCalled();
    const calls = stub.calls.length;
    await processor.reconcile(HR);
    expect(stub.calls.length).toBe(calls);
  });

  it('tears down when its workspace was released, whatever desired says', async () => {
    await processor.reconcile(HR);
    await workspaces.update({ id: WS }, { status: WorkspaceStatus.RELEASED });
    await processor.reconcile(HR);
    expect(row().state).toBe('torn_down');
  });

  it('provisions once when two ticks race for the same row (the claim)', async () => {
    await Promise.all([processor.reconcile(HR), processor.reconcile(HR)]);
    expect(stub.calls.filter((c) => c.startsWith('provision')).length).toBe(1);
  });

  it('takes over a claim whose lease ran out', async () => {
    const stale = new Date(Date.now() - settings.minutes(settings.current.reconcile.claimLeaseMinutes) - 1000);
    await hostedRunners.update({ id: HR }, { state: 'provisioning', lastReconcileAt: stale });
    await processor.reconcile(HR);
    expect(stub.calls).toContain(`provision:${HR}`);
  });

  it('keeps reading through transient errors and fails on the third in a row', async () => {
    await processor.reconcile(HR);
    stub.failNext = ['read', 'read', 'read'];
    await processor.reconcile(HR);
    expect(row()).toMatchObject({ state: 'suspended', actual: expect.objectContaining({ consecutiveErrors: 1 }) });
    await processor.reconcile(HR);
    expect(row().actual!.consecutiveErrors).toBe(2);
    await processor.reconcile(HR);
    expect(row()).toMatchObject({ state: 'failed', lastError: 'stub read failed' });
  });

  it('fails at once when the cluster connection itself is unusable', async () => {
    service.clusterCredentialsFor.mockRejectedValueOnce(Object.assign(new Error('HOSTED_RUNNERS_CLUSTER_CONNECTION is not set'), { code: 'CREDENTIAL_NOT_FOUND' }));
    await processor.reconcile(HR);
    expect(row()).toMatchObject({ state: 'failed', lastError: 'HOSTED_RUNNERS_CLUSTER_CONNECTION is not set' });
  });

  it('orphans a machine the cluster lost, after the grace, and releases its workspace with the reason', async () => {
    await processor.reconcile(HR);
    stub.forget(HR);
    await processor.reconcile(HR);
    expect(row().state).toBe('suspended');
    expect(row().actual!.missingSince).toBeTruthy();
    const old = new Date(Date.now() - settings.minutes(settings.current.reconcile.orphanGraceMinutes) - 1000).toISOString();
    await hostedRunners.update({ id: HR }, { actual: { ...row().actual, missingSince: old } });
    await processor.reconcile(HR);
    expect(row().state).toBe('orphaned');
    expect(workspaces.row(WS)).toMatchObject({ status: WorkspaceStatus.RELEASED, closeReason: { kind: 'released', detail: 'its volume no longer exists in the cluster' } });
  });

  it('runs the idle and retention checks on every sweep, and nothing while switched off', async () => {
    await processor.handleSweep();
    expect(service.suspendIdle).toHaveBeenCalledTimes(1);
    expect(service.sweepSuspended).toHaveBeenCalledTimes(1);
    expect(stub.calls).toContain(`provision:${HR}`);

    const off = new HostedRunnersProcessor({} as any, hostedRunners as any, environments as any, workspaces as any, runners as any, new HostedAdapterRegistry(), service as any, {} as any, usage as any, new HostedRunnerSettingsService(DEFAULT_HOSTED_RUNNER_SETTINGS, {}));
    expect(await off.handleSweep()).toEqual({ reconciled: 0 });
    expect(service.suspendIdle).toHaveBeenCalledTimes(1);
  });
});
