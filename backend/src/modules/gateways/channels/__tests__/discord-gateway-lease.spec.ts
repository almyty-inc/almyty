import {
  DiscordGatewayTransport,
  DiscordLeaseRedis,
  DiscordSocket,
} from '../discord-gateway.transport';
import { Gateway, GatewayStatus, GatewayType } from '../../../../entities/gateway.entity';

/**
 * Multi-replica safety for the discord Gateway transport. Staging runs
 * two api replicas; each bootstraps the same active discord gateways,
 * so without coordination every MESSAGE_CREATE would be processed once
 * per replica (duplicate agent runs). These tests drive two transport
 * instances against one fake redis and assert the lease protocol:
 * only the holder connects, a dead holder is replaced after its lease
 * expires, a graceful stop hands over promptly, and the no-redis
 * setup keeps the old single-instance connect-immediately behavior.
 *
 * jest modern fake timers also fake Date.now(), so the fake redis can
 * honor PX TTLs against the same clock the lease timers run on.
 */

class FakeSocket implements DiscordSocket {
  closedWith: number | null = null;
  private listeners = new Map<string, Array<(...args: any[]) => void>>();
  on(event: string, listener: (...args: any[]) => void): void {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
  }
  send(): void {}
  close(code?: number): void {
    this.closedWith = code ?? 1000;
  }
}

class FakeRedis implements DiscordLeaseRedis {
  store = new Map<string, { value: string; expiresAt: number }>();
  setCalls = 0;

  private live(key: string): { value: string; expiresAt: number } | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() >= entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry;
  }

  async set(key: string, value: string, _px: 'PX', ttl: number, _nx: 'NX'): Promise<'OK' | null> {
    this.setCalls += 1;
    if (this.live(key)) return null;
    this.store.set(key, { value, expiresAt: Date.now() + ttl });
    return 'OK';
  }

  async get(key: string): Promise<string | null> {
    return this.live(key)?.value ?? null;
  }

  async del(key: string): Promise<number> {
    return this.store.delete(key) ? 1 : 0;
  }

  async pexpire(key: string, ttl: number): Promise<number> {
    const entry = this.live(key);
    if (!entry) return 0;
    entry.expiresAt = Date.now() + ttl;
    return 1;
  }
}

describe('DiscordGatewayTransport — distributed lease', () => {
  const GATEWAY_ID = 'gw-discord-lease';
  const LEASE_KEY = `almyty:discord:gateway-lease:${GATEWAY_ID}`;

  let redis: FakeRedis;

  const gateway = () =>
    ({
      id: GATEWAY_ID,
      type: GatewayType.DISCORD,
      status: GatewayStatus.ACTIVE,
      organizationId: 'org-1',
      configuration: { bot_token: 'token-abc' },
    } as unknown as Gateway);

  const makeTransport = (withRedis = true) => {
    const sockets: FakeSocket[] = [];
    const transport = new DiscordGatewayTransport(
      { find: jest.fn().mockResolvedValue([]) } as any,
      { handleInboundMessage: jest.fn().mockResolvedValue(undefined) } as any,
      withRedis ? redis : undefined,
    );
    transport.socketFactory = () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    };
    transport.random = () => 0.5;
    return { transport, sockets };
  };

  const flush = () => jest.advanceTimersByTimeAsync(0);

  beforeEach(() => {
    jest.useFakeTimers();
    redis = new FakeRedis();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('connects immediately when no redis is configured (single-instance mode)', () => {
    const { transport, sockets } = makeTransport(false);
    transport.start(gateway());
    expect(sockets).toHaveLength(1);
    expect(transport.activeConnectionCount).toBe(1);
    transport.onModuleDestroy();
  });

  it('only the lease holder connects when two replicas start the same gateway', async () => {
    const a = makeTransport();
    const b = makeTransport();

    a.transport.start(gateway());
    await flush();
    b.transport.start(gateway());
    await flush();

    expect(a.sockets).toHaveLength(1);
    expect(b.sockets).toHaveLength(0);
    expect(redis.store.get(LEASE_KEY)?.value).toBe(a.transport.instanceId);

    // The holder renews (ttl/3 = 10s); the loser polls (ttl/2 = 15s)
    // and keeps losing while the lease is alive.
    await jest.advanceTimersByTimeAsync(45_000);
    expect(a.sockets).toHaveLength(1);
    expect(b.sockets).toHaveLength(0);
    expect(redis.store.get(LEASE_KEY)?.value).toBe(a.transport.instanceId);

    a.transport.onModuleDestroy();
    b.transport.onModuleDestroy();
  });

  it('a polling replica takes over after the holder dies and its lease expires', async () => {
    const a = makeTransport();
    const b = makeTransport();

    a.transport.start(gateway());
    await flush();
    b.transport.start(gateway());
    await flush();
    expect(a.sockets).toHaveLength(1);
    expect(b.sockets).toHaveLength(0);

    // Simulate a crash: the holder vanishes WITHOUT releasing its
    // lease (releaseLease stubbed out) — only the TTL can free it.
    (a.transport as any).releaseLease = jest.fn().mockResolvedValue(undefined);
    a.transport.onModuleDestroy();

    // Lease was last renewed at some point < ttl ago; after at most
    // ttl + poll interval the loser's SET NX must succeed.
    await jest.advanceTimersByTimeAsync(45_000);

    expect(b.sockets).toHaveLength(1);
    expect(redis.store.get(LEASE_KEY)?.value).toBe(b.transport.instanceId);

    b.transport.onModuleDestroy();
  });

  it('a graceful stop releases the lease so the other replica takes over on its next poll', async () => {
    const a = makeTransport();
    const b = makeTransport();

    a.transport.start(gateway());
    await flush();
    b.transport.start(gateway());
    await flush();

    a.transport.stop(GATEWAY_ID);
    await flush();
    expect(redis.store.has(LEASE_KEY)).toBe(false);

    // b's next acquisition poll (ttl/2 = 15s) picks the gateway up.
    await jest.advanceTimersByTimeAsync(15_000);
    expect(b.sockets).toHaveLength(1);
    expect(redis.store.get(LEASE_KEY)?.value).toBe(b.transport.instanceId);

    b.transport.onModuleDestroy();
  });

  it('disconnects and re-enters polling when the lease is lost to another instance', async () => {
    const a = makeTransport();
    a.transport.start(gateway());
    await flush();
    expect(a.sockets).toHaveLength(1);

    // Another instance steals the key (e.g. after a redis flush or an
    // operator intervention) — the renewal must detect the mismatch.
    redis.store.set(LEASE_KEY, { value: 'someone-else', expiresAt: Date.now() + 60_000 });
    await jest.advanceTimersByTimeAsync(10_000); // renewal tick (ttl/3)

    expect(a.sockets[0].closedWith).toBe(1000);
    // Back in acquisition mode: when the other holder goes away, we
    // reconnect.
    redis.store.delete(LEASE_KEY);
    await jest.advanceTimersByTimeAsync(15_000);
    expect(a.sockets).toHaveLength(2);

    a.transport.onModuleDestroy();
  });

  it('does not release another instance lease on stop (compare-and-delete)', async () => {
    const a = makeTransport();
    a.transport.start(gateway());
    await flush();

    // Lease expired and was re-acquired elsewhere while we were
    // stopping — stop() must not delete the new holder's key.
    redis.store.set(LEASE_KEY, { value: 'new-holder', expiresAt: Date.now() + 60_000 });
    a.transport.stop(GATEWAY_ID);
    await flush();

    expect(redis.store.get(LEASE_KEY)?.value).toBe('new-holder');
  });

  it('keeps polling instead of connecting when redis errors on acquire', async () => {
    const a = makeTransport();
    redis.set = jest.fn().mockRejectedValue(new Error('redis down'));

    a.transport.start(gateway());
    await flush();
    expect(a.sockets).toHaveLength(0);

    // Redis comes back: the next poll acquires and connects.
    redis.set = FakeRedis.prototype.set.bind(redis);
    await jest.advanceTimersByTimeAsync(15_000);
    expect(a.sockets).toHaveLength(1);

    a.transport.onModuleDestroy();
  });
});
