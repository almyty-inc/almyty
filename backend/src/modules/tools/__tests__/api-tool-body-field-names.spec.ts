import axios from 'axios';

import { ToolHttpExecutor } from '../executors/tool-http.executor';
import { isGroupedArguments } from '../executors/argument-shape';
import { ToolStatus, ToolType } from '../../../entities/tool.entity';
import { fakeRepository } from '../../../test/fake-repository';

jest.mock('axios', () => {
  const fn: any = jest.fn();
  fn.isAxiosError = () => false;
  return { __esModule: true, default: fn, isAxiosError: () => false };
});

const mockedAxios = axios as unknown as jest.Mock;

/**
 * A body field named `query` (BigQuery's jobs.query takes its SQL there) or
 * `body` (GitHub's create-issue takes its text there) is an argument like
 * any other. It used to switch the call to the grouped shape, which spread
 * the SQL over the query string one character per parameter.
 */
describe('API tools with a body field named query or body', () => {
  const executor = new ToolHttpExecutor(
    { applyApiAuth: jest.fn(), applyInlineToolAuth: jest.fn() } as any,
    fakeRepository<any>([{ id: 'org-1', settings: {} }]) as any,
  );
  const api = { id: 'api-1', organizationId: 'org-1', baseUrl: 'https://bigquery.googleapis.com/bigquery/v2', headers: {}, timeoutMs: 1000 } as any;
  const tool = { id: 'tool-1', name: 'bigquery_bigquery_jobs_query', organizationId: 'org-1', status: ToolStatus.ACTIVE, type: ToolType.API, configuration: {} } as any;
  const jobsQuery = { method: 'POST', endpoint: '/projects/{projectId}/queries', parameters: { path: { projectId: {} }, body: { schema: { $ref: '#/components/schemas/QueryRequest' } } } } as any;

  beforeEach(() => {
    mockedAxios.mockReset();
    mockedAxios.mockResolvedValue({ status: 200, data: { kind: 'bigquery#queryResponse' }, headers: {} });
  });

  it('sends a SQL string named query in the body', async () => {
    const result = await executor.executeRestOperation(
      tool,
      jobsQuery,
      api,
      { projectId: 'larkspur-analytics', query: 'SELECT COUNT(*) AS orders FROM orders', useLegacySql: false },
      {} as any,
    );

    expect(result.success).toBe(true);
    const config = mockedAxios.mock.calls[0][0];
    expect(config.url).toBe('https://bigquery.googleapis.com/bigquery/v2/projects/larkspur-analytics/queries');
    expect(config.data).toEqual({ query: 'SELECT COUNT(*) AS orders FROM orders', useLegacySql: false });
    expect(config.params).toEqual({});
  });

  it('sends a text field named body in the body', async () => {
    const createIssue = { method: 'POST', endpoint: '/repos/{owner}/{repo}/issues', parameters: { path: { owner: {}, repo: {} }, body: { schema: { properties: { title: {}, body: {} } } } } } as any;
    await executor.executeRestOperation(tool, createIssue, { ...api, baseUrl: 'https://api.github.com' }, { owner: 'acme', repo: 'shop', title: 'Broken link', body: 'The footer link 404s.' }, {} as any);

    const config = mockedAxios.mock.calls[0][0];
    expect(config.url).toBe('https://api.github.com/repos/acme/shop/issues');
    expect(config.data).toEqual({ title: 'Broken link', body: 'The footer link 404s.' });
  });

  it('still takes arguments grouped by where they go', async () => {
    const getComments = { method: 'GET', endpoint: '/tickets/{ticketId}/comments', parameters: { path: { ticketId: {} }, query: { limit: {} } } } as any;
    await executor.executeRestOperation(tool, getComments, { ...api, baseUrl: 'https://helpdesk.example.com' }, { path: { ticketId: 'T-1' }, query: { limit: 5 } }, {} as any);

    const config = mockedAxios.mock.calls[0][0];
    expect(config.url).toBe('https://helpdesk.example.com/tickets/T-1/comments');
    expect(config.params).toEqual({ limit: 5 });
  });

  it('tells the two shapes apart', () => {
    expect(isGroupedArguments({ query: 'SELECT 1' }, jobsQuery)).toBe(false);
    expect(isGroupedArguments({ query: { limit: 5 } }, { parameters: { query: { query: {} } } })).toBe(false);
    expect(isGroupedArguments({ query: { limit: 5 } }, { parameters: { query: { limit: {} } } })).toBe(true);
    expect(isGroupedArguments({ body: [{ id: 1 }] }, { parameters: {} })).toBe(true);
    expect(isGroupedArguments({ limit: 5 }, null)).toBe(false);
  });
});
