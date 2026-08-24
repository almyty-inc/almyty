import {
  HOSTED_CHAT_DEFAULTS,
  HOSTED_CHAT_REFUSALS,
  RESERVED_SLUGS,
  canPublishHostedChat,
  hostedChatConfigFrom,
  hostedChatConfigSchema,
  type HostedChatConfig,
} from '../hosted-chat.config';

const config = (overrides: Partial<HostedChatConfig> = {}): HostedChatConfig => ({
  ...HOSTED_CHAT_DEFAULTS,
  slug: 'acme',
  appName: 'Acme Assistant',
  ...overrides,
});

/** A public link that satisfies every guard, for isolating one failure. */
const SAFE_PUBLIC = {
  costCapCents: 500,
  perEndUserRateLimit: 20,
  perIpRateLimit: 60,
};

describe('hosted chat slug', () => {
  it('accepts a normal hostname label and lowercases it', () => {
    const parsed = hostedChatConfigSchema.parse({ ...config(), slug: 'ACME-Support' });
    expect(parsed.slug).toBe('acme-support');
  });

  it('rejects labels that are not valid DNS', () => {
    for (const slug of ['-acme', 'acme-', 'ac me', 'acme_support', 'ac', 'a'.repeat(64)]) {
      expect(hostedChatConfigSchema.safeParse({ ...config(), slug }).success).toBe(false)
    }
  });

  it('refuses slugs we route ourselves', () => {
    for (const slug of RESERVED_SLUGS) {
      const parsed = hostedChatConfigSchema.safeParse({ ...config(), slug });
      expect(parsed.success).toBe(false);
    }
  });
});

describe('hostedChatConfigFrom', () => {
  it('returns defaults when nothing is saved', () => {
    expect(hostedChatConfigFrom(null)).toEqual(HOSTED_CHAT_DEFAULTS);
    expect(hostedChatConfigFrom({})).toEqual(HOSTED_CHAT_DEFAULTS);
  });

  it('merges saved values over the defaults', () => {
    const resolved = hostedChatConfigFrom({
      hostedChat: { slug: 'acme', appName: 'Acme', primaryColor: '#22d3ee' },
    });
    expect(resolved.slug).toBe('acme');
    expect(resolved.primaryColor).toBe('#22d3ee');
    // Untouched keys still come from the defaults.
    expect(resolved.theme).toBe('auto');
  });

  it('falls back to defaults rather than throwing on a corrupt block', () => {
    expect(hostedChatConfigFrom({ hostedChat: { primaryColor: 'not-a-color' } })).toEqual(
      HOSTED_CHAT_DEFAULTS,
    );
    expect(hostedChatConfigFrom({ hostedChat: ['nonsense'] })).toEqual(HOSTED_CHAT_DEFAULTS);
  });

  it('caps suggested prompts', () => {
    const tooMany = { hostedChat: { ...config(), suggestedPrompts: ['a', 'b', 'c', 'd', 'e'] } };
    expect(hostedChatConfigFrom(tooMany)).toEqual(HOSTED_CHAT_DEFAULTS);
  });
});

describe('canPublishHostedChat', () => {
  it('publishes a public link that has a cost cap and both rate limits', () => {
    expect(canPublishHostedChat(config(), SAFE_PUBLIC)).toEqual({
      publishable: true,
      refusals: [],
    });
  });

  it('refuses a public link with no cost cap', () => {
    // On bring-your-own-key this is the difference between a demo and
    // handing strangers the customer's model spend.
    const check = canPublishHostedChat(config(), { ...SAFE_PUBLIC, costCapCents: null });
    expect(check.publishable).toBe(false);
    expect(check.refusals).toContainEqual({
      code: 'PUBLIC_LINK_NEEDS_COST_CAP',
      message: HOSTED_CHAT_REFUSALS.PUBLIC_LINK_NEEDS_COST_CAP,
    });
  });

  it('treats a zero or negative cost cap as no cap', () => {
    expect(canPublishHostedChat(config(), { ...SAFE_PUBLIC, costCapCents: 0 }).publishable).toBe(
      false,
    );
    expect(canPublishHostedChat(config(), { ...SAFE_PUBLIC, costCapCents: -1 }).publishable).toBe(
      false,
    );
  });

  it('requires BOTH a per-visitor and a per-IP limit, not either', () => {
    const noPerIp = canPublishHostedChat(config(), { ...SAFE_PUBLIC, perIpRateLimit: null });
    const noPerUser = canPublishHostedChat(config(), { ...SAFE_PUBLIC, perEndUserRateLimit: null });
    for (const check of [noPerIp, noPerUser]) {
      expect(check.publishable).toBe(false);
      expect(check.refusals.map((r) => r.code)).toContain('PUBLIC_LINK_NEEDS_RATE_LIMIT');
    }
  });

  it('reports every refusal at once rather than one at a time', () => {
    const check = canPublishHostedChat(config({ slug: '' }), {});
    expect(check.refusals.map((r) => r.code).sort()).toEqual([
      'PUBLIC_LINK_NEEDS_COST_CAP',
      'PUBLIC_LINK_NEEDS_RATE_LIMIT',
      'SLUG_INVALID',
    ]);
  });

  it('pairs every refusal code with a sentence a person can act on', () => {
    const check = canPublishHostedChat(config({ slug: '' }), {});
    for (const refusal of check.refusals) {
      expect(refusal.message).toBe(HOSTED_CHAT_REFUSALS[refusal.code]);
      expect(refusal.message.length).toBeGreaterThan(20);
    }
  });

  it('does not demand a cost cap for gated surfaces', () => {
    // An OTP or SSO gate is the thing standing between a stranger and
    // the spend, so the public-link rules do not apply.
    expect(canPublishHostedChat(config({ authMode: 'email_otp' }), {}).publishable).toBe(true);
  });

  it('refuses SSO without the entitlement, and allows it with', () => {
    expect(canPublishHostedChat(config({ authMode: 'sso' }), {}).refusals[0].code).toBe(
      'AUTH_MODE_NOT_ENTITLED',
    );
    expect(
      canPublishHostedChat(config({ authMode: 'sso' }), { hasEnterpriseAuth: true }).publishable,
    ).toBe(true);
  });

  describe('Art. 50 disclosure', () => {
    it('allows the default line, which is what null means', () => {
      expect(
        canPublishHostedChat(config({ aiDisclosure: null }), SAFE_PUBLIC).publishable,
      ).toBe(true);
    });

    it('allows a custom line without any entitlement', () => {
      expect(
        canPublishHostedChat(config({ aiDisclosure: 'This is a bot.' }), SAFE_PUBLIC).publishable,
      ).toBe(true);
    });

    it('refuses removal without the white-label entitlement', () => {
      const check = canPublishHostedChat(config({ aiDisclosure: '   ' }), SAFE_PUBLIC);
      expect(check.publishable).toBe(false);
      expect(check.refusals[0].code).toBe('DISCLOSURE_REMOVAL_NOT_ENTITLED');
    });

    it('allows removal with the entitlement', () => {
      expect(
        canPublishHostedChat(config({ aiDisclosure: '' }), {
          ...SAFE_PUBLIC,
          hasWhiteLabel: true,
        }).publishable,
      ).toBe(true);
    });
  });
});
