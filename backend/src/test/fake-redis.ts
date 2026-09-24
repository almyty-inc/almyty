/**
 * A truthful in-memory Redis for unit specs.
 *
 * Not a `.spec.ts`, deliberately: jest collects `.*\.spec\.ts$`.
 *
 * Each command takes effect on the "server" when it is sent and its reply
 * comes back a round trip later, the way a real client behaves across a
 * network. A double whose replies were synchronous would hide exactly the
 * check-then-act window an atomic command exists to close: two callers
 * that GET before either SETs both see "absent".
 *
 * Only the commands and options below are modelled. Anything else throws
 * rather than answering, so a spec cannot pass against a command this
 * double quietly ignores.
 */
const roundTrip = () => new Promise<void>((resolve) => setImmediate(resolve));

interface Entry {
  value: string;
  expiresAt: number | null;
}

export class FakeRedis {
  private readonly store = new Map<string, Entry>();
  /** Every command sent, for specs that assert on the wire. */
  readonly commands: Array<{ name: string; args: unknown[] }> = [];

  constructor(private readonly now: () => number = () => Date.now()) {}

  private live(key: string): Entry | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && entry.expiresAt <= this.now()) {
      this.store.delete(key);
      return null;
    }
    return entry;
  }

  /** Milliseconds left on a key, -1 for no expiry, -2 for absent. */
  pttlNow(key: string): number {
    const entry = this.live(key);
    if (!entry) return -2;
    return entry.expiresAt === null ? -1 : entry.expiresAt - this.now();
  }

  keys(): string[] {
    return [...this.store.keys()].filter((k) => this.live(k));
  }

  /** SET key value [PX ms | EX s] [NX]. */
  async set(key: string, value: string, ...options: Array<string | number>): Promise<'OK' | null> {
    this.commands.push({ name: 'set', args: [key, value, ...options] });
    let ttlMs: number | null = null;
    let nx = false;
    for (let i = 0; i < options.length; i++) {
      const opt = String(options[i]).toUpperCase();
      if (opt === 'NX') nx = true;
      else if (opt === 'PX') ttlMs = Number(options[++i]);
      else if (opt === 'EX') ttlMs = Number(options[++i]) * 1000;
      else throw new Error(`fake redis: SET option ${opt} is not modelled`);
    }
    if (ttlMs !== null && (!Number.isFinite(ttlMs) || ttlMs <= 0)) {
      // Real Redis refuses a zero or negative expiry outright.
      await roundTrip();
      throw new Error('ERR invalid expire time in set');
    }
    let reply: 'OK' | null = 'OK';
    if (nx && this.live(key)) {
      reply = null;
    } else {
      this.store.set(key, { value: String(value), expiresAt: ttlMs === null ? null : this.now() + ttlMs });
    }
    await roundTrip();
    return reply;
  }

  async get(key: string): Promise<string | null> {
    this.commands.push({ name: 'get', args: [key] });
    const value = this.live(key)?.value ?? null;
    await roundTrip();
    return value;
  }

  /** GETDEL key: the value, removed in the same step, or null. */
  async getdel(key: string): Promise<string | null> {
    this.commands.push({ name: 'getdel', args: [key] });
    const value = this.live(key)?.value ?? null;
    this.store.delete(key);
    await roundTrip();
    return value;
  }

  async del(...keys: string[]): Promise<number> {
    this.commands.push({ name: 'del', args: keys });
    let removed = 0;
    for (const key of keys) if (this.live(key) && this.store.delete(key)) removed++;
    await roundTrip();
    return removed;
  }
}
