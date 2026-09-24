import { BadRequestException } from '@nestjs/common';

import { Not } from 'typeorm';

import { Organization } from '../../../entities/organization.entity';
import { Tool, ToolStatus } from '../../../entities/tool.entity';
import { GatewayStatus } from '../../../entities/gateway.entity';
import { ApiStatus } from '../../../entities/api.entity';
import { fakeManager, fakeRepository } from '../../../test/fake-repository';
import { ToolsService } from '../tools.service';
import { ToolsOperationHelper } from '../tools-operation.helper';
import { ToolGeneratorService } from '../tool-generator.service';
import { ApisToolGeneratorHelper } from '../../apis/apis-tool-generator.helper';
import { McpSourcesService } from '../../mcp-sources/mcp-sources.service';
import { ToolHubService } from '../../tool-hub/tool-hub.service';
import { RunnerCapabilityPublisher } from '../../runner/runner-capability.publisher';
import {
  MAX_GENERATED_DESCRIPTION_LENGTH,
  MAX_TOOLS_PER_SCHEMA,
  ToolQuotaExceededException,
  assertToolQuota,
  capGeneratedDescription,
  countLiveTools,
  precheckToolQuota,
  withToolQuota,
} from '../tool-quota';
import { QuotaLockRequiresTransactionError } from '../../../common/quota/org-quota-lock';

/**
 * Exploit-shaped: an organization sitting exactly at `settings.maxTools`
 * tries to add more tools through every path that inserts Tool rows.
 *
 * Before the fix only manual creation checked the limit, and that check
 * read the never-loaded `organization.tools` relation, so it passed too.
 * The organization rows below are loaded the way production loads them:
 * plain columns, no `tools` relation.
 */
const ORG = 'org-1';
const MB = 1024 * 1024;

/**
 * A fake EntityManager for the quota helper. `current` is what
 * COUNT(*) FROM tools WHERE organizationId returns; a count with a
 * narrower filter (by name / operationId: "which of these already
 * exist") returns `existing`.
 */
function quotaManager(opts: { maxTools?: number; current: number; existing?: number }) {
  const org = Object.assign(new Organization(), {
    id: ORG,
    settings: opts.maxTools ? { maxTools: opts.maxTools } : {},
  });
  const orgRepo = { findOne: jest.fn().mockResolvedValue(org) };
  const count = jest.fn(async (o: any) => {
    const where = o?.where ?? {};
    return where.name !== undefined || where.operationId !== undefined ? opts.existing ?? 0 : opts.current;
  });
  // The mocked Tool repository a service under test writes through; the
  // transaction's Tool repository forwards its writes there.
  let tools: Record<string, unknown> = {};
  const toolRepo = () => ({ ...tools, count });
  const lock = jest.fn(async (_sql: string, _params?: unknown[]) => []);
  const getRepository = jest.fn((entity: unknown) => (entity === Organization ? orgRepo : toolRepo()));
  const tx: any = { queryRunner: { isTransactionActive: true }, query: lock, getRepository };
  const manager: any = { getRepository, transaction: jest.fn(async (cb: any) => cb(tx)) };
  const bindTools = (repo: Record<string, unknown>) => {
    tools = repo;
    return manager;
  };
  return { manager, tx, org, count, lock, bindTools };
}

const atLimit = () => quotaManager({ maxTools: 5, current: 5 });

describe('assertToolQuota', () => {
  it('counts with a real query, not the organization.tools relation', async () => {
    const { tx, org, count } = atLimit();
    expect(org.tools).toBeUndefined();
    await expect(assertToolQuota(tx, ORG)).rejects.toBeInstanceOf(ToolQuotaExceededException);
    expect(count).toHaveBeenCalledWith({ where: { organizationId: ORG, status: Not(ToolStatus.DELETED) } });
  });

  it('is a 400 like the API limit', async () => {
    const { tx } = atLimit();
    await expect(assertToolQuota(tx, ORG)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a batch larger than what remains, naming the numbers', async () => {
    const { tx } = quotaManager({ maxTools: 10, current: 8 });
    await expect(assertToolQuota(tx, ORG, 2)).resolves.toBeUndefined();
    await expect(assertToolQuota(tx, ORG, 3)).rejects.toThrow('this would add 3 tools and only 2 remain');
  });

  it('lets an organization without a limit through, without locking', async () => {
    const { tx, lock } = quotaManager({ current: 10_000 });
    await expect(assertToolQuota(tx, ORG, 500)).resolves.toBeUndefined();
    expect(lock).not.toHaveBeenCalled();
  });

  it('takes the per-organization lock before it counts', async () => {
    const { tx, lock, count } = quotaManager({ maxTools: 10, current: 1 });
    await assertToolQuota(tx, ORG, 1);
    expect(lock).toHaveBeenCalledWith('SELECT pg_advisory_xact_lock(hashtext($1))', [`quota:tools:${ORG}`]);
    expect(lock.mock.invocationCallOrder[0]).toBeLessThan(count.mock.invocationCallOrder[0]);
  });

  it('refuses to run outside a transaction, where the lock would serialise nothing', async () => {
    const { manager } = quotaManager({ maxTools: 10, current: 1 });
    await expect(assertToolQuota(manager, ORG)).rejects.toBeInstanceOf(QuotaLockRequiresTransactionError);
  });
  it("does not count soft-deleted tools against the limit", async () => {
    // Real rows, evaluated by the shared fake: deleting a tool sets
    // status = deleted and keeps the row. An organization at maxTools
    // that deletes one must get the slot back.
    const orgs = fakeRepository<any>([{ id: ORG, settings: { maxTools: 3 } }]);
    const tools = fakeRepository<any>([
      { organizationId: ORG, name: "a", status: ToolStatus.ACTIVE },
      { organizationId: ORG, name: "b", status: ToolStatus.DRAFT },
      { organizationId: ORG, name: "c", status: ToolStatus.DELETED },
      { organizationId: "other-org", name: "d", status: ToolStatus.ACTIVE },
    ]);
    const tx: any = Object.assign(fakeManager([[Organization, orgs], [Tool, tools]]), {
      queryRunner: { isTransactionActive: true },
      query: jest.fn(async () => []),
    });
    await expect(countLiveTools(tx, ORG)).resolves.toBe(2);
    await expect(assertToolQuota(tx, ORG, 1)).resolves.toBeUndefined();
    await expect(assertToolQuota(tx, ORG, 2)).rejects.toThrow("this would add 2 tools and only 1 remain");
    await expect(precheckToolQuota(tx, ORG, 1)).resolves.toBeUndefined();
  });

  it("gateways and APIs are hard-deleted, so their quotas count every row", () => {
    // If either grows a soft-delete status, its quota count must learn to
    // skip it the way countLiveTools does.
    expect(Object.values(GatewayStatus)).not.toContain("deleted");
    expect(Object.values(ApiStatus)).not.toContain("deleted");
  });
});

describe('withToolQuota', () => {
  it('runs the check and the insert in one transaction, check first', async () => {
    const { manager, tx, lock } = quotaManager({ maxTools: 10, current: 1 });
    const insert = jest.fn(async (t: unknown) => t);
    await expect(withToolQuota(manager, ORG, 1, insert)).resolves.toBe(tx);
    expect(manager.transaction).toHaveBeenCalledTimes(1);
    expect(lock.mock.invocationCallOrder[0]).toBeLessThan(insert.mock.invocationCallOrder[0]);
  });

  it('joins a transaction the caller already owns', async () => {
    const { tx } = quotaManager({ maxTools: 10, current: 1 });
    tx.transaction = jest.fn();
    await withToolQuota(tx, ORG, 1, async () => undefined);
    expect(tx.transaction).not.toHaveBeenCalled();
  });

  it('does not run the insert when the quota refuses', async () => {
    const { manager } = atLimit();
    const insert = jest.fn();
    await expect(withToolQuota(manager, ORG, 1, insert)).rejects.toBeInstanceOf(ToolQuotaExceededException);
    expect(insert).not.toHaveBeenCalled();
  });
});

describe('precheckToolQuota', () => {
  it('checks without a transaction or a lock', async () => {
    const { manager, lock } = atLimit();
    await expect(precheckToolQuota(manager, ORG)).rejects.toBeInstanceOf(ToolQuotaExceededException);
    expect(lock).not.toHaveBeenCalled();
    expect(manager.transaction).not.toHaveBeenCalled();
  });
});

describe('capGeneratedDescription', () => {
  it('truncates a 1MB description with an ellipsis', () => {
    const out = capGeneratedDescription('x'.repeat(MB));
    expect(out).toHaveLength(MAX_GENERATED_DESCRIPTION_LENGTH);
    expect(out.endsWith('…')).toBe(true);
  });

  it('leaves short and missing descriptions alone', () => {
    expect(capGeneratedDescription('short')).toBe('short');
    expect(capGeneratedDescription(undefined)).toBeUndefined();
    expect(capGeneratedDescription(null)).toBeNull();
  });
});

describe('manual create (ToolsService.createTool)', () => {
  function build(quota: ReturnType<typeof quotaManager>) {
    const toolRepo: any = {
      get manager() { return quota.bindTools(this); },
      create: jest.fn((x: any) => ({ id: 't-new', ...x })),
      save: jest.fn(async (x: any) => x),
    };
    const service = new ToolsService(
      toolRepo,
      { create: jest.fn((x: any) => x), save: jest.fn(async (x: any) => x) } as any,
      { find: jest.fn().mockResolvedValue([]) } as any,
      {} as any,
      {} as any,
      { findOne: jest.fn() } as any,
      {} as any,
      { findOne: jest.fn().mockResolvedValue({ id: 'u-1', hasPermissionInOrganization: () => true }) } as any,
      { findOne: jest.fn().mockResolvedValue(quota.org) } as any,
      { logCreate: jest.fn() } as any,
      {} as any,
      {} as any,
      { assertCanScopeToTeam: jest.fn().mockResolvedValue(undefined) } as any,
    );
    return { service, toolRepo };
  }

  it('refuses a tool when the organization is at its limit', async () => {
    const { service, toolRepo } = build(atLimit());
    await expect(
      service.createTool({ name: 'one_more', description: 'd', type: 'function' } as any, ORG, 'u-1'),
    ).rejects.toBeInstanceOf(ToolQuotaExceededException);
    expect(toolRepo.save).not.toHaveBeenCalled();
  });
});

describe('schema import (ApisToolGeneratorHelper.generateToolsFromApi)', () => {
  const op = (i: number, extra: Record<string, unknown> = {}) =>
    ({ id: `op-${i}`, name: `op${i}`, operationId: `op${i}`, method: 'get', endpoint: `/r${i}`, isActive: true, ...extra }) as any;

  function build(quota: ReturnType<typeof quotaManager>) {
    // The batch is written through the quota transaction's Tool repository.
    const written: any = { find: jest.fn(async () => []), save: jest.fn(async (rows: any) => rows) };
    const apiRepo: any = {
      manager: quota.bindTools(written),
      findOne: jest.fn().mockResolvedValue({ id: 'api-1', name: 'Petstore', organizationId: ORG }),
    };
    const toolsService: any = {
      findByName: jest.fn().mockResolvedValue(null),
      buildFromOperation: jest.fn(async (o: any, x: any) => ({ operationId: o.id, ...x })),
      prepareUpdateFromOperation: jest.fn(async (t: any, _o: any, x: any) => ({ ...t, ...x })),
      createToolVersion: jest.fn(async () => undefined),
    };
    const helper = new ApisToolGeneratorHelper(apiRepo, toolsService, {} as any);
    return { helper, toolsService, written };
  }

  it('refuses a schema whose new tools do not fit, before writing any', async () => {
    const { helper, toolsService, written } = build(atLimit());
    await expect(helper.generateToolsFromApi('api-1', ORG, [op(1), op(2), op(3)])).rejects.toBeInstanceOf(
      ToolQuotaExceededException,
    );
    expect(toolsService.buildFromOperation).not.toHaveBeenCalled();
    expect(written.save).not.toHaveBeenCalled();
  });

  it('refuses the whole batch when the slots are gone by the time it is written', async () => {
    // The unlocked precheck sees room (3 of 5 used, 2 new); a concurrent
    // import takes a slot before the write, and the locked check at write
    // time refuses. Row by row, the first tool would have landed and the
    // import stopped partway; now nothing is written.
    const quota = quotaManager({ maxTools: 5, current: 3 });
    const { helper, written, toolsService } = build(quota);
    quota.count.mockResolvedValueOnce(0).mockResolvedValueOnce(3).mockResolvedValue(4);
    await expect(helper.generateToolsFromApi('api-1', ORG, [op(1), op(2)])).rejects.toThrow(
      'this would add 2 tools and only 1 remain',
    );
    expect(toolsService.buildFromOperation).toHaveBeenCalledTimes(2);
    expect(written.save).not.toHaveBeenCalled();
    expect(quota.lock).toHaveBeenCalled();
  });

  it('still re-imports a schema whose tools all exist already (no new rows)', async () => {
    const { helper, toolsService, written } = build(quotaManager({ maxTools: 5, current: 5, existing: 2 }));
    toolsService.findByName.mockResolvedValue({ id: 't-existing' });
    const result = await helper.generateToolsFromApi('api-1', ORG, [op(1), op(2)]);
    expect(result.generated).toBe(2);
    expect(toolsService.buildFromOperation).not.toHaveBeenCalled();
    expect(written.save).toHaveBeenCalledTimes(1);
  });

  it(`refuses a schema with more than ${MAX_TOOLS_PER_SCHEMA} operations`, async () => {
    const { helper, toolsService } = build(quotaManager({ current: 0 }));
    const ops = Array.from({ length: MAX_TOOLS_PER_SCHEMA + 1 }, (_, i) => op(i));
    await expect(helper.generateToolsFromApi('api-1', ORG, ops)).rejects.toThrow(
      `would produce ${MAX_TOOLS_PER_SCHEMA + 1} tools`,
    );
    expect(toolsService.buildFromOperation).not.toHaveBeenCalled();
  });

  it('truncates a 1MB operation description', async () => {
    const { helper, toolsService } = build(quotaManager({ current: 0 }));
    await helper.generateToolsFromApi('api-1', ORG, [op(1, { description: 'd'.repeat(MB) })]);
    const { description } = toolsService.buildFromOperation.mock.calls[0][1];
    expect(description).toHaveLength(MAX_GENERATED_DESCRIPTION_LENGTH);
  });
});

describe('ToolsService.createFromOperation (ToolsOperationHelper)', () => {
  it('refuses a row when the organization is at its limit', async () => {
    const quota = atLimit();
    const toolRepo: any = {
      get manager() { return quota.bindTools(this); },
      create: jest.fn((x: any) => x),
      save: jest.fn(async (x: any) => x),
    };
    const opRepo: any = {
      findOne: jest.fn().mockResolvedValue({ id: 'op-1', name: 'op', parameters: [], api: { id: 'api-1', name: 'A' } }),
    };
    const helper = new ToolsOperationHelper(toolRepo, opRepo, {} as any, { createToolVersion: jest.fn() } as any);
    jest.spyOn(helper, 'generateToolParametersFromOperation').mockResolvedValue({});
    await expect(
      helper.createFromOperation({ id: 'op-1' } as any, { name: 'n', description: 'd', organizationId: ORG }),
    ).rejects.toBeInstanceOf(ToolQuotaExceededException);
    expect(toolRepo.save).not.toHaveBeenCalled();
  });
});

describe('generate-from-api (ToolGeneratorService.generateToolsFromApi)', () => {
  const api = { id: 'api-1', name: 'Petstore', organizationId: ORG, type: 'openapi' } as any;
  const op = (i: number) =>
    ({ id: `op-${i}`, name: `op${i}`, method: 'get', endpoint: `/r${i}`, isReadOperation: () => true }) as any;

  function build(quota: ReturnType<typeof quotaManager>, ops: any[]) {
    const toolRepo: any = {
      get manager() { return quota.bindTools(this); },
      count: jest.fn(async () => quota.count({ where: { operationId: 'x' } })),
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((x: any) => ({ id: 't-new', ...x })),
      save: jest.fn(async (x: any) => x),
    };
    const service = new ToolGeneratorService(
      toolRepo,
      { create: jest.fn((x: any) => x), save: jest.fn(async (x: any) => x) } as any,
      { find: jest.fn().mockResolvedValue(ops) } as any,
      { findOne: jest.fn().mockResolvedValue(null), create: jest.fn((x: any) => x), save: jest.fn(async (x: any) => x) } as any,
      {} as any,
    );
    return { service, toolRepo };
  }

  it('refuses operations whose tools do not fit, before writing any', async () => {
    const { service, toolRepo } = build(atLimit(), [op(1), op(2)]);
    await expect(service.generateToolsFromApi(api)).rejects.toBeInstanceOf(ToolQuotaExceededException);
    expect(toolRepo.save).not.toHaveBeenCalled();
  });

  it(`refuses more than ${MAX_TOOLS_PER_SCHEMA} operations`, async () => {
    const ops = Array.from({ length: MAX_TOOLS_PER_SCHEMA + 1 }, (_, i) => op(i));
    const { service, toolRepo } = build(quotaManager({ current: 0 }), ops);
    await expect(service.generateToolsFromApi(api)).rejects.toThrow(`would produce ${MAX_TOOLS_PER_SCHEMA + 1} tools`);
    expect(toolRepo.save).not.toHaveBeenCalled();
  });

  it('truncates a 1MB operation description', () => {
    const { service } = build(quotaManager({ current: 0 }), []);
    const description = (service as any).generateToolDescription({ description: 'd'.repeat(MB) }, api);
    expect(description).toHaveLength(MAX_GENERATED_DESCRIPTION_LENGTH);
  });
});

describe('MCP source sync (McpSourcesService.sync)', () => {
  const source = {
    id: 'src-1',
    name: 'weather',
    url: 'https://mcp.example.com/mcp',
    authType: 'none',
    credentialId: null,
    organizationId: ORG,
    createdBy: 'u-1',
  } as any;

  function build(quota: ReturnType<typeof quotaManager>, remote: Array<{ name: string; description?: string }>) {
    const toolRepo: any = {
      get manager() { return quota.bindTools(this); },
      find: jest.fn().mockResolvedValue([]),
      create: jest.fn((x: any) => x),
      save: jest.fn(async (x: any) => x),
    };
    const sourceRepo: any = {
      findOne: jest.fn().mockResolvedValue({ ...source }),
      save: jest.fn(async (x: any) => x),
    };
    const mcpClient: any = {
      listTools: jest.fn().mockResolvedValue({ tools: remote, init: { protocolVersion: 'x', serverInfo: {} } }),
    };
    const service = new McpSourcesService(sourceRepo, toolRepo, mcpClient, {} as any, {} as any);
    return { service, toolRepo };
  }

  it('refuses to materialize remote tools past the limit', async () => {
    const { service, toolRepo } = build(atLimit(), [{ name: 'a' }, { name: 'b' }]);
    await expect(service.sync('src-1', ORG)).rejects.toBeInstanceOf(ToolQuotaExceededException);
    expect(toolRepo.save).not.toHaveBeenCalled();
  });

  it(`refuses a server listing more than ${MAX_TOOLS_PER_SCHEMA} tools`, async () => {
    const remote = Array.from({ length: MAX_TOOLS_PER_SCHEMA + 1 }, (_, i) => ({ name: `t${i}` }));
    const { service, toolRepo } = build(quotaManager({ current: 0 }), remote);
    await expect(service.sync('src-1', ORG)).rejects.toThrow(`would produce ${MAX_TOOLS_PER_SCHEMA + 1} tools`);
    expect(toolRepo.save).not.toHaveBeenCalled();
  });

  it('truncates a 1MB remote description', async () => {
    const { service, toolRepo } = build(quotaManager({ current: 0 }), [{ name: 'a', description: 'd'.repeat(MB) }]);
    await service.sync('src-1', ORG);
    expect(toolRepo.save.mock.calls[0][0].description).toHaveLength(MAX_GENERATED_DESCRIPTION_LENGTH);
  });
});

describe('Tool Hub install (ToolHubService.installTemplate)', () => {
  function build(quota: ReturnType<typeof quotaManager>, template: Record<string, unknown>) {
    const toolRepo: any = {
      get manager() { return quota.bindTools(this); },
      create: jest.fn((x: any) => x),
      save: jest.fn(async (x: any) => ({ id: 't-new', ...x })),
    };
    const templateRepo: any = {
      findOne: jest.fn().mockResolvedValue({ id: 'tpl-1', name: 'tpl', organizationId: null, ...template }),
      increment: jest.fn(),
    };
    const apiRepo: any = { find: jest.fn().mockResolvedValue([]), create: jest.fn((x: any) => x), save: jest.fn(async (x: any) => x) };
    const service = new ToolHubService(templateRepo, toolRepo, apiRepo, { log: jest.fn(), logCreate: jest.fn() } as any);
    return { service, toolRepo, apiRepo };
  }

  it('refuses an install when the organization is at its limit, without creating its API', async () => {
    const { service, toolRepo, apiRepo } = build(atLimit(), {
      description: 'd',
      apiConfig: { name: 'Remote', baseUrl: 'https://api.example.com' },
    });
    await expect(service.installTemplate('tpl-1', ORG, 'u-1')).rejects.toBeInstanceOf(ToolQuotaExceededException);
    expect(toolRepo.save).not.toHaveBeenCalled();
    expect(apiRepo.save).not.toHaveBeenCalled();
  });

  it('truncates a 1MB template description', async () => {
    const { service, toolRepo } = build(quotaManager({ current: 0 }), { description: 'd'.repeat(MB) });
    await service.installTemplate('tpl-1', ORG, 'u-1');
    expect(toolRepo.save.mock.calls[0][0].description).toHaveLength(MAX_GENERATED_DESCRIPTION_LENGTH);
  });
});

/** A transactional manager whose Tool repository can also delete via a query builder. */
function transactionalTools(quota: ReturnType<typeof quotaManager>) {
  const qb: any = {};
  for (const m of ['delete', 'from', 'where', 'andWhere']) qb[m] = jest.fn(() => qb);
  qb.execute = jest.fn().mockResolvedValue({ affected: 0 });
  const toolRepoInTx: any = {
    createQueryBuilder: jest.fn(() => qb),
    create: jest.fn((x: any) => x),
    save: jest.fn(async (x: any) => x),
    count: jest.fn(async () => quota.count({ where: { organizationId: ORG } })),
  };
  const mgr: any = {
    queryRunner: { isTransactionActive: true },
    query: quota.lock,
    getRepository: jest.fn((entity: unknown) => (entity === Tool ? toolRepoInTx : quota.manager.getRepository(entity))),
  };
  const tools: any = { manager: { transaction: jest.fn(async (cb: any) => cb(mgr)) } };
  return { tools, toolRepoInTx };
}

describe('runner capability publish (RunnerCapabilityPublisher.publish)', () => {
  const runner = { id: 'r-1', name: 'laptop', organizationId: ORG, ownerUserId: 'u-1', visibility: 'org' } as any;

  it('refuses to mint capability tools past the limit', async () => {
    const { tools, toolRepoInTx } = transactionalTools(atLimit());
    await expect(new RunnerCapabilityPublisher(tools).publish(runner)).rejects.toBeInstanceOf(
      ToolQuotaExceededException,
    );
    expect(toolRepoInTx.save).not.toHaveBeenCalled();
  });

  it('publishes when there is room', async () => {
    const { tools, toolRepoInTx } = transactionalTools(quotaManager({ maxTools: 5, current: 2 }));
    await expect(new RunnerCapabilityPublisher(tools).publish(runner)).resolves.toHaveLength(3);
    expect(toolRepoInTx.save).toHaveBeenCalledTimes(3);
  });
});
