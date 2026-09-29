import { readFileSync } from 'fs';
import { join } from 'path';

import { Controller, Get, INestApplication, Post } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { Throttle, ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import request from 'supertest';
import { listenOnLoopback } from '../../../test/http';

import { buildThrottlerOptions } from '../throttler-options';

/**
 * The tracker unit test proves the key is right. This one proves the
 * key is REACHED: an options object nobody wires in is the same outage
 * with better comments. So boot a real ThrottlerGuard on exactly the
 * options app.module.ts passes and drive it over HTTP.
 */
@Controller()
class PingController {
  @Get('ping')
  ping() {
    return { ok: true };
  }

  // Stands in for login/register/forgot-password: a route with its own,
  // much tighter limit layered on the global one.
  @Throttle({ default: { limit: 1, ttl: 60_000 } })
  @Post('login')
  login() {
    return { ok: true };
  }
}

const configStub = (values: Record<string, unknown>) =>
  ({
    get: (key: string, fallback?: unknown) => values[key] ?? fallback,
  }) as unknown as ConfigService;

describe('buildThrottlerOptions', () => {
  it('converts RATE_LIMIT_TTL from seconds to milliseconds', () => {
    const options = buildThrottlerOptions(
      configStub({ RATE_LIMIT_TTL: '60', RATE_LIMIT_MAX: '100' }),
    ) as any;

    expect(options.throttlers[0].ttl).toBe(60_000);
    expect(options.throttlers[0].limit).toBe(100);
  });

  it('supplies a getTracker rather than leaving the library default in place', () => {
    // The library default is normalizeIp(req.ip), and `trust proxy` is
    // off here, so the default is one bucket for the whole platform.
    const options = buildThrottlerOptions(configStub({})) as any;

    expect(typeof options.getTracker).toBe('function');
    expect(
      options.getTracker({ ip: '10.42.0.7', headers: { 'x-forwarded-for': '203.0.113.5' } }),
    ).toBe('ip:203.0.113.5');
  });

  it('leaves storage in memory when no Redis host is configured', () => {
    expect((buildThrottlerOptions(configStub({})) as any).storage).toBeUndefined();
  });
});

describe('the global ThrottlerGuard, end to end', () => {
  let app: INestApplication;

  // Two requests per window makes the third the interesting one.
  const options = buildThrottlerOptions(
    configStub({ RATE_LIMIT_TTL: '60', RATE_LIMIT_MAX: '2' }),
  );

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot(options as any)],
      controllers: [PingController],
      providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
    }).compile();

    app = moduleRef.createNestApplication();
    await listenOnLoopback(app);
  });

  afterAll(async () => {
    await app?.close();
  });

  const ping = (xff: string) =>
    request(app.getHttpServer()).get('/ping').set('X-Forwarded-For', xff);
  const login = (xff: string) =>
    request(app.getHttpServer()).post('/login').set('X-Forwarded-For', xff);

  it('429s one client without touching another behind the same proxy', async () => {
    // Every one of these arrives at the same ingress pod. Under the old
    // tracker they all shared a counter and bob's first request would
    // have been the fourth hit on it.
    expect((await ping('198.51.100.4')).status).toBe(200);
    expect((await ping('198.51.100.4')).status).toBe(200);
    expect((await ping('198.51.100.4')).status).toBe(429);

    // Different client, same proxy, untouched limit.
    const bob = await ping('203.0.113.77');
    expect(bob.status).toBe(200);
    expect(bob.headers['x-ratelimit-remaining']).toBe('1');
  });

  it('does not let a client escape its bucket by lengthening the chain', async () => {
    // A fresh address: spend its window, then try to wriggle out of it.
    expect((await ping('192.0.2.50')).status).toBe(200);
    expect((await ping('192.0.2.50')).status).toBe(200);

    // Each of these is the same real client (nginx appended 192.0.2.50)
    // dressing the header up differently. All must still be blocked.
    expect((await ping('8.8.8.8, 192.0.2.50')).status).toBe(429);
    expect((await ping('1.1.1.1, 2.2.2.2, 3.3.3.3, 192.0.2.50')).status).toBe(429);
    expect((await ping('unidentified, 192.0.2.50')).status).toBe(429);
  });

  it('counts a request that arrives with no X-Forwarded-For at all', async () => {
    // No header: supertest connects straight to the server, so the peer
    // address is the client's own. It gets a bucket like anyone else.
    const server = app.getHttpServer();
    expect((await request(server).get('/ping')).status).toBe(200);
    expect((await request(server).get('/ping')).status).toBe(200);
    expect((await request(server).get('/ping')).status).toBe(429);

    // And that did not spend anyone else's window.
    expect((await ping('198.51.100.200')).status).toBe(200);
  });

  it('keys per-route @Throttle overrides per client as well', async () => {
    // login-style routes carry their own tight @Throttle. They share the
    // module's getTracker, so under the library default "one attempt per
    // window" was one attempt per window for the entire platform.
    expect((await login('198.51.100.60')).status).toBe(201);
    expect((await login('198.51.100.60')).status).toBe(429);

    // A different client behind the same proxy is not locked out.
    expect((await login('203.0.113.61')).status).toBe(201);
  });
});

describe('app.module.ts wiring', () => {
  const source = readFileSync(join(__dirname, '..', '..', '..', 'app.module.ts'), 'utf8');

  it('builds the throttler options through buildThrottlerOptions', () => {
    // Guard against a future inline useFactory that quietly drops
    // getTracker and restores the single global bucket. The import alone
    // is not enough: the factory itself has to return the builder's
    // result.
    expect(source).toMatch(
      /ThrottlerModule\.forRootAsync\(\{[^}]*useFactory:\s*\([^)]*\)\s*=>\s*buildThrottlerOptions\(configService\)/,
    );
  });

  it('still binds ThrottlerGuard globally', () => {
    expect(source).toContain('useClass: ThrottlerGuard');
    expect(source).toContain('provide: APP_GUARD');
  });

  it('does not build throttler options inline', () => {
    // `throttlers: [` appearing in app.module.ts would mean the options
    // are being assembled somewhere this spec cannot reach.
    expect(source).not.toContain('throttlers:');
  });
});
