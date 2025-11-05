import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';

describe('Protocol Endpoints Only (e2e)', () => {
  let app: INestApplication;

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

  describe('Protocol Discovery (No Auth Required)', () => {
    it('should discover MCP protocol', async () => {
      const response = await request(app.getHttpServer())
        .get('/mcp/.well-known/mcp')
        .expect(200);

      expect(response.body.protocol).toBe('mcp');
      expect(response.body.version).toBe('2024-11-05');
      expect(response.body.server.name).toBe('apifai');
      expect(response.body.capabilities.tools.listChanged).toBe(true);
    });

    it('should discover UTCP protocol', async () => {
      const response = await request(app.getHttpServer())
        .get('/utcp/.well-known/utcp')
        .expect(200);

      expect(response.body.protocol).toBe('utcp');
      expect(response.body.version).toBe('1.0.0');
      expect(response.body.server.name).toBe('apifai');
      expect(response.body.capabilities.directCalling).toBe(true);
      expect(response.body.capabilities.proxyMode).toBe(true);
    });

    it('should provide UTCP capabilities', async () => {
      const response = await request(app.getHttpServer())
        .get('/utcp/capabilities')
        .expect(200);

      expect(response.body.protocol).toBe('utcp');
      expect(response.body.capabilities.manualGeneration).toBe(true);
      expect(response.body.capabilities.apiFormats).toContain('openapi');
      expect(response.body.capabilities.apiFormats).toContain('graphql');
      expect(response.body.capabilities.apiFormats).toContain('soap');
      expect(response.body.capabilities.apiFormats).toContain('protobuf');
    });

    it('should provide A2A capabilities', async () => {
      const response = await request(app.getHttpServer())
        .get('/a2a/capabilities')
        .expect(200);

      expect(response.body.protocol).toBe('a2a');
      expect(response.body.supportedAgentTypes).toContain('openai');
      expect(response.body.supportedAgentTypes).toContain('anthropic');
      expect(response.body.features.enhanced_beyond_mcp_context_forge).toContain('Universal API integration');
    });

    it('should provide monitoring health check', async () => {
      const response = await request(app.getHttpServer())
        .get('/monitoring/health')
        .expect(200);

      expect(response.body.status).toMatch(/healthy|degraded|unhealthy/);
      expect(response.body.uptime).toBeGreaterThan(0);
      expect(response.body.components.database).toBeDefined();
      expect(response.body.components.redis).toBeDefined();
    });
  });

  describe('Protected Endpoints (Should Require Auth)', () => {
    it('should reject unauthorized MCP requests', async () => {
      await request(app.getHttpServer())
        .post('/mcp')
        .send({ jsonrpc: '2.0', id: 1, method: 'ping' })
        .expect(401);
    });

    it('should reject unauthorized UTCP manual requests', async () => {
      await request(app.getHttpServer())
        .get('/utcp/fake-org-id/manual')
        .expect(401);
    });

    it('should reject unauthorized A2A requests', async () => {
      await request(app.getHttpServer())
        .get('/a2a/agents')
        .expect(401);

      await request(app.getHttpServer())
        .post('/a2a/agents')
        .send({ name: 'test' })
        .expect(401);
    });

    it('should reject unauthorized API requests', async () => {
      await request(app.getHttpServer())
        .get('/apis')
        .expect(401);

      await request(app.getHttpServer())
        .post('/apis')
        .send({ name: 'test' })
        .expect(401);
    });

    it('should reject unauthorized monitoring requests', async () => {
      await request(app.getHttpServer())
        .get('/monitoring/metrics')
        .expect(401);

      await request(app.getHttpServer())
        .get('/monitoring/alerts')
        .expect(401);
    });
  });

  describe('Error Handling', () => {
    it('should handle invalid routes gracefully', async () => {
      await request(app.getHttpServer())
        .get('/nonexistent-route')
        .expect(404);
    });

    it('should handle malformed JSON gracefully', async () => {
      const response = await request(app.getHttpServer())
        .post('/mcp')
        .set('Content-Type', 'application/json')
        .send('{ invalid json }')
        .expect(400);

      expect(response.body.message).toContain('JSON');
    });
  });
});

describe('Basic Functionality Without Database Issues', () => {
  let app: INestApplication;

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

  it('should have all modules loaded correctly', async () => {
    // Test that the app starts without errors
    expect(app).toBeDefined();
    
    // Test basic health endpoint
    const healthResponse = await request(app.getHttpServer())
      .get('/monitoring/health')
      .expect(200);
      
    expect(healthResponse.body.status).toBeDefined();
  });

  it('should expose all protocol discovery endpoints', async () => {
    const endpoints = [
      '/mcp/.well-known/mcp',
      '/utcp/.well-known/utcp', 
      '/a2a/capabilities',
      '/utcp/capabilities',
      '/monitoring/health'
    ];

    for (const endpoint of endpoints) {
      await request(app.getHttpServer())
        .get(endpoint)
        .expect(200);
    }
  });

  it('should provide comprehensive protocol capabilities', async () => {
    const mcpResponse = await request(app.getHttpServer())
      .get('/mcp/.well-known/mcp')
      .expect(200);

    const utcpResponse = await request(app.getHttpServer())
      .get('/utcp/.well-known/utcp')
      .expect(200);

    const a2aResponse = await request(app.getHttpServer())
      .get('/a2a/capabilities')
      .expect(200);

    // Verify we support all three protocols
    expect(mcpResponse.body.protocol).toBe('mcp');
    expect(utcpResponse.body.protocol).toBe('utcp');
    expect(a2aResponse.body.protocol).toBe('a2a');

    // Verify experimental features
    expect(mcpResponse.body.capabilities.experimental.apifai.universalApiTranslation).toBe(true);
    expect(utcpResponse.body.experimental.apifai.universalApiTranslation).toBe(true);
    expect(a2aResponse.body.features.enhanced_beyond_mcp_context_forge).toBeDefined();

    // Verify transport support
    expect(mcpResponse.body.transports.http).toBeDefined();
    expect(mcpResponse.body.transports.sse).toBeDefined();
    expect(mcpResponse.body.transports.websocket).toBeDefined();
  });
});