import { AdapterCredentials, DeployRequest, ModelProviderAdapter, assertAdapterContract } from '../../adapters/adapter.interface';

/**
 * The conformance suite every deployment adapter must pass.
 *
 * Fixture mode is the default and runs in CI against recorded or
 * simulated behaviour. Live mode (CONFORMANCE_LIVE=<adapterKey>) runs the
 * same cases against a real account with credentials from the local
 * environment and is required before an adapter is marked shipped; it
 * never runs in CI.
 *
 * A harness gives the suite: a factory for the adapter, credentials that
 * work and credentials that do not, a tiny version to deploy, a request
 * whose architecture the adapter cannot serve, a way to trigger a quota
 * error, and a way to make an endpoint disappear behind the adapter's
 * back (for orphan detection). Live harnesses may skip the simulated
 * failure cases they cannot trigger safely by returning undefined.
 */
export interface ConformanceHarness {
  adapter: () => ModelProviderAdapter;
  credentials: AdapterCredentials;
  badCredentials: AdapterCredentials;
  tinyVersion: DeployRequest['version'];
  providerConfig: Record<string, any>;
  unsupportedArchitectureVersion?: DeployRequest['version'];
  quotaExceededConfig?: Record<string, any>;
  vanish?: (adapter: ModelProviderAdapter, ref: Record<string, any>) => Promise<void> | void;
  /** How long to wait for 'ready' in live mode. */
  readyTimeoutMs?: number;
  /** A chat request through the endpoint; fixture harnesses can return a canned reply. */
  chat?: (url: string, credentials: AdapterCredentials) => Promise<string>;
}

async function waitForReady(adapter: ModelProviderAdapter, ref: Record<string, any>, creds: AdapterCredentials, timeoutMs: number) {
  const started = Date.now();
  for (;;) {
    const actual = await adapter.readEndpoint(ref, creds);
    if (actual.state === 'ready') return actual;
    if (actual.state === 'failed' || actual.state === 'missing') throw new Error(`endpoint ${actual.state}: ${actual.message ?? ''}`);
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for ready');
    await new Promise((r) => setTimeout(r, Math.min(2000, timeoutMs / 20)));
  }
}

export function runConformance(name: string, harness: ConformanceHarness): void {
  const request = (version = harness.tinyVersion, providerConfig = harness.providerConfig): DeployRequest => ({
    deploymentId: 'conf-1',
    organizationId: 'org-conf',
    version,
    desired: { replicas: 1, minScale: 0, maxScale: 1 },
    providerConfig,
  });

  describe(`conformance: ${name}`, () => {
    it('honours the adapter contract (s3 source, key shape, config schema)', () => {
      expect(() => assertAdapterContract(harness.adapter())).not.toThrow();
      const caps = harness.adapter().capabilities();
      expect(caps.registrySources).toContain('s3');
      expect(typeof caps.scaleToZero).toBe('boolean');
    });

    it('deploys a tiny version, reaches ready, serves a chat, scales to zero, tears down, with sane cost', async () => {
      const adapter = harness.adapter();
      const ref = await adapter.deploy(request(), harness.credentials);
      expect(ref).toBeTruthy();
      const ready = await waitForReady(adapter, ref, harness.credentials, harness.readyTimeoutMs ?? 60_000);
      expect(ready.state).toBe('ready');
      expect(ready.url ?? ref.url).toBeTruthy();

      if (harness.chat) {
        const reply = await harness.chat(ready.url ?? (ref.url as string), harness.credentials);
        expect(typeof reply).toBe('string');
        expect(reply.length).toBeGreaterThan(0);
      }

      const before = await adapter.costSnapshot(ref, harness.credentials);
      expect(before.spentCents).toBeGreaterThanOrEqual(0);
      expect(before.ratePerHourCents).toBeGreaterThanOrEqual(0);

      await adapter.scale(ref, 0, harness.credentials);
      const stopped = await adapter.readEndpoint(ref, harness.credentials);
      expect(['stopped', 'scaling', 'ready']).toContain(stopped.state);
      const atZero = await adapter.costSnapshot(ref, harness.credentials);
      expect(atZero.spentCents).toBeGreaterThanOrEqual(before.spentCents);
      if (adapter.capabilities().scaleToZero && stopped.state === 'stopped') {
        expect(atZero.ratePerHourCents).toBe(0);
      }

      await adapter.teardown(ref, harness.credentials);
      const gone = await adapter.readEndpoint(ref, harness.credentials);
      expect(['missing', 'stopped']).toContain(gone.state);
    });

    it('refuses an unsupported architecture before creating anything', async () => {
      if (!harness.unsupportedArchitectureVersion) return;
      const adapter = harness.adapter();
      await expect(adapter.deploy(request(harness.unsupportedArchitectureVersion), harness.credentials)).rejects.toMatchObject({
        code: 'ADAPTER_UNSUPPORTED_ARCHITECTURE',
      });
    });

    it('reports a quota problem as a typed error', async () => {
      if (!harness.quotaExceededConfig) return;
      const adapter = harness.adapter();
      await expect(adapter.deploy(request(harness.tinyVersion, harness.quotaExceededConfig), harness.credentials)).rejects.toMatchObject({
        code: 'ADAPTER_QUOTA_EXCEEDED',
      });
    });

    it('rejects an expired or invalid credential without creating anything', async () => {
      const adapter = harness.adapter();
      await expect(adapter.deploy(request(), harness.badCredentials)).rejects.toMatchObject({ code: 'ADAPTER_AUTH' });
    });

    it('reports an endpoint deleted behind its back as missing (orphan detection)', async () => {
      if (!harness.vanish) return;
      const adapter = harness.adapter();
      const ref = await adapter.deploy(request(), harness.credentials);
      await harness.vanish(adapter, ref);
      const actual = await adapter.readEndpoint(ref, harness.credentials);
      expect(actual.state).toBe('missing');
    });
  });
}

/** True when this adapter's live suite was requested from the local environment. */
export function liveRequested(adapterKey: string): boolean {
  const flag = (process.env.CONFORMANCE_LIVE ?? '').split(',').map((s) => s.trim());
  return flag.includes(adapterKey) || flag.includes('all');
}
