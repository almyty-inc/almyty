import { Exec, ModalAdapter } from '../../adapters/modal.adapter';
import { liveRequested, runConformance } from './conformance.suite';

/**
 * Fixture mode: a stand-in for the `modal endpoint` CLI, faithful to the
 * documented subcommands and flags (create, list --json, stop). Live mode
 * (CONFORMANCE_LIVE=modal with MODAL_TOKEN_ID and MODAL_TOKEN_SECRET in
 * the local environment) runs the same cases against a real workspace;
 * never in CI.
 */
function fixtureExec() {
  const endpoints = new Map<string, { state: string; url: string; model: string }>();
  const calls: Array<{ args: string[]; env: Record<string, string> }> = [];
  const flag = (args: string[], name: string) => (args.indexOf(name) >= 0 ? args[args.indexOf(name) + 1] : undefined);
  const exec: Exec = async (_cmd, args, options) => {
    calls.push({ args, env: options.env });
    if (options.env.MODAL_TOKEN_ID !== 'ak-valid' || options.env.MODAL_TOKEN_SECRET !== 'as-valid') {
      throw Object.assign(new Error('exit 1'), { stderr: 'Error: Token is invalid or unauthorized. Run `modal token new`.' });
    }
    const [group, verb] = args;
    if (group !== 'endpoint') throw new Error(`unexpected modal invocation: ${args.join(' ')}`);
    if (verb === 'create') {
      const name = flag(args, '--name')!;
      const model = flag(args, '--model')!;
      if (model === 'quota/exceeded') throw Object.assign(new Error('exit 1'), { stderr: 'Error: insufficient credits to start this endpoint' });
      if (model.includes('unsupported')) throw Object.assign(new Error('exit 1'), { stderr: 'Error: no recipe matches this model architecture' });
      const url = `https://acme--${name}.modal.run`;
      endpoints.set(name, { state: 'ready', url, model });
      return { stdout: `Deployed endpoint ${name}\nEndpoint URL: ${url}\n`, stderr: '' };
    }
    if (verb === 'list') {
      return { stdout: JSON.stringify([...endpoints.entries()].map(([name, e]) => ({ name, state: e.state, url: e.url, model: e.model }))), stderr: '' };
    }
    if (verb === 'stop') {
      if (!endpoints.delete(args[2])) throw Object.assign(new Error('exit 1'), { stderr: 'Error: Endpoint not found' });
      return { stdout: '', stderr: '' };
    }
    throw new Error(`unexpected modal invocation: ${args.join(' ')}`);
  };
  return { endpoints, calls, exec };
}

const live = liveRequested('modal');
const fixture = fixtureExec();
const adapter = () => (live ? new ModalAdapter() : new ModalAdapter(fixture.exec, 'modal'));
const tiny = { id: 'v1', name: 'qwen3-0.6b', registryUri: 'hf://Qwen/Qwen3-0.6B@main', base: 'qwen3-0.6b', quantizations: [], manifestSha: 'sha' };

runConformance(live ? 'modal (LIVE)' : 'modal (fixture)', {
  adapter,
  credentials: live ? { tokenId: process.env.MODAL_TOKEN_ID, tokenSecret: process.env.MODAL_TOKEN_SECRET } : { tokenId: 'ak-valid', tokenSecret: 'as-valid' },
  badCredentials: { tokenId: 'ak-valid', tokenSecret: 'wrong' },
  tinyVersion: tiny,
  providerConfig: { environment: live ? process.env.MODAL_ENVIRONMENT : undefined, hourlyRateCents: 59 },
  unsupportedArchitectureVersion: live ? undefined : { ...tiny, id: 'v2', registryUri: 'hf://acme/unsupported-arch' },
  quotaExceededConfig: live ? undefined : { model: 'quota/exceeded' },
  vanish: live ? undefined : (_a, ref) => { fixture.endpoints.delete(ref.endpointName); },
  chat: live ? undefined : async () => 'fixture reply',
  readyTimeoutMs: live ? 30 * 60_000 : 5_000,
});

describe('modal request shape', () => {
  const request = {
    deploymentId: 'abc-123',
    organizationId: 'org',
    version: tiny,
    desired: { replicas: 2 },
    providerConfig: { environment: 'prod', routingRegion: 'us-east', computeRegions: ['us-east', 'us-west'], hourlyRateCents: 59 },
  };
  const creds = { tokenId: 'ak-valid', tokenSecret: 'as-valid' };

  it('creates a managed endpoint that names the Hugging Face repository, with the token only in the child environment', async () => {
    const f = fixtureExec();
    const a = new ModalAdapter(f.exec);
    const ref = await a.deploy(request, creds);
    const create = f.calls.find((c) => c.args[1] === 'create')!;
    expect(create.args).toEqual([
      'endpoint',
      'create',
      '--name',
      'almyty-abc123',
      '--model',
      'Qwen/Qwen3-0.6B',
      '--env',
      'prod',
      '--routing-region',
      'us-east',
      '--compute-region',
      'us-east',
      '--compute-region',
      'us-west',
    ]);
    expect(create.env).toMatchObject({ MODAL_TOKEN_ID: 'ak-valid', MODAL_TOKEN_SECRET: 'as-valid' });
    // No generated app, no registry credentials, no weight copying.
    expect(JSON.stringify(f.calls)).not.toContain('ALMYTY_REGISTRY');
    expect(ref).toMatchObject({ endpointName: 'almyty-abc123', environment: 'prod', model: 'Qwen/Qwen3-0.6B', url: 'https://acme--almyty-abc123.modal.run/v1' });
  });

  it('serves custom weights from a repository or a volume the operator already has', async () => {
    const f = fixtureExec();
    const a = new ModalAdapter(f.exec);
    await a.deploy(
      { ...request, providerConfig: { customHfRepo: 'acme/qwen3-ft', customHfRevision: 'v2', passHfTokenFlag: true, customVolumeName: 'qwen-ft', customVolumePath: '/models/qwen' } },
      { ...creds, hfToken: 'hf_x' },
    );
    const create = f.calls.find((c) => c.args[1] === 'create')!;
    expect(create.args).toEqual(expect.arrayContaining(['--custom-hf-repo', 'acme/qwen3-ft', '--custom-hf-revision', 'v2', '--custom-volume-name', 'qwen-ft', '--custom-volume-path', '/models/qwen']));
    expect(create.env).toMatchObject({ HF_TOKEN: 'hf_x' });
  });

  it('keeps the Hugging Face token off the command line unless the operator opts in', async () => {
    const f = fixtureExec();
    const a = new ModalAdapter(f.exec);
    await a.deploy({ ...request, providerConfig: { customHfRepo: 'acme/qwen3-ft' } }, { ...creds, hfToken: 'hf_x' });
    const create = f.calls.find((c) => c.args[1] === 'create')!;
    expect(create.args).not.toContain('--custom-hf-token');
    expect(create.args.join(' ')).not.toContain('hf_x');
    expect(create.env.HF_TOKEN).toBe('hf_x');
  });

  it('refuses a registry source Modal cannot read, naming what it accepts', async () => {
    const f = fixtureExec();
    const a = new ModalAdapter(f.exec);
    await expect(
      a.deploy({ ...request, version: { ...tiny, registryUri: 's3://registry/models/q@etag' }, providerConfig: {} }, creds),
    ).rejects.toMatchObject({ code: 'ADAPTER_UNSUPPORTED_SOURCE', message: expect.stringContaining('hf://org/repo') });
    expect(f.calls).toHaveLength(0);
  });

  it('reads the endpoint out of the listing, reports the ceiling, and stops it on teardown', async () => {
    const f = fixtureExec();
    const a = new ModalAdapter(f.exec);
    const ref = await a.deploy(request, creds);
    const ready = await a.readEndpoint(ref, creds);
    expect(ready.state).toBe('ready');
    expect(ready.url).toBe('https://acme--almyty-abc123.modal.run/v1');
    expect(ready.openAiBase).toBe(ready.url);
    expect(ready.replicas).toBe(2);
    expect((await a.costSnapshot(ref, creds)).ratePerHourCents).toBe(118);

    await a.scale(ref, 0, creds);
    const idle = await a.readEndpoint(ref, creds);
    expect(idle.state).toBe('stopped');
    expect((await a.costSnapshot(ref, creds)).ratePerHourCents).toBe(0);

    await a.teardown(ref, creds);
    expect(f.calls.some((c) => c.args[0] === 'endpoint' && c.args[1] === 'stop' && c.args[2] === 'almyty-abc123' && c.args.includes('--env'))).toBe(true);
    expect((await a.readEndpoint(ref, creds)).state).toBe('missing');
  });

  it('falls back to the listing when the CLI does not print a URL', async () => {
    const f = fixtureExec();
    const quiet: Exec = async (cmd, args, options) => {
      const result = await f.exec(cmd, args, options);
      return args[1] === 'create' ? { stdout: 'Deployed.', stderr: '' } : result;
    };
    const a = new ModalAdapter(quiet);
    const ref = await a.deploy({ ...request, providerConfig: {} }, creds);
    expect(ref.url).toBe('https://acme--almyty-abc123.modal.run/v1');
  });

  it('maps a rejected architecture and a credit refusal from the CLI to their own error codes', async () => {
    const f = fixtureExec();
    const a = new ModalAdapter(f.exec);
    await expect(a.deploy({ ...request, version: { ...tiny, registryUri: 'hf://acme/unsupported-arch' } }, creds)).rejects.toMatchObject({
      code: 'ADAPTER_UNSUPPORTED_ARCHITECTURE',
    });
    await expect(a.deploy({ ...request, providerConfig: { model: 'quota/exceeded' } }, creds)).rejects.toMatchObject({ code: 'ADAPTER_QUOTA_EXCEEDED' });
  });
});
