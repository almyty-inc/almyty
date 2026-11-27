import { snapshotEnv } from '../../../test/env';
import {
  DEFAULT_POSTHOG_HOST,
  FIRST_RUN_SUCCEEDED_EVENT,
  MILESTONE_FRESH_MS,
  ProductAnalyticsService,
  SIGNUP_COMPLETED_EVENT,
} from '../product-analytics.service';

/**
 * The once-only claim is a conditional UPDATE. This fake applies the same
 * rule Postgres does: an UPDATE whose WHERE no longer matches affects no
 * rows, and two UPDATEs on one row run one after the other. Criteria are
 * the TypeORM FindOperators the service passes (IsNull / Not(IsNull)).
 */
function matches(row: Record<string, any>, criteria: Record<string, any>): boolean {
  return Object.entries(criteria).every(([key, want]) => {
    const value = row[key] ?? null;
    if (want && typeof want === 'object' && '_type' in want) {
      if (want._type === 'isNull') return value === null;
      if (want._type === 'not') {
        const inner = want._value;
        if (inner && typeof inner === 'object' && inner._type === 'isNull') return value !== null;
        return value !== inner;
      }
      throw new Error(`fake repo: unsupported operator ${want._type}`);
    }
    return value === want;
  });
}

function fakeRepo(rows: Record<string, any>[]) {
  return {
    rows,
    update: jest.fn(async (criteria: Record<string, any>, patch: Record<string, any>) => {
      // Yield first, so concurrent callers really interleave.
      await Promise.resolve();
      let affected = 0;
      for (const row of rows) {
        if (matches(row, criteria)) {
          Object.assign(row, patch);
          affected++;
        }
      }
      return { affected };
    }),
    findOne: jest.fn(async ({ where }: { where: Record<string, any> }) => rows.find((r) => matches(r, where)) ?? null),
  };
}

const USER_ID = 'user-1';
const ORG_ID = 'org-1';

function setup(overrides: { user?: Record<string, any>; agent?: Record<string, any>; earlierRun?: boolean } = {}) {
  const user = {
    id: USER_ID,
    email: 'dana@example.com',
    firstName: 'Dana',
    lastName: 'Lind',
    verifiedAt: new Date(),
    signupAttribution: { utm_source: 'almyty.com', utm_campaign: 'launch', cta: 'hero' },
    signupEventAt: null,
    firstRunEventAt: null,
    ...overrides.user,
  };
  const agent = {
    id: 'agent-1',
    organizationId: ORG_ID,
    isTemporary: false,
    metadata: null,
    createdBy: USER_ID,
    mode: 'autonomous',
    ...overrides.agent,
  };
  const users = Object.assign(fakeRepo([user]), {
    // hasEarlierQualifyingRun: an own-agent run that finished before the window.
    manager: { query: jest.fn(async (_sql: string, _params: string[]) => [{ earlier: !!overrides.earlierRun }]) },
  });
  const agents = fakeRepo([agent]);
  const organizations = fakeRepo([{ id: ORG_ID, plan: 'pro', name: 'Lind Labs' }]);
  const memberships = {
    findOne: jest.fn(async () => ({ userId: USER_ID, organizationId: ORG_ID, organization: { id: ORG_ID, plan: 'pro', name: 'Lind Labs' } })),
  };
  const service = new ProductAnalyticsService(users as any, agents as any, organizations as any, memberships as any);
  return { service, users, agents, user, agent };
}

function sentEvents(fetchMock: jest.Mock): Array<{ url: string; body: any }> {
  return fetchMock.mock.calls.map(([url, init]) => ({ url, body: JSON.parse(init.body) }));
}

describe('ProductAnalyticsService', () => {
  let restore: () => void;
  let fetchMock: jest.Mock;
  const realFetch = global.fetch;

  beforeEach(() => {
    restore = snapshotEnv('POSTHOG_API_KEY', 'POSTHOG_HOST', 'POSTHOG_ENVIRONMENT');
    process.env.POSTHOG_API_KEY = 'phc_test';
    delete process.env.POSTHOG_HOST;
    process.env.POSTHOG_ENVIRONMENT = 'staging';
    fetchMock = jest.fn(async () => ({ ok: true, status: 200 }));
    global.fetch = fetchMock as any;
  });

  afterEach(() => {
    restore();
    global.fetch = realFetch;
  });

  describe('signup_completed', () => {
    it('sends one event for a verified account, keyed by the user id, with no email, name or free text', async () => {
      const { service } = setup();
      await service.signupCompleted(USER_ID);

      const events = sentEvents(fetchMock);
      expect(events).toHaveLength(1);
      expect(events[0].url).toBe(`${DEFAULT_POSTHOG_HOST}/capture/`);
      expect(events[0].body).toEqual({
        api_key: 'phc_test',
        event: SIGNUP_COMPLETED_EVENT,
        distinct_id: USER_ID,
        timestamp: expect.any(String),
        properties: {
          organization_id: ORG_ID,
          plan: 'pro',
          signup_method: 'email',
          utm_source: 'almyty.com',
          utm_campaign: 'launch',
          cta: 'hero',
          environment: 'staging',
          $lib: 'almyty-backend',
        },
      });
      const raw = JSON.stringify(events[0].body);
      for (const pii of ['dana@example.com', 'Dana', 'Lind']) expect(raw).not.toContain(pii);
    });

    it('sends it once, even when called twice at the same moment and again later', async () => {
      const { service, user } = setup();
      await Promise.all([service.signupCompleted(USER_ID), service.signupCompleted(USER_ID)]);
      await service.signupCompleted(USER_ID);

      expect(sentEvents(fetchMock)).toHaveLength(1);
      expect(user.signupEventAt).toBeInstanceOf(Date);
    });

    it('sends nothing for an account whose email is not verified, and leaves it unclaimed', async () => {
      const { service, user } = setup({ user: { verifiedAt: null } });
      await service.signupCompleted(USER_ID);

      expect(fetchMock).not.toHaveBeenCalled();
      expect(user.signupEventAt).toBeNull();

      // Verifying later still counts.
      user.verifiedAt = new Date();
      await service.signupCompleted(USER_ID);
      expect(sentEvents(fetchMock).map((e) => e.body.event)).toEqual([SIGNUP_COMPLETED_EVENT]);
    });

    it('drops stored attribution keys that are not on the whitelist on the way out', async () => {
      const { service } = setup({ user: { signupAttribution: { utm_source: 'x', email: 'a@b.c', utm_term: 'free text' } } });
      await service.signupCompleted(USER_ID);
      const props = sentEvents(fetchMock)[0].body.properties;
      expect(props.utm_source).toBe('x');
      expect(props).not.toHaveProperty('email');
      expect(props).not.toHaveProperty('utm_term');
    });
  });

  describe('first_run_succeeded', () => {
    it('sends one event for the first completed run of an own agent, for the user who started it', async () => {
      const { service } = setup({ agent: { mode: 'workflow' } });
      await service.runSucceeded({ agentId: 'agent-1', userId: USER_ID });

      const events = sentEvents(fetchMock);
      expect(events).toHaveLength(1);
      expect(events[0].body).toMatchObject({
        event: FIRST_RUN_SUCCEEDED_EVENT,
        distinct_id: USER_ID,
        properties: {
          organization_id: ORG_ID,
          plan: 'pro',
          agent_mode: 'workflow',
          utm_source: 'almyty.com',
          utm_campaign: 'launch',
          cta: 'hero',
        },
      });
    });

    it('sends it once across concurrent and later runs', async () => {
      const { service } = setup();
      await Promise.all([
        service.runSucceeded({ agentId: 'agent-1', userId: USER_ID }),
        service.runSucceeded({ agentId: 'agent-1', userId: USER_ID }),
        service.runSucceeded({ agentId: 'agent-1', userId: null }),
      ]);
      await service.runSucceeded({ agentId: 'agent-1', userId: USER_ID });
      expect(sentEvents(fetchMock)).toHaveLength(1);
    });

    it('counts a run nobody started (schedule, webhook, visitor) for the agent builder', async () => {
      const { service } = setup();
      await service.runSucceeded({ agentId: 'agent-1', userId: null });
      expect(sentEvents(fetchMock)[0].body.distinct_id).toBe(USER_ID);
    });

    it.each([
      ['a sample agent', { metadata: { sampleWorkspace: true } }],
      ['a temporary sub-agent copy', { isTemporary: true }],
    ])('sends nothing for %s and leaves the user unclaimed', async (_label, agent) => {
      const { service, user } = setup({ agent });
      await service.runSucceeded({ agentId: 'agent-1', userId: USER_ID });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(user.firstRunEventAt).toBeNull();
    });
  });

  describe('without POSTHOG_API_KEY', () => {
    it('claims both milestones on the user row and sends nothing', async () => {
      delete process.env.POSTHOG_API_KEY;
      const { service, user } = setup();
      await service.signupCompleted(USER_ID);
      await service.runSucceeded({ agentId: 'agent-1', userId: USER_ID });

      expect(service.isEnabled()).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(user.signupEventAt).toBeInstanceOf(Date);
      expect(user.firstRunEventAt).toBeInstanceOf(Date);
    });

    it('never sends a milestone reached without a key once a key is set', async () => {
      delete process.env.POSTHOG_API_KEY;
      const { service, user } = setup();
      await service.signupCompleted(USER_ID);
      await service.runSucceeded({ agentId: 'agent-1', userId: USER_ID });

      process.env.POSTHOG_API_KEY = 'phc_test';
      await service.signupCompleted(USER_ID);
      await service.runSucceeded({ agentId: 'agent-1', userId: USER_ID });

      expect(fetchMock).not.toHaveBeenCalled();
      expect(user.signupEventAt).toBeInstanceOf(Date);
      expect(user.firstRunEventAt).toBeInstanceOf(Date);
    });

    it('still claims nothing for an unverified account or a sample agent', async () => {
      delete process.env.POSTHOG_API_KEY;
      const { service, user } = setup({ user: { verifiedAt: null }, agent: { metadata: { sampleWorkspace: true } } });
      await service.signupCompleted(USER_ID);
      await service.runSucceeded({ agentId: 'agent-1', userId: USER_ID });

      expect(user.signupEventAt).toBeNull();
      expect(user.firstRunEventAt).toBeNull();
    });
  });

  describe('a milestone written earlier without a claim (an older server during a deploy)', () => {
    it('does not send signup_completed for an address confirmed before the window', async () => {
      const { service, user } = setup({
        user: { verifiedAt: new Date(Date.now() - MILESTONE_FRESH_MS - 60_000) },
      });
      await service.signupCompleted(USER_ID);
      expect(user.signupEventAt).toBeInstanceOf(Date);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('does not send first_run_succeeded when an earlier own-agent run finished before the window', async () => {
      const { service, users, user } = setup({ earlierRun: true });
      const before = Date.now();
      await service.runSucceeded({ agentId: 'agent-1', userId: USER_ID });
      expect(user.firstRunEventAt).toBeInstanceOf(Date);
      expect(fetchMock).not.toHaveBeenCalled();
      const [, [who, cutoff]] = users.manager.query.mock.calls[0];
      expect(who).toBe(USER_ID);
      expect(Math.abs(new Date(cutoff).getTime() - (before - MILESTONE_FRESH_MS))).toBeLessThan(5_000);
    });

    it('still sends both for a milestone that just happened', async () => {
      const { service } = setup({ earlierRun: false });
      await service.signupCompleted(USER_ID);
      await service.runSucceeded({ agentId: 'agent-1', userId: USER_ID });
      expect(sentEvents(fetchMock).map((e) => e.body.event)).toEqual([SIGNUP_COMPLETED_EVENT, FIRST_RUN_SUCCEEDED_EVENT]);
    });
  });

  it('never throws when PostHog fails or the database does', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));
    const { service, users } = setup();
    await expect(service.signupCompleted(USER_ID)).resolves.toBeUndefined();

    users.update.mockRejectedValue(new Error('db down'));
    await expect(service.runSucceeded({ agentId: 'agent-1', userId: USER_ID })).resolves.toBeUndefined();
  });

  it('honours POSTHOG_HOST', async () => {
    process.env.POSTHOG_HOST = 'https://ph.example.com/';
    const { service } = setup();
    await service.signupCompleted(USER_ID);
    expect(sentEvents(fetchMock)[0].url).toBe('https://ph.example.com/capture/');
  });
});
