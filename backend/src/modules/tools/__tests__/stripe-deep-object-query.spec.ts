import axios from 'axios';
import { readFileSync } from 'fs';
import { join } from 'path';

import { ToolHttpExecutor } from '../executors/tool-http.executor';
import { serializeQueryParams } from '../tool-execution-utils';
import { OpenAPIParserService } from '../../schema-parser/parsers/openapi-parser.service';
import { detectApiSchema } from '../../schema-parser/schema-detect';
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
 * Stripe filters lists by ranges written in brackets: `created[gte]=...`,
 * `arrival_date[lt]=...`. Its description declares them as query
 * parameters with `style: deepObject` whose schema is an object (in an
 * anyOf with a bare integer). The tool takes the range as an object and
 * the call writes it back in brackets. The fixture is a trimmed copy of
 * Stripe's published spec3 (two list operations, verbatim parameters).
 */
const STRIPE = readFileSync(join(__dirname, '../../schema-parser/__fixtures__/stripe-payouts-trimmed.json'), 'utf8');

async function stripeOperation(operationId: string) {
  const parsed = await new OpenAPIParserService().parseSchema(STRIPE);
  const op = parsed.operations.find((o: any) => o.operationId === operationId);
  if (!op) throw new Error(`no ${operationId}`);
  return op as any;
}

describe('Stripe deepObject query parameters', () => {
  it('reads arrival_date and created as object parameters with their range keys', async () => {
    const op = await stripeOperation('GetPayouts');
    expect(op.parameters.query.arrival_date).toMatchObject({
      type: 'object',
      style: 'deepObject',
      properties: { gt: { type: 'integer' }, gte: { type: 'integer' }, lt: { type: 'integer' }, lte: { type: 'integer' } },
    });
    // The same range through a $ref.
    expect(op.parameters.query.created).toMatchObject({ type: 'object', style: 'deepObject', properties: { gte: { type: 'integer' } } });
    expect(op.parameters.query.expand).toMatchObject({ type: 'array', items: { type: 'string' }, style: 'deepObject' });
    expect(op.parameters.query.limit).toMatchObject({ type: 'integer' });

    // What the model is shown: an object with gte/lt, not a string.
    const input = translateOpenAPIOperationInput(op) as any;
    expect(input.properties.arrival_date.type).toBe('object');
    expect(Object.keys(input.properties.arrival_date.properties)).toEqual(['gt', 'gte', 'lt', 'lte']);
  });

  it('sends the range as arrival_date[gte]=...&arrival_date[lt]=...', async () => {
    const op = await stripeOperation('GetPayouts');
    const qs = serializeQueryParams(
      { arrival_date: { gte: 1696204800, lt: 1698796800 }, limit: 10, expand: ['data.destination'], status: 'paid' },
      op.parameters.query,
    );
    expect(qs).toBe('arrival_date[gte]=1696204800&arrival_date[lt]=1698796800&limit=10&expand[]=data.destination&status=paid');
  });

  it('calls Stripe with the brackets from a tool call', async () => {
    const op = await stripeOperation('GetBalanceTransactions');
    mockedAxios.mockReset();
    mockedAxios.mockResolvedValue({ status: 200, data: { data: [] }, headers: {} });
    const executor = new ToolHttpExecutor({ applyApiAuth: jest.fn(), applyInlineToolAuth: jest.fn() } as any, fakeRepository<any>([]) as any);
    const tool = { id: 't-1', name: 'list_balance_transactions', organizationId: 'org-1', status: ToolStatus.ACTIVE, type: ToolType.API, configuration: {} } as any;
    const api = { id: 'api-1', organizationId: 'org-1', baseUrl: 'https://api.stripe.com/', headers: {}, timeoutMs: 1000 } as any;
    // A model sometimes sends the object as JSON text: it is read as the object.
    await executor.executeRestOperation(tool, { ...op, method: 'GET' }, api, { created: '{"gte": 1696204800}', type: 'payout' }, {} as any);
    const config = mockedAxios.mock.calls[0][0];
    expect(config.url).toBe('https://api.stripe.com/v1/balance_transactions');
    expect(config.paramsSerializer(config.params)).toBe('created[gte]=1696204800&type=payout');
  });

  it('folds bracket-named parameters (created[gte], created[lt]) into one object parameter', async () => {
    const doc = {
      openapi: '3.0.0',
      info: { title: 'Brackets', version: '1' },
      servers: [{ url: 'https://api.example.com' }],
      paths: {
        '/charges': {
          get: {
            operationId: 'listCharges',
            parameters: [
              { name: 'created[gte]', in: 'query', description: 'Created at or after', schema: { type: 'integer' } },
              { name: 'created[lt]', in: 'query', schema: { type: 'integer' } },
              { name: 'limit', in: 'query', schema: { type: 'integer' } },
            ],
            responses: { '200': { description: 'ok' } },
          },
        },
      },
    };
    const parsed = await new OpenAPIParserService().parseSchema(JSON.stringify(doc));
    const op: any = parsed.operations[0];
    expect(Object.keys(op.parameters.query)).toEqual(['created', 'limit']);
    expect(op.parameters.query.created).toMatchObject({ type: 'object', style: 'deepObject', properties: { gte: { type: 'integer' }, lt: { type: 'integer' } } });
    expect(serializeQueryParams({ created: { gte: 1, lt: 2 }, limit: 3 }, op.parameters.query)).toBe('created[gte]=1&created[lt]=2&limit=3');
  });

  it('serialises the other OpenAPI styles as the spec says', () => {
    // form + explode (the default): properties become parameters.
    expect(serializeQueryParams({ point: { x: 1, y: 2 } }, { point: { type: 'object' } })).toBe('x=1&y=2');
    // form, explode false: one comma list.
    expect(serializeQueryParams({ point: { x: 1, y: 2 }, ids: [1, 2] }, { point: { style: 'form', explode: false }, ids: { explode: false } })).toBe('point=x,1,y,2&ids=1,2');
    // Undeclared: arrays repeat the name, objects go in brackets, scalars as they are.
    expect(serializeQueryParams({ tag: ['a b', 'c'], q: 'x&y', filter: { status: ['paid'] } })).toBe('tag=a%20b&tag=c&q=x%26y&filter[status][]=paid');
    expect(serializeQueryParams({ skip: undefined, none: null, n: 0 })).toBe('n=0');
  });
});

describe('Stripe sign-in from its description', () => {
  it('uses the bearer token Stripe offers next to basic auth', () => {
    expect(detectApiSchema(STRIPE).auth).toEqual({ type: 'bearer' });
  });
});
