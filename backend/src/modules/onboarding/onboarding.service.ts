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
   *
   * Scoped on `request_logs.organizationId`, which
   * `IDX_request_logs_organizationId_timestamp` covers with the
   * timestamp this orders by. The older
   * `(gw.organizationId = ... OR log.metadata->>'organizationId' = ...)`
   * ORed across `gateways` and `request_logs`, so no index could serve
   * it and an unbounded read of every tenant's logs answered a
   * checklist tick.
   */
  private async firstSuccessfulCall(organizationId: string): Promise<RequestLog | null> {
    return this.requestLogRepo
      .createQueryBuilder('log')
      .where('log.organizationId = :orgId', { orgId: organizationId })
      .andWhere('log.statusCode >= 200 AND log.statusCode < 300')
      .orderBy('log.timestamp', 'ASC')
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
