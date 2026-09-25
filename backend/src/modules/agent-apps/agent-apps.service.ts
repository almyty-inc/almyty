import {
  BadRequestException,
  Optional,

  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
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

/** An app an agent is part of, and the places in it where that agent answers. */
export interface AgentUsage {
  slug: string;
  name: string;
  places: Array<{ target: DistributionTarget; status: DistributionStatus }>;
}

import {
  AppCheck,
  checkDistribution,
  checkApp,
  appSlugError,
  defaultLimitsFor,
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
import { OrgLicenseResolver } from '../licensing/org-license.resolver';
import { EE_ENTITLEMENTS } from '../licensing/license.constants';
import { CredentialType } from '../../entities/credential.entity';
import { CredentialRefResolver } from '../credentials/credential-ref.resolver';
import { channelConnectorKey } from '../gateways/channels/channel-credential.service';
import { channelSecretKeysIn } from '../gateways/channels/channel-config.helper';
import { distributionManagedBy, splitDistributionSecrets } from './distribution-secrets';


export interface CreateAppDto {
  name: string;
  slug: string;
  description?: string;
  agentIds?: string[];
  branding?: AgentApp['branding'];
  authMode?: AppAuthMode;
  capabilities?: AgentApp['capabilities'];
  limits?: AgentApp['limits'];
  privacy?: AgentApp['privacy'];

}

export type UpdateAppDto = Partial<CreateAppDto> & { isActive?: boolean };

/**
 * Ceiling on one page of apps. The list is not caller-paginated; this only
 * stops an organization with an unbounded number of products from putting
 * all of them in heap at once.
 */
export const MAX_APPS_PER_PAGE = 200;

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
    @Optional()
    private readonly orgLicense?: OrgLicenseResolver,
    // Where a distribution's platform secrets are kept. Not @Optional():
    // Nest must inject it; typed optional only for positional unit specs,
    // and without it a secret is refused rather than written to the row.
    private readonly credentialRefs?: CredentialRefResolver,
  ) {}

  async list(organizationId: string): Promise<Array<AgentApp & { health: AppHealth }>> {
    const apps = await this.appRepository.find({
      where: { organizationId },
      order: { createdAt: 'DESC' },
      take: MAX_APPS_PER_PAGE,
    });

    // The health of every app's agents in three queries rather than
    // 1 + 2 x (apps x agents). This used to issue two findOnes per agent of
    // every app, plus a name lookup per failure: 20 apps x 3 agents was 121
    // queries per page load, against the two largest tables in the schema.
    const agentIds = [...new Set(apps.flatMap((app) => app.agentIds ?? []))];
    const latest = await this.latestActivityByAgent(organizationId, agentIds);
    const failingIds = [...latest.entries()]
      .filter(([, a]) => a.status === 'failed' || a.status === 'timeout')
      .map(([agentId]) => agentId);
    const names = await this.agentNames(organizationId, failingIds);

    return apps.map((app) => ({
      ...app,
      health: this.healthFrom(app.agentIds ?? [], latest, names),
    }));
  }

  /**
   * Every app in this organization that carries the agent, with the
   * places in each where it is the one answering (the place names it, or
   * it is the app's default). An app that carries it but answers with
   * another agent everywhere is still listed, with no places, so "used
   * in" never hides a product the agent is part of.
   */
  async usedBy(organizationId: string, agentId: string): Promise<AgentUsage[]> {
    const apps = await this.appRepository
      .createQueryBuilder('app')
      .leftJoinAndSelect('app.distributions', 'distribution')
      .where('app.organizationId = :organizationId', { organizationId })
      .andWhere(':agentId = ANY(app.agentIds)', { agentId })
      .orderBy('app.name', 'ASC')
      .take(MAX_APPS_PER_PAGE)
      .getMany();

    return apps.map((app) => ({
      slug: app.slug,
      name: app.branding?.appName || app.name,
      places: (app.distributions ?? [])
        .filter((d) => agentForDistribution(app, d.configuration) === agentId)
        .map((d) => ({ target: d.target, status: d.status }))
        .sort((a, b) => a.target.localeCompare(b.target)),
    }));
  }

  /**
   * The most recent execution or run per agent, whichever is later.
   *
   * One windowed `DISTINCT ON (agentId)` per table: Postgres keeps only the
   * first row of each agent's `createdAt DESC` ordering, so this is the same
   * answer the per-agent findOne pair produced, in two queries instead of
   * two per agent.
   */
  private async latestActivityByAgent(
    organizationId: string,
    agentIds: string[],
  ): Promise<Map<string, { status: string; createdAt: Date; error?: string | null }>> {
    const latest = new Map<string, { status: string; createdAt: Date; error?: string | null }>();
    if (!agentIds.length) return latest;

    const newest = <T extends { agentId: string; status: string; createdAt: Date; error?: string | null }>(
      rows: T[],
    ) => {
      for (const row of rows) {
        const current = latest.get(row.agentId);
        if (!current || new Date(row.createdAt).getTime() > new Date(current.createdAt).getTime()) {
          latest.set(row.agentId, { status: row.status, createdAt: row.createdAt, error: row.error });
        }
      }
    };

    const [executions, runs] = await Promise.all([
      this.executionRepository
        .createQueryBuilder('execution')
        .select(['execution.agentId', 'execution.status', 'execution.createdAt', 'execution.error'])
        .where('execution.organizationId = :organizationId', { organizationId })
        .andWhere('execution.agentId IN (:...agentIds)', { agentIds })
        .distinctOn(['"execution"."agentId"'])
        .orderBy('execution.agentId', 'ASC')
        .addOrderBy('execution.createdAt', 'DESC')
        .getMany(),
      this.runRepository
        .createQueryBuilder('run')
        .select(['run.agentId', 'run.status', 'run.createdAt', 'run.error'])
        .where('run.organizationId = :organizationId', { organizationId })
        .andWhere('run.agentId IN (:...agentIds)', { agentIds })
        .distinctOn(['"run"."agentId"'])
        .orderBy('run.agentId', 'ASC')
        .addOrderBy('run.createdAt', 'DESC')
        .getMany(),
    ]);

    newest(executions as any[]);
    newest(runs as any[]);
    return latest;
  }

  /** Display names for the agents a failure will be reported against. */
  private async agentNames(
    organizationId: string,
    agentIds: string[],
  ): Promise<Map<string, string>> {
    if (!agentIds.length) return new Map();
    const agents = await this.agentRepository.find({
      where: { id: In(agentIds), organizationId },
      select: { id: true, name: true },
    });
    return new Map(agents.map((a) => [a.id, a.name]));
  }

  /** The same verdict `health()` reaches, from already-loaded rows. */
  private healthFrom(
    agentIds: string[],
    latest: Map<string, { status: string; createdAt: Date; error?: string | null }>,
    names: Map<string, string>,
  ): AppHealth {
    for (const agentId of agentIds) {
      const activity = latest.get(agentId);
      if (!activity) continue;
      if (activity.status === 'failed' || activity.status === 'timeout') {
        return {
          state: 'failing',
          agentId,
          agentName: names.get(agentId) ?? agentId,
          at: activity.createdAt,
          message: activity.error ?? `Last run ${activity.status}`,
        };
      }
    }
    return { state: 'ok' };
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
      select: { id: true, visibility: true },
    });
    if (owned.length !== agentIds.length) {
      const ownedIds = new Set(owned.map((a) => a.id));
      const missing = agentIds.filter((id) => !ownedIds.has(id));
      throw new BadRequestException(
        `These agents do not exist in this organization: ${missing.join(', ')}`,
      );
    }
    // An app is an organization's product with public surfaces; a private
    // ("just me") agent cannot be put behind one. Named by id only.
    const privateIds = owned.filter((a) => a.visibility === 'private').map((a) => a.id);
    if (privateIds.length) {
      throw new BadRequestException(
        `These agents are private to their owner and cannot be served by an app: ${privateIds.join(', ')}. ` +
          'Share the agent with the organization first.',
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
        // A product open to anyone starts with a ceiling on every axis
        // rather than with empty fields and a publish rule that refuses
        // it. The numbers are meant to be edited, not discovered.
        limits: dto.limits ?? defaultLimitsFor(dto.authMode ?? AppAuthMode.PUBLIC_LINK),
        privacy: dto.privacy ?? null,
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
    if (dto.privacy !== undefined) app.privacy = dto.privacy;

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
    return checkApp(app, await this.limitsContext(app, context));
  }

  /**
   * The app's own limits, unless the caller knows better.
   *
   * Without this the cost-cap and rate-limit rules were checked against
   * an empty context on every call, so a public product showed both
   * refusals for ever and no setting could clear them.
   */
  private async limitsContext(
    app: AgentApp,
    context: Parameters<typeof checkApp>[1] = {},
  ): Promise<Parameters<typeof checkApp>[1]> {
    return {
      costCapCents: app.limits?.costCapCents ?? null,
      perUserRateLimit: app.limits?.perUserRateLimit ?? null,
      perIpRateLimit: app.limits?.perIpRateLimit ?? null,
      // SSO is an enterprise entitlement; until this was passed in, every
      // SSO app was refused at publish whether the org had it or not.
      hasEnterpriseAuth: this.orgLicense ? await this.orgLicense.hasForOrg(app.organizationId, 'sso') : false,
      // And the same for white label, which was left out when the SSO
      // half above was fixed -- so WHITE_LABEL_NOT_ENTITLED and
      // DISCLOSURE_REMOVAL_NOT_ENTITLED refused every app, entitled or
      // not, for exactly the reason the comment above describes.
      hasWhiteLabel: this.orgLicense
        ? await this.orgLicense.hasForOrg(app.organizationId, EE_ENTITLEMENTS.WHITE_LABEL)
        : false,
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
    // Platform secrets never reach the row: they go to the credential
    // store below and the configuration keeps a reference. Responses
    // mask them, so a placeholder sent back is dropped here, not stored.
    const incoming = splitDistributionSecrets(configuration);

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
      // sending it empty, which every reader treats as unset. A secret
      // still inline on an older row moves to the store with this write.
      const stored = splitDistributionSecrets(existing.configuration);
      existing.configuration = {
        ...stored.publicConfig,
        ...this.credentialReference(existing.configuration),
        ...incoming.publicConfig,
      };
      if (gatewayId !== null) existing.gatewayId = gatewayId;
      await this.storeDistributionSecrets(app, existing, { ...stored.secrets, ...incoming.secrets }, incoming.cleared);
      return this.distributionRepository.save(existing);
    }

    // The managed credential names the distribution, so the row is saved
    // first with only its public part, then pointed at the credential.
    const created = await this.distributionRepository.save(
      this.distributionRepository.create({
        organizationId,
        appId: app.id,
        target,
        status: DistributionStatus.DRAFT,
        gatewayId,
        configuration: incoming.publicConfig,
      }),
    );
    if (Object.keys(incoming.secrets).length === 0) return created;
    await this.storeDistributionSecrets(app, created, incoming.secrets, []);
    return this.distributionRepository.save(created);
  }

  /** `credentialId` / `credentialKeys` of a stored configuration, the only server-owned keys it keeps. */
  private credentialReference(configuration: Record<string, any> | null | undefined): Record<string, any> {
    const id = configuration?.credentialId;
    if (typeof id !== 'string' || !id) return {};
    return { credentialId: id, credentialKeys: Array.isArray(configuration?.credentialKeys) ? configuration!.credentialKeys : [] };
  }

  /**
   * Put a distribution's platform secrets in its managed credential:
   * rotated in place when it has one, created when not. Mutates the
   * distribution's configuration to reference it. `cleared` keys are
   * emptied on the credential, which every reader treats as unset.
   */
  private async storeDistributionSecrets(
    app: AgentApp,
    distribution: AppDistribution,
    secrets: Record<string, string>,
    cleared: string[],
  ): Promise<void> {
    const secretKeys = Object.keys(secrets);
    if (secretKeys.length === 0 && cleared.length === 0) return;
    if (!this.credentialRefs) {
      // Failing closed: the alternative is writing the secret onto the row.
      throw new ServiceUnavailableException('The credential store is not available, so platform credentials cannot be saved.');
    }
    const organizationId = distribution.organizationId;
    const managedBy = distributionManagedBy(distribution.id);
    const currentId = distribution.configuration?.credentialId;
    const current =
      typeof currentId === 'string' && currentId
        ? await this.credentialRefs.load(organizationId, currentId).catch(() => null)
        : null;

    let row;
    if (current && CredentialRefResolver.isManagedBy(current, managedBy)) {
      const patch: Record<string, string> = { ...secrets };
      for (const key of cleared) if (!(key in patch)) patch[key] = '';
      row = await this.credentialRefs.rotateManaged(organizationId, current.id, { config: patch, secretKeys, managedBy });
    } else if (secretKeys.length > 0) {
      const gatewayType = GATEWAY_TYPE_FOR_TARGET[distribution.target];
      row = await this.credentialRefs.createManaged(organizationId, {
        name: `${app.name} ${distribution.target} distribution`,
        description: `Platform credentials of the ${distribution.target} distribution of app ${app.slug}`,
        type: CredentialType.CUSTOM,
        config: secrets,
        secretKeys,
        connectorKey: gatewayType ? channelConnectorKey(gatewayType) : null,
        managedBy,
      });
    } else {
      return;
    }
    distribution.configuration = {
      ...(distribution.configuration ?? {}),
      credentialId: row.id,
      credentialKeys: channelSecretKeysIn(row.config),
    };
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
    const product = checkApp(app, await this.limitsContext(app));
    // The agent that will actually answer: the one this surface names,
    // or the product's default. Resolved before the checks so a surface
    // is never published in front of an agent that cannot hold a
    // conversation.
    const agentId = agentForDistribution(app, distribution.configuration);
    const agent = agentId
      ? await this.agentRepository.findOne({ where: { id: agentId, organizationId } })
      : null;
    // The agent may have been made private after the app was built.
    if (agent?.visibility === 'private') {
      throw new BadRequestException(
        'This app answers with an agent that is private to its owner. Share the agent with the organization before publishing.',
      );
    }

    const publish = checkPublish(target, app, distribution.configuration, agent);
    const refusals = [...product.refusals, ...publish.refusals];
    if (refusals.length) {
      throw new BadRequestException(refusals.map((r) => r.message).join(' '));
    }

    // Stand the gateway up but keep it quiet, record it on the
    // distribution, and only then let it answer.
    //
    // The gateway used to be created ACTIVE — routable the instant it
    // committed — and the distribution row saved afterwards, with no
    // transaction. A pod evicted between the two left a Slack or
    // WhatsApp surface answering customers while the distribution said
    // not-live and carried no gatewayId, and unpublishDistribution
    // resolves the gateway through that id, so the product had no
    // handle on the thing that was talking.
    //
    // Activating last inverts the worst case instead of transacting
    // over it: a crash now leaves a distribution marked LIVE in front
    // of a gateway that is not answering. That is visible in the UI,
    // takes no messages, and republishing (which is idempotent and
    // reactivates by endpoint, not by gatewayId) fixes it. A
    // transaction would not help with the half that matters — the
    // gateway's own platform-side registration is not a database
    // write and cannot be rolled back.
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
        rateLimitConfig: rateLimitFor(app, target),
        // A surface serves only what its own scope covers, so a team agent
        // is published through a gateway scoped to that team; the gateway
        // write checks the publisher may do that (member or org admin).
        ...(agent?.visibility === 'team' && agent.teamId
          ? { visibility: 'team' as const, teamId: agent.teamId }
          : { visibility: 'org' as const }),
      },
      organizationId,
      userId,
      { activate: false, gatewayId: distribution.gatewayId },
    );

    distribution.gatewayId = gateway.id;
    distribution.status = DistributionStatus.LIVE;
    const saved = await this.distributionRepository.save(distribution);

    await this.gateways.activateGateway(gateway.id, organizationId, userId);

    return saved;
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
    // Its platform credentials go with it. A shared connection it was
    // pointed at is not its to delete, and releaseManaged leaves that alone.
    await this.credentialRefs?.releaseManaged(
      organizationId,
      distribution.configuration?.credentialId,
      distributionManagedBy(distribution.id),
    );
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
      await this.limitsContext(app, context),
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
