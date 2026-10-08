import {
  HostedActual,
  HostedAdapterCapabilities,
  HostedAdapterCredentials,
  HostedPodPhase,
  HostedProvisionRequest,
  HostedRef,
  HostedRunnerAdapter,
  SANDBOX_RUNTIME_CLASS,
} from './hosted-runner-adapter.interface';
import { KubeApiClient, KubeConnection, kubeConnectionFrom } from './kubernetes/kube-api.client';
import { ClusterLayout, KubeObject, buildHostedRunnerObjects, buildSecret, namesFor, podSelector } from './kubernetes/manifests';

/** Builds the API client for a connection; a spec hands in one aimed at a fake API server. */
export type KubeClientFactory = (conn: KubeConnection) => Pick<KubeApiClient, 'apply' | 'get' | 'delete' | 'scaleDeployment' | 'listPods'>;

/** What the adapter writes into `externalRef`: the names of what it made. Never a secret. */
interface KubeRef extends HostedRef {
  namespace: string;
  deployment: string;
  volume: string;
  secret: string;
  egressPolicy: string;
  hostedRunnerId: string;
  organizationId: string;
  workspaceId: string;
  environmentId: string;
}

/**
 * Hosted runners on a Kubernetes cluster whose sandbox nodes run gVisor
 * (docs/hosted-runners.md, "Cluster setup"). Objects come from the
 * builders in kubernetes/manifests.ts; this file only sends them.
 *
 * `provision` is called by the reconcile loop only while the runner has
 * no pod (first provision, or a new environment version while
 * suspended), so applying the Deployment at replicas 0 never stops a
 * running pod; `scale` moves replicas through the scale subresource.
 */
export class KubernetesHostedAdapter implements HostedRunnerAdapter {
  readonly key = 'kubernetes';

  constructor(
    private readonly layout: () => ClusterLayout,
    private readonly clientFor: KubeClientFactory = (conn) => new KubeApiClient(conn),
  ) {}

  capabilities(): HostedAdapterCapabilities {
    return { runtimeClasses: [SANDBOX_RUNTIME_CLASS], volumeSnapshots: false };
  }

  private client(creds: HostedAdapterCredentials) {
    return this.clientFor(kubeConnectionFrom(creds));
  }

  async provision(req: HostedProvisionRequest, creds: HostedAdapterCredentials): Promise<HostedRef> {
    const layout = this.layout();
    const client = this.client(creds);
    for (const obj of buildHostedRunnerObjects(req, layout)) await client.apply(obj);
    const names = namesFor(req, layout);
    const ref: KubeRef = {
      ...names,
      hostedRunnerId: req.hostedRunnerId,
      organizationId: req.organizationId,
      workspaceId: req.workspaceId,
      environmentId: req.environmentId,
    };
    return ref;
  }

  async read(ref: HostedRef, creds: HostedAdapterCredentials): Promise<HostedActual> {
    const r = ref as KubeRef;
    const client = this.client(creds);
    const deployment = await client.get('Deployment', r.deployment, r.namespace);
    if (!deployment) return { exists: false, replicas: 0, readyReplicas: 0, pod: 'absent', message: 'the Deployment is gone' };
    const replicas = Number(deployment.spec?.replicas ?? 0);
    const readyReplicas = Number(deployment.status?.readyReplicas ?? 0);
    const pods = await client.listPods(r.namespace, podSelector(r.hostedRunnerId));
    const { phase, message } = podPhase(pods, readyReplicas);
    return {
      exists: true,
      replicas,
      readyReplicas,
      pod: phase,
      ...(message ? { message } : {}),
      details: { pods: pods.length, observedGeneration: deployment.status?.observedGeneration ?? null },
    };
  }

  async scale(ref: HostedRef, replicas: 0 | 1, creds: HostedAdapterCredentials): Promise<void> {
    const r = ref as KubeRef;
    await this.client(creds).scaleDeployment(r.deployment, r.namespace, replicas);
  }

  async rotateEnrollment(ref: HostedRef, secretEnv: Record<string, string>, creds: HostedAdapterCredentials): Promise<void> {
    const r = ref as KubeRef;
    await this.client(creds).apply(buildSecret(r as any, secretEnv, this.layout()));
  }

  async clearSecrets(ref: HostedRef, creds: HostedAdapterCredentials): Promise<void> {
    const r = ref as KubeRef;
    await this.client(creds).delete('Secret', r.secret, r.namespace);
  }

  async teardown(ref: HostedRef, opts: { keepVolume: boolean }, creds: HostedAdapterCredentials): Promise<void> {
    const r = ref as KubeRef;
    const client = this.client(creds);
    await client.delete('Deployment', r.deployment, r.namespace);
    await client.delete('Secret', r.secret, r.namespace);
    await client.delete('CiliumNetworkPolicy', r.egressPolicy, r.namespace);
    if (!opts.keepVolume) await client.delete('PersistentVolumeClaim', r.volume, r.namespace);
  }
}

/** What the runner's pod is doing, from the pod list, in one word and a reason. */
export function podPhase(pods: KubeObject[], readyReplicas: number): { phase: HostedPodPhase; message?: string } {
  if (readyReplicas > 0) return { phase: 'running' };
  if (pods.length === 0) return { phase: 'absent' };
  for (const pod of pods) {
    const statuses: any[] = pod.status?.containerStatuses ?? [];
    for (const s of statuses) {
      const waiting = s.state?.waiting?.reason as string | undefined;
      if (waiting && /(ImagePullBackOff|ErrImagePull|CrashLoopBackOff|CreateContainerConfigError|InvalidImageName)/.test(waiting)) {
        return { phase: 'failed', message: `${waiting}: ${String(s.state?.waiting?.message ?? '').slice(0, 300)}`.trim() };
      }
    }
    if (pod.status?.phase === 'Failed') return { phase: 'failed', message: String(pod.status?.reason ?? 'the pod failed') };
    const unschedulable = (pod.status?.conditions ?? []).find((c: any) => c.type === 'PodScheduled' && c.status === 'False');
    if (unschedulable) return { phase: 'starting', message: String(unschedulable.message ?? 'waiting for a sandbox node').slice(0, 300) };
  }
  return { phase: 'starting' };
}
