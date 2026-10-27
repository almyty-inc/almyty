import { json } from 'express';

/** Where the SCIM 2.0 endpoints are served (ee/modules/sso/scim.controller.ts). */
export const SCIM_ROUTES = ['/scim/v2'];

/**
 * SCIM clients send their bodies as `application/scim+json` (RFC 7644,
 * section 3.1): Microsoft Entra ID's provisioning service and Okta both do.
 * Nest's own JSON parser only reads `application/json`, so without this
 * every user Entra created arrived with no body and was answered 500, and
 * provisioning never added anyone.
 *
 * Named, and not express's json() handed over as is: Nest skips installing
 * its own JSON parser when it finds a middleware named `jsonParser` (see
 * the model route parser in main.ts).
 */
export function scimJsonParser() {
  const parse = json({ type: ['application/scim+json', 'application/json'] });
  return function scimRouteJsonParser(req: any, res: any, next: (err?: unknown) => void) {
    return parse(req, res, next);
  };
}
