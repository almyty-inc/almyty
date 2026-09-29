import { Controller, Get, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { readFileSync, readdirSync, statSync } from 'fs';
import * as http from 'http';
import type { AddressInfo } from 'net';
import { join, relative } from 'path';
import request from 'supertest';

import { listenOnLoopback } from '../http';

/**
 * supertest sends every request to http://127.0.0.1:<port>. When the server
 * is not already listening it listens on the IPv6 wildcard itself, and on
 * macOS that wildcard can hold the same port as another process's
 * 127.0.0.1 listener, which then receives the request. That is how
 * hosted-chat-oauth.controller.spec.ts saw "expected 302, got 404" (and a
 * 200 "ok") under parallel runs: the answer came from someone else's server.
 */
const SRC_ROOT = join(__dirname, '..', '..');
const EE_ROOT = join(SRC_ROOT, '..', 'ee');

@Controller()
class OursController {
  @Get('whoami')
  whoami() {
    return { server: 'ours' };
  }
}

function listening(server: http.Server, port: number, host?: string): Promise<boolean> {
  return new Promise((resolve) => {
    server.once('error', () => resolve(false));
    server.listen(port, ...(host ? [host] : []), () => resolve(true));
  });
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve) => (server.listening ? server.close(() => resolve()) : resolve()));
}

function specs(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : specs(path);
    return path.endsWith('.spec.ts') && path !== __filename ? [path] : [];
  });
}

describe('supertest requests reach the app under test', () => {
  let app: INestApplication | undefined;
  const others: http.Server[] = [];

  afterEach(async () => {
    await app?.close();
    app = undefined;
    await Promise.all(others.splice(0).map(close));
  });

  const someoneElse = () => {
    const server = http.createServer((_req, res) => {
      res.statusCode = 404;
      res.end('not ours');
    });
    others.push(server);
    return server;
  };

  async function oursApp(): Promise<INestApplication> {
    const moduleRef = await Test.createTestingModule({ controllers: [OursController] }).compile();
    return moduleRef.createNestApplication({ logger: false });
  }

  it('an app on the IPv6 wildcard can be shadowed by another 127.0.0.1 listener (what supertest used to get)', async () => {
    const other = someoneElse();
    await listening(other, 0, '127.0.0.1');
    const port = (other.address() as AddressInfo).port;

    app = await oursApp();
    await app.init();
    const server: http.Server = app.getHttpServer();
    // The port the kernel handed supertest's listen(0) in the flake.
    if (!(await listening(server, port))) {
      // Linux refuses the overlapping bind, so the shadowing cannot happen there.
      return;
    }
    const res = await request(server).get('/whoami');
    expect(res.status).toBe(404);
    expect(res.text).toBe('not ours');
  });

  it('an app listening via listenOnLoopback cannot be shadowed', async () => {
    app = await listenOnLoopback(await oursApp());
    const server: http.Server = app.getHttpServer();
    const { address, port } = server.address() as AddressInfo;
    expect(address).toBe('127.0.0.1');

    // Nobody else can take its 127.0.0.1 port...
    expect(await listening(someoneElse(), port, '127.0.0.1')).toBe(false);
    // ...and a wildcard listener on it, where one is allowed, does not get its traffic.
    await listening(someoneElse(), port);

    for (let i = 0; i < 3; i++) {
      const res = await request(server).get('/whoami');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ server: 'ours' });
    }
    // supertest reused the listening server rather than re-listening per request.
    expect((server.address() as AddressInfo).port).toBe(port);
  });

  it('every spec that drives an app through supertest listens on 127.0.0.1 first', () => {
    const offenders = [...specs(SRC_ROOT), ...specs(EE_ROOT)]
      .filter((file) => {
        const source = readFileSync(file, 'utf8');
        if (!/from ['"]supertest['"]/.test(source)) return false;
        return !/(?:listenOnLoopback|serveOnLoopback)\(|\.listen\(\s*0\s*,\s*['"]127\.0\.0\.1['"]/.test(source);
      })
      .map((file) => relative(SRC_ROOT, file));
    expect(offenders).toEqual([]);
  });
});
