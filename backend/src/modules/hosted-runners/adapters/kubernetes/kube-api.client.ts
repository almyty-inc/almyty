import * as https from 'https';
import * as http from 'http';

import { KubeObject, MANAGER, assertSandboxed } from './manifests';

/**
 * A small client for the Kubernetes REST API: server-side apply, get,
 * delete, scale and a pod list. Enough for the hosted runner adapter and
 * nothing more, so the backend carries no Kubernetes SDK.
 *
 * The connection comes from a `kubernetes` connection in the credential
 * store (server URL, CA certificate, ServiceAccount token), resolved by
 * the reconcile processor and passed in per call; nothing is read from
 * the API pod's environment. The platform pool's connection is the
 * operator's own (outbound-transport-inventory: `operator`).
 *
 * Every write of a workload passes assertSandboxed first. Error messages
 * carry the API's status and reason, never a request body: a Secret's
 * body is exactly what must not reach a log.
 */
export interface KubeConnection {
  server: string;
  /** PEM CA bundle for the API server; absent uses the system roots. */
  caCert?: string;
  token: string;
}

export class KubeApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'KubeApiError';
  }
}

interface KubeResponse {
  status: number;
  body: any;
}

/** Plural resource path segments, by kind. */
const RESOURCES: Record<string, { group: string; plural: string; namespaced: boolean }> = {
  Namespace: { group: 'api/v1', plural: 'namespaces', namespaced: false },
  ResourceQuota: { group: 'api/v1', plural: 'resourcequotas', namespaced: true },
  LimitRange: { group: 'api/v1', plural: 'limitranges', namespaced: true },
  PersistentVolumeClaim: { group: 'api/v1', plural: 'persistentvolumeclaims', namespaced: true },
  Secret: { group: 'api/v1', plural: 'secrets', namespaced: true },
  Pod: { group: 'api/v1', plural: 'pods', namespaced: true },
  NetworkPolicy: { group: 'apis/networking.k8s.io/v1', plural: 'networkpolicies', namespaced: true },
  CiliumNetworkPolicy: { group: 'apis/cilium.io/v2', plural: 'ciliumnetworkpolicies', namespaced: true },
  Deployment: { group: 'apis/apps/v1', plural: 'deployments', namespaced: true },
  PodDisruptionBudget: { group: 'apis/policy/v1', plural: 'poddisruptionbudgets', namespaced: true },
  RuntimeClass: { group: 'apis/node.k8s.io/v1', plural: 'runtimeclasses', namespaced: false },
};

export function resourcePath(kind: string, name: string, namespace?: string): string {
  const r = RESOURCES[kind];
  if (!r) throw new Error(`no resource path for kind ${kind}`);
  const enc = encodeURIComponent;
  if (r.namespaced) {
    if (!namespace) throw new Error(`${kind} ${name} needs a namespace`);
    return `/${r.group}/namespaces/${enc(namespace)}/${r.plural}/${enc(name)}`;
  }
  return `/${r.group}/${r.plural}/${enc(name)}`;
}

/** A connection a client can use: an https server URL and a token. */
export function kubeConnectionFrom(creds: Record<string, string | undefined>): KubeConnection {
  let server = (creds.server ?? '').trim();
  while (server.endsWith('/')) server = server.slice(0, -1);
  const token = (creds.token ?? '').trim();
  if (!/^https:\/\//i.test(server)) throw Object.assign(new Error('the kubernetes connection needs an https server URL'), { code: 'CREDENTIAL_INVALID' });
  if (!token) throw Object.assign(new Error('the kubernetes connection needs a ServiceAccount token'), { code: 'CREDENTIAL_INVALID' });
  return { server, token, caCert: creds.caCert?.trim() || undefined };
}

export class KubeApiClient {
  constructor(private readonly conn: KubeConnection) {}

  private request(method: string, path: string, body?: unknown, contentType = 'application/json'): Promise<KubeResponse> {
    const url = new URL(path, `${this.conn.server}/`);
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const options: https.RequestOptions = {
      method,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${this.conn.token}`,
        ...(payload ? { 'Content-Type': contentType, 'Content-Length': String(payload.length) } : {}),
      },
      ...(this.conn.caCert ? { ca: this.conn.caCert } : {}),
    };
    return new Promise((resolve, reject) => {
      const onResponse = (res: http.IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed: any = text;
          try {
            parsed = text ? JSON.parse(text) : null;
          } catch {
            /* a non-JSON body stays text */
          }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      };
      // Plain http only for a spec's loopback fake; kubeConnectionFrom
      // refuses anything but https for a real connection.
      const req = url.protocol === 'http:' ? http.request(url, options, onResponse) : https.request(url, options, onResponse);
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  private fail(what: string, res: KubeResponse): never {
    const reason = typeof res.body === 'object' && res.body ? `${res.body.reason ?? ''} ${res.body.message ?? ''}`.trim() : '';
    throw new KubeApiError(res.status, `${what} failed: HTTP ${res.status}${reason ? ` ${reason}` : ''}`.slice(0, 500));
  }

  /** Server-side apply: create or update to exactly this object, owned by almyty. */
  async apply(obj: KubeObject): Promise<KubeObject> {
    assertSandboxed(obj);
    const path = `${resourcePath(obj.kind, obj.metadata.name, obj.metadata.namespace)}?fieldManager=${MANAGER}&force=true`;
    const res = await this.request('PATCH', path, obj, 'application/apply-patch+yaml');
    if (res.status >= 300) this.fail(`apply ${obj.kind} ${obj.metadata.name}`, res);
    return res.body;
  }

  async get(kind: string, name: string, namespace?: string): Promise<KubeObject | null> {
    const res = await this.request('GET', resourcePath(kind, name, namespace));
    if (res.status === 404) return null;
    if (res.status >= 300) this.fail(`get ${kind} ${name}`, res);
    return res.body;
  }

  /** Delete; a missing object is already deleted. */
  async delete(kind: string, name: string, namespace?: string): Promise<void> {
    const res = await this.request('DELETE', resourcePath(kind, name, namespace), { propagationPolicy: 'Foreground' });
    if (res.status === 404) return;
    if (res.status >= 300) this.fail(`delete ${kind} ${name}`, res);
  }

  /** Set a Deployment's replicas through its scale subresource. */
  async scaleDeployment(name: string, namespace: string, replicas: number): Promise<void> {
    const path = `${resourcePath('Deployment', name, namespace)}/scale?fieldManager=${MANAGER}`;
    const res = await this.request('PATCH', path, { spec: { replicas } }, 'application/merge-patch+json');
    if (res.status >= 300) this.fail(`scale Deployment ${name}`, res);
  }

  async listPods(namespace: string, selector: Record<string, string>): Promise<KubeObject[]> {
    const labelSelector = Object.entries(selector).map(([k, v]) => `${k}=${v}`).join(',');
    const path = `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods?labelSelector=${encodeURIComponent(labelSelector)}`;
    const res = await this.request('GET', path);
    if (res.status === 404) return [];
    if (res.status >= 300) this.fail(`list pods in ${namespace}`, res);
    return Array.isArray(res.body?.items) ? res.body.items : [];
  }
}
