import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { Harness, HarnessAuthMode } from '../../entities/harness.entity';
import {
  DistributionStatus,
  DistributionTarget,
  HarnessDistribution,
} from '../../entities/harness-distribution.entity';
import { Agent } from '../../entities/agent.entity';
import {
  HarnessCheck,
  checkDistribution,
  checkHarness,
  harnessSlugError,
} from './harness.rules';

export interface CreateHarnessDto {
  name: string;
  slug: string;
  description?: string;
  agentIds?: string[];
  branding?: Harness['branding'];
  authMode?: HarnessAuthMode;
  capabilities?: Harness['capabilities'];
}

export type UpdateHarnessDto = Partial<CreateHarnessDto> & { isActive?: boolean };

/**
 * The factory floor: creating, configuring and shipping agent products.
 *
 * Everything is scoped to an organization in the query rather than
 * checked afterwards, because a harness carries branding, credentials
 * by reference and a capability grant. Reading one that belongs to
 * another tenant would leak all three.
 */
@Injectable()
export class HarnessesService {
  constructor(
    @InjectRepository(Harness)
    private readonly harnessRepository: Repository<Harness>,
    @InjectRepository(HarnessDistribution)
    private readonly distributionRepository: Repository<HarnessDistribution>,
    @InjectRepository(Agent)
    private readonly agentRepository: Repository<Agent>,
  ) {}

  async list(organizationId: string): Promise<Harness[]> {
    return this.harnessRepository.find({
      where: { organizationId },
      order: { createdAt: 'DESC' },
    });
  }

  async findOne(organizationId: string, id: string): Promise<Harness> {
    const harness = await this.harnessRepository.findOne({
      where: { id, organizationId },
      relations: { distributions: true },
    });
    if (!harness) throw new NotFoundException('Harness not found');
    return harness;
  }

  /**
   * Confirm every agent belongs to this organization.
   *
   * A harness exposes agents by id, so without this an operator could
   * point their product at another tenant's agent and serve its answers
   * under their own branding.
   */
  private async assertAgentsOwned(organizationId: string, agentIds: string[]): Promise<void> {
    if (!agentIds.length) return;
    const owned = await this.agentRepository.find({
      where: { id: In(agentIds), organizationId },
      select: { id: true },
    });
    if (owned.length !== agentIds.length) {
      const ownedIds = new Set(owned.map((a) => a.id));
      const missing = agentIds.filter((id) => !ownedIds.has(id));
      throw new BadRequestException(
        `These agents do not exist in this organization: ${missing.join(', ')}`,
      );
    }
  }

  async create(organizationId: string, dto: CreateHarnessDto): Promise<Harness> {
    const slugError = harnessSlugError(dto.slug);
    if (slugError) throw new BadRequestException(slugError);

    const agentIds = dto.agentIds ?? [];
    await this.assertAgentsOwned(organizationId, agentIds);

    const existing = await this.harnessRepository.findOne({
      where: { organizationId, slug: dto.slug.trim().toLowerCase() },
    });
    if (existing) throw new ConflictException('A product with that name already exists');

    return this.harnessRepository.save(
      this.harnessRepository.create({
        organizationId,
        name: dto.name,
        slug: dto.slug.trim().toLowerCase(),
        description: dto.description ?? null,
        agentIds,
        branding: dto.branding ?? {},
        authMode: dto.authMode ?? HarnessAuthMode.PUBLIC_LINK,
        capabilities: dto.capabilities ?? {},
        isActive: true,
      }),
    );
  }

  async update(organizationId: string, id: string, dto: UpdateHarnessDto): Promise<Harness> {
    const harness = await this.findOne(organizationId, id);

    if (dto.slug !== undefined) {
      const slugError = harnessSlugError(dto.slug);
      if (slugError) throw new BadRequestException(slugError);
      const slug = dto.slug.trim().toLowerCase();
      if (slug !== harness.slug) {
        const clash = await this.harnessRepository.findOne({ where: { organizationId, slug } });
        if (clash) throw new ConflictException('A product with that name already exists');
      }
      harness.slug = slug;
    }

    if (dto.agentIds !== undefined) {
      await this.assertAgentsOwned(organizationId, dto.agentIds);
      harness.agentIds = dto.agentIds;
    }

    if (dto.name !== undefined) harness.name = dto.name;
    if (dto.description !== undefined) harness.description = dto.description ?? null;
    if (dto.branding !== undefined) harness.branding = dto.branding;
    if (dto.authMode !== undefined) harness.authMode = dto.authMode;
    if (dto.capabilities !== undefined) harness.capabilities = dto.capabilities;
    if (dto.isActive !== undefined) harness.isActive = dto.isActive;

    return this.harnessRepository.save(harness);
  }

  async remove(organizationId: string, id: string): Promise<void> {
    const harness = await this.findOne(organizationId, id);
    await this.harnessRepository.remove(harness);
  }

  /**
   * Whether this product may ship, and if not, why.
   *
   * Reported rather than enforced silently: the builder shows the unmet
   * rules while they are still fixable, and publish refuses using the
   * same function so the two cannot disagree.
   */
  async check(
    organizationId: string,
    id: string,
    context: Parameters<typeof checkHarness>[1] = {},
  ): Promise<HarnessCheck> {
    const harness = await this.findOne(organizationId, id);
    return checkHarness(harness, context);
  }

  async addDistribution(
    organizationId: string,
    harnessId: string,
    target: DistributionTarget,
    configuration: Record<string, any> = {},
    gatewayId: string | null = null,
  ): Promise<HarnessDistribution> {
    const harness = await this.findOne(organizationId, harnessId);

    // One distribution per target, except channels: a product ships to
    // one web address and one desktop app, but reasonably to Slack and
    // Telegram at once.
    if (target !== DistributionTarget.CHANNEL) {
      const existing = await this.distributionRepository.findOne({
        where: { harnessId: harness.id, target },
      });
      if (existing) {
        throw new ConflictException(`This product already has a ${target} distribution`);
      }
    }

    return this.distributionRepository.save(
      this.distributionRepository.create({
        organizationId,
        harnessId: harness.id,
        target,
        status: DistributionStatus.DRAFT,
        gatewayId,
        configuration,
      }),
    );
  }

  async removeDistribution(organizationId: string, id: string): Promise<void> {
    const distribution = await this.distributionRepository.findOne({
      where: { id, organizationId },
    });
    if (!distribution) throw new NotFoundException('Distribution not found');
    await this.distributionRepository.remove(distribution);
  }

  /**
   * Whether a distribution can be built or published.
   *
   * Runs the harness rules plus whatever the target itself demands, so
   * a desktop build is refused for a missing bundle id and for a
   * missing cost cap in the same answer rather than one at a time.
   */
  async checkDistribution(
    organizationId: string,
    id: string,
    context: Parameters<typeof checkHarness>[1] = {},
  ): Promise<HarnessCheck> {
    const distribution = await this.distributionRepository.findOne({
      where: { id, organizationId },
    });
    if (!distribution) throw new NotFoundException('Distribution not found');

    const harness = await this.findOne(organizationId, distribution.harnessId);
    return checkDistribution(distribution.target, harness, distribution.configuration, context);
  }

  /**
   * Record the outcome of a build.
   *
   * The artifact is produced on the customer's own machine, because
   * signing it needs their certificates and those must not reach us.
   * What we keep is what came out, so a question about a binary already
   * in the wild has an answer.
   */
  async recordBuild(
    organizationId: string,
    id: string,
    build: NonNullable<HarnessDistribution['lastBuild']>,
  ): Promise<HarnessDistribution> {
    const distribution = await this.distributionRepository.findOne({
      where: { id, organizationId },
    });
    if (!distribution) throw new NotFoundException('Distribution not found');

    distribution.lastBuild = { ...build, builtAt: build.builtAt ?? new Date().toISOString() };
    distribution.status = build.error ? DistributionStatus.FAILED : DistributionStatus.BUILT;
    return this.distributionRepository.save(distribution);
  }
}
