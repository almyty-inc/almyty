import { NotFoundException } from '@nestjs/common';

import { ToolHubService } from '../tool-hub.service';
import { orgMembersPolicy } from '../../../test/execution-access.fixture';

/**
 * First tests for the tool hub. The module had none, and the two things
 * worth pinning are the ones a reader cannot verify by inspection: the
 * public-or-own-org visibility rule (a private template must never be
 * readable or installable by another tenant) and the page ceiling on
 * `listTemplates`, whose `page`/`limit` arrive straight off the query
 * string.
 */
describe('ToolHubService', () => {
  let qb: any;
  let templateRepository: any;
  let toolRepository: any;
  let apiRepository: any;
  let auditLogService: any;
  let service: ToolHubService;

  beforeEach(() => {
    qb = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      addGroupBy: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
      getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
      getRawMany: jest.fn().mockResolvedValue([]),
    };

    templateRepository = {
      createQueryBuilder: jest.fn(() => qb),
      findOne: jest.fn(),
      increment: jest.fn().mockResolvedValue(undefined),
    };
    toolRepository = {
      create: jest.fn((x: any) => ({ ...x })),
      save: jest.fn((t: any) => Promise.resolve({ ...t, id: 'tool-1' })),
    };
    apiRepository = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((x: any) => ({ ...x })),
      save: jest.fn((a: any) => Promise.resolve({ ...a, id: 'api-1' })),
    };
    auditLogService = { logCreate: jest.fn() };

    service = new ToolHubService(
      templateRepository,
      toolRepository,
      apiRepository,
      auditLogService,
      orgMembersPolicy('org-1'),
    );
  });

  // ── pagination ceiling ───────────────────────────────────────────

  it('caps a caller-supplied page size', async () => {
    await service.listTemplates({ limit: 1_000_000 }, 'org-1');
    expect(qb.take).toHaveBeenCalledWith(100);
  });

  it('falls back to the default page size when limit is not a number', async () => {
    // `?limit=abc` → parseInt → NaN in the controller.
    await service.listTemplates({ limit: NaN }, 'org-1');
    expect(qb.take).toHaveBeenCalledWith(20);
    expect(qb.skip).toHaveBeenCalledWith(0);
  });

  it('never asks for a negative offset', async () => {
    await service.listTemplates({ page: 0, limit: 20 }, 'org-1');
    expect(qb.skip).toHaveBeenCalledWith(0);

    qb.skip.mockClear();
    await service.listTemplates({ page: -5, limit: 20 }, 'org-1');
    expect(qb.skip).toHaveBeenCalledWith(0);
  });

  it('honours a legitimate page request', async () => {
    await service.listTemplates({ page: 3, limit: 25 }, 'org-1');
    expect(qb.skip).toHaveBeenCalledWith(50);
    expect(qb.take).toHaveBeenCalledWith(25);
  });

  // ── tenancy ──────────────────────────────────────────────────────

  it('hides another org private template behind a 404', async () => {
    templateRepository.findOne.mockResolvedValue({
      id: 'tpl-1',
      name: 'Private',
      organizationId: 'org-2',
    });

    await expect(service.getTemplate('tpl-1', 'org-1')).rejects.toThrow(NotFoundException);
  });

  it('serves a global template to any org', async () => {
    templateRepository.findOne.mockResolvedValue({
      id: 'tpl-1',
      name: 'Public',
      organizationId: null,
    });

    await expect(service.getTemplate('tpl-1', 'org-1')).resolves.toMatchObject({ id: 'tpl-1' });
  });

  it('refuses to install another org private template', async () => {
    templateRepository.findOne.mockResolvedValue({
      id: 'tpl-1',
      name: 'Private',
      organizationId: 'org-2',
    });

    await expect(service.installTemplate('tpl-1', 'org-1', 'user-1')).rejects.toThrow(
      NotFoundException,
    );
    expect(toolRepository.save).not.toHaveBeenCalled();
  });

  it('restricts a provider bulk install to visible templates', async () => {
    await expect(service.installProviderTemplates('stripe', 'org-1', 'user-1')).rejects.toThrow(
      NotFoundException,
    );
    expect(qb.andWhere).toHaveBeenCalledWith(
      '(t.organizationId IS NULL OR t.organizationId = :orgId)',
      { orgId: 'org-1' },
    );
  });

  it('scopes the category rollup to public plus own-org templates', async () => {
    await service.getCategories('org-1');
    expect(qb.where).toHaveBeenCalledWith(
      '(t.organizationId IS NULL OR t.organizationId = :orgId)',
      { orgId: 'org-1' },
    );
  });

  it('shows only public templates when there is no org context', async () => {
    await service.getCategories(undefined);
    expect(qb.where).toHaveBeenCalledWith('t.organizationId IS NULL');
  });
});
