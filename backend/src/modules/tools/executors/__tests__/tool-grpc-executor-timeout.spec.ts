/**
 * A gRPC tool waits as long as an HTTP tool would: the caller's timeout,
 * else the tool's, else the API's timeoutMs, else 30 s. The gRPC paths
 * skipped the API's setting and passed a zero timeout straight through,
 * which the caller read as "no deadline".
 */
import { ToolGrpcExecutor } from '../tool-grpc.executor';
import { DEFAULT_GRPC_TIMEOUT_MS } from '../grpc-caller.service';

function setup() {
  const grpcCaller = { call: jest.fn().mockResolvedValue({ success: true, data: { ok: 1 }, code: 0 }) };
  const auth = { applyApiAuth: jest.fn(), applyToolAuth: jest.fn() };
  const schemas = { findOne: jest.fn().mockResolvedValue({ rawSchema: 'syntax = "proto3";' }) };
  const executor = new ToolGrpcExecutor(auth as any, grpcCaller as any, schemas as any, undefined);
  return { executor, grpcCaller };
}

function fixture(apiTimeoutMs?: number, toolTimeout?: number) {
  const api: any = { id: 'api-1', type: 'grpc', baseUrl: 'https://grpcb.in:9001', timeoutMs: apiTimeoutMs, organizationId: 'org-1' };
  const operation: any = { endpoint: '/grpc/GRPCBin/DummyUnary', metadata: {}, api };
  const tool: any = { name: 'dummy_unary', organizationId: 'org-1', configuration: toolTimeout === undefined ? {} : { timeout: toolTimeout }, operation, api };
  return { api, operation, tool };
}

describe('ToolGrpcExecutor timeout', () => {
  it("uses the API's timeoutMs when the tool and the caller name none", async () => {
    const { executor, grpcCaller } = setup();
    const { api, operation, tool } = fixture(12_000);
    await executor.executeProtobufOperation(tool, operation, api, { f_string: 'x' }, {} as any);
    expect(grpcCaller.call.mock.calls[0][0].timeoutMs).toBe(12_000);
  });

  it("the tool's timeout wins over the API's, and the caller's over both", async () => {
    const { executor, grpcCaller } = setup();
    const { api, operation, tool } = fixture(12_000, 7_000);
    await executor.executeProtobufOperation(tool, operation, api, {}, {} as any);
    await executor.executeProtobufOperation(tool, operation, api, {}, { timeout: 3_000 } as any);
    expect(grpcCaller.call.mock.calls.map((c: any[]) => c[0].timeoutMs)).toEqual([7_000, 3_000]);
  });

  it('a zero timeout falls through to the default instead of meaning no deadline', async () => {
    const { executor, grpcCaller } = setup();
    const { api, operation, tool } = fixture(0, 0);
    await executor.executeProtobufOperation(tool, operation, api, {}, { timeout: 0 } as any);
    expect(grpcCaller.call.mock.calls[0][0].timeoutMs).toBe(DEFAULT_GRPC_TIMEOUT_MS);
  });

  it('a structured gRPC tool uses the same rule', async () => {
    const { executor, grpcCaller } = setup();
    const { api, tool } = fixture(9_000);
    tool.grpcConfig = { serviceName: 'GRPCBin', methodName: 'DummyUnary', protoDefinition: 'syntax = "proto3";' };
    await executor.executeGrpcConfig(tool, {}, {} as any);
    expect(grpcCaller.call.mock.calls[0][0].timeoutMs).toBe(9_000);
    expect(api.baseUrl).toBe(grpcCaller.call.mock.calls[0][0].baseUrl);
  });

  it("passes the caller's plain timeout message through to the tool result", async () => {
    const { executor, grpcCaller } = setup();
    const message = "Couldn't reach grpcb.in:9001 within 30 s: no connection could be made.";
    grpcCaller.call.mockResolvedValueOnce({ success: false, error: message, code: 4 });
    const { api, operation, tool } = fixture();
    const res = await executor.executeProtobufOperation(tool, operation, api, {}, {} as any);
    expect(res.success).toBe(false);
    expect(res.error).toBe(`gRPC request failed: ${message}`);
  });
});
