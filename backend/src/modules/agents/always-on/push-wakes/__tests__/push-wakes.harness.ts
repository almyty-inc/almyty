/**
 * A world for PushWakesService specs: the real service and the real
 * AlwaysOnService behind it (always-on.harness.ts), fake repositories that
 * evaluate their criteria, a Redis that honours NX/PX, and a tool executor
 * that answers each operation from an in-memory service ("the service at
 * the other end"). No network.
 *
 * Not a `.spec.ts`, deliberately: jest collects `.*\.spec\.ts$`.
 */
import { createHmac } from 'crypto';
import { exportJWK, generateKeyPair, SignJWT, createLocalJWKSet, type JWK } from 'jose';

import { fakeRepository, FakeRepository } from '../../../../../test/fake-repository';
import { AgentPushWake } from '../../../../../entities/agent-push-wake.entity';
import { PushSubscription } from '../../../../../entities/push-subscription.entity';
import { PushWakesService } from '../push-wakes.service';
import { AGENT, ORG, OWNER, World, alwaysOnAgent, world } from '../../__tests__/always-on.harness';

export const API = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const OTHER_API = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

export type Handler = (params: Record<string, any>) => { status?: number; data?: any; error?: string };

/** A Redis that honours NX and PX (expiry is not modelled), with incr and multi-key del. */
export function pushRedis() {
  const store = new Map<string, string>();
  return {
    store,
    set: jest.fn(async (key: string, value: string, ...args: any[]) => {
      if (args.includes('NX') && store.has(key)) return null;
      store.set(key, value);
      return 'OK';
    }),
    get: jest.fn(async (key: string) => store.get(key) ?? null),
    del: jest.fn(async (...keys: string[]) => keys.reduce((n, k) => n + (store.delete(k) ? 1 : 0), 0)),
    incr: jest.fn(async (key: string) => {
      const n = Number(store.get(key) ?? 0) + 1;
      store.set(key, String(n));
      return n;
    }),
    pexpire: jest.fn(async () => 1),
  };
}

export function pushQueue() {
  const added: Array<{ name: string; data: any; opts: any }> = [];
  return { added, add: jest.fn(async (name: string, data: any, opts: any = {}) => (added.push({ name, data, opts }), { id: opts.jobId })) };
}

/** The credential store, as far as managed rows go: what was created, resolved and released. */
export function fakeCredentialRefs() {
  const rows = new Map<string, { id: string; config: Record<string, any>; managedBy: any; organizationId: string }>();
  let seq = 0;
  return {
    rows,
    createManaged: jest.fn(async (organizationId: string, input: any) => {
      const id = `cred-${++seq}`;
      rows.set(id, { id, config: { ...input.config }, managedBy: input.managedBy, organizationId });
      return { id };
    }),
    tryResolve: jest.fn(async (organizationId: string, id: string) => {
      const row = rows.get(id);
      return row && row.organizationId === organizationId ? { credential: row, config: row.config, secrets: {} } : null;
    }),
    releaseManaged: jest.fn(async (_org: string, id: string, by: any) => {
      const row = rows.get(id);
      if (!row || row.managedBy.kind !== by.kind || row.managedBy.id !== by.id) return false;
      rows.delete(id);
      return true;
    }),
  };
}

export interface PushWorld {
  service: PushWakesService;
  alwaysOn: World;
  subs: FakeRepository<any>;
  members: FakeRepository<any>;
  apis: FakeRepository<any>;
  operations: FakeRepository<any>;
  tools: FakeRepository<any>;
  queue: ReturnType<typeof pushQueue>;
  redis: ReturnType<typeof pushRedis>;
  credentials: ReturnType<typeof fakeCredentialRefs>;
  /** Every call the executor made: operation and parameters. */
  calls: Array<{ operation: string; params: Record<string, any>; options: any }>;
  handlers: Record<string, Handler>;
}

/** A world whose connection API has a tool for each operation in `handlers`. */
export function pushWorld(handlers: Record<string, Handler>, options: { agent?: Record<string, any> } = {}): PushWorld {
  const alwaysOn = world({ agent: options.agent ?? alwaysOnAgent({}, { wakeOn: { timer: { everyMinutes: 30 }, channelIds: [], connectionEvents: [] }, ownerChannel: null }) });
  const subs = fakeRepository<any>({ make: () => new PushSubscription(), idPrefix: 'sub' });
  const members = fakeRepository<any>({ make: () => new AgentPushWake(), idPrefix: 'pw' });
  const apis = fakeRepository<any>([
    { id: API, organizationId: ORG, name: 'The service', visibility: 'org', teamId: null, ownerUserId: null },
    { id: OTHER_API, organizationId: ORG, name: 'Something else', visibility: 'org', teamId: null, ownerUserId: null },
  ]);
  const operations = fakeRepository<any>([]);
  const tools = fakeRepository<any>([]);
  let n = 0;
  for (const op of Object.keys(handlers)) {
    n++;
    const opId = `op-${n}`;
    operations.seed({ id: opId, apiId: API, operationId: op });
    tools.seed({ id: `tool-${n}`, apiId: API, organizationId: ORG, operationId: opId, status: 'active', name: op });
  }
  const calls: PushWorld['calls'] = [];
  const executor = {
    executeTool: jest.fn(async (toolId: string, params: Record<string, any>, opts: any) => {
      const tool = tools.row(toolId);
      const op = tool ? operations.row(tool.operationId)?.operationId : undefined;
      if (!op || !handlers[op]) return { success: false, error: 'Tool not found' };
      calls.push({ operation: op, params, options: opts });
      const res = handlers[op](params);
      const status = res.status ?? 200;
      return status < 400
        ? { success: true, data: res.data ?? {}, metadata: { httpStatus: status } }
        : { success: false, data: res.data ?? null, error: res.error ?? `HTTP ${status}`, metadata: { httpStatus: status } };
    }),
  };
  const queue = pushQueue();
  const redis = pushRedis();
  const credentials = fakeCredentialRefs();
  const service = new PushWakesService(
    members as any,
    subs as any,
    alwaysOn.agents as any,
    apis as any,
    operations as any,
    tools as any,
    queue as any,
    redis as any,
    executor as any,
    alwaysOn.service,
    credentials as any,
    undefined,
    // The real execution gate: an agent may join only a connection its owner can use.
    alwaysOn.membership.executionAccess,
  );
  return { service, alwaysOn, subs, members, apis, operations, tools, queue, redis, credentials, calls, handlers };
}

export function hmacHex(key: string, content: string): string {
  return createHmac('sha256', key).update(content).digest('hex');
}

/** An OIDC issuer for tests: a key pair, its JWKS, and a token minter. */
export async function fakeIssuer(issuer = 'https://accounts.google.com') {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  const keySet = createLocalJWKSet({ keys: [jwk] });
  const mint = async (claims: Record<string, unknown>, opts: { audience: string; issuer?: string; expiresIn?: string | number; iat?: number; key?: any } = { audience: '' }) => {
    let jwt = new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuer(opts.issuer ?? issuer).setAudience(opts.audience);
    jwt = opts.iat !== undefined ? jwt.setIssuedAt(opts.iat) : jwt.setIssuedAt();
    jwt = jwt.setExpirationTime(opts.expiresIn ?? '1h');
    return jwt.sign(opts.key ?? privateKey);
  };
  return { keySet, mint, keySetFor: () => keySet };
}

export { AGENT, ORG, OWNER };
