// The resolver is the attacker's: every `.test` name answers with loopback.
jest.mock('dns', () => ({ ...jest.requireActual('dns'), lookup: jest.fn() }));

import * as dns from 'dns';
import * as http from 'http';
import { AddressInfo } from 'net';
import { BadRequestException } from '@nestjs/common';

import { ApiConnectService, LINK_NOT_A_DESCRIPTION, LINK_PRIVATE } from '../api-connect.service';
import { ApisImportHelper } from '../apis-import.helper';

/**
 * POST /apis/import fetches whatever link is pasted, and asks a GraphQL
 * endpoint to introspect itself when the link is not a document. Both
 * requests are made by the API process, so both must be held to the egress
 * gate -- against a real HTTP server standing in for an internal service
 * (it listens on 127.0.0.1), with hostile DNS pointing public-looking
 * names at it.
 */
const OPENAPI = JSON.stringify({
  openapi: '3.0.0',
  info: { title: 'Internal admin', version: '1' },
  paths: { '/users': { get: { responses: { '200': { description: 'ok' } } } } },
});

let hits = 0;
let server: http.Server;
let port: number;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    hits++;
    if (req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"data":{"__schema":{}}}');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(OPENAPI);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const realLookup = jest.requireActual('dns').lookup;
beforeEach(() => {
  hits = 0;
  (dns.lookup as unknown as jest.Mock).mockImplementation((hostname: string, options: any, callback?: any) => {
    const cb = typeof options === 'function' ? options : callback;
    const opts = typeof options === 'object' && options ? options : {};
    if (!hostname.endsWith('.test')) return realLookup(hostname, options, callback);
    process.nextTick(() => (opts.all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4)));
  });
});
afterEach(() => (dns.lookup as unknown as jest.Mock).mockReset());

function service() {
  const helper = new ApisImportHelper(null as any, null as any, null as any, null as any, null as any, null as any, null as any);
  return { helper, connect: new ApiConnectService({} as any, {} as any, helper) };
}

async function refusal(promise: Promise<unknown>): Promise<any> {
  const err = await promise.then(() => null, (e) => e);
  expect(err).toBeInstanceOf(BadRequestException);
  return err.getResponse();
}

describe('POST /apis/import against an internal address', () => {
  it('refuses a link whose name resolves to loopback, and neither the document fetch nor the introspection reaches it', async () => {
    const body = await refusal(service().connect.describe({ url: `http://docs.rebind.test:${port}/openapi.json` }));
    expect(body.message).toBe(LINK_NOT_A_DESCRIPTION);
    expect(hits).toBe(0);
  });

  it.each([
    `http://127.0.0.1:${0}/openapi.json`,
    'http://169.254.169.254/latest/meta-data/',
    'http://2130706433/',
    'http://[::ffff:127.0.0.1]/',
    'http://0x7f000001/',
  ])('refuses %s by the string gate, before any request', async (link) => {
    const body = await refusal(service().connect.describe({ url: link.replace(':0/', `:${port}/`) }));
    expect(JSON.stringify(body)).toContain(LINK_PRIVATE);
    expect(hits).toBe(0);
  });

  it.each(['file:///etc/passwd', 'gopher://127.0.0.1:6379/_INFO', 'ftp://example.com/spec.json'])(
    'refuses the %s scheme',
    async (link) => {
      await refusal(service().connect.describe({ url: link }));
      expect(hits).toBe(0);
    },
  );
});

describe('the schema fetch says nothing about what answered', () => {
  it.each([
    ['fetchSchemaFromUrl', (h: ApisImportHelper, u: string) => h.fetchSchemaFromUrl(u)],
    ['fetchGraphQLIntrospection', (h: ApisImportHelper, u: string) => h.fetchGraphQLIntrospection(u)],
  ])('%s', async (_name, call) => {
    const body = await refusal(call(service().helper, `http://docs.rebind.test:${port}/openapi.json`));
    expect(hits).toBe(0);
    expect(JSON.stringify(body)).not.toMatch(/127\.0\.0\.1|ECONN|resolved to|SSRF|status code/);
    expect(JSON.stringify(body)).toContain('the endpoint could not be reached');
  });
});
