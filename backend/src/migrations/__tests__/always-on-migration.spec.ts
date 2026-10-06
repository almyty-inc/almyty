import { AlwaysOn1750813802000 } from '../1750813802000-AlwaysOn';

/**
 * Heartbeat becomes Always on: the column is renamed and each stored
 * heartbeat reshaped so its interval, prompt and pause carry over, and an
 * agent that had one keeps acting on its own as it did.
 */
describe('AlwaysOn migration', () => {
  function runner(rows: Array<{ id: string; alwaysOn: any }>) {
    const queries: Array<{ sql: string; params?: any[] }> = [];
    const updates = new Map<string, any>();
    return {
      queries,
      updates,
      query: jest.fn(async (sql: string, params?: any[]) => {
        queries.push({ sql, params });
        if (/^SELECT/.test(sql.trim())) return rows;
        if (/^UPDATE "agents"/.test(sql.trim()) && params) updates.set(params[0], params[1] ? JSON.parse(params[1]) : null);
        return [];
      }),
    };
  }

  it('renames the column, reshapes each heartbeat and creates the wake inbox', async () => {
    const qr = runner([
      { id: 'a1', alwaysOn: { enabled: true, intervalMinutes: 20, prompt: 'check the queue', pausedReason: { code: 'OWNER_CANNOT_RUN', message: 'm', detectedAt: 'd' } } },
      { id: 'a2', alwaysOn: JSON.stringify({ enabled: false, intervalMinutes: 'x', prompt: '' }) },
    ]);
    await new AlwaysOn1750813802000().up(qr as any);

    expect(qr.queries[0].sql).toBe('ALTER TABLE "agents" RENAME COLUMN "heartbeat" TO "alwaysOn"');
    expect(qr.updates.get('a1')).toEqual({
      enabled: true,
      brief: 'check the queue',
      wakeOn: { timer: { everyMinutes: 20 } },
      actMode: 'act',
      askFirstToolIds: [],
      reportTo: null,
      report: 'when_acted',
      pausedReason: { code: 'OWNER_CANNOT_RUN', message: 'm', detectedAt: 'd' },
    });
    expect(qr.updates.get('a2')).toMatchObject({ enabled: false, wakeOn: { timer: { everyMinutes: 60 } } });
    expect(qr.queries.some((q) => /CREATE TABLE IF NOT EXISTS "agent_wakes"/.test(q.sql))).toBe(true);
    expect(qr.queries.some((q) => /UNIQUE INDEX IF NOT EXISTS "UQ_agent_wakes_agent_dedupe"/.test(q.sql))).toBe(true);
  });

  it('goes back to a heartbeat', async () => {
    const qr = runner([{ id: 'a1', alwaysOn: { enabled: true, brief: 'b', wakeOn: { timer: { everyMinutes: 15 } } } }]);
    await new AlwaysOn1750813802000().down(qr as any);
    expect(qr.updates.get('a1')).toEqual({ enabled: true, intervalMinutes: 15, prompt: 'b' });
    expect(qr.queries[qr.queries.length - 1].sql).toBe('ALTER TABLE "agents" RENAME COLUMN "alwaysOn" TO "heartbeat"');
  });
});
