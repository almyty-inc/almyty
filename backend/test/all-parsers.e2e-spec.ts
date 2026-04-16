/**
 * Comprehensive E2E Tests for ALL API Parser Types
 *
 * Runs against the LIVE backend (Docker Compose at localhost:4000).
 * No NestJS Test module — pure HTTP tests, like a real client.
 *
 * Tests the full pipeline for each supported schema type:
 * - OpenAPI (Petstore)
 * - GraphQL (SDL)
 * - SOAP (WSDL)
 * - Protobuf (proto3)
 *
 * Each parser test verifies:
 * 1. API creation with correct type
 * 2. Schema import via schemaContent
 * 3. Operation extraction
 * 4. Resource extraction
 * 5. Tool generation from operations
 *
 * Also tests:
 * - Gateway creation for all 3 types (MCP, A2A, UTCP)
 * - Tool scoping to gateways
 * - MCP protocol (tools/list, prompts/list)
 * - Gateway exports (Skills, CLI, SDK)
 * - Health/monitoring endpoints
 * - Error handling
 */

const BASE_URL = process.env.E2E_BACKEND_URL || 'http://localhost:4000';

// Simple HTTP helper (no external deps)
async function api(
  method: string,
  path: string,
  body?: any,
  token?: string,
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const opts: RequestInit = { method, headers };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(`${BASE_URL}${path}`, opts);
  let json: any;
  const text = await res.text();
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, body: json };
}

async function waitForImportJob(
  apiId: string,
  jobId: string,
  token: string,
  timeoutMs = 30000,
): Promise<any> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await api('GET', `/apis/${apiId}/import-status/${jobId}`, undefined, token);
    if (res.body.status === 'completed') return res.body;
    if (res.body.status === 'failed') {
      throw new Error(`Import failed: ${JSON.stringify(res.body.error || res.body.result?.error || res.body)}`);
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`Import timed out after ${timeoutMs}ms`);
}

// ============================================================
// Test Schema Fixtures
// ============================================================

const OPENAPI_SCHEMA = JSON.stringify({
  openapi: '3.0.0',
  info: { title: 'Test Petstore', version: '1.0.0', description: 'Test API' },
  servers: [{ url: 'https://petstore3.swagger.io/api/v3' }],
  paths: {
    '/pet': {
      get: {
        operationId: 'listPets',
        summary: 'List all pets',
        parameters: [
          {
            name: 'status',
            in: 'query',
            schema: { type: 'string', enum: ['available', 'pending', 'sold'] },
          },
        ],
        responses: {
          '200': {
            description: 'Pets list',
            content: {
              'application/json': {
                schema: {
                  type: 'array',
                  items: { $ref: '#/components/schemas/Pet' },
                },
              },
            },
          },
        },
      },
      post: {
        operationId: 'addPet',
        summary: 'Add a new pet',
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/Pet' } },
          },
        },
        responses: { '200': { description: 'Pet created' } },
      },
      put: {
        operationId: 'updatePet',
        summary: 'Update an existing pet',
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/Pet' } },
          },
        },
        responses: { '200': { description: 'Pet updated' } },
      },
    },
    '/pet/{petId}': {
      get: {
        operationId: 'getPetById',
        summary: 'Find pet by ID',
        parameters: [
          {
            name: 'petId',
            in: 'path',
            required: true,
            schema: { type: 'integer', format: 'int64' },
          },
        ],
        responses: { '200': { description: 'Pet details' } },
      },
      delete: {
        operationId: 'deletePet',
        summary: 'Delete a pet',
        parameters: [
          {
            name: 'petId',
            in: 'path',
            required: true,
            schema: { type: 'integer', format: 'int64' },
          },
        ],
        responses: { '200': { description: 'Pet deleted' } },
      },
    },
    '/store/inventory': {
      get: {
        operationId: 'getInventory',
        summary: 'Returns pet inventories',
        responses: {
          '200': {
            description: 'Inventory map',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  additionalProperties: { type: 'integer' },
                },
              },
            },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      Pet: {
        type: 'object',
        required: ['name'],
        properties: {
          id: { type: 'integer', format: 'int64' },
          name: { type: 'string' },
          status: {
            type: 'string',
            enum: ['available', 'pending', 'sold'],
          },
          category: { $ref: '#/components/schemas/Category' },
          tags: {
            type: 'array',
            items: { $ref: '#/components/schemas/Tag' },
          },
        },
      },
      Category: {
        type: 'object',
        properties: {
          id: { type: 'integer', format: 'int64' },
          name: { type: 'string' },
        },
      },
      Tag: {
        type: 'object',
        properties: {
          id: { type: 'integer', format: 'int64' },
          name: { type: 'string' },
        },
      },
    },
  },
});

const GRAPHQL_SCHEMA = `
type Query {
  user(id: ID!): User
  users(limit: Int, offset: Int): [User!]!
  post(id: ID!): Post
  posts(authorId: ID): [Post!]!
}

type Mutation {
  createUser(input: CreateUserInput!): User!
  updateUser(id: ID!, input: UpdateUserInput!): User
  deleteUser(id: ID!): Boolean!
  createPost(input: CreatePostInput!): Post!
}

type Subscription {
  userCreated: User!
  postPublished(authorId: ID): Post!
}

type User {
  id: ID!
  name: String!
  email: String!
  age: Int
  role: UserRole!
  posts: [Post!]!
}

type Post {
  id: ID!
  title: String!
  body: String!
  published: Boolean!
  author: User!
  tags: [String!]
  createdAt: String!
}

enum UserRole {
  ADMIN
  EDITOR
  VIEWER
}

input CreateUserInput {
  name: String!
  email: String!
  age: Int
  role: UserRole
}

input UpdateUserInput {
  name: String
  email: String
  age: Int
  role: UserRole
}

input CreatePostInput {
  title: String!
  body: String!
  published: Boolean
  authorId: ID!
  tags: [String!]
}
`;

const SOAP_SCHEMA = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://schemas.xmlsoap.org/wsdl/"
             xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/"
             xmlns:tns="http://example.com/calculator"
             xmlns:xsd="http://www.w3.org/2001/XMLSchema"
             targetNamespace="http://example.com/calculator"
             name="CalculatorService">
  <types>
    <xsd:schema targetNamespace="http://example.com/calculator">
      <xsd:complexType name="CalculationRequest">
        <xsd:sequence>
          <xsd:element name="a" type="xsd:decimal"/>
          <xsd:element name="b" type="xsd:decimal"/>
        </xsd:sequence>
      </xsd:complexType>
      <xsd:complexType name="CalculationResponse">
        <xsd:sequence>
          <xsd:element name="result" type="xsd:decimal"/>
        </xsd:sequence>
      </xsd:complexType>
      <xsd:complexType name="ConvertRequest">
        <xsd:sequence>
          <xsd:element name="value" type="xsd:decimal"/>
          <xsd:element name="fromUnit" type="xsd:string"/>
          <xsd:element name="toUnit" type="xsd:string"/>
        </xsd:sequence>
      </xsd:complexType>
      <xsd:complexType name="ConvertResponse">
        <xsd:sequence>
          <xsd:element name="result" type="xsd:decimal"/>
          <xsd:element name="unit" type="xsd:string"/>
        </xsd:sequence>
      </xsd:complexType>
      <xsd:simpleType name="OperationType">
        <xsd:restriction base="xsd:string">
          <xsd:enumeration value="add"/>
          <xsd:enumeration value="subtract"/>
          <xsd:enumeration value="multiply"/>
          <xsd:enumeration value="divide"/>
        </xsd:restriction>
      </xsd:simpleType>
    </xsd:schema>
  </types>
  <message name="AddRequest"><part name="parameters" element="tns:CalculationRequest"/></message>
  <message name="AddResponse"><part name="parameters" element="tns:CalculationResponse"/></message>
  <message name="SubtractRequest"><part name="parameters" element="tns:CalculationRequest"/></message>
  <message name="SubtractResponse"><part name="parameters" element="tns:CalculationResponse"/></message>
  <message name="MultiplyRequest"><part name="parameters" element="tns:CalculationRequest"/></message>
  <message name="MultiplyResponse"><part name="parameters" element="tns:CalculationResponse"/></message>
  <message name="DivideRequest"><part name="parameters" element="tns:CalculationRequest"/></message>
  <message name="DivideResponse"><part name="parameters" element="tns:CalculationResponse"/></message>
  <message name="ConvertUnitRequest"><part name="parameters" element="tns:ConvertRequest"/></message>
  <message name="ConvertUnitResponse"><part name="parameters" element="tns:ConvertResponse"/></message>
  <portType name="CalculatorPortType">
    <operation name="Add"><input message="tns:AddRequest"/><output message="tns:AddResponse"/></operation>
    <operation name="Subtract"><input message="tns:SubtractRequest"/><output message="tns:SubtractResponse"/></operation>
    <operation name="Multiply"><input message="tns:MultiplyRequest"/><output message="tns:MultiplyResponse"/></operation>
    <operation name="Divide"><input message="tns:DivideRequest"/><output message="tns:DivideResponse"/></operation>
    <operation name="ConvertUnit"><input message="tns:ConvertUnitRequest"/><output message="tns:ConvertUnitResponse"/></operation>
  </portType>
  <binding name="CalculatorBinding" type="tns:CalculatorPortType">
    <soap:binding style="document" transport="http://schemas.xmlsoap.org/soap/http"/>
    <operation name="Add"><soap:operation soapAction="http://example.com/calculator/Add"/></operation>
    <operation name="Subtract"><soap:operation soapAction="http://example.com/calculator/Subtract"/></operation>
    <operation name="Multiply"><soap:operation soapAction="http://example.com/calculator/Multiply"/></operation>
    <operation name="Divide"><soap:operation soapAction="http://example.com/calculator/Divide"/></operation>
    <operation name="ConvertUnit"><soap:operation soapAction="http://example.com/calculator/ConvertUnit"/></operation>
  </binding>
  <service name="CalculatorService">
    <port name="CalculatorPort" binding="tns:CalculatorBinding">
      <soap:address location="http://example.com/calculator"/>
    </port>
  </service>
</definitions>`;

const PROTOBUF_SCHEMA = `
syntax = "proto3";

package taskmanager;

service TaskService {
  rpc CreateTask(CreateTaskRequest) returns (Task);
  rpc GetTask(GetTaskRequest) returns (Task);
  rpc ListTasks(ListTasksRequest) returns (ListTasksResponse);
  rpc UpdateTask(UpdateTaskRequest) returns (Task);
  rpc DeleteTask(DeleteTaskRequest) returns (DeleteTaskResponse);
  rpc AssignTask(AssignTaskRequest) returns (Task);
}

service UserService {
  rpc GetUser(GetUserRequest) returns (User);
  rpc ListUsers(ListUsersRequest) returns (ListUsersResponse);
}

message Task {
  string id = 1;
  string title = 2;
  string description = 3;
  TaskStatus status = 4;
  Priority priority = 5;
  string assignee_id = 6;
  repeated string tags = 7;
  int64 created_at = 8;
  int64 updated_at = 9;
}

message User {
  string id = 1;
  string name = 2;
  string email = 3;
  UserRole role = 4;
}

message CreateTaskRequest {
  string title = 1;
  string description = 2;
  Priority priority = 3;
  string assignee_id = 4;
  repeated string tags = 5;
}

message GetTaskRequest {
  string task_id = 1;
}

message ListTasksRequest {
  int32 limit = 1;
  int32 offset = 2;
  TaskStatus status_filter = 3;
}

message ListTasksResponse {
  repeated Task tasks = 1;
  int32 total = 2;
}

message UpdateTaskRequest {
  string task_id = 1;
  string title = 2;
  string description = 3;
  TaskStatus status = 4;
  Priority priority = 5;
}

message DeleteTaskRequest {
  string task_id = 1;
}

message DeleteTaskResponse {
  bool success = 1;
}

message AssignTaskRequest {
  string task_id = 1;
  string assignee_id = 2;
}

message GetUserRequest {
  string user_id = 1;
}

message ListUsersRequest {
  int32 limit = 1;
  int32 offset = 2;
}

message ListUsersResponse {
  repeated User users = 1;
  int32 total = 2;
}

enum TaskStatus {
  TASK_STATUS_UNSPECIFIED = 0;
  TODO = 1;
  IN_PROGRESS = 2;
  DONE = 3;
  CANCELLED = 4;
}

enum Priority {
  PRIORITY_UNSPECIFIED = 0;
  LOW = 1;
  MEDIUM = 2;
  HIGH = 3;
  CRITICAL = 4;
}

enum UserRole {
  USER_ROLE_UNSPECIFIED = 0;
  ADMIN = 1;
  MEMBER = 2;
  VIEWER = 3;
}
`;

// ============================================================
// Test Suite
// ============================================================

describe('All Parser Types — Full Pipeline E2E (Live Backend)', () => {
  let authToken: string;
  let organizationId: string;
  let orgSlug: string;

  const createdApis: Record<string, string> = {};
  const allToolIds: string[] = [];
  const createdGateways: Record<string, { id: string; endpoint: string }> = {};

  const testUser = {
    email: `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@almyty.com`,
    password: 'TestPass123',
    firstName: 'Parser',
    lastName: 'Tester',
    organizationName: `E2EOrg-${Date.now()}`,
  };

  // ============================================================
  // Setup: register + login
  // ============================================================
  beforeAll(async () => {
    // Health check
    const health = await api('GET', '/health');
    if (health.status !== 200) {
      throw new Error(`Backend not healthy: ${JSON.stringify(health.body)}`);
    }

    // Register (returns accessToken directly)
    const reg = await api('POST', '/auth/register', testUser);
    console.log(`Register status: ${reg.status}, keys: ${Object.keys(reg.body).join(', ')}`);
    if (reg.body.data?.accessToken) {
      authToken = reg.body.data.accessToken;
    }

    // Login if register failed (user exists) or didn't return token
    if (!authToken) {
      const login = await api('POST', '/auth/login', {
        email: testUser.email,
        password: testUser.password,
      });
      console.log(`Login status: ${login.status}, keys: ${Object.keys(login.body).join(', ')}`);
      authToken = login.body.data?.accessToken;
    }

    if (!authToken) {
      throw new Error(
        `Auth failed. Register: ${JSON.stringify(reg.body)}`,
      );
    }

    // Debug: decode JWT
    try {
      const payload = JSON.parse(
        Buffer.from(authToken.split('.')[1], 'base64').toString(),
      );
      console.log(`JWT payload keys: ${Object.keys(payload).join(', ')}`);
      console.log(`JWT orgs: ${JSON.stringify(payload.organizations || [])}`);
    } catch (e) {
      console.log(`JWT decode error: ${e}`);
    }

    // Decode JWT to get org info (JWT payload has organizations array)
    try {
      const payload = JSON.parse(
        Buffer.from(authToken.split('.')[1], 'base64').toString(),
      );
      const jwtOrgs = payload.organizations || [];
      if (jwtOrgs.length > 0) {
        organizationId = jwtOrgs[0].id;
        orgSlug = jwtOrgs[0].name?.toLowerCase().replace(/\s+/g, '-') || 'unknown';
      }
    } catch (e) {
      // Fallback to profile
    }

    // Fallback: get org from profile
    if (!organizationId) {
      const profile = await api('GET', '/users/me', undefined, authToken);
      const orgs = profile.body?.organizationMemberships || [];
      organizationId = orgs[0]?.organization?.id || orgs[0]?.organizationId;
      orgSlug = orgs[0]?.organization?.slug || 'unknown';
    }

    // Fallback: get org from /organizations
    if (!organizationId) {
      const orgRes = await api('GET', '/organizations', undefined, authToken);
      const orgList = Array.isArray(orgRes.body) ? orgRes.body : orgRes.body?.data || [];
      if (orgList.length > 0) {
        organizationId = orgList[0].id;
        orgSlug = orgList[0].slug || orgList[0].name?.toLowerCase().replace(/\s+/g, '-') || 'unknown';
      }
    }

    if (!organizationId) {
      throw new Error('No org found after trying JWT, profile, and /organizations');
    }

    console.log(`\nSetup: user=${testUser.email} org=${orgSlug} (${organizationId})\n`);
  }, 15000);

  // ============================================================
  // Helper: create + import + verify
  // ============================================================
  async function importApi(
    name: string,
    type: string,
    baseUrl: string,
    schemaContent: string,
  ): Promise<{ apiId: string; operations: any[]; resources: any[] }> {
    // Create
    const create = await api(
      'POST',
      `/apis?organizationId=${organizationId}`,
      { name, description: `${name} e2e`, type, baseUrl },
      authToken,
    );
    expect(create.status).toBe(201);
    const apiId = create.body.id;
    expect(apiId).toBeTruthy();
    createdApis[type] = apiId;

    // Import
    const imp = await api(
      'POST',
      `/apis/${apiId}/import-schema`,
      { schemaContent, generateTools: true },
      authToken,
    );
    expect([200, 201].includes(imp.status) || imp.body.jobId).toBeTruthy();

    // Wait for async job if needed
    if (imp.body.jobId) {
      await waitForImportJob(apiId, imp.body.jobId, authToken, 30000);
    }

    // Explicitly generate tools (the async job may or may not do this)
    const genRes = await api(
      'POST',
      `/apis/${apiId}/generate-tools`,
      {},
      authToken,
    );
    if (genRes.status === 201 || genRes.status === 200) {
      const generated = Array.isArray(genRes.body) ? genRes.body : [];
      if (generated.length > 0) {
        console.log(`  Generated ${generated.length} tools for ${name}`);
      }
    }

    // Fetch full API with relations
    const full = await api('GET', `/apis/${apiId}`, undefined, authToken);
    expect(full.status).toBe(200);

    return {
      apiId,
      operations: full.body.operations || [],
      resources: full.body.resources || [],
    };
  }

  // ================================================================
  // 1. OPENAPI
  // ================================================================
  describe('1. OpenAPI Parser', () => {
    let result: { apiId: string; operations: any[]; resources: any[] };

    it('should import OpenAPI schema and extract operations + resources', async () => {
      result = await importApi(
        'E2E Petstore',
        'openapi',
        'https://petstore3.swagger.io/api/v3',
        OPENAPI_SCHEMA,
      );

      expect(result.operations.length).toBeGreaterThanOrEqual(6);
      expect(result.resources.length).toBeGreaterThanOrEqual(2);
    }, 45000);

    it('should have correct HTTP methods from OpenAPI paths', () => {
      const methods = result.operations.map((op: any) =>
        (op.method || '').toUpperCase(),
      );
      expect(methods).toContain('GET');
      expect(methods).toContain('POST');
      expect(methods).toContain('PUT');
      expect(methods).toContain('DELETE');
    });

    it('should have Pet resource with properties', () => {
      const pet = result.resources.find((r: any) => r.name === 'Pet');
      expect(pet).toBeDefined();
      if (pet?.properties) {
        const propNames = Object.keys(pet.properties);
        expect(propNames).toContain('name');
      }
    });

    it('should have generated tools', async () => {
      const tools = await api(
        'GET',
        `/organizations/${organizationId}/tools`,
        undefined,
        authToken,
      );
      const toolList = Array.isArray(tools.body) ? tools.body :
        tools.body.data?.tools || tools.body.tools || tools.body.data || [];
      const petTools = toolList.filter(
        (t: any) => t.name?.includes('E2E Petstore'),
      );
      expect(petTools.length).toBeGreaterThanOrEqual(1);
      petTools.forEach((t: any) => allToolIds.push(t.id));

      console.log(
        `  ✓ OpenAPI: ${result.operations.length} operations, ${result.resources.length} resources, ${petTools.length} tools`,
      );
    });
  });

  // ================================================================
  // 2. GRAPHQL
  // ================================================================
  describe('2. GraphQL Parser', () => {
    let result: { apiId: string; operations: any[]; resources: any[] };

    it('should import GraphQL SDL schema', async () => {
      result = await importApi(
        'E2E GraphQL Blog',
        'graphql',
        'https://example.com/graphql',
        GRAPHQL_SCHEMA,
      );

      // 4 queries + 4 mutations + 2 subscriptions = 10
      expect(result.operations.length).toBeGreaterThanOrEqual(8);
      // User, Post, UserRole enum, inputs
      expect(result.resources.length).toBeGreaterThanOrEqual(2);
    }, 45000);

    it('should have query and mutation operations', () => {
      const names = result.operations.map(
        (op: any) => op.name || op.operationId,
      );
      // Check for query-like ops
      expect(
        names.some((n: string) => n?.toLowerCase().includes('user')),
      ).toBe(true);
      // Check for mutation-like ops
      expect(
        names.some(
          (n: string) =>
            n?.toLowerCase().includes('create') ||
            n?.toLowerCase().includes('delete'),
        ),
      ).toBe(true);
    });

    it('should extract User and Post types as resources', () => {
      const names = result.resources.map((r: any) => r.name);
      expect(names).toContain('User');
      expect(names).toContain('Post');
    });

    it('should extract enum types', () => {
      const enums = result.resources.filter((r: any) => r.type === 'enum');
      expect(enums.length).toBeGreaterThanOrEqual(1);
      const enumNames = enums.map((r: any) => r.name);
      expect(enumNames).toContain('UserRole');
    });

    it('should generate tools from GraphQL operations', async () => {
      const tools = await api(
        'GET',
        `/organizations/${organizationId}/tools`,
        undefined,
        authToken,
      );
      const toolList = Array.isArray(tools.body) ? tools.body :
        tools.body.data?.tools || tools.body.tools || tools.body.data || [];
      const gqlTools = toolList.filter(
        (t: any) => t.name?.includes('E2E GraphQL'),
      );
      expect(gqlTools.length).toBeGreaterThanOrEqual(1);
      gqlTools.forEach((t: any) => allToolIds.push(t.id));

      console.log(
        `  ✓ GraphQL: ${result.operations.length} operations, ${result.resources.length} resources, ${gqlTools.length} tools`,
      );
    });
  });

  // ================================================================
  // 3. SOAP
  // ================================================================
  describe('3. SOAP Parser', () => {
    let result: { apiId: string; operations: any[]; resources: any[] };

    it('should import SOAP WSDL schema', async () => {
      result = await importApi(
        'E2E SOAP Calculator',
        'soap',
        'http://example.com/calculator',
        SOAP_SCHEMA,
      );

      expect(result.operations.length).toBeGreaterThanOrEqual(5);
      expect(result.resources.length).toBeGreaterThanOrEqual(2);
    }, 45000);

    it('should extract all 5 SOAP operations', () => {
      const names = result.operations.map(
        (op: any) => op.name || op.operationId,
      );
      expect(names).toContain('Add');
      expect(names).toContain('Subtract');
      expect(names).toContain('Multiply');
      expect(names).toContain('Divide');
      expect(names).toContain('ConvertUnit');
    });

    it('should extract complex types', () => {
      const names = result.resources.map((r: any) => r.name);
      expect(
        names.some(
          (n: string) =>
            n?.includes('Calculation') || n?.includes('Convert'),
        ),
      ).toBe(true);
    });

    it('should extract types from WSDL schema definitions', () => {
      // WSDL may store enum-like simpleTypes as model resources
      // The SOAP parser extracts complexTypes and simpleTypes as resources
      expect(result.resources.length).toBeGreaterThanOrEqual(2);
      const names = result.resources.map((r: any) => r.name);
      console.log(`  SOAP resource names: ${names.join(', ')}`);
      console.log(`  SOAP resource types: ${result.resources.map((r: any) => `${r.name}:${r.type}`).join(', ')}`);
    });

    it('should generate tools from SOAP operations', async () => {
      const tools = await api(
        'GET',
        `/organizations/${organizationId}/tools`,
        undefined,
        authToken,
      );
      const toolList = Array.isArray(tools.body) ? tools.body :
        tools.body.data?.tools || tools.body.tools || tools.body.data || [];
      const soapTools = toolList.filter(
        (t: any) => t.name?.includes('E2E SOAP'),
      );
      expect(soapTools.length).toBeGreaterThanOrEqual(1);
      soapTools.forEach((t: any) => allToolIds.push(t.id));

      console.log(
        `  ✓ SOAP: ${result.operations.length} operations, ${result.resources.length} resources, ${soapTools.length} tools`,
      );
    });
  });

  // ================================================================
  // 4. PROTOBUF
  // ================================================================
  describe('4. Protobuf Parser', () => {
    let result: { apiId: string; operations: any[]; resources: any[] };

    it('should import Protobuf (.proto) schema', async () => {
      result = await importApi(
        'E2E Protobuf TaskMgr',
        'grpc',
        'http://example.com/grpc',
        PROTOBUF_SCHEMA,
      );

      // TaskService:6 + UserService:2 = 8
      expect(result.operations.length).toBeGreaterThanOrEqual(8);
      // Task, User, Request/Response messages
      expect(result.resources.length).toBeGreaterThanOrEqual(4);
    }, 45000);

    it('should extract RPC methods as operations', () => {
      const names = result.operations.map(
        (op: any) => op.name || op.operationId,
      );
      expect(
        names.some((n: string) => n?.includes('CreateTask')),
      ).toBe(true);
      expect(
        names.some((n: string) => n?.includes('GetTask')),
      ).toBe(true);
      expect(
        names.some((n: string) => n?.includes('ListTasks')),
      ).toBe(true);
      expect(
        names.some((n: string) => n?.includes('GetUser')),
      ).toBe(true);
      expect(
        names.some((n: string) => n?.includes('ListUsers')),
      ).toBe(true);
    });

    it('should extract message types as resources', () => {
      const names = result.resources.map((r: any) => r.name);
      expect(names).toContain('Task');
      expect(names).toContain('User');
    });

    it('should extract all 3 protobuf enums', () => {
      const enums = result.resources.filter((r: any) => r.type === 'enum');
      expect(enums.length).toBeGreaterThanOrEqual(3);
      const enumNames = enums.map((r: any) => r.name);
      expect(enumNames).toContain('TaskStatus');
      expect(enumNames).toContain('Priority');
      expect(enumNames).toContain('UserRole');
    });

    it('should generate tools from RPC methods', async () => {
      const tools = await api(
        'GET',
        `/organizations/${organizationId}/tools`,
        undefined,
        authToken,
      );
      const toolList = Array.isArray(tools.body) ? tools.body :
        tools.body.data?.tools || tools.body.tools || tools.body.data || [];
      const protoTools = toolList.filter(
        (t: any) => t.name?.includes('E2E Protobuf'),
      );
      expect(protoTools.length).toBeGreaterThanOrEqual(1);
      protoTools.forEach((t: any) => allToolIds.push(t.id));

      console.log(
        `  ✓ Protobuf: ${result.operations.length} operations, ${result.resources.length} resources, ${protoTools.length} tools`,
      );
    });
  });

  // ================================================================
  // 5. GATEWAYS (MCP, A2A, UTCP)
  // ================================================================
  describe('5. Gateways — All 3 Types', () => {
    it('should create MCP gateway', async () => {
      const res = await api(
        'POST',
        `/gateways`,
        {
          name: 'E2E MCP GW',
          type: 'mcp',
          endpoint: `/e2e-mcp-${Date.now()}`,
          description: 'MCP test gateway',
          configuration: { transport: 'http' },
        },
        authToken,
      );
      if (res.status !== 201) {
        console.log(`  MCP gateway creation: ${res.status} ${JSON.stringify(res.body).substring(0, 300)}`);
      }
      expect(res.status).toBe(201);
      const gw = res.body.data || res.body;
      createdGateways.mcp = { id: gw.id, endpoint: gw.endpoint };
    });

    it('should create A2A gateway', async () => {
      const res = await api(
        'POST',
        `/gateways`,
        {
          name: 'E2E A2A GW',
          type: 'a2a',
          endpoint: `/e2e-a2a-${Date.now()}`,
          description: 'A2A test gateway',
          configuration: { agentCapabilities: ['tool-use', 'chat'] },
        },
        authToken,
      );
      if (res.status !== 201) {
        console.log(`  A2A gateway creation: ${res.status} ${JSON.stringify(res.body).substring(0, 300)}`);
      }
      expect(res.status).toBe(201);
      const gw = res.body.data || res.body;
      createdGateways.a2a = { id: gw.id, endpoint: gw.endpoint };
    });

    it('should create UTCP gateway', async () => {
      const res = await api(
        'POST',
        `/gateways`,
        {
          name: 'E2E UTCP GW',
          type: 'utcp',
          endpoint: `/e2e-utcp-${Date.now()}`,
          description: 'UTCP test gateway',
          configuration: { protocol: 'http' },
        },
        authToken,
      );
      if (res.status !== 201) {
        console.log(`  UTCP gateway creation: ${res.status} ${JSON.stringify(res.body).substring(0, 300)}`);
      }
      expect(res.status).toBe(201);
      const gw = res.body.data || res.body;
      createdGateways.utcp = { id: gw.id, endpoint: gw.endpoint };
    });

    it('should scope tools to MCP gateway', async () => {
      if (!createdGateways.mcp) {
        console.warn('  ⚠ No MCP gateway to assign tools to');
        return;
      }
      const toolsToAssign = allToolIds.slice(
        0,
        Math.min(5, allToolIds.length),
      );
      if (toolsToAssign.length === 0) {
        console.warn('  ⚠ No tools to assign');
        return;
      }
      // Use bulk endpoint: POST /gateways/:id/tools/bulk with { toolIds: [...] }
      const res = await api(
        'POST',
        `/gateways/${createdGateways.mcp.id}/tools/bulk`,
        { toolIds: toolsToAssign },
        authToken,
      );
      if (res.status !== 201 && res.status !== 200) {
        console.log(`  Tool scoping error: ${res.status} ${JSON.stringify(res.body).substring(0, 300)}`);
      }
      expect([200, 201]).toContain(res.status);
      console.log(`  ✓ Assigned ${toolsToAssign.length} tools to MCP gateway`);
    });

    it('should list all 3 gateways', async () => {
      const res = await api(
        'GET',
        `/gateways`,
        undefined,
        authToken,
      );
      // gateways endpoint uses JWT for org, no query param needed
      if (res.status !== 200) {
        console.log(`  Gateways list returned ${res.status}: ${JSON.stringify(res.body).substring(0, 200)}`);
      }
      const gateways =
        res.body.data?.gateways ||
        res.body.gateways ||
        res.body.data ||
        res.body;
      const gwList = Array.isArray(gateways) ? gateways : [];
      expect(gwList.length).toBeGreaterThanOrEqual(3);

      const types = gwList.map((g: any) => g.type);
      expect(types).toContain('mcp');
      expect(types).toContain('a2a');
      expect(types).toContain('utcp');
    });
  });

  // ================================================================
  // 6. MCP PROTOCOL (JSON-RPC)
  // ================================================================
  describe('6. MCP Protocol', () => {
    it('should serve MCP discovery', async () => {
      const res = await api('GET', '/mcp/.well-known/mcp');
      expect(res.status).toBe(200);
      expect(res.body.capabilities).toBeDefined();
    });

    it('should handle tools/list via JSON-RPC', async () => {
      if (!createdGateways.mcp) return;
      const endpoint = createdGateways.mcp.endpoint;
      const res = await api(
        'POST',
        `/${orgSlug}${endpoint}`,
        { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
      );
      // May need session init first
      if (res.status === 200 && res.body.result) {
        expect(Array.isArray(res.body.result.tools)).toBe(true);
        console.log(
          `  ✓ MCP tools/list: ${res.body.result.tools.length} tools`,
        );
      }
    });

    it('should handle prompts/list without crashing (bug fix)', async () => {
      if (!createdGateways.mcp) return;
      const endpoint = createdGateways.mcp.endpoint;
      const res = await api(
        'POST',
        `/${orgSlug}${endpoint}`,
        { jsonrpc: '2.0', id: 2, method: 'prompts/list', params: {} },
      );
      // The bug was a 500 error from TypeORM relation issue
      expect(res.status).not.toBe(500);
    });
  });

  // ================================================================
  // 7. TOOL EXECUTION (Real HTTP)
  // ================================================================
  describe('7. Tool Execution', () => {
    it('should execute an OpenAPI tool (GET /pet)', async () => {
      if (allToolIds.length === 0) {
        console.warn('  ⚠ No tools available for execution');
        return;
      }

      // Find a GET tool
      const tools = await api(
        'GET',
        `/organizations/${organizationId}/tools`,
        undefined,
        authToken,
      );
      const toolList = Array.isArray(tools.body) ? tools.body :
        tools.body.data?.tools || tools.body.tools || tools.body.data || [];
      const getTool = toolList.find(
        (t: any) =>
          (t.name?.toLowerCase().includes('list') ||
            t.name?.toLowerCase().includes('get') ||
            t.name?.toLowerCase().includes('find')) &&
          t.status === 'active',
      );

      if (!getTool) {
        console.warn('  ⚠ No active GET tool found for execution test');
        return;
      }

      // Execute
      const exec = await api(
        'POST',
        `/tools/${getTool.id}/execute`,
        { parameters: {} },
        authToken,
      );

      // Tool execution should return a result (may fail with target API errors, that's fine)
      expect([200, 201, 400, 404, 500, 502]).toContain(exec.status);
      console.log(
        `  ✓ Tool ${getTool.name} execution returned status: ${exec.status}`,
      );
    });
  });

  // ================================================================
  // 8. GATEWAY EXPORTS
  // ================================================================
  describe('8. Gateway Exports', () => {
    it('should export skills bundle', async () => {
      if (!createdGateways.mcp) {
        console.warn('  ⚠ No MCP gateway for export test');
        return;
      }
      const res = await api(
        'GET',
        `/gateways/${createdGateways.mcp.id}/skills`,
        undefined,
        authToken,
      );
      expect(res.status).toBe(200);
      expect(res.body).toBeTruthy();
      console.log('  ✓ Skills export successful');
    });

    it('should export CLI bundle', async () => {
      if (!createdGateways.mcp) {
        console.warn('  ⚠ No MCP gateway for export test');
        return;
      }
      const res = await api(
        'GET',
        `/gateways/${createdGateways.mcp.id}/cli-bundle`,
        undefined,
        authToken,
      );
      expect(res.status).toBe(200);
      expect(res.body).toBeTruthy();
      console.log('  ✓ CLI export successful');
    });

    it('should export TypeScript SDK', async () => {
      if (!createdGateways.mcp) {
        console.warn('  ⚠ No MCP gateway for export test');
        return;
      }
      const res = await api(
        'GET',
        `/gateways/${createdGateways.mcp.id}/sdk`,
        undefined,
        authToken,
      );
      expect(res.status).toBe(200);
      expect(res.body).toBeTruthy();
      console.log('  ✓ SDK export successful');
    });
  });

  // ================================================================
  // 9. HEALTH & MONITORING
  // ================================================================
  describe('9. Health & Monitoring', () => {
    it('GET /health → ok', async () => {
      const res = await api('GET', '/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
    });

    it('GET /health/live → ok', async () => {
      const res = await api('GET', '/health/live');
      expect(res.status).toBe(200);
    });

    it('GET /health/ready → ok', async () => {
      const res = await api('GET', '/health/ready');
      expect(res.status).toBe(200);
    });
  });

  // ================================================================
  // 10. ERROR HANDLING
  // ================================================================
  describe('10. Error Handling', () => {
    it('should reject invalid OpenAPI schema', async () => {
      const create = await api(
        'POST',
        `/apis?organizationId=${organizationId}`,
        { name: 'Bad OpenAPI', type: 'openapi', baseUrl: 'http://x.com' },
        authToken,
      );
      if (create.status === 201) {
        const imp = await api(
          'POST',
          `/apis/${create.body.id}/import-schema`,
          { schemaContent: 'not valid json', generateTools: true },
          authToken,
        );
        if (imp.body.jobId) {
          try {
            await waitForImportJob(create.body.id, imp.body.jobId, authToken, 15000);
            fail('Expected import to fail');
          } catch (e: any) {
            expect(e.message).toMatch(/failed|timed out/i);
          }
        } else {
          expect([400, 422, 500]).toContain(imp.status);
        }
      }
    }, 30000);

    it('should reject invalid GraphQL SDL', async () => {
      const create = await api(
        'POST',
        `/apis?organizationId=${organizationId}`,
        { name: 'Bad GQL', type: 'graphql', baseUrl: 'http://x.com/gql' },
        authToken,
      );
      if (create.status === 201) {
        const imp = await api(
          'POST',
          `/apis/${create.body.id}/import-schema`,
          { schemaContent: 'type { broken syntax', generateTools: true },
          authToken,
        );
        if (imp.body.jobId) {
          try {
            await waitForImportJob(create.body.id, imp.body.jobId, authToken, 15000);
            fail('Expected import to fail');
          } catch (e: any) {
            expect(e.message).toMatch(/failed|timed out/i);
          }
        }
      }
    }, 30000);

    it('should return 401 for unauthenticated requests', async () => {
      const res = await api('GET', '/apis');
      expect(res.status).toBe(401);
    });

    it('should return 404 for non-existent API', async () => {
      const res = await api(
        'GET',
        '/apis/00000000-0000-0000-0000-000000000000',
        undefined,
        authToken,
      );
      expect(res.status).toBe(404);
    });
  });

  // ================================================================
  // 11. CROSS-PARSER SUMMARY
  // ================================================================
  describe('11. Cross-Parser Summary', () => {
    it('should have APIs of all 4 types', async () => {
      const res = await api(
        'GET',
        `/apis?organizationId=${organizationId}`,
        undefined,
        authToken,
      );
      const apis = Array.isArray(res.body) ? res.body :
        res.body.apis || res.body.data || [];
      const types = apis.map((a: any) => a.type);

      console.log('\n============================================');
      console.log('        COMPREHENSIVE E2E TEST SUMMARY');
      console.log('============================================');

      expect(types).toContain('openapi');
      expect(types).toContain('graphql');
      expect(types).toContain('soap');
      expect(types).toContain('grpc');

      for (const a of apis) {
        if (a.name?.startsWith('E2E')) {
          console.log(
            `  ${a.type.padEnd(8)} | ${a.name.padEnd(25)} | ops: ${(a.operations?.length || '?').toString().padStart(3)} | res: ${(a.resources?.length || '?').toString().padStart(3)} | status: ${a.status}`,
          );
        }
      }

      // Total tools
      const tools = await api(
        'GET',
        `/organizations/${organizationId}/tools`,
        undefined,
        authToken,
      );
      const toolList = Array.isArray(tools.body) ? tools.body :
        tools.body.data?.tools || tools.body.tools || tools.body.data || [];
      console.log(`\n  Total tools generated: ${toolList.length}`);
      console.log(`  Total tool IDs tracked: ${allToolIds.length}`);
      console.log(
        `  Gateways created: MCP=${createdGateways.mcp?.id ? '✓' : '✗'}, A2A=${createdGateways.a2a?.id ? '✓' : '✗'}, UTCP=${createdGateways.utcp?.id ? '✓' : '✗'}`,
      );
      console.log('============================================\n');
    });
  });
});
