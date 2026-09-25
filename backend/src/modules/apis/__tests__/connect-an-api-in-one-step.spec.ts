import 'reflect-metadata';
import { readFileSync } from 'fs';
import { join } from 'path';
import axios from 'axios';
import { BadRequestException, ConflictException } from '@nestjs/common';

import { ApisController } from '../apis.controller';
import { ApisService } from '../apis.service';
import { ApisImportHelper } from '../apis-import.helper';
import { ApiConnectService, LINK_NOT_A_DESCRIPTION, LINK_PRIVATE } from '../api-connect.service';
import { ApiQuotaExceededException } from '../api-quota';
import { Api, ApiStatus, ApiType } from '../../../entities/api.entity';
import { Organization } from '../../../entities/organization.entity';
import { fakeManager, fakeRepository, FakeRepository } from '../../../test/fake-repository';
import { ROLES_KEY } from '../../auth/decorators/roles.decorator';

/**
 * POST /apis/import: one box instead of the old two-step form. The link,
 * file or pasted text is read, recognised, and becomes an API with what
 * the description says, and the import job is queued -- in one call.
 *
 * Real ApisService (org lookup, name check, quota lock), real connect
 * service and detector, real import helper with only the network (axios)
 * standing in; repositories are the truthful in-memory fakes.
 */
const fixture = (name: string) =>
  readFileSync(join(__dirname, '..', '..', 'schema-parser', '__fixtures__', name), 'utf8');

const ORG = 'org-1';
const OTHER_ORG = 'org-2';

function setup(opts: { maxApis?: number } = {}) {
  const apis: FakeRepository<Api> = fakeRepository<Api>({ make: () => new Api(), idPrefix: 'api' });
  const orgs = fakeRepository<Organization>({
    make: () => new Organization(),
    seed: [
      { id: ORG, settings: opts.maxApis ? { maxApis: opts.maxApis } : {} } as any,
      { id: OTHER_ORG, settings: {} } as any,
    ],
  });
  const manager: any = fakeManager([[Api, apis], [Organization, orgs]]);
  // The quota takes an advisory lock inside the transaction.
  manager.queryRunner = { isTransactionActive: true };
  manager.query = jest.fn(async () => []);

  const audit = { logCreate: jest.fn(), logUpdate: jest.fn(), logDelete: jest.fn() };
  const accessPolicy = {
    assertCanScopeToTeam: jest.fn(),
    canAccess: jest.fn(async () => ({ allowed: true })),
  };
  const importHelper = new ApisImportHelper(null as any, null as any, null as any, null as any, null as any, null as any, null as any);
  const apisService = new ApisService(
    apis as any, {} as any, {} as any, {} as any, orgs as any, {} as any, {} as any,
    audit as any, {} as any, importHelper, {} as any, accessPolicy as any, {} as any,
  );
  const connect = new ApiConnectService(apis as any, apisService, importHelper);
  const queued: any[] = [];
  const queue = {
    add: jest.fn(async (_name: string, data: any, _opts: any) => {
      queued.push(data);
      return { id: `job-${queued.length}`, data };
    }),
  };
  const controller = new ApisController(apisService, {} as any, queue as any, connect);
  const req = { user: { id: 'user-1', currentOrganizationId: ORG } };
  return { apis, controller, queue, queued, req };
}

const file = (name: string) => ({ buffer: Buffer.from(fixture(name)), originalname: name });

afterEach(() => jest.restoreAllMocks());

describe('POST /apis/import', () => {
  it('is for admins and owners, like creating an API', () => {
    expect(Reflect.getMetadata(ROLES_KEY, ApisController.prototype.connect)).toEqual(['admin', 'owner']);
  });

  it('creates the API from an uploaded OpenAPI file with what the file says, and queues its import with tools on', async () => {
    const { controller, apis, queued, req } = setup();

    const res = await controller.connect(req, {} as any, file('openapi3-petstore.json'));

    const [row] = apis.rows();
    expect(row).toMatchObject({
      organizationId: ORG,
      ownerUserId: 'user-1',
      name: 'Petstore',
      type: ApiType.OPENAPI,
      baseUrl: 'https://petstore.example.com/v2',
      version: '2.1.0',
      description: 'Pets you can list, add and look up.',
      status: ApiStatus.DRAFT,
      authentication: { type: 'api_key', config: { headerName: 'X-Pets-Key', location: 'header' } },
    });
    expect(queued).toEqual([
      {
        apiId: row.id,
        organizationId: ORG,
        schemaContent: fixture('openapi3-petstore.json'),
        options: { fileName: 'openapi3-petstore.json', generateTools: true, createdBy: 'user-1' },
      },
    ]);
    expect(res.data).toMatchObject({ jobId: 'job-1', needs: { key: true, address: false } });
    expect(res.data.detected).toMatchObject({ type: ApiType.OPENAPI, format: 'openapi3' });
    expect(res.data.detected).not.toHaveProperty('content');
  });

  it('reads a GraphQL endpoint link by asking it to describe itself, and queues SDL', async () => {
    const { controller, apis, queued, req } = setup();
    const get = jest.spyOn(axios, 'get').mockRejectedValue(new Error('Request failed with status code 400'));
    const post = jest.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: JSON.parse(fixture('countries-introspection.json')) } as any);

    const res = await controller.connect(req, { url: 'https://countries.example.com/graphql' } as any);

    expect(get).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][0]).toBe('https://countries.example.com/graphql');
    expect((post.mock.calls[0][1] as any).query).toContain('__schema');
    expect(apis.rows()[0]).toMatchObject({ type: ApiType.GRAPHQL, name: 'countries.example.com', baseUrl: 'https://countries.example.com/graphql' });
    expect(queued[0].schemaContent).toContain('type Query');
    expect(res.data.needs).toEqual({ key: false, address: false });
  });

  it('takes pasted WSDL, and "don\'t make tools" reaches the job', async () => {
    const { controller, apis, queued, req } = setup();

    await controller.connect(req, { content: fixture('temperature.wsdl'), generateTools: false } as any);

    expect(apis.rows()[0]).toMatchObject({ type: ApiType.SOAP, baseUrl: 'https://temperature.example.com/TempConvert.asmx' });
    expect(queued[0].options.generateTools).toBe(false);
  });

  it('says when the address is missing, and takes it from Advanced when given', async () => {
    const first = setup();
    const res = await first.controller.connect(first.req, { content: fixture('greeter.proto') } as any);
    expect(res.data.needs).toEqual({ key: false, address: true });
    expect(first.apis.rows()[0].baseUrl).toBe('');

    const second = setup();
    const res2 = await second.controller.connect(second.req, { content: fixture('greeter.proto'), baseUrl: 'https://greeter.example.com', name: 'Hello service' } as any);
    expect(res2.data.needs.address).toBe(false);
    expect(second.apis.rows()[0]).toMatchObject({ name: 'Hello service', baseUrl: 'https://greeter.example.com', type: ApiType.GRPC });
  });

  it('lets Advanced override the sign-in type the description declares', async () => {
    const { controller, apis, req } = setup();
    const res = await controller.connect(req, { content: fixture('openapi3-petstore.json'), authType: 'bearer' } as any);
    expect(apis.rows()[0].authentication).toEqual({ type: 'bearer', config: {} });
    expect(res.data.needs.key).toBe(true);
  });

  it('refuses what it cannot read, in plain words, and creates and queues nothing', async () => {
    const { controller, apis, queue, req } = setup();

    await expect(controller.connect(req, { content: fixture('garbage.html') } as any)).rejects.toThrow(
      "We couldn't read this as OpenAPI, GraphQL, WSDL or proto.",
    );
    await expect(controller.connect(req, {} as any, file('not-an-api.json'))).rejects.toBeInstanceOf(BadRequestException);
    expect(apis.rows()).toHaveLength(0);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('says so when a link returns a page that is not a description and is no GraphQL endpoint', async () => {
    const { controller, apis, req } = setup();
    jest.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: fixture('garbage.html') } as any);
    jest.spyOn(axios, 'post').mockRejectedValue(new Error('Request failed with status code 405'));

    await expect(controller.connect(req, { url: 'https://www.example.com/' } as any)).rejects.toThrow(LINK_NOT_A_DESCRIPTION);
    expect(apis.rows()).toHaveLength(0);
  });

  it('never fetches a private or local address', async () => {
    const { controller, req } = setup();
    const get = jest.spyOn(axios, 'get');
    const post = jest.spyOn(axios, 'post');

    await expect(controller.connect(req, { url: 'http://127.0.0.1:6379/' } as any)).rejects.toThrow(LINK_PRIVATE);
    await expect(controller.connect(req, { url: 'http://169.254.169.254/latest/meta-data' } as any)).rejects.toThrow(LINK_PRIVATE);
    expect(get).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it('numbers a name read from the description when this organization has it already, not when another one does', async () => {
    const { controller, apis, req } = setup();
    apis.seed({ id: 'theirs', organizationId: OTHER_ORG, name: 'Petstore', type: ApiType.OPENAPI, baseUrl: '' } as any);

    await controller.connect(req, { content: fixture('openapi3-petstore.json') } as any);
    await controller.connect(req, { content: fixture('openapi3-petstore.json') } as any);

    const ours = apis.rows().filter((a) => a.organizationId === ORG).map((a) => a.name).sort();
    expect(ours).toEqual(['Petstore', 'Petstore 2']);
  });

  it('refuses a typed name that is taken, as creating an API always has', async () => {
    const { controller, apis, req } = setup();
    apis.seed({ id: 'mine', organizationId: ORG, name: 'Billing', type: ApiType.OPENAPI, baseUrl: '' } as any);
    await expect(
      controller.connect(req, { content: fixture('openapi3-petstore.json'), name: 'Billing' } as any),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('holds the organization API limit under its lock, and queues nothing when full', async () => {
    const { controller, apis, queue, req } = setup({ maxApis: 1 });
    apis.seed({ id: 'existing', organizationId: ORG, name: 'Existing', type: ApiType.OPENAPI, baseUrl: '' } as any);

    await expect(controller.connect(req, { content: fixture('openapi3-petstore.json') } as any)).rejects.toBeInstanceOf(
      ApiQuotaExceededException,
    );
    expect(apis.rows().map((a) => a.id)).toEqual(['existing']);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('needs an organization in the session', async () => {
    const { controller } = setup();
    await expect(controller.connect({ user: { id: 'user-1' } }, { content: fixture('greeter.proto') } as any)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('takes the API back out when the import cannot be queued', async () => {
    const { controller, apis, queue, req } = setup();
    queue.add.mockRejectedValueOnce(new Error('redis is down'));
    await expect(controller.connect(req, { content: fixture('greeter.proto') } as any)).rejects.toThrow('redis is down');
    expect(apis.rows()).toHaveLength(0);
  });
});

describe('POST /apis/:id/import-schema (updating the description)', () => {
  it('reads a GraphQL endpoint link here too', async () => {
    const { controller, apis, queued, req } = setup();
    apis.seed({ id: 'gql', organizationId: ORG, name: 'Countries', type: ApiType.GRAPHQL, baseUrl: 'https://countries.example.com/graphql', operations: [] } as any);
    jest.spyOn(axios, 'get').mockRejectedValue(new Error('Request failed with status code 400'));
    jest.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: JSON.parse(fixture('countries-introspection.json')) } as any);

    await controller.importSchema(req, 'gql', { schemaUrl: 'https://countries.example.com/graphql' } as any);

    expect(queued[0]).toMatchObject({ apiId: 'gql', organizationId: ORG });
    expect(queued[0].schemaContent).toContain('type Query');
  });

  it('refuses a description of another kind in words', async () => {
    const { controller, apis, queue, req } = setup();
    apis.seed({ id: 'pets', organizationId: ORG, name: 'Petstore', type: ApiType.OPENAPI, baseUrl: '', operations: [] } as any);

    await expect(controller.importSchema(req, 'pets', { schemaContent: fixture('temperature.wsdl') } as any)).rejects.toThrow(
      'This is a SOAP description, but Petstore is an OpenAPI API.',
    );
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('does not reach an API of another organization', async () => {
    const { controller, apis, req } = setup();
    apis.seed({ id: 'theirs', organizationId: OTHER_ORG, name: 'Theirs', type: ApiType.OPENAPI, baseUrl: '', operations: [] } as any);
    await expect(controller.importSchema(req, 'theirs', { schemaContent: fixture('openapi3-petstore.json') } as any)).rejects.toThrow(
      'API not found',
    );
  });
});
