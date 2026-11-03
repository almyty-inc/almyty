import axios from 'axios';

import { ToolHttpExecutor } from '../executors/tool-http.executor';
import { OpenAPIParserService } from '../../schema-parser/parsers/openapi-parser.service';
import { translateOpenAPIOperationInput } from '../../json-schema-translator/protocol-translators.helper';
import { ToolStatus, ToolType } from '../../../entities/tool.entity';
import { fakeRepository } from '../../../test/fake-repository';

jest.mock('axios', () => {
  const fn: any = jest.fn();
  fn.isAxiosError = () => false;
  return { __esModule: true, default: fn, isAxiosError: () => false };
});

const mockedAxios = axios as unknown as jest.Mock;

/**
 * Stripe Search (GET /v1/customers/search) takes its search in a query
 * parameter literally named `query`, and Stripe's description gives every
 * GET an empty form body. The parameter was read as the grouped
 * `{ query: {...} }` shape and its string spread over the query string one
 * character per parameter (`0=e&1=m&2=a...`). This drives the operation as
 * the OpenAPI parser imports it from Stripe's own description.
 */
const STRIPE_FRAGMENT = {
  openapi: '3.0.0',
  info: { title: 'Stripe API', version: '2024-06-20' },
  servers: [{ url: 'https://api.stripe.com/' }],
  paths: {
    '/v1/customers/search': {
      get: {
        operationId: 'GetCustomersSearch',
        summary: 'Search customers',
        description: '<p>Search for customers you’ve previously created using Stripe’s <a href="/docs/search#search-query-language">Search Query Language</a>.</p>',
        parameters: [
          { description: 'Specifies which fields in the response should be expanded.', explode: true, in: 'query', name: 'expand', required: false, schema: { items: { maxLength: 5000, type: 'string' }, type: 'array' }, style: 'deepObject' },
          { description: 'A limit on the number of objects to be returned.', in: 'query', name: 'limit', required: false, schema: { type: 'integer' }, style: 'form' },
          { description: 'A cursor for pagination across multiple pages of results.', in: 'query', name: 'page', required: false, schema: { maxLength: 5000, type: 'string' }, style: 'form' },
          { description: 'The search query string.', in: 'query', name: 'query', required: true, schema: { maxLength: 5000, type: 'string' }, style: 'form' },
        ],
        requestBody: {
          content: { 'application/x-www-form-urlencoded': { encoding: {}, schema: { additionalProperties: false, properties: {}, type: 'object' } } },
          required: false,
        },
        responses: { '200': { description: 'Successful response.', content: { 'application/json': { schema: { type: 'object' } } } } },
      },
    },
    '/v1/refunds': {
      post: {
        operationId: 'PostRefunds',
        summary: 'Create customer balance refund',
        requestBody: {
          content: {
            'application/x-www-form-urlencoded': {
              encoding: { metadata: { explode: true, style: 'deepObject' } },
              schema: {
                additionalProperties: false,
                properties: { amount: { type: 'integer' }, charge: { maxLength: 5000, type: 'string' }, metadata: { type: 'object' }, reason: { type: 'string' } },
                type: 'object',
              },
            },
          },
          required: false,
        },
        responses: { '200': { description: 'Successful response.', content: { 'application/json': { schema: { type: 'object' } } } } },
      },
    },
  },
};

describe('Stripe Search: a parameter named query', () => {
  const executor = new ToolHttpExecutor(
    { applyApiAuth: jest.fn(), applyInlineToolAuth: jest.fn() } as any,
    fakeRepository<any>([{ id: 'org-1', settings: {} }]) as any,
  );
  const api = { id: 'api-1', organizationId: 'org-1', baseUrl: 'https://api.stripe.com/', headers: {}, timeoutMs: 1000 } as any;
  const tool = { id: 'tool-1', name: 'stripe_get_customers_search', organizationId: 'org-1', status: ToolStatus.ACTIVE, type: ToolType.API, configuration: {} } as any;

  let operation: any;
  beforeAll(async () => {
    const parsed = await new OpenAPIParserService().parseSchema(JSON.stringify(STRIPE_FRAGMENT));
    operation = parsed.operations.find((o: any) => o.endpoint === '/v1/customers/search');
  });

  beforeEach(() => {
    mockedAxios.mockReset();
    mockedAxios.mockResolvedValue({ status: 200, data: { object: 'search_result', data: [] }, headers: {} });
  });

  const serialized = () => {
    const config = mockedAxios.mock.calls[0][0];
    return { url: config.url, query: config.paramsSerializer(config.params), data: config.data };
  };

  it('sends the search as one query parameter, the way the model calls it', async () => {
    await executor.executeRestOperation(tool, operation, api, { query: "email:'dana@acme.example'", limit: 5 }, {} as any);

    const sent = serialized();
    expect(sent.url).toBe('https://api.stripe.com/v1/customers/search');
    expect(sent.query).toBe(`query=${encodeURIComponent("email:'dana@acme.example'")}&limit=5`);
    expect(sent.query).not.toMatch(/(^|&)0=/);
    expect(sent.data).toBeUndefined();
  });

  it('also when the call is grouped by where each argument goes', async () => {
    await executor.executeRestOperation(tool, operation, api, { query: { query: "name~:'acme'", limit: 3 } }, {} as any);

    expect(serialized().query).toBe(`query=${encodeURIComponent("name~:'acme'")}&limit=3`);
  });

  it('the tool offers query, limit, page and expand as its inputs', () => {
    const schema = translateOpenAPIOperationInput(operation);
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual(['expand', 'limit', 'page', 'query']);
    expect(schema.required).toEqual(['query']);
  });

  // Stripe's writes take a form body; sent as JSON, Stripe read no
  // parameters and refused the refund for a missing charge.
  it('sends a refund as a form, nested the way Stripe reads it', async () => {
    const parsed = await new OpenAPIParserService().parseSchema(JSON.stringify(STRIPE_FRAGMENT));
    const refunds = parsed.operations.find((o: any) => o.endpoint === '/v1/refunds');
    await executor.executeRestOperation(tool, refunds as any, api, { charge: 'ch_3Pq', amount: 2500, metadata: { invoice: 'INV-0917' } }, {} as any);

    const config = mockedAxios.mock.calls[0][0];
    expect(config.url).toBe('https://api.stripe.com/v1/refunds');
    expect(config.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(config.data).toBe('charge=ch_3Pq&amount=2500&metadata%5Binvoice%5D=INV-0917');
  });
});
