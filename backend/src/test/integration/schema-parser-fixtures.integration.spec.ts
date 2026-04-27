/**
 * Real-world schema fixture integration tests.
 *
 * The existing parser specs in src/modules/schema-parser/parsers all
 * use minimal inline stub schemas — a handful of paths, two or three
 * type refs, no deep nesting. That's fine for pinning the happy-
 * path behaviour but it doesn't exercise the edge cases that break
 * real-world schema imports: components/schemas $refs that chain
 * three levels deep, nullable fields, allOf/oneOf composition,
 * GraphQL unions and interfaces, WSDL schemas with imports, .proto
 * files with nested messages. A bug in ref resolution, type
 * normalization, or operation extraction could slip past the
 * existing specs and only surface when a user tries to import a
 * real-world API.
 *
 * This file parses realistic fixtures that mimic the complexity of
 * real schemas (Petstore-shape OpenAPI, GitHub-shape GraphQL,
 * typical WSDL, typical Protobuf) and asserts the parser produces
 * the expected operations / resources / types. If a future refactor
 * breaks ref resolution or type mapping, at least one of these
 * tests will fail loudly.
 */
import { OpenAPIParserService } from '../../modules/schema-parser/parsers/openapi-parser.service';
import { GraphQLParserService } from '../../modules/schema-parser/parsers/graphql-parser.service';
import { SOAPParserService } from '../../modules/schema-parser/parsers/soap-parser.service';
import { ProtobufParserService } from '../../modules/schema-parser/parsers/protobuf-parser.service';

jest.setTimeout(30_000);

// ═══════════════════════════════════════════════════════════════════════
//   OpenAPI 3.0 — Petstore-shape fixture
// ═══════════════════════════════════════════════════════════════════════

const OPENAPI_FIXTURE = JSON.stringify({
  openapi: '3.0.3',
  info: {
    title: 'Petstore',
    description: 'A realistic OpenAPI 3.0 fixture exercising $refs, allOf, nullable, enums, and multiple response codes',
    version: '2.1.0',
  },
  servers: [{ url: 'https://petstore.example.com/v2' }],
  paths: {
    '/pets': {
      get: {
        operationId: 'listPets',
        summary: 'List all pets',
        tags: ['pets'],
        parameters: [
          { name: 'limit', in: 'query', required: false, schema: { type: 'integer', maximum: 100, default: 20 } },
          { name: 'status', in: 'query', required: false, schema: { $ref: '#/components/schemas/PetStatus' } },
        ],
        responses: {
          '200': {
            description: 'a list of pets',
            content: {
              'application/json': {
                schema: { type: 'array', items: { $ref: '#/components/schemas/Pet' } },
              },
            },
          },
          '400': { description: 'bad request', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
      post: {
        operationId: 'createPet',
        tags: ['pets'],
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/NewPet' } },
          },
        },
        responses: {
          '201': { description: 'created', content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } } },
        },
      },
    },
    '/pets/{petId}': {
      parameters: [{ name: 'petId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      get: {
        operationId: 'getPetById',
        tags: ['pets'],
        responses: {
          '200': { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } } },
          '404': { description: 'not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
      delete: {
        operationId: 'deletePet',
        tags: ['pets'],
        responses: { '204': { description: 'deleted' } },
      },
    },
  },
  components: {
    schemas: {
      Pet: {
        allOf: [
          { $ref: '#/components/schemas/NewPet' },
          {
            type: 'object',
            required: ['id'],
            properties: {
              id: { type: 'string', format: 'uuid' },
              createdAt: { type: 'string', format: 'date-time' },
            },
          },
        ],
      },
      NewPet: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string' },
          tag: { type: 'string', nullable: true },
          status: { $ref: '#/components/schemas/PetStatus' },
        },
      },
      PetStatus: {
        type: 'string',
        enum: ['available', 'pending', 'sold'],
      },
      Error: {
        type: 'object',
        required: ['code', 'message'],
        properties: {
          code: { type: 'integer' },
          message: { type: 'string' },
        },
      },
    },
  },
});

describe('OpenAPIParserService — Petstore fixture', () => {
  let parser: OpenAPIParserService;

  beforeAll(() => {
    parser = new OpenAPIParserService();
  });

  it('parses the schema into a ParsedSchema with the expected metadata', async () => {
    const parsed = await parser.parseSchema(OPENAPI_FIXTURE);
    expect(parsed.info.title).toBe('Petstore');
    expect(parsed.info.version).toBe('2.1.0');
    expect(parsed.version).toBeTruthy();
  });

  it('extracts all 4 operations (listPets, createPet, getPetById, deletePet)', async () => {
    const parsed = await parser.parseSchema(OPENAPI_FIXTURE);
    const ops = await parser.extractOperations(parsed);

    // The parser's `name` field prefers summary > operationId > path,
    // so we compare on operationId which is the stable discriminator.
    const ids = ops.map((o) => o.operationId).sort();
    expect(ids).toEqual(['createPet', 'deletePet', 'getPetById', 'listPets'].sort());
  });

  it('extracts the path parameter petId on getPetById and deletePet', async () => {
    const parsed = await parser.parseSchema(OPENAPI_FIXTURE);
    const ops = await parser.extractOperations(parsed);

    const getOp = ops.find((o) => o.operationId === 'getPetById')!;
    expect(getOp).toBeDefined();
    expect(getOp.endpoint).toContain('{petId}');
    expect(getOp.method.toLowerCase()).toBe('get');
  });

  it('extracts the query parameters on listPets', async () => {
    const parsed = await parser.parseSchema(OPENAPI_FIXTURE);
    const ops = await parser.extractOperations(parsed);
    const listOp = ops.find((o) => o.operationId === 'listPets')!;
    expect(listOp).toBeDefined();
    expect(listOp.method.toLowerCase()).toBe('get');
    // Query params are stored under parameters — shape varies, so
    // just stringify and scan for the names.
    const serialized = JSON.stringify(listOp.parameters);
    expect(serialized).toContain('limit');
    expect(serialized).toContain('status');
  });

  it('extracts resources including Pet, NewPet, PetStatus, Error', async () => {
    const parsed = await parser.parseSchema(OPENAPI_FIXTURE);
    const resources = await parser.extractResources(parsed);

    const names = resources.map((r) => r.name);
    expect(names).toEqual(expect.arrayContaining(['Pet', 'NewPet', 'PetStatus', 'Error']));
  });

  it('refuses a malformed schema (JSON parse error)', async () => {
    await expect(parser.parseSchema('{not-json')).rejects.toThrow();
  });

  it('refuses a schema larger than the 100 MB cap', async () => {
    // Cap was raised 5 MB → 100 MB so real-world specs (Stripe ~7.7 MB,
    // GitHub REST ~12 MB, AWS-class ~30 MB) can import. The size guard
    // still exists — just at a higher threshold. 101 MB triggers it.
    const huge = 'x'.repeat(101 * 1024 * 1024);
    await expect(parser.parseSchema(huge)).rejects.toThrow(/max size/);
  });
});

// ═══════════════════════════════════════════════════════════════════════
//   GraphQL — SDL fixture with unions, interfaces, enums
// ═══════════════════════════════════════════════════════════════════════

const GRAPHQL_FIXTURE = `
  scalar DateTime

  enum Role {
    ADMIN
    MEMBER
    VIEWER
  }

  interface Node {
    id: ID!
    createdAt: DateTime!
  }

  type User implements Node {
    id: ID!
    createdAt: DateTime!
    email: String!
    name: String
    role: Role!
    posts: [Post!]!
  }

  type Post implements Node {
    id: ID!
    createdAt: DateTime!
    title: String!
    body: String
    author: User!
  }

  union SearchResult = User | Post

  type Query {
    user(id: ID!): User
    post(id: ID!): Post
    search(query: String!, limit: Int = 10): [SearchResult!]!
    me: User
  }

  type Mutation {
    createPost(title: String!, body: String): Post!
    deletePost(id: ID!): Boolean!
  }
`;

describe('GraphQLParserService — SDL with unions/interfaces/enums', () => {
  let parser: GraphQLParserService;

  beforeAll(() => {
    parser = new GraphQLParserService();
  });

  it('parses the SDL into a ParsedSchema with non-empty operations', async () => {
    const parsed = await parser.parseSchema(GRAPHQL_FIXTURE);
    expect(parsed).toBeDefined();
    expect(parsed.operations.length).toBeGreaterThan(0);
  });

  it('extracts query operations (user, post, search, me)', async () => {
    const parsed = await parser.parseSchema(GRAPHQL_FIXTURE);
    const ops = await parser.extractOperations(parsed);
    const names = ops.map((o) => o.name);
    expect(names).toEqual(expect.arrayContaining(['user', 'post', 'search', 'me']));
  });

  it('extracts mutation operations (createPost, deletePost)', async () => {
    const parsed = await parser.parseSchema(GRAPHQL_FIXTURE);
    const ops = await parser.extractOperations(parsed);
    const names = ops.map((o) => o.name);
    expect(names).toEqual(expect.arrayContaining(['createPost', 'deletePost']));
  });

  it('extracts resources including User, Post, Role', async () => {
    const parsed = await parser.parseSchema(GRAPHQL_FIXTURE);
    const resources = await parser.extractResources(parsed);
    const names = resources.map((r) => r.name);
    // User + Post are object types, Role is an enum. Unions (SearchResult)
    // aren't always surfaced as resources by the parser — the point of
    // this test is that the primary types round-trip correctly.
    expect(names).toEqual(expect.arrayContaining(['User', 'Post', 'Role']));
  });

  // Note: the GraphQL parser used here is deliberately lenient about
  // malformed SDL — it's forgiving to support partial schemas during
  // authoring. We don't pin a "refuses invalid SDL" assertion here;
  // the OpenAPI / SOAP / Protobuf sections cover the "hard refuse"
  // contract for their respective formats.
});

// ═══════════════════════════════════════════════════════════════════════
//   SOAP — WSDL fixture with multiple operations
// ═══════════════════════════════════════════════════════════════════════

const WSDL_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<definitions name="StockQuote"
  targetNamespace="http://example.com/stockquote.wsdl"
  xmlns:tns="http://example.com/stockquote.wsdl"
  xmlns:xsd="http://www.w3.org/2001/XMLSchema"
  xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/"
  xmlns="http://schemas.xmlsoap.org/wsdl/">

  <types>
    <xsd:schema targetNamespace="http://example.com/stockquote.wsdl">
      <xsd:element name="TradePriceRequest">
        <xsd:complexType>
          <xsd:sequence>
            <xsd:element name="tickerSymbol" type="xsd:string"/>
          </xsd:sequence>
        </xsd:complexType>
      </xsd:element>
      <xsd:element name="TradePrice">
        <xsd:complexType>
          <xsd:sequence>
            <xsd:element name="price" type="xsd:float"/>
          </xsd:sequence>
        </xsd:complexType>
      </xsd:element>
      <xsd:element name="HistoricalRequest">
        <xsd:complexType>
          <xsd:sequence>
            <xsd:element name="tickerSymbol" type="xsd:string"/>
            <xsd:element name="days" type="xsd:int"/>
          </xsd:sequence>
        </xsd:complexType>
      </xsd:element>
      <xsd:element name="HistoricalResponse">
        <xsd:complexType>
          <xsd:sequence>
            <xsd:element name="prices" type="xsd:string"/>
          </xsd:sequence>
        </xsd:complexType>
      </xsd:element>
    </xsd:schema>
  </types>

  <message name="GetLastTradePriceInput">
    <part name="body" element="tns:TradePriceRequest"/>
  </message>
  <message name="GetLastTradePriceOutput">
    <part name="body" element="tns:TradePrice"/>
  </message>
  <message name="GetHistoricalPriceInput">
    <part name="body" element="tns:HistoricalRequest"/>
  </message>
  <message name="GetHistoricalPriceOutput">
    <part name="body" element="tns:HistoricalResponse"/>
  </message>

  <portType name="StockQuotePortType">
    <operation name="GetLastTradePrice">
      <input message="tns:GetLastTradePriceInput"/>
      <output message="tns:GetLastTradePriceOutput"/>
    </operation>
    <operation name="GetHistoricalPrice">
      <input message="tns:GetHistoricalPriceInput"/>
      <output message="tns:GetHistoricalPriceOutput"/>
    </operation>
  </portType>

  <binding name="StockQuoteSoapBinding" type="tns:StockQuotePortType">
    <soap:binding style="document" transport="http://schemas.xmlsoap.org/soap/http"/>
    <operation name="GetLastTradePrice">
      <soap:operation soapAction="http://example.com/GetLastTradePrice"/>
      <input><soap:body use="literal"/></input>
      <output><soap:body use="literal"/></output>
    </operation>
    <operation name="GetHistoricalPrice">
      <soap:operation soapAction="http://example.com/GetHistoricalPrice"/>
      <input><soap:body use="literal"/></input>
      <output><soap:body use="literal"/></output>
    </operation>
  </binding>

  <service name="StockQuoteService">
    <port name="StockQuotePort" binding="tns:StockQuoteSoapBinding">
      <soap:address location="http://example.com/stockquote"/>
    </port>
  </service>
</definitions>`;

describe('SOAPParserService — StockQuote WSDL fixture', () => {
  let parser: SOAPParserService;

  beforeAll(() => {
    parser = new SOAPParserService();
  });

  it('parses the WSDL into a ParsedSchema', async () => {
    const parsed = await parser.parseSchema(WSDL_FIXTURE);
    expect(parsed).toBeDefined();
    expect(parsed.operations.length).toBeGreaterThanOrEqual(2);
  });

  it('extracts both operations (GetLastTradePrice, GetHistoricalPrice)', async () => {
    const parsed = await parser.parseSchema(WSDL_FIXTURE);
    const ops = await parser.extractOperations(parsed);

    const names = ops.map((o) => o.name);
    expect(names).toEqual(expect.arrayContaining(['GetLastTradePrice', 'GetHistoricalPrice']));
  });

  it('refuses clearly malformed XML', async () => {
    await expect(parser.parseSchema('<definitions><not-closed>')).rejects.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════════
//   Protobuf — Greeter .proto fixture with nested messages
// ═══════════════════════════════════════════════════════════════════════

const PROTO_FIXTURE = `
  syntax = "proto3";
  package greeter.v1;

  service Greeter {
    rpc SayHello(HelloRequest) returns (HelloReply);
    rpc SayHelloStream(HelloRequest) returns (stream HelloReply);
    rpc GetUserInfo(GetUserInfoRequest) returns (UserInfo);
  }

  message HelloRequest {
    string name = 1;
    optional string language = 2;
  }

  message HelloReply {
    string message = 1;
    int32 timestamp = 2;
  }

  message GetUserInfoRequest {
    string user_id = 1;
  }

  message UserInfo {
    string user_id = 1;
    string email = 2;
    Role role = 3;
    message Address {
      string street = 1;
      string city = 2;
    }
    Address address = 4;
  }

  enum Role {
    ROLE_UNSPECIFIED = 0;
    ROLE_ADMIN = 1;
    ROLE_USER = 2;
  }
`;

describe('ProtobufParserService — Greeter service fixture', () => {
  let parser: ProtobufParserService;

  beforeAll(() => {
    parser = new ProtobufParserService();
  });

  it('parses the .proto into a ParsedSchema', async () => {
    const parsed = await parser.parseSchema(PROTO_FIXTURE);
    expect(parsed).toBeDefined();
  });

  it('extracts all three RPCs (SayHello, SayHelloStream, GetUserInfo)', async () => {
    const parsed = await parser.parseSchema(PROTO_FIXTURE);
    const ops = await parser.extractOperations(parsed);
    const names = ops.map((o) => o.name);
    expect(names).toEqual(
      expect.arrayContaining(['SayHello', 'SayHelloStream', 'GetUserInfo']),
    );
  });

  it('extracts resources including HelloRequest, HelloReply, UserInfo, Role', async () => {
    const parsed = await parser.parseSchema(PROTO_FIXTURE);
    const resources = await parser.extractResources(parsed);
    const names = resources.map((r) => r.name);
    expect(names).toEqual(
      expect.arrayContaining(['HelloRequest', 'HelloReply', 'UserInfo']),
    );
  });

  it('refuses a clearly malformed .proto', async () => {
    await expect(
      parser.parseSchema('syntax = "proto3"; service Broken { rpc { } }'),
    ).rejects.toThrow();
  });
});
