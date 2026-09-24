import { generateKeyPairSync } from 'crypto';
import { BadRequestException } from '@nestjs/common';
import { BillingService } from '../billing.service';
import { verifyLicense } from '../../../../src/modules/licensing/license-token';
import {
  LICENSE_PRIVATE_KEY_ENV,
  PLAN_BUSINESS,
  PLAN_FREE,
  STRIPE_PRICE_BUSINESS_ENV,
  STRIPE_PRICE_PRO_ENV,
} from '../billing.constants';

/**
 * Stripe delivers webhooks at least once and in no particular order, and a
 * customer can end up with more than one subscription. These specs pin that
 * the org's entitlements follow the subscription that is actually current,
 * not whichever event happened to arrive last.
 */

const ORG_ID = '22222222-2222-2222-2222-222222222222';
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

const FAR_PERIOD_END = Math.floor(Date.now() / 1000) + 365 * 24 * 3600;

function sub(overrides: any = {}) {
  return {
    id: 'sub_current',
    status: 'active',
    customer: 'cus_1',
    metadata: { organizationId: ORG_ID, plan: PLAN_BUSINESS },
    items: { data: [{ price: { id: 'price_biz' }, quantity: 2, current_period_end: FAR_PERIOD_END }] },
    current_period_end: FAR_PERIOD_END,
    ...overrides,
  };
}

function evt(type: string, object: any, id: string, created: number) {
  return { id, type, created, data: { object } } as any;
}

describe('BillingService webhook state integrity', () => {
  let service: BillingService;
  let org: any;
  let stripe: any;

  beforeEach(() => {
    org = { id: ORG_ID, name: 'Acme', plan: PLAN_FREE, planExpiresAt: null, billingInfo: null };
    const orgRepo: any = {
      findOne: jest.fn(async () => org),
      save: jest.fn(async (o: any) => (org = o)),
      createQueryBuilder: jest.fn(() => {
        const b: any = { where: () => b, getOne: async () => org };
        return b;
      }),
    };
    const events = new Map<string, any>();
    const eventRepo: any = {
      findOne: jest.fn(async ({ where }: any) => events.get(where.eventId) || null),
      create: jest.fn((e: any) => e),
      save: jest.fn(async (e: any) => events.set(e.eventId, e)),
    };
    stripe = {
      isConfigured: () => true,
      createCustomer: jest.fn(async () => ({ id: 'cus_1' })),
      createCheckoutSession: jest.fn(async () => ({ url: 'https://checkout.stripe.test/s' })),
    };
    const cfg: Record<string, string> = {
      [LICENSE_PRIVATE_KEY_ENV]: privatePem,
      [STRIPE_PRICE_PRO_ENV]: 'price_pro',
      [STRIPE_PRICE_BUSINESS_ENV]: 'price_biz',
    };
    service = new BillingService(orgRepo, eventRepo, stripe, { get: (k: string) => cfg[k] } as any);
  });

  describe('out-of-order delivery', () => {
    it('a stale subscription.updated arriving after the deletion does not re-grant the plan', async () => {
      await service.handleWebhookEvent(evt('customer.subscription.created', sub(), 'evt_1', 1000));
      await service.handleWebhookEvent(
        evt('customer.subscription.deleted', sub({ status: 'canceled' }), 'evt_3', 3000),
      );
      // Older event (created before the deletion) delivered late by Stripe.
      await service.handleWebhookEvent(evt('customer.subscription.updated', sub(), 'evt_2', 2000));

      expect(org.plan).toBe(PLAN_FREE);
      expect(org.billingInfo.licenseToken).toBeNull();
    });

    it('a canceled subscription stays canceled even when a same-second active event lands after it', async () => {
      await service.handleWebhookEvent(
        evt('customer.subscription.deleted', sub({ status: 'canceled' }), 'evt_del', 5000),
      );
      await service.handleWebhookEvent(evt('customer.subscription.updated', sub(), 'evt_upd', 5000));

      expect(org.plan).toBe(PLAN_FREE);
      expect(org.billingInfo.licenseToken).toBeNull();
    });

    it('a newer event is still applied', async () => {
      await service.handleWebhookEvent(
        evt('customer.subscription.created', sub({ status: 'past_due' }), 'evt_a', 1000),
      );
      await service.handleWebhookEvent(evt('customer.subscription.updated', sub(), 'evt_b', 2000));
      expect(org.billingInfo.subscriptionStatus).toBe('active');
      expect(org.billingInfo.dunning).toBe(false);
    });
  });

  describe('more than one subscription on the org', () => {
    it('deleting a stale subscription does not downgrade the org off its live one', async () => {
      await service.handleWebhookEvent(evt('customer.subscription.created', sub(), 'evt_new', 2000));
      await service.handleWebhookEvent(
        evt('customer.subscription.deleted', sub({ id: 'sub_old', status: 'canceled' }), 'evt_old_del', 3000),
      );

      expect(org.plan).toBe(PLAN_BUSINESS);
      expect(org.billingInfo.stripeSubscriptionId).toBe('sub_current');
      expect(org.billingInfo.licenseToken).toBeTruthy();
    });

    it('a new subscription is adopted once the previous one has ended', async () => {
      await service.handleWebhookEvent(
        evt('customer.subscription.deleted', sub({ id: 'sub_old', status: 'canceled' }), 'evt_1', 1000),
      );
      await service.handleWebhookEvent(evt('customer.subscription.created', sub(), 'evt_2', 2000));
      expect(org.plan).toBe(PLAN_BUSINESS);
      expect(org.billingInfo.stripeSubscriptionId).toBe('sub_current');
    });

    it('checkout refuses to open a second subscription while one is live', async () => {
      org.billingInfo = {
        stripeCustomerId: 'cus_1',
        stripeSubscriptionId: 'sub_current',
        subscriptionStatus: 'active',
      };
      await expect(
        service.createCheckoutSession(ORG_ID, { plan: PLAN_BUSINESS }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(stripe.createCheckoutSession).not.toHaveBeenCalled();
    });

    it('checkout is allowed again after the subscription was canceled', async () => {
      org.billingInfo = {
        stripeCustomerId: 'cus_1',
        stripeSubscriptionId: 'sub_current',
        subscriptionStatus: 'canceled',
      };
      await expect(
        service.createCheckoutSession(ORG_ID, { plan: PLAN_BUSINESS }),
      ).resolves.toEqual({ url: 'https://checkout.stripe.test/s' });
    });
  });

  describe('unpaid subscriptions do not keep entitlements past the grace window', () => {
    it('past_due mints a token that expires at the grace deadline, not a year out', async () => {
      await service.handleWebhookEvent(
        evt('customer.subscription.updated', sub({ status: 'past_due' }), 'evt_pd', 1000),
      );

      const verified = verifyLicense(org.billingInfo.licenseToken, publicPem);
      expect(verified.valid).toBe(true);
      const tokenExpiry = Date.parse(verified.payload.expiresAt as string);
      expect(tokenExpiry).toBeLessThanOrEqual(Date.parse(org.billingInfo.graceUntil));
      expect(tokenExpiry).toBeLessThan(Date.now() + 8 * 24 * 3600 * 1000);
    });

    it('once the grace window has lapsed a further unpaid update leaves no valid token', async () => {
      org.billingInfo = {
        stripeSubscriptionId: 'sub_current',
        subscriptionStatus: 'past_due',
        dunning: true,
        graceUntil: new Date(Date.now() - 1000).toISOString(),
      };
      await service.handleWebhookEvent(
        evt('customer.subscription.updated', sub({ status: 'unpaid' }), 'evt_u', 1000),
      );
      const token = org.billingInfo.licenseToken;
      expect(!token || !verifyLicense(token, publicPem).valid).toBe(true);
    });

    it.each(['incomplete', 'paused'])('a %s subscription grants no entitlements', async (status) => {
      await service.handleWebhookEvent(
        evt('customer.subscription.created', sub({ status }), `evt_${status}`, 1000),
      );
      expect(org.billingInfo.licenseToken).toBeFalsy();
      expect(org.plan).toBe(PLAN_FREE);
      expect(org.billingInfo.subscriptionStatus).toBe(status);
    });
  });
});
