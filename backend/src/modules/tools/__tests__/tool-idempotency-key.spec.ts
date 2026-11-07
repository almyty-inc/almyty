import axios from 'axios';

import { ToolHttpExecutor } from '../executors/tool-http.executor';
import { idempotencyHeader } from '../operation-header-params';
import { ToolStatus, ToolType } from '../../../entities/tool.entity';
import { fakeRepository } from '../../../test/fake-repository';

jest.mock('axios', () => {
  const fn: any = jest.fn();
  fn.isAxiosError = () => false;
  return { __esModule: true, default: fn, isAxiosError: () => false };
});

const mockedAxios = axios as unknown as jest.Mock;

/**
 * Durable runs step 4: a run step's call carries an idempotency key, the
 * same on every attempt of the step (run-resume.ts), and a tool that
 * accepts one gets it. An HTTP operation accepts one when it declares an
 * `Idempotency-Key` (or `X-Idempotency-Key`) header, as Stripe's API
 * description does on every write: the key goes out as that header,
 * whatever the model put there. A tool that declares none is sent no key.
 */
const createCharge = {
  name: 'Create a charge',
  method: 'POST',
  endpoint: '/v1/charges',
  apiId: 'api-pay',
  parameters: {
    path: {},
    query: {},
    header: { 'Idempotency-Key': { type: 'string', description: 'Makes the request safe to retry' } },
    body: { amount: { type: 'integer' }, currency: { type: 'string' } },
  },
} as any;
const createRefund = { ...createCharge, name: 'Create a refund', endpoint: '/v1/refunds', parameters: { ...createCharge.parameters, header: {} } } as any;

describe('a tool call carries its idempotency key to a tool that accepts one', () => {
  it('a tool accepts a key when it declares the header for one, under either name, in any case', () => {
    expect(idempotencyHeader(['xero-tenant-id', 'Idempotency-Key'])).toBe('Idempotency-Key');
    expect(idempotencyHeader(['x-idempotency-key'])).toBe('x-idempotency-key');
    expect(idempotencyHeader(['IDEMPOTENCY-KEY'])).toBe('IDEMPOTENCY-KEY');
    expect(idempotencyHeader(['Idempotency-Key-Version', 'X-Request-Id'])).toBeNull();
    expect(idempotencyHeader([])).toBeNull();
  });

  describe('the call', () => {
    const executor = new ToolHttpExecutor(
      { applyApiAuth: jest.fn(), applyInlineToolAuth: jest.fn() } as any,
      fakeRepository<any>([{ id: 'org-1', settings: {} }]) as any,
    );
    const api = { id: 'api-pay', organizationId: 'org-1', baseUrl: 'https://api.pay.example', headers: {}, timeoutMs: 1000 } as any;
    const tool = { id: 'tool-1', name: 'pay_create_charge', organizationId: 'org-1', status: ToolStatus.ACTIVE, type: ToolType.API, configuration: {} } as any;
    const KEY = 'run-1:3:0';

    beforeEach(() => {
      mockedAxios.mockReset();
      mockedAxios.mockResolvedValue({ status: 200, data: { id: 'ch_1' }, headers: {} });
    });

    it('sends the key as the declared header, in place of anything the model put there', async () => {
      await executor.executeRestOperation(tool, createCharge, api, { amount: 4000, currency: 'eur', 'Idempotency-Key': 'made-up' }, { idempotencyKey: KEY } as any);

      const config = mockedAxios.mock.calls[0][0];
      expect(config.headers['Idempotency-Key']).toBe(KEY);
      expect(Object.keys(config.headers).filter((h) => h.toLowerCase() === 'idempotency-key')).toEqual(['Idempotency-Key']);
      expect(config.data).toEqual({ amount: 4000, currency: 'eur' });
    });

    it('the same key on every attempt: a retried call is the same request to the API', async () => {
      await executor.executeRestOperation(tool, createCharge, api, { amount: 4000, currency: 'eur' }, { idempotencyKey: KEY } as any);
      await executor.executeRestOperation(tool, createCharge, api, { amount: 4000, currency: 'eur' }, { idempotencyKey: KEY } as any);
      expect(mockedAxios.mock.calls.map(([config]) => config.headers['Idempotency-Key'])).toEqual([KEY, KEY]);
    });

    it('sends no key to an operation that declares no header for one', async () => {
      await executor.executeRestOperation(tool, createRefund, api, { amount: 4000, currency: 'eur' }, { idempotencyKey: KEY } as any);
      const config = mockedAxios.mock.calls[0][0];
      expect(Object.keys(config.headers).some((h) => /idempotency/i.test(h))).toBe(false);
    });

    it('a call made outside a run step (no key) sends what the caller gave, as before', async () => {
      await executor.executeRestOperation(tool, createCharge, api, { amount: 4000, currency: 'eur', 'Idempotency-Key': 'callers-own' }, {} as any);
      expect(mockedAxios.mock.calls[0][0].headers['Idempotency-Key']).toBe('callers-own');
    });

    it('an HTTP tool whose config sets the header gets the key in it', async () => {
      const httpTool = {
        ...tool,
        id: 'tool-2',
        type: ToolType.ACTION,
        httpConfig: { method: 'POST', path: 'https://api.pay.example/v1/payouts', headers: { 'X-Idempotency-Key': '{{key}}' } },
      } as any;
      await executor.executeHttpConfig(httpTool, { amount: 10, key: 'from-the-model' }, { idempotencyKey: KEY } as any);
      expect(mockedAxios.mock.calls[0][0].headers['X-Idempotency-Key']).toBe(KEY);

      mockedAxios.mockClear();
      const plain = { ...httpTool, httpConfig: { ...httpTool.httpConfig, headers: {} } };
      await executor.executeHttpConfig(plain, { amount: 10 }, { idempotencyKey: KEY } as any);
      expect(Object.keys(mockedAxios.mock.calls[0][0].headers).some((h) => /idempotency/i.test(h))).toBe(false);
    });
  });
});
