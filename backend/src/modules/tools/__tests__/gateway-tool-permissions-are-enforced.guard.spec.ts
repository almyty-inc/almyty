import { membershipFixture } from '../../../test/execution-access.fixture';
import { readFileSync } from 'fs';
import { join } from 'path';

import axios from 'axios';

import { ToolExecutorService } from '../tool-executor.service';
import { ToolHttpExecutor } from '../executors/tool-http.executor';
import { ToolStatus, ToolType } from '../../../entities/tool.entity';
import { decideToolCaller } from '../../../common/security/gateway-tool-permissions';

jest.mock('axios', () => {
  const fn: any = jest.fn();
  fn.isAxiosError = () => false;
  return { __esModule: true, default: fn, isAxiosError: () => false };
});

/**
 * `gateway_tools.permissions` shipped complete and inert: four fields on
 * the column, four fields on the PATCH DTO, a dashboard that edited them,
 * and `GatewayTool.hasPermission()` implementing all four -- with zero
 * callers anywhere in backend/src or backend/ee. A tool restricted to two
 * named users answered anyone who could reach the gateway, and the
 * restriction still rendered in the UI as if it were in force.
 *
 * The same shape as the securityPolicy bug one column over, found the same
 * week, which is why the fix follows the same pattern: a pure decision
 * function in common/security that the executor calls before dispatch, and
 * an entity method that delegates to it rather than being a second copy.
 *
 * Source-reading arms on purpose: decideToolCaller has perfectly good unit
 * tests below, and every one of them passed while nothing called it.
 *
 * What it guards:
 *   1. the executor imports and calls the decision function;
 *   2. it reads the permissions column when it loads the row, and reads
 *      that row on EVERY gatewayed call -- the securityPolicy short-circuit
 *      must not let a caller skip the access list;
 *   3. the entity method delegates rather than reimplementing;
 *   4. the refusal really fires, including for an anonymous caller.
 */
const SRC = join(__dirname, '..', '..', '..');
const read = (...p: string[]) => readFileSync(join(SRC, ...p), 'utf8');

const executorSrc = read('modules', 'tools', 'tool-executor.service.ts');
const entitySrc = read('entities', 'gateway-tool.entity.ts');

describe('the access list is consulted before dispatch', () => {
  it('the executor calls the decision function', () => {
    expect(executorSrc).toContain("from '../../common/security/gateway-tool-permissions'");
    expect(executorSrc).toContain('decideToolCaller(gatewayTool?.permissions');
  });

  it('it selects the permissions column when it loads the row', () => {
    expect(executorSrc).toMatch(/select: \{[^}]*permissions: true/s);
  });

  it('the row is loaded for every gatewayed call, not only unresolved ones', () => {
    // The bug this prevents: gating the lookup on
    // `options.securityPolicy === undefined` would let any caller skip the
    // access list by passing a policy it already had.
    const lookup = executorSrc.indexOf('this.gatewayToolRepository.findOne({');
    const guard = executorSrc.lastIndexOf('if (options.gatewayId) {', lookup);
    expect(guard).toBeGreaterThan(-1);
    expect(executorSrc.slice(guard, lookup)).not.toContain('securityPolicy === undefined');
  });

  it('it refuses rather than logging and continuing', () => {
    const call = executorSrc.indexOf('decideToolCaller(gatewayTool?.permissions');
    const after = executorSrc.slice(call, call + 600);
    expect(after).toMatch(/if \(!access\.allowed\)/);
    expect(after).toContain('throw new Error');
  });

  it('the entity method delegates instead of keeping a second copy', () => {
    expect(entitySrc).toContain('return decideToolCaller(this.permissions, {');
    // The old inline implementation, which is what went uncalled.
    expect(entitySrc).not.toContain('this.permissions.allowedUsers.includes');
  });
});

describe('what the decision function decides', () => {
  const caller = {
    userId: 'u1',
    roles: ['admin'],
    organizationId: 'org-1',
    scopes: ['tools:run'],
  };

  it('allows everything when no permissions are set', () => {
    expect(decideToolCaller(null, {}).allowed).toBe(true);
    expect(decideToolCaller({}, {}).allowed).toBe(true);
  });

  it('treats an empty list as no restriction on that axis', () => {
    expect(decideToolCaller({ allowedUsers: [], allowedRoles: [] }, {}).allowed).toBe(true);
  });

  it.each([
    ['allowedUsers', { allowedUsers: ['someone-else'] }],
    ['allowedRoles', { allowedRoles: ['auditor'] }],
    ['allowedOrganizations', { allowedOrganizations: ['org-2'] }],
    ['requiredScopes', { requiredScopes: ['tools:admin'] }],
  ])('refuses on %s', (_name, permissions) => {
    const decision = decideToolCaller(permissions, caller);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBeTruthy();
  });

  it('allows a caller that satisfies every clause', () => {
    expect(
      decideToolCaller(
        {
          allowedUsers: ['u1'],
          allowedRoles: ['admin'],
          allowedOrganizations: ['org-1'],
          requiredScopes: ['tools:run'],
        },
        caller,
      ).allowed,
    ).toBe(true);
  });

  it('refuses an anonymous caller against any explicit list', () => {
    expect(decideToolCaller({ allowedUsers: ['u1'] }, {}).allowed).toBe(false);
    expect(decideToolCaller({ requiredScopes: ['tools:run'] }, {}).allowed).toBe(false);
  });
});

describe('end to end through the executor', () => {
  const mockedAxios = axios as unknown as jest.Mock;

  function buildExecutor(gatewayTool: any) {
    const tool = {
      id: 'tool-1',
      name: 'fixture',
      organizationId: 'org-1',
      status: ToolStatus.ACTIVE,
      type: ToolType.API,
      httpConfig: { method: 'GET', path: 'https://upstream.example.com/things' },
      configuration: {},
      api: null,
      operation: null,
    } as any;

    return new ToolExecutorService(
      { findOne: jest.fn().mockResolvedValue(tool) } as any,
      {} as any,
      { findOne: jest.fn() } as any,
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
        recordExecution: jest.fn().mockResolvedValue(undefined),
      } as any,
      {} as any,
      {} as any,
      {} as any,
      { findOne: jest.fn().mockResolvedValue(gatewayTool) } as any,
      undefined,
      // The real execution gate; these calls carry no user, so org tools pass.
      membershipFixture().executionAccess,
    );
  }

  beforeEach(() => {
    mockedAxios.mockReset();
    mockedAxios.mockResolvedValue({ status: 200, data: { ok: true }, headers: {} });
  });

  it('refuses a call from outside the allowed-user list, without reaching the network', async () => {
    const service = buildExecutor({ id: 'gt-1', permissions: { allowedUsers: ['someone-else'] } });

    const result = await service.executeTool('tool-1', {}, {
      userId: '',
      organizationId: 'org-1',
      gatewayId: 'gw-1',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('allowed-user list');
    expect(mockedAxios).not.toHaveBeenCalled();
  });

  it('refuses a call missing a required scope', async () => {
    const service = buildExecutor({ id: 'gt-1', permissions: { requiredScopes: ['tools:admin'] } });

    const result = await service.executeTool('tool-1', {}, {
      userId: '',
      organizationId: 'org-1',
      gatewayId: 'gw-1',
      scopes: ['tools:read'],
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('tools:admin');
    expect(mockedAxios).not.toHaveBeenCalled();
  });

  it('lets a call with the required scope through', async () => {
    const service = buildExecutor({ id: 'gt-1', permissions: { requiredScopes: ['tools:admin'] } });

    const result = await service.executeTool('tool-1', {}, {
      userId: '',
      organizationId: 'org-1',
      gatewayId: 'gw-1',
      scopes: ['tools:admin'],
    });

    expect(result.success).toBe(true);
    expect(mockedAxios).toHaveBeenCalledTimes(1);
  });

  it('a gateway tool with no permissions row behaves exactly as before', async () => {
    const service = buildExecutor({ id: 'gt-1', permissions: null });

    const result = await service.executeTool('tool-1', {}, {
      userId: '',
      organizationId: 'org-1',
      gatewayId: 'gw-1',
    });

    expect(result.success).toBe(true);
  });
});
