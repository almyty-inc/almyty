import {
  PRIVATE_EGRESS_DENY,
  assertRunnerGuarded,
  assertSandboxed,
  buildDefaultDeny,
  buildDeployment,
  buildDisruptionBudget,
  buildEgressPolicy,
  buildHostedRunnerObjects,
  buildLimitRange,
  buildNamespace,
  buildResourceQuota,
  buildRuntimeClass,
  buildSecret,
  buildVolumeClaim,
  egressDenyCidrs,
  isAllowlistHost,
  multiplyQuantity,
  namespaceFor,
  podSpecOf,
} from '../adapters/kubernetes/manifests';
import { SANDBOX_RUNTIME_CLASS } from '../adapters/hosted-runner-adapter.interface';
import { DEFAULT_HOSTED_RUNNER_SETTINGS } from '../hosted-runner-settings';
import { BOUND_SECRET, ENROLLMENT_TOKEN, LAYOUT, provisionRequest } from './fixtures';

describe('hosted runner Kubernetes objects', () => {
  const req = provisionRequest();

  describe('the runner pod', () => {
    const deployment = buildDeployment(req, LAYOUT);
    const pod = deployment.spec.template.spec;
    const container = pod.containers[0];

    it('runs under the gVisor RuntimeClass, never the default runc', () => {
      expect(SANDBOX_RUNTIME_CLASS).toBe('gvisor');
      expect(pod.runtimeClassName).toBe('gvisor');
    });

    it('is non-root, drops every capability, has a read-only root and no service-account token', () => {
      expect(pod.automountServiceAccountToken).toBe(false);
      expect(pod.securityContext).toMatchObject({ runAsNonRoot: true, runAsUser: LAYOUT.runAsUser, seccompProfile: { type: 'RuntimeDefault' } });
      expect(container.securityContext).toMatchObject({
        runAsNonRoot: true,
        allowPrivilegeEscalation: false,
        readOnlyRootFilesystem: true,
        privileged: false,
        capabilities: { drop: ['ALL'] },
      });
      expect(pod.hostNetwork).toBe(false);
      expect(pod.hostPID).toBe(false);
      expect(pod.hostIPC).toBe(false);
      expect(pod.enableServiceLinks).toBe(false);
    });

    it('holds no token or secret value: secrets come from the Secret by reference only', () => {
      const text = JSON.stringify(deployment);
      expect(text).not.toContain(ENROLLMENT_TOKEN);
      expect(text).not.toContain(BOUND_SECRET);
      for (const e of container.env) expect(e.name).not.toMatch(/token|secret|password|api[_-]?key|credential/i);
      expect(container.envFrom).toEqual([{ secretRef: { name: `hr-${req.workspaceId}-env`, optional: false } }]);
    });

    it('is a Deployment with Recreate (one ReadWriteOnce volume) at the replicas asked, 0 by default', () => {
      expect(deployment.kind).toBe('Deployment');
      expect(deployment.spec.strategy).toEqual({ type: 'Recreate' });
      expect(deployment.spec.replicas).toBe(0);
      expect(buildDeployment(req, LAYOUT, 1).spec.replicas).toBe(1);
    });

    it('mounts the workspace volume and a scratch /tmp, sized from the class', () => {
      expect(container.volumeMounts).toEqual([
        { name: 'workspace', mountPath: LAYOUT.workspaceMountPath },
        { name: 'tmp', mountPath: '/tmp' },
      ]);
      expect(pod.volumes[0]).toEqual({ name: 'workspace', persistentVolumeClaim: { claimName: `ws-${req.workspaceId}` } });
      expect(container.resources.limits).toEqual({ cpu: req.resources.cpu, memory: req.resources.memory, 'ephemeral-storage': req.resources.ephemeralStorage });
      expect(container.resources.requests).toEqual(container.resources.limits);
    });

    it('passes assertSandboxed for every configured resource class', () => {
      for (const [name, size] of Object.entries(DEFAULT_HOSTED_RUNNER_SETTINGS.resourceClasses)) {
        expect(() => assertSandboxed(buildDeployment(provisionRequest({ resources: { name, ...size } }), LAYOUT, 1))).not.toThrow();
      }
    });
  });

  describe('assertSandboxed', () => {
    const sandboxed = () => buildDeployment(req, LAYOUT, 1);

    it('refuses a pod with no RuntimeClass (the default runc) or another one', () => {
      const plain = sandboxed();
      delete plain.spec.template.spec.runtimeClassName;
      expect(() => assertSandboxed(plain)).toThrow(/gvisor/);
      const runc = sandboxed();
      runc.spec.template.spec.runtimeClassName = 'runc';
      expect(() => assertSandboxed(runc)).toThrow(/gvisor/);
    });

    it('refuses root, privilege, host namespaces, a mounted token and inline secrets', () => {
      const root = sandboxed();
      root.spec.template.spec.securityContext.runAsNonRoot = false;
      expect(() => assertSandboxed(root)).toThrow(/root/);
      const privileged = sandboxed();
      privileged.spec.template.spec.containers[0].securityContext.privileged = true;
      expect(() => assertSandboxed(privileged)).toThrow(/locked down/);
      const host = sandboxed();
      host.spec.template.spec.hostNetwork = true;
      expect(() => assertSandboxed(host)).toThrow(/host namespace/);
      const token = sandboxed();
      token.spec.template.spec.automountServiceAccountToken = true;
      expect(() => assertSandboxed(token)).toThrow(/service-account token/);
      const inline = sandboxed();
      inline.spec.template.spec.containers[0].env.push({ name: 'ALMYTY_ENROLLMENT_TOKEN', value: ENROLLMENT_TOKEN });
      expect(() => assertSandboxed(inline)).toThrow(/inline/);
    });

    it('applies to every workload kind, and finds the pod spec where each keeps it', () => {
      const pod = { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'p' }, spec: { containers: [] } };
      expect(() => assertSandboxed(pod as any)).toThrow(/gvisor/);
      const job = { apiVersion: 'batch/v1', kind: 'Job', metadata: { name: 'j' }, spec: { template: { spec: { containers: [] } } } };
      expect(() => assertSandboxed(job as any)).toThrow(/gvisor/);
      const cron = { apiVersion: 'batch/v1', kind: 'CronJob', metadata: { name: 'c' }, spec: { jobTemplate: { spec: { template: { spec: { runtimeClassName: 'gvisor' } } } } } };
      expect(podSpecOf(cron as any)).toEqual({ runtimeClassName: 'gvisor' });
      expect(() => assertSandboxed(buildNamespace(req.organizationId, LAYOUT))).not.toThrow();
    });
  });

  describe('egress', () => {
    const policy = buildEgressPolicy(req, LAYOUT);

    it('selects only this runner\'s pod', () => {
      expect(policy.kind).toBe('CiliumNetworkPolicy');
      expect(policy.spec.endpointSelector).toEqual({ matchLabels: { 'almyty.com/hosted-runner': req.hostedRunnerId } });
    });

    it('lets the pod resolve names through cluster DNS, with the DNS proxy watching', () => {
      const dns = policy.spec.egress[0];
      expect(dns.toEndpoints).toEqual([{ matchLabels: { 'k8s:io.kubernetes.pod.namespace': 'kube-system', 'k8s:k8s-app': 'kube-dns' } }]);
      expect(dns.toPorts[0].rules).toEqual({ dns: [{ matchPattern: '*' }] });
    });

    it('allows each host by TLS SNI (serverNames), not by address alone', () => {
      const tls = policy.spec.egress[1];
      const hosts = [...req.egressHosts].sort();
      expect(tls.toFQDNs).toEqual(hosts.map((matchName) => ({ matchName })));
      expect(tls.toPorts).toEqual([{ ports: [{ port: '443', protocol: 'TCP' }], serverNames: hosts }]);
      // No allow rule opens an address range or an entity like "world".
      const allows = JSON.stringify(policy.spec.egress);
      expect(allows).not.toMatch(/toCIDR|toEntities|0\.0\.0\.0/);
    });

    it('with no hosts allows DNS and nothing else', () => {
      const none = buildEgressPolicy(provisionRequest({ egressHosts: [] }), LAYOUT);
      expect(none.spec.egress).toHaveLength(1);
    });

    it('refuses a wildcard, an address, or a cluster-internal name', () => {
      for (const bad of ['*.npmjs.org', '1.1.1.1', '169.254.169.254', 'kubernetes.default.svc', 'web.other.svc.cluster.local', 'localhost', 'GitHub.com', 'intranet']) {
        expect(isAllowlistHost(bad)).toBe(false);
        expect(() => buildEgressPolicy(provisionRequest({ egressHosts: [bad] }), LAYOUT)).toThrow(/not allowlistable/);
      }
      for (const good of ['github.com', 'registry.npmjs.org', 'objects.githubusercontent.com', 'pypi.org']) expect(isAllowlistHost(good)).toBe(true);
    });

    it('denies everything else in the namespace, both ways', () => {
      expect(buildDefaultDeny(req.organizationId, LAYOUT).spec).toEqual({ podSelector: {}, policyTypes: ['Ingress', 'Egress'] });
    });

    const deniedBy = (p: typeof policy): string[] => (p.spec.egressDeny ?? []).flatMap((rule: any) => (rule.toCIDRSet ?? []).map((c: any) => c.cidr));

    it('denies the private, CGNAT, link-local, loopback and metadata ranges, whatever an allowed name resolves to', () => {
      const denied = deniedBy(policy);
      for (const cidr of ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10', '169.254.0.0/16', '169.254.169.254/32', '127.0.0.0/8', 'fc00::/7', 'fe80::/10', '::1/128']) {
        expect(denied).toContain(cidr);
      }
      expect(denied).toEqual(egressDenyCidrs(LAYOUT));
      expect([...PRIVATE_EGRESS_DENY].every((cidr) => denied.includes(cidr))).toBe(true);
      // The deny is on the same pod the allow rules open, and holds with no hosts too.
      expect(policy.spec.endpointSelector).toEqual({ matchLabels: { 'almyty.com/hosted-runner': req.hostedRunnerId } });
      expect(deniedBy(buildEgressPolicy(provisionRequest({ egressHosts: [] }), LAYOUT))).toEqual(denied);
    });

    it('also denies the cluster CIDRs the settings name', () => {
      const layout = { ...LAYOUT, clusterCidrs: ['198.18.0.0/16', '198.19.0.0/16', '10.0.0.0/8'] };
      const denied = deniedBy(buildEgressPolicy(req, layout));
      expect(denied).toContain('198.18.0.0/16');
      expect(denied).toContain('198.19.0.0/16');
      expect(denied.filter((c) => c === '10.0.0.0/8')).toHaveLength(1);
    });
  });

  describe('per organization', () => {
    it('gives every organization a namespace of its own, by its full id', () => {
      expect(namespaceFor(req.organizationId, LAYOUT)).toBe(`almyty-rt-${req.organizationId}`);
      expect(namespaceFor('aaaaaaaa-0000-4000-8000-000000000001', LAYOUT)).not.toBe(namespaceFor('aaaaaaaa-0000-4000-8000-000000000002', LAYOUT));
      const ns = buildNamespace(req.organizationId, LAYOUT);
      expect(ns.metadata.labels).toMatchObject({ 'almyty.com/runner-pool': 'true', 'pod-security.kubernetes.io/enforce': 'restricted' });
    });

    it('sizes the quota from capacity times the largest class, and allows no services', () => {
      const quota = buildResourceQuota(req, LAYOUT).spec.hard;
      expect(quota.pods).toBe('2');
      expect(quota['limits.cpu']).toBe('8');
      expect(quota['limits.memory']).toBe('16Gi');
      expect(quota.persistentvolumeclaims).toBe('10');
      expect(quota['requests.storage']).toBe('400Gi');
      expect(quota.services).toBe('0');
      expect(buildLimitRange(req, LAYOUT).spec.limits[0].max).toEqual({ cpu: '4', memory: '8Gi', 'ephemeral-storage': '16Gi' });
    });

    it('multiplies quantities in their own units', () => {
      expect(multiplyQuantity('2Gi', 3)).toBe('6Gi');
      expect(multiplyQuantity('500m', 2)).toBe('1000m');
      expect(multiplyQuantity('1.5', 2)).toBe('3');
      expect(() => multiplyQuantity('lots', 2)).toThrow();
    });
  });

  describe('disruption budget', () => {
    it('gives every runner a PodDisruptionBudget on its own pod, from the settings', () => {
      const pdb = buildDisruptionBudget(req, LAYOUT);
      expect(pdb).toMatchObject({ apiVersion: 'policy/v1', kind: 'PodDisruptionBudget', metadata: { name: `hr-${req.workspaceId}`, namespace: namespaceFor(req.organizationId, LAYOUT) } });
      expect(pdb.spec).toEqual({
        selector: { matchLabels: buildDeployment(req, LAYOUT).spec.selector.matchLabels },
        maxUnavailable: LAYOUT.disruptionBudget.maxUnavailable,
        unhealthyPodEvictionPolicy: 'AlwaysAllow',
      });
      expect(LAYOUT.disruptionBudget).toEqual({ minAvailable: null, maxUnavailable: 0 });
      const min = buildDisruptionBudget(req, { ...LAYOUT, disruptionBudget: { minAvailable: 1, maxUnavailable: null } }).spec;
      expect(min.minAvailable).toBe(1);
      expect(min).not.toHaveProperty('maxUnavailable');
    });

    it('refuses a budget with both or neither amount set', () => {
      expect(() => buildDisruptionBudget(req, { ...LAYOUT, disruptionBudget: { minAvailable: 1, maxUnavailable: 0 } })).toThrow(/exactly one/);
      expect(() => buildDisruptionBudget(req, { ...LAYOUT, disruptionBudget: { minAvailable: null, maxUnavailable: null } })).toThrow(/exactly one/);
    });
  });

  describe('no runner Deployment without its guards', () => {
    const objects = () => buildHostedRunnerObjects(req, LAYOUT);
    const without = (kind: string) => objects().filter((o) => o.kind !== kind);

    it('applies the egress policy and the disruption budget before the Deployment', () => {
      const kinds = objects().map((o) => o.kind);
      expect(kinds.indexOf('CiliumNetworkPolicy')).toBeLessThan(kinds.indexOf('Deployment'));
      expect(kinds.indexOf('PodDisruptionBudget')).toBeLessThan(kinds.indexOf('Deployment'));
      expect(() => assertRunnerGuarded(objects())).not.toThrow();
    });

    it('refuses a Deployment with no PodDisruptionBudget for its pod', () => {
      expect(() => assertRunnerGuarded(without('PodDisruptionBudget'))).toThrow(/PodDisruptionBudget/);
      const other = objects();
      other.find((o) => o.kind === 'PodDisruptionBudget')!.spec.selector.matchLabels = { 'almyty.com/hosted-runner': 'someone-else' };
      expect(() => assertRunnerGuarded(other)).toThrow(/PodDisruptionBudget/);
    });

    it('refuses a Deployment with no egress policy, or one that does not deny the private ranges', () => {
      expect(() => assertRunnerGuarded(without('CiliumNetworkPolicy'))).toThrow(/private ranges/);
      const open = objects();
      delete open.find((o) => o.kind === 'CiliumNetworkPolicy')!.spec.egressDeny;
      expect(() => assertRunnerGuarded(open)).toThrow(/private ranges/);
      const partial = objects();
      partial.find((o) => o.kind === 'CiliumNetworkPolicy')!.spec.egressDeny[0].toCIDRSet.pop();
      expect(() => assertRunnerGuarded(partial)).toThrow(/private ranges/);
    });

    it('refuses guards that only come after the Deployment', () => {
      const late = objects();
      const deployment = late.splice(late.findIndex((o) => o.kind === 'Deployment'), 1)[0];
      expect(() => assertRunnerGuarded([late[0], deployment, ...late.slice(1)])).toThrow();
    });
  });

  it('keeps the token and bound values in the Secret, and only there', () => {
    const secret = buildSecret(req, req.secretEnv, LAYOUT);
    expect(secret.stringData).toEqual(req.secretEnv);
    const others = buildHostedRunnerObjects(req, LAYOUT);
    expect(others.map((o) => o.kind)).toEqual([
      'Namespace', 'ResourceQuota', 'LimitRange', 'NetworkPolicy', 'CiliumNetworkPolicy', 'PodDisruptionBudget', 'PersistentVolumeClaim', 'Deployment',
    ]);
    const text = JSON.stringify(others);
    expect(text).not.toContain(ENROLLMENT_TOKEN);
    expect(text).not.toContain(BOUND_SECRET);
  });

  it('sizes the volume from the class and uses the configured StorageClass', () => {
    expect(buildVolumeClaim(req, LAYOUT).spec).toEqual({ accessModes: ['ReadWriteOnce'], resources: { requests: { storage: '10Gi' } } });
    expect(buildVolumeClaim(req, { ...LAYOUT, storageClassName: 'do-block-storage' }).spec.storageClassName).toBe('do-block-storage');
  });

  it('describes the RuntimeClass the setup installs: runsc, only on nodes the installer marked ready', () => {
    const rc = buildRuntimeClass();
    expect(rc).toMatchObject({
      kind: 'RuntimeClass',
      metadata: { name: 'gvisor' },
      handler: 'runsc',
      scheduling: {
        nodeSelector: { 'almyty.com/gvisor': 'ready' },
        tolerations: [{ key: 'almyty.com/sandbox', operator: 'Equal', value: 'gvisor', effect: 'NoSchedule' }],
      },
    });
  });
});
