import axios from 'axios';

import { ToolExecutorService } from '../tool-executor.service';
import { ToolHttpExecutor } from '../executors/tool-http.executor';
import { ToolStatus, ToolType } from '../../../entities/tool.entity';
import { PiiFilterPlugin } from '../../plugins/built-in/pii-filter.plugin';
import { PluginHookType } from '../../plugins/types/plugin.types';
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
 * The PII filter hides personal data in what is kept and what leaves
 * almyty, never in what a tool is called with. With a Business plan's
 * secure default (the filter enforced), a calendar id like
 * team@lumen.example went to Google as "******************mple" and the
 * team calendar came back empty, with no error.
 */
describe('the PII filter and tool calls', () => {
  const pii = new PiiFilterPlugin();
  // The plugin manager as far as the executor sees it, with the real
  // filter registered under the hooks it declares (and none other).
  const declared = new Set(pii.getPluginDefinition().hooks.map((h) => h.type));
  const pluginManager = {
    executeHook: jest.fn(async (type: PluginHookType, context: any) => {
      if (!declared.has(type) || type !== PluginHookType.DATA_FILTER) return context;
      const out = await pii.filterPiiFromData(context, { detectEmails: true, detectPhoneNumbers: true, detectCreditCards: true, detectSSN: true, detectIPAddresses: true, maskCharacter: '*' });
      return { ...context, data: out.data };
    }),
  };
  const tool = {
    id: 'tool-events',
    name: 'calendar_events_list',
    organizationId: 'org-1',
    status: ToolStatus.ACTIVE,
    type: ToolType.API,
    visibility: 'org',
    teamId: null,
    createdBy: 'u-1',
    httpConfig: { method: 'GET', path: 'https://www.googleapis.com/calendar/v3/calendars/{calendarId}/events' },
    parameters: { type: 'object', properties: { calendarId: { type: 'string' } } },
    configuration: {},
    api: null,
    operation: null,
  };
  const recordExecution = jest.fn();
  const m = membershipFixture();
  m.member('org-1', 'u-1');
  const executor = new ToolExecutorService(
    fakeRepository<any>([tool]) as any,
    {} as any,
    { findOne: jest.fn().mockResolvedValue({ hasPermissionInOrganization: () => true, organizationMemberships: [] }) } as any,
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
    { validateParameters: jest.fn().mockResolvedValue({ isValid: true, errors: [] }), recordExecution } as any,
    {} as any,
    {} as any,
    {} as any,
    fakeRepository<any>([]) as any,
    pluginManager as any,
    m.executionAccess,
  );

  beforeEach(() => {
    mockedAxios.mockReset();
    recordExecution.mockReset();
    mockedAxios.mockResolvedValue({ status: 200, data: { organizer: 'maya@lumen.example', items: [] }, headers: {} });
  });

  it('calls the tool with the real address, and keeps the record without it', async () => {
    const result = await executor.executeTool('tool-events', { calendarId: 'team@lumen.example' }, { organizationId: 'org-1', userId: 'u-1', principal: userPrincipal('u-1'), runId: 'run-1' } as any);

    expect(mockedAxios.mock.calls[0][0].url).toContain('team%40lumen.example');
    // The agent's own run gets the real answer.
    expect(result.data).toEqual({ organizer: 'maya@lumen.example', items: [] });
    const [, storedParams, storedResult] = recordExecution.mock.calls[0];
    expect(JSON.stringify(storedParams)).not.toContain('team@lumen.example');
    expect(JSON.stringify(storedResult.data)).not.toContain('maya@lumen.example');
  });

  it('hides personal data in the answer to an outside caller of a gateway', async () => {
    const inner = jest
      .spyOn(executor as any, 'executeToolUnfiltered')
      .mockResolvedValue({ success: true, data: { organizer: 'maya@lumen.example' } });
    const outside = await executor.executeTool('tool-events', { calendarId: 'primary' }, { organizationId: 'org-1', gatewayId: 'gw-1' } as any);
    const ownRun = await executor.executeTool('tool-events', { calendarId: 'primary' }, { organizationId: 'org-1', gatewayId: 'gw-1', runId: 'run-1' } as any);
    inner.mockRestore();

    expect(JSON.stringify(outside.data)).not.toContain('maya@lumen.example');
    expect(ownRun.data).toEqual({ organizer: 'maya@lumen.example' });
  });

  it('the filter no longer registers for tool inputs', () => {
    expect(declared.has(PluginHookType.PRE_TOOL_EXECUTION)).toBe(false);
    expect(declared.has(PluginHookType.DATA_FILTER)).toBe(true);
  });
});
