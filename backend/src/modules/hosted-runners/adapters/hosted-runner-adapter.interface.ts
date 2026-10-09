/**
 * The frozen contract every hosted runner adapter implements.
 *
 * An adapter turns "a pod for this workspace of this environment" into
 * objects in one place that runs containers, and reports what it sees.
 * It knows nothing about agents, routing or other adapters: it may not
 * import another adapter, `providerConfig` is opaque to everyone but it,
 * and credentials arrive as arguments and are never held. Only the
 * reconcile processor calls an adapter (hosted-runners.processor.ts).
 *
 * Changing this file is a spec change. Add capabilities through
 * `HostedAdapterCapabilities`, not new required methods.
 */

export interface HostedAdapterCapabilities {
  /** RuntimeClasses the adapter runs customer pods under. Must be sandboxed (gVisor). */
  runtimeClasses: string[];
  /** Whether new volumes can be cloned from a snapshot (phase 4). */
  volumeSnapshots: boolean;
}

/** Resolved by the caller from the credential store; never persisted by an adapter. */
export interface HostedAdapterCredentials {
  [key: string]: string | undefined;
}

/** A pod's size: resolved from the hosted runner settings by the caller. */
export interface HostedResourceSpec {
  name: string;
  cpu: string;
  memory: string;
  ephemeralStorage: string;
  volumeGi: number;
}

/** Everything an adapter needs to create the objects for one hosted runner. */
export interface HostedProvisionRequest {
  hostedRunnerId: string;
  organizationId: string;
  environmentId: string;
  environmentVersion: number;
  workspaceId: string;
  runnerId: string;
  image: string;
  resources: HostedResourceSpec;
  /** Hosts the pod may reach over TLS (the environment's allowlist plus the almyty API). */
  egressHosts: string[];
  /** Plain settings for the runner inside the pod. Never a secret. */
  env: Record<string, string>;
  /**
   * Values that go into the pod's Secret and nowhere else: the enrollment
   * token and the environment's connection-backed variables. The pod
   * reads them by reference; no adapter writes them into a pod spec.
   */
  secretEnv: Record<string, string>;
  /** Organization-wide limits for the namespace. */
  quota: { maxConcurrentRunners: number; maxWorkspaces: number; podResources: HostedResourceSpec };
  /** Adapter-specific, opaque to the caller. */
  providerConfig: Record<string, any>;
}

/** Adapter-owned handle to what it made. Opaque to everyone else. */
export interface HostedRef {
  [key: string]: any;
}

export type HostedPodPhase = 'absent' | 'starting' | 'running' | 'failed';

export interface HostedActual {
  /** Whether the adapter's objects still exist at all. */
  exists: boolean;
  /** Replicas asked of the cluster. */
  replicas: number;
  /** Pods ready right now. */
  readyReplicas: number;
  pod: HostedPodPhase;
  message?: string;
  /** Anything else observed. Must not contain secrets. */
  details?: Record<string, any>;
}

export interface HostedRunnerAdapter {
  /** Stable key, the hosted runner's providerType. */
  readonly key: string;
  /** A test double; registered outside production only. */
  readonly internal?: boolean;
  capabilities(): HostedAdapterCapabilities;
  /** Namespace if missing, quota, network policy, volume, Secret, and the Deployment at 0. Idempotent. */
  provision(req: HostedProvisionRequest, creds: HostedAdapterCredentials): Promise<HostedRef>;
  read(ref: HostedRef, creds: HostedAdapterCredentials): Promise<HostedActual>;
  scale(ref: HostedRef, replicas: 0 | 1, creds: HostedAdapterCredentials): Promise<void>;
  /**
   * Rewrite the pod's Secret: a fresh enrollment token, and the
   * connection-backed variables resolved again, so a rotated secret
   * reaches the next wake.
   */
  rotateEnrollment(ref: HostedRef, secretEnv: Record<string, string>, creds: HostedAdapterCredentials): Promise<void>;
  /** Drop the Secret while the pod is scaled to zero; nothing secret sits in the cluster between wakes. */
  clearSecrets(ref: HostedRef, creds: HostedAdapterCredentials): Promise<void>;
  teardown(ref: HostedRef, opts: { keepVolume: boolean }, creds: HostedAdapterCredentials): Promise<void>;
}

/** The runtime class every customer pod runs under. Never plain runc for customer code. */
export const SANDBOX_RUNTIME_CLASS = 'gvisor';

/** What every adapter owes its caller. */
export function assertHostedAdapterContract(adapter: HostedRunnerAdapter): void {
  if (!adapter.key || !/^[a-z][a-z0-9-]*$/.test(adapter.key)) {
    throw new Error(`${adapter.key}: key must be lowercase kebab-case`);
  }
  const caps = adapter.capabilities();
  if (!Array.isArray(caps.runtimeClasses) || !caps.runtimeClasses.includes(SANDBOX_RUNTIME_CLASS)) {
    throw new Error(`${adapter.key}: must run customer pods under the ${SANDBOX_RUNTIME_CLASS} runtime class`);
  }
}
