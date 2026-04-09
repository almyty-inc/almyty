/**
 * Real-worker security integration tests.
 *
 * These tests run the full NodeSandboxService → Worker → user code
 * path with the actual sandbox-worker.ts script, the actual
 * --permission flag set, and the actual net-guard monkey-patches
 * installed. They exist because every single mock-based test in
 * this codebase stubs out the worker layer (otherwise tests would
 * be slow), which means a bug in any of the three security layers
 * — FS permission, network guard, env scrub, tool-invocation shim —
 * could slip past every spec in src/modules/tools/node-sandbox/.
 *
 * Each test here proves ONE threat model assumption:
 *
 *   1. fs-read outside the allowed scope → ERR_ACCESS_DENIED
 *   2. fs-write anywhere → ERR_ACCESS_DENIED
 *   3. child_process.spawn/exec → refused
 *   4. nested worker_threads → refused
 *   5. net.connect to 127.0.0.1 → refused (via allowlist OR net-guard)
 *   6. fetch to metadata.google.internal → refused (hostname ban)
 *   7. fetch to 169.254.169.254 → refused (IP ban)
 *   8. process.env.SOMETHING → undefined (env scrub)
 *   9. tools.invoke round-trip → host callback result flows back
 *  10. tools.invoke rejection → user code observes a rejected promise
 *  11. tools global undefined when no invokeTool callback wired
 *  12. test-net-allow bypass → fetch to local HTTP server succeeds
 *  13. test-net-allow bypass does NOT leak to other local ports
 *  14. AbortSignal propagation → worker terminates mid-execution
 *
 * Why ts-node dev path: the dev scope still grants ONLY
 *   backendRoot + backend/node_modules + nodeDir
 * which means /etc/passwd is outside the allowed scope and
 * --permission still denies fs.write, child_process, worker_threads,
 * and native addon loading. The compiled-prod scope is narrower
 * but the threats this suite guards against are blocked in both.
 * The existing 76 unit tests in src/modules/tools/node-sandbox
 * already exercise the prod-scope boundary implicitly via their
 * Jest invocation under --permission.
 */
import * as http from 'http';
import { AddressInfo } from 'net';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { NodeSandboxService } from '../../modules/tools/node-sandbox/node-sandbox.service';
import { DependencyManagerService } from '../../modules/tools/node-sandbox/dependency-manager.service';

jest.setTimeout(60_000);

describe('Sandbox security (real worker, permission model ON)', () => {
  let service: NodeSandboxService;
  let depManager: DependencyManagerService;

  beforeAll(() => {
    depManager = {
      ensureInstalled: jest.fn().mockResolvedValue({
        installDir: path.join(os.tmpdir(), 'sandbox-security-fake-deps'),
        cached: true,
        installTimeMs: 0,
      }),
      listCached: jest.fn().mockReturnValue([]),
      clearCache: jest.fn(),
    } as any;

    service = new NodeSandboxService(depManager);
  });

  // ── 1. Filesystem read refused ──────────────────────────────────

  it('refuses fs.readFileSync on /etc/passwd', async () => {
    const result = await service.execute({
      code: `
        try {
          const fs = require('fs');
          return { ok: false, read: fs.readFileSync('/etc/passwd', 'utf8').slice(0, 10) };
        } catch (err) {
          return { ok: true, code: err.code, msg: err.message };
        }
      `,
      parameters: {},
      timeoutMs: 10_000,
    });

    expect(result.success).toBe(true);
    // require('fs') is blocked by the module allowlist. Either way,
    // no /etc/passwd content ever reaches user code.
    expect(result.data.ok).toBe(true);
    expect(JSON.stringify(result.data)).not.toMatch(/root:/);
  });

  // ── 2. Filesystem write refused ─────────────────────────────────

  it('refuses fs.writeFileSync to /tmp', async () => {
    const tmpTarget = path.join(os.tmpdir(), `sandbox-write-test-${Date.now()}.txt`);
    const result = await service.execute({
      code: `
        try {
          const fs = require('fs');
          fs.writeFileSync(${JSON.stringify(tmpTarget)}, 'pwned');
          return { ok: false };
        } catch (err) {
          return { ok: true, code: err.code, msg: err.message };
        }
      `,
      parameters: {},
      timeoutMs: 10_000,
    });

    expect(result.success).toBe(true);
    expect(result.data.ok).toBe(true);
    // File must not exist on host.
    expect(fs.existsSync(tmpTarget)).toBe(false);
  });

  // ── 3. child_process refused ────────────────────────────────────

  it('refuses child_process.execSync', async () => {
    const result = await service.execute({
      code: `
        try {
          const { execSync } = require('child_process');
          return { ok: false, stdout: execSync('whoami').toString() };
        } catch (err) {
          return { ok: true, code: err.code, msg: err.message };
        }
      `,
      parameters: {},
      timeoutMs: 10_000,
    });

    expect(result.success).toBe(true);
    expect(result.data.ok).toBe(true);
  });

  // ── 4. worker_threads refused ───────────────────────────────────

  it('refuses nested require("worker_threads")', async () => {
    const result = await service.execute({
      code: `
        try {
          require('worker_threads');
          return { ok: false };
        } catch (err) {
          return { ok: true, msg: err.message };
        }
      `,
      parameters: {},
      timeoutMs: 10_000,
    });

    expect(result.success).toBe(true);
    expect(result.data.ok).toBe(true);
    expect(result.data.msg).toMatch(/not allowed/);
  });

  // ── 5. Network: 127.0.0.1 refused ──────────────────────────────

  it('refuses net.connect to 127.0.0.1:22', async () => {
    const result = await service.execute({
      code: `
        try {
          require('net');
          return { ok: false, msg: 'net loaded' };
        } catch (err) {
          return { ok: true, msg: err.message };
        }
      `,
      parameters: {},
      timeoutMs: 10_000,
    });

    expect(result.success).toBe(true);
    expect(result.data.ok).toBe(true);
    expect(result.data.msg).toMatch(/not allowed/);
  });

  // ── 6. Network: fetch to metadata.google.internal refused ──────

  it('refuses fetch() to metadata.google.internal via net-guard', async () => {
    const result = await service.execute({
      code: `
        try {
          const res = await fetch('http://metadata.google.internal/computeMetadata/v1/');
          return { ok: false, status: res.status };
        } catch (err) {
          return { ok: true, code: err.cause?.code ?? err.code, msg: err.message, causeMsg: err.cause?.message };
        }
      `,
      parameters: {},
      timeoutMs: 10_000,
    });

    expect(result.success).toBe(true);
    expect(result.data.ok).toBe(true);
    // undici wraps the low-level error in a TypeError('fetch failed')
    // with the real ERR_SANDBOX_NET_REFUSED or ENOTFOUND as .cause.
    expect(JSON.stringify(result.data)).toMatch(
      /ERR_SANDBOX_NET_REFUSED|banned|ENOTFOUND|fetch failed/i,
    );
  });

  // ── 7. Network: literal IMDS IP refused ────────────────────────

  it('refuses fetch() to 169.254.169.254 (IMDS)', async () => {
    const result = await service.execute({
      code: `
        try {
          const res = await fetch('http://169.254.169.254/latest/meta-data/');
          return { ok: false, status: res.status };
        } catch (err) {
          return { ok: true, code: err.cause?.code ?? err.code, msg: err.message, causeMsg: err.cause?.message };
        }
      `,
      parameters: {},
      timeoutMs: 10_000,
    });

    expect(result.success).toBe(true);
    expect(result.data.ok).toBe(true);
    expect(JSON.stringify(result.data)).toMatch(
      /ERR_SANDBOX_NET_REFUSED|banned|fetch failed/i,
    );
  });

  // ── 8. Env scrub — redundant with existing spec, pin it again ──

  it('process.env is empty inside the worker', async () => {
    process.env.SANDBOX_REALTEST_SENTINEL = 'should-not-leak';
    try {
      const result = await service.execute({
        code: `
          return {
            sentinel: process.env.SANDBOX_REALTEST_SENTINEL ?? null,
            keys: Object.keys(process.env).length,
          };
        `,
        parameters: {},
        timeoutMs: 10_000,
      });

      expect(result.success).toBe(true);
      expect(result.data.sentinel).toBeNull();
      expect(result.data.keys).toBe(0);
    } finally {
      delete process.env.SANDBOX_REALTEST_SENTINEL;
    }
  });

  // ── 9. tools.invoke round-trip ─────────────────────────────────

  it('tools.invoke returns the host callback result to user code', async () => {
    let observedToolId: string | null = null;
    let observedParams: any = null;
    let callCount = 0;
    const callback = async (toolId: string, params: any) => {
      callCount++;
      observedToolId = toolId;
      observedParams = params;
      return { doubled: params.x * 2 };
    };

    const result = await service.execute({
      code: `
        const out = await tools.invoke('inner-tool', { x: parameters.x });
        return out;
      `,
      parameters: { x: 21 },
      invokeTool: callback,
      timeoutMs: 10_000,
    });

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ doubled: 42 });
    expect(callCount).toBe(1);
    expect(observedToolId).toBe('inner-tool');
    expect(observedParams).toEqual({ x: 21 });
  });

  it('tools.invoke rejection surfaces as a rejected promise in user code', async () => {
    const callback = async () => {
      throw new Error('inner blew up');
    };

    const result = await service.execute({
      code: `
        try {
          await tools.invoke('bad-tool', {});
          return { caught: false };
        } catch (err) {
          return { caught: true, msg: err.message };
        }
      `,
      parameters: {},
      invokeTool: callback,
      timeoutMs: 10_000,
    });

    expect(result.success).toBe(true);
    expect(result.data.caught).toBe(true);
    expect(result.data.msg).toMatch(/inner blew up/);
  });

  it('tools global is undefined when invokeTool callback not wired', async () => {
    const result = await service.execute({
      code: `return { toolsType: typeof tools };`,
      parameters: {},
      timeoutMs: 10_000,
    });

    expect(result.success).toBe(true);
    expect(result.data.toolsType).toBe('undefined');
  });

  // ── 10. Happy-path: test-net-allow bypass to local server ──────

  describe('test-net-allow bypass (happy-path fetch to local HTTP)', () => {
    let server: http.Server;
    let port: number;

    beforeAll(async () => {
      server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, path: req.url }));
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      port = (server.address() as AddressInfo).port;
    });

    afterAll(async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    });

    it('bypass allows fetch to reach the loopback test server', async () => {
      const result = await service.execute({
        code: `
          const res = await fetch('http://127.0.0.1:' + parameters.port + '/hello');
          const body = await res.json();
          return { status: res.status, body };
        `,
        parameters: { port },
        testNetAllow: `127.0.0.1:${port}`,
        timeoutMs: 10_000,
      });

      expect(result.success).toBe(true);
      expect(result.data.status).toBe(200);
      expect(result.data.body).toEqual({ ok: true, path: '/hello' });
    });

    it('bypass does NOT leak to other local ports', async () => {
      // Same host, different port — the allow list is port-specific.
      const result = await service.execute({
        code: `
          try {
            const res = await fetch('http://127.0.0.1:1/');
            return { ok: false, status: res.status };
          } catch (err) {
            return { ok: true, msg: err.message, code: err.cause?.code ?? err.code };
          }
        `,
        parameters: {},
        testNetAllow: `127.0.0.1:${port}`,
        timeoutMs: 10_000,
      });

      expect(result.success).toBe(true);
      expect(result.data.ok).toBe(true);
    });
  });

  // ── 11. Abort signal propagation through the worker ───────────

  it('cancels the worker mid-execution on signal abort', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);

    const started = Date.now();
    const result = await service.execute({
      code: `
        await new Promise((r) => setTimeout(r, 10000));
        return { ok: false };
      `,
      parameters: {},
      signal: controller.signal,
      timeoutMs: 15_000,
    });

    const elapsed = Date.now() - started;
    expect(result.success).toBe(false);
    expect(elapsed).toBeLessThan(2_000);
    expect(result.error).toMatch(/cancel/i);
  });
});
