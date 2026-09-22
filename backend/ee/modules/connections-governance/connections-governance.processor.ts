import { InjectQueue, OnQueueFailed, Process, Processor } from '@nestjs/bull';
import { Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Job, Queue } from 'bull';

import { EE_ENTITLEMENTS } from '../../../src/modules/licensing/license.constants';
import { OrgLicenseResolver } from '../../../src/modules/licensing/org-license.resolver';
import { ConnectionsGovernanceService, ExpiryRunResult, RotationRunResult } from './connections-governance.service';

export const CONNECTIONS_GOVERNANCE_QUEUE = 'connections-governance';
export const EXPIRY_JOB = 'expiry';
export const ROTATION_JOB = 'rotation';

/** Stable ids so restarts do not stack schedules and a cron change can evict the old one. */
export const EXPIRY_REPEAT_JOB_ID = 'connections-governance-expiry';
export const ROTATION_REPEAT_JOB_ID = 'connections-governance-rotation';

/** Daily at 03:00 UTC, before the provider usage pull and price feed. */
export const DEFAULT_CRON = '0 3 * * *';
export const CRON_ENV = 'CONNECTIONS_GOVERNANCE_CRON';

export interface SweepSummary {
  organizations: number;
  results: Array<ExpiryRunResult | RotationRunResult>;
  retentionRemoved?: number;
}

/**
 * Nightly governance sweep: expiry enforcement, scheduled rotation and
 * the audit retention window, per organization that holds the
 * `connections_governance` entitlement and has a matching enabled
 * rule. Cadence via CONNECTIONS_GOVERNANCE_CRON (or `off`), always off
 * under NODE_ENV=test. `POST /ee/connections/rotate-due` and the
 * expiry endpoint run the same handlers on demand for one org.
 */
@Processor(CONNECTIONS_GOVERNANCE_QUEUE)
export class ConnectionsGovernanceProcessor implements OnApplicationBootstrap {
  private readonly logger = new Logger(ConnectionsGovernanceProcessor.name);

  constructor(
    @InjectQueue(CONNECTIONS_GOVERNANCE_QUEUE) private readonly queue: Queue,
    private readonly governance: ConnectionsGovernanceService,
    private readonly licenses: OrgLicenseResolver,
  ) {}

  /** The configured cron, or undefined when the sweep is turned off. */
  cron(): string | undefined {
    const raw = process.env[CRON_ENV]?.trim();
    if (raw && raw.toLowerCase() === 'off') return undefined;
    return raw && raw.length > 0 ? raw : DEFAULT_CRON;
  }

  isEnabled(): boolean {
    return process.env.NODE_ENV !== 'test' && this.cron() !== undefined;
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.isEnabled()) {
      this.logger.log(`Connections governance sweep disabled (NODE_ENV=test or ${CRON_ENV}=off)`);
      return;
    }
    const cron = this.cron() as string;
    try {
      const existing = await this.queue.getRepeatableJobs();
      for (const repeatable of existing) {
        if ((repeatable.id === EXPIRY_REPEAT_JOB_ID || repeatable.id === ROTATION_REPEAT_JOB_ID) && repeatable.cron !== cron) {
          await this.queue.removeRepeatableByKey(repeatable.key);
        }
      }
      await this.queue.add(EXPIRY_JOB, {}, { jobId: EXPIRY_REPEAT_JOB_ID, repeat: { cron }, removeOnComplete: true, removeOnFail: true });
      await this.queue.add(ROTATION_JOB, {}, { jobId: ROTATION_REPEAT_JOB_ID, repeat: { cron }, removeOnComplete: true, removeOnFail: true });
      this.logger.log(`Connections governance sweep registered: "${cron}"`);
    } catch (error: any) {
      // Scheduling is best-effort; a Redis hiccup at bootstrap must not take the API down.
      this.logger.error(`Failed to schedule connections governance sweep: ${error.message}`);
    }
  }

  private async licensed(organizationId: string): Promise<boolean> {
    try {
      return await this.licenses.hasForOrg(organizationId, EE_ENTITLEMENTS.CONNECTIONS_GOVERNANCE);
    } catch {
      return false;
    }
  }

  @Process(EXPIRY_JOB)
  async handleExpiry(_job?: Job): Promise<SweepSummary> {
    const summary: SweepSummary = { organizations: 0, results: [], retentionRemoved: 0 };
    const orgs = await this.governance.organizationsWithPolicies(['expiry_rule']);
    for (const organizationId of orgs) {
      if (!(await this.licensed(organizationId))) continue;
      summary.organizations++;
      try {
        summary.results.push(await this.governance.enforceExpiry(organizationId));
        summary.retentionRemoved! += await this.governance.sweepRetention(organizationId);
      } catch (error: any) {
        // One org's failure must not abort the sweep for the rest.
        this.logger.warn(`expiry sweep failed for ${organizationId}: ${error?.message ?? error}`);
      }
    }
    this.logger.log(`Connections expiry sweep: ${summary.organizations} organization(s)`);
    return summary;
  }

  @Process(ROTATION_JOB)
  async handleRotation(_job?: Job): Promise<SweepSummary> {
    const summary: SweepSummary = { organizations: 0, results: [] };
    const orgs = await this.governance.organizationsWithPolicies(['rotation_rule']);
    for (const organizationId of orgs) {
      if (!(await this.licensed(organizationId))) continue;
      summary.organizations++;
      try {
        summary.results.push(await this.governance.rotateDue(organizationId));
      } catch (error: any) {
        this.logger.warn(`rotation sweep failed for ${organizationId}: ${error?.message ?? error}`);
      }
    }
    this.logger.log(`Connections rotation sweep: ${summary.organizations} organization(s)`);
    return summary;
  }

  @OnQueueFailed()
  onFailed(job: Job, error: Error): void {
    this.logger.error(`Connections governance job ${job?.id} failed: ${error.message}`);
  }
}
