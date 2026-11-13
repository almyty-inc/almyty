/**
 * A gRPC call always ends. On staging a generated gRPC tool called a
 * server the cluster could not reach, and the run never answered in the
 * browser: grpc-js waits on a server it cannot connect to until the
 * deadline, the name lookup had no bound, and the error said only
 * "Deadline exceeded ... Waiting for LB pick". These run against servers
 * on 127.0.0.1 that never answer, and need no network.
 */
import { createServer, Server as NetServer, Socket } from 'net';
import { Client, Server, ServerCredentials, loadPackageDefinition } from '@grpc/grpc-js';
import { loadSync } from '@grpc/proto-loader';
import { mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// A name lookup that never comes back, for the pinned-DNS case only.
jest.mock('../../../../common/security/ssrf-safe-agent', () => ({
  pinnedLookup: jest.fn(() => undefined),
}));

import { DEFAULT_GRPC_TIMEOUT_MS, effectiveTimeoutMs, GrpcCallerService } from '../grpc-caller.service';

const PROTO = `
syntax = "proto3";
package hang;
service HangService {
  rpc Unary(Msg) returns (Msg);
}
message Msg { string text = 1; }
`;

function call(svc: GrpcCallerService, baseUrl: string, timeoutMs?: number, pinDns = false) {
  return svc.call({
    protoSource: PROTO,
    baseUrl,
    serviceName: 'HangService',
    methodName: 'Unary',
    request: { text: 'hi' },
    timeoutMs,
    pinDns,
  });
}

/** Accepts TCP connections and never says a word, like a dropped port. */
async function silentServer(): Promise<{ port: number; sockets: Socket[]; close: () => Promise<void> }> {
  const sockets: Socket[] = [];
  const server: NetServer = createServer((s) => {
    sockets.push(s);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as any).port;
  return {
    port,
    sockets,
    close: () =>
      new Promise<void>((r) => {
        sockets.forEach((s) => s.destroy());
        server.close(() => r());
      }),
  };
}

describe('GrpcCallerService deadlines', () => {
  const svc = new GrpcCallerService();

  it('a server that never completes the connection yields a timeout error naming the address', async () => {
    const silent = await silentServer();
    try {
      const t0 = Date.now();
      const res = await call(svc, `127.0.0.1:${silent.port}`, 1000);
      expect(Date.now() - t0).toBeLessThan(5000);
      expect(res.success).toBe(false);
      expect(res.code).toBe(4);
      expect(res.error).toBe(
        `Couldn't reach 127.0.0.1:${silent.port} within 1 s: no connection could be made. ` +
          'Check the address and port, and that outbound connections to that port are allowed from this server.',
      );
    } finally {
      await silent.close();
    }
  });
  it('closes the channel when the call ends', async () => {
    const silent = await silentServer();
    const close = jest.spyOn(Client.prototype, 'close');
    try {
      await call(svc, `127.0.0.1:${silent.port}`, 500);
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      close.mockRestore();
      await silent.close();
    }
  });

  describe('a gRPC server whose method never answers', () => {
    let server: Server;
    let port: number;

    beforeAll(async () => {
      const dir = join(tmpdir(), 'grpc-deadline-spec');
      mkdirSync(dir, { recursive: true });
      const protoPath = join(dir, 'hang.proto');
      writeFileSync(protoPath, PROTO, 'utf-8');
      const loaded = loadPackageDefinition(loadSync(protoPath, { keepCase: true })) as any;
      server = new Server();
      server.addService(loaded.hang.HangService.service, {
        Unary: () => {
          /* never calls back */
        },
      });
      port = await new Promise<number>((resolve, reject) =>
        server.bindAsync('127.0.0.1:0', ServerCredentials.createInsecure(), (err, p) => (err ? reject(err) : resolve(p))),
      );
    });

    afterAll(() => {
      server.forceShutdown();
    });

    it('says it connected but got no answer within the deadline', async () => {
      const res = await call(svc, `127.0.0.1:${port}`, 1000);
      expect(res.success).toBe(false);
      expect(res.code).toBe(4);
      expect(res.error).toBe(`127.0.0.1:${port} accepted the connection but did not answer within 1 s.`);
    });
  });

  it('bounds the name lookup by the same deadline', async () => {
    const t0 = Date.now();
    const res = await call(svc, 'https://grpc.example.invalid:9001', 500, true);
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(res.success).toBe(false);
    expect(res.code).toBe(4);
    expect(res.error).toBe("Couldn't resolve grpc.example.invalid:9001 within 0.5 s.");
  });

  it('a call with no timeout still gets a deadline', async () => {
    const spy = jest
      .spyOn(svc as any, 'callUnary')
      .mockImplementation(async (...args: any[]) => ({ success: true, data: args[4], code: 0 }));
    try {
      const before = Date.now();
      const res = await call(svc, '127.0.0.1:1', undefined);
      const deadline: Date = res.data.deadline;
      expect(deadline).toBeInstanceOf(Date);
      expect(deadline.getTime()).toBeGreaterThanOrEqual(before + DEFAULT_GRPC_TIMEOUT_MS);
      expect(deadline.getTime()).toBeLessThan(before + DEFAULT_GRPC_TIMEOUT_MS + 5000);
    } finally {
      spy.mockRestore();
    }
  });

  it('a zero or nonsense timeout falls back to the default', () => {
    expect(effectiveTimeoutMs(undefined)).toBe(DEFAULT_GRPC_TIMEOUT_MS);
    expect(effectiveTimeoutMs(0)).toBe(DEFAULT_GRPC_TIMEOUT_MS);
    expect(effectiveTimeoutMs(-5)).toBe(DEFAULT_GRPC_TIMEOUT_MS);
    expect(effectiveTimeoutMs(Number.NaN)).toBe(DEFAULT_GRPC_TIMEOUT_MS);
    expect(effectiveTimeoutMs(1500)).toBe(1500);
  });
});
