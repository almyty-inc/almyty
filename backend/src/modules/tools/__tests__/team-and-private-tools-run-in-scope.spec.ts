import axios from 'axios';

import { ToolExecutorService } from '../tool-executor.service';
import { ToolHttpExecutor } from '../executors/tool-http.executor';
import { ToolStatus, ToolType } from '../../../entities/tool.entity';
import { fakeRepository } from '../../../test/fake-repository';
import { CAST, castFixture } from '../../../test/execution-access.fixture';
import {
  ExecutionPrincipal,
  gatewayPrincipal,
  userPrincipal,
} from '../../../common/authorization/execution-access.service';

jest.mock('axios', () => {
  const fn: any = jest.fn();
  fn.isAxiosError = () => false;
  return { __esModule: true, default: fn, isAxiosError: () => false };
});

/**
 * Team and private tools run only in the caller's scope, whichever surface
 * the call came through. ToolExecutorService is where every surface
 * converges -- REST execute, a tool_call node, an autonomous run's tool
 * call, MCP/UTCP/Skills gateways, a sandboxed tools.invoke -- so the check
 * lives there: a caller who learns a team tool's id, or reaches it through
 * a surface that forgot to filter, still cannot run it.
 *
 * The decision is the real ExecutionAccessService over the real
 * AccessPolicyService.canAccess; only the membership rows are in memory
 * (execution-access.fixture). A refusal must look exactly like a missing
 * tool, must not reach the network, and must not be recorded against the
 * tool.
 */
describe('team and private tools run in the caller scope only (executor)', () => {
  const mockedAxios = axios as unknown as jest.Mock;
  const base = {
    organizationId: CAST.org,
    status: ToolStatus.ACTIVE,
    type: ToolType.API,
    httpConfig: { method: 'GET', path: 'https://upstream.example.com/things' },
    configuration: {},
    api: null,
    operation: null,
  };
  const TOOLS = [
    { ...base, id: 'org-tool', name: 'org-tool', visibility: 'org', teamId: null, createdBy: CAST.owner },
    { ...base, id: 'team-tool', name: 'team-tool', visibility: 'team', teamId: CAST.team, createdBy: CAST.member },
    { ...base, id: 'private-tool', name: 'private-tool', visibility: 'private', teamId: null, createdBy: CAST.owner },
  ];

  function build() {
    const m = castFixture();
    const tools = fakeRepository<any>(TOOLS);
    const recordExecution = jest.fn().mockResolvedValue(undefined);
    const member = {
      hasPermissionInOrganization: () => true,
      organizationMemberships: [{ organizationId: CAST.org, role: 'member' }],
    };
    const executor = new ToolExecutorService(
      tools as any,
      {} as any,
      { findOne: jest.fn().mockResolvedValue(member) } as any,
      {} as any,
      new ToolHttpExecutor({ applyApiAuth: jest.fn(), applyInlineToolAuth: jest.fn() } as any),
      {} as any,
      {} as any,
      {} as any,
      {
        checkRateLimit: jest.fn().mockResolvedValue({ limited: false }),
        getCachedResult: jest.fn().mockResolvedValue(null),
        cacheResult: jest.fn().mockResolvedValue(undefined),
      } as any,
      {
        validateParameters: jest.fn().mockResolvedValue({ isValid: true, errors: [] }),
        recordExecution,
      } as any,
      {} as any,
      {} as any,
      {} as any,
      fakeRepository<any>([]) as any,
      undefined,
      m.executionAccess,
    );
    return { executor, recordExecution, m };
  }

  const run = (executor: ToolExecutorService, toolId: string, principal: ExecutionPrincipal) =>
    executor.executeTool(toolId, {}, { userId: '', organizationId: CAST.org, principal });

  beforeEach(() => {
    mockedAxios.mockReset();
    mockedAxios.mockResolvedValue({ status: 200, data: { ok: true }, headers: {} });
  });

  const allowed: Array<[string, string, () => ExecutionPrincipal]> = [
    ['a team member runs the team tool', 'team-tool', () => userPrincipal(CAST.member)],
    ['an org admin runs the team tool (the read rule)', 'team-tool', () => userPrincipal(CAST.admin)],
    ['the owner runs their private tool', 'private-tool', () => userPrincipal(CAST.owner)],
    ['a non-member of the team still runs org tools', 'org-tool', () => userPrincipal(CAST.nonMember)],
    ['a gateway scoped to the team runs the team tool', 'team-tool', () =>
      gatewayPrincipal({ id: 'gw', organizationId: CAST.org, visibility: 'team', teamId: CAST.team })],
  ];
  it.each(allowed)('%s', async (_label, toolId, principal) => {
    const { executor } = build();
    const result = await run(executor, toolId, principal());
    expect(result.success).toBe(true);
    expect(mockedAxios).toHaveBeenCalledTimes(1);
  });

  const refused: Array<[string, string, () => ExecutionPrincipal]> = [
    ['a member of another team', 'team-tool', () => userPrincipal(CAST.nonMember)],
    ['a call with no known user', 'team-tool', () => userPrincipal(null)],
    ['an org admin, on somebody else\'s private tool', 'private-tool', () => userPrincipal(CAST.admin)],
    ['a team member, on somebody else\'s private tool', 'private-tool', () => userPrincipal(CAST.member)],
    ['an org-wide gateway', 'team-tool', () =>
      gatewayPrincipal({ id: 'gw', organizationId: CAST.org, visibility: 'org', ownerUserId: CAST.member })],
    ['a gateway scoped to another team', 'team-tool', () =>
      gatewayPrincipal({ id: 'gw', organizationId: CAST.org, visibility: 'team', teamId: CAST.otherTeam })],
  ];
  it.each(refused)('refuses %s exactly as a missing tool, off the network and off the record', async (_l, toolId, principal) => {
    const { executor, recordExecution } = build();
    const refusedResult = await run(executor, toolId, principal());
    const missingResult = await run(executor, 'no-such-tool', principal());
    expect(refusedResult.success).toBe(false);
    expect(refusedResult.notFound).toBe(true);
    expect(refusedResult.error).toBe(missingResult.error);
    expect(missingResult.notFound).toBe(true);
    expect(mockedAxios).not.toHaveBeenCalled();
    expect(recordExecution).not.toHaveBeenCalled();
  });

  it('a member who leaves the team is refused on the next call', async () => {
    const { executor, m } = build();
    expect((await run(executor, 'team-tool', userPrincipal(CAST.member))).success).toBe(true);
    m.leaveTeam(CAST.team, CAST.member);
    const after = await run(executor, 'team-tool', userPrincipal(CAST.member));
    expect(after.notFound).toBe(true);
    expect(mockedAxios).toHaveBeenCalledTimes(1);
  });

  it('decides on the principal, not on userId: a member principal is not widened by an admin userId', async () => {
    const { executor } = build();
    const result = await executor.executeTool('team-tool', {}, {
      userId: CAST.admin,
      organizationId: CAST.org,
      principal: userPrincipal(CAST.nonMember),
    });
    expect(result.notFound).toBe(true);
    expect(mockedAxios).not.toHaveBeenCalled();
  });

  it('without a principal the call is authorized as its userId', async () => {
    const { executor } = build();
    expect((await executor.executeTool('team-tool', {}, { userId: CAST.member, organizationId: CAST.org })).success).toBe(true);
    expect((await executor.executeTool('team-tool', {}, { userId: CAST.nonMember, organizationId: CAST.org })).notFound).toBe(true);
  });

  it('runs nothing when the gate is not wired (fail closed)', async () => {
    const executor = new ToolExecutorService(
      fakeRepository<any>(TOOLS) as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any,
      {} as any, {} as any, { recordExecution: jest.fn() } as any, {} as any, {} as any, {} as any,
      fakeRepository<any>([]) as any,
    );
    const result = await executor.executeTool('org-tool', {}, { userId: '', organizationId: CAST.org });
    expect(result.success).toBe(false);
    expect(mockedAxios).not.toHaveBeenCalled();
  });

  describe('an org-wide tool over a team API', () => {
    // Generation makes a team API's tools org-wide (only a private API's
    // tools follow it), so the tool row alone handed the team's API -- its
    // base URL and bound credentials -- to the whole org.
    const TEAM_API = { id: 'api-team', organizationId: CAST.org, visibility: 'team', teamId: CAST.team, ownerUserId: null };
    const onTeamApi = { ...base, id: 'org-tool-team-api', name: 'org-tool-team-api', visibility: 'org', teamId: null, createdBy: CAST.member, api: TEAM_API };

    function buildWithApiTool() {
      const built = build();
      (built.executor as any).toolRepository = fakeRepository<any>([...TOOLS, onTeamApi]);
      return built;
    }

    const refusedOnApi: Array<[string, () => ExecutionPrincipal]> = [
      ['a member outside the API team', () => userPrincipal(CAST.nonMember)],
      ['a call with no known user', () => userPrincipal(null)],
      ['an org-wide gateway', () => gatewayPrincipal({ id: 'gw', organizationId: CAST.org, visibility: 'org' })],
      ['a gateway scoped to another team', () =>
        gatewayPrincipal({ id: 'gw', organizationId: CAST.org, visibility: 'team', teamId: CAST.otherTeam })],
    ];
    it.each(refusedOnApi)('is refused to %s, exactly as a missing tool', async (_label, principal) => {
      const { executor, recordExecution } = buildWithApiTool();
      const result = await run(executor, 'org-tool-team-api', principal());
      expect(result.notFound).toBe(true);
      expect(result.error).toBe((await run(executor, 'no-such-tool', principal())).error);
      expect(mockedAxios).not.toHaveBeenCalled();
      expect(recordExecution).not.toHaveBeenCalled();
    });

    const allowedOnApi: Array<[string, () => ExecutionPrincipal]> = [
      ['a member of the API team', () => userPrincipal(CAST.member)],
      ['an org admin', () => userPrincipal(CAST.admin)],
      ['a gateway scoped to the API team', () =>
        gatewayPrincipal({ id: 'gw', organizationId: CAST.org, visibility: 'team', teamId: CAST.team })],
    ];
    it.each(allowedOnApi)('is run for %s', async (_label, principal) => {
      const { executor } = buildWithApiTool();
      const result = await run(executor, 'org-tool-team-api', principal());
      expect(result.notFound).toBeFalsy();
    });
  });
});
