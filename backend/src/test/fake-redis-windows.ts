/**
 * FakeRedis plus the one Lua script the rate limiter sends.
 *
 * Not a `.spec.ts`, deliberately: jest collects `.*\.spec\.ts$`.
 *
 * `eval` is modelled for exactly BUMP_WINDOW_SCRIPT (INCR, then arm the
 * TTL if the key has none), executed atomically the way Redis runs a
 * script. Any other script throws: a double that answered an unknown
 * script would let a limiter change what it asks Redis and stay green.
 */
import { FakeRedis } from './fake-redis';
import { BUMP_WINDOW_SCRIPT } from '../modules/gateways/gateway-rate-limit.service';

const roundTrip = () => new Promise<void>((resolve) => setImmediate(resolve));

export class FakeRedisWithWindows extends FakeRedis {
  private readonly counters = new Map<string, { count: number; expiresAt: number | null }>();

  constructor(private readonly clock: () => number = () => Date.now()) {
    super(clock);
  }

  async eval(script: string, numKeys: number, key: string, seconds: string): Promise<number> {
    if (script !== BUMP_WINDOW_SCRIPT || numKeys !== 1) {
      throw new Error('fake redis: only the rate-limit window script is modelled');
    }
    let entry = this.counters.get(key);
    if (entry && entry.expiresAt !== null && entry.expiresAt <= this.clock()) entry = undefined;
    const count = (entry?.count ?? 0) + 1;
    const expiresAt = entry?.expiresAt ?? this.clock() + Number(seconds) * 1000;
    this.counters.set(key, { count, expiresAt });
    await roundTrip();
    return count;
  }

  /** Current count for a window key (for assertions). */
  counter(prefix: string): number {
    let total = 0;
    for (const [key, entry] of this.counters) if (key.startsWith(prefix)) total += entry.count;
    return total;
  }
}
