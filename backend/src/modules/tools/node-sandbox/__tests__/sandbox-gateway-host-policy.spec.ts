import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as path from 'path';

import { sandboxHostPolicy } from '../../../../common/security/gateway-tool-policy';
import { NodeSandboxService } from '../node-sandbox.service';
import { DependencyManagerService } from '../dependency-manager.service';

/**
 * A gateway tool's `securityPolicy` host restrictions reach the sandbox.
 *
 * HTTP, GraphQL, SOAP and gRPC tools were held to a gateway tool's
 * allowed / blocked domains by the host-side executors; a JavaScript or
 * SDK tool's own `fetch` was held only to the SSRF floor, so an
 * allow-list of one API host did not stop the tool calling any other
 * public host. These run real workers against a loopback server (let
 * through the SSRF floor by the test-only allow list, which the policy
 * deliberately does not honour).
 */
jest.setTimeout(30_000);

const FETCH_LOCAL = `
  const res = await fetch('http://127.0.0.1:' + parameters.port + '/');
  return await res.text();
`;

describe('sandboxed tool code is held to the gateway host policy', () => {
  let server: http.Server;
  let port: number;
  let service: NodeSandboxService;

  beforeAll(async () => {
    server = http.createServer((_req, res) => res.end('reached'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as net.AddressInfo).port;
    service = new NodeSandboxService({
      ensureInstalled: jest.fn(),
    } as unknown as DependencyManagerService);
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const run = (hostPolicy?: { allowedDomains?: string[]; blockedDomains?: string[] } | null) =>
    service.execute({
      code: FETCH_LOCAL,
      parameters: { port },
      timeoutMs: 10_000,
      memoryLimitMb: 64,
      testNetAllow: `127.0.0.1:${port}`,
      hostPolicy,
    });

  it('reaches the server when no policy restricts hosts', async () => {
    const result = await run(null);
    expect(result.error).toBeUndefined();
    expect(result.data).toBe('reached');
  });

  it('refuses a host outside the allowed-domain list', async () => {
    const result = await run({ allowedDomains: ['api.example.com'] });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).not.toContain('reached');
  });

  it('refuses a host on the blocked-domain list', async () => {
    const result = await run({ blockedDomains: ['127.0.0.1'] });
    expect(result.success).toBe(false);
  });

  it('allows a host the policy lists', async () => {
    const result = await run({ allowedDomains: ['127.0.0.1'] });
    expect(result.data).toBe('reached');
  });
});

describe('sandboxHostPolicy', () => {
  it('keeps only the host restrictions, and is null when there are none', () => {
    expect(sandboxHostPolicy(null)).toBeNull();
    expect(sandboxHostPolicy({ requireHttps: true, allowedHttpMethods: ['GET'] })).toBeNull();
    expect(sandboxHostPolicy({ allowedDomains: ['', 'api.example.com'], blockedDomains: [] })).toEqual({
      allowedDomains: ['api.example.com'],
      blockedDomains: [],
    });
  });
});

describe('every sandbox execution from the script executor carries the host policy', () => {
  it('passes hostPolicy on each nodeSandbox.execute call', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '..', '..', 'executors', 'tool-script.executor.ts'),
      'utf8',
    );
    const calls = source.match(/this\.nodeSandbox\.execute\(\{[\s\S]*?\}\);/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const call of calls) {
      expect(call).toContain('hostPolicy: sandboxHostPolicy(options.securityPolicy)');
    }
  });
});
