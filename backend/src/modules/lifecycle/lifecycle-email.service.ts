import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { JwtService } from '@nestjs/jwt';
import { MoreThan, Not, IsNull, Repository } from 'typeorm';

import { User } from '../../entities/user.entity';
import { UserOrganization, OrganizationRole } from '../../entities/user-organization.entity';
import { MailService } from '../mail/mail.service';
import { OnboardingService } from '../onboarding/onboarding.service';

/**
 * New-signup activation lifecycle emails.
 *
 * Catches the "signed up, never came back" segment: a welcome email on
 * email verification, then up to three activation nudges tied to real
 * onboarding progress. Everything here is an operator/growth tool (the
 * instance operator emailing their own signups), so it lives in the
 * Apache core and is strictly guardrailed:
 *
 *   - verified-only (unverified signups are likely bots),
 *   - per-user opt-out honored on every send,
 *   - every email type deduped via preferences.lifecycle,
 *   - at most one nudge per user per sweep,
 *   - never activated after they activate,
 *   - the feature is opt-in (see LIFECYCLE_EMAILS_ENABLED below).
 *
 * Dedupe / opt-out state lives in the existing `user.preferences` JSON
 * column under `preferences.lifecycle` — no new table, no migration.
 */

/** Default app URL used in CTAs when APP_URL / FRONTEND_URL are unset. */
export const DEFAULT_APP_URL = 'https://app.almyty.com';

/**
 * Cadence thresholds in whole days since signup (createdAt). Exported so
 * they are easy to tune in one place. A nudge is only "due" once the
 * user is at least this many days old AND the corresponding onboarding
 * step is still missing AND the nudge has not already been sent.
 * MARKETING: refine copy + cadence
 */
export const NUDGE_PROVIDER_DAY = 1;
export const NUDGE_API_DAY = 3;
export const NUDGE_FINAL_DAY = 7;

/**
 * Only signups from roughly the last window are swept. Older accounts
 * that never activated are past the point where a "finish setup" email
 * is welcome, and it keeps the sweep query bounded.
 */
export const SWEEP_LOOKBACK_DAYS = 8;

/** Shape stored under user.preferences.lifecycle. All timestamps are ISO strings. */
interface LifecycleState {
  optOut?: boolean;
  welcome?: string;
  nudgeProvider?: string;
  nudgeApi?: string;
  nudgeFinal?: string;
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
    private readonly jwtService: JwtService,
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
   * Signed, purpose-scoped unsubscribe token. Reuses the app JwtService
   * (same signing key as the rest of auth) with a distinct `purpose` so
   * it can never be confused with a session/verification token. No expiry
   * on purpose: an unsubscribe link should keep working forever.
   */
  private signUnsubToken(userId: string): string {
    return this.jwtService.sign({ userId, purpose: 'lifecycle-unsub' });
  }

  /** Verify an unsubscribe token; returns the userId or null. */
  verifyUnsubToken(token: string): string | null {
    if (!token || typeof token !== 'string') return null;
    try {
      const payload = this.jwtService.verify(token) as {
        userId?: string;
        purpose?: string;
      };
      if (payload?.purpose !== 'lifecycle-unsub' || !payload.userId) return null;
      return payload.userId;
    } catch {
      return null;
    }
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

  /** Returns true if a nudge was sent for this user. */
  private async processNudge(user: User, now: number): Promise<boolean> {
    const state = this.readState(user);
    if (state.optOut) return false; // opt-out honored

    const orgId = await this.resolveOrganizationId(user.id);
    if (!orgId) return false;

    const onboarding = await this.onboardingService.getState(orgId, user.id);
    const steps = onboarding.steps;

    // Already activated: never nudge again. Mark it so future sweeps skip
    // the onboarding lookup cheaply-ish (still recomputed, but recorded).
    if (steps.first_call) {
      if (!state.activated) {
        await this.writeState(user.id, { activated: new Date().toISOString() });
      }
      return false;
    }

    const days = Math.floor((now - new Date(user.createdAt).getTime()) / (24 * 60 * 60 * 1000));
    const commonParams = {
      firstName: user.firstName,
      appUrl: this.appUrl(),
      unsubscribeUrl: this.unsubscribeUrl(user.id),
    };

    // At most ONE nudge per sweep. Evaluate most-progressed → least so a
    // user who blew past an earlier step still gets the right later nudge.

    // Day >= 7: still not activated, final nudge not sent.
    if (days >= NUDGE_FINAL_DAY && !state.nudgeFinal) {
      return this.sendNudge(user, 'lifecycle.nudge-final', 'nudgeFinal', commonParams);
    }

    // Day >= 3: no api (or no gateway) yet, api nudge not sent.
    if (days >= NUDGE_API_DAY && (!steps.api || !steps.gateway) && !state.nudgeApi) {
      return this.sendNudge(user, 'lifecycle.nudge-api', 'nudgeApi', commonParams);
    }

    // Day >= 1: no provider yet, provider nudge not sent.
    if (days >= NUDGE_PROVIDER_DAY && !steps.provider && !state.nudgeProvider) {
      return this.sendNudge(user, 'lifecycle.nudge-provider', 'nudgeProvider', commonParams);
    }

    return false;
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
