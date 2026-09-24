import { HttpException } from '@nestjs/common';

import { ToolExecutorService } from '../tool-executor.service';
import { ToolsController } from '../tools.controller';
import { ToolsStatsHelper } from '../tools-stats.helper';
import { ToolStatus } from '../../../entities/tool.entity';
import { fakeRepository, FakeRepository } from '../../../test/fake-repository';

/**
 * Three tool lookups the tenancy audit had not reached, each keyed by an
 * id that can name a row in another organization. Their existing doubles
 * answered a canned row whatever the `where` said (or were never called
 * with a foreign id), so the `organizationId` in each could be deleted
 * with the suite green. Here the tables are real and hold a row in each
 * organization.
 */
const ORG = 'org-1';
const OTHER_ORG = 'org-2';

describe('ToolExecutorService error path records only against the caller org', () => {
  let tools: FakeRepository<any>;
  let stats: { recordExecution: jest.Mock };
  let executor: ToolExecutorService;

  beforeEach(() => {
    tools = fakeRepository<any>([
      { id: 'tool-theirs', organizationId: OTHER_ORG, status: ToolStatus.ACTIVE },
      { id: 'tool-mine-inactive', organizationId: ORG, status: ToolStatus.INACTIVE },
    ]);
    stats = { recordExecution: jest.fn().mockResolvedValue(undefined) };
    // Positional, as the other executor harnesses construct it. Nothing
    // past the tool load is reached on these paths.
    executor = new ToolExecutorService(
      tools as any,
      fakeRepository<any>() as any,
      fakeRepository<any>() as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      stats as any,
      {} as any,
      {} as any,
      {} as any,
      fakeRepository<any>() as any,
    );
  });

  it("records a failed run of the caller's own tool", async () => {
    const result = await executor.executeTool('tool-mine-inactive', {}, { organizationId: ORG } as any);

    expect(result.success).toBe(false);
    expect(stats.recordExecution).toHaveBeenCalledTimes(1);
    expect(stats.recordExecution.mock.calls[0][0].id).toBe('tool-mine-inactive');
  });

  it("does not load another organization's tool to record the failure against it", async () => {
    const result = await executor.executeTool('tool-theirs', {}, { organizationId: ORG } as any);

    expect(result).toMatchObject({ success: false, error: 'Tool not found' });
    expect(stats.recordExecution).not.toHaveBeenCalled();
  });
});

describe('ToolsController.generateToolsFromApi reads the API in the caller org', () => {
  let generator: { generateToolsFromApi: jest.Mock };
  let controller: ToolsController;

  beforeEach(() => {
    const apis = fakeRepository<any>([
      { id: 'api-theirs', organizationId: OTHER_ORG, name: 'Theirs' },
      { id: 'api-mine', organizationId: ORG, name: 'Mine' },
    ]);
    generator = {
      generateToolsFromApi: jest.fn(async () => ({ tools: [], summary: { generated: 0 } })),
    };
    controller = new ToolsController(
      { apiRepository: apis } as any,
      generator as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
  });

  it("generates from the caller's own API", async () => {
    await controller.generateToolsFromApi(ORG, 'api-mine', {} as any, {});

    expect(generator.generateToolsFromApi).toHaveBeenCalledTimes(1);
    expect(generator.generateToolsFromApi.mock.calls[0][0].id).toBe('api-mine');
  });

  it("answers 404 for another organization's API and generates nothing", async () => {
    const error = await controller.generateToolsFromApi(ORG, 'api-theirs', {} as any, {}).catch((e) => e);

    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(404);
    expect(generator.generateToolsFromApi).not.toHaveBeenCalled();
  });
});

describe('ToolsStatsHelper top tools are named from the caller org only', () => {
  it("does not load another organization's tool into topUsedTools", async () => {
    const tools = fakeRepository<any>([
      { id: 'tool-mine', organizationId: ORG, name: 'Mine' },
      { id: 'tool-theirs', organizationId: OTHER_ORG, name: 'Theirs' },
    ]);
    // The status rollup; its clauses are not what this spec is about.
    (tools as any).createQueryBuilder = () => chain({ getRawMany: [] });

    // The execution rollups, as the database would answer them for ORG.
    // An execution row carries its own organizationId and a toolId; the
    // tool it names is resolved separately, and that second read is the
    // one under test. Here one ORG execution names a tool id that lives
    // in OTHER_ORG.
    const executions = {
      createQueryBuilder: jest
        .fn()
        .mockReturnValueOnce(chain({ getRawOne: { count: '3', avg: '10' } }))
        .mockReturnValueOnce(
          chain({
            getRawMany: [
              { toolId: 'tool-mine', count: '2' },
              { toolId: 'tool-theirs', count: '1' },
            ],
          }),
        ),
    };

    const helper = new ToolsStatsHelper(tools as any, executions as any);
    const result = await helper.getOrganizationToolStats(ORG, 'user-1');

    expect(result.topUsedTools.map((t) => t.tool.id)).toEqual(['tool-mine']);
    expect(result.topUsedTools.map((t) => t.tool.name)).not.toContain('Theirs');
  });
});

/**
 * A query-builder stand-in that answers one terminal call with a fixed
 * value. Only used for rollups whose clauses this spec does not assert on.
 */
function chain(terminal: { getRawOne?: any; getRawMany?: any[] }) {
  const qb: any = {};
  for (const m of ['select', 'addSelect', 'where', 'andWhere', 'groupBy', 'orderBy', 'limit']) {
    qb[m] = () => qb;
  }
  qb.getRawOne = async () => {
    if (!('getRawOne' in terminal)) throw new Error('unexpected getRawOne');
    return terminal.getRawOne;
  };
  qb.getRawMany = async () => {
    if (!('getRawMany' in terminal)) throw new Error('unexpected getRawMany');
    return terminal.getRawMany;
  };
  return qb;
}
