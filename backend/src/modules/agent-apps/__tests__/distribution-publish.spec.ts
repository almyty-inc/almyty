import { DistributionTarget } from '../../../entities/agent-app-distribution.entity';
import { GatewayType } from '../../../entities/gateway.entity';
import {
  GATEWAY_TYPE_FOR_TARGET,
  checkPublish,
  endpointFor,
  gatewayNameFor,
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

describe('checkPublish', () => {
  it('lets a complete product go live', () => {
    expect(checkPublish(DistributionTarget.SLACK, app())).toEqual({ ok: true, refusals: [] });
  });

  it('refuses a target that ships as a file', () => {
    const result = checkPublish(DistributionTarget.TUI, app());
    expect(result.ok).toBe(false);
    expect(result.refusals[0].code).toBe('NOT_SERVED');
  });

  it('refuses a product with no agent, because nothing would answer', () => {
    const result = checkPublish(DistributionTarget.SLACK, app({ agentIds: [] }));
    expect(result.refusals.map((r) => r.code)).toContain('NO_AGENT');
  });

  it('refuses a product that has been switched off', () => {
    const result = checkPublish(DistributionTarget.SLACK, app({ isActive: false }));
    expect(result.refusals.map((r) => r.code)).toContain('APP_INACTIVE');
  });

  it('does not repeat the cost cap rule, which checkApp already answers', () => {
    // Saying the same thing twice reads as two separate problems.
    const result = checkPublish(DistributionTarget.SLACK, app({ limits: null }));
    expect(result.ok).toBe(true);
  });

  it('reports every reason at once rather than the first', () => {
    const result = checkPublish(DistributionTarget.TUI, app({ agentIds: [], isActive: false }));
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
