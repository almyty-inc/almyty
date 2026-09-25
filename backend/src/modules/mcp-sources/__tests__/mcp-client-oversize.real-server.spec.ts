import * as http from 'http';
import { AddressInfo } from 'net';

import { MCP_MAX_RESPONSE_BYTES, McpClientService } from '../mcp-client.service';

/**
 * An MCP source is a URL an org admin types, and sync buffers the reply
 * whole (an SSE stream until our response arrives). A server that answers
 * with an endless body must be cut off at the cap, not read into the API
 * process. Real server on loopback, reached through the self-host hatch
 * (MCP_ALLOW_PRIVATE_URLS), which exempts that one host and nothing else.
 */
let server: http.Server;
let port: number;
let bytesSent = 0;

beforeAll(async () => {
  server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = Buffer.alloc(256 * 1024, 0x61);
    const pump = () => {
      while (!res.destroyed) {
        bytesSent += chunk.length;
        if (!res.write(chunk)) return void res.once('drain', pump);
      }
    };
    pump();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const prior = process.env.MCP_ALLOW_PRIVATE_URLS;
beforeEach(() => {
  process.env.MCP_ALLOW_PRIVATE_URLS = 'true';
});
afterEach(() => {
  if (prior === undefined) delete process.env.MCP_ALLOW_PRIVATE_URLS;
  else process.env.MCP_ALLOW_PRIVATE_URLS = prior;
});

it('stops reading an endless reply at the cap', async () => {
  const client = new McpClientService();
  const err = await client
    .initialize({ url: `http://127.0.0.1:${port}/mcp`, timeoutMs: 20_000 })
    .then(() => null, (e) => e);
  expect(err).toMatchObject({ code: 'MCP_RESPONSE_TOO_LARGE' });
  // It stopped near the cap rather than draining the stream until the timeout.
  expect(bytesSent).toBeLessThan(MCP_MAX_RESPONSE_BYTES * 4);
}, 30_000);
