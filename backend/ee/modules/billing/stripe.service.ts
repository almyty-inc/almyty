import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import {
  STRIPE_API_BASE_ENV,
  STRIPE_SECRET_KEY_ENV,
  STRIPE_WEBHOOK_SECRET_ENV,
} from './billing.constants';

/**
 * Thin, mockable wrapper over the Stripe SDK. Every Stripe call the billing
 * module needs goes through here so tests can substitute a fake with no network.
 * The SDK client is created lazily on first use; when no secret key is
 * configured the whole billing surface stays dormant (checkout/portal throw a
 * clear 503, the webhook rejects).
 */
@Injectable()
export class StripeService {
  private readonly logger = new Logger(StripeService.name);
  private client: Stripe | null = null;

  constructor(private readonly config: ConfigService) {}

  isConfigured(): boolean {
    return !!this.config.get<string>(STRIPE_SECRET_KEY_ENV);
  }

  private stripe(): Stripe {
    if (!this.client) {
      const key = this.config.get<string>(STRIPE_SECRET_KEY_ENV);
      if (!key) {
        throw new ServiceUnavailableException(
          'Billing is not configured (STRIPE_SECRET_KEY is unset)',
        );
      }
      this.client = new Stripe(key, this.stripeOptions());
    }
    return this.client;
  }

  /**
   * Build the Stripe SDK options. When `STRIPE_API_BASE` is set (local
   * `stripe-mock` in integration tests) its protocol/host/port are applied so
   * the SDK talks to the emulator; otherwise no overrides are passed and the
   * SDK targets `api.stripe.com` exactly as before.
   */
  private stripeOptions(): ConstructorParameters<typeof Stripe>[1] {
    const base = this.config.get<string>(STRIPE_API_BASE_ENV);
    if (!base) return undefined;
    try {
      const url = new URL(base);
      const protocol = url.protocol.replace(/:$/, '') as 'http' | 'https';
      const port = url.port
        ? Number(url.port)
        : protocol === 'https'
          ? 443
          : 80;
      return { protocol, host: url.hostname, port };
    } catch {
      this.logger.warn(`Ignoring malformed ${STRIPE_API_BASE_ENV}: ${base}`);
      return undefined;
    }
  }

  createCustomer(params: Stripe.CustomerCreateParams): Promise<Stripe.Customer> {
    return this.stripe().customers.create(params);
  }

  createCheckoutSession(
    params: Stripe.Checkout.SessionCreateParams,
  ): Promise<Stripe.Checkout.Session> {
    return this.stripe().checkout.sessions.create(params);
  }

  createBillingPortalSession(
    params: Stripe.BillingPortal.SessionCreateParams,
  ): Promise<Stripe.BillingPortal.Session> {
    return this.stripe().billingPortal.sessions.create(params);
  }

  listInvoices(customerId: string): Promise<Stripe.ApiList<Stripe.Invoice>> {
    return this.stripe().invoices.list({ customer: customerId, limit: 20 });
  }

  retrieveSubscription(subscriptionId: string): Promise<Stripe.Subscription> {
    return this.stripe().subscriptions.retrieve(subscriptionId);
  }

  /**
   * Verify + decode a webhook payload. Throws on a bad/missing signature — the
   * controller maps that to a 400 so Stripe retries only on genuine failures.
   */
  constructEvent(rawBody: Buffer | string, signature: string): Stripe.Event {
    const secret = this.config.get<string>(STRIPE_WEBHOOK_SECRET_ENV);
    if (!secret) {
      throw new ServiceUnavailableException(
        'Billing webhook is not configured (STRIPE_WEBHOOK_SECRET is unset)',
      );
    }
    return this.stripe().webhooks.constructEvent(rawBody, signature, secret);
  }
}
