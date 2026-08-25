import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';

import { HarnessesService } from '../harnesses.service';
import { HarnessAuthMode } from '../../../entities/harness.entity';
import {
  DistributionStatus,
  DistributionTarget,
} from '../../../entities/harness-distribution.entity';

describe('HarnessesService', () => {
  let harnessRepository: any;
  let distributionRepository: any;
  let agentRepository: any;
  let service: HarnessesService;

  const ORG = 'org-1';

  const harness = (overrides: any = {}) => ({
    id: 'h-1',
    organizationId: ORG,
    name: 'Acme Support',
    slug: 'acme-support',
    agentIds: ['agent-1'],
    branding: {},
    authMode: HarnessAuthMode.PUBLIC_LINK,
    capabilities: {},
    isActive: true,
    ...overrides,
  });

  beforeEach(() => {
    harnessRepository = {
      find: jest.fn(async () => []),
      findOne: jest.fn(async () => harness()),
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
    service = new HarnessesService(harnessRepository, distributionRepository, agentRepository);
  });

  describe('tenant scoping', () => {
    it('scopes a lookup to the organization in the query itself', async () => {
      await service.findOne(ORG, 'h-1');
      expect(harnessRepository.findOne).toHaveBeenCalledWith({
        where: { id: 'h-1', organizationId: ORG },
        relations: { distributions: true },
      });
    });

    it('404s rather than leaking another tenant product', async () => {
      harnessRepository.findOne.mockResolvedValueOnce(null);
      await expect(service.findOne(ORG, 'someone-elses')).rejects.toThrow(NotFoundException);
    });
  });

  describe('create', () => {
    it('normalises the slug and defaults to the open auth mode', async () => {
      harnessRepository.findOne.mockResolvedValueOnce(null); // no clash
      const created = await service.create(ORG, { name: 'Acme', slug: '  ACME-Support ' });
      expect(created.slug).toBe('acme-support');
      expect(created.authMode).toBe(HarnessAuthMode.PUBLIC_LINK);
    });

    it('rejects an unusable slug before touching the database', async () => {
      await expect(service.create(ORG, { name: 'Acme', slug: 'a' })).rejects.toThrow(
        BadRequestException,
      );
      expect(harnessRepository.save).not.toHaveBeenCalled();
    });

    it('refuses a slug already used in this organization', async () => {
      harnessRepository.findOne.mockResolvedValueOnce(harness());
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
      harnessRepository.findOne.mockResolvedValueOnce(null); // no clash
      const created = await service.create(ORG, { name: 'Acme', slug: 'acme' });
      expect(created.agentIds).toEqual([]);
      // Publishing is what refuses an empty product, not creating one.
      expect(agentRepository.find).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('checks ownership again when the agent list changes', async () => {
      agentRepository.find.mockResolvedValueOnce([]);
      await expect(service.update(ORG, 'h-1', { agentIds: ['stolen'] })).rejects.toThrow(
        BadRequestException,
      );
    });

    it('allows keeping the same slug', async () => {
      harnessRepository.findOne.mockResolvedValueOnce(harness());
      const updated = await service.update(ORG, 'h-1', { slug: 'acme-support' });
      expect(updated.slug).toBe('acme-support');
    });

    it('refuses a slug taken by another product', async () => {
      harnessRepository.findOne
        .mockResolvedValueOnce(harness())
        .mockResolvedValueOnce(harness({ id: 'h-2', slug: 'taken' }));
      await expect(service.update(ORG, 'h-1', { slug: 'taken' })).rejects.toThrow(
        ConflictException,
      );
    });

    it('leaves untouched fields alone', async () => {
      const updated = await service.update(ORG, 'h-1', { name: 'Renamed' });
      expect(updated.name).toBe('Renamed');
      expect(updated.slug).toBe('acme-support');
      expect(updated.agentIds).toEqual(['agent-1']);
    });
  });

  describe('distributions', () => {
    it('creates one in draft', async () => {
      const created = await service.addDistribution(ORG, 'h-1', DistributionTarget.WEB);
      expect(created.status).toBe(DistributionStatus.DRAFT);
      expect(created.harnessId).toBe('h-1');
    });

    it('allows only one web, desktop or binary distribution', async () => {
      for (const target of [
        DistributionTarget.WEB,
        DistributionTarget.DESKTOP,
        DistributionTarget.BINARY,
        DistributionTarget.TUI,
      ]) {
        harnessRepository.findOne.mockResolvedValueOnce(harness());
        distributionRepository.findOne.mockResolvedValueOnce({ id: 'existing' });
        await expect(service.addDistribution(ORG, 'h-1', target)).rejects.toThrow(
          ConflictException,
        );
      }
    });

    it('allows several channel distributions, since a product ships to more than one platform', async () => {
      distributionRepository.findOne.mockResolvedValueOnce({ id: 'existing-slack' });
      const created = await service.addDistribution(
        ORG,
        'h-1',
        DistributionTarget.CHANNEL,
        {},
        'gw-telegram',
      );
      expect(created.gatewayId).toBe('gw-telegram');
    });

    it('404s removing another tenant distribution', async () => {
      distributionRepository.findOne.mockResolvedValueOnce(null);
      await expect(service.removeDistribution(ORG, 'd-9')).rejects.toThrow(NotFoundException);
    });
  });

  describe('check', () => {
    it('reports the unmet rules rather than throwing', async () => {
      harnessRepository.findOne.mockResolvedValueOnce(harness({ agentIds: [] }));
      const result = await service.check(ORG, 'h-1', {});
      expect(result.ok).toBe(false);
      expect(result.refusals.map((r) => r.code)).toContain('NO_AGENTS');
    });

    it('passes a product with caps in place', async () => {
      const result = await service.check(ORG, 'h-1', {
        costCapCents: 500,
        perUserRateLimit: 10,
        perIpRateLimit: 30,
      });
      expect(result.ok).toBe(true);
    });

    it('combines harness and target rules in one answer', async () => {
      distributionRepository.findOne.mockResolvedValueOnce({
        id: 'd-1',
        organizationId: ORG,
        harnessId: 'h-1',
        target: DistributionTarget.DESKTOP,
        configuration: { bundleId: 'not-reverse-dns' },
      });
      harnessRepository.findOne.mockResolvedValueOnce(harness({ agentIds: [] }));
      const result = await service.checkDistribution(ORG, 'd-1', {});
      const codes = result.refusals.map((r) => r.code);
      expect(codes).toContain('NO_AGENTS');
      expect(codes).toContain('BUNDLE_ID_INVALID');
    });
  });

  describe('recordBuild', () => {
    it('marks a successful build and stamps the time', async () => {
      distributionRepository.findOne.mockResolvedValueOnce({ id: 'd-1', organizationId: ORG });
      const updated = await service.recordBuild(ORG, 'd-1', {
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
      const updated = await service.recordBuild(ORG, 'd-1', { error: 'notarisation rejected' });
      expect(updated.status).toBe(DistributionStatus.FAILED);
      expect(updated.lastBuild?.error).toBe('notarisation rejected');
    });
  });
});
