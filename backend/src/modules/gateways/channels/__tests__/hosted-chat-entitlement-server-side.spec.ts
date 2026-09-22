import { canPublishHostedChat } from '../hosted-chat.config';

/**
 * The white-label rules are enforced on the server, not only in the builder.
 *
 * `canPublishHostedChat` had exactly one caller: the React component. No
 * service or controller ran it, and the gateway write path has no
 * HOSTED_CHAT case, so a `PATCH /gateways/:id` setting `whiteLabel: true`
 * and `aiDisclosure: ""` was accepted outright — and the public page then
 * dropped both the almyty mark and the AI disclosure. The disclosure is
 * an EU AI Act Art. 50 control, so this was a compliance gap, not a
 * branding one.
 *
 * The rule itself also only ever checked disclosure removal; the
 * `whiteLabel` flag was never compared against the entitlement at all.
 */
describe('hosted chat publish rules', () => {
  const base: any = {
    slug: 'acme-support',
    authMode: 'sso',
    aiDisclosure: null,
    whiteLabel: false,
    costCapCents: 500,
    perEndUserRateLimit: 10,
    perIpRateLimit: 10,
  };

  const codes = (config: any, context: any) =>
    canPublishHostedChat(config, context).refusals.map(r => r.code);

  it('refuses white label without the entitlement', () => {
    expect(codes({ ...base, whiteLabel: true }, { hasEnterpriseAuth: true })).toContain(
      'WHITE_LABEL_NOT_ENTITLED',
    );
  });

  it('allows white label with it', () => {
    expect(
      codes({ ...base, whiteLabel: true }, { hasEnterpriseAuth: true, hasWhiteLabel: true }),
    ).not.toContain('WHITE_LABEL_NOT_ENTITLED');
  });

  it('still refuses removing the AI disclosure without the entitlement', () => {
    expect(codes({ ...base, aiDisclosure: '' }, { hasEnterpriseAuth: true })).toContain(
      'DISCLOSURE_REMOVAL_NOT_ENTITLED',
    );
  });

  it('treats a null disclosure as "use the default", which anyone may do', () => {
    expect(codes(base, { hasEnterpriseAuth: true })).toEqual([]);
  });

  it('refuses an enterprise auth mode without the entitlement', () => {
    expect(codes(base, {})).toContain('AUTH_MODE_NOT_ENTITLED');
  });

  /**
   * An absent `aiDisclosure` is not an empty one.
   *
   * The removal check was `config.aiDisclosure !== null && ...trim() === ''`.
   * `undefined` passes a `!== null` test and then `.trim()` throws a
   * TypeError, which createGateway and updateGateway surface as a 500 —
   * so a publish check whose job is to produce a list of refusals
   * produced a stack trace instead. The zod schema defaults the field so
   * the ordinary API path never gets there; a config assembled by a
   * seed, a migration or an MCP call does.
   */
  describe('an absent disclosure', () => {
    it('does not throw where an explicit removal would refuse', () => {
      const { aiDisclosure, ...withoutDisclosure } = base;
      expect(() => canPublishHostedChat(withoutDisclosure as any, {})).not.toThrow();
    });

    it('is treated as "use the default line", not as a removal', () => {
      const { aiDisclosure, ...withoutDisclosure } = base;
      expect(codes(withoutDisclosure, { hasEnterpriseAuth: true })).not.toContain(
        'DISCLOSURE_REMOVAL_NOT_ENTITLED',
      );
    });

    it('still refuses an explicitly emptied disclosure without the entitlement', () => {
      // The compliance control this rule exists for. An empty string is
      // somebody deliberately taking the line off.
      expect(codes({ ...base, aiDisclosure: '' }, { hasEnterpriseAuth: true })).toContain(
        'DISCLOSURE_REMOVAL_NOT_ENTITLED',
      );
      expect(codes({ ...base, aiDisclosure: '   ' }, { hasEnterpriseAuth: true })).toContain(
        'DISCLOSURE_REMOVAL_NOT_ENTITLED',
      );
    });

    it('allows a custom disclosure line without the entitlement', () => {
      // Changing the wording is not removing the mark.
      expect(
        codes({ ...base, aiDisclosure: 'Answers come from an AI.' }, { hasEnterpriseAuth: true }),
      ).not.toContain('DISCLOSURE_REMOVAL_NOT_ENTITLED');
    });
  });
});
