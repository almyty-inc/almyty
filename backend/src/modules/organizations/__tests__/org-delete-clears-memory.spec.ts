import { ForbiddenException } from '@nestjs/common';

import { OrganizationsService } from '../organizations.service';

/**
 * Deleting an organization has to take its canonical memory with it.
 *
 * `memories`, `memory_workspace_config` and `memory_softcap_warnings`
 * are keyed by (scope_type, scope_id) with no organizationId column and
 * no foreign key to `organizations`, so no database cascade reaches
 * them. Nothing else removes them either: the TTL sweeper only sets
 * valid_until and RetentionPolicy has no memory class. Without an
 * explicit delete here, a deleted tenant's memory content and
 * embeddings stay in the database with no code path able to remove
 * them.
 */
describe('OrganizationsService.delete — canonical memory', () => {
  const organization = (over: Record<string, any> = {}) => ({
    id: 'org-1',
    name: 'Acme',
    apis: [],
    gateways: [],
    ...over,
  });

  const memoryRepo = () => ({ delete: jest.fn().mockResolvedValue({ affected: 3 }) });

  const makeService = (org: any, repos = {
    memories: memoryRepo(),
    config: memoryRepo(),
    warnings: memoryRepo(),
  }) => {
    const organizationRepository: any = {
      findOne: jest.fn().mockResolvedValue(org),
      remove: jest.fn().mockResolvedValue(org),
    };
    const service = new OrganizationsService(
      organizationRepository,
      {} as any, // userOrganization repo
      {} as any, // team repo
      {} as any, // userTeam repo
      {} as any, // user repo
      {} as any, // mail
      {} as any, // gateways
      {} as any, // invites helper
      {} as any, // team membership helper
      repos.memories as any,
      repos.config as any,
      repos.warnings as any,
    );
    return { service, organizationRepository, repos };
  };

  it('clears all three canonical memory tables by scope_id', async () => {
    const { service, organizationRepository, repos } = makeService(organization());

    await service.delete('org-1');

    for (const repo of [repos.memories, repos.config, repos.warnings]) {
      expect(repo.delete).toHaveBeenCalledWith({ scopeId: 'org-1' });
    }
    expect(organizationRepository.remove).toHaveBeenCalledTimes(1);
  });

  it('clears the memory before removing the organization row', async () => {
    const { service, organizationRepository, repos } = makeService(organization());

    await service.delete('org-1');

    expect(repos.memories.delete.mock.invocationCallOrder[0]).toBeLessThan(
      organizationRepository.remove.mock.invocationCallOrder[0],
    );
  });

  it('keeps the organization row when the memory delete fails', async () => {
    // A half-deleted tenant is worse than a stranded table: leaving the
    // organization means the next attempt can retry the memory.
    const repos = {
      memories: { delete: jest.fn().mockRejectedValue(new Error('pgvector down')) },
      config: memoryRepo(),
      warnings: memoryRepo(),
    };
    const { service, organizationRepository } = makeService(organization(), repos as any);

    await expect(service.delete('org-1')).rejects.toThrow('pgvector down');
    expect(organizationRepository.remove).not.toHaveBeenCalled();
  });

  it('never touches memory for an organization it refuses to delete', async () => {
    const { service, repos } = makeService(organization({ gateways: [{ id: 'gw-1' }] }));

    await expect(service.delete('org-1')).rejects.toBeInstanceOf(ForbiddenException);
    expect(repos.memories.delete).not.toHaveBeenCalled();
  });
});
