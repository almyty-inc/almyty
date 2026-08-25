import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { AgentApp, AppAuthMode } from '../../entities/agent-app.entity';
import {
  DistributionStatus,
  DistributionTarget,
  AppDistribution,
} from '../../entities/agent-app-distribution.entity';
import { Agent } from '../../entities/agent.entity';
import {
  AppCheck,
  checkDistribution,
  checkApp,
  appSlugError,
} from './agent-app.rules';

export interface CreateAppDto {
  name: string;
  slug: string;
  description?: string;
  agentIds?: string[];
  branding?: AgentApp['branding'];
  authMode?: AppAuthMode;
  capabilities?: AgentApp['capabilities'];
}

export type UpdateAppDto = Partial<CreateAppDto> & { isActive?: boolean };

/**
 * The factory floor: creating, configuring and shipping agent products.
 *
 * Everything is scoped to an organization in the query rather than
 * checked afterwards, because a app carries branding, credentials
 * by reference and a capability grant. Reading one that belongs to
 * another tenant would leak all three.
 */
@Injectable()
export class AgentAppsService {
  constructor(
    @InjectRepository(AgentApp)
    private readonly appRepository: Repository<AgentApp>,
    @InjectRepository(AppDistribution)
    private readonly distributionRepository: Repository<AppDistribution>,
    @InjectRepository(Agent)
    private readonly agentRepository: Repository<Agent>,
  ) {}

  async list(organizationId: string): Promise<AgentApp[]> {
    return this.appRepository.find({
      where: { organizationId },
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * Apps are addressed by their slug, not their id.
   *
   * The slug is already unique per organization and is the name the
   * product ships under, so it is what an operator recognises in a URL
   * and what they can type from memory. An opaque id in a path is
   * unreadable and unshareable for no gain.
   */
  async findOne(organizationId: string, slug: string): Promise<AgentApp> {
    const app = await this.appRepository.findOne({
      where: { slug: (slug || '').trim().toLowerCase(), organizationId },
      relations: { distributions: true },
    });
    if (!app) throw new NotFoundException('App not found');
    return app;
  }

  /**
   * Confirm every agent belongs to this organization.
   *
   * A app exposes agents by id, so without this an operator could
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

  async create(organizationId: string, dto: CreateAppDto): Promise<AgentApp> {
    const slugError = appSlugError(dto.slug);
    if (slugError) throw new BadRequestException(slugError);

    const agentIds = dto.agentIds ?? [];
    await this.assertAgentsOwned(organizationId, agentIds);

    const existing = await this.appRepository.findOne({
      where: { organizationId, slug: dto.slug.trim().toLowerCase() },
    });
    if (existing) throw new ConflictException('A product with that name already exists');

    return this.appRepository.save(
      this.appRepository.create({
        organizationId,
        name: dto.name,
        slug: dto.slug.trim().toLowerCase(),
        description: dto.description ?? null,
        agentIds,
        branding: dto.branding ?? {},
        authMode: dto.authMode ?? AppAuthMode.PUBLIC_LINK,
        capabilities: dto.capabilities ?? {},
        isActive: true,
      }),
    );
  }

  async update(organizationId: string, slug: string, dto: UpdateAppDto): Promise<AgentApp> {
    const app = await this.findOne(organizationId, slug);

    if (dto.slug !== undefined) {
      const slugError = appSlugError(dto.slug);
      if (slugError) throw new BadRequestException(slugError);
      const slug = dto.slug.trim().toLowerCase();
      if (slug !== app.slug) {
        const clash = await this.appRepository.findOne({ where: { organizationId, slug } });
        if (clash) throw new ConflictException('A product with that name already exists');
      }
      app.slug = slug;
    }

    if (dto.agentIds !== undefined) {
      await this.assertAgentsOwned(organizationId, dto.agentIds);
      app.agentIds = dto.agentIds;
    }

    if (dto.name !== undefined) app.name = dto.name;
    if (dto.description !== undefined) app.description = dto.description ?? null;
    if (dto.branding !== undefined) app.branding = dto.branding;
    if (dto.authMode !== undefined) app.authMode = dto.authMode;
    if (dto.capabilities !== undefined) app.capabilities = dto.capabilities;
    if (dto.isActive !== undefined) app.isActive = dto.isActive;

    return this.appRepository.save(app);
  }

  async remove(organizationId: string, slug: string): Promise<void> {
    const app = await this.findOne(organizationId, slug);
    await this.appRepository.remove(app);
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
    slug: string,
    context: Parameters<typeof checkApp>[1] = {},
  ): Promise<AppCheck> {
    const app = await this.findOne(organizationId, slug);
    return checkApp(app, context);
  }

  async addDistribution(
    organizationId: string,
    slug: string,
    target: DistributionTarget,
    configuration: Record<string, any> = {},
    gatewayId: string | null = null,
  ): Promise<AppDistribution> {
    const app = await this.findOne(organizationId, slug);

    // One distribution per target, full stop. Naming the platform
    // rather than lumping them under "channel" is what makes that
    // simple: an app ships to Slack once and to Telegram once, and each
    // is separately addressable by name.
    const existing = await this.distributionRepository.findOne({
      where: { appId: app.id, target },
    });
    if (existing) {
      throw new ConflictException(`This app already ships to ${target}`);
    }

    return this.distributionRepository.save(
      this.distributionRepository.create({
        organizationId,
        appId: app.id,
        target,
        status: DistributionStatus.DRAFT,
        gatewayId,
        configuration,
      }),
    );
  }

  async removeDistribution(
    organizationId: string,
    slug: string,
    target: DistributionTarget,
  ): Promise<void> {
    const app = await this.findOne(organizationId, slug);
    const distribution = await this.distributionRepository.findOne({
      where: { appId: app.id, target },
    });
    if (!distribution) throw new NotFoundException('This app does not ship to that target');
    await this.distributionRepository.remove(distribution);
  }

  /**
   * Whether a distribution can be built or published.
   *
   * Runs the app rules plus whatever the target itself demands, so
   * a desktop build is refused for a missing bundle id and for a
   * missing cost cap in the same answer rather than one at a time.
   */
  async checkDistribution(
    organizationId: string,
    slug: string,
    target: DistributionTarget,
    context: Parameters<typeof checkApp>[1] = {},
  ): Promise<AppCheck> {
    const app = await this.findOne(organizationId, slug);
    const distribution = await this.distributionRepository.findOne({
      where: { appId: app.id, target },
    });
    if (!distribution) throw new NotFoundException('This app does not ship to that target');

    return checkDistribution(distribution.target, app, distribution.configuration, context);
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
    slug: string,
    target: DistributionTarget,
    build: NonNullable<AppDistribution['lastBuild']>,
  ): Promise<AppDistribution> {
    const app = await this.findOne(organizationId, slug);
    const distribution = await this.distributionRepository.findOne({
      where: { appId: app.id, target },
    });
    if (!distribution) throw new NotFoundException('This app does not ship to that target');

    distribution.lastBuild = { ...build, builtAt: build.builtAt ?? new Date().toISOString() };
    distribution.status = build.error ? DistributionStatus.FAILED : DistributionStatus.BUILT;
    return this.distributionRepository.save(distribution);
  }
}
