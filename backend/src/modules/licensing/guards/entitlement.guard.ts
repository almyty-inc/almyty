import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ENTITLEMENT_KEY } from '../decorators/requires-entitlement.decorator';
import { LicenseService } from '../license.service';

/**
 * Enforces `@RequiresEntitlement(...)`. When the active license does not grant
 * every required entitlement, the request is refused with 402 Payment Required
 * (the feature exists but is not licensed) rather than 403 (not authorized) —
 * this lets the frontend distinguish "upgrade to unlock" from "access denied".
 */
@Injectable()
export class EntitlementGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly licenseService: LicenseService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[]>(ENTITLEMENT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!required || required.length === 0) {
      return true;
    }

    const missing = required.filter((entitlement) => !this.licenseService.has(entitlement));
    if (missing.length > 0) {
      throw new HttpException(
        {
          statusCode: HttpStatus.PAYMENT_REQUIRED,
          error: 'Payment Required',
          message: `This feature requires an enterprise license entitlement: ${missing.join(', ')}`,
          requiredEntitlements: missing,
        },
        HttpStatus.PAYMENT_REQUIRED,
      );
    }

    return true;
  }
}
