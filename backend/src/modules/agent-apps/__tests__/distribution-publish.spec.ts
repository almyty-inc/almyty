import { DistributionTarget } from '../../../entities/agent-app-distribution.entity';
import { GatewayType } from '../../../entities/gateway.entity';
import {
  GATEWAY_TYPE_FOR_TARGET,
  REQUIRED_CREDENTIALS,
  agentForDistribution,
  checkPublish,
  endpointFor,
  gatewayConfigurationFor,
  gatewayNameFor,
  missingCredentials,
  rateLimitFor,
  servesOverGateway,
} from '../distribution-publish';

const app = (over: any = {}) => ({
  name: 'Acme Assistant',
  agentIds: ['agent-1'],
  isActive: true,
  limits: null,
  ...over,
});

describe('GATEWAY_TYPE_FOR_TARGET', () => {
  it('maps every distribution target, so none is silently unpublishable', () => {
    // A target with no entry reads as "not served over a gateway",
    // which for a messaging platform would be wrong and invisible.
    for (const target of Object.values(DistributionTarget)) {
      expect(GATEWAY_TYPE_FOR_TARGET).toHaveProperty(target);
    }
  });

  it('serves the web app as a hosted chat, not as a widget', () => {
    // The widget is a bubble in someone else's page; this is a site.
    expect(GATEWAY_TYPE_FOR_TARGET[DistributionTarget.WEB]).toBe(GatewayType.HOSTED_CHAT);
  });

  it('has nothing to stand up for the three that compile to a file', () => {
    expect(servesOverGateway(DistributionTarget.TUI)).toBe(false);
    expect(servesOverGateway(DistributionTarget.DESKTOP)).toBe(false);
    expect(servesOverGateway(DistributionTarget.BINARY)).toBe(false);
  });

  it('serves every messaging platform over a gateway', () => {
    for (const target of [
      DistributionTarget.SLACK,
      DistributionTarget.DISCORD,
      DistributionTarget.TELEGRAM,
      DistributionTarget.WHATSAPP,
      DistributionTarget.EMAIL,
      DistributionTarget.IRC,
    ]) {
      expect(servesOverGateway(target)).toBe(true);
    }
  });
});

const slackCreds = { bot_token: 'xoxb-1', signing_secret: 's3cret' };

describe('REQUIRED_CREDENTIALS', () => {
  it('names a requirement for every target that serves over a gateway', () => {
    for (const target of Object.values(DistributionTarget)) {
      expect(REQUIRED_CREDENTIALS).toHaveProperty(target);
    }
  });

  it('asks nothing of the surfaces we host ourselves', () => {
    // There is no third-party account for an operator to register.
    expect(REQUIRED_CREDENTIALS[DistributionTarget.WEB]).toEqual([]);
    expect(REQUIRED_CREDENTIALS[DistributionTarget.TUI]).toEqual([]);
  });

  it('matches what the adapter actually reads', () => {
    // Read off the adapters rather than their documentation: slack.
    // adapter.ts uses config.bot_token and config.signing_secret.
    expect(REQUIRED_CREDENTIALS[DistributionTarget.SLACK]).toEqual([
      'bot_token',
      'signing_secret',
    ]);
  });
});

describe('missingCredentials', () => {
  it('lists what is absent', () => {
    expect(missingCredentials(DistributionTarget.SLACK, { bot_token: 'xoxb-1' })).toEqual([
      'signing_secret',
    ]);
  });

  it('treats a blank string as missing, not as supplied', () => {
    // A field someone cleared is not a credential.
    expect(missingCredentials(DistributionTarget.TELEGRAM, { bot_token: '   ' })).toEqual([
      'bot_token',
    ]);
  });

  it('treats an absent configuration as everything missing', () => {
    expect(missingCredentials(DistributionTarget.SLACK, null)).toEqual([
      'bot_token',
      'signing_secret',
    ]);
  });

  it('is satisfied by a complete set', () => {
    expect(missingCredentials(DistributionTarget.SLACK, slackCreds)).toEqual([]);
  });
});

describe('checkPublish', () => {
  it('lets a complete product go live', () => {
    expect(checkPublish(DistributionTarget.SLACK, app(), slackCreds)).toEqual({
      ok: true,
      refusals: [],
    });
  });

  it('refuses a platform that cannot carry a message yet, and says what is missing', () => {
    // A gateway created without these says live and answers nothing.
    const result = checkPublish(DistributionTarget.SLACK, app(), { bot_token: 'xoxb-1' });

    expect(result.ok).toBe(false);
    expect(result.refusals[0].code).toBe('MISSING_CREDENTIALS');
    expect(result.refusals[0].message).toContain('signing_secret');
  });

  it('does not ask a hosted surface for credentials it has no account for', () => {
    expect(checkPublish(DistributionTarget.WEB, app(), null).ok).toBe(true);
  });

  it('does not complain about credentials for something that ships as a file', () => {
    // It cannot be published at all, and a second reason reads as a
    // second problem.
    const codes = checkPublish(DistributionTarget.TUI, app(), null).refusals.map((r) => r.code);
    expect(codes).toEqual(['NOT_SERVED']);
  });

  it('refuses a target that ships as a file', () => {
    const result = checkPublish(DistributionTarget.TUI, app());
    expect(result.ok).toBe(false);
    expect(result.refusals[0].code).toBe('NOT_SERVED');
  });

  it('refuses a product with no agent, because nothing would answer', () => {
    const result = checkPublish(DistributionTarget.SLACK, app({ agentIds: [] }), slackCreds);
    expect(result.refusals.map((r) => r.code)).toContain('NO_AGENT');
  });

  it('refuses a product that has been switched off', () => {
    const result = checkPublish(DistributionTarget.SLACK, app({ isActive: false }), slackCreds);
    expect(result.refusals.map((r) => r.code)).toContain('APP_INACTIVE');
  });

  it('does not repeat the cost cap rule, which checkApp already answers', () => {
    // Saying the same thing twice reads as two separate problems.
    const result = checkPublish(DistributionTarget.SLACK, app({ limits: null }), slackCreds);
    expect(result.ok).toBe(true);
  });

  it('reports every reason at once rather than the first', () => {
    const result = checkPublish(
      DistributionTarget.TUI,
      app({ agentIds: [], isActive: false }),
      null,
    );
    expect(result.refusals.map((r) => r.code).sort()).toEqual([
      'APP_INACTIVE',
      'NOT_SERVED',
      'NO_AGENT',
    ]);
  });
});

describe('endpointFor', () => {
  it('is unique per app and target', () => {
    expect(endpointFor('acme-support', DistributionTarget.SLACK)).toBe('/apps/acme-support/slack');
    expect(endpointFor('acme-support', DistributionTarget.SLACK)).not.toBe(
      endpointFor('acme-support', DistributionTarget.TELEGRAM),
    );
  });

  it('does not collide between two products on the same platform', () => {
    expect(endpointFor('acme', DistributionTarget.SLACK)).not.toBe(
      endpointFor('northwind', DistributionTarget.SLACK),
    );
  });
});

describe('gatewayNameFor', () => {
  it('names the gateway after the product it serves', () => {
    expect(gatewayNameFor({ name: 'Acme Assistant' }, DistributionTarget.SLACK)).toBe(
      'Acme Assistant (slack)',
    );
  });
});

describe('rateLimitFor', () => {
  it('carries the product limits onto the surface', () => {
    // The limits are the reason publishing was allowed. Creating the
    // surface without them would make the check theatre.
    const limit = rateLimitFor(app({ limits: { perUserRateLimit: 120, perIpRateLimit: 60 } }));
    expect(limit.enabled).toBe(true);
    expect(limit.requestsPerHour).toBe(120);
  });

  it('takes the higher of the two ceilings', () => {
    expect(rateLimitFor(app({ limits: { perUserRateLimit: 10, perIpRateLimit: 90 } })))
      .toMatchObject({ requestsPerHour: 90 });
  });

  it('adds a per-minute ceiling, so an hour cannot be spent in ten seconds', () => {
    expect(rateLimitFor(app({ limits: { perUserRateLimit: 600 } }))).toMatchObject({
      requestsPerMinute: 10,
    });
  });

  it('never sets a per-minute ceiling of zero', () => {
    // Rounding a small hourly budget down would block every request.
    expect(rateLimitFor(app({ limits: { perUserRateLimit: 5 } }))).toMatchObject({
      requestsPerMinute: 1,
    });
  });

  it('is disabled when the product sets no limits', () => {
    // Only reachable for a product that is not open to anyone; the
    // public rules refuse to publish one without them.
    expect(rateLimitFor(app({ limits: null }))).toEqual({ enabled: false });
    expect(rateLimitFor(app({ limits: { perUserRateLimit: 0, perIpRateLimit: 0 } }))).toEqual({
      enabled: false,
    });
  });
});

describe('checkPublish agent mode', () => {
  const autonomous = { mode: 'autonomous' };

  it('lets a conversational agent through', () => {
    expect(checkPublish(DistributionTarget.SLACK, app(), slackCreds, autonomous).ok).toBe(true);
  });

  it('refuses a workflow agent, which the runtime rejects at the first message', () => {
    // Publishing one produces a surface that is live and turns away
    // every visitor with "Agent is not in autonomous mode".
    const result = checkPublish(DistributionTarget.SLACK, app(), slackCreds, { mode: 'workflow' });

    expect(result.ok).toBe(false);
    expect(result.refusals[0].code).toBe('AGENT_NOT_CONVERSATIONAL');
  });

  it('says nothing about the mode when no agent was resolved', () => {
    // NO_AGENT already covers that, and two messages read as two
    // problems.
    const codes = checkPublish(DistributionTarget.SLACK, app({ agentIds: [] }), slackCreds, null)
      .refusals.map((r) => r.code);
    expect(codes).toEqual(['NO_AGENT']);
  });

  it('does not ask about conversation for something that ships as a file', () => {
    const codes = checkPublish(DistributionTarget.TUI, app(), null, { mode: 'workflow' }).refusals.map(
      (r) => r.code,
    );
    expect(codes).toEqual(['NOT_SERVED']);
  });
});

describe('gatewayConfigurationFor', () => {
  const product = {
    id: 'app-1',
    slug: 'acme-support',
    name: 'Acme Support',
    branding: { appName: 'Acme', primaryColor: '#0f766e', greeting: 'Hi' },
    authMode: 'public_link',
  } as any;

  it('keeps the operator credentials it was given', () => {
    const config = gatewayConfigurationFor(DistributionTarget.SLACK, product, slackCreds);
    expect(config).toMatchObject(slackCreds);
  });

  it('carries the product branding, so no copy has to be kept in step', () => {
    const config = gatewayConfigurationFor(DistributionTarget.SLACK, product, null);
    expect(config.branding).toEqual(product.branding);
    expect(config.appId).toBe('app-1');
  });

  it('gives a web surface the block it is looked up by', () => {
    // findBySlug matches configuration -> 'hostedChat' ->> 'slug'.
    // Without this a published web app is a gateway nothing can find,
    // which is exactly what happened.
    const config = gatewayConfigurationFor(DistributionTarget.WEB, product, null);
    expect(config.hostedChat.slug).toBe('acme-support');
  });

  it('addresses the web surface by the product slug, not its display name', () => {
    // The slug is a hostname label; the display name is not.
    const config = gatewayConfigurationFor(
      DistributionTarget.WEB,
      { ...product, name: 'Acme Support!' },
      null,
    );
    expect(config.hostedChat.slug).toBe('acme-support');
  });

  it('fills the hosted chat from the product branding', () => {
    const config = gatewayConfigurationFor(DistributionTarget.WEB, product, null);
    expect(config.hostedChat).toMatchObject({
      appName: 'Acme',
      primaryColor: '#0f766e',
      greeting: 'Hi',
      authMode: 'public_link',
    });
  });

  it('falls back to the product name when no display name is set', () => {
    const config = gatewayConfigurationFor(
      DistributionTarget.WEB,
      { ...product, branding: {} },
      null,
    );
    expect(config.hostedChat.appName).toBe('Acme Support');
  });

  it('leaves the AI disclosure null, which means the default wording', () => {
    // Clearing it entirely is gated on white-label and audited, so an
    // unset value must not read as a removal.
    const config = gatewayConfigurationFor(DistributionTarget.WEB, product, null);
    expect(config.hostedChat.aiDisclosure).toBeNull();
    expect(config.hostedChat.whiteLabel).toBe(false);
  });

  it('does not put a hostedChat block on anything else', () => {
    const config = gatewayConfigurationFor(DistributionTarget.SLACK, product, slackCreds);
    expect(config.hostedChat).toBeUndefined();
  });
});

describe('agentForDistribution', () => {
  const twoAgents = { agentIds: ['triage-1', 'billing-2'] } as any;

  it('uses the product default when the surface names nobody', () => {
    // The entity documents the first agent as the default.
    expect(agentForDistribution(twoAgents, null)).toBe('triage-1');
    expect(agentForDistribution(twoAgents, {})).toBe('triage-1');
  });

  it('lets a surface name its own', () => {
    // A support product with a triage agent and a billing agent should
    // be able to put the billing one on the billing channel.
    expect(agentForDistribution(twoAgents, { agentId: 'billing-2' })).toBe('billing-2');
  });

  it('ignores a blank choice rather than treating it as one', () => {
    expect(agentForDistribution(twoAgents, { agentId: '   ' })).toBe('triage-1');
  });

  it('has nobody to offer when the product has no agents', () => {
    expect(agentForDistribution({ agentIds: [] } as any, null)).toBeNull();
  });
});

describe('checkPublish agent choice', () => {
  const twoAgents = app({ agentIds: ['triage-1', 'billing-2'] });

  it('accepts an agent that is part of the product', () => {
    const result = checkPublish(
      DistributionTarget.SLACK,
      twoAgents,
      { ...slackCreds, agentId: 'billing-2' },
      { mode: 'autonomous' },
    );
    expect(result.ok).toBe(true);
  });

  it('refuses one that has since been removed from it', () => {
    // Otherwise the surface answers with something the operator thinks
    // is no longer involved.
    const result = checkPublish(
      DistributionTarget.SLACK,
      twoAgents,
      { ...slackCreds, agentId: 'removed-9' },
      { mode: 'autonomous' },
    );
    expect(result.refusals.map((r) => r.code)).toContain('AGENT_NOT_ON_APP');
  });

  it('says nothing about the choice when none was made', () => {
    const codes = checkPublish(
      DistributionTarget.SLACK,
      twoAgents,
      slackCreds,
      { mode: 'autonomous' },
    ).refusals.map((r) => r.code);
    expect(codes).not.toContain('AGENT_NOT_ON_APP');
  });
});
