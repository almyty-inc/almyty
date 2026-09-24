import { ApisToolGeneratorHelper } from '../apis-tool-generator.helper';
import { ToolsService } from '../../tools/tools.service';
import { ToolQuotaExceededException } from '../../tools/tool-quota';
import { Tool, ToolStatus } from '../../../entities/tool.entity';
import { Organization } from '../../../entities/organization.entity';
import { fakeManager, fakeRepository, FakeRepository } from '../../../test/fake-repository';

/**
 * Re-importing a schema after one of its tools was deleted.
 *
 * Deleting a tool is a soft delete: the row keeps `status = 'deleted'`
 * for history, and the partial `tools_org_name_uq` index frees its name.
 * Generation looked names up without that filter, so the dead row came
 * back as "the existing tool", was "updated" in place, stayed deleted,
 * and was still counted among the tools the import generated.
 *
 * The real `ToolsService.findByName` and the real batch writer run here,
 * over one in-memory tools table.
 */
describe('generating tools over a deleted tool of the same name', () => {
  const ORG = 'org-1';
  const operation = {
    id: 'op-1',
    name: 'listPets',
    method: 'GET',
    endpoint: '/pets',
    description: 'List every pet',
    isActive: true,
  } as any;
  const api = { id: 'api-1', name: 'Pets', organizationId: ORG, operations: [operation] } as any;

  let tools: FakeRepository<Tool>;
  let organizations: FakeRepository<Organization>;
  let buildFromOperation: jest.Mock;
  let helper: ApisToolGeneratorHelper;
  let toolName: string;

  beforeEach(() => {
    tools = fakeRepository<Tool>({ idPrefix: 'tool', make: () => new Tool() });
    organizations = fakeRepository<Organization>([{ id: ORG, settings: {} } as any]);
    const manager = fakeManager([
      [Tool, tools],
      [Organization, organizations],
    ]);

    buildFromOperation = jest.fn(async (_op: any, opts: any) =>
      Object.assign(new Tool(), { name: opts.name, description: opts.description, organizationId: ORG, status: ToolStatus.ACTIVE }),
    );
    const toolsService = {
      // The service's own lookup, bound to the fake table.
      findByName: ToolsService.prototype.findByName.bind({ toolRepository: tools }),
      buildFromOperation,
      prepareUpdateFromOperation: jest.fn(async (existing: Tool, _op: any, opts: any) =>
        Object.assign(existing, { description: opts.description }),
      ),
      createToolVersion: jest.fn(async () => undefined),
    };
    const apiRepository = { findOne: jest.fn(async () => api), manager } as any;
    helper = new ApisToolGeneratorHelper(apiRepository, toolsService as any, {} as any);
    toolName = helper.generateSemanticToolName(api.name, operation);
  });

  it('does not answer a name lookup with a deleted tool', async () => {
    tools.seed({ id: 'dead', name: toolName, organizationId: ORG, status: ToolStatus.DELETED });
    const service = { toolRepository: tools };

    expect(await ToolsService.prototype.findByName.call(service, toolName, ORG)).toBeNull();

    tools.seed({ id: 'alive', name: toolName, organizationId: ORG, status: ToolStatus.ACTIVE });
    expect((await ToolsService.prototype.findByName.call(service, toolName, ORG))?.id).toBe('alive');
  });

  it('creates a fresh live tool and leaves the deleted row as it was', async () => {
    tools.seed({ id: 'dead', name: toolName, organizationId: ORG, status: ToolStatus.DELETED, description: 'old' });

    const result = await helper.generateToolsFromApi(api.id, ORG, [operation]);

    const rows = tools.rows();
    const live = rows.filter((r) => r.status !== ToolStatus.DELETED);
    expect(live).toHaveLength(1);
    expect(live[0].id).not.toBe('dead');
    expect(live[0].name).toBe(toolName);

    const dead = tools.row('dead')!;
    expect(dead.status).toBe(ToolStatus.DELETED);
    expect(dead.description).toBe('old');

    // What the import reports is the row that is really there.
    expect(result.generated).toBe(1);
    expect(result.tools.map((t) => t.id)).toEqual([live[0].id]);
  });

  it('updates the live tool, not a deleted namesake, when both exist', async () => {
    tools.seed({ id: 'dead', name: toolName, organizationId: ORG, status: ToolStatus.DELETED, description: 'old' });
    tools.seed({ id: 'alive', name: toolName, organizationId: ORG, status: ToolStatus.ACTIVE, description: 'stale' });

    const result = await helper.generateToolsFromApi(api.id, ORG, [operation]);

    expect(tools.rows()).toHaveLength(2);
    expect(tools.row('alive')!.description).toBe('List every pet');
    expect(tools.row('dead')!.description).toBe('old');
    expect(result.tools.map((t) => t.id)).toEqual(['alive']);
  });

  it('counts a name only a deleted tool holds as a new tool against the quota', async () => {
    // At the limit: one live tool, plus the deleted namesake of the tool
    // this import would add. Counting the deleted row as "already there"
    // made the early check think nothing new was being added.
    await organizations.update({ id: ORG }, { settings: { maxTools: 1 } });
    tools.seed({ id: 'other', name: 'something_else', organizationId: ORG, status: ToolStatus.ACTIVE });
    tools.seed({ id: 'dead', name: toolName, organizationId: ORG, status: ToolStatus.DELETED });

    await expect(helper.generateToolsFromApi(api.id, ORG, [operation])).rejects.toBeInstanceOf(ToolQuotaExceededException);
    // Refused up front, before any row was built.
    expect(buildFromOperation).not.toHaveBeenCalled();
  });
});
