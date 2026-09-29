import express from 'express';
import cors from 'cors';
import request from 'supertest';
import { NotFoundException } from '@nestjs/common';
import { readFileSync } from 'fs';
import type { Server } from 'http';
import { join } from 'path';

import { serveOnLoopback } from '../../../../test/http';
import {
  SurfaceCorsService,
  publicSurfaceFor,
  surfaceCorsDelegate,
  type SurfaceRef,
} from '../surface-cors';
import { normalizeAllowedOrigins, originIsAllowed, parseOrigin } from '../surface-origins';
import { GatewayInitHelper } from '../../gateway-init.helper';
import { GatewayType } from '../../../../entities/gateway.entity';

/**
 * Per-gateway CORS for the public chat surfaces, driven through the real
 * `cors` middleware that Nest's enableCors installs, so what is asserted is
 * the headers a browser would actually see.
 */

const WIDGET = '11111111-2222-4333-8444-555555555555';
const OTHER_WIDGET = '99999999-2222-4333-8444-555555555555';
const DASHBOARD = 'https://app.almyty.com';

const servers: Server[] = [];
const closeServers = () =>
  Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));

async function appWith(lists: Record<string, string[]>, opts: { failLookup?: boolean } = {}) {
  const seen: SurfaceRef[] = [];
  const delegate = surfaceCorsDelegate({
    platformOrigins: new Set([DASHBOARD]),
    platform: { credentials: true, methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'] },
    allowedOriginsFor: async (ref) => {
      seen.push(ref);
      if (opts.failLookup) throw new Error('db down');
      const key = ref.kind === 'chat_widget' ? ref.gatewayId : `slug:${ref.slug}`;
      return lists[key] ?? [];
    },
  });
  const handler = express();
  handler.use(cors(delegate as any));
  handler.use((_req, res) => res.json({ ok: true }));
  const app = await serveOnLoopback(handler);
  servers.push(app);
  return { app, seen };
}

describe('publicSurfaceFor', () => {
  it.each([
    [`/gateways/${WIDGET}/widget/messages`, { kind: 'chat_widget', gatewayId: WIDGET }],
    [`/gateways/${WIDGET}/widget-config`, { kind: 'chat_widget', gatewayId: WIDGET }],
    [`/gateways/${WIDGET}/widget.js`, { kind: 'chat_widget', gatewayId: WIDGET }],
    [`/api/gateways/${WIDGET}/widget/messages?threadId=x`, { kind: 'chat_widget', gatewayId: WIDGET }],
    ['/public/chat/acme/messages', { kind: 'hosted_chat', slug: 'acme' }],
    ['/public/chat/Acme', { kind: 'hosted_chat', slug: 'acme' }],
    ['/public/chat/by-host', { kind: 'hosted_chat', slug: null }],
  ])('%s is a public surface', (path, ref) => {
    expect(publicSurfaceFor(path)).toEqual(ref);
  });

  it.each(['/gateways', `/gateways/${WIDGET}`, '/auth/profile', '/users/me', '/public/chatter'])(
    '%s is not',
    (path) => expect(publicSurfaceFor(path)).toBeNull(),
  );
});

describe('origin parsing', () => {
  it('canonicalises to what browsers send in Origin', () => {
    expect(parseOrigin('https://Shop.Example.com/')).toEqual({ origin: 'https://shop.example.com' });
    expect(parseOrigin('https://shop.example.com:443')).toEqual({ origin: 'https://shop.example.com' });
    expect(parseOrigin('http://localhost:8080')).toEqual({ origin: 'http://localhost:8080' });
  });

  it.each([
    'https://*.example.com',
    '*',
    'https://example.com/path',
    'https://example.com/?q=1',
    'https://example.com#x',
    'https://user:pw@example.com',
    'ftp://example.com',
    'javascript:alert(1)',
    'null',
    'example.com',
    '',
  ])('refuses %j', (value) => {
    expect(parseOrigin(value)).toHaveProperty('error');
  });

  it('normalises and de-duplicates a submitted list, naming the bad entry', () => {
    expect(normalizeAllowedOrigins(['https://a.com/', 'https://A.com', 'https://b.com'])).toEqual({
      origins: ['https://a.com', 'https://b.com'],
    });
    expect(normalizeAllowedOrigins(['https://a.com', 'https://*.b.com'])).toEqual({
      error: expect.stringMatching(/^Allowed origin 2: Wildcards/),
    });
    expect(normalizeAllowedOrigins('https://a.com')).toHaveProperty('error');
    expect(normalizeAllowedOrigins(Array(51).fill('https://a.com'))).toHaveProperty('error');
    expect(normalizeAllowedOrigins(undefined)).toEqual({ origins: [] });
  });

  it('matches exactly: no prefix, suffix, scheme or port slack', () => {
    const allowed = ['https://shop.example.com'];
    expect(originIsAllowed(allowed, 'https://shop.example.com')).toBe(true);
    for (const near of [
      'https://shop.example.com.evil.com',
      'https://evilshop.example.com',
      'https://x.shop.example.com',
      'http://shop.example.com',
      'https://shop.example.com:8443',
      'null',
      '',
    ]) {
      expect(originIsAllowed(allowed, near)).toBe(false);
    }
  });
});

describe('surface CORS through the real cors middleware', () => {
  const lists = { [WIDGET]: ['https://shop.example.com'], 'slug:acme': ['https://acme.com'] };
  afterEach(closeServers);
  it('answers a listed origin, without credentials', async () => {
    const { app } = await appWith(lists);
    const res = await request(app)
      .get(`/gateways/${WIDGET}/widget/messages`)
      .set('Origin', 'https://shop.example.com');
    expect(res.headers['access-control-allow-origin']).toBe('https://shop.example.com');
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
    expect(res.headers.vary).toMatch(/Origin/);
  });

  it('gives an unlisted origin no CORS answer', async () => {
    const { app } = await appWith(lists);
    const res = await request(app)
      .get(`/gateways/${WIDGET}/widget/messages`)
      .set('Origin', 'https://attacker.example');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it("does not let one gateway's list open another gateway", async () => {
    const { app } = await appWith(lists);
    const res = await request(app)
      .post(`/gateways/${OTHER_WIDGET}/widget/messages`)
      .set('Origin', 'https://shop.example.com');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('an empty list is same-origin only', async () => {
    const { app } = await appWith({ [WIDGET]: [] });
    const res = await request(app).get(`/gateways/${WIDGET}/widget-config`).set('Origin', 'https://shop.example.com');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('answers a preflight for a listed origin and refuses it for anyone else', async () => {
    const { app } = await appWith(lists);
    const ok = await request(app)
      .options(`/gateways/${WIDGET}/widget/messages`)
      .set('Origin', 'https://shop.example.com')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type');
    expect(ok.status).toBe(204);
    expect(ok.headers['access-control-allow-origin']).toBe('https://shop.example.com');
    expect(ok.headers['access-control-allow-headers']).toBe('Content-Type');
    expect(ok.headers['access-control-allow-credentials']).toBeUndefined();

    const no = await request(app)
      .options(`/gateways/${WIDGET}/widget/messages`)
      .set('Origin', 'https://attacker.example')
      .set('Access-Control-Request-Method', 'POST');
    expect(no.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('hosted chat routes answer from the surface list, never with credentials', async () => {
    const { app } = await appWith(lists);
    const ok = await request(app).get('/public/chat/acme/me').set('Origin', 'https://acme.com');
    expect(ok.headers['access-control-allow-origin']).toBe('https://acme.com');
    expect(ok.headers['access-control-allow-credentials']).toBeUndefined();

    const other = await request(app).get('/public/chat/acme/me').set('Origin', 'https://shop.example.com');
    expect(other.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('the dashboard origin is answered on a surface, but without credentials', async () => {
    const { app } = await appWith(lists);
    const res = await request(app).get(`/gateways/${WIDGET}/widget-config`).set('Origin', DASHBOARD);
    expect(res.headers['access-control-allow-origin']).toBe(DASHBOARD);
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('leaves every other route on the app-wide policy', async () => {
    const { app, seen } = await appWith(lists);
    const dash = await request(app).get('/auth/profile').set('Origin', DASHBOARD);
    expect(dash.headers['access-control-allow-origin']).toBe(DASHBOARD);
    expect(dash.headers['access-control-allow-credentials']).toBe('true');

    // A tenant's listed site gets nothing from the rest of the API.
    const tenantSite = await request(app).get('/auth/profile').set('Origin', 'https://shop.example.com');
    expect(tenantSite.headers['access-control-allow-origin']).toBeUndefined();
    expect(seen).toHaveLength(0);
  });

  it('fails closed when the list cannot be read', async () => {
    const { app } = await appWith(lists, { failLookup: true });
    const res = await request(app)
      .get(`/gateways/${WIDGET}/widget/messages`)
      .set('Origin', 'https://shop.example.com');
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('SurfaceCorsService', () => {
  const widget = { id: WIDGET, configuration: { allowedOrigins: ['https://shop.example.com'] } };
  const hosted = { id: 'h1', configuration: { allowedOrigins: ['https://acme.com'] } };
  const service = new SurfaceCorsService(
    {
      findWidgetGateway: async (id: string) => {
        if (id !== WIDGET) throw new NotFoundException('Widget not found');
        return widget;
      },
    } as any,
    {
      findBySlug: async (slug: string) => {
        if (slug !== 'acme') throw new NotFoundException('Chat app not found');
        return hosted;
      },
    } as any,
  );

  it('reads the list off the live surface the path names', async () => {
    await expect(service.allowedOriginsFor({ kind: 'chat_widget', gatewayId: WIDGET })).resolves.toEqual([
      'https://shop.example.com',
    ]);
    await expect(service.allowedOriginsFor({ kind: 'hosted_chat', slug: 'acme' })).resolves.toEqual([
      'https://acme.com',
    ]);
  });

  it('has no list for a surface that does not exist or is not addressable', async () => {
    await expect(service.allowedOriginsFor({ kind: 'chat_widget', gatewayId: OTHER_WIDGET })).resolves.toEqual([]);
    await expect(service.allowedOriginsFor({ kind: 'chat_widget', gatewayId: 'not-a-uuid' })).resolves.toEqual([]);
    await expect(service.allowedOriginsFor({ kind: 'hosted_chat', slug: 'nope' })).resolves.toEqual([]);
    await expect(service.allowedOriginsFor({ kind: 'hosted_chat', slug: null })).resolves.toEqual([]);
  });
});

describe('allowed origins are validated and stored canonically on save', () => {
  const init = new GatewayInitHelper({} as any, {} as any);

  it.each([GatewayType.CHAT_WIDGET, GatewayType.HOSTED_CHAT])('%s', (type) => {
    const configuration: any = { allowedOrigins: ['https://Shop.Example.com/', 'https://shop.example.com'] };
    init.validateGatewayConfiguration(type, configuration);
    expect(configuration.allowedOrigins).toEqual(['https://shop.example.com']);

    expect(() => init.validateGatewayConfiguration(type, { allowedOrigins: ['https://*.example.com'] })).toThrow(
      /Wildcards/,
    );
  });
});

describe('the surface CORS policy is what the app installs', () => {
  const src = (rel: string) => readFileSync(join(__dirname, '..', '..', '..', '..', rel), 'utf8');

  it('main.ts hands enableCors the SurfaceCorsService delegate', () => {
    const main = src('main.ts');
    expect(main).toMatch(/app\.enableCors\(\s*app\.get\(SurfaceCorsService\)\.delegate\(allowedOrigins,/);
    // One CORS policy, not a second enableCors that would bypass it.
    expect(main.match(/enableCors\(/g)).toHaveLength(1);
  });

  it('SurfaceCorsService is a provider of GatewaysModule', () => {
    expect(src('modules/gateways/gateways.module.ts')).toMatch(/providers:\s*\[[\s\S]*?\bSurfaceCorsService\b/);
  });
});
