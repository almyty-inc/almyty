import { Exec, ModalAdapter } from '../../adapters/modal.adapter';
import { liveRequested, runConformance } from './conformance.suite';

/**
 * Fixture mode: a stand-in for the modal CLI. Live mode
 * (CONFORMANCE_LIVE=modal with MODAL_TOKEN_ID, MODAL_TOKEN_SECRET,
 * MODAL_WORKSPACE and a registry in the local environment) runs the same
 * cases against a real workspace; never in CI.
 */
function fixtureExec() {
  const apps = new Map<string, { state: string }>();
  const calls: Array<{ args: string[]; env: Record<string, string> }> = [];
  const exec: Exec = async (_cmd, args, options) => {
    calls.push({ args, env: options.env });
    if (options.env.MODAL_TOKEN_ID !== 'ak-valid' || options.env.MODAL_TOKEN_SECRET !== 'as-valid') {
      throw Object.assign(new Error('exit 1'), { stderr: 'Error: Token is invalid or unauthorized. Run `modal token new`.' });
    }
    const [verb, sub] = args;
    if (verb === 'deploy') {
      const name = args[args.indexOf('--name') + 1];
      if (options.env.ALMYTY_SIMULATE_QUOTA === '1') throw Object.assign(new Error('exit 1'), { stderr: 'Error: insufficient credits for GPU quota' });
      apps.set(name, { state: 'deployed' });
      return { stdout: `Created web function serve => https://ws--${name}-serve.modal.run`, stderr: '' };
    }
    if (verb === 'app' && sub === 'list') {
      return { stdout: JSON.stringify([...apps.entries()].map(([name, a]) => ({ 'App ID': 'ap-1', Name: name, State: a.state }))), stderr: '' };
    }
    if (verb === 'app' && sub === 'stop') {
      const name = args[2];
      if (!apps.delete(name)) throw Object.assign(new Error('exit 1'), { stderr: 'Error: App not found' });
      return { stdout: '', stderr: '' };
    }
    throw new Error(`unexpected modal invocation: ${args.join(' ')}`);
  };
  return { apps, calls, exec };
}

const live = liveRequested('modal');
const fixture = fixtureExec();
const adapter = () => (live ? new ModalAdapter() : new ModalAdapter(fixture.exec, 'modal'));
const tiny = { id: 'v1', name: 'qwen3-0.6b', registryUri: 's3://registry/models/qwen3-0.6b@etag1', base: 'qwen3-0.6b', quantizations: [], manifestSha: 'sha' };

runConformance(live ? 'modal (LIVE)' : 'modal (fixture)', {
  adapter,
  credentials: live ? { tokenId: process.env.MODAL_TOKEN_ID, tokenSecret: process.env.MODAL_TOKEN_SECRET } : { tokenId: 'ak-valid', tokenSecret: 'as-valid' },
  badCredentials: { tokenId: 'ak-valid', tokenSecret: 'wrong' },
  tinyVersion: tiny,
  providerConfig: { workspace: live ? process.env.MODAL_WORKSPACE : 'ws', gpu: 'T4', hourlyRateCents: 59 },
  vanish: live ? undefined : (_a, ref) => { fixture.apps.delete(ref.appName); },
  chat: live ? undefined : async () => 'fixture reply',
  readyTimeoutMs: live ? 20 * 60_000 : 5_000,
});

describe('modal request shape', () => {
  it('deploys a generated vLLM app under a deterministic name and URL with the registry keys only in the process environment', async () => {
    const f = fixtureExec();
    const a = new ModalAdapter(f.exec);
    const ref = await a.deploy(
      { deploymentId: 'abc-123', organizationId: 'org', version: tiny, desired: { replicas: 2, hardware: 'L4' }, providerConfig: { workspace: 'acme', environment: 'prod', registryEndpoint: 'https://minio.local' } },
      { tokenId: 'ak-valid', tokenSecret: 'as-valid', registryAccessKeyId: 'AK', registrySecretAccessKey: 'SK' },
    );
    expect(ref.appName).toBe('almyty-abc123');
    expect(ref.url).toBe('https://acme-prod--almyty-abc123-serve.modal.run');
    const deploy = f.calls.find((c) => c.args[0] === 'deploy')!;
    expect(deploy.args).toEqual(expect.arrayContaining(['--name', 'almyty-abc123', '--env', 'prod']));
    expect(deploy.env).toMatchObject({ MODAL_TOKEN_ID: 'ak-valid', ALMYTY_REGISTRY_ACCESS_KEY_ID: 'AK', ALMYTY_REGISTRY_SECRET_ACCESS_KEY: 'SK' });
    const source = ModalAdapter.appSource({ deploymentId: 'abc-123', organizationId: 'org', version: tiny, desired: { replicas: 2, hardware: 'L4' }, providerConfig: { workspace: 'acme', registryEndpoint: 'https://minio.local' } }, 'almyty-abc123');
    expect(source).toContain('gpu="L4"');
    expect(source).toContain('max_containers=2');
    expect(source).toContain('s3://registry/models/qwen3-0.6b');
    expect(source).not.toContain('SK');
  });

  it('reports a quota problem from the CLI as a typed error', async () => {
    const f = fixtureExec();
    const a = new ModalAdapter(async (c, args, o) => f.exec(c, args, { ...o, env: { ...o.env, ALMYTY_SIMULATE_QUOTA: '1' } }));
    await expect(a.deploy({ deploymentId: 'q', organizationId: 'o', version: tiny, desired: {}, providerConfig: { workspace: 'ws' } }, { tokenId: 'ak-valid', tokenSecret: 'as-valid' })).rejects.toMatchObject({ code: 'ADAPTER_QUOTA_EXCEEDED' });
  });
});
