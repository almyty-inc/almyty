import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Organization } from '../../../src/entities/organization.entity';
import { BillingEvent } from '../../../src/entities/billing-event.entity';
import { RunnerUsageReport } from '../../../src/entities/runner-usage-report.entity';
import { BillingService } from './billing.service';
import { StripeService } from './stripe.service';
import { BillingController } from './billing.controller';
import { BillingWebhookController } from './billing-webhook.controller';
import { HostedUsageReportService } from './hosted-usage-report.service';
import { HOSTED_USAGE_REPORT_QUEUE, HostedUsageReportProcessor } from './hosted-usage-report.processor';

/**
 * Hosted subscription billing (P6). Commercial-tier only; dormant unless
 * STRIPE_SECRET_KEY is configured. Reuses P3's Ed25519 signer to mint the
 * entitlement token the licensing module verifies. Also reports hosted
 * runner minutes beyond the plan's allowance to Stripe, hourly.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Organization, BillingEvent, RunnerUsageReport]),
    BullModule.registerQueue({ name: HOSTED_USAGE_REPORT_QUEUE }),
  ],
  controllers: [BillingController, BillingWebhookController],
  providers: [BillingService, StripeService, HostedUsageReportService, HostedUsageReportProcessor],
  exports: [BillingService, HostedUsageReportService],
})
export class BillingModule {}