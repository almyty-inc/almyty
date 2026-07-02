import { SetMetadata } from '@nestjs/common';

export const ENTITLEMENT_KEY = 'requiredEntitlements';

/**
 * Gate a route/controller behind one or more license entitlements. Modeled on
 * the existing `@Roles(...)` decorator. Enforced by `EntitlementGuard`, which
 * returns 402 Payment Required when the active license lacks the feature.
 *
 * @example
 *   @RequiresEntitlement('sso')
 *   @Get('saml/metadata')
 *   metadata() { ... }
 */
export const RequiresEntitlement = (...entitlements: string[]) =>
  SetMetadata(ENTITLEMENT_KEY, entitlements);
