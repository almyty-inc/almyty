import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Organization } from '../../entities/organization.entity';
import { BillingEvent } from '../../entities/billing-event.entity';
import { BillingService } from './billing.service';
import { StripeService } from './stripe.service';
import { BillingController } from './billing.controller';
import { BillingWebhookController } from './billing-webhook.controller';

/**
 * Hosted subscription billing (P6). Commercial-tier only; dormant unless
 * STRIPE_SECRET_KEY is configured. Reuses P3's Ed25519 signer to mint the
 * entitlement token the licensing module verifies.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Organization, BillingEvent])],
  controllers: [BillingController, BillingWebhookController],
  providers: [BillingService, StripeService],
  exports: [BillingService],
})
export class BillingModule {}
