import axios from 'axios';

import { ToolHttpExecutor } from '../executors/tool-http.executor';
import { ToolsOperationHelper } from '../tools-operation.helper';
import { operationHeaderParams } from '../operation-header-params';
import { ToolStatus, ToolType } from '../../../entities/tool.entity';
import { fakeRepository } from '../../../test/fake-repository';

jest.mock('axios', () => {
  const fn: any = jest.fn();
  fn.isAxiosError = () => false;
  return { __esModule: true, default: fn, isAxiosError: () => false };
});

const mockedAxios = axios as unknown as jest.Mock;

/**
 * Xero's API description declares `xero-tenant-id` as a required header on
 * every path. A generated tool takes it as an input like a query parameter,
 * and the call sends it as a header, never in the query string. Headers the
 * key sets (Authorization) are never inputs.
 */
const xeroGetBankTransactions = {
  name: 'Retrieves any spent or received money transactions',
  method: 'GET',
  endpoint: '/BankTransactions',
  apiId: 'api-xero',
  parameters: {
    path: {},
    query: { where: { type: 'string', description: 'Filter by an any element' } },
    header: {
      'xero-tenant-id': { type: 'string', description: 'Xero identifier for Tenant', required: true },
      'If-Modified-Since': { type: 'string', description: 'Only records created or modified since this timestamp will be returned' },
      Authorization: { type: 'string', description: 'Bearer token' },
    },
    body: {},
  },
} as any;

describe('API tools take declared header parameters', () => {
  it('lists declared headers except the ones a key or the client sets', () => {
    expect(operationHeaderParams(xeroGetBankTransactions).map(([name]) => name)).toEqual(['xero-tenant-id', 'If-Modified-Since']);
    expect(operationHeaderParams({ parameters: {} } as any)).toEqual([]);
    expect(operationHeaderParams(null)).toEqual([]);
  });

  it('a generated tool has the header as an input, required when the description says so', async () => {
    const helper = new ToolsOperationHelper({} as any, {} as any, {} as any, {} as any);
    const params = await helper.generateToolParametersFromOperation(xeroGetBankTransactions);

    expect(params.properties['xero-tenant-id']).toEqual({ type: 'string', description: 'Xero identifier for Tenant' });
    expect(params.properties['If-Modified-Since']).toBeDefined();
    expect(params.properties.Authorization).toBeUndefined();
    expect(params.required).toEqual(['xero-tenant-id']);
    expect(params.properties.where).toBeDefined();
  });

  describe('the call', () => {
    const executor = new ToolHttpExecutor(
      { applyApiAuth: jest.fn(), applyInlineToolAuth: jest.fn() } as any,
      fakeRepository<any>([{ id: 'org-1', settings: {} }]) as any,
    );
    const api = { id: 'api-xero', organizationId: 'org-1', baseUrl: 'https://api.xero.com/api.xro/2.0', headers: {}, timeoutMs: 1000 } as any;
    const tool = { id: 'tool-1', name: 'xero_accounting_get_bank_transactions', organizationId: 'org-1', status: ToolStatus.ACTIVE, type: ToolType.API, configuration: {} } as any;

    beforeEach(() => {
      mockedAxios.mockReset();
      mockedAxios.mockResolvedValue({ status: 200, data: { BankTransactions: [] }, headers: {} });
    });

    it('sends the header as a header and the rest in the query string', async () => {
      const result = await executor.executeRestOperation(
        tool,
        xeroGetBankTransactions,
        api,
        { 'xero-tenant-id': '7a3c51e2-0d4b-4c7e-9a52-6f1e8b2d4c90', where: 'Type=="RECEIVE"' },
        {} as any,
      );

      expect(result.success).toBe(true);
      const config = mockedAxios.mock.calls[0][0];
      expect(config.url).toBe('https://api.xero.com/api.xro/2.0/BankTransactions');
      expect(config.headers['xero-tenant-id']).toBe('7a3c51e2-0d4b-4c7e-9a52-6f1e8b2d4c90');
      expect(config.params).toEqual({ where: 'Type=="RECEIVE"' });
    });

    it('never lets an argument named like an auth header become a header', async () => {
      await executor.executeRestOperation(tool, xeroGetBankTransactions, api, { Authorization: 'Bearer stolen' }, {} as any);

      const config = mockedAxios.mock.calls[0][0];
      expect(config.headers.Authorization).toBeUndefined();
    });
  });
});
