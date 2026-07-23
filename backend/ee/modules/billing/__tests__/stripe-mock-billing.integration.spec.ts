/**
 * REAL Stripe billing round-trips against the official `stripe-mock` (#240).
 *
 * The unit spec (ee/modules/billing/__tests__/billing.service.spec.ts) hands
 * BillingService a plain-object `stripe` fake, so the real Stripe SDK — request
 * serialization, response parsing, and (critically) webhook SIGNATURE
 * VERIFICATION — is never exercised. `stripe-mock` runs the real Stripe OpenAPI
 * spec, so a request/response-shape bug the fake would mask surfaces here.
 *
 * What this proves:
 *   - StripeService.createCustomer / createCheckoutSession make real SDK calls
 *     to stripe-mock (base URL overridden via STRIPE_API_BASE) and parse the
 *     spec-shaped responses.
 *   - StripeService.constructEvent verifies a REAL Stripe signature (generated
 *     with the SDK's official test-header helper) over the raw body.
 *   - Feeding the verified `customer.subscription.created` event into
 *     BillingService mints a valid, signature-verifiable Ed25519 entitlement
 *     token and upgrades the org's plan.
 *
 * Requires:
 *   - RUN_EMULATOR_TESTS=1
 *   - Docker available (a `stripe/stripe-mock` container is started in
 *     beforeAll via testcontainers, exposing port 12111).
 *
 * Manual equivalent:
 *   docker run --rm -p 12111:12111 stripe/stripe-mock
 *   STRIPE_API_BASE=http://localhost:12111 RUN_EMULATOR_TESTS=1 \
 *     npx jest stripe-mock-billing
 */
import Stripe from 'stripe';
import { ConfigService } from '@nestjs/config';
import { GenericContainer, StartedTestContainer, Wait } from 'testcontainers';
import { generateKeyPairSync } from 'crypto';

import { StripeService } from '../stripe.service';
import { BillingService } from '../billing.service';
import {
  LICENSE_PRIVATE_KEY_ENV,
  STRIPE_API_BASE_ENV,
  STRIPE_PRICE_PRO_ENV,
  STRIPE_SECRET_KEY_ENV,
  STRIPE_WEBHOOK_SECRET_ENV,
  PLAN_PRO,
  PLAN_FREE,
} from '../billing.constants';
import { verifyLicense } from '../../../../src/modules/licensing/license-token';

const RUN = process.env.RUN_EMULATOR_TESTS === '1';
const d = RUN ? describe : describe.skip;

// stripe-mock accepts any well-formed key; it never authenticates.
const SECRET_KEY = 'sk_test_123';
const WEBHOOK_SECRET = 'whsec_test_secret';
const ORG_ID = '11111111-1111-1111-1111-111111111111';

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

const { publicPem, privatePem } = keypair();

/** ConfigService stub backed by a plain map. */
function config(map: Record<string, string>): ConfigService {
  return { get: (k: string) => map[k] } as unknown as ConfigService;
}

d('Stripe billing — real SDK round-trips vs stripe-mock', () => {
  jest.setTimeout(180_000);

  let container: StartedTestContainer;
  let apiBase: string;
  let configMap: Record<string, string>;
  let stripeService: StripeService;

  beforeAll(async () => {
    container = await new GenericContainer('stripe/stripe-mock:latest')
      .withExposedPorts(12111)
      .withWaitStrategy(Wait.forListeningPorts())
      .start();

    apiBase = `http://${container.getHost()}:${container.getMappedPort(12111)}`;

    configMap = {
      [STRIPE_SECRET_KEY_ENV]: SECRET_KEY,
      [STRIPE_WEBHOOK_SECRET_ENV]: WEBHOOK_SECRET,
      [STRIPE_API_BASE_ENV]: apiBase,
      [STRIPE_PRICE_PRO_ENV]: 'price_pro',
      [LICENSE_PRIVATE_KEY_ENV]: privatePem,
    };
    stripeService = new StripeService(config(configMap));
  });

  afterAll(async () => {
    if (container) await container.stop();
  });

  it('createCustomer hits stripe-mock through the real SDK', async () => {
    const customer = await stripeService.createCustomer({
      name: 'Acme',
      metadata: { organizationId: ORG_ID },
    });
    // stripe-mock returns a spec-shaped Customer object.
    expect(customer.object).toBe('customer');
    expect(customer.id).toMatch(/^cus_/);
  });

  it('createCheckoutSession hits stripe-mock through the real SDK', async () => {
    const session = await stripeService.createCheckoutSession({
      mode: 'subscription',
      line_items: [{ price: 'price_pro', quantity: 1 }],
      success_url: 'https://app.almyty.com/ok',
      cancel_url: 'https://app.almyty.com/no',
    });
    expect(session.object).toBe('checkout.session');
    expect(session.id).toMatch(/^cs_/);
  });

  it('constructEvent verifies a REAL Stripe signature over the raw body', () => {
    // A real Stripe client (any key) only for its signature helper — no network.
    const signer = new Stripe(SECRET_KEY);
    const payload = JSON.stringify({
      id: 'evt_sig_1',
      type: 'ping',
      data: { object: {} },
    });
    const header = signer.webhooks.generateTestHeaderString({
      payload,
      secret: WEBHOOK_SECRET,
    });

    const event = stripeService.constructEvent(payload, header);
    expect(event.id).toBe('evt_sig_1');
    expect(event.type).toBe('ping');

    // A tampered body must fail verification.
    expect(() =>
      stripeService.constructEvent(payload + ' ', header),
    ).toThrow();
  });

  it('a signed customer.subscription.created webhook mints an entitlement token', async () => {
    // Org + event repos as in the billing unit spec, but the SIGNATURE and the
    // token are both produced/verified for real.
    let org: any = {
      id: ORG_ID,
      name: 'Acme',
      plan: PLAN_FREE,
      planExpiresAt: null,
      billingInfo: { stripeCustomerId: 'cus_live_1' },
    };
    const orgRepo = {
      findOne: jest.fn(async () => org),
      save: jest.fn(async (o: any) => {
        org = o;
        return o;
      }),
      create: jest.fn((o: any) => o),
      createQueryBuilder: jest.fn(() => ({
        where: () => ({ getOne: async () => org }),
      })),
    };
    const events = new Map<string, any>();
    const eventRepo = {
      findOne: jest.fn(async ({ where }: any) => events.get(where.eventId) ?? null),
      create: jest.fn((e: any) => e),
      save: jest.fn(async (e: any) => {
        events.set(e.eventId, e);
        return e;
      }),
    };

    const billing = new BillingService(
      orgRepo as any,
      eventRepo as any,
      stripeService,
      config(configMap),
    );

    const subscription = {
      id: 'sub_live_1',
      status: 'active',
      customer: 'cus_live_1',
      metadata: { organizationId: ORG_ID, plan: PLAN_PRO },
      items: {
        data: [
          {
            price: { id: 'price_pro' },
            quantity: 4,
            current_period_end: 1900000000,
          },
        ],
      },
      current_period_end: 1900000000,
    };
    const rawEvent = {
      id: 'evt_sub_created_1',
      type: 'customer.subscription.created',
      data: { object: subscription },
    };
    const payload = JSON.stringify(rawEvent);

    // Sign the payload the way Stripe would, then verify it through the SAME
    // path the webhook controller uses.
    const signer = new Stripe(SECRET_KEY);
    const header = signer.webhooks.generateTestHeaderString({
      payload,
      secret: WEBHOOK_SECRET,
    });
    const verified = stripeService.constructEvent(payload, header);

    const result = await billing.handleWebhookEvent(verified);
    expect(result.handled).toBe(true);
    expect(result.deduped).toBe(false);

    // Org upgraded and a REAL, signature-verifiable entitlement token minted.
    expect(org.plan).toBe(PLAN_PRO);
    expect(org.billingInfo.seats).toBe(4);
    const token = org.billingInfo.licenseToken as string;
    expect(token).toBeTruthy();
    const verifyResult = verifyLicense(token, publicPem);
    expect(verifyResult.valid).toBe(true);
    expect(verifyResult.payload!.limits.seats).toBe(4);

    // Idempotency: replaying the SAME event id is deduped, not double-applied.
    const replay = await billing.handleWebhookEvent(verified);
    expect(replay.deduped).toBe(true);
    expect(replay.handled).toBe(false);
  });
});
