/**
 * The frozen contract every deployment adapter implements.
 *
 * An adapter turns a model version into a running endpoint on one
 * provider's own managed product and reports what it costs. It knows
 * nothing about the catalog, the router or other adapters: it may not
 * import or invoke another adapter, reads weights only from a source its
 * provider natively supports, and receives credentials as arguments
 * rather than holding them. Weight files never pass through almyty.
 *
 * Changing this file is a spec change. Add capabilities through
 * `AdapterCapabilities`, not through new required methods.
 */

/**
 * Where an adapter can read weights from.
 *
 *   hub   a Hugging Face repository, which is what most managed
 *         providers import from and the default for nearly all of them
 *   s3    object storage the provider itself reads (AWS: SageMaker and
 *         Bedrock load model artifacts from S3 by design)
 *   gcs   Google Cloud Storage, the same story on Vertex
 *   local a path on the machine that serves the model
 */
export type RegistrySource = 'hub' | 's3' | 'gcs' | 'local';

export interface AdapterCapabilities {
  /** Model architectures the adapter can serve, or 'any' for a raw container. */
  architectures: string[] | 'any';
  /** LoRA support: merged weights only, multiple adapters per base, or none. */
  lora: 'merged' | 'multi' | 'none';
  /** Runs without a dedicated instance. */
  serverless: boolean;
  /** Runs on dedicated instances. */
  dedicated: boolean;
  scaleToZero: boolean;
  /** Regions the provider offers; empty means the provider chooses. */
  regions: string[];
  /**
   * Where this provider can actually read weights from, most preferred
   * first. The first entry is the native default: what the provider's
   * own documentation tells you to use. An adapter declares only what it
   * really supports, so a version it cannot read is refused with a clear
   * error instead of being smuggled in through the platform.
   */
  registrySources: RegistrySource[];
  /**
   * How generally available the provider's product is. A preview product
   * needs the customer to opt in on the provider's side before any call
   * works, and its API may change under us, so the UI says so up front
   * rather than letting an opaque 403 be the first the user hears of it.
   * Absent means generally available.
   */
  availability?: 'public_preview' | 'private_preview';
  /** Why it is limited, one sentence, shown next to the provider. */
  availabilityNote?: string;
}

/** Credentials resolved by the caller from the credentials vault. Never persisted by an adapter. */
export interface AdapterCredentials {
  [key: string]: string | undefined;
}

export interface DeploymentDesired {
  hardware?: string;
  /** The operator asked for the endpoint to go away; the reconcile loop keeps trying until it has. */
  teardownRequested?: boolean;
  replicas?: number;
  minScale?: number;
  maxScale?: number;
  quantization?: string;
  region?: string;
  privacyTier?: 'local' | 'private_cloud' | 'public';
}

/** What the adapter needs to deploy: the version's registry location plus the operator's config. */
export interface DeployRequest {
  deploymentId: string;
  organizationId: string;
  version: {
    id: string;
    name: string;
    registryUri: string;
    base: string;
    quantizations: string[];
    manifestSha: string | null;
  };
  desired: DeploymentDesired;
  /** Validated against the adapter's configSchema; secrets already decrypted. */
  providerConfig: Record<string, any>;
}

/** Adapter-owned handle to what it created. Opaque to everyone else. */
export interface EndpointRef {
  [key: string]: any;
  /** The URL the gateway sends chat requests to, once ready. */
  url?: string;
}

export type EndpointState = 'pending' | 'deploying' | 'ready' | 'degraded' | 'scaling' | 'stopped' | 'missing' | 'failed';

export interface ActualState {
  state: EndpointState;
  url?: string;
  replicas?: number;
  hardware?: string;
  region?: string;
  message?: string;
  /**
   * The OpenAI-compatible base of this endpoint, when the adapter knows
   * it: chat is POSTed to `<openAiBase>/chat/completions`. Adapters whose
   * `url` is already that base may leave it unset; the catalog falls back
   * to appending `/v1` when the URL does not carry it.
   */
  openAiBase?: string;
  /** Anything else the adapter observed. Must not contain secrets. */
  details?: Record<string, any>;
}

export interface CostSnapshot {
  /** Money spent so far on this endpoint, in cents, as far as the provider reports it. */
  spentCents: number;
  /** Current burn rate while running, in cents per hour; 0 when scaled to zero. */
  ratePerHourCents: number;
  /** Optional per-token price the provider charges for this endpoint, dollars per million tokens. */
  perToken?: { inPerMTok: number; outPerMTok: number; currency: string };
  observedAt: Date;
}

export interface UploadResult {
  /** The registry URI the adapter can deploy from after upload. */
  registryUri: string;
}

/**
 * Thrown by an adapter for an operation its provider cannot do (e.g. the
 * Ollama wrapper cannot deploy). Callers show it as a clean refusal.
 */
export class UnsupportedOperationError extends Error {
  readonly code = 'ADAPTER_UNSUPPORTED_OPERATION';
  constructor(adapter: string, operation: string) {
    super(`${adapter} does not support ${operation}`);
    this.name = 'UnsupportedOperationError';
  }
}

export interface ModelProviderAdapter {
  /** Stable key, also the deployment's providerType and the LlmProviderType where one exists. */
  readonly key: string;
  /** Human name for forms. */
  readonly displayName: string;
  capabilities(): AdapterCapabilities;
  /** JSON schema for providerConfig; secret fields carry `"x-secret": true`. Forms render from this. */
  configSchema(): Record<string, any>;
  /** Optional: push weights from the registry to the provider's own store. */
  upload?(version: DeployRequest['version'], credentials: AdapterCredentials): Promise<UploadResult>;
  deploy(request: DeployRequest, credentials: AdapterCredentials): Promise<EndpointRef>;
  readEndpoint(ref: EndpointRef, credentials: AdapterCredentials): Promise<ActualState>;
  scale(ref: EndpointRef, replicas: number, credentials: AdapterCredentials): Promise<void>;
  teardown(ref: EndpointRef, credentials: AdapterCredentials): Promise<void>;
  costSnapshot(ref: EndpointRef, credentials: AdapterCredentials): Promise<CostSnapshot>;
  // Reserved for a later assignment; unimplemented on purpose.
  train?: never;
  jobStatus?: never;
}

/**
 * What every adapter owes its caller.
 *
 * There used to be a rule here that every adapter must declare 's3'. It
 * was wrong: almyty supports inference through the providers, and most
 * providers import from a Hugging Face repository, not from our object
 * storage. The rule forced a workaround per provider (a presigned
 * archive, a placeholder repository, weight bytes streamed through this
 * backend) instead of each one using its documented path. An adapter now
 * declares what it can really read, native default first.
 */
export function assertAdapterContract(adapter: ModelProviderAdapter): void {
  const caps = adapter.capabilities();
  if (!Array.isArray(caps.registrySources) || caps.registrySources.length === 0) {
    throw new Error(`${adapter.key}: registrySources must name at least one source this provider can read`);
  }
  if (!adapter.key || !/^[a-z][a-z0-9-]*$/.test(adapter.key)) {
    throw new Error(`${adapter.key}: key must be lowercase kebab-case`);
  }
  const schema = adapter.configSchema();
  if (!schema || schema.type !== 'object') {
    throw new Error(`${adapter.key}: configSchema must be a JSON schema object`);
  }
}
