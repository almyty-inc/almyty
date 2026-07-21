import 'reflect-metadata';

import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as http from 'http';

import { All, Controller, Get, Module, Req } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ServeStaticModule } from '@nestjs/serve-static';

import {
  API_ROUTE_ROOTS,
  buildExcludePatterns,
  createSpaRootMiddleware,
  frontendStaticImports,
  resolveFrontendDist,
  shouldServeFrontend,
} from './frontend-static';

/**
 * The single self-host image (almyty/almyty) makes this backend also serve the
 * built React SPA. The default api-only image must be completely unaffected:
 * with SERVE_FRONTEND unset, ServeStaticModule is NOT wired and every route
 * behaves exactly as before. These tests lock both halves of that contract.
 */

function makeStubDist(): string {
  const dir = mkdtempSync(join(tmpdir(), 'almyty-dist-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>almyty spa</title>');
  mkdirSync(join(dir, 'assets'), { recursive: true });
  writeFileSync(join(dir, 'assets', 'app.js'), 'console.log("app")');
  return dir;
}

describe('frontend-static gating', () => {
  const originalFlag = process.env.SERVE_FRONTEND;
  const originalDist = process.env.FRONTEND_DIST;

  afterEach(() => {
    if (originalFlag === undefined) delete process.env.SERVE_FRONTEND;
    else process.env.SERVE_FRONTEND = originalFlag;
    if (originalDist === undefined) delete process.env.FRONTEND_DIST;
    else process.env.FRONTEND_DIST = originalDist;
  });

  it('is OFF (api-only) when SERVE_FRONTEND is unset — current behavior preserved', () => {
    delete process.env.SERVE_FRONTEND;
    const dist = makeStubDist();
    try {
      expect(shouldServeFrontend(dist)).toBe(false);
      expect(frontendStaticImports()).toEqual([]);
      expect(createSpaRootMiddleware(dist)).toBeNull();
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  });

  it('stays OFF when SERVE_FRONTEND=true but no build exists (fails closed to api-only)', () => {
    process.env.SERVE_FRONTEND = 'true';
    const empty = mkdtempSync(join(tmpdir(), 'almyty-empty-'));
    try {
      expect(shouldServeFrontend(empty)).toBe(false);
      expect(createSpaRootMiddleware(empty)).toBeNull();
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('turns ON when SERVE_FRONTEND=true and a build is present', () => {
    process.env.SERVE_FRONTEND = 'true';
    const dist = makeStubDist();
    process.env.FRONTEND_DIST = dist;
    try {
      expect(resolveFrontendDist()).toBe(dist);
      expect(shouldServeFrontend()).toBe(true);
      const imports = frontendStaticImports();
      expect(imports).toHaveLength(1);
      expect(createSpaRootMiddleware()).toBeInstanceOf(Function);
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  });

  it('exclude patterns cover every API root at the root and below', () => {
    const patterns = buildExcludePatterns();
    for (const root of API_ROUTE_ROOTS) {
      expect(patterns).toContain(`/${root}`);
      expect(patterns).toContain(`/${root}/{*rest}`);
    }
  });
});

/**
 * Behavioral proof against a standalone Nest app that mimics the real routing
 * shape: root-mounted API controllers plus the unified gateway `@All('/')`.
 * The full AppModule needs a DB to boot, so this reproduces just the routing
 * surface the static serving has to coexist with.
 */
describe('frontend-static serving behavior', () => {
  let dist: string;
  let app: any;
  let baseUrl: string;

  @Controller('agents')
  class AgentsController {
    @Get()
    list() {
      return { data: 'agents-json' };
    }
  }

  @Controller('health')
  class HealthController {
    @Get()
    health() {
      return { status: 'ok' };
    }
  }

  @Controller()
  class RootJsonRpcController {
    // Mirrors unified-endpoint.controller @All('/') — JSON-RPC at the root.
    @All('/')
    root(@Req() req: any) {
      return { rpc: true, method: req.method };
    }
  }

  beforeAll(async () => {
    dist = makeStubDist();
    process.env.SERVE_FRONTEND = 'true';
    process.env.FRONTEND_DIST = dist;

    @Module({
      imports: [...frontendStaticImports()],
      controllers: [AgentsController, HealthController, RootJsonRpcController],
    })
    class TestAppModule {}

    app = await NestFactory.create(TestAppModule, { logger: false });
    const mw = createSpaRootMiddleware();
    if (mw) app.getHttpAdapter().getInstance().use(mw);
    await app.listen(0);
    const port = app.getHttpServer().address().port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    if (app) await app.close();
    delete process.env.SERVE_FRONTEND;
    delete process.env.FRONTEND_DIST;
    if (dist) rmSync(dist, { recursive: true, force: true });
  });

  function req(path: string, accept: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      http
        .get(`${baseUrl}${path}`, { headers: { accept } }, (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => resolve({ status: res.statusCode || 0, body }));
        })
        .on('error', reject);
    });
  }

  it('serves index.html for SPA client routes (no matching controller)', async () => {
    const r = await req('/dashboard', 'text/html');
    expect(r.status).toBe(200);
    expect(r.body).toContain('almyty spa');
  });

  it('serves static assets', async () => {
    const r = await req('/assets/app.js', '*/*');
    expect(r.status).toBe(200);
    expect(r.body).toContain('console.log');
  });

  it('serves index.html for a bare GET / HTML navigation', async () => {
    const r = await req('/', 'text/html');
    expect(r.status).toBe(200);
    expect(r.body).toContain('almyty spa');
  });

  it('still routes GET / (non-HTML) to the root JSON-RPC controller', async () => {
    const r = await req('/', 'application/json');
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toMatchObject({ rpc: true });
  });

  it('API routes still resolve to their controllers (not shadowed by the SPA)', async () => {
    const agents = await req('/agents', 'application/json');
    expect(agents.status).toBe(200);
    expect(JSON.parse(agents.body)).toMatchObject({ data: 'agents-json' });

    const health = await req('/health', 'application/json');
    expect(health.status).toBe(200);
    expect(JSON.parse(health.body)).toMatchObject({ status: 'ok' });
  });
});
