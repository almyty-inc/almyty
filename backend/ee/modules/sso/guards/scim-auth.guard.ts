import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { SsoConfigService } from '../sso-config.service';

/**
 * Authenticates SCIM requests with the per-org bearer token. The token is
 * hashed and resolved to an organization via `OrgSsoConfig.scimTokenHash`; the
 * resolved org id is attached to the request as `scimOrgId` for the controller.
 *
 * A missing/unknown token throws 401 with a SCIM-shaped error body. This runs
 * AFTER the EntitlementGuard, so an unlicensed deployment returns 402 first and
 * never reaches token validation.
 */
@Injectable()
export class ScimAuthGuard implements CanActivate {
  constructor(private readonly configService: SsoConfigService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const header: string | undefined =
      req.headers?.authorization || req.headers?.Authorization;

    const token = header?.startsWith('Bearer ')
      ? header.slice('Bearer '.length).trim()
      : undefined;

    if (!token) {
      throw new UnauthorizedException(this.scimError('Missing bearer token'));
    }

    const orgId = await this.configService.findOrgByScimToken(token);
    if (!orgId) {
      throw new UnauthorizedException(this.scimError('Invalid SCIM token'));
    }

    req.scimOrgId = orgId;
    return true;
  }

  private scimError(detail: string) {
    return {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'],
      status: '401',
      detail,
    };
  }
}
