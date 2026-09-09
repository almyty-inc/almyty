import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
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
 * Modal: the raw-container path and the conformance reference.
 *
 * Delta from the spec, recorded in docs/design/models-layer.md: Modal has
 * no HTTP API for deploying or stopping apps. This adapter drives the
 * `modal` CLI in a subprocess with a generated app file that serves the
 * registry version through vLLM, the workspace token in the process
 * environment, `modal app list --json` to observe, and `modal app stop`
 * to tear down. Modal is serverless and scales to zero on its own;
 * "replicas" here is the container concurrency ceiling. The API container
 * must ship the `modal` package.
 */
export type Exec = (cmd: string, args: string[], options: { env: Record<string, string>; timeoutMs: number }) => Promise<{ stdout: string; stderr: string }>;

const defaultExec: Exec = (cmd, args, options) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { env: { ...process.env, ...options.env }, timeout: options.timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(Object.assign(err, { stdout: String(stdout), stderr: String(stderr) }));
      resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });

export class ModalAdapter implements ModelProviderAdapter {
  readonly key = 'modal';
  readonly displayName = 'Modal';

  constructor(private readonly exec: Exec = defaultExec, private readonly modalBin = process.env.MODAL_BIN ?? 'modal') {}

  capabilities(): AdapterCapabilities {
    return { architectures: 'any', lora: 'merged', serverless: true, dedicated: false, scaleToZero: true, regions: [], registrySources: ['s3'] };
  }

  configSchema(): Record<string, any> {
    return {
      type: 'object',
      properties: {
        tokenId: { type: 'string', title: 'Modal token id', 'x-secret': true },
        tokenSecret: { type: 'string', title: 'Modal token secret', 'x-secret': true },
        workspace: { type: 'string', title: 'Workspace', description: 'Your Modal workspace slug; forms the endpoint URL' },
        environment: { type: 'string', title: 'Environment', description: 'Modal environment; leave empty for the default' },
        gpu: { type: 'string', title: 'GPU', enum: ['T4', 'L4', 'A10G', 'L40S', 'A100-40GB', 'A100-80GB', 'H100', 'H200', 'B200'], default: 'A10G' },
        image: { type: 'string', title: 'vLLM image', default: 'vllm/vllm-openai:latest' },
        maxContainers: { type: 'integer', minimum: 1, default: 1 },
        scaledownWindowSeconds: { type: 'integer', minimum: 30, default: 300 },
        hourlyRateCents: { type: 'integer', title: 'GPU price per hour (cents)', description: 'Modal publishes no billing API; used to estimate spend' },
        registryAccessKeyId: { type: 'string', title: 'Registry access key', 'x-secret': true },
        registrySecretAccessKey: { type: 'string', title: 'Registry secret key', 'x-secret': true },
        registryEndpoint: { type: 'string', title: 'Registry endpoint' },
      },
      required: ['tokenId', 'tokenSecret', 'workspace'],
    };
  }

  private env(credentials: AdapterCredentials): Record<string, string> {
    if (!credentials.tokenId || !credentials.tokenSecret) {
      throw Object.assign(new Error('missing Modal token'), { code: 'ADAPTER_AUTH', status: 401 });
    }
    return { MODAL_TOKEN_ID: credentials.tokenId, MODAL_TOKEN_SECRET: credentials.tokenSecret };
  }

  private classify(err: any, fallback: string): never {
    const text = `${err?.stderr ?? ''} ${err?.message ?? ''}`;
    if (/auth|token|unauthori[sz]ed|forbidden/i.test(text)) throw Object.assign(new Error(`credential rejected: ${text.trim().slice(0, 200)}`), { code: 'ADAPTER_AUTH', status: 401 });
    if (/quota|limit|insufficient|credits/i.test(text)) throw Object.assign(new Error(`quota: ${text.trim().slice(0, 200)}`), { code: 'ADAPTER_QUOTA_EXCEEDED', status: 429 });
    throw Object.assign(new Error(text.trim().slice(0, 500) || fallback), { code: 'ADAPTER_ERROR' });
  }

  static appName(deploymentId: string): string {
    return `almyty-${deploymentId.replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 20)}`;
  }

  static endpointUrl(workspace: string, environment: string | undefined, appName: string): string {
    const source = environment ? `${workspace}-${environment}` : workspace;
    return `https://${source}--${appName}-serve.modal.run`;
  }

  /** The Python app Modal runs: vLLM serving the registry version, weights pulled from S3 at cold start. */
  static appSource(request: DeployRequest, appName: string): string {
    const cfg = request.providerConfig;
    const gpu = request.desired.hardware ?? cfg.gpu ?? 'A10G';
    const image = cfg.image ?? 'vllm/vllm-openai:latest';
    const maxContainers = request.desired.replicas ?? cfg.maxContainers ?? 1;
    const scaledown = cfg.scaledownWindowSeconds ?? 300;
    const uri = request.version.registryUri.replace(/@[^@]+$/, '');
    return [
      'import modal, os, subprocess',
      `app = modal.App(${JSON.stringify(appName)})`,
      `image = modal.Image.from_registry(${JSON.stringify(image)}).pip_install("boto3")`,
      'registry = modal.Secret.from_dict({',
      '    "AWS_ACCESS_KEY_ID": os.environ.get("ALMYTY_REGISTRY_ACCESS_KEY_ID", ""),',
      '    "AWS_SECRET_ACCESS_KEY": os.environ.get("ALMYTY_REGISTRY_SECRET_ACCESS_KEY", ""),',
      `    "AWS_ENDPOINT_URL": ${JSON.stringify(cfg.registryEndpoint ?? '')},`,
      '})',
      `@app.function(image=image, gpu=${JSON.stringify(gpu)}, max_containers=${Number(maxContainers)}, scaledown_window=${Number(scaledown)}, secrets=[registry])`,
      '@modal.web_server(port=8000, startup_timeout=900)',
      'def serve():',
      '    import boto3',
      `    uri = ${JSON.stringify(uri)}`,
      '    bucket, _, prefix = uri[len("s3://"):].partition("/")',
      '    s3 = boto3.client("s3", endpoint_url=os.environ.get("AWS_ENDPOINT_URL") or None)',
      '    os.makedirs("/model", exist_ok=True)',
      '    for page in s3.get_paginator("list_objects_v2").paginate(Bucket=bucket, Prefix=prefix):',
      '        for obj in page.get("Contents", []):',
      '            rel = obj["Key"][len(prefix):].lstrip("/")',
      '            if rel:',
      '                os.makedirs(os.path.dirname("/model/" + rel) or "/model", exist_ok=True)',
      '                s3.download_file(bucket, obj["Key"], "/model/" + rel)',
      '    subprocess.Popen(["python", "-m", "vllm.entrypoints.openai.api_server", "--model", "/model", "--port", "8000", "--served-model-name", ' + JSON.stringify(request.version.name) + '])',
      '',
    ].join('\n');
  }

  async deploy(request: DeployRequest, credentials: AdapterCredentials): Promise<EndpointRef> {
    const env = this.env(credentials);
    const cfg = request.providerConfig;
    const appName = ModalAdapter.appName(request.deploymentId);
    const dir = await fs.mkdtemp(join(tmpdir(), 'almyty-modal-'));
    const file = join(dir, 'app.py');
    await fs.writeFile(file, ModalAdapter.appSource(request, appName));
    const args = ['deploy', file, '--name', appName, ...(cfg.environment ? ['--env', cfg.environment] : [])];
    try {
      await this.exec(this.modalBin, args, {
        env: {
          ...env,
          ...(credentials.registryAccessKeyId ? { ALMYTY_REGISTRY_ACCESS_KEY_ID: credentials.registryAccessKeyId } : {}),
          ...(credentials.registrySecretAccessKey ? { ALMYTY_REGISTRY_SECRET_ACCESS_KEY: credentials.registrySecretAccessKey } : {}),
        },
        timeoutMs: 15 * 60_000,
      });
    } catch (err) {
      this.classify(err, 'modal deploy failed');
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
    return {
      appName,
      workspace: cfg.workspace,
      environment: cfg.environment ?? null,
      url: ModalAdapter.endpointUrl(cfg.workspace, cfg.environment, appName),
      maxContainers: request.desired.replicas ?? cfg.maxContainers ?? 1,
      hourlyRateCents: cfg.hourlyRateCents ?? 0,
      createdAt: new Date().toISOString(),
    };
  }

  async readEndpoint(ref: EndpointRef, credentials: AdapterCredentials): Promise<ActualState> {
    const env = this.env(credentials);
    let apps: Array<{ name?: string; state?: string; ['App ID']?: string; Name?: string; State?: string }>;
    try {
      const { stdout } = await this.exec(this.modalBin, ['app', 'list', '--json', ...(ref.environment ? ['--env', ref.environment] : [])], { env, timeoutMs: 60_000 });
      apps = JSON.parse(stdout || '[]');
    } catch (err) {
      this.classify(err, 'modal app list failed');
    }
    const row = apps.find((a) => (a.name ?? a.Name) === ref.appName);
    if (!row) return { state: 'missing', message: 'app not found in workspace' };
    const state = String(row.state ?? row.State ?? '').toLowerCase();
    if (state === 'deployed' || state === 'running') {
      const ceiling = Number(ref.maxContainers ?? 1);
      if (ceiling === 0) return { state: 'stopped', url: ref.url, replicas: 0, details: { rawState: state, note: 'ceiling 0, idle app sleeps at no cost' } };
      return { state: 'ready', url: ref.url, replicas: ceiling, details: { rawState: state } };
    }

    if (state === 'stopped') return { state: 'stopped', url: ref.url, replicas: 0, details: { rawState: state } };
    return { state: 'deploying', url: ref.url, details: { rawState: state } };
  }

  /**
   * Modal scales to zero on its own when a web endpoint is idle and bills
   * nothing while it sleeps, so "replicas" here is only the container
   * ceiling recorded on the handle. Zero means: leave the app deployed
   * but count it as stopped; the app goes away only on teardown.
   */
  async scale(ref: EndpointRef, replicas: number, _credentials: AdapterCredentials): Promise<void> {
    ref.maxContainers = replicas;
  }

  async teardown(ref: EndpointRef, credentials: AdapterCredentials): Promise<void> {
    const env = this.env(credentials);
    try {
      await this.exec(this.modalBin, ['app', 'stop', ref.appName, '-y', ...(ref.environment ? ['--env', ref.environment] : [])], { env, timeoutMs: 120_000 });
    } catch (err: any) {
      if (/not found|no such app/i.test(`${err?.stderr ?? ''} ${err?.message ?? ''}`)) return;
      this.classify(err, 'modal app stop failed');
    }
  }

  /** Modal publishes no billing API: an estimate from the GPU rate and observed running time. */
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
