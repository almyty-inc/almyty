import { Injectable, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Reflector } from '@nestjs/core';

/**
 * Composite auth guard: tries JWT first, then falls back to API key.
 *
 * This is the guard used on all main API routes (agents, tools,
 * gateways, etc.). The CLI login flow mints long-lived API keys
 * (prefixed `almyty_`), while the web UI uses httpOnly cookie
 * JWTs. Both must be accepted on the same routes.
 *
 * When the JWT strategy fails (token is not a valid JWT, expired,
 * etc.), we try the api-key strategy before rejecting. If both
 * fail, the original JWT error is surfaced.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard(['jwt', 'api-key']) {
  constructor(private reflector: Reflector) {
    super();
  }

  canActivate(context: ExecutionContext) {
    // Check if route is marked as public
    const isPublic = this.reflector.getAllAndOverride<boolean>('isPublic', [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    return super.canActivate(context);
  }

  handleRequest(err: any, user: any, info: any, context: ExecutionContext) {
    if (err || !user) {
      throw err || new UnauthorizedException('Invalid token');
    }

    return user;
  }
}