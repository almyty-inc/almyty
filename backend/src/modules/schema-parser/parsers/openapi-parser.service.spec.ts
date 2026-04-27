import { Test, TestingModule } from '@nestjs/testing';
import { OpenAPIParserService } from './openapi-parser.service';

describe('OpenAPIParserService', () => {
  let service: OpenAPIParserService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [OpenAPIParserService],
    }).compile();

    service = module.get<OpenAPIParserService>(OpenAPIParserService);
  });

  describe('parseSchema', () => {
    it('should parse valid OpenAPI 3.0 schema', async () => {
      const validSchema = JSON.stringify({
        openapi: '3.0.0',
        info: {
          title: 'Test API',
          description: 'A test API',
          version: '1.0.0',
        },
        servers: [
          {
            url: 'https://api.example.com',
            description: 'Production server',
          },
        ],
        paths: {
          '/users': {
            get: {
              operationId: 'getUsers',
              summary: 'Get all users',
              description: 'Retrieve a list of all users',
              tags: ['users'],
              parameters: [
                {
                  name: 'limit',
                  in: 'query',
                  description: 'Number of users to return',
                  required: false,
                  schema: {
                    type: 'integer',
                    default: 10,
                  },
                },
              ],
              responses: {
                '200': {
                  description: 'Successful response',
                  content: {
                    'application/json': {
                      schema: {
                        type: 'array',
                        items: {
                          $ref: '#/components/schemas/User',
                        },
                      },
                    },
                  },
                },
              },
            },
            post: {
              operationId: 'createUser',
              summary: 'Create a new user',
              tags: ['users'],
              requestBody: {
                required: true,
                content: {
                  'application/json': {
                    schema: {
                      $ref: '#/components/schemas/CreateUserRequest',
                    },
                  },
                },
              },
              responses: {
                '201': {
                  description: 'User created successfully',
                  content: {
                    'application/json': {
                      schema: {
                        $ref: '#/components/schemas/User',
                      },
                    },
                  },
                },
              },
            },
          },
          '/users/{userId}': {
            get: {
              operationId: 'getUserById',
              summary: 'Get user by ID',
              tags: ['users'],
              parameters: [
                {
                  name: 'userId',
                  in: 'path',
                  required: true,
                  schema: {
                    type: 'string',
                  },
                },
              ],
              responses: {
                '200': {
                  description: 'User found',
                  content: {
                    'application/json': {
                      schema: {
                        $ref: '#/components/schemas/User',
                      },
                    },
                  },
                },
                '404': {
                  description: 'User not found',
                },
              },
            },
          },
        },
        components: {
          schemas: {
            User: {
              type: 'object',
              description: 'User entity',
              required: ['id', 'email'],
              properties: {
                id: {
                  type: 'string',
                  description: 'Unique user identifier',
                },
                email: {
                  type: 'string',
                  format: 'email',
                  description: 'User email address',
                },
                name: {
                  type: 'string',
                  description: 'User display name',
                },
                createdAt: {
                  type: 'string',
                  format: 'date-time',
                  description: 'User creation timestamp',
                },
              },
            },
            CreateUserRequest: {
              type: 'object',
              description: 'Request payload for creating a user',
              required: ['email', 'name'],
              properties: {
                email: {
                  type: 'string',
                  format: 'email',
                },
                name: {
                  type: 'string',
                },
              },
            },
          },
        },
        tags: [
          {
            name: 'users',
            description: 'User management operations',
          },
        ],
      });

      const result = await service.parseSchema(validSchema, 'test-api.json');

      expect(result).toBeDefined();
      expect(result.version).toBe('3.0.0');
      expect(result.info.title).toBe('Test API');
      expect(result.info.description).toBe('A test API');
      expect(result.info.version).toBe('1.0.0');

      // Check operations
      expect(result.operations).toHaveLength(3);
      
      const getUsersOp = result.operations.find(op => op.operationId === 'getUsers');
      expect(getUsersOp).toBeDefined();
      expect(getUsersOp.method).toBe('GET');
      expect(getUsersOp.endpoint).toBe('/users');
      expect(getUsersOp.name).toBe('Get all users');
      expect(getUsersOp.tags).toEqual(['users']);

      const createUserOp = result.operations.find(op => op.operationId === 'createUser');
      expect(createUserOp).toBeDefined();
      expect(createUserOp.method).toBe('POST');
      expect(createUserOp.parameters.body.required).toBe(true);

      const getUserByIdOp = result.operations.find(op => op.operationId === 'getUserById');
      expect(getUserByIdOp).toBeDefined();
      expect(getUserByIdOp.parameters.path.userId).toBeDefined();

      // Check resources
      expect(result.resources).toHaveLength(2);
      
      const userResource = result.resources.find(r => r.name === 'User');
      expect(userResource).toBeDefined();
      expect(userResource.type).toBe('model');
      expect(userResource.description).toBe('User entity');
      expect(userResource.properties.id.required).toBe(true);
      expect(userResource.properties.email.required).toBe(true);
      expect(userResource.properties.name.required).toBe(false);

      // Check metadata
      expect(result.metadata.servers).toHaveLength(1);
      expect(result.metadata.servers[0].url).toBe('https://api.example.com');
      expect(result.metadata.tags).toHaveLength(1);
      expect(result.metadata.fileName).toBe('test-api.json');
      // originalSchema deliberately not retained — see parser
      // comment: keeping the parsed object on metadata doubled
      // the import's peak memory.
      expect((result.metadata as any).originalSchema).toBeUndefined();
    });

    it('should handle minimal OpenAPI schema', async () => {
      const minimalSchema = JSON.stringify({
        openapi: '3.0.0',
        info: {
          title: 'Minimal API',
          version: '1.0.0',
        },
        paths: {
          '/health': {
            get: {
              responses: {
                '200': {
                  description: 'OK',
                },
              },
            },
          },
        },
      });

      const result = await service.parseSchema(minimalSchema);

      expect(result).toBeDefined();
      expect(result.info.title).toBe('Minimal API');
      expect(result.operations).toHaveLength(1);
      expect(result.operations[0].operationId).toBe('get__health');
      expect(result.operations[0].name).toBe('GET /health');
      expect(result.resources).toHaveLength(0);
    });

    it('should handle invalid JSON', async () => {
      const invalidJson = '{ invalid json }';

      await expect(service.parseSchema(invalidJson)).rejects.toThrow('Invalid OpenAPI schema');
    });

    it('rejects schemas containing external $refs (SSRF / file-read protection)', async () => {
      // We dropped SwaggerParser.dereference (it deep-cloned every $ref
      // and was the dominant cause of the 7.7 MB Stripe import OOM),
      // so the implicit "valid OpenAPI version" validation it did is
      // also gone. The version check was incidental; what we MUST
      // still enforce is the SSRF guard against external $refs.
      const externalRefSchema = JSON.stringify({
        openapi: '3.0.0',
        info: { title: 'Sneaky', version: '1.0.0' },
        paths: {
          '/x': {
            get: {
              parameters: [
                { $ref: 'http://attacker.example/leak.json' },
              ],
              responses: { '200': { description: 'ok' } },
            },
          },
        },
      });
      await expect(service.parseSchema(externalRefSchema)).rejects.toThrow(/External \$ref blocked/);
    });
  });

  describe('validateSchema', () => {
    it('should validate correct OpenAPI schema', async () => {
      const validSchema = JSON.stringify({
        openapi: '3.0.0',
        info: {
          title: 'Valid API',
          version: '1.0.0',
        },
        paths: {},
      });

      const result = await service.validateSchema(validSchema);

      expect(result.isValid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should return validation errors for invalid schema', async () => {
      const invalidSchema = JSON.stringify({
        openapi: '3.0.0',
        // Missing required 'info' field
        paths: {},
      });

      const result = await service.validateSchema(invalidSchema);

      expect(result.isValid).toBe(false);
      expect(result.errors).not.toHaveLength(0);
    });

    it('should handle malformed JSON in validation', async () => {
      const malformedJson = '{ "openapi": "3.0.0" ';

      const result = await service.validateSchema(malformedJson);

      expect(result.isValid).toBe(false);
      expect(result.errors).toHaveLength(1);
    });
  });

  describe('extractOperations', () => {
    it('should convert parsed operations to Operation entities', async () => {
      const parsedSchema = {
        version: '3.0.0',
        info: {
          title: 'Test API',
          version: '1.0.0',
        },
        operations: [
          {
            operationId: 'getUsers',
            name: 'Get all users',
            description: 'Retrieve users',
            method: 'GET',
            endpoint: '/users',
            parameters: {
              query: { limit: { type: 'integer' } },
            },
            responses: {
              '200': { description: 'Success' },
            },
            security: [],
            tags: ['users'],
            deprecated: false,
          },
        ],
        resources: [],
        metadata: {},
      };

      const operations = await service.extractOperations(parsedSchema);

      expect(operations).toHaveLength(1);
      expect(operations[0].name).toBe('Get all users');
      expect(operations[0].operationId).toBe('getUsers');
      expect(operations[0].description).toBe('Retrieve users');
      expect(operations[0].method).toBe('GET');
      expect(operations[0].endpoint).toBe('/users');
      expect(operations[0].type).toBe('query');
      expect(operations[0].parameters).toEqual({
        query: { limit: { type: 'integer' } },
      });
      expect(operations[0].deprecated).toBe(false);
      expect(operations[0].isActive).toBe(true);
    });

    it('should determine correct operation types', async () => {
      const parsedSchema = {
        version: '3.0.0',
        info: { title: 'API', version: '1.0.0' },
        operations: [
          { operationId: 'getUser', method: 'GET', endpoint: '/users/1' },
          { operationId: 'createUser', method: 'POST', endpoint: '/users' },
          { operationId: 'updateUser', method: 'PUT', endpoint: '/users/1' },
          { operationId: 'patchUser', method: 'PATCH', endpoint: '/users/1' },
          { operationId: 'deleteUser', method: 'DELETE', endpoint: '/users/1' },
          { operationId: 'headUser', method: 'HEAD', endpoint: '/users/1' },
        ],
        resources: [],
        metadata: {},
      };

      const operations = await service.extractOperations(parsedSchema as any);

      expect(operations.find(op => op.method === 'GET').type).toBe('query');
      expect(operations.find(op => op.method === 'POST').type).toBe('mutation');
      expect(operations.find(op => op.method === 'PUT').type).toBe('mutation');
      expect(operations.find(op => op.method === 'PATCH').type).toBe('mutation');
      expect(operations.find(op => op.method === 'DELETE').type).toBe('mutation');
      expect(operations.find(op => op.method === 'HEAD').type).toBe('rpc');
    });
  });

  describe('extractResources', () => {
    it('should convert parsed resources to Resource entities', async () => {
      const parsedSchema = {
        version: '3.0.0',
        info: { title: 'API', version: '1.0.0' },
        operations: [],
        resources: [
          {
            name: 'User',
            description: 'User model',
            type: 'model',
            properties: {
              id: { type: 'string', required: true },
              name: { type: 'string', required: false },
            },
            schema: { type: 'object' },
            examples: [{ id: '1', name: 'John' }],
          },
          {
            name: 'Status',
            description: 'Status enum',
            type: 'enum',
            properties: {},
            schema: { enum: ['active', 'inactive'] },
          },
        ],
        metadata: {},
      };

      const resources = await service.extractResources(parsedSchema as any);

      expect(resources).toHaveLength(2);
      
      const userResource = resources.find(r => r.name === 'User');
      expect(userResource.description).toBe('User model');
      expect(userResource.type).toBe('model');
      expect(userResource.properties).toEqual({
        id: { type: 'string', required: true },
        name: { type: 'string', required: false },
      });
      expect(userResource.examples).toEqual([{ id: '1', name: 'John' }]);
      expect(userResource.isActive).toBe(true);

      const statusResource = resources.find(r => r.name === 'Status');
      expect(statusResource.type).toBe('enum');
    });
  });

  describe('Parameter extraction', () => {
    it('should extract path parameters correctly', () => {
      const parameters = [
        {
          name: 'userId',
          in: 'path',
          required: true,
          description: 'User ID',
          schema: { type: 'string' },
          example: '123',
        },
      ];

      const result = service['extractParameters'](parameters as any, undefined, {} as any);

      expect(result.path.userId).toEqual({
        type: 'string',
        description: 'User ID',
        required: true,
        example: '123',
        schema: { type: 'string' },
      });
    });

    it('should extract query parameters correctly', () => {
      const parameters = [
        {
          name: 'limit',
          in: 'query',
          required: false,
          schema: { type: 'integer', default: 10 },
        },
        {
          name: 'offset',
          in: 'query',
          required: false,
          schema: { type: 'integer', default: 0 },
        },
      ];

      const result = service['extractParameters'](parameters as any, undefined, {} as any);

      expect(result.query.limit.type).toBe('integer');
      expect(result.query.offset.type).toBe('integer');
    });

    it('should extract request body correctly', () => {
      const requestBody = {
        required: true,
        description: 'User data',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                email: { type: 'string' },
              },
            },
          },
        },
      };

      const result = service['extractParameters'](undefined, requestBody as any, {} as any);

      expect(result.body.contentType).toBe('application/json');
      expect(result.body.required).toBe(true);
      expect(result.body.description).toBe('User data');
      expect(result.body.schema).toBeDefined();
    });

    it('should extract header parameters correctly (lines 200-201)', () => {
      const parameters = [
        {
          name: 'Authorization',
          in: 'header',
          required: true,
          schema: { type: 'string' },
          description: 'Bearer token',
        },
        {
          name: 'X-API-Key',
          in: 'header',
          required: false,
          schema: { type: 'string' },
        },
      ];

      const result = service['extractParameters'](parameters as any, undefined, {} as any);

      expect(result.header.Authorization).toEqual({
        type: 'string',
        description: 'Bearer token',
        required: true,
        schema: { type: 'string' },
      });
      expect(result.header['X-API-Key']).toEqual({
        type: 'string',
        required: false,
        schema: { type: 'string' },
      });
    });

    it('should extract examples from media type content (line 255)', () => {
      const content = {
        'application/json': {
          schema: { type: 'object' },
          example: { id: '123', name: 'Test' },
        },
      };

      const result = service['extractExamplesFromContent'](content as any, {} as any);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({ id: '123', name: 'Test' });
    });
  });

  describe('Response extraction', () => {
    it('should extract responses with schemas', () => {
      const responses = {
        '200': {
          description: 'Success',
          content: {
            'application/json': {
              schema: {
                type: 'array',
                items: { type: 'object' },
              },
              examples: {
                users: {
                  value: [{ id: '1', name: 'John' }],
                },
              },
            },
          },
        },
        '404': {
          description: 'Not found',
        },
      };

      const result = service['extractResponses'](responses as any, {} as any);

      expect(result['200'].description).toBe('Success');
      expect(result['200'].schema).toEqual({
        type: 'array',
        items: { type: 'object' },
      });
      expect(result['200'].examples).toEqual([[{ id: '1', name: 'John' }]]);

      expect(result['404'].description).toBe('Not found');
      expect(result['404'].schema).toBeUndefined();
    });
  });

  describe('Resource type determination', () => {
    it('should identify enum resources', () => {
      const schema = { enum: ['active', 'inactive', 'pending'] };
      const result = service['determineResourceType'](schema);
      expect(result).toBe('enum');
    });

    it('should identify object models', () => {
      const schema = { type: 'object', properties: { id: { type: 'string' } } };
      const result = service['determineResourceType'](schema);
      expect(result).toBe('model');
    });

    it('should default to model type', () => {
      const schema = { type: 'string' };
      const result = service['determineResourceType'](schema);
      expect(result).toBe('model');
    });
  });

  describe('Reference resolution', () => {
    it('should resolve simple references', () => {
      const document = {
        components: {
          schemas: {
            User: { type: 'object', properties: { id: { type: 'string' } } },
          },
        },
      };

      const ref = { $ref: '#/components/schemas/User' };
      const result = service['resolveReference'](ref, document as any);

      expect(result).toEqual({ type: 'object', properties: { id: { type: 'string' } } });
    });

    it('should return object as-is when no reference', () => {
      const obj = { type: 'string' };
      const result = service['resolveReference'](obj);
      expect(result).toBe(obj);
    });

    it('should handle broken references gracefully', () => {
      const document = { components: { schemas: {} } };
      const ref = { $ref: '#/components/schemas/NonExistent' };
      const result = service['resolveReference'](ref, document as any);
      expect(result).toBeUndefined();
    });
  });

  describe('YAML schema parsing', () => {
    it('should parse a valid YAML OpenAPI schema', async () => {
      const yamlSchema = `
openapi: "3.0.0"
info:
  title: YAML Test API
  version: "1.0.0"
paths:
  /hello:
    get:
      operationId: getHello
      summary: Say hello
      responses:
        "200":
          description: OK
`;
      const result = await service.parseSchema(yamlSchema);
      expect(result.info.title).toBe('YAML Test API');
      expect(result.info.version).toBe('1.0.0');
      expect(result.operations.length).toBe(1);
      expect(result.operations[0].operationId).toBe('getHello');
    });

    it('should not treat YAML content as a file $ref', async () => {
      const yamlSchema = `
openapi: "3.0.0"
info:
  title: Not A Ref
  version: "1.0.0"
paths: {}
`;
      // This was the bug: YAML string was passed to SwaggerParser.dereference
      // as a string, which treated it as a file path reference
      const result = await service.parseSchema(yamlSchema);
      expect(result.info.title).toBe('Not A Ref');
    });
  });
});