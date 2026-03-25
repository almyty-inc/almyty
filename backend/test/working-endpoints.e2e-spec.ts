import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';

describe('Working Endpoints Test (e2e)', () => {
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

  describe('Public Endpoints (No Auth Required)', () => {
    it('should provide MCP protocol discovery', async () => {
      const response = await request(app.getHttpServer())
        .get('/mcp/.well-known/mcp')
        .expect(200);

      // Verify MCP protocol response
      expect(response.body).toBeDefined();
      expect(response.body.protocol).toBe('mcp');
      expect(response.body.version).toBe('2024-11-05');
      expect(response.body.server.name).toBe('almyty');
      expect(response.body.capabilities.tools.listChanged).toBe(true);
      expect(response.body.capabilities.experimental.almyty.universalApiTranslation).toBe(true);
      
      // Verify transport endpoints
      expect(response.body.transports.http).toContain('/api/mcp');
      expect(response.body.transports.sse).toContain('/api/mcp/sse');
      expect(response.body.transports.websocket).toContain('/api/mcp/ws');
    });

    it('should provide UTCP protocol discovery', async () => {
      const response = await request(app.getHttpServer())
        .get('/utcp/.well-known/utcp')
        .expect(200);

      // Verify UTCP protocol response
      expect(response.body).toBeDefined();
      expect(response.body.protocol).toBe('utcp');
      expect(response.body.version).toBe('1.0.0');
      expect(response.body.server.name).toBe('almyty');
      expect(response.body.capabilities.directCalling).toBe(true);
      expect(response.body.capabilities.proxyMode).toBe(true);
      expect(response.body.experimental.almyty.universalApiTranslation).toBe(true);
    });

    it('should provide UTCP capabilities', async () => {
      const response = await request(app.getHttpServer())
        .get('/utcp/capabilities')
        .expect(200);

      // Verify UTCP capabilities
      expect(response.body.protocol).toBe('utcp');
      expect(response.body.capabilities.manualGeneration).toBe(true);
      expect(response.body.capabilities.directCalling).toBe(true);
      expect(response.body.capabilities.proxyMode).toBe(true);
      
      // Verify supported API formats
      expect(response.body.capabilities.apiFormats).toContain('openapi');
      expect(response.body.capabilities.apiFormats).toContain('graphql');
      expect(response.body.capabilities.apiFormats).toContain('soap');
      expect(response.body.capabilities.apiFormats).toContain('protobuf');
      
      // Verify almyty differentiators
      expect(response.body.differentiators.vs_mcp).toBe('Direct calling instead of proxy-only');
      expect(response.body.differentiators.unique_features).toContain('Automatic tool generation from any API format');
      expect(response.body.differentiators.unique_features).toContain('Multi-protocol output (MCP + UTCP + A2A)');
    });

    it('should provide monitoring health check', async () => {
      const response = await request(app.getHttpServer())
        .get('/monitoring/health')
        .expect(200);

      // Verify health response structure
      expect(response.body.status).toMatch(/^(healthy|degraded|unhealthy)$/);
      expect(response.body.uptime).toBeGreaterThan(0);
      expect(response.body.version).toBeDefined();
      
      // Verify component health checks
      expect(response.body.components).toBeDefined();
      expect(response.body.components.database).toBeDefined();
      expect(response.body.components.redis).toBeDefined();
      expect(response.body.components.mcp).toBeDefined();
      expect(response.body.components.utcp).toBeDefined();
      expect(response.body.components.a2a).toBeDefined();
      expect(response.body.components.plugins).toBeDefined();
    });

    it('should provide UTCP health check', async () => {
      const response = await request(app.getHttpServer())
        .get('/utcp/health')
        .expect(200);

      expect(response.body.protocol).toBe('utcp');
      expect(response.body.status).toBe('healthy');
      expect(response.body.server).toBe('almyty');
      expect(response.body.uptime).toBeGreaterThan(0);
    });
  });

  describe('Protected Endpoints (Should Require Auth)', () => {
    it('should properly protect MCP endpoints', async () => {
      await request(app.getHttpServer())
        .post('/mcp')
        .send({ jsonrpc: '2.0', id: 1, method: 'ping' })
        .expect(401);

      await request(app.getHttpServer())
        .post('/mcp/tools/list')
        .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
        .expect(401);
    });

    it('should properly protect UTCP manual endpoints', async () => {
      await request(app.getHttpServer())
        .get('/utcp/fake-org-id/manual')
        .expect(401);

      await request(app.getHttpServer())
        .post('/utcp/fake-org-id/execute')
        .send({ toolId: 'fake', parameters: {} })
        .expect(401);
    });

    it('should properly protect API management endpoints', async () => {
      await request(app.getHttpServer())
        .get('/apis')
        .expect(401);

      await request(app.getHttpServer())
        .post('/apis')
        .send({ name: 'test' })
        .expect(401);

      await request(app.getHttpServer())
        .get('/tools')
        .expect(401);
    });

    it('should properly protect monitoring endpoints', async () => {
      await request(app.getHttpServer())
        .get('/monitoring/metrics')
        .expect(401);

      await request(app.getHttpServer())
        .get('/monitoring/alerts')
        .expect(401);

      await request(app.getHttpServer())
        .get('/monitoring/stats/live')
        .expect(401);
    });
  });

  describe('Error Handling', () => {
    it('should handle invalid routes', async () => {
      await request(app.getHttpServer())
        .get('/nonexistent')
        .expect(404);

      await request(app.getHttpServer())
        .get('/api/invalid-endpoint')
        .expect(404);
    });

    it('should handle malformed requests', async () => {
      const response = await request(app.getHttpServer())
        .post('/mcp')
        .set('Content-Type', 'application/json')
        .send('invalid json')
        .expect(400);

      expect(response.body.message).toBeDefined();
    });
  });

  describe('Backend Service Health', () => {
    it('should demonstrate all modules loaded successfully', async () => {
      // If we get here, it means:
      // 1. All TypeScript compiled successfully
      // 2. All modules resolved dependencies correctly  
      // 3. All database entities are valid
      // 4. All services started without errors
      // 5. All controllers registered routes correctly
      
      expect(app).toBeDefined();
      
      // Test that basic endpoint works
      const healthResponse = await request(app.getHttpServer())
        .get('/monitoring/health')
        .expect(200);
        
      expect(healthResponse.body.status).toBeDefined();
    });
  });
});