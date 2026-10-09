import axios from 'axios';

import { ToolExecutorService, isNoAccessError, noAccessMessage } from '../tool-executor.service';
import { ToolHttpExecutor } from '../executors/tool-http.executor';
import { ToolStatus, ToolType } from '../../../entities/tool.entity';
import { ConnectionNotGrantedError } from '../../connections/grants/grants.service';
import { fakeRepository } from '../../../test/fake-repository';
import { membershipFixture } from '../../../test/execution-access.fixture';
import { userPrincipal } from '../../../common/authorization/execution-access.service';

jest.mock('axios', () => {
  const fn: any = jest.fn();
  fn.isAxiosError = () => false;
  return { __esModule: true, default: fn, isAxiosError: () => false };
});
const mockedAxios = axios as unknown as jest.Mock;

/**
 * A run that may not use the account a tool signs in with (a Slack message
 * from someone other than the agent's owner, for an agent that was given no
 * access) was retried three times over fourteen seconds and then answered
 * with "Execution failed after 4 attempts: connection is not granted: ...",
 * which the agent read as "found nothing". It now fails at once, with a
 * sentence the agent can repeat.
 */
describe('a tool the run has no access to says so', () => {
  const tool = {
    id: 'tool-search',
    name: 'hubspot_companies_search',
    organizationId: 'org-1',
    status: ToolStatus.ACTIVE,
    type: ToolType.API,
    visibility: 'org',
    teamId: null,
    createdBy: 'u-1',
    httpConfig: { method: 'POST', path: 'https://api.hubapi.com/crm/v3/objects/companies/search' },
    authConfig: { type: 'bearer', config: { credentialId: 'cred-hubspot' } },
    parameters: { type: 'object', properties: {} },
    configuration: {},
    api: { name: 'HubSpot Companies' },
    operation: null,
  };
  const auth = {
    applyToolAuth: jest.fn(),
    applyApiAuth: jest.fn(async () => {
      throw new ConnectionNotGrantedError('cred-hubspot', 'no grant on this org-scoped connection');
    }),
    applyInlineToolAuth: jest.fn(),
  };
  const m = membershipFixture();
  m.member('org-1', 'u-1');
  const executor = new ToolExecutorService(
    fakeRepository<any>([tool]) as any,
    {} as any,
    { findOne: jest.fn().mockResolvedValue({ hasPermissionInOrganization: () => true, organizationMemberships: [] }) } as any,
    {} as any,
    new ToolHttpExecutor(auth as any),
    {} as any,
    {} as any,
    {} as any,
    {
      checkRateLimit: jest.fn().mockResolvedValue({ limited: false }),
      getCachedResult: jest.fn().mockResolvedValue(null),
      cacheResult: jest.fn().mockResolvedValue(undefined),
    } as any,
    { validateParameters: jest.fn().mockResolvedValue({ isValid: true, errors: [] }), recordExecution: jest.fn() } as any,
    {} as any,
    {} as any,
    {} as any,
    fakeRepository<any>([]) as any,
    undefined,
    m.executionAccess,
  );

  it('fails at once with a plain sentence naming the service', async () => {
    const started = Date.now();
    const result = await executor.executeTool('tool-search', {}, { organizationId: 'org-1', userId: 'u-1', principal: userPrincipal('u-1'), runId: 'run-1' } as any);

    expect(result.success).toBe(false);
    expect(result.noAccess).toBe(true);
    expect(result.error).toBe(noAccessMessage('HubSpot Companies'));
    expect(result.error).toMatch(/^I don't have access to HubSpot Companies\./);
    expect(auth.applyApiAuth).toHaveBeenCalledTimes(1);
    expect(mockedAxios).not.toHaveBeenCalled();
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('an imported API operation is not retried either', async () => {
    const api = { id: 'api-1', name: 'HubSpot Companies', type: 'openapi', baseUrl: 'https://api.hubapi.com', organizationId: 'org-1', headers: {} };
    const imported = { ...tool, id: 'tool-op', httpConfig: null, authConfig: null, api, operation: { id: 'op-1', method: 'POST', endpoint: '/crm/v3/objects/companies/search', parameters: {}, api } };
    const opExecutor = new ToolExecutorService(
      fakeRepository<any>([imported]) as any,
      {} as any,
      { findOne: jest.fn().mockResolvedValue({ hasPermissionInOrganization: () => true, organizationMemberships: [] }) } as any,
      {} as any,
      new ToolHttpExecutor(auth as any),
      {} as any,
      {} as any,
      {} as any,
      { checkRateLimit: jest.fn().mockResolvedValue({ limited: false }), getCachedResult: jest.fn().mockResolvedValue(null), cacheResult: jest.fn() } as any,
      { validateParameters: jest.fn().mockResolvedValue({ isValid: true, errors: [] }), recordExecution: jest.fn() } as any,
      {} as any,
      {} as any,
      {} as any,
      fakeRepository<any>([]) as any,
      undefined,
      m.executionAccess,
    );
    auth.applyApiAuth.mockClear();
    const started = Date.now();
    const result = await opExecutor.executeTool('tool-op', {}, { organizationId: 'org-1', userId: 'u-1', principal: userPrincipal('u-1'), runId: 'run-1' } as any);

    expect(result).toMatchObject({ success: false, noAccess: true, error: noAccessMessage('HubSpot Companies') });
    expect(auth.applyApiAuth).toHaveBeenCalledTimes(1);
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('knows a refused, missing or hidden connection when it sees one', () => {
    expect(isNoAccessError(new ConnectionNotGrantedError('c', 'r'))).toBe(true);
    expect(isNoAccessError({ response: { code: 'CONNECTION_NOT_FOUND' } })).toBe(true);
    expect(isNoAccessError(new Error('socket hang up'))).toBe(false);
  });
});
