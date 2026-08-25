import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';

import { AgentAppsService } from '../agent-apps.service';
import { AppAuthMode } from '../../../entities/agent-app.entity';
import {
  DistributionStatus,
  DistributionTarget,
} from '../../../entities/agent-app-distribution.entity';

describe('AgentAppsService', () => {
  let appRepository: any;
  let distributionRepository: any;
  let agentRepository: any;
  let service: AgentAppsService;

  const ORG = 'org-1';

  const app = (overrides: any = {}) => ({
    id: 'h-1',
    organizationId: ORG,
    name: 'Acme Support',
    slug: 'acme-support',
    agentIds: ['agent-1'],
    branding: {},
    authMode: AppAuthMode.PUBLIC_LINK,
    capabilities: {},
    isActive: true,
    ...overrides,
  });

  beforeEach(() => {
    appRepository = {
      find: jest.fn(async () => []),
      findOne: jest.fn(async () => app()),
      create: jest.fn((row: any) => row),
      save: jest.fn(async (row: any) => ({ id: 'h-1', ...row })),
      remove: jest.fn(async () => undefined),
    };
    distributionRepository = {
      findOne: jest.fn(async () => null),
      create: jest.fn((row: any) => row),
      save: jest.fn(async (row: any) => ({ id: 'd-1', ...row })),
      remove: jest.fn(async () => undefined),
    };
    agentRepository = { find: jest.fn(async () => [{ id: 'agent-1' }]) };
    service = new AgentAppsService(appRepository, distributionRepository, agentRepository);
  });

  describe('tenant scoping', () => {
    it('looks an app up by name, scoped to the organization in the query', async () => {
      await service.findOne(ORG, '  ACME-Support ');
      expect(appRepository.findOne).toHaveBeenCalledWith({
        where: { slug: 'acme-support', organizationId: ORG },
        relations: { distributions: true },
      });
    });

    it('404s rather than leaking another tenant product', async () => {
      appRepository.findOne.mockResolvedValueOnce(null);
      await expect(service.findOne(ORG, 'someone-elses')).rejects.toThrow(NotFoundException);
    });
  });

  describe('create', () => {
    it('normalises the slug and defaults to the open auth mode', async () => {
      appRepository.findOne.mockResolvedValueOnce(null); // no clash
      const created = await service.create(ORG, { name: 'Acme', slug: '  ACME-Support ' });
      expect(created.slug).toBe('acme-support');
      expect(created.authMode).toBe(AppAuthMode.PUBLIC_LINK);
    });

    it('rejects an unusable slug before touching the database', async () => {
      await expect(service.create(ORG, { name: 'Acme', slug: 'a' })).rejects.toThrow(
        BadRequestException,
      );
      expect(appRepository.save).not.toHaveBeenCalled();
    });

    it('refuses a slug already used in this organization', async () => {
      appRepository.findOne.mockResolvedValueOnce(app());
      await expect(service.create(ORG, { name: 'Acme', slug: 'acme-support' })).rejects.toThrow(
        ConflictException,
      );
    });

    it('refuses agents belonging to another organization', async () => {
      // Otherwise a product could serve another tenant's agent under
      // its own branding.
      agentRepository.find.mockResolvedValueOnce([{ id: 'agent-1' }]);
      await expect(
        service.create(ORG, { name: 'Acme', slug: 'acme', agentIds: ['agent-1', 'not-ours'] }),
      ).rejects.toThrow(/not-ours/);
    });

    it('allows a product with no agents yet, so it can be built up', async () => {
      appRepository.findOne.mockResolvedValueOnce(null); // no clash
      const created = await service.create(ORG, { name: 'Acme', slug: 'acme' });
      expect(created.agentIds).toEqual([]);
      // Publishing is what refuses an empty product, not creating one.
      expect(agentRepository.find).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('checks ownership again when the agent list changes', async () => {
      agentRepository.find.mockResolvedValueOnce([]);
      await expect(service.update(ORG, 'acme-support', { agentIds: ['stolen'] })).rejects.toThrow(
        BadRequestException,
      );
    });

    it('allows keeping the same slug', async () => {
      appRepository.findOne.mockResolvedValueOnce(app());
      const updated = await service.update(ORG, 'acme-support', { slug: 'acme-support' });
      expect(updated.slug).toBe('acme-support');
    });

    it('refuses a slug taken by another product', async () => {
      appRepository.findOne
        .mockResolvedValueOnce(app())
        .mockResolvedValueOnce(app({ id: 'h-2', slug: 'taken' }));
      await expect(service.update(ORG, 'acme-support', { slug: 'taken' })).rejects.toThrow(
        ConflictException,
      );
    });

    it('leaves untouched fields alone', async () => {
      const updated = await service.update(ORG, 'acme-support', { name: 'Renamed' });
      expect(updated.name).toBe('Renamed');
      expect(updated.slug).toBe('acme-support');
      expect(updated.agentIds).toEqual(['agent-1']);
    });
  });

  describe('distributions', () => {
    it('creates one in draft', async () => {
      const created = await service.addDistribution(ORG, 'acme-support', DistributionTarget.WEB);
      expect(created.status).toBe(DistributionStatus.DRAFT);
      expect(created.appId).toBe('h-1');
    });

    it('allows only one distribution per target', async () => {
      // Naming the platform rather than lumping them under "channel" is
      // what makes this simple: slack and telegram are separate targets.
      for (const target of [
        DistributionTarget.WEB,
        DistributionTarget.DESKTOP,
        DistributionTarget.BINARY,
        DistributionTarget.TUI,
        DistributionTarget.SLACK,
      ]) {
        appRepository.findOne.mockResolvedValueOnce(app());
        distributionRepository.findOne.mockResolvedValueOnce({ id: 'existing' });
        await expect(service.addDistribution(ORG, 'acme-support', target)).rejects.toThrow(
          ConflictException,
        );
      }
    });

    it('lets an app ship to several platforms at once', async () => {
      // Slack already exists; telegram is a different target, so it is
      // not a clash.
      distributionRepository.findOne.mockResolvedValueOnce(null);
      const created = await service.addDistribution(
        ORG,
        'acme-support',
        DistributionTarget.TELEGRAM,
        {},
        'gw-telegram',
      );
      expect(created.gatewayId).toBe('gw-telegram');
      expect(created.target).toBe(DistributionTarget.TELEGRAM);
    });

    it('404s removing a target this app does not ship to', async () => {
      distributionRepository.findOne.mockResolvedValueOnce(null);
      await expect(
        service.removeDistribution(ORG, 'acme-support', DistributionTarget.DESKTOP),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('check', () => {
    it('reports the unmet rules rather than throwing', async () => {
      appRepository.findOne.mockResolvedValueOnce(app({ agentIds: [] }));
      const result = await service.check(ORG, 'acme-support', {});
      expect(result.ok).toBe(false);
      expect(result.refusals.map((r) => r.code)).toContain('NO_AGENTS');
    });

    it('passes a product with caps in place', async () => {
      const result = await service.check(ORG, 'acme-support', {
        costCapCents: 500,
        perUserRateLimit: 10,
        perIpRateLimit: 30,
      });
      expect(result.ok).toBe(true);
    });

    it('combines app and target rules in one answer', async () => {
      appRepository.findOne.mockResolvedValueOnce(app({ agentIds: [] }));
      distributionRepository.findOne.mockResolvedValueOnce({
        id: 'd-1',
        organizationId: ORG,
        appId: 'h-1',
        target: DistributionTarget.DESKTOP,
        configuration: { bundleId: 'not-reverse-dns' },
      });
      const result = await service.checkDistribution(
        ORG,
        'acme-support',
        DistributionTarget.DESKTOP,
        {},
      );
      const codes = result.refusals.map((r) => r.code);
      expect(codes).toContain('NO_AGENTS');
      expect(codes).toContain('BUNDLE_ID_INVALID');
    });
  });

  describe('recordBuild', () => {
    it('marks a successful build and stamps the time', async () => {
      distributionRepository.findOne.mockResolvedValueOnce({ id: 'd-1', organizationId: ORG });
      const updated = await service.recordBuild(ORG, 'acme-support', DistributionTarget.BINARY, {
        version: '1.0.0',
        platform: 'darwin-arm64',
        checksum: 'abc',
        signed: true,
      });
      expect(updated.status).toBe(DistributionStatus.BUILT);
      expect(updated.lastBuild?.builtAt).toEqual(expect.any(String));
    });

    it('marks a failed build as failed, keeping the reason', async () => {
      distributionRepository.findOne.mockResolvedValueOnce({ id: 'd-1', organizationId: ORG });
      const updated = await service.recordBuild(ORG, 'acme-support', DistributionTarget.DESKTOP, {
        error: 'notarisation rejected',
      });
      expect(updated.status).toBe(DistributionStatus.FAILED);
      expect(updated.lastBuild?.error).toBe('notarisation rejected');
    });
  });
});
