import { EventEmitter } from 'events';

import { McpChangeBus, toolsChangedChannel } from '../mcp-change-bus.service';
import { RecordingQueryBuilder, matchingRows, ExecutedQuery } from '../../gateways/__tests__/recording-query-builder';

/**
 * The change bus carries "this gateway's tools changed" from the pod that
 * made the change to the pod holding a client's subscriptions/listen stream,
 * and drops the gateway's cached tools/list pages first.
 */

/** One Redis shared by several pods: keys, SCAN MATCH, and pattern pub/sub. */
class SharedRedis {
  readonly store = new Map<string, string>();
  readonly wire = new EventEmitter();
  readonly published: Array<[string, string]> = [];

  client(): any {
    const shared = this;
    const listeners = new EventEmitter();
    const patterns: RegExp[] = [];
    let scanned: string[] = [];
    const onWire = (channel: string, message: string) => {
      for (const p of patterns) if (p.test(channel)) listeners.emit('pmessage', p.source, channel, message);
    };
    return {
      async scan(cursor: string, _m: 'MATCH', glob: string, _c: 'COUNT', _n: number) {
        const re = new RegExp(`^${glob.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
        // Two pages over the keys as they stood when the scan began, to
        // prove the loop follows the cursor.
        if (cursor === '0') scanned = [...shared.store.keys()].filter((k) => re.test(k)).sort();
        const half = Math.ceil(scanned.length / 2);
        return cursor === '0' ? ['17', scanned.slice(0, half)] : ['0', scanned.slice(half)];
      },
      async del(...keys: string[]) {
        let n = 0;
        for (const k of keys) n += shared.store.delete(k) ? 1 : 0;
        return n;
      },
      async publish(channel: string, message: string) {
        shared.published.push([channel, message]);
        shared.wire.emit('message', channel, message);
        return 1;
      },
      duplicate() {
        return shared.client();
      },
      async psubscribe(glob: string) {
        patterns.push(new RegExp(`^${glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*|\*/g, '.*')}$`));
        shared.wire.on('message', onWire);
      },
      on(event: string, fn: (...args: any[]) => void) {
        listeners.on(event, fn);
      },
      disconnect() {
        shared.wire.off('message', onWire);
      },
    };
  }
}

const GATEWAY_TOOLS = [
  { gatewayId: 'gw-1', toolId: 't-1' },
  { gatewayId: 'gw-2', toolId: 't-1' },
  { gatewayId: 'gw-2', toolId: 't-2' },
  { gatewayId: 'gw-3', toolId: 't-3' },
];

function gatewayToolRepo() {
  const builders: RecordingQueryBuilder[] = [];
  const repo: any = {
    builders,
    createQueryBuilder: jest.fn((alias: string) => {
      const qb = new RecordingQueryBuilder(alias, {
        getRawMany: (q: ExecutedQuery) => {
          const rows = matchingRows(q, GATEWAY_TOOLS, {
            'gt."toolId" IN (:...ids)': (row, p) => p.ids.includes(row.toolId),
          });
          return [...new Set(rows.map((r) => r.gatewayId))].map((gatewayId) => ({ gatewayId }));
        },
      });
      builders.push(qb);
      return qb;
    }),
  };
  return repo;
}

const tick = () => new Promise((r) => setImmediate(r));

describe('McpChangeBus', () => {
  it('names one channel per gateway', () => {
    expect(toolsChangedChannel('gw-1')).toBe('mcp:changed:gw-1');
  });

  it('delivers a change made on one pod to a listener on another', async () => {
    const redis = new SharedRedis();
    const podA = new McpChangeBus(gatewayToolRepo(), redis.client());
    const podB = new McpChangeBus(gatewayToolRepo(), redis.client());
    const heard: string[] = [];
    const stop = podB.onGatewayToolsChanged('gw-1', () => heard.push('gw-1'));
    podB.onGatewayToolsChanged('gw-2', () => heard.push('gw-2'));
    await tick();

    await podA.gatewayToolsChanged('gw-1');
    await tick();
    expect(redis.published).toEqual([['mcp:changed:gw-1', JSON.stringify({ kind: 'tools', gatewayId: 'gw-1' })]]);
    expect(heard).toEqual(['gw-1']);

    stop();
    await podA.gatewayToolsChanged('gw-1');
    await tick();
    expect(heard).toEqual(['gw-1']);
    await podA.onModuleDestroy();
    await podB.onModuleDestroy();
  });

  it("drops exactly the gateway's cached tools/list pages before publishing", async () => {
    const redis = new SharedRedis();
    for (const k of [
      'mcp:tools:org-1:gw-1:cursor:0',
      'mcp:tools:org-1:gw-1:cursor:50',
      'mcp:tools:org-1:gw-1:cursor:100',
      'mcp:tools:org-1:gw-10:cursor:0',
      'mcp:tools:org-1:gw-2:cursor:0',
      'other:gw-1',
    ]) {
      redis.store.set(k, '[]');
    }
    const bus = new McpChangeBus(gatewayToolRepo(), redis.client());
    await bus.gatewayToolsChanged('gw-1');
    expect([...redis.store.keys()].sort()).toEqual(['mcp:tools:org-1:gw-10:cursor:0', 'mcp:tools:org-1:gw-2:cursor:0', 'other:gw-1']);
  });

  it('tells every gateway a changed tool is attached to, and no other', async () => {
    const repo = gatewayToolRepo();
    const bus = new McpChangeBus(repo, undefined);
    const heard: string[] = [];
    for (const gw of ['gw-1', 'gw-2', 'gw-3']) bus.onGatewayToolsChanged(gw, () => heard.push(gw));

    await bus.toolsChanged(['t-1', 't-1', '']);
    expect(heard.sort()).toEqual(['gw-1', 'gw-2']);
    expect(repo.builders[0].executed[0].parameters).toEqual({ ids: ['t-1'] });

    heard.length = 0;
    await bus.toolsChanged([]);
    expect(repo.createQueryBuilder).toHaveBeenCalledTimes(1);
    expect(heard).toEqual([]);
  });

  it('delivers in-process without Redis', async () => {
    const bus = new McpChangeBus(gatewayToolRepo(), undefined);
    const heard = jest.fn();
    bus.onGatewayToolsChanged('gw-3', heard);
    await bus.gatewayToolsChanged('gw-3');
    expect(heard).toHaveBeenCalledTimes(1);
    expect(bus.listenerCount('gw-3')).toBe(1);
  });
});
