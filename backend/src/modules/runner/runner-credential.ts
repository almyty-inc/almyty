import { CanActivate, ExecutionContext, Injectable, Optional, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Runner } from '../../entities/runner.entity';
import { jwtSecretOrDevFallback } from '../auth/dev-jwt-secret';
import { JWT_ALGORITHM, JWT_ISSUER, RUNNER_CREDENTIAL_AUDIENCE } from '../auth/token-kinds';

/**
 * The credential a hosted runner pod holds instead of anybody's login.
 *
 * A pod trades its single-use enrollment token for one of these (POST
 * /runners/enroll). It names one runner and nothing else: `sub` is
 * `runner:<id>`, the audience is `almyty-runner`, so the session strategy
 * (audience `almyty-api`) refuses it on every route, and the only routes
 * that accept it are the hosted runner's own stream and its renewal
 * (RunnerCredentialGuard). It cannot call an agent, read a credential or
 * list anything. `act` records whose workspace the pod serves, for audit;
 * it grants nothing.
 */
export interface RunnerCredentialClaims {
  runnerId: string;
  organizationId: string;
  hostedRunnerId: string;
  actUserId: string;
}

/** The session-user stand-in a runner credential is known by on the worker stream. */
export function runnerSessionUser(runnerId: string): string {
  return `runner:${runnerId}`;
}

/** The runner id behind a `runner:<id>` session user, or null for a person. */
export function runnerIdOfSessionUser(userId: string | null | undefined): string | null {
  if (!userId || !userId.startsWith('runner:')) return null;
  const id = userId.slice('runner:'.length);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ? id : null;
}

@Injectable()
export class RunnerCredentialService {
  private readonly jwt: JwtService;

  constructor(@Optional() config?: ConfigService) {
    const secret = jwtSecretOrDevFallback(config?.get<string>('JWT_SECRET') ?? process.env.JWT_SECRET, 'RunnerCredentialService');
    this.jwt = new JwtService({ secret });
  }

  /** Sign a credential for `ttlSeconds` (from the hosted runner settings). */
  sign(claims: RunnerCredentialClaims, ttlSeconds: number): { token: string; expiresAt: Date } {
    const token = this.jwt.sign(
      { org: claims.organizationId, hr: claims.hostedRunnerId, act: claims.actUserId, purpose: 'runner' },
      {
        subject: runnerSessionUser(claims.runnerId),
        audience: RUNNER_CREDENTIAL_AUDIENCE,
        issuer: JWT_ISSUER,
        algorithm: JWT_ALGORITHM,
        expiresIn: ttlSeconds,
      },
    );
    return { token, expiresAt: new Date(Date.now() + ttlSeconds * 1000) };
  }

  /** The claims of a valid runner credential, or null for anything else (a session token included). */
  verify(token: string | null | undefined): RunnerCredentialClaims | null {
    if (!token) return null;
    try {
      const payload = this.jwt.verify(token, {
        audience: RUNNER_CREDENTIAL_AUDIENCE,
        issuer: JWT_ISSUER,
        algorithms: [JWT_ALGORITHM],
      }) as Record<string, any>;
      const runnerId = runnerIdOfSessionUser(payload.sub);
      if (!runnerId || payload.purpose !== 'runner' || !payload.org || !payload.hr) return null;
      return { runnerId, organizationId: payload.org, hostedRunnerId: payload.hr, actUserId: payload.act };
    } catch {
      return null;
    }
  }
}

function bearerOf(req: any): string | null {
  const header: string | undefined = req.headers?.authorization ?? req.headers?.Authorization;
  if (!header) return null;
  const [scheme, value] = header.split(' ');
  return scheme?.toLowerCase() === 'bearer' && value ? value.trim() : null;
}

/**
 * The runner surface's guard: a valid runner credential for a hosted
 * runner that still exists in the organization the credential names.
 * Puts the claims on `req.runnerCredential`; never sets `req.user`, so
 * nothing downstream mistakes the pod for a person.
 */
@Injectable()
export class RunnerCredentialGuard implements CanActivate {
  constructor(
    private readonly credentials: RunnerCredentialService,
    @InjectRepository(Runner) private readonly runners: Repository<Runner>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const claims = this.credentials.verify(bearerOf(req));
    if (!claims) throw new UnauthorizedException('A runner credential is required');
    const runner = await this.runners.findOne({
      where: { id: claims.runnerId, organizationId: claims.organizationId, kind: 'hosted', hostedRunnerId: claims.hostedRunnerId },
      select: { id: true },
    });
    if (!runner) throw new UnauthorizedException('A runner credential is required');
    req.runnerCredential = claims;
    return true;
  }
}
