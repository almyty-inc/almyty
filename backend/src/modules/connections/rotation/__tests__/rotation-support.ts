import { RotationHttp } from '../rotation.interface';

export interface FixtureRoute {
  method?: string;
  url: string | RegExp;
  handle: (url: string, init: RequestInit) => { status: number; body?: unknown; headers?: Record<string, string> } | Promise<{ status: number; body?: unknown; headers?: Record<string, string> }>;
}

export interface RecordedCall {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | null;
  json: any;
}

/** An HTTP stand-in that answers only the routes a spec declares and records every call with parsed headers and body. */
export function fixtureHttp(routes: FixtureRoute[]) {
  const calls: RecordedCall[] = [];
  const http: RotationHttp = async (url, init) => {
    const method = (init.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init.headers as Record<string, string>) ?? {})) headers[k.toLowerCase()] = String(v);
    const body = typeof init.body === 'string' ? init.body : null;
    let json: any = null;
    if (body && headers['content-type']?.includes('json')) {
      try {
        json = JSON.parse(body);
      } catch {
        json = null;
      }
    }
    calls.push({ method, url, headers, body, json });
    const route = routes.find((r) => (r.method ?? 'GET').toUpperCase() === method && (typeof r.url === 'string' ? url === r.url || url.startsWith(r.url) : r.url.test(url)));
    if (!route) throw new Error(`fixture: no route for ${method} ${url}`);
    const out = await route.handle(url, init);
    const text = out.body === undefined || out.status === 204 ? null : typeof out.body === 'string' ? out.body : JSON.stringify(out.body);
    return new Response(text, { status: out.status, headers: { 'content-type': 'application/json', ...(out.headers ?? {}) } });
  };
  return { http, calls };
}

export const ctx = { organizationId: 'org-1', connectionId: 'conn-12345678', now: new Date('2026-09-08T12:00:00Z') };

/** Awaits a rejection and returns the error so specs can assert on `code` and a secret-free message. */
export async function rejection(p: Promise<unknown>): Promise<any> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected a rejection');
}
