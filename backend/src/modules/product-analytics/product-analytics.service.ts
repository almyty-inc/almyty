import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Not, Repository } from 'typeorm';

import { User } from '../../entities/user.entity';
import { Agent } from '../../entities/agent.entity';
import { Organization } from '../../entities/organization.entity';
import { UserOrganization } from '../../entities/user-organization.entity';
import { isOwnAgent } from '../onboarding/real-activation';
import { sanitizeSignupAttribution } from './signup-attribution';

export const POSTHOG_API_KEY_ENV = 'POSTHOG_API_KEY';
export const POSTHOG_HOST_ENV = 'POSTHOG_HOST';
export const DEFAULT_POSTHOG_HOST = 'https://eu.i.posthog.com';

export const SIGNUP_COMPLETED_EVENT = 'signup_completed';
export const FIRST_RUN_SUCCEEDED_EVENT = 'first_run_succeeded';

/** How long one capture may take before it is abandoned. */
const CAPTURE_TIMEOUT_MS = 5_000;

/** A run that reached completed. */
export interface RunSucceeded {
  agentId: string;
  /** The dashboard user who started the run; null for a visitor, a schedule or a webhook. */
  userId: string | null | undefined;
}

/**
 * Server-side funnel events for PostHog, sent once per user:
 *
 * - `signup_completed`: the account exists and its email is verified (on
 *   verification, or at creation for an auto-verified address).
 * - `first_run_succeeded`: the first run of one of the org's own agents
 *   (onboarding/real-activation.ts) that completed, workflow or autonomous.
 *
 * distinct_id is the user id, the same id the frontend passes to
 * identify(). Properties are ids, the plan, the sign-up method and the
 * sign-up link's attribution: never an email, a name or free text.
 *
 * Once-only: each event is claimed with a conditional UPDATE on the user
 * row (`signupEventAt` / `firstRunEventAt` set only while NULL). Postgres
 * lets exactly one UPDATE match, whichever replica or retry sends it, and
 * the claim survives restarts. A capture lost after its claim is not sent
 * again: at most once, never twice.
 *
 * The claim is written whether or not POSTHOG_API_KEY is set: it is a
 * timestamp on the user's own row noting that the milestone happened.
 * Only the send needs the key, and a milestone reached without one is
 * never sent later, so turning PostHog on never reports an old milestone
 * as new. Without a key nothing leaves the system.
 *
 * Delivery is one fetch to PostHog's /capture/ endpoint rather than
 * posthog-node: two events per user do not need a batching client, its
 * flush-on-shutdown lifecycle, or another dependency. Every method here
 * swallows its own errors and callers do not await it, so analytics can
 * neither fail nor slow the request that triggered it.
 */
@Injectable()
export class ProductAnalyticsService {
  private readonly logger = new Logger(ProductAnalyticsService.name);

  constructor(
    @InjectRepository(User)
    private readonly users: Repository<User>,
    @InjectRepository(Agent)
    private readonly agents: Repository<Agent>,
    @InjectRepository(Organization)
    private readonly organizations: Repository<Organization>,
    @InjectRepository(UserOrganization)
    private readonly memberships: Repository<UserOrganization>,
  ) {}

  /** Read per call, so a key set or removed in the environment takes effect without a rebuild of this object. */
  isEnabled(): boolean {
    return !!apiKey();
  }

  /** Call when an account may just have become verified. Never throws. */
  async signupCompleted(userId: string): Promise<void> {
    try {
      if (!userId) return;
      // Only a verified account, and only the first time. Claimed with or
      // without a key, so a key set later never reports it as new.
      const claimed = await this.users.update(
        { id: userId, verifiedAt: Not(IsNull()), signupEventAt: IsNull() },
        { signupEventAt: new Date() },
      );
      if (!claimed?.affected || !this.isEnabled()) return;

      const user = await this.users.findOne({ where: { id: userId }, select: { id: true, signupAttribution: true } });
      const membership = await this.memberships.findOne({
        where: { userId },
        relations: { organization: true },
        order: { joinedAt: 'ASC' },
      });
      await this.capture(userId, SIGNUP_COMPLETED_EVENT, {
        organization_id: membership?.organizationId ?? null,
        plan: membership?.organization?.plan ?? null,
        signup_method: 'email',
        ...attributionOf(user),
      });
    } catch (err) {
      this.logger.warn(`signup_completed for ${userId} not sent: ${(err as Error)?.message}`);
    }
  }

  /** Call when a run reached completed. Never throws. */
  async runSucceeded(run: RunSucceeded): Promise<void> {
    try {
      if (!run?.agentId) return;
      const agent = await this.agents.findOne({
        where: { id: run.agentId },
        select: { id: true, organizationId: true, isTemporary: true, metadata: true, createdBy: true, mode: true },
      });
      if (!agent || !isOwnAgent(agent)) return;
      // The person who started it; a scheduled, webhook or visitor run
      // counts for whoever built the agent.
      const userId = run.userId || agent.createdBy;
      if (!userId) return;

      // Claimed with or without a key: the milestone is noted on the
      // user's row either way, so a key set later never reports it as new.
      const claimed = await this.users.update(
        { id: userId, firstRunEventAt: IsNull() },
        { firstRunEventAt: new Date() },
      );
      if (!claimed?.affected || !this.isEnabled()) return;

      const [user, organization] = await Promise.all([
        this.users.findOne({ where: { id: userId }, select: { id: true, signupAttribution: true } }),
        this.organizations.findOne({ where: { id: agent.organizationId }, select: { id: true, plan: true } }),
      ]);
      await this.capture(userId, FIRST_RUN_SUCCEEDED_EVENT, {
        organization_id: agent.organizationId,
        plan: organization?.plan ?? null,
        agent_mode: agent.mode === 'workflow' ? 'workflow' : 'autonomous',
        ...attributionOf(user),
      });
    } catch (err) {
      this.logger.warn(`first_run_succeeded for agent ${run?.agentId} not sent: ${(err as Error)?.message}`);
    }
  }

  private async capture(distinctId: string, event: string, properties: Record<string, unknown>): Promise<void> {
    const key = apiKey();
    if (!key) return;
    const environment = environmentTag();
    const response = await fetch(`${host()}/capture/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        api_key: key,
        event,
        distinct_id: distinctId,
        timestamp: new Date().toISOString(),
        properties: { ...properties, ...(environment ? { environment } : {}), $lib: 'almyty-backend' },
      }),
      signal: AbortSignal.timeout(CAPTURE_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`PostHog answered ${response.status}`);
  }
}

function apiKey(): string | undefined {
  const key = process.env[POSTHOG_API_KEY_ENV]?.trim();
  return key ? key : undefined;
}

function host(): string {
  let configured = process.env[POSTHOG_HOST_ENV]?.trim() || DEFAULT_POSTHOG_HOST;
  while (configured.endsWith('/')) configured = configured.slice(0, -1);
  return configured;
}

/**
 * Tags events the way the frontend does (`environment`), so staging and
 * production stay apart in the one shared project.
 */
function environmentTag(): string | undefined {
  return process.env.POSTHOG_ENVIRONMENT?.trim() || process.env.SENTRY_ENVIRONMENT?.trim() || process.env.NODE_ENV?.trim() || undefined;
}

/** The stored attribution, whitelisted again on the way out. */
function attributionOf(user: Pick<User, 'signupAttribution'> | null | undefined): Record<string, string> {
  return sanitizeSignupAttribution(user?.signupAttribution) ?? {};
}
