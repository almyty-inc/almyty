import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import {
  STRIPE_API_BASE_ENV,
  STRIPE_SECRET_KEY_ENV,
  STRIPE_WEBHOOK_SECRET_ENV,
} from './billing.constants';

/** Stripe error types that mean Stripe, or our key for it, is the problem. */
const UNAVAILABLE_STRIPE_ERRORS = new Set([
  'StripeAuthenticationError',
  'StripePermissionError',
  'StripeConnectionError',
  'StripeAPIError',
  'StripeRateLimitError',
]);

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
    return this.call('create a customer', () => this.stripe().customers.create(params));
  }

  createCheckoutSession(
    params: Stripe.Checkout.SessionCreateParams,
  ): Promise<Stripe.Checkout.Session> {
    return this.call('start a checkout', () => this.stripe().checkout.sessions.create(params));
  }

  createBillingPortalSession(
    params: Stripe.BillingPortal.SessionCreateParams,
  ): Promise<Stripe.BillingPortal.Session> {
    return this.call('open the billing portal', () => this.stripe().billingPortal.sessions.create(params));
  }

  listInvoices(customerId: string): Promise<Stripe.ApiList<Stripe.Invoice>> {
    return this.call('list invoices', () => this.stripe().invoices.list({ customer: customerId, limit: 20 }));
  }

  /**
   * Stripe being unreachable or refusing our key (an expired or revoked
   * secret, an outage, rate limiting) is not a fault in the request, and
   * surfaced as an unhandled 500 on Settings > Billing. It becomes a clear
   * 503; the Stripe message, which can name the key, stays in the log.
   * Anything else (a request Stripe judged invalid, our own bugs) passes
   * through unchanged.
   */
  private async call<T>(what: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (err) {
      const type = (err as { type?: string } | null)?.type;
      if (type && UNAVAILABLE_STRIPE_ERRORS.has(type)) {
        this.logger.error(`Stripe could not ${what}: ${type}: ${(err as Error).message}`);
        throw new ServiceUnavailableException(
          'The billing provider is unavailable right now. Try again later.',
        );
      }
      throw err;
    }
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
