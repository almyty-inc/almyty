import { execFile } from 'child_process';

import {
  ActualState,
  AdapterCapabilities,
  AdapterCredentials,
  CostSnapshot,
  DeployRequest,
  EndpointRef,
  ModelProviderAdapter,
} from './adapter.interface';

/**
 * Modal Endpoints. Verified shapes are in docs/design/adapters/modal.md.
 *
 * Modal Endpoints is Modal's managed inference product: Modal builds, runs
 * and autoscales the serving stack, and we name a model. A Dedicated
 * Endpoint takes a Hugging Face repo id for the base architecture
 * (`--model`) and, for a fine-tune, weights from a private Hugging Face
 * repository (`--custom-hf-repo`) or a Modal Volume the operator already
 * populated (`--custom-volume-name`). Modal pulls them; nothing passes
 * through almyty, and almyty never writes to a Volume.
 *
 * Delta from the spec: Modal publishes no REST control plane for
 * Endpoints, so this adapter drives the `modal` CLI in a subprocess with
 * the workspace token in the process environment. `modal endpoint create`
 * deploys, `modal endpoint list --json` observes, `modal endpoint stop`
 * removes. The `--json` key names are not published, so rows are read
 * through the plausible variants rather than one guessed name.
 *
 * The CLI exposes no replica control: a Dedicated Endpoint autoscales,
 * including to zero, on Modal's side. `scale` therefore records intent on
 * the handle, and a ceiling of zero reads as stopped at no cost, which is
 * what an idle Modal endpoint is.
 */
export type Exec = (cmd: string, args: string[], options: { env: Record<string, string>; timeoutMs: number }) => Promise<{ stdout: string; stderr: string }>;

const defaultExec: Exec = (cmd, args, options) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { env: { ...process.env, ...options.env }, timeout: options.timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(Object.assign(err, { stdout: String(stdout), stderr: String(stderr) }));
      resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });

const NAME_KEYS = ['name', 'Name', 'endpoint', 'Endpoint', 'identifier', 'Identifier'];
const STATE_KEYS = ['state', 'State', 'status', 'Status'];
const URL_KEYS = ['url', 'Url', 'URL', 'endpoint_url', 'endpointUrl', 'Endpoint URL'];

const STATE_MAP: Record<string, ActualState['state']> = {
  ready: 'ready',
  running: 'ready',
  deployed: 'ready',
  active: 'ready',
  creating: 'deploying',
  starting: 'deploying',
  pending: 'deploying',
  provisioning: 'deploying',
  deploying: 'deploying',
  updating: 'scaling',
  stopping: 'stopped',
  stopped: 'stopped',
  disabled: 'stopped',
  failed: 'failed',
  error: 'failed',
};

export class ModalAdapter implements ModelProviderAdapter {
  readonly key = 'modal';
  readonly displayName = 'Modal Endpoints';

  constructor(private readonly exec: Exec = defaultExec, private readonly modalBin = process.env.MODAL_BIN ?? 'modal') {}

  capabilities(): AdapterCapabilities {
    return {
      architectures: 'any',
      lora: 'merged',
      serverless: true,
      dedicated: true,
      scaleToZero: true,
      regions: [],
      // `--model` is a Hugging Face repo id. A Modal Volume is the other
      // documented source, but filling one is `modal volume put` from the
      // operator's own machine: almyty references a Volume, never writes
      // to it, and never streams weights of its own.
      registrySources: ['hub'],
    };
  }

  configSchema(): Record<string, any> {
    return {
      type: 'object',
      properties: {
        tokenId: { type: 'string', title: 'Modal token id', 'x-secret': true },
        tokenSecret: { type: 'string', title: 'Modal token secret', 'x-secret': true },
        environment: { type: 'string', title: 'Environment', description: 'Modal environment; leave empty for the default' },
        model: { type: 'string', title: 'Base model', description: 'Overrides the version: a Hugging Face repo id for the base model architecture' },
        customHfRepo: { type: 'string', title: 'Custom weights repository', description: 'A Hugging Face repo holding fine-tuned weights, served against the base model' },
        customHfRevision: { type: 'string', title: 'Custom weights revision' },
        passHfTokenFlag: { type: 'boolean', title: 'Pass the Hugging Face token as a flag', description: 'Off by default: the token goes in the child process environment so it stays out of the process list', default: false },
        customVolumeName: { type: 'string', title: 'Modal Volume', description: 'A Volume you already populated with weights; almyty never writes to it' },
        customVolumePath: { type: 'string', title: 'Path within the Volume' },
        routingRegion: { type: 'string', title: 'Routing region', description: 'Where inference requests are routed; Modal defaults to us-west' },
        computeRegions: { type: 'array', items: { type: 'string' }, title: 'Compute regions' },
        colocateCompute: { type: 'boolean', title: 'Colocate compute with routing', default: false },
        unauthenticated: { type: 'boolean', title: 'Allow unauthenticated requests', description: 'Off by default; a dedicated endpoint otherwise needs a Modal proxy token', default: false },
        maxContainers: { type: 'integer', minimum: 0, default: 1 },
        hourlyRateCents: { type: 'integer', title: 'Price per hour (cents)', description: 'Modal has a billing API but it is plan-gated and not per endpoint; used to estimate spend' },
      },
      required: ['tokenId', 'tokenSecret'],
    };
  }

  private env(credentials: AdapterCredentials): Record<string, string> {
    if (!credentials.tokenId || !credentials.tokenSecret) {
      throw Object.assign(new Error('missing Modal token'), { code: 'ADAPTER_AUTH', status: 401 });
    }
    return {
      MODAL_TOKEN_ID: credentials.tokenId,
      MODAL_TOKEN_SECRET: credentials.tokenSecret,
      ...(credentials.hfToken ? { HF_TOKEN: credentials.hfToken } : {}),
    };
  }

  private classify(err: any, fallback: string): never {
    if (typeof err?.code === 'string' && err.code.startsWith('ADAPTER_')) throw err;
    const text = `${err?.stderr ?? ''} ${err?.message ?? ''}`;
    if (/auth|token|unauthori[sz]ed|forbidden/i.test(text)) throw Object.assign(new Error(`credential rejected: ${text.trim().slice(0, 200)}`), { code: 'ADAPTER_AUTH', status: 401 });
    if (/quota|limit|insufficient|credits/i.test(text)) throw Object.assign(new Error(`quota: ${text.trim().slice(0, 200)}`), { code: 'ADAPTER_QUOTA_EXCEEDED', status: 429 });
    if (/unsupported|no recipe|not compatible|architecture/i.test(text)) {
      throw Object.assign(new Error(`unsupported model: ${text.trim().slice(0, 200)}`), { code: 'ADAPTER_UNSUPPORTED_ARCHITECTURE' });
    }
    throw Object.assign(new Error(text.trim().slice(0, 500) || fallback), { code: 'ADAPTER_ERROR' });
  }

  static endpointName(deploymentId: string): string {
    return `almyty-${deploymentId.replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 20)}`;
  }

  /** The Hugging Face repo id Modal is asked to serve. */
  static baseModel(request: DeployRequest): string {
    const cfg = request.providerConfig ?? {};
    if (cfg.model) return String(cfg.model);
    const uri = request.version.registryUri;
    if (uri.startsWith('hf://')) return uri.slice('hf://'.length).split('@')[0];
    throw Object.assign(
      new Error(
        'Modal Endpoints serve a Hugging Face repository, optionally with custom weights from a private repo or a Modal Volume; ' +
          'point the version at hf://org/repo, or set providerConfig.model',
      ),
      { code: 'ADAPTER_UNSUPPORTED_SOURCE' },
    );
  }

  /** Arguments for `modal endpoint create`, in the order the CLI documents them. */
  static createArgs(request: DeployRequest, name: string, credentials: AdapterCredentials): string[] {
    const cfg = request.providerConfig ?? {};
    const args = ['endpoint', 'create', '--name', name, '--model', ModalAdapter.baseModel(request)];
    if (cfg.environment) args.push('--env', String(cfg.environment));
    if (cfg.routingRegion) args.push('--routing-region', String(cfg.routingRegion));
    for (const region of cfg.computeRegions ?? []) args.push('--compute-region', String(region));
    if (cfg.colocateCompute) args.push('--colocate-compute');
    if (cfg.unauthenticated) args.push('--unauthenticated');
    if (cfg.customHfRepo) {
      args.push('--custom-hf-repo', String(cfg.customHfRepo));
      if (cfg.customHfRevision) args.push('--custom-hf-revision', String(cfg.customHfRevision));
      // The token is otherwise handed over as HF_TOKEN in the child
      // environment, where it stays out of the process list.
      if (cfg.passHfTokenFlag && credentials.hfToken) args.push('--custom-hf-token', credentials.hfToken);
    }
    if (cfg.customVolumeName) {
      args.push('--custom-volume-name', String(cfg.customVolumeName));
      if (cfg.customVolumePath) args.push('--custom-volume-path', String(cfg.customVolumePath));
    }
    return args;
  }

  private static pick(row: any, keys: string[]): string | undefined {
    for (const key of keys) {
      const value = row?.[key];
      if (value !== undefined && value !== null && value !== '') return String(value);
    }
    return undefined;
  }

  private static rows(stdout: string): any[] {
    let parsed: any;
    try {
      parsed = JSON.parse(stdout || '[]');
    } catch {
      return [];
    }
    if (Array.isArray(parsed)) return parsed;
    for (const key of ['endpoints', 'data', 'items', 'rows']) if (Array.isArray(parsed?.[key])) return parsed[key];
    return [];
  }

  static urlFromOutput(stdout: string, stderr = ''): string | undefined {
    return `${stdout}\n${stderr}`.match(/https:\/\/[A-Za-z0-9._~:/?#@!$&'*+,;=%-]*modal\.run[A-Za-z0-9._~:/?#@!$&'*+,;=%-]*/)?.[0]?.replace(/[.,)\]]+$/, '');
  }

  private async list(ref: { environment?: string | null; [key: string]: any }, credentials: AdapterCredentials): Promise<any[]> {
    const args = ['endpoint', 'list', '--json', ...(ref.environment ? ['--env', String(ref.environment)] : [])];
    try {
      const { stdout } = await this.exec(this.modalBin, args, { env: this.env(credentials), timeoutMs: 60_000 });
      return ModalAdapter.rows(stdout);
    } catch (err) {
      this.classify(err, 'modal endpoint list failed');
    }
  }

  async deploy(request: DeployRequest, credentials: AdapterCredentials): Promise<EndpointRef> {
    const cfg = request.providerConfig ?? {};
    const env = this.env(credentials);
    const name = ModalAdapter.endpointName(request.deploymentId);
    const args = ModalAdapter.createArgs(request, name, credentials);
    let base: string | undefined;
    try {
      const { stdout, stderr } = await this.exec(this.modalBin, args, { env, timeoutMs: 30 * 60_000 });
      base = ModalAdapter.urlFromOutput(stdout, stderr);
    } catch (err) {
      this.classify(err, 'modal endpoint create failed');
    }
    if (!base) {
      // The CLI usually prints the URL; when it does not, the listing has it.
      const row = (await this.list({ environment: cfg.environment ?? null }, credentials)).find((r) => ModalAdapter.pick(r, NAME_KEYS) === name);
      base = ModalAdapter.pick(row, URL_KEYS);
    }
    return {
      endpointName: name,
      environment: cfg.environment ?? null,
      model: ModalAdapter.baseModel(request),
      endpointUrl: base,
      url: base ? `${base.replace(/\/+$/, '')}/v1` : undefined,
      maxContainers: request.desired.replicas ?? cfg.maxContainers ?? 1,
      createdAt: new Date().toISOString(),
      hourlyRateCents: cfg.hourlyRateCents ?? 0,
    };
  }

  async readEndpoint(ref: EndpointRef, credentials: AdapterCredentials): Promise<ActualState> {
    const rows = await this.list(ref, credentials);
    const row = rows.find((r) => ModalAdapter.pick(r, NAME_KEYS) === ref.endpointName);
    if (!row) return { state: 'missing', message: 'endpoint not found in workspace' };
    const raw = (ModalAdapter.pick(row, STATE_KEYS) ?? '').toLowerCase();
    const base = ModalAdapter.pick(row, URL_KEYS) ?? ref.endpointUrl;
    const url = base ? `${String(base).replace(/\/+$/, '')}/v1` : ref.url;
    const ceiling = Number(ref.maxContainers ?? 1);
    let state = STATE_MAP[raw] ?? 'deploying';
    let message: string | undefined;
    if (state === 'ready' && ceiling === 0) {
      // Modal keeps the endpoint but sleeps it; at ceiling zero we treat
      // it as stopped, and Modal bills nothing while it is idle.
      state = 'stopped';
      message = 'ceiling 0, endpoint idle at no cost';
    }
    return {
      state,
      url,
      openAiBase: url,
      replicas: state === 'ready' ? ceiling : 0,
      message,
      details: { rawState: raw || 'unknown', model: ref.model },
    };
  }

  /**
   * Modal autoscales a dedicated endpoint itself, including to zero, and
   * the CLI exposes no replica control, so this records the ceiling the
   * reconcile loop asked for rather than pretending to set one.
   */
  async scale(ref: EndpointRef, replicas: number, _credentials: AdapterCredentials): Promise<void> {
    ref.maxContainers = replicas;
  }

  async teardown(ref: EndpointRef, credentials: AdapterCredentials): Promise<void> {
    const args = ['endpoint', 'stop', ref.endpointName, '-y', ...(ref.environment ? ['--env', String(ref.environment)] : [])];
    try {
      await this.exec(this.modalBin, args, { env: this.env(credentials), timeoutMs: 120_000 });
    } catch (err: any) {
      if (/not found|no such endpoint/i.test(`${err?.stderr ?? ''} ${err?.message ?? ''}`)) return;
      this.classify(err, 'modal endpoint stop failed');
    }
  }

  /**
   * Modal's billing API is plan-gated and reports per app rather than per
   * endpoint, so this is an estimate from the configured rate and the time
   * the endpoint has existed.
   */
  async costSnapshot(ref: EndpointRef, credentials: AdapterCredentials): Promise<CostSnapshot> {
    const actual = await this.readEndpoint(ref, credentials);
    const rate = Number(ref.hourlyRateCents ?? 0);
    const hours = ref.createdAt ? Math.max(0, (Date.now() - new Date(ref.createdAt).getTime()) / 3_600_000) : 0;
    return {
      spentCents: Math.round(rate * hours),
      ratePerHourCents: actual.state === 'ready' ? rate * Number(ref.maxContainers ?? 1) : 0,
      observedAt: new Date(),
    };
  }
}
