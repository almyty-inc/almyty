import { Injectable, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, MoreThan, Repository } from 'typeorm';
import * as crypto from 'crypto';

import { AuthSession } from '../../entities/auth-session.entity';

/** How long a session lives without a refresh. Matches the refresh token. */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type SessionRevokeReason = 'logout' | 'refresh_reuse';

/**
 * Whether the session a token names is still live: present, for this
 * user, not revoked and not expired. Exported for the verifiers that sit
 * outside AuthModule (the unified agent endpoint) and hold only a
 * repository.
 */
export async function isSessionLive(
  repo: Repository<AuthSession>,
  sessionId: unknown,
  userId: unknown,
): Promise<boolean> {
  if (typeof sessionId !== 'string' || typeof userId !== 'string') return false;
  const count = await repo.count({
    where: { id: sessionId, userId, revokedAt: IsNull(), expiresAt: MoreThan(new Date()) },
  });
  return count === 1;
}

/**
 * The server-side half of a signed-in session. See AuthSession.
 */
@Injectable()
export class AuthSessionService {
  constructor(
    @InjectRepository(AuthSession)
    private readonly sessions: Repository<AuthSession>,
  ) {}

  static newJti(): string {
    return crypto.randomBytes(24).toString('base64url');
  }

  async start(userId: string, options: { ssoOrganizationId?: string } = {}): Promise<AuthSession> {
    return this.sessions.save(
      this.sessions.create({
        userId,
        refreshJti: AuthSessionService.newJti(),
        ssoOrganizationId: options.ssoOrganizationId ?? null,
        expiresAt: new Date(Date.now() + SESSION_TTL_MS),
        revokedAt: null,
        revokedReason: null,
      }),
    );
  }

  isLive(sessionId: unknown, userId: unknown): Promise<boolean> {
    return isSessionLive(this.sessions, sessionId, userId);
  }

  /**
   * Redeem refresh token `presentedJti` of session `sessionId`: swap it
   * for a fresh id and extend the session. Exactly one caller can win the
   * swap (the UPDATE is conditional on the current id). A presented id
   * that is not the current one on a live session is a replay of an
   * already-redeemed token, so the session is revoked outright: whichever
   * of the two holders is the thief, neither keeps it.
   */
  async rotate(sessionId: string, userId: string, presentedJti: string): Promise<AuthSession> {
    const nextJti = AuthSessionService.newJti();
    const claimed = await this.sessions
      .createQueryBuilder()
      .update(AuthSession)
      .set({ refreshJti: nextJti, expiresAt: new Date(Date.now() + SESSION_TTL_MS) })
      .where('id = :sessionId AND "userId" = :userId AND "refreshJti" = :presentedJti', {
        sessionId,
        userId,
        presentedJti,
      })
      .andWhere('"revokedAt" IS NULL AND "expiresAt" > now()')
      .execute();

    if (claimed.affected === 1) {
      const session = await this.sessions.findOne({ where: { id: sessionId } });
      if (session) return session;
    } else {
      const session = await this.sessions.findOne({ where: { id: sessionId, userId } });
      if (session && !session.revokedAt && session.refreshJti !== presentedJti) {
        await this.revoke(sessionId, 'refresh_reuse');
      }
    }
    throw new UnauthorizedException('Invalid refresh token');
  }

  async revoke(sessionId: string, reason: SessionRevokeReason, userId?: string): Promise<void> {
    await this.sessions.update(
      { id: sessionId, revokedAt: IsNull(), ...(userId ? { userId } : {}) },
      { revokedAt: new Date(), revokedReason: reason },
    );
  }
}
