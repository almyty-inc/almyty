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
import { OrgLicenseResolver } from '../org-license.resolver';

/**
 * Enforces `@RequiresEntitlement(...)`. When the active license does not grant
 * every required entitlement, the request is refused with 402 Payment Required
 * (the feature exists but is not licensed) rather than 403 (not authorized) —
 * this lets the frontend distinguish "upgrade to unlock" from "access denied".
 *
 * Entitlements are resolved PER ORG: billing is org-scoped, so the requesting
 * org's stored license token (via `OrgLicenseResolver`) decides access. When a
 * request carries no org context (non-org routes), we fall back to the global
 * `LicenseService.has()` — preserving self-host/env-token behavior.
 */
@Injectable()
export class EntitlementGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly licenseService: LicenseService,
    private readonly orgLicenseResolver: OrgLicenseResolver,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<string[]>(ENTITLEMENT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!required || required.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const organizationId: string | undefined = request?.user?.currentOrganizationId;

    let missing: string[];
    if (organizationId) {
      // Per-org path: resolve the requesting org's stored token.
      const snapshot = await this.orgLicenseResolver.entitlementsForOrg(organizationId);
      const granted = new Set(snapshot.entitlements);
      missing = required.filter((entitlement) => !granted.has(entitlement));
    } else {
      // No org context (non-org route) → global/self-host entitlement set.
      missing = required.filter((entitlement) => !this.licenseService.has(entitlement));
    }

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
