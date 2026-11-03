/**
 * Redis streams in memory, for unit specs of the live run streams
 * (agent-runtime-events.helper.ts): XADD, XREVRANGE, a blocking XREAD over
 * several keys, EXPIRE, and `duplicate()` sharing the same data the way a
 * second connection to one server does.
 *
 * Not a `.spec.ts`, deliberately: jest collects `.*\.spec\.ts$`.
 */
type Entry = [string, string[]];

export function fakeRedisStreams() {
  const streams = new Map<string, Entry[]>();
  const waiters = new Set<() => void>();
  let counter = 0;
  /** Make the next XADD to a key matching this fail, once per match (a lost announcement). */
  let failNext: RegExp | null = null;

  const idNumber = (id: string) => Number(String(id).split('-')[0]);
  const after = (key: string, id: string) => (streams.get(key) ?? []).filter(([eid]) => idNumber(eid) > idNumber(id));

  const client: any = {
    streams,
    failNextAddTo(pattern: RegExp) {
      failNext = pattern;
    },
    xadd: jest.fn(async (key: string, ...args: any[]) => {
      if (failNext && failNext.test(key)) {
        failNext = null;
        throw new Error('connection reset');
      }
      let i = 0;
      if (args[0] === 'MAXLEN') i += 3;
      i++; // '*'
      const fields = args.slice(i).map(String);
      const id = `${++counter}-0`;
      if (!streams.has(key)) streams.set(key, []);
      streams.get(key)!.push([id, fields]);
      for (const wake of [...waiters]) wake();
      return id;
    }),
    expire: jest.fn(async () => 1),
    xrevrange: jest.fn(async (key: string) => {
      const list = streams.get(key) ?? [];
      return list.length ? [list[list.length - 1]] : [];
    }),
    xread: jest.fn(async (...args: any[]) => {
      let block: number | null = null;
      let i = 0;
      while (args[i] !== 'STREAMS') {
        if (args[i] === 'BLOCK') block = Number(args[i + 1]);
        i += 2;
      }
      const rest = args.slice(i + 1);
      const keys = rest.slice(0, rest.length / 2);
      const ids = rest.slice(rest.length / 2);
      const collect = () => {
        const out: Array<[string, Entry[]]> = [];
        keys.forEach((key: string, k: number) => {
          const found = after(key, ids[k]);
          if (found.length) out.push([key, found]);
        });
        return out.length ? out : null;
      };
      const now = collect();
      if (now || block === null) return now;
      return new Promise((resolve) => {
        const wake = () => {
          const found = collect();
          if (!found) return;
          clearTimeout(timer);
          waiters.delete(wake);
          resolve(found);
        };
        const timer = setTimeout(() => {
          waiters.delete(wake);
          resolve(null);
        }, block);
        waiters.add(wake);
      });
    }),
    disconnect: jest.fn(),
  };
  client.duplicate = () => client;
  return client;
}
