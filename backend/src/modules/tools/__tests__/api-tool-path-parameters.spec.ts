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

  it('POST whose body has a field named body (GitHub issue comments): flat, with the path filled', async () => {
    const operation = op('POST', '/repos/{owner}/{repo}/issues/{issue_number}/comments', {
      path: { owner: {}, repo: {}, issue_number: {} },
      body: { schema: { type: 'object', properties: { body: { type: 'string' } } } },
    });
    await executor.executeRestOperation(tool, operation, api, { owner: 'tidewater-labs', repo: 'ledgerly', issue_number: 482, body: 'Same as #431.' }, {} as any);

    const config = mockedAxios.mock.calls[0][0];
    expect(config.url).toBe('https://helpdesk.example.com/repos/tidewater-labs/ledgerly/issues/482/comments');
    expect(config.data).toEqual({ body: 'Same as #431.' });
  });

  it('POST whose body has a field named query (HubSpot search): flat, the text stays in the body', async () => {
    const operation = op('POST', '/crm/v3/objects/deals/search', {
      body: { schema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer' } } } },
    });
    await executor.executeRestOperation(tool, operation, api, { query: 'Bluefin', limit: 5 }, {} as any);

    const config = mockedAxios.mock.calls[0][0];
    expect(config.url).toBe('https://helpdesk.example.com/crm/v3/objects/deals/search');
    expect(config.data).toEqual({ query: 'Bluefin', limit: 5 });
  });

  it('arguments grouped by where they go are still read as groups', async () => {
    const operation = op('POST', '/repos/{owner}/{repo}/issues/{issue_number}/comments', {
      path: { owner: {}, repo: {}, issue_number: {} },
      body: { schema: { type: 'object', properties: { body: { type: 'string' } } } },
    });
    await executor.executeRestOperation(tool, operation, api, { path: { owner: 'o', repo: 'r', issue_number: 1 }, body: { body: 'hi' } }, {} as any);

    const config = mockedAxios.mock.calls[0][0];
    expect(config.url).toBe('https://helpdesk.example.com/repos/o/r/issues/1/comments');
    expect(config.data).toEqual({ body: 'hi' });
  });

  it('POST with a declared header parameter (PagerDuty notes): the header is sent as a header', async () => {
    const operation = op('POST', '/incidents/{id}/notes', {
      path: { id: {} },
      header: { Accept: {}, 'Content-Type': {}, From: {} },
      body: { schema: { type: 'object', properties: { note: { type: 'object' } } } },
    });
    await executor.executeRestOperation(tool, operation, api, { id: 'Q2KF8NXJ1T', From: 'oncall@tidewater.example', note: { content: 'Likely the pool again.' } }, {} as any);

    const config = mockedAxios.mock.calls[0][0];
    expect(config.url).toBe('https://helpdesk.example.com/incidents/Q2KF8NXJ1T/notes');
    expect(config.headers.From).toBe('oncall@tidewater.example');
    expect(config.data).toEqual({ note: { content: 'Likely the pool again.' } });
  });
});
