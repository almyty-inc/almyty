import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { ApiType } from '../src/entities/api.entity';

describe('Complete almyty System (e2e)', () => {
  let app: INestApplication;
  let authToken: string;
  let organizationId: string;
  let apiId: string;
  let generatedTools: any[] = [];

  const testUser = {
    email: `test-${Date.now()}@almyty.com`,
    password: 'testpass123',
    firstName: 'Test',
    lastName: 'User'
  };

  const realPetStoreSchema = {
    openapi: '3.0.0',
    info: {
      title: 'Pet Store API',
      description: 'A real pet store API for testing',
      version: '1.0.0'
    },
    servers: [
      { url: 'https://petstore.swagger.io/v2' }
    ],
    paths: {
      '/pets': {
        get: {
          operationId: 'listPets',
          summary: 'List all pets',
          parameters: [
            {
              name: 'limit',
              in: 'query',
              schema: { type: 'integer', maximum: 100 }
            }
          ],
          responses: {
            '200': {
              description: 'A list of pets',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/Pets' }
                }
              }
            }
          }
        },
        post: {
          operationId: 'createPet',
          summary: 'Create a pet',
          requestBody: {
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Pet' }
              }
            }
          },
          responses: {
            '201': { description: 'Pet created' }
          }
        }
      },
      '/pets/{petId}': {
        get: {
          operationId: 'getPetById',
          summary: 'Get pet by ID',
          parameters: [
            {
              name: 'petId',
              in: 'path',
              required: true,
              schema: { type: 'string' }
            }
          ],
          responses: {
            '200': { description: 'Pet details' }
          }
        }
      }
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
              enum: ['available', 'pending', 'sold'] 
            }
          }
        },
        Pets: {
          type: 'array',
          items: { $ref: '#/components/schemas/Pet' }
        }
      }
    }
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('Complete Pipeline Test', () => {
    it('should register user and create organization', async () => {
      const response = await request(app.getHttpServer())
        .post('/auth/register')
        .send(testUser)
        .expect(201);

      expect(response.body.success).toBe(true);
      expect(response.body.data.accessToken).toBeDefined();

      authToken = response.body.data.accessToken;

      expect(authToken).toMatch(/^[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+$/); // JWT format

      // Fetch profile to get organization membership
      const profileRes = await request(app.getHttpServer())
        .get('/auth/profile')
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      expect(profileRes.body.data.organizationMemberships).toBeDefined();
      expect(profileRes.body.data.organizationMemberships.length).toBeGreaterThan(0);

      organizationId = profileRes.body.data.organizationMemberships[0].organization.id;
      expect(organizationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/); // UUID format
    });

    it('should create API successfully', async () => {
      const apiData = {
        name: 'Test Pet Store API',
        description: 'Real API for testing complete pipeline',
        baseUrl: 'https://petstore.swagger.io/v2',
        type: ApiType.OPENAPI,
        version: '1.0.0'
      };

      const response = await request(app.getHttpServer())
        .post('/apis')
        .set('Authorization', `Bearer ${authToken}`)
        .send(apiData)
        .expect(201);

      expect(response.body.id).toBeDefined();
      expect(response.body.name).toBe(apiData.name);
      expect(response.body.type).toBe(ApiType.OPENAPI);
      expect(response.body.organizationId).toBe(organizationId);

      apiId = response.body.id;
    });

    it('should import schema and generate operations/resources', async () => {
      const importData = {
        schemaContent: JSON.stringify(realPetStoreSchema),
        description: 'Pet Store OpenAPI schema for testing',
        generateTools: true
      };

      const response = await request(app.getHttpServer())
        .post(`/apis/${apiId}/import-schema`)
        .set('Authorization', `Bearer ${authToken}`)
        .send(importData)
        .expect(201);

      expect(response.body.api).toBeDefined();
      expect(response.body.schema).toBeDefined();
      expect(response.body.operations).toBeDefined();
      expect(response.body.resources).toBeDefined();

      // Should have 3 operations: GET /pets, POST /pets, GET /pets/{petId}
      expect(response.body.operations).toHaveLength(3);
      
      // Should have 2 resources: Pet and Pets
      expect(response.body.resources).toHaveLength(2);

      // Verify operation details
      const operations = response.body.operations;
      const operationIds = operations.map(op => op.operationId || op.name);
      
      expect(operationIds).toContain('listPets');
      expect(operationIds).toContain('createPet');
      expect(operationIds).toContain('getPetById');

      // Tools should be generated
      if (response.body.tools) {
        expect(response.body.tools.length).toBeGreaterThan(0);
        generatedTools = response.body.tools;
      }
    });

    it('should retrieve operations and verify structure', async () => {
      const response = await request(app.getHttpServer())
        .get(`/apis/${apiId}/operations`)
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      expect(response.body).toHaveLength(3);
      
      const listPetsOp = response.body.find(op => (op.operationId || op.name) === 'listPets');
      expect(listPetsOp).toBeDefined();
      expect(listPetsOp.method).toBe('GET');
      expect(listPetsOp.endpoint).toBe('/pets');
      expect(listPetsOp.apiId).toBe(apiId);
    });
  });

  describe('MCP Protocol Integration', () => {
    it('should discover MCP protocol capabilities', async () => {
      const response = await request(app.getHttpServer())
        .get('/mcp/.well-known/mcp')
        .expect(200);

      expect(response.body.protocol).toBe('mcp');
      expect(response.body.version).toBe('2024-11-05');
      expect(response.body.server.name).toBe('almyty');
      expect(response.body.capabilities.tools.listChanged).toBe(true);
      expect(response.body.transports.http).toContain('/api/mcp');
    });

    it('should initialize MCP session', async () => {
      const initRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {
            tools: { listChanged: true }
          },
          clientInfo: {
            name: 'test-client',
            version: '1.0.0'
          }
        }
      };

      const response = await request(app.getHttpServer())
        .post('/mcp/initialize')
        .set('Authorization', `Bearer ${authToken}`)
        .send(initRequest)
        .expect(200);

      expect(response.body.jsonrpc).toBe('2.0');
      expect(response.body.result.protocolVersion).toBe('2024-11-05');
      expect(response.body.result.serverInfo.name).toBe('almyty');
      expect(response.body.result.capabilities.tools.listChanged).toBe(true);
    });

    it('should list tools via MCP protocol', async () => {
      const toolsRequest = {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: {}
      };

      const response = await request(app.getHttpServer())
        .post('/mcp/tools/list')
        .set('Authorization', `Bearer ${authToken}`)
        .send(toolsRequest)
        .expect(200);

      expect(response.body.jsonrpc).toBe('2.0');
      expect(response.body.result.tools).toBeDefined();
      expect(Array.isArray(response.body.result.tools)).toBe(true);
      
      if (generatedTools.length > 0) {
        expect(response.body.result.tools.length).toBeGreaterThan(0);
        
        // Verify tool structure
        const tool = response.body.result.tools[0];
        expect(tool.name).toBeDefined();
        expect(tool.inputSchema).toBeDefined();
        expect(tool.inputSchema.type).toBe('object');
      }
    });

    it('should handle MCP ping', async () => {
      const pingRequest = {
        jsonrpc: '2.0',
        id: 3,
        method: 'ping'
      };

      const response = await request(app.getHttpServer())
        .post('/mcp/ping')
        .set('Authorization', `Bearer ${authToken}`)
        .send(pingRequest)
        .expect(200);

      expect(response.body.jsonrpc).toBe('2.0');
      expect(response.body.result).toEqual({});
    });
  });

  describe('UTCP Protocol Integration', () => {
    it('should discover UTCP protocol capabilities', async () => {
      const response = await request(app.getHttpServer())
        .get('/utcp/.well-known/utcp')
        .expect(200);

      expect(response.body.protocol).toBe('utcp');
      expect(response.body.version).toBe('1.0.0');
      expect(response.body.server.name).toBe('almyty');
      expect(response.body.capabilities.directCalling).toBe(true);
      expect(response.body.capabilities.proxyMode).toBe(true);
      expect(response.body.experimental.almyty.universalApiTranslation).toBe(true);
    });

    it('should generate UTCP manual for organization', async () => {
      const response = await request(app.getHttpServer())
        .get(`/utcp/${organizationId}/manual`)
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      expect(response.body.version).toBe('1.0.0');
      expect(response.body.info.title).toContain('API Tools');
      expect(response.body.tools).toBeDefined();
      expect(response.body.callTemplates).toBeDefined();
      expect(response.body.metadata.organizationId).toBe(organizationId);
      
      if (generatedTools.length > 0) {
        expect(response.body.tools.length).toBeGreaterThan(0);
        expect(response.body.callTemplates.length).toBeGreaterThan(0);

        // Verify UTCP tool structure
        const utcpTool = response.body.tools[0];
        expect(utcpTool.id).toBeDefined();
        expect(utcpTool.name).toBeDefined();
        expect(utcpTool.inputSchema).toBeDefined();
        expect(utcpTool.metadata.sourceApi).toBeDefined();

        // Verify call template structure
        const callTemplate = response.body.callTemplates[0];
        expect(callTemplate.protocol).toBe('http');
        expect(callTemplate.endpoint.url).toContain('petstore.swagger.io');
        expect(callTemplate.requestMapping.parameters).toBeDefined();
      }
    });

    it('should get UTCP capabilities', async () => {
      const response = await request(app.getHttpServer())
        .get('/utcp/capabilities')
        .expect(200);

      expect(response.body.protocol).toBe('utcp');
      expect(response.body.capabilities.manualGeneration).toBe(true);
      expect(response.body.capabilities.directCalling).toBe(true);
      expect(response.body.capabilities.apiFormats).toContain('openapi');
      expect(response.body.features.universalApiTranslation).toBe(true);
      
      // Verify differentiators
      expect(response.body.differentiators.vs_mcp).toBeDefined();
      expect(response.body.differentiators.unique_features).toContain('Automatic tool generation from any API format');
    });
  });

  describe('A2A Protocol Integration', () => {
    let agentId: string;

    it('should register A2A agent', async () => {
      const agentData = {
        name: 'Test OpenAI Agent',
        description: 'Test agent for A2A communication',
        type: 'openai',
        endpoint: 'https://api.openai.com/v1/chat/completions',
        capabilities: {
          protocols: ['http'],
          messageFormats: ['json'],
          functions: {
            calling: true,
            streaming: true,
            chaining: false,
            parallel: true
          },
          memory: {
            persistent: false,
            contextWindow: 128000,
            retrieval: false
          },
          specializations: ['reasoning', 'code', 'analysis']
        },
        configuration: {
          timeout: 30000,
          retries: 3
        },
        authentication: {
          type: 'api_key',
          config: { apiKey: 'fake-key-for-testing' },
          location: 'header',
          parameter: 'Authorization'
        }
      };

      const response = await request(app.getHttpServer())
        .post('/a2a/agents')
        .set('Authorization', `Bearer ${authToken}`)
        .send(agentData)
        .expect(201);

      expect(response.body.id).toBeDefined();
      expect(response.body.name).toBe(agentData.name);
      expect(response.body.type).toBe(agentData.type);
      expect(response.body.organizationId).toBe(organizationId);
      expect(response.body.isActive).toBe(true);

      agentId = response.body.id;
    });

    it('should list A2A agents', async () => {
      const response = await request(app.getHttpServer())
        .get('/a2a/agents')
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body.length).toBeGreaterThan(0);
      
      const agent = response.body.find(a => a.id === agentId);
      expect(agent).toBeDefined();
      expect(agent.capabilities.functions.calling).toBe(true);
    });

    it('should get A2A capabilities', async () => {
      const response = await request(app.getHttpServer())
        .get('/a2a/capabilities')
        .expect(200);

      expect(response.body.protocol).toBe('a2a');
      expect(response.body.supportedAgentTypes).toContain('openai');
      expect(response.body.supportedAgentTypes).toContain('anthropic');
      expect(response.body.features.enhanced_beyond_mcp_context_forge).toContain('Universal API integration');
      expect(response.body.differentiators.vs_mcp_context_forge).toContain('Automatic API-to-tool generation');
    });

    it('should get A2A statistics', async () => {
      const response = await request(app.getHttpServer())
        .get('/a2a/stats')
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      expect(response.body.totalAgents).toBeGreaterThanOrEqual(1);
      expect(response.body.activeAgents).toBeGreaterThanOrEqual(1);
      expect(response.body.activeSessions).toBeGreaterThanOrEqual(0);
      expect(response.body.activeWorkflows).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Tool Generation and Protocol Output', () => {
    it('should generate tools from imported schema', async () => {
      const response = await request(app.getHttpServer())
        .post(`/apis/${apiId}/generate-tools`)
        .set('Authorization', `Bearer ${authToken}`)
        .expect(201);

      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body.length).toBe(3); // Should match number of operations

      // Verify generated tool structure
      const tool = response.body[0];
      expect(tool.name).toContain('Test Pet Store API');
      expect(tool.operationId).toBeDefined();
      expect(tool.metadata.autoGenerated).toBe(true);
      expect(tool.metadata.sourceApi).toBeDefined();
      expect(tool.parameters).toBeDefined();

      generatedTools = response.body;
    });

    it('should make tools available via MCP', async () => {
      const toolsRequest = {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/list'
      };

      const response = await request(app.getHttpServer())
        .post('/mcp')
        .set('Authorization', `Bearer ${authToken}`)
        .send(toolsRequest)
        .expect(200);

      expect(response.body.result.tools).toBeDefined();
      expect(response.body.result.tools.length).toBe(generatedTools.length);

      // Verify MCP tool format
      const mcpTool = response.body.result.tools[0];
      expect(mcpTool.name).toBeDefined();
      expect(mcpTool.description).toBeDefined();
      expect(mcpTool.inputSchema).toBeDefined();
      expect(mcpTool.inputSchema.type).toBe('object');
    });

    it('should make tools available via UTCP manual', async () => {
      const response = await request(app.getHttpServer())
        .get(`/utcp/${organizationId}/manual`)
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      expect(response.body.tools.length).toBe(generatedTools.length);
      expect(response.body.callTemplates.length).toBe(generatedTools.length);

      // Verify UTCP direct calling template
      const callTemplate = response.body.callTemplates[0];
      expect(callTemplate.protocol).toBe('http');
      expect(callTemplate.endpoint.url).toBeDefined();
      expect(callTemplate.endpoint.method).toBeDefined();
      expect(callTemplate.requestMapping.parameters).toBeDefined();
      expect(callTemplate.metadata.directAccess).toBe(true);
      expect(callTemplate.metadata.bypassProxy).toBe(true);
    });
  });

  describe('Real Tool Execution', () => {
    it('should execute MCP tool call', async () => {
      if (generatedTools.length === 0) {
        pending('No tools generated - skipping execution test');
        return;
      }

      const toolName = generatedTools[0].name;
      const callRequest = {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: {
          name: toolName,
          arguments: {}
        }
      };

      const response = await request(app.getHttpServer())
        .post('/mcp')
        .set('Authorization', `Bearer ${authToken}`)
        .send(callRequest)
        .expect(200);

      expect(response.body.jsonrpc).toBe('2.0');
      expect(response.body.result).toBeDefined();
      expect(response.body.result.content).toBeDefined();
      expect(Array.isArray(response.body.result.content)).toBe(true);
      
      // Tool execution might fail due to external API, but structure should be correct
      expect(response.body.result.isError).toBeDefined();
    });

    it('should validate tool execution results structure', async () => {
      const toolsResponse = await request(app.getHttpServer())
        .get('/tools')
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      expect(toolsResponse.body.tools).toBeDefined();
      expect(toolsResponse.body.total).toBeGreaterThan(0);

      const tool = toolsResponse.body.tools[0];
      expect(tool.id).toBeDefined();
      expect(tool.name).toBeDefined();
      expect(tool.organizationId).toBe(organizationId);
      expect(tool.status).toBeDefined();
    });
  });

  describe('Monitoring and Health Checks', () => {
    it('should provide system health status', async () => {
      const response = await request(app.getHttpServer())
        .get('/monitoring/health')
        .expect(200);

      expect(response.body.status).toMatch(/healthy|degraded|unhealthy/);
      expect(response.body.components).toBeDefined();
      expect(response.body.uptime).toBeGreaterThan(0);
      expect(response.body.version).toBeDefined();
      
      // Verify component health
      expect(response.body.components.database).toBeDefined();
      expect(response.body.components.redis).toBeDefined();
      expect(response.body.components.mcp).toBeDefined();
      expect(response.body.components.utcp).toBeDefined();
      expect(response.body.components.a2a).toBeDefined();
    });

    it('should provide Prometheus metrics', async () => {
      const response = await request(app.getHttpServer())
        .get('/monitoring/metrics/prometheus')
        .expect(200);

      expect(response.text).toContain('# HELP almyty_uptime_seconds');
      expect(response.text).toContain('almyty_uptime_seconds');
      expect(response.text).toContain('# HELP almyty_tools_total');
      expect(response.text).toContain('almyty_tools_total');
      expect(response.text).toContain('# HELP almyty_mcp_sessions');
    });
  });

  describe('Error Handling and Edge Cases', () => {
    it('should handle invalid MCP JSON-RPC requests', async () => {
      const invalidRequest = {
        // Missing jsonrpc field
        id: 999,
        method: 'tools/list'
      };

      const response = await request(app.getHttpServer())
        .post('/mcp')
        .set('Authorization', `Bearer ${authToken}`)
        .send(invalidRequest)
        .expect(200); // JSON-RPC errors return 200 with error in body

      expect(response.body.jsonrpc).toBe('2.0');
      expect(response.body.error).toBeDefined();
      expect(response.body.error.code).toBe(-32600); // Invalid Request
    });

    it('should handle unauthorized requests', async () => {
      await request(app.getHttpServer())
        .post('/mcp')
        .send({ jsonrpc: '2.0', id: 1, method: 'ping' })
        .expect(401);

      await request(app.getHttpServer())
        .get(`/utcp/${organizationId}/manual`)
        .expect(401);

      await request(app.getHttpServer())
        .get('/a2a/agents')
        .expect(401);
    });

    it('should handle non-existent resources', async () => {
      const fakeOrgId = '00000000-0000-0000-0000-000000000000';
      
      await request(app.getHttpServer())
        .get(`/utcp/${fakeOrgId}/manual`)
        .set('Authorization', `Bearer ${authToken}`)
        .expect(403); // Forbidden - different organization

      await request(app.getHttpServer())
        .get(`/apis/00000000-0000-0000-0000-000000000000/operations`)
        .set('Authorization', `Bearer ${authToken}`)
        .expect(404);
    });
  });

  describe('Data Integrity and Relationships', () => {
    it('should maintain proper entity relationships', async () => {
      // Get API with all relations
      const apiResponse = await request(app.getHttpServer())
        .get(`/apis/${apiId}`)
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      const api = apiResponse.body;
      expect(api.operations).toBeDefined();
      expect(api.resources).toBeDefined();
      expect(api.schemas).toBeDefined();
      expect(api.tools).toBeDefined();
      expect(api.organizationId).toBe(organizationId);

      // Verify operations belong to API
      for (const operation of api.operations) {
        expect(operation.apiId).toBe(apiId);
      }

      // Verify resources belong to API  
      for (const resource of api.resources) {
        expect(resource.apiId).toBe(apiId);
      }
    });

    it('should maintain organization isolation', async () => {
      // Create second user with different organization
      const secondUser = {
        email: `test2-${Date.now()}@almyty.com`,
        password: 'testpass123',
        firstName: 'Test2',
        lastName: 'User2'
      };

      const registerResponse = await request(app.getHttpServer())
        .post('/auth/register')
        .send(secondUser)
        .expect(201);

      const secondToken = registerResponse.body.data.accessToken;

      // Second user shouldn't see first user's APIs
      const apisResponse = await request(app.getHttpServer())
        .get('/apis')
        .set('Authorization', `Bearer ${secondToken}`)
        .expect(200);

      expect(apisResponse.body.total).toBe(0);

      // Second user shouldn't access first user's API
      await request(app.getHttpServer())
        .get(`/apis/${apiId}`)
        .set('Authorization', `Bearer ${secondToken}`)
        .expect(403);

      // Second user shouldn't access first user's UTCP manual
      await request(app.getHttpServer())
        .get(`/utcp/${organizationId}/manual`)
        .set('Authorization', `Bearer ${secondToken}`)
        .expect(403);
    });
  });
});