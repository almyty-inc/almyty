import axios from 'axios';

import { ToolHttpExecutor } from '../executors/tool-http.executor';
import { ToolStatus, ToolType } from '../../../entities/tool.entity';
import { fakeRepository } from '../../../test/fake-repository';

jest.mock('axios', () => {
  const fn: any = jest.fn();
  fn.isAxiosError = () => false;
  return { __esModule: true, default: fn, isAxiosError: () => false };
});

const mockedAxios = axios as unknown as jest.Mock;

/**
 * A generated API tool takes its arguments flat (`{ ticketId, status }`).
 * The endpoint's placeholders are filled from them on every method: a write
 * with a body puts the rest in the body (declared query parameters in the
 * query string), a read puts the rest in the query string.
 */
describe('API tools fill path parameters on every method', () => {
  const executor = new ToolHttpExecutor(
    { applyApiAuth: jest.fn(), applyInlineToolAuth: jest.fn() } as any,
    fakeRepository<any>([{ id: 'org-1', settings: {} }]) as any,
  );
  const api = { id: 'api-1', organizationId: 'org-1', baseUrl: 'https://helpdesk.example.com', headers: {}, timeoutMs: 1000 } as any;
  const tool = { id: 'tool-1', name: 'update_ticket', organizationId: 'org-1', status: ToolStatus.ACTIVE, type: ToolType.API, configuration: {} } as any;
  const op = (method: string, endpoint: string, parameters: Record<string, any>) => ({ method, endpoint, parameters }) as any;

  beforeEach(() => {
    mockedAxios.mockReset();
    mockedAxios.mockResolvedValue({ status: 200, data: { ok: true }, headers: {} });
  });

  it('PATCH with a body: the id goes in the URL, the rest in the body', async () => {
    const operation = op('PATCH', '/tickets/{ticketId}', { path: { ticketId: {} }, body: { schema: {} } });
    const result = await executor.executeRestOperation(tool, operation, api, { ticketId: 'T-1002', status: 'closed' }, {} as any);

    expect(result.success).toBe(true);
    const config = mockedAxios.mock.calls[0][0];
    expect(config.url).toBe('https://helpdesk.example.com/tickets/T-1002');
    expect(config.data).toEqual({ status: 'closed' });
  });

  it('POST with a body and a query parameter: each where the operation declares it', async () => {
    const operation = op('POST', '/pet/{petId}', { path: { petId: {} }, query: { notify: {} }, body: { schema: {} } });
    await executor.executeRestOperation(tool, operation, api, { petId: 3, notify: true, name: 'Pepper' }, {} as any);

    const config = mockedAxios.mock.calls[0][0];
    expect(config.url).toBe('https://helpdesk.example.com/pet/3');
    expect(config.params).toEqual({ notify: true });
    expect(config.data).toEqual({ name: 'Pepper' });
  });

  it('POST without a body: the id in the URL, nothing else in the body', async () => {
    const operation = op('POST', '/tickets/{ticketId}/close', { path: { ticketId: {} } });
    await executor.executeRestOperation(tool, operation, api, { ticketId: 'T-1005' }, {} as any);

    expect(mockedAxios.mock.calls[0][0].url).toBe('https://helpdesk.example.com/tickets/T-1005/close');
  });

  it('GET: the id in the URL, the rest in the query string', async () => {
    const operation = op('GET', '/tickets/{ticketId}/comments', { path: { ticketId: {} }, query: { limit: {} } });
    await executor.executeRestOperation(tool, operation, api, { ticketId: 'T-1001', limit: 5 }, {} as any);

    const config = mockedAxios.mock.calls[0][0];
    expect(config.url).toBe('https://helpdesk.example.com/tickets/T-1001/comments');
    expect(config.params).toEqual({ limit: 5 });
  });
});
