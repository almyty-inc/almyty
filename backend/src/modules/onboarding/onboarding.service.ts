import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, MoreThan, Not, Repository } from 'typeorm';

import { Api } from '../../entities/api.entity';
import { Gateway, GatewayType } from '../../entities/gateway.entity';
import { Agent } from '../../entities/agent.entity';
import { User } from '../../entities/user.entity';
import { RequestLog } from '../../entities/request-log.entity';
import { LlmProvider, LlmProviderStatus } from '../../entities/llm-provider.entity';
import { Tool, ToolStatus } from '../../entities/tool.entity';
import { AgentApp } from '../../entities/agent-app.entity';
import { AppDistribution, DistributionStatus } from '../../entities/agent-app-distribution.entity';
import { Runner } from '../../entities/runner.entity';
import {
  OnboardingLinks,
  OnboardingState,
  OnboardingSteps,
  PAGE_INTRO_TOPICS,
  PageIntroTopic,
} from './dto/onboarding.dto';

/**
 * User-Agent substring that identifies a request originating from the
 * almyty web frontend. Anything else calling a gateway (a `claude mcp
 * add` handshake, an OpenAI-compat SDK, plain curl) counts as an
 * external client for the `external_client` step (spec criterion #5).
 */
const ALMYTY_FRONTEND_UA = 'almyty-frontend';

/**
 * A distribution counts as shipped once it is served (`live`) or its
 * artifact was produced (`built`). `draft`, `building` and `failed` do not:
 * nobody can reach the agent through them yet.
 */
const SHIPPED_DISTRIBUTION_STATUSES = [DistributionStatus.LIVE, DistributionStatus.BUILT];

/**
 * Computes the platform guide's steps purely from entity state. Nothing
 * here reads a "user clicked Next" flag -- every step is a projection of
 * what actually exists in the org, so CLI-driven work checks itself off
 * on the next visit (criterion #2).
 *
 * Every read is a count or a single-row lookup on an indexed
 * organization column; no step scans a table.
 */
@Injectable()
export class OnboardingService {
  constructor(
    @InjectRepository(LlmProvider)
    private readonly providerRepo: Repository<LlmProvider>,
    @InjectRepository(Api)
    private readonly apiRepo: Repository<Api>,
    @InjectRepository(Gateway)
    private readonly gatewayRepo: Repository<Gateway>,
    @InjectRepository(Agent)
    private readonly agentRepo: Repository<Agent>,
    @InjectRepository(RequestLog)
    private readonly requestLogRepo: Repository<RequestLog>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectRepository(Tool)
    private readonly toolRepo: Repository<Tool>,
    @InjectRepository(AgentApp)
    private readonly appRepo: Repository<AgentApp>,
    @InjectRepository(AppDistribution)
    private readonly distributionRepo: Repository<AppDistribution>,
    @InjectRepository(Runner)
    private readonly runnerRepo: Repository<Runner>,
  ) {}

  async getState(organizationId: string, userId: string): Promise<OnboardingState> {
    const [
      hasProvider,
      hasApi,
      hasTools,
      gatewayWithTool,
      firstCallLog,
      externalCallExists,
      firstAgent,
      hasAgentRun,
      firstApp,
      hasShippedDistribution,
      hasRunner,
      prefs,
    ] = await Promise.all([
      this.hasHealthyProvider(organizationId),
      this.hasApi(organizationId),
      this.hasTools(organizationId),
      this.gatewayWithTool(organizationId),
      this.firstSuccessfulCall(organizationId),
      this.hasExternalClientCall(organizationId),
      this.firstAgent(organizationId),
      this.hasSuccessfulAgentRun(organizationId),
      this.firstApp(organizationId),
      this.hasShippedDistribution(organizationId),
      this.hasConnectedRunner(organizationId, userId),
      this.preferencesFor(userId),
    ]);

    const steps: OnboardingSteps = {
      provider: hasProvider,
      api: hasApi,
      tools: hasTools,
      gateway: !!gatewayWithTool,
      first_call: !!firstCallLog,
      external_client: externalCallExists,
      agent: !!firstAgent,
      agent_run: hasAgentRun,
      app: !!firstApp,
      distribution: hasShippedDistribution,
      runner: hasRunner,
    };

    const links: OnboardingLinks = {
      gateway: gatewayWithTool
        ? {
            id: gatewayWithTool.id,
            name: gatewayWithTool.name,
            type: gatewayWithTool.type,
            endpoint: gatewayWithTool.endpoint,
          }
        : null,
      agent: firstAgent ? { id: firstAgent.id, name: firstAgent.name } : null,
      app: firstApp ? { slug: firstApp.slug, name: firstApp.name } : null,
    };

    // Activation is the earliest successful call once the org owns a gateway
    // of its own. Gateways an older build seeded as a sample workspace (tagged
    // metadata.sampleWorkspace) still do not count, so poking at one cannot
    // close onboarding.
    const activatedRealAt = await this.realActivationAt(organizationId, firstCallLog);

    return {
      steps,
      links,
      dismissed: prefs.dismissed,
      dismissedIntros: prefs.dismissedIntros,
      activatedRealAt,
    };
  }

  /**
   * Health here is the observation (`isHealthy`), not the operator's
   * intent (`status`). This read `status: Not(LlmProviderStatus.ERROR)`,
   * and nothing in the build ever assigns that status -- the health sweep
   * writes `isHealthy` with a partial UPDATE and deliberately leaves
   * `status` alone -- so the filter excluded nothing and the onboarding
   * step counted a provider whose key had been rejected on every call.
   * Same pair the router uses (model-router.service.ts).
   */
  private async hasHealthyProvider(organizationId: string): Promise<boolean> {
    const count = await this.providerRepo.count({
      where: { organizationId, status: LlmProviderStatus.ACTIVE, isHealthy: true },
    });
    return count > 0;
  }

  private async hasApi(organizationId: string): Promise<boolean> {
    const count = await this.apiRepo.count({ where: { organizationId } });
    return count > 0;
  }

  /** Generated from an API or written by hand; a deleted tool is gone. */
  private async hasTools(organizationId: string): Promise<boolean> {
    const count = await this.toolRepo.count({
      where: { organizationId, status: Not(ToolStatus.DELETED) },
    });
    return count > 0;
  }

  /**
   * A non-system gateway with at least one assigned tool (join row), MCP
   * first because that is the one a coding harness connects to with a
   * single command. One row, so the guide can link to its integrations.
   */
  private async gatewayWithTool(organizationId: string): Promise<Gateway | null> {
    return this.gatewayRepo
      .createQueryBuilder('gw')
      .innerJoin('gw.tools', 'gt')
      .select(['gw.id', 'gw.name', 'gw.type', 'gw.endpoint', 'gw.createdAt'])
      .where('gw.organizationId = :organizationId', { organizationId })
      .andWhere('gw.isSystem = false')
      .orderBy(`CASE WHEN gw.type = '${GatewayType.MCP}' THEN 0 ELSE 1 END`, 'ASC')
      .addOrderBy('gw.createdAt', 'ASC')
      .limit(1)
      .getOne();
  }

  /**
   * The oldest agent the org built. `isTemporary` agents are scratch
   * copies the runtime spawns for a sub-agent step, not something a
   * person made.
   */
  private async firstAgent(organizationId: string): Promise<Pick<Agent, 'id' | 'name'> | null> {
    return this.agentRepo.findOne({
      where: { organizationId, isTemporary: false },
      select: { id: true, name: true },
      order: { createdAt: 'ASC' },
    });
  }

  /**
   * `successfulExecutions` is bumped by both engines on a successful
   * finish (workflow: agent-execution-state.helper; autonomous:
   * agent-runtime-misc.helper), so one counter answers "has any agent of
   * this org ever worked" without reading either runs table.
   */
  private async hasSuccessfulAgentRun(organizationId: string): Promise<boolean> {
    const count = await this.agentRepo.count({
      where: { organizationId, isTemporary: false, successfulExecutions: MoreThan(0) },
    });
    return count > 0;
  }

  private async firstApp(organizationId: string): Promise<Pick<AgentApp, 'slug' | 'name'> | null> {
    return this.appRepo.findOne({
      where: { organizationId },
      select: { slug: true, name: true },
      order: { createdAt: 'ASC' },
    });
  }

  private async hasShippedDistribution(organizationId: string): Promise<boolean> {
    const count = await this.distributionRepo.count({
      where: { organizationId, status: In(SHIPPED_DISTRIBUTION_STATUSES) },
    });
    return count > 0;
  }

  /**
   * "Run it on your machines" is per person: a runner belongs to one user
   * in one org (unique on ownerUserId + organizationId). It counts once it
   * has actually connected -- a registration whose daemon never sent a
   * heartbeat is a token, not a machine.
   */
  private async hasConnectedRunner(organizationId: string, userId: string): Promise<boolean> {
    const count = await this.runnerRepo.count({
      where: { organizationId, ownerUserId: userId, lastHeartbeatAt: Not(IsNull()) },
    });
    return count > 0;
  }

  /**
   * Earliest successful gateway request OR agent run for the org.
   *
   * Scoped on `request_logs.organizationId`, which
   * `IDX_request_logs_organizationId_timestamp` covers with the
   * timestamp this orders by. The older
   * `(gw.organizationId = ... OR log.metadata->>'organizationId' = ...)`
   * ORed across `gateways` and `request_logs`, so no index could serve
   * it and an unbounded read of every tenant's logs answered a
   * checklist tick.
   *
   * `limit(1)`: TypeORM's getOne() does not add a LIMIT by itself, so
   * without it this fetched every successful log the org ever wrote
   * and kept the first.
   */
  private async firstSuccessfulCall(organizationId: string): Promise<RequestLog | null> {
    return this.requestLogRepo
      .createQueryBuilder('log')
      .where('log.organizationId = :orgId', { orgId: organizationId })
      .andWhere('log.statusCode >= 200 AND log.statusCode < 300')
      .orderBy('log.timestamp', 'ASC')
      .limit(1)
      .getOne();
  }

  private async hasExternalClientCall(organizationId: string): Promise<boolean> {
    const count = await this.requestLogRepo
      .createQueryBuilder('log')
      .where('log.organizationId = :orgId', { orgId: organizationId })
      .andWhere('log.statusCode >= 200 AND log.statusCode < 300')
      .andWhere('log.gatewayId IS NOT NULL')
      .andWhere(
        "(log.userAgent IS NULL OR log.userAgent NOT ILIKE :ua)",
        { ua: `%${ALMYTY_FRONTEND_UA}%` },
      )
      .getCount();
    return count > 0;
  }

  private async preferencesFor(
    userId: string,
  ): Promise<{ dismissed: boolean; dismissedIntros: PageIntroTopic[] }> {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    return {
      dismissed: user?.preferences?.onboardingDismissed === true,
      dismissedIntros: introsFrom(user?.preferences),
    };
  }

  /**
   * The activation timestamp: the earliest successful call, once the org
   * owns at least one gateway it set up itself. Gateways an older build
   * seeded as a sample workspace are excluded.
   */
  private async realActivationAt(
    organizationId: string,
    firstCall: RequestLog | null,
  ): Promise<string | null> {
    if (!firstCall) return null;
    const nonSampleGateway = await this.gatewayRepo
      .createQueryBuilder('gw')
      .where('gw.organizationId = :organizationId', { organizationId })
      .andWhere('gw.isSystem = false')
      .andWhere(
        "(gw.metadata IS NULL OR gw.metadata->>'sampleWorkspace' IS NULL)",
      )
      .getCount();
    return nonSampleGateway > 0 ? firstCall.timestamp.toISOString() : null;
  }

  async setDismissed(userId: string, dismissed: boolean): Promise<void> {
    await this.updatePreferences(userId, () => ({ onboardingDismissed: dismissed }));
  }

  /** Close one page intro for this user. Idempotent. */
  async dismissIntro(userId: string, topic: PageIntroTopic): Promise<void> {
    await this.updatePreferences(userId, (prefs) => {
      const current = introsFrom(prefs);
      return { onboardingDismissedIntros: current.includes(topic) ? current : [...current, topic] };
    });
  }

  /** Bring every page intro back for this user. */
  async resetIntros(userId: string): Promise<void> {
    await this.updatePreferences(userId, () => ({ onboardingDismissedIntros: [] }));
  }

  private async updatePreferences(
    userId: string,
    patch: (prefs: Record<string, any>) => Record<string, any>,
  ): Promise<void> {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) return;
    const current = user.preferences || {};
    const preferences = { ...current, ...patch(current) };
    await this.userRepo.update({ id: userId }, { preferences } as any);
  }
}

/** Stored intro dismissals, keeping only topics that still exist. */
function introsFrom(prefs: Record<string, any> | null | undefined): PageIntroTopic[] {
  const raw = prefs?.onboardingDismissedIntros;
  if (!Array.isArray(raw)) return [];
  return raw.filter((t): t is PageIntroTopic =>
    (PAGE_INTRO_TOPICS as readonly string[]).includes(t),
  );
}