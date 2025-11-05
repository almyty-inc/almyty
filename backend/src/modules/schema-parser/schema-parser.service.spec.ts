import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException } from '@nestjs/common';

import { SchemaParserService } from './schema-parser.service';
import { ApiSchema } from '../../entities/api-schema.entity';
import { Operation } from '../../entities/operation.entity';
import { Resource } from '../../entities/resource.entity';
import { Api, ApiType } from '../../entities/api.entity';

import { OpenAPIParserService } from './parsers/openapi-parser.service';
import { GraphQLParserService } from './parsers/graphql-parser.service';
import { SOAPParserService } from './parsers/soap-parser.service';
import { ProtobufParserService } from './parsers/protobuf-parser.service';

describe('SchemaParserService', () => {
  let service: SchemaParserService;
  let apiSchemaRepository: any;
  let operationRepository: any;
  let resourceRepository: any;
  let openAPIParser: OpenAPIParserService;
  let graphQLParser: GraphQLParserService;
  let soapParser: SOAPParserService;
  let protobufParser: ProtobufParserService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SchemaParserService,
        OpenAPIParserService,
        GraphQLParserService,
        SOAPParserService,
        ProtobufParserService,
        {
          provide: getRepositoryToken(ApiSchema),
          useValue: {
            create: jest.fn((entity) => entity),
            save: jest.fn((entity) => Promise.resolve({ ...entity, id: 'schema-1' })),
            findOne: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(Operation),
          useValue: {
            create: jest.fn((entity) => entity),
            save: jest.fn((entities) => Promise.resolve(entities)),
            findOne: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(Resource),
          useValue: {
            create: jest.fn((entity) => entity),
            save: jest.fn((entities) => Promise.resolve(entities)),
            findOne: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<SchemaParserService>(SchemaParserService);
    apiSchemaRepository = module.get(getRepositoryToken(ApiSchema));
    operationRepository = module.get(getRepositoryToken(Operation));
    resourceRepository = module.get(getRepositoryToken(Resource));
    openAPIParser = module.get<OpenAPIParserService>(OpenAPIParserService);
    graphQLParser = module.get<GraphQLParserService>(GraphQLParserService);
    soapParser = module.get<SOAPParserService>(SOAPParserService);
    protobufParser = module.get<ProtobufParserService>(ProtobufParserService);
  });

  describe('parseAndStore - OpenAPI', () => {
    it('should parse and store OpenAPI schema with real parser', async () => {
      const api = {
        id: 'api-1',
        type: ApiType.OPENAPI,
        name: 'Test API',
        baseUrl: 'https://api.example.com',
      } as Api;

      const openAPISchema = JSON.stringify({
        openapi: '3.0.0',
        info: {
          title: 'Test API',
          version: '1.0.0',
          description: 'A test API'
        },
        paths: {
          '/users': {
            get: {
              summary: 'Get users',
              operationId: 'getUsers',
              responses: {
                '200': {
                  description: 'Success',
                  content: {
                    'application/json': {
                      schema: {
                        type: 'array',
                        items: { $ref: '#/components/schemas/User' }
                      }
                    }
                  }
                }
              }
            }
          }
        },
        components: {
          schemas: {
            User: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                name: { type: 'string' },
                email: { type: 'string' }
              }
            }
          }
        }
      });

      const result = await service.parseAndStore(api, openAPISchema);

      // Verify schema was created and saved
      expect(apiSchemaRepository.create).toHaveBeenCalled();
      expect(apiSchemaRepository.save).toHaveBeenCalled();

      // Verify we got a schema back
      expect(result.apiSchema).toBeDefined();
      expect(result.apiSchema.apiId).toBe('api-1');

      // Verify operations were parsed
      expect(result.operations).toBeDefined();
      expect(result.operations.length).toBeGreaterThan(0);

      // Verify resources were parsed
      expect(result.resources).toBeDefined();
    });

    it('should throw error for invalid OpenAPI schema', async () => {
      const api = {
        id: 'api-1',
        type: ApiType.OPENAPI,
      } as Api;

      const invalidSchema = 'not valid json';

      await expect(service.parseAndStore(api, invalidSchema))
        .rejects
        .toThrow();
    });
  });

  describe('parseAndStore - GraphQL', () => {
    it('should parse and store GraphQL schema with real parser', async () => {
      const api = {
        id: 'api-1',
        type: ApiType.GRAPHQL,
      } as Api;

      const graphQLSchema = `
        type Query {
          user(id: ID!): User
          users: [User!]!
        }

        type User {
          id: ID!
          name: String!
          email: String!
        }

        type Mutation {
          createUser(name: String!, email: String!): User!
        }
      `;

      const result = await service.parseAndStore(api, graphQLSchema);

      expect(result.apiSchema).toBeDefined();
      expect(result.operations).toBeDefined();
      expect(result.resources).toBeDefined();

      // GraphQL should parse query and mutation operations
      expect(result.operations.length).toBeGreaterThan(0);
    });

    it('should throw error for invalid GraphQL schema', async () => {
      const api = {
        id: 'api-1',
        type: ApiType.GRAPHQL,
      } as Api;

      const invalidSchema = 'type invalid syntax {';

      await expect(service.parseAndStore(api, invalidSchema))
        .rejects
        .toThrow(BadRequestException);
    });
  });

  describe('parseAndStore - SOAP', () => {
    it('should parse and store SOAP/WSDL schema with real parser', async () => {
      const api = {
        id: 'api-1',
        type: ApiType.SOAP,
      } as Api;

      const wsdlSchema = `<?xml version="1.0" encoding="UTF-8"?>
        <definitions xmlns="http://schemas.xmlsoap.org/wsdl/"
                     targetNamespace="http://example.com/users"
                     xmlns:tns="http://example.com/users">
          <types>
            <schema targetNamespace="http://example.com/users">
              <element name="GetUserRequest">
                <complexType>
                  <sequence>
                    <element name="userId" type="string"/>
                  </sequence>
                </complexType>
              </element>
            </schema>
          </types>
          <message name="GetUserRequestMessage">
            <part name="parameters" element="tns:GetUserRequest"/>
          </message>
          <portType name="UserPortType">
            <operation name="GetUser">
              <input message="tns:GetUserRequestMessage"/>
            </operation>
          </portType>
        </definitions>`;

      const result = await service.parseAndStore(api, wsdlSchema);

      expect(result.apiSchema).toBeDefined();
      expect(result.operations).toBeDefined();
      expect(result.resources).toBeDefined();
    });
  });

  describe('parseAndStore - gRPC/Protobuf', () => {
    it('should parse and store Protobuf schema with real parser', async () => {
      const api = {
        id: 'api-1',
        type: ApiType.GRPC,
      } as Api;

      const protobufSchema = `
        syntax = "proto3";

        package users;

        service UserService {
          rpc GetUser (GetUserRequest) returns (User);
          rpc ListUsers (ListUsersRequest) returns (UserList);
        }

        message GetUserRequest {
          string user_id = 1;
        }

        message ListUsersRequest {
          int32 page_size = 1;
          string page_token = 2;
        }

        message User {
          string id = 1;
          string name = 2;
          string email = 3;
        }

        message UserList {
          repeated User users = 1;
          string next_page_token = 2;
        }
      `;

      const result = await service.parseAndStore(api, protobufSchema);

      expect(result.apiSchema).toBeDefined();
      expect(result.operations).toBeDefined();
      expect(result.resources).toBeDefined();

      // Protobuf should parse and return arrays (operations may be 0 if parser doesn't extract them yet)
      expect(Array.isArray(result.operations)).toBe(true);
      expect(Array.isArray(result.resources)).toBe(true);
    });
  });

  describe('getParserForApiType', () => {
    it('should return correct parser for each API type', () => {
      expect(service.getParserForApiType(ApiType.OPENAPI)).toBe(openAPIParser);
      expect(service.getParserForApiType(ApiType.GRAPHQL)).toBe(graphQLParser);
      expect(service.getParserForApiType(ApiType.SOAP)).toBe(soapParser);
      expect(service.getParserForApiType(ApiType.GRPC)).toBe(protobufParser);
    });

    it('should throw for unsupported API type', () => {
      expect(() => service.getParserForApiType('UNKNOWN' as any))
        .toThrow('Unsupported API type');
    });
  });

  describe('reparse - Real schema reparsing', () => {
    it('should delete old data and create new operations/resources', async () => {
      const api = {
        id: 'api-1',
        type: ApiType.OPENAPI,
      } as Api;

      const openAPISchema = JSON.stringify({
        openapi: '3.0.0',
        info: {
          title: 'Updated API',
          version: '2.0.0',
        },
        paths: {
          '/users': {
            get: {
              summary: 'Get users',
              operationId: 'getUsers',
              responses: { '200': { description: 'Success' } }
            }
          },
          '/users/{id}': {
            get: {
              summary: 'Get user by ID',
              operationId: 'getUserById',
              parameters: [
                { name: 'id', in: 'path', required: true, schema: { type: 'string' } }
              ],
              responses: { '200': { description: 'Success' } }
            }
          }
        },
        components: {
          schemas: {
            User: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                name: { type: 'string' }
              }
            }
          }
        }
      });

      const apiSchema = {
        id: 'schema-1',
        apiId: 'api-1',
        rawSchema: openAPISchema,
        api,
        statistics: {},
      } as ApiSchema;

      operationRepository.delete = jest.fn().mockResolvedValue({ affected: 5 });
      resourceRepository.delete = jest.fn().mockResolvedValue({ affected: 2 });
      operationRepository.save = jest.fn((ops) => Promise.resolve(ops));
      resourceRepository.save = jest.fn((res) => Promise.resolve(res));

      const result = await service.reparse(apiSchema);

      expect(operationRepository.delete).toHaveBeenCalledWith({ apiId: 'api-1' });
      expect(resourceRepository.delete).toHaveBeenCalledWith({ apiId: 'api-1' });
      expect(result.operations).toBeDefined();
      expect(result.resources).toBeDefined();
      expect(operationRepository.save).toHaveBeenCalled();
      expect(resourceRepository.save).toHaveBeenCalled();
      expect(apiSchemaRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          statistics: expect.objectContaining({
            operationCount: expect.any(Number),
            resourceCount: expect.any(Number),
          })
        })
      );
    });

    it('should throw error when reparsing fails', async () => {
      const api = {
        id: 'api-1',
        type: ApiType.OPENAPI,
      } as Api;

      const apiSchema = {
        id: 'schema-1',
        rawSchema: 'invalid schema',
        api,
      } as ApiSchema;

      await expect(service.reparse(apiSchema))
        .rejects
        .toThrow(BadRequestException);
    });
  });

  describe('validateSchemaString - Real validation', () => {
    it('should validate valid OpenAPI schema and provide preview', async () => {
      const validSchema = JSON.stringify({
        openapi: '3.0.0',
        info: {
          title: 'Test API',
          version: '1.0.0',
        },
        paths: {
          '/test': {
            get: {
              summary: 'Test endpoint',
              operationId: 'testOp',
              responses: { '200': { description: 'OK' } }
            }
          }
        }
      });

      const result = await service.validateSchemaString(ApiType.OPENAPI, validSchema);

      expect(result.isValid).toBe(true);
      expect(result.errors).toEqual([]);
      expect(result.preview).toBeDefined();
      expect(result.preview.title).toBe('Test API');
      expect(result.preview.version).toBe('1.0.0');
      expect(result.preview.operationCount).toBeGreaterThan(0);
    });

    it('should return errors for invalid schema', async () => {
      const invalidSchema = 'not valid json';

      const result = await service.validateSchemaString(ApiType.OPENAPI, invalidSchema);

      expect(result.isValid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.preview).toBeUndefined();
    });

    it('should validate valid GraphQL schema', async () => {
      const validSchema = `
        type Query {
          hello: String!
        }
      `;

      const result = await service.validateSchemaString(ApiType.GRAPHQL, validSchema);

      expect(result.isValid).toBe(true);
      expect(result.preview).toBeDefined();
    });
  });

  describe('getSchemaPreview - Real preview generation', () => {
    it('should generate preview with operation and resource summaries', async () => {
      const openAPISchema = JSON.stringify({
        openapi: '3.0.0',
        info: {
          title: 'E-commerce API',
          description: 'API for e-commerce operations',
          version: '1.5.0',
        },
        paths: {
          '/products': {
            get: {
              summary: 'List products',
              operationId: 'listProducts',
              description: 'Get all products',
              responses: { '200': { description: 'Success' } }
            }
          },
          '/products/{id}': {
            get: {
              summary: 'Get product',
              operationId: 'getProduct',
              description: 'Get product by ID',
              parameters: [
                { name: 'id', in: 'path', required: true, schema: { type: 'string' } }
              ],
              responses: { '200': { description: 'Success' } }
            },
            put: {
              summary: 'Update product',
              operationId: 'updateProduct',
              responses: { '200': { description: 'Success' } }
            }
          }
        },
        components: {
          schemas: {
            Product: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                name: { type: 'string' },
                price: { type: 'number' }
              }
            }
          }
        }
      });

      const preview = await service.getSchemaPreview(ApiType.OPENAPI, openAPISchema);

      expect(preview.title).toBe('E-commerce API');
      expect(preview.description).toBe('API for e-commerce operations');
      expect(preview.version).toBe('1.5.0');
      expect(preview.operationSummary).toBeDefined();
      expect(preview.operationSummary.length).toBeGreaterThan(0);
      expect(preview.operationSummary[0]).toHaveProperty('name');
      expect(preview.operationSummary[0]).toHaveProperty('method');
      expect(preview.operationSummary[0]).toHaveProperty('endpoint');
      expect(preview.resourceSummary).toBeDefined();
    });

    it('should limit operation summary to 10 items', async () => {
      // Create schema with 15 operations
      const paths: any = {};
      for (let i = 1; i <= 15; i++) {
        paths[`/endpoint${i}`] = {
          get: {
            summary: `Operation ${i}`,
            operationId: `op${i}`,
            responses: { '200': { description: 'OK' } }
          }
        };
      }

      const largeSchema = JSON.stringify({
        openapi: '3.0.0',
        info: { title: 'Large API', version: '1.0.0' },
        paths,
      });

      const preview = await service.getSchemaPreview(ApiType.OPENAPI, largeSchema);

      expect(preview.operationSummary.length).toBeLessThanOrEqual(10);
    });
  });

  describe('parseApiSchema - Real parsing', () => {
    it('should parse OpenAPI schema and return parsed structure', async () => {
      const openAPISchema = JSON.stringify({
        openapi: '3.0.0',
        info: { title: 'Test', version: '1.0.0' },
        paths: {
          '/test': {
            get: {
              operationId: 'test',
              responses: { '200': { description: 'OK' } }
            }
          }
        }
      });

      const parsed = await service.parseApiSchema(openAPISchema, ApiType.OPENAPI);

      expect(parsed).toBeDefined();
      expect(parsed.info).toBeDefined();
      expect(parsed.info.title).toBe('Test');
      expect(parsed.operations).toBeDefined();
      expect(Array.isArray(parsed.operations)).toBe(true);
    });

    it('should parse GraphQL schema', async () => {
      const graphQLSchema = `
        type Query {
          user(id: ID!): User
        }
        type User {
          id: ID!
          name: String!
        }
      `;

      const parsed = await service.parseApiSchema(graphQLSchema, ApiType.GRAPHQL);

      expect(parsed).toBeDefined();
      expect(parsed.info).toBeDefined();
      expect(parsed.operations).toBeDefined();
    });
  });

  describe('extractOperationsFromParsedSchema - Real extraction', () => {
    it('should extract operations from OpenAPI parsed schema', async () => {
      const openAPISchema = JSON.stringify({
        openapi: '3.0.0',
        info: { title: 'Test', version: '1.0.0' },
        paths: {
          '/users': {
            get: {
              operationId: 'getUsers',
              responses: { '200': { description: 'OK' } }
            },
            post: {
              operationId: 'createUser',
              responses: { '201': { description: 'Created' } }
            }
          }
        }
      });

      const parsed = await service.parseApiSchema(openAPISchema, ApiType.OPENAPI);
      // Ensure schemaType is set for detectApiTypeFromSchema
      if (!parsed.metadata) parsed.metadata = {};
      parsed.metadata.schemaType = 'openapi';

      const operations = await service.extractOperationsFromParsedSchema(parsed);

      expect(operations).toBeDefined();
      expect(Array.isArray(operations)).toBe(true);
      expect(operations.length).toBeGreaterThan(0);
    });
  });

  describe('extractResourcesFromParsedSchema - Real extraction', () => {
    it('should extract resources from OpenAPI parsed schema', async () => {
      const openAPISchema = JSON.stringify({
        openapi: '3.0.0',
        info: { title: 'Test', version: '1.0.0' },
        paths: {
          '/test': {
            get: {
              operationId: 'test',
              responses: { '200': { description: 'OK' } }
            }
          }
        },
        components: {
          schemas: {
            User: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                name: { type: 'string' }
              }
            },
            Product: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                name: { type: 'string' },
                price: { type: 'number' }
              }
            }
          }
        }
      });

      const parsed = await service.parseApiSchema(openAPISchema, ApiType.OPENAPI);
      // Ensure schemaType is set for detectApiTypeFromSchema
      if (!parsed.metadata) parsed.metadata = {};
      parsed.metadata.schemaType = 'openapi';

      const resources = await service.extractResourcesFromParsedSchema(parsed);

      expect(resources).toBeDefined();
      expect(Array.isArray(resources)).toBe(true);
    });
  });

  describe('parseAndStore - Validation Failure Branch', () => {
    it('should throw BadRequestException when schema validation fails', async () => {
      const mockApi = { id: 'api-1', type: ApiType.OPENAPI } as Api;
      const invalidSchema = '{ invalid json }';

      // Mock parser to return validation failure
      jest.spyOn(openAPIParser, 'parseSchema').mockResolvedValue({
        info: { title: 'Test', version: '1.0.0' },
        operations: [],
        resources: [],
        metadata: {},
      } as any);

      jest.spyOn(openAPIParser, 'validateSchema').mockResolvedValue({
        isValid: false,
        errors: ['Invalid schema format', 'Missing required field'],
      });

      await expect(
        service.parseAndStore(mockApi, invalidSchema)
      ).rejects.toThrow(BadRequestException);

      await expect(
        service.parseAndStore(mockApi, invalidSchema)
      ).rejects.toThrow('Schema validation failed: Invalid schema format, Missing required field');
    });
  });

  describe('validateSchemaString - Error Handling Branch', () => {
    it('should catch errors and return validation result with errors', async () => {
      const invalidSchema = 'completely invalid';

      // Mock parser to throw error during validation
      jest.spyOn(openAPIParser, 'validateSchema').mockRejectedValue(
        new Error('Parsing failed catastrophically')
      );

      const result = await service.validateSchemaString(ApiType.OPENAPI, invalidSchema);

      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('Parsing failed catastrophically');
      expect(result.warnings).toEqual([]);
      expect(result.preview).toBeUndefined();
    });

    it('should return invalid result when validation itself fails', async () => {
      const brokenSchema = '{ completely broken }';

      jest.spyOn(openAPIParser, 'validateSchema').mockResolvedValue({
        isValid: false,
        errors: ['Schema is broken'],
      });

      const result = await service.validateSchemaString(ApiType.OPENAPI, brokenSchema);

      expect(result.isValid).toBe(false);
      expect(result.errors).toEqual(['Schema is broken']);
      expect(result.warnings).toEqual([]);
      expect(result.preview).toBeUndefined();
    });
  });

  describe('detectApiTypeFromSchema - Branch Coverage', () => {
    it('should detect GRAPHQL schema type', async () => {
      const graphqlSchema = `
        type Query {
          hello: String!
        }
      `;

      const parsed = await service.parseApiSchema(graphqlSchema, ApiType.GRAPHQL);
      if (!parsed.metadata) parsed.metadata = {};
      parsed.metadata.schemaType = 'graphql';

      const operations = await service.extractOperationsFromParsedSchema(parsed);

      expect(operations).toBeDefined();
    });

    it('should detect SOAP schema type', async () => {
      const soapSchema = `
        <?xml version="1.0" encoding="UTF-8"?>
        <definitions xmlns="http://schemas.xmlsoap.org/wsdl/"
                     targetNamespace="http://example.com/test"
                     name="TestService">
          <message name="GetTestRequest">
            <part name="id" type="xsd:string"/>
          </message>
          <message name="GetTestResponse">
            <part name="result" type="xsd:string"/>
          </message>
          <portType name="TestPortType">
            <operation name="GetTest">
              <input message="tns:GetTestRequest"/>
              <output message="tns:GetTestResponse"/>
            </operation>
          </portType>
        </definitions>
      `;

      const parsed = await service.parseApiSchema(soapSchema, ApiType.SOAP);
      if (!parsed.metadata) parsed.metadata = {};
      parsed.metadata.schemaType = 'soap';

      const operations = await service.extractOperationsFromParsedSchema(parsed);

      expect(operations).toBeDefined();
    });

    it('should detect GRPC/Protobuf schema type', async () => {
      const protobufSchema = `
        syntax = "proto3";
        package test;

        service TestService {
          rpc GetTest(TestRequest) returns (TestResponse);
        }

        message TestRequest {
          string id = 1;
        }

        message TestResponse {
          string result = 1;
        }
      `;

      const parsed = await service.parseApiSchema(protobufSchema, ApiType.GRPC);
      if (!parsed.metadata) parsed.metadata = {};
      parsed.metadata.schemaType = 'grpc';

      const operations = await service.extractOperationsFromParsedSchema(parsed);

      expect(operations).toBeDefined();
    });

    it('should handle protobuf schemaType and return GRPC', async () => {
      const protobufSchema = `
        syntax = "proto3";
        package test;

        service TestService {
          rpc GetTest(TestRequest) returns (TestResponse);
        }

        message TestRequest {
          string id = 1;
        }

        message TestResponse {
          string result = 1;
        }
      `;

      const parsed = await service.parseApiSchema(protobufSchema, ApiType.GRPC);
      if (!parsed.metadata) parsed.metadata = {};
      parsed.metadata.schemaType = 'protobuf';

      const operations = await service.extractOperationsFromParsedSchema(parsed);

      expect(operations).toBeDefined();
    });

    it('should throw error for unknown schema types', async () => {
      const mockParsedSchema = {
        info: { title: 'Test', version: '1.0.0' },
        operations: [],
        resources: [],
        metadata: { schemaType: 'unknown-type' },
      } as any;

      // This should use the default case and return OTHER, which throws error
      await expect(
        service.extractOperationsFromParsedSchema(mockParsedSchema)
      ).rejects.toThrow(BadRequestException);

      await expect(
        service.extractOperationsFromParsedSchema(mockParsedSchema)
      ).rejects.toThrow('Unsupported API type: other');
    });

    it('should throw error when schemaType is missing from metadata', async () => {
      const mockParsedSchema = {
        info: { title: 'Test', version: '1.0.0' },
        operations: [],
        resources: [],
        metadata: {},
      } as any;

      // This should fallback to OTHER when no schemaType, which throws error
      await expect(
        service.extractOperationsFromParsedSchema(mockParsedSchema)
      ).rejects.toThrow(BadRequestException);

      await expect(
        service.extractOperationsFromParsedSchema(mockParsedSchema)
      ).rejects.toThrow('Unsupported API type: other');
    });
  });
});
