import { CollapseRunnerToolCopies1791001100000 } from '../1791001100000-CollapseRunnerToolCopies';

/**
 * With no copies to merge, the migration stops after finding none. The
 * history updates would otherwise scan usage_metrics and request_logs (no
 * toolId index, millions of rows), which kept a staging deploy past its
 * migration wait while there was nothing left to move.
 */
describe('CollapseRunnerToolCopies with nothing to merge', () => {
  const run = async (copies: number) => {
    const sql: string[] = [];
    const queryRunner = {
      query: jest.fn(async (text: string) => {
        sql.push(text);
        return /count\(\*\)::int AS copies/.test(text) ? [{ copies }] : [];
      }),
    };
    await new CollapseRunnerToolCopies1791001100000().up(queryRunner as any);
    return sql;
  };

  it('reads no history table and drops its work table', async () => {
    const sql = await run(0);
    const all = sql.join('\n');
    for (const table of ['usage_metrics', 'request_logs', 'tool_executions', 'approval_requests', 'gateway_tools']) {
      expect(all).not.toContain(table.includes('gateway') ? 'DELETE FROM gateway_tools' : `UPDATE ${table}`);
    }
    expect(all).not.toMatch(/DELETE FROM tools/);
    expect(sql[sql.length - 1]).toMatch(/DROP TABLE runner_tool_merge/);
  });

  it('still moves the history when there are copies', async () => {
    const all = (await run(3)).join('\n');
    expect(all).toContain('UPDATE usage_metrics');
    expect(all).toContain('UPDATE request_logs');
    expect(all).toMatch(/DELETE FROM tools/);
  });
});
