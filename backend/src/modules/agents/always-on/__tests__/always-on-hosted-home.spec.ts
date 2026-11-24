import { agentEnvironmentId } from '../../agent-capabilities';
import { activeHostedHome, mergeAlwaysOn, readAlwaysOn } from '../always-on.types';
import { planCapacity } from '../always-on-capacity';
import { HostedRunnersService } from '../../../hosted-runners/hosted-runners.service';
import { DEFAULT_HOSTED_RUNNER_SETTINGS, HostedRunnerSettingsService } from '../../../hosted-runners/hosted-runner-settings';
import { AGENT, ORG, OWNER, alwaysOnAgent, world } from './always-on.harness';

/**
 * Always on with a hosted home (design phase 3, `alwaysOn.home.environmentId`):
 * chosen on the agent's Always on settings, it is where its runner tools go
 * while it is on, and every call there works in the agent's own persistent
 * workspace, so what one wake writes the next one reads.
 */
const ENV = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_ENV = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const VISITOR = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

describe('a hosted home in the settings', () => {
  it('is taken from the request, checked as an environment id, and can be cleared', () => {
    const base = readAlwaysOn(alwaysOnAgent().alwaysOn);
    expect(mergeAlwaysOn(base, { home: { environmentId: ENV } }).home).toEqual({ environmentId: ENV });
    expect(mergeAlwaysOn({ ...base!, home: { environmentId: ENV } }, { home: null }).home).toBeNull();
    expect(() => mergeAlwaysOn(base, { home: { environmentId: 'not-an-id' } })).toThrow('Choose the hosted environment it lives on.');
  });

  it('is where its runner tools go while it is on; off, its tools go where they are set to', () => {
    const agent = { agentConfig: { environmentId: OTHER_ENV }, alwaysOn: { enabled: true, brief: 'x', wakeOn: {}, home: { environmentId: ENV } } } as any;
    expect(agentEnvironmentId(agent)).toBe(ENV);
    expect(agentEnvironmentId({ ...agent, alwaysOn: { ...agent.alwaysOn, enabled: false } })).toBe(OTHER_ENV);
    expect(agentEnvironmentId({ agentConfig: {}, alwaysOn: agent.alwaysOn } as any)).toBe(ENV);
    expect(activeHostedHome(null)).toBeNull();
  });
});

describe('choosing a hosted home on the Always on page', () => {
  function withEnvironments(w: ReturnType<typeof world>, ids: string[]) {
    (w.agents as any).manager = {
      getRepository: () => ({ count: async ({ where }: any) => (where.organizationId === ORG && ids.includes(where.id) ? 1 : 0) }),
    };
    return w;
  }

  it('saves one of the organization\'s environments, and refuses anything else', async () => {
    const w = withEnvironments(world({ plan: 'business' }), [ENV]);
    await w.service.configure(AGENT, ORG, { home: { environmentId: ENV } });
    expect(w.agents.row(AGENT)!.alwaysOn.home).toEqual({ environmentId: ENV });
    await expect(w.service.configure(AGENT, ORG, { home: { environmentId: OTHER_ENV } })).rejects.toThrow(
      "Choose one of your organization's hosted environments as its home.",
    );
    expect(w.agents.row(AGENT)!.alwaysOn.home).toEqual({ environmentId: ENV });
  });

  it('counts toward the plan: giving an agent that is already on a home past what the plan includes is refused', async () => {
    const limit = planCapacity('pro').includedAgents as number;
    const w = withEnvironments(world({ plan: 'pro' }), [ENV]);
    for (let i = 1; i <= limit; i++) {
      w.agents.seed(alwaysOnAgent({ id: `0000000${i}-0000-4000-8000-00000000000${i}`, name: `Agent ${i}` }, { home: { environmentId: ENV }, enabledAt: new Date(0).toISOString() }));
    }
    await expect(w.service.configure(AGENT, ORG, { home: { environmentId: ENV } })).rejects.toThrow(/always-on agent/);
    expect(w.agents.row(AGENT)!.alwaysOn.home ?? null).toBeNull();
  });
});

describe('the agent\'s own workspace at its home', () => {
  const settings = new HostedRunnerSettingsService(DEFAULT_HOSTED_RUNNER_SETTINGS, { HOSTED_RUNNERS_ENABLED: 'true' });

  function hosted(agentRow: any) {
    const env = { id: ENV, organizationId: ORG, visibility: 'org', ownerUserId: OWNER };
    const workspaces: any[] = [];
    const matches = (row: any, where: any) =>
      Object.entries(where).every(([k, v]: [string, any]) => {
        if (v && typeof v === 'object' && v._type === 'isNull') return row[k] === null;
        if (v && typeof v === 'object' && v._type === 'in') return v._value.includes(row[k]);
        return row[k] === v;
      });
    const workspaceRepo: any = {
      findOne: jest.fn(async ({ where }: any) => workspaces.find((w) => matches(w, where)) ?? null),
      count: jest.fn(async () => workspaces.length),
      manager: { getRepository: () => ({ findOne: async ({ where }: any) => (where.id === agentRow.id && where.organizationId === ORG ? agentRow : null) }) },
    };
    const hostedRunnerRepo: any = { findOne: jest.fn(async ({ where }: any) => ({ id: `hr-${where.workspaceId}`, workspaceId: where.workspaceId, state: 'suspended', desired: { replicas: 0 } })) };
    const service = new HostedRunnersService(
      hostedRunnerRepo,
      { findOne: async () => env } as any,
      workspaceRepo,
      {} as any,
      { add: jest.fn() } as any,
      {} as any,
      settings,
      { canAccess: async () => ({ allowed: true }) } as any,
    );
    jest.spyOn(service as any, 'createPersistent').mockImplementation(async (_env: any, ownerUserId: any, agentId: any) => {
      const workspace = { id: `ws-${workspaces.length + 1}`, environmentId: ENV, ownerUserId, agentId, kind: 'persistent', readOnly: false, status: 'suspended' };
      workspaces.push(workspace);
      return { workspace, hostedRunner: { id: `hr-${workspace.id}` } };
    });
    return { service, workspaces };
  }

  const homeAgent = (enabled = true) => ({ id: AGENT, organizationId: ORG, createdBy: OWNER, alwaysOn: { enabled, brief: 'x', wakeOn: {}, home: { environmentId: ENV } } });

  it("Monday's wake and Tuesday's work in the same workspace, the agent's own, held by its owner", async () => {
    const { service, workspaces } = hosted(homeAgent());
    const monday = await service.workspaceFor(ENV, { organizationId: ORG, callerUserId: OWNER, agentId: AGENT, runId: 'run-monday' });
    const tuesday = await service.workspaceFor(ENV, { organizationId: ORG, callerUserId: OWNER, agentId: AGENT, runId: 'run-tuesday' });
    expect(tuesday.workspace.id).toBe(monday.workspace.id);
    expect(workspaces).toHaveLength(1);
    expect(monday.workspace).toMatchObject({ agentId: AGENT, ownerUserId: OWNER });
  });

  it('is the same workspace when someone else runs the agent', async () => {
    const { service, workspaces } = hosted(homeAgent());
    const own = await service.workspaceFor(ENV, { organizationId: ORG, callerUserId: OWNER, agentId: AGENT });
    const theirs = await service.workspaceFor(ENV, { organizationId: ORG, callerUserId: VISITOR, agentId: AGENT });
    expect(theirs.workspace.id).toBe(own.workspace.id);
    expect(workspaces).toHaveLength(1);
  });

  it('is not used once Always on is off: the call works in the person\'s own workspace', async () => {
    const { service } = hosted(homeAgent(false));
    const { workspace } = await service.workspaceFor(ENV, { organizationId: ORG, callerUserId: OWNER, agentId: AGENT });
    expect(workspace).toMatchObject({ agentId: null, ownerUserId: OWNER });
  });
});
