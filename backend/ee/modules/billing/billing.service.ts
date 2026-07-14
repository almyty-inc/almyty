import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type Stripe from 'stripe';

import { Organization } from '../../../src/entities/organization.entity';
import { BillingEvent } from '../../../src/entities/billing-event.entity';
import { signLicense, LicensePayload } from '../../../src/modules/licensing/license-token';
import {
  ACTIVE_SUBSCRIPTION_STATUSES,
  DEFAULT_DUNNING_GRACE_DAYS,
  DUNNING_GRACE_DAYS_ENV,
  DUNNING_SUBSCRIPTION_STATUSES,
  LICENSE_PRIVATE_KEY_ENV,
  PAID_PLANS,
  PLAN_ENTERPRISE,
  PLAN_BUSINESS,
  SELF_SERVE_PLANS,
  PLAN_ENTITLEMENTS,
  PLAN_FREE,
  PLAN_PRO,
  STRIPE_CHECKOUT_CANCEL_URL_ENV,
  STRIPE_CHECKOUT_SUCCESS_URL_ENV,
  STRIPE_PORTAL_RETURN_URL_ENV,
  STRIPE_PRICE_BUSINESS_ENV,
  STRIPE_PRICE_PRO_ENV,
} from './billing.constants';
import { StripeService } from './stripe.service';

export interface BillingStatus {
  plan: string;
  seats: number;
  status: string | null;
  hasSubscription: boolean;
  dunning: boolean;
  graceUntil: string | null;
  planExpiresAt: string | null;
  hasLicenseToken: boolean;
  stripeConfigured: boolean;
}

export interface CreateCheckoutInput {
  plan: string;
  seats?: number;
  successUrl?: string;
  cancelUrl?: string;
}

/**
 * Hosted subscription billing. Admin-only — it is how an org OBTAINS
 * entitlements, so it is deliberately not entitlement-gated. Stripe is the
 * source of truth for payment state; on every subscription change the webhook
 * calls into here to (re)mint or revoke the org's signed license token.
 */
@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    @InjectRepository(Organization)
    private readonly orgRepo: Repository<Organization>,
    @InjectRepository(BillingEvent)
    private readonly eventRepo: Repository<BillingEvent>,
    private readonly stripe: StripeService,
    private readonly config: ConfigService,
  ) {}

  // ── Read side ───────────────────────────────────────────────────────────

  async getBillingStatus(organizationId: string): Promise<BillingStatus> {
    const org = await this.getOrg(organizationId);
    const info = org.billingInfo || {};
    return {
      plan: org.plan || PLAN_FREE,
      seats: Number(info.seats) || 1,
      status: info.subscriptionStatus || null,
      hasSubscription: !!info.stripeSubscriptionId,
      dunning: !!info.dunning,
      graceUntil: info.graceUntil || null,
      planExpiresAt: org.planExpiresAt ? new Date(org.planExpiresAt).toISOString() : null,
      hasLicenseToken: !!info.licenseToken,
      stripeConfigured: this.stripe.isConfigured(),
    };
  }

  async listInvoices(organizationId: string): Promise<
    Array<{
      id: string;
      number: string | null;
      amountDue: number;
      currency: string;
      status: string | null;
      created: string;
      hostedInvoiceUrl: string | null;
      pdfUrl: string | null;
    }>
  > {
    const org = await this.getOrg(organizationId);
    const customerId = org.billingInfo?.stripeCustomerId;
    if (!customerId) return [];
    const list = await this.stripe.listInvoices(customerId);
    return (list.data || []).map((inv) => ({
      id: inv.id,
      number: inv.number ?? null,
      amountDue: inv.amount_due,
      currency: inv.currency,
      status: inv.status ?? null,
      created: new Date(inv.created * 1000).toISOString(),
      hostedInvoiceUrl: inv.hosted_invoice_url ?? null,
      pdfUrl: inv.invoice_pdf ?? null,
    }));
  }

  // ── Checkout / portal ───────────────────────────────────────────────────

  async createCheckoutSession(
    organizationId: string,
    input: CreateCheckoutInput,
  ): Promise<{ url: string }> {
    const plan = input.plan;
    if (!SELF_SERVE_PLANS.includes(plan)) {
      // Enterprise (and anything not pro/business) is contact-sales — there is
      // no self-serve checkout for it. Matches almyty.com/pricing.
      throw new BadRequestException(
        `Plan "${plan}" is not self-serve. Pro and Business can be purchased ` +
          `here; Enterprise is contact-sales.`,
      );
    }
    const priceId = this.priceIdForPlan(plan);
    if (!priceId) {
      throw new BadRequestException(
        `No Stripe price configured for plan "${plan}"`,
      );
    }

    const org = await this.getOrg(organizationId);
    const customerId = await this.ensureCustomer(org);
    const seats = Math.max(1, Number(input.seats) || 1);

    const successUrl =
      input.successUrl ||
      this.config.get<string>(STRIPE_CHECKOUT_SUCCESS_URL_ENV) ||
      'https://app.almyty.com/settings/billing?checkout=success';
    const cancelUrl =
      input.cancelUrl ||
      this.config.get<string>(STRIPE_CHECKOUT_CANCEL_URL_ENV) ||
      'https://app.almyty.com/settings/billing?checkout=cancelled';

    const session = await this.stripe.createCheckoutSession({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: priceId, quantity: seats }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      client_reference_id: org.id,
      subscription_data: { metadata: { organizationId: org.id, plan } },
      metadata: { organizationId: org.id, plan },
    });

    return { url: session.url };
  }

  async createPortalSession(organizationId: string): Promise<{ url: string }> {
    const org = await this.getOrg(organizationId);
    const customerId = org.billingInfo?.stripeCustomerId;
    if (!customerId) {
      throw new BadRequestException(
        'No billing customer for this organization yet — start a checkout first',
      );
    }
    const returnUrl =
      this.config.get<string>(STRIPE_PORTAL_RETURN_URL_ENV) ||
      'https://app.almyty.com/settings/billing';
    const session = await this.stripe.createBillingPortalSession({
      customer: customerId,
      return_url: returnUrl,
    });
    return { url: session.url };
  }

  // ── Webhook handling ────────────────────────────────────────────────────

  /**
   * Apply a verified Stripe event. Idempotent: a repeated event id is a no-op.
   * Returns whether the event was newly handled vs. deduped/ignored.
   */
  async handleWebhookEvent(
    event: Stripe.Event,
  ): Promise<{ handled: boolean; deduped: boolean; ignored: boolean }> {
    const existing = await this.eventRepo.findOne({ where: { eventId: event.id } });
    if (existing) {
      this.logger.debug(`Duplicate Stripe event ${event.id} ignored`);
      return { handled: false, deduped: true, ignored: false };
    }

    let organizationId: string | undefined;
    let ignored = false;

    switch (event.type) {
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
        organizationId = await this.applySubscription(
          event.data.object as Stripe.Subscription,
          event.type === 'customer.subscription.deleted',
        );
        break;
      case 'invoice.payment_failed':
        organizationId = await this.applyPaymentFailed(
          event.data.object as Stripe.Invoice,
        );
        break;
      case 'invoice.payment_succeeded':
        organizationId = await this.applyPaymentSucceeded(
          event.data.object as Stripe.Invoice,
        );
        break;
      default:
        ignored = true;
    }

    await this.eventRepo.save(
      this.eventRepo.create({
        eventId: event.id,
        type: event.type,
        organizationId,
        processedAt: new Date(),
      }),
    );

    return { handled: !ignored, deduped: false, ignored };
  }

  // ── Subscription state → org plan + entitlement token ───────────────────

  private async applySubscription(
    subscription: Stripe.Subscription,
    deleted: boolean,
  ): Promise<string | undefined> {
    const org = await this.findOrgForSubscription(subscription);
    if (!org) {
      this.logger.warn(
        `No organization matched Stripe subscription ${subscription.id}`,
      );
      return undefined;
    }

    const status = subscription.status;
    const info = { ...(org.billingInfo || {}) };
    info.stripeSubscriptionId = subscription.id;
    info.subscriptionStatus = status;

    // Terminal / deleted → downgrade to free and revoke the license token.
    if (deleted || status === 'canceled' || status === 'incomplete_expired') {
      org.plan = PLAN_FREE;
      org.planExpiresAt = null;
      info.licenseToken = null;
      info.dunning = false;
      info.graceUntil = null;
      org.billingInfo = info;
      await this.orgRepo.save(org);
      this.logger.log(`Org ${org.id} downgraded to free (subscription ${status})`);
      return org.id;
    }

    const plan = this.planFromSubscription(subscription);
    const seats = this.seatsFromSubscription(subscription);
    const periodEnd = this.periodEndFromSubscription(subscription);

    info.seats = seats;

    if (DUNNING_SUBSCRIPTION_STATUSES.includes(status)) {
      // Keep entitlements but flag dunning + start/extend the grace window.
      info.dunning = true;
      info.graceUntil =
        info.graceUntil || this.graceDeadline().toISOString();
    } else if (ACTIVE_SUBSCRIPTION_STATUSES.includes(status)) {
      info.dunning = false;
      info.graceUntil = null;
    }

    const expiresAt = periodEnd || this.graceDeadline();
    const token = this.mintToken(plan, seats, expiresAt, org.name);
    info.licenseToken = token;

    org.plan = plan;
    org.planExpiresAt = expiresAt;
    org.billingInfo = info;
    await this.orgRepo.save(org);

    this.logger.log(
      `Org ${org.id} set to plan=${plan} seats=${seats} status=${status}; entitlement token minted`,
    );
    return org.id;
  }

  private async applyPaymentFailed(
    invoice: Stripe.Invoice,
  ): Promise<string | undefined> {
    const org = await this.findOrgForCustomer(this.customerId(invoice.customer));
    if (!org) return undefined;
    const info = { ...(org.billingInfo || {}) };
    info.dunning = true;
    info.graceUntil = info.graceUntil || this.graceDeadline().toISOString();
    info.subscriptionStatus = 'past_due';
    org.billingInfo = info;
    await this.orgRepo.save(org);
    this.logger.warn(`Org ${org.id} entered dunning grace after payment failure`);
    return org.id;
  }

  private async applyPaymentSucceeded(
    invoice: Stripe.Invoice,
  ): Promise<string | undefined> {
    const org = await this.findOrgForCustomer(this.customerId(invoice.customer));
    if (!org) return undefined;
    if (!org.billingInfo?.dunning) return org.id;
    const info = { ...(org.billingInfo || {}) };
    info.dunning = false;
    info.graceUntil = null;
    org.billingInfo = info;
    await this.orgRepo.save(org);
    this.logger.log(`Org ${org.id} cleared dunning after successful payment`);
    return org.id;
  }

  // ── Token minting ───────────────────────────────────────────────────────

  private mintToken(
    plan: string,
    seats: number,
    expiresAt: Date,
    issuedTo: string,
  ): string {
    const privateKey = this.config.get<string>(LICENSE_PRIVATE_KEY_ENV);
    if (!privateKey) {
      throw new BadRequestException(
        'Cannot mint entitlement token: ALMYTY_LICENSE_PRIVATE_KEY is unset',
      );
    }
    const payload: LicensePayload = {
      entitlements: PLAN_ENTITLEMENTS[plan] || [],
      limits: { seats },
      expiresAt: expiresAt ? expiresAt.toISOString() : null,
      issuedTo,
      issuedAt: new Date().toISOString(),
    };
    return signLicense(payload, privateKey);
  }

  // ── Stripe object helpers (version-tolerant) ────────────────────────────

  private planFromSubscription(subscription: Stripe.Subscription): string {
    const priceId = this.priceIdFromSubscription(subscription);
    const proPrice = this.config.get<string>(STRIPE_PRICE_PRO_ENV);
    const businessPrice = this.config.get<string>(STRIPE_PRICE_BUSINESS_ENV);
    if (businessPrice && priceId === businessPrice) return PLAN_BUSINESS;
    if (proPrice && priceId === proPrice) return PLAN_PRO;
    // Fall back to the plan stamped on subscription metadata at checkout.
    const metaPlan = subscription.metadata?.plan;
    if (metaPlan && PAID_PLANS.includes(metaPlan)) return metaPlan;
    return PLAN_PRO;
  }

  private priceIdFromSubscription(subscription: Stripe.Subscription): string | undefined {
    const item = subscription.items?.data?.[0] as any;
    return item?.price?.id;
  }

  private seatsFromSubscription(subscription: Stripe.Subscription): number {
    const item = subscription.items?.data?.[0] as any;
    return Math.max(1, Number(item?.quantity) || 1);
  }

  private periodEndFromSubscription(subscription: Stripe.Subscription): Date | null {
    const sub = subscription as any;
    const seconds =
      sub.current_period_end ?? sub.items?.data?.[0]?.current_period_end;
    return seconds ? new Date(Number(seconds) * 1000) : null;
  }

  private customerId(customer: string | Stripe.Customer | Stripe.DeletedCustomer): string {
    return typeof customer === 'string' ? customer : customer?.id;
  }

  private priceIdForPlan(plan: string): string | undefined {
    if (plan === PLAN_BUSINESS) {
      return this.config.get<string>(STRIPE_PRICE_BUSINESS_ENV);
    }
    if (plan === PLAN_PRO) {
      return this.config.get<string>(STRIPE_PRICE_PRO_ENV);
    }
    // Enterprise is contact-sales — no self-serve price.
    return undefined;
  }

  private graceDeadline(): Date {
    const days =
      Number(this.config.get<string>(DUNNING_GRACE_DAYS_ENV)) ||
      DEFAULT_DUNNING_GRACE_DAYS;
    return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  }

  // ── Org lookups ─────────────────────────────────────────────────────────

  private async ensureCustomer(org: Organization): Promise<string> {
    if (org.billingInfo?.stripeCustomerId) {
      return org.billingInfo.stripeCustomerId;
    }
    const customer = await this.stripe.createCustomer({
      name: org.name,
      metadata: { organizationId: org.id },
    });
    org.billingInfo = { ...(org.billingInfo || {}), stripeCustomerId: customer.id };
    await this.orgRepo.save(org);
    return customer.id;
  }

  private async findOrgForSubscription(
    subscription: Stripe.Subscription,
  ): Promise<Organization | null> {
    const metaOrg = subscription.metadata?.organizationId;
    if (metaOrg) {
      const byMeta = await this.orgRepo.findOne({ where: { id: metaOrg } });
      if (byMeta) return byMeta;
    }
    return this.findOrgForCustomer(this.customerId(subscription.customer));
  }

  private async findOrgForCustomer(customerId: string): Promise<Organization | null> {
    if (!customerId) return null;
    // billingInfo is JSON; match on the nested stripeCustomerId. Kept as a
    // scan-free query via the JSON path operator (Postgres) with a portable
    // fallback for the small org table.
    const orgs = await this.orgRepo
      .createQueryBuilder('org')
      .where(`org."billingInfo" ->> 'stripeCustomerId' = :cid`, { cid: customerId })
      .getOne();
    return orgs || null;
  }

  private async getOrg(organizationId: string): Promise<Organization> {
    const org = await this.orgRepo.findOne({ where: { id: organizationId } });
    if (!org) throw new NotFoundException('Organization not found');
    return org;
  }
}
