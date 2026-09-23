import axios from 'axios';

import { ToolExecutorService, isPrivateToolCallAllowed } from '../tool-executor.service';
import { ToolHttpExecutor } from '../executors/tool-http.executor';
import { ToolStatus, ToolType } from '../../../entities/tool.entity';

jest.mock('axios', () => {
  const fn: any = jest.fn();
  fn.isAxiosError = () => false;
  return { __esModule: true, default: fn, isAxiosError: () => false };
});

/**
 * A private tool runs for its owner and nobody else. The executor is the
 * one place every surface converges (REST execute, agent runs, gateways,
 * MCP), so the check lives there as well as in the listings: a caller
 * who learns a private tool's id, or reaches it through a surface that
 * forgot to filter, still cannot run it. Runner capability tools are
 * private tools too when their runner is private -- this is what stops
 * another member calling `runner.<name>.shell.exec` on the owner's
 * machine.
 */
describe('isPrivateToolCallAllowed', () => {
  it('leaves org and team tools to the layers in front of the executor', () => {
    expect(isPrivateToolCallAllowed({ visibility: 'org', createdBy: 'alice' }, undefined)).toBe(true);
    expect(isPrivateToolCallAllowed({ visibility: 'team', createdBy: 'alice' }, 'bob')).toBe(true);
  });

  it('runs a private tool for its owner only; an unknown caller is not the owner', () => {
    expect(isPrivateToolCallAllowed({ visibility: 'private', createdBy: 'alice' }, 'alice')).toBe(true);
    expect(isPrivateToolCallAllowed({ visibility: 'private', createdBy: 'alice' }, 'bob')).toBe(false);
    expect(isPrivateToolCallAllowed({ visibility: 'private', createdBy: 'alice' }, undefined)).toBe(false);
    expect(isPrivateToolCallAllowed({ visibility: 'private', createdBy: null as any }, 'alice')).toBe(false);
  });
});

describe('end to end through the executor', () => {
  const mockedAxios = axios as unknown as jest.Mock;

  function buildExecutor() {
    const tool = {
      id: 'tool-1',
      name: 'alice-private-fixture',
      organizationId: 'org-1',
      status: ToolStatus.ACTIVE,
      type: ToolType.API,
      visibility: 'private',
      createdBy: 'alice',
      httpConfig: { method: 'GET', path: 'https://upstream.example.com/things' },
      configuration: {},
      api: null,
      operation: null,
    } as any;
    const member = {
      hasPermissionInOrganization: () => true,
      organizationMemberships: [{ organizationId: 'org-1', role: 'admin' }],
    };

    return new ToolExecutorService(
      { findOne: jest.fn().mockResolvedValue(tool) } as any,
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
        recordExecution: jest.fn().mockResolvedValue(undefined),
      } as any,
      {} as any,
      {} as any,
      {} as any,
      { findOne: jest.fn().mockResolvedValue(null) } as any,
    );
  }

  beforeEach(() => {
    mockedAxios.mockReset();
    mockedAxios.mockResolvedValue({ status: 200, data: { ok: true }, headers: {} });
  });

  it('refuses another member of the org (here an org admin) without reaching the network', async () => {
    const result = await buildExecutor().executeTool('tool-1', {}, { userId: 'bob', organizationId: 'org-1' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found/i);
    expect(mockedAxios).not.toHaveBeenCalled();
  });

  it('refuses a call with no known user (an API-key gateway call)', async () => {
    const result = await buildExecutor().executeTool('tool-1', {}, { userId: '', organizationId: 'org-1' });
    expect(result.success).toBe(false);
    expect(mockedAxios).not.toHaveBeenCalled();
  });

  it('runs for the owner', async () => {
    const result = await buildExecutor().executeTool('tool-1', {}, { userId: 'alice', organizationId: 'org-1' });
    expect(mockedAxios).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
  });
});
