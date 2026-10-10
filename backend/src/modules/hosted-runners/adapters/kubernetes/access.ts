import { KubeApiClient, KubeResourceAttributes, resourceAttributes } from './kube-api.client';

/**
 * What the hosted runner adapter does on a cluster, as access reviews:
 * every kind buildHostedRunnerObjects applies (server-side apply needs
 * create for a new object and patch for an existing one), the Secret it
 * writes on rotate, the Deployment it reads and scales, the pods it lists
 * and what teardown deletes. The connection check asks the cluster about
 * each of these for the namespace the adapter would use, so a token that
 * can reach the API but not provision is reported before the first wake.
 *
 * `access.spec.ts` keeps this list in step with what the adapter sends.
 */
export interface HostedRunnerAccess {
  kind: string;
  verb: string;
  subresource?: string;
}

const APPLIED_KINDS = [
  'Namespace',
  'ResourceQuota',
  'LimitRange',
  'NetworkPolicy',
  'CiliumNetworkPolicy',
  'PodDisruptionBudget',
  'PersistentVolumeClaim',
  'Deployment',
  'Secret',
] as const;

// Written as calls, not object literals: these name kinds, they never build
// one, and no-unsandboxed-pods.guard.spec.ts reads a workload kind literal as a write.
const need = (kind: string, verb: string, subresource?: string): HostedRunnerAccess => (subresource ? { kind, verb, subresource } : { kind, verb });

export const HOSTED_RUNNER_ACCESS: HostedRunnerAccess[] = [
  ...APPLIED_KINDS.flatMap((kind) => [need(kind, 'create'), need(kind, 'patch')]),
  need('Deployment', 'get'),
  need('Deployment', 'patch', 'scale'),
  need('Pod', 'list'),
  need('Deployment', 'delete'),
  need('Secret', 'delete'),
  need('PodDisruptionBudget', 'delete'),
  need('CiliumNetworkPolicy', 'delete'),
  need('PersistentVolumeClaim', 'delete'),
];

/** One thing the token may not do, in the words `kubectl auth can-i` uses. */
export interface DeniedAccess {
  verb: string;
  resource: string;
  namespaced: boolean;
}

/**
 * Asks the cluster, for each entry of HOSTED_RUNNER_ACCESS, whether this
 * token may do it in `namespace`, and returns what it may not. Throws what
 * the client throws (unreachable, TLS, a rejected token).
 */
export async function deniedHostedRunnerAccess(client: Pick<KubeApiClient, 'canI'>, namespace: string): Promise<DeniedAccess[]> {
  const reviews: KubeResourceAttributes[] = HOSTED_RUNNER_ACCESS.map((a) => resourceAttributes(a.kind, a.verb, namespace, a.subresource));
  const allowed = await Promise.all(reviews.map((r) => client.canI(r)));
  return reviews
    .filter((_, i) => !allowed[i])
    .map((r) => ({ verb: r.verb, resource: r.subresource ? `${r.resource}/${r.subresource}` : r.resource, namespaced: !!r.namespace }));
}
