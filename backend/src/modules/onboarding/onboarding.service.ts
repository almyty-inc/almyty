import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Not, Repository } from 'typeorm';

import { Api } from '../../entities/api.entity';
import { Gateway } from '../../entities/gateway.entity';
import { Agent } from '../../entities/agent.entity';
import { User } from '../../entities/user.entity';
import { RequestLog } from '../../entities/request-log.entity';
import { LlmProvider, LlmProviderStatus } from '../../entities/llm-provider.entity';
import { OnboardingState, OnboardingSteps } from './dto/onboarding.dto';

/**
 * User-Agent substring that identifies a request originating from the
 * almyty web frontend. Anything else calling a gateway (a `claude mcp
 * add` handshake, an OpenAI-compat SDK, plain curl) counts as an
 * external client for the `external_client` step (spec criterion #5).
 */
const ALMYTY_FRONTEND_UA = 'almyty-frontend';

/**
 * Computes the onboarding "golden path" checklist purely from entity
 * state. Nothing here reads a "user clicked Next" flag — the checklist
 * is a projection of what actually exists in the org, so CLI-driven
 * work checks itself off on the next dashboard visit (criterion #2).
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
  ) {}

  async getState(organizationId: string, userId: string): Promise<OnboardingState> {
    const [
      hasProvider,
      hasApi,
      hasGatewayWithTool,
      firstCallLog,
      externalCallExists,
      hasSampleWorkspace,
      dismissed,
    ] = await Promise.all([
      this.hasHealthyProvider(organizationId),
      this.hasApi(organizationId),
      this.hasGatewayWithTool(organizationId),
      this.firstSuccessfulCall(organizationId),
      this.hasExternalClientCall(organizationId),
      this.hasSampleWorkspace(organizationId),
      this.isDismissedFor(userId),
    ]);

    const steps: OnboardingSteps = {
      provider: hasProvider,
      api: hasApi,
      gateway: hasGatewayWithTool,
      first_call: !!firstCallLog,
      external_client: externalCallExists,
    };

    // A successful call through any gateway/agent is the sample-activation
    // moment; a successful call whose entities are non-sample is the real
    // one. We approximate the "real" timestamp with the earliest successful
    // call once the org owns at least one non-sample gateway.
    const activatedSampleAt = firstCallLog ? firstCallLog.timestamp.toISOString() : null;
    const activatedRealAt = await this.realActivationAt(organizationId, firstCallLog);

    return {
      steps,
      sampleWorkspace: hasSampleWorkspace,
      dismissed,
      activatedSampleAt,
      activatedRealAt,
    };
  }

  private async hasHealthyProvider(organizationId: string): Promise<boolean> {
    const count = await this.providerRepo.count({
      where: { organizationId, status: Not(LlmProviderStatus.ERROR) },
    });
    return count > 0;
  }

  private async hasApi(organizationId: string): Promise<boolean> {
    const count = await this.apiRepo.count({ where: { organizationId } });
    return count > 0;
  }

  private async hasGatewayWithTool(organizationId: string): Promise<boolean> {
    // A non-system gateway with at least one assigned tool (join row).
    const count = await this.gatewayRepo
      .createQueryBuilder('gw')
      .innerJoin('gw.tools', 'gt')
      .where('gw.organizationId = :organizationId', { organizationId })
      .andWhere('gw.isSystem = false')
      .getCount();
    return count > 0;
  }

  /**
   * Earliest successful gateway request OR agent run for the org.
   * RequestLog has no direct org column; it is scoped through its
   * gateway (or a metadata.organizationId stamp), matching the
   * analytics service's own scoping.
   */
  private async firstSuccessfulCall(organizationId: string): Promise<RequestLog | null> {
    return this.requestLogRepo
      .createQueryBuilder('log')
      .leftJoin('log.gateway', 'gw')
      .where(
        "(gw.organizationId = :orgId OR log.metadata->>'organizationId' = :orgId)",
        { orgId: organizationId },
      )
      .andWhere('log.statusCode >= 200 AND log.statusCode < 300')
      .orderBy('log.timestamp', 'ASC')
      .getOne();
  }

  private async hasExternalClientCall(organizationId: string): Promise<boolean> {
    const count = await this.requestLogRepo
      .createQueryBuilder('log')
      .leftJoin('log.gateway', 'gw')
      .where(
        "(gw.organizationId = :orgId OR log.metadata->>'organizationId' = :orgId)",
        { orgId: organizationId },
      )
      .andWhere('log.statusCode >= 200 AND log.statusCode < 300')
      .andWhere('log.gatewayId IS NOT NULL')
      .andWhere(
        "(log.userAgent IS NULL OR log.userAgent NOT ILIKE :ua)",
        { ua: `%${ALMYTY_FRONTEND_UA}%` },
      )
      .getCount();
    return count > 0;
  }

  private async hasSampleWorkspace(organizationId: string): Promise<boolean> {
    const count = await this.apiRepo
      .createQueryBuilder('api')
      .where('api.organizationId = :organizationId', { organizationId })
      .andWhere("api.metadata->>'sampleWorkspace' = :key", { key: 'petstore' })
      .getCount();
    return count > 0;
  }

  private async isDismissedFor(userId: string): Promise<boolean> {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    return user?.preferences?.onboardingDismissed === true;
  }

  /**
   * The "real" activation timestamp: the earliest successful call, but
   * only once the org owns at least one non-sample gateway (otherwise
   * every call is against sample objects and only `activated_sample`
   * applies).
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
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) return;
    const preferences = { ...(user.preferences || {}), onboardingDismissed: dismissed };
    await this.userRepo.update({ id: userId }, { preferences } as any);
  }
}
