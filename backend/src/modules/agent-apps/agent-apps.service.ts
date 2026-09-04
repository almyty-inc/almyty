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
import { AgentExecution } from '../../entities/agent-execution.entity';
import { AgentRun } from '../../entities/agent-run.entity';

/** What the apps page shows next to a product: is its agent working right now? */
export type AppHealth =
  | { state: 'ok' }
  | { state: 'failing'; agentId: string; agentName: string; at: Date; message: string };

import {
  AppCheck,
  checkDistribution,
  checkApp,
  appSlugError,
} from './agent-app.rules';
import {
  GATEWAY_TYPE_FOR_TARGET,
  agentForDistribution,
  checkPublish,
  endpointFor,
  gatewayConfigurationFor,
  gatewayNameFor,
  rateLimitFor,
} from './distribution-publish';
import { GatewaysService } from '../gateways/gateways.service';

export interface CreateAppDto {
  name: string;
  slug: string;
  description?: string;
  agentIds?: string[];
  branding?: AgentApp['branding'];
  authMode?: AppAuthMode;
  capabilities?: AgentApp['capabilities'];
  limits?: AgentApp['limits'];
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
    @InjectRepository(AgentExecution)
    private readonly executionRepository: Repository<AgentExecution>,
    @InjectRepository(AgentRun)
    private readonly runRepository: Repository<AgentRun>,

    private readonly gateways: GatewaysService,
  ) {}

  async list(organizationId: string): Promise<Array<AgentApp & { health: AppHealth }>> {
    const apps = await this.appRepository.find({
      where: { organizationId },
      order: { createdAt: 'DESC' },
    });
    return Promise.all(apps.map(async (app) => ({ ...app, health: await this.health(organizationId, app.agentIds ?? []) })));
  }

  /**
   * Did the last thing any of this app's agents did fail?
   *
   * A product whose agent is failing looked identical on the apps page
   * to one that is idle; the only trace was a visitor's empty screen.
   * Look at the most recent execution (workflow agents) or run
   * (autonomous agents) per agent and report the failure, if that is
   * what happened last.
   */
  async health(organizationId: string, agentIds: string[]): Promise<AppHealth> {
    for (const agentId of agentIds) {
      const [execution, run] = await Promise.all([
        this.executionRepository.findOne({ where: { agentId, organizationId }, order: { createdAt: 'DESC' } }),
        this.runRepository.findOne({ where: { agentId, organizationId }, order: { createdAt: 'DESC' } }),
      ]);
      const latest = [execution, run]
        .filter((x): x is AgentExecution | AgentRun => !!x)
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];
      if (!latest) continue;
      if (latest.status === 'failed' || latest.status === 'timeout') {
        const agent = await this.agentRepository.findOne({ where: { id: agentId, organizationId }, select: { id: true, name: true } });
        return {
          state: 'failing',
          agentId,
          agentName: agent?.name ?? agentId,
          at: latest.createdAt,
          message: latest.error ?? `Last run ${latest.status}`,
        };
      }
    }
    return { state: 'ok' };
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
    if (dto.limits !== undefined) app.limits = dto.limits;
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
    return checkApp(app, this.limitsContext(app, context));
  }

  /**
   * The app's own limits, unless the caller knows better.
   *
   * Without this the cost-cap and rate-limit rules were checked against
   * an empty context on every call, so a public product showed both
   * refusals for ever and no setting could clear them.
   */
  private limitsContext(
    app: AgentApp,
    context: Parameters<typeof checkApp>[1] = {},
  ): Parameters<typeof checkApp>[1] {
    return {
      costCapCents: app.limits?.costCapCents ?? null,
      perUserRateLimit: app.limits?.perUserRateLimit ?? null,
      perIpRateLimit: app.limits?.perIpRateLimit ?? null,
      ...context,
    };
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
    //
    // Shipping somewhere it already ships is a settings change, not a
    // conflict. This used to reject it, which meant every edit to a
    // distribution's settings failed once it existed.
    const existing = await this.distributionRepository.findOne({
      where: { appId: app.id, target },
    });
    if (existing) {
      // Merged rather than replaced, so a caller that sends one field
      // does not silently drop the others. Clearing a field is done by
      // sending it empty, which every reader treats as unset.
      existing.configuration = { ...(existing.configuration ?? {}), ...configuration };
      if (gatewayId !== null) existing.gatewayId = gatewayId;
      return this.distributionRepository.save(existing);
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

  /**
   * Make a distribution answer.
   *
   * Until this exists a distribution is a row: adding one to Slack
   * records an intent and connects nothing. Publishing stands up a
   * gateway of the matching type, wired to the app's first agent, and
   * marks the distribution live.
   *
   * Idempotent. Publishing something already published re-syncs the
   * gateway with the app's current name and limits rather than creating
   * a second one, because the endpoint is unique per organization and
   * the second attempt is usually someone reapplying a settings change.
   */
  async publishDistribution(
    organizationId: string,
    slug: string,
    target: DistributionTarget,
    userId: string,
  ): Promise<AppDistribution> {
    const app = await this.findOne(organizationId, slug);
    const distribution = await this.distributionRepository.findOne({
      where: { appId: app.id, target },
    });
    if (!distribution) throw new NotFoundException('This app does not ship to that target');

    // Both gates, as one list. The product-wide rules are the reason a
    // public product needs a cost cap; the publish rules are the ones
    // that only apply at this moment.
    const product = checkApp(app, this.limitsContext(app));
    // The agent that will actually answer: the one this surface names,
    // or the product's default. Resolved before the checks so a surface
    // is never published in front of an agent that cannot hold a
    // conversation.
    const agentId = agentForDistribution(app, distribution.configuration);
    const agent = agentId
      ? await this.agentRepository.findOne({ where: { id: agentId, organizationId } })
      : null;

    const publish = checkPublish(target, app, distribution.configuration, agent);
    const refusals = [...product.refusals, ...publish.refusals];
    if (refusals.length) {
      throw new BadRequestException(refusals.map((r) => r.message).join(' '));
    }

    const gateway = await this.gateways.upsertForDistribution(
      {
        name: gatewayNameFor(app, target),
        description: app.description ?? undefined,
        type: GATEWAY_TYPE_FOR_TARGET[target]!,
        agentId: agentId!,
        endpoint: endpointFor(app.slug, target),
        // Carries the operator's platform credentials, the product's
        // branding, and for the hosted chat the block it is looked up
        // by. Without that last one a published web app was a gateway
        // nothing could find.
        configuration: gatewayConfigurationFor(target, app, distribution.configuration),
        rateLimitConfig: rateLimitFor(app),
      },
      organizationId,
      userId,
    );

    distribution.gatewayId = gateway.id;
    distribution.status = DistributionStatus.LIVE;
    return this.distributionRepository.save(distribution);
  }

  /**
   * Stop answering, without forgetting the distribution.
   *
   * The gateway is deactivated rather than deleted, so republishing
   * keeps the same endpoint and whatever credentials were attached to
   * it. Someone taking a product down for an afternoon should not have
   * to re-register a Slack app afterwards.
   */
  async unpublishDistribution(
    organizationId: string,
    slug: string,
    target: DistributionTarget,
    userId: string,
  ): Promise<AppDistribution> {
    const app = await this.findOne(organizationId, slug);
    const distribution = await this.distributionRepository.findOne({
      where: { appId: app.id, target },
    });
    if (!distribution) throw new NotFoundException('This app does not ship to that target');

    if (distribution.gatewayId) {
      await this.gateways.deactivateGateway(distribution.gatewayId, organizationId, userId);
    }

    distribution.status = DistributionStatus.DRAFT;
    return this.distributionRepository.save(distribution);
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

    return checkDistribution(
      distribution.target,
      app,
      distribution.configuration,
      this.limitsContext(app, context),
    );
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
