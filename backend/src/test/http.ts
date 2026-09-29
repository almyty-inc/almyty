import type { INestApplication } from '@nestjs/common';
import * as http from 'http';

/**
 * Initialise `app` and listen on 127.0.0.1 for the life of the spec.
 *
 * supertest's `request(server)` on a server that is not listening calls
 * `server.listen(0)` -- the IPv6 wildcard -- for every request, and then
 * sends the request to http://127.0.0.1:<port>. macOS will hand that
 * wildcard listener a port another process already holds on 127.0.0.1, and
 * the request then goes to that process instead (a browser helper, a dev
 * server, another agent's fake): the spec sees a 404 or a 200 "ok" it never
 * produced. Listening on 127.0.0.1 itself cannot share a port with another
 * 127.0.0.1 listener, and supertest reuses a server that already listens.
 * Pinned by __tests__/supertest-listens-on-loopback.guard.spec.ts.
 */
export async function listenOnLoopback<T extends INestApplication>(app: T): Promise<T> {
  await app.listen(0, '127.0.0.1');
  return app;
}

/**
 * The same for a bare request handler (an express app) that a spec would
 * otherwise hand to supertest as `request(handler)`, which wraps it in a
 * fresh server listening on the wildcard for every request. Close the
 * returned server when the spec is done with it.
 */
export async function serveOnLoopback(handler: http.RequestListener): Promise<http.Server> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  return server;
}