import { KubernetesHostedAdapter, podPhase } from '../adapters/kubernetes.adapter';
import { KubeApiClient, kubeConnectionFrom } from '../adapters/kubernetes/kube-api.client';
import { FakeKubeApi } from './fake-kube-api';
import { BOUND_SECRET, ENROLLMENT_TOKEN, LAYOUT, provisionRequest } from './fixtures';

/**
 * The kubernetes adapter against a fake API server: what goes over the
 * wire, in what order, with which content type, and where the secrets go.
 */
describe('KubernetesHostedAdapter', () => {
  let api: FakeKubeApi;
  let adapter: KubernetesHostedAdapter;
  const creds = { server: 'https://kube.example.com', token: 'sa-token-xyz' };
  const req = provisionRequest();
  const ns = `almyty-rt-${req.organizationId}`;

  beforeEach(async () => {
    api = new FakeKubeApi();
    const url = await api.start();
    adapter = new KubernetesHostedAdapter(() => LAYOUT, (conn) => new KubeApiClient({ ...conn, server: url }));
  });
  afterEach(() => api.stop());

  it('provisions with server-side apply, in order, authenticated by the connection token', async () => {
    const ref = await adapter.provision(req, creds);
    expect(api.kinds('PATCH')).toEqual(['Namespace', 'ResourceQuota', 'LimitRange', 'NetworkPolicy', 'CiliumNetworkPolicy', 'PodDisruptionBudget', 'PersistentVolumeClaim', 'Deployment']);
    for (const r of api.requests) {
      expect(r.contentType).toBe('application/apply-patch+yaml');
      expect(r.path).toContain('fieldManager=almyty&force=true');
      expect(r.authorization).toBe('Bearer sa-token-xyz');
    }
    expect(api.requests.find((r) => r.body.kind === 'Deployment')!.path).toBe(`/apis/apps/v1/namespaces/${ns}/deployments/hr-${req.workspaceId}?fieldManager=almyty&force=true`);
    expect(ref).toMatchObject({ namespace: ns, deployment: `hr-${req.workspaceId}`, volume: `ws-${req.workspaceId}`, secret: `hr-${req.workspaceId}-env`, disruptionBudget: `hr-${req.workspaceId}` });
    expect(api.requests.find((r) => r.body.kind === 'PodDisruptionBudget')!.path).toBe(`/apis/policy/v1/namespaces/${ns}/poddisruptionbudgets/hr-${req.workspaceId}?fieldManager=almyty&force=true`);
  });

  it('sends the enrollment token and bound values in the Secret and in no other request', async () => {
    const ref = await adapter.provision(req, creds);
    await adapter.rotateEnrollment(ref, req.secretEnv, creds);
    await adapter.scale(ref, 1, creds);
    const withSecret = api.requests.filter((r) => JSON.stringify(r.body ?? {}).includes(ENROLLMENT_TOKEN));
    expect(withSecret.map((r) => r.body.kind)).toEqual(['Secret']);
    expect(api.requests.filter((r) => JSON.stringify(r.body ?? {}).includes(BOUND_SECRET)).map((r) => r.body.kind)).toEqual(['Secret']);
    // And nothing the adapter hands back for the row carries one.
    expect(JSON.stringify(ref)).not.toContain(ENROLLMENT_TOKEN);
  });

  it('scales through the scale subresource with a merge patch', async () => {
    const ref = await adapter.provision(req, creds);
    await adapter.scale(ref, 1, creds);
    const scale = api.requests[api.requests.length - 1];
    expect(scale).toMatchObject({ method: 'PATCH', contentType: 'application/merge-patch+json', body: { spec: { replicas: 1 } } });
    expect(scale.path).toBe(`/apis/apps/v1/namespaces/${ns}/deployments/hr-${req.workspaceId}/scale?fieldManager=almyty`);
  });

  it('drops the Secret while scaled to zero, and tears down keeping or deleting the volume', async () => {
    const ref = await adapter.provision(req, creds);
    await adapter.rotateEnrollment(ref, req.secretEnv, creds);
    await adapter.clearSecrets(ref, creds);
    expect(api.objects.has(`/api/v1/namespaces/${ns}/secrets/hr-${req.workspaceId}-env`)).toBe(false);
    expect(api.objects.has(`/apis/policy/v1/namespaces/${ns}/poddisruptionbudgets/hr-${req.workspaceId}`)).toBe(true);

    await adapter.teardown(ref, { keepVolume: true }, creds);
    expect(api.objects.has(`/api/v1/namespaces/${ns}/persistentvolumeclaims/ws-${req.workspaceId}`)).toBe(true);
    expect(api.objects.has(`/apis/apps/v1/namespaces/${ns}/deployments/hr-${req.workspaceId}`)).toBe(false);
    // The runner's disruption budget and egress policy go with it.
    expect(api.objects.has(`/apis/policy/v1/namespaces/${ns}/poddisruptionbudgets/hr-${req.workspaceId}`)).toBe(false);
    expect(api.objects.has(`/apis/cilium.io/v2/namespaces/${ns}/ciliumnetworkpolicies/hr-${req.workspaceId}-egress`)).toBe(false);
    expect(api.requests.filter((r) => r.method === 'DELETE').map((r) => r.path)).toContain(`/apis/policy/v1/namespaces/${ns}/poddisruptionbudgets/hr-${req.workspaceId}`);
    await adapter.teardown(ref, { keepVolume: false }, creds);
    expect(api.objects.has(`/api/v1/namespaces/${ns}/persistentvolumeclaims/ws-${req.workspaceId}`)).toBe(false);
    // The namespace's own policy stays for the organization's other runners.
    expect(api.objects.has(`/apis/networking.k8s.io/v1/namespaces/${ns}/networkpolicies/default-deny`)).toBe(true);
  });

  it('says a pod that cannot pull its image or keeps crashing has failed, and one waiting for a node is starting', () => {
    const waiting = (reason: string) => [{ status: { containerStatuses: [{ state: { waiting: { reason, message: 'x' } } }] } }];
    expect(podPhase(waiting('ImagePullBackOff') as any, 0).phase).toBe('failed');
    expect(podPhase(waiting('CrashLoopBackOff') as any, 0).phase).toBe('failed');
    const pending = [{ status: { phase: 'Pending', conditions: [{ type: 'PodScheduled', status: 'False', message: '0/2 nodes are available' }] } }];
    expect(podPhase(pending as any, 0)).toEqual({ phase: 'starting', message: '0/2 nodes are available' });
    expect(podPhase([], 1).phase).toBe('running');
    expect(podPhase([], 0).phase).toBe('absent');
  });

  it('reports an API refusal with its status and reason, never a request body', async () => {
    const ref = await adapter.provision(req, creds);
    api.failNext = 403;
    const error = await adapter.rotateEnrollment(ref, req.secretEnv, creds).catch((e) => e);
    expect(error.message).toMatch(/HTTP 403 Forbidden/);
    expect(error.message).not.toContain(ENROLLMENT_TOKEN);
  });

  it('needs an https server and a token from the connection', () => {
    expect(() => kubeConnectionFrom({ server: 'http://kube.example.com', token: 't' })).toThrow(/https/);
    expect(() => kubeConnectionFrom({ server: 'https://kube.example.com/', token: '' })).toThrow(/token/);
    expect(kubeConnectionFrom({ server: 'https://kube.example.com//', token: 't', caCert: ' PEM ' })).toEqual({ server: 'https://kube.example.com', token: 't', caCert: 'PEM' });
  });
});
