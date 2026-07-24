import { Injectable, Logger } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';
import { InjectRepository } from '@nestjs/typeorm';
import { MoreThan, Not, IsNull, Repository } from 'typeorm';

import { User } from '../../entities/user.entity';
import { UserOrganization, OrganizationRole } from '../../entities/user-organization.entity';
import { MailService } from '../mail/mail.service';
import { OnboardingService } from '../onboarding/onboarding.service';

/**
 * New-signup activation lifecycle emails.
 *
 * Catches the "signed up, never came back" segment: a welcome email on
 * email verification, then a state-aware activation cadence tied to real
 * onboarding progress, plus a post-activation congrats. Everything here
 * is an operator/growth tool (the instance operator emailing their own
 * signups), so it lives in the Apache core and is strictly guardrailed:
 *
 *   - verified-only (unverified signups are likely bots),
 *   - per-user opt-out honored on every send,
 *   - every email type deduped via preferences.lifecycle,
 *   - at most one email per user per sweep,
 *   - nudges stop the instant a user activates (first_call true); the
 *     one exception is the good-moment congrats, which fires ON activation,
 *   - the feature is opt-in (see LIFECYCLE_EMAILS_ENABLED below).
 *
 * Dedupe / opt-out state lives in the existing `user.preferences` JSON
 * column under `preferences.lifecycle` — no new table, no migration.
 */

/** Default app URL used in CTAs when APP_URL / FRONTEND_URL are unset. */
export const DEFAULT_APP_URL = 'https://app.almyty.com';

/**
 * Cadence thresholds in whole days since signup (createdAt). Exported so
 * they are easy to tune in one place. An email is only "due" once the
 * user is at least this many days old AND the corresponding step is still
 * missing AND that email has not already been sent.
 *
 * Each threshold is ENV-OVERRIDABLE (LIFECYCLE_STATE_NUDGE_DAY,
 * LIFECYCLE_SHOWCASE_DAY, LIFECYCLE_LAST_TOUCH_DAY,
 * LIFECYCLE_SWEEP_LOOKBACK_DAYS) so the staging verify harness (and any
 * operator tuning) can shift the windows without a redeploy. An unset or
 * non-numeric value falls back to the production default below.
 * MARKETING: refine copy + cadence
 */
/** Read a positive-integer day threshold from env, else the default. */
function envDay(name: string, fallback: number): number {
  const raw = (process.env[name] ?? '').trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

/** State-aware nudge (provider/api/gateway/first_call): T+2d. */
export const STATE_NUDGE_DAY = envDay('LIFECYCLE_STATE_NUDGE_DAY', 2);
/** "Give claude your api" concrete showcase: T+5d. */
export const SHOWCASE_DAY = envDay('LIFECYCLE_SHOWCASE_DAY', 5);
/** Last touch ("here's what people build", then stop): T+10d. */
export const LAST_TOUCH_DAY = envDay('LIFECYCLE_LAST_TOUCH_DAY', 10);

/**
 * Only signups from roughly the last window are swept. Older accounts
 * that never activated are past the point where a "finish setup" email
 * is welcome, and it keeps the sweep query bounded. Must exceed
 * LAST_TOUCH_DAY so the day-10 touch (and a just-after-10 activation
 * congrats) still falls inside the window.
 */
export const SWEEP_LOOKBACK_DAYS = envDay('LIFECYCLE_SWEEP_LOOKBACK_DAYS', 11);

/** Shape stored under user.preferences.lifecycle. All timestamps are ISO strings. */
interface LifecycleState {
  optOut?: boolean;
  welcome?: string;
  /** The single state-aware T+2 nudge (whichever step they were stuck on). */
  stateNudge?: string;
  showcase?: string;
  lastTouch?: string;
  /** Post-activation good-moment congrats (fires ON activation, once). */
  activatedCongrats?: string;
  /** Legacy marker: first time we observed the user activated. */
  activated?: string;
}

@Injectable()
export class LifecycleEmailService {
  private readonly logger = new Logger(LifecycleEmailService.name);

  constructor(
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectRepository(UserOrganization)
    private readonly userOrgRepo: Repository<UserOrganization>,
    private readonly mailService: MailService,
    private readonly onboardingService: OnboardingService,
  ) {}

  /**
   * Opt-in gate. Lifecycle activation emails are an operator/growth tool:
   * the instance operator emailing their OWN signups, not a per-tenant
   * feature. A self-hoster running almyty for an internal team must never
   * send surprise "finish setup" emails, so the whole feature is OFF
   * unless the operator explicitly enables it (the almyty SaaS sets it
   * true). RESEND_API_KEY being unset is a second natural gate. Default
   * OFF: only "true"/"1"/"yes" (case-insensitive) turns it on.
   */
  isEnabled(): boolean {
    const raw = (process.env.LIFECYCLE_EMAILS_ENABLED ?? '').trim().toLowerCase();
    return raw === 'true' || raw === '1' || raw === 'yes';
  }

  private appUrl(): string {
    return (
      process.env.APP_URL ||
      process.env.FRONTEND_URL ||
      DEFAULT_APP_URL
    );
  }

  /**
   * Compact, purpose-scoped HMAC unsubscribe token.
   */
  private signUnsubToken(userId: string): string {
    // Compact HMAC token (userId.sig) rather than a JWT — a JWT made the
    // unsubscribe URL enormous. Purpose-scoped so it can't double as a
    // session token; no expiry (unsubscribe must work forever).
    const sig = createHmac('sha256', process.env.JWT_SECRET || '')
      .update(`lifecycle-unsub:${userId}`)
      .digest('base64url')
      .slice(0, 16);
    return `${userId}.${sig}`;
  }

  /** Verify an unsubscribe token; returns the userId or null. */
  verifyUnsubToken(token: string): string | null {
    if (!token || typeof token !== 'string') return null;
    const dot = token.indexOf('.');
    if (dot <= 0) return null;
    const userId = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const expected = createHmac('sha256', process.env.JWT_SECRET || '')
      .update(`lifecycle-unsub:${userId}`)
      .digest('base64url')
      .slice(0, 16);
    if (
      sig.length !== expected.length ||
      !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
    ) {
      return null;
    }
    return userId;
  }

  /** Absolute unsubscribe URL embedded in every lifecycle email footer. */
  unsubscribeUrl(userId: string): string {
    const token = encodeURIComponent(this.signUnsubToken(userId));
    return `${this.appUrl()}/lifecycle/unsubscribe?token=${token}`;
  }

  private readState(user: User): LifecycleState {
    const prefs = user.preferences || {};
    return (prefs.lifecycle as LifecycleState) || {};
  }

  /**
   * Persist a patch onto preferences.lifecycle without clobbering other
   * preference keys. Read-modify-write on the JSON column.
   */
  private async writeState(userId: string, patch: Partial<LifecycleState>): Promise<void> {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) return;
    const prefs = user.preferences || {};
    const lifecycle: LifecycleState = { ...(prefs.lifecycle as LifecycleState), ...patch };
    user.preferences = { ...prefs, lifecycle };
    await this.userRepo.save(user);
  }

  /**
   * Welcome email — fired from the email-verification path. Skips unless
   * the user is verified, not opted out, and hasn't already had a welcome.
   */
  async sendWelcome(userId: string): Promise<void> {
    if (!this.isEnabled()) return;

    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) return;
    if (!user.verifiedAt) return; // verified-only

    const state = this.readState(user);
    if (state.optOut) return; // opt-out honored
    if (state.welcome) return; // dedupe

    const ok = await this.mailService.sendTemplate(user.email, 'lifecycle.welcome', {
      firstName: user.firstName,
      appUrl: this.appUrl(),
      unsubscribeUrl: this.unsubscribeUrl(user.id),
    });

    if (ok) {
      await this.writeState(user.id, { welcome: new Date().toISOString() });
    } else {
      this.logger.warn(`Lifecycle welcome send failed for user ${user.id}`);
    }
  }

  /**
   * Daily sweep: for each recently-verified, not-opted-out signup whose
   * org has NOT activated (no first_call), send at most ONE due nudge,
   * gated by days-since-signup and which nudges were already sent.
   */
  async runNudgeSweep(): Promise<{ scanned: number; sent: number }> {
    if (!this.isEnabled()) return { scanned: 0, sent: 0 };

    const now = Date.now();
    const cutoff = new Date(now - SWEEP_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

    // Verified, created within the lookback window. Opt-out and dedupe are
    // filtered per-user below (they live inside the JSON column).
    const candidates = await this.userRepo.find({
      where: {
        verifiedAt: Not(IsNull()),
        createdAt: MoreThan(cutoff),
      },
    });

    let sent = 0;
    for (const user of candidates) {
      try {
        if (await this.processNudge(user, now)) sent++;
      } catch (err: any) {
        // One bad user must never abort the sweep.
        this.logger.warn(`Lifecycle nudge failed for user ${user.id}: ${err?.message}`);
      }
    }

    this.logger.log(`Lifecycle nudge sweep: ${candidates.length} scanned, ${sent} sent`);
    return { scanned: candidates.length, sent };
  }

  /** Returns true if an email was sent for this user this sweep. */
  private async processNudge(user: User, now: number): Promise<boolean> {
    const state = this.readState(user);
    if (state.optOut) return false; // opt-out honored

    const orgId = await this.resolveOrganizationId(user.id);
    if (!orgId) return false;

    const onboarding = await this.onboardingService.getState(orgId, user.id);
    const steps = onboarding.steps;

    const commonParams = {
      firstName: user.firstName,
      appUrl: this.appUrl(),
      unsubscribeUrl: this.unsubscribeUrl(user.id),
    };

    // Activated: the ONLY post-activation email is the good-moment
    // congrats, sent once. Everything else stops the instant they
    // activate. We also record `activated` the first time we see it.
    // TODO: event-driven on first successful call (currently sweep-
    // detected, so up to ~24h delay after activation).
    if (steps.first_call) {
      if (!state.activatedCongrats) {
        const sent = await this.sendNudge(
          user,
          'lifecycle.activated-congrats',
          'activatedCongrats',
          commonParams,
        );
        if (sent && !state.activated) {
          await this.writeState(user.id, { activated: new Date().toISOString() });
        }
        return sent;
      }
      if (!state.activated) {
        await this.writeState(user.id, { activated: new Date().toISOString() });
      }
      return false;
    }

    const days = Math.floor((now - new Date(user.createdAt).getTime()) / (24 * 60 * 60 * 1000));

    // At most ONE email per sweep, evaluated latest-stage → earliest so a
    // user who has waited longer gets the more-advanced touch.

    // T+10: last touch ("here's what people build", then stop).
    if (days >= LAST_TOUCH_DAY && !state.lastTouch) {
      return this.sendNudge(user, 'lifecycle.last-touch', 'lastTouch', commonParams);
    }

    // T+5: concrete showcase ("give claude your api" ~5-min win).
    if (days >= SHOWCASE_DAY && !state.showcase) {
      return this.sendNudge(user, 'lifecycle.example-showcase', 'showcase', commonParams);
    }

    // T+2: the single state-aware nudge for the exact stuck step. Pick the
    // first missing step in the golden-path order.
    if (days >= STATE_NUDGE_DAY && !state.stateNudge) {
      const template = this.stateNudgeTemplate(steps);
      return this.sendNudge(user, template, 'stateNudge', commonParams);
    }

    return false;
  }

  /**
   * Maps the first missing onboarding step to its nudge template. Order
   * mirrors the golden path: provider → api → gateway → first_call. The
   * caller only reaches here when the user is NOT activated, so at least
   * one of these is false; first_call is the final fallback.
   */
  private stateNudgeTemplate(steps: {
    provider: boolean;
    api: boolean;
    gateway: boolean;
    first_call: boolean;
  }): string {
    if (!steps.provider) return 'lifecycle.nudge-provider';
    if (!steps.api) return 'lifecycle.nudge-api';
    if (!steps.gateway) return 'lifecycle.nudge-gateway';
    return 'lifecycle.nudge-first-call';
  }

  private async sendNudge(
    user: User,
    template: string,
    stateKey: keyof LifecycleState,
    params: Record<string, any>,
  ): Promise<boolean> {
    const ok = await this.mailService.sendTemplate(user.email, template, params);
    if (ok) {
      await this.writeState(user.id, { [stateKey]: new Date().toISOString() });
      return true;
    }
    this.logger.warn(`Lifecycle ${template} send failed for user ${user.id}`);
    return false;
  }

  /**
   * A user's organization for onboarding lookup: their OWNER membership if
   * any, else the earliest active membership. Deterministic by joinedAt.
   */
  private async resolveOrganizationId(userId: string): Promise<string | null> {
    const memberships = await this.userOrgRepo.find({
      where: { userId, isActive: true },
      order: { joinedAt: 'ASC' },
    });
    if (memberships.length === 0) return null;
    const owned = memberships.find((m) => m.role === OrganizationRole.OWNER);
    return (owned ?? memberships[0]).organizationId;
  }

  /** Set (or clear) the per-user opt-out flag. */
  async setOptOut(userId: string, optOut: boolean): Promise<void> {
    await this.writeState(userId, { optOut });
  }
}
