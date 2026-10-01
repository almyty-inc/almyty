/**
 * A GraphQL, SOAP or gRPC tool made on the Create tool page runs.
 *
 * The page used to save these kinds as generated JavaScript (axios, the
 * `soap` package, `require('@grpc/grpc-js')` with the proto text passed
 * as a file path). The executor sends `code` to the sandbox, which has
 * none of those, so every such tool failed on its first call. The page
 * now sends the protocol's config, the one shape the protocol executor
 * runs; this spec takes exactly that payload through the create path
 * (the controller's ValidationPipe and ToolsService.createTool) and runs
 * the stored tool through ToolExecutorService.executeTool against a real
 * server of each kind on loopback.
 *
 * Loopback is private, so the organization has 127.0.0.1 on its egress
 * allowlist: the calls go out through the same guarded egress a tool of
 * any kind uses (decideToolEgress), not around it.
 */
import * as http from 'http';
import { AddressInfo } from 'net';
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { Server, ServerCredentials, loadPackageDefinition, Metadata } from '@grpc/grpc-js';
import { fromJSON } from '@grpc/proto-loader';
import * as protobuf from 'protobufjs';

import { ToolsService } from '../tools.service';
import { ToolExecutorService } from '../tool-executor.service';
import { ToolHttpExecutor } from '../executors/tool-http.executor';
import { ToolProtocolExecutor } from '../executors/tool-protocol.executor';
import { ToolGrpcExecutor } from '../executors/tool-grpc.executor';
import { GrpcCallerService } from '../executors/grpc-caller.service';
import { CreateToolBodyDto } from '../dto/tools-controller.dto';
import { Tool } from '../../../entities/tool.entity';
import { fakeRepository } from '../../../test/fake-repository';
import { unlimitedToolQuotaManager } from '../../../test/tool-quota.fake';
import { membershipFixture } from '../../../test/execution-access.fixture';

jest.setTimeout(20_000);

const ORG = 'org-1';
const USER = 'user-1';

const ECHO_PROTO = `
syntax = "proto3";
package echo;

service EchoService {
  rpc Echo(EchoRequest) returns (EchoResponse);
  rpc Stream(EchoRequest) returns (stream EchoResponse);
}

message EchoRequest {
  string text = 1;
  int32 times = 2;
}

message EchoResponse {
  string repeated = 1;
}
`;

/** What the Create tool page sends for each kind (frontend tool-form.tsx). */
function formPayload(kind: 'graphql' | 'soap' | 'grpc', config: Record<string, any>, parameters: any): Record<string, any> {
  const base = {
    name: `${kind}_tool`,
    description: `A hand-made ${kind} tool`,
    type: kind === 'graphql' ? 'query' : 'function',
    parameters,
    executionMethod: kind,
    authConfig: { type: 'bearer', config: { credentialId: 'cred-1' } },
    visibility: 'org',
    teamId: null,
  };
  return { ...base, [`${kind}Config`]: config };
}

describe('Hand-made GraphQL, SOAP and gRPC tools run end to end', () => {
  let gqlServer: http.Server;
  let soapServer: http.Server;
  let grpcServer: Server;
  let gqlUrl: string;
  let soapUrl: string;
  let grpcUrl: string;
  const seen: { gql: any[]; soap: any[]; grpc: any[] } = { gql: [], soap: [], grpc: [] };

  let tools: ReturnType<typeof fakeRepository<Tool>>;
  let toolsService: ToolsService;
  let executor: ToolExecutorService;

  beforeAll(async () => {
    // GraphQL: `user(id: Int!)` answers one known user, anything else is a GraphQL error.
    gqlServer = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const body = JSON.parse(raw || '{}');
        seen.gql.push({ body, auth: req.headers.authorization });
        res.writeHead(200, { 'content-type': 'application/json' });
        if (body.variables?.id === 7) {
          res.end(JSON.stringify({ data: { user: { id: 7, name: 'Ada Lovelace' } } }));
        } else {
          res.end(JSON.stringify({ data: { user: null }, errors: [{ message: `No user ${body.variables?.id}` }] }));
        }
      });
    });
    // SOAP: CelsiusToFahrenheit, the w3schools TempConvert shape.
    soapServer = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        seen.soap.push({ body: raw, action: req.headers.soapaction, auth: req.headers.authorization });
        const c = /<Celsius>([^<]*)<\/Celsius>/.exec(raw)?.[1];
        res.writeHead(200, { 'content-type': 'text/xml; charset=utf-8' });
        res.end(
          `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>` +
            `<CelsiusToFahrenheitResponse xmlns="https://www.w3schools.com/xml/"><CelsiusToFahrenheitResult>${Number(c) * 1.8 + 32}</CelsiusToFahrenheitResult></CelsiusToFahrenheitResponse>` +
            `</soap:Body></soap:Envelope>`,
        );
      });
    });
    for (const s of [gqlServer, soapServer]) {
      await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
    }
    gqlUrl = `http://127.0.0.1:${(gqlServer.address() as AddressInfo).port}/graphql`;
    soapUrl = `http://127.0.0.1:${(soapServer.address() as AddressInfo).port}/TempConvert.asmx`;

    // gRPC: a real @grpc/grpc-js server speaking the proto the tool carries.
    const root = protobuf.parse(ECHO_PROTO, { keepCase: true }).root;
    const Echo = (loadPackageDefinition(fromJSON(root.toJSON(), { keepCase: true, defaults: true })) as any).echo.EchoService;
    grpcServer = new Server();
    grpcServer.addService(Echo.service, {
      Echo: (call: any, cb: any) => {
        seen.grpc.push({ request: call.request, auth: (call.metadata as Metadata).get('authorization')[0] });
        const { text = '', times = 1 } = call.request || {};
        cb(null, { repeated: Array(times).fill(text).join(' ') });
      },
      Stream: (call: any) => {
        const { text = '', times = 1 } = call.request || {};
        for (let i = 0; i < times; i++) call.write({ repeated: `${text}-${i}` });
        call.end();
      },
    });
    const grpcPort = await new Promise<number>((resolve, reject) =>
      grpcServer.bindAsync('127.0.0.1:0', ServerCredentials.createInsecure(), (err, p) => (err ? reject(err) : resolve(p))),
    );
    grpcUrl = `http://127.0.0.1:${grpcPort}`;
  });

  afterAll(async () => {
    await Promise.all([
      ...[gqlServer, soapServer].map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
      new Promise<void>((resolve) => grpcServer.tryShutdown(() => resolve())),
    ]);
  });

  beforeEach(() => {
    seen.gql = [];
    seen.soap = [];
    seen.grpc = [];

    const organizations = fakeRepository<any>([{ id: ORG, settings: { egressAllowlist: ['127.0.0.1'] } }]);
    tools = fakeRepository<Tool>({ make: () => new Tool(), idPrefix: 'tool' });
    Object.defineProperty(tools, 'manager', { get: () => unlimitedToolQuotaManager(tools) });
    const user = {
      id: USER,
      hasPermissionInOrganization: () => true,
      organizationMemberships: [{ organizationId: ORG, role: 'member' }],
    };
    const users = { findOne: jest.fn().mockResolvedValue(user) };

    toolsService = new ToolsService(
      tools as any,
      { create: jest.fn((v) => v), save: jest.fn(async (v) => v) } as any, // versions
      { find: jest.fn().mockResolvedValue([]) } as any, // categories
      {} as any, // executions
      fakeRepository<any>([]) as any, // apis
      fakeRepository<any>([]) as any, // operations
      {} as any, // api schemas
      users as any,
      organizations as any,
      { logCreate: jest.fn(), logUpdate: jest.fn(), computeChanges: jest.fn().mockReturnValue([]) } as any,
      {} as any, // operation helper
      {} as any, // stats helper
      { assertCanScopeToTeam: jest.fn().mockResolvedValue(undefined) } as any,
    );

    // The credential the tool points at, as the auth service would send it.
    const auth = {
      applyApiAuth: jest.fn(),
      applyToolAuth: jest.fn(async (config: any) => {
        config.headers = { ...(config.headers || {}), Authorization: 'Bearer from-credential' };
      }),
    } as any;
    const grpcExecutor = new ToolGrpcExecutor(auth, new GrpcCallerService(), fakeRepository<any>([]) as any, organizations as any);
    executor = new ToolExecutorService(
      tools as any,
      {} as any,
      users as any,
      {} as any,
      new ToolHttpExecutor(auth, organizations as any),
      new ToolProtocolExecutor(auth, grpcExecutor, organizations as any),
      {} as any,
      {} as any,
      {
        checkRateLimit: jest.fn().mockResolvedValue({ limited: false }),
        getCachedResult: jest.fn().mockResolvedValue(null),
        cacheResult: jest.fn(),
      } as any,
      {
        validateParameters: jest.fn().mockResolvedValue({ isValid: true, errors: [] }),
        recordExecution: jest.fn().mockResolvedValue(undefined),
      } as any,
      {} as any,
      {} as any,
      {} as any,
      { findOne: jest.fn().mockResolvedValue(null) } as any,
      undefined,
      membershipFixture().executionAccess,
    );
  });

  /** POST /tools as the dashboard sends it: validation pipe, then the service. */
  async function createViaApi(payload: Record<string, any>): Promise<Tool> {
    const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
    const dto = await pipe.transform(JSON.parse(JSON.stringify(payload)), {
      type: 'body',
      metatype: CreateToolBodyDto,
    });
    return toolsService.createTool(dto as any, ORG, USER);
  }

  const run = (toolId: string, params: Record<string, any>) =>
    executor.executeTool(toolId, params, { organizationId: ORG, userId: USER });

  describe('GraphQL', () => {
    const payload = () =>
      formPayload(
        'graphql',
        {
          endpoint: gqlUrl,
          query: 'query GetUser($id: Int!) { user(id: $id) { id name } }',
          variables: { id: '{userId}' },
        },
        { type: 'object', properties: { userId: { type: 'integer' } }, required: ['userId'] },
      );

    it('is stored as graphqlConfig and returns the data object', async () => {
      const tool = await createViaApi(payload());
      const stored = tools.row(tool.id)!;
      expect(stored.code ?? null).toBeNull();
      expect(stored.executionMethod).toBe('graphql');
      expect(stored.status).toBe('active');
      expect(stored.graphqlConfig).toEqual(expect.objectContaining({ endpoint: gqlUrl }));

      const result = await run(tool.id, { userId: 7 });

      expect(result.error).toBeUndefined();
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ user: { id: 7, name: 'Ada Lovelace' } });
      // `{userId}` as the whole value keeps the parameter's type.
      expect(seen.gql[0].body.variables).toEqual({ id: 7 });
      expect(seen.gql[0].auth).toBe('Bearer from-credential');
    });

    it('reports GraphQL errors as a failed call', async () => {
      const tool = await createViaApi(payload());
      const result = await run(tool.id, { userId: 8 });
      expect(result.success).toBe(false);
      expect(result.error).toContain('No user 8');
    });

    it('refuses the old generated-code shape', async () => {
      await expect(
        createViaApi({ ...payload(), graphqlConfig: undefined, code: 'return await axios.post(...)' }),
      ).rejects.toThrow(BadRequestException);
      expect(tools.rows()).toHaveLength(0);
    });

    it('refuses a GraphQL tool with no query', async () => {
      const p = payload();
      p.graphqlConfig = { endpoint: gqlUrl, query: '  ' } as any;
      await expect(createViaApi(p)).rejects.toThrow(/query/);
    });
  });

  describe('SOAP', () => {
    const payload = () =>
      formPayload(
        'soap',
        { endpoint: soapUrl, operation: 'CelsiusToFahrenheit', namespace: 'https://www.w3schools.com/xml/' },
        { type: 'object', properties: { Celsius: { type: 'number' } }, required: ['Celsius'] },
      );

    it('is stored as soapConfig and calls the operation with an envelope built from the parameters', async () => {
      const tool = await createViaApi(payload());
      const stored = tools.row(tool.id)!;
      expect(stored.code ?? null).toBeNull();
      expect(stored.executionMethod).toBe('soap');
      expect(stored.status).toBe('active');

      const result = await run(tool.id, { Celsius: 25 });

      expect(result.error).toBeUndefined();
      expect(result.success).toBe(true);
      expect(String(result.data)).toContain('<CelsiusToFahrenheitResult>77</CelsiusToFahrenheitResult>');
      expect(seen.soap[0].body).toContain(
        '<CelsiusToFahrenheit xmlns="https://www.w3schools.com/xml/"><Celsius>25</Celsius></CelsiusToFahrenheit>',
      );
      expect(seen.soap[0].action).toBe('https://www.w3schools.com/xml/CelsiusToFahrenheit');
      expect(seen.soap[0].auth).toBe('Bearer from-credential');
    });

    it('refuses a SOAP tool with no operation', async () => {
      const p = payload();
      p.soapConfig = { endpoint: soapUrl, operation: '', namespace: '' } as any;
      await expect(createViaApi(p)).rejects.toThrow(/operation/);
    });
  });

  describe('gRPC', () => {
    const payload = (method = 'Echo', proto = ECHO_PROTO) =>
      formPayload(
        'grpc',
        { endpoint: grpcUrl, serviceName: 'EchoService', methodName: method, protoDefinition: proto },
        { type: 'object', properties: { text: { type: 'string' }, times: { type: 'integer' } } },
      );

    it('is stored as grpcConfig with its proto and makes a real unary call', async () => {
      const tool = await createViaApi(payload());
      const stored = tools.row(tool.id)!;
      expect(stored.code ?? null).toBeNull();
      expect(stored.executionMethod).toBe('grpc');
      expect(stored.status).toBe('active');
      expect(stored.grpcConfig?.protoDefinition).toBe(ECHO_PROTO);

      const result = await run(tool.id, { text: 'ping', times: 3 });

      expect(result.error).toBeUndefined();
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ repeated: 'ping ping ping' });
      expect(seen.grpc[0].auth).toBe('Bearer from-credential');
    });

    it('reads from the proto that a method streams its response', async () => {
      const tool = await createViaApi(payload('Stream'));
      const result = await run(tool.id, { text: 'tick', times: 2 });
      expect(result.success).toBe(true);
      expect(result.data).toEqual([{ repeated: 'tick-0' }, { repeated: 'tick-1' }]);
    });

    it('refuses a gRPC tool without a proto', async () => {
      await expect(createViaApi(payload('Echo', ''))).rejects.toThrow(/proto/);
      expect(tools.rows()).toHaveLength(0);
    });

    it('refuses a method the proto does not define', async () => {
      await expect(createViaApi(payload('Missing'))).rejects.toThrow(/no method "Missing"/);
    });
  });
});
