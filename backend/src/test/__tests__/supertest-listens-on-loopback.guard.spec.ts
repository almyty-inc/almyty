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

/**
 * Resolves on the server's own 'listening' or 'error' event, whichever comes,
 * and leaves no listener behind for the other.
 */
function listening(server: http.Server, port: number, host?: string): Promise<boolean> {
  return new Promise((resolve) => {
    const onListening = () => {
      server.off('error', onError);
      resolve(true);
    };
    const onError = () => {
      server.off('listening', onListening);
      resolve(false);
    };
    server.once('listening', onListening);
    server.once('error', onError);
    server.listen(port, ...(host ? [host] : []));
  });
}

/** Closes at once: supertest's keep-alive sockets are dropped, not waited out. */
function close(server: http.Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
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

  // The first Nest app a jest worker initialises loads express and its
  // middleware into the module sandbox, which takes seconds on a loaded
  // machine and blew the 5s test budget of whichever case ran first. Pay it
  // once here, so the cases themselves only do socket work and wait on
  // events. The generous hook budget is for module loading, not for a socket.
  beforeAll(async () => {
    const warm = await listenOnLoopback(await oursApp());
    try {
      await request(warm.getHttpServer()).get('/whoami').expect(200);
    } finally {
      await warm.close();
    }
  }, 120_000);

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
