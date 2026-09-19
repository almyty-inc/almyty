import { ToolGeneratorService } from '../tool-generator.service';
import { ToolsController } from '../tools.controller';

/**
 * Regression: `POST /organizations/:organizationId/tools/:toolId/regenerate`
 * parsed `organizationId` off the path and then dropped it — the handler
 * called `regenerateToolFromOperation(toolId)` and the service looked the
 * tool up by id alone.
 *
 * RolesGuard only proves the caller is an admin/owner of the org named in
 * the PATH (see roles.guard.ts extractOrganizationId), so an admin of their
 * own org could regenerate a tool belonging to any other org whose id they
 * knew — rewriting its description, parameters and version. The sibling
 * handler `generateToolsFromApi` shows the intended shape: it reads its API
 * with `where: { id: apiId, organizationId }`.
 *
 * These tests fail if the organizationId is dropped again at either seam.
 */
describe('regenerate tool — organization scope', () => {
  function makeService(findOne: jest.Mock) {
    const toolRepository = { findOne, save: jest.fn(async (t: unknown) => t) };
    const toolVersionRepository = { create: jest.fn(() => ({})), save: jest.fn(async () => ({})) };
    const operationRepository = { find: jest.fn() };
    const jsonSchemaRepository = { findOne: jest.fn(async () => null), save: jest.fn(async (s: unknown) => s) };
    const translator = {
      translateOperationToInputSchema: jest.fn(async () => ({ id: 'in-1', schema: { type: 'object' } })),
      translateOperationToOutputSchema: jest.fn(async () => ({ id: 'out-1', schema: { type: 'object' } })),
    };
    const service = new ToolGeneratorService(
      toolRepository as never,
      toolVersionRepository as never,
      operationRepository as never,
      jsonSchemaRepository as never,
      translator as never,
    );
    return { service, toolRepository };
  }

  const toolOwnedBy = (organizationId: string) => ({
    id: 'tool-1',
    organizationId,
    version: '1.0.0',
    operation: {
      id: 'op-1',
      name: 'getUser',
      operationId: 'getUser',
      method: 'GET',
      endpoint: '/users/{id}',
      isReadOperation: () => true,
      api: { id: 'api-1', name: 'User API', type: 'openapi' },
    },
  });

  it('scopes the tool lookup to the organization from the path', async () => {
    const findOne = jest.fn(async () => toolOwnedBy('org-a'));
    const { service, toolRepository } = makeService(findOne);

    await service.regenerateToolFromOperation('tool-1', 'org-a');

    expect(toolRepository.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'tool-1', organizationId: 'org-a' },
      }),
    );
  });

  it('does not reach a tool owned by another organization', async () => {
    // Stands in for the database: the row is only visible to a query that
    // actually carries the owning org. An unscoped `where: { id }` — the
    // shape of the defect — hands the foreign tool straight back.
    const findOne = jest.fn(async (opts: { where: { id: string; organizationId?: string } }) => {
      const tool = toolOwnedBy('org-a');
      if (opts.where.organizationId === undefined) return tool; // unscoped read
      return opts.where.organizationId === tool.organizationId ? tool : null;
    });
    const { service } = makeService(findOne);

    await expect(
      service.regenerateToolFromOperation('tool-1', 'org-b'),
    ).rejects.toThrow('Tool or operation not found');
  });

  it('the controller forwards the path organizationId to the service', async () => {
    const regenerate = jest.fn(async () => ({ id: 'tool-1' }));
    const controller = new ToolsController(
      {} as never,
      { regenerateToolFromOperation: regenerate } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await controller.regenerateTool('org-a', 'tool-1', { user: { id: 'u-1' } });

    expect(regenerate).toHaveBeenCalledWith('tool-1', 'org-a');
  });
});
