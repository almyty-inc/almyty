import { generateKeyPairSync } from 'crypto';
import { BadRequestException } from '@nestjs/common';
import { BillingService } from '../billing.service';
import { verifyLicense } from '../../../../src/modules/licensing/license-token';
import { LicenseService } from '../../../../src/modules/licensing/license.service';
import { EE_ENTITLEMENTS } from '../../../../src/modules/licensing/license.constants';
import {
  LICENSE_PRIVATE_KEY_ENV,
  PLAN_ENTERPRISE,
  PLAN_FREE,
  PLAN_PRO,
  STRIPE_PRICE_ENTERPRISE_ENV,
  STRIPE_PRICE_PRO_ENV,
} from '../billing.constants';

const ORG_ID = '11111111-1111-1111-1111-111111111111';

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

const { publicPem, privatePem } = keypair();

function fakeSubscription(overrides: any = {}) {
  return {
    id: 'sub_123',
    status: 'active',
    customer: 'cus_123',
    metadata: { organizationId: ORG_ID, plan: PLAN_PRO },
    items: {
      data: [
        {
          price: { id: 'price_pro' },
          quantity: 3,
          current_period_end: 1900000000,
        },
      ],
    },
    current_period_end: 1900000000,
    ...overrides,
  };
}

function event(type: string, object: any, id = 'evt_1') {
  return { id, type, data: { object } } as any;
}

describe('BillingService', () => {
  let service: BillingService;
  let org: any;
  let orgRepo: any;
  let eventRepo: any;
  let events: Map<string, any>;
  let stripe: any;
  let config: any;
  let configMap: Record<string, string>;

  beforeEach(() => {
    org = {
      id: ORG_ID,
      name: 'Acme',
      plan: PLAN_FREE,
      planExpiresAt: null,
      billingInfo: null,
    };
    orgRepo = {
      findOne: jest.fn(async () => org),
      save: jest.fn(async (o: any) => {
        org = o;
        return o;
      }),
      create: jest.fn((o: any) => o),
      createQueryBuilder: jest.fn(() => {
        const builder: any = {
          where: () => builder,
          getOne: async () => org,
        };
        return builder;
      }),
    };
    events = new Map();
    eventRepo = {
      findOne: jest.fn(async ({ where }: any) => events.get(where.eventId) || null),
      create: jest.fn((e: any) => e),
      save: jest.fn(async (e: any) => {
        events.set(e.eventId, e);
        return e;
      }),
    };
    stripe = {
      isConfigured: () => true,
      createCustomer: jest.fn(async () => ({ id: 'cus_new' })),
      createCheckoutSession: jest.fn(async () => ({
        id: 'cs_1',
        url: 'https://checkout.stripe.test/session',
      })),
      createBillingPortalSession: jest.fn(async () => ({
        url: 'https://portal.stripe.test/session',
      })),
      listInvoices: jest.fn(async () => ({ data: [] })),
      constructEvent: jest.fn(),
    };
    configMap = {
      [LICENSE_PRIVATE_KEY_ENV]: privatePem,
      [STRIPE_PRICE_PRO_ENV]: 'price_pro',
      [STRIPE_PRICE_ENTERPRISE_ENV]: 'price_ent',
    };
    config = { get: (k: string) => configMap[k] };
    service = new BillingService(orgRepo, eventRepo, stripe, config);
  });

  describe('checkout', () => {
    it('creates a Stripe customer then a checkout session and returns the url', async () => {
      const res = await service.createCheckoutSession(ORG_ID, { plan: PLAN_PRO, seats: 5 });

      expect(stripe.createCustomer).toHaveBeenCalled();
      expect(stripe.createCheckoutSession).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: 'subscription',
          customer: 'cus_new',
          line_items: [{ price: 'price_pro', quantity: 5 }],
        }),
      );
      expect(res.url).toBe('https://checkout.stripe.test/session');
      // Customer id persisted for reuse.
      expect(org.billingInfo.stripeCustomerId).toBe('cus_new');
    });

    it('reuses an existing customer', async () => {
      org.billingInfo = { stripeCustomerId: 'cus_existing' };
      await service.createCheckoutSession(ORG_ID, { plan: PLAN_ENTERPRISE });
      expect(stripe.createCustomer).not.toHaveBeenCalled();
      expect(stripe.createCheckoutSession).toHaveBeenCalledWith(
        expect.objectContaining({ customer: 'cus_existing', line_items: [{ price: 'price_ent', quantity: 1 }] }),
      );
    });

    it('rejects an unknown plan', async () => {
      await expect(
        service.createCheckoutSession(ORG_ID, { plan: 'gold' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('webhook → entitlement issuance', () => {
    it('subscription.created sets plan + mints a token verifiable by the licensing verifier', async () => {
      const res = await service.handleWebhookEvent(
        event('customer.subscription.created', fakeSubscription()),
      );

      expect(res).toEqual({ handled: true, deduped: false, ignored: false });
      expect(org.plan).toBe(PLAN_PRO);
      expect(org.billingInfo.seats).toBe(3);
      expect(org.billingInfo.licenseToken).toBeTruthy();

      // The minted token verifies against the matching PUBLIC key...
      const verified = verifyLicense(org.billingInfo.licenseToken, publicPem);
      expect(verified.valid).toBe(true);
      expect(verified.payload.limits.seats).toBe(3);

      // ...and unlocks the pro set through the PER-ORG resolution path the app
      // actually uses (resolveToken), not the process-global load(). The old
      // assertion used license.load({token}) — a path production never takes —
      // which is why a live payment unlocked nothing while this test was green.
      const license = new LicenseService();
      license.load({ publicKeyPem: publicPem }); // global stays community, as in prod
      const snap = license.resolveToken(org.billingInfo.licenseToken);
      expect(snap.entitlements).toContain(EE_ENTITLEMENTS.ADVANCED_RBAC);
      expect(snap.entitlements).toContain(EE_ENTITLEMENTS.AUDIT_EXPORT);
      expect(snap.entitlements).not.toContain(EE_ENTITLEMENTS.SSO);
    });

    it('maps the enterprise price to the enterprise entitlement set', async () => {
      const sub = fakeSubscription({
        metadata: { organizationId: ORG_ID },
        items: { data: [{ price: { id: 'price_ent' }, quantity: 10, current_period_end: 1900000000 }] },
      });
      await service.handleWebhookEvent(event('customer.subscription.updated', sub));

      expect(org.plan).toBe(PLAN_ENTERPRISE);
      const license = new LicenseService();
      license.load({ publicKeyPem: publicPem, token: org.billingInfo.licenseToken });
      expect(license.has(EE_ENTITLEMENTS.SSO)).toBe(true);
      expect(license.has(EE_ENTITLEMENTS.BYO_KMS)).toBe(true);
    });

    it('is idempotent — a repeated event id is a no-op', async () => {
      const evt = event('customer.subscription.created', fakeSubscription());
      await service.handleWebhookEvent(evt);
      const savesAfterFirst = orgRepo.save.mock.calls.length;

      const res = await service.handleWebhookEvent(evt);
      expect(res.deduped).toBe(true);
      expect(res.handled).toBe(false);
      // No further org mutation on the duplicate.
      expect(orgRepo.save.mock.calls.length).toBe(savesAfterFirst);
    });
  });

  describe('dunning + downgrade', () => {
    it('invoice.payment_failed flags dunning + sets a grace deadline without revoking the token', async () => {
      // Seed an active subscription first.
      await service.handleWebhookEvent(event('customer.subscription.created', fakeSubscription(), 'evt_a'));
      const tokenBefore = org.billingInfo.licenseToken;

      await service.handleWebhookEvent(
        event('invoice.payment_failed', { customer: 'cus_123' }, 'evt_b'),
      );

      expect(org.billingInfo.dunning).toBe(true);
      expect(org.billingInfo.graceUntil).toBeTruthy();
      expect(new Date(org.billingInfo.graceUntil).getTime()).toBeGreaterThan(Date.now());
      // Entitlements preserved during grace.
      expect(org.billingInfo.licenseToken).toBe(tokenBefore);
      expect(org.plan).toBe(PLAN_PRO);
    });

    it('invoice.payment_succeeded clears dunning', async () => {
      org.billingInfo = { stripeCustomerId: 'cus_123', dunning: true, graceUntil: new Date().toISOString() };
      await service.handleWebhookEvent(
        event('invoice.payment_succeeded', { customer: 'cus_123' }, 'evt_c'),
      );
      expect(org.billingInfo.dunning).toBe(false);
      expect(org.billingInfo.graceUntil).toBeNull();
    });

    it('subscription.deleted downgrades to free and revokes the token', async () => {
      await service.handleWebhookEvent(event('customer.subscription.created', fakeSubscription(), 'evt_d'));
      expect(org.billingInfo.licenseToken).toBeTruthy();

      await service.handleWebhookEvent(
        event('customer.subscription.deleted', fakeSubscription({ status: 'canceled' }), 'evt_e'),
      );

      expect(org.plan).toBe(PLAN_FREE);
      expect(org.planExpiresAt).toBeNull();
      expect(org.billingInfo.licenseToken).toBeNull();
    });
  });

  describe('minting guard', () => {
    it('throws if the signing private key is unset', async () => {
      delete configMap[LICENSE_PRIVATE_KEY_ENV];
      await expect(
        service.handleWebhookEvent(event('customer.subscription.created', fakeSubscription())),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('status', () => {
    it('reports free/no-subscription defaults', async () => {
      const status = await service.getBillingStatus(ORG_ID);
      expect(status.plan).toBe(PLAN_FREE);
      expect(status.hasSubscription).toBe(false);
      expect(status.seats).toBe(1);
      expect(status.stripeConfigured).toBe(true);
    });
  });
});
