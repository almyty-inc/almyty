import { randomUUID } from 'crypto';

import { Credential } from '../../../entities/credential.entity';
import { OrganizationRole } from '../../../entities/user-organization.entity';
import { MemoryConnectStateStore } from '../connect-state.store';
import { ConnectionValidationService, ConnectionsHttp, S3ProbeClientFactory } from '../connection-validation.service';
import { ConnectionsService } from '../connections.service';
import { ConnectorCatalogService } from '../connector-catalog.service';
import { ConnectionPrincipal } from '../connections.permissions';

/** In-memory stand-in for a TypeORM repository: enough of find/findOne/save/remove for the service. */
export function fakeRepo<T extends { id?: string }>(factory: () => T = () => ({} as T)) {
  const rows: T[] = [];
  const matches = (row: any, where: Record<string, unknown> | undefined) =>
    !where || Object.entries(where).every(([k, v]) => row[k] === v);
  const repo = {
    rows,
    create: jest.fn((partial: Partial<T>) => Object.assign(factory(), partial)),
    save: jest.fn(async (row: any) => {
      if (!row.id) row.id = randomUUID();
      const now = new Date();
      row.createdAt = row.createdAt ?? now;
      row.updatedAt = now;
      const i = rows.findIndex((r) => r.id === row.id);
      if (i >= 0) rows[i] = row; else rows.push(row);
      return row;
    }),
    findOne: jest.fn(async (opts: any) => rows.find((r) => matches(r, opts?.where)) ?? null),
    find: jest.fn(async (opts: any) => rows.filter((r) => matches(r, opts?.where))),
    remove: jest.fn(async (row: any) => {
      const i = rows.findIndex((r) => r.id === row.id);
      if (i >= 0) rows.splice(i, 1);
      return row;
    }),
  };
  return repo;
}

export const fakeEnvelope = {
  warmOrg: jest.fn(async () => undefined),
  encryptForOrg: jest.fn(async (_org: string, v: string) => `encrypted:kms:${Buffer.from(v).toString('base64')}`),
  decryptForOrg: jest.fn(async (_org: string, v: string) => Buffer.from(v.replace(/^encrypted:kms:/, ''), 'base64').toString()),
  invalidate: jest.fn(),
} as any;

export const fakeAudit = () => ({ log: jest.fn(async () => null) }) as any;

export const fakeConfig = (env: Record<string, string | undefined> = {}) => ({ get: (k: string) => env[k] }) as any;

export interface FixtureRoute {
  method?: string;
  url: string | RegExp;
  handle: (url: string, init: RequestInit) => { status: number; body?: unknown; headers?: Record<string, string> } | Promise<{ status: number; body?: unknown; headers?: Record<string, string> }>;
}

/** An HTTP stand-in that answers only the routes a spec declares and records every call. */
export function fixtureHttp(routes: FixtureRoute[]) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const http: ConnectionsHttp = async (url, init) => {
    calls.push({ url, init });
    const method = (init.method ?? 'GET').toUpperCase();
    const route = routes.find((r) => (r.method ?? 'GET').toUpperCase() === method && (typeof r.url === 'string' ? url.startsWith(r.url) : r.url.test(url)));
    if (!route) throw new Error(`fixture: no route for ${method} ${url}`);
    const out = await route.handle(url, init);
    const body = out.body === undefined || out.status === 204 ? null : typeof out.body === 'string' ? out.body : JSON.stringify(out.body);
    return new Response(body, { status: out.status, headers: { 'content-type': 'application/json', ...(out.headers ?? {}) } });
  };
  return { http, calls };
}

export function principal(id: string, organizationId: string, role: OrganizationRole | string, permissions: string[] = []): ConnectionPrincipal {
  return { id, organizationMemberships: [{ organizationId, role, permissions }] };
}

export interface Harness {
  credentials: ReturnType<typeof fakeRepo<Credential>>;
  organizations: ReturnType<typeof fakeRepo<any>>;
  customConnectors: ReturnType<typeof fakeRepo<any>>;
  catalog: ConnectorCatalogService;
  validation: ConnectionValidationService;
  service: ConnectionsService;
  store: MemoryConnectStateStore;
  audit: any;
  http: ReturnType<typeof fixtureHttp>;
}

export function buildHarness(opts: { routes?: FixtureRoute[]; env?: Record<string, string>; s3Factory?: S3ProbeClientFactory; now?: () => number; adapters?: any; org?: Record<string, unknown>; grants?: any } = {}): Harness {
  const credentials = fakeRepo<Credential>(() => new Credential());
  const organizations = fakeRepo<any>();
  organizations.rows.push({ id: 'org-1', plan: 'free', settings: null, ...(opts.org ?? {}) });
  const customConnectors = fakeRepo<any>();
  const audit = fakeAudit();
  const catalog = new ConnectorCatalogService(customConnectors as any, audit, opts.adapters);
  const http = fixtureHttp(opts.routes ?? []);
  const config = fakeConfig({ PUBLIC_API_URL: 'https://api.test.almyty.com', ...(opts.env ?? {}) });
  const validation = new ConnectionValidationService(config, http.http, opts.s3Factory);
  const store = new MemoryConnectStateStore(opts.now);
  const service = new ConnectionsService(credentials as any, organizations as any, catalog, validation, fakeEnvelope, audit, config, { create: () => store } as any, store, opts.grants);
  return { credentials, organizations, customConnectors, catalog, validation, service, store, audit, http };
}
