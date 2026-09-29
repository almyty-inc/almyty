import axios from 'axios';

import { ToolHttpExecutor } from '../executors/tool-http.executor';
import { ToolStatus, ToolType } from '../../../entities/tool.entity';
import { ssrfSafeHttpAgent } from '../../../common/security/ssrf-safe-agent';
import { fakeRepository } from '../../../test/fake-repository';

jest.mock('axios', () => {
  const fn: any = jest.fn();
  fn.isAxiosError = () => false;
  return { __esModule: true, default: fn, isAxiosError: () => false };
});

const mockedAxios = axios as unknown as jest.Mock;

/**
 * An API on the organization's own network: its tools reach it once an
 * admin puts its host on the organization's egress allowlist, the same
 * allowlist a model provider's URL is judged by. Every other private
 * address stays refused, and one organization's allowlist opens nothing
 * for another.
 */
describe('API tools and the organization egress allowlist', () => {
  const organizations = fakeRepository<any>([
    { id: 'org-1', settings: { egressAllowlist: ['localhost'] } },
    { id: 'org-2', settings: {} },
  ]);
  const auth = { applyApiAuth: jest.fn(), applyInlineToolAuth: jest.fn() } as any;
  const executor = new ToolHttpExecutor(auth, organizations as any);

  const api = (organizationId: string, baseUrl = 'http://localhost:8123/api') =>
    ({ id: 'api-1', organizationId, baseUrl, headers: {}, timeoutMs: 1000 }) as any;
  const operation = { method: 'GET', endpoint: '/forecast', parameters: {} } as any;
  const tool = (organizationId: string, extra: Record<string, any> = {}) =>
    ({ id: 'tool-1', name: 'getForecast', organizationId, status: ToolStatus.ACTIVE, type: ToolType.API, configuration: {}, ...extra }) as any;

  beforeEach(() => {
    mockedAxios.mockReset();
    mockedAxios.mockResolvedValue({ status: 200, data: { forecast: 'sunny' }, headers: {} });
  });

  it('calls an operation on an allowlisted private host, with an agent that exempts that host alone', async () => {
    const result = await executor.executeRestOperation(tool('org-1'), operation, api('org-1'), { city: 'Lisbon' }, {} as any);

    expect(result.success).toBe(true);
    const config = mockedAxios.mock.calls[0][0];
    expect(config.url).toBe('http://localhost:8123/api/forecast');
    expect(config.httpAgent).toBeDefined();
    expect(config.httpAgent).not.toBe(ssrfSafeHttpAgent);
    expect(config.maxRedirects).toBe(0);
  });

  it('calls a structured HTTP tool on an allowlisted private host', async () => {
    const httpTool = tool('org-1', { httpConfig: { method: 'GET', path: '/forecast' }, api: api('org-1') });
    const result = await executor.executeHttpConfig(httpTool, { city: 'Lisbon' }, {} as any);

    expect(result.success).toBe(true);
    expect(mockedAxios.mock.calls[0][0].url).toBe('http://localhost:8123/api/forecast');
  });

  it('still refuses a private host the organization has not allowlisted', async () => {
    const result = await executor.executeRestOperation(tool('org-2'), operation, api('org-2'), {}, {} as any);

    expect(result.success).toBe(false);
    expect(mockedAxios).not.toHaveBeenCalled();
  });

  it('refuses a private host other than the allowlisted one', async () => {
    const result = await executor.executeRestOperation(tool('org-1'), operation, api('org-1', 'http://169.254.169.254/api'), {}, {} as any);

    expect(result.success).toBe(false);
    expect(mockedAxios).not.toHaveBeenCalled();
  });

  it('sends a public host through the pinning agent, as before', async () => {
    await executor.executeRestOperation(tool('org-1'), operation, api('org-1', 'https://api.example.com'), {}, {} as any);

    expect(mockedAxios.mock.calls[0][0].httpAgent).toBe(ssrfSafeHttpAgent);
  });
});
