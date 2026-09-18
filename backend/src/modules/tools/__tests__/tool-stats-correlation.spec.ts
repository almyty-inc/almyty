import { ToolStatsHelper } from '../tool-stats.helper';
import { runWithRequestContext } from '../../../common/request-context';

/**
 * A tool_executions row and the thing that caused it.
 *
 * `gatewayId` has been a column on this table all along with nothing
 * populating it, and there was no `runId` column at all — so an
 * `agent_runs` step and the tool execution it made could not be joined.
 * "The agent said the lookup failed" had no path to the row holding the
 * parameters, the upstream status and the error text.
 */
describe('ToolStatsHelper.recordExecution — correlation', () => {
  let toolExecutionRepository: { create: jest.Mock; save: jest.Mock };
  let toolRepository: any;
  let auditLogService: any;
  let helper: ToolStatsHelper;

  const tool = { id: 'tool-1', name: 'lookup' } as any;
  const result = { success: true, data: { ok: true }, executionTime: 12, cached: false, rateLimited: false, retryCount: 0 } as any;
  const meta = { cached: false, executionTime: 12, retryCount: 0 };

  const created = () => toolExecutionRepository.create.mock.calls[0][0];

  beforeEach(() => {
    toolExecutionRepository = {
      create: jest.fn((v) => v),
      save: jest.fn().mockResolvedValue({}),
    };
    toolRepository = {
      createQueryBuilder: jest.fn(() => ({
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: 1 }),
      })),
    };
    auditLogService = { logToolExecution: jest.fn() };
    helper = new ToolStatsHelper(
      toolRepository as any,
      toolExecutionRepository as any,
      auditLogService as any,
    );
    jest.spyOn((helper as any).logger, 'error').mockImplementation(() => undefined);
  });

  it('stamps the run, the node and the gateway from the correlation scope', async () => {
    await runWithRequestContext(
      {
        requestId: 'req-1',
        runId: 'run-9',
        nodeId: 'tool_2',
        gatewayId: 'gw-3',
      },
      () =>
        helper.recordExecution(tool, { q: 'x' }, result, { userId: 'u1', organizationId: 'org-1' }, meta),
    );

    const row = created();
    expect(row.runId).toBe('run-9');
    expect(row.gatewayId).toBe('gw-3');
    expect(row.metadata.nodeId).toBe('tool_2');
    expect(row.metadata.requestId).toBe('req-1');
  });

  it('lets an explicit option win over the scope', async () => {
    await runWithRequestContext({ requestId: 'req-1', runId: 'run-9', gatewayId: 'gw-3' }, () =>
      helper.recordExecution(
        tool,
        {},
        result,
        { userId: 'u1', organizationId: 'org-1', gatewayId: 'gw-explicit', runId: 'run-explicit' },
        meta,
      ),
    );

    expect(created().gatewayId).toBe('gw-explicit');
    expect(created().runId).toBe('run-explicit');
  });

  it('records nulls, not undefined, for a call with no run or gateway', async () => {
    await helper.recordExecution(tool, {}, result, { userId: 'u1', organizationId: 'org-1' }, meta);

    // A manual test from the dashboard has neither; the columns are
    // nullable and must be written as null.
    expect(created().runId).toBeNull();
    expect(created().gatewayId).toBeNull();
  });

  it("prefers the upstream API's own request id when it returned one", async () => {
    await runWithRequestContext({ requestId: 'ours' }, () =>
      helper.recordExecution(
        tool,
        {},
        { ...result, metadata: { requestId: 'theirs', httpStatus: 200 } },
        { userId: 'u1', organizationId: 'org-1' },
        meta,
      ),
    );

    expect(created().metadata.requestId).toBe('theirs');
  });
});
