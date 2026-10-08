/**
 * A fake almyty API for enroll mode, on a loopback port: the three routes
 * a hosted runner talks to, with the backend's rules (single-use token,
 * credential accepted only on the hosted stream and its renewal).
 */
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';

export const FAKE_TOKEN = 'fake-enrollment-token-for-tests';

export interface FakeHostedApi {
  url: string;
  /** Every request seen, in order, without bodies. */
  requests: Array<{ method: string; path: string; authorization?: string }>;
  /** Envelopes POSTed to the hosted stream. */
  envelopes: any[];
  /** Enrollment bodies received. */
  enrollBodies: any[];
  /** Credentials issued so far; the last one is current. */
  issued: string[];
  /** Open GET streams. */
  openStreams: number;
  /** Make the next renewals answer this status. */
  renewStatus: number;
  /** Seconds each issued credential lives. */
  credentialTtlSeconds: number;
  close(): Promise<void>;
}

const EFFECTIVE_CONFIG = {
  defaultIsolation: 'host',
  maxConcurrent: 1,
  allowedCwdRoots: ['/workspace'],
  denyPatterns: [],
  networkBlocked: false,
  installBlocked: false,
};

export async function startFakeHostedApi(): Promise<FakeHostedApi> {
  let tokenUsed = false;
  let credentialSeq = 0;
  const streams = new Set<ServerResponse>();
  const api: FakeHostedApi = {
    url: '',
    requests: [],
    envelopes: [],
    enrollBodies: [],
    issued: [],
    openStreams: 0,
    renewStatus: 200,
    credentialTtlSeconds: 3600,
    close: async () => {
      for (const s of streams) s.end();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };

  const issue = () => {
    const credential = `fake-runner-credential-${++credentialSeq}`;
    api.issued.push(credential);
    return { credential, expiresAt: new Date(Date.now() + api.credentialTtlSeconds * 1000).toISOString() };
  };
  const bearerOk = (req: IncomingMessage) => {
    const current = api.issued[api.issued.length - 1];
    return !!current && req.headers.authorization === `Bearer ${current}`;
  };
  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const server: Server = createServer(async (req, res) => {
    const path = (req.url ?? '').split('?')[0];
    api.requests.push({ method: req.method ?? '', path, authorization: req.headers.authorization });
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString('utf-8');
    const body = raw ? JSON.parse(raw) : undefined;

    if (req.method === 'POST' && path === '/runners/enroll') {
      api.enrollBodies.push(body);
      if (tokenUsed || body?.token !== FAKE_TOKEN) {
        return json(res, 401, { statusCode: 401, message: 'This enrollment token is not valid' });
      }
      tokenUsed = true;
      return json(res, 200, {
        success: true,
        data: {
          runnerId: '11111111-2222-4333-8444-555555555555',
          ...issue(),
          effectiveConfig: EFFECTIVE_CONFIG,
          streamPath: '/runners/hosted/stream',
          renewPath: '/runners/hosted/credential',
        },
      });
    }
    if (req.method === 'POST' && path === '/runners/hosted/credential') {
      if (!bearerOk(req)) return json(res, 401, { message: 'A runner credential is required' });
      if (api.renewStatus !== 200) return json(res, api.renewStatus, { message: 'runner not found' });
      return json(res, 200, { success: true, data: issue() });
    }
    if (path === '/runners/hosted/stream') {
      if (!bearerOk(req)) return json(res, 401, { message: 'A runner credential is required' });
      if (req.method === 'POST') {
        api.envelopes.push(body);
        res.writeHead(202, { 'Mcp-Session-Id': 'fake-session' });
        return res.end();
      }
      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        res.write(': open\n\n');
        api.openStreams++;
        streams.add(res);
        req.on('close', () => { streams.delete(res); api.openStreams--; });
        return;
      }
    }
    json(res, 404, { message: `Cannot ${req.method} ${path}` });
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  api.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return api;
}
