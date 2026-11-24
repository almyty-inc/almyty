import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Organization } from '../../../src/entities/organization.entity';
import { HostedCapacity, HostedCapacityProvider } from '../../../src/modules/hosted-runners/hosted-capacity.provider';
import { HostedRunnerSettingsService } from '../../../src/modules/hosted-runners/hosted-runner-settings';
import { STRIPE_SECRET_KEY_ENV } from './billing.constants';
import { includedMinutes, orgHostedCapacity } from './hosted-capacity';
import { STRIPE_HOSTED_METERS_ENV, hostedMinutePrices } from './hosted-metering.config';

/** Nothing at all: what a lookup that failed answers on a Stripe-backed install. */
const NONE: HostedCapacity = {
  maxConcurrentRunners: 0,
  maxWorkspaces: 0,
  resourceClasses: [],
  plan: null,
  hostedEnvironments: false,
  includedMinutes: {},
  monthlyCeilingMinutes: 0,
  monthlyCeilingUsd: 0,
  billed: false,
};

/**
 * Per-plan hosted capacity, filling HOSTED_CAPACITY_PROVIDER the way the
 * licensing resolver is filled. The plan row (hosted-capacity.ts) wins;
 * a number it leaves null comes from the install's hosted runner
 * settings.
 *
 * Plans apply only on an install that sells them through Stripe. A
 * self-hosted install running its own pool has no plan capacity and
 * bills nobody: it gets the install's settings, as without `ee`. On a
 * Stripe-backed install it fails closed: an organization it cannot read
 * gets no hosted capacity at all.
 */
@Injectable()
export class PlanHostedCapacityProvider implements HostedCapacityProvider {
  private readonly logger = new Logger(PlanHostedCapacityProvider.name);

  constructor(
    @InjectRepository(Organization) private readonly orgs: Repository<Organization>,
    private readonly config: ConfigService,
    @Optional() private readonly settings?: HostedRunnerSettingsService,
  ) {}

  /** Whether this install sells plans through Stripe. */
  stripeBacked(): boolean {
    return !!this.config.get<string>(STRIPE_SECRET_KEY_ENV);
  }

  async capacityFor(organizationId: string): Promise<HostedCapacity> {
    const fallback = this.settings?.current.capacity;
    if (!this.stripeBacked()) {
      return {
        maxConcurrentRunners: fallback?.maxConcurrentRunners ?? 0,
        maxWorkspaces: fallback?.maxWorkspaces ?? 0,
        resourceClasses: fallback?.resourceClasses ?? null,
      };
    }
    let org: Organization | null;
    try {
      org = await this.orgs.findOne({ where: { id: organizationId } });
    } catch (err) {
      this.logger.warn(`hosted capacity for ${organizationId} could not be read: ${(err as Error)?.message ?? err}`);
      org = null;
    }
    if (!org) return { ...NONE };
    const row = orgHostedCapacity(org as any);
    const seats = Number(org.billingInfo?.seats) || 1;
    return {
      plan: org.plan || 'free',
      hostedEnvironments: row.hostedEnvironments,
      maxConcurrentRunners: row.maxConcurrentRunners ?? fallback?.maxConcurrentRunners ?? 0,
      maxWorkspaces: row.maxWorkspaces ?? fallback?.maxWorkspaces ?? 0,
      // The sizes the plan allows, among those the install allows: a plan
      // never offers a size the install's machines cannot run.
      resourceClasses:
        row.resourceClasses && fallback?.resourceClasses
          ? row.resourceClasses.filter((c) => fallback.resourceClasses!.includes(c))
          : (row.resourceClasses ?? fallback?.resourceClasses ?? null),
      includedMinutes: includedMinutes(row, seats),
      monthlyCeilingMinutes: row.monthlyCeilingHours === null ? null : row.monthlyCeilingHours * 60,
      monthlyCeilingUsd: row.monthlyCeilingUsd,
      usdPerMinute: hostedMinutePrices({ [STRIPE_HOSTED_METERS_ENV]: this.config.get<string>(STRIPE_HOSTED_METERS_ENV) }),
      billed: row.billed && this.stripeBacked() && !!org.billingInfo?.stripeSubscriptionId,
    };
  }
}
