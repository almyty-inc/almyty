import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { ApiType } from '../src/entities/api.entity';

describe('API to Tools Pipeline (e2e)', () => {
  let app: INestApplication;
  let authToken: string;
  let organizationId: string;
  let apiId: string;

  const testUser = {
    email: `test-${Date.now()}@almyty.com`,
    password: 'testpass123',
    firstName: 'Test',
    lastName: 'User'
  };

  const petStoreSchema = {
    openapi: '3.0.0',
    info: {
      title: 'Pet Store API',
      description: 'A simple Pet Store API for testing almyty',
      version: '1.0.0'
    },
    servers: [
      {
        url: 'https://petstore.swagger.io/v2',
        description: 'Pet Store Server'
      }
    ],
    paths: {
      '/pets': {
        get: {
          summary: 'List all pets',
          operationId: 'listPets',
          parameters: [
            {
              name: 'limit',
              in: 'query',
              description: 'How many items to return at one time (max 100)',
              required: false,
              schema: {
                type: 'integer',
                maximum: 100,
                format: 'int32'
              }
            }
          ],
          responses: {
            '200': {
              description: 'A paged array of pets',
              content: {
                'application/json': {
                  schema: {
                    $ref: '#/components/schemas/Pets'
                  }
                }
              }
            }
          }
        },
        post: {
          summary: 'Create a pet',
          operationId: 'createPet',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/Pet'
                }
              }
            }
          },
          responses: {
            '201': {
              description: 'Pet created',
              content: {
                'application/json': {
                  schema: {
                    $ref: '#/components/schemas/Pet'
                  }
                }
              }
            }
          }
        }
      },
      '/pets/{petId}': {
        get: {
          summary: 'Info for a specific pet',
          operationId: 'showPetById',
          parameters: [
            {
              name: 'petId',
              in: 'path',
              required: true,
              description: 'The id of the pet to retrieve',
              schema: {
                type: 'string'
              }
            }
          ],
          responses: {
            '200': {
              description: 'Expected response to a valid request',
              content: {
                'application/json': {
                  schema: {
                    $ref: '#/components/schemas/Pet'
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
        Pet: {
          type: 'object',
          required: ['id', 'name'],
          properties: {
            id: {
              type: 'integer',
              format: 'int64'
            },
            name: {
              type: 'string'
            },
            tag: {
              type: 'string'
            }
          }
        },
        Pets: {
          type: 'array',
          items: {
            $ref: '#/components/schemas/Pet'
          }
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

  describe('Complete API-to-Tools Pipeline', () => {
    it('should register a new user and create organization', async () => {
      const response = await request(app.getHttpServer())
        .post('/auth/register')
        .send(testUser)
        .expect(201);

      expect(response.body.success).toBe(true);
      expect(response.body.data.accessToken).toBeDefined();

      authToken = response.body.data.accessToken;

      // Fetch profile to get organization membership
      const profileRes = await request(app.getHttpServer())
        .get('/auth/profile')
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      organizationId = profileRes.body.data.organizationMemberships?.[0]?.organization?.id;
      expect(organizationId).toBeDefined();
    });

    it('should create a new API', async () => {
      const apiData = {
        name: 'Pet Store API Test',
        description: 'Test API for almyty pipeline',
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
      expect(response.body.type).toBe(apiData.type);
      
      apiId = response.body.id;
    });

    it('should import OpenAPI schema and generate operations', async () => {
      const importData = {
        schemaContent: JSON.stringify(petStoreSchema),
        description: 'Pet Store OpenAPI schema',
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
      
      // Tools should be generated
      if (response.body.tools) {
        expect(response.body.tools.length).toBeGreaterThan(0);
      }
    });

    it('should retrieve API operations', async () => {
      const response = await request(app.getHttpServer())
        .get(`/apis/${apiId}/operations`)
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      expect(response.body).toHaveLength(3);
      
      const operations = response.body;
      const operationIds = operations.map(op => op.operationId || op.name);
      
      expect(operationIds).toContain('listPets');
      expect(operationIds).toContain('createPet'); 
      expect(operationIds).toContain('showPetById');
      
      // Check operation details
      const listPetsOp = operations.find(op => (op.operationId || op.name) === 'listPets');
      expect(listPetsOp.method).toBe('GET');
      expect(listPetsOp.endpoint).toBe('/pets');
    });

    it('should retrieve API resources', async () => {
      const response = await request(app.getHttpServer())
        .get(`/apis/${apiId}/resources`)
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      expect(response.body).toHaveLength(2);
      
      const resources = response.body;
      const resourceNames = resources.map(r => r.name);
      
      expect(resourceNames).toContain('Pet');
      expect(resourceNames).toContain('Pets');
      
      // Check Pet resource structure
      const petResource = resources.find(r => r.name === 'Pet');
      expect(petResource.properties).toBeDefined();
      expect(petResource.properties.id).toBeDefined();
      expect(petResource.properties.name).toBeDefined();
      expect(petResource.properties.tag).toBeDefined();
    });

    it('should generate tools from API operations', async () => {
      const response = await request(app.getHttpServer())
        .post(`/apis/${apiId}/generate-tools`)
        .set('Authorization', `Bearer ${authToken}`)
        .expect(201);

      expect(response.body).toHaveLength(3);
      
      const toolNames = response.body.map(tool => tool.name);
      expect(toolNames).toContain('Pet Store API Test_listPets');
      expect(toolNames).toContain('Pet Store API Test_createPet');
      expect(toolNames).toContain('Pet Store API Test_showPetById');
      
      // Check tool configuration
      const listPetsTool = response.body.find(tool => tool.name.includes('listPets'));
      expect(listPetsTool.type).toBe('api');
      expect(listPetsTool.operationId).toBeDefined();
      expect(listPetsTool.parameters).toBeDefined();
    });

    it('should retrieve generated tools', async () => {
      const response = await request(app.getHttpServer())
        .get('/tools')
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      expect(response.body.total).toBeGreaterThanOrEqual(3);
      
      const tools = response.body.tools || response.body.data || response.body;
      const apiTools = tools.filter(tool => tool.name.includes('Pet Store API Test'));
      
      expect(apiTools.length).toBe(3);
      
      // Verify tool metadata
      apiTools.forEach(tool => {
        expect(tool.metadata.autoGenerated).toBe(true);
        expect(tool.metadata.sourceApi).toBeDefined();
        expect(tool.metadata.sourceOperation).toBeDefined();
      });
    });

    it('should test API connection', async () => {
      const response = await request(app.getHttpServer())
        .post(`/apis/${apiId}/test-connection`)
        .set('Authorization', `Bearer ${authToken}`)
        .expect(201);

      expect(response.body.success).toBeDefined();
      expect(response.body.statusCode).toBeDefined();
      expect(response.body.responseTime).toBeDefined();
    });

    it('should retrieve API schemas', async () => {
      const response = await request(app.getHttpServer())
        .get(`/apis/${apiId}/schemas`)
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      expect(response.body).toHaveLength(1);
      
      const schema = response.body[0];
      expect(schema.rawSchema).toBeDefined();
      expect(schema.processedSchema).toBeDefined();
      expect(schema.version).toBe('3.0.0');
      expect(schema.format).toBe('json');
    });

    it('should update API status', async () => {
      const response = await request(app.getHttpServer())
        .put(`/apis/${apiId}/status`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({ status: 'active' })
        .expect(200);

      expect(response.body.status).toBe('active');
    });
  });

  describe('Error Handling', () => {
    it('should handle invalid schema import', async () => {
      const invalidSchema = {
        schemaContent: 'invalid json content',
        generateTools: true
      };

      await request(app.getHttpServer())
        .post(`/apis/${apiId}/import-schema`)
        .set('Authorization', `Bearer ${authToken}`)
        .send(invalidSchema)
        .expect(400);
    });

    it('should handle unauthorized requests', async () => {
      await request(app.getHttpServer())
        .get('/apis')
        .expect(401);
    });

    it('should handle non-existent API operations', async () => {
      const fakeApiId = '00000000-0000-0000-0000-000000000000';
      
      await request(app.getHttpServer())
        .get(`/apis/${fakeApiId}/operations`)
        .set('Authorization', `Bearer ${authToken}`)
        .expect(404);
    });
  });
});