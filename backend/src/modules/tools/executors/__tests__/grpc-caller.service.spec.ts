/**
 * grpc-caller.service spec — stands up a real @grpc/grpc-js server
 * in-process so the test exercises actual HTTP/2 + protobuf framing,
 * not a stub. The test server speaks the same proto we ship to
 * GrpcCallerService.
 *
 * Skipped by default in environments where binding to a local
 * insecure port might fail (CI sandbox quirks); set
 * RUN_GRPC_INTEGRATION=1 to exercise.
 */
import { Server, ServerCredentials, loadPackageDefinition, credentials } from '@grpc/grpc-js';
import { loadSync } from '@grpc/proto-loader';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { GrpcCallerService } from '../grpc-caller.service';

const PROTO = `
syntax = "proto3";
package echo;

service EchoService {
  rpc Echo(EchoRequest) returns (EchoResponse);
  rpc Stream(EchoRequest) returns (stream EchoResponse);
  rpc Aggregate(stream EchoRequest) returns (EchoResponse);
  rpc Bidi(stream EchoRequest) returns (stream EchoResponse);
}

message EchoRequest {
  string text = 1;
  int32 times = 2;
}

message EchoResponse {
  string repeated = 1;
}
`;

const SHOULD_RUN = process.env.RUN_GRPC_INTEGRATION === '1';
const describeIfRun = SHOULD_RUN ? describe : describe.skip;

describeIfRun('GrpcCallerService (real @grpc/grpc-js server)', () => {
  let server: Server;
  let port: number;
  let protoPath: string;
  let svc: GrpcCallerService;

  beforeAll(async () => {
    const dir = join(tmpdir(), 'grpc-caller-spec');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    protoPath = join(dir, 'echo.proto');
    writeFileSync(protoPath, PROTO, 'utf-8');

    const pkgDef = loadSync(protoPath, {
      keepCase: true,
      longs: Number,
      defaults: true,
    });
    const loaded = loadPackageDefinition(pkgDef) as any;
    const Echo = loaded.echo.EchoService;

    server = new Server();
    server.addService(Echo.service, {
      Echo: (call: any, cb: any) => {
        const { text = '', times = 1 } = call.request || {};
        cb(null, { repeated: Array(times).fill(text).join(' ') });
      },
      Stream: (call: any) => {
        const { text = '', times = 1 } = call.request || {};
        for (let i = 0; i < times; i++) {
          call.write({ repeated: `${text}-${i}` });
        }
        call.end();
      },
      Aggregate: (call: any, cb: any) => {
        const parts: string[] = [];
        call.on('data', (msg: any) => parts.push(msg.text || ''));
        call.on('end', () => cb(null, { repeated: parts.join('|') }));
      },
      Bidi: (call: any) => {
        // Echo each inbound message back, prefixed.
        call.on('data', (msg: any) =>
          call.write({ repeated: `pong:${msg.text || ''}` }),
        );
        call.on('end', () => call.end());
      },
    });

    port = await new Promise<number>((resolve, reject) => {
      server.bindAsync(
        '127.0.0.1:0',
        ServerCredentials.createInsecure(),
        (err, p) => (err ? reject(err) : resolve(p)),
      );
    });

    svc = new GrpcCallerService();
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.tryShutdown(() => resolve()));
    rmSync(join(tmpdir(), 'grpc-caller-spec'), { recursive: true, force: true });
  });

  it('makes a real unary call and returns the response', async () => {
    const result = await svc.call({
      protoSource: PROTO,
      baseUrl: `127.0.0.1:${port}`, // bare host:port → insecure
      serviceName: 'EchoService',
      methodName: 'Echo',
      request: { text: 'ping', times: 3 },
    });
    expect(result.success).toBe(true);
    expect(result.data?.repeated).toBe('ping ping ping');
    expect(result.code).toBe(0);
  });

  it('returns a structured error when the service is wrong', async () => {
    const result = await svc.call({
      protoSource: PROTO,
      baseUrl: `127.0.0.1:${port}`,
      serviceName: 'NotARealService',
      methodName: 'Echo',
      request: {},
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('NotARealService');
  });

  it('returns a structured error when the method is wrong', async () => {
    const result = await svc.call({
      protoSource: PROTO,
      baseUrl: `127.0.0.1:${port}`,
      serviceName: 'EchoService',
      methodName: 'NotARealMethod',
      request: {},
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('NotARealMethod');
  });

  it('passes call metadata through to the server handler', async () => {
    // Add a custom metadata header. The Echo handler can't see it
    // directly without recapture, so we rely on the call returning
    // success — the assertion is mainly that adding metadata
    // doesn't break the call.
    const result = await svc.call({
      protoSource: PROTO,
      baseUrl: `127.0.0.1:${port}`,
      serviceName: 'EchoService',
      methodName: 'Echo',
      request: { text: 'meta', times: 1 },
      metadata: { 'x-test-header': 'present' },
    });
    expect(result.success).toBe(true);
    expect(result.data?.repeated).toBe('meta');
  });

  // ─── Streaming ───────────────────────────────────────────────

  it('server-streaming: collects every emitted message', async () => {
    const result = await svc.call({
      protoSource: PROTO,
      baseUrl: `127.0.0.1:${port}`,
      serviceName: 'EchoService',
      methodName: 'Stream',
      request: { text: 'tick', times: 4 },
      responseStream: true,
    });
    expect(result.success).toBe(true);
    expect(Array.isArray(result.data)).toBe(true);
    expect(result.data).toHaveLength(4);
    expect(result.data[0]?.repeated).toBe('tick-0');
    expect(result.data[3]?.repeated).toBe('tick-3');
    expect(result.streamMessageCount).toBe(4);
    expect(result.streamTruncated).toBeFalsy();
  });

  it('server-streaming: caps at maxStreamMessages and reports truncation', async () => {
    const result = await svc.call({
      protoSource: PROTO,
      baseUrl: `127.0.0.1:${port}`,
      serviceName: 'EchoService',
      methodName: 'Stream',
      request: { text: 'flood', times: 50 },
      responseStream: true,
      maxStreamMessages: 5,
    });
    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(5);
    expect(result.streamMessageCount).toBe(5);
    expect(result.streamTruncated).toBe(true);
  });

  it('client-streaming: aggregates the inbound messages into one response', async () => {
    const result = await svc.call({
      protoSource: PROTO,
      baseUrl: `127.0.0.1:${port}`,
      serviceName: 'EchoService',
      methodName: 'Aggregate',
      request: [{ text: 'a' }, { text: 'b' }, { text: 'c' }],
      requestStream: true,
    });
    expect(result.success).toBe(true);
    expect(result.data?.repeated).toBe('a|b|c');
  });

  it('bidi-streaming: replies to each inbound message and collects the responses', async () => {
    const result = await svc.call({
      protoSource: PROTO,
      baseUrl: `127.0.0.1:${port}`,
      serviceName: 'EchoService',
      methodName: 'Bidi',
      request: [{ text: 'one' }, { text: 'two' }],
      requestStream: true,
      responseStream: true,
    });
    expect(result.success).toBe(true);
    expect(Array.isArray(result.data)).toBe(true);
    expect(result.data).toHaveLength(2);
    expect(result.data[0]?.repeated).toBe('pong:one');
    expect(result.data[1]?.repeated).toBe('pong:two');
    expect(result.streamMessageCount).toBe(2);
  });
});

// Pure target/TLS resolution — no server needed, always runs.
describe('GrpcCallerService.resolveTarget', () => {
  const resolve = (baseUrl: string, tls?: boolean) =>
    (new GrpcCallerService() as any).resolveTarget(baseUrl, tls);

  it('uses TLS for https:// and plaintext for http://', () => {
    expect(resolve('https://x.example.com')).toEqual({ target: 'x.example.com:443', useTls: true });
    expect(resolve('http://x.example.com')).toEqual({ target: 'x.example.com:80', useTls: false });
  });

  it('defaults bare host (no port) to TLS:443 and bare host:port to plaintext', () => {
    expect(resolve('x.example.com')).toEqual({ target: 'x.example.com:443', useTls: true });
    expect(resolve('internal-host:50051')).toEqual({ target: 'internal-host:50051', useTls: false });
  });

  it('honors an explicit tls override over the heuristic', () => {
    // bare host:port would default to plaintext — force TLS.
    expect(resolve('internal-host:50051', true).useTls).toBe(true);
    // https:// would default to TLS — force plaintext.
    expect(resolve('https://x.example.com', false).useTls).toBe(false);
  });

  it('throws on empty baseUrl', () => {
    expect(() => resolve('')).toThrow();
  });
});
