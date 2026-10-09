import * as http from 'http';
import { AddressInfo } from 'net';

export interface RecordedRequest {
  method: string;
  path: string;
  contentType: string | undefined;
  authorization: string | undefined;
  body: any;
}

/**
 * A pretend Kubernetes API server on loopback: server-side apply stores
 * the object, the scale subresource sets replicas, DELETE removes, GET
 * reads back, and a pod list answers from what a spec put in `pods`. It
 * records every request so a spec can say what went over the wire.
 */
export class FakeKubeApi {
  readonly requests: RecordedRequest[] = [];
  readonly objects = new Map<string, any>();
  /** Pod lists by namespace, set by a spec. */
  pods = new Map<string, any[]>();
  /** Answer the next request with this status instead. */
  failNext: number | null = null;
  private server?: http.Server;

  async start(): Promise<string> {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        const body = text ? JSON.parse(text) : undefined;
        const url = new URL(req.url ?? '/', 'http://fake');
        this.requests.push({ method: req.method ?? '', path: url.pathname + url.search, contentType: req.headers['content-type'], authorization: req.headers.authorization, body });
        const reply = (status: number, payload: any) => {
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(payload));
        };
        if (this.failNext) {
          const status = this.failNext;
          this.failNext = null;
          return reply(status, { reason: 'Forbidden', message: 'not allowed' });
        }
        const path = url.pathname;
        if (req.method === 'PATCH' && path.endsWith('/scale')) {
          const key = path.slice(0, -'/scale'.length);
          const obj = this.objects.get(key);
          if (!obj) return reply(404, { reason: 'NotFound' });
          obj.spec.replicas = body.spec.replicas;
          obj.status = { readyReplicas: body.spec.replicas, observedGeneration: 1 };
          return reply(200, { spec: { replicas: body.spec.replicas } });
        }
        if (req.method === 'PATCH') {
          const existing = this.objects.get(path);
          const stored = { ...body, status: existing?.status ?? { readyReplicas: 0 } };
          this.objects.set(path, stored);
          return reply(200, stored);
        }
        if (req.method === 'GET' && path.endsWith('/pods')) {
          const ns = path.split('/')[4];
          return reply(200, { items: this.pods.get(ns) ?? [] });
        }
        if (req.method === 'GET') {
          const obj = this.objects.get(path);
          return obj ? reply(200, obj) : reply(404, { reason: 'NotFound' });
        }
        if (req.method === 'DELETE') {
          const had = this.objects.delete(path);
          return had ? reply(200, { status: 'Success' }) : reply(404, { reason: 'NotFound' });
        }
        return reply(405, { reason: 'MethodNotAllowed' });
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  kinds(method: string): string[] {
    return this.requests.filter((r) => r.method === method && r.body?.kind).map((r) => r.body.kind);
  }
}
