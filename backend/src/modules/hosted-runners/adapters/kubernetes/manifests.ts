import { HostedProvisionRequest, HostedResourceSpec, SANDBOX_RUNTIME_CLASS } from '../hosted-runner-adapter.interface';

/**
 * The Kubernetes objects a hosted runner is made of, as plain data.
 *
 * These builders are the only place in the backend that writes a pod
 * template (`no-unsandboxed-pods.guard.spec.ts` holds every other file to
 * that), and the pod template they write always runs under the gVisor
 * RuntimeClass, as a non-root user with every capability dropped, a
 * read-only root, no service-account token and nothing secret inline:
 * values that are secret reach the pod only through `envFrom` of the
 * runner's Secret. The client refuses to send a workload that is not
 * sandboxed (assertSandboxed), so a builder bug cannot reach a cluster
 * either.
 *
 * Per organization: a namespace, a ResourceQuota and LimitRange, and a
 * default-deny NetworkPolicy. Per hosted runner: a CiliumNetworkPolicy
 * that lets its pod resolve names and reach exactly its allowlisted hosts
 * over TLS, matched by SNI (`serverNames`), not by IP, because hosts
 * behind one CDN share addresses (docs/hosted-runners.md), and denies
 * every private, link-local and cluster range whatever a name resolves
 * to; a PodDisruptionBudget; a volume; a Secret; and a Deployment with
 * replicas 0 or 1 and `Recreate`, because a ReadWriteOnce volume mounts
 * once.
 */

export type KubeObject = Record<string, any> & {
  apiVersion: string;
  kind: string;
  metadata: { name: string; namespace?: string; labels?: Record<string, string>; [k: string]: any };
};

/** The cluster-side settings the builders need (from the hosted runner settings). */
export interface ClusterLayout {
  namespacePrefix: string;
  storageClassName: string | null;
  workspaceMountPath: string;
  runAsUser: number;
  runAsGroup: number;
  dnsNamespace: string;
  dnsPodLabels: Record<string, string>;
  tlsPorts: number[];
  /** The cluster's pod and service CIDRs, denied to the runner on top of PRIVATE_EGRESS_DENY. */
  clusterCidrs: string[];
  /** The runner's PodDisruptionBudget: exactly one of the two is set, the other null. */
  disruptionBudget: { minAvailable: number | string | null; maxUnavailable: number | string | null };
}

export const LABEL = {
  managedBy: 'app.kubernetes.io/managed-by',
  pool: 'almyty.com/runner-pool',
  organization: 'almyty.com/organization',
  hostedRunner: 'almyty.com/hosted-runner',
  workspace: 'almyty.com/workspace',
  environment: 'almyty.com/environment',
} as const;

export const MANAGER = 'almyty';

/** Kinds that run containers; every one of them must be sandboxed. */
export const WORKLOAD_KINDS = ['Pod', 'Deployment', 'ReplicaSet', 'StatefulSet', 'DaemonSet', 'Job', 'CronJob'] as const;

export interface HostedNames {
  namespace: string;
  deployment: string;
  volume: string;
  secret: string;
  egressPolicy: string;
  disruptionBudget: string;
}

/** One namespace per organization, named by its full id so two organizations never share one. */
export function namespaceFor(organizationId: string, layout: Pick<ClusterLayout, 'namespacePrefix'>): string {
  return `${layout.namespacePrefix}${organizationId.toLowerCase()}`;
}

export function namesFor(req: Pick<HostedProvisionRequest, 'organizationId' | 'workspaceId'>, layout: Pick<ClusterLayout, 'namespacePrefix'>): HostedNames {
  const ws = req.workspaceId.toLowerCase();
  return {
    namespace: namespaceFor(req.organizationId, layout),
    deployment: `hr-${ws}`,
    volume: `ws-${ws}`,
    secret: `hr-${ws}-env`,
    egressPolicy: `hr-${ws}-egress`,
    disruptionBudget: `hr-${ws}`,
  };
}

function runnerLabels(req: HostedProvisionRequest): Record<string, string> {
  return {
    [LABEL.managedBy]: MANAGER,
    [LABEL.hostedRunner]: req.hostedRunnerId,
    [LABEL.workspace]: req.workspaceId,
    [LABEL.environment]: req.environmentId,
  };
}

/** The selector that picks one hosted runner's pod. */
export function podSelector(hostedRunnerId: string): Record<string, string> {
  return { [LABEL.hostedRunner]: hostedRunnerId };
}

export function buildNamespace(organizationId: string, layout: ClusterLayout): KubeObject {
  return {
    apiVersion: 'v1',
    kind: 'Namespace',
    metadata: {
      name: namespaceFor(organizationId, layout),
      labels: {
        [LABEL.managedBy]: MANAGER,
        [LABEL.pool]: 'true',
        [LABEL.organization]: organizationId,
        // The pods below already meet `restricted`; enforcing it means a
        // pod that does not is refused by the API server too.
        'pod-security.kubernetes.io/enforce': 'restricted',
        'pod-security.kubernetes.io/enforce-version': 'latest',
      },
    },
  };
}

/** A Kubernetes quantity times n, keeping its unit ("2Gi" x 3 = "6Gi", "500m" x 2 = "1000m"). */
export function multiplyQuantity(quantity: string, n: number): string {
  const m = /^(\d+(?:\.\d+)?)([a-zA-Z]*)$/.exec(quantity.trim());
  if (!m) throw new Error(`not a Kubernetes quantity: ${quantity}`);
  const value = Number(m[1]) * n;
  return `${Number.isInteger(value) ? value : Number(value.toFixed(3))}${m[2]}`;
}

/** Room for the organization's concurrent pods and its volumes, and no more. */
export function buildResourceQuota(req: HostedProvisionRequest, layout: ClusterLayout): KubeObject {
  const { maxConcurrentRunners: pods, maxWorkspaces: volumes, podResources: biggest } = req.quota;
  return {
    apiVersion: 'v1',
    kind: 'ResourceQuota',
    metadata: { name: 'hosted-runners', namespace: namespaceFor(req.organizationId, layout), labels: { [LABEL.managedBy]: MANAGER } },
    spec: {
      hard: {
        pods: String(pods),
        'requests.cpu': multiplyQuantity(biggest.cpu, pods),
        'limits.cpu': multiplyQuantity(biggest.cpu, pods),
        'requests.memory': multiplyQuantity(biggest.memory, pods),
        'limits.memory': multiplyQuantity(biggest.memory, pods),
        'requests.ephemeral-storage': multiplyQuantity(biggest.ephemeralStorage, pods),
        'limits.ephemeral-storage': multiplyQuantity(biggest.ephemeralStorage, pods),
        persistentvolumeclaims: String(volumes),
        'requests.storage': `${biggest.volumeGi * volumes}Gi`,
        services: '0',
        'services.loadbalancers': '0',
        'services.nodeports': '0',
      },
    },
  };
}

/** No container in the namespace may ask for more than the largest class the organization may use. */
export function buildLimitRange(req: HostedProvisionRequest, layout: ClusterLayout): KubeObject {
  const biggest = req.quota.podResources;
  return {
    apiVersion: 'v1',
    kind: 'LimitRange',
    metadata: { name: 'hosted-runners', namespace: namespaceFor(req.organizationId, layout), labels: { [LABEL.managedBy]: MANAGER } },
    spec: {
      limits: [
        {
          type: 'Container',
          max: { cpu: biggest.cpu, memory: biggest.memory, 'ephemeral-storage': biggest.ephemeralStorage },
        },
        { type: 'PersistentVolumeClaim', max: { storage: `${biggest.volumeGi}Gi` } },
      ],
    },
  };
}

/** Nothing in, nothing out, for every pod in the namespace. The per-runner policy opens what it needs. */
export function buildDefaultDeny(organizationId: string, layout: ClusterLayout): KubeObject {
  return {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: { name: 'default-deny', namespace: namespaceFor(organizationId, layout), labels: { [LABEL.managedBy]: MANAGER } },
    spec: { podSelector: {}, policyTypes: ['Ingress', 'Egress'] },
  };
}

/**
 * A hostname an egress rule may name: lowercase DNS labels, at least one
 * dot, no wildcard, no IP literal, nothing cluster-internal. The pod
 * reaches the internet by name only.
 */
export function isAllowlistHost(host: string): boolean {
  if (typeof host !== 'string' || host.length > 253) return false;
  const h = host.toLowerCase();
  if (h !== host) return false;
  if (!/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/.test(h)) return false;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) return false;
  return !/(^|\.)(local|localhost|internal|cluster\.local|svc|lan|home|corp|intranet)$/.test(h);
}

/**
 * Address ranges a runner may never reach, whatever its allowlist says:
 * the private, carrier-grade NAT, link-local and loopback ranges of IPv4
 * and IPv6, and the cloud metadata address (inside link-local, named on
 * its own so nobody has to work that out). An allowlisted name that
 * resolves to one of these (a DNS record pointed at a VPC address, a
 * rebinding trick) passes the FQDN rule; the deny below wins over it.
 */
export const PRIVATE_EGRESS_DENY: readonly string[] = [
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '100.64.0.0/10',
  '169.254.0.0/16',
  '169.254.169.254/32',
  '127.0.0.0/8',
  'fc00::/7',
  'fe80::/10',
  '::1/128',
];

/**
 * Cluster identities a runner may never reach: its own node, every other
 * node, and the Kubernetes API server. Cilium gives node addresses these
 * identities rather than treating them as CIDRs, so the CIDR deny above
 * does not cover them (a gVisor pod on DOKS reached node kubelets at
 * 10.114.0.x:10250 with only that deny in place); an entity deny does.
 */
export const NODE_EGRESS_DENY_ENTITIES: readonly string[] = ['host', 'remote-node', 'kube-apiserver'];

/** Every CIDR the runner's policy denies: the fixed private ranges plus the cluster's own. */
export function egressDenyCidrs(layout: Pick<ClusterLayout, 'clusterCidrs'>): string[] {
  return [...new Set([...PRIVATE_EGRESS_DENY, ...(layout.clusterCidrs ?? [])])];
}

/**
 * The one runner's way out: DNS to the cluster resolver (which Cilium's
 * DNS proxy watches, so the FQDN rules below can learn addresses), and
 * TLS to the allowlisted hosts, admitted only when the TLS SNI is one of
 * them. Addresses alone would admit every host behind a shared CDN
 * address (registry.yarnpkg.com behind registry.npmjs.org's addresses,
 * in the gVisor-on-DOKS test). No ingress at all.
 *
 * `egressDeny` takes precedence over every allow in Cilium, so an
 * allowlisted name resolving to a private, link-local, loopback or
 * cluster address is dropped. Cilium's CIDR selectors match only
 * addresses outside the cluster's own endpoints, so the deny does not cut
 * the DNS rule to kube-dns (a pod, selected by labels). For the same
 * reason the CIDR deny misses the nodes and the API server, which Cilium
 * knows as identities; the second deny names those entities, and the DNS
 * allow still works under it, since kube-dns is a pod, not the host. The
 * almyty API is reached by its public name, which is on the allowlist
 * like any other host (the processor adds it); it must therefore resolve
 * to a public address, which the separate runner cluster gives it.
 */
export function buildEgressPolicy(req: HostedProvisionRequest, layout: ClusterLayout): KubeObject {
  const hosts = [...new Set(req.egressHosts)].filter(isAllowlistHost).sort();
  const rejected = req.egressHosts.filter((h) => !isAllowlistHost(h));
  if (rejected.length) throw new Error(`not allowlistable hosts: ${rejected.join(', ')}`);
  const names = namesFor(req, layout);
  const dnsSelector: Record<string, string> = { 'k8s:io.kubernetes.pod.namespace': layout.dnsNamespace };
  for (const [k, v] of Object.entries(layout.dnsPodLabels)) dnsSelector[`k8s:${k}`] = v;
  const egress: any[] = [
    {
      toEndpoints: [{ matchLabels: dnsSelector }],
      toPorts: [{ ports: [{ port: '53', protocol: 'ANY' }], rules: { dns: [{ matchPattern: '*' }] } }],
    },
  ];
  if (hosts.length > 0) {
    egress.push({
      toFQDNs: hosts.map((matchName) => ({ matchName })),
      toPorts: layout.tlsPorts.map((port) => ({ ports: [{ port: String(port), protocol: 'TCP' }], serverNames: hosts })),
    });
  }
  return {
    apiVersion: 'cilium.io/v2',
    kind: 'CiliumNetworkPolicy',
    metadata: { name: names.egressPolicy, namespace: names.namespace, labels: runnerLabels(req) },
    spec: {
      endpointSelector: { matchLabels: podSelector(req.hostedRunnerId) },
      egress,
      egressDeny: [{ toCIDRSet: egressDenyCidrs(layout).map((cidr) => ({ cidr })) }, { toEntities: [...NODE_EGRESS_DENY_ENTITIES] }],
    },
  };
}

/**
 * The runner's PodDisruptionBudget, so a node drain (a pool upgrade, a
 * node replacement, the autoscaler) does not evict a running runner
 * without warning. With the default (`maxUnavailable: 0`) the drain waits
 * until the runner goes idle and is scaled to zero; an install that
 * prefers drains to win sets its own budget. A pod that is not ready
 * (starting, crashing) may always be evicted, so a broken runner never
 * holds a node.
 */
export function buildDisruptionBudget(req: HostedProvisionRequest, layout: ClusterLayout): KubeObject {
  const names = namesFor(req, layout);
  const minAvailable = layout.disruptionBudget?.minAvailable ?? null;
  const maxUnavailable = layout.disruptionBudget?.maxUnavailable ?? null;
  if ((minAvailable === null) === (maxUnavailable === null)) {
    throw new Error('cluster.disruptionBudget needs exactly one of minAvailable and maxUnavailable');
  }
  return {
    apiVersion: 'policy/v1',
    kind: 'PodDisruptionBudget',
    metadata: { name: names.disruptionBudget, namespace: names.namespace, labels: runnerLabels(req) },
    spec: {
      selector: { matchLabels: podSelector(req.hostedRunnerId) },
      ...(minAvailable !== null ? { minAvailable } : { maxUnavailable }),
      unhealthyPodEvictionPolicy: 'AlwaysAllow',
    },
  };
}

export function buildVolumeClaim(req: HostedProvisionRequest, layout: ClusterLayout): KubeObject {
  const names = namesFor(req, layout);
  return {
    apiVersion: 'v1',
    kind: 'PersistentVolumeClaim',
    metadata: { name: names.volume, namespace: names.namespace, labels: runnerLabels(req) },
    spec: {
      accessModes: ['ReadWriteOnce'],
      resources: { requests: { storage: `${req.resources.volumeGi}Gi` } },
      ...(layout.storageClassName ? { storageClassName: layout.storageClassName } : {}),
    },
  };
}

/**
 * The runner's Secret: the enrollment token and the environment's
 * connection-backed variables. The only object that carries a secret
 * value; it is deleted while the pod is scaled to zero.
 */
export function buildSecret(req: Pick<HostedProvisionRequest, 'organizationId' | 'workspaceId' | 'hostedRunnerId' | 'environmentId'>, secretEnv: Record<string, string>, layout: ClusterLayout): KubeObject {
  const names = namesFor(req, layout);
  return {
    apiVersion: 'v1',
    kind: 'Secret',
    type: 'Opaque',
    metadata: { name: names.secret, namespace: names.namespace, labels: runnerLabels(req as HostedProvisionRequest) },
    stringData: { ...secretEnv },
  };
}

function resourceBlock(r: HostedResourceSpec): Record<string, any> {
  const amounts = { cpu: r.cpu, memory: r.memory, 'ephemeral-storage': r.ephemeralStorage };
  return { requests: { ...amounts }, limits: { ...amounts } };
}

/**
 * The runner pod, under gVisor, at `replicas` (0 when provisioned; the
 * reconcile loop scales it). Plain settings go in `env`; every secret
 * value comes from the Secret through `envFrom`, so the pod spec itself
 * never holds one.
 */
export function buildDeployment(req: HostedProvisionRequest, layout: ClusterLayout, replicas: 0 | 1 = 0): KubeObject {
  const names = namesFor(req, layout);
  const labels = runnerLabels(req);
  const mount = layout.workspaceMountPath;
  // An inherited workspace is mounted read-only (its owner keeps it to copy
  // from); HOME then lives in /tmp, the one other writable place.
  const readOnly = req.readOnlyWorkspace === true;
  const home = readOnly ? '/tmp/.home' : `${mount}/.home`;
  const env = Object.entries({ ...req.env, ALMYTY_WORKSPACE_ROOT: mount, HOME: home, ...(readOnly ? { ALMYTY_WORKSPACE_READ_ONLY: 'true' } : {}) })
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => ({ name, value: String(value) }));
  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name: names.deployment, namespace: names.namespace, labels },
    spec: {
      replicas,
      strategy: { type: 'Recreate' },
      selector: { matchLabels: podSelector(req.hostedRunnerId) },
      template: {
        metadata: { labels },
        spec: {
          runtimeClassName: SANDBOX_RUNTIME_CLASS,
          automountServiceAccountToken: false,
          enableServiceLinks: false,
          hostNetwork: false,
          hostPID: false,
          hostIPC: false,
          restartPolicy: 'Always',
          securityContext: {
            runAsNonRoot: true,
            runAsUser: layout.runAsUser,
            runAsGroup: layout.runAsGroup,
            fsGroup: layout.runAsGroup,
            seccompProfile: { type: 'RuntimeDefault' },
          },
          containers: [
            {
              name: 'runner',
              image: req.image,
              imagePullPolicy: 'IfNotPresent',
              env,
              envFrom: [{ secretRef: { name: names.secret, optional: false } }],
              resources: resourceBlock(req.resources),
              securityContext: {
                runAsNonRoot: true,
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: true,
                privileged: false,
                capabilities: { drop: ['ALL'] },
                seccompProfile: { type: 'RuntimeDefault' },
              },
              volumeMounts: [
                { name: 'workspace', mountPath: mount, ...(readOnly ? { readOnly: true } : {}) },
                { name: 'tmp', mountPath: '/tmp' },
              ],
            },
          ],
          volumes: [
            { name: 'workspace', persistentVolumeClaim: { claimName: names.volume } },
            { name: 'tmp', emptyDir: { sizeLimit: req.resources.ephemeralStorage } },
          ],
        },
      },
    },
  };
}

/**
 * The cluster-wide RuntimeClass the setup installs once (docs/hosted-runners.md):
 * handler `runsc`, scheduled only onto nodes the gVisor installer has
 * marked ready, tolerating the sandbox pool's taint.
 */
export function buildRuntimeClass(): KubeObject {
  return {
    apiVersion: 'node.k8s.io/v1',
    kind: 'RuntimeClass',
    metadata: { name: SANDBOX_RUNTIME_CLASS, labels: { [LABEL.managedBy]: MANAGER } },
    handler: 'runsc',
    scheduling: {
      nodeSelector: { 'almyty.com/gvisor': 'ready' },
      tolerations: [{ key: 'almyty.com/sandbox', operator: 'Equal', value: 'gvisor', effect: 'NoSchedule' }],
    },
  } as KubeObject;
}

/** Every object for one hosted runner, in the order they are applied. The Secret is written separately (rotate). */
export function buildHostedRunnerObjects(req: HostedProvisionRequest, layout: ClusterLayout): KubeObject[] {
  const objects = [
    buildNamespace(req.organizationId, layout),
    buildResourceQuota(req, layout),
    buildLimitRange(req, layout),
    buildDefaultDeny(req.organizationId, layout),
    buildEgressPolicy(req, layout),
    buildDisruptionBudget(req, layout),
    buildVolumeClaim(req, layout),
    buildDeployment(req, layout, 0),
  ];
  assertRunnerGuarded(objects);
  return objects;
}

function sameLabels(a: Record<string, string> | undefined, b: Record<string, string> | undefined): boolean {
  const flat = (m: Record<string, string> | undefined) => JSON.stringify(Object.entries(m ?? {}).sort(([x], [y]) => x.localeCompare(y)));
  return !!a && !!b && Object.keys(a).length > 0 && flat(a) === flat(b);
}

/**
 * Refuse a set of objects in which a runner Deployment comes without,
 * before it, the egress policy that selects its pod and denies every
 * private range and every node identity, and the PodDisruptionBudget that
 * selects its pod. The Deployment is the last thing applied, so a refusal
 * here means nothing that runs code is sent.
 */
export function assertRunnerGuarded(objects: KubeObject[]): void {
  objects.forEach((obj, i) => {
    if (obj.kind !== 'Deployment') return;
    const selector = obj.spec?.selector?.matchLabels;
    const before = objects.slice(0, i);
    const where = `Deployment ${obj.metadata?.namespace ?? ''}/${obj.metadata?.name ?? ''}`;
    const policy = before.find((o) => o.kind === 'CiliumNetworkPolicy' && sameLabels(o.spec?.endpointSelector?.matchLabels, selector));
    const rules: any[] = policy?.spec?.egressDeny ?? [];
    const denied = new Set<string>(rules.flatMap((rule: any) => (rule.toCIDRSet ?? []).map((c: any) => c.cidr)));
    const deniedEntities = new Set<string>(rules.flatMap((rule: any) => rule.toEntities ?? []));
    if (!policy || !PRIVATE_EGRESS_DENY.every((cidr) => denied.has(cidr)) || !NODE_EGRESS_DENY_ENTITIES.every((e) => deniedEntities.has(e))) {
      throw new Error(`${where} comes without an egress policy that denies the private ranges and the node identities to its pod`);
    }
    if (!before.some((o) => o.kind === 'PodDisruptionBudget' && sameLabels(o.spec?.selector?.matchLabels, selector))) {
      throw new Error(`${where} comes without a PodDisruptionBudget for its pod`);
    }
  });
}

/** The pod spec of a workload object, wherever its kind keeps it. */
export function podSpecOf(obj: KubeObject): Record<string, any> | null {
  switch (obj.kind) {
    case 'Pod':
      return obj.spec ?? null;
    case 'CronJob':
      return obj.spec?.jobTemplate?.spec?.template?.spec ?? null;
    default:
      return (WORKLOAD_KINDS as readonly string[]).includes(obj.kind) ? (obj.spec?.template?.spec ?? null) : null;
  }
}

/**
 * Refuse a workload that would run customer code outside the sandbox:
 * no gVisor RuntimeClass, root, privilege, host namespaces, a mounted
 * service-account token, or an inline env value that looks secret.
 */
export function assertSandboxed(obj: KubeObject): void {
  if (!(WORKLOAD_KINDS as readonly string[]).includes(obj.kind)) return;
  const spec = podSpecOf(obj);
  const where = `${obj.kind} ${obj.metadata?.namespace ?? ''}/${obj.metadata?.name ?? ''}`;
  if (!spec) throw new Error(`${where} has no pod spec`);
  if (spec.runtimeClassName !== SANDBOX_RUNTIME_CLASS) throw new Error(`${where} does not run under the ${SANDBOX_RUNTIME_CLASS} RuntimeClass`);
  if (spec.automountServiceAccountToken !== false) throw new Error(`${where} would mount a service-account token`);
  if (spec.hostNetwork || spec.hostPID || spec.hostIPC) throw new Error(`${where} shares a host namespace`);
  if (spec.securityContext?.runAsNonRoot !== true) throw new Error(`${where} may run as root`);
  for (const c of [...(spec.containers ?? []), ...(spec.initContainers ?? [])]) {
    const sc = c.securityContext ?? {};
    if (sc.privileged || sc.allowPrivilegeEscalation !== false || !(sc.capabilities?.drop ?? []).includes('ALL')) {
      throw new Error(`${where} container ${c.name} is not locked down`);
    }
    for (const e of c.env ?? []) {
      if (e.value !== undefined && /(token|secret|password|api[_-]?key|credential)/i.test(e.name)) {
        throw new Error(`${where} container ${c.name} carries ${e.name} inline; secrets come from the Secret only`);
      }
    }
  }
}
