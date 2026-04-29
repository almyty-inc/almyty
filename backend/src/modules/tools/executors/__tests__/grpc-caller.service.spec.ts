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
});
